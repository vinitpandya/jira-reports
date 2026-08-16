import { useMemo, useState } from 'react'
import * as d3 from 'd3'
import { ordinalRamp, MAX_ORDINAL_STEPS } from '../lib/palette'
import { compact, full, longDate, shortDate } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion, type TooltipRow } from '../components/ui'
import type { Cfd } from '../lib/api'

const M = { top: 10, right: 96, bottom: 30, left: 52 }

type Folded = { keys: string[]; rows: { date: Date; values: number[] }[]; foldedFrom: string[] }

/**
 * Statuses arrive in workflow order. The ordinal ramp tops out at five steps in
 * light mode, so any excess folds into one labelled "Other" band placed where the
 * first folded status sat — the fold is stated under the chart and the table view
 * still carries every status.
 */
function fold(data: Cfd, max = MAX_ORDINAL_STEPS): Folded {
  const rows = data.series.map((p) => ({
    date: new Date(`${p.date}T00:00:00Z`),
    raw: p as Record<string, number | string>,
  }))
  const area = new Map(data.keys.map((k) => [k, d3.sum(data.series, (p) => Number(p[k]) || 0)]))

  if (data.keys.length <= max) {
    return {
      keys: data.keys,
      rows: rows.map((r) => ({ date: r.date, values: data.keys.map((k) => Number(r.raw[k]) || 0) })),
      foldedFrom: [],
    }
  }

  const keep = new Set(
    [...data.keys].sort((a, b) => (area.get(b) ?? 0) - (area.get(a) ?? 0)).slice(0, max - 1)
  )
  const foldedFrom = data.keys.filter((k) => !keep.has(k))
  const otherAt = data.keys.findIndex((k) => !keep.has(k))
  const keys: string[] = []
  data.keys.forEach((k, i) => {
    if (i === otherAt) keys.push(`Other (${foldedFrom.length})`)
    if (keep.has(k)) keys.push(k)
  })

  return {
    keys,
    rows: rows.map((r) => ({
      date: r.date,
      values: keys.map((k) =>
        k.startsWith('Other (')
          ? d3.sum(foldedFrom, (f) => Number(r.raw[f]) || 0)
          : Number(r.raw[k]) || 0
      ),
    })),
    foldedFrom,
  }
}

