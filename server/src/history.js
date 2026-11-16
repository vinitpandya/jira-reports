import { db } from './db.js'
import { categoryForStatusName, categoryOf } from './reports.js'

/*
 * Point-in-time reconstruction of issues from their Jira changelogs.
 *
 * Every history-based report (burn-up, burn-down, added vs completed, CFD,
 * network replay) needs the same two answers for an issue on a given day:
 * which status category was it in, and was it part of the selected scope
 * (under the chosen epic / initiative) at that moment. Both live here so the
 * reports cannot drift apart again.
 */

function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',')
}

export const toMs = (s) => {
  if (!s) return null
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? t : null
}

/* ----------------------------------------------------------------- status */

/** Status transitions per issue, oldest first by actual instant. */
export function statusHistoryFor(cloudId, issueIds) {
  const map = new Map()
  const chunk = 900
  for (let i = 0; i < issueIds.length; i += chunk) {
    const part = issueIds.slice(i, i + chunk)
    const rows = db
      .prepare(
        `SELECT issue_id, at, from_id, from_status, to_id, to_status
         FROM status_history
         WHERE cloud_id = ? AND issue_id IN (${placeholders(part.length)})`
      )
      .all(cloudId, ...part)
    for (const r of rows) {
      const t = toMs(r.at)
      if (t === null) continue
      if (!map.has(r.issue_id)) map.set(r.issue_id, [])
      map.get(r.issue_id).push({ ...r, t })
    }
  }
  // Jira stamps changelogs in the author's offset, so the text does not sort
  // chronologically across authors — order by the parsed instant instead.
  for (const list of map.values()) list.sort((a, b) => a.t - b.t)
  return map
}

/**
 * Category resolver: by status id, falling back to the recorded status name so
 * a hop whose id is unknown (other workflow, renamed status) still lands in the
 * right category. User overrides apply through categoryForStatusName.
 */
export function statusCategoryResolver(cloudId) {
  const meta = new Map(
    db.prepare('SELECT id, name, category_key FROM statuses WHERE cloud_id = ?').all(cloudId)
      .map((s) => [String(s.id), s])
  )
  const catOf = (statusId, statusName, fallback = 'indeterminate') => {
    const m = meta.get(String(statusId))
    if (!m && !statusName) return fallback
    return categoryForStatusName(statusName || m?.name, m?.category_key || fallback)
  }
  return { meta, catOf }
}

/**
 * An issue's category over time: where it started and every category change.
 *
 * With a changelog, the first hop's `from` is the starting status. Without
 * one, the issue is assumed to have started in "to do" and moved to its
 * current category on its last category change (resolution date for done
 * work) — never at creation, which would count finished work as finished the
 * day it was raised. `inferred` flags issues reconstructed that way.
 */
export function categoryTimeline(issue, hist, catOf) {
  const created = toMs(issue.created)
  const current = categoryOf(issue)
  const steps = []
  if (hist && hist.length) {
    let cat = catOf(hist[0].from_id, hist[0].from_status, 'new')
    const initial = cat
    let lastT = created
    for (const h of hist) {
      const next = catOf(h.to_id, h.to_status)
      const t = Math.max(h.t, created)
      lastT = t
      if (next === cat) continue
      steps.push({ t, cat: next })
      cat = next
    }
    // Current state wins when history is missing its final hop.
    if (cat !== current) {
      const at = current === 'done' ? toMs(issue.resolved) ?? toMs(issue.status_changed) : toMs(issue.status_changed)
      steps.push({ t: Math.max(at ?? toMs(issue.updated) ?? lastT, lastT), cat: current })
    }
    return { initial, steps, inferred: false }
  }

  if (current === 'new') return { initial: 'new', steps, inferred: false }
  const at =
    (current === 'done' ? toMs(issue.resolved) : null) ??
    toMs(issue.status_changed) ??
    toMs(issue.updated) ??
    created
  const t = Math.max(at, created)
  // Created straight into its current category (an import, a "done" bug
  // logged after the fact): that is a fact, not an inference.
  if (t - created < 60_000) return { initial: current, steps, inferred: false }
  steps.push({ t, cat: current })
  return { initial: 'new', steps, inferred: true }
}

/** Category at instant t, given a timeline from categoryTimeline. */
export function categoryAt(timeline, t) {
  let cat = timeline.initial
  for (const s of timeline.steps) {
    if (s.t > t) break
    cat = s.cat
  }
  return cat
}

/* ----------------------------------------------------------------- parent */

/**
 * Former members of a scope: issues whose parent history ever pointed into
 * the set (an epic's story that was later moved elsewhere), plus their
 * current descendants. Repeats until nothing new turns up.
 */
