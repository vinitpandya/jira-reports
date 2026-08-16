import { useState } from 'react'
import * as d3 from 'd3'
import { full, longDate, pct, shortDate } from '../lib/format'
import { Tooltip, useMeasure } from '../components/ui'
import type { BurnupData } from '../lib/api'

const M = { top: 14, right: 58, bottom: 28, left: 44 }

/**
 * Percent complete over time — one line from 0 toward 100. A single series, so
 * the card title names it and the end of the line carries the current value.
 */
export function ProgressLine({
  data,
  metric,
  height = 300,
}: {
  data: BurnupData
  metric: string
  height?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)

  const series = data.series
  if (series.length < 2) return null

  const w = Math.max(width, 360)
  const iw = Math.max(80, w - M.left - M.right)
  const ih = height - M.top - M.bottom

  const dates = series.map((p) => new Date(`${p.date}T00:00:00Z`))
  const x = d3.scaleUtc().domain([dates[0], dates[dates.length - 1]]).range([0, iw])
  const y = d3.scaleLinear().domain([0, 100]).range([ih, 0])

  const line = d3
    .line<number>()
    .x((i) => x(dates[i]))
    .y((i) => y(series[i].pct))
  const area = d3
    .area<number>()
    .x((i) => x(dates[i]))
    .y0(ih)
    .y1((i) => y(series[i].pct))
  const idx = series.map((_, i) => i)

  const nearest = (px: number) => {
    const t = x.invert(px)
    let best = 0
    let dist = Infinity
    dates.forEach((d, i) => {
      const dd = Math.abs(+d - +t)
      if (dd < dist) {
        dist = dd
        best = i
      }
    })
    return best
  }

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
    const scale = rect.width / w
    setHover({ i: nearest((e.clientX - rect.left) / scale - M.left), x: e.clientX, y: e.clientY })
  }

  const last = series[series.length - 1]
  const unit = metric === 'timespent' ? 'h' : ''

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg
          className="chart"
          viewBox={`0 0 ${w} ${height}`}
          style={{ minWidth: 360 }}
          role="img"
          aria-label="Percent complete over time"
        >
          <g transform={`translate(${M.left},${M.top})`}>
            {[0, 25, 50, 75, 100].map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line className="grid-line" x1={0} x2={iw} />
                <text className="tick-label" x={-8} dy="0.32em" textAnchor="end">
                  {t}%
                </text>
              </g>
            ))}

            <path d={area(idx) ?? undefined} fill="var(--series-1)" opacity={0.1} />
            <path
              d={line(idx) ?? undefined}
              fill="none"
              stroke="var(--series-1)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* End marker + the one direct label that matters. */}
            <circle
              cx={x(dates[dates.length - 1])}
              cy={y(last.pct)}
              r={4.5}
              fill="var(--series-1)"
              stroke="var(--surface-1)"
              strokeWidth={2}
            />
            <text
              x={iw + 8}
              y={y(last.pct)}
              dy="0.32em"
              style={{ fill: 'var(--text-primary)', fontWeight: 650 }}
            >
              {pct(last.pct)}
            </text>

            <line className="axis-line" x1={0} x2={iw} y1={ih} y2={ih} />
            {x.ticks(Math.max(2, Math.min(6, Math.floor(iw / 130)))).map((t) => (
              <text key={+t} className="tick-label" x={x(t)} y={ih + 18} textAnchor="middle">
                {shortDate(t)}
              </text>
            ))}

            {hover && (
              <g pointerEvents="none">
                <line
                  className="axis-line"
                  x1={x(dates[hover.i])}
                  x2={x(dates[hover.i])}
                  y1={0}
                  y2={ih}
                />
                <circle
                  cx={x(dates[hover.i])}
                  cy={y(series[hover.i].pct)}
                  r={4}
                  fill="var(--series-1)"
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              </g>
            )}

            <rect
              x={0}
              y={0}
              width={iw}
              height={ih}
              fill="transparent"
              tabIndex={0}
              role="application"
              aria-label="Progress readout; arrow keys step through days"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                e.preventDefault()
                const cur = hover?.i ?? series.length - 1
                const next = Math.max(0, Math.min(series.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)))
                const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                const scale = rect.width / w
                setHover({ i: next, x: rect.left + (M.left + x(dates[next])) * scale, y: rect.top + rect.height / 2 })
              }}
              onBlur={() => setHover(null)}
              style={{ cursor: 'crosshair', outlineOffset: -2 }}
            />
          </g>
        </svg>
      </div>

      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          title={longDate(dates[hover.i])}
          rows={[
            { name: 'complete', value: pct(series[hover.i].pct), color: 'var(--series-1)' },
            { name: `done (${unitName(metric)})`, value: `${full(series[hover.i].done)}${unit}` },
            { name: `in scope (${unitName(metric)})`, value: `${full(series[hover.i].scope)}${unit}` },
          ]}
        />
      )}
    </div>
  )
}

function unitName(metric: string) {
  return { count: 'issues', points: 'points', timespent: 'hours' }[metric] ?? metric
}

export function ProgressTable({ data }: { data: BurnupData }) {
  const rows = [...data.series].reverse()
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Date</th>
            <th style={{ textAlign: 'right' }}>In scope</th>
            <th style={{ textAlign: 'right' }}>Done</th>
            <th style={{ textAlign: 'right' }}>Complete</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.date}>
              <td>{p.date}</td>
              <td className="num">{full(p.scope)}</td>
              <td className="num">{full(p.done)}</td>
              <td className="num">{pct(p.pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
