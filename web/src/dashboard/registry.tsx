import { useReport, useScope } from '../lib/scope'
import type {
  BurnupData,
  Cfd,
  ChordData,
  CycleTimeData,
  GraphData,
  IssueRow,
  Person,
  SankeyData,
  Summary,
  TreeNode,
  WidgetConfig,
} from '../lib/api'
import { Empty, Meter } from '../components/ui'
import { CumulativeFlow } from '../charts/CumulativeFlow'
import { ThroughputBars } from '../charts/ThroughputBars'
import { BreakdownBars, type BreakdownRow } from '../charts/BreakdownBars'
import { SankeyChart } from '../charts/SankeyChart'
import { ChordChart } from '../charts/ChordChart'
import { DotPlot } from '../charts/DotPlot'
import { NetworkGraph } from '../charts/NetworkGraph'
import { ProgressLine } from '../charts/ProgressLine'
import { FlowInOut } from '../charts/FlowInOut'
import { compact, full, metricLabel, pct } from '../lib/format'
import { ROW_H, GAP } from './Grid'

export type FieldDef = {
  key: string
  label: string
  kind: 'select' | 'text'
  choices?: { value: string; label: string }[]
  placeholder?: string
}

export type WidgetDef = {
  type: string
  label: string
  desc: string
  w: number
  h: number
  minW: number
  minH: number
  fields: FieldDef[]
}

const METRIC_FIELD: FieldDef = {
  key: 'metric',
  label: 'Measure',
  kind: 'select',
  choices: [
    { value: '', label: 'Inherit from filter row' },
    { value: 'count', label: 'Issue count' },
    { value: 'points', label: 'Story points' },
    { value: 'timespent', label: 'Time logged' },
  ],
}

const SCOPE_FIELDS: FieldDef[] = [
  { key: 'roots', label: 'Limit to items (keys, comma-separated)', kind: 'text', placeholder: 'e.g. PORT-101' },
  { key: 'projects', label: 'Limit to projects (keys, comma-separated)', kind: 'text', placeholder: 'e.g. PAY,GRW' },
]

const DIMENSION_CHOICES = [
  { value: 'assignee', label: 'Assignee' },
  { value: 'reporter', label: 'Reporter' },
  { value: 'epic', label: 'Epic' },
  { value: 'initiative', label: 'Initiative' },
  { value: 'project', label: 'Project' },
  { value: 'status', label: 'Status' },
  { value: 'category', label: 'Progress' },
  { value: 'type', label: 'Issue type' },
  { value: 'priority', label: 'Priority' },
]

