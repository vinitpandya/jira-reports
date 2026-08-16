import express from 'express'
import { db, getConfig, setConfig } from './db.js'
import { WEB_ORIGIN } from './config.js'
import {
  authStatus,
  buildAuthUrl,
  consumeState,
  exchangeCode,
  disconnect,
  fetchAccessibleResources,
  setCredentials,
  activeCloudId,
} from './oauth.js'
import { runSync, syncStatus, cancelSync } from './sync.js'
import {
  resolveScope,
  summarise,
  cumulativeFlow,
  buildTree,
  sankey,
  peopleBreakdown,
  throughput,
  chordFlows,
  cycleTime,
  graphData,
  burnup,
  graphTimeline,
  SANKEY_DIMENSIONS,
  METRICS,
} from './reports.js'

export const router = express.Router()

const csv = (v) =>
  typeof v === 'string' && v.length ? v.split(',').map((s) => s.trim()).filter(Boolean) : []

function scopeFrom(query) {
  return resolveScope({
    projects: csv(query.projects),
    roots: csv(query.roots),
    types: csv(query.types),
    descendants: query.descendants !== 'false',
    followLinks: query.followLinks === 'true',
  })
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500
      res.status(status).json({ error: String(err.message || err) })
    }
  }
}

/* ------------------------------------------------------------------- auth */

router.get('/auth/status', (req, res) => res.json(authStatus()))

router.post('/auth/credentials', wrap(async (req, res) => {
  const { clientId, clientSecret, redirectUri, scopes } = req.body || {}
  setCredentials({ clientId, clientSecret, redirectUri, scopes })
  res.json(authStatus())
}))

router.get('/auth/login', wrap(async (req, res) => {
  res.redirect(buildAuthUrl())
}))

router.get('/auth/callback', async (req, res) => {
  const back = (params) => res.redirect(`${WEB_ORIGIN}/settings?${new URLSearchParams(params)}`)
  try {
    if (req.query.error) return back({ error: String(req.query.error_description || req.query.error) })
    if (!consumeState(String(req.query.state || ''))) {
      return back({ error: 'OAuth state mismatch — start the connection again' })
    }
    await exchangeCode(String(req.query.code))
    await fetchAccessibleResources()
    return back({ connected: '1' })
  } catch (err) {
    return back({ error: String(err.message || err) })
  }
})

router.post('/auth/disconnect', wrap(async (req, res) => {
  disconnect()
  res.json(authStatus())
}))

/* ------------------------------------------------------------------ sites */

router.get('/sites', wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM sites').all()
  res.json({ sites: rows, active: activeCloudId() })
}))

router.post('/sites/refresh', wrap(async (req, res) => {
  const sites = await fetchAccessibleResources()
  res.json({ sites, active: activeCloudId() })
}))

router.post('/sites/select', wrap(async (req, res) => {
  setConfig('cloud_id', req.body?.cloudId)
  res.json({ active: activeCloudId() })
}))

/* --------------------------------------------------------------- projects */

