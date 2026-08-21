import { rangeStart, useReport, useScope, type RangePreset } from '../lib/scope'
import type {
  BreakdownData,
  BurnupData,
  Cfd,
  CrosstabData,
  ChordData,
  CycleTimeData,
  GraphData,
  IssueRow,
  Person,
  SankeyData,
  Summary,
  TimelineGraphData,
  TreeNode,
  WidgetConfig,
} from '../lib/api'
import { Empty, Meter, TableToggle } from '../components/ui'
import { CumulativeFlow, CfdTable } from '../charts/CumulativeFlow'
import { ThroughputBars } from '../charts/ThroughputBars'
import { BreakdownBars, type BreakdownRow } from '../charts/BreakdownBars'
import { SankeyChart, SankeyTable } from '../charts/SankeyChart'
import { Donut } from '../charts/Donut'
import { MultiLine } from '../charts/MultiLine'
import { ColumnChart } from '../charts/ColumnChart'
import { StackedBars, type StackedRow } from '../charts/StackedBars'
import { StackedColumns } from '../charts/StackedColumns'
import { Treemap } from '../charts/Treemap'
import { Bubbles } from '../charts/Bubbles'
import { Heatmap } from '../charts/Heatmap'
import { ChordChart, ChordTable } from '../charts/ChordChart'
import { DotPlot, CycleTimeTable } from '../charts/DotPlot'
import { NetworkGraph, GraphTable } from '../charts/NetworkGraph'
import { ProgressLine, ProgressTable } from '../charts/ProgressLine'
import { FlowInOut, FlowInOutTable } from '../charts/FlowInOut'
import { Icicle } from '../charts/Icicle'
import { TemporalGraph, TimelineTable } from '../charts/TemporalGraph'
import { compact, full, metricLabel, pct } from '../lib/format'
import { ROW_H, GAP } from './Grid'

export type FieldDef = {
  key: string
  label: string
  kind: 'select' | 'text'
  choices?: { value: string; label: string }[]
  placeholder?: string
  /** Hide the field unless the current options warrant it (e.g. per chart type). */
  showIf?: (options: Record<string, string>) => boolean
  /** Also surface the field on the widget header as an inline quick control. */
  quick?: boolean
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
  /** Kept for saved layouts but left out of the add-widget picker. */
  hidden?: boolean
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
  { key: 'types', label: 'Limit to issue types (comma-separated)', kind: 'text', placeholder: 'e.g. Story,Bug' },
]

const WINDOW_FIELD: FieldDef = {
  key: 'window',
  label: 'Time window',
  kind: 'select',
  choices: [
    { value: '', label: 'Inherit from filter row' },
    { value: '30d', label: 'Last 30 days' },
    { value: '90d', label: 'Last 90 days' },
    { value: '180d', label: 'Last 180 days' },
    { value: '365d', label: 'Last year' },
    { value: 'all', label: 'All time' },
  ],
}

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

/** The build-your-own chart forms shown first in the add-widget picker. */
export const CHART_FORMS: { chartType: string; label: string; desc: string }[] = [
  { chartType: 'bar', label: 'Bars', desc: 'Horizontal bars, stacked by state' },
  { chartType: 'column', label: 'Columns', desc: 'Vertical columns, stacked by state' },
  { chartType: 'donut', label: 'Donut', desc: 'Share of the total per group' },
  { chartType: 'pie', label: 'Pie', desc: 'Classic slice-of-the-whole view' },
  { chartType: 'treemap', label: 'Treemap', desc: 'Tiles sized by value' },
  { chartType: 'bubbles', label: 'Bubbles', desc: 'Packed circles sized by value' },
  { chartType: 'area', label: 'Stacked area', desc: 'Groups over time, stacked' },
  { chartType: 'line', label: 'Lines', desc: 'One line per group over time' },
  { chartType: 'heatmap', label: 'Heatmap', desc: 'Weekly intensity per group' },
  { chartType: 'table', label: 'Table', desc: 'Exact numbers per group' },
]

/** Forms fed by the weekly time-series endpoint (the rest use the grouped rollup). */
const isTimeChart = (o: Record<string, string>) =>
  o.chartType === 'area' || o.chartType === 'line' || o.chartType === 'heatmap'
