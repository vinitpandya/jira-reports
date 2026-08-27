import { useMemo, useState } from 'react'
import * as d3 from 'd3'
import { compact, full, longDate, shortDate } from '../lib/format'
import { Tooltip, useMeasure, useThemeVersion } from '../components/ui'
import type { BurnupData } from '../lib/api'

const M = { top: 14, right: 16, bottom: 30, left: 52 }
const DAY = 86_400_000

/**
 * Remaining work, day by day, burning toward zero. A dashed projection extends
 * the recent trend; with a due date, the projection says whether it will land
 * in time (green) or late (red).
 */
export function Burndown({
  data,
  metric,
  height = 280,
  dueDate,
}: {
  data: BurnupData
  metric: string
  height?: number
  /** YYYY-MM-DD, or null when no due date applies. */
  dueDate: string | null
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  useThemeVersion()
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)

  const rows = useMemo(
    () =>
      data.series.map((p) => ({
        date: new Date(`${p.date}T00:00:00Z`),
        remaining: Math.max(0, p.scope - p.done),
      })),
    [data]
  )

  const due = dueDate ? new Date(`${dueDate}T00:00:00Z`) : null

  // Trend over the last four weeks of movement, projected to zero.
  const projection = useMemo(() => {
    if (rows.length < 3) return null
    const tail = rows.slice(-Math.min(28, rows.length))
    const t0 = +tail[0].date
    const xs = tail.map((r) => (+r.date - t0) / DAY)
    const ys = tail.map((r) => r.remaining)
    const n = xs.length
    const mx = d3.mean(xs) ?? 0
    const my = d3.mean(ys) ?? 0
    const denom = d3.sum(xs, (x) => (x - mx) * (x - mx))
    if (!denom) return null
    const slope = d3.sum(xs.map((x, i) => (x - mx) * (ys[i] - my))) / denom // per day
    if (slope >= -1e-6) return null // not burning down
    const last = rows[rows.length - 1]
    const daysToZero = last.remaining / -slope
    return { at: new Date(+last.date + daysToZero * DAY), slope }
  }, [rows])

  if (rows.length < 2) return null

  const last = rows[rows.length - 1]
  // Cap the drawn projection at a year out so a slow trend can't flatten the chart.
  const projDrawn = projection
    ? new Date(Math.min(+projection.at, +last.date + 365 * DAY))
    : null

  const w = Math.max(width, 360)
  const iw = Math.max(80, w - M.left - M.right)
  const ih = height - M.top - M.bottom

  const xEnd = Math.max(+last.date, due ? +due : 0, projDrawn ? +projDrawn : 0)
  const x = d3.scaleUtc().domain([rows[0].date, new Date(xEnd)]).range([0, iw])
  const maxY = d3.max(rows, (r) => r.remaining) ?? 1
  const y = d3.scaleLinear().domain([0, maxY || 1]).nice(5).range([ih, 0])

  const line = d3
    .line<(typeof rows)[number]>()
    .x((r) => x(r.date))
    .y((r) => y(r.remaining))
    .curve(d3.curveMonotoneX)(rows)
  const area = d3
    .area<(typeof rows)[number]>()
    .x((r) => x(r.date))
    .y0(ih)
    .y1((r) => y(r.remaining))
    .curve(d3.curveMonotoneX)(rows)

  const onTrack = projection && due ? +projection.at <= +due + DAY : null
  const projColor =
    onTrack === null ? 'var(--text-muted)' : onTrack ? 'var(--status-good)' : 'var(--status-critical)'

  const unit = metric === 'timespent' ? 'h' : ''

  const nearestIndex = (px: number) => {
    const t = x.invert(px - M.left)
    let best = 0
    let dist = Infinity
    rows.forEach((r, i) => {
      const d = Math.abs(+r.date - +t)
      if (d < dist) {
        best = i
        dist = d
      }
    })
    return best
  }

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg className="chart" viewBox={`0 0 ${w} ${height}`} style={{ minWidth: 360 }} role="img" aria-label="Burn down with projection">
          <g transform={`translate(${M.left},${M.top})`}>
            {y.ticks(5).map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line className="grid-line" x1={0} x2={iw} />
                <text className="tick-label" x={-8} dy="0.32em" textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}

            <path d={area ?? undefined} fill="var(--accent)" opacity={0.12} />
            <path d={line ?? undefined} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />

            {projDrawn && (
              <line
                x1={x(last.date)}
                y1={y(last.remaining)}
                x2={x(projDrawn)}
                y2={projection && +projection.at <= +projDrawn ? y(0) : y(
                  Math.max(0, last.remaining + (projection?.slope ?? 0) * ((+projDrawn - +last.date) / DAY))
                )}
                stroke={projColor}
                strokeWidth={2}
                strokeDasharray="5 4"
              />
            )}

            {due && (
              <g transform={`translate(${x(due)},0)`}>
                <line y1={0} y2={ih} stroke="var(--status-warning)" strokeWidth={1.6} strokeDasharray="3 3" />
                <text y={-3} textAnchor="middle" style={{ fill: 'var(--status-warning)', fontSize: 11, fontWeight: 600 }}>
                  Due {shortDate(due)}
                </text>
              </g>
            )}

            <line className="axis-line" x1={0} x2={iw} y1={ih} y2={ih} />
            {x.ticks(Math.max(2, Math.min(6, Math.floor(iw / 130)))).map((t) => (
              <text key={+t} className="tick-label" x={x(t)} y={ih + 18} textAnchor="middle">
                {shortDate(t)}
              </text>
            ))}

            {hover && (
              <g pointerEvents="none">
                <line className="axis-line" x1={x(rows[hover.i].date)} x2={x(rows[hover.i].date)} y1={0} y2={ih} />
                <circle cx={x(rows[hover.i].date)} cy={y(rows[hover.i].remaining)} r={3.5} fill="var(--accent)" stroke="var(--surface-1)" strokeWidth={1.5} />
              </g>
            )}

            <rect
              x={0}
              y={0}
              width={iw}
              height={ih}
              fill="transparent"
              onPointerMove={(e) => {
                const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                const scale = rect.width / w
                setHover({ i: nearestIndex((e.clientX - rect.left) / scale), x: e.clientX, y: e.clientY })
              }}
              onPointerLeave={() => setHover(null)}
              style={{ cursor: 'crosshair' }}
            />
          </g>
        </svg>
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        {full(last.remaining)}
        {unit} remaining
        {projection
          ? ` · trend projects completion ${longDate(projection.at)}`
          : ' · no downward trend to project yet'}
        {due && projection && (
          <strong style={{ color: projColor }}>
            {onTrack ? ' — on track for the due date' : ' — projected past the due date'}
          </strong>
        )}
        {due && !projection && ` · due ${longDate(due)}`}
      </p>

      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          title={longDate(rows[hover.i].date)}
          rows={[{ name: 'remaining', value: `${full(rows[hover.i].remaining)}${unit}`, color: 'var(--accent)' }]}
        />
      )}
    </div>
  )
}
