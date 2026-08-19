import { useMemo, useState } from 'react'
import * as d3 from 'd3'
import { inkOn, makeColorScale } from '../lib/palette'
import { compact, full } from '../lib/format'
import { Tooltip, useMeasure, useThemeVersion } from '../components/ui'
import type { DonutSlice } from './Donut'

/** Circle-packed groups sized by value — a softer read than the treemap. */
export function Bubbles({
  slices,
  metric,
  height = 260,
}: {
  slices: DonutSlice[]
  metric: string
  height?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  useThemeVersion()
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)

  const w = Math.max(width, 320)
  const total = d3.sum(slices, (s) => s.value)
  const color = useMemo(() => makeColorScale(slices.map((s) => s.id)), [slices])

  const circles = useMemo(() => {
    const root = d3
      .hierarchy<{ children: DonutSlice[] } | DonutSlice>({ children: slices })
      .sum((d) => ('value' in d ? d.value : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    d3.pack<{ children: DonutSlice[] } | DonutSlice>().size([w, height]).padding(5)(root)
    return root.leaves() as (d3.HierarchyCircularNode<DonutSlice> & { data: DonutSlice })[]
  }, [slices, w, height])

  if (!total) return null
  const unit = metric === 'timespent' ? 'h' : ''
  const hovered = hover ? slices.find((s) => s.id === hover.id) : undefined

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg className="chart" viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Bubbles by value">
          {circles.map((c) => {
            const fill = color(c.data.id)
            const ink = inkOn(fill)
            return (
              <g
                key={c.data.id}
                transform={`translate(${c.x},${c.y})`}
                onPointerMove={(e) => setHover({ id: c.data.id, x: e.clientX, y: e.clientY })}
                onPointerLeave={() => setHover(null)}
              >
                <circle
                  r={c.r}
                  fill={fill}
                  stroke="var(--surface-1)"
                  strokeWidth={1.5}
                  opacity={hover && hover.id !== c.data.id ? 0.5 : 1}
                />
                {c.r > 30 && (
                  <>
                    <text textAnchor="middle" dy="-0.2em" style={{ fill: ink, fontSize: 12, fontWeight: 600 }}>
                      {truncate(c.data.name, Math.floor(c.r / 3.6))}
                    </text>
                    <text textAnchor="middle" dy="1.1em" style={{ fill: inkOn(fill, 0.75), fontSize: 11 }}>
                      {compact(c.data.value)}
                      {unit}
                    </text>
                  </>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {hover && hovered && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          title={hovered.name}
          rows={[
            {
              name: 'share',
              value: `${full(hovered.value)}${unit} · ${Math.round((hovered.value / total) * 100)}%`,
              color: color(hovered.id),
            },
          ]}
        />
      )}
    </div>
  )
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, Math.max(2, n - 1))}…` : s
}
