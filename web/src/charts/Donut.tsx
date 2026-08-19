import { useMemo, useState } from 'react'
import * as d3 from 'd3'
import { makeColorScale } from '../lib/palette'
import { compact, full } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion, type TooltipRow } from '../components/ui'

export type DonutSlice = { id: string; name: string; value: number }

const MAX_SLICES = 8

/** Share-of-total donut (or full pie). Slices beyond the palette fold into "Other". */
export function Donut({
  slices,
  metric,
  height = 260,
  variant = 'donut',
}: {
  slices: DonutSlice[]
  metric: string
  height?: number
  variant?: 'donut' | 'pie'
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  useThemeVersion()
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)

  const folded = useMemo(() => {
    const sorted = [...slices].sort((a, b) => b.value - a.value)
    if (sorted.length <= MAX_SLICES) return sorted
    const kept = sorted.slice(0, MAX_SLICES - 1)
    const rest = sorted.slice(MAX_SLICES - 1)
    return [
      ...kept,
      {
        id: '__other__',
        name: `Other (${rest.length})`,
        value: d3.sum(rest, (s) => s.value),
      },
    ]
  }, [slices])

  const total = d3.sum(folded, (s) => s.value)
  const color = useMemo(() => makeColorScale(folded.map((s) => s.id)), [folded])

  const w = Math.max(width, 240)
  const r = Math.min(w, height) / 2 - 8
  const arcs = useMemo(() => {
    const pie = d3
      .pie<DonutSlice>()
      .value((s) => s.value)
      .sort(null)
      .padAngle(0.012)
    const arc = d3
      .arc<d3.PieArcDatum<DonutSlice>>()
      .innerRadius(variant === 'pie' ? 0 : r * 0.62)
      .outerRadius(r)
    return pie(folded).map((p) => ({ p, path: arc(p) ?? '' }))
  }, [folded, r, variant])

  if (!total) return null
  const unit = metric === 'timespent' ? 'h' : ''

  const hovered = hover ? folded.find((s) => s.id === hover.id) : undefined
  const tooltipRows: TooltipRow[] = hovered
    ? [
        {
          name: 'share',
          value: `${full(hovered.value)}${unit} · ${Math.round((hovered.value / total) * 100)}%`,
          color: color(hovered.id),
        },
      ]
    : []

  return (
    <div ref={ref}>
      <div className="chart-wrap" style={{ display: 'flex', justifyContent: 'center' }}>
        <svg
          className="chart"
          viewBox={`0 0 ${w} ${height}`}
          style={{ maxWidth: w }}
          role="img"
          aria-label={`Share by ${folded.map((s) => s.name).join(', ')}`}
        >
          <g transform={`translate(${w / 2},${height / 2})`}>
            {arcs.map(({ p, path }) => (
              <path
                key={p.data.id}
                d={path}
                fill={color(p.data.id)}
                stroke="var(--surface-1)"
                strokeWidth={1.5}
                opacity={hover && hover.id !== p.data.id ? 0.45 : 1}
                onPointerMove={(e) => setHover({ id: p.data.id, x: e.clientX, y: e.clientY })}
                onPointerLeave={() => setHover(null)}
              />
            ))}
            {variant === 'donut' && (
              <>
                <text textAnchor="middle" dy="-0.15em" style={{ fill: 'var(--text-primary)', fontWeight: 650, fontSize: 20 }}>
                  {compact(total)}
                  {unit}
                </text>
                <text textAnchor="middle" dy="1.35em" className="tick-label">
                  total
                </text>
              </>
            )}
          </g>
        </svg>
      </div>

      <Legend items={folded.map((s) => ({ id: s.id, label: s.name, color: color(s.id) }))} />

      {hover && hovered && (
        <Tooltip x={hover.x} y={hover.y} title={hovered.name} rows={tooltipRows} />
      )}
    </div>
  )
}
