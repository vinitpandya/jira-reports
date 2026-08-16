import { useState } from 'react'
import * as d3 from 'd3'
import { compact, full, shortDate } from '../lib/format'
import { Tooltip, useMeasure } from '../components/ui'

const M = { top: 20, right: 12, bottom: 26, left: 40 }
const MAX_BAR = 24

/** Issues resolved per week. One series, so no legend — the card title names it. */
export function ThroughputBars({
  data,
  field = 'count',
  height = 158,
}: {
  data: { week: string; count: number; points: number }[]
  field?: 'count' | 'points'
  height?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const [hover, setHover] = useState<{ x: number; y: number; i: number } | null>(null)

  const w = Math.max(width, 300)
  const iw = Math.max(60, w - M.left - M.right)
  const ih = height - M.top - M.bottom

  if (!data.length) return null

  const x = d3.scaleBand<string>().domain(data.map((d) => d.week)).range([0, iw]).padding(0.32)
  const maxV = d3.max(data, (d) => d[field]) ?? 0
  const y = d3.scaleLinear().domain([0, maxV || 1]).nice(3).range([ih, 0])
  const barW = Math.min(MAX_BAR, x.bandwidth())
  const peak = data.reduce((best, d, i) => (d[field] > data[best][field] ? i : best), 0)
  // Issue counts are whole numbers — never offer the reader "1.5 issues".
  const ticks = field === 'count' ? y.ticks(3).filter(Number.isInteger) : y.ticks(3)

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg className="chart" viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Resolved per week">
          <g transform={`translate(${M.left},${M.top})`}>
            {ticks.map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line className="grid-line" x1={0} x2={iw} />
                <text className="tick-label" x={-8} dy="0.32em" textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}

            {data.map((d, i) => {
              const cx = (x(d.week) ?? 0) + x.bandwidth() / 2
              const bh = Math.max(0, ih - y(d[field]))
              return (
                <g key={d.week}>
                  {/* Rounded data-end, square at the baseline. */}
                  <path
                    d={roundedTop(cx - barW / 2, y(d[field]), barW, bh, 4)}
                    fill="var(--series-1)"
                  />
                  <rect
                    x={cx - Math.max(12, x.bandwidth() / 2)}
                    y={0}
                    width={Math.max(24, x.bandwidth())}
                    height={ih}
                    fill="transparent"
                    onPointerMove={(e) => setHover({ x: e.clientX, y: e.clientY, i })}
                    onPointerLeave={() => setHover(null)}
                  />
                </g>
              )
            })}

            {/* Direct-label the peak only; the axis carries the rest. */}
            {maxV > 0 && (
              <text
                x={(x(data[peak].week) ?? 0) + x.bandwidth() / 2}
                y={y(data[peak][field]) - 6}
                textAnchor="middle"
                style={{ fill: 'var(--text-primary)', fontWeight: 650 }}
              >
                {compact(data[peak][field])}
              </text>
            )}

            <line className="axis-line" x1={0} x2={iw} y1={ih} y2={ih} />
            {data.map((d, i) =>
              i % Math.ceil(data.length / 6) === 0 ? (
                <text
                  key={d.week}
                  className="tick-label"
                  x={(x(d.week) ?? 0) + x.bandwidth() / 2}
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
      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          title={`Week of ${shortDate(data[hover.i].week)}`}
          rows={[
            { name: 'issues resolved', value: full(data[hover.i].count), color: 'var(--series-1)' },
            { name: 'points resolved', value: full(data[hover.i].points) },
          ]}
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
