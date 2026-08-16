import { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import { ordinalRamp } from '../lib/palette'
import { longDate } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion } from '../components/ui'
import type { TimelineGraphData, TimelineNode } from '../lib/api'

type SimNode = TimelineNode & d3.SimulationNodeDatum & { r: number }
type SimEdge = { source: SimNode; target: SimNode; kind: 'parent' | 'link' }

const SWEEP_MS = 14_000 // one full playback

/**
 * The delivery network replayed: scrub or play through time and watch stories
 * appear under their epics and darken as they move to done. Colour is the
 * ordinal ramp — the story here is progress, not project identity.
 */
export function TemporalGraph({ data, height = 480 }: { data: TimelineGraphData; height?: number }) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const themeVersion = useThemeVersion()
  const svgRef = useRef<SVGSVGElement>(null)
  const [tick, setTick] = useState(0)
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 })
  const [hover, setHover] = useState<{ x: number; y: number; node: SimNode } | null>(null)
  const [playing, setPlaying] = useState(false)

  const w = Math.max(width, 420)

  const extent = useMemo(() => {
    const min = d3.min(data.nodes, (n) => n.created) ?? Date.now() - 1
    return [min, Date.now()] as [number, number]
  }, [data.nodes])
  const [t, setT] = useState(extent[1])
  useEffect(() => setT(extent[1]), [extent])

  const ramp = ordinalRamp(3)
  const colorFor = (cat: string) =>
    cat === 'done' ? ramp[2] : cat === 'indeterminate' ? ramp[1] : ramp[0]
  void themeVersion

  const sim = useMemo(() => {
    const rOf = (n: TimelineNode) =>
      n.level >= 2 ? 20 : n.level === 1 ? 13 : n.type === 'Idea' ? 8 : 5

    const nodes: SimNode[] = data.nodes.map((n) => ({ ...n, r: rOf(n) }))
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const edges: SimEdge[] = data.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ source: byId.get(e.source)!, target: byId.get(e.target)!, kind: e.kind }))

    const parentOf = new Map<string, SimNode>()
    for (const e of edges) if (e.kind === 'parent') parentOf.set(e.target.id, e.source)

    const simulation = d3
      .forceSimulation<SimNode>([])
      .force(
        'link',
        d3
          .forceLink<SimNode, SimEdge>([])
          .id((d) => d.id)
          .distance((l) => (l.kind === 'link' ? 85 : l.source.level >= 2 ? 75 : 38))
          .strength((l) => (l.kind === 'link' ? 0.2 : 0.55))
      )
      .force('charge', d3.forceManyBody().strength(-110))
      .force('collide', d3.forceCollide<SimNode>().radius((d) => d.r + 5))
      .force('x', d3.forceX(0).strength(0.06))
      .force('y', d3.forceY(0).strength(0.07))

    return { nodes, edges, simulation, byId, parentOf }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const visible = useMemo(() => sim.nodes.filter((n) => n.created <= t), [sim.nodes, t])
  const visibleIds = useMemo(() => new Set(visible.map((n) => n.id)), [visible])
  const visibleEdges = useMemo(
    () => sim.edges.filter((e) => visibleIds.has(e.source.id) && visibleIds.has(e.target.id)),
    [sim.edges, visibleIds]
  )

  // Feed the running simulation whenever membership changes. Newly appearing
  // nodes spawn beside their parent so they visibly grow out of it.
  useEffect(() => {
    for (const n of visible) {
      if (n.x === undefined) {
        const p = sim.parentOf.get(n.id)
        n.x = (p?.x ?? 0) + (Math.random() - 0.5) * 24
        n.y = (p?.y ?? 0) + (Math.random() - 0.5) * 24
      }
    }
    sim.simulation.nodes(visible)
    ;(sim.simulation.force('link') as d3.ForceLink<SimNode, SimEdge>).links(visibleEdges)
    sim.simulation.alpha(0.35).restart()
  }, [sim, visible.length, visibleEdges.length]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    sim.simulation.on('tick', () => setTick((v) => v + 1))
    return () => {
      sim.simulation.stop()
    }
  }, [sim])

  // Playback.
  useEffect(() => {
    if (!playing) return
    const stepMs = 50
    const span = extent[1] - extent[0]
    const step = span / (SWEEP_MS / stepMs)
    const timer = window.setInterval(() => {
      setT((cur) => {
        const next = cur + step
        if (next >= extent[1]) {
          setPlaying(false)
          return extent[1]
        }
        return next
      })
    }, stepMs)
    return () => window.clearInterval(timer)
  }, [playing, extent])

  // Zoom / pan.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 4])
      .filter((event) => !(event.type === 'mousedown' && (event.target as Element).closest('[data-node]')))
      .on('zoom', (event) => setTransform({ k: event.transform.k, x: event.transform.x, y: event.transform.y }))
    d3.select(svg).call(zoom)
    return () => {
      d3.select(svg).on('.zoom', null)
    }
  }, [])

  const dragging = useRef<SimNode | null>(null)
  const toSim = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * w - w / 2
    const py = ((e.clientY - rect.top) / rect.height) * height - height / 2
    return { x: (px - transform.x) / transform.k, y: (py - transform.y) / transform.k }
  }

  const catAt = (n: SimNode) => {
    let cat = n.initial
    for (const tr of n.transitions) {
      if (tr.at > t) break
      cat = tr.cat
    }
    return cat
  }

  void tick
  if (!sim.nodes.length) return null

  const doneCount = visible.filter((n) => n.level <= 0 && catAt(n) === 'done').length
  const leafCount = visible.filter((n) => n.level <= 0 && n.type !== 'Idea').length

  return (
    <div ref={ref}>
      <div className="row" style={{ marginBottom: 10, gap: 12 }}>
        <button type="button" onClick={() => {
          if (!playing && t >= extent[1]) setT(extent[0])
          setPlaying((p) => !p)
        }}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <input
          type="range"
          min={extent[0]}
          max={extent[1]}
          step={(extent[1] - extent[0]) / 500}
          value={t}
          onChange={(e) => {
            setPlaying(false)
            setT(Number(e.target.value))
          }}
          aria-label="Point in time"
          style={{ flex: '1 1 200px', accentColor: 'var(--accent)' }}
        />
        <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-secondary)', minWidth: 190, textAlign: 'right' }}>
          {longDate(new Date(t))} · {leafCount} stories, {doneCount} done
        </span>
      </div>

      <div className="chart-wrap">
        <svg
          ref={svgRef}
          className="chart"
          viewBox={`0 0 ${w} ${height}`}
          style={{ minWidth: 420, touchAction: 'none', cursor: 'grab' }}
          role="application"
          aria-label="Delivery network over time; use the slider to move through time"
        >
          <g transform={`translate(${w / 2 + transform.x},${height / 2 + transform.y}) scale(${transform.k})`}>
            {visibleEdges.map((e, i) => (
              <line
                key={i}
                x1={e.source.x}
                y1={e.source.y}
                x2={e.target.x}
                y2={e.target.y}
                stroke="var(--axis)"
                strokeWidth={e.kind === 'link' ? 1.4 : 1.1}
                strokeDasharray={e.kind === 'link' ? '4 3' : undefined}
                opacity={0.8}
              />
            ))}
            {visible.map((n) => {
              const cat = catAt(n)
              return (
                <g key={n.id} transform={`translate(${n.x ?? 0},${n.y ?? 0})`}>
                  <circle
                    data-node
                    r={n.r}
                    fill={colorFor(cat)}
                    stroke="var(--surface-1)"
                    strokeWidth={2}
                    onPointerDown={(e) => {
                      e.preventDefault()
                      ;(e.target as Element).setPointerCapture(e.pointerId)
                      dragging.current = n
                      sim.simulation.alphaTarget(0.25).restart()
                      const p = toSim(e)
                      n.fx = p.x
                      n.fy = p.y
                    }}
                    onPointerMove={(e) => {
                      if (dragging.current === n) {
                        const p = toSim(e)
                        n.fx = p.x
                        n.fy = p.y
                      } else {
                        setHover({ x: e.clientX, y: e.clientY, node: n })
                      }
                    }}
                    onPointerUp={() => {
                      dragging.current = null
                      sim.simulation.alphaTarget(0)
                    }}
                    onPointerLeave={() => setHover(null)}
                    onDoubleClick={() => {
                      n.fx = null
                      n.fy = null
                      sim.simulation.alpha(0.3).restart()
                    }}
                    style={{ cursor: 'grab' }}
                  />
                  {n.level >= 1 && (
                    <text
                      y={n.r + 11}
                      textAnchor="middle"
                      pointerEvents="none"
                      style={{ fill: 'var(--text-secondary)', fontSize: 10 }}
                    >
                      {n.key}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>
      </div>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Legend
          items={[
            { id: 'new', label: 'To do', color: ramp[0] },
            { id: 'indeterminate', label: 'In progress', color: ramp[1] },
            { id: 'done', label: 'Done', color: ramp[2] },
          ]}
        />
        <span className="muted" style={{ fontSize: 12, paddingTop: 12, flex: '0 0 auto' }}>
          Drag pins · double-click releases · scroll zooms
        </span>
      </div>

      {data.storiesDropped > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          The {data.storiesDropped} most recent stories beyond the cap are not drawn — narrow the scope
          to replay everything.
        </p>
      )}

      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          title={`${hover.node.key} · ${hover.node.type}`}
          rows={[
            { name: hover.node.summary, value: '' },
            { name: 'state at this time', value: catLabel(catAt(hover.node)), color: colorFor(catAt(hover.node)) },
            { name: 'created', value: longDate(new Date(hover.node.created)) },
          ]}
        />
      )}
    </div>
  )
}

function catLabel(cat: string) {
  return cat === 'done' ? 'Done' : cat === 'indeterminate' ? 'In progress' : 'To do'
}

export function TimelineTable({ data }: { data: TimelineGraphData }) {
  const rows = [...data.nodes].sort((a, b) => a.created - b.created)
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Key</th>
            <th>Type</th>
            <th>Created</th>
            <th>Transitions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.id}>
              <td>{n.key}</td>
              <td>{n.type}</td>
              <td>{longDate(new Date(n.created))}</td>
              <td className="wide">
                {n.transitions.length
                  ? n.transitions.map((tr) => `${longDate(new Date(tr.at))}: ${catLabel(tr.cat)}`).join(' · ')
                  : catLabel(n.initial)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
