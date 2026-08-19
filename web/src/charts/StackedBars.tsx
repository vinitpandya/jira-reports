import { useMemo, useState } from 'react'
import { makeColorScale } from '../lib/palette'
import { compact, full } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion } from '../components/ui'

export type StackedRow = { id: string; name: string; sub?: string; values: Record<string, number> }

const ROW_H = 30
const BAR_H = 18
const M = { top: 6, right: 74, bottom: 24, left: 190 }

/**
 * Horizontal stacked bars with arbitrary segment keys — the categorical
 * sibling of BreakdownBars, colored from the series palette.
 */
export function StackedBars({
  rows,
  keys,
  metric,
  max,
}: {
  rows: StackedRow[]
  keys: string[]
  metric: string
  max?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  useThemeVersion()
  const [hover, setHover] = useState<{ x: number; y: number; row: StackedRow } | null>(null)

  const color = useMemo(() => makeColorScale(keys), [keys])
  const totalOf = (r: StackedRow) => keys.reduce((s, k) => s + (r.values[k] || 0), 0)

  const shown = max ? rows.slice(0, max) : rows
  const w = Math.max(width, 420)
  const iw = Math.max(80, w - M.left - M.right)
  const h = shown.length * ROW_H + M.top + M.bottom
  const domainMax = Math.max(1, ...shown.map(totalOf))
  const unit = metric === 'timespent' ? 'h' : ''
  const scale = (v: number) => (v / domainMax) * iw

  if (!shown.length) return null

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg className="chart" viewBox={`0 0 ${w} ${h}`} style={{ minWidth: 420 }} role="img" aria-label="Stacked bars">
          <g transform={`translate(${M.left},${M.top})`}>
            {shown.map((r, i) => {
              const total = totalOf(r)
              const y = i * ROW_H + (ROW_H - BAR_H) / 2
              let x = 0
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
                  <rect x={-M.left} y={i * ROW_H} width={w - M.right} height={ROW_H} fill="transparent" />
                  <text
                    x={-10}
                    y={i * ROW_H + ROW_H / 2}
                    dy="0.32em"
                    textAnchor="end"
                    style={{ fill: 'var(--text-primary)', fontSize: 12.5 }}
                  >
                    {truncate(r.name, 26)}
                  </text>
                  {keys.map((k) => {
                    const v = r.values[k] || 0
                    if (v <= 0) return null
                    const segW = scale(v)
                    const rect = (
                      <rect
                        key={k}
                        x={x}
                        y={y}
                        width={Math.max(0.5, segW - 2)}
                        height={BAR_H}
                        rx={3}
                        fill={color(k)}
                      />
                    )
                    x += segW
                    return rect
                  })}
                  <text
                    x={scale(total) + 8}
                    y={i * ROW_H + ROW_H / 2}
                    dy="0.32em"
                    style={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                  >
                    {compact(total)}
                    {unit}
                  </text>
                </g>
              )
            })}
            <line className="axis-line" x1={0} x2={iw} y1={shown.length * ROW_H} y2={shown.length * ROW_H} />
          </g>
        </svg>
      </div>

      <Legend items={keys.map((k) => ({ id: k, label: k, color: color(k) }))} />

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
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
