import { API_BASE } from './config.js'
import { getAccessToken, activeCloudId } from './oauth.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class JiraError extends Error {
  constructor(status, body, path) {
    super(`Jira ${status} on ${path}: ${String(body).slice(0, 400)}`)
    this.status = status
    this.body = body
    this.path = path
  }
}

/**
 * One request against a site's Jira REST API, with retry on 429/5xx.
 * `path` is relative to /rest, e.g. "/api/3/project/search".
 */
export async function jiraFetch(path, { method = 'GET', query, body, cloudId } = {}) {
  const cid = cloudId || activeCloudId()
  if (!cid) throw new Error('No Jira site selected')

  const url = new URL(`${API_BASE}/ex/jira/${cid}/rest${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }

  let attempt = 0
  for (;;) {
    const token = await getAccessToken()
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (res.ok) {
      if (res.status === 204) return null
      return res.json()
    }

    const retryable = res.status === 429 || res.status >= 500
    if (retryable && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after'))
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 2 ** attempt * 1000)
      attempt += 1
      await sleep(wait)
      continue
    }

    throw new JiraError(res.status, await res.text(), path)
  }
}

/**
 * JQL search. Uses the current /search/jql endpoint (token pagination) and
 * falls back to the legacy /search offset endpoint on older sites.
 */
export async function searchIssues({ jql, fields, cloudId, expand, onPage, pageSize = 100, signal }) {
  const fieldParam = Array.isArray(fields) ? fields.join(',') : fields
  let useLegacy = false
  let nextPageToken
  let startAt = 0
  let count = 0

  for (;;) {
    if (signal?.aborted) throw new Error('Sync cancelled')

    let page
    if (!useLegacy) {
      try {
        page = await jiraFetch('/api/3/search/jql', {
          cloudId,
          query: {
            jql,
            fields: fieldParam,
            maxResults: pageSize,
            nextPageToken,
            expand,
          },
        })
      } catch (err) {
        if (err instanceof JiraError && (err.status === 404 || err.status === 410)) {
          useLegacy = true
          continue
        }
        throw err
      }
    } else {
      page = await jiraFetch('/api/3/search', {
        cloudId,
        query: { jql, fields: fieldParam, maxResults: pageSize, startAt, expand },
      })
    }

    const issues = page?.issues ?? []
    count += issues.length
    if (issues.length) await onPage(issues)

    if (!useLegacy) {
      nextPageToken = page?.nextPageToken
      if (page?.isLast || !nextPageToken || issues.length === 0) break
    } else {
      startAt += issues.length
      const total = page?.total ?? 0
      if (issues.length === 0 || startAt >= total) break
    }
  }

  return count
}

/**
 * Changelogs for many issues. Prefers the bulkfetch endpoint (one call per 100
 * issues); falls back to per-issue paging where it is unavailable.
 */
export async function fetchChangelogs({ issueIds, fieldIds = ['status', 'assignee'], cloudId, signal }) {
  const out = new Map()
  const chunkSize = 100

  for (let i = 0; i < issueIds.length; i += chunkSize) {
    if (signal?.aborted) throw new Error('Sync cancelled')
    const chunk = issueIds.slice(i, i + chunkSize)

    let bulkOk = true
    let nextPageToken
    for (;;) {
      let page
      try {
        page = await jiraFetch('/api/3/changelog/bulkfetch', {
          method: 'POST',
          cloudId,
          body: {
            fieldIds,
            issueIdsOrKeys: chunk,
            maxResults: 1000,
            ...(nextPageToken ? { nextPageToken } : {}),
          },
        })
      } catch (err) {
        if (err instanceof JiraError && [400, 404, 410].includes(err.status)) {
          bulkOk = false
          break
        }
        throw err
      }

      for (const entry of page?.issueChangeLogs ?? []) {
        const id = String(entry.issueId)
        if (!out.has(id)) out.set(id, [])
        out.get(id).push(...(entry.changeHistories ?? []))
      }
      nextPageToken = page?.nextPageToken
      if (!nextPageToken) break
    }

    if (bulkOk) continue

    for (const id of chunk) {
      const histories = []
      let startAt = 0
      for (;;) {
        const page = await jiraFetch(`/api/3/issue/${id}/changelog`, {
          cloudId,
          query: { startAt, maxResults: 100 },
        })
        histories.push(...(page?.values ?? []))
        startAt += page?.values?.length ?? 0
        if (page?.isLast || startAt >= (page?.total ?? 0) || !page?.values?.length) break
      }
      out.set(String(id), histories)
    }
  }

  return out
}
