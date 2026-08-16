# Jira Reports

A local-first reporting app for **Jira Cloud**. It connects over OAuth 2.0 (3LO)
with your own app's client ID and secret, caches the issues you care about in a
SQLite file on your machine, and builds every report from that cache. Nothing
talks to Atlassian until you press **Refresh**.

```
┌───────────────┐   OAuth 3LO    ┌──────────────┐
│  web  (Vite)  │ ──────────────▶│    server    │──▶ api.atlassian.com
│  React + D3   │◀── /api ───────│  Express     │
└───────────────┘                └──────┬───────┘
                                        │
                                 data/jira.sqlite
```

The client secret and the refresh token live only in `data/jira.sqlite` on this
machine — the browser never sees either.

## Quick start

```bash
npm install
npm run dev
```

- UI → <http://localhost:5173>
- API → <http://localhost:8787>

Then open **Connection & sync** and work through the four steps.

### Try it first with demo data

```bash
npm run seed:demo
npm run dev
```

This seeds **Aurora Fintech**, a fictional organisation: a portfolio project with
4 initiatives, 11 epics spread across three team projects (Payments, Growth,
Platform), ~190 issues with real status histories, 14 people, and a Discovery
project whose ideas link to the epics that implement them. It lives under its own
demo site id, so it never mixes with a real Jira sync — once connected, switch
between the demo and your real site from the site dropdown in Settings. Remove it
with `npm run seed:demo -- --remove`.

### 1 · Create an Atlassian app

At <https://developer.atlassian.com/console/myapps/>:

1. **Create → OAuth 2.0 integration**.
2. **Permissions → Jira API → Add**, then grant `read:jira-work` and
   `read:jira-user`.
3. **Authorization → OAuth 2.0 (3LO) → Configure**, and set the callback URL to
   exactly:

   ```
   http://localhost:8787/api/auth/callback
   ```

4. Copy the **Client ID** and **Secret** from *Settings*.

Paste them into step 1 of the Settings page (stored locally), or pre-seed them by
copying `.env.example` to `.env`.

### 2 · Authorise, pick projects, sync

Click **Connect to Jira**, approve the consent screen, choose your site, tick the
projects to cache, and run the first sync. A full sync reads issues, then their
change history — that second phase is what makes the cumulative flow possible, and
it is the slow one on a large project.

Later syncs are incremental: only issues whose `updated` timestamp moved are
re-read, and only those get their change history re-fetched.

## Reports

| Page | What it answers |
|---|---|
| **Overview** | How complete is this scope, what got resolved recently, which items are biggest |
| **Dashboards** | Your own boards: add widgets, drag to arrange, resize from the corner — saved locally |
| **Cumulative flow** | How much work sat in each status, day by day, rebuilt from change history |
| **Initiatives** | Every child rolled up through the parent chain, with % complete at each level |
| **People & flow** | A Sankey of who works on what — pick any three of assignee / epic / initiative / project / status / type / priority |
| **Insights** | A directed chord of who hands work to whom, cycle-time dot plots (median vs p90), and a draggable force-graph of the delivery network |
| **Timeline** | The scope as a story: % complete over time, weekly added-vs-completed, and a playable replay of the network growing and finishing |
| **Explorer** | The raw issue list the current scope resolves to; pick a new report root from it |

### Dashboards

The Dashboards page is a widget builder: pick from twelve widget types (stat,
cumulative flow, throughput, top items, people load, Sankey, chord, cycle time,
network graph, progress over time, added-vs-completed, issue list), drag cards by their header on a
12-column grid, resize from the bottom-right corner, and configure each via its
gear — title, measure, dimensions, and an optional per-widget scope override
(leave empty to inherit the filter row). Layouts live in the same local SQLite
file as the data, so boards survive browser resets. Any number of dashboards can
be created and switched from the page header.

Chart cards on the report pages are **resizable** — drag the small corner handle
at the bottom-right of a chart to make it taller or shorter; the chart refills
the space and the chosen height is remembered per card. The added-vs-completed
chart can be drawn as mirror bars or as two trend lines (toggle on the card, or
per-widget in a dashboard).

### The filter row

One row, above everything, scoping every chart on the page:

- **Projects** — restrict to cached projects
- **Report on** + **Selection** — pick an initiative, epic, or Product Discovery
  idea as the report root; everything beneath it via parent links is included
- **Measure** — issue count, story points, or logged time. Every chart and every
  percentage switches together
