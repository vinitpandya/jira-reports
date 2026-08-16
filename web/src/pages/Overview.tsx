import { Link } from 'react-router-dom'
import { useReport, useScope } from '../lib/scope'
import type { Summary, TreeNode } from '../lib/api'
import { Card, StatTile, Meter, Banner, Empty, ResizableBody } from '../components/ui'
import { ThroughputBars } from '../charts/ThroughputBars'
import { BreakdownBars, type BreakdownRow } from '../charts/BreakdownBars'
import { compact, full, metricLabel, pct } from '../lib/format'

export function Overview() {
  const { scope, catalog, sync, syncError } = useScope()
  const { data, loading, error } = useReport<Summary>('/reports/summary')
  const tree = useReport<{ tree: TreeNode[] }>('/reports/tree')

  if (!catalog?.ready && !sync?.running) return <NoData />

  const metric = scope.metric

  const topRows: BreakdownRow[] =
    tree.data?.tree
      .slice(0, 8)
      .map((n) => ({
        id: n.id,
        name: `${n.key} ${n.summary}`,
        sub: n.type,
        done: n.rollup.done,
        inProgress: n.rollup.inProgress,
        todo: n.rollup.todo,
      })) ?? []

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>
            Everything below is scoped by the filter row and reads from the local cache — nothing here
            calls Jira until you press Refresh.
          </p>
        </div>
      </div>

      {syncError && (
        <Banner kind="error" title="Last sync failed">
          {syncError}
        </Banner>
      )}
      {error && <Banner kind="error" title="Could not build the report">{error}</Banner>}

      <div className="stack">
        <div className="grid cols-2">
          <Card title="Scope progress" loading={loading}>
            {data ? (
              <>
                {/* Exactly one hero figure per view. */}
                <div className="hero">{pct(data.percentComplete)}</div>
                <div className="hero-sub">
                  complete by {metricLabel(metric)} — {full(data.byCategory.done ?? 0)} of{' '}
                  {full(data.total)}
                </div>
                <div style={{ marginTop: 16 }}>
                  <Meter
                    done={data.byCategory.done ?? 0}
                    inProgress={data.byCategory.indeterminate ?? 0}
                    total={data.total}
                    showLabel={false}
                  />
                </div>
                <div className="row" style={{ marginTop: 12, gap: 16 }}>
                  <LegendKey color="var(--meter-done)" label={`Done ${compact(data.byCategory.done ?? 0)}`} />
                  <LegendKey
                    color="var(--meter-progress)"
                    label={`In progress ${compact(data.byCategory.indeterminate ?? 0)}`}
                  />
                  <LegendKey color="var(--meter-track)" label={`To do ${compact(data.byCategory.new ?? 0)}`} />
                </div>
              </>
            ) : (
              <Empty title="No issues in this scope" />
            )}
          </Card>

          <Card title="Resolved per week" sub="Last 12 weeks, by resolution date" loading={loading}>
            {data?.throughput?.length ? (
              <ResizableBody storageKey="overview.throughput" defaultHeight={160} min={110} max={480}>
                {(h) => (
                  <ThroughputBars
                    data={data.throughput}
                    field={metric === 'points' ? 'points' : 'count'}
                    height={h - 6}
                  />
                )}
              </ResizableBody>
            ) : (
              <Empty title="Nothing resolved yet" />
            )}
          </Card>
        </div>

        <div className="grid cols-4">
          <StatTile label="Issues in scope" value={compact(data?.issues ?? 0)} detail={`${data?.counts.done ?? 0} done`} />
          <StatTile
            label="In progress"
            value={compact(data?.byCategory.indeterminate ?? 0)}
            detail={pct(data?.percentInProgress ?? 0)}
          />
          <StatTile
            label="People assigned"
            value={compact(data?.assignees ?? 0)}
            detail={`${compact(data?.unassigned ?? 0)} issues unassigned`}
          />
          <StatTile
            label="Story points"
            value={compact(data?.points ?? 0)}
            detail={`${pct(data?.estimatedCoverage ?? 0)} of issues estimated`}
          />
        </div>

        <Card
          title="Largest items in scope"
          sub="Top-level items ranked by share of the selected measure"
          loading={tree.loading}
          actions={<Link to="/initiatives">Full hierarchy →</Link>}
        >
          {topRows.length ? (
            <ResizableBody storageKey="overview.topitems" defaultHeight={Math.min(64 + topRows.length * 30, 360)} min={150}>
              {(h) => <BreakdownBars rows={topRows.slice(0, Math.max(2, Math.floor((h - 64) / 30)))} metric={metric} />}
            </ResizableBody>
          ) : (
            <Empty title="No parent items in this scope">
              Pick an initiative or epic in the filter row, or widen the window.
            </Empty>
          )}
        </Card>
      </div>
    </div>
  )
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="dot" style={{ background: color }} />
      <span className="muted" style={{ fontSize: 12.5 }}>
        {label}
      </span>
    </span>
  )
}

export function NoData() {
  return (
    <div className="page">
      <Empty title="No local data yet">
        <p style={{ maxWidth: '52ch', margin: '0 auto 16px' }}>
          Connect a Jira site, choose which projects to cache, and run the first sync. Reports are built
          entirely from the local copy after that.
        </p>
        <Link to="/settings">
          <button type="button" className="primary">
            Go to connection &amp; sync
          </button>
        </Link>
      </Empty>
    </div>
  )
}