/** The heatmap is always per-week; only area/line offer a running total. */
const hasAccumulation = (o: Record<string, string>) =>
  o.chartType === 'area' || o.chartType === 'line'
/** Bars and columns can stack by a second dimension instead of work state. */
const canStack = (o: Record<string, string>) => o.chartType === 'bar' || o.chartType === 'column'

export const WIDGETS: WidgetDef[] = [
  {
    type: 'chart',
    label: 'Chart',
    desc: 'Pick a form, a dimension and a measure',
    w: 6, h: 4, minW: 3, minH: 3,
    hidden: true, // reached via CHART_FORMS cards, each preselecting a form
    fields: [
      {
        key: 'chartType',
        label: 'Chart type',
        kind: 'select',
        choices: CHART_FORMS.map((f) => ({ value: f.chartType, label: f.label })),
        quick: true,
      },
      { key: 'groupBy', label: 'Break down by (axis)', kind: 'select', choices: DIMENSION_CHOICES, quick: true },
      {
        key: 'stackBy',
        label: 'Stack by',
        kind: 'select',
        choices: [
          { value: '', label: 'Work state (to do / in progress / done)' },
          ...DIMENSION_CHOICES,
        ],
        showIf: canStack,
      },
      {
        key: 'mode',
        label: 'Date each item by',
        kind: 'select',
        choices: [
          { value: 'completed', label: 'When it was completed' },
          { value: 'created', label: 'When it was created' },
        ],
        showIf: isTimeChart,
      },
      {
        key: 'accumulate',
        label: 'Accumulation',
        kind: 'select',
        choices: [
          { value: 'cumulative', label: 'Running total' },
          { value: 'weekly', label: 'Per week' },
        ],
        showIf: hasAccumulation,
      },
      METRIC_FIELD,
      { ...WINDOW_FIELD, showIf: isTimeChart },
      ...SCOPE_FIELDS,
    ],
  },
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
          { value: 'status', label: 'Status' },
          { value: 'category', label: 'Progress' },
        ],
        quick: true,
      },
      {
        key: 'leavesOnly',
        label: 'Which issues',
        kind: 'select',
        choices: [
          { value: 'true', label: 'Leaf issues' },
          { value: 'false', label: 'Everything' },
        ],
        quick: true,
      },
      METRIC_FIELD,
      WINDOW_FIELD,
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
          { value: 'points', label: 'Points' },
        ],
        quick: true,
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
    type: 'breakdown',
    label: 'Breakdown',
    desc: 'Any dimension, stacked by state',
    w: 6, h: 4, minW: 4, minH: 3,
    hidden: true, // superseded by the "chart" builder; kept for saved layouts
    fields: [
      { key: 'groupBy', label: 'Break down by', kind: 'select', choices: DIMENSION_CHOICES },
      METRIC_FIELD,
      ...SCOPE_FIELDS,
    ],
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
          { value: 'handovers', label: 'People' },
          { value: 'projects', label: 'Projects' },
        ],
        quick: true,
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
        quick: true,
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
        key: 'colorBy',
        label: 'Colour by',
        kind: 'select',
        choices: [
          { value: 'project', label: 'Project' },
          { value: 'type', label: 'Type' },
          { value: 'status', label: 'Status' },
        ],
        quick: true,
      },
      {
        key: 'includeStories',
        label: 'Detail',
        kind: 'select',
        choices: [
          { value: '', label: 'Epics & up' },
          { value: 'true', label: 'Stories' },
        ],
        quick: true,
      },
      ...SCOPE_FIELDS,
    ],
  },
  {
    type: 'burnup',
    label: 'Progress over time',
    desc: '% complete, day by day',
    w: 6, h: 4, minW: 4, minH: 3,
    fields: [METRIC_FIELD, WINDOW_FIELD, ...SCOPE_FIELDS],
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
          { value: 'bars', label: 'Bars' },
          { value: 'lines', label: 'Lines' },
          { value: 'cumulative', label: 'Cumulative' },
        ],
        quick: true,
      },
      METRIC_FIELD,
      WINDOW_FIELD,
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
  {
    type: 'icicle',
    label: 'Hierarchy icicle',
    desc: 'Initiatives to stories, sized by share of work',
    w: 6, h: 4, minW: 4, minH: 3,
    fields: [METRIC_FIELD, ...SCOPE_FIELDS],
  },
  {
    type: 'timeline-graph',
    label: 'Evolution',
    desc: 'Play the work graph through time',
    w: 12, h: 6, minW: 6, minH: 4,
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
  if (widget.type === 'breakdown' || widget.type === 'chart') {
    const dim =
      DIMENSION_CHOICES.find((c) => c.value === (widget.options.groupBy || 'assignee'))?.label.toLowerCase() ??
      'group'
    if (isTimeChart(widget.options)) {
      const what = widget.options.mode === 'created' ? 'Created' : 'Completed'
      return `${what} over time by ${dim}`
    }
    if (canStack(widget.options) && widget.options.stackBy) {
      const stack =
        DIMENSION_CHOICES.find((c) => c.value === widget.options.stackBy)?.label.toLowerCase() ?? 'group'
      return `By ${dim}, stacked by ${stack}`
    }
    return `By ${dim}`
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
  if (options.types) extra.types = options.types
  if (options.window) {
    // 'all' resolves to '' — the api layer drops empty params, clearing the
    // global from without sending one of our own.
    extra.from = options.window === 'all' ? '' : rangeStart(options.window as RangePreset) ?? ''
  }
  return extra
}

function effectiveMetric(options: Record<string, string>, scopeMetric: string): string {
  return options.metric || scopeMetric
}

/* --------------------------------------------------------- quick controls */

/** Widget types that offer a chart ↔ table flip, like the old report cards. */
export const TABLE_TYPES = new Set([
  'cfd', 'flow-io', 'cycletime', 'people-load', 'top-items', 'chord',
  'sankey', 'graph', 'burnup', 'timeline-graph',
])

/**
 * The inline controls on a widget header: every `quick` select field renders
 * as a segmented group (≤3 choices) or a compact dropdown, plus a table
 * toggle where the widget has a table view. The ⚙ editor keeps the full set.
 */
export function WidgetQuickBar({
  widget,
  onPatch,
}: {
  widget: WidgetConfig
  onPatch: (patch: Record<string, string>) => void
}) {
  const def = widgetDef(widget.type)
  if (!def) return null
  const quick = def.fields.filter(
    (f) => f.quick && f.kind === 'select' && f.choices?.length && (!f.showIf || f.showIf(widget.options))
  )
  const supportsTable = TABLE_TYPES.has(widget.type)
  if (!quick.length && !supportsTable) return null

  return (
    <span className="widget-quick" onPointerDown={(e) => e.stopPropagation()}>
      {quick.map((f) => {
        const current = widget.options[f.key] ?? f.choices![0].value
        return f.choices!.length <= 3 ? (
          <span key={f.key} className="segmented" role="group" aria-label={f.label}>
            {f.choices!.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-pressed={current === c.value}
                onClick={() => onPatch({ [f.key]: c.value })}
              >
                {c.label}
              </button>
            ))}
          </span>
        ) : (
          <select
            key={f.key}
            aria-label={f.label}
            value={current}
            onChange={(e) => onPatch({ [f.key]: e.target.value })}
          >
            {f.choices!.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        )
      })}
      {supportsTable && (
        <TableToggle
          on={widget.options.view === 'table'}
          onChange={(v) => onPatch({ view: v ? 'table' : '' })}
        />
      )}
    </span>
  )
}

