import { useMemo, useState } from 'react'
import { makeColorScale } from '../lib/palette'
import { compact, full } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion } from '../components/ui'
import type { StackedRow } from './StackedBars'

const M = { top: 22, right: 10, bottom: 44, left: 42 }

/** Vertical stacked columns with arbitrary segment keys from the series palette. */
export function StackedColumns({
  rows,
  keys,
  metric,
  height = 240,
}: {
  rows: StackedRow[]
  keys: string[]
  metric: string
  height?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  useThemeVersion()
  const [hover, setHover] = useState<{ x: number; y: number; row: StackedRow } | null>(null)

  const color = useMemo(() => makeColorScale(keys), [keys])
  const totalOf = (r: StackedRow) => keys.reduce((s, k) => s + (r.values[k] || 0), 0)

  const w = Math.max(width, 360)
  const iw = Math.max(80, w - M.left - M.right)
  const ih = Math.max(60, height - M.top - M.bottom)

  const maxCols = Math.max(3, Math.floor(iw / 52))
  const shown = rows.slice(0, maxCols)
  if (!shown.length) return null

  const domainMax = Math.max(1, ...shown.map(totalOf))
  const unit = metric === 'timespent' ? 'h' : ''
  const yOf = (v: number) => ih - (v / domainMax) * ih

  const step = iw / shown.length
  const barW = Math.min(56, step * 0.68)
  const tilted = step < 74

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg className="chart" viewBox={`0 0 ${w} ${height}`} style={{ minWidth: 360 }} role="img" aria-label="Stacked columns">
          <g transform={`translate(${M.left},${M.top})`}>
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f} transform={`translate(0,${yOf(domainMax * f)})`}>
                <line className="grid-line" x1={0} x2={iw} />
                <text className="tick-label" x={-8} dy="0.32em" textAnchor="end">
                  {compact(domainMax * f)}
                </text>
              </g>
            ))}

            {shown.map((r, i) => {
              const cx = i * step + step / 2
              const total = totalOf(r)
              let acc = 0
              return (
                <g
                  key={r.id}
                  onPointerMove={(e) => setHover({ x: e.clientX, y: e.clientY, row: r })}
                  onPointerLeave={() => setHover(null)}
                  tabIndex={0}
                  onFocus={(e) => {
                    const b = (e.currentTarget as unknown as SVGGElement).getBoundingClientRect()
                    setHover({ x: b.right, y: b.top, row: r })
                  }}
                  onBlur={() => setHover(null)}
                  style={{ cursor: 'default' }}
                >
                  <rect x={i * step} y={0} width={step} height={ih + M.bottom} fill="transparent" />
                  {keys.map((k) => {
                    const v = r.values[k] || 0
                    if (v <= 0) return null
                    const y1 = yOf(acc + v)
                    const segH = yOf(acc) - y1
                    acc += v
                    return (
                      <rect
                        key={k}
                        x={cx - barW / 2}
                        y={y1 + 1}
                        width={barW}
                        height={Math.max(0.5, segH - 2)}
                        rx={3}
                        fill={color(k)}
                      />
                    )
                  })}
                  <text
                    x={cx}
                    y={yOf(total) - 6}
                    textAnchor="middle"
                    style={{ fill: 'var(--text-secondary)', fontSize: 11.5 }}
                  >
                    {compact(total)}
                    {unit}
                  </text>
                  {tilted ? (
                    <text
                      transform={`translate(${cx},${ih + 12}) rotate(-32)`}
                      textAnchor="end"
                      className="tick-label"
                    >
                      {truncate(r.name, 12)}
                    </text>
                  ) : (
                    <text x={cx} y={ih + 16} textAnchor="middle" className="tick-label">
                      {truncate(r.name, Math.floor(step / 7))}
                    </text>
                  )}
                </g>
              )
            })}
            <line className="axis-line" x1={0} x2={iw} y1={ih} y2={ih} />
          </g>
        </svg>
      </div>

      <Legend items={keys.map((k) => ({ id: k, label: k, color: color(k) }))} />

      {rows.length > shown.length && (
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Showing the top {shown.length} of {rows.length} groups — widen the widget for more.
        </p>
      )}

      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          title={hover.row.sub ? `${hover.row.name} · ${hover.row.sub}` : hover.row.name}
          rows={keys
            .filter((k) => (hover.row.values[k] || 0) > 0)
            .map((k) => ({
              name: k,
              color: color(k),
              value: `${full(hover.row.values[k] || 0)}${unit}`,
            }))}
          total={{ name: 'total', value: `${full(totalOf(hover.row))}${unit}` }}
        />
      )}
    </div>
  )
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, Math.max(2, n - 1))}…` : s
}
