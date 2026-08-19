import { useMemo, useState } from 'react'
import * as d3 from 'd3'
import { inkOn, makeColorScale } from '../lib/palette'
import { compact, full } from '../lib/format'
import { Tooltip, useMeasure, useThemeVersion } from '../components/ui'
import type { DonutSlice } from './Donut'

/** Tiles sized by value — reads best when a few groups dominate. */
export function Treemap({
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

  const tiles = useMemo(() => {
    const root = d3
      .hierarchy<{ children: DonutSlice[] } | DonutSlice>({ children: slices })
      .sum((d) => ('value' in d ? d.value : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    d3.treemap<{ children: DonutSlice[] } | DonutSlice>().size([w, height]).paddingInner(3).round(true)(root)
    return root.leaves() as (d3.HierarchyRectangularNode<DonutSlice> & { data: DonutSlice })[]
  }, [slices, w, height])

  if (!total) return null
  const unit = metric === 'timespent' ? 'h' : ''
  const hovered = hover ? slices.find((s) => s.id === hover.id) : undefined

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg className="chart" viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Treemap by value">
          {tiles.map((t) => {
            const tw = t.x1 - t.x0
            const th = t.y1 - t.y0
            const fill = color(t.data.id)
            const ink = inkOn(fill)
            const inkSoft = inkOn(fill, 0.75)
            return (
              <g
                key={t.data.id}
                transform={`translate(${t.x0},${t.y0})`}
                onPointerMove={(e) => setHover({ id: t.data.id, x: e.clientX, y: e.clientY })}
                onPointerLeave={() => setHover(null)}
              >
                <rect
                  width={tw}
                  height={th}
                  rx={4}
                  fill={fill}
                  opacity={hover && hover.id !== t.data.id ? 0.55 : 1}
                />
                {tw > 64 && th > 34 && (
                  <>
                    <text x={8} y={17} style={{ fill: ink, fontSize: 12, fontWeight: 600 }}>
                      {truncate(t.data.name, Math.floor(tw / 7))}
                    </text>
                    <text x={8} y={32} style={{ fill: inkSoft, fontSize: 11 }}>
                      {compact(t.data.value)}
                      {unit} · {Math.round((t.data.value / total) * 100)}%
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
