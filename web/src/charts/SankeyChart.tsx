import { useId, useMemo, useState } from 'react'
import { sankey as d3sankey, sankeyLinkHorizontal, sankeyJustify } from 'd3-sankey'
import { makeColorScale } from '../lib/palette'
import { compact, full } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion } from '../components/ui'
import type { SankeyData } from '../lib/api'

const M = { top: 12, right: 12, bottom: 12, left: 12 }
const NODE_W = 13
const NODE_PAD = 14
const LABEL_PAD = 8

type N = SankeyData['nodes'][number] & {
  x0: number
  x1: number
  y0: number
  y1: number
  index: number
  sourceLinks: L[]
  targetLinks: L[]
}
type L = { source: N; target: N; value: number; width: number; index: number }

/**
 * Flow between ordered dimensions — assignee → epic → progress by default.
 *
 * Every column gets its own categorical scale (top eight members per column;
 * anything beyond falls back to a muted tone), and each link is a gradient
 * from its source colour to its target colour so the flow reads in colour
 * from end to end.
 */
export function SankeyChart({
  data,
  metric,
  height: heightProp,
}: {
  data: SankeyData
  metric: string
  height?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const themeVersion = useThemeVersion()
  const gradId = useId().replace(/:/g, '')
  const [hover, setHover] = useState<
    { x: number; y: number; title: string; rows: { name: string; value: string; color?: string }[] } | null
  >(null)
  const [focus, setFocus] = useState<string | null>(null)

  const unit = metric === 'timespent' ? 'h' : ''

  const firstColumn = useMemo(
    () => data.nodes.filter((n) => n.column === 0).sort((a, b) => b.value - a.value),
    [data.nodes]
  )

  const colorOf = useMemo(() => {
    const scales = new Map<number, (id: string) => string>()
    const columnCount = Math.max(1, ...data.nodes.map((n) => n.column + 1))
    for (let c = 0; c < columnCount; c += 1) {
      const ids = data.nodes
        .filter((n) => n.column === c)
        .sort((a, b) => b.value - a.value)
        .map((n) => n.id)
      scales.set(c, makeColorScale(ids.slice(0, 8)))
    }
    return (n: { id: string; column: number }) => scales.get(n.column)?.(n.id) ?? 'var(--axis)'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nodes, themeVersion])

  const columns = Math.max(1, ...data.nodes.map((n) => n.column + 1))
  const perColumn = Math.max(
    1,
    ...Array.from({ length: columns }, (_, c) => data.nodes.filter((n) => n.column === c).length)
  )
  const height = heightProp ?? Math.max(300, perColumn * 32 + M.top + M.bottom)
  const w = Math.max(width, 420)

  // Reserve gutters so first/last column labels sit outside the plot.
  const gutterL = 130
  const gutterR = 150

  const layout = useMemo(() => {
    if (!data.nodes.length || !data.links.length) return null
    const gen = d3sankey<N, L>()
      .nodeId((d) => d.id)
      .nodeWidth(NODE_W)
      .nodePadding(NODE_PAD)
      .nodeAlign(sankeyJustify)
      .extent([
        [M.left + gutterL, M.top],
        [w - M.right - gutterR, height - M.bottom],
      ])

    try {
      return gen({
        nodes: data.nodes.map((n) => ({ ...n })) as N[],
        links: data.links.map((l) => ({ ...l })) as unknown as L[],
      })
    } catch {
      return null
    }
  }, [data, w, height])

  if (!layout) return null
  const path = sankeyLinkHorizontal<N, L>()

  const dim = (id: string) => focus !== null && focus !== id

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg
          className="chart"
          viewBox={`0 0 ${w} ${height}`}
          style={{ minWidth: 420 }}
          role="img"
          aria-label={`Flow from ${data.dimensions.join(' to ')}`}
        >
          <defs>
            {layout.links.map((l) => (
              // Gradient per link: source colour flowing into target colour.
              <linearGradient
                key={l.index}
                id={`sk-${gradId}-${l.index}`}
                gradientUnits="userSpaceOnUse"
                x1={l.source.x1}
                x2={l.target.x0}
              >
                <stop offset="0%" style={{ stopColor: colorOf(l.source) }} />
                <stop offset="100%" style={{ stopColor: colorOf(l.target) }} />
              </linearGradient>
            ))}
          </defs>
          <g>
            {layout.links.map((l) => {
              const active = focus === null || l.source.id === focus || l.target.id === focus
              return (
                <path
                  key={l.index}
                  d={path(l) ?? undefined}
                  fill="none"
                  stroke={`url(#sk-${gradId}-${l.index})`}
                  strokeOpacity={active ? 0.34 : 0.08}
                  strokeWidth={Math.max(1, l.width)}
                  onPointerMove={(e) =>
                    setHover({
                      x: e.clientX,
                      y: e.clientY,
                      title: `${l.source.name} → ${l.target.name}`,
                      rows: [{ name: metricName(metric), value: `${full(l.value)}${unit}`, color: colorOf(l.source) }],
                    })
                  }
                  onPointerLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              )
            })}
          </g>

          <g>
            {layout.nodes.map((n) => {
              const h = Math.max(1, n.y1 - n.y0)
              const isFirst = n.column === 0
              const isLast = n.column === columns - 1
              const fits = h >= 12
              return (
                <g key={n.id}>
                  <rect
                    x={n.x0}
                    y={n.y0}
                    width={n.x1 - n.x0}
                    height={h}
                    rx={3}
                    fill={colorOf(n)}
                    opacity={dim(n.id) ? 0.35 : 1}
                  />
                  {/* Hit target is wider than the 13px bar. */}
                  <rect
                    x={n.x0 - 6}
                    y={n.y0 - 3}
                    width={n.x1 - n.x0 + 12}
                    height={h + 6}
                    fill="transparent"
                    tabIndex={0}
                    style={{ cursor: 'pointer' }}
                    onPointerEnter={() => setFocus(n.id)}
                    onFocus={() => setFocus(n.id)}
                    onPointerMove={(e) =>
                      setHover({
                        x: e.clientX,
                        y: e.clientY,
                        title: n.name,
                        rows: [{ name: metricName(metric), value: `${full(n.value)}${unit}`, color: colorOf(n) }],
                      })
                    }
                    onPointerLeave={() => {
                      setFocus(null)
                      setHover(null)
                    }}
                    onBlur={() => setFocus(null)}
                  >
                    <title>{`${n.name}: ${full(n.value)}${unit}`}</title>
                  </rect>
                  {fits && (
                    <text
                      x={isLast || !isFirst ? n.x1 + LABEL_PAD : n.x0 - LABEL_PAD}
                      y={(n.y0 + n.y1) / 2}
                      dy="0.32em"
                      textAnchor={isLast || !isFirst ? 'start' : 'end'}
                      style={{ fill: 'var(--text-secondary)' }}
                    >
                      {truncate(n.name, isFirst ? 20 : 22)}
                      <tspan style={{ fill: 'var(--text-muted)' }}>{`  ${compact(n.value)}${unit}`}</tspan>
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>
      </div>

      <Legend items={firstColumn.map((n) => ({ id: n.id, label: n.name, color: colorOf(n) }))} />

      {data.truncated && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Columns show the top 8 by {metricName(metric)}; the remainder is grouped as “Other”. The table
          view lists everything.
        </p>
      )}

      {hover && <Tooltip x={hover.x} y={hover.y} title={hover.title} rows={hover.rows} />}
    </div>
  )
}

function metricName(metric: string) {
  return { count: 'issues', points: 'points', timespent: 'hours' }[metric] ?? metric
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export function SankeyTable({ data, metric }: { data: SankeyData; metric: string }) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const unit = metric === 'timespent' ? 'h' : ''
  const rows = [...data.links].sort((a, b) => b.value - a.value)
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>From</th>
            <th>To</th>
            <th style={{ textAlign: 'right' }}>{metricName(metric)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={i}>
              <td className="wide">{byId.get(l.source)?.name ?? l.source}</td>
              <td className="wide">{byId.get(l.target)?.name ?? l.target}</td>
              <td className="num">
                {full(l.value)}
                {unit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
