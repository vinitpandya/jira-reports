import { db } from './db.js'
import { activeCloudId } from './oauth.js'

const DAY = 86_400_000

/* ------------------------------------------------------------------ scope */

function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',')
}

/**
 * Resolve a selection into a concrete issue set.
 *
 * `roots` are issue keys (an initiative, epic or idea); `projects` are project
 * keys. With `descendants` on, every issue beneath a root via parent links is
 * included. `followLinks` additionally walks outward issue links once, which is
 * how a Product Discovery idea reaches its delivery tickets.
 */
export function resolveScope({
  projects = [],
  roots = [],
  types = [],
  descendants = true,
  followLinks = false,
  cloudId = activeCloudId(),
} = {}) {
  if (!cloudId) return { cloudId: null, issues: [] }

  let seedIds = []

  if (roots.length) {
    seedIds = db
      .prepare(
        `SELECT id FROM issues WHERE cloud_id = ? AND (key IN (${placeholders(
          roots.length
        )}) OR id IN (${placeholders(roots.length)}))`
      )
      .all(cloudId, ...roots, ...roots)
      .map((r) => r.id)
  } else if (projects.length) {
    seedIds = db
      .prepare(
        `SELECT id FROM issues WHERE cloud_id = ? AND project_key IN (${placeholders(
          projects.length
        )})`
      )
      .all(cloudId, ...projects)
      .map((r) => r.id)
  } else {
    seedIds = db.prepare('SELECT id FROM issues WHERE cloud_id = ?').all(cloudId).map((r) => r.id)
  }

  if (!seedIds.length) return { cloudId, issues: [] }

  let ids = new Set(seedIds)

  if (descendants && roots.length) {
    if (followLinks) {
      const linked = db
        .prepare(
          `SELECT target_id AS id FROM issue_links
           WHERE cloud_id = ? AND direction = 'outward' AND source_id IN (${placeholders(
             seedIds.length
           )})`
        )
        .all(cloudId, ...seedIds)
      for (const r of linked) ids.add(r.id)
    }

    const frontier = [...ids]
    const rows = db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM issues WHERE cloud_id = @cid AND id IN (${placeholders(frontier.length)})
           UNION
           SELECT c.id FROM issues c JOIN tree t ON c.parent_id = t.id WHERE c.cloud_id = @cid
         )
         SELECT id FROM tree`
      )
      .all({ cid: cloudId }, ...frontier)
    for (const r of rows) ids.add(r.id)
  }

  const idList = [...ids]
  const issues = []
  const chunk = 900 // stay under SQLite's variable limit
  for (let i = 0; i < idList.length; i += chunk) {
    const part = idList.slice(i, i + chunk)
    issues.push(
      ...db
        .prepare(
          `SELECT * FROM issues WHERE cloud_id = ? AND id IN (${placeholders(part.length)})`
        )
        .all(cloudId, ...part)
    )
  }

  const filtered = types.length
    ? issues.filter((i) => types.includes(i.type_name) || types.includes(String(i.hierarchy_level)))
    : issues

  return { cloudId, issues: filtered }
}

/* ---------------------------------------------------------------- metrics */

export const METRICS = {
  count: { label: 'Issues', value: () => 1, format: 'count' },
  points: { label: 'Story points', value: (i) => i.story_points || 0, format: 'number' },
  timespent: { label: 'Time logged', value: (i) => (i.time_spent || 0) / 3600, format: 'hours' },
}

export function metricValue(issue, metric = 'count') {
  return (METRICS[metric] || METRICS.count).value(issue)
}

export function summarise(issues, metric = 'count') {
  const total = issues.reduce((s, i) => s + metricValue(i, metric), 0)
  const byCategory = { new: 0, indeterminate: 0, done: 0 }
  for (const i of issues) {
    const key = i.status_category || 'new'
    byCategory[key] = (byCategory[key] || 0) + metricValue(i, metric)
  }
  const counts = { new: 0, indeterminate: 0, done: 0 }
  for (const i of issues) {
    const key = i.status_category || 'new'
    counts[key] = (counts[key] || 0) + 1
  }

  const estimated = issues.filter((i) => (i.story_points || 0) > 0).length
  return {
    metric,
    total,
    issues: issues.length,
    byCategory,
    counts,
    percentComplete: total > 0 ? (byCategory.done / total) * 100 : 0,
    percentInProgress: total > 0 ? (byCategory.indeterminate / total) * 100 : 0,
    points: issues.reduce((s, i) => s + (i.story_points || 0), 0),
    hours: issues.reduce((s, i) => s + (i.time_spent || 0), 0) / 3600,
    estimatedCoverage: issues.length ? (estimated / issues.length) * 100 : 0,
    assignees: new Set(issues.filter((i) => i.assignee_id).map((i) => i.assignee_id)).size,
    unassigned: issues.filter((i) => !i.assignee_id).length,
  }
}

/* -------------------------------------------------- cumulative flow (CFD) */

function statusHistoryFor(cloudId, issueIds) {
  const map = new Map()
  const chunk = 900
  for (let i = 0; i < issueIds.length; i += chunk) {
    const part = issueIds.slice(i, i + chunk)
    const rows = db
      .prepare(
        `SELECT issue_id, at, from_id, from_status, to_id, to_status
         FROM status_history
         WHERE cloud_id = ? AND issue_id IN (${placeholders(part.length)})
         ORDER BY at ASC`
      )
      .all(cloudId, ...part)
    for (const r of rows) {
      if (!map.has(r.issue_id)) map.set(r.issue_id, [])
      map.get(r.issue_id).push(r)
    }
  }
  return map
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10)
}

/**
 * Daily count of issues sitting in each status (or status category).
 *
 * Each issue contributes a step function: it enters at `created` in whatever
 * status its first recorded transition came *from* (falling back to its current
 * status when there is no history), then moves on each transition. Snapshots are
 * taken at every day boundary in the window.
 */
export function cumulativeFlow({
  issues,
  cloudId = activeCloudId(),
  from,
  to,
  groupBy = 'status',
  metric = 'count',
}) {
  if (!issues.length) return { series: [], keys: [], order: [], empty: true }

  const history = statusHistoryFor(cloudId, issues.map((i) => i.id))
  const statusMeta = new Map(
    db
      .prepare('SELECT id, name, category_key FROM statuses WHERE cloud_id = ?')
      .all(cloudId)
      .map((s) => [String(s.id), s])
  )

  const categoryLabel = { new: 'To do', indeterminate: 'In progress', done: 'Done' }

  const labelFor = (statusId, statusName) => {
    if (groupBy === 'category') {
      const cat = statusMeta.get(String(statusId))?.category_key || 'indeterminate'
      return categoryLabel[cat] || cat
    }
    return statusMeta.get(String(statusId))?.name || statusName || 'Unknown'
  }

  const toMs = (s) => (s ? new Date(s).getTime() : null)

  // Build per-issue event lists, and learn the workflow order while doing it.
  const orderScore = new Map() // label -> { sum, n, category }
  const noteOrder = (label, idx, category) => {
    if (!orderScore.has(label)) orderScore.set(label, { sum: 0, n: 0, category })
    const e = orderScore.get(label)
    e.sum += idx
    e.n += 1
    if (category) e.category = category
  }

  const events = [] // { t, label, delta, weight }
  let minT = Infinity
  let maxT = -Infinity

  for (const issue of issues) {
    const w = metricValue(issue, metric)
    if (!w) continue
    const created = toMs(issue.created)
    if (!created) continue
    const hist = (history.get(issue.id) || []).filter((h) => toMs(h.at) !== null)

    const firstLabel = hist.length
      ? labelFor(hist[0].from_id, hist[0].from_status)
      : labelFor(issue.status_id, issue.status_name)
    const firstCat = hist.length
      ? statusMeta.get(String(hist[0].from_id))?.category_key
      : issue.status_category

    events.push({ t: created, label: firstLabel, delta: w })
    noteOrder(firstLabel, 0, firstCat)
    minT = Math.min(minT, created)
    maxT = Math.max(maxT, created)

    let prev = firstLabel
    hist.forEach((h, idx) => {
      const t = Math.max(toMs(h.at), created)
      const next = labelFor(h.to_id, h.to_status)
      if (next === prev) return
      events.push({ t, label: prev, delta: -w })
      events.push({ t, label: next, delta: w })
      noteOrder(next, idx + 1, statusMeta.get(String(h.to_id))?.category_key)
      prev = next
      minT = Math.min(minT, t)
      maxT = Math.max(maxT, t)
    })
  }

  if (!events.length) return { series: [], keys: [], order: [], empty: true }

  const start = from ? new Date(from).getTime() : minT
  const end = to ? new Date(to).getTime() : Math.max(maxT, Date.now())
  const endDay = Math.floor(end / DAY) * DAY + DAY - 1

  events.sort((a, b) => a.t - b.t)

  // Workflow order: status category first, then average position in the flow.
  const catRank = { new: 0, indeterminate: 1, done: 2 }
  const order = [...orderScore.entries()]
    .map(([label, e]) => ({ label, mean: e.sum / e.n, rank: catRank[e.category] ?? 1 }))
    .sort((a, b) => a.rank - b.rank || a.mean - b.mean)
    .map((e) => e.label)

  const tally = new Map(order.map((k) => [k, 0]))
  const series = []
  let cursor = 0

  for (let day = Math.floor(start / DAY) * DAY; day <= endDay; day += DAY) {
    const boundary = day + DAY - 1
    while (cursor < events.length && events[cursor].t <= boundary) {
      const e = events[cursor]
      tally.set(e.label, (tally.get(e.label) || 0) + e.delta)
      cursor += 1
    }
    const point = { date: dayKey(day) }
    for (const k of order) point[k] = Math.max(0, Number((tally.get(k) || 0).toFixed(3)))
    series.push(point)
  }

  // Drop leading all-zero days so the chart starts where work starts.
  let firstNonEmpty = series.findIndex((p) => order.some((k) => p[k] > 0))
  if (firstNonEmpty > 0) series.splice(0, firstNonEmpty)

  return { series, keys: order, order, groupBy, metric, empty: series.length === 0 }
}

/* -------------------------------------------------------------- hierarchy */

function nearestAncestorAtLevel(issue, byId, level) {
  let cur = issue
  const seen = new Set()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.hierarchy_level === level) return cur
    if (cur.hierarchy_level > level) return null
    cur = cur.parent_id ? byId.get(cur.parent_id) : null
  }
  return null
}

function ancestorAtOrAbove(issue, byId, level) {
  let cur = issue
  const seen = new Set()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.hierarchy_level >= level) return cur
    cur = cur.parent_id ? byId.get(cur.parent_id) : null
  }
  return null
}

/** Nest an issue set into a parent/child tree with rolled-up completion. */
export function buildTree({ issues, metric = 'count', rootIds = null }) {
  const byId = new Map(issues.map((i) => [i.id, i]))
  const nodes = new Map()

  for (const i of issues) {
    nodes.set(i.id, {
      id: i.id,
      key: i.key,
      summary: i.summary,
      type: i.type_name,
      level: i.hierarchy_level,
      status: i.status_name,
      category: i.status_category,
      assignee: i.assignee_name,
      assigneeId: i.assignee_id,
      project: i.project_key,
      points: i.story_points || 0,
      hours: (i.time_spent || 0) / 3600,
      created: i.created,
      resolved: i.resolved,
      updated: i.updated,
      children: [],
    })
  }

  const roots = []
  for (const i of issues) {
    const node = nodes.get(i.id)
    const parent = i.parent_id ? nodes.get(i.parent_id) : null
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }

  const rollup = (node) => {
    let total = 0
    let done = 0
    let inProgress = 0
    let leaves = 0
    let leafDone = 0

    const own = metric === 'points' ? node.points : metric === 'timespent' ? node.hours : 1
    if (!node.children.length) {
      leaves = 1
      leafDone = node.category === 'done' ? 1 : 0
      total = own
      done = node.category === 'done' ? own : 0
      inProgress = node.category === 'indeterminate' ? own : 0
    } else {
      for (const c of node.children) {
        const r = rollup(c)
        total += r.total
        done += r.done
        inProgress += r.inProgress
        leaves += r.leaves
        leafDone += r.leafDone
      }
      // A parent with children whose children carry no metric value still has
      // its own value (e.g. an epic with unestimated stories).
      if (total === 0 && own > 0) {
        total = own
        done = node.category === 'done' ? own : 0
      }
    }

    node.rollup = {
      total,
      done,
      inProgress,
      todo: Math.max(0, total - done - inProgress),
      leaves,
      leafDone,
      percent: total > 0 ? (done / total) * 100 : 0,
      countPercent: leaves > 0 ? (leafDone / leaves) * 100 : 0,
    }
    return node.rollup
  }

  for (const r of roots) rollup(r)

  const filtered = rootIds ? roots.filter((r) => rootIds.includes(r.id) || rootIds.includes(r.key)) : roots
  filtered.sort((a, b) => (b.rollup.total - a.rollup.total) || a.key.localeCompare(b.key))
  return filtered
}

/* ----------------------------------------------------------------- sankey */

const DIMENSIONS = {
  assignee: {
    label: 'Assignee',
    of: (i) => i.assignee_name || 'Unassigned',
    id: (i) => i.assignee_id || 'unassigned',
  },
  reporter: { label: 'Reporter', of: (i) => i.reporter_name || 'Unknown', id: (i) => i.reporter_id || 'unknown' },
  project: { label: 'Project', of: (i) => i.project_key || 'None', id: (i) => i.project_key || 'none' },
  status: { label: 'Status', of: (i) => i.status_name || 'Unknown', id: (i) => `s:${i.status_id}` },
  category: {
    label: 'Progress',
    of: (i) => ({ new: 'To do', indeterminate: 'In progress', done: 'Done' })[i.status_category] || 'Unknown',
    id: (i) => `c:${i.status_category}`,
  },
  type: { label: 'Issue type', of: (i) => i.type_name || 'Unknown', id: (i) => `t:${i.type_id}` },
  priority: { label: 'Priority', of: (i) => i.priority || 'None', id: (i) => `p:${i.priority || 'none'}` },
  epic: { label: 'Epic', hierarchy: 1 },
  initiative: { label: 'Initiative', hierarchy: 2, orAbove: true },
}

export const SANKEY_DIMENSIONS = Object.entries(DIMENSIONS).map(([k, v]) => ({
  key: k,
  label: v.label,
}))

/**
 * Flow between ordered dimensions, e.g. assignee -> epic -> progress.
 * Node ids are namespaced by column so the same name in two columns stays two
 * nodes, and a value stays with the entity rather than its rank.
 */
export function sankey({ issues, dimensions = ['assignee', 'epic', 'category'], metric = 'count', maxPerColumn = 12 }) {
  const byId = new Map(issues.map((i) => [i.id, i]))
  const dims = dimensions.filter((d) => DIMENSIONS[d]).slice(0, 4)
  if (dims.length < 2) return { nodes: [], links: [], dimensions: dims }

  const resolve = (issue, dim) => {
    const def = DIMENSIONS[dim]
    if (def.hierarchy !== undefined) {
      const node = def.orAbove
        ? ancestorAtOrAbove(issue, byId, def.hierarchy)
        : nearestAncestorAtLevel(issue, byId, def.hierarchy)
      if (!node) return { id: `${dim}:none`, name: `No ${def.label.toLowerCase()}` }
      return { id: `${dim}:${node.id}`, name: `${node.key} ${node.summary}`.slice(0, 60), key: node.key }
    }
    return { id: `${dim}:${def.id(issue)}`, name: String(def.of(issue)) }
  }

  // Column totals decide which members survive the per-column cap.
  const columnTotals = dims.map(() => new Map())
  const rowsForIssue = []

  for (const issue of issues) {
    const w = metricValue(issue, metric)
    if (!w) continue
    const path = dims.map((d) => resolve(issue, d))
    rowsForIssue.push({ path, w })
    path.forEach((p, c) => {
      const m = columnTotals[c]
      m.set(p.id, { ...p, value: (m.get(p.id)?.value || 0) + w })
    })
  }

  const keep = columnTotals.map((m, c) => {
    const sorted = [...m.values()].sort((a, b) => b.value - a.value)
    const survivors = new Set(sorted.slice(0, maxPerColumn).map((n) => n.id))
    return { survivors, dropped: Math.max(0, sorted.length - maxPerColumn), col: c }
  })

  const nodes = new Map()
  const links = new Map()

  const nodeFor = (p, col) => {
    const kept = keep[col].survivors.has(p.id)
    const id = kept ? p.id : `${dims[col]}:__other__`
    const name = kept ? p.name : `Other (${keep[col].dropped})`
    if (!nodes.has(id)) {
      nodes.set(id, { id, name, column: col, dimension: dims[col], value: 0, key: p.key })
    }
    return nodes.get(id)
  }

  for (const { path, w } of rowsForIssue) {
    const resolved = path.map((p, c) => nodeFor(p, c))
    resolved.forEach((n) => {
      n.value += w
    })
    for (let c = 0; c < resolved.length - 1; c += 1) {
      const key = `${resolved[c].id}\u0000${resolved[c + 1].id}`
      const existing = links.get(key)
      if (existing) existing.value += w
      else links.set(key, { source: resolved[c].id, target: resolved[c + 1].id, value: w })
    }
  }

  return {
    nodes: [...nodes.values()],
    links: [...links.values()].filter((l) => l.value > 0),
    dimensions: dims,
    metric,
    truncated: keep.some((k) => k.dropped > 0),
  }
}

/* ------------------------------------------------------------ per-person */

export function peopleBreakdown({ issues, metric = 'count' }) {
  const map = new Map()
  for (const i of issues) {
    const id = i.assignee_id || 'unassigned'
    if (!map.has(id)) {
      map.set(id, {
        id,
        name: i.assignee_name || 'Unassigned',
        avatar: i.assignee_avatar,
        total: 0,
        done: 0,
        inProgress: 0,
        todo: 0,
        issues: 0,
        points: 0,
        hours: 0,
      })
    }
    const e = map.get(id)
    const w = metricValue(i, metric)
    e.total += w
    e.issues += 1
    e.points += i.story_points || 0
    e.hours += (i.time_spent || 0) / 3600
    if (i.status_category === 'done') e.done += w
    else if (i.status_category === 'indeterminate') e.inProgress += w
    else e.todo += w
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
}

/* -------------------------------------------------------------- breakdown */

/**
 * Generic grouped rollup: issues bucketed by any DIMENSIONS key, each bucket
 * split by progress category. Powers the configurable "Breakdown" widget.
 */
export function breakdown({ issues, groupBy = 'assignee', metric = 'count', max = 30 }) {
  const def = DIMENSIONS[groupBy] || DIMENSIONS.assignee
  const byId = new Map(issues.map((i) => [i.id, i]))

  const resolve = (issue) => {
    if (def.hierarchy !== undefined) {
      const node = def.orAbove
        ? ancestorAtOrAbove(issue, byId, def.hierarchy)
        : nearestAncestorAtLevel(issue, byId, def.hierarchy)
      if (!node) return { id: 'none', name: `No ${def.label.toLowerCase()}` }
      return { id: String(node.id), name: `${node.key} ${node.summary}`.slice(0, 60) }
    }
    return { id: String(def.id(issue)), name: String(def.of(issue)) }
  }

  const map = new Map()
  for (const i of issues) {
    const g = resolve(i)
    if (!map.has(g.id)) {
      map.set(g.id, { id: g.id, name: g.name, total: 0, done: 0, inProgress: 0, todo: 0, issues: 0 })
    }
    const e = map.get(g.id)
    const w = metricValue(i, metric)
    e.total += w
    e.issues += 1
    if (i.status_category === 'done') e.done += w
    else if (i.status_category === 'indeterminate') e.inProgress += w
    else e.todo += w
  }

  const rows = [...map.values()].sort((a, b) => b.total - a.total)
  return { groupBy, metric, groups: rows.length, rows: rows.slice(0, max) }
}

/* --------------------------------------------------------------- crosstab */

/**
 * Two-dimensional rollup: rows by `groupBy`, each split across `stackBy`.
 * Stacks beyond the palette fold into "Other"; values are keyed by stack name.
 */
export function crosstab({
  issues,
  groupBy = 'project',
  stackBy = 'type',
  metric = 'count',
  maxGroups = 30,
  maxStacks = 8,
}) {
  const byId = new Map(issues.map((i) => [i.id, i]))
  const resolverFor = (dimKey) => {
    const def = DIMENSIONS[dimKey] || DIMENSIONS.assignee
    return (issue) => {
      if (def.hierarchy !== undefined) {
        const node = def.orAbove
          ? ancestorAtOrAbove(issue, byId, def.hierarchy)
          : nearestAncestorAtLevel(issue, byId, def.hierarchy)
        return node
          ? { id: String(node.id), name: `${node.key} ${node.summary}`.slice(0, 60) }
          : { id: `${dimKey}:none`, name: `No ${def.label.toLowerCase()}` }
      }
      return { id: String(def.id(issue)), name: String(def.of(issue)) }
    }
  }
  const groupOf = resolverFor(groupBy)
  const stackOf = resolverFor(stackBy)

  const cells = issues.map((i) => ({ g: groupOf(i), s: stackOf(i), w: metricValue(i, metric) }))

  const stackTotals = new Map()
  for (const c of cells) stackTotals.set(c.s.name, (stackTotals.get(c.s.name) || 0) + c.w)
  const topStacks = [...stackTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxStacks)
    .map(([n]) => n)
  const keepStacks = new Set(topStacks)
  const droppedStacks = stackTotals.size - keepStacks.size
  const otherStack = droppedStacks > 0 ? `Other (${droppedStacks})` : null
  const keys = otherStack ? [...topStacks, otherStack] : topStacks

  const rows = new Map()
  for (const c of cells) {
    if (!rows.has(c.g.id)) {
      rows.set(c.g.id, {
        id: c.g.id,
        name: c.g.name,
        total: 0,
        issues: 0,
        values: Object.fromEntries(keys.map((k) => [k, 0])),
      })
    }
    const row = rows.get(c.g.id)
    row.total += c.w
    row.issues += 1
    row.values[keepStacks.has(c.s.name) ? c.s.name : otherStack] += c.w
  }

  const sorted = [...rows.values()].sort((a, b) => b.total - a.total)
  return { groupBy, stackBy, metric, keys, groups: sorted.length, rows: sorted.slice(0, maxGroups) }
}

/* ------------------------------------------------------------- timeseries */

/**
 * Weekly metric per dimension group, CFD-shaped ({series, keys}) so the same
 * chart components can draw it. `mode` picks the dating event (resolved or
 * created); `accumulate` turns weekly totals into a running sum, with work
 * before `from` folded into the starting level rather than dropped.
 */
export function timeseries({
  issues,
  groupBy = 'assignee',
  metric = 'count',
  mode = 'completed',
  accumulate = true,
  from,
  maxGroups = 6,
}) {
  const def = DIMENSIONS[groupBy] || DIMENSIONS.assignee
  const byId = new Map(issues.map((i) => [i.id, i]))

  const nameFor = (issue) => {
    if (def.hierarchy !== undefined) {
      const node = def.orAbove
        ? ancestorAtOrAbove(issue, byId, def.hierarchy)
        : nearestAncestorAtLevel(issue, byId, def.hierarchy)
      return node ? `${node.key} ${node.summary}`.slice(0, 60) : `No ${def.label.toLowerCase()}`
    }
    return String(def.of(issue))
  }

  const events = []
  for (const i of issues) {
    const date = mode === 'created' ? i.created : i.resolved
    if (!date) continue
    const w = metricValue(i, metric)
    if (!w) continue
    events.push({ ts: new Date(date).getTime(), name: nameFor(i), w })
  }
  if (!events.length) return { series: [], keys: [], groupBy, metric, mode, empty: true }

  // Cap the group count: the busiest survive, the rest fold into "Other".
  const totals = new Map()
  for (const e of events) totals.set(e.name, (totals.get(e.name) || 0) + e.w)
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxGroups).map(([n]) => n)
  const keep = new Set(top)
  const dropped = totals.size - keep.size
  const otherKey = dropped > 0 ? `Other (${dropped})` : null
  const keys = otherKey ? [...top, otherKey] : top
  const keyFor = (name) => (keep.has(name) ? name : otherKey)

  const startOfWeek = (ts) => {
    const d = new Date(ts)
    const day = (d.getUTCDay() + 6) % 7 // Monday = 0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)
  }

  const WEEK = 7 * DAY
  const now = Date.now()
  const firstEvent = Math.min(...events.map((e) => e.ts))
  const fromTs = from ? new Date(`${from}T00:00:00Z`).getTime() : firstEvent
  // 260 weeks (~5y) keeps an all-time series from ballooning.
  const start = startOfWeek(Math.max(fromTs, now - 260 * WEEK))
  const end = startOfWeek(now)

  const zero = () => Object.fromEntries(keys.map((k) => [k, 0]))
  const weeks = new Map()
  for (let t = start; t <= end; t += WEEK) weeks.set(t, zero())

  const baseline = zero()
  for (const e of events) {
    const k = keyFor(e.name)
    const wk = startOfWeek(e.ts)
    if (wk < start) {
      if (accumulate) baseline[k] += e.w
      continue
    }
    const bucket = weeks.get(wk)
    if (bucket) bucket[k] += e.w
  }

  const running = { ...baseline }
  const series = [...weeks.entries()].map(([t, bucket]) => {
    const point = { date: dayKey(t) }
    for (const k of keys) {
      if (accumulate) {
        running[k] += bucket[k]
        point[k] = running[k]
      } else {
        point[k] = bucket[k]
      }
    }
    return point
  })

  return { series, keys, groupBy, metric, mode, accumulate, empty: series.length < 2 }
}

/* ---------------------------------------------------------------- burn-up */

/**
 * The story of a scope over time: how much work existed each day, how much of
 * it was done, and — per week — how much arrived versus finished. Rebuilt from
 * issue change history, counting leaf issues only.
 */
export function burnup({ issues, cloudId = activeCloudId(), metric = 'count', from }) {
  const parents = new Set(issues.map((i) => i.parent_id).filter(Boolean))
  const leaves = issues.filter((i) => !parents.has(i.id))
  if (!leaves.length) return { series: [], weekly: [], empty: true }

  const history = statusHistoryFor(cloudId, leaves.map((i) => i.id))
  const statusMeta = new Map(
    db.prepare('SELECT id, category_key FROM statuses WHERE cloud_id = ?').all(cloudId)
      .map((s) => [String(s.id), s.category_key])
  )
  const catOf = (statusId, fallback = 'indeterminate') =>
    statusMeta.get(String(statusId)) || fallback

  const toMs = (s) => (s ? new Date(s).getTime() : null)
  const scopeEvents = [] // { t, w }
  const doneEvents = [] // { t, w } (negative when leaving done)
  const perIssue = [] // { created, firstDone, w }
  let minT = Infinity

  for (const issue of leaves) {
    const w = metricValue(issue, metric)
    if (!w) continue
    const created = toMs(issue.created)
    if (!created) continue
    minT = Math.min(minT, created)
    scopeEvents.push({ t: created, w })

    const hist = (history.get(issue.id) || []).filter((h) => toMs(h.at) !== null)
    let cat = hist.length ? catOf(hist[0].from_id, 'new') : issue.status_category || 'new'
    let firstDone = null

    if (cat === 'done') {
      doneEvents.push({ t: created, w })
      firstDone = created
    }
    for (const h of hist) {
      const t = Math.max(toMs(h.at), created)
      const next = catOf(h.to_id)
      if (next === 'done' && cat !== 'done') {
        doneEvents.push({ t, w })
        if (firstDone === null) firstDone = t
      } else if (next !== 'done' && cat === 'done') {
        doneEvents.push({ t, w: -w })
      }
      cat = next
    }
    // Current state wins when history is missing its final hop.
    if (cat !== 'done' && issue.status_category === 'done') {
      const t = toMs(issue.resolved) ?? toMs(issue.status_changed) ?? created
      doneEvents.push({ t: Math.max(t, created), w })
      if (firstDone === null) firstDone = Math.max(t, created)
    }
    perIssue.push({ created, firstDone, w })
  }

  if (!scopeEvents.length) return { series: [], weekly: [], empty: true }

  scopeEvents.sort((a, b) => a.t - b.t)
  doneEvents.sort((a, b) => a.t - b.t)

  const start = Math.floor(minT / DAY) * DAY
  const end = Date.now()
  const fromMs = from ? new Date(from).getTime() : start
  const series = []
  let scope = 0
  let done = 0
  let si = 0
  let di = 0

  for (let day = start; day <= end; day += DAY) {
    const boundary = day + DAY - 1
    while (si < scopeEvents.length && scopeEvents[si].t <= boundary) scope += scopeEvents[si++].w
    while (di < doneEvents.length && doneEvents[di].t <= boundary) done += doneEvents[di++].w
    if (boundary < fromMs) continue
    series.push({
      date: dayKey(day),
      scope: Number(scope.toFixed(2)),
      done: Number(Math.max(0, done).toFixed(2)),
      pct: scope > 0 ? Number(((Math.max(0, done) / scope) * 100).toFixed(2)) : 0,
    })
  }

  // Long histories get thinned so the chart stays a readable series.
  const step = Math.ceil(series.length / 400)
  const thinned = step > 1 ? series.filter((_, i) => i % step === 0 || i === series.length - 1) : series

  const weekStart = (ts) => {
    const d = new Date(ts)
    const day = (d.getUTCDay() + 6) % 7
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)
  }
  const weekly = new Map()
  const bucket = (t) => {
    const k = dayKey(weekStart(t))
    if (!weekly.has(k)) weekly.set(k, { week: k, added: 0, completed: 0 })
    return weekly.get(k)
  }
  for (const p of perIssue) {
    if (p.created >= fromMs) bucket(p.created).added += p.w
    if (p.firstDone !== null && p.firstDone >= fromMs) bucket(p.firstDone).completed += p.w
  }

  return {
    metric,
    series: thinned,
    weekly: [...weekly.values()].sort((a, b) => a.week.localeCompare(b.week)),
  }
}

/* ------------------------------------------------------- temporal network */

/**
 * The delivery network with time attached: each node carries its creation time
 * and category transitions, so the client can replay the scope's history.
 */
export function graphTimeline({ issues, cloudId = activeCloudId(), maxStories = 250 }) {
  const always = issues.filter((i) => i.hierarchy_level >= 1 || i.type_name === 'Idea')
  const stories = issues
    .filter((i) => i.hierarchy_level === 0 && i.type_name !== 'Idea')
    .sort((a, b) => (a.created || '').localeCompare(b.created || ''))
  const kept = stories.slice(0, maxStories)
  const included = [...always, ...kept]
  const nodeSet = new Map(included.map((i) => [i.id, i]))

  const history = statusHistoryFor(cloudId, included.map((i) => i.id))
  const statusMeta = new Map(
    db.prepare('SELECT id, category_key FROM statuses WHERE cloud_id = ?').all(cloudId)
      .map((s) => [String(s.id), s.category_key])
  )
  const catOf = (statusId, fallback = 'indeterminate') =>
    statusMeta.get(String(statusId)) || fallback
  const toMs = (s) => (s ? new Date(s).getTime() : null)

  const nodes = included
    .map((i) => {
      const created = toMs(i.created)
      if (!created) return null
      const hist = (history.get(i.id) || []).filter((h) => toMs(h.at) !== null)
      const initial = hist.length ? catOf(hist[0].from_id, 'new') : i.status_category || 'new'
      const transitions = []
      let cat = initial
      for (const h of hist) {
        const next = catOf(h.to_id)
        if (next === cat) continue
        transitions.push({ at: Math.max(toMs(h.at), created), cat: next })
        cat = next
      }
      if (!hist.length && (i.status_category || 'new') !== initial) {
        transitions.push({ at: toMs(i.status_changed) ?? created, cat: i.status_category })
      }
      return {
        id: i.id,
        key: i.key,
        summary: i.summary,
        type: i.type_name,
        level: i.hierarchy_level,
        project: i.project_key,
        created,
        initial,
        transitions,
      }
    })
    .filter(Boolean)

  const edges = []
  for (const i of included) {
    if (i.parent_id && nodeSet.has(i.parent_id)) {
      edges.push({ source: i.parent_id, target: i.id, kind: 'parent' })
    }
  }
  const ids = [...nodeSet.keys()]
  const chunk = 450
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk)
    const rows = db
      .prepare(
        `SELECT source_id, target_id, type FROM issue_links
         WHERE cloud_id = ? AND direction = 'outward'
           AND source_id IN (${placeholders(part.length)})`
      )
      .all(cloudId, ...part)
    for (const r of rows) {
      if (nodeSet.has(r.target_id)) {
        edges.push({ source: r.source_id, target: r.target_id, kind: 'link', label: r.type })
      }
    }
  }

  return { nodes, edges, storiesDropped: Math.max(0, stories.length - maxStories) }
}

/* ------------------------------------------------------------ chord flows */

/**
 * Directed flows between entities of one kind, for a chord diagram.
 *
 * `handovers` — who hands work to whom, from assignee change history.
 * `projects`  — issue links crossing project boundaries.
 *
 * Entities are capped at 8 (the categorical palette's limit); the rest fold
 * into "Other", and self-flows are dropped after folding.
 */
export function chordFlows({ issues, cloudId = activeCloudId(), flow = 'handovers', maxEntities = 8 }) {
  const raw = new Map() // "from\u0000to" -> value

  const add = (from, to, v = 1) => {
    if (!from || !to || from === to) return
    const k = `${from}\u0000${to}`
    raw.set(k, (raw.get(k) || 0) + v)
  }

  if (flow === 'projects') {
    const inScope = new Set(issues.map((i) => i.id))
    const ids = [...inScope]
    const chunk = 900
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk)
      const rows = db
        .prepare(
          `SELECT s.project_key AS a, t.project_key AS b, COUNT(*) AS n
           FROM issue_links l
           JOIN issues s ON s.cloud_id = l.cloud_id AND s.id = l.source_id
           JOIN issues t ON t.cloud_id = l.cloud_id AND t.id = l.target_id
           WHERE l.cloud_id = ? AND l.direction = 'outward'
             AND l.source_id IN (${placeholders(part.length)})
           GROUP BY s.project_key, t.project_key`
        )
        .all(cloudId, ...part)
      for (const r of rows) add(r.a, r.b, r.n)
    }
  } else {
    const ids = issues.map((i) => i.id)
    const chunk = 900
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk)
      const rows = db
        .prepare(
          `SELECT from_name AS a, to_name AS b, COUNT(*) AS n
           FROM assignee_history
           WHERE cloud_id = ? AND from_id IS NOT NULL AND to_id IS NOT NULL
             AND issue_id IN (${placeholders(part.length)})
           GROUP BY from_name, to_name`
        )
        .all(cloudId, ...part)
      for (const r of rows) add(r.a, r.b, r.n)
    }
  }

  // Rank entities by total involvement, fold the tail into "Other".
  const totals = new Map()
  for (const [k, v] of raw) {
    const [a, b] = k.split('\u0000')
    totals.set(a, (totals.get(a) || 0) + v)
    totals.set(b, (totals.get(b) || 0) + v)
  }
  const ranked = [...totals.entries()].sort((x, y) => y[1] - x[1])
  const keep = new Set(ranked.slice(0, maxEntities).map(([name]) => name))
  const fold = (name) => (keep.has(name) ? name : 'Other')

  const flows = new Map()
  for (const [k, v] of raw) {
    const [a, b] = k.split('\u0000')
    const fa = fold(a)
    const fb = fold(b)
    if (fa === fb) continue
    const fk = `${fa}\u0000${fb}`
    flows.set(fk, (flows.get(fk) || 0) + v)
  }

  const entities = ranked.filter(([name]) => keep.has(name)).map(([name, total]) => ({ id: name, name, total }))
  if (ranked.length > maxEntities) {
    entities.push({ id: 'Other', name: `Other (${ranked.length - maxEntities})`, total: 0 })
  }

  return {
    flow,
    entities,
    flows: [...flows.entries()].map(([k, value]) => {
      const [source, target] = k.split('\u0000')
      return { source, target, value }
    }),
    truncated: ranked.length > maxEntities,
  }
}

/* ------------------------------------------------------------- cycle time */

function quantile(sorted, p) {
  if (!sorted.length) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/** Days from created to resolved, grouped — the dot-plot's data. */
export function cycleTime({ issues, groupBy = 'epic' }) {
  const byId = new Map(issues.map((i) => [i.id, i]))

  const groupOf = (issue) => {
    if (groupBy === 'assignee') return issue.assignee_name || 'Unassigned'
    if (groupBy === 'project') return issue.project_key || 'None'
    const epic = nearestAncestorAtLevel(issue, byId, 1)
    return epic ? `${epic.key} ${epic.summary}` : 'No epic'
  }

  const groups = new Map()
  for (const i of issues) {
    if (!i.resolved || !i.created || i.hierarchy_level > 0) continue
    const days = (new Date(i.resolved) - new Date(i.created)) / DAY
    if (!Number.isFinite(days) || days < 0) continue
    const key = groupOf(i)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(days)
  }

  const rows = [...groups.entries()]
    .map(([name, arr]) => {
      const sorted = arr.sort((a, b) => a - b)
      return {
        name,
        n: sorted.length,
        p50: quantile(sorted, 0.5),
        p90: quantile(sorted, 0.9),
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
      }
    })
    .filter((r) => r.n >= 2)
    .sort((a, b) => b.p50 - a.p50)

  return { groupBy, rows }
}

/* ---------------------------------------------------------------- network */

/**
 * The delivery network: initiatives, epics and ideas as nodes; parent edges and
 * issue links as edges. Leaf work rolls up into each node's size/completion.
 */
export function graphData({ issues, includeStories = false, maxStories = 120 }) {
  const byId = new Map(issues.map((i) => [i.id, i]))
  const nodeSet = new Map()

  for (const i of issues) {
    if (i.hierarchy_level >= 1 || i.type_name === 'Idea') nodeSet.set(i.id, i)
  }

  // Roll leaves up into every ancestor that is a node.
  const rollups = new Map() // nodeId -> { leaves, done, points }
  const bump = (nodeId, issue) => {
    if (!rollups.has(nodeId)) rollups.set(nodeId, { leaves: 0, done: 0, points: 0 })
    const r = rollups.get(nodeId)
    r.leaves += 1
    r.points += issue.story_points || 0
    if (issue.status_category === 'done') r.done += 1
  }
  for (const i of issues) {
    if (i.hierarchy_level >= 1) continue
    let cur = i
    const seen = new Set()
    while (cur?.parent_id && !seen.has(cur.parent_id)) {
      seen.add(cur.parent_id)
      if (nodeSet.has(cur.parent_id)) bump(cur.parent_id, i)
      cur = byId.get(cur.parent_id)
    }
  }

  let storyCount = 0
  let storiesDropped = 0
  if (includeStories) {
    for (const i of issues) {
      if (i.hierarchy_level !== 0 || i.type_name === 'Idea') continue
      if (!i.parent_id || !nodeSet.has(i.parent_id)) continue
      if (storyCount >= maxStories) {
        storiesDropped += 1
        continue
      }
      nodeSet.set(i.id, i)
      storyCount += 1
    }
  }

  const nodes = [...nodeSet.values()].map((i) => {
    const r = rollups.get(i.id)
    return {
      id: i.id,
      key: i.key,
      summary: i.summary,
      type: i.type_name,
      level: i.hierarchy_level,
      project: i.project_key,
      category: i.status_category,
      assignee: i.assignee_name,
      leaves: r?.leaves ?? 0,
      done: r?.done ?? 0,
      points: r?.points ?? (i.story_points || 0),
    }
  })

  const edges = []
  for (const i of nodeSet.values()) {
    if (i.parent_id && nodeSet.has(i.parent_id)) {
      edges.push({ source: i.parent_id, target: i.id, kind: 'parent' })
    }
  }
  const ids = [...nodeSet.keys()]
  const chunk = 450
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk)
    const rows = db
      .prepare(
        `SELECT source_id, target_id, type FROM issue_links
         WHERE cloud_id = ? AND direction = 'outward'
           AND source_id IN (${placeholders(part.length)})`
      )
      .all(activeCloudId(), ...part)
    for (const r of rows) {
      if (nodeSet.has(r.target_id)) {
        edges.push({ source: r.source_id, target: r.target_id, kind: 'link', label: r.type })
      }
    }
  }

  return { nodes, edges, storiesDropped }
}

/** Issues resolved per week — the throughput companion to the CFD. */
export function throughput({ issues, weeks = 12 }) {
  const now = Date.now()
  const startOfWeek = (ts) => {
    const d = new Date(ts)
    const day = (d.getUTCDay() + 6) % 7 // Monday = 0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)
  }
  const buckets = new Map()
  for (let w = weeks - 1; w >= 0; w -= 1) {
    buckets.set(dayKey(startOfWeek(now - w * 7 * DAY)), { week: dayKey(startOfWeek(now - w * 7 * DAY)), count: 0, points: 0 })
  }
  for (const i of issues) {
    if (!i.resolved) continue
    const k = dayKey(startOfWeek(new Date(i.resolved).getTime()))
    const b = buckets.get(k)
    if (b) {
      b.count += 1
      b.points += i.story_points || 0
    }
  }
  return [...buckets.values()]
}
