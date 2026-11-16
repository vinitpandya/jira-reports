import { db, getConfig, setConfig } from './db.js'
import { activeCloudId, fetchAccessibleResources } from './oauth.js'
import { jiraFetch, searchIssues, fetchChangelogs, fetchIssueChangelog } from './jiraClient.js'

/* ------------------------------------------------------------------ state */

let current = null // { runId, mode, phase, message, counts, startedAt, controller }

export function syncStatus() {
  const last = db
    .prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1')
    .get()
  return {
    running: !!current,
    phase: current?.phase ?? null,
    message: current?.message ?? null,
    counts: current?.counts ?? null,
    startedAt: current?.startedAt ?? null,
    last: last
      ? {
          id: last.id,
          mode: last.mode,
          status: last.status,
          startedAt: last.started_at,
          finishedAt: last.finished_at,
          stats: last.stats ? JSON.parse(last.stats) : null,
          error: last.error,
        }
      : null,
  }
}

export function cancelSync() {
  if (!current) return false
  current.controller.abort()
  return true
}

function progress(phase, message, extra = {}) {
  if (!current) return
  current.phase = phase
  current.message = message
  Object.assign(current.counts, extra)
}

/* ------------------------------------------------------------- field ids */

const STORY_POINT_NAMES = ['story points', 'story point estimate', 'story point']
const EPIC_LINK_NAMES = ['epic link']
const PARENT_LINK_NAMES = ['parent link']

/** Named fields captured verbatim into issues.custom_fields for reporting. */
export const TRACKED_FIELDS = [
  { label: 'Estimation Need Date', names: ['estimation need date'] },
  { label: 'Requested Due Date', names: ['requested due date'] },
  { label: 'Start Date', names: ['start date', 'start date[date]'] },
  { label: 'Due Date', names: ['due date', 'duedate'] },
  { label: 'Staging Date', names: ['staging date'] },
  { label: 'Epic HL Estimation', names: ['epic hl estimation'] },
]

function discoverFieldIds(cloudId) {
  const rows = db
    .prepare('SELECT id, name FROM fields WHERE cloud_id = ?')
    .all(cloudId)
  const byName = (names) =>
    rows.filter((r) => names.includes((r.name || '').trim().toLowerCase())).map((r) => r.id)

  const tracked = []
  for (const t of TRACKED_FIELDS) {
    const id = byName(t.names)[0]
    if (id) tracked.push({ id, label: t.label })
  }

  return {
    storyPoints: byName(STORY_POINT_NAMES),
    epicLink: byName(EPIC_LINK_NAMES)[0] || null,
    parentLink: byName(PARENT_LINK_NAMES)[0] || null,
    tracked,
  }
}

/* -------------------------------------------------------------- metadata */

async function syncMetadata(cloudId, signal) {
  progress('metadata', 'Reading fields, issue types and statuses…')

  const fields = await jiraFetch('/api/3/field', { cloudId })
  const fStmt = db.prepare(
    `INSERT INTO fields (cloud_id, id, name, custom, schema_type) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id, id) DO UPDATE SET name = excluded.name,
       custom = excluded.custom, schema_type = excluded.schema_type`
  )
  db.transaction(() => {
    for (const f of fields) {
      fStmt.run(cloudId, f.id, f.name, f.custom ? 1 : 0, f.schema?.type || null)
    }
  })()

  const types = await jiraFetch('/api/3/issuetype', { cloudId })
  const tStmt = db.prepare(
    `INSERT INTO issue_types (cloud_id, id, name, subtask, hierarchy_level, icon)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id, id) DO UPDATE SET name = excluded.name,
       subtask = excluded.subtask, hierarchy_level = excluded.hierarchy_level,
       icon = excluded.icon`
  )
  db.transaction(() => {
    for (const t of types) {
      const level = t.hierarchyLevel ?? (t.subtask ? -1 : 0)
      tStmt.run(cloudId, t.id, t.name, t.subtask ? 1 : 0, level, t.iconUrl || null)
    }
  })()

  const statuses = await jiraFetch('/api/3/status', { cloudId })
  const sStmt = db.prepare(
    `INSERT INTO statuses (cloud_id, id, name, category_key, category_name)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id, id) DO UPDATE SET name = excluded.name,
       category_key = excluded.category_key, category_name = excluded.category_name`
  )
  db.transaction(() => {
    for (const s of statuses) {
      sStmt.run(cloudId, s.id, s.name, s.statusCategory?.key || null, s.statusCategory?.name || null)
    }
  })()

  progress('metadata', 'Reading projects…')
  const pStmt = db.prepare(
    `INSERT INTO projects (cloud_id, id, key, name, type_key, style, avatar, category, lead)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id, id) DO UPDATE SET key = excluded.key, name = excluded.name,
       type_key = excluded.type_key, style = excluded.style, avatar = excluded.avatar,
       category = excluded.category, lead = excluded.lead`
  )
  let startAt = 0
  let projectCount = 0
  for (;;) {
    if (signal.aborted) throw new Error('Sync cancelled')
    const page = await jiraFetch('/api/3/project/search', {
      cloudId,
      query: { startAt, maxResults: 50, expand: 'lead,description,projectKeys' },
    })
    const values = page?.values ?? []
    db.transaction(() => {
      for (const p of values) {
        pStmt.run(
          cloudId,
          p.id,
          p.key,
          p.name,
          p.projectTypeKey || null,
          p.style || null,
          p.avatarUrls?.['48x48'] || null,
          p.projectCategory?.name || null,
          p.lead?.displayName || null
        )
      }
    })()
    projectCount += values.length
    startAt += values.length
    if (page?.isLast || !values.length) break
  }

  progress('metadata', 'Metadata up to date', { projects: projectCount })
  return discoverFieldIds(cloudId)
}

