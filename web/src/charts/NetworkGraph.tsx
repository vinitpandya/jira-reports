import { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import { makeColorScale, ordinalRamp } from '../lib/palette'
import { full, pct } from '../lib/format'
import { Legend, Tooltip, useMeasure, useThemeVersion } from '../components/ui'
import type { GraphData, GraphNode } from '../lib/api'

type SimNode = GraphNode & d3.SimulationNodeDatum & { r: number }
type SimEdge = { source: SimNode; target: SimNode; kind: 'parent' | 'link'; label?: string }

export type GraphColorBy = 'project' | 'type' | 'status'

const STATUS_LABEL: Record<string, string> = {
  new: 'To do',
  indeterminate: 'In progress',
  done: 'Done',
}

/**
 * The delivery network as a draggable force layout. Colour follows the chosen
 * dimension (project, issue type, or status category); node size follows how
 * much leaf work rolls up into it. Dragging pins a node (double-click
 * releases), so a layout can be arranged by hand and it stays where it was put.
 */
export function NetworkGraph({
  data,
  height = 460,
  colorBy = 'project',
}: {
  data: GraphData
  height?: number
  colorBy?: GraphColorBy
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const themeVersion = useThemeVersion()
  const svgRef = useRef<SVGSVGElement>(null)
  const [tick, setTick] = useState(0)
  const [transform, setTransform] = useState<{ k: number; x: number; y: number }>({ k: 1, x: 0, y: 0 })
  const [hover, setHover] = useState<{ x: number; y: number; node: SimNode } | null>(null)

  const w = Math.max(width, 420)

  const keyOf = (n: GraphNode) =>
    colorBy === 'status'
      ? STATUS_LABEL[n.category] ?? 'To do'
      : colorBy === 'type'
        ? n.type
        : n.project

  const legendKeys = useMemo(() => {
    if (colorBy === 'status') return ['To do', 'In progress', 'Done']
    return [...new Set(data.nodes.map((n) => (colorBy === 'type' ? n.type : n.project)))].sort()
  }, [data.nodes, colorBy])

  const colorOf = useMemo(() => {
    if (colorBy === 'status') {
      // The ordered blue ramp, matching how state reads on the other charts.
      const ramp = ordinalRamp(3)
      const map: Record<string, string> = { 'To do': ramp[0], 'In progress': ramp[1], Done: ramp[2] }
      return (k: string) => map[k] ?? 'var(--axis)'
    }
    const scale = makeColorScale(legendKeys.slice(0, 8))
    const known = new Set(legendKeys.slice(0, 8))
    return (k: string) => (known.has(k) ? scale(k) : 'var(--axis)')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legendKeys, colorBy, themeVersion])

  // Build simulation state once per dataset; positions live in these objects.
  const sim = useMemo(() => {
    const rOf = (n: GraphNode) =>
      n.level >= 2 ? 22 : n.level === 1 ? Math.max(10, Math.min(20, 8 + Math.sqrt(n.leaves) * 2)) : n.type === 'Idea' ? 9 : 5.5

    const nodes: SimNode[] = data.nodes.map((n) => ({ ...n, r: rOf(n) }))
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const edges: SimEdge[] = data.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ source: byId.get(e.source)!, target: byId.get(e.target)!, kind: e.kind, label: e.label }))

    const simulation = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3
          .forceLink<SimNode, SimEdge>(edges)
          .id((d) => d.id)
          .distance((l) => (l.kind === 'link' ? 90 : l.source.level >= 2 ? 80 : 46))
          .strength((l) => (l.kind === 'link' ? 0.25 : 0.6))
      )
      .force('charge', d3.forceManyBody().strength(-160))
      .force('collide', d3.forceCollide<SimNode>().radius((d) => d.r + 6))
      .force('x', d3.forceX(0).strength(0.05))
      .force('y', d3.forceY(0).strength(0.06))

    return { nodes, edges, simulation }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  useEffect(() => {
    const { simulation } = sim
    simulation.on('tick', () => setTick((t) => t + 1))
    simulation.alpha(1).restart()
    return () => {
      simulation.stop()
    }
  }, [sim])

  // Wheel/pinch zoom and background pan.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 4])
      .filter((event) => !(event.type === 'mousedown' && (event.target as Element).closest('[data-node]')))
      .on('zoom', (event) => {
        const t = event.transform
        setTransform({ k: t.k, x: t.x, y: t.y })
      })
    d3.select(svg).call(zoom)
    return () => {
      d3.select(svg).on('.zoom', null)
    }
  }, [])

  const dragging = useRef<SimNode | null>(null)

  const toSimCoords = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * w - w / 2
    const py = ((e.clientY - rect.top) / rect.height) * height - height / 2
    return { x: (px - transform.x) / transform.k, y: (py - transform.y) / transform.k }
  }

  const onNodeDown = (node: SimNode) => (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    dragging.current = node
    sim.simulation.alphaTarget(0.25).restart()
    const p = toSimCoords(e)
    node.fx = p.x
    node.fy = p.y
  }
  const onNodeMove = (e: React.PointerEvent) => {
    const node = dragging.current
    if (!node) return
    const p = toSimCoords(e)
    node.fx = p.x
    node.fy = p.y
  }
  const onNodeUp = () => {
    if (!dragging.current) return
    // Stay pinned where dropped; double-click releases.
    dragging.current = null
    sim.simulation.alphaTarget(0)
  }

  void tick

  if (!sim.nodes.length) return null

  return (
    <div ref={ref}>
      <div className="chart-wrap">
        <svg
          ref={svgRef}
          className="chart"
          viewBox={`0 0 ${w} ${height}`}
          style={{ minWidth: 420, touchAction: 'none', cursor: 'grab' }}
          role="application"
          aria-label="Delivery network graph; drag nodes to arrange, scroll to zoom"
        >
          <defs>
            <marker id="net-arrow" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
              <path d="M0,0.6 L7.4,4 L0,7.4 Z" fill="var(--text-muted)" />
            </marker>
          </defs>
          <g transform={`translate(${w / 2 + transform.x},${height / 2 + transform.y}) scale(${transform.k})`}>
            {sim.edges.map((e, i) => (
              <line
                key={i}
                x1={e.source.x}
                y1={e.source.y}
                x2={e.target.x}
                y2={e.target.y}
                stroke={e.kind === 'link' ? 'var(--text-muted)' : 'var(--axis)'}
                strokeWidth={e.kind === 'link' ? 1.4 : 1.2}
                strokeDasharray={e.kind === 'link' ? '4 3' : undefined}
                markerEnd={e.kind === 'link' ? 'url(#net-arrow)' : undefined}
                opacity={0.85}
              />
            ))}

            {sim.nodes.map((n) => (
              <g key={n.id} transform={`translate(${n.x ?? 0},${n.y ?? 0})`}>
                <circle
                  data-node
                  r={n.r}
                  fill={colorOf(keyOf(n))}
                  opacity={colorBy !== 'status' && n.category === 'done' ? 0.55 : 1}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                  onPointerDown={onNodeDown(n)}
                  onPointerMove={onNodeMove}
                  onPointerUp={onNodeUp}
                  onPointerEnter={(e) => setHover({ x: e.clientX, y: e.clientY, node: n })}
                  onPointerLeave={() => setHover(null)}
                  onDoubleClick={() => {
                    n.fx = null
                    n.fy = null
                    sim.simulation.alpha(0.3).restart()
                  }}
                  style={{ cursor: 'grab' }}
                />
                {(n.fx !== undefined && n.fx !== null) && (
                  <circle r={2.4} fill="var(--surface-1)" pointerEvents="none" />
                )}
                {n.level >= 1 || n.type === 'Idea' ? (
                  <text
                    y={n.r + 12}
                    textAnchor="middle"
                    pointerEvents="none"
                    style={{ fill: 'var(--text-secondary)', fontSize: 10.5 }}
                  >
                    {n.key}
                  </text>
                ) : null}
              </g>
            ))}
          </g>
        </svg>
      </div>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Legend items={legendKeys.map((k) => ({ id: k, label: k, color: colorOf(k) }))} />
        <span className="muted" style={{ fontSize: 12, paddingTop: 12, flex: '0 0 auto' }}>
          Drag pins · double-click releases · scroll zooms
        </span>
      </div>

      {data.storiesDropped > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {data.storiesDropped} stories beyond the cap are not drawn — narrow the scope to see them.
        </p>
      )}

      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          title={`${hover.node.key} · ${hover.node.type}`}
          rows={[
            { name: hover.node.summary, value: '' },
            ...(hover.node.leaves > 0
              ? [
                  { name: 'child issues', value: full(hover.node.leaves) },
                  { name: 'complete', value: pct(hover.node.leaves ? (hover.node.done / hover.node.leaves) * 100 : 0) },
                ]
              : [{ name: 'status', value: hover.node.category === 'done' ? 'Done' : hover.node.category === 'indeterminate' ? 'In progress' : 'To do' }]),
          ]}
        />
      )}
    </div>
  )
}

export function GraphTable({ data }: { data: GraphData }) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>From</th>
            <th>Relation</th>
            <th>To</th>
          </tr>
        </thead>
        <tbody>
          {data.edges.map((e, i) => (
            <tr key={i}>
              <td>{byId.get(e.source)?.key ?? e.source}</td>
              <td>{e.kind === 'parent' ? 'contains' : e.label || 'links to'}</td>
              <td>{byId.get(e.target)?.key ?? e.target}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
