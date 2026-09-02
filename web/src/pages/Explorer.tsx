import { useEffect, useRef, useState } from 'react'
import { DEFAULT_SCOPE, useReport, useScope, type Scope } from '../lib/scope'
import type { IssueRow } from '../lib/api'
import { ScopeBar } from '../components/ScopeBar'
import { Card, Banner, Empty } from '../components/ui'
import { DataGrid } from '../components/DataGrid'
import { IssueLink } from '../components/IssueLink'
import { compact, full, longDate, pct } from '../lib/format'
import { NoData } from './Overview'

const EXPLORER_SCOPE_KEY = 'jira-reports.scope.explorer'

const CATEGORY_LABEL: Record<string, string> = {
  new: 'To do',
  indeterminate: 'In progress',
  done: 'Done',
}

export function Explorer() {
  const { scope, setScope, replaceScope, catalog, sync } = useScope()
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState('all')
  const scopeReady = useRef(false)

  // Explorer keeps its own filter row, persisted locally.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(EXPLORER_SCOPE_KEY)
      replaceScope(raw ? { ...DEFAULT_SCOPE, ...(JSON.parse(raw) as Partial<Scope>) } : DEFAULT_SCOPE)
    } catch {
      replaceScope(DEFAULT_SCOPE)
    }
    requestAnimationFrame(() => {
      scopeReady.current = true
    })
  }, [replaceScope])

  useEffect(() => {
    if (scopeReady.current) localStorage.setItem(EXPLORER_SCOPE_KEY, JSON.stringify(scope))
  }, [scope])

  const { data, loading, error } = useReport<{ total: number; issues: IssueRow[] }>('/reports/issues', {
    limit: 2000,
  })

  if (!catalog?.ready && !sync?.running) return <NoData />

  const q = filter.trim().toLowerCase()
  const rows = (data?.issues ?? []).filter((i) => {
    if (category !== 'all' && i.category !== category) return false
    if (!q) return true
    return (
      i.key.toLowerCase().includes(q) ||
      i.summary.toLowerCase().includes(q) ||
      (i.assignee ?? '').toLowerCase().includes(q) ||
      (i.parent ?? '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Explorer</h1>
          <p>
            Every issue the current scope resolves to. Use it to sanity-check what a report is counting,
            or to pick a new root for the other pages.
          </p>
        </div>
      </div>

      <ScopeBar />

      {error && <Banner kind="error" title="Could not list issues">{error}</Banner>}

      <Card
        title={`${full(rows.length)} of ${full(data?.total ?? 0)} issues in scope`}
        sub={
          data && data.total > (data.issues.length ?? 0)
            ? `Listing the ${full(data.issues.length)} most recently updated — narrow the scope to see the rest`
            : undefined
        }
        loading={loading}
        actions={
          <>
            <input
              type="search"
              value={filter}
              placeholder="Filter key, summary, assignee…"
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: 230 }}
            />
            <div className="segmented" role="group" aria-label="Progress">
              {[
                ['all', 'All'],
                ['new', 'To do'],
                ['indeterminate', 'In progress'],
                ['done', 'Done'],
              ].map(([v, label]) => (
                <button key={v} type="button" aria-pressed={category === v} onClick={() => setCategory(v)}>
                  {label}
                </button>
              ))}
            </div>
          </>
        }
      >
        {rows.length ? (
          <DataGrid
            rows={rows}
            rowKey={(i) => i.key}
            storageKey="explorer"
            maxHeight={620}
            columns={[
              { key: 'key', label: 'Key', value: (i) => i.key, render: (i) => <IssueLink issueKey={i.key} />, groupable: false },
              { key: 'summary', label: 'Summary', value: (i) => i.summary, wide: true, groupable: false, title: (i) => i.summary },
              { key: 'type', label: 'Type', value: (i) => i.type },
              {
                key: 'status',
                label: 'Status',
                value: (i) => i.status,
                render: (i) => <span className="pill">{i.status}</span>,
              },
              { key: 'category', label: 'Progress', value: (i) => CATEGORY_LABEL[i.category] ?? i.category },
              { key: 'assignee', label: 'Assignee', value: (i) => i.assignee },
              { key: 'project', label: 'Project', value: (i) => i.project },
              { key: 'parent', label: 'Parent', value: (i) => i.parent },
              {
                key: 'points',
                label: 'Points',
                value: (i) => i.points,
                align: 'right',
                render: (i) => (i.points != null ? full(i.points) : '—'),
              },
              {
                key: 'hours',
                label: 'Hours',
                value: (i) => i.hours || null,
                align: 'right',
                render: (i) => (i.hours ? full(i.hours) : '—'),
              },
              {
                key: 'updated',
                label: 'Updated',
                value: (i) => i.updated,
                render: (i) => (i.updated ? longDate(i.updated) : '—'),
                groupable: false,
              },
              {
                key: 'actions',
                label: '',
                value: () => null,
                sortable: false,
                groupable: false,
                render: (i) =>
                  i.level >= 1 ? (
                    <button
                      type="button"
                      className="ghost"
                      style={{ fontSize: 12, padding: '2px 8px' }}
                      onClick={() => setScope({ roots: [i.key] })}
                    >
                      Report on this
                    </button>
                  ) : (
                    ''
                  ),
              },
            ]}
          />
        ) : (
          <Empty title="Nothing matches">Clear the filter, or widen the scope in the filter row.</Empty>
        )}
      </Card>

      {catalog?.levels && (
        <div className="grid cols-2" style={{ marginTop: 14 }}>
          <Card title="Issue types in the cache" sub="Grouped by Jira hierarchy level">
            <DataGrid
              rows={catalog.levels}
              rowKey={(l) => `${l.level}-${l.name}`}
              storageKey="catalog-levels"
              maxHeight={260}
              columns={[
                { key: 'level', label: 'Level', value: (l) => l.level, render: (l) => levelName(l.level) },
                { key: 'type', label: 'Type', value: (l) => l.name, groupable: false },
                { key: 'n', label: 'Issues', value: (l) => l.n, align: 'right', render: (l) => full(l.n) },
              ]}
            />
          </Card>

          <Card title="Statuses in the cache" sub="What the cumulative flow bands are drawn from">
            <div className="table-scroll" style={{ maxHeight: 260 }}>
              <DataGrid
                rows={catalog.statuses ?? []}
                rowKey={(s) => s.name}
                storageKey="catalog-statuses"
                maxHeight={260}
                columns={[
                  { key: 'status', label: 'Status', value: (s) => s.name, groupable: false },
                  { key: 'progress', label: 'Progress', value: (s) => CATEGORY_LABEL[s.category] ?? s.category },
                  { key: 'n', label: 'Issues', value: (s) => s.n, align: 'right', render: (s) => full(s.n) },
                ]}
              />
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

function levelName(level: number) {
  if (level <= -1) return 'Sub-task'
  if (level === 0) return 'Standard'
  if (level === 1) return 'Epic'
  return `Level ${level}`
}
