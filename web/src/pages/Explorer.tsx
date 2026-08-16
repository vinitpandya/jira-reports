import { useState } from 'react'
import { useReport, useScope } from '../lib/scope'
import type { IssueRow } from '../lib/api'
import { Card, Banner, Empty } from '../components/ui'
import { compact, full, longDate, pct } from '../lib/format'
import { NoData } from './Overview'

const CATEGORY_LABEL: Record<string, string> = {
  new: 'To do',
  indeterminate: 'In progress',
  done: 'Done',
}

export function Explorer() {
  const { scope, setScope, catalog, sync, siteUrl } = useScope()
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState('all')

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
          <div className="table-scroll" style={{ maxHeight: 620 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Summary</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Assignee</th>
                  <th>Parent</th>
                  <th style={{ textAlign: 'right' }}>Points</th>
                  <th style={{ textAlign: 'right' }}>Hours</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.key}>
                    <td>
                      {siteUrl ? (
                        <a href={`${siteUrl}/browse/${i.key}`} target="_blank" rel="noreferrer">
                          {i.key}
                        </a>
                      ) : (
                        i.key
                      )}
                    </td>
                    <td className="wide" title={i.summary}>
                      {i.summary}
                    </td>
                    <td>{i.type}</td>
                    <td>
                      <span className="pill">{i.status}</span>
                    </td>
                    <td>{i.assignee ?? '—'}</td>
                    <td>{i.parent ?? '—'}</td>
                    <td className="num">{i.points != null ? full(i.points) : '—'}</td>
                    <td className="num">{i.hours ? full(i.hours) : '—'}</td>
                    <td>{i.updated ? longDate(i.updated) : '—'}</td>
                    <td>
                      {i.level >= 1 && (
                        <button
                          type="button"
                          className="ghost"
                          style={{ fontSize: 12, padding: '2px 8px' }}
                          onClick={() => setScope({ roots: [i.key] })}
                        >
                          Report on this
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Nothing matches">Clear the filter, or widen the scope in the filter row.</Empty>
        )}
      </Card>

      {catalog?.levels && (
        <div className="grid cols-2" style={{ marginTop: 14 }}>
          <Card title="Issue types in the cache" sub="Grouped by Jira hierarchy level">
            <div className="table-scroll" style={{ maxHeight: 260 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Level</th>
                    <th>Type</th>
                    <th style={{ textAlign: 'right' }}>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.levels.map((l) => (
                    <tr key={`${l.level}-${l.name}`}>
                      <td>{levelName(l.level)}</td>
                      <td>{l.name}</td>
                      <td className="num">{full(l.n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Statuses in the cache" sub="What the cumulative flow bands are drawn from">
            <div className="table-scroll" style={{ maxHeight: 260 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Progress</th>
                    <th style={{ textAlign: 'right' }}>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {(catalog.statuses ?? []).map((s) => (
                    <tr key={s.name}>
                      <td>{s.name}</td>
                      <td>{CATEGORY_LABEL[s.category] ?? s.category}</td>
                      <td className="num">{full(s.n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
