import { useState } from 'react'
import { useReport, useScope } from '../lib/scope'
import type { ChordData, CycleTimeData, GraphData } from '../lib/api'
import { Card, Banner, Empty, TableToggle, ResizableBody } from '../components/ui'
import { ChordChart, ChordTable } from '../charts/ChordChart'
import { DotPlot, CycleTimeTable } from '../charts/DotPlot'
import { NetworkGraph, GraphTable } from '../charts/NetworkGraph'
import { Select } from '../components/Picker'
import { NoData } from './Overview'

export function Insights() {
  const { catalog, sync } = useScope()
  const [flow, setFlow] = useState<'handovers' | 'projects'>('handovers')
  const [chordTable, setChordTable] = useState(false)
  const [groupBy, setGroupBy] = useState<'epic' | 'assignee' | 'project'>('epic')
  const [cycleTable, setCycleTable] = useState(false)
  const [includeStories, setIncludeStories] = useState(false)
  const [graphTable, setGraphTable] = useState(false)

  const chord = useReport<ChordData>('/reports/chord', { flow })
  const cycle = useReport<CycleTimeData>('/reports/cycletime', { groupBy })
  const graph = useReport<GraphData>('/reports/graph', { includeStories: String(includeStories) })

  if (!catalog?.ready && !sync?.running) return <NoData />

  const unitLabel = flow === 'projects' ? 'links' : 'handovers'

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Insights</h1>
          <p>
            Three more lenses on the same scope: who hands work to whom, how long work takes once
            started, and how initiatives, epics and ideas hang together.
          </p>
        </div>
      </div>

      {chord.error && <Banner kind="error" title="Could not build the chord">{chord.error}</Banner>}
      {cycle.error && <Banner kind="error" title="Could not compute cycle times">{cycle.error}</Banner>}
      {graph.error && <Banner kind="error" title="Could not build the network">{graph.error}</Banner>}

      <div className="stack">
        <div className="grid cols-2">
          <Card
            title="Work handovers"
            sub={
              flow === 'handovers'
                ? 'Reassignments between people; the arrow lands on the receiver'
                : 'Issue links crossing project boundaries'
            }
            loading={chord.loading}
            actions={
              <>
                <Select label="Flow" value={flow} onChange={(v) => setFlow(v as typeof flow)} width={150}>
                  <option value="handovers">Between people</option>
                  <option value="projects">Between projects</option>
                </Select>
                <TableToggle on={chordTable} onChange={setChordTable} />
              </>
            }
          >
            {chord.data && chord.data.flows.length ? (
              chordTable ? (
                <ChordTable data={chord.data} unitLabel={unitLabel} />
              ) : (
                <ResizableBody storageKey="insights.chord" defaultHeight={560} min={340}>
                  {(h) => <ChordChart data={chord.data!} unitLabel={unitLabel} height={h - 100} />}
                </ResizableBody>
              )
            ) : (
              <Empty title="No flows in this scope">
                {flow === 'handovers'
                  ? 'Handovers come from assignee change history — sync change history first, or widen the scope.'
                  : 'No issue links cross project boundaries in this scope.'}
              </Empty>
            )}
          </Card>

          <Card
            title="Cycle time"
            sub="Days from created to resolved; slowest groups first"
            loading={cycle.loading}
            actions={
              <>
                <Select label="Group by" value={groupBy} onChange={(v) => setGroupBy(v as typeof groupBy)} width={130}>
                  <option value="epic">Epic</option>
                  <option value="assignee">Assignee</option>
                  <option value="project">Project</option>
                </Select>
                <TableToggle on={cycleTable} onChange={setCycleTable} />
              </>
            }
          >
            {cycle.data && cycle.data.rows.length ? (
              cycleTable ? (
                <CycleTimeTable data={cycle.data} />
              ) : (
                <ResizableBody storageKey="insights.cycletime" defaultHeight={560} min={220}>
                  {(h) => <DotPlot data={cycle.data!} max={Math.max(3, Math.floor((h - 96) / 30))} />}
                </ResizableBody>
              )
            ) : (
              <Empty title="Not enough resolved issues">
                Cycle time needs at least two resolved issues per group.
              </Empty>
            )}
          </Card>
        </div>

        <Card
          title="Delivery network"
          sub="Initiatives, epics and ideas; dashed arrows are issue links. Node size is the amount of child work."
          loading={graph.loading}
          actions={
            <>
              <div className="segmented" role="group" aria-label="Detail">
                <button type="button" aria-pressed={!includeStories} onClick={() => setIncludeStories(false)}>
                  Epics &amp; up
                </button>
                <button type="button" aria-pressed={includeStories} onClick={() => setIncludeStories(true)}>
                  With stories
                </button>
              </div>
              <TableToggle on={graphTable} onChange={setGraphTable} />
            </>
          }
        >
          {graph.data && graph.data.nodes.length ? (
            graphTable ? (
              <GraphTable data={graph.data} />
            ) : (
              <ResizableBody storageKey="insights.network" defaultHeight={540} min={300}>
                {(h) => <NetworkGraph data={graph.data!} height={h - 70} />}
              </ResizableBody>
            )
          ) : (
            <Empty title="Nothing above story level in this scope" />
          )}
        </Card>
      </div>
    </div>
  )
}