export const WIDGETS: WidgetDef[] = [
  {
    type: 'stat',
    label: 'Stat',
    desc: 'One number — completion, counts, people',
    w: 3, h: 2, minW: 2, minH: 2,
    fields: [
      {
        key: 'kind',
        label: 'Show',
        kind: 'select',
        choices: [
          { value: 'percent', label: '% complete' },
          { value: 'issues', label: 'Issues in scope' },
          { value: 'inprogress', label: 'In progress' },
          { value: 'points', label: 'Story points' },
          { value: 'people', label: 'People assigned' },
          { value: 'unassigned', label: 'Unassigned issues' },
        ],
      },
      METRIC_FIELD,
      ...SCOPE_FIELDS,
    ],
  },
  {
    type: 'cfd',
    label: 'Cumulative flow',
    desc: 'Work per state, day by day',
    w: 6, h: 5, minW: 4, minH: 4,
    fields: [
      {
        key: 'groupBy',
        label: 'Bands',
        kind: 'select',
        choices: [
          { value: 'status', label: 'By status' },
          { value: 'category', label: 'By progress category' },
        ],
      },
      METRIC_FIELD,
      ...SCOPE_FIELDS,
    ],
  },
  {
    type: 'throughput',
    label: 'Throughput',
    desc: 'Resolved per week',
    w: 6, h: 3, minW: 3, minH: 2,
    fields: [
      {
        key: 'field',
        label: 'Count',
        kind: 'select',
        choices: [
          { value: 'count', label: 'Issues' },
          { value: 'points', label: 'Story points' },
        ],
      },
      ...SCOPE_FIELDS,
    ],
  },
  {
    type: 'top-items',
    label: 'Top items',
    desc: 'Largest items, stacked by state',
    w: 6, h: 4, minW: 4, minH: 3,
    fields: [METRIC_FIELD, ...SCOPE_FIELDS],
  },
  {
    type: 'people-load',
    label: 'People load',
    desc: 'Per-person stacked workload',
    w: 6, h: 4, minW: 4, minH: 3,
    fields: [METRIC_FIELD, ...SCOPE_FIELDS],
  },
  {
    type: 'sankey',
    label: 'Sankey',
    desc: 'Flow across two or three dimensions',
    w: 8, h: 5, minW: 5, minH: 4,
    fields: [
      { key: 'from', label: 'From', kind: 'select', choices: DIMENSION_CHOICES },
      {
        key: 'via',
        label: 'Through',
        kind: 'select',
        choices: [{ value: '', label: '— skip —' }, ...DIMENSION_CHOICES],
      },
      { key: 'to', label: 'To', kind: 'select', choices: DIMENSION_CHOICES },
      METRIC_FIELD,
      ...SCOPE_FIELDS,
    ],
  },
  {
    type: 'chord',
    label: 'Chord',
    desc: 'Directed handovers between people or projects',
    w: 5, h: 5, minW: 4, minH: 4,
    fields: [
      {
        key: 'flow',
        label: 'Flow',
        kind: 'select',
        choices: [
          { value: 'handovers', label: 'Between people' },
          { value: 'projects', label: 'Between projects' },
        ],
      },
      ...SCOPE_FIELDS,
    ],
  },
  {
    type: 'cycletime',
    label: 'Cycle time',
    desc: 'Median and p90 days to resolve',
    w: 6, h: 4, minW: 4, minH: 3,
    fields: [
      {
        key: 'groupBy',
        label: 'Group by',
        kind: 'select',
        choices: [
          { value: 'epic', label: 'Epic' },
          { value: 'assignee', label: 'Assignee' },
          { value: 'project', label: 'Project' },
        ],
      },
      ...SCOPE_FIELDS,
    ],
  },
  {
    type: 'graph',
    label: 'Network',
    desc: 'Draggable initiative / epic / idea graph',
    w: 8, h: 5, minW: 5, minH: 4,
    fields: [
      {
        key: 'includeStories',
        label: 'Detail',
        kind: 'select',
        choices: [
          { value: '', label: 'Epics & up' },
          { value: 'true', label: 'Include stories' },
        ],
      },
      ...SCOPE_FIELDS,
    ],
  },
  {
    type: 'burnup',
    label: 'Progress over time',
    desc: '% complete, day by day',
    w: 6, h: 4, minW: 4, minH: 3,
    fields: [METRIC_FIELD, ...SCOPE_FIELDS],
  },
  {
    type: 'flow-io',
    label: 'Added vs completed',
    desc: 'Weekly scope in against work out',
    w: 6, h: 4, minW: 4, minH: 3,
    fields: [
      {
        key: 'style',
        label: 'Style',
        kind: 'select',
        choices: [
          { value: 'bars', label: 'Mirror bars' },
          { value: 'lines', label: 'Lines' },
        ],
      },
      METRIC_FIELD,
      ...SCOPE_FIELDS,
    ],
  },
  {
    type: 'issues',
    label: 'Issue list',
    desc: 'Most recently updated issues',
    w: 6, h: 4, minW: 4, minH: 3,
    fields: SCOPE_FIELDS,
  },
]

export const widgetDef = (type: string) => WIDGETS.find((w) => w.type === type)

export function defaultTitle(widget: WidgetConfig): string {
  const def = widgetDef(widget.type)
  if (widget.type === 'stat') {
    const kind = widget.options.kind || 'percent'
    return (
      def?.fields[0].choices?.find((c) => c.value === kind)?.label ?? def?.label ?? widget.type
    )
  }
  return def?.label ?? widget.type
}

/** Pixel height available to a widget body, from its grid height. */
export function bodyHeight(h: number): number {
  return h * ROW_H + (h - 1) * GAP - 40 /* header */ - 20 /* padding */
}

function widgetExtra(options: Record<string, string>): Record<string, string> {
  const extra: Record<string, string> = {}
  if (options.metric) extra.metric = options.metric
  if (options.projects) extra.projects = options.projects
  if (options.roots) extra.roots = options.roots
  return extra
}

function effectiveMetric(options: Record<string, string>, scopeMetric: string): string {
  return options.metric || scopeMetric
}

/* ---------------------------------------------------------- widget bodies */

