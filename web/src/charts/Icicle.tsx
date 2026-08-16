import { useMemo, useState } from 'react'
import * as d3 from 'd3'
import { makeColorScale, inkOn } from '../lib/palette'
import { compact, full, pct } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion } from '../components/ui'
import type { TreeNode } from '../lib/api'

type Datum = { id: string; name: string; key?: string; node?: TreeNode; children?: Datum[] }

const ROW_H = 26
const GAP = 2
const M = { top: 4, right: 8, bottom: 4, left: 8 }

function leafValue(n: TreeNode, metric: string) {
  if (metric === 'points') return n.points || 0
  if (metric === 'timespent') return n.hours || 0
  return 1
}

/**
 * Structure and proportion in one view: each depth is a column, each cell's
 * height is its share of the metric. Colour follows the top-level entity — every
 * descendant of an initiative wears that initiative's hue, so depth is read from
 * position and the 2px gaps, never from a second colour dimension.
 */
export function Icicle({
  tree,
  metric,
  onSelect,
}: {
  tree: TreeNode[]
  metric: string
  onSelect?: (key: string) => void
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const themeVersion = useThemeVersion()
  const [focusId, setFocusId] = useState<string | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number; node: TreeNode; share: number } | null>(null)

  const toDatum = (n: TreeNode): Datum => ({
    id: n.id,
    name: `${n.key} ${n.summary}`,
    key: n.key,
    node: n,
    children: n.children.length ? n.children.map(toDatum) : undefined,
  })

  const rootData: Datum = useMemo(
    () => ({ id: '__root__', name: 'All', children: tree.map(toDatum) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree]
  )

  const topLevel = useMemo(() => [...tree].sort((a, b) => b.rollup.total - a.rollup.total), [tree])
  const colorOf = useMemo(() => {
    const scale = makeColorScale(topLevel.slice(0, 8).map((n) => n.id))
    const known = new Set(topLevel.slice(0, 8).map((n) => n.id))
    return (topId: string) => (known.has(topId) ? scale(topId) : 'var(--axis)')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topLevel, themeVersion])

  const root = useMemo(() => {
    const h = d3
      .hierarchy<Datum>(rootData)
      .sum((d) => (d.children?.length ? 0 : d.node ? leafValue(d.node, metric) : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    return h
  }, [rootData, metric])

  const focus = useMemo(() => {
    if (!focusId) return root
    let found: d3.HierarchyNode<Datum> | null = null
    root.each((n) => {
      if (n.data.id === focusId) found = n
    })
    return found ?? root
  }, [root, focusId])

  const maxDepth = useMemo(() => {
    let d = 0
    focus.each((n) => {
      d = Math.max(d, n.depth - focus.depth)
    })
    return d
  }, [focus])

  const w = Math.max(width, 420)
  const columns = Math.max(1, maxDepth)
  const colW = Math.max(90, (w - M.left - M.right) / columns)
  const leaves = focus.leaves().length
  const height = Math.max(180, Math.min(760, leaves * ROW_H)) + M.top + M.bottom
  const ih = height - M.top - M.bottom

  // The partition gives the (invisible) root its own column, so lay out one
  // extra column and shift left by it — otherwise the chart opens on a gap.
  const laid = useMemo(() => {
    const clone = focus.copy()
    d3.partition<Datum>().size([ih, (columns + 1) * colW])(clone)
    return clone
  }, [focus, ih, columns, colW])

  const totalValue = laid.value ?? 0
  const cells = laid.descendants().filter((n) => n.depth > 0)

  /** The top-level item this cell belongs to — colour follows that entity. */
  const topAncestorOf = (n: d3.HierarchyNode<Datum>) => {
    let p = n
    while (p.parent && p.parent.data.id !== '__root__') p = p.parent
    return p.data.id
  }

  if (!cells.length) return null

  return (
    <div ref={ref}>
      {focusId && (
        <div className="row" style={{ marginBottom: 8 }}>
          <button type="button" className="ghost" onClick={() => setFocusId(null)}>
            ← Back to all
          </button>
          <span className="muted">Zoomed to {focus.data.name}</span>
        </div>
      )}

      <div className="chart-wrap">
        <svg
          className="chart"
          viewBox={`0 0 ${w} ${height}`}
          style={{ minWidth: 420 }}
          role="img"
          aria-label="Hierarchy breakdown by share of work"
        >
          <g transform={`translate(${M.left - colW},${M.top})`}>
            {cells.map((n) => {
              const y0 = (n as unknown as { x0: number }).x0
              const y1 = (n as unknown as { x1: number }).x1
              const x0 = (n as unknown as { y0: number }).y0
              const x1 = (n as unknown as { y1: number }).y1
              const cellH = Math.max(0, y1 - y0 - GAP)
              const cellW = Math.max(0, x1 - x0 - GAP)
              if (cellH <= 0.5) return null

              const node = n.data.node!
              const share = totalValue ? ((n.value ?? 0) / totalValue) * 100 : 0
              const label = `${node.key} ${node.summary}`
              // Only draw text that actually fits — never clip, never overflow.
              const fits = cellH >= 13 && cellW >= 58
              const chars = Math.floor((cellW - 12) / 6.2)
              const fill = colorOf(topAncestorOf(n))
              const alpha = 0.25 + 0.75 * (1 / (1 + (n.depth - focus.depth - 1) * 0.55))

              return (
                <g key={n.data.id}>
                  <rect
                    x={x0}
                    y={y0}
                    width={cellW}
                    height={cellH}
                    rx={3}
                    fill={fill}
                    opacity={alpha}
                    tabIndex={0}
                    style={{ cursor: 'pointer' }}
                    onPointerMove={(e) => setHover({ x: e.clientX, y: e.clientY, node, share })}
                    onPointerLeave={() => setHover(null)}
                    onFocus={(e) => {
                      const b = (e.currentTarget as SVGRectElement).getBoundingClientRect()
                      setHover({ x: b.right, y: b.top, node, share })
                    }}
                    onBlur={() => setHover(null)}
                    onClick={() => {
                      if (n.children?.length) setFocusId(n.data.id)
                      else onSelect?.(node.key)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        if (n.children?.length) setFocusId(n.data.id)
                        else onSelect?.(node.key)
                      }
                    }}
                  >
                    <title>{`${label} — ${pct(share, 1)} of ${metricName(metric)}`}</title>
                  </rect>
                  {fits && (
                    <text
                      x={x0 + 7}
                      y={y0 + cellH / 2}
                      dy="0.32em"
                      pointerEvents="none"
                      style={{ fill: inkOn(fill, alpha), fontSize: 11.5 }}
                    >
                      {label.length > chars ? `${label.slice(0, Math.max(1, chars - 1))}…` : label}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>
      </div>

      <Legend items={topLevel.slice(0, 8).map((n) => ({ id: n.id, label: n.key, color: colorOf(n.id) }))} />

      {topLevel.length > 8 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {topLevel.length - 8} further top-level item(s) are drawn in neutral grey — hues are capped at
          eight. Narrow the scope to colour them.
        </p>
      )}

      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          title={`${hover.node.key} · ${hover.node.type}`}
          rows={[
            { name: 'of scope', value: pct(hover.share, 1) },
            { name: 'complete', value: pct(hover.node.rollup.percent) },
            { name: metricName(metric), value: full(hover.node.rollup.total) },
            { name: 'status', value: hover.node.status },
          ]}
        />
      )}
    </div>
  )
}

function metricName(metric: string) {
  return { count: 'issues', points: 'points', timespent: 'hours' }[metric] ?? metric
}