router.get('/projects', wrap(async (req, res) => {
  const cloudId = activeCloudId()
  const rows = cloudId
    ? db.prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM issues i WHERE i.cloud_id = p.cloud_id AND i.project_id = p.id) AS issue_count
         FROM projects p WHERE p.cloud_id = ? ORDER BY p.key`
      ).all(cloudId)
    : []
  res.json({ projects: rows, selected: getConfig('sync_projects', []) })
}))

router.post('/projects/select', wrap(async (req, res) => {
  setConfig('sync_projects', req.body?.keys || [])
  res.json({ selected: getConfig('sync_projects', []) })
}))

/* ------------------------------------------------------------------- sync */

router.post('/sync', wrap(async (req, res) => {
  if (syncStatus().running) return res.status(409).json({ error: 'A sync is already running' })
  const mode = req.body?.mode === 'full' ? 'full' : 'incremental'
  if (mode === 'full') setConfig('last_issue_sync', null)
  // Fire and forget; the client polls /sync/status, which also surfaces errors.
  runSync({ mode }).catch((err) => console.error('[sync]', err))
  res.json({ started: true, mode })
}))

router.get('/sync/status', (req, res) => res.json(syncStatus()))

router.post('/sync/cancel', wrap(async (req, res) => {
  res.json({ cancelled: cancelSync() })
}))

/* ---------------------------------------------------------------- catalog */

router.get('/catalog', wrap(async (req, res) => {
  const cloudId = activeCloudId()
  if (!cloudId) return res.json({ ready: false })

  const levels = db.prepare(
    `SELECT hierarchy_level AS level, type_name AS name, COUNT(*) AS n
     FROM issues WHERE cloud_id = ? GROUP BY hierarchy_level, type_name ORDER BY level DESC, n DESC`
  ).all(cloudId)

  const statuses = db.prepare(
    `SELECT status_name AS name, status_category AS category, COUNT(*) AS n
     FROM issues WHERE cloud_id = ? GROUP BY status_name, status_category ORDER BY n DESC`
  ).all(cloudId)

  const projects = db.prepare(
    `SELECT key, name, type_key, n FROM (
       SELECT p.key, p.name, p.type_key,
              (SELECT COUNT(*) FROM issues i WHERE i.cloud_id = p.cloud_id AND i.project_id = p.id) AS n
       FROM projects p WHERE p.cloud_id = ?
     ) WHERE n > 0 ORDER BY key`
  ).all(cloudId)

  const totals = db.prepare(
    'SELECT COUNT(*) AS issues, MAX(updated) AS newest FROM issues WHERE cloud_id = ?'
  ).get(cloudId)

  res.json({
    ready: totals.issues > 0,
    levels,
    statuses,
    projects,
    totals,
    metrics: Object.entries(METRICS).map(([k, v]) => ({ key: k, label: v.label })),
    dimensions: SANKEY_DIMENSIONS,
  })
}))

/**
 * Selectable report roots: initiatives, epics and Product Discovery ideas.
 * `level` filters the hierarchy tier; `q` is a substring match on key/summary.
 */
router.get('/roots', wrap(async (req, res) => {
  const cloudId = activeCloudId()
  if (!cloudId) return res.json({ roots: [] })

  const level = req.query.level
  const q = String(req.query.q || '').trim()
  const limit = Math.min(Number(req.query.limit) || 300, 1000)

  const where = ['i.cloud_id = ?']
  const params = [cloudId]

  if (level === 'idea') {
    where.push(`p.type_key = 'product_discovery'`)
  } else if (level !== undefined && level !== '' && level !== 'any') {
    where.push('i.hierarchy_level = ?')
    params.push(Number(level))
  }
  if (q) {
    where.push('(i.key LIKE ? OR i.summary LIKE ?)')
    params.push(`%${q}%`, `%${q}%`)
  }

  const roots = db.prepare(
    `SELECT i.id, i.key, i.summary, i.type_name, i.hierarchy_level, i.status_name,
            i.status_category, i.project_key, p.type_key AS project_type,
            (SELECT COUNT(*) FROM issues c WHERE c.cloud_id = i.cloud_id AND c.parent_id = i.id) AS child_count
     FROM issues i
     LEFT JOIN projects p ON p.cloud_id = i.cloud_id AND p.id = i.project_id
     WHERE ${where.join(' AND ')}
     ORDER BY child_count DESC, i.key
     LIMIT ?`
  ).all(...params, limit)

  res.json({ roots })
}))

/* ---------------------------------------------------------------- reports */

router.get('/reports/summary', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  const metric = req.query.metric || 'count'
  res.json({
    ...summarise(issues, metric),
    throughput: throughput({ issues, weeks: Number(req.query.weeks) || 12 }),
  })
}))

router.get('/reports/cfd', wrap(async (req, res) => {
  const { issues, cloudId } = scopeFrom(req.query)
  let set = issues
  if (req.query.leavesOnly === 'true') {
    // Anything that is somebody's parent within this scope is not a leaf.
    const parents = new Set(issues.map((i) => i.parent_id).filter(Boolean))
    set = issues.filter((i) => !parents.has(i.id))
  }
  res.json(
    cumulativeFlow({
      issues: set,
      cloudId,
      from: req.query.from,
      to: req.query.to,
      groupBy: req.query.groupBy === 'category' ? 'category' : 'status',
      metric: req.query.metric || 'count',
    })
  )
}))

router.get('/reports/tree', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  const tree = buildTree({ issues, metric: req.query.metric || 'count' })
  res.json({ tree, issueCount: issues.length })
}))

router.get('/reports/sankey', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  const dims = csv(req.query.dimensions)
  res.json(
    sankey({
      issues,
      dimensions: dims.length ? dims : ['assignee', 'epic', 'category'],
      metric: req.query.metric || 'count',
      maxPerColumn: Math.min(Number(req.query.maxPerColumn) || 12, 24),
    })
  )
}))

router.get('/reports/people', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  res.json({ people: peopleBreakdown({ issues, metric: req.query.metric || 'count' }) })
}))

router.get('/reports/issues', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  const limit = Math.min(Number(req.query.limit) || 500, 5000)
  res.json({
    total: issues.length,
    issues: issues
      .slice()
      .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))
      .slice(0, limit)
      .map((i) => ({
        key: i.key,
        summary: i.summary,
        type: i.type_name,
        level: i.hierarchy_level,
        status: i.status_name,
        category: i.status_category,
        assignee: i.assignee_name,
        project: i.project_key,
        points: i.story_points,
        hours: (i.time_spent || 0) / 3600,
        created: i.created,
        updated: i.updated,
        resolved: i.resolved,
        parent: i.parent_key,
      })),
  })
}))

router.get('/reports/chord', wrap(async (req, res) => {
  const { issues, cloudId } = scopeFrom(req.query)
  res.json(
    chordFlows({
      issues,
      cloudId,
      flow: req.query.flow === 'projects' ? 'projects' : 'handovers',
      maxEntities: Math.min(Number(req.query.maxEntities) || 8, 8),
    })
  )
}))

router.get('/reports/cycletime', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  const groupBy = ['epic', 'assignee', 'project'].includes(req.query.groupBy)
    ? req.query.groupBy
    : 'epic'
  res.json(cycleTime({ issues, groupBy }))
}))

router.get('/reports/graph', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  res.json(
    graphData({
      issues,
      includeStories: req.query.includeStories === 'true',
      maxStories: Math.min(Number(req.query.maxStories) || 120, 300),
    })
  )
}))

router.get('/reports/burnup', wrap(async (req, res) => {
  const { issues, cloudId } = scopeFrom(req.query)
  res.json(
    burnup({
      issues,
      cloudId,
      metric: req.query.metric || 'count',
      from: req.query.from,
    })
  )
}))

router.get('/reports/graph-timeline', wrap(async (req, res) => {
  const { issues, cloudId } = scopeFrom(req.query)
  res.json(
    graphTimeline({
      issues,
      cloudId,
      maxStories: Math.min(Number(req.query.maxStories) || 250, 500),
    })
  )
}))

/* ------------------------------------------------------------- dashboards */

const dashboardRow = (row) => ({
  id: row.id,
  name: row.name,
  layout: JSON.parse(row.layout || '[]'),
  updatedAt: row.updated_at,
})

router.get('/dashboards', wrap(async (req, res) => {
  const rows = db.prepare('SELECT id, name, updated_at FROM dashboards ORDER BY name').all()
  res.json({ dashboards: rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at })) })
}))

router.get('/dashboards/:id', wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'No such dashboard' })
  res.json(dashboardRow(row))
}))

router.post('/dashboards', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim() || 'Untitled dashboard'
  const layout = JSON.stringify(req.body?.layout ?? [])
  const now = Date.now()
  const info = db
    .prepare('INSERT INTO dashboards (name, layout, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, layout, now, now)
  const row = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(info.lastInsertRowid)
  res.json(dashboardRow(row))
}))

router.put('/dashboards/:id', wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'No such dashboard' })
  const name = req.body?.name !== undefined ? String(req.body.name).trim() || row.name : row.name
  const layout = req.body?.layout !== undefined ? JSON.stringify(req.body.layout) : row.layout
  db.prepare('UPDATE dashboards SET name = ?, layout = ?, updated_at = ? WHERE id = ?')
    .run(name, layout, Date.now(), row.id)
  res.json(dashboardRow(db.prepare('SELECT * FROM dashboards WHERE id = ?').get(row.id)))
}))

router.delete('/dashboards/:id', wrap(async (req, res) => {
  db.prepare('DELETE FROM dashboards WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
}))

/** Site base URL so the UI can deep-link an issue key back into Jira. */
router.get('/site-url', wrap(async (req, res) => {
  const cloudId = activeCloudId()
  const row = cloudId ? db.prepare('SELECT url FROM sites WHERE cloud_id = ?').get(cloudId) : null
  res.json({ url: row?.url || null })
}))