export function WidgetBody({ widget }: { widget: WidgetConfig }) {
  switch (widget.type) {
    case 'stat': return <StatBody widget={widget} />
    case 'cfd': return <CfdBody widget={widget} />
    case 'throughput': return <ThroughputBody widget={widget} />
    case 'top-items': return <TopItemsBody widget={widget} />
    case 'people-load': return <PeopleLoadBody widget={widget} />
    case 'sankey': return <SankeyBody widget={widget} />
    case 'chord': return <ChordBody widget={widget} />
    case 'cycletime': return <CycleTimeBody widget={widget} />
    case 'graph': return <GraphBody widget={widget} />
    case 'burnup': return <BurnupBody widget={widget} />
    case 'flow-io': return <FlowIoBody widget={widget} />
    case 'issues': return <IssuesBody widget={widget} />
    default: return <Empty title={`Unknown widget "${widget.type}"`} />
  }
}

function StatBody({ widget }: { widget: WidgetConfig }) {
  const { scope } = useScope()
  const { data } = useReport<Summary>('/reports/summary', widgetExtra(widget.options))
  if (!data) return null
  const metric = effectiveMetric(widget.options, scope.metric)
  const kind = widget.options.kind || 'percent'

  if (kind === 'percent') {
    return (
      <div>
        <div className="value" style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.02em' }}>
          {pct(data.percentComplete)}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {full(data.byCategory.done ?? 0)} of {full(data.total)} {metricLabel(metric)}
        </div>
        <div style={{ marginTop: 8 }}>
          <Meter
            done={data.byCategory.done ?? 0}
            inProgress={data.byCategory.indeterminate ?? 0}
            total={data.total}
            showLabel={false}
          />
        </div>
      </div>
    )
  }

  const value =
    kind === 'issues' ? data.issues
    : kind === 'inprogress' ? data.byCategory.indeterminate ?? 0
    : kind === 'points' ? data.points
    : kind === 'people' ? data.assignees
    : data.unassigned
  const sub =
    kind === 'issues' ? `${data.counts.done ?? 0} done`
    : kind === 'inprogress' ? pct(data.percentInProgress)
    : kind === 'points' ? `${pct(data.estimatedCoverage)} estimated`
    : kind === 'people' ? `${compact(data.unassigned)} unassigned`
    : 'issues without an assignee'

  return (
    <div>
      <div style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.02em' }}>{compact(value)}</div>
      <div className="muted" style={{ fontSize: 12 }}>{sub}</div>
    </div>
  )
}

function CfdBody({ widget }: { widget: WidgetConfig }) {
  const { scope } = useScope()
  const { data } = useReport<Cfd>('/reports/cfd', {
    ...widgetExtra(widget.options),
    groupBy: widget.options.groupBy === 'category' ? 'category' : 'status',
    leavesOnly: 'true',
  })
  if (!data || data.empty || data.series.length < 2) return <Empty title="Not enough history" />
  return (
    <CumulativeFlow
      data={data}
      metric={effectiveMetric(widget.options, scope.metric)}
      height={Math.max(200, bodyHeight(widget.h) - 76)}
    />
  )
}

function ThroughputBody({ widget }: { widget: WidgetConfig }) {
  const { data } = useReport<Summary>('/reports/summary', widgetExtra(widget.options))
  if (!data?.throughput?.length) return <Empty title="Nothing resolved yet" />
  return (
    <ThroughputBars
      data={data.throughput}
      field={widget.options.field === 'points' ? 'points' : 'count'}
      height={Math.max(110, bodyHeight(widget.h) - 36)}
    />
  )
}

function TopItemsBody({ widget }: { widget: WidgetConfig }) {
  const { scope } = useScope()
  const { data } = useReport<{ tree: TreeNode[] }>('/reports/tree', widgetExtra(widget.options))
  const rows: BreakdownRow[] =
    data?.tree.slice(0, Math.max(3, Math.floor((bodyHeight(widget.h) - 46) / 30))).map((n) => ({
      id: n.id,
      name: `${n.key} ${n.summary}`,
      sub: n.type,
      done: n.rollup.done,
      inProgress: n.rollup.inProgress,
      todo: n.rollup.todo,
    })) ?? []
  if (!rows.length) return <Empty title="No parent items in scope" />
  return <BreakdownBars rows={rows} metric={effectiveMetric(widget.options, scope.metric)} />
}

