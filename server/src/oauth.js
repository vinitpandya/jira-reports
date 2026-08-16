import crypto from 'node:crypto'
import { db, getConfig, setConfig } from './db.js'
import {
  AUTH_BASE,
  API_BASE,
  REDIRECT_URI,
  SCOPES,
  ENV_CLIENT_ID,
  ENV_CLIENT_SECRET,
} from './config.js'

/**
 * Credentials resolve from the Settings page first, then .env. The secret never
 * leaves this process — the browser only ever sees whether one is present.
 */
export function getCredentials() {
  return {
    clientId: getConfig('client_id') || ENV_CLIENT_ID,
    clientSecret: getConfig('client_secret') || ENV_CLIENT_SECRET,
    redirectUri: getConfig('redirect_uri') || REDIRECT_URI,
    scopes: getConfig('scopes') || SCOPES,
    fromEnv: !getConfig('client_id') && !!ENV_CLIENT_ID,
  }
}

export function setCredentials({ clientId, clientSecret, redirectUri, scopes }) {
  if (clientId !== undefined) setConfig('client_id', clientId)
  if (clientSecret !== undefined) setConfig('client_secret', clientSecret)
  if (redirectUri !== undefined) setConfig('redirect_uri', redirectUri)
  if (scopes !== undefined) setConfig('scopes', scopes)
}

export function buildAuthUrl() {
  const { clientId, redirectUri, scopes } = getCredentials()
  if (!clientId) throw new Error('No Jira client ID configured')

  const state = crypto.randomBytes(24).toString('hex')
  setConfig('oauth_state', { state, at: Date.now() })

  const url = new URL('/authorize', AUTH_BASE)
  url.searchParams.set('audience', 'api.atlassian.com')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('scope', scopes)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

export function consumeState(state) {
  const stored = getConfig('oauth_state')
  db.prepare('DELETE FROM app_config WHERE key = ?').run('oauth_state')
  if (!stored || stored.state !== state) return false
  // 10 minute window; a stale state means a stray or replayed callback.
  return Date.now() - stored.at < 10 * 60 * 1000
}

async function tokenRequest(body) {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${text.slice(0, 500)}`)
  }
  return JSON.parse(text)
}

function storeToken(tok) {
  const now = Date.now()
  db.prepare(
    `INSERT INTO oauth_token (id, access_token, refresh_token, expires_at, scope, obtained_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       access_token  = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, oauth_token.refresh_token),
       expires_at    = excluded.expires_at,
       scope         = excluded.scope,
       obtained_at   = excluded.obtained_at`
  ).run(
    tok.access_token,
    tok.refresh_token || null,
    now + (tok.expires_in || 3600) * 1000,
    tok.scope || '',
    now
  )
}

export async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = getCredentials()
  const tok = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  })
  storeToken(tok)
  return tok
}

let refreshInFlight = null

async function refresh() {
  const row = db.prepare('SELECT * FROM oauth_token WHERE id = 1').get()
  if (!row?.refresh_token) throw new Error('Not connected to Jira (no refresh token)')
  const { clientId, clientSecret } = getCredentials()
  // Atlassian rotates refresh tokens, so the response's new one must be stored.
  const tok = await tokenRequest({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: row.refresh_token,
  })
  storeToken(tok)
  return tok.access_token
}

export async function getAccessToken() {
  const row = db.prepare('SELECT * FROM oauth_token WHERE id = 1').get()
  if (!row?.access_token) throw new Error('Not connected to Jira')
  if (row.expires_at - Date.now() > 60_000) return row.access_token

  // Collapse concurrent refreshes — the sync fires many requests at once and a
  // rotated refresh token can only be redeemed one time.
  if (!refreshInFlight) {
    refreshInFlight = refresh().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

export function authStatus() {
  const row = db.prepare('SELECT * FROM oauth_token WHERE id = 1').get()
  const creds = getCredentials()
  return {
    configured: !!creds.clientId && !!creds.clientSecret,
    clientId: creds.clientId ? `${creds.clientId.slice(0, 6)}…` : null,
    hasSecret: !!creds.clientSecret,
    credentialSource: creds.fromEnv ? 'env' : creds.clientId ? 'settings' : null,
    redirectUri: creds.redirectUri,
    scopes: creds.scopes,
    connected: !!row?.access_token,
    expiresAt: row?.expires_at ?? null,
    grantedScopes: row?.scope ?? null,
  }
}

export function disconnect() {
  db.prepare('DELETE FROM oauth_token').run()
}

/** The sites (Jira Cloud instances) this grant can reach. */
export async function fetchAccessibleResources() {
  const token = await getAccessToken()
  const res = await fetch(`${API_BASE}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`accessible-resources failed (${res.status})`)
  const sites = await res.json()

  const stmt = db.prepare(
    `INSERT INTO sites (cloud_id, name, url, avatar, scopes) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id) DO UPDATE SET
       name = excluded.name, url = excluded.url,
       avatar = excluded.avatar, scopes = excluded.scopes`
  )
  const tx = db.transaction((rows) => {
    for (const s of rows) {
      stmt.run(s.id, s.name, s.url, s.avatarUrl || null, JSON.stringify(s.scopes || []))
    }
  })
  tx(sites)

  if (!getConfig('cloud_id') && sites.length) setConfig('cloud_id', sites[0].id)
  return sites
}

export function activeCloudId() {
  const id = getConfig('cloud_id')
  if (id) return id
  const row = db.prepare('SELECT cloud_id FROM sites LIMIT 1').get()
  return row?.cloud_id || null
}