export function expandWithFormerMembers(cloudId, issues) {
  const ids = new Set(issues.map((i) => i.id))
  const added = []
  let frontier = [...ids]
  for (let round = 0; round < 8 && frontier.length; round += 1) {
    const found = new Set()
    for (let i = 0; i < frontier.length; i += 400) {
      const part = frontier.slice(i, i + 400)
      const rows = db
        .prepare(
          `SELECT DISTINCT issue_id FROM parent_history
           WHERE cloud_id = ? AND (from_id IN (${placeholders(part.length)})
                                OR to_id IN (${placeholders(part.length)}))`
        )
        .all(cloudId, ...part, ...part)
      for (const r of rows) if (!ids.has(r.issue_id)) found.add(r.issue_id)
    }
    if (!found.size) break
    // Their current subtrees came along with them.
    const seed = [...found]
    const fresh = []
    for (let i = 0; i < seed.length; i += 400) {
      const part = seed.slice(i, i + 400)
      const rows = db
        .prepare(
          `WITH RECURSIVE tree(id) AS (
             SELECT id FROM issues WHERE cloud_id = @cid AND id IN (${placeholders(part.length)})
             UNION
             SELECT c.id FROM issues c JOIN tree t ON c.parent_id = t.id WHERE c.cloud_id = @cid
           )
           SELECT i.* FROM issues i JOIN tree t ON t.id = i.id WHERE i.cloud_id = @cid`
        )
        .all({ cid: cloudId }, ...part)
      for (const r of rows) {
        if (ids.has(r.id)) continue
        ids.add(r.id)
        added.push(r)
        fresh.push(r.id)
      }
    }
    frontier = fresh
  }
  return added
}

/**
 * Scope membership over time for a root-anchored scope (epics, initiatives).
 *
 * An issue is in scope at instant t when it is an anchor, or its parent at t
 * is in scope at t. Parents at t come from parent_history (parent field, Epic
 * Link, Parent Link); with no recorded move, the current parent is assumed to
 * have held since creation. Returns intervalsFor(id) → [[start, end], …] with
 * end = Infinity for open intervals.
 */
export function membershipTracker(cloudId, anchorIds) {
  const anchors = new Set(anchorIds)
  const nodes = new Map()
  const getIssue = db.prepare('SELECT id, parent_id, created, updated FROM issues WHERE cloud_id = ? AND id = ?')
  const getMoves = db.prepare(
    `SELECT at, field, from_id, to_id FROM parent_history WHERE cloud_id = ? AND issue_id = ?`
  )

  const node = (id) => {
    if (nodes.has(id)) return nodes.get(id)
    const row = getIssue.get(cloudId, id)
    const moves = getMoves
      .all(cloudId, id)
      .map((m) => ({ ...m, t: toMs(m.at) }))
      .filter((m) => m.t !== null)
      .sort((a, b) => a.t - b.t)
    const created = toMs(row?.created) ?? -Infinity
    // Legacy Epic Link and the parent field can both record one move (Jira's
    // own migration does); collapse to one parent timeline, last write wins.
    const initialParent = moves.length ? moves[0].from_id || null : row?.parent_id || null
    const changes = moves.map((m) => ({ t: m.t, parent: m.to_id || null }))
    const current = row?.parent_id || null
    const last = changes.length ? changes[changes.length - 1].parent : initialParent
    if (row && last !== current) {
      // History is missing the final move (sub-task parent, unlogged edit).
      const lastT = changes.length ? changes[changes.length - 1].t : created
      changes.push({ t: Math.max(toMs(row.updated) ?? lastT, lastT), parent: current })
    }
    const n = { id, created, initialParent, changes }
    nodes.set(id, n)
    return n
  }

  const parentAt = (n, t) => {
    let p = n.initialParent
    for (const c of n.changes) {
      if (c.t > t) break
      p = c.parent
    }
    return p
  }

  const inScopeAt = (id, t, depth = 0) => {
    if (anchors.has(id)) return true
    if (!id || depth > 12) return false
    const p = parentAt(node(id), t)
    return p ? inScopeAt(p, t, depth + 1) : false
  }

  /** Every instant at which this issue's ancestry could have changed. */
  const changePoints = (id) => {
    const out = new Set()
    const seen = new Set()
    const stack = [id]
    while (stack.length) {
      const cur = stack.pop()
      if (!cur || seen.has(cur) || anchors.has(cur)) continue
      seen.add(cur)
      const n = node(cur)
      if (n.initialParent) stack.push(n.initialParent)
      for (const c of n.changes) {
        out.add(c.t)
        if (c.parent) stack.push(c.parent)
      }
    }
    return [...out].sort((a, b) => a - b)
  }

  const intervalsFor = (id) => {
    const n = node(id)
    const start = n.created
    const points = [start, ...changePoints(id).filter((t) => t > start)]
    const out = []
    let open = null
    for (const t of points) {
      const inside = inScopeAt(id, t)
      if (inside && open === null) open = t
      else if (!inside && open !== null) {
        out.push([open, t])
        open = null
      }
    }
    if (open !== null) out.push([open, Infinity])
    return out
  }

  return { intervalsFor }
}