function PeopleLoadBody({ widget }: { widget: WidgetConfig }) {
  const { scope } = useScope()
  const { data } = useReport<{ people: Person[] }>('/reports/people', widgetExtra(widget.options))
  const rows: BreakdownRow[] =
    data?.people.map((p) => ({
      id: p.id,
      name: p.name,
      sub: `${p.issues} issues`,
      done: p.done,
      inProgress: p.inProgress,
      todo: p.todo,
    })) ?? []
  if (!rows.length) return <Empty title="Nobody has work here" />
  return (
    <BreakdownBars
      rows={rows}
      metric={effectiveMetric(widget.options, scope.metric)}
      max={Math.max(3, Math.floor((bodyHeight(widget.h) - 46) / 30))}
    />
  )
}

function SankeyBody({ widget }: { widget: WidgetConfig }) {
  const { scope } = useScope()
  const dims = [widget.options.from || 'assignee', widget.options.via, widget.options.to || 'category']
    .filter(Boolean)
    .filter((d, i, a) => a.indexOf(d) === i)
  const { data } = useReport<SankeyData>('/reports/sankey', {
    ...widgetExtra(widget.options),
    dimensions: dims.join(','),
    maxPerColumn: 8,
  })
  if (!data?.links?.length) return <Empty title="Nothing flows between those columns" />
  return (
    <SankeyChart
      data={data}
      metric={effectiveMetric(widget.options, scope.metric)}
      height={Math.max(240, bodyHeight(widget.h) - 76)}
    />
  )
}

function ChordBody({ widget }: { widget: WidgetConfig }) {
  const flow = widget.options.flow === 'projects' ? 'projects' : 'handovers'
  const { data } = useReport<ChordData>('/reports/chord', { ...widgetExtra(widget.options), flow })
  if (!data?.flows?.length) return <Empty title="No flows in this scope" />
  return (
    <ChordChart
      data={data}
      unitLabel={flow === 'projects' ? 'links' : 'handovers'}
      height={Math.max(300, bodyHeight(widget.h) - 90)}
    />
  )
}

function CycleTimeBody({ widget }: { widget: WidgetConfig }) {
  const { data } = useReport<CycleTimeData>('/reports/cycletime', {
    ...widgetExtra(widget.options),
    groupBy: widget.options.groupBy || 'epic',
  })
  if (!data?.rows?.length) return <Empty title="Not enough resolved issues" />
  return <DotPlot data={data} max={Math.max(3, Math.floor((bodyHeight(widget.h) - 60) / 30))} />
}

function GraphBody({ widget }: { widget: WidgetConfig }) {
  const { data } = useReport<GraphData>('/reports/graph', {
    ...widgetExtra(widget.options),
    includeStories: widget.options.includeStories === 'true' ? 'true' : 'false',
  })
  if (!data?.nodes?.length) return <Empty title="Nothing above story level" />
  return <NetworkGraph data={data} height={Math.max(220, bodyHeight(widget.h) - 64)} />
}

function BurnupBody({ widget }: { widget: WidgetConfig }) {
  const { scope } = useScope()
  const { data } = useReport<BurnupData>('/reports/burnup', widgetExtra(widget.options))
  if (!data || data.empty || data.series.length < 2) return <Empty title="Not enough history" />
  return (
    <ProgressLine
      data={data}
      metric={effectiveMetric(widget.options, scope.metric)}
      height={Math.max(180, bodyHeight(widget.h) - 24)}
    />
  )
}

function FlowIoBody({ widget }: { widget: WidgetConfig }) {
  const { scope } = useScope()
  const { data } = useReport<BurnupData>('/reports/burnup', widgetExtra(widget.options))
  if (!data?.weekly?.length) return <Empty title="Nothing arrived or finished" />
  return (
    <FlowInOut
      data={data}
      metric={effectiveMetric(widget.options, scope.metric)}
      variant={widget.options.style === 'lines' ? 'lines' : 'bars'}
      height={Math.max(160, bodyHeight(widget.h) - 60)}
    />
  )
}

function IssuesBody({ widget }: { widget: WidgetConfig }) {
  const { data } = useReport<{ total: number; issues: IssueRow[] }>('/reports/issues', {
    ...widgetExtra(widget.options),
    limit: 60,
  })
  if (!data?.issues?.length) return <Empty title="No issues in scope" />
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Key</th>
          <th>Summary</th>
          <th>Status</th>
          <th>Assignee</th>
        </tr>
      </thead>
      <tbody>
        {data.issues.map((i) => (
          <tr key={i.key}>
            <td>{i.key}</td>
            <td className="wide" title={i.summary}>{i.summary.length > 46 ? `${i.summary.slice(0, 45)}…` : i.summary}</td>
            <td><span className="pill">{i.status}</span></td>
            <td>{i.assignee ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
