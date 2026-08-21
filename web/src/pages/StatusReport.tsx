import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type Rag,
  type Root,
  type StatusEntry,
  type StatusInitiative,
  type StatusReport,
  type StatusReportMeta,
  type Team,
} from '../lib/api'
import { useScope } from '../lib/scope'
import { seriesVar } from '../lib/palette'
import { longDate, pct, shortDate } from '../lib/format'
import { Banner, Empty, Meter, Modal } from '../components/ui'

const RAGS: { value: Rag; label: string }[] = [
  { value: 'on-track', label: 'On track' },
  { value: 'at-risk', label: 'At risk' },
  { value: 'off-track', label: 'Off track' },
  { value: 'done', label: 'Done' },
  { value: 'paused', label: 'Paused' },
]

const ragLabel = (r: Rag) => RAGS.find((x) => x.value === r)?.label ?? r

const RAG_CSS: Record<Rag, string> = {
  'on-track': 'var(--status-good)',
  'at-risk': 'var(--status-warning)',
  'off-track': 'var(--status-critical)',
  done: 'var(--accent)',
  paused: 'var(--text-muted)',
}

const currentMonday = () => {
  const d = new Date()
  const day = (d.getUTCDay() + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
    .toISOString()
    .slice(0, 10)
}

type Section = { key: string; teamId: number | null; label: string; entries: StatusEntry[] }
type WorkstreamGroup = { initiativeId: number; title: string; entries: StatusEntry[] }

export function StatusReportPage() {
  const { siteUrl } = useScope()
  const [reports, setReports] = useState<StatusReportMeta[]>([])
  const [report, setReport] = useState<StatusReport | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  const [initiatives, setInitiatives] = useState<StatusInitiative[]>([])
  const [teamFilter, setTeamFilter] = useState<'all' | number>('all')
  const [view, setView] = useState<'workstream' | 'team'>('workstream')
  const [error, setError] = useState<string | null>(null)
  const [addingTeam, setAddingTeam] = useState<number | null | false>(false) // false = closed
  const [addingWorkstream, setAddingWorkstream] = useState(false)
  const [creating, setCreating] = useState(false)
  const [managingTeams, setManagingTeams] = useState(false)
  const [editingEntry, setEditingEntry] = useState<StatusEntry | null>(null)
  const [editingEpicEntry, setEditingEpicEntry] = useState<StatusEntry | null>(null)
  const [editingGroup, setEditingGroup] = useState<WorkstreamGroup | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggleCollapsed = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const [copied, setCopied] = useState<'md' | 'conf' | null>(null)
  const saveTimers = useRef(new Map<number, number>())

  const fail = (err: unknown) => setError(String((err as Error).message))

  const loadTeams = useCallback(
    () => api.get<{ teams: Team[] }>('/teams').then((d) => setTeams(d.teams)).catch(fail),
    []
  )
  const loadInitiatives = useCallback(
    () =>
      api
        .get<{ initiatives: StatusInitiative[] }>('/initiatives')
        .then((d) => setInitiatives(d.initiatives))
        .catch(fail),
    []
  )
  const loadReports = useCallback(async () => {
    const d = await api.get<{ reports: StatusReportMeta[] }>('/status-reports')
    setReports(d.reports)
    return d.reports
  }, [])

  const openWeek = useCallback(async (week: string) => {
    try {
      setReport(await api.get<StatusReport>(`/status-reports/${week}`))
    } catch (err) {
      fail(err)
    }
  }, [])

  useEffect(() => {
    void loadTeams()
    void loadInitiatives()
    void loadReports()
      .then((list) => {
        if (list.length) return openWeek(list[0].week)
      })
      .catch(fail)
  }, [loadTeams, loadInitiatives, loadReports, openWeek])

  const createReport = async (week: string, copyFrom: string) => {
    try {
      const d = await api.post<StatusReport>('/status-reports', {
        week,
        ...(copyFrom !== 'latest' ? { copyFrom } : {}),
      })
      setReport(d)
      setCreating(false)
      await loadReports()
    } catch (err) {
      fail(err)
    }
  }

  const deleteReport = async () => {
    if (!report) return
    if (!window.confirm(`Delete the report for the week of ${longDate(report.week)}?`)) return
    await api.del(`/status-reports/${report.id}`)
    setReport(null)
    const list = await loadReports()
    if (list.length) await openWeek(list[0].week)
  }

  /** Optimistic edit + debounced save, one timer per entry. */
  const patchEntry = (
    id: number,
    patch: Partial<Pick<StatusEntry, 'rag' | 'updateText' | 'targetDate' | 'jiraKey'>>
  ) => {
    if (!report) return
    setReport({
      ...report,
      entries: report.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    })
    window.clearTimeout(saveTimers.current.get(id))
    saveTimers.current.set(
      id,
      window.setTimeout(() => {
        api.put(`/status-entries/${id}`, patch).catch(fail)
      }, 500)
    )
  }

  const removeEntry = async (id: number) => {
    if (!report) return
    await api.del(`/status-entries/${id}`)
    setReport({ ...report, entries: report.entries.filter((e) => e.id !== id) })
  }

  const addEntryFor = async (initiativeId: number, teamId: number | null, jiraKey?: string | null) => {
    if (!report) return
    try {
      setReport(
        await api.post<StatusReport>(`/status-reports/${report.id}/entries`, {
          initiativeId,
          teamId,
          jiraKey: jiraKey ?? undefined,
        })
      )
      setAddingTeam(false)
    } catch (err) {
      fail(err)
    }
  }

  /** Reuse a workstream when one already matches the key or title; else create. */
  const resolveInitiative = async (
    title: string,
    jiraKey: string | null,
    initiativeId?: number
  ): Promise<StatusInitiative> => {
    if (initiativeId) {
      const known = initiatives.find((i) => i.id === initiativeId)
      if (known) return known
    }
    let ini = jiraKey
      ? initiatives.find((i) => i.jiraKey === jiraKey)
      : initiatives.find((i) => !i.jiraKey && i.title.toLowerCase() === title.toLowerCase())
    if (!ini) {
      ini = await api.post<StatusInitiative>('/initiatives', { title, jiraKey })
      await loadInitiatives()
    }
    return ini
  }

  const createAndAdd = async (title: string, jiraKey: string | null, teamId: number | null) => {
    try {
      const ini = await resolveInitiative(title, jiraKey)
      await addEntryFor(ini.id, teamId, jiraKey)
    } catch (err) {
      fail(err)
    }
  }

  /** New top-level group: an overall section plus one entry per chosen team. */
  const createWorkstream = async (
    title: string,
    jiraKey: string | null,
    teamIds: number[],
    includeGeneral: boolean,
    initiativeId?: number
  ) => {
    if (!report) return
    try {
      const ini = await resolveInitiative(title, jiraKey, initiativeId)
      const sections: (number | null)[] = [...(includeGeneral ? [null] : []), ...teamIds]
      let latest = report
      for (const teamId of sections) {
        latest = await api.post<StatusReport>(`/status-reports/${report.id}/entries`, {
          initiativeId: ini.id,
          teamId,
          jiraKey: jiraKey ?? ini.jiraKey ?? undefined,
        })
      }
      setReport(latest)
      setAddingWorkstream(false)
    } catch (err) {
      fail(err)
    }
  }

  const removeGroup = async (g: WorkstreamGroup) => {
    if (!report) return
    const n = g.entries.length
    if (!window.confirm(`Remove "${g.title}" and its ${n} update${n === 1 ? '' : 's'} from this week's report?`)) {
      return
    }
    try {
      for (const e of g.entries) await api.del(`/status-entries/${e.id}`)
      setReport({ ...report, entries: report.entries.filter((e) => e.initiativeId !== g.initiativeId) })
    } catch (err) {
      fail(err)
    }
  }

  const activeTeams = useMemo(() => teams.filter((t) => !t.archived), [teams])
  const teamColor = (id: number | null) => {
    const i = teams.findIndex((t) => t.id === id)
    return seriesVar(i < 0 ? 7 : i)
  }

  /** All sections (used for export); the view filters this down. */
  const allSections = useMemo<Section[]>(() => {
    if (!report) return []
    const list: Section[] = activeTeams.map((t) => ({
      key: `t${t.id}`,
      teamId: t.id,
      label: t.name,
      entries: report.entries.filter((e) => e.teamId === t.id),
    }))
    const general = report.entries.filter(
      (e) => e.teamId == null || !activeTeams.some((t) => t.id === e.teamId)
    )
    if (general.length) list.push({ key: 'none', teamId: null, label: 'General', entries: general })
    return list
  }, [report, activeTeams])

  const sections = useMemo<Section[]>(() => {
    if (teamFilter === 'all') return allSections.filter((s) => s.entries.length)
    return allSections.filter((s) => s.teamId === teamFilter)
  }, [allSections, teamFilter])

  /** The workstream view: one group per initiative, team updates inside. */
  const wsGroups = useMemo<WorkstreamGroup[]>(() => {
    if (!report) return []
    const visible =
      teamFilter === 'all' ? report.entries : report.entries.filter((e) => e.teamId === teamFilter)
    return groupByWorkstream(visible)
  }, [report, teamFilter])

  const teamName = (id: number | null) =>
    id == null ? 'General' : teams.find((t) => t.id === id)?.name ?? '?'

  const copyExport = async (kind: 'md' | 'conf') => {
    if (!report) return
    // Exports cover the whole report, grouped like the current view.
    const nonEmpty = allSections.filter((s) => s.entries.length)
    const groups = groupByWorkstream(report.entries)
    const md =
      (view === 'workstream' ? wsMarkdown(report, groups, teamName) : reportMarkdown(report, nonEmpty)) +
      '\n' +
      summaryMarkdown(report.entries, teamName) +
      '\n'
    try {
      if (kind === 'conf') {
        const html =
          (view === 'workstream' ? wsHtml(report, groups, teamName) : reportHtml(report, nonEmpty)) +
          '\n' +
          summaryHtmlBlock(report.entries, teamName)
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([md], { type: 'text/plain' }),
          }),
        ])
      } else {
        await navigator.clipboard.writeText(md)
      }
      setCopied(kind)
      window.setTimeout(() => setCopied(null), 1800)
    } catch (err) {
      fail(err)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Weekly status</h1>
          <p>
            Each team reports in its own section, with its own epic links. New reports copy forward
            from a week you choose, and date slips against last week are flagged automatically.
          </p>
        </div>
        <div className="row">
          {reports.length > 0 && (
            <select
              value={report?.week ?? ''}
              onChange={(e) => void openWeek(e.target.value)}
              aria-label="Report week"
            >
              {reports.map((r) => (
                <option key={r.id} value={r.week}>
                  Week of {shortDate(r.week)} ({r.entryCount})
                </option>
              ))}
            </select>
          )}
          <button type="button" className="ghost" onClick={() => setManagingTeams(true)}>
            Teams
          </button>
          {report && (
            <>
              <button type="button" className="ghost" onClick={() => void copyExport('conf')}>
                {copied === 'conf' ? 'Copied ✓' : 'Copy for Confluence'}
              </button>
              <button type="button" className="ghost" onClick={() => void copyExport('md')}>
                {copied === 'md' ? 'Copied ✓' : 'Markdown'}
              </button>
              <button type="button" className="ghost danger" onClick={() => void deleteReport()}>
                Delete
              </button>
            </>
          )}
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            New report
          </button>
        </div>
      </div>

      {error && (
        <Banner
          kind="error"
          title="Status report error"
          actions={<button type="button" className="ghost" onClick={() => setError(null)}>Dismiss</button>}
        >
          {error}
        </Banner>
      )}

      {!report ? (
        <Empty title="No reports yet">
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            Create the first weekly report
          </button>
        </Empty>
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <span className="muted" style={{ fontSize: 13 }}>
              Week of <strong>{longDate(report.week)}</strong>
              {report.prevWeek ? ` · compared against ${shortDate(report.prevWeek)}` : ''}
            </span>
            <span className="row" style={{ gap: 8 }}>
              {view === 'workstream' && (
                <button type="button" className="primary" onClick={() => setAddingWorkstream(true)}>
                  + Add workstream
                </button>
              )}
              <div className="segmented" role="group" aria-label="Grouping">
                <button
                  type="button"
                  aria-pressed={view === 'workstream'}
                  onClick={() => setView('workstream')}
                >
                  By workstream
                </button>
                <button type="button" aria-pressed={view === 'team'} onClick={() => setView('team')}>
                  By team
                </button>
              </div>
              <select
                value={teamFilter === 'all' ? 'all' : String(teamFilter)}
                onChange={(e) => setTeamFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                aria-label="Team"
              >
                <option value="all">All teams</option>
                {activeTeams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </span>
          </div>

          {(view === 'team' ? sections : wsGroups).length === 0 && (
            <Empty title="Nothing reported this week yet">
              <span className="muted" style={{ fontSize: 13 }}>
                Pick your team above, or add the first update to any section.
              </span>
              <button
                type="button"
                className="primary"
                onClick={() => (view === 'workstream' ? setAddingWorkstream(true) : setAddingTeam(null))}
              >
                {view === 'workstream' ? '+ Add a workstream' : '+ Add an update'}
              </button>
            </Empty>
          )}

          {view === 'workstream' && (
            <div className="stack">
              {wsGroups.map((g) => {
                // The general (no-team) entry carries the group-level status;
                // its controls live on the header. Team rows keep their own.
                const general = g.entries.find((e) => e.teamId == null)
                const teamEntries = g.entries.filter((e) => e.teamId != null)
                const inGroup = new Set(g.entries.map((e) => e.teamId))
                const addable = activeTeams.filter((t) => !inGroup.has(t.id))
                const slip = general ? dateSlip(general) : null
                const isCollapsed = collapsed.has(`ws${g.initiativeId}`)
                return (
                  <section key={g.initiativeId} className="card" style={{ padding: '12px 14px' }}>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button
                        type="button"
                        className="ghost widget-btn"
                        aria-expanded={!isCollapsed}
                        aria-label={isCollapsed ? 'Expand workstream' : 'Collapse workstream'}
                        onClick={() => toggleCollapsed(`ws${g.initiativeId}`)}
                      >
                        {isCollapsed ? '▸' : '▾'}
                      </button>
                      <h2
                        style={{ fontSize: 14, margin: 0, cursor: 'pointer' }}
                        onClick={() => toggleCollapsed(`ws${g.initiativeId}`)}
                      >
                        {g.title}
                      </h2>
                      {teamEntries.map((e) => (
                        <span key={e.id} className="pill">
                          <span className="dot" style={{ background: teamColor(e.teamId) }} />
                          {teamName(e.teamId)}
                        </span>
                      ))}
                      {general?.jiraKey &&
                        (siteUrl ? (
                          <a
                            className="pill"
                            href={`${siteUrl}/browse/${general.jiraKey}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {general.jiraKey}
                          </a>
                        ) : (
                          <span className="pill">{general.jiraKey}</span>
                        ))}
                      <span className="row" style={{ marginLeft: 'auto', gap: 8, alignItems: 'center' }}>
                        {slip && (
                          <span
                            style={{
                              fontSize: 12,
                              color: slip.later ? 'var(--status-critical)' : 'var(--status-good)',
                            }}
                          >
                            {slip.later ? '▲ slipped' : '▼ pulled in'} — was {shortDate(slip.was)}
                          </span>
                        )}
                        {general && (
                          <>
                            <select
                              className={`rag rag-${general.rag}`}
                              value={general.rag}
                              onChange={(ev) => patchEntry(general.id, { rag: ev.target.value as Rag })}
                              aria-label="Workstream status"
                            >
                              {RAGS.map((r) => (
                                <option key={r.value} value={r.value}>
                                  {r.label}
                                </option>
                              ))}
                            </select>
                            <input
                              type="date"
                              value={general.targetDate ?? ''}
                              onChange={(ev) => patchEntry(general.id, { targetDate: ev.target.value || null })}
                              aria-label="Target date"
                            />
                          </>
                        )}
                        {(addable.length > 0 || !general) && (
                          <select
                            value=""
                            aria-label="Add a section to this workstream"
                            style={{ fontSize: 12 }}
                            onChange={(ev) => {
                              if (!ev.target.value) return
                              const ini = initiatives.find((i) => i.id === g.initiativeId)
                              const teamId = ev.target.value === 'general' ? null : Number(ev.target.value)
                              void addEntryFor(g.initiativeId, teamId, ini?.jiraKey ?? null)
                            }}
                          >
                            <option value="">+ Add team…</option>
                            {!general && <option value="general">General (overall)</option>}
                            {addable.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          type="button"
                          className="ghost widget-btn"
                          aria-label="Edit workstream"
                          onClick={() => setEditingGroup(g)}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="ghost widget-btn"
                          aria-label="Remove workstream from this report"
                          title="Remove workstream from this report"
                          onClick={() => void removeGroup(g)}
                        >
                          ✕
                        </button>
                      </span>
                    </div>

                    {!isCollapsed && (
                      <>
                        {general && (
                          <>
                            <textarea
                              rows={2}
                              placeholder="Overall: what happened this week, what's next, any risks…"
                              value={general.updateText}
                              onChange={(ev) => patchEntry(general.id, { updateText: ev.target.value })}
                              style={{ width: '100%', marginTop: 8, resize: 'vertical' }}
                            />
                            {general.prev?.updateText && (
                              <details style={{ marginTop: 6 }}>
                                <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>
                                  Last week ({ragLabel(general.prev.rag)})
                                </summary>
                                <p className="muted" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>
                                  {general.prev.updateText}
                                </p>
                              </details>
                            )}
                          </>
                        )}

                        <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                          {teamEntries.map((e) => (
                            <EntryCard
                              key={e.id}
                              entry={e}
                              nested
                              teamBadge={{ name: teamName(e.teamId), color: teamColor(e.teamId) }}
                              siteUrl={siteUrl}
                              onPatch={(patch) => patchEntry(e.id, patch)}
                              onRemove={() => void removeEntry(e.id)}
                              onEdit={() => setEditingEpicEntry(e)}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </section>
                )
              })}
            </div>
          )}

          {view === 'team' && (
          <div className="stack">
            {sections.map((s) => (
              <section key={s.key}>
                <div className="row" style={{ margin: '4px 0 10px', gap: 8 }}>
                  <button
                    type="button"
                    className="ghost widget-btn"
                    aria-expanded={!collapsed.has(s.key)}
                    aria-label={collapsed.has(s.key) ? 'Expand section' : 'Collapse section'}
                    onClick={() => toggleCollapsed(s.key)}
                  >
                    {collapsed.has(s.key) ? '▸' : '▾'}
                  </button>
                  <span className="dot" style={{ background: teamColor(s.teamId) }} />
                  <h2
                    style={{ fontSize: 14, margin: 0, cursor: 'pointer' }}
                    onClick={() => toggleCollapsed(s.key)}
                  >
                    {s.label}
                  </h2>
                  <span className="muted" style={{ fontSize: 12 }}>· {s.entries.length}</span>
                  <button
                    type="button"
                    className="ghost"
                    style={{ marginLeft: 'auto', fontSize: 12 }}
                    onClick={() => setAddingTeam(s.teamId)}
                  >
                    + Add update
                  </button>
                </div>
                {collapsed.has(s.key) ? null : s.entries.length === 0 ? (
                  <p className="muted" style={{ fontSize: 13 }}>
                    No updates from {s.label} this week yet.
                  </p>
                ) : (
                  <div className="stack" style={{ gap: 10 }}>
                    {s.entries.map((e) => (
                      <EntryCard
                        key={e.id}
                        entry={e}
                        siteUrl={siteUrl}
                        onPatch={(patch) => patchEntry(e.id, patch)}
                        onRemove={() => void removeEntry(e.id)}
                        onEdit={() => setEditingEntry(e)}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
          )}

          {report.entries.length > 0 && <ReportSummary entries={report.entries} teamName={teamName} />}
        </>
      )}

      {creating && (
        <NewReportModal
          reports={reports}
          onClose={() => setCreating(false)}
          onCreate={(week, copyFrom) => void createReport(week, copyFrom)}
        />
      )}

      {addingWorkstream && report && (
        <AddWorkstreamModal
          teams={activeTeams}
          existing={initiatives.filter(
            (i) => !i.archived && !report.entries.some((e) => e.initiativeId === i.id)
          )}
          onClose={() => setAddingWorkstream(false)}
          onCreate={(title, jiraKey, teamIds, includeGeneral, initiativeId) =>
            void createWorkstream(title, jiraKey, teamIds, includeGeneral, initiativeId)
          }
        />
      )}

      {addingTeam !== false && report && (
        <AddUpdateModal
          teamName={
            addingTeam == null ? 'General' : activeTeams.find((t) => t.id === addingTeam)?.name ?? '?'
          }
          existing={initiatives.filter(
            (i) =>
              !i.archived &&
              !report.entries.some((e) => e.initiativeId === i.id && e.teamId === addingTeam)
          )}
          onClose={() => setAddingTeam(false)}
          onPickExisting={(id) => {
            const ini = initiatives.find((i) => i.id === id)
            void addEntryFor(id, addingTeam, ini?.jiraKey ?? null)
          }}
          onCreate={(title, jiraKey) => void createAndAdd(title, jiraKey, addingTeam)}
        />
      )}

      {managingTeams && (
        <ManageTeamsModal teams={teams} onClose={() => setManagingTeams(false)} onChanged={loadTeams} />
      )}

      {editingEntry && (
        <EditEntryModal
          entry={editingEntry}
          onClose={() => setEditingEntry(null)}
          onSaved={async () => {
            setEditingEntry(null)
            await loadInitiatives()
            if (report) await openWeek(report.week)
          }}
        />
      )}

      {editingEpicEntry && (
        <EditEntryModal
          entry={editingEpicEntry}
          epicOnly
          onClose={() => setEditingEpicEntry(null)}
          onSaved={async () => {
            setEditingEpicEntry(null)
            if (report) await openWeek(report.week)
          }}
        />
      )}

      {editingGroup && (
        <EditWorkstreamModal
          group={editingGroup}
          onClose={() => setEditingGroup(null)}
          onSaved={async () => {
            setEditingGroup(null)
            await loadInitiatives()
            if (report) await openWeek(report.week)
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------ entry card */

function EntryCard({
  entry,
  siteUrl,
  nested = false,
  teamBadge,
  onPatch,
  onRemove,
  onEdit,
}: {
  entry: StatusEntry
  siteUrl: string | null
  /** Inside a workstream group: no card chrome, team badge instead of title. */
  nested?: boolean
  teamBadge?: { name: string; color: string }
  onPatch: (patch: Partial<Pick<StatusEntry, 'rag' | 'updateText' | 'targetDate'>>) => void
  onRemove: () => void
  onEdit: () => void
}) {
  const slip = dateSlip(entry)
  return (
    <div className={nested ? 'status-entry nested' : 'card status-entry'}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {teamBadge ? (
          <strong style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="dot" style={{ background: teamBadge.color }} />
            {teamBadge.name}
          </strong>
        ) : (
          <strong style={{ fontSize: 13.5 }}>{entry.title}</strong>
        )}
        {nested ? (
          // The team's epic is the row's own detail — the pill edits it.
          <button
            type="button"
            className="pill"
            style={{ cursor: 'pointer' }}
            title="Change this team's epic link"
            onClick={onEdit}
          >
            {entry.jiraKey ?? '+ link epic'}
          </button>
        ) : (
          entry.jiraKey &&
          (siteUrl ? (
            <a className="pill" href={`${siteUrl}/browse/${entry.jiraKey}`} target="_blank" rel="noreferrer">
              {entry.jiraKey}
            </a>
          ) : (
            <span className="pill">{entry.jiraKey}</span>
          ))
        )}
        {nested && entry.jiraKey && siteUrl && (
          <a
            href={`${siteUrl}/browse/${entry.jiraKey}`}
            target="_blank"
            rel="noreferrer"
            className="muted"
            style={{ fontSize: 12 }}
          >
            open ↗
          </a>
        )}
        <span style={{ marginLeft: 'auto' }} className="row">
          <select
            className={`rag rag-${entry.rag}`}
            value={entry.rag}
            onChange={(e) => onPatch({ rag: e.target.value as Rag })}
            aria-label="Status"
          >
            {RAGS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={entry.targetDate ?? ''}
            onChange={(e) => onPatch({ targetDate: e.target.value || null })}
            aria-label="Target date"
          />
          {!nested && (
            <button type="button" className="ghost widget-btn" aria-label="Edit workstream" onClick={onEdit}>
              ✎
            </button>
          )}
          <button type="button" className="ghost widget-btn" aria-label="Remove from report" onClick={onRemove}>
            ✕
          </button>
        </span>
      </div>

      {(slip || entry.progress) && (
        <div className="row" style={{ gap: 14, marginTop: 6, alignItems: 'center' }}>
          {slip && (
            <span
              style={{
                fontSize: 12,
                color: slip.later ? 'var(--status-critical)' : 'var(--status-good)',
              }}
            >
              {slip.later ? '▲ slipped' : '▼ pulled in'} — was {shortDate(slip.was)}
            </span>
          )}
          {entry.progress && entry.progress.total > 0 && (
            <span className="row" style={{ gap: 8, flex: '0 1 260px', alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                {entry.progress.done}/{entry.progress.total} done · {pct(entry.progress.pct)}
              </span>
              <span style={{ flex: 1, minWidth: 80 }}>
                <Meter done={entry.progress.done} inProgress={0} total={entry.progress.total} showLabel={false} />
              </span>
            </span>
          )}
        </div>
      )}

      <textarea
        rows={2}
        placeholder="What happened this week, what's next, any risks…"
        value={entry.updateText}
        onChange={(e) => onPatch({ updateText: e.target.value })}
        style={{ width: '100%', marginTop: 8, resize: 'vertical' }}
      />
      {entry.prev?.updateText && (
        <details style={{ marginTop: 6 }}>
          <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>
            Last week ({ragLabel(entry.prev.rag)})
          </summary>
          <p className="muted" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>
            {entry.prev.updateText}
          </p>
        </details>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- summary */

function summarize(entries: StatusEntry[]) {
  const counts = {} as Record<Rag, number>
  for (const e of entries) counts[e.rag] = (counts[e.rag] || 0) + 1
  return {
    counts,
    workstreams: new Set(entries.map((e) => e.initiativeId)).size,
    teamsReporting: new Set(entries.filter((e) => e.teamId != null).map((e) => e.teamId)).size,
    risks: entries.filter((e) => e.rag === 'at-risk' || e.rag === 'off-track'),
  }
}

function ReportSummary({
  entries,
  teamName,
}: {
  entries: StatusEntry[]
  teamName: (id: number | null) => string
}) {
  const s = summarize(entries)
  return (
    <section className="card" style={{ padding: '12px 14px', marginTop: 14 }}>
      <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Summary</h2>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="pill">{s.workstreams} workstreams</span>
        <span className="pill">{s.teamsReporting} teams reporting</span>
        {RAGS.map((r) =>
          s.counts[r.value] ? (
            <span key={r.value} className="pill" style={{ color: RAG_CSS[r.value], fontWeight: 600 }}>
              {s.counts[r.value]} {r.label.toLowerCase()}
            </span>
          ) : null
        )}
      </div>
      {s.risks.length > 0 && (
        <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 13 }}>
          {s.risks.map((e) => (
            <li key={e.id} style={{ marginBottom: 2 }}>
              <strong>{e.title}</strong>
              {e.teamId != null ? ` — ${teamName(e.teamId)}` : ''} ·{' '}
              <span style={{ color: RAG_CSS[e.rag], fontWeight: 600 }}>{ragLabel(e.rag)}</span>
              {e.targetDate ? ` · target ${shortDate(e.targetDate)}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function summaryMarkdown(entries: StatusEntry[], teamName: (id: number | null) => string): string {
  const s = summarize(entries)
  const tallies = RAGS.filter((r) => s.counts[r.value])
    .map((r) => `${s.counts[r.value]} ${r.label.toLowerCase()}`)
    .join(' · ')
  const lines = [
    '## Summary',
    '',
    `- ${s.workstreams} workstreams · ${s.teamsReporting} teams reporting`,
    `- ${tallies}`,
  ]
  if (s.risks.length) {
    lines.push('- Needs attention:')
    for (const e of s.risks) {
      lines.push(
        `  - **${e.title}**${e.teamId != null ? ` — ${teamName(e.teamId)}` : ''} · ${ragLabel(e.rag)}${
          e.targetDate ? ` · target ${shortDate(e.targetDate)}` : ''
        }`
      )
    }
  }
  return lines.join('\n')
}

function summaryHtmlBlock(entries: StatusEntry[], teamName: (id: number | null) => string): string {
  const s = summarize(entries)
  const tallies = RAGS.filter((r) => s.counts[r.value])
    .map(
      (r) =>
        `<strong style="color:${RAG_HTML_COLOR[r.value]}">${s.counts[r.value]} ${r.label.toLowerCase()}</strong>`
    )
    .join(' · ')
  const parts = [
    '<h2>Summary</h2>',
    `<p>${s.workstreams} workstreams · ${s.teamsReporting} teams reporting · ${tallies}</p>`,
  ]
  if (s.risks.length) {
    parts.push('<ul>')
    for (const e of s.risks) {
      parts.push(
        `<li><strong>${esc(e.title)}</strong>${e.teamId != null ? ` — ${esc(teamName(e.teamId))}` : ''} · ` +
          `<strong style="color:${RAG_HTML_COLOR[e.rag]}">${esc(ragLabel(e.rag))}</strong>` +
          `${e.targetDate ? ` · target ${esc(shortDate(e.targetDate))}` : ''}</li>`
      )
    }
    parts.push('</ul>')
  }
  return parts.join('\n')
}

function dateSlip(entry: StatusEntry): { was: string; later: boolean } | null {
  if (!entry.prev?.targetDate || !entry.targetDate) return null
  if (entry.prev.targetDate === entry.targetDate) return null
  return { was: entry.prev.targetDate, later: entry.targetDate > entry.prev.targetDate }
}

/* ---------------------------------------------------------------- modals */

function NewReportModal({
  reports,
  onClose,
  onCreate,
}: {
  reports: StatusReportMeta[]
  onClose: () => void
  onCreate: (week: string, copyFrom: string) => void
}) {
  const [week, setWeek] = useState(currentMonday())
  const [copyFrom, setCopyFrom] = useState('latest')

  return (
    <Modal title="New weekly report" onClose={onClose}>
      <form
        className="stack"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault()
          onCreate(week, copyFrom)
        }}
      >
        <div className="field">
          <label htmlFor="nr-week">Week (any day — it snaps to Monday)</label>
          <input id="nr-week" type="date" value={week} onChange={(e) => setWeek(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="nr-copy">Copy entries from</label>
          <select id="nr-copy" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="latest">Most recent report</option>
            {reports.map((r) => (
              <option key={r.id} value={String(r.id)}>
                Week of {shortDate(r.week)} ({r.entryCount} entries)
              </option>
            ))}
            <option value="blank">Start blank</option>
          </select>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Statuses, target dates and epic links carry over; the narrative starts fresh. Entries
          marked Done and archived workstreams are left behind.
        </p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Create
          </button>
        </div>
      </form>
    </Modal>
  )
}

function AddWorkstreamModal({
  teams,
  existing,
  onClose,
  onCreate,
}: {
  teams: Team[]
  existing: StatusInitiative[]
  onClose: () => void
  onCreate: (
    title: string,
    jiraKey: string | null,
    teamIds: number[],
    includeGeneral: boolean,
    initiativeId?: number
  ) => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Root[]>([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState<{ title: string; jiraKey: string | null; initiativeId?: number } | null>(null)
  const [title, setTitle] = useState('')
  const [teamIds, setTeamIds] = useState<Set<number>>(new Set())
  const [general, setGeneral] = useState(true)

  useEffect(() => {
    if (!q.trim()) {
      setResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    const t = window.setTimeout(() => {
      api
        .get<{ roots: Root[] }>('/roots', { q: q.trim(), level: 'any', limit: 12 })
        .then((d) => {
          if (!cancelled) setResults(d.roots)
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [q])

  const toggleTeam = (id: number) =>
    setTeamIds((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const chosenTitle = picked ? picked.title : title
  const canCreate = chosenTitle.trim().length > 0 && (general || teamIds.size > 0)

  return (
    <Modal title="Add a workstream" onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        {existing.length > 0 && !picked && (
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Bring back a known workstream
            </div>
            <div className="stack" style={{ gap: 4, maxHeight: 140, overflow: 'auto' }}>
              {existing.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className="ghost"
                  style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                  onClick={() => setPicked({ title: i.title, jiraKey: i.jiraKey, initiativeId: i.id })}
                >
                  {i.title}
                  {i.jiraKey ? ` · ${i.jiraKey}` : ''}
                </button>
              ))}
            </div>
          </div>
        )}

        {!picked ? (
          <div className="field">
            <label htmlFor="ws-search">Link a Jira initiative or epic</label>
            <input
              id="ws-search"
              type="text"
              placeholder="Search by key or summary…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {searching && <span className="muted" style={{ fontSize: 12 }}>Searching…</span>}
            {results.length > 0 && (
              <div className="stack" style={{ gap: 2, marginTop: 6, maxHeight: 180, overflow: 'auto' }}>
                {results.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="ghost"
                    style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                    onClick={() => setPicked({ title: r.summary, jiraKey: r.key })}
                  >
                    <span className="pill" style={{ marginRight: 6 }}>{r.key}</span>
                    {r.summary}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            {picked.jiraKey && <span className="pill">{picked.jiraKey}</span>}
            <strong style={{ fontSize: 13 }}>{picked.title}</strong>
            <button type="button" className="ghost" onClick={() => setPicked(null)}>
              change
            </button>
          </div>
        )}

        {!picked && (
          <div className="field">
            <label htmlFor="ws-title">…or start something that isn't a ticket</label>
            <input
              id="ws-title"
              type="text"
              placeholder="e.g. FIX gateway migration"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        )}

        <div className="field">
          <label>Sections to create</label>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <label className="pill" style={{ cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={general}
                onChange={(e) => setGeneral(e.target.checked)}
                style={{ marginRight: 4 }}
              />
              General (overall)
            </label>
            {teams.map((t) => (
              <label key={t.id} className="pill" style={{ cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={teamIds.has(t.id)}
                  onChange={() => toggleTeam(t.id)}
                  style={{ marginRight: 4 }}
                />
                {t.name}
              </label>
            ))}
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canCreate}
            onClick={() =>
              onCreate(chosenTitle.trim(), picked?.jiraKey ?? null, [...teamIds], general, picked?.initiativeId)
            }
          >
            Add to report
          </button>
        </div>
      </div>
    </Modal>
  )
}

function AddUpdateModal({
  teamName,
  existing,
  onClose,
  onPickExisting,
  onCreate,
}: {
  teamName: string
  existing: StatusInitiative[]
  onClose: () => void
  onPickExisting: (initiativeId: number) => void
  onCreate: (title: string, jiraKey: string | null) => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Root[]>([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState<{ title: string; jiraKey: string | null } | null>(null)
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (!q.trim()) {
      setResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    const t = window.setTimeout(() => {
      api
        .get<{ roots: Root[] }>('/roots', { q: q.trim(), level: 'any', limit: 12 })
        .then((d) => {
          if (!cancelled) setResults(d.roots)
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [q])

  const chosenTitle = picked ? picked.title : title
  const canCreate = chosenTitle.trim().length > 0

  return (
    <Modal title={`Add update — ${teamName}`} onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        {existing.length > 0 && (
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Known workstreams
            </div>
            <div className="stack" style={{ gap: 4, maxHeight: 160, overflow: 'auto' }}>
              {existing.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className="ghost"
                  style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                  onClick={() => onPickExisting(i.id)}
                >
                  {i.title}
                  {i.jiraKey ? ` · ${i.jiraKey}` : ''}
                </button>
              ))}
            </div>
          </div>
        )}

        {!picked ? (
          <div className="field">
            <label htmlFor="su-search">Link this team's epic or initiative from Jira</label>
            <input
              id="su-search"
              type="text"
              placeholder="Search by key or summary…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {searching && <span className="muted" style={{ fontSize: 12 }}>Searching…</span>}
            {results.length > 0 && (
              <div className="stack" style={{ gap: 2, marginTop: 6, maxHeight: 200, overflow: 'auto' }}>
                {results.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="ghost"
                    style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                    onClick={() => setPicked({ title: r.summary, jiraKey: r.key })}
                  >
                    <span className="pill" style={{ marginRight: 6 }}>{r.key}</span>
                    {r.summary}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            <span className="pill">{picked.jiraKey}</span>
            <strong style={{ fontSize: 13 }}>{picked.title}</strong>
            <button type="button" className="ghost" onClick={() => setPicked(null)}>
              change
            </button>
          </div>
        )}

        {!picked && (
          <div className="field">
            <label htmlFor="su-title">…or start something that isn't a ticket</label>
            <input
              id="su-title"
              type="text"
              placeholder="e.g. FIX gateway migration"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canCreate}
            onClick={() => onCreate(chosenTitle.trim(), picked?.jiraKey ?? null)}
          >
            Add to {teamName}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function EditEntryModal({
  entry,
  epicOnly = false,
  onClose,
  onSaved,
}: {
  entry: StatusEntry
  /** Only change this team's epic link; workstream details live on the group. */
  epicOnly?: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(entry.title)
  const [jiraKey, setJiraKey] = useState(entry.jiraKey ?? '')

  const save = async (archive?: boolean) => {
    if (!epicOnly) {
      await api.put(`/initiatives/${entry.initiativeId}`, {
        title: title.trim(),
        ...(archive !== undefined ? { archived: archive } : {}),
      })
    }
    await api.put(`/status-entries/${entry.id}`, { jiraKey: jiraKey.trim() || null })
    onSaved()
  }

  return (
    <Modal title={epicOnly ? 'Team epic link' : 'Edit workstream'} onClose={onClose}>
      <div className="stack" style={{ gap: 12 }}>
        {!epicOnly && (
          <div className="field">
            <label htmlFor="ei-title">Title (shared across teams)</label>
            <input id="ei-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="ei-key">This team's epic / Jira key (optional)</label>
          <input
            id="ei-key"
            type="text"
            placeholder="e.g. PAY-12"
            value={jiraKey}
            onChange={(e) => setJiraKey(e.target.value)}
            autoFocus={epicOnly}
          />
        </div>
        <div className="row" style={{ justifyContent: epicOnly ? 'flex-end' : 'space-between' }}>
          {!epicOnly && (
            <button type="button" className="ghost danger" onClick={() => void save(true)}>
              Archive workstream
            </button>
          )}
          <span className="row">
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => void save()}>
              Save
            </button>
          </span>
        </div>
      </div>
    </Modal>
  )
}

function EditWorkstreamModal({
  group,
  onClose,
  onSaved,
}: {
  group: WorkstreamGroup
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(group.title)

  const save = async (archive?: boolean) => {
    await api.put(`/initiatives/${group.initiativeId}`, {
      title: title.trim(),
      ...(archive !== undefined ? { archived: archive } : {}),
    })
    onSaved()
  }

  return (
    <Modal title="Edit workstream" onClose={onClose}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="field">
          <label htmlFor="ew-title">Title</label>
          <input id="ew-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Archiving keeps this week's entries but leaves the workstream out of future copy-forwards
          and pickers.
        </p>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="ghost danger" onClick={() => void save(true)}>
            Archive workstream
          </button>
          <span className="row">
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => void save()}>
              Save
            </button>
          </span>
        </div>
      </div>
    </Modal>
  )
}

function ManageTeamsModal({
  teams,
  onClose,
  onChanged,
}: {
  teams: Team[]
  onClose: () => void
  onChanged: () => Promise<unknown>
}) {
  const [newName, setNewName] = useState('')

  const rename = async (id: number, name: string) => {
    await api.put(`/teams/${id}`, { name })
    await onChanged()
  }
  const setArchived = async (id: number, archived: boolean) => {
    await api.put(`/teams/${id}`, { archived })
    await onChanged()
  }
  const add = async () => {
    if (!newName.trim()) return
    await api.post('/teams', { name: newName.trim() })
    setNewName('')
    await onChanged()
  }

  return (
    <Modal title="Teams" onClose={onClose}>
      <div className="stack" style={{ gap: 8 }}>
        {teams.map((t, i) => (
          <div key={t.id} className="row" style={{ gap: 8, opacity: t.archived ? 0.55 : 1 }}>
            <span className="dot" style={{ background: seriesVar(i), flexShrink: 0 }} />
            <input
              type="text"
              defaultValue={t.name}
              style={{ flex: 1 }}
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value.trim() !== t.name) {
                  void rename(t.id, e.target.value.trim())
                }
              }}
            />
            <button type="button" className="ghost" onClick={() => void setArchived(t.id, !t.archived)}>
              {t.archived ? 'Restore' : 'Archive'}
            </button>
          </div>
        ))}
        <form
          className="row"
          style={{ gap: 8, marginTop: 4 }}
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <input
            type="text"
            placeholder="New team name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit" className="primary" disabled={!newName.trim()}>
            Add
          </button>
        </form>
      </div>
    </Modal>
  )
}

/* --------------------------------------------------------------- exports */

function groupByWorkstream(entries: StatusEntry[]): WorkstreamGroup[] {
  const map = new Map<number, WorkstreamGroup>()
  for (const e of entries) {
    if (!map.has(e.initiativeId)) {
      map.set(e.initiativeId, { initiativeId: e.initiativeId, title: e.title, entries: [] })
    }
    map.get(e.initiativeId)!.entries.push(e)
  }
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title))
}

function entrySummaryBits(e: StatusEntry): string[] {
  const slip = dateSlip(e)
  const bits = [ragLabel(e.rag)]
  if (e.targetDate) {
    bits.push(`target ${shortDate(e.targetDate)}${slip ? ` (was ${shortDate(slip.was)})` : ''}`)
  }
  if (e.progress && e.progress.total > 0) bits.push(`${e.progress.done}/${e.progress.total} done`)
  return bits
}

function reportMarkdown(report: StatusReport, sections: Section[]): string {
  const lines: string[] = [`# Weekly status — week of ${longDate(report.week)}`, '']
  for (const s of sections) {
    lines.push(`## ${s.label}`, '')
    for (const e of s.entries) {
      lines.push(`- **${e.title}**${e.jiraKey ? ` (${e.jiraKey})` : ''} — ${entrySummaryBits(e).join(' · ')}`)
      if (e.updateText.trim()) {
        for (const l of e.updateText.trim().split('\n')) lines.push(`  ${l}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n').trim() + '\n'
}

function wsMarkdown(
  report: StatusReport,
  groups: WorkstreamGroup[],
  teamName: (id: number | null) => string
): string {
  const lines: string[] = [`# Weekly status — week of ${longDate(report.week)}`, '']
  for (const g of groups) {
    lines.push(`## ${g.title}`, '')
    for (const e of g.entries) {
      lines.push(
        `- **${teamName(e.teamId)}**${e.jiraKey ? ` (${e.jiraKey})` : ''} — ${entrySummaryBits(e).join(' · ')}`
      )
      if (e.updateText.trim()) {
        for (const l of e.updateText.trim().split('\n')) lines.push(`  ${l}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n').trim() + '\n'
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const RAG_HTML_COLOR: Record<Rag, string> = {
  'on-track': '#0ca30c',
  'at-risk': '#c98a00',
  'off-track': '#d03b3b',
  done: '#2f6fd0',
  paused: '#777777',
}

/** Rich-clipboard flavour grouped by workstream: one table per initiative. */
function wsHtml(
  report: StatusReport,
  groups: WorkstreamGroup[],
  teamName: (id: number | null) => string
): string {
  const parts: string[] = [`<h1>Weekly status — week of ${esc(longDate(report.week))}</h1>`]
  for (const g of groups) {
    parts.push(`<h2>${esc(g.title)}</h2>`)
    parts.push(
      '<table><thead><tr><th>Team</th><th>Epic</th><th>Status</th><th>Target</th><th>Progress</th><th>Update</th></tr></thead><tbody>'
    )
    for (const e of g.entries) {
      const slip = dateSlip(e)
      const target = e.targetDate
        ? `${esc(shortDate(e.targetDate))}${slip ? ` <em>(was ${esc(shortDate(slip.was))})</em>` : ''}`
        : '—'
      const progress =
        e.progress && e.progress.total > 0
          ? `${e.progress.done}/${e.progress.total} (${Math.round(e.progress.pct)}%)`
          : '—'
      parts.push(
        '<tr>' +
          `<td><strong>${esc(teamName(e.teamId))}</strong></td>` +
          `<td>${e.jiraKey ? esc(e.jiraKey) : '—'}</td>` +
          `<td><strong style="color:${RAG_HTML_COLOR[e.rag]}">${esc(ragLabel(e.rag))}</strong></td>` +
          `<td>${target}</td>` +
          `<td>${progress}</td>` +
          `<td>${esc(e.updateText.trim()).replace(/\n/g, '<br/>')}</td>` +
          '</tr>'
      )
    }
    parts.push('</tbody></table>')
  }
  return parts.join('\n')
}

/** Rich-clipboard flavour: tables per team, pastes cleanly into Confluence. */
function reportHtml(report: StatusReport, sections: Section[]): string {
  const parts: string[] = [`<h1>Weekly status — week of ${esc(longDate(report.week))}</h1>`]
  for (const s of sections) {
    parts.push(`<h2>${esc(s.label)}</h2>`)
    parts.push(
      '<table><thead><tr><th>Workstream</th><th>Status</th><th>Target</th><th>Progress</th><th>Update</th></tr></thead><tbody>'
    )
    for (const e of s.entries) {
      const slip = dateSlip(e)
      const target = e.targetDate
        ? `${esc(shortDate(e.targetDate))}${slip ? ` <em>(was ${esc(shortDate(slip.was))})</em>` : ''}`
        : '—'
      const progress =
        e.progress && e.progress.total > 0
          ? `${e.progress.done}/${e.progress.total} (${Math.round(e.progress.pct)}%)`
          : '—'
      parts.push(
        '<tr>' +
          `<td><strong>${esc(e.title)}</strong>${e.jiraKey ? ` (${esc(e.jiraKey)})` : ''}</td>` +
          `<td><strong style="color:${RAG_HTML_COLOR[e.rag]}">${esc(ragLabel(e.rag))}</strong></td>` +
          `<td>${target}</td>` +
          `<td>${progress}</td>` +
          `<td>${esc(e.updateText.trim()).replace(/\n/g, '<br/>')}</td>` +
          '</tr>'
      )
    }
    parts.push('</tbody></table>')
  }
  return parts.join('\n')
}
