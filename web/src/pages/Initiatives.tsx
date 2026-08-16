import { useMemo, useState } from 'react'
import { useReport, useScope } from '../lib/scope'
import type { TreeNode } from '../lib/api'
import { Card, Meter, Banner, Empty, TableToggle } from '../components/ui'
import { Icicle } from '../charts/Icicle'
import { compact, full, metricLabel, pct } from '../lib/format'
import { NoData } from './Overview'

export function Initiatives() {
  const { scope, setScope, catalog, sync, siteUrl } = useScope()
  const { data, loading, error } = useReport<{ tree: TreeNode[]; issueCount: number }>('/reports/tree')
  const [table, setTable] = useState(false)

  const tree = data?.tree ?? []
  const totals = useMemo(
    () =>
      tree.reduce(
        (acc, n) => ({
          total: acc.total + n.rollup.total,
          done: acc.done + n.rollup.done,
          inProgress: acc.inProgress + n.rollup.inProgress,
          leaves: acc.leaves + n.rollup.leaves,
        }),
        { total: 0, done: 0, inProgress: 0, leaves: 0 }
      ),
    [tree]
  )

  if (!catalog?.ready && !sync?.running) return <NoData />

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Initiatives &amp; epics</h1>
          <p>
            Every child rolled up through the parent chain — initiative to epic to story to sub-task —
            with completion measured in {metricLabel(scope.metric)}.
          </p>
        </div>
      </div>

      {error && <Banner kind="error" title="Could not build the hierarchy">{error}</Banner>}

      <div className="stack">
        <Card
          title="Share of work"
          sub="Each column is one level of the hierarchy; height is share of the selected measure. Click a block to zoom in."
          loading={loading}
        >
          {tree.length ? (
            <Icicle tree={tree} metric={scope.metric} onSelect={(key) => setScope({ roots: [key] })} />
          ) : (
            <Empty title="Nothing to roll up in this scope" />
          )}
        </Card>

        <Card
          title="Rollup"
          sub={
            tree.length
              ? `${tree.length} top-level item(s) · ${full(totals.leaves)} leaf issues · ${pct(
                  totals.total ? (totals.done / totals.total) * 100 : 0
                )} complete overall`
              : undefined
          }
          loading={loading}
          actions={<TableToggle on={table} onChange={setTable} />}
        >
          {!tree.length ? (
            <Empty title="No parent items here">
              Choose an initiative or epic in the filter row, or select whole projects.
            </Empty>
          ) : table ? (
            <FlatTable tree={tree} metric={scope.metric} siteUrl={siteUrl} />
          ) : (
            <div>
              <div
                className="tree-row"
                style={{ cursor: 'default', color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}
              >
                <span />
                <span>Item</span>
                <span>Complete</span>
                <span style={{ textAlign: 'right' }}>{metricLabel(scope.metric)}</span>
              </div>
              {tree.map((n) => (
                <TreeRow key={n.id} node={n} depth={0} metric={scope.metric} siteUrl={siteUrl} />
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

function TreeRow({
  node,
  depth,
  metric,
  siteUrl,
}: {
  node: TreeNode
  depth: number
  metric: string
  siteUrl: string | null
}) {
  const [open, setOpen] = useState(depth < 1)
  const hasChildren = node.children.length > 0

  return (
    <>
      <div className="tree-row" style={{ paddingLeft: 8 + depth * 18 }}>
        <span
          className="twisty"
          role={hasChildren ? 'button' : undefined}
          tabIndex={hasChildren ? 0 : -1}
          onClick={() => hasChildren && setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (hasChildren && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              setOpen((o) => !o)
            }
          }}
          style={{ cursor: hasChildren ? 'pointer' : 'default' }}
          aria-label={hasChildren ? (open ? 'Collapse' : 'Expand') : undefined}
        >
          {hasChildren ? (open ? '▾' : '▸') : ''}
        </span>

        <span className="tree-title">
          <span className="tree-key">
            {siteUrl ? (
              <a href={`${siteUrl}/browse/${node.key}`} target="_blank" rel="noreferrer">
                {node.key}
              </a>
            ) : (
              node.key
            )}
          </span>
          <span className="tree-summary" title={node.summary}>
            {node.summary}
          </span>
          <span className="pill" style={{ flex: '0 0 auto' }}>
            {node.type}
          </span>
        </span>

        <Meter
          done={node.rollup.done}
          inProgress={node.rollup.inProgress}
          total={node.rollup.total}
          showLabel={false}
        />

        <span className="tree-pct">
          {pct(node.rollup.percent)} · {compact(node.rollup.total)}
        </span>
      </div>
      {open && node.children.map((c) => (
        <TreeRow key={c.id} node={c} depth={depth + 1} metric={metric} siteUrl={siteUrl} />
      ))}
    </>
  )
}

function flatten(nodes: TreeNode[], depth = 0, out: { n: TreeNode; depth: number }[] = []) {
  for (const n of nodes) {
    out.push({ n, depth })
    flatten(n.children, depth + 1, out)
  }
  return out
}

function FlatTable({ tree, metric, siteUrl }: { tree: TreeNode[]; metric: string; siteUrl: string | null }) {
  const rows = flatten(tree)
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Key</th>
            <th>Summary</th>
            <th>Type</th>
            <th>Status</th>
            <th>Assignee</th>
            <th style={{ textAlign: 'right' }}>{metricLabel(metric)}</th>
            <th style={{ textAlign: 'right' }}>Done</th>
            <th style={{ textAlign: 'right' }}>Complete</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ n, depth }) => (
            <tr key={n.id}>
              <td style={{ paddingLeft: depth * 14 }}>
                {siteUrl ? (
                  <a href={`${siteUrl}/browse/${n.key}`} target="_blank" rel="noreferrer">
                    {n.key}
                  </a>
                ) : (
                  n.key
                )}
              </td>
              <td className="wide">{n.summary}</td>
              <td>{n.type}</td>
              <td>{n.status}</td>
              <td>{n.assignee ?? '—'}</td>
              <td className="num">{full(n.rollup.total)}</td>
              <td className="num">{full(n.rollup.done)}</td>
              <td className="num">{pct(n.rollup.percent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