/* ---------------------------------------------------------------- issues */

const upsertIssue = db.prepare(`
  INSERT INTO issues (
    cloud_id, id, key, project_id, project_key, type_id, type_name, hierarchy_level,
    status_id, status_name, status_category, resolution, priority,
    parent_id, parent_key, assignee_id, assignee_name, assignee_avatar,
    reporter_id, reporter_name, summary, labels, components,
    story_points, time_spent, original_estimate,
    created, updated, resolved, status_changed, custom_fields
  ) VALUES (
    @cloud_id, @id, @key, @project_id, @project_key, @type_id, @type_name, @hierarchy_level,
    @status_id, @status_name, @status_category, @resolution, @priority,
    @parent_id, @parent_key, @assignee_id, @assignee_name, @assignee_avatar,
    @reporter_id, @reporter_name, @summary, @labels, @components,
    @story_points, @time_spent, @original_estimate,
    @created, @updated, @resolved, @status_changed, @custom_fields
  )
  ON CONFLICT(cloud_id, id) DO UPDATE SET
    key = excluded.key, project_id = excluded.project_id, project_key = excluded.project_key,
    type_id = excluded.type_id, type_name = excluded.type_name,
    hierarchy_level = excluded.hierarchy_level,
    status_id = excluded.status_id, status_name = excluded.status_name,
    status_category = excluded.status_category, resolution = excluded.resolution,
    priority = excluded.priority, parent_id = excluded.parent_id, parent_key = excluded.parent_key,
    assignee_id = excluded.assignee_id, assignee_name = excluded.assignee_name,
    assignee_avatar = excluded.assignee_avatar, reporter_id = excluded.reporter_id,
    reporter_name = excluded.reporter_name, summary = excluded.summary,
    labels = excluded.labels, components = excluded.components,
    story_points = excluded.story_points, time_spent = excluded.time_spent,
    original_estimate = excluded.original_estimate, created = excluded.created,
    updated = excluded.updated, resolved = excluded.resolved,
    status_changed = excluded.status_changed, custom_fields = excluded.custom_fields
`)

const upsertLink = db.prepare(
  `INSERT OR IGNORE INTO issue_links (cloud_id, source_id, target_id, type, direction)
   VALUES (?, ?, ?, ?, ?)`
)

function levelForType(cloudId, typeId, isSubtask) {
  const row = db
    .prepare('SELECT hierarchy_level FROM issue_types WHERE cloud_id = ? AND id = ?')
    .get(cloudId, typeId)
  if (row?.hierarchy_level !== undefined && row?.hierarchy_level !== null) return row.hierarchy_level
  return isSubtask ? -1 : 0
}

