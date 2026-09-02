import { useState } from 'react'
import * as d3 from 'd3'
import { ordinalRamp } from '../lib/palette'
import { full } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion } from '../components/ui'
import { DataGrid, type GridColumn } from '../components/DataGrid'
import { LinkedName } from '../components/IssueLink'
import type { CycleTimeData } from '../lib/api'

const ROW_H = 30
const M = { top: 8, right: 56, bottom: 30, left: 200 }

/**
 * Cycle-time dumbbell: one row per group, a dot at the median and one at the
 * 90th percentile, joined by a line. Both stats are the same measure at
 * different depths, so they ride the ordinal ramp rather than two hues.
 */
export function DotPlot({ data, max }: { data: CycleTimeData; max?: number }) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const themeVersion = useThemeVersion()
  const [hover, setHover] = useState<{ x: number; y: number; row: CycleTimeData['rows'][number] } | null>(null)

  const ramp = ordinalRamp(3)
  const colorP50 = ramp[2]
  const colorP90 = ramp[0]
  void themeVersion

  const rows = max ? data.rows.slice(0, max) : data.rows
  if (!rows.length) return null

  const w = Math.max(width, 420)
  const iw = Math.max(80, w - M.left - M.right)
  const h = rows.length * ROW_H + M.top + M.bottom
  const maxDays = Math.max(1, d3.max(rows, (r) => r.p90) ?? 1)
  const x = d3.scaleLinear().domain([0, maxDays]).nice(5).range([0, iw])
  const slowest = rows[0]

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg
          className="chart"
          viewBox={`0 0 ${w} ${h}`}
          style={{ minWidth: 420 }}
          role="img"
          aria-label="Cycle time in days, median and 90th percentile"
        >
          <g transform={`translate(${M.left},${M.top})`}>
            {x.ticks(5).map((t) => (
              <g key={t} transform={`translate(${x(t)},0)`}>
                <line className="grid-line" y1={0} y2={rows.length * ROW_H} />
                <text className="tick-label" y={rows.length * ROW_H + 18} textAnchor="middle">
                  {t}d
                </text>
              </g>
            ))}

            {rows.map((r, i) => {
              const cy = i * ROW_H + ROW_H / 2
              return (
                <g
                  key={r.name}
                  tabIndex={0}
                  onPointerMove={(e) => setHover({ x: e.clientX, y: e.clientY, row: r })}
                  onPointerLeave={() => setHover(null)}
                  onFocus={(e) => {
                    const b = (e.currentTarget as unknown as SVGGElement).getBoundingClientRect()
                    setHover({ x: b.right, y: b.top, row: r })
                  }}
                  onBlur={() => setHover(null)}
                >
                  <rect x={-M.left} y={i * ROW_H} width={w - M.right} height={ROW_H} fill="transparent" />
                  <text
                    x={-10}
                    y={cy}
                    dy="0.32em"
                    textAnchor="end"
                    style={{ fill: 'var(--text-primary)', fontSize: 12.5 }}
                  >
                    {truncate(r.name, 27)}
                    <tspan style={{ fill: 'var(--text-muted)' }}>{`  ${r.n}`}</tspan>
                  </text>

                  <line
                    x1={x(r.p50)}
                    x2={x(r.p90)}
                    y1={cy}
                    y2={cy}
                    stroke={colorP90}
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                  {/* 2px surface rings keep the dots legible where they overlap. */}
                  <circle cx={x(r.p90)} cy={cy} r={5} fill={colorP90} stroke="var(--surface-1)" strokeWidth={2} />
                  <circle cx={x(r.p50)} cy={cy} r={5.5} fill={colorP50} stroke="var(--surface-1)" strokeWidth={2} />

                  {r === slowest && (
                    <text
                      x={x(r.p90) + 10}
                      y={cy}
                      dy="0.32em"
                      style={{ fill: 'var(--text-secondary)', fontWeight: 600 }}
                    >
                      {Math.round(r.p90)}d
                    </text>
                  )}
                </g>
              )
            })}

            <line className="axis-line" x1={0} x2={iw} y1={rows.length * ROW_H} y2={rows.length * ROW_H} />
          </g>
        </svg>
      </div>

      <Legend
        shape="line"
        items={[
          { id: 'p50', label: 'Median', color: colorP50 },
          { id: 'p90', label: '90th percentile', color: colorP90 },
        ]}
      />

      {max !== undefined && data.rows.length > max && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Showing the {max} slowest of {data.rows.length}; the table view lists all.
        </p>
      )}

      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          title={hover.row.name}
          rows={[
            { name: 'median', value: `${hover.row.p50.toFixed(1)}d`, color: colorP50 },
            { name: '90th percentile', value: `${hover.row.p90.toFixed(1)}d`, color: colorP90 },
            { name: 'fastest · slowest', value: `${hover.row.min.toFixed(0)}d · ${hover.row.max.toFixed(0)}d` },
            { name: 'resolved issues', value: full(hover.row.n) },
          ]}
        />
      )}
    </div>
  )
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export function CycleTimeTable({ data }: { data: CycleTimeData }) {
  type Row = CycleTimeData['rows'][number]
  const days = (n: number) => n.toFixed(1)
  const stat = (key: keyof Row & string, label: string, agg: 'avg' | 'sum' | 'none' = 'avg'): GridColumn<Row> => ({
    key,
    label,
    value: (r) => r[key] as number,
    align: 'right',
    render: (r) => days(r[key] as number),
    aggregate: agg,
    format: days,
  })
  return (
    <DataGrid
      rows={data.rows}
      rowKey={(r) => r.name}
      storageKey="cycletime"
      defaultSort={{ key: 'p50', dir: 'desc' }}
      columns={[
        { key: 'name', label: 'Group', value: (r) => r.name, render: (r) => <LinkedName name={r.name} />, wide: true },
        { key: 'n', label: 'Resolved', value: (r) => r.n, align: 'right' },
        stat('p50', 'Median (d)'),
        stat('p90', 'p90 (d)'),
        stat('mean', 'Mean (d)'),
        { ...stat('min', 'Min', 'none'), render: (r) => r.min.toFixed(0) },
        { ...stat('max', 'Max', 'none'), render: (r) => r.max.toFixed(0) },
      ]}
    />
  )
}
