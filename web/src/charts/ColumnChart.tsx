import { useState } from 'react'
import { ordinalRamp } from '../lib/palette'
import { compact, full } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion } from '../components/ui'
import type { BreakdownRow } from './BreakdownBars'

const SEGMENTS = ['Done', 'In progress', 'To do'] as const
const M = { top: 22, right: 10, bottom: 44, left: 42 }

/**
 * Vertical stacked columns — the upright sibling of BreakdownBars. Done sits at
 * the base in the darkest ramp step so progress reads bottom-up.
 */
export function ColumnChart({
  rows,
  metric,
  height = 240,
}: {
  rows: BreakdownRow[]
  metric: string
  height?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const themeVersion = useThemeVersion()
  const [hover, setHover] = useState<{ x: number; y: number; row: BreakdownRow } | null>(null)

  const ramp = ordinalRamp(3)
  const colors: Record<(typeof SEGMENTS)[number], string> = {
    Done: ramp[2],
    'In progress': ramp[1],
    'To do': ramp[0],
  }
  void themeVersion

  const w = Math.max(width, 360)
  const iw = Math.max(80, w - M.left - M.right)
  const ih = Math.max(60, height - M.top - M.bottom)

  // Fit what the width allows; the rest is stated below the chart.
  const maxCols = Math.max(3, Math.floor(iw / 52))
  const shown = rows.slice(0, maxCols)
  if (!shown.length) return null

  const domainMax = Math.max(1, ...shown.map((r) => r.done + r.inProgress + r.todo))
  const unit = metric === 'timespent' ? 'h' : ''
  const yOf = (v: number) => ih - (v / domainMax) * ih

  const step = iw / shown.length
  const barW = Math.min(56, step * 0.68)
  const tilted = step < 74

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg className="chart" viewBox={`0 0 ${w} ${height}`} style={{ minWidth: 360 }} role="img" aria-label="Stacked columns by state">
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
              const total = r.done + r.inProgress + r.todo
              const parts = [
                { key: 'Done' as const, v: r.done },
                { key: 'In progress' as const, v: r.inProgress },
                { key: 'To do' as const, v: r.todo },
              ]
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
                  {parts.map((p) => {
                    if (p.v <= 0) return null
                    const y1 = yOf(acc + p.v)
                    const segH = yOf(acc) - y1
                    acc += p.v
                    return (
                      <rect
                        key={p.key}
                        x={cx - barW / 2}
                        y={y1 + 1}
                        width={barW}
                        height={Math.max(0.5, segH - 2)}
                        rx={3}
                        fill={colors[p.key]}
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

      <Legend items={SEGMENTS.map((s) => ({ id: s, label: s, color: colors[s] }))} />

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
          rows={SEGMENTS.map((s) => ({
            name: s,
            color: colors[s],
            value: `${full(s === 'Done' ? hover.row.done : s === 'In progress' ? hover.row.inProgress : hover.row.todo)}${unit}`,
          }))}
          total={{
            name: 'total',
            value: `${full(hover.row.done + hover.row.inProgress + hover.row.todo)}${unit}`,
          }}
        />
      )}
    </div>
  )
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, Math.max(2, n - 1))}…` : s
}