function storeIssuePage(cloudId, issues, fieldIds) {
  const write = db.transaction((list) => {
    for (const raw of list) {
      const f = raw.fields || {}

      let points = null
      for (const id of fieldIds.storyPoints) {
        const v = f[id]
        if (typeof v === 'number') {
          points = v
          break
        }
      }

      // Tracked extras (report dates, HL estimation) keyed by canonical label.
      const extras = {}
      for (const t of fieldIds.tracked || []) {
        const v = f[t.id]
        if (v === null || v === undefined || v === '') continue
        extras[t.label] =
          typeof v === 'object' ? v.value ?? v.name ?? v.displayName ?? null : v
      }

      const epicLinkKey = fieldIds.epicLink ? f[fieldIds.epicLink] : null
      const parentLinkRaw = fieldIds.parentLink ? f[fieldIds.parentLink] : null
      const parentLinkKey =
        typeof parentLinkRaw === 'string' ? parentLinkRaw : parentLinkRaw?.key || null

      upsertIssue.run({
        cloud_id: cloudId,
        id: String(raw.id),
        key: raw.key,
        project_id: f.project?.id ? String(f.project.id) : null,
        project_key: f.project?.key || null,
        type_id: f.issuetype?.id ? String(f.issuetype.id) : null,
        type_name: f.issuetype?.name || null,
        hierarchy_level: levelForType(cloudId, String(f.issuetype?.id), f.issuetype?.subtask),
        status_id: f.status?.id ? String(f.status.id) : null,
        status_name: f.status?.name || null,
        status_category: f.status?.statusCategory?.key || null,
        resolution: f.resolution?.name || null,
        priority: f.priority?.name || null,
        parent_id: f.parent?.id ? String(f.parent.id) : null,
        parent_key: f.parent?.key || epicLinkKey || parentLinkKey || null,
        assignee_id: f.assignee?.accountId || null,
        assignee_name: f.assignee?.displayName || null,
        assignee_avatar: f.assignee?.avatarUrls?.['48x48'] || null,
        reporter_id: f.reporter?.accountId || null,
        reporter_name: f.reporter?.displayName || null,
        summary: f.summary || '',
        labels: JSON.stringify(f.labels || []),
        components: JSON.stringify((f.components || []).map((c) => c.name)),
        story_points: points,
        time_spent: f.aggregatetimespent ?? f.timespent ?? null,
        original_estimate: f.timeoriginalestimate ?? null,
        created: f.created || null,
        updated: f.updated || null,
        resolved: f.resolutiondate || null,
        status_changed: f.statuscategorychangedate || null,
        custom_fields: Object.keys(extras).length ? JSON.stringify(extras) : null,
      })

      for (const link of f.issuelinks || []) {
        const type = link.type?.name || 'relates'
        if (link.outwardIssue) {
          upsertLink.run(cloudId, String(raw.id), String(link.outwardIssue.id), type, 'outward')
        }
        if (link.inwardIssue) {
          upsertLink.run(cloudId, String(raw.id), String(link.inwardIssue.id), type, 'inward')
        }
      }
    }
  })
  write(issues)
}

function issueFieldList(fieldIds) {
  const base = [
    'summary', 'status', 'statuscategorychangedate', 'issuetype', 'project',
    'assignee', 'reporter', 'created', 'updated', 'resolutiondate', 'resolution',
    'priority', 'parent', 'labels', 'components', 'timeoriginalestimate',
    'timespent', 'aggregatetimespent', 'issuelinks',
  ]
  const extra = [...fieldIds.storyPoints]
  if (fieldIds.epicLink) extra.push(fieldIds.epicLink)
  if (fieldIds.parentLink) extra.push(fieldIds.parentLink)
  for (const t of fieldIds.tracked || []) extra.push(t.id)
  return [...base, ...extra]
}

/** Pull in ancestors that live outside the selected projects (initiatives, themes). */
async function closeHierarchy(cloudId, fieldIds, signal) {
  const fields = issueFieldList(fieldIds)
  for (let round = 0; round < 6; round += 1) {
    const missing = db
      .prepare(
        `SELECT DISTINCT i.parent_key AS k FROM issues i
         WHERE i.cloud_id = ? AND i.parent_key IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM issues p WHERE p.cloud_id = i.cloud_id AND p.key = i.parent_key
           )`
      )
      .all(cloudId)
      .map((r) => r.k)
      .filter(Boolean)

    if (!missing.length) return
    progress('hierarchy', `Fetching ${missing.length} parent issue(s) outside the selected projects…`)

    for (let i = 0; i < missing.length; i += 50) {
      if (signal.aborted) throw new Error('Sync cancelled')
      const chunk = missing.slice(i, i + 50)
      const jql = `key in (${chunk.map((k) => `"${k}"`).join(',')})`
      await searchIssues({
        jql,
        fields,
        cloudId,
        signal,
        onPage: (issues) => storeIssuePage(cloudId, issues, fieldIds),
      })
    }
  }
}

