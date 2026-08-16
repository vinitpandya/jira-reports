import { useState } from 'react'
import { ordinalRamp } from '../lib/palette'
import { compact, full, pct } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion } from '../components/ui'

export type BreakdownRow = {
  id: string
  name: string
  sub?: string
  done: number
  inProgress: number
  todo: number
}

const SEGMENTS = ['Done', 'In progress', 'To do'] as const
const ROW_H = 30
const BAR_H = 18 // capped well under 24px so the band keeps its air
const M = { top: 6, right: 74, bottom: 24, left: 190 }

/**
 * One stacked bar per row: done → in progress → to do. Three ordered stages, so
 * the ordinal blue ramp carries them (darkest = done), matching the cumulative
 * flow's reading direction.
 */
export function BreakdownBars({
  rows,
  metric,
  max,
}: {
  rows: BreakdownRow[]
  metric: string
  max?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const themeVersion = useThemeVersion()
  const [hover, setHover] = useState<{ x: number; y: number; row: BreakdownRow } | null>(null)

  const ramp = ordinalRamp(3)
  // ramp is lightest→darkest; done is the darkest step.
  const colors: Record<(typeof SEGMENTS)[number], string> = {
    Done: ramp[2],
    'In progress': ramp[1],
    'To do': ramp[0],
  }
  void themeVersion

  const shown = max ? rows.slice(0, max) : rows
  const w = Math.max(width, 420)
  const iw = Math.max(80, w - M.left - M.right)
  const h = shown.length * ROW_H + M.top + M.bottom
  const domainMax = Math.max(1, ...shown.map((r) => r.done + r.inProgress + r.todo))
  const unit = metric === 'timespent' ? 'h' : ''
  const scale = (v: number) => (v / domainMax) * iw

  if (!shown.length) return null

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg className="chart" viewBox={`0 0 ${w} ${h}`} style={{ minWidth: 420 }} role="img" aria-label="Work breakdown by state">
          <g transform={`translate(${M.left},${M.top})`}>
            {shown.map((r, i) => {
              const total = r.done + r.inProgress + r.todo
              const y = i * ROW_H + (ROW_H - BAR_H) / 2
              const parts = [
                { key: 'Done' as const, v: r.done },
                { key: 'In progress' as const, v: r.inProgress },
                { key: 'To do' as const, v: r.todo },
              ]
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
                  {parts.map((p) => {
                    if (p.v <= 0) return null
                    const width0 = scale(p.v)
                    // 2px surface gap separates touching segments.
                    const rect = (
                      <rect
                        key={p.key}
                        x={x}
                        y={y}
                        width={Math.max(0.5, width0 - 2)}
                        height={BAR_H}
                        rx={3}
                        fill={colors[p.key]}
                      />
                    )
                    x += width0
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
                    <tspan style={{ fill: 'var(--text-muted)' }}>{`  ${pct(total ? (r.done / total) * 100 : 0)}`}</tspan>
                  </text>
                </g>
              )
            })}
            <line className="axis-line" x1={0} x2={iw} y1={shown.length * ROW_H} y2={shown.length * ROW_H} />
          </g>
        </svg>
      </div>

      <Legend items={SEGMENTS.map((s) => ({ id: s, label: s, color: colors[s] }))} />

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
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
