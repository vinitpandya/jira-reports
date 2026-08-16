import { useMemo, useState } from 'react'
import * as d3 from 'd3'
import { makeColorScale } from '../lib/palette'
import { full } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion } from '../components/ui'
import type { ChordData } from '../lib/api'

/**
 * Directed chord — who hands work to whom. Arc = entity, ribbon = flow, and the
 * ribbon's arrowhead lands on the receiver. Ribbons wear the giver's colour.
 * Entities arrive capped at 8 + "Other" from the server, so hues never cycle.
 */
export function ChordChart({
  data,
  unitLabel = 'handovers',
  height,
}: {
  data: ChordData
  unitLabel?: string
  height?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const themeVersion = useThemeVersion()
  const [focus, setFocus] = useState<number | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number; title: string; value: string } | null>(null)

  const names = data.entities.map((e) => e.id)
  const colorOf = useMemo(() => {
    const ranked = data.entities.filter((e) => e.id !== 'Other').map((e) => e.id)
    const scale = makeColorScale(ranked)
    return (id: string) => (id === 'Other' ? 'var(--axis)' : scale(id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.entities, themeVersion])

  const side = Math.max(340, Math.min(width, height ?? 560))
  const outer = side / 2 - 98
  const inner = outer - 13

  const layout = useMemo(() => {
    if (names.length < 2) return null
    const index = new Map(names.map((n, i) => [n, i]))
    const matrix = names.map(() => names.map(() => 0))
    for (const f of data.flows) {
      const si = index.get(f.source)
      const ti = index.get(f.target)
      if (si !== undefined && ti !== undefined) matrix[si][ti] = f.value
    }
    const chords = d3
      .chordDirected()
      .padAngle(12 / inner)
      .sortSubgroups(d3.descending)(matrix)
    return { chords }
  }, [data.flows, names.join('|'), inner])

  if (!layout || !data.flows.length) return null

  const arc = d3.arc<d3.ChordGroup>().innerRadius(inner).outerRadius(outer)
  const ribbon = d3
    .ribbonArrow<d3.Chord, d3.ChordSubgroup>()
    .radius(inner - 2)
    .padAngle(1 / inner) as unknown as (d: d3.Chord) => string

  // d3.chordDirected returns an array of chords carrying a `groups` property.
  const groups = (layout.chords as unknown as { groups: d3.ChordGroup[] }).groups ?? []

  const displayName = (id: string) => data.entities.find((e) => e.id === id)?.name ?? id

  return (
    <div ref={ref}>
      <div className="chart-wrap" style={{ display: 'flex', justifyContent: 'center' }}>
        <svg
          className="chart"
          viewBox={`0 0 ${side} ${side}`}
          style={{ maxWidth: side, minWidth: 340 }}
          role="img"
          aria-label={`Flow between ${names.length} entities`}
        >
          <g transform={`translate(${side / 2},${side / 2})`}>
            {layout.chords.map((c, k) => {
              const active = focus === null || c.source.index === focus || c.target.index === focus
              return (
                <path
                  key={k}
                  d={ribbon(c) ?? undefined}
                  fill={colorOf(names[c.source.index])}
                  fillOpacity={active ? 0.62 : 0.08}
                  stroke="var(--surface-1)"
                  strokeWidth={1}
                  onPointerMove={(e) =>
                    setHover({
                      x: e.clientX,
                      y: e.clientY,
                      title: `${displayName(names[c.source.index])} → ${displayName(names[c.target.index])}`,
                      value: `${full(c.source.value)} ${unitLabel}`,
                    })
                  }
                  onPointerLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              )
            })}

            {groups.map((g) => {
              const angle = (g.startAngle + g.endAngle) / 2
              const deg = (angle * 180) / Math.PI - 90
              const flip = angle > Math.PI
              const total = data.entities[g.index]?.total ?? g.value
              return (
                <g key={g.index}>
                  <path
                    d={arc(g) ?? undefined}
                    fill={colorOf(names[g.index])}
                    tabIndex={0}
                    onPointerEnter={() => setFocus(g.index)}
                    onFocus={() => setFocus(g.index)}
                    onPointerMove={(e) =>
                      setHover({
                        x: e.clientX,
                        y: e.clientY,
                        title: displayName(names[g.index]),
                        value: `${full(total)} ${unitLabel} in + out`,
                      })
                    }
                    onPointerLeave={() => {
                      setFocus(null)
                      setHover(null)
                    }}
                    onBlur={() => setFocus(null)}
                    style={{ cursor: 'pointer' }}
                  >
                    <title>{`${displayName(names[g.index])}: ${full(total)} ${unitLabel}`}</title>
                  </path>
                  {g.endAngle - g.startAngle > 0.06 && (
                    <text
                      transform={`rotate(${deg}) translate(${outer + 7},0)${flip ? ' rotate(180)' : ''}`}
                      textAnchor={flip ? 'end' : 'start'}
                      dy="0.32em"
                      style={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                    >
                      {truncate(displayName(names[g.index]), 14)}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>
      </div>

      <Legend
        items={data.entities.map((e) => ({ id: e.id, label: e.name, color: colorOf(e.id) }))}
      />

      {data.truncated && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Showing the 8 most involved; the rest are grouped as “Other”. The table view lists every flow.
        </p>
      )}

      {hover && (
        <Tooltip x={hover.x} y={hover.y} title={hover.title} rows={[{ name: unitLabel, value: hover.value }]} />
      )}
    </div>
  )
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export function ChordTable({ data, unitLabel = 'handovers' }: { data: ChordData; unitLabel?: string }) {
  const name = (id: string) => data.entities.find((e) => e.id === id)?.name ?? id
  const rows = [...data.flows].sort((a, b) => b.value - a.value)
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>From</th>
            <th>To</th>
            <th style={{ textAlign: 'right' }}>{unitLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f, i) => (
            <tr key={i}>
              <td>{name(f.source)}</td>
              <td>{name(f.target)}</td>
              <td className="num">{full(f.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