/* ------------------------------------------------------------ changelogs */

/**
 * Bump when the changelog capture changes shape (new fields recorded), so the
 * next sync re-reads every issue's history instead of only the changed ones.
 * v2: parent / Epic Link / Parent Link moves, all changelog fields requested.
 */
export const HISTORY_VERSION = 2

/** Which parent-like field a changelog item moves, or null. */
function parentFieldOf(item, fieldIds) {
  const name = (item.field || '').toLowerCase()
  const id = item.fieldId || ''
  if (id === 'parent' || name === 'issueparentassociation' || name === 'parent') return 'parent'
  if (name === 'epic link' || (fieldIds.epicLink && id === fieldIds.epicLink)) return 'epic-link'
  if (name === 'parent link' || (fieldIds.parentLink && id === fieldIds.parentLink)) return 'parent-link'
  return null
}

/** Changelog ids are issue ids; strings are keys ("ABC-12"). */
const idOrNull = (v) => (v && /^\d+$/.test(String(v)) ? String(v) : null)
const keyOrNull = (v) => (v && /^[A-Z][A-Z0-9_]*-\d+$/.test(String(v)) ? String(v) : null)

function recordChangelogs(cloudId, map, fieldIds) {
  const sStmt = db.prepare(
    `INSERT OR REPLACE INTO status_history
     (cloud_id, issue_id, at, from_id, from_status, to_id, to_status, author_id, author_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const aStmt = db.prepare(
    `INSERT OR REPLACE INTO assignee_history
     (cloud_id, issue_id, at, from_id, from_name, to_id, to_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const pStmt = db.prepare(
    `INSERT OR REPLACE INTO parent_history
     (cloud_id, issue_id, at, field, from_id, from_key, to_id, to_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const cStmt = db.prepare(
    `INSERT INTO changelog_cursor (cloud_id, issue_id, issue_updated, fetched_at)
     VALUES (?, ?, (SELECT updated FROM issues WHERE cloud_id = ? AND id = ?), ?)
     ON CONFLICT(cloud_id, issue_id) DO UPDATE SET
       issue_updated = excluded.issue_updated, fetched_at = excluded.fetched_at`
  )
  const hasHistory = db.prepare(
    `SELECT EXISTS (SELECT 1 FROM status_history WHERE cloud_id = ? AND issue_id = ?)
         OR EXISTS (SELECT 1 FROM parent_history WHERE cloud_id = ? AND issue_id = ?) AS n`
  )
  let kept = 0

  const write = db.transaction(() => {
    const now = Date.now()
    for (const [issueId, histories] of map) {
      // A Jira changelog only ever grows. An empty answer for an issue we
      // already hold history for is a gap in the response, not a reset —
      // keep what we have rather than erase the issue's past.
      if (!histories.length && hasHistory.get(cloudId, issueId, cloudId, issueId).n) {
        kept += 1
        cStmt.run(cloudId, issueId, cloudId, issueId, now)
        continue
      }
      db.prepare('DELETE FROM status_history WHERE cloud_id = ? AND issue_id = ?').run(cloudId, issueId)
      db.prepare('DELETE FROM assignee_history WHERE cloud_id = ? AND issue_id = ?').run(cloudId, issueId)
      db.prepare('DELETE FROM parent_history WHERE cloud_id = ? AND issue_id = ?').run(cloudId, issueId)
      for (const h of histories) {
        for (const item of h.items || []) {
          if (item.field === 'status' || item.fieldId === 'status') {
            sStmt.run(
              cloudId, issueId, h.created,
              item.from ? String(item.from) : null, item.fromString || null,
              item.to ? String(item.to) : null, item.toString || null,
              h.author?.accountId || null, h.author?.displayName || null
            )
          } else if (item.field === 'assignee' || item.fieldId === 'assignee') {
            aStmt.run(
              cloudId, issueId, h.created,
              item.from || null, item.fromString || null,
              item.to || null, item.toString || null
            )
          } else {
            const field = parentFieldOf(item, fieldIds)
            if (!field) continue
            pStmt.run(
              cloudId, issueId, h.created, field,
              idOrNull(item.from), keyOrNull(item.fromString) || keyOrNull(item.from),
              idOrNull(item.to), keyOrNull(item.toString) || keyOrNull(item.to)
            )
          }
        }
      }
      cStmt.run(cloudId, issueId, cloudId, issueId, now)
    }
  })
  write()
  return kept
}

/** Moves recorded only by key get their ids once the parent is in the cache. */
function resolveParentKeys(cloudId) {
  for (const [idCol, keyCol] of [['from_id', 'from_key'], ['to_id', 'to_key']]) {
    db.prepare(
      `UPDATE parent_history SET ${idCol} = (
         SELECT p.id FROM issues p WHERE p.cloud_id = parent_history.cloud_id AND p.key = parent_history.${keyCol}
       )
       WHERE cloud_id = ? AND ${idCol} IS NULL AND ${keyCol} IS NOT NULL`
    ).run(cloudId)
  }
}

async function syncChangelogs(cloudId, signal, fieldIds) {
  // Only issues whose "updated" moved past what the cursor recorded.
  const stale = db
    .prepare(
      `SELECT i.id, i.created, i.updated FROM issues i
       LEFT JOIN changelog_cursor c ON c.cloud_id = i.cloud_id AND c.issue_id = i.id
       WHERE i.cloud_id = ? AND (c.issue_updated IS NULL OR c.issue_updated <> i.updated)`
    )
    .all(cloudId)

  if (!stale.length) {
    resolveParentKeys(cloudId)
    progress('changelog', 'Status history already current', { changelogs: 0 })
    return { changelogs: 0, refetched: 0, kept: 0 }
  }

  // An issue never touched after creation has no changelog to miss.
  const touched = new Set(
    stale
      .filter((r) => {
        const c = new Date(r.created).getTime()
        const u = new Date(r.updated).getTime()
        return !(Number.isFinite(c) && Number.isFinite(u) && u - c < 5_000)
      })
      .map((r) => r.id)
  )

  let done = 0
  let refetched = 0
  let kept = 0
  const ids = stale.map((r) => r.id)
  const batch = 500
  for (let i = 0; i < ids.length; i += batch) {
    if (signal.aborted) throw new Error('Sync cancelled')
    const chunk = ids.slice(i, i + batch)
    progress('changelog', `Reading change history ${done}/${ids.length}…`, {
      changelogs: done,
      changelogTotal: ids.length,
    })
    const map = await fetchChangelogs({ issueIds: chunk, cloudId, signal })

    // The bulk endpoint can leave issues out of its answer. Anything that was
    // edited after creation gets asked for individually before we accept
    // "no history" for it.
    const missing = chunk.filter((id) => !map.has(id) && touched.has(id))
    for (const [n, id] of missing.entries()) {
      if (signal.aborted) throw new Error('Sync cancelled')
      progress('changelog', `Re-reading history issue by issue ${n + 1}/${missing.length} (batch ${done + 1}–${done + chunk.length})…`)
      map.set(id, await fetchIssueChangelog({ issueId: id, cloudId }))
      refetched += 1
    }
    // Untouched issues still need a cursor so they are not re-fetched.
    for (const id of chunk) if (!map.has(id)) map.set(id, [])
    kept += recordChangelogs(cloudId, map, fieldIds)
    done += chunk.length
  }

  resolveParentKeys(cloudId)
  progress('changelog', 'Change history up to date', { changelogs: done })
  return { changelogs: done, refetched, kept }
}

/* ------------------------------------------------------------------ main */

export async function runSync({ mode = 'incremental' } = {}) {
  if (current) throw new Error('A sync is already running')

  const controller = new AbortController()
  const signal = controller.signal
  const startedAt = Date.now()

  const info = db
    .prepare('INSERT INTO sync_runs (started_at, mode, status) VALUES (?, ?, ?)')
    .run(startedAt, mode, 'running')

  current = {
    runId: info.lastInsertRowid,
    mode,
    phase: 'starting',
    message: 'Starting…',
    counts: { issues: 0 },
    startedAt,
    controller,
  }

  try {
    const sites = await fetchAccessibleResources()
    let cloudId = activeCloudId()
    // The active site may be the seeded demo org (or a site this grant lost
    // access to) — a sync only makes sense against a real accessible site.
    if (!sites.some((s) => s.id === cloudId)) {
      cloudId = sites[0]?.id ?? null
      if (cloudId) setConfig('cloud_id', cloudId)
    }
    if (!cloudId) throw new Error('No Jira site available for this grant')
    db.prepare('UPDATE sync_runs SET cloud_id = ? WHERE id = ?').run(cloudId, current.runId)

    const fieldIds = await syncMetadata(cloudId, signal)
    setConfig('field_ids', fieldIds)

    const selected = getConfig('sync_projects', [])
    const rows = selected.length
      ? db
          .prepare(
            `SELECT id, key, name FROM projects WHERE cloud_id = ? AND key IN (${selected
              .map(() => '?')
              .join(',')})`
          )
          .all(cloudId, ...selected)
      : db.prepare('SELECT id, key, name FROM projects WHERE cloud_id = ?').all(cloudId)

    if (!rows.length) throw new Error('No projects selected to sync — choose some in Settings')

    // A full rebuild, an explicit history rebuild, or a changelog format bump
    // re-reads every issue's history rather than only the changed ones.
    if (mode === 'full' || mode === 'history' || (getConfig('history_version', 1) || 1) < HISTORY_VERSION) {
      db.prepare('DELETE FROM changelog_cursor WHERE cloud_id = ?').run(cloudId)
      // Recorded now: a cancelled rebuild resumes from the cursor next time
      // instead of starting over.
      setConfig('history_version', HISTORY_VERSION)
    }

    const since = mode === 'full' ? null : getConfig('last_issue_sync', null)
    const fields = issueFieldList(fieldIds)
    let total = 0

    for (const [idx, project] of rows.entries()) {
      if (signal.aborted) throw new Error('Sync cancelled')
      const clauses = [`project = ${project.id}`]
      if (since) clauses.push(`updated >= "${since}"`)
      const jql = `${clauses.join(' AND ')} ORDER BY created ASC`

      progress('issues', `${project.key} — ${project.name} (${idx + 1}/${rows.length})`, {
        projectIndex: idx + 1,
        projectTotal: rows.length,
      })

      await searchIssues({
        jql,
        fields,
        cloudId,
        signal,
        onPage: (issues) => {
          storeIssuePage(cloudId, issues, fieldIds)
          total += issues.length
          progress('issues', `${project.key} — ${total} issues read`, { issues: total })
        },
      })
    }

    await closeHierarchy(cloudId, fieldIds, signal)

    // Resolve parents that arrived only as a key (legacy Epic Link / Parent Link).
    db.prepare(
      `UPDATE issues SET parent_id = (
         SELECT p.id FROM issues p WHERE p.cloud_id = issues.cloud_id AND p.key = issues.parent_key
       )
       WHERE cloud_id = ? AND parent_id IS NULL AND parent_key IS NOT NULL`
    ).run(cloudId)

    const history = await syncChangelogs(cloudId, signal, fieldIds)

    // Watermark for the next incremental pass, minus a minute of slack for
    // clock skew between this machine and Jira.
    const watermark = new Date(startedAt - 60_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 16)
    setConfig('last_issue_sync', watermark)

    const stats = {
      issues: total,
      changelogs: history.changelogs,
      changelogsRefetched: history.refetched,
      changelogsKept: history.kept,
      projects: rows.length,
      issuesInDb: db
        .prepare('SELECT COUNT(*) AS n FROM issues WHERE cloud_id = ?')
        .get(cloudId).n,
    }
    db.prepare(
      'UPDATE sync_runs SET finished_at = ?, status = ?, stats = ? WHERE id = ?'
    ).run(Date.now(), 'ok', JSON.stringify(stats), current.runId)

    return stats
  } catch (err) {
    db.prepare(
      'UPDATE sync_runs SET finished_at = ?, status = ?, error = ? WHERE id = ?'
    ).run(Date.now(), signal.aborted ? 'cancelled' : 'error', String(err.message || err), current.runId)
    throw err
  } finally {
    current = null
  }
}
