import { useState } from 'react'
import { useReport, useScope } from '../lib/scope'
import type { Person, SankeyData } from '../lib/api'
import { Card, Banner, Empty, TableToggle, StatTile, ResizableBody } from '../components/ui'
import { SankeyChart, SankeyTable } from '../charts/SankeyChart'
import { BreakdownBars, type BreakdownRow } from '../charts/BreakdownBars'
import { compact, full, metricLabel, pct } from '../lib/format'
import { Select } from '../components/Picker'
import { NoData } from './Overview'

const DIMENSIONS = [
  { key: 'assignee', label: 'Assignee' },
  { key: 'reporter', label: 'Reporter' },
  { key: 'epic', label: 'Epic' },
  { key: 'initiative', label: 'Initiative' },
  { key: 'project', label: 'Project' },
  { key: 'status', label: 'Status' },
  { key: 'category', label: 'Progress' },
  { key: 'type', label: 'Issue type' },
  { key: 'priority', label: 'Priority' },
]

export function People() {
  const { scope, catalog, sync } = useScope()
  const [from, setFrom] = useState('assignee')
  const [via, setVia] = useState('epic')
  const [to, setTo] = useState('category')
  const [table, setTable] = useState(false)

  const dimensions = [from, via, to].filter((d, i, a) => d !== 'none' && a.indexOf(d) === i)

  const flow = useReport<SankeyData>('/reports/sankey', {
    dimensions: dimensions.join(','),
    maxPerColumn: 8,
  })
  const people = useReport<{ people: Person[] }>('/reports/people')

  if (!catalog?.ready && !sync?.running) return <NoData />

  const rows: BreakdownRow[] =
    people.data?.people.map((p) => ({
      id: p.id,
      name: p.name,
      sub: `${p.issues} issues`,
      done: p.done,
      inProgress: p.inProgress,
      todo: p.todo,
    })) ?? []

  const assigned = people.data?.people.filter((p) => p.id !== 'unassigned') ?? []
  const unassigned = people.data?.people.find((p) => p.id === 'unassigned')

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>People &amp; flow</h1>
          <p>
            Who is carrying which work, and where it ends up. Ribbon width is the selected measure —{' '}
            {metricLabel(scope.metric)}.
          </p>
        </div>
      </div>

      {flow.error && <Banner kind="error" title="Could not build the flow">{flow.error}</Banner>}

      <div className="stack">
        <div className="grid cols-4">
          <StatTile label="People with work" value={compact(assigned.length)} />
          <StatTile
            label="Busiest"
            value={assigned[0]?.name.split(' ')[0] ?? '—'}
            detail={assigned[0] ? `${compact(assigned[0].total)} ${metricLabel(scope.metric)}` : undefined}
          />
          <StatTile
            label="Unassigned"
            value={compact(unassigned?.total ?? 0)}
            detail={unassigned ? `${unassigned.issues} issues` : 'none'}
          />
          <StatTile
            label="Median load"
            value={compact(median(assigned.map((p) => p.total)))}
            detail={`per person, ${metricLabel(scope.metric)}`}
          />
        </div>

        <Card
          title="Flow of work"
          sub="Pick the columns; every ribbon is one slice of the selected measure."
          loading={flow.loading}
          actions={
            <>
              <Select label="From" value={from} onChange={setFrom} width={130}>
                {DIMENSIONS.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </Select>
              <Select label="Through" value={via} onChange={setVia} width={130}>
                <option value="none">— skip —</option>
                {DIMENSIONS.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </Select>
              <Select label="To" value={to} onChange={setTo} width={130}>
                {DIMENSIONS.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </Select>
              <TableToggle on={table} onChange={setTable} />
            </>
          }
        >
          {flow.data?.links?.length ? (
            table ? (
              <SankeyTable data={flow.data} metric={scope.metric} />
            ) : (
              <ResizableBody storageKey="people.sankey" defaultHeight={520} min={280}>
                {(h) => <SankeyChart data={flow.data!} metric={scope.metric} height={h - 90} />}
              </ResizableBody>
            )
          ) : (
            <Empty title="Nothing flows between those columns">
              Try a different pairing, widen the window, or switch the measure to issue count — story
              points and logged time are zero for many issues.
            </Empty>
          )}
        </Card>

        <Card
          title="Load per person"
          sub={`Ranked by ${metricLabel(scope.metric)}; segments are the issue's current state`}
          loading={people.loading}
        >
          {rows.length ? (
            <>
              <ResizableBody
                storageKey="people.load"
                defaultHeight={Math.min(110 + rows.length * 30, 560)}
                min={170}
              >
                {(h) => <BreakdownBars rows={rows} metric={scope.metric} max={Math.max(3, Math.floor((h - 64) / 30))} />}
              </ResizableBody>
              {rows.length > 20 && (
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Drag the corner to show more of the {rows.length} people; the table below lists everyone.
                </p>
              )}
              <details style={{ marginTop: 14 }}>
                <summary className="muted" style={{ cursor: 'pointer', fontSize: 12.5 }}>
                  All {rows.length} people as a table
                </summary>
                <div className="table-scroll" style={{ marginTop: 10 }}>
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th style={{ textAlign: 'right' }}>Issues</th>
                        <th style={{ textAlign: 'right' }}>Points</th>
                        <th style={{ textAlign: 'right' }}>Hours</th>
                        <th style={{ textAlign: 'right' }}>Done</th>
                        <th style={{ textAlign: 'right' }}>In progress</th>
                        <th style={{ textAlign: 'right' }}>To do</th>
                        <th style={{ textAlign: 'right' }}>Complete</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(people.data?.people ?? []).map((p) => (
                        <tr key={p.id}>
                          <td>{p.name}</td>
                          <td className="num">{full(p.issues)}</td>
                          <td className="num">{full(p.points)}</td>
                          <td className="num">{full(p.hours)}</td>
                          <td className="num">{full(p.done)}</td>
                          <td className="num">{full(p.inProgress)}</td>
                          <td className="num">{full(p.todo)}</td>
                          <td className="num">{pct(p.total ? (p.done / p.total) * 100 : 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          ) : (
            <Empty title="Nobody is assigned work in this scope" />
          )}
        </Card>
      </div>
    </div>
  )
}

function median(xs: number[]) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