export function CumulativeFlow({
  data,
  metric,
  height = 340,
}: {
  data: Cfd
  metric: string
  height?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const themeVersion = useThemeVersion()
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)

  const folded = useMemo(() => fold(data), [data])

  // Bottom of the stack is the end of the workflow (Done); the ramp runs
  // darkest at the bottom to lightest at the top, so progress reads as descent.
  const stackKeys = useMemo(
    () => [...folded.keys].reverse().filter((k) => !hidden.has(k)),
    [folded.keys, hidden]
  )

  const colorFor = useMemo(() => {
    const ramp = ordinalRamp(folded.keys.length)
    const darkestFirst = [...ramp].reverse()
    const order = [...folded.keys].reverse() // done → todo
    const map = new Map(order.map((k, i) => [k, darkestFirst[Math.min(i, darkestFirst.length - 1)]]))
    return (k: string) => map.get(k) ?? 'var(--accent)'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folded.keys, themeVersion])

  const w = Math.max(width, 360)
  const iw = Math.max(80, w - M.left - M.right)
  const ih = height - M.top - M.bottom

  const geom = useMemo(() => {
    const rows = folded.rows
    if (!rows.length) return null

    const idx = new Map(folded.keys.map((k, i) => [k, i]))
    const series = d3
      .stack<{ date: Date; values: number[] }>()
      .keys(stackKeys)
      .value((row, key) => row.values[idx.get(key) ?? 0] ?? 0)(rows)

    const x = d3.scaleUtc().domain(d3.extent(rows, (r) => r.date) as [Date, Date]).range([0, iw])
    const maxY = d3.max(series, (s) => d3.max(s, (p) => p[1])) ?? 0
    const y = d3.scaleLinear().domain([0, maxY || 1]).nice(5).range([ih, 0])

    const area = d3
      .area<d3.SeriesPoint<{ date: Date; values: number[] }>>()
      .x((p) => x(p.data.date))
      .y0((p) => y(p[0]))
      .y1((p) => y(p[1]))
      .curve(d3.curveLinear)

    return { rows, series, x, y, area, maxY }
  }, [folded, stackKeys, iw, ih])

  if (!geom) return null
  const { rows, series, x, y, area } = geom

  const nearestIndex = (px: number) => {
    const t = x.invert(px - M.left)
    let lo = 0
    let hi = rows.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (rows[mid].date < t) lo = mid + 1
      else hi = mid
    }
    if (lo > 0 && Math.abs(+rows[lo - 1].date - +t) < Math.abs(+rows[lo].date - +t)) return lo - 1
    return lo
  }

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
    const scale = rect.width / w
    setHover({ i: nearestIndex((e.clientX - rect.left) / scale), x: e.clientX, y: e.clientY })
  }

  const onKey = (e: React.KeyboardEvent<SVGRectElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const cur = hover?.i ?? rows.length - 1
    const next = Math.max(0, Math.min(rows.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)))
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
    const scale = rect.width / w
    setHover({ i: next, x: rect.left + (M.left + x(rows[next].date)) * scale, y: rect.top + rect.height / 2 })
  }

  // Selective direct labels: the total, plus the two thickest end bands that fit.
  const last = rows.length - 1
  const endLabels = series
    .map((s) => ({ key: String(s.key), top: s[last][1], bottom: s[last][0] }))
    .filter((s) => y(s.bottom) - y(s.top) >= 16)
    .sort((a, b) => b.top - b.bottom - (a.top - a.bottom))
    .slice(0, 2)

  const total = rows[last].values.reduce((a, b) => a + b, 0)
  const unit = metric === 'timespent' ? 'h' : ''

  const tooltipRows: TooltipRow[] = hover
    ? [...folded.keys]
        .reverse()
        .filter((k) => !hidden.has(k))
        .map((k) => ({
          name: k,
          value: `${full(rows[hover.i].values[folded.keys.indexOf(k)] ?? 0)}${unit}`,
          color: colorFor(k),
        }))
    : []

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg
          className="chart"
          viewBox={`0 0 ${w} ${height}`}
          style={{ minWidth: 360 }}
          role="img"
          aria-label={`Cumulative flow, ${folded.keys.join(', ')}`}
        >
          <g transform={`translate(${M.left},${M.top})`}>
            {y.ticks(5).map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line className="grid-line" x1={0} x2={iw} />
                <text className="tick-label" x={-8} dy="0.32em" textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}

            {series.map((s) => (
              <path
                key={String(s.key)}
                d={area(s) ?? undefined}
                fill={colorFor(String(s.key))}
                /* 2px surface stroke = the gap between touching bands */
                stroke="var(--surface-1)"
                strokeWidth={2}
                strokeLinejoin="round"
              />
            ))}

            <line className="axis-line" x1={0} x2={iw} y1={ih} y2={ih} />
            {x.ticks(Math.max(2, Math.min(6, Math.floor(iw / 140)))).map((t) => (
              <text key={+t} className="tick-label" x={x(t)} y={ih + 18} textAnchor="middle">
                {shortDate(t)}
              </text>
            ))}

            {endLabels.map((s) => (
              <text
                key={s.key}
                x={iw + 8}
                y={y((s.top + s.bottom) / 2)}
                dy="0.32em"
                style={{ fill: 'var(--text-secondary)', fontWeight: 600 }}
              >
                {compact(s.top - s.bottom)}
                {unit}
              </text>
            ))}
            <text x={iw + 8} y={y(total) - 8} style={{ fill: 'var(--text-primary)', fontWeight: 650 }}>
              {compact(total)}
              {unit} total
            </text>

            {hover && (
              <g pointerEvents="none">
                <line className="axis-line" x1={x(rows[hover.i].date)} x2={x(rows[hover.i].date)} y1={0} y2={ih} />
                <circle cx={x(rows[hover.i].date)} cy={ih} r={3} fill="var(--text-secondary)" />
              </g>
            )}

            <rect
              x={0}
              y={0}
              width={iw}
              height={ih}
              fill="transparent"
              tabIndex={0}
              role="application"
              aria-label="Cumulative flow readout; use arrow keys to step through days"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
              onKeyDown={onKey}
              onBlur={() => setHover(null)}
              style={{ cursor: 'crosshair', outlineOffset: -2 }}
            />
          </g>
        </svg>
      </div>

      <Legend
        items={folded.keys.map((k) => ({ id: k, label: k, color: colorFor(k) }))}
        hidden={hidden}
        onToggle={(id) =>
          setHidden((h) => {
            const next = new Set(h)
            if (next.has(id)) next.delete(id)
            else if (next.size < folded.keys.length - 1) next.add(id)
            return next
          })
        }
      />

      {folded.foldedFrom.length > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Folded into “Other”: {folded.foldedFrom.join(', ')}. Switch to Table for the full breakdown,
          or group by progress category.
        </p>
      )}

      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          title={longDate(rows[hover.i].date)}
          rows={tooltipRows}
          total={{
            name: 'total',
            value: `${full(rows[hover.i].values.reduce((a, b) => a + b, 0))}${unit}`,
          }}
        />
      )}
    </div>
  )
}

export function CfdTable({ data }: { data: Cfd }) {
  const rows = [...data.series].reverse()
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Date</th>
            {data.keys.map((k) => (
              <th key={k} style={{ textAlign: 'right' }}>
                {k}
              </th>
            ))}
            <th style={{ textAlign: 'right' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={String(p.date)}>
              <td>{p.date}</td>
              {data.keys.map((k) => (
                <td key={k} className="num">
                  {full(Number(p[k]) || 0)}
                </td>
              ))}
              <td className="num">{full(data.keys.reduce((s, k) => s + (Number(p[k]) || 0), 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
