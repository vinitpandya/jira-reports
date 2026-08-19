import { useMemo, useState } from 'react'
import { compact, full, longDate, shortDate } from '../lib/format'
import { Tooltip, useMeasure, useThemeVersion } from '../components/ui'
import type { Cfd } from '../lib/api'

const M = { top: 6, right: 8, bottom: 26, left: 132 }

/**
 * Weeks across, groups down, colour intensity for the value. Takes the same
 * {series, keys} shape as the time-series endpoint (weekly, not cumulative).
 */
export function Heatmap({
  data,
  metric,
  height = 260,
}: {
  data: Cfd
  metric: string
  height?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  useThemeVersion()
  const [hover, setHover] = useState<{ key: string; i: number; x: number; y: number } | null>(null)

  const weeks = useMemo(
    () => data.series.map((p) => ({ date: new Date(`${p.date}T00:00:00Z`), raw: p })),
    [data]
  )
  const max = useMemo(
    () =>
      Math.max(
        1,
        ...data.series.flatMap((p) => data.keys.map((k) => Number(p[k]) || 0))
      ),
    [data]
  )

  if (!weeks.length || !data.keys.length) return null

  const w = Math.max(width, 360)
  const iw = Math.max(60, w - M.left - M.right)
  const ih = Math.max(40, height - M.top - M.bottom)
  const cellW = iw / weeks.length
  const cellH = Math.min(28, ih / data.keys.length)
  const unit = metric === 'timespent' ? 'h' : ''

  const valueAt = (key: string, i: number) => Number(weeks[i].raw[key]) || 0
  // sqrt keeps small-but-nonzero weeks visible next to spikes.
  const alpha = (v: number) => (v <= 0 ? 0 : 0.15 + 0.85 * Math.sqrt(v / max))

  const labelEvery = Math.max(1, Math.ceil(weeks.length / Math.max(2, Math.floor(iw / 90))))

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg className="chart" viewBox={`0 0 ${w} ${height}`} style={{ minWidth: 360 }} role="img" aria-label="Weekly heatmap per group">
          <g transform={`translate(${M.left},${M.top})`}>
            {data.keys.map((k, row) => (
              <g key={k} transform={`translate(0,${row * cellH})`}>
                <text
                  x={-10}
                  y={cellH / 2}
                  dy="0.32em"
                  textAnchor="end"
                  style={{ fill: 'var(--text-primary)', fontSize: 12 }}
                >
                  {k.length > 18 ? `${k.slice(0, 17)}…` : k}
                </text>
                {weeks.map((wk, i) => {
                  const v = valueAt(k, i)
                  return (
                    <rect
                      key={+wk.date}
                      x={i * cellW + 1}
                      y={1}
                      width={Math.max(0.5, cellW - 2)}
                      height={Math.max(0.5, cellH - 2)}
                      rx={2}
                      fill="var(--accent)"
                      fillOpacity={alpha(v)}
                      stroke={hover && hover.key === k && hover.i === i ? 'var(--text-primary)' : 'none'}
                      onPointerMove={(e) => setHover({ key: k, i, x: e.clientX, y: e.clientY })}
                      onPointerLeave={() => setHover(null)}
                    />
                  )
                })}
              </g>
            ))}
            {weeks.map((wk, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={+wk.date}
                  className="tick-label"
                  x={i * cellW + cellW / 2}
                  y={data.keys.length * cellH + 16}
                  textAnchor="middle"
                >
                  {shortDate(wk.date)}
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
          title={`${hover.key} · week of ${longDate(weeks[hover.i].date)}`}
          rows={[
            {
              name: metric === 'points' ? 'points' : metric === 'timespent' ? 'hours' : 'issues',
              value: `${full(valueAt(hover.key, hover.i))}${unit}`,
            },
          ]}
        />
      )}
      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Darker means more — peak week is {compact(max)}
        {unit}.
      </p>
    </div>
  )
}
