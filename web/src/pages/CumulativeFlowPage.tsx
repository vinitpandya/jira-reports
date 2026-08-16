import { useState } from 'react'
import { useReport, useScope } from '../lib/scope'
import type { Cfd } from '../lib/api'
import { Card, Banner, Empty, TableToggle, ResizableBody } from '../components/ui'
import { CumulativeFlow, CfdTable } from '../charts/CumulativeFlow'
import { NoData } from './Overview'

export function CumulativeFlowPage() {
  const { scope, catalog, sync } = useScope()
  const [groupBy, setGroupBy] = useState<'status' | 'category'>('status')
  const [leavesOnly, setLeavesOnly] = useState(true)
  const [table, setTable] = useState(false)

  const { data, loading, error } = useReport<Cfd>('/reports/cfd', {
    groupBy,
    leavesOnly: String(leavesOnly),
  })

  if (!catalog?.ready && !sync?.running) return <NoData />

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Cumulative flow</h1>
          <p>
            How much work sat in each state, day by day, rebuilt from issue change history. A widening
            band is a queue building up; a flat top band is work that stopped arriving.
          </p>
        </div>
      </div>

      {error && <Banner kind="error" title="Could not build the flow">{error}</Banner>}

      <Card
        title={scope.roots.length ? `Flow beneath ${scope.roots.join(', ')}` : 'Flow across the selected scope'}
        sub={
          leavesOnly
            ? 'Counting leaf issues only — parents are excluded so an epic is not counted twice'
            : 'Counting every issue in scope, parents included'
        }
        loading={loading}
        actions={
          <>
            <div className="segmented" role="group" aria-label="Group by">
              <button type="button" aria-pressed={groupBy === 'status'} onClick={() => setGroupBy('status')}>
                By status
              </button>
              <button type="button" aria-pressed={groupBy === 'category'} onClick={() => setGroupBy('category')}>
                By progress
              </button>
            </div>
            <div className="segmented" role="group" aria-label="Which issues">
              <button type="button" aria-pressed={leavesOnly} onClick={() => setLeavesOnly(true)}>
                Leaves
              </button>
              <button type="button" aria-pressed={!leavesOnly} onClick={() => setLeavesOnly(false)}>
                All
              </button>
            </div>
            <TableToggle on={table} onChange={setTable} />
          </>
        }
      >
        {data && !data.empty && data.series.length > 1 ? (
          table ? (
            <CfdTable data={data} />
          ) : (
            <ResizableBody storageKey="flow.cfd" defaultHeight={400} min={240}>
              {(h) => <CumulativeFlow data={data} metric={scope.metric} height={h - 56} />}
            </ResizableBody>
          )
        ) : (
          <Empty title="Not enough history to draw a flow">
            <p style={{ maxWidth: '54ch', margin: '0 auto' }}>
              A cumulative flow needs issue change history. If you have just synced, check that the sync
              finished its “status history” phase, then widen the window or pick a broader scope.
            </p>
          </Empty>
        )}
      </Card>
    </div>
  )
}
