import { useState } from 'react'
import { useReport, useScope } from '../lib/scope'
import type { BurnupData, TimelineGraphData } from '../lib/api'
import { Card, Banner, Empty, TableToggle, ResizableBody } from '../components/ui'
import { ProgressLine, ProgressTable } from '../charts/ProgressLine'
import { FlowInOut, FlowInOutTable, type FlowVariant } from '../charts/FlowInOut'
import { TemporalGraph, TimelineTable } from '../charts/TemporalGraph'
import { metricLabel } from '../lib/format'
import { NoData } from './Overview'

export function Timeline() {
  const { scope, catalog, sync } = useScope()
  const [progressTable, setProgressTable] = useState(false)
  const [flowTable, setFlowTable] = useState(false)
  const [flowStyle, setFlowStyle] = useState<FlowVariant>(() =>
    new URLSearchParams(window.location.search).get('flowStyle') === 'lines' ? 'lines' : 'bars'
  )
  const [graphTable, setGraphTable] = useState(false)

  const burnup = useReport<BurnupData>('/reports/burnup')
  const graph = useReport<TimelineGraphData>('/reports/graph-timeline')

  if (!catalog?.ready && !sync?.running) return <NoData />

  const scopeName = scope.roots.length ? scope.roots.join(', ') : 'the selected scope'

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Timeline</h1>
          <p>
            The same scope as a story: how completion moved, what arrived against what finished, and
            the network growing week by week. Pick an epic or initiative in the filter row to follow
            one thing.
          </p>
        </div>
      </div>

      {burnup.error && <Banner kind="error" title="Could not build the burn-up">{burnup.error}</Banner>}
      {graph.error && <Banner kind="error" title="Could not build the replay">{graph.error}</Banner>}

      <div className="stack">
        <div className="grid cols-2">
          <Card
            title={`Completion of ${scopeName}`}
            sub={`Percent of ${metricLabel(scope.metric)} done, day by day — dips are scope arriving faster than it finishes`}
            loading={burnup.loading}
            actions={<TableToggle on={progressTable} onChange={setProgressTable} />}
          >
            {burnup.data && !burnup.data.empty && burnup.data.series.length > 1 ? (
              progressTable ? (
                <ProgressTable data={burnup.data} />
              ) : (
                <ResizableBody storageKey="timeline.progress" defaultHeight={310} min={200}>
                  {(h) => <ProgressLine data={burnup.data!} metric={scope.metric} height={h - 8} />}
                </ResizableBody>
              )
            ) : (
              <Empty title="Not enough history in this scope">
                Sync change history first, or widen the window to all time.
              </Empty>
            )}
          </Card>

          <Card
            title="Added vs completed"
            sub={
              flowStyle === 'bars'
                ? 'Per week: scope arriving (up) against work finishing (down)'
                : flowStyle === 'cumulative'
                  ? 'Running totals: the gap between the lines is the open scope'
                  : 'Per week: scope arriving against work finishing, as trends'
            }
            loading={burnup.loading}
            actions={
              <>
                <div className="segmented" role="group" aria-label="Chart style">
                  <button type="button" aria-pressed={flowStyle === 'bars'} onClick={() => setFlowStyle('bars')}>
                    Bars
                  </button>
                  <button type="button" aria-pressed={flowStyle === 'lines'} onClick={() => setFlowStyle('lines')}>
                    Lines
                  </button>
                  <button
                    type="button"
                    aria-pressed={flowStyle === 'cumulative'}
                    onClick={() => setFlowStyle('cumulative')}
                  >
                    Cumulative
                  </button>
                </div>
                <TableToggle on={flowTable} onChange={setFlowTable} />
              </>
            }
          >
            {burnup.data && burnup.data.weekly.length ? (
              flowTable ? (
                <FlowInOutTable data={burnup.data} />
              ) : (
                <ResizableBody storageKey="timeline.flow" defaultHeight={310} min={200}>
                  {(h) => (
                    <FlowInOut data={burnup.data!} metric={scope.metric} variant={flowStyle} height={h - 46} />
                  )}
                </ResizableBody>
              )
            ) : (
              <Empty title="Nothing arrived or finished in this window" />
            )}
          </Card>
        </div>

        <Card
          title="Evolution"
          sub="Press play — stories appear under their epics as they were created and darken as they reach done"
          loading={graph.loading}
          actions={<TableToggle on={graphTable} onChange={setGraphTable} />}
        >
          {graph.data && graph.data.nodes.length ? (
            graphTable ? (
              <TimelineTable data={graph.data} />
            ) : (
              <ResizableBody storageKey="timeline.evolution" defaultHeight={600} min={320}>
                {(h) => <TemporalGraph data={graph.data!} height={h - 118} />}
              </ResizableBody>
            )
          ) : (
            <Empty title="Nothing to replay in this scope" />
          )}
        </Card>
      </div>
    </div>
  )
}