/* ---------------------------------------------------------- widget bodies */

export function WidgetBody({ widget }: { widget: WidgetConfig }) {
  switch (widget.type) {
    case 'stat': return <StatBody widget={widget} />
    case 'cfd': return <CfdBody widget={widget} />
    case 'throughput': return <ThroughputBody widget={widget} />
    case 'top-items': return <TopItemsBody widget={widget} />
    case 'people-load': return <PeopleLoadBody widget={widget} />
    case 'breakdown': return <BreakdownBody widget={widget} />
    case 'chart': return <ChartBody widget={widget} />
    case 'sankey': return <SankeyBody widget={widget} />
    case 'chord': return <ChordBody widget={widget} />
    case 'cycletime': return <CycleTimeBody widget={widget} />
    case 'graph': return <GraphBody widget={widget} />
    case 'burnup': return <BurnupBody widget={widget} />
    case 'flow-io': return <FlowIoBody widget={widget} />
    case 'issues': return <IssuesBody widget={widget} />
    case 'icicle': return <IcicleBody widget={widget} />
    case 'timeline-graph': return <TimelineGraphBody widget={widget} />
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
    leavesOnly: widget.options.leavesOnly === 'false' ? 'false' : 'true',
  })
  if (!data || data.empty || data.series.length < 2) return <Empty title="Not enough history" />
  if (widget.options.view === 'table') return <CfdTable data={data} />
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
  if (widget.options.view === 'table') {
    return (
      <table className="data">
        <thead>
          <tr>
            <th>Item</th>
            <th style={{ textAlign: 'right' }}>To do</th>
            <th style={{ textAlign: 'right' }}>In progress</th>
            <th style={{ textAlign: 'right' }}>Done</th>
            <th style={{ textAlign: 'right' }}>%</th>
          </tr>
        </thead>
        <tbody>
          {data!.tree.map((n) => (
            <tr key={n.id}>
              <td className="wide" title={`${n.key} ${n.summary}`}>
                {n.key} {n.summary.length > 34 ? `${n.summary.slice(0, 33)}…` : n.summary}
              </td>
              <td className="num">{full(n.rollup.todo)}</td>
              <td className="num">{full(n.rollup.inProgress)}</td>
              <td className="num">{full(n.rollup.done)}</td>
              <td className="num">{pct(n.rollup.percent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
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
  if (widget.options.view === 'table') {
    return (
      <table className="data">
        <thead>
          <tr>
            <th>Person</th>
            <th style={{ textAlign: 'right' }}>Issues</th>
            <th style={{ textAlign: 'right' }}>To do</th>
            <th style={{ textAlign: 'right' }}>In progress</th>
            <th style={{ textAlign: 'right' }}>Done</th>
          </tr>
        </thead>
        <tbody>
          {data!.people.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td className="num">{p.issues}</td>
              <td className="num">{full(p.todo)}</td>
              <td className="num">{full(p.inProgress)}</td>
              <td className="num">{full(p.done)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  return (
    <BreakdownBars
      rows={rows}
      metric={effectiveMetric(widget.options, scope.metric)}
      max={Math.max(3, Math.floor((bodyHeight(widget.h) - 46) / 30))}
    />
  )
}

function ChartBody({ widget }: { widget: WidgetConfig }) {
  const kind = widget.options.chartType || 'bar'
  if (isTimeChart({ chartType: kind })) return <ChartTimeBody widget={widget} kind={kind} />
  if (canStack({ chartType: kind }) && widget.options.stackBy) {
    return <ChartCrosstabBody widget={widget} kind={kind} />
  }
  return <ChartGroupedBody widget={widget} kind={kind} />
}

/** bar / column stacked by a second dimension — /reports/crosstab. */
function ChartCrosstabBody({ widget, kind }: { widget: WidgetConfig; kind: string }) {
  const { scope } = useScope()
  const { data } = useReport<CrosstabData>('/reports/crosstab', {
    ...widgetExtra(widget.options),
    groupBy: widget.options.groupBy || 'assignee',
    stackBy: widget.options.stackBy,
  })
  if (!data) return null
  if (!data.rows.length) return <Empty title="Nothing to chart here" />
  const metric = effectiveMetric(widget.options, scope.metric)
  const rows: StackedRow[] = data.rows.map((r) => ({
    id: r.id,
    name: r.name,
    sub: `${r.issues} issues`,
    values: r.values,
  }))
  return kind === 'column' ? (
    <StackedColumns rows={rows} keys={data.keys} metric={metric} height={Math.max(180, bodyHeight(widget.h) - 60)} />
  ) : (
    <StackedBars
      rows={rows}
      keys={data.keys}
      metric={metric}
      max={Math.max(3, Math.floor((bodyHeight(widget.h) - 46) / 30))}
    />
  )
}

/** bar / donut / table — one request to /reports/breakdown, three renderings. */
function ChartGroupedBody({ widget, kind }: { widget: WidgetConfig; kind: string }) {
  const { scope } = useScope()
  const { data } = useReport<BreakdownData>('/reports/breakdown', {
    ...widgetExtra(widget.options),
    groupBy: widget.options.groupBy || 'assignee',
  })
  if (!data) return null
  if (!data.rows.length) return <Empty title="Nothing to chart here" />
  const metric = effectiveMetric(widget.options, scope.metric)

  const slices = data.rows.map((r) => ({ id: r.id, name: r.name, value: r.total }))

  if (kind === 'donut' || kind === 'pie') {
    return (
      <Donut
        slices={slices}
        metric={metric}
        variant={kind === 'pie' ? 'pie' : 'donut'}
        height={Math.max(180, bodyHeight(widget.h) - 60)}
      />
    )
  }

  if (kind === 'treemap') {
    return <Treemap slices={slices} metric={metric} height={Math.max(180, bodyHeight(widget.h) - 16)} />
  }

  if (kind === 'bubbles') {
    return <Bubbles slices={slices} metric={metric} height={Math.max(180, bodyHeight(widget.h) - 16)} />
  }

  if (kind === 'column') {
    const rows: BreakdownRow[] = data.rows.map((r) => ({
      id: r.id,
      name: r.name,
      sub: `${r.issues} issues`,
      done: r.done,
      inProgress: r.inProgress,
      todo: r.todo,
    }))
    return <ColumnChart rows={rows} metric={metric} height={Math.max(180, bodyHeight(widget.h) - 60)} />
  }

  if (kind === 'table') {
    return (
      <table className="data">
        <thead>
          <tr>
            <th>{DIMENSION_CHOICES.find((c) => c.value === data.groupBy)?.label ?? 'Group'}</th>
            <th style={{ textAlign: 'right' }}>To do</th>
            <th style={{ textAlign: 'right' }}>In progress</th>
            <th style={{ textAlign: 'right' }}>Done</th>
            <th style={{ textAlign: 'right' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.id}>
              <td className="wide" title={r.name}>{r.name.length > 40 ? `${r.name.slice(0, 39)}…` : r.name}</td>
              <td className="num">{full(r.todo)}</td>
              <td className="num">{full(r.inProgress)}</td>
              <td className="num">{full(r.done)}</td>
              <td className="num">{full(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  const rows: BreakdownRow[] = data.rows.map((r) => ({
    id: r.id,
    name: r.name,
    sub: `${r.issues} issues`,
    done: r.done,
    inProgress: r.inProgress,
    todo: r.todo,
  }))
  return (
    <BreakdownBars
      rows={rows}
      metric={metric}
      max={Math.max(3, Math.floor((bodyHeight(widget.h) - 46) / 30))}
    />
  )
}

/** area / line / heatmap — weekly series per group from /reports/timeseries. */
function ChartTimeBody({ widget, kind }: { widget: WidgetConfig; kind: string }) {
  const { scope } = useScope()
  const heat = kind === 'heatmap'
  const { data } = useReport<Cfd>('/reports/timeseries', {
    ...widgetExtra(widget.options),
    groupBy: widget.options.groupBy || 'assignee',
    mode: widget.options.mode === 'created' ? 'created' : 'completed',
    // A heatmap of running totals would just darken rightward — always weekly.
    accumulate: heat || widget.options.accumulate === 'weekly' ? 'false' : 'true',
    ...(heat ? { maxGroups: 10 } : {}),
  })
  if (!data) return null
  if (data.empty || data.series.length < 2) return <Empty title="Not enough history" />
  const metric = effectiveMetric(widget.options, scope.metric)
  const height = Math.max(200, bodyHeight(widget.h) - 76)
  if (heat) return <Heatmap data={data} metric={metric} height={Math.max(160, bodyHeight(widget.h) - 46)} />
  return kind === 'line' ? (
    <MultiLine data={data} metric={metric} height={height} />
  ) : (
    <CumulativeFlow data={data} metric={metric} height={height} />
  )
}

function BreakdownBody({ widget }: { widget: WidgetConfig }) {
  const { scope } = useScope()
  const { data } = useReport<BreakdownData>('/reports/breakdown', {
    ...widgetExtra(widget.options),
    groupBy: widget.options.groupBy || 'assignee',
  })
  const rows: BreakdownRow[] =
    data?.rows.map((r) => ({
      id: r.id,
      name: r.name,
      sub: `${r.issues} issues`,
      done: r.done,
      inProgress: r.inProgress,
      todo: r.todo,
    })) ?? []
  if (!rows.length) return <Empty title="Nothing to break down here" />
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
  if (widget.options.view === 'table') {
    return <SankeyTable data={data} metric={effectiveMetric(widget.options, scope.metric)} />
  }
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
  if (widget.options.view === 'table') {
    return <ChordTable data={data} unitLabel={flow === 'projects' ? 'links' : 'handovers'} />
  }
  return (
    <ChordChart
      data={data}
      unitLabel={flow === 'projects' ? 'links' : 'handovers'}
      height={Math.max(300, bodyHeight(widget.h) - 90)}
    />
  )
}

function CycleTimeBody({ widget }: { widget: WidgetConfig }) {
  const groupBy = widget.options.groupBy || 'epic'
  const { data } = useReport<CycleTimeData>('/reports/cycletime', {
    ...widgetExtra(widget.options),
    groupBy,
  })
  if (!data?.rows?.length) return <Empty title="Not enough resolved issues" />
  if (widget.options.view === 'table') return <CycleTimeTable data={data} />
  return <DotPlot data={data} max={Math.max(3, Math.floor((bodyHeight(widget.h) - 60) / 30))} />
}

function GraphBody({ widget }: { widget: WidgetConfig }) {
  const { data } = useReport<GraphData>('/reports/graph', {
    ...widgetExtra(widget.options),
    includeStories: widget.options.includeStories === 'true' ? 'true' : 'false',
  })
  if (!data?.nodes?.length) return <Empty title="Nothing above story level" />
  if (widget.options.view === 'table') return <GraphTable data={data} />
  const colorBy =
    widget.options.colorBy === 'type' || widget.options.colorBy === 'status'
      ? widget.options.colorBy
      : 'project'
  return <NetworkGraph data={data} colorBy={colorBy} height={Math.max(220, bodyHeight(widget.h) - 64)} />
}

function BurnupBody({ widget }: { widget: WidgetConfig }) {
  const { scope } = useScope()
  const { data } = useReport<BurnupData>('/reports/burnup', widgetExtra(widget.options))
  if (!data || data.empty || data.series.length < 2) return <Empty title="Not enough history" />
  if (widget.options.view === 'table') return <ProgressTable data={data} />
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
  if (widget.options.view === 'table') return <FlowInOutTable data={data} />
  return (
    <FlowInOut
      data={data}
      metric={effectiveMetric(widget.options, scope.metric)}
      variant={
        widget.options.style === 'lines' ? 'lines'
        : widget.options.style === 'cumulative' ? 'cumulative'
        : 'bars'
      }
      height={Math.max(160, bodyHeight(widget.h) - 60)}
    />
  )
}

function IcicleBody({ widget }: { widget: WidgetConfig }) {
  const { scope } = useScope()
  const { data } = useReport<{ tree: TreeNode[] }>('/reports/tree', widgetExtra(widget.options))
  if (!data?.tree?.length) return <Empty title="No hierarchy in scope" />
  return <Icicle tree={data.tree} metric={effectiveMetric(widget.options, scope.metric)} />
}

function TimelineGraphBody({ widget }: { widget: WidgetConfig }) {
  const { data } = useReport<TimelineGraphData>('/reports/graph-timeline', widgetExtra(widget.options))
  if (!data?.nodes?.length) return <Empty title="Not enough history to replay" />
  if (widget.options.view === 'table') return <TimelineTable data={data} />
  return <TemporalGraph data={data} height={Math.max(280, bodyHeight(widget.h) - 24)} />
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
