import { useState } from 'react'
import * as d3 from 'd3'
import { compact, full, shortDate } from '../lib/format'
import { Legend, Tooltip, useMeasure } from '../components/ui'
import type { BurnupData } from '../lib/api'

const M = { top: 16, right: 12, bottom: 26, left: 44 }
const MAX_BAR = 24

export type FlowVariant = 'bars' | 'lines'

/**
 * Scope in, work out. As bars: a mirror around zero — added up (slot 2),
 * completed down (slot 1) — so a week where more lands than leaves visibly
 * bulges upward. As lines: the same two series on one positive axis, better
 * for reading each trend's shape over a long window.
 */
export function FlowInOut({
  data,
  metric,
  height = 260,
  variant = 'bars',
}: {
  data: BurnupData
  metric: string
  height?: number
  variant?: FlowVariant
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const [hover, setHover] = useState<{ x: number; y: number; i: number } | null>(null)

  const weeks = data.weekly
  if (!weeks.length) return null

  const w = Math.max(width, 360)
  const iw = Math.max(60, w - M.left - M.right)
  const ih = height - M.top - M.bottom

  const x = d3.scaleBand<string>().domain(weeks.map((d) => d.week)).range([0, iw]).padding(0.3)
  const maxAbs = Math.max(1, d3.max(weeks, (d) => Math.max(d.added, d.completed)) ?? 1)
  const y =
    variant === 'lines'
      ? d3.scaleLinear().domain([0, maxAbs]).nice(4).range([ih, 0])
      : d3.scaleLinear().domain([-maxAbs, maxAbs]).nice(4).range([ih, 0])
  const barW = Math.min(MAX_BAR, x.bandwidth())
  const zero = y(0)
  const isCount = metric === 'count'
  const unit = metric === 'timespent' ? 'h' : ''

  const ticks = y.ticks(4).filter((t) => (isCount ? Number.isInteger(t) : true))
  const cxOf = (d: { week: string }) => (x(d.week) ?? 0) + x.bandwidth() / 2

  const linePath = (field: 'added' | 'completed') =>
    d3
      .line<(typeof weeks)[number]>()
      .x((d) => cxOf(d))
      .y((d) => y(d[field]))(weeks) ?? undefined

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg
          className="chart"
          viewBox={`0 0 ${w} ${height}`}
          style={{ minWidth: 360 }}
          role="img"
          aria-label="Added versus completed per week"
        >
          <g transform={`translate(${M.left},${M.top})`}>
            {ticks.map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line className="grid-line" x1={0} x2={iw} />
                <text className="tick-label" x={-8} dy="0.32em" textAnchor="end">
                  {compact(Math.abs(t))}
                </text>
              </g>
            ))}

            {variant === 'bars' &&
              weeks.map((d, i) => {
                const cx = cxOf(d)
                const upH = Math.max(0, zero - y(d.added))
                const downH = Math.max(0, y(-d.completed) - zero)
                return (
                  <g key={d.week}>
                    {d.added > 0 && (
                      <path d={roundedTop(cx - barW / 2, y(d.added), barW, upH, 4)} fill="var(--series-2)" />
                    )}
                    {d.completed > 0 && (
                      <path
                        d={roundedBottom(cx - barW / 2, zero + 1, barW, Math.max(0, downH - 1), 4)}
                        fill="var(--series-1)"
                      />
                    )}
                  </g>
                )
              })}

            {variant === 'lines' && (
              <g>
                <path
                  d={linePath('added')}
                  fill="none"
                  stroke="var(--series-2)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <path
                  d={linePath('completed')}
                  fill="none"
                  stroke="var(--series-1)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {/* End markers with surface rings where the two lines may cross. */}
                <circle
                  cx={cxOf(weeks[weeks.length - 1])}
                  cy={y(weeks[weeks.length - 1].added)}
                  r={4.5}
                  fill="var(--series-2)"
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
                <circle
                  cx={cxOf(weeks[weeks.length - 1])}
                  cy={y(weeks[weeks.length - 1].completed)}
                  r={4.5}
                  fill="var(--series-1)"
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              </g>
            )}

            {/* One hover layer for both variants: the week is the hit target. */}
            {weeks.map((d, i) => (
              <rect
                key={`hit-${d.week}`}
                x={(x(d.week) ?? 0) - 2}
                y={0}
                width={x.bandwidth() + 4}
                height={ih}
                fill="transparent"
                onPointerMove={(e) => setHover({ x: e.clientX, y: e.clientY, i })}
                onPointerLeave={() => setHover(null)}
              />
            ))}

            {hover && variant === 'lines' && (
              <g pointerEvents="none">
                <line className="axis-line" x1={cxOf(weeks[hover.i])} x2={cxOf(weeks[hover.i])} y1={0} y2={ih} />
              </g>
            )}

            <line
              className="axis-line"
              x1={0}
              x2={iw}
              y1={variant === 'lines' ? ih : zero}
              y2={variant === 'lines' ? ih : zero}
            />
            {weeks.map((d, i) =>
              i % Math.ceil(weeks.length / 6) === 0 ? (
                <text
                  key={d.week}
                  className="tick-label"
                  x={cxOf(d)}
                  y={ih + 16}
                  textAnchor="middle"
                >
                  {shortDate(d.week)}
                </text>
              ) : null
            )}
          </g>
        </svg>
      </div>

      <Legend
        shape={variant === 'lines' ? 'line' : 'rect'}
        items={[
          { id: 'added', label: 'Added', color: 'var(--series-2)' },
          { id: 'completed', label: 'Completed', color: 'var(--series-1)' },
        ]}
      />

      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          title={`Week of ${shortDate(weeks[hover.i].week)}`}
          rows={[
            { name: 'added', value: `${full(weeks[hover.i].added)}${unit}`, color: 'var(--series-2)' },
            { name: 'completed', value: `${full(weeks[hover.i].completed)}${unit}`, color: 'var(--series-1)' },
          ]}
          total={{
            name: 'net scope change',
            value: `${weeks[hover.i].added - weeks[hover.i].completed >= 0 ? '+' : ''}${full(
              weeks[hover.i].added - weeks[hover.i].completed
            )}${unit}`,
          }}
        />
      )}
    </div>
  )
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h)
  if (h <= 0) return ''
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`
}

function roundedBottom(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h)
  if (h <= 0) return ''
  return `M${x},${y} L${x + w},${y} L${x + w},${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} L${x + rr},${y + h} Q${x},${y + h} ${x},${y + h - rr} Z`
}

export function FlowInOutTable({ data }: { data: BurnupData }) {
  const rows = [...data.weekly].reverse()
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Week</th>
            <th style={{ textAlign: 'right' }}>Added</th>
            <th style={{ textAlign: 'right' }}>Completed</th>
            <th style={{ textAlign: 'right' }}>Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.week}>
              <td>{d.week}</td>
              <td className="num">{full(d.added)}</td>
              <td className="num">{full(d.completed)}</td>
              <td className="num">
                {d.added - d.completed >= 0 ? '+' : ''}
                {full(d.added - d.completed)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