- **Window** — 30 / 90 / 180 / 365 days or all time
- **Refresh** — incremental sync, with live progress

### Notes on the numbers

- **Completion** is `done / total` in the selected measure. Story points and
  logged time are missing on many issues, so the Overview shows what share of
  issues carry an estimate — check it before trusting a points-based percentage.
- **Cumulative flow** defaults to *leaf* issues so an epic is not counted both as
  itself and as its children.
- **Hierarchy** comes from the `parent` field, falling back to the legacy *Epic
  Link* and *Parent Link* fields. Parents living outside the cached projects are
  fetched automatically so an initiative is never orphaned.
- **Ideas** are issues in a Product Discovery project; selecting one can follow
  its outward links to delivery tickets.

## Design

Charts follow a validated palette rather than an eyeballed one:

- Categorical hues are assigned in **fixed slot order** keyed by entity, so
  filtering never repaints the survivors, and hues are never cycled past eight —
  the tail folds into a labelled "Other".
- Status bands and completion meters use a single-hue **ordinal blue ramp**
  (darkest = done), validated for monotonic lightness and adjacent-step contrast
  in both themes.
- Every chart has a **table view** twin, a legend when there are two or more
  series, and keyboard-reachable tooltips — no value is available only on hover.

Light and dark are both explicitly selected; the theme control is bottom-left.

## Layout

```
server/src/
  index.js       Express app; serves web/dist in production
  config.js      env + paths
  db.js          SQLite schema and migrations
  oauth.js       3LO: authorise, exchange, rotate refresh tokens
  jiraClient.js  REST calls with 429/5xx retry, JQL + changelog pagination
  sync.js        metadata → issues → hierarchy closure → change history
  reports.js     scope resolution, CFD, rollups, Sankey, throughput
  routes.js      the /api surface
web/src/
  charts/        CumulativeFlow, SankeyChart, Icicle, BreakdownBars, ThroughputBars
  components/    ScopeBar, Picker, shared UI
  pages/         Overview, CumulativeFlowPage, Initiatives, People, Explorer, Settings
  lib/           api client, scope context, palette, formatting
```

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | server (watch) + Vite dev server |
| `npm run build` | production bundle into `web/dist` |
| `npm start` | server only; serves `web/dist` if built, on one port |

## Troubleshooting

**"OAuth state mismatch"** — the callback took longer than 10 minutes or was
replayed. Start the connection again.

**Consent screen rejects the redirect** — the callback URL in the developer
console must match `http://localhost:8787/api/auth/callback` character for
character, including the scheme and port.

**Cumulative flow says "not enough history"** — the change-history phase of the
sync had not finished, or the window predates the issues. Widen the window, or
re-run the sync and watch step 4 on the Settings page.

**No initiatives in the picker** — your site may not use a hierarchy level above
Epic, or those issues live in a project you have not cached. Check *Explorer →
Issue types in the cache* to see which levels exist.

**Sync is slow the first time** — change history is one request per 100 issues
and cannot be batched further. It only happens once per issue; later syncs skip
anything unchanged.

## Building your own dashboards on top

Everything lives in `data/jira.sqlite`, so free widget-dashboard tools can sit
directly on the cache — no extra export step:

- **[Metabase](https://www.metabase.com/data-sources/sqlite)** (open source,
  self-hosted, free) officially supports SQLite. Run it via Docker or the JAR,
  point it at `data/jira.sqlite`, and you get a drag-and-drop question/dashboard
  builder over `issues`, `status_history`, `projects` etc.
- **[Grafana](https://grafana.com/grafana/plugins/frser-sqlite-datasource/)**
  (open source, free) reads the same file through the `frser-sqlite-datasource`
  plugin — best when you want auto-refreshing wallboard-style panels.
- Anything that consumes **JSON over HTTP** (Grafana's Infinity plugin,
  Appsmith, Budibase) can instead call this app's `/api/reports/*` endpoints and
  reuse the computed rollups rather than raw tables.

The database is opened in WAL mode; point external tools at it read-only and
they can coexist with a running sync.

## Full specification

[SPEC.md](SPEC.md) is a complete build specification — every schema, algorithm,
constant, colour value, component contract, and known pitfall — detailed enough
to rebuild the application from scratch without the source.

## Scope

Built for **Jira Cloud**. Jira Server / Data Center does not offer OAuth 3LO
through `auth.atlassian.com` and is not supported.
