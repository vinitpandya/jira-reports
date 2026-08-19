import { db } from './db.js'

/**
 * The built-in report pages, expressed as dashboard layouts so they are fully
 * editable in the UI. Seeded once per slug; "reset" re-applies the template.
 * Widget types and option keys mirror web/src/dashboard/registry.tsx.
 */
export const SYSTEM_PAGES = [
  {
    slug: 'overview',
    name: 'Overview',
    layout: [
      { i: 'ov-1', type: 'stat', title: '', x: 0, y: 0, w: 3, h: 2, options: { kind: 'percent' } },
      { i: 'ov-2', type: 'stat', title: '', x: 3, y: 0, w: 3, h: 2, options: { kind: 'issues' } },
      { i: 'ov-3', type: 'stat', title: '', x: 6, y: 0, w: 3, h: 2, options: { kind: 'inprogress' } },
      { i: 'ov-4', type: 'stat', title: '', x: 9, y: 0, w: 3, h: 2, options: { kind: 'people' } },
      { i: 'ov-5', type: 'cfd', title: '', x: 0, y: 2, w: 6, h: 5, options: { groupBy: 'category' } },
      { i: 'ov-6', type: 'throughput', title: '', x: 6, y: 2, w: 6, h: 3, options: { field: 'count' } },
      { i: 'ov-7', type: 'flow-io', title: '', x: 6, y: 5, w: 6, h: 4, options: { style: 'bars' } },
      { i: 'ov-8', type: 'top-items', title: '', x: 0, y: 7, w: 6, h: 4, options: {} },
      { i: 'ov-9', type: 'people-load', title: '', x: 6, y: 9, w: 6, h: 4, options: {} },
    ],
  },
  {
    slug: 'flow',
    name: 'Cumulative flow',
    layout: [
      { i: 'fl-1', type: 'cfd', title: '', x: 0, y: 0, w: 8, h: 6, options: { groupBy: 'status' } },
      { i: 'fl-2', type: 'stat', title: '', x: 8, y: 0, w: 4, h: 2, options: { kind: 'percent' } },
      { i: 'fl-3', type: 'burnup', title: '', x: 8, y: 2, w: 4, h: 4, options: {} },
      { i: 'fl-4', type: 'flow-io', title: '', x: 0, y: 6, w: 6, h: 4, options: { style: 'bars' } },
      {
        i: 'fl-5', type: 'chart', title: '', x: 6, y: 6, w: 6, h: 4,
        options: { chartType: 'area', groupBy: 'status', mode: 'completed', accumulate: 'cumulative' },
      },
    ],
  },
  {
    slug: 'initiatives',
    name: 'Initiatives',
    layout: [
      { i: 'in-1', type: 'top-items', title: '', x: 0, y: 0, w: 6, h: 5, options: {} },
      { i: 'in-2', type: 'graph', title: '', x: 6, y: 0, w: 6, h: 5, options: { includeStories: '' } },
      { i: 'in-3', type: 'cycletime', title: '', x: 0, y: 5, w: 6, h: 4, options: { groupBy: 'epic' } },
      { i: 'in-4', type: 'icicle', title: '', x: 6, y: 5, w: 6, h: 4, options: {} },
    ],
  },
  {
    slug: 'people',
    name: 'People & flow',
    layout: [
      { i: 'pe-1', type: 'people-load', title: '', x: 0, y: 0, w: 6, h: 4, options: {} },
      { i: 'pe-2', type: 'chord', title: '', x: 6, y: 0, w: 6, h: 5, options: { flow: 'handovers' } },
      { i: 'pe-3', type: 'cycletime', title: '', x: 0, y: 4, w: 6, h: 4, options: { groupBy: 'assignee' } },
      {
        i: 'pe-4', type: 'chart', title: '', x: 6, y: 5, w: 6, h: 4,
        options: { chartType: 'bar', groupBy: 'assignee', stackBy: 'type' },
      },
    ],
  },
  {
    slug: 'insights',
    name: 'Insights',
    layout: [
      {
        i: 'ins-1', type: 'sankey', title: '', x: 0, y: 0, w: 8, h: 5,
        options: { from: 'assignee', via: 'epic', to: 'category' },
      },
      { i: 'ins-2', type: 'chord', title: '', x: 8, y: 0, w: 4, h: 5, options: { flow: 'projects' } },
      { i: 'ins-3', type: 'graph', title: '', x: 0, y: 5, w: 8, h: 5, options: { includeStories: '' } },
      {
        i: 'ins-4', type: 'chart', title: '', x: 8, y: 5, w: 4, h: 5,
        options: { chartType: 'donut', groupBy: 'project' },
      },
    ],
  },
  {
    slug: 'timeline',
    name: 'Timeline',
    layout: [
      { i: 'tl-1', type: 'burnup', title: '', x: 0, y: 0, w: 6, h: 4, options: {} },
      { i: 'tl-2', type: 'flow-io', title: '', x: 6, y: 0, w: 6, h: 4, options: { style: 'cumulative' } },
      { i: 'tl-3', type: 'timeline-graph', title: '', x: 0, y: 4, w: 12, h: 6, options: {} },
    ],
  },
]

export function templateFor(slug) {
  return SYSTEM_PAGES.find((p) => p.slug === slug) ?? null
}

/** Insert any system page that is not in the database yet. Never overwrites. */
export function seedSystemPages() {
  const existing = new Set(
    db.prepare('SELECT slug FROM dashboards WHERE slug IS NOT NULL').all().map((r) => r.slug)
  )
  const insert = db.prepare(
    'INSERT INTO dashboards (name, slug, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  )
  const now = Date.now()
  for (const page of SYSTEM_PAGES) {
    if (!existing.has(page.slug)) {
      insert.run(page.name, page.slug, JSON.stringify(page.layout), now, now)
    }
  }
}
