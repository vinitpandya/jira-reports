import { useMemo, useState } from 'react'
import * as d3 from 'd3'
import { makeColorScale } from '../lib/palette'
import { compact, full, longDate, shortDate } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion, type TooltipRow } from '../components/ui'
import type { Cfd } from '../lib/api'

const M = { top: 10, right: 96, bottom: 30, left: 52 }

/** One line per series key over time. Takes the same {series, keys} shape as the CFD. */
export function MultiLine({
  data,
  metric,
  height = 260,
}: {
  data: Cfd
  metric: string
  height?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  useThemeVersion()
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)

  const rows = useMemo(
    () =>
      data.series.map((p) => ({
        date: new Date(`${p.date}T00:00:00Z`),
        values: data.keys.map((k) => Number(p[k]) || 0),
      })),
    [data]
  )

  const color = useMemo(() => makeColorScale(data.keys), [data.keys])
  const visible = data.keys.filter((k) => !hidden.has(k))

  const w = Math.max(width, 360)
  const iw = Math.max(80, w - M.left - M.right)
  const ih = height - M.top - M.bottom

  const geom = useMemo(() => {
    if (rows.length < 2) return null
    const x = d3.scaleUtc().domain(d3.extent(rows, (r) => r.date) as [Date, Date]).range([0, iw])
    const maxY =
      d3.max(rows, (r) => d3.max(visible.map((k) => r.values[data.keys.indexOf(k)] ?? 0))) ?? 0
    const y = d3.scaleLinear().domain([0, maxY || 1]).nice(5).range([ih, 0])
    const line = (key: string) => {
      const idx = data.keys.indexOf(key)
      return (
        d3
          .line<{ date: Date; values: number[] }>()
          .x((r) => x(r.date))
          .y((r) => y(r.values[idx] ?? 0))
          .curve(d3.curveMonotoneX)(rows) ?? undefined
      )
    }
    return { x, y, line }
  }, [rows, visible, data.keys, iw, ih])

  if (!geom) return null
  const { x, y, line } = geom

  const nearestIndex = (px: number) => {
    const t = x.invert(px - M.left)
    let best = 0
    let bestDist = Infinity
    rows.forEach((r, i) => {
      const dist = Math.abs(+r.date - +t)
      if (dist < bestDist) {
        best = i
        bestDist = dist
      }
    })
    return best
  }

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
    const scale = rect.width / w
    setHover({ i: nearestIndex((e.clientX - rect.left) / scale), x: e.clientX, y: e.clientY })
  }

  const unit = metric === 'timespent' ? 'h' : ''
  const last = rows.length - 1

  // Direct labels for the two highest-ending visible lines that fit.
  const endLabels = visible
    .map((k) => ({ key: k, v: rows[last].values[data.keys.indexOf(k)] ?? 0 }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 2)

  const tooltipRows: TooltipRow[] = hover
    ? visible.map((k) => ({
        name: k,
        value: `${full(rows[hover.i].values[data.keys.indexOf(k)] ?? 0)}${unit}`,
        color: color(k),
      }))
    : []

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg
          className="chart"
          viewBox={`0 0 ${w} ${height}`}
          style={{ minWidth: 360 }}
          role="img"
          aria-label={`Lines over time: ${data.keys.join(', ')}`}
        >
          <g transform={`translate(${M.left},${M.top})`}>
            {y.ticks(5).map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line className="grid-line" x1={0} x2={iw} />
                <text className="tick-label" x={-8} dy="0.32em" textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}

            {visible.map((k) => (
              <path key={k} d={line(k)} fill="none" stroke={color(k)} strokeWidth={2} strokeLinejoin="round" />
            ))}

            <line className="axis-line" x1={0} x2={iw} y1={ih} y2={ih} />
            {x.ticks(Math.max(2, Math.min(6, Math.floor(iw / 140)))).map((t) => (
              <text key={+t} className="tick-label" x={x(t)} y={ih + 18} textAnchor="middle">
                {shortDate(t)}
              </text>
            ))}

            {endLabels.map(({ key, v }) => (
              <text
                key={key}
                x={iw + 8}
                y={y(v)}
                dy="0.32em"
                style={{ fill: 'var(--text-secondary)', fontWeight: 600 }}
              >
                {compact(v)}
                {unit}
              </text>
            ))}

            {hover && (
              <g pointerEvents="none">
                <line className="axis-line" x1={x(rows[hover.i].date)} x2={x(rows[hover.i].date)} y1={0} y2={ih} />
                {visible.map((k) => (
                  <circle
                    key={k}
                    cx={x(rows[hover.i].date)}
                    cy={y(rows[hover.i].values[data.keys.indexOf(k)] ?? 0)}
                    r={3}
                    fill={color(k)}
                    stroke="var(--surface-1)"
                    strokeWidth={1.5}
                  />
                ))}
              </g>
            )}

            <rect
              x={0}
              y={0}
              width={iw}
              height={ih}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
              style={{ cursor: 'crosshair' }}
            />
          </g>
        </svg>
      </div>

      <Legend
        items={data.keys.map((k) => ({ id: k, label: k, color: color(k) }))}
        hidden={hidden}
        shape="line"
        onToggle={(id) =>
          setHidden((h) => {
            const next = new Set(h)
            if (next.has(id)) next.delete(id)
            else if (next.size < data.keys.length - 1) next.add(id)
            return next
          })
        }
      />

      {hover && (
        <Tooltip x={hover.x} y={hover.y} title={longDate(rows[hover.i].date)} rows={tooltipRows} />
      )}
    </div>
  )
}
