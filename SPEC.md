# Jira Reports — Complete Build Specification

This document specifies the entire application precisely enough to rebuild it
from scratch without seeing the original source. Every schema, algorithm,
constant, colour value, component contract, and known pitfall is written down.
Follow it top to bottom; each milestone ends with a verification step whose
expected output is given.

Contents:

0. [How to use this specification](#0-how-to-use-this-specification)
1. [Product definition](#1-product-definition)
2. [Stack, dependencies, repository layout](#2-stack-dependencies-repository-layout)
3. [Server: configuration](#3-server-configuration)
4. [Server: database schema](#4-server-database-schema)
5. [Server: OAuth 2.0 (3LO)](#5-server-oauth-20-3lo)
6. [Server: Jira REST client](#6-server-jira-rest-client)
7. [Server: sync engine](#7-server-sync-engine)
8. [Server: report algorithms](#8-server-report-algorithms)
9. [Server: HTTP API](#9-server-http-api)
10. [Frontend: design tokens & theming](#10-frontend-design-tokens--theming)
11. [Frontend: palette module & colour rules](#11-frontend-palette-module--colour-rules)
12. [Frontend: shared UI components](#12-frontend-shared-ui-components)
13. [Frontend: scope context & data fetching](#13-frontend-scope-context--data-fetching)
14. [Frontend: chart components (all 12)](#14-frontend-chart-components)
15. [Frontend: dashboard system](#15-frontend-dashboard-system)
16. [Frontend: pages & navigation](#16-frontend-pages--navigation)
17. [Frontend: CSS reference](#17-frontend-css-reference)
18. [Demo data seeder](#18-demo-data-seeder)
19. [Verification recipes & ground truth](#19-verification-recipes--ground-truth)
20. [Gotchas & invariants](#20-gotchas--invariants)
21. [Build order](#21-build-order)
22. [Appendix A — reference implementations (copy verbatim)](#appendix-a--reference-implementations-copy-verbatim)
23. [Appendix B — complete server source (copy verbatim)](#appendix-b--complete-server-source-copy-verbatim)
24. [Appendix C — web configuration & tokens (copy verbatim)](#appendix-c--web-configuration--tokens-copy-verbatim)

---

## 0. How to use this specification

Rules for the implementing model — follow these to the letter:

1. **Build in the §21 milestone order.** Do not start a milestone before the
   previous milestone's check passes.
2. **Copy code verbatim.** Wherever this document shows code — every entry in
   Appendix A, every SQL block, every path/formula snippet — reproduce it
   character for character. Do not paraphrase, rename, reorder, or "improve"
   it. Where the spec gives only prose, any implementation that passes the
   §19 checks is acceptable.
3. **Prose vs code precedence:** when a section says "verbatim implementation:
   A.x", the appendix entry is the source of truth and the prose is only a
   summary.
4. **Use exactly the dependencies in §2.** No chart libraries, no CSS
   frameworks, no drag-and-drop or grid-layout libraries, no state managers.
   Everything beyond the listed packages is hand-written.
5. **File paths are exact.** Create every file where the tree in §2 places it,
   with the same name and extension.
6. **Numbers are load-bearing.** Margins, heights, caps, slack constants,
   debounce and poll intervals, colour hex values, force strengths — use them
   as written; do not round or substitute.
7. **Verify constantly.** §19 gives deterministic ground truth via the demo
   seeder: if your numbers differ from the expected values, your algorithm
   differs — fix the algorithm, never the expectation.
8. **Escape sequences are text.** `\u0000` must appear in source files as six
   characters (backslash, u, four zeros) inside a string literal — never as a
   raw control byte.
9. **TypeScript `strict` is on** in the web workspace; the server is plain
   ESM JavaScript. Both must run with zero build errors (`tsc -b` and
   `node --check`).
10. **This file is long (~6,000 lines) — read ALL of it before building.**
    Default file-read limits truncate it mid-appendix; keep reading in chunks
    (by line offset) until you reach the literal text `*End of
    specification.*`. In particular: §19 contains the verification ground
    truth, Appendix A the high-risk algorithm implementations, **Appendix B
    the complete server source code**, and **Appendix C the web configuration
    files and design-token CSS**. If something seems missing, it is further
    down the file — nothing referenced is absent.

---

## 1. Product definition

A **local-first reporting app for Jira Cloud**. It:

- authenticates against Atlassian with the user's own OAuth 2.0 (3LO) app
  (client ID + secret entered in the UI or `.env`);
- caches selected projects' issues, hierarchy, links, and full status/assignee
  change history into a **SQLite file on disk** (`data/jira.sqlite`);
- computes every report from that cache — Jira is only contacted when the user
  presses **Refresh** (incremental sync);
- renders reports with **hand-built D3 charts** (no chart library): cumulative
  flow, hierarchy rollups, Sankey, directed chord, cycle-time dot plot,
  force-directed network, temporal (playable) network, burn-up/progress line,
  added-vs-completed mirror/line chart, throughput bars, stacked breakdown bars,
  icicle;
- provides a **widget dashboard builder** (12 widget types, drag/resize on a
  12-column grid, persisted in SQLite);
- ships a deterministic **demo organisation seeder** so the app is explorable
  with zero setup.

Non-goals: Jira Server/Data Center (no 3LO), writing anything back to Jira,
multi-user auth (single local user).

Two-process architecture:

```
┌───────────────┐   OAuth 3LO    ┌──────────────┐
│  web  (Vite)  │ ──────────────▶│    server    │──▶ api.atlassian.com
│  React + D3   │◀── /api ───────│  Express     │
└───────────────┘                └──────┬───────┘
                                        │
                                 data/jira.sqlite
```

The client secret and refresh token exist only in the SQLite file; the browser
never receives either (auth status reports only a truncated client ID and
boolean `hasSecret`).

---

## 2. Stack, dependencies, repository layout

### Toolchain

- Node.js ≥ 20.11 (uses global `fetch`, `node --watch`)
- npm workspaces monorepo: root + `server` + `web`

### Root `package.json`

```json
{
  "name": "jira-reports",
  "private": true,
  "workspaces": ["server", "web"],
  "scripts": {
    "dev": "concurrently -n server,web -c blue,magenta \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "npm run dev --workspace server",
    "dev:web": "npm run dev --workspace web",
    "build": "npm run build --workspace web",
    "start": "npm run start --workspace server",
    "seed:demo": "node server/scripts/seed-demo.mjs"
  },
  "devDependencies": { "concurrently": "^9.1.2" },
  "engines": { "node": ">=20.11" }
}
```

### Server dependencies (`server/package.json`, `"type": "module"`)

| Package | Version | Used for |
|---|---|---|
| `express` | ^4.21 | HTTP API, static serving of `web/dist` |
| `better-sqlite3` | ^12.4 | synchronous SQLite driver (prepared statements, transactions) |
| `dotenv` | ^16.4 | `.env` loading |
| `cookie-parser` | ^1.4 | installed for future use; no cookies are actually required |

Scripts: `dev` = `node --watch src/index.js`, `start` = `node src/index.js`.

Verbatim `server/package.json`:

```json
{
  "name": "server",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "dev": "node --watch src/index.js",
    "start": "node src/index.js"
  },
  "dependencies": {
    "better-sqlite3": "^12.4.1",
    "cookie-parser": "^1.4.7",
    "dotenv": "^16.4.7",
    "express": "^4.21.2"
  }
}
```

### Web dependencies (`web/package.json`, `"type": "module"`)

| Package | Version | Used for |
|---|---|---|
| `react`, `react-dom` | ^18.3 | UI |
| `react-router-dom` | ^6.28 | routing (BrowserRouter) |
| `d3` | ^7.9 | scales, shapes, force, chord, zoom, partition, stack (the full bundle) |
| `d3-sankey` | ^0.12.3 | Sankey layout (not in the d3 bundle) |
| dev: `vite` ^6, `@vitejs/plugin-react` ^4.3, `typescript` ^5.7, `@types/d3`, `@types/d3-sankey`, `@types/react`, `@types/react-dom` |

Verbatim `web/package.json`:

```json
{
  "name": "web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "d3": "^7.9.0",
    "d3-sankey": "^0.12.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/d3": "^7.4.3",
    "@types/d3-sankey": "^0.12.4",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.2",
    "vite": "^6.0.5"
  }
}
```

`vite.config.ts`: react plugin; dev server port **5173** with proxy
`'/api' → http://localhost:8787` (`changeOrigin: true`); build to `dist`
with sourcemaps.

`tsconfig.json`: `strict: true`, `jsx: react-jsx`, `moduleResolution: bundler`,
`target ES2022`, `noEmit`, include `src`.

### Repository layout

```
.env.example                 sample env config
.gitignore                   node_modules/ dist/ data/ .env *.log
package.json                 workspaces root (above)
README.md                    user documentation
SPEC.md                      this file
server/
  package.json
  scripts/seed-demo.mjs      demo organisation seeder (§18)
  src/
    config.js                env + paths (§3)
    db.js                    schema + config helpers (§4)
    oauth.js                 3LO flow, token store (§5)
    jiraClient.js            REST + pagination + retry (§6)
    sync.js                  sync engine (§7)
    reports.js               all report algorithms (§8)
    routes.js                the /api surface (§9)
    index.js                 Express bootstrap
web/
  index.html                 pre-paint theme script (§10)
  vite.config.ts
  tsconfig.json
  package.json
  src/
    main.tsx                 createRoot + BrowserRouter + StrictMode
    App.tsx                  shell, nav, theme toggle, routes, inline SVG icons
    styles/theme.css         design tokens (§10)
    styles/app.css           application CSS (§17)
    lib/api.ts               fetch wrapper + all TS types
    lib/format.ts            number/date formatting (§12)
    lib/palette.ts           colour access (§11)
    lib/scope.tsx            ScopeProvider, useScope, useReport (§13)
    components/ui.tsx        Card, StatTile, Meter, Tooltip, Legend, TableToggle,
                             Empty, Banner, ResizableBody, useMeasure, useThemeVersion
    components/Picker.tsx    searchable multi-select + plain Select
    components/ScopeBar.tsx  the global filter row
    charts/CumulativeFlow.tsx    (+ CfdTable)
    charts/SankeyChart.tsx       (+ SankeyTable)
    charts/Icicle.tsx
    charts/BreakdownBars.tsx
    charts/ThroughputBars.tsx
    charts/ChordChart.tsx        (+ ChordTable)
    charts/DotPlot.tsx           (+ CycleTimeTable)
    charts/NetworkGraph.tsx      (+ GraphTable)
    charts/TemporalGraph.tsx     (+ TimelineTable)
    charts/ProgressLine.tsx      (+ ProgressTable)
    charts/FlowInOut.tsx         (+ FlowInOutTable)
    dashboard/Grid.tsx           layout math + drag/resize (§15)
    dashboard/registry.tsx       widget catalog + widget bodies (§15)
    pages/Overview.tsx
    pages/Dashboards.tsx
    pages/CumulativeFlowPage.tsx
    pages/Initiatives.tsx
    pages/People.tsx
    pages/Insights.tsx
    pages/Timeline.tsx
    pages/Explorer.tsx
    pages/Settings.tsx
```

`.env.example` keys: `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`,
`OAUTH_REDIRECT_URI=http://localhost:8787/api/auth/callback`,
`JIRA_SCOPES=read:jira-work read:jira-user offline_access`, `PORT=8787`,
optional `DATA_DIR`.

---

## 3. Server: configuration

`server/src/config.js` (ESM, imports `dotenv/config` first):

| Export | Value |
|---|---|
| `ROOT` | repo root, resolved as `path.resolve(dirname(this file), '..', '..')` |
| `PORT` | `Number(process.env.PORT \|\| 8787)` |
| `DATA_DIR` | `process.env.DATA_DIR` resolved against ROOT, else `ROOT/data` |
| `REDIRECT_URI` | env `OAUTH_REDIRECT_URI` else `http://localhost:${PORT}/api/auth/callback` |
| `SCOPES` | env `JIRA_SCOPES` else `read:jira-work read:jira-user offline_access` |
| `ENV_CLIENT_ID` / `ENV_CLIENT_SECRET` | from env, default `''` |
| `AUTH_BASE` | `https://auth.atlassian.com` |
| `API_BASE` | `https://api.atlassian.com` |
| `WEB_ORIGIN` | env `WEB_ORIGIN` else `http://localhost:5173` (OAuth callback redirects back to `${WEB_ORIGIN}/settings?...`) |

`server/src/index.js`: `express.json({limit:'2mb'})`, `cookieParser()`, mount
router at `/api`; if `ROOT/web/dist` exists, serve it statically and send
`index.html` for any non-`/api` GET (SPA fallback); a final error middleware
returns `{ error: String(err.message) }` with status 500; listens on PORT and
logs the data dir.

---

## 4. Server: database schema

`server/src/db.js` creates `DATA_DIR` (`mkdirSync recursive`), opens
`DATA_DIR/jira.sqlite` with better-sqlite3, sets `journal_mode = WAL` and
`foreign_keys = ON`, then executes this DDL verbatim (all `CREATE TABLE IF NOT
EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT                        -- JSON-encoded
);

CREATE TABLE IF NOT EXISTS oauth_token (
  id            INTEGER PRIMARY KEY CHECK (id = 1),   -- single row
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    INTEGER,            -- epoch ms
  scope         TEXT,
  obtained_at   INTEGER
);

CREATE TABLE IF NOT EXISTS sites (
  cloud_id TEXT PRIMARY KEY,
  name     TEXT, url TEXT, avatar TEXT, scopes TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  cloud_id TEXT NOT NULL, id TEXT NOT NULL,
  key TEXT, name TEXT,
  type_key TEXT,      -- software | service_desk | business | product_discovery
  style TEXT,         -- classic | next-gen
  avatar TEXT, category TEXT, lead TEXT,
  PRIMARY KEY (cloud_id, id)
);

CREATE TABLE IF NOT EXISTS issue_types (
  cloud_id TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT, subtask INTEGER,
  hierarchy_level INTEGER,  -- -1 subtask, 0 story, 1 epic, 2+ initiative
  icon TEXT,
  PRIMARY KEY (cloud_id, id)
);

CREATE TABLE IF NOT EXISTS statuses (
  cloud_id TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT,
  category_key TEXT,        -- new | indeterminate | done
  category_name TEXT,
  PRIMARY KEY (cloud_id, id)
);

CREATE TABLE IF NOT EXISTS fields (
  cloud_id TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT, custom INTEGER, schema_type TEXT,
  PRIMARY KEY (cloud_id, id)
);

CREATE TABLE IF NOT EXISTS issues (
  cloud_id TEXT NOT NULL, id TEXT NOT NULL,
  key TEXT, project_id TEXT, project_key TEXT,
  type_id TEXT, type_name TEXT, hierarchy_level INTEGER,
  status_id TEXT, status_name TEXT, status_category TEXT,
  resolution TEXT, priority TEXT,
  parent_id TEXT, parent_key TEXT,
  assignee_id TEXT, assignee_name TEXT, assignee_avatar TEXT,
  reporter_id TEXT, reporter_name TEXT,
  summary TEXT,
  labels TEXT,        -- JSON array of strings
  components TEXT,    -- JSON array of strings
  story_points REAL, time_spent INTEGER, original_estimate INTEGER,
  created TEXT, updated TEXT, resolved TEXT, status_changed TEXT,  -- ISO strings
  PRIMARY KEY (cloud_id, id)
);
CREATE INDEX IF NOT EXISTS idx_issues_parent   ON issues (cloud_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_issues_project  ON issues (cloud_id, project_id);
CREATE INDEX IF NOT EXISTS idx_issues_level    ON issues (cloud_id, hierarchy_level);
CREATE INDEX IF NOT EXISTS idx_issues_key      ON issues (cloud_id, key);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues (cloud_id, assignee_id);

CREATE TABLE IF NOT EXISTS issue_links (
  cloud_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
  type TEXT NOT NULL, direction TEXT NOT NULL,   -- outward | inward
  PRIMARY KEY (cloud_id, source_id, target_id, type, direction)
);
CREATE INDEX IF NOT EXISTS idx_links_source ON issue_links (cloud_id, source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON issue_links (cloud_id, target_id);

CREATE TABLE IF NOT EXISTS status_history (
  cloud_id TEXT NOT NULL, issue_id TEXT NOT NULL, at TEXT NOT NULL,
  from_id TEXT, from_status TEXT, to_id TEXT, to_status TEXT,
  author_id TEXT, author_name TEXT,
  PRIMARY KEY (cloud_id, issue_id, at, to_id)
);
CREATE INDEX IF NOT EXISTS idx_hist_issue ON status_history (cloud_id, issue_id, at);

CREATE TABLE IF NOT EXISTS assignee_history (
  cloud_id TEXT NOT NULL, issue_id TEXT NOT NULL, at TEXT NOT NULL,
  from_id TEXT, from_name TEXT, to_id TEXT, to_name TEXT,
  PRIMARY KEY (cloud_id, issue_id, at)
);
CREATE INDEX IF NOT EXISTS idx_ahist_issue ON assignee_history (cloud_id, issue_id, at);

CREATE TABLE IF NOT EXISTS changelog_cursor (
  cloud_id TEXT NOT NULL, issue_id TEXT NOT NULL,
  issue_updated TEXT,      -- issues.updated at fetch time (the watermark)
  fetched_at INTEGER,
  PRIMARY KEY (cloud_id, issue_id)
);

CREATE TABLE IF NOT EXISTS dashboards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  layout TEXT NOT NULL DEFAULT '[]',   -- JSON [{i,type,title,x,y,w,h,options}]
  created_at INTEGER, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cloud_id TEXT, started_at INTEGER, finished_at INTEGER,
  mode TEXT,      -- full | incremental
  status TEXT,    -- running | ok | error | cancelled
  stats TEXT,     -- JSON
  error TEXT
);
```

Exports: `db`, plus `getConfig(key, fallback)` / `setConfig(key, value)` /
`deleteConfig(key)` — values JSON-stringified into `app_config`, parsed on read
(fall back to raw string if parse fails).

**`app_config` keys used:** `client_id`, `client_secret`, `redirect_uri`,
`scopes` (Settings-page overrides), `oauth_state` (`{state, at}` CSRF nonce),
`cloud_id` (active site), `sync_projects` (array of project keys),
`field_ids` (discovered custom field ids), `last_issue_sync` (incremental
watermark string `YYYY-MM-DD HH:mm`).

---

## 5. Server: OAuth 2.0 (3LO)

`server/src/oauth.js`. Atlassian 3LO endpoints:

- Authorize: `GET https://auth.atlassian.com/authorize` with query
  `audience=api.atlassian.com`, `client_id`, `scope`, `redirect_uri`, `state`,
  `response_type=code`, `prompt=consent`.
- Token: `POST https://auth.atlassian.com/oauth/token` (JSON body).
- Accessible sites: `GET https://api.atlassian.com/oauth/token/accessible-resources`
  with `Authorization: Bearer <access_token>`.

Functions:

- `getCredentials()` — resolution order: `app_config` values first, then env.
  Returns `{clientId, clientSecret, redirectUri, scopes, fromEnv}`.
- `setCredentials({...})` — writes only the keys provided.
- `buildAuthUrl()` — generates `state = randomBytes(24).toString('hex')`, stores
  `{state, at: Date.now()}` under `oauth_state`, returns the authorize URL.
- `consumeState(state)` — reads and **deletes** the stored nonce; valid only if
  it matches and is younger than **10 minutes**.
- `exchangeCode(code)` — token request with
  `{grant_type:'authorization_code', client_id, client_secret, code, redirect_uri}`;
  stores the token.
- Token storage (`storeToken`): single-row upsert into `oauth_token` with
  `expires_at = now + expires_in*1000`;
  `refresh_token = COALESCE(new, existing)` — **Atlassian rotates refresh
  tokens**, and some responses omit it, so never null it out.
- `getAccessToken()` — returns the stored token if it has **> 60 s** of life
  left; otherwise refreshes with
  `{grant_type:'refresh_token', client_id, client_secret, refresh_token}`.
  **Single-flight**: a module-level `refreshInFlight` promise is shared so that
  concurrent callers (the sync fires many requests) never redeem the same
  rotated refresh token twice:

  ```js
  if (!refreshInFlight) refreshInFlight = refresh().finally(() => { refreshInFlight = null })
  return refreshInFlight
  ```

- `authStatus()` — `{configured, clientId: first 6 chars + '…', hasSecret,
  credentialSource: 'env'|'settings'|null, redirectUri, scopes, connected,
  expiresAt, grantedScopes}`. Never returns the secret.
- `disconnect()` — `DELETE FROM oauth_token`.
- `fetchAccessibleResources()` — fetches sites, upserts into `sites`
  (scopes JSON-stringified), and if `cloud_id` config is unset picks the first
  site. Returns the raw site array.
- `activeCloudId()` — config `cloud_id`, else first row of `sites`, else null.

---

## 6. Server: Jira REST client

`server/src/jiraClient.js`.

- `class JiraError extends Error { status, body, path }`.
- `jiraFetch(path, {method, query, body, cloudId})` — URL is
  `${API_BASE}/ex/jira/${cloudId}/rest${path}`; query params skipped when
  `undefined | null | ''`. Retries on **429 or ≥ 500**, up to **5 attempts**,
  waiting `Retry-After` seconds if that header is a positive number, else
  exponential backoff `min(30_000, 2**attempt * 1000)` ms. Re-acquires the
  access token before every attempt (it may refresh mid-loop). 204 → null.
  Non-retryable failure → throw `JiraError`.
- `searchIssues({jql, fields, cloudId, expand, onPage, pageSize=100, signal})` —
  paginated JQL search. Primary endpoint: `GET /api/3/search/jql`
  (token pagination: `nextPageToken`, stop on `isLast || !nextPageToken ||
  page empty`). If it 404s/410s (older sites), permanently fall back to legacy
  `GET /api/3/search` with `startAt` offset pagination (stop when
  `startAt >= total` or empty page). Calls `await onPage(issues)` per page;
  checks `signal.aborted` between pages (throw `Error('Sync cancelled')`).
  Returns total count.
- `fetchChangelogs({issueIds, fieldIds=['status','assignee'], cloudId, signal})` —
  chunks of **100** issue ids. Primary: `POST /api/3/changelog/bulkfetch` with
  `{fieldIds, issueIdsOrKeys, maxResults: 1000, nextPageToken?}`, accumulating
  `issueChangeLogs[].changeHistories` into a `Map<issueId, histories[]>`,
  following `nextPageToken`. If bulkfetch returns 400/404/410, fall back for
  that chunk to per-issue `GET /api/3/issue/{id}/changelog` pages of 100.

---

## 7. Server: sync engine

`server/src/sync.js`. One sync at a time; module-level `current` holds
`{runId, mode, phase, message, counts, startedAt, controller: AbortController}`.

Public API: `runSync({mode: 'full'|'incremental'})`, `syncStatus()`,
`cancelSync()` (aborts the controller).

`syncStatus()` returns `{running, phase, message, counts, startedAt, last}`
where `last` is the newest `sync_runs` row (stats JSON-parsed).

### Run sequence

1. Insert a `sync_runs` row (`status='running'`).
2. `fetchAccessibleResources()`. **Site guard:** if the active `cloud_id` is
   not among the returned sites (e.g. the demo org is active, or access was
   lost), switch to `sites[0].id` and persist it. No site → error.
3. **Metadata phase** (`phase='metadata'`):
   - `GET /api/3/field` → upsert `fields`.
   - `GET /api/3/issuetype` → upsert `issue_types`
     (`hierarchy_level = t.hierarchyLevel ?? (subtask ? -1 : 0)`).
   - `GET /api/3/status` → upsert `statuses` with `statusCategory.key`.
   - `GET /api/3/project/search` paginated `startAt`/50,
     `expand=lead,description,projectKeys` → upsert `projects`.
   - **Field discovery** (case-insensitive name match over `fields`):
     - story points: any of `story points`, `story point estimate`, `story point`
       (keep *all* matching ids; when reading an issue use the first that holds
       a number);
     - `epic link` → single id or null; `parent link` → single id or null.
     Store result in config `field_ids`.
4. **Issue phase** (`phase='issues'`): target projects = config `sync_projects`
   (project keys) or all projects if empty (route refuses empty selection —
   see §9). For each project:
   `jql = project = <id> [AND updated >= "<watermark>"] ORDER BY created ASC`
   (watermark only in incremental mode, from config `last_issue_sync`).
   Fields requested = base list + discovered ids:

   ```
   summary, status, statuscategorychangedate, issuetype, project, assignee,
   reporter, created, updated, resolutiondate, resolution, priority, parent,
   labels, components, timeoriginalestimate, timespent, aggregatetimespent,
   issuelinks
   ```

   Each page is stored in one transaction. Issue mapping (`storeIssuePage`):
   - `story_points`: first numeric value among discovered story-point fields;
   - `parent_id`/`parent_key` from `fields.parent`; if absent, `parent_key`
     falls back to the Epic Link value (a string key) or Parent Link
     (string or `{key}`), leaving `parent_id` null for later resolution;
   - `hierarchy_level` looked up from `issue_types` by type id (fallback
     `subtask ? -1 : 0`);
   - `time_spent = aggregatetimespent ?? timespent ?? null`;
   - `labels`/`components` JSON-stringified; components mapped to names;
   - every `issuelinks` entry inserts up to two `issue_links` rows
     (`outwardIssue` → direction `outward`, `inwardIssue` → `inward`),
     `INSERT OR IGNORE`.
5. **Hierarchy closure** (`phase='hierarchy'`): up to **6 rounds**; each round
   selects `DISTINCT parent_key` values that have no matching issue row
   (`NOT EXISTS (… p.key = i.parent_key)`), fetches them **50 keys at a time**
   with `jql = key in ("K-1","K-2",…)` using the same field list and
   `storeIssuePage`. Stops early when nothing is missing. This pulls
   initiatives/parents living outside the selected projects.
6. **Parent resolution**: one SQL statement links key-only parents:

   ```sql
   UPDATE issues SET parent_id = (
     SELECT p.id FROM issues p
     WHERE p.cloud_id = issues.cloud_id AND p.key = issues.parent_key)
   WHERE cloud_id = ? AND parent_id IS NULL AND parent_key IS NOT NULL
   ```

7. **Changelog phase** (`phase='changelog'`): stale set =

   ```sql
   SELECT i.id FROM issues i
   LEFT JOIN changelog_cursor c ON c.cloud_id=i.cloud_id AND c.issue_id=i.id
   WHERE i.cloud_id=? AND (c.issue_updated IS NULL OR c.issue_updated <> i.updated)
   ```

   Process in batches of **500** ids via `fetchChangelogs`. For each issue:
   delete its old `status_history` and `assignee_history` rows, then re-insert
   from changelog items where `field`/`fieldId` is `status` (→ status_history
   with author) or `assignee` (→ assignee_history). Upsert `changelog_cursor`
   with the issue's current `updated`. Issues that returned no changelog still
   get a cursor row (so they are not refetched). Progress exposes
   `counts.changelogs` / `counts.changelogTotal` for the UI meter.
8. **Watermark**: `last_issue_sync = ISO(startedAt - 60_000)` formatted
   `YYYY-MM-DD HH:mm` (60 s slack for clock skew). Full mode clears the
   watermark *before* running (done in the route).
9. Finish: update the `sync_runs` row with `status='ok'` and stats
   `{issues, changelogs, projects, issuesInDb}`; on error/cancel set
   `status='error'|'cancelled'` and the message. `current = null` in `finally`.

---

## 8. Server: report algorithms

`server/src/reports.js`. Common helpers:

- `DAY = 86_400_000`; `placeholders(n)` → `"?,?,…"`; **every** `IN (...)`
  query is chunked at **900** ids (SQLite's default 999-variable limit);
- `dayKey(ts)` → `YYYY-MM-DD` (UTC, `toISOString().slice(0,10)`);
- `statusHistoryFor(cloudId, issueIds)` → `Map<issueId, rows[]>` of
  status_history ordered by `at ASC`, chunked.

### 8.1 `resolveScope({projects, roots, types, descendants=true, followLinks=false, cloudId})`

1. Seed ids: if `roots` (issue keys **or** ids) → match `key IN (…) OR id IN (…)`;
   else if `projects` (keys) → all issues in those projects; else all issues in
   the cloud.
2. If `descendants && roots.length`:
   - if `followLinks`: add `issue_links.target_id` where `direction='outward'`
     and source is a seed (one hop — how a Discovery idea reaches delivery);
   - then expand with a recursive CTE:

     ```sql
     WITH RECURSIVE tree(id) AS (
       SELECT id FROM issues WHERE cloud_id=@cid AND id IN (…seeds…)
       UNION
       SELECT c.id FROM issues c JOIN tree t ON c.parent_id = t.id
       WHERE c.cloud_id=@cid)
     SELECT id FROM tree
     ```

3. Load full rows (chunked), optionally filter by `types` (matches `type_name`
   or `String(hierarchy_level)`).
4. Returns `{cloudId, issues}` (raw DB rows).

### 8.2 Metrics

```js
METRICS = {
  count:     value: () => 1,
  points:    value: i => i.story_points || 0,
  timespent: value: i => (i.time_spent || 0) / 3600,   // hours
}
metricValue(issue, metric)  // falls back to count
```

### 8.3 `summarise(issues, metric)`

Totals by `status_category` (weighted by metric) and raw counts; returns
`{metric, total, issues, byCategory{new,indeterminate,done}, counts{...},
percentComplete (done/total*100), percentInProgress, points (sum), hours
(sum/3600), estimatedCoverage (% of issues with points>0), assignees (distinct
assignee_id), unassigned}`.

### 8.4 `cumulativeFlow({issues, cloudId, from, to, groupBy='status'|'category', metric})`

**Verbatim implementation: Appendix A.1.**
Reconstructs a per-day stacked series of how much work sat in each status.

1. Load history for all issue ids; load `statuses` meta for name/category.
2. Label function: `groupBy='category'` → `To do | In progress | Done` from the
   status category; else status name (fallbacks: history's stored string,
   `'Unknown'`).
3. **Event building** per issue (skip if metric weight `w` is 0 or no created):
   - the issue *enters* at `created` in the status its **first transition came
     from** (or its current status if no history): push `{t: created, label, +w}`;
   - each transition at `t = max(at, created)` to a *different* label pushes
     `{t, prevLabel, -w}` and `{t, nextLabel, +w}`.
4. **Workflow ordering** is learned, not configured: for every label record the
   mean index at which it appears in issues' transition sequences (entry
   status = index 0) plus its status category. Sort labels by
   `categoryRank (new=0, indeterminate=1, done=2)` then mean index. This yields
   e.g. `To Do | In Progress | In Review | QA | Done`.
5. **Sweep**: sort events by time; for each UTC day from
   `floor(start/DAY)*DAY` to `end` (start = `from` or min event; end = `to` or
   `max(maxEvent, now)`), apply all events with `t <= day+DAY-1` to a running
   tally, then snapshot `{date, [label]: max(0, round3(value))…}`.
6. Trim leading all-zero days. Return
   `{series, keys: orderedLabels, order, groupBy, metric, empty}`.

### 8.5 `buildTree({issues, metric, rootIds})`

Builds nested nodes (`id, key, summary, type, level, status, category,
assignee, project, points, hours (time_spent/3600), created, resolved, children[]`).
Parent = `parent_id` within the set; nodes whose parent is absent are roots.
Post-order rollup per node:

- leaf: `total = own` (own = 1 | points | hours per metric); `done = own` if
  category done; `inProgress = own` if indeterminate; `leaves = 1`;
  `leafDone = 1` if done.
- parent: sum of children; **if the children sum to 0 but the node's own value
  is > 0** (e.g. an epic of unestimated stories under `points`), use the own
  value as total (done if the node itself is done).
- rollup fields: `{total, done, inProgress, todo=max(0,total-done-inProgress),
  leaves, leafDone, percent=done/total*100, countPercent=leafDone/leaves*100}`.

Roots sorted by `rollup.total` desc then key.

### 8.6 `sankey({issues, dimensions, metric, maxPerColumn=12})`

**Verbatim implementation: Appendix A.4.**
Dimension definitions (key → node id + display name per issue):

| key | id | name |
|---|---|---|
| `assignee` | accountId or `unassigned` | display name or `Unassigned` |
| `reporter` | accountId or `unknown` | display name |
| `project` | project_key | project_key |
| `status` | `s:<status_id>` | status name |
| `category` | `c:<category>` | `To do`/`In progress`/`Done` |
| `type` | `t:<type_id>` | type name |
| `priority` | `p:<priority>` | priority |
| `epic` | `epic:<ancestorId>` | `KEY summary` (60 chars) — nearest ancestor at hierarchy level **exactly 1**; missing → `epic:none` "No epic" |
| `initiative` | ditto at level **≥ 2** (`orAbove`) | ditto |

Algorithm: use ≤ 4 valid dimensions (≥ 2 required). For every issue with
weight `w`, resolve its node per column; accumulate per-column totals; per
column keep the top `maxPerColumn` by total and fold the rest into a
`<dim>:__other__` node named `Other (n)`. Node ids are **namespaced by column**
so identical names in different columns stay distinct. Links aggregate weights
between adjacent columns. Returns `{nodes:[{id,name,column,dimension,value,key?}],
links:[{source,target,value}], dimensions, metric, truncated}`.

Ancestor helpers (used by sankey + cycletime): walk `parent_id` chains through
a `Map(id → issue)` with a visited-set cycle guard;
`nearestAncestorAtLevel(issue, byId, level)` returns the first ancestor whose
level equals `level` (abort if a higher level is passed);
`ancestorAtOrAbove(...)` returns the first ancestor with `level >= target`.

### 8.7 `peopleBreakdown({issues, metric})`

Group by assignee (`unassigned` bucket included):
`{id, name, avatar, total, done, inProgress, todo, issues, points, hours}`,
sorted by total desc.

### 8.8 `throughput({issues, weeks=12})`

Weekly buckets keyed by **UTC Monday** (`(getUTCDay()+6)%7` subtracted).
Pre-create the last N weeks (zero-filled), then for each issue with `resolved`
add `count += 1`, `points += story_points||0` into its week (ignore weeks
outside the window). Returns `[{week: 'YYYY-MM-DD', count, points}]`.

### 8.9 `chordFlows({issues, cloudId, flow='handovers'|'projects', maxEntities=8})`

**Verbatim implementation: Appendix A.3.**

- Keys joining two names use the separator `'\u0000'` **written as the escape
  sequence in source** (names contain spaces; never use a raw NUL byte in the
  file — see §20).
- `handovers`: `SELECT from_name a, to_name b, COUNT(*) n FROM assignee_history
  WHERE from_id IS NOT NULL AND to_id IS NOT NULL AND issue_id IN (scope)` —
  grouped. `projects`: join `issue_links` (direction `outward`, source in
  scope) to source/target issues, group by project-key pair.
- Drop self-flows. Rank entities by total involvement (in + out); keep the top
  8; re-map the rest to `Other` and re-aggregate; **drop flows that became
  self-flows after folding** (Other→Other).
- Return `{flow, entities:[{id,name,total}] (+ {id:'Other', name:'Other (n)',
  total:0} when truncated), flows:[{source,target,value}], truncated}`.

### 8.10 `cycleTime({issues, groupBy='epic'|'assignee'|'project'})`

Only issues with `resolved`, `created`, and `hierarchy_level <= 0`.
`days = (resolved - created)/DAY` (skip negatives/NaN). Group name: epic =
nearest level-1 ancestor `KEY summary` (else `No epic`); assignee name or
`Unassigned`; project key. Per group with **n ≥ 2** compute, on the sorted
array, linearly interpolated quantiles:

```js
quantile(sorted, p): idx=(len-1)*p; lo=floor, hi=ceil
  → sorted[lo] + (sorted[hi]-sorted[lo]) * (idx-lo)
```

Return `{groupBy, rows:[{name,n,p50,p90,min,max,mean}]}` sorted p50 desc
(slowest first).

### 8.11 `graphData({issues, includeStories=false, maxStories=120})`

Static network. Nodes: `hierarchy_level >= 1` or `type_name === 'Idea'`;
optionally + level-0 stories whose parent is a node (capped, excess counted in
`storiesDropped`). Rollups: for each leaf-ish issue (level < 1) walk its parent
chain; every ancestor that is a node accumulates `{leaves+1, done+1 if done,
points+story_points}`. Node payload: `{id,key,summary,type,level,project,
category,assignee,leaves,done,points}`. Edges: parent edges inside the node
set + outward `issue_links` rows whose both endpoints are nodes
(`{source,target,kind:'parent'|'link',label:type}`).

### 8.12 `burnup({issues, cloudId, metric, from})`

**Verbatim implementation: Appendix A.2.**
The time-story engine. **Leaves only**: exclude any issue that is some
in-scope issue's parent (`parents = Set(parent_id)`).

Per leaf with weight `w` and `created`:

- `scopeEvents.push({t: created, w})`.
- Category timeline from history: start category = first transition's *from*
  category (else current); each transition to `done` from non-done pushes
  `doneEvents {t, +w}` (record `firstDone` on the first); each transition off
  `done` pushes `{t, -w}`; `t = max(at, created)`.
- If the walk never reached done but the issue's current category **is** done
  (missing final hop): push `+w` at `resolved ?? status_changed ?? created`
  and set `firstDone`.

Sweep both sorted event lists over UTC days from the earliest creation to now
(two cursors), snapshotting `{date, scope, done: max(0, done), pct:
done/scope*100}` — but only **emit** days `>= from` (the cumulative state is
always computed from the true beginning so a windowed chart starts at the
correct level, not zero). Round to 2 decimals. If the series exceeds **400**
points, thin it: keep every `ceil(len/400)`-th point plus the last.

Weekly buckets (UTC Mondays, same formula as throughput), only events
`>= from`: `added += w` at `created`; `completed += w` at `firstDone`.

Return `{metric, series, weekly:[{week,added,completed}]}` or
`{series:[],weekly:[],empty:true}`.

### 8.13 `graphTimeline({issues, cloudId, maxStories=250})`

Temporal network payload. Node set: all level ≥ 1 + Ideas, plus the first
`maxStories` level-0 non-Idea stories ordered by `created` asc (excess →
`storiesDropped`). Per node: `created` (epoch ms), `initial` category (first
transition's *from* category, else current), `transitions:[{at: ms, cat}]`
(consecutive duplicates dropped; `at = max(at, created)`); if no history but
current differs from initial, synthesize one transition at
`status_changed ?? created`. Edges as in 8.11.

---

## 9. Server: HTTP API

`server/src/routes.js`. Every handler is wrapped:
`wrap(handler)` catches, maps `err.status` in 400..599 else 500, responds
`{error: message}`. Query helper `csv(v)` splits comma lists.
`scopeFrom(query)` → `resolveScope({projects: csv, roots: csv, types: csv,
descendants: query.descendants !== 'false', followLinks:
query.followLinks === 'true'})`.

**Shared scope query params** accepted by every `/reports/*` endpoint:
`projects`, `roots`, `types` (CSV), `descendants`, `followLinks`, `metric`
(`count|points|timespent`), plus endpoint-specific ones below.

| Method & path | Params / body | Response (shape) |
|---|---|---|
| GET `/api/auth/status` | — | authStatus() (§5) |
| POST `/api/auth/credentials` | `{clientId?, clientSecret?, redirectUri?, scopes?}` | authStatus() |
| GET `/api/auth/login` | — | 302 → Atlassian authorize URL |
| GET `/api/auth/callback` | `code`, `state`, `error?` | 302 → `${WEB_ORIGIN}/settings?connected=1` or `?error=…`; validates state, exchanges code, fetches sites |
| POST `/api/auth/disconnect` | — | authStatus() |
| GET `/api/sites` | — | `{sites: rows, active}` |
| POST `/api/sites/refresh` | — | `{sites, active}` (live fetch) |
| POST `/api/sites/select` | `{cloudId}` | `{active}` |
| GET `/api/projects` | — | `{projects: rows + issue_count subquery, selected}` |
| POST `/api/projects/select` | `{keys: []}` | `{selected}` |
| POST `/api/sync` | `{mode: 'full'\|'incremental'}` | 409 if running; full clears watermark; fire-and-forget `runSync`; `{started, mode}` |
| GET `/api/sync/status` | — | syncStatus() (§7) |
| POST `/api/sync/cancel` | — | `{cancelled: bool}` |
| GET `/api/catalog` | — | `{ready, levels:[{level,name,n}], statuses:[{name,category,n}], projects:[{key,name,type_key,n}] (n>0 via subquery-in-subselect — **not** bare HAVING, see §20), totals:{issues,newest}, metrics, dimensions}` |
| GET `/api/roots` | `level` (`2`,`1`,number, `idea`, `any`), `q` substring, `limit` ≤ 1000 (default 300) | `{roots:[{id,key,summary,type_name,hierarchy_level,status_name,status_category,project_key,project_type,child_count}]}` ordered child_count desc, key; `idea` filters `projects.type_key='product_discovery'` |
| GET `/api/reports/summary` | scope + `weeks` | summarise() + `throughput` array |
| GET `/api/reports/cfd` | scope + `from`,`to`,`groupBy`,`leavesOnly` | cumulativeFlow(); `leavesOnly=true` first removes issues that are parents of in-scope issues (Set membership, O(n)) |
| GET `/api/reports/tree` | scope | `{tree, issueCount}` |
| GET `/api/reports/sankey` | scope + `dimensions` CSV, `maxPerColumn` ≤ 24 (default 12) | sankey(); default dims `assignee,epic,category` |
| GET `/api/reports/people` | scope | `{people}` |
| GET `/api/reports/issues` | scope + `limit` ≤ 5000 (default 500) | `{total, issues:[...]}` sorted `updated` desc; row fields: key, summary, type, level, status, category, assignee, project, points, hours, created, updated, resolved, parent |
| GET `/api/reports/chord` | scope + `flow` (`handovers`\|`projects`), `maxEntities` ≤ 8 | chordFlows() |
| GET `/api/reports/cycletime` | scope + `groupBy` | cycleTime() |
| GET `/api/reports/graph` | scope + `includeStories`, `maxStories` ≤ 300 | graphData() |
| GET `/api/reports/burnup` | scope + `from` | burnup() |
| GET `/api/reports/graph-timeline` | scope + `maxStories` ≤ 500 | graphTimeline() |
| GET `/api/dashboards` | — | `{dashboards:[{id,name,updatedAt}]}` ordered by name |
| GET `/api/dashboards/:id` | — | `{id,name,layout,updatedAt}` (layout JSON-parsed); 404 if missing |
| POST `/api/dashboards` | `{name?, layout?}` | created dashboard (name default `Untitled dashboard`) |
| PUT `/api/dashboards/:id` | `{name?, layout?}` | updated dashboard (partial update; empty name keeps old) |
| DELETE `/api/dashboards/:id` | — | `{ok:true}` |
| GET `/api/site-url` | — | `{url}` of active site (null suppresses deep links in the UI) |

The sync route refuses to run with an empty computed project list
(`'No projects selected to sync'` comes from the engine when selection matches
nothing).

---

## 10. Frontend: design tokens & theming

### Theme mechanism (three states)

- The viewer's explicit choice stamps `document.documentElement.dataset.theme =
  'dark' | 'light'`; "Auto" removes the attribute and defers to
  `prefers-color-scheme`.
- `web/index.html` runs a **pre-paint inline script** so there is no flash:

  ```html
  <script>
    try { var t = localStorage.getItem('theme')
      if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t
    } catch (e) {}
  </script>
  ```

- `theme.css` defines the full light palette on bare `:root`; redefines dark
  under `@media (prefers-color-scheme: dark) { :root:where(:not([data-theme='light'])) { … } }`
  (the `:where(:not(...))` guard lets an explicit light stamp beat OS-dark
  without specificity problems), and **again** under `:root[data-theme='dark']`
  so the toggle wins both ways. The dark block is duplicated verbatim in both
  scopes.

### Complete token tables

Categorical series (fixed slot order — this order passed CVD validation; do
not reorder):

| Slot | Light | Dark |
|---|---|---|
| `--series-1` | `#2a78d6` | `#3987e5` |
| `--series-2` | `#eb6834` | `#d95926` |
| `--series-3` | `#1baf7a` | `#199e70` |
| `--series-4` | `#eda100` | `#c98500` |
| `--series-5` | `#e87ba4` | `#d55181` |
| `--series-6` | `#008300` | `#008300` |
| `--series-7` | `#4a3aa7` | `#9085e9` |
| `--series-8` | `#e34948` | `#e66767` |

Blue ramp (sequential/ordinal source; mode-invariant):

| Var | Hex | Var | Hex |
|---|---|---|---|
| `--blue-100` | `#cde2fb` | `--blue-450` | `#2a78d6` |
| `--blue-150` | `#b7d3f6` | `--blue-500` | `#256abf` |
| `--blue-200` | `#9ec5f4` | `--blue-550` | `#1c5cab` |
| `--blue-250` | `#86b6ef` | `--blue-600` | `#184f95` |
| `--blue-300` | `#6da7ec` | `--blue-650` | `#104281` |
| `--blue-350` | `#5598e7` | `--blue-700` | `#0d366b` |
| `--blue-400` | `#3987e5` | | |

Chrome & ink:

| Var | Light | Dark |
|---|---|---|
| `--surface-1` (cards/charts) | `#fcfcfb` | `#1a1a19` |
| `--surface-2` (sidebar) | `#f9f9f7` | `#131312` |
| `--page` | `#f9f9f7` | `#0d0d0d` |
| `--text-primary` | `#0b0b0b` | `#ffffff` |
| `--text-secondary` | `#52514e` | `#c3c2b7` |
| `--text-muted` | `#898781` | `#898781` |
| `--gridline` | `#e1e0d9` | `#2c2c2a` |
| `--axis` | `#c3c2b7` | `#383835` |
| `--border` | `rgba(11,11,11,0.10)` | `rgba(255,255,255,0.10)` |
| `--hover-wash` | `rgba(11,11,11,0.04)` | `rgba(255,255,255,0.06)` |
| `--selected-wash` | `rgba(42,120,214,0.10)` | `rgba(57,135,229,0.16)` |
| `--accent` | `var(--blue-450)` | `var(--blue-400)` |
| `--delta-good` | `#006300` | `#0ca30c` |
| `--status-good/warning/serious/critical` | `#0ca30c` / `#fab219` / `#ec835a` / `#d03b3b` (both modes) |
| `--meter-done` | `var(--blue-700)` | `var(--blue-600)` |
| `--meter-progress` | `var(--blue-450)` | `var(--blue-350)` |
| `--meter-track` | `var(--blue-250)` | `var(--blue-100)` |
| `--radius` | `10px` | — |
| `--shadow` | `0 1px 2px rgba(11,11,11,0.05)` | `none` |

Font: `system-ui, -apple-system, 'Segoe UI', sans-serif` everywhere, 14px base.
`color-scheme: light` / `dark` is set alongside the tokens so native controls
(range inputs, resize handles) match.

---

## 11. Frontend: palette module & colour rules

`web/src/lib/palette.ts`.

**Rules enforced throughout (do not violate):**

1. Categorical hues are assigned in fixed slot order **keyed by entity id**,
   never by rank — filtering must not repaint surviving series. Never generate
   a 9th hue; fold into "Other" (drawn `var(--axis)` grey).
2. Ordered/stage data (status bands, done/in-progress/todo, p50/p90) uses the
   **single-hue ordinal blue ramp**, darkest = most done. In **light mode the
   ramp maxes out at 5 steps** — a 6th cannot keep both monotone lightness gaps
   and surface contrast — so anything beyond 5 folds.
3. Text never wears a series colour; identity comes from a coloured mark
   beside text. The one exception: a label **inside** a coloured fill picks
   white/ink by computed luminance (`inkOn`).
4. Every chart with ≥ 2 series shows a legend; single-series charts show none
   (the card title names it). Every chart has a table-view twin.
5. Counts get integer axis ticks only.

Exports:

- `CATEGORICAL_SLOTS = 8`, `MAX_ORDINAL_STEPS = 5`.
- `seriesVar(i)` → `var(--series-${(i % 8) + 1})`.
- `isDark()` — `data-theme` stamp wins; else `matchMedia('(prefers-color-scheme: dark)')`.
- `ordinalRamp(n, dark = isDark())` — clamped 1..5, returns CSS var refs
  lightest→darkest:

  | n | light | dark |
  |---|---|---|
  | 1 | 450 | 400 |
  | 2 | 250, 700 | 100, 600 |
  | 3 | 250, 450, 700 | 100, 350, 600 |
  | 4 | 250, 400, 550, 700 | 100, 250, 400, 600 |
  | 5 | 250, 350, 450, 550, 700 | 100, 200, 300, 450, 600 |

- `makeColorScale(ids)` — assigns slots in the given (ranked) order, returns
  `(id) => cssVar`, unknown id → `var(--text-muted)`.
- `resolve(color)` — resolves a `var(--x)` reference to hex via
  `getComputedStyle(document.documentElement)`.
- `inkOn(color, alpha=1)` (verbatim: Appendix A.7) — for in-fill labels: parse fill + surface hex,
  alpha-composite fill over surface, compute WCAG relative luminance
  (sRGB linearisation, threshold 0.04045, coefficients .2126/.7152/.0722),
  return `#ffffff` if `1.05/(L+.05) >= (L+.05)/.05` else `#0b0b0b`.
- `CATEGORY_LABEL = {new:'To do', indeterminate:'In progress', done:'Done'}`.

---

## 12. Frontend: shared UI components

`web/src/lib/format.ts`:

- `compact(n)` — `≥1M → x.xM`, `≥10K → x.xK`, else localized, ≤ 1 decimal;
- `full(n)` — localized, ≤ 2 decimals; `pct(n, digits=0)` → `"62%"`;
- `metricLabel(m)` → `issues|points|hours`; `formatMetric` appends `h` for
  timespent; `shortDate` (`Mar 4`), `longDate` (`Mar 4, 2026`);
- `relative(ts)` → `just now | 5m ago | 3h ago | 2d ago | never`;
- `duration(ms)` → `45s | 3m 20s`.

`web/src/components/ui.tsx`:

- **Card** `{title?, sub?, actions?, loading?, children}` — section.card;
  header row with h2 + `.sub` + actions; **`loading` dims `.card-body` to
  opacity 0.45** (refetch keeps the previous render — no skeletons, ever).
- **StatTile** `{label, value, detail?, good?}` — big proportional-figure value
  (no `tabular-nums` on display numbers).
- **Meter** `{done, inProgress=0, total, showLabel=true}` — flex track
  (`--meter-track`) with two fills (`--meter-done`, `--meter-progress`),
  `role="img"` aria-label with both percentages, optional right-aligned % text.
- **Tooltip** `{x, y, title, rows:[{name,value,color?}], total?}` —
  `position:fixed` at pointer + 14px offset; measures itself and **flips**
  left/up when it would overflow the viewport. Row layout: 12×2px colour key,
  then **value first (bold), name second** — the legend's hierarchy inverted.
  Values inserted as text (React escapes; never innerHTML).
- **Legend** `{items:[{id,label,color}], hidden?, onToggle?, shape:'rect'|'line'}` —
  returns null for < 2 items; buttons with `aria-pressed`; hidden items at
  opacity 0.42. CSS keeps non-interactive legends at full opacity
  (`.legend-item:disabled { opacity: 1 }`).
- **TableToggle** — segmented Chart|Table.
- **Empty** `{title, children}`; **Banner** `{kind: info|warn|error, title,
  children, actions}` — left border colour by kind.
- **ResizableBody** `{storageKey, defaultHeight, min=160, max=1100,
  children:(h)=>ReactNode}` — the resizable card body (verbatim: Appendix
  A.8). Implementation contract:
  - localStorage key `jira-reports.size.${storageKey}`; initial height =
    stored (validated within min/max) else default;
  - the element gets CSS `resize: vertical; overflow: hidden` and inline
    `height` set **once from a ref captured at mount** (never re-applied from
    state — the browser owns the height after the user drags, and re-applying
    would fight the native resize);
  - a ResizeObserver reports the live height; changes > 2px update state and
    persist; the render-prop children receive the live height and must fit
    within it (each call site subtracts a slack constant for legends/controls).
- **useMeasure<T>()** — `{ref, width}` via ResizeObserver, initial width 720,
  updates when |Δ| > 1px.
- **useThemeVersion()** — increments on `prefers-color-scheme` change or
  `data-theme` attribute mutation (MutationObserver); charts depend on it so
  memoised colour closures re-read CSS vars after a theme flip.

`web/src/components/Picker.tsx`:

- **Picker** `{label, options:[{value,label,sub?,count?}], selected, onChange,
  multiple=true, placeholder, emptyText, width=230, onSearch?, loading?}` —
  button showing `placeholder | single label | "N selected"`, popover
  (absolute, z-40, min 300px) with a search input (debounced **220 ms** into
  `onSearch` if provided, else local substring filter), checkbox/radio rows,
  count column, Clear button. Closes on outside mousedown or Escape.
- **Select** — labelled native `<select>`.

---

## 13. Frontend: scope context & data fetching

`web/src/lib/api.ts`: `api.get/post/put/del` over `fetch('/api'+path)`;
query params skip empty values; non-OK throws `ApiError(status, message from
{error} body)`. All response types are declared here — **the complete file is
given verbatim in Appendix A.11**; do not invent alternative shapes.

`web/src/lib/scope.tsx`:

```ts
type Scope = {
  projects: string[]         // project keys
  roots: string[]            // issue keys
  followLinks: boolean       // set when roots are Discovery ideas
  metric: 'count'|'points'|'timespent'
  range: 'all'|'30d'|'90d'|'180d'|'365d'
}
DEFAULT = { projects:[], roots:[], followLinks:false, metric:'count', range:'90d' }
```

- Persisted to localStorage `jira-reports.scope` on every change.
- `rangeStart(range)` → ISO date `now - {30,90,180,365}d` or undefined.
- `params` memo: `{metric, projects?, roots?, followLinks?: 'true', from?}` —
  `followLinks` only when roots are set.
- Context value: `{scope, setScope(patch), resetScope, params, revision,
  reload, catalog, refreshCatalog, sync, startSync(mode), cancelSync,
  syncError, siteUrl}`.
- **Sync polling**: one status fetch on mount/revision; while `running`,
  re-poll every **700 ms**; on the running→stopped edge, surface
  `last.error` if failed, refresh the catalog, and bump `revision` (which
  makes every mounted report refetch).
- `useReport<T>(path, extra?)` (verbatim: Appendix A.9) — fetches `path` with `{...params, ...extra}`
  (so per-widget overrides win), keyed on `JSON.stringify([path, params,
  extra, revision])`. **Holds previous data while loading** (`loading` drives
  the Card dimming); cancelled with a closure flag on unmount.

`web/src/components/ScopeBar.tsx` — the single filter row (sticky, top 0,
z-20), rendered above every page except Settings:

1. **Projects** Picker (options from catalog, counts = cached issues).
2. **Report on** Select: `2 Initiatives | 1 Epics | idea Ideas (Discovery) |
   any Anything` (local state, default `2`).
3. **Selection** Picker — server-searched via `/roots?level&q&limit=200`
   (refetches when catalog changes); `onChange` sets
   `{roots, followLinks: level === 'idea'}`.
4. **Measure** Select (count/points/timespent).
5. **Window** Select (30/90/180/365/all).
6. Right side: sync status — running: spinner pill with `sync.message` +
   Stop; idle: `Synced 5m ago` + primary **Refresh** button
   (`startSync('incremental')`).

---

## 14. Frontend: chart components

Shared conventions for every SVG chart:

- Root `<svg class="chart" viewBox="0 0 {w} {height}">` where `w` comes from
  `useMeasure` (min-width clamps below); CSS `width:100%; height:auto` keeps
  the aspect; wide charts sit in `.chart-wrap { overflow-x: auto }`.
- Margins object `M = {top,right,bottom,left}`; inner `iw/ih`.
- Gridlines/axes: 1px solid `.grid-line` (`--gridline`) / `.axis-line`
  (`--axis`); tick text 11px `--text-muted`, `tabular-nums` class on numeric
  ticks only.
- Marks: bars ≤ 24px thick with 4px rounded **data end** and square baseline;
  lines 2px round cap/join; dots ≥ 8px diameter with **2px surface-colour
  ring**; stacked/touching fills separated by a **2px surface gap** (stroke or
  width-2), never a dark outline.
- Direct labels are selective (an endpoint, a peak, the total) — never every
  point; identity text uses text tokens.
- Tooltips: value-first rows (§12); crosshair on time charts snaps to nearest
  X; on bar/cell charts the mark (with padding) is the hit target; hit areas
  exceed the painted mark.
- Theme changes: colour closures memoised with `useThemeVersion()` in deps.

### 14.1 CumulativeFlow (`charts/CumulativeFlow.tsx`)

(Fold + colour/stack code verbatim: Appendix A.5.)
Props `{data: Cfd, metric, height=340}`. Constants
`M={top:10,right:96,bottom:30,left:52}` (right holds end labels), min width 360.

- **Fold**: if `keys.length > 5` keep the 4 largest by total area (sum over
  series), preserve workflow order, insert one `Other (n)` key at the position
  of the first folded status; the folded names are listed in a note under the
  chart. Rows become `{date: Date, values: number[]}` aligned to folded keys.
- **Stack**: `d3.stack` over the folded keys **reversed** (workflow end first)
  minus hidden keys, so **Done sits at the bottom in the darkest step**;
  colours from `ordinalRamp(keys.length)` reversed (darkest→bottom band).
- Areas: `d3.area` curveLinear, `stroke: var(--surface-1)` width 2 (the gap
  between bands).
- Y: linear, `.nice(5)`, 5 gridlines with `compact` labels. X: `scaleUtc`,
  `ticks(clamp(floor(iw/140), 2, 6))`, `shortDate` labels.
- **End labels**: total (`{compact(total)}{unit} total`, bold, above the stack
  top) plus up to the 2 thickest bands whose final pixel height ≥ 16.
- **Hover**: full-plot transparent rect, `cursor:crosshair`; nearest day by
  binary search on the date array; vertical hairline + baseline dot; Tooltip
  lists every visible band (workflow-end first) with colour keys + a total
  row; pointer coords → svg coords via `getBoundingClientRect()` scaling.
  Keyboard: rect is focusable `role="application"`; ←/→ step days.
- **Legend**: all folded keys, toggleable; the toggle guard refuses to hide
  the last visible key (`next.size < keys.length - 1`).
- `CfdTable`: date rows (newest first), one column per key + Total.

### 14.2 SankeyChart (`charts/SankeyChart.tsx`)

Props `{data: SankeyData, metric, height?}`. Uses `d3-sankey`:
`nodeWidth 13, nodePadding 14, nodeAlign sankeyJustify`, extent
`[[12+130, 12], [w-12-150, height-12]]` — 130/150px gutters keep first/last
column labels inside the svg. `height = prop ?? max(300, maxNodesPerColumn*32
+ 24)`; min width 420. Layout inputs are **copies** (`{...n}`, `{...l}`) —
d3-sankey mutates.

- **Colour: first column only.** Ranked by value → `makeColorScale`; every
  other column's nodes are `var(--axis)`; links inherit the **source** colour
  at opacity 0.34 (0.08 when another node has hover-focus). Painting a link
  leaving a mid column would lie — it aggregates several sources.
- Node rect rx 3; separate transparent hit rect inflated 6/3px; hover/focus
  sets the focus id (dims unrelated links, others' nodes to 0.35), shows a
  tooltip (`value + metric name`), native `<title>` too.
- Labels when node height ≥ 12: first column → left of the node
  (`text-anchor:end`), others → right; truncate 20/22 chars; value appended in
  muted tspan (`compact`).
- Legend = first-column entities. `truncated` prints the "top 8 …" note.
- `SankeyTable`: From | To | value, sorted desc.

### 14.3 Icicle (`charts/Icicle.tsx`)

Props `{tree: TreeNode[], metric, onSelect?(key)}`. Horizontal icicle
(root→leaves left→right). Constants `ROW_H 26, GAP 2, M {4,8,4,8}`, column
width `max(90, innerW/maxDepth)`, height `max(180, min(760, leafCount*26))`.

- Build `d3.hierarchy` from a synthetic root `{id:'__root__'}` over the tree;
  `sum()` counts **leaves only** (parents contribute 0) using the metric;
  sort by value desc.
- **Partition quirk**: `d3.partition` gives the (invisible) root its own
  column — lay out with `(columns+1) * colW` and translate the group left by
  one `colW` so the first visible column is depth 1. (Without this the chart
  opens on an empty column.)
- Cell rect: swap partition axes (x0↔y for vertical position); rx 3;
  `fill = colour of the cell's top-level ancestor` (walk parents until the
  child of `__root__`); `opacity = 0.25 + 0.75 * (1 / (1 + (depth -
  focusDepth - 1) * 0.55))` (deeper = lighter); 2px gaps via `size - GAP`.
- Label only when `cellH ≥ 13 && cellW ≥ 58`; char budget
  `floor((cellW-12)/6.2)`; **ink from `inkOn(fill, opacity)`** so text always
  clears contrast inside the wash. Never clip text — skip it.
- Interactions: click (or Enter/Space — cells are focusable) on a branch
  zooms (`focusId`, with a "← Back to all" row); on a leaf calls
  `onSelect(key)` (pages use it to set the scope root). Hover tooltip:
  % of scope, % complete, total, status.
- Legend: top-8 top-level items by rollup total; beyond 8 drawn grey with an
  explanatory note.

### 14.4 BreakdownBars (`charts/BreakdownBars.tsx`)

Props `{rows:[{id,name,sub?,done,inProgress,todo}], metric, max?}`.
Constants `ROW_H 30, BAR_H 18, M {6,74,24,190}`; min width 420.

One horizontal stacked bar per row, segments Done → In progress → To do,
colours `ordinalRamp(3)` with **done darkest** (`ramp[2], ramp[1], ramp[0]`).
Shared linear x domain = max row total. 2px surface gaps by drawing each
segment `width - 2`. Right of each bar: `compact(total)` + muted `pct(done)`.
Row label left, truncated at 26 chars. Whole row is a hover/focus target →
tooltip with all three values + total. Legend of the three stages.

### 14.5 ThroughputBars (`charts/ThroughputBars.tsx`)

Props `{data:[{week,count,points}], field:'count'|'points', height=158}`.
`M {20,12,26,40}`, band scale padding 0.32, bar width ≤ 24, bars drawn with a
`roundedTop` path (4px radius at the top, square at the baseline):

```
M x,y+h L x,y+r Q x,y x+r,y L x+w-r,y Q x+w,y x+w,y+r L x+w,y+h Z
```

Y ticks: 3, **filtered to integers when field='count'** (never offer “1.5
issues”). Single series → no legend. Direct label on the **peak bar only**.
X labels every `ceil(n/6)` weeks. Full-height transparent hit columns →
tooltip with both count and points.

### 14.6 ChordChart (`charts/ChordChart.tsx`)

Props `{data: ChordData, unitLabel='handovers', height?}`. Square side
`max(340, min(width, height ?? 560))`; `outer = side/2 - 98` (label margin),
`inner = outer - 13`.

- Matrix: entities indexed in server order; `matrix[src][tgt] = value`.
- Layout `d3.chordDirected().padAngle(12/inner).sortSubgroups(d3.descending)`.
  **The returned array carries a `groups` property** — access it as
  `(chords as unknown as {groups: d3.ChordGroup[]}).groups`.
- Ribbons: `d3.ribbonArrow().radius(inner - 2).padAngle(1/inner)` — the
  arrowhead lands on the receiver (this is what makes it *directional*).
  Fill = **source** entity colour, fillOpacity 0.62 (0.08 when unrelated to
  the focused entity), 1px surface stroke.
- Groups (arcs): `d3.arc().innerRadius(inner).outerRadius(outer)`; hover/focus
  sets the focused index; tooltip `total in + out`.
- Labels when arc angle > 0.06 rad: rotate to the arc's mid-angle —
  `rotate(deg-90) translate(outer+7,0)` + `rotate(180)`/anchor-end flip when
  `angle > π`; truncate 14 chars; 11px secondary ink.
- Colours: `makeColorScale` over non-Other entities (server rank order);
  `Other` → `var(--axis)`. Legend lists all entities; truncated note.
- `ChordTable`: From | To | unit, sorted desc.

### 14.7 DotPlot (`charts/DotPlot.tsx`) — cycle time

Props `{data: CycleTimeData, max?}` (max = row cap; page computes from card
height). `ROW_H 30, M {8,56,30,200}`; rows arrive slowest-first.

Dumbbell per row: line from `x(p50)` to `x(p90)` (2px, colour = light ramp
step), dot at p90 (r5, lightest) then dot at p50 (r5.5, darkest) — both with
2px surface rings, p50 drawn last so it wins overlaps. X linear `[0,
max(p90)].nice(5)`, ticks suffixed `d`, vertical gridlines. Row label + muted
`n`. Direct label only on the slowest row's p90 (`{round(p90)}d`). Rows are
focusable hover targets → tooltip p50/p90/min·max/n. Legend (shape 'line'):
Median (dark), 90th percentile (light). Colours `ordinalRamp(3)[2]` and `[0]`
— same measure at two depths, so one hue.

### 14.8 NetworkGraph (`charts/NetworkGraph.tsx`)

(Coordinate/drag/zoom code verbatim: Appendix A.10.)
Props `{data: GraphData, height=460}`. Static force layout; colour = project
(top-8 + grey), node size = rolled-up child work.

- Radii: level ≥ 2 → 22; level 1 → `clamp(8 + sqrt(leaves)*2, 10, 20)`;
  Idea → 9; story → 5.5.
- Simulation (built once per dataset in `useMemo`, node/edge objects copied):
  `forceLink` distance `link edge 90 | from level≥2 80 | else 46`, strength
  `link .25 | parent .6`; `forceManyBody -160`; `forceCollide r+6`;
  `forceX/Y` strength .05/.06 toward 0. Tick handler bumps a state counter
  (re-render reads mutated x/y). Cleanup calls `simulation.stop()`.
- Edges: parent = solid `--axis` 1.2px; link = dashed `4 3` `--text-muted`
  1.4px with an `auto-start-reverse` arrow marker
  (`viewBox 0 0 8 8, refX 7, path M0,0.6 L7.4,4 L0,7.4 Z`).
- Nodes: circle, 2px surface ring, done nodes at opacity 0.55; key label
  under level ≥ 1 and Idea nodes (10.5px secondary).
- **Drag pins**: pointerdown captures the pointer, sets
  `simulation.alphaTarget(0.25).restart()`, and writes `fx/fy` from pointer →
  sim coordinates:

  ```
  px = (clientX - rect.left)/rect.width * viewBoxW - viewBoxW/2
  sim = (px - transform.x) / transform.k        (same for y)
  ```

  pointerup keeps `fx/fy` (stays pinned; a small surface-colour dot marks
  pinned nodes); **double-click clears** `fx/fy` and reheats (alpha 0.3).
- **Zoom/pan**: `d3.zoom` on the svg, `scaleExtent [0.3, 4]`, with a `filter`
  that ignores mousedown on `[data-node]` (so node drag wins); transform kept
  in React state, applied to the inner `<g>` as
  `translate(w/2+tx, h/2+ty) scale(k)`.
- Legend = projects; hint text "Drag pins · double-click releases · scroll
  zooms"; storiesDropped note. Tooltip: summary, child issues + % complete
  (or state for leaves). `GraphTable`: From | contains/link-label | To.

### 14.9 TemporalGraph (`charts/TemporalGraph.tsx`)

(Membership + playback effects verbatim: Appendix A.10.)
Props `{data: TimelineGraphData, height=480}`. The playable replay. Colour =
**status category at time t** via `ordinalRamp(3)` (light→dark = todo→done);
project identity is deliberately not encoded (one colour budget per chart).

- Time extent `[min(created), Date.now()]`; state `t` initialised to the end.
- Controls row above the svg: Play/Pause button (restart from the beginning if
  pressed at the end); native `<input type=range>` (min/max = extent, step =
  span/500, `accentColor: var(--accent)`); readout
  `{longDate(t)} · {leafCount} stories, {doneCount} done` (leaves = level ≤ 0
  non-Idea among visible).
- Playback: `setInterval` 50 ms adding `span / (14000/50)` per tick
  (≈ 14 s sweep), auto-pause at the end. Scrubbing pauses.
- Radii: level ≥ 2 → 20; 1 → 13; Idea → 8; story → 5. Forces: link distance
  `link 85 | initiative-child 75 | else 38`, strength `.2/.55`; charge −110;
  collide r+5; forceX/Y .06/.07.
- **Membership effect** (the temporal core): visible = nodes with
  `created <= t`; on visible-count change, assign spawn positions to new nodes
  (beside their parent: `parent.x + (rand−.5)*24`), then
  `simulation.nodes(visible)`, `linkForce.links(visibleEdges)`,
  `alpha(0.35).restart()`. Node objects are stable across the whole lifetime,
  so positions persist as t moves both directions.
- `catAt(node)` walks `transitions` while `at <= t`, starting from `initial`.
- Same drag-pin/zoom mechanics as 14.8. Legend: To do / In progress / Done.
  Tooltip: summary, state **at this time**, created date.
- `TimelineTable`: key, type, created, transition list.

### 14.10 ProgressLine (`charts/ProgressLine.tsx`) — burn-up %

Props `{data: BurnupData, metric, height=300}`. `M {14,58,28,44}`.
Y fixed domain `[0,100]` with gridlines at 0/25/50/75/100 (`%` labels);
X `scaleUtc` over `series[].date`. One 2px `--series-1` line +
10%-opacity area wash; end dot (r4.5, surface ring) and **one** direct label:
final `pct` bold at the right margin. Crosshair hover (nearest date, linear
scan), keyboard ←/→; tooltip: complete %, done, in-scope (unit `h` for
timespent). Single series → no legend. `ProgressTable`: date, scope, done, %.

### 14.11 FlowInOut (`charts/FlowInOut.tsx`) — added vs completed

Props `{data: BurnupData, metric, height=260, variant:'bars'|'lines'}`.
`M {16,12,26,44}`; band x-scale over weeks, padding 0.3, bars ≤ 24px.

- **bars** (default): mirror around zero. Y domain `[-max, max].nice(4)`;
  added grows **up** in `--series-2` (orange, `roundedTop` path), completed
  grows **down** in `--series-1` (blue, `roundedBottom` path, offset 1px below
  zero); the zero baseline is drawn **after** the bars (it is the hinge of the
  story). Tick labels show absolute values.
- **lines**: Y domain `[0, max].nice(4)`; two 2px lines through week centres,
  end dots with surface rings; vertical hairline on hover; baseline at the
  bottom.
- Both variants: integer tick filter for count metric; shared full-height hit
  rect per week; tooltip added/completed + `net scope change` with sign;
  legend Added/Completed (swatch shape rect for bars, line for lines);
  x labels every `ceil(n/6)` weeks.
- `FlowInOutTable`: week, added, completed, net (signed).

### 14.12 Existing simple charts

**Meter** (§12) is the 12th visual: a stat, not a chart — no axes, value
always printed beside it.

---

## 15. Frontend: dashboard system

### 15.1 Grid engine (`dashboard/Grid.tsx`)

**Layout math verbatim: Appendix A.6.**
Constants `COLS 12, ROW_H 84, GAP 12`.
`type LayoutItem = {i, x, y, w, h}` (grid units).

```
collides(a,b) = a.i!==b.i && a.x<b.x+b.w && a.x+a.w>b.x && a.y<b.y+b.h && a.y+a.h>b.y
```

`resolveLayout(items, pinnedId)` — the whole interaction model:

1. Copy every non-pinned item, sort by `(y, x)`.
2. Greedy placement: for each item, while it collides with anything already
   placed (the pin is placed first), push it **down** (`y += 1`).
3. Upward compaction: re-sort placed items (pin excluded) by `(y, x)`; each
   floats up (`y -= 1`) while no collision with already-settled items
   (pin included).

`compactAll(items)` = the compaction pass alone (used after widget removal).
`nextFreeY(items)` = max `y + h` (placement row for a new widget; also the
grid's row count → container height `rows*ROW_H + (rows-1)*GAP`).

**DashGrid** `{layout, minSize(id)→{w,h}, onChange(next), onCommit(), render(item,
handles)}`:

- container `.dash-grid` `position:relative`, measured width →
  `cellW = (width - GAP*11)/12`.
- each item renders in an absolutely positioned `.widget` at
  `transform: translate(x*(cellW+GAP), y*(ROW_H+GAP))`, size
  `w*cellW+(w-1)*GAP × h*ROW_H+(h-1)*GAP`; CSS transitions transform/size
  140 ms, disabled on the dragged widget (`.dragging`, z-30, big shadow).
- drag begins on pointerdown (button 0) from the handles the page attaches
  (`onMoveDown` on the card header, `onResizeDown` on the corner); stores
  `{id, mode, startClientX/Y, orig}`; document-level pointermove converts the
  pixel delta to grid deltas (`round(dx / (cellW+GAP))`, `round(dy /
  (ROW_H+GAP))`), clamps (`x` to `0..COLS-w`, `w` to `min..COLS-x`, `h ≥
  minH`, `y ≥ 0`), and calls `onChange(resolveLayout(...))` only when the cell
  actually changed; pointerup → `onCommit()`. `body { user-select: none }`
  while dragging.

### 15.2 Widget registry (`dashboard/registry.tsx`)

`WidgetDef = {type, label, desc, w, h, minW, minH, fields: FieldDef[]}`;
`FieldDef = {key, label, kind:'select'|'text', choices?, placeholder?}`.

Common fields: `METRIC_FIELD` (select: '' inherit | count | points |
timespent) and `SCOPE_FIELDS` (`roots`, `projects` — comma-separated text
inputs; empty inherits the page filter row).

The catalog (defaults `w×h`, min `w×h`):

| type | label | default | min | extra fields |
|---|---|---|---|---|
| `stat` | Stat | 3×2 | 2×2 | kind: percent/issues/inprogress/points/people/unassigned |
| `cfd` | Cumulative flow | 6×5 | 4×4 | groupBy status/category |
| `throughput` | Throughput | 6×3 | 3×2 | field count/points |
| `top-items` | Top items | 6×4 | 4×3 | — |
| `people-load` | People load | 6×4 | 4×3 | — |
| `sankey` | Sankey | 8×5 | 5×4 | from/via('' skip)/to dimension selects |
| `chord` | Chord | 5×5 | 4×4 | flow handovers/projects |
| `cycletime` | Cycle time | 6×4 | 4×3 | groupBy epic/assignee/project |
| `graph` | Network | 8×5 | 5×4 | includeStories ''/true |
| `burnup` | Progress over time | 6×4 | 4×3 | — |
| `flow-io` | Added vs completed | 6×4 | 4×3 | style bars/lines |
| `issues` | Issue list | 6×4 | 4×3 | — |

(every type also gets METRIC_FIELD — except throughput/chord/cycletime/
graph/issues where metric is irrelevant or fixed — plus SCOPE_FIELDS.)

Helpers: `widgetDef(type)`; `defaultTitle(widget)` (stat uses the kind's
choice label); `bodyHeight(h) = h*84 + (h-1)*12 − 40 (header) − 20 (padding)`;
`widgetExtra(options)` maps `metric/projects/roots` options into request
params (overriding the scope via `useReport`'s extra merge);
`effectiveMetric(options, scopeMetric)`.

`WidgetBody({widget})` switches to one small component per type (each its own
function component so hooks stay legal). Chart height slacks (leave room for
legends/notes inside the tile):

| body | render |
|---|---|
| stat | percent → 30px value + meter; others → 30px value + contextual sub |
| cfd | `CumulativeFlow height=max(200, bodyHeight−76)`, always leavesOnly |
| throughput | `height=max(110, bodyHeight−36)` |
| top-items | tree top rows, count `max(3, floor((bodyHeight−46)/30))` |
| people-load | same row math, `max` prop |
| sankey | dims from options (dedup, ≥2), maxPerColumn 8, `height=max(240, bodyHeight−76)` |
| chord | `height=max(300, bodyHeight−90)` |
| cycletime | `max = max(3, floor((bodyHeight−60)/30))` |
| graph | `height=max(220, bodyHeight−64)` |
| burnup | `ProgressLine height=max(180, bodyHeight−24)` |
| flow-io | variant from options.style, `height=max(160, bodyHeight−60)` |
| issues | plain table, limit 60, summary truncated at 46 chars |

Every body renders `<Empty title=…/>` on missing/empty data.

### 15.3 Dashboards page (`pages/Dashboards.tsx`)

- localStorage `jira-reports.dashboard` remembers the active id.
- Header: dashboard `<select>`, Rename (modal + form), Delete, New dashboard,
  primary "+ Add widget".
- First dashboard is created with the **starter layout**:
  stat percent 0,0 3×2; stat issues 3,0 3×2; throughput 6,0 6×3;
  cfd 0,2 6×5; people-load 6,3 6×4.
- Widget ids: `crypto.randomUUID()` (fallback `w${Date.now()}${rand}`).
- Add: modal with a `.type-grid` of `.type-card` buttons (label + desc);
  new widget placed at `x:0, y:nextFreeY`, default size, options prefilled
  with each select field's first choice.
- Widget card chrome: `.widget-head` (drag handle = the whole header;
  title = `widget.title || defaultTitle`) with ⚙ (open editor) and ✕ (remove →
  `compactAll`) buttons that `stopPropagation` on pointerdown;
  `.widget-body { overflow:auto; maxHeight: bodyHeight+8 }`; `.resize-handle`
  18×18 bottom-right corner with a 7×7 two-border glyph.
- Editor modal: Title text input (placeholder = default title), the def's
  fields (selects/texts), note "Leave scope fields empty to inherit the filter
  row", Cancel/Save.
- Persistence: any layout/widget change updates local state immediately and
  debounce-PUTs the layout after **500 ms**. Layout position updates merge by
  widget id (`updateLayout` maps x/y/w/h back onto the full WidgetConfig list).
- Modal component: fixed backdrop rgba(0,0,0,.42) z-80, closes on backdrop
  click or Escape; panel `min(540px, 94vw)`, max-height 84vh.

---

## 16. Frontend: pages & navigation

`App.tsx` shell: CSS grid `232px 1fr`; sidebar (sticky, full height) with
brand mark (three blue bars syncing with the ramp), nav sections **Reports**
(Overview `/overview`, Dashboards `/dashboards`, Cumulative flow `/flow`,
Initiatives `/initiatives`, People & flow `/people`, Insights `/insights`,
Timeline `/timeline`, Explorer `/explorer`) and **Data** (Connection & sync
`/settings`); footer = ThemeToggle (Light/Auto/Dark segmented, §10) + cached
issue count. All icons are inline 15/16px SVGs (stroke currentColor 1.4–1.6).
Every non-Settings page renders under the ScopeBar. Unknown routes redirect to
`/overview`.

Pages that need data all follow: `if (!catalog?.ready && !sync?.running)
return <NoData/>` — a CTA pointing to Settings.

- **Overview**: hero card "Scope progress" (one hero figure: `pct(percentComplete)`
  ≈ 52px, sub `complete by {metric} — X of Y`, Meter, three dot-legend keys
  using the meter tokens); "Resolved per week" card (ThroughputBars in a
  ResizableBody `overview.throughput` default 160 min 110 max 480, chart h−6);
  four StatTiles (issues+done, in progress+%, people+unassigned, points+
  estimated coverage); "Largest items in scope" (top-8 tree roots as
  BreakdownBars, ResizableBody `overview.topitems` default `min(64+rows*30,
  360)`, rows `floor((h−64)/30)`; link → /initiatives).
- **CumulativeFlowPage**: one card; segmented By status | By progress;
  segmented Leaves | All (`leavesOnly`); TableToggle; ResizableBody `flow.cfd`
  default 400 min 240 (chart h−56). Empty state explains history/sync.
- **Initiatives**: Icicle card ("Share of work", click-to-zoom, leaf click
  sets scope root); Rollup card — collapsible tree rows (grid columns
  `18px 1fr 140px 92px`: twisty, key+summary+type pill, Meter, `pct · total`),
  expanded to depth 1 by default, keys deep-link to `{siteUrl}/browse/KEY`
  when a site url exists; TableToggle → flattened table (indented keys).
- **People**: 4 StatTiles (people with work, busiest first name + load,
  unassigned, median load); "Flow of work" Sankey card with From/Through
  ('— skip —')/To selects (dims deduped) + TableToggle + ResizableBody
  `people.sankey` 520/280 (h−90); "Load per person" BreakdownBars
  (ResizableBody `people.load` default `min(110+rows*30, 560)` min 170, rows
  `floor((h−64)/30)`) + a `<details>` full table of everyone.
- **Insights**: chord card (Flow select between people/projects, TableToggle,
  ResizableBody `insights.chord` 560/340, chart height h−100); cycle-time card
  (Group by select, ResizableBody `insights.cycletime` 560/220, rows
  `floor((h−96)/30)`); network card (segmented Epics & up | With stories,
  ResizableBody `insights.network` 540/300, h−70).
- **Timeline**: grid cols-2 — "Completion of {roots or 'the selected scope'}"
  (ProgressLine, ResizableBody `timeline.progress` 310/200, h−8) and "Added vs
  completed" (segmented **Bars | Lines** — initial value honours URL
  `?flowStyle=lines` — plus TableToggle, ResizableBody `timeline.flow`
  310/200, h−46); full-width "Evolution" card (TemporalGraph, ResizableBody
  `timeline.evolution` 600/320, h−118).
- **Explorer**: issue table (limit 2000 requested), text filter (key, summary,
  assignee, parent), segmented All/To do/In progress/Done, per-row "Report on
  this" button for level ≥ 1 rows (sets scope root); two catalog cards (issue
  types by level, statuses with category).
- **Settings**: four numbered cards — 1 credentials (console link, exact
  callback URL in a code chip, client id/secret inputs — the connect action is
  a **button navigating via `window.location.href`**, never a disabled button
  inside an `<a>`); 2 authorise (status pill, expiry, disconnect, site
  select); 3 projects to cache (checklist with cached counts, select
  all/clear, warning when none selected); 4 sync (Refresh now / Full rebuild /
  Stop; live phase + message + changelog Meter; last-run table: status,
  relative time, mode, duration, stats, error). Reads `?connected=1` /
  `?error=…` query params (from the OAuth callback) into a dismissible banner
  and strips them from the URL.

---

## 17. Frontend: CSS reference

`app.css` essentials (beyond generic resets):

- `.shell` grid `232px 1fr`; `@media (max-width: 900px)` collapses to one
  column with a horizontal sidebar.
- `.scopebar` — sticky top 0, z-20, flex-wrap, aligned to flex-end, surface-1
  background, bottom hairline.
- `.card` — surface-1, 1px `--border`, radius `--radius`, `--shadow`,
  padding `16px 18px 18px`; `.card.loading .card-body { opacity:.45;
  transition: opacity 120ms }`.
- Controls: `select/input/button` share font, surface-1, border, radius 7px;
  `button.primary` accent bg white text; `.ghost` borderless; `.segmented`
  joined buttons where `[aria-pressed=true]` gets `--selected-wash` + 650
  weight; visible `:focus-visible` outline `2px var(--accent)` on everything.
- Charts: `svg.chart { display:block; width:100%; height:auto; overflow:
  visible }`, `text { 11px, fill var(--text-muted) }`; `.grid-line` /
  `.axis-line` 1px strokes; `.tick-label { font-variant-numeric:
  tabular-nums }`; `.chart-wrap { overflow-x:auto }`.
- `.legend` flex-wrap gap `6px 16px`; `.legend-item` 12.5px secondary with an
  11×11 radius-3 swatch (`.swatch.line` = 14×2px); `[aria-pressed=false]
  { opacity:.42 }`; `:disabled { opacity:1; cursor:default }`.
- `.tooltip` — fixed, z-60, pointer-events none, surface-1, border, radius 8,
  shadow `0 4px 16px rgba(0,0,0,.16)`, min 150 / max 300px; `.tt-value` bold
  tabular; `.tt-key` 12×2px bar; `.tt-total` separated by a hairline.
- `table.data` — 12.5px; th uppercase 11px muted, **sticky top 0** with
  surface background; `td.num { text-align:right; tabular-nums }`;
  `.table-scroll { max-height:420px; overflow:auto }`.
- `.tree-row` grid `18px minmax(0,1fr) 140px 92px`.
- `.resizable-body { resize:vertical; overflow:hidden; position:relative }`
  with a `::after` corner glyph (7×7, 2px right+bottom borders in `--axis`) —
  the same glyph as `.resize-handle::after` on dashboard widgets so the
  affordance reads identically.
- Dashboard: `.dash-grid { position:relative }`; `.widget` absolute, card
  look, flex column, `transition: transform 140ms, width 140ms, height
  140ms`; `.widget.dragging { transition:none; z-index:30; shadow }`;
  `.widget-head { cursor:grab; touch-action:none }`; `.widget-body {
  overflow:auto; min-height:0; flex:1 }`; `.resize-handle` 18×18 corner,
  `cursor:nwse-resize`.
- `.modal-backdrop` fixed z-80 rgba(0,0,0,.42) centered; `.modal` surface
  panel; `.type-grid` auto-fill minmax(150px,1fr); `.type-card` left-aligned
  button with muted desc line.
- `.spinner` 13px border-top accent, 700ms rotation (2s under
  `prefers-reduced-motion`).
- `.pill`, `.dot`, `.banner` (left border 3px accent / warning / critical),
  `.empty`, `.checklist/.checkrow`, `.hero { 52px/650/-0.03em }`.

---

## 18. Demo data seeder

`server/scripts/seed-demo.mjs` — run via `npm run seed:demo`
(`--remove` deletes). Idempotent: always removes first.

- **Isolation**: everything under `cloud_id = 'demo-aurora'`, site name
  `Aurora Fintech (demo)` with `url NULL` (null suppresses /browse deep
  links). Sets config `cloud_id` to the demo. Removal deletes demo rows from
  all tables and repoints `cloud_id` at any remaining site. The sync engine's
  site guard (§7 step 2) keeps Refresh safe while the demo is active.
- **Determinism**: LCG `state = (state*1103515245 + 12345) % 2^31`, seed
  `20260816`; helpers `rand()`, `randInt(a,b)`, `pick(arr)`, `chance(p)`.
  Timestamps relative to `Date.now()`; ISO strings end `+0000`.
- **Org**: projects PORT (Portfolio), PAY (Payments), GRW (Growth), PLT
  (Platform), DISC (Discovery, `type_key='product_discovery'`). People —
  PAY: Priya Sharma, Marco Rossi, Elif Kaya, Tomás Silva, Hannah Berg;
  GRW: Jonas Weber, Aiko Tanaka, Lucas Moreau, Sofia Petrova;
  PLT: David Okafor, Mei Chen, Karl Johansson, Ana Kovač, Ryan O'Brien;
  reporters + Laura Novak, Ben Carter.
- **Statuses** (ids 1–5): To Do(new), In Progress, In Review, QA
  (indeterminate), Done(done). **Types**: Initiative(L2), Epic(L1), Story,
  Task, Bug, Idea(L0), Sub-task(−1).
- **Structure**: 4 initiatives in PORT —
  "Launch in EU markets" (epics: PAY SEPA instant payments, PAY PSD2
  compliance & SCA, GRW Localised onboarding for DE/FR/ES, PLT Multi-region
  deployments); "Reduce payment failure rate below 1%" (PAY Smart retry &
  routing, PLT Payment gateway observability); "Self-serve onboarding"
  (GRW KYC without the wait, GRW In-product activation nudges, PAY Card
  issuing for new accounts); "Reliability 99.95" (PLT Zero-downtime
  migrations, PLT Chaos & load testing programme). 11 epics total, each with
  8–14 stories (18% Bugs), plus 6–10 loose Tasks/Bugs per team (no epic), 15%
  of stories get 1–2 sub-tasks, 5 DISC Ideas each linked (`Implements`,
  outward) to 1–2 random epics.
- **Issue generator** `makeIssue`: ids from a counter starting 90000; keys
  `PROJ-101` upward per project; final workflow stage sampled
  (`r<.42→Done, <.52→QA, <.66→In Review, <.86→In Progress, else To Do` for
  epic stories; loose work `.5/.75` split; sub-tasks 60% done), then a
  **workflow walk** writes status_history hop by hop with gaps of
  `1–14 days + 0–23 h`, stopping if it would pass `now−1d` — the row's status
  reflects wherever the walk actually reached; done issues get
  `resolution='Done'` and `resolved` = last hop.
- Points on 75% of stories from `[1,2,3,3,5,5,8,13]`; time_spent on 60% of
  started work (`2–40 h`); labels 50% from a 6-word pool; priority weighted
  Medium-heavy; 88% assigned (12% of those cross-team).
- **Handovers** (chord fuel): 30% of assigned stories get an
  assignee_history row from another person (20% cross-team) to the final
  assignee; 25% of those get a second earlier hop.
- Prints a summary and the removal command.

---

## 19. Verification recipes & ground truth

### Palette validation (once, when touching colours)

Validate with a CVD simulator implementing Machado-Oliveira-Fernandes 2009 at
severity 1.0, OKLab ΔE×100: the 8-slot categorical order must pass adjacent
pairs in both modes (measured: worst adjacent CVD ΔE 9.1 light / 8.4 dark;
normal-vision 19.6 / 19.3, floor 15); light slots 3/4/5 sit below 3:1 contrast
→ mitigated by labels/table views. Ordinal ramps (§11 table) pass monotone
lightness with ΔL ≥ 0.06 per step and light-end ≥ 2:1 — the light-mode 6-step
ramp **fails** (that is why MAX_ORDINAL_STEPS = 5).

### After seeding the demo (`npm run seed:demo`)

Expected console: `4 initiatives, 11 epics, 121 stories/bugs, 26 sub-tasks,
26 loose tasks, 5 ideas`; totals `189 issues`, ~`481` transitions, `8` idea
links (handover counts vary with the fixed seed but are ≥ 60 rows).

### API assertions (server on any port, demo seeded)

| Check | Expect |
|---|---|
| `/api/catalog` | `ready:true`, `totals.issues = 189`, 5 projects |
| `/api/roots?level=2` | 4 rows |
| `/api/roots?level=1` | 11 rows |
| `/api/roots?level=idea` | 5 rows |
| `/api/reports/cfd?leavesOnly=true` | `keys = To Do\|In Progress\|In Review\|QA\|Done` (exact order) |
| `/api/reports/cfd?leavesOnly=true` final row sum | 156 (leaves) |
| `/api/reports/cfd?leavesOnly=false` final row sum | 189 |
| `/api/reports/tree?roots=PORT-101` | 1 root, ≥ 2 epic children across ≥ 2 projects |
| `/api/reports/sankey?dimensions=assignee,epic,category&maxPerColumn=8` | col0 ≤ 9 nodes (8 + Other), `truncated:true` |
| `/api/reports/chord?flow=handovers` | 2–9 entities, > 5 flows |
| `/api/reports/chord?flow=projects` | DISC→{PAY,GRW,PLT} rows |
| `/api/reports/cycletime?groupBy=epic` | ≥ 5 rows, every `p90 ≥ p50` |
| `/api/reports/graph` | 15–30 nodes; `?includeStories=true` > 100 |
| `/api/reports/burnup` | final `done ≤ scope`, `0 ≤ pct ≤ 100`, weekly sums equal final scope/done when un-windowed |
| **Cross-engine invariant** | burnup final `done` **equals** the CFD (category, leavesOnly) final `Done` value — two independent reconstructions of the same history must agree (demo: 83) |
| `/api/reports/issues?roots=DISC-101` | total 1; `…&followLinks=true` total > 5 |
| Dashboards | POST → GET → PUT(layout) → DELETE round-trips |

### Visual checks (headless Chrome)

```
chrome --headless=new --disable-gpu --hide-scrollbars --window-size=1500,1400
  --virtual-time-budget=9000 --user-data-dir=<fresh> --screenshot=out.png
  http://localhost:<port>/<page>
```

Inspect both themes (a `theme.html` shim that writes `localStorage.theme` then
redirects works; delete it from dist afterwards). Look for: axis bands never
cropped by fixed-height containers; labels never clipped by their own marks;
legends present for ≥ 2 series; nothing relies on hover alone.

---

## 20. Gotchas & invariants

Hard-won; each of these was a real bug or a deliberate guard:

1. **Refresh-token rotation is single-flight** (§5). Concurrent refreshes with
   a rotated token permanently break the grant. Also `COALESCE` the refresh
   token on store.
2. **String-pair keys use `'\u0000'` as separator, written as the escape
   sequence** — names contain spaces; and a literal NUL byte in a source file
   makes tools treat it as binary.
3. **SQLite variable limit**: chunk every `IN (...)` at 900.
4. **`HAVING` without `GROUP BY` is an error in SQLite** — filter computed
   columns via a wrapping subquery (`SELECT … FROM (SELECT …, (subquery) AS n
   …) WHERE n > 0`).
5. **Incremental watermark backs off 60 s** for clock skew; full sync clears
   it first. Changelog cursors compare the *stored* `issue_updated` with the
   row's current `updated` — equality means skip.
6. **Hierarchy may reference parents outside cached projects** — the closure
   loop (§7.5) plus the key→id resolution UPDATE are both required; legacy
   Epic Link / Parent Link arrive as *keys*, not ids.
7. **CFD entry status** is the *from* side of the first transition, not the
   current status — otherwise history rewrites itself. Same trick in burnup
   and graphTimeline (`initial`).
8. **Workflow order is learned** (category rank, then mean position);
   hardcoding status order breaks on real sites.
9. **Light mode ordinal ramp caps at 5 steps**; the CFD folds extra statuses
   into a positioned "Other" and says so under the chart.
10. **Colour follows the entity, never the rank**: colour scales are built
    from ranked entity *ids* once; filtering must not repaint survivors; > 8
    entities fold to grey "Other", hues are never cycled or generated.
11. **d3-sankey and d3-force mutate their inputs** — always feed copies
    (`{...node}`); d3.chordDirected's return value carries `.groups`.
12. **d3.partition assigns the invisible root its own column** — lay out one
    extra column and translate left by one column width.
13. **In-fill label ink must be computed** (`inkOn`: alpha-composite over the
    surface, WCAG luminance, pick white/near-black).
14. **Counts get integer ticks** (filter `y.ticks()`); `tabular-nums` only in
    columns/ticks, never on hero numbers.
15. **Refetch keeps the frame**: `useReport` holds previous data; cards dim
    (opacity .45) — no skeletons, no layout jumps.
16. **Chart containers must include the axis band** — tile/resizable heights
    subtract explicit slack for legends and controls; when in doubt the
    `.widget-body`/`.resizable-body` scrolls rather than crops labels.
17. **A disabled button inside `<a>` still navigates** — the Connect action
    is a real button with `window.location.href`.
18. **Force-graph drag pins** (`fx/fy` persist on purpose; double-click
    releases); the zoom behaviour needs a `filter` excluding node mousedowns,
    and pointer→sim maths must divide out both the viewBox scale and the zoom
    transform.
19. **TemporalGraph keeps one simulation and one node-object array** for the
    whole lifetime; visibility changes swap `sim.nodes()`/`links()` and reheat
    (alpha 0.35). New nodes spawn beside their parent. Never rebuild node
    objects on scrub (positions would reset).
20. **ResizableBody sets its inline height once** (from a mount-time ref);
    afterwards the browser owns it and a ResizeObserver reports back — writing
    state height into style would fight the native drag.
21. **The demo org lives under its own cloud_id**; the sync site-guard resets
    `cloud_id` to a real accessible site before syncing.
22. **OAuth state nonce**: 24 random bytes, single-use, 10-minute window;
    the callback redirects to the web origin with `?connected=1` or
    `?error=…` (never renders JSON to the user's browser).
23. React StrictMode double-invokes effects in dev — all effects here are
    idempotent (observers/simulations are torn down in cleanup).
24. **Everything is local**: system font stack, no CDN, no external requests
    from the web app other than `/api` (and Jira avatars if rendered).

---

## 21. Build order

Milestones with acceptance checks; each is buildable and testable alone.

1. **Scaffold** — root/workspace package.json files, vite + tsconfig,
   `.env.example`, `.gitignore`. ✔ `npm install` clean.
2. **DB + config** (§3, §4). ✔ server starts, `data/jira.sqlite` created with
   all tables (`sqlite3 .tables` or better-sqlite3 pragma).
3. **OAuth** (§5) + auth routes (§9). ✔ `/api/auth/status` returns
   `configured:false`; with test credentials the login redirect URL contains
   all six query params.
4. **Jira client + sync** (§6, §7) + sites/projects/sync routes. ✔ against a
   real site: sync completes phases metadata→issues→hierarchy→changelog;
   `sync_runs` row has stats; second run re-reads only changed issues.
5. **Reports** (§8) + report routes. ✔ seed the demo (§18) and run the full
   assertion table (§19) — especially the burnup≡CFD invariant.
6. **Frontend foundation** — tokens (§10), palette (§11), api/scope/format
   libs (§12–13), App shell + Settings page. ✔ connect + sync from the UI.
7. **Core charts & pages** — CumulativeFlow, BreakdownBars, ThroughputBars,
   Meter, Icicle, Sankey; Overview/Flow/Initiatives/People/Explorer pages.
   ✔ screenshots both themes; anti-checklist in §19.
8. **Insight charts** — Chord, DotPlot, NetworkGraph + Insights page.
9. **Time story** — burnup + graphTimeline server side; ProgressLine,
   FlowInOut (both variants), TemporalGraph; Timeline page.
10. **Dashboards** — Grid engine, registry, page, CRUD. ✔ drag/resize/reflow;
    reload restores; per-widget scope overrides beat the filter row.
11. **Resizable page cards** (§12 ResizableBody + §16 per-card wiring).
12. **Demo seeder + docs** — seed script, README, this SPEC.

---

## Appendix A — reference implementations (copy verbatim)

These are the highest-risk pieces: prose descriptions of them are lossy, so
the code itself is the specification. Copy each block character for character
into the named file. (Surrounding imports/exports are stated per entry.)

Note: A.1–A.4 are excerpts of `server/src/reports.js`; the **complete** file —
including every helper they call (`placeholders`, `statusHistoryFor`,
`dayKey`, `DAY`, `metricValue`, the `DIMENSIONS` table, ancestor walkers) and
every other report function — is given verbatim in Appendix B.6. When in
doubt, B.6 is authoritative.

### A.1 `cumulativeFlow` — `server/src/reports.js`

Uses module helpers `db`, `activeCloudId`, `metricValue`, `statusHistoryFor`,
`dayKey`, `DAY` (§8).

```js
export function cumulativeFlow({
  issues,
  cloudId = activeCloudId(),
  from,
  to,
  groupBy = 'status',
  metric = 'count',
}) {
  if (!issues.length) return { series: [], keys: [], order: [], empty: true }

  const history = statusHistoryFor(cloudId, issues.map((i) => i.id))
  const statusMeta = new Map(
    db
      .prepare('SELECT id, name, category_key FROM statuses WHERE cloud_id = ?')
      .all(cloudId)
      .map((s) => [String(s.id), s])
  )

  const categoryLabel = { new: 'To do', indeterminate: 'In progress', done: 'Done' }

  const labelFor = (statusId, statusName) => {
    if (groupBy === 'category') {
      const cat = statusMeta.get(String(statusId))?.category_key || 'indeterminate'
      return categoryLabel[cat] || cat
    }
    return statusMeta.get(String(statusId))?.name || statusName || 'Unknown'
  }

  const toMs = (s) => (s ? new Date(s).getTime() : null)

  // Build per-issue event lists, and learn the workflow order while doing it.
  const orderScore = new Map() // label -> { sum, n, category }
  const noteOrder = (label, idx, category) => {
    if (!orderScore.has(label)) orderScore.set(label, { sum: 0, n: 0, category })
    const e = orderScore.get(label)
    e.sum += idx
    e.n += 1
    if (category) e.category = category
  }

  const events = [] // { t, label, delta, weight }
  let minT = Infinity
  let maxT = -Infinity

  for (const issue of issues) {
    const w = metricValue(issue, metric)
    if (!w) continue
    const created = toMs(issue.created)
    if (!created) continue
    const hist = (history.get(issue.id) || []).filter((h) => toMs(h.at) !== null)

    const firstLabel = hist.length
      ? labelFor(hist[0].from_id, hist[0].from_status)
      : labelFor(issue.status_id, issue.status_name)
    const firstCat = hist.length
      ? statusMeta.get(String(hist[0].from_id))?.category_key
      : issue.status_category

    events.push({ t: created, label: firstLabel, delta: w })
    noteOrder(firstLabel, 0, firstCat)
    minT = Math.min(minT, created)
    maxT = Math.max(maxT, created)

    let prev = firstLabel
    hist.forEach((h, idx) => {
      const t = Math.max(toMs(h.at), created)
      const next = labelFor(h.to_id, h.to_status)
      if (next === prev) return
      events.push({ t, label: prev, delta: -w })
      events.push({ t, label: next, delta: w })
      noteOrder(next, idx + 1, statusMeta.get(String(h.to_id))?.category_key)
      prev = next
      minT = Math.min(minT, t)
      maxT = Math.max(maxT, t)
    })
  }

  if (!events.length) return { series: [], keys: [], order: [], empty: true }

  const start = from ? new Date(from).getTime() : minT
  const end = to ? new Date(to).getTime() : Math.max(maxT, Date.now())
  const endDay = Math.floor(end / DAY) * DAY + DAY - 1

  events.sort((a, b) => a.t - b.t)

  // Workflow order: status category first, then average position in the flow.
  const catRank = { new: 0, indeterminate: 1, done: 2 }
  const order = [...orderScore.entries()]
    .map(([label, e]) => ({ label, mean: e.sum / e.n, rank: catRank[e.category] ?? 1 }))
    .sort((a, b) => a.rank - b.rank || a.mean - b.mean)
    .map((e) => e.label)

  const tally = new Map(order.map((k) => [k, 0]))
  const series = []
  let cursor = 0

  for (let day = Math.floor(start / DAY) * DAY; day <= endDay; day += DAY) {
    const boundary = day + DAY - 1
    while (cursor < events.length && events[cursor].t <= boundary) {
      const e = events[cursor]
      tally.set(e.label, (tally.get(e.label) || 0) + e.delta)
      cursor += 1
    }
    const point = { date: dayKey(day) }
    for (const k of order) point[k] = Math.max(0, Number((tally.get(k) || 0).toFixed(3)))
    series.push(point)
  }

  // Drop leading all-zero days so the chart starts where work starts.
  let firstNonEmpty = series.findIndex((p) => order.some((k) => p[k] > 0))
  if (firstNonEmpty > 0) series.splice(0, firstNonEmpty)

  return { series, keys: order, order, groupBy, metric, empty: series.length === 0 }
}
```

### A.2 `burnup` — `server/src/reports.js`

```js
export function burnup({ issues, cloudId = activeCloudId(), metric = 'count', from }) {
  const parents = new Set(issues.map((i) => i.parent_id).filter(Boolean))
  const leaves = issues.filter((i) => !parents.has(i.id))
  if (!leaves.length) return { series: [], weekly: [], empty: true }

  const history = statusHistoryFor(cloudId, leaves.map((i) => i.id))
  const statusMeta = new Map(
    db.prepare('SELECT id, category_key FROM statuses WHERE cloud_id = ?').all(cloudId)
      .map((s) => [String(s.id), s.category_key])
  )
  const catOf = (statusId, fallback = 'indeterminate') =>
    statusMeta.get(String(statusId)) || fallback

  const toMs = (s) => (s ? new Date(s).getTime() : null)
  const scopeEvents = [] // { t, w }
  const doneEvents = [] // { t, w } (negative when leaving done)
  const perIssue = [] // { created, firstDone, w }
  let minT = Infinity

  for (const issue of leaves) {
    const w = metricValue(issue, metric)
    if (!w) continue
    const created = toMs(issue.created)
    if (!created) continue
    minT = Math.min(minT, created)
    scopeEvents.push({ t: created, w })

    const hist = (history.get(issue.id) || []).filter((h) => toMs(h.at) !== null)
    let cat = hist.length ? catOf(hist[0].from_id, 'new') : issue.status_category || 'new'
    let firstDone = null

    if (cat === 'done') {
      doneEvents.push({ t: created, w })
      firstDone = created
    }
    for (const h of hist) {
      const t = Math.max(toMs(h.at), created)
      const next = catOf(h.to_id)
      if (next === 'done' && cat !== 'done') {
        doneEvents.push({ t, w })
        if (firstDone === null) firstDone = t
      } else if (next !== 'done' && cat === 'done') {
        doneEvents.push({ t, w: -w })
      }
      cat = next
    }
    // Current state wins when history is missing its final hop.
    if (cat !== 'done' && issue.status_category === 'done') {
      const t = toMs(issue.resolved) ?? toMs(issue.status_changed) ?? created
      doneEvents.push({ t: Math.max(t, created), w })
      if (firstDone === null) firstDone = Math.max(t, created)
    }
    perIssue.push({ created, firstDone, w })
  }

  if (!scopeEvents.length) return { series: [], weekly: [], empty: true }

  scopeEvents.sort((a, b) => a.t - b.t)
  doneEvents.sort((a, b) => a.t - b.t)

  const start = Math.floor(minT / DAY) * DAY
  const end = Date.now()
  const fromMs = from ? new Date(from).getTime() : start
  const series = []
  let scope = 0
  let done = 0
  let si = 0
  let di = 0

  for (let day = start; day <= end; day += DAY) {
    const boundary = day + DAY - 1
    while (si < scopeEvents.length && scopeEvents[si].t <= boundary) scope += scopeEvents[si++].w
    while (di < doneEvents.length && doneEvents[di].t <= boundary) done += doneEvents[di++].w
    if (boundary < fromMs) continue
    series.push({
      date: dayKey(day),
      scope: Number(scope.toFixed(2)),
      done: Number(Math.max(0, done).toFixed(2)),
      pct: scope > 0 ? Number(((Math.max(0, done) / scope) * 100).toFixed(2)) : 0,
    })
  }

  // Long histories get thinned so the chart stays a readable series.
  const step = Math.ceil(series.length / 400)
  const thinned = step > 1 ? series.filter((_, i) => i % step === 0 || i === series.length - 1) : series

  const weekStart = (ts) => {
    const d = new Date(ts)
    const day = (d.getUTCDay() + 6) % 7
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)
  }
  const weekly = new Map()
  const bucket = (t) => {
    const k = dayKey(weekStart(t))
    if (!weekly.has(k)) weekly.set(k, { week: k, added: 0, completed: 0 })
    return weekly.get(k)
  }
  for (const p of perIssue) {
    if (p.created >= fromMs) bucket(p.created).added += p.w
    if (p.firstDone !== null && p.firstDone >= fromMs) bucket(p.firstDone).completed += p.w
  }

  return {
    metric,
    series: thinned,
    weekly: [...weekly.values()].sort((a, b) => a.week.localeCompare(b.week)),
  }
}
```

### A.3 `chordFlows` — `server/src/reports.js`

Note the separator is the six-character escape sequence, not a raw byte.

```js
export function chordFlows({ issues, cloudId = activeCloudId(), flow = 'handovers', maxEntities = 8 }) {
  const raw = new Map()

  const add = (from, to, v = 1) => {
    if (!from || !to || from === to) return
    const k = `${from}\u0000${to}`
    raw.set(k, (raw.get(k) || 0) + v)
  }

  if (flow === 'projects') {
    const inScope = new Set(issues.map((i) => i.id))
    const ids = [...inScope]
    const chunk = 900
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk)
      const rows = db
        .prepare(
          `SELECT s.project_key AS a, t.project_key AS b, COUNT(*) AS n
           FROM issue_links l
           JOIN issues s ON s.cloud_id = l.cloud_id AND s.id = l.source_id
           JOIN issues t ON t.cloud_id = l.cloud_id AND t.id = l.target_id
           WHERE l.cloud_id = ? AND l.direction = 'outward'
             AND l.source_id IN (${placeholders(part.length)})
           GROUP BY s.project_key, t.project_key`
        )
        .all(cloudId, ...part)
      for (const r of rows) add(r.a, r.b, r.n)
    }
  } else {
    const ids = issues.map((i) => i.id)
    const chunk = 900
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk)
      const rows = db
        .prepare(
          `SELECT from_name AS a, to_name AS b, COUNT(*) AS n
           FROM assignee_history
           WHERE cloud_id = ? AND from_id IS NOT NULL AND to_id IS NOT NULL
             AND issue_id IN (${placeholders(part.length)})
           GROUP BY from_name, to_name`
        )
        .all(cloudId, ...part)
      for (const r of rows) add(r.a, r.b, r.n)
    }
  }

  // Rank entities by total involvement, fold the tail into "Other".
  const totals = new Map()
  for (const [k, v] of raw) {
    const [a, b] = k.split('\u0000')
    totals.set(a, (totals.get(a) || 0) + v)
    totals.set(b, (totals.get(b) || 0) + v)
  }
  const ranked = [...totals.entries()].sort((x, y) => y[1] - x[1])
  const keep = new Set(ranked.slice(0, maxEntities).map(([name]) => name))
  const fold = (name) => (keep.has(name) ? name : 'Other')

  const flows = new Map()
  for (const [k, v] of raw) {
    const [a, b] = k.split('\u0000')
    const fa = fold(a)
    const fb = fold(b)
    if (fa === fb) continue
    const fk = `${fa}\u0000${fb}`
    flows.set(fk, (flows.get(fk) || 0) + v)
  }

  const entities = ranked.filter(([name]) => keep.has(name)).map(([name, total]) => ({ id: name, name, total }))
  if (ranked.length > maxEntities) {
    entities.push({ id: 'Other', name: `Other (${ranked.length - maxEntities})`, total: 0 })
  }

  return {
    flow,
    entities,
    flows: [...flows.entries()].map(([k, value]) => {
      const [source, target] = k.split('\u0000')
      return { source, target, value }
    }),
    truncated: ranked.length > maxEntities,
  }
}
```

### A.4 `sankey` — `server/src/reports.js`

Requires the `DIMENSIONS` table from §8.6 and the ancestor helpers.

```js
export function sankey({ issues, dimensions = ['assignee', 'epic', 'category'], metric = 'count', maxPerColumn = 12 }) {
  const byId = new Map(issues.map((i) => [i.id, i]))
  const dims = dimensions.filter((d) => DIMENSIONS[d]).slice(0, 4)
  if (dims.length < 2) return { nodes: [], links: [], dimensions: dims }

  const resolve = (issue, dim) => {
    const def = DIMENSIONS[dim]
    if (def.hierarchy !== undefined) {
      const node = def.orAbove
        ? ancestorAtOrAbove(issue, byId, def.hierarchy)
        : nearestAncestorAtLevel(issue, byId, def.hierarchy)
      if (!node) return { id: `${dim}:none`, name: `No ${def.label.toLowerCase()}` }
      return { id: `${dim}:${node.id}`, name: `${node.key} ${node.summary}`.slice(0, 60), key: node.key }
    }
    return { id: `${dim}:${def.id(issue)}`, name: String(def.of(issue)) }
  }

  // Column totals decide which members survive the per-column cap.
  const columnTotals = dims.map(() => new Map())
  const rowsForIssue = []

  for (const issue of issues) {
    const w = metricValue(issue, metric)
    if (!w) continue
    const path = dims.map((d) => resolve(issue, d))
    rowsForIssue.push({ path, w })
    path.forEach((p, c) => {
      const m = columnTotals[c]
      m.set(p.id, { ...p, value: (m.get(p.id)?.value || 0) + w })
    })
  }

  const keep = columnTotals.map((m, c) => {
    const sorted = [...m.values()].sort((a, b) => b.value - a.value)
    const survivors = new Set(sorted.slice(0, maxPerColumn).map((n) => n.id))
    return { survivors, dropped: Math.max(0, sorted.length - maxPerColumn), col: c }
  })

  const nodes = new Map()
  const links = new Map()

  const nodeFor = (p, col) => {
    const kept = keep[col].survivors.has(p.id)
    const id = kept ? p.id : `${dims[col]}:__other__`
    const name = kept ? p.name : `Other (${keep[col].dropped})`
    if (!nodes.has(id)) {
      nodes.set(id, { id, name, column: col, dimension: dims[col], value: 0, key: p.key })
    }
    return nodes.get(id)
  }

  for (const { path, w } of rowsForIssue) {
    const resolved = path.map((p, c) => nodeFor(p, c))
    resolved.forEach((n) => {
      n.value += w
    })
    for (let c = 0; c < resolved.length - 1; c += 1) {
      const key = `${resolved[c].id}\u0000${resolved[c + 1].id}`
      const existing = links.get(key)
      if (existing) existing.value += w
      else links.set(key, { source: resolved[c].id, target: resolved[c + 1].id, value: w })
    }
  }

  return {
    nodes: [...nodes.values()],
    links: [...links.values()].filter((l) => l.value > 0),
    dimensions: dims,
    metric,
    truncated: keep.some((k) => k.dropped > 0),
  }
}
```

### A.5 CFD client fold + colour/stack — `web/src/charts/CumulativeFlow.tsx`

```tsx
type Folded = { keys: string[]; rows: { date: Date; values: number[] }[]; foldedFrom: string[] }

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
```

Inside the component (`hidden: Set<string>` is legend-toggle state,
`themeVersion` from `useThemeVersion()`):

```tsx
// Bottom of the stack is the end of the workflow (Done); the ramp runs
// darkest at the bottom to lightest at the top.
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
}, [folded.keys, themeVersion])
```

### A.6 Grid layout math — `web/src/dashboard/Grid.tsx`

```tsx
export const COLS = 12
export const ROW_H = 84
export const GAP = 12

export type LayoutItem = { i: string; x: number; y: number; w: number; h: number }

const collides = (a: LayoutItem, b: LayoutItem) =>
  a.i !== b.i && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

export function resolveLayout(items: LayoutItem[], pinnedId: string): LayoutItem[] {
  const pin = items.find((l) => l.i === pinnedId)
  if (!pin) return items

  const rest = items
    .filter((l) => l.i !== pinnedId)
    .map((l) => ({ ...l }))
    .sort((a, b) => a.y - b.y || a.x - b.x)

  const placed: LayoutItem[] = [{ ...pin }]
  for (const item of rest) {
    while (placed.some((p) => collides(item, p))) item.y += 1
    placed.push(item)
  }

  // Upward compaction, pin excluded, top rows first.
  const settled: LayoutItem[] = [placed[0]]
  for (const item of placed.slice(1).sort((a, b) => a.y - b.y || a.x - b.x)) {
    while (item.y > 0) {
      const candidate = { ...item, y: item.y - 1 }
      if (settled.some((p) => collides(candidate, p))) break
      item.y -= 1
    }
    settled.push(item)
  }
  return settled
}

export function compactAll(items: LayoutItem[]): LayoutItem[] {
  const sorted = items.map((l) => ({ ...l })).sort((a, b) => a.y - b.y || a.x - b.x)
  const settled: LayoutItem[] = []
  for (const item of sorted) {
    while (item.y > 0) {
      const candidate = { ...item, y: item.y - 1 }
      if (settled.some((p) => collides(candidate, p))) break
      item.y -= 1
    }
    settled.push(item)
  }
  return settled
}

export function nextFreeY(items: LayoutItem[]): number {
  return items.reduce((m, l) => Math.max(m, l.y + l.h), 0)
}
```

Drag conversion inside `DashGrid` (document-level pointermove while dragging):

```tsx
const dx = e.clientX - drag.startClientX
const dy = e.clientY - drag.startClientY
const gx = Math.round(dx / (cellW + GAP))
const gy = Math.round(dy / (ROW_H + GAP))
// move:   x = clamp(orig.x + gx, 0, COLS - item.w); y = max(0, orig.y + gy)
// resize: w = clamp(orig.w + gx, minW, COLS - item.x); h = max(minH, orig.h + gy)
// then: onChange(resolveLayout(layout with the changed item, drag.id))
```

### A.7 `inkOn` — `web/src/lib/palette.ts`

```ts
function toRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace('#', '')
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  if (s.length !== 6) return null
  const n = Number.parseInt(s, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function relLum([r, g, b]: [number, number, number]) {
  const f = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export function inkOn(color: string, alpha = 1): string {
  const fg = toRgb(resolve(color))
  const bg = toRgb(resolve('var(--surface-1)'))
  if (!fg || !bg) return 'var(--text-primary)'
  const mix = fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as [number, number, number]
  const L = relLum(mix)
  return 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? '#ffffff' : '#0b0b0b'
}
```

### A.8 `ResizableBody` — `web/src/components/ui.tsx`

```tsx
export function ResizableBody({
  storageKey,
  defaultHeight,
  min = 160,
  max = 1100,
  children,
}: {
  storageKey: string
  defaultHeight: number
  min?: number
  max?: number
  children: (height: number) => ReactNode
}) {
  const key = `jira-reports.size.${storageKey}`
  const [height, setHeight] = useState<number>(() => {
    const stored = Number(localStorage.getItem(key))
    return Number.isFinite(stored) && stored >= min && stored <= max ? stored : defaultHeight
  })
  const initial = useRef(height)
  const live = useRef(height)
  live.current = height
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const h = Math.round(entries[0].contentRect.height)
      if (h && Math.abs(h - live.current) > 2) {
        setHeight(h)
        localStorage.setItem(key, String(h))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [key])

  return (
    <div
      ref={ref}
      className="resizable-body"
      style={{ height: initial.current, minHeight: min, maxHeight: max }}
    >
      {children(height)}
    </div>
  )
}
```

### A.9 `useReport` + sync polling — `web/src/lib/scope.tsx`

```tsx
export function useReport<T>(
  path: string | null,
  extra?: Record<string, unknown>
): { data: T | null; loading: boolean; error: string | null } {
  const { params, revision } = useScope()
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const key = JSON.stringify([path, params, extra, revision])

  useEffect(() => {
    if (!path) return
    let cancelled = false
    setLoading(true)
    api
      .get<T>(path, { ...params, ...extra })
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String((err as Error).message))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { data, loading, error }
}
```

Polling effect inside `ScopeProvider` (`wasRunning` is a `useRef(false)`):

```tsx
useEffect(() => {
  let timer: number | undefined
  let cancelled = false

  const tick = async () => {
    try {
      const s = await api.get<SyncStatus>('/sync/status')
      if (cancelled) return
      setSync(s)
      if (wasRunning.current && !s.running) {
        wasRunning.current = false
        if (s.last?.status === 'error') setSyncError(s.last.error)
        await refreshCatalog()
        setRevision((r) => r + 1)
      }
      if (s.running) {
        wasRunning.current = true
        timer = window.setTimeout(tick, 700)
      }
    } catch {
      /* server not up yet */
    }
  }

  void tick()
  return () => {
    cancelled = true
    if (timer) window.clearTimeout(timer)
  }
}, [refreshCatalog, revision])
```

### A.10 Force-graph mechanics — `NetworkGraph.tsx` / `TemporalGraph.tsx`

Pointer → simulation coordinates (both graphs; `w`/`height` are the viewBox
size, `transform` is the zoom state `{k,x,y}`):

```tsx
const toSimCoords = (e: React.PointerEvent) => {
  const rect = svgRef.current!.getBoundingClientRect()
  const px = ((e.clientX - rect.left) / rect.width) * w - w / 2
  const py = ((e.clientY - rect.top) / rect.height) * height - height / 2
  return { x: (px - transform.x) / transform.k, y: (py - transform.y) / transform.k }
}
```

Drag-pin handlers (attach to each node circle):

```tsx
onPointerDown: e => { e.preventDefault()
  ;(e.target as Element).setPointerCapture(e.pointerId)
  dragging.current = node
  sim.simulation.alphaTarget(0.25).restart()
  const p = toSimCoords(e); node.fx = p.x; node.fy = p.y }
onPointerMove: e => { if (dragging.current === node) {
  const p = toSimCoords(e); node.fx = p.x; node.fy = p.y } }
onPointerUp:   () => { dragging.current = null; sim.simulation.alphaTarget(0) }
onDoubleClick: () => { node.fx = null; node.fy = null; sim.simulation.alpha(0.3).restart() }
```

Zoom setup (node drags must win over zoom's pan):

```tsx
useEffect(() => {
  const svg = svgRef.current
  if (!svg) return
  const zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.3, 4])
    .filter((event) => !(event.type === 'mousedown' && (event.target as Element).closest('[data-node]')))
    .on('zoom', (event) => setTransform({ k: event.transform.k, x: event.transform.x, y: event.transform.y }))
  d3.select(svg).call(zoom)
  return () => { d3.select(svg).on('.zoom', null) }
}, [])
```

TemporalGraph membership + playback effects:

```tsx
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
}, [sim, visible.length, visibleEdges.length])

useEffect(() => {
  if (!playing) return
  const stepMs = 50
  const span = extent[1] - extent[0]
  const step = span / (SWEEP_MS / stepMs)   // SWEEP_MS = 14_000
  const timer = window.setInterval(() => {
    setT((cur) => {
      const next = cur + step
      if (next >= extent[1]) { setPlaying(false); return extent[1] }
      return next
    })
  }, stepMs)
  return () => window.clearInterval(timer)
}, [playing, extent])
```

Category at time t:

```tsx
const catAt = (n: SimNode) => {
  let cat = n.initial
  for (const tr of n.transitions) {
    if (tr.at > t) break
    cat = tr.cat
  }
  return cat
}
```

### A.11 `web/src/lib/api.ts` — complete file

(Declaration order within the file is free; contents are not.)

```ts
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new ApiError(res.status, data?.error || res.statusText)
  return data as T
}

export const api = {
  get: <T,>(path: string, params?: Record<string, unknown>) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
    }
    const q = qs.toString()
    return request<T>(`${path}${q ? `?${q}` : ''}`)
  },
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  del: <T,>(path: string) => request<T>(path, { method: 'DELETE' }),
}

export type AuthStatus = {
  configured: boolean
  clientId: string | null
  hasSecret: boolean
  credentialSource: 'env' | 'settings' | null
  redirectUri: string
  scopes: string
  connected: boolean
  expiresAt: number | null
  grantedScopes: string | null
}

export type Site = { cloud_id: string; name: string; url: string; avatar: string | null }

export type Project = {
  id: string
  key: string
  name: string
  type_key: string
  style: string
  category: string | null
  lead: string | null
  issue_count: number
}

export type SyncStatus = {
  running: boolean
  phase: string | null
  message: string | null
  counts: Record<string, number> | null
  startedAt: number | null
  last: {
    id: number
    mode: string
    status: string
    startedAt: number
    finishedAt: number | null
    stats: { issues: number; changelogs: number; projects: number; issuesInDb: number } | null
    error: string | null
  } | null
}

export type Catalog = {
  ready: boolean
  levels?: { level: number; name: string; n: number }[]
  statuses?: { name: string; category: string; n: number }[]
  projects?: { key: string; name: string; type_key: string; n: number }[]
  totals?: { issues: number; newest: string | null }
  metrics?: { key: string; label: string }[]
  dimensions?: { key: string; label: string }[]
}

export type Root = {
  id: string
  key: string
  summary: string
  type_name: string
  hierarchy_level: number
  status_name: string
  status_category: string
  project_key: string
  project_type: string | null
  child_count: number
}

export type Summary = {
  metric: string
  total: number
  issues: number
  byCategory: Record<string, number>
  counts: Record<string, number>
  percentComplete: number
  percentInProgress: number
  points: number
  hours: number
  estimatedCoverage: number
  assignees: number
  unassigned: number
  throughput: { week: string; count: number; points: number }[]
}

export type CfdPoint = { date: string } & Record<string, number | string>
export type Cfd = { series: CfdPoint[]; keys: string[]; groupBy?: string; metric?: string; empty?: boolean }

export type TreeNode = {
  id: string
  key: string
  summary: string
  type: string
  level: number
  status: string
  category: string
  assignee: string | null
  assigneeId: string | null
  project: string
  points: number
  hours: number
  created: string
  resolved: string | null
  updated: string
  children: TreeNode[]
  rollup: {
    total: number
    done: number
    inProgress: number
    todo: number
    leaves: number
    leafDone: number
    percent: number
    countPercent: number
  }
}

export type SankeyData = {
  nodes: { id: string; name: string; column: number; dimension: string; value: number; key?: string }[]
  links: { source: string; target: string; value: number }[]
  dimensions: string[]
  metric?: string
  truncated?: boolean
}

export type Person = {
  id: string
  name: string
  avatar: string | null
  total: number
  done: number
  inProgress: number
  todo: number
  issues: number
  points: number
  hours: number
}

export type ChordData = {
  flow: string
  entities: { id: string; name: string; total: number }[]
  flows: { source: string; target: string; value: number }[]
  truncated: boolean
}

export type CycleTimeData = {
  groupBy: string
  rows: { name: string; n: number; p50: number; p90: number; min: number; max: number; mean: number }[]
}

export type GraphNode = {
  id: string
  key: string
  summary: string
  type: string
  level: number
  project: string
  category: string
  assignee: string | null
  leaves: number
  done: number
  points: number
}

export type GraphData = {
  nodes: GraphNode[]
  edges: { source: string; target: string; kind: 'parent' | 'link'; label?: string }[]
  storiesDropped: number
}

export type BurnupData = {
  metric?: string
  series: { date: string; scope: number; done: number; pct: number }[]
  weekly: { week: string; added: number; completed: number }[]
  empty?: boolean
}

export type TimelineNode = {
  id: string
  key: string
  summary: string
  type: string
  level: number
  project: string
  created: number
  initial: string
  transitions: { at: number; cat: string }[]
}

export type TimelineGraphData = {
  nodes: TimelineNode[]
  edges: { source: string; target: string; kind: 'parent' | 'link'; label?: string }[]
  storiesDropped: number
}

export type WidgetConfig = {
  i: string
  type: string
  title?: string
  x: number
  y: number
  w: number
  h: number
  options: Record<string, string>
}

export type Dashboard = {
  id: number
  name: string
  layout: WidgetConfig[]
  updatedAt: number
}

export type IssueRow = {
  key: string
  summary: string
  type: string
  level: number
  status: string
  category: string
  assignee: string | null
  project: string
  points: number | null
  hours: number
  created: string
  updated: string
  resolved: string | null
  parent: string | null
}
```

---

## Appendix B — complete server source (copy verbatim)

Every file under `server/` in full. These supersede all prose summaries: when a
§3–§9 description and a file here differ in any detail, the file wins. Create
each file exactly as shown.

### B.1 `server/src/config.js`

```js
import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(here, '..', '..')

export const PORT = Number(process.env.PORT || 8787)
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(ROOT, process.env.DATA_DIR)
  : path.join(ROOT, 'data')

export const REDIRECT_URI =
  process.env.OAUTH_REDIRECT_URI || `http://localhost:${PORT}/api/auth/callback`

export const SCOPES =
  process.env.JIRA_SCOPES || 'read:jira-work read:jira-user offline_access'

// Credentials may come from .env or from the Settings page (stored in app_config).
export const ENV_CLIENT_ID = process.env.JIRA_CLIENT_ID || ''
export const ENV_CLIENT_SECRET = process.env.JIRA_CLIENT_SECRET || ''

export const AUTH_BASE = 'https://auth.atlassian.com'
export const API_BASE = 'https://api.atlassian.com'

// The web dev server; used to bounce the browser back after the OAuth callback.
export const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:5173'
```

### B.2 `server/src/db.js`

```js
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DATA_DIR } from './config.js'

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(path.join(DATA_DIR, 'jira.sqlite'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS oauth_token (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    INTEGER,
  scope         TEXT,
  obtained_at   INTEGER
);

CREATE TABLE IF NOT EXISTS sites (
  cloud_id TEXT PRIMARY KEY,
  name     TEXT,
  url      TEXT,
  avatar   TEXT,
  scopes   TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  cloud_id  TEXT NOT NULL,
  id        TEXT NOT NULL,
  key       TEXT,
  name      TEXT,
  type_key  TEXT,        -- software | service_desk | business | product_discovery
  style     TEXT,        -- classic | next-gen
  avatar    TEXT,
  category  TEXT,
  lead      TEXT,
  PRIMARY KEY (cloud_id, id)
);

CREATE TABLE IF NOT EXISTS issue_types (
  cloud_id        TEXT NOT NULL,
  id              TEXT NOT NULL,
  name            TEXT,
  subtask         INTEGER,
  hierarchy_level INTEGER,   -- -1 subtask, 0 story, 1 epic, 2+ initiative/theme
  icon            TEXT,
  PRIMARY KEY (cloud_id, id)
);

CREATE TABLE IF NOT EXISTS statuses (
  cloud_id      TEXT NOT NULL,
  id            TEXT NOT NULL,
  name          TEXT,
  category_key  TEXT,   -- new | indeterminate | done
  category_name TEXT,
  PRIMARY KEY (cloud_id, id)
);

CREATE TABLE IF NOT EXISTS fields (
  cloud_id    TEXT NOT NULL,
  id          TEXT NOT NULL,
  name        TEXT,
  custom      INTEGER,
  schema_type TEXT,
  PRIMARY KEY (cloud_id, id)
);

CREATE TABLE IF NOT EXISTS issues (
  cloud_id          TEXT NOT NULL,
  id                TEXT NOT NULL,
  key               TEXT,
  project_id        TEXT,
  project_key       TEXT,
  type_id           TEXT,
  type_name         TEXT,
  hierarchy_level   INTEGER,
  status_id         TEXT,
  status_name       TEXT,
  status_category   TEXT,
  resolution        TEXT,
  priority          TEXT,
  parent_id         TEXT,
  parent_key        TEXT,
  assignee_id       TEXT,
  assignee_name     TEXT,
  assignee_avatar   TEXT,
  reporter_id       TEXT,
  reporter_name     TEXT,
  summary           TEXT,
  labels            TEXT,   -- JSON array
  components        TEXT,   -- JSON array
  story_points      REAL,
  time_spent        INTEGER,
  original_estimate INTEGER,
  created           TEXT,
  updated           TEXT,
  resolved          TEXT,
  status_changed    TEXT,
  PRIMARY KEY (cloud_id, id)
);
CREATE INDEX IF NOT EXISTS idx_issues_parent   ON issues (cloud_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_issues_project  ON issues (cloud_id, project_id);
CREATE INDEX IF NOT EXISTS idx_issues_level    ON issues (cloud_id, hierarchy_level);
CREATE INDEX IF NOT EXISTS idx_issues_key      ON issues (cloud_id, key);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues (cloud_id, assignee_id);

CREATE TABLE IF NOT EXISTS issue_links (
  cloud_id  TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type      TEXT NOT NULL,
  direction TEXT NOT NULL,   -- outward | inward
  PRIMARY KEY (cloud_id, source_id, target_id, type, direction)
);
CREATE INDEX IF NOT EXISTS idx_links_source ON issue_links (cloud_id, source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON issue_links (cloud_id, target_id);

CREATE TABLE IF NOT EXISTS status_history (
  cloud_id    TEXT NOT NULL,
  issue_id    TEXT NOT NULL,
  at          TEXT NOT NULL,
  from_id     TEXT,
  from_status TEXT,
  to_id       TEXT,
  to_status   TEXT,
  author_id   TEXT,
  author_name TEXT,
  PRIMARY KEY (cloud_id, issue_id, at, to_id)
);
CREATE INDEX IF NOT EXISTS idx_hist_issue ON status_history (cloud_id, issue_id, at);

CREATE TABLE IF NOT EXISTS assignee_history (
  cloud_id    TEXT NOT NULL,
  issue_id    TEXT NOT NULL,
  at          TEXT NOT NULL,
  from_id     TEXT,
  from_name   TEXT,
  to_id       TEXT,
  to_name     TEXT,
  PRIMARY KEY (cloud_id, issue_id, at)
);
CREATE INDEX IF NOT EXISTS idx_ahist_issue ON assignee_history (cloud_id, issue_id, at);

-- Which issues we have already pulled a changelog for, so a refresh only
-- re-reads issues whose "updated" moved past the recorded watermark.
CREATE TABLE IF NOT EXISTS changelog_cursor (
  cloud_id     TEXT NOT NULL,
  issue_id     TEXT NOT NULL,
  issue_updated TEXT,
  fetched_at   INTEGER,
  PRIMARY KEY (cloud_id, issue_id)
);

CREATE TABLE IF NOT EXISTS dashboards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  layout     TEXT NOT NULL DEFAULT '[]',   -- JSON [{i,type,title,x,y,w,h,options}]
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cloud_id    TEXT,
  started_at  INTEGER,
  finished_at INTEGER,
  mode        TEXT,     -- full | incremental
  status      TEXT,     -- running | ok | error | cancelled
  stats       TEXT,     -- JSON
  error       TEXT
);
`)

export function getConfig(key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value)
  } catch {
    return row.value
  }
}

export function setConfig(key, value) {
  db.prepare(
    'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value))
}

export function deleteConfig(key) {
  db.prepare('DELETE FROM app_config WHERE key = ?').run(key)
}
```

### B.3 `server/src/oauth.js`

```js
import crypto from 'node:crypto'
import { db, getConfig, setConfig } from './db.js'
import {
  AUTH_BASE,
  API_BASE,
  REDIRECT_URI,
  SCOPES,
  ENV_CLIENT_ID,
  ENV_CLIENT_SECRET,
} from './config.js'

/**
 * Credentials resolve from the Settings page first, then .env. The secret never
 * leaves this process — the browser only ever sees whether one is present.
 */
export function getCredentials() {
  return {
    clientId: getConfig('client_id') || ENV_CLIENT_ID,
    clientSecret: getConfig('client_secret') || ENV_CLIENT_SECRET,
    redirectUri: getConfig('redirect_uri') || REDIRECT_URI,
    scopes: getConfig('scopes') || SCOPES,
    fromEnv: !getConfig('client_id') && !!ENV_CLIENT_ID,
  }
}

export function setCredentials({ clientId, clientSecret, redirectUri, scopes }) {
  if (clientId !== undefined) setConfig('client_id', clientId)
  if (clientSecret !== undefined) setConfig('client_secret', clientSecret)
  if (redirectUri !== undefined) setConfig('redirect_uri', redirectUri)
  if (scopes !== undefined) setConfig('scopes', scopes)
}

export function buildAuthUrl() {
  const { clientId, redirectUri, scopes } = getCredentials()
  if (!clientId) throw new Error('No Jira client ID configured')

  const state = crypto.randomBytes(24).toString('hex')
  setConfig('oauth_state', { state, at: Date.now() })

  const url = new URL('/authorize', AUTH_BASE)
  url.searchParams.set('audience', 'api.atlassian.com')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('scope', scopes)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

export function consumeState(state) {
  const stored = getConfig('oauth_state')
  db.prepare('DELETE FROM app_config WHERE key = ?').run('oauth_state')
  if (!stored || stored.state !== state) return false
  // 10 minute window; a stale state means a stray or replayed callback.
  return Date.now() - stored.at < 10 * 60 * 1000
}

async function tokenRequest(body) {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${text.slice(0, 500)}`)
  }
  return JSON.parse(text)
}

function storeToken(tok) {
  const now = Date.now()
  db.prepare(
    `INSERT INTO oauth_token (id, access_token, refresh_token, expires_at, scope, obtained_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       access_token  = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, oauth_token.refresh_token),
       expires_at    = excluded.expires_at,
       scope         = excluded.scope,
       obtained_at   = excluded.obtained_at`
  ).run(
    tok.access_token,
    tok.refresh_token || null,
    now + (tok.expires_in || 3600) * 1000,
    tok.scope || '',
    now
  )
}

export async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = getCredentials()
  const tok = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  })
  storeToken(tok)
  return tok
}

let refreshInFlight = null

async function refresh() {
  const row = db.prepare('SELECT * FROM oauth_token WHERE id = 1').get()
  if (!row?.refresh_token) throw new Error('Not connected to Jira (no refresh token)')
  const { clientId, clientSecret } = getCredentials()
  // Atlassian rotates refresh tokens, so the response's new one must be stored.
  const tok = await tokenRequest({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: row.refresh_token,
  })
  storeToken(tok)
  return tok.access_token
}

export async function getAccessToken() {
  const row = db.prepare('SELECT * FROM oauth_token WHERE id = 1').get()
  if (!row?.access_token) throw new Error('Not connected to Jira')
  if (row.expires_at - Date.now() > 60_000) return row.access_token

  // Collapse concurrent refreshes — the sync fires many requests at once and a
  // rotated refresh token can only be redeemed one time.
  if (!refreshInFlight) {
    refreshInFlight = refresh().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

export function authStatus() {
  const row = db.prepare('SELECT * FROM oauth_token WHERE id = 1').get()
  const creds = getCredentials()
  return {
    configured: !!creds.clientId && !!creds.clientSecret,
    clientId: creds.clientId ? `${creds.clientId.slice(0, 6)}…` : null,
    hasSecret: !!creds.clientSecret,
    credentialSource: creds.fromEnv ? 'env' : creds.clientId ? 'settings' : null,
    redirectUri: creds.redirectUri,
    scopes: creds.scopes,
    connected: !!row?.access_token,
    expiresAt: row?.expires_at ?? null,
    grantedScopes: row?.scope ?? null,
  }
}

export function disconnect() {
  db.prepare('DELETE FROM oauth_token').run()
}

/** The sites (Jira Cloud instances) this grant can reach. */
export async function fetchAccessibleResources() {
  const token = await getAccessToken()
  const res = await fetch(`${API_BASE}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`accessible-resources failed (${res.status})`)
  const sites = await res.json()

  const stmt = db.prepare(
    `INSERT INTO sites (cloud_id, name, url, avatar, scopes) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id) DO UPDATE SET
       name = excluded.name, url = excluded.url,
       avatar = excluded.avatar, scopes = excluded.scopes`
  )
  const tx = db.transaction((rows) => {
    for (const s of rows) {
      stmt.run(s.id, s.name, s.url, s.avatarUrl || null, JSON.stringify(s.scopes || []))
    }
  })
  tx(sites)

  if (!getConfig('cloud_id') && sites.length) setConfig('cloud_id', sites[0].id)
  return sites
}

export function activeCloudId() {
  const id = getConfig('cloud_id')
  if (id) return id
  const row = db.prepare('SELECT cloud_id FROM sites LIMIT 1').get()
  return row?.cloud_id || null
}
```

### B.4 `server/src/jiraClient.js`

```js
import { API_BASE } from './config.js'
import { getAccessToken, activeCloudId } from './oauth.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class JiraError extends Error {
  constructor(status, body, path) {
    super(`Jira ${status} on ${path}: ${String(body).slice(0, 400)}`)
    this.status = status
    this.body = body
    this.path = path
  }
}

/**
 * One request against a site's Jira REST API, with retry on 429/5xx.
 * `path` is relative to /rest, e.g. "/api/3/project/search".
 */
export async function jiraFetch(path, { method = 'GET', query, body, cloudId } = {}) {
  const cid = cloudId || activeCloudId()
  if (!cid) throw new Error('No Jira site selected')

  const url = new URL(`${API_BASE}/ex/jira/${cid}/rest${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }

  let attempt = 0
  for (;;) {
    const token = await getAccessToken()
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (res.ok) {
      if (res.status === 204) return null
      return res.json()
    }

    const retryable = res.status === 429 || res.status >= 500
    if (retryable && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after'))
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 2 ** attempt * 1000)
      attempt += 1
      await sleep(wait)
      continue
    }

    throw new JiraError(res.status, await res.text(), path)
  }
}

/**
 * JQL search. Uses the current /search/jql endpoint (token pagination) and
 * falls back to the legacy /search offset endpoint on older sites.
 */
export async function searchIssues({ jql, fields, cloudId, expand, onPage, pageSize = 100, signal }) {
  const fieldParam = Array.isArray(fields) ? fields.join(',') : fields
  let useLegacy = false
  let nextPageToken
  let startAt = 0
  let count = 0

  for (;;) {
    if (signal?.aborted) throw new Error('Sync cancelled')

    let page
    if (!useLegacy) {
      try {
        page = await jiraFetch('/api/3/search/jql', {
          cloudId,
          query: {
            jql,
            fields: fieldParam,
            maxResults: pageSize,
            nextPageToken,
            expand,
          },
        })
      } catch (err) {
        if (err instanceof JiraError && (err.status === 404 || err.status === 410)) {
          useLegacy = true
          continue
        }
        throw err
      }
    } else {
      page = await jiraFetch('/api/3/search', {
        cloudId,
        query: { jql, fields: fieldParam, maxResults: pageSize, startAt, expand },
      })
    }

    const issues = page?.issues ?? []
    count += issues.length
    if (issues.length) await onPage(issues)

    if (!useLegacy) {
      nextPageToken = page?.nextPageToken
      if (page?.isLast || !nextPageToken || issues.length === 0) break
    } else {
      startAt += issues.length
      const total = page?.total ?? 0
      if (issues.length === 0 || startAt >= total) break
    }
  }

  return count
}

/**
 * Changelogs for many issues. Prefers the bulkfetch endpoint (one call per 100
 * issues); falls back to per-issue paging where it is unavailable.
 */
export async function fetchChangelogs({ issueIds, fieldIds = ['status', 'assignee'], cloudId, signal }) {
  const out = new Map()
  const chunkSize = 100

  for (let i = 0; i < issueIds.length; i += chunkSize) {
    if (signal?.aborted) throw new Error('Sync cancelled')
    const chunk = issueIds.slice(i, i + chunkSize)

    let bulkOk = true
    let nextPageToken
    for (;;) {
      let page
      try {
        page = await jiraFetch('/api/3/changelog/bulkfetch', {
          method: 'POST',
          cloudId,
          body: {
            fieldIds,
            issueIdsOrKeys: chunk,
            maxResults: 1000,
            ...(nextPageToken ? { nextPageToken } : {}),
          },
        })
      } catch (err) {
        if (err instanceof JiraError && [400, 404, 410].includes(err.status)) {
          bulkOk = false
          break
        }
        throw err
      }

      for (const entry of page?.issueChangeLogs ?? []) {
        const id = String(entry.issueId)
        if (!out.has(id)) out.set(id, [])
        out.get(id).push(...(entry.changeHistories ?? []))
      }
      nextPageToken = page?.nextPageToken
      if (!nextPageToken) break
    }

    if (bulkOk) continue

    for (const id of chunk) {
      const histories = []
      let startAt = 0
      for (;;) {
        const page = await jiraFetch(`/api/3/issue/${id}/changelog`, {
          cloudId,
          query: { startAt, maxResults: 100 },
        })
        histories.push(...(page?.values ?? []))
        startAt += page?.values?.length ?? 0
        if (page?.isLast || startAt >= (page?.total ?? 0) || !page?.values?.length) break
      }
      out.set(String(id), histories)
    }
  }

  return out
}
```

### B.5 `server/src/sync.js`

```js
import { db, getConfig, setConfig } from './db.js'
import { activeCloudId, fetchAccessibleResources } from './oauth.js'
import { jiraFetch, searchIssues, fetchChangelogs } from './jiraClient.js'

/* ------------------------------------------------------------------ state */

let current = null // { runId, mode, phase, message, counts, startedAt, controller }

export function syncStatus() {
  const last = db
    .prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1')
    .get()
  return {
    running: !!current,
    phase: current?.phase ?? null,
    message: current?.message ?? null,
    counts: current?.counts ?? null,
    startedAt: current?.startedAt ?? null,
    last: last
      ? {
          id: last.id,
          mode: last.mode,
          status: last.status,
          startedAt: last.started_at,
          finishedAt: last.finished_at,
          stats: last.stats ? JSON.parse(last.stats) : null,
          error: last.error,
        }
      : null,
  }
}

export function cancelSync() {
  if (!current) return false
  current.controller.abort()
  return true
}

function progress(phase, message, extra = {}) {
  if (!current) return
  current.phase = phase
  current.message = message
  Object.assign(current.counts, extra)
}

/* ------------------------------------------------------------- field ids */

const STORY_POINT_NAMES = ['story points', 'story point estimate', 'story point']
const EPIC_LINK_NAMES = ['epic link']
const PARENT_LINK_NAMES = ['parent link']

function discoverFieldIds(cloudId) {
  const rows = db
    .prepare('SELECT id, name FROM fields WHERE cloud_id = ?')
    .all(cloudId)
  const byName = (names) =>
    rows.filter((r) => names.includes((r.name || '').trim().toLowerCase())).map((r) => r.id)

  return {
    storyPoints: byName(STORY_POINT_NAMES),
    epicLink: byName(EPIC_LINK_NAMES)[0] || null,
    parentLink: byName(PARENT_LINK_NAMES)[0] || null,
  }
}

/* -------------------------------------------------------------- metadata */

async function syncMetadata(cloudId, signal) {
  progress('metadata', 'Reading fields, issue types and statuses…')

  const fields = await jiraFetch('/api/3/field', { cloudId })
  const fStmt = db.prepare(
    `INSERT INTO fields (cloud_id, id, name, custom, schema_type) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id, id) DO UPDATE SET name = excluded.name,
       custom = excluded.custom, schema_type = excluded.schema_type`
  )
  db.transaction(() => {
    for (const f of fields) {
      fStmt.run(cloudId, f.id, f.name, f.custom ? 1 : 0, f.schema?.type || null)
    }
  })()

  const types = await jiraFetch('/api/3/issuetype', { cloudId })
  const tStmt = db.prepare(
    `INSERT INTO issue_types (cloud_id, id, name, subtask, hierarchy_level, icon)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id, id) DO UPDATE SET name = excluded.name,
       subtask = excluded.subtask, hierarchy_level = excluded.hierarchy_level,
       icon = excluded.icon`
  )
  db.transaction(() => {
    for (const t of types) {
      const level = t.hierarchyLevel ?? (t.subtask ? -1 : 0)
      tStmt.run(cloudId, t.id, t.name, t.subtask ? 1 : 0, level, t.iconUrl || null)
    }
  })()

  const statuses = await jiraFetch('/api/3/status', { cloudId })
  const sStmt = db.prepare(
    `INSERT INTO statuses (cloud_id, id, name, category_key, category_name)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id, id) DO UPDATE SET name = excluded.name,
       category_key = excluded.category_key, category_name = excluded.category_name`
  )
  db.transaction(() => {
    for (const s of statuses) {
      sStmt.run(cloudId, s.id, s.name, s.statusCategory?.key || null, s.statusCategory?.name || null)
    }
  })()

  progress('metadata', 'Reading projects…')
  const pStmt = db.prepare(
    `INSERT INTO projects (cloud_id, id, key, name, type_key, style, avatar, category, lead)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cloud_id, id) DO UPDATE SET key = excluded.key, name = excluded.name,
       type_key = excluded.type_key, style = excluded.style, avatar = excluded.avatar,
       category = excluded.category, lead = excluded.lead`
  )
  let startAt = 0
  let projectCount = 0
  for (;;) {
    if (signal.aborted) throw new Error('Sync cancelled')
    const page = await jiraFetch('/api/3/project/search', {
      cloudId,
      query: { startAt, maxResults: 50, expand: 'lead,description,projectKeys' },
    })
    const values = page?.values ?? []
    db.transaction(() => {
      for (const p of values) {
        pStmt.run(
          cloudId,
          p.id,
          p.key,
          p.name,
          p.projectTypeKey || null,
          p.style || null,
          p.avatarUrls?.['48x48'] || null,
          p.projectCategory?.name || null,
          p.lead?.displayName || null
        )
      }
    })()
    projectCount += values.length
    startAt += values.length
    if (page?.isLast || !values.length) break
  }

  progress('metadata', 'Metadata up to date', { projects: projectCount })
  return discoverFieldIds(cloudId)
}

/* ---------------------------------------------------------------- issues */

const upsertIssue = db.prepare(`
  INSERT INTO issues (
    cloud_id, id, key, project_id, project_key, type_id, type_name, hierarchy_level,
    status_id, status_name, status_category, resolution, priority,
    parent_id, parent_key, assignee_id, assignee_name, assignee_avatar,
    reporter_id, reporter_name, summary, labels, components,
    story_points, time_spent, original_estimate,
    created, updated, resolved, status_changed
  ) VALUES (
    @cloud_id, @id, @key, @project_id, @project_key, @type_id, @type_name, @hierarchy_level,
    @status_id, @status_name, @status_category, @resolution, @priority,
    @parent_id, @parent_key, @assignee_id, @assignee_name, @assignee_avatar,
    @reporter_id, @reporter_name, @summary, @labels, @components,
    @story_points, @time_spent, @original_estimate,
    @created, @updated, @resolved, @status_changed
  )
  ON CONFLICT(cloud_id, id) DO UPDATE SET
    key = excluded.key, project_id = excluded.project_id, project_key = excluded.project_key,
    type_id = excluded.type_id, type_name = excluded.type_name,
    hierarchy_level = excluded.hierarchy_level,
    status_id = excluded.status_id, status_name = excluded.status_name,
    status_category = excluded.status_category, resolution = excluded.resolution,
    priority = excluded.priority, parent_id = excluded.parent_id, parent_key = excluded.parent_key,
    assignee_id = excluded.assignee_id, assignee_name = excluded.assignee_name,
    assignee_avatar = excluded.assignee_avatar, reporter_id = excluded.reporter_id,
    reporter_name = excluded.reporter_name, summary = excluded.summary,
    labels = excluded.labels, components = excluded.components,
    story_points = excluded.story_points, time_spent = excluded.time_spent,
    original_estimate = excluded.original_estimate, created = excluded.created,
    updated = excluded.updated, resolved = excluded.resolved,
    status_changed = excluded.status_changed
`)

const upsertLink = db.prepare(
  `INSERT OR IGNORE INTO issue_links (cloud_id, source_id, target_id, type, direction)
   VALUES (?, ?, ?, ?, ?)`
)

function levelForType(cloudId, typeId, isSubtask) {
  const row = db
    .prepare('SELECT hierarchy_level FROM issue_types WHERE cloud_id = ? AND id = ?')
    .get(cloudId, typeId)
  if (row?.hierarchy_level !== undefined && row?.hierarchy_level !== null) return row.hierarchy_level
  return isSubtask ? -1 : 0
}

function storeIssuePage(cloudId, issues, fieldIds) {
  const write = db.transaction((list) => {
    for (const raw of list) {
      const f = raw.fields || {}

      let points = null
      for (const id of fieldIds.storyPoints) {
        const v = f[id]
        if (typeof v === 'number') {
          points = v
          break
        }
      }

      const epicLinkKey = fieldIds.epicLink ? f[fieldIds.epicLink] : null
      const parentLinkRaw = fieldIds.parentLink ? f[fieldIds.parentLink] : null
      const parentLinkKey =
        typeof parentLinkRaw === 'string' ? parentLinkRaw : parentLinkRaw?.key || null

      upsertIssue.run({
        cloud_id: cloudId,
        id: String(raw.id),
        key: raw.key,
        project_id: f.project?.id ? String(f.project.id) : null,
        project_key: f.project?.key || null,
        type_id: f.issuetype?.id ? String(f.issuetype.id) : null,
        type_name: f.issuetype?.name || null,
        hierarchy_level: levelForType(cloudId, String(f.issuetype?.id), f.issuetype?.subtask),
        status_id: f.status?.id ? String(f.status.id) : null,
        status_name: f.status?.name || null,
        status_category: f.status?.statusCategory?.key || null,
        resolution: f.resolution?.name || null,
        priority: f.priority?.name || null,
        parent_id: f.parent?.id ? String(f.parent.id) : null,
        parent_key: f.parent?.key || epicLinkKey || parentLinkKey || null,
        assignee_id: f.assignee?.accountId || null,
        assignee_name: f.assignee?.displayName || null,
        assignee_avatar: f.assignee?.avatarUrls?.['48x48'] || null,
        reporter_id: f.reporter?.accountId || null,
        reporter_name: f.reporter?.displayName || null,
        summary: f.summary || '',
        labels: JSON.stringify(f.labels || []),
        components: JSON.stringify((f.components || []).map((c) => c.name)),
        story_points: points,
        time_spent: f.aggregatetimespent ?? f.timespent ?? null,
        original_estimate: f.timeoriginalestimate ?? null,
        created: f.created || null,
        updated: f.updated || null,
        resolved: f.resolutiondate || null,
        status_changed: f.statuscategorychangedate || null,
      })

      for (const link of f.issuelinks || []) {
        const type = link.type?.name || 'relates'
        if (link.outwardIssue) {
          upsertLink.run(cloudId, String(raw.id), String(link.outwardIssue.id), type, 'outward')
        }
        if (link.inwardIssue) {
          upsertLink.run(cloudId, String(raw.id), String(link.inwardIssue.id), type, 'inward')
        }
      }
    }
  })
  write(issues)
}

function issueFieldList(fieldIds) {
  const base = [
    'summary', 'status', 'statuscategorychangedate', 'issuetype', 'project',
    'assignee', 'reporter', 'created', 'updated', 'resolutiondate', 'resolution',
    'priority', 'parent', 'labels', 'components', 'timeoriginalestimate',
    'timespent', 'aggregatetimespent', 'issuelinks',
  ]
  const extra = [...fieldIds.storyPoints]
  if (fieldIds.epicLink) extra.push(fieldIds.epicLink)
  if (fieldIds.parentLink) extra.push(fieldIds.parentLink)
  return [...base, ...extra]
}

/** Pull in ancestors that live outside the selected projects (initiatives, themes). */
async function closeHierarchy(cloudId, fieldIds, signal) {
  const fields = issueFieldList(fieldIds)
  for (let round = 0; round < 6; round += 1) {
    const missing = db
      .prepare(
        `SELECT DISTINCT i.parent_key AS k FROM issues i
         WHERE i.cloud_id = ? AND i.parent_key IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM issues p WHERE p.cloud_id = i.cloud_id AND p.key = i.parent_key
           )`
      )
      .all(cloudId)
      .map((r) => r.k)
      .filter(Boolean)

    if (!missing.length) return
    progress('hierarchy', `Fetching ${missing.length} parent issue(s) outside the selected projects…`)

    for (let i = 0; i < missing.length; i += 50) {
      if (signal.aborted) throw new Error('Sync cancelled')
      const chunk = missing.slice(i, i + 50)
      const jql = `key in (${chunk.map((k) => `"${k}"`).join(',')})`
      await searchIssues({
        jql,
        fields,
        cloudId,
        signal,
        onPage: (issues) => storeIssuePage(cloudId, issues, fieldIds),
      })
    }
  }
}

/* ------------------------------------------------------------ changelogs */

function recordChangelogs(cloudId, map) {
  const sStmt = db.prepare(
    `INSERT OR REPLACE INTO status_history
     (cloud_id, issue_id, at, from_id, from_status, to_id, to_status, author_id, author_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const aStmt = db.prepare(
    `INSERT OR REPLACE INTO assignee_history
     (cloud_id, issue_id, at, from_id, from_name, to_id, to_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const cStmt = db.prepare(
    `INSERT INTO changelog_cursor (cloud_id, issue_id, issue_updated, fetched_at)
     VALUES (?, ?, (SELECT updated FROM issues WHERE cloud_id = ? AND id = ?), ?)
     ON CONFLICT(cloud_id, issue_id) DO UPDATE SET
       issue_updated = excluded.issue_updated, fetched_at = excluded.fetched_at`
  )

  const write = db.transaction(() => {
    const now = Date.now()
    for (const [issueId, histories] of map) {
      db.prepare('DELETE FROM status_history WHERE cloud_id = ? AND issue_id = ?').run(cloudId, issueId)
      db.prepare('DELETE FROM assignee_history WHERE cloud_id = ? AND issue_id = ?').run(cloudId, issueId)
      for (const h of histories) {
        for (const item of h.items || []) {
          if (item.field === 'status' || item.fieldId === 'status') {
            sStmt.run(
              cloudId, issueId, h.created,
              item.from ? String(item.from) : null, item.fromString || null,
              item.to ? String(item.to) : null, item.toString || null,
              h.author?.accountId || null, h.author?.displayName || null
            )
          } else if (item.field === 'assignee' || item.fieldId === 'assignee') {
            aStmt.run(
              cloudId, issueId, h.created,
              item.from || null, item.fromString || null,
              item.to || null, item.toString || null
            )
          }
        }
      }
      cStmt.run(cloudId, issueId, cloudId, issueId, now)
    }
  })
  write()
}

async function syncChangelogs(cloudId, signal) {
  // Only issues whose "updated" moved past what the cursor recorded.
  const stale = db
    .prepare(
      `SELECT i.id FROM issues i
       LEFT JOIN changelog_cursor c ON c.cloud_id = i.cloud_id AND c.issue_id = i.id
       WHERE i.cloud_id = ? AND (c.issue_updated IS NULL OR c.issue_updated <> i.updated)`
    )
    .all(cloudId)
    .map((r) => r.id)

  if (!stale.length) {
    progress('changelog', 'Status history already current', { changelogs: 0 })
    return 0
  }

  let done = 0
  const batch = 500
  for (let i = 0; i < stale.length; i += batch) {
    if (signal.aborted) throw new Error('Sync cancelled')
    const chunk = stale.slice(i, i + batch)
    progress('changelog', `Reading status history ${done}/${stale.length}…`, {
      changelogs: done,
      changelogTotal: stale.length,
    })
    const map = await fetchChangelogs({ issueIds: chunk, cloudId, signal })
    // Issues with no changelog still need a cursor so they are not re-fetched.
    for (const id of chunk) if (!map.has(id)) map.set(id, [])
    recordChangelogs(cloudId, map)
    done += chunk.length
  }

  progress('changelog', 'Status history up to date', { changelogs: done })
  return done
}

/* ------------------------------------------------------------------ main */

export async function runSync({ mode = 'incremental' } = {}) {
  if (current) throw new Error('A sync is already running')

  const controller = new AbortController()
  const signal = controller.signal
  const startedAt = Date.now()

  const info = db
    .prepare('INSERT INTO sync_runs (started_at, mode, status) VALUES (?, ?, ?)')
    .run(startedAt, mode, 'running')

  current = {
    runId: info.lastInsertRowid,
    mode,
    phase: 'starting',
    message: 'Starting…',
    counts: { issues: 0 },
    startedAt,
    controller,
  }

  try {
    const sites = await fetchAccessibleResources()
    let cloudId = activeCloudId()
    // The active site may be the seeded demo org (or a site this grant lost
    // access to) — a sync only makes sense against a real accessible site.
    if (!sites.some((s) => s.id === cloudId)) {
      cloudId = sites[0]?.id ?? null
      if (cloudId) setConfig('cloud_id', cloudId)
    }
    if (!cloudId) throw new Error('No Jira site available for this grant')
    db.prepare('UPDATE sync_runs SET cloud_id = ? WHERE id = ?').run(cloudId, current.runId)

    const fieldIds = await syncMetadata(cloudId, signal)
    setConfig('field_ids', fieldIds)

    const selected = getConfig('sync_projects', [])
    const rows = selected.length
      ? db
          .prepare(
            `SELECT id, key, name FROM projects WHERE cloud_id = ? AND key IN (${selected
              .map(() => '?')
              .join(',')})`
          )
          .all(cloudId, ...selected)
      : db.prepare('SELECT id, key, name FROM projects WHERE cloud_id = ?').all(cloudId)

    if (!rows.length) throw new Error('No projects selected to sync — choose some in Settings')

    const since = mode === 'full' ? null : getConfig('last_issue_sync', null)
    const fields = issueFieldList(fieldIds)
    let total = 0

    for (const [idx, project] of rows.entries()) {
      if (signal.aborted) throw new Error('Sync cancelled')
      const clauses = [`project = ${project.id}`]
      if (since) clauses.push(`updated >= "${since}"`)
      const jql = `${clauses.join(' AND ')} ORDER BY created ASC`

      progress('issues', `${project.key} — ${project.name} (${idx + 1}/${rows.length})`, {
        projectIndex: idx + 1,
        projectTotal: rows.length,
      })

      await searchIssues({
        jql,
        fields,
        cloudId,
        signal,
        onPage: (issues) => {
          storeIssuePage(cloudId, issues, fieldIds)
          total += issues.length
          progress('issues', `${project.key} — ${total} issues read`, { issues: total })
        },
      })
    }

    await closeHierarchy(cloudId, fieldIds, signal)

    // Resolve parents that arrived only as a key (legacy Epic Link / Parent Link).
    db.prepare(
      `UPDATE issues SET parent_id = (
         SELECT p.id FROM issues p WHERE p.cloud_id = issues.cloud_id AND p.key = issues.parent_key
       )
       WHERE cloud_id = ? AND parent_id IS NULL AND parent_key IS NOT NULL`
    ).run(cloudId)

    const changelogs = await syncChangelogs(cloudId, signal)

    // Watermark for the next incremental pass, minus a minute of slack for
    // clock skew between this machine and Jira.
    const watermark = new Date(startedAt - 60_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 16)
    setConfig('last_issue_sync', watermark)

    const stats = {
      issues: total,
      changelogs,
      projects: rows.length,
      issuesInDb: db
        .prepare('SELECT COUNT(*) AS n FROM issues WHERE cloud_id = ?')
        .get(cloudId).n,
    }
    db.prepare(
      'UPDATE sync_runs SET finished_at = ?, status = ?, stats = ? WHERE id = ?'
    ).run(Date.now(), 'ok', JSON.stringify(stats), current.runId)

    return stats
  } catch (err) {
    db.prepare(
      'UPDATE sync_runs SET finished_at = ?, status = ?, error = ? WHERE id = ?'
    ).run(Date.now(), signal.aborted ? 'cancelled' : 'error', String(err.message || err), current.runId)
    throw err
  } finally {
    current = null
  }
}
```

### B.6 `server/src/reports.js` (part 1 of 2 — authoritative over A.1–A.4)

```js
import { db } from './db.js'
import { activeCloudId } from './oauth.js'

const DAY = 86_400_000

/* ------------------------------------------------------------------ scope */

function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',')
}

/**
 * Resolve a selection into a concrete issue set.
 *
 * `roots` are issue keys (an initiative, epic or idea); `projects` are project
 * keys. With `descendants` on, every issue beneath a root via parent links is
 * included. `followLinks` additionally walks outward issue links once, which is
 * how a Product Discovery idea reaches its delivery tickets.
 */
export function resolveScope({
  projects = [],
  roots = [],
  types = [],
  descendants = true,
  followLinks = false,
  cloudId = activeCloudId(),
} = {}) {
  if (!cloudId) return { cloudId: null, issues: [] }

  let seedIds = []

  if (roots.length) {
    seedIds = db
      .prepare(
        `SELECT id FROM issues WHERE cloud_id = ? AND (key IN (${placeholders(
          roots.length
        )}) OR id IN (${placeholders(roots.length)}))`
      )
      .all(cloudId, ...roots, ...roots)
      .map((r) => r.id)
  } else if (projects.length) {
    seedIds = db
      .prepare(
        `SELECT id FROM issues WHERE cloud_id = ? AND project_key IN (${placeholders(
          projects.length
        )})`
      )
      .all(cloudId, ...projects)
      .map((r) => r.id)
  } else {
    seedIds = db.prepare('SELECT id FROM issues WHERE cloud_id = ?').all(cloudId).map((r) => r.id)
  }

  if (!seedIds.length) return { cloudId, issues: [] }

  let ids = new Set(seedIds)

  if (descendants && roots.length) {
    if (followLinks) {
      const linked = db
        .prepare(
          `SELECT target_id AS id FROM issue_links
           WHERE cloud_id = ? AND direction = 'outward' AND source_id IN (${placeholders(
             seedIds.length
           )})`
        )
        .all(cloudId, ...seedIds)
      for (const r of linked) ids.add(r.id)
    }

    const frontier = [...ids]
    const rows = db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM issues WHERE cloud_id = @cid AND id IN (${placeholders(frontier.length)})
           UNION
           SELECT c.id FROM issues c JOIN tree t ON c.parent_id = t.id WHERE c.cloud_id = @cid
         )
         SELECT id FROM tree`
      )
      .all({ cid: cloudId }, ...frontier)
    for (const r of rows) ids.add(r.id)
  }

  const idList = [...ids]
  const issues = []
  const chunk = 900 // stay under SQLite's variable limit
  for (let i = 0; i < idList.length; i += chunk) {
    const part = idList.slice(i, i + chunk)
    issues.push(
      ...db
        .prepare(
          `SELECT * FROM issues WHERE cloud_id = ? AND id IN (${placeholders(part.length)})`
        )
        .all(cloudId, ...part)
    )
  }

  const filtered = types.length
    ? issues.filter((i) => types.includes(i.type_name) || types.includes(String(i.hierarchy_level)))
    : issues

  return { cloudId, issues: filtered }
}

/* ---------------------------------------------------------------- metrics */

export const METRICS = {
  count: { label: 'Issues', value: () => 1, format: 'count' },
  points: { label: 'Story points', value: (i) => i.story_points || 0, format: 'number' },
  timespent: { label: 'Time logged', value: (i) => (i.time_spent || 0) / 3600, format: 'hours' },
}

export function metricValue(issue, metric = 'count') {
  return (METRICS[metric] || METRICS.count).value(issue)
}

export function summarise(issues, metric = 'count') {
  const total = issues.reduce((s, i) => s + metricValue(i, metric), 0)
  const byCategory = { new: 0, indeterminate: 0, done: 0 }
  for (const i of issues) {
    const key = i.status_category || 'new'
    byCategory[key] = (byCategory[key] || 0) + metricValue(i, metric)
  }
  const counts = { new: 0, indeterminate: 0, done: 0 }
  for (const i of issues) {
    const key = i.status_category || 'new'
    counts[key] = (counts[key] || 0) + 1
  }

  const estimated = issues.filter((i) => (i.story_points || 0) > 0).length
  return {
    metric,
    total,
    issues: issues.length,
    byCategory,
    counts,
    percentComplete: total > 0 ? (byCategory.done / total) * 100 : 0,
    percentInProgress: total > 0 ? (byCategory.indeterminate / total) * 100 : 0,
    points: issues.reduce((s, i) => s + (i.story_points || 0), 0),
    hours: issues.reduce((s, i) => s + (i.time_spent || 0), 0) / 3600,
    estimatedCoverage: issues.length ? (estimated / issues.length) * 100 : 0,
    assignees: new Set(issues.filter((i) => i.assignee_id).map((i) => i.assignee_id)).size,
    unassigned: issues.filter((i) => !i.assignee_id).length,
  }
}

/* -------------------------------------------------- cumulative flow (CFD) */

function statusHistoryFor(cloudId, issueIds) {
  const map = new Map()
  const chunk = 900
  for (let i = 0; i < issueIds.length; i += chunk) {
    const part = issueIds.slice(i, i + chunk)
    const rows = db
      .prepare(
        `SELECT issue_id, at, from_id, from_status, to_id, to_status
         FROM status_history
         WHERE cloud_id = ? AND issue_id IN (${placeholders(part.length)})
         ORDER BY at ASC`
      )
      .all(cloudId, ...part)
    for (const r of rows) {
      if (!map.has(r.issue_id)) map.set(r.issue_id, [])
      map.get(r.issue_id).push(r)
    }
  }
  return map
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10)
}

/**
 * Daily count of issues sitting in each status (or status category).
 *
 * Each issue contributes a step function: it enters at `created` in whatever
 * status its first recorded transition came *from* (falling back to its current
 * status when there is no history), then moves on each transition. Snapshots are
 * taken at every day boundary in the window.
 */
export function cumulativeFlow({
  issues,
  cloudId = activeCloudId(),
  from,
  to,
  groupBy = 'status',
  metric = 'count',
}) {
  if (!issues.length) return { series: [], keys: [], order: [], empty: true }

  const history = statusHistoryFor(cloudId, issues.map((i) => i.id))
  const statusMeta = new Map(
    db
      .prepare('SELECT id, name, category_key FROM statuses WHERE cloud_id = ?')
      .all(cloudId)
      .map((s) => [String(s.id), s])
  )

  const categoryLabel = { new: 'To do', indeterminate: 'In progress', done: 'Done' }

  const labelFor = (statusId, statusName) => {
    if (groupBy === 'category') {
      const cat = statusMeta.get(String(statusId))?.category_key || 'indeterminate'
      return categoryLabel[cat] || cat
    }
    return statusMeta.get(String(statusId))?.name || statusName || 'Unknown'
  }

  const toMs = (s) => (s ? new Date(s).getTime() : null)

  // Build per-issue event lists, and learn the workflow order while doing it.
  const orderScore = new Map() // label -> { sum, n, category }
  const noteOrder = (label, idx, category) => {
    if (!orderScore.has(label)) orderScore.set(label, { sum: 0, n: 0, category })
    const e = orderScore.get(label)
    e.sum += idx
    e.n += 1
    if (category) e.category = category
  }

  const events = [] // { t, label, delta, weight }
  let minT = Infinity
  let maxT = -Infinity

  for (const issue of issues) {
    const w = metricValue(issue, metric)
    if (!w) continue
    const created = toMs(issue.created)
    if (!created) continue
    const hist = (history.get(issue.id) || []).filter((h) => toMs(h.at) !== null)

    const firstLabel = hist.length
      ? labelFor(hist[0].from_id, hist[0].from_status)
      : labelFor(issue.status_id, issue.status_name)
    const firstCat = hist.length
      ? statusMeta.get(String(hist[0].from_id))?.category_key
      : issue.status_category

    events.push({ t: created, label: firstLabel, delta: w })
    noteOrder(firstLabel, 0, firstCat)
    minT = Math.min(minT, created)
    maxT = Math.max(maxT, created)

    let prev = firstLabel
    hist.forEach((h, idx) => {
      const t = Math.max(toMs(h.at), created)
      const next = labelFor(h.to_id, h.to_status)
      if (next === prev) return
      events.push({ t, label: prev, delta: -w })
      events.push({ t, label: next, delta: w })
      noteOrder(next, idx + 1, statusMeta.get(String(h.to_id))?.category_key)
      prev = next
      minT = Math.min(minT, t)
      maxT = Math.max(maxT, t)
    })
  }

  if (!events.length) return { series: [], keys: [], order: [], empty: true }

  const start = from ? new Date(from).getTime() : minT
  const end = to ? new Date(to).getTime() : Math.max(maxT, Date.now())
  const endDay = Math.floor(end / DAY) * DAY + DAY - 1

  events.sort((a, b) => a.t - b.t)

  // Workflow order: status category first, then average position in the flow.
  const catRank = { new: 0, indeterminate: 1, done: 2 }
  const order = [...orderScore.entries()]
    .map(([label, e]) => ({ label, mean: e.sum / e.n, rank: catRank[e.category] ?? 1 }))
    .sort((a, b) => a.rank - b.rank || a.mean - b.mean)
    .map((e) => e.label)

  const tally = new Map(order.map((k) => [k, 0]))
  const series = []
  let cursor = 0

  for (let day = Math.floor(start / DAY) * DAY; day <= endDay; day += DAY) {
    const boundary = day + DAY - 1
    while (cursor < events.length && events[cursor].t <= boundary) {
      const e = events[cursor]
      tally.set(e.label, (tally.get(e.label) || 0) + e.delta)
      cursor += 1
    }
    const point = { date: dayKey(day) }
    for (const k of order) point[k] = Math.max(0, Number((tally.get(k) || 0).toFixed(3)))
    series.push(point)
  }

  // Drop leading all-zero days so the chart starts where work starts.
  let firstNonEmpty = series.findIndex((p) => order.some((k) => p[k] > 0))
  if (firstNonEmpty > 0) series.splice(0, firstNonEmpty)

  return { series, keys: order, order, groupBy, metric, empty: series.length === 0 }
}

/* -------------------------------------------------------------- hierarchy */

function nearestAncestorAtLevel(issue, byId, level) {
  let cur = issue
  const seen = new Set()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.hierarchy_level === level) return cur
    if (cur.hierarchy_level > level) return null
    cur = cur.parent_id ? byId.get(cur.parent_id) : null
  }
  return null
}

function ancestorAtOrAbove(issue, byId, level) {
  let cur = issue
  const seen = new Set()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.hierarchy_level >= level) return cur
    cur = cur.parent_id ? byId.get(cur.parent_id) : null
  }
  return null
}

/** Nest an issue set into a parent/child tree with rolled-up completion. */
export function buildTree({ issues, metric = 'count', rootIds = null }) {
  const byId = new Map(issues.map((i) => [i.id, i]))
  const nodes = new Map()

  for (const i of issues) {
    nodes.set(i.id, {
      id: i.id,
      key: i.key,
      summary: i.summary,
      type: i.type_name,
      level: i.hierarchy_level,
      status: i.status_name,
      category: i.status_category,
      assignee: i.assignee_name,
      assigneeId: i.assignee_id,
      project: i.project_key,
      points: i.story_points || 0,
      hours: (i.time_spent || 0) / 3600,
      created: i.created,
      resolved: i.resolved,
      updated: i.updated,
      children: [],
    })
  }

  const roots = []
  for (const i of issues) {
    const node = nodes.get(i.id)
    const parent = i.parent_id ? nodes.get(i.parent_id) : null
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }

  const rollup = (node) => {
    let total = 0
    let done = 0
    let inProgress = 0
    let leaves = 0
    let leafDone = 0

    const own = metric === 'points' ? node.points : metric === 'timespent' ? node.hours : 1
    if (!node.children.length) {
      leaves = 1
      leafDone = node.category === 'done' ? 1 : 0
      total = own
      done = node.category === 'done' ? own : 0
      inProgress = node.category === 'indeterminate' ? own : 0
    } else {
      for (const c of node.children) {
        const r = rollup(c)
        total += r.total
        done += r.done
        inProgress += r.inProgress
        leaves += r.leaves
        leafDone += r.leafDone
      }
      // A parent with children whose children carry no metric value still has
      // its own value (e.g. an epic with unestimated stories).
      if (total === 0 && own > 0) {
        total = own
        done = node.category === 'done' ? own : 0
      }
    }

    node.rollup = {
      total,
      done,
      inProgress,
      todo: Math.max(0, total - done - inProgress),
      leaves,
      leafDone,
      percent: total > 0 ? (done / total) * 100 : 0,
      countPercent: leaves > 0 ? (leafDone / leaves) * 100 : 0,
    }
    return node.rollup
  }

  for (const r of roots) rollup(r)

  const filtered = rootIds ? roots.filter((r) => rootIds.includes(r.id) || rootIds.includes(r.key)) : roots
  filtered.sort((a, b) => (b.rollup.total - a.rollup.total) || a.key.localeCompare(b.key))
  return filtered
}

/* ----------------------------------------------------------------- sankey */

const DIMENSIONS = {
  assignee: {
    label: 'Assignee',
    of: (i) => i.assignee_name || 'Unassigned',
    id: (i) => i.assignee_id || 'unassigned',
  },
  reporter: { label: 'Reporter', of: (i) => i.reporter_name || 'Unknown', id: (i) => i.reporter_id || 'unknown' },
  project: { label: 'Project', of: (i) => i.project_key || 'None', id: (i) => i.project_key || 'none' },
  status: { label: 'Status', of: (i) => i.status_name || 'Unknown', id: (i) => `s:${i.status_id}` },
  category: {
    label: 'Progress',
    of: (i) => ({ new: 'To do', indeterminate: 'In progress', done: 'Done' })[i.status_category] || 'Unknown',
    id: (i) => `c:${i.status_category}`,
  },
  type: { label: 'Issue type', of: (i) => i.type_name || 'Unknown', id: (i) => `t:${i.type_id}` },
  priority: { label: 'Priority', of: (i) => i.priority || 'None', id: (i) => `p:${i.priority || 'none'}` },
  epic: { label: 'Epic', hierarchy: 1 },
  initiative: { label: 'Initiative', hierarchy: 2, orAbove: true },
}

export const SANKEY_DIMENSIONS = Object.entries(DIMENSIONS).map(([k, v]) => ({
  key: k,
  label: v.label,
}))

/**
 * Flow between ordered dimensions, e.g. assignee -> epic -> progress.
 * Node ids are namespaced by column so the same name in two columns stays two
 * nodes, and a value stays with the entity rather than its rank.
 */
export function sankey({ issues, dimensions = ['assignee', 'epic', 'category'], metric = 'count', maxPerColumn = 12 }) {
  const byId = new Map(issues.map((i) => [i.id, i]))
  const dims = dimensions.filter((d) => DIMENSIONS[d]).slice(0, 4)
  if (dims.length < 2) return { nodes: [], links: [], dimensions: dims }

  const resolve = (issue, dim) => {
    const def = DIMENSIONS[dim]
    if (def.hierarchy !== undefined) {
      const node = def.orAbove
        ? ancestorAtOrAbove(issue, byId, def.hierarchy)
        : nearestAncestorAtLevel(issue, byId, def.hierarchy)
      if (!node) return { id: `${dim}:none`, name: `No ${def.label.toLowerCase()}` }
      return { id: `${dim}:${node.id}`, name: `${node.key} ${node.summary}`.slice(0, 60), key: node.key }
    }
    return { id: `${dim}:${def.id(issue)}`, name: String(def.of(issue)) }
  }

  // Column totals decide which members survive the per-column cap.
  const columnTotals = dims.map(() => new Map())
  const rowsForIssue = []

  for (const issue of issues) {
    const w = metricValue(issue, metric)
    if (!w) continue
    const path = dims.map((d) => resolve(issue, d))
    rowsForIssue.push({ path, w })
    path.forEach((p, c) => {
      const m = columnTotals[c]
      m.set(p.id, { ...p, value: (m.get(p.id)?.value || 0) + w })
    })
  }

  const keep = columnTotals.map((m, c) => {
    const sorted = [...m.values()].sort((a, b) => b.value - a.value)
    const survivors = new Set(sorted.slice(0, maxPerColumn).map((n) => n.id))
    return { survivors, dropped: Math.max(0, sorted.length - maxPerColumn), col: c }
  })

  const nodes = new Map()
  const links = new Map()

  const nodeFor = (p, col) => {
    const kept = keep[col].survivors.has(p.id)
    const id = kept ? p.id : `${dims[col]}:__other__`
    const name = kept ? p.name : `Other (${keep[col].dropped})`
    if (!nodes.has(id)) {
      nodes.set(id, { id, name, column: col, dimension: dims[col], value: 0, key: p.key })
    }
    return nodes.get(id)
  }

  for (const { path, w } of rowsForIssue) {
    const resolved = path.map((p, c) => nodeFor(p, c))
    resolved.forEach((n) => {
      n.value += w
    })
    for (let c = 0; c < resolved.length - 1; c += 1) {
      const key = `${resolved[c].id}\u0000${resolved[c + 1].id}`
      const existing = links.get(key)
      if (existing) existing.value += w
      else links.set(key, { source: resolved[c].id, target: resolved[c + 1].id, value: w })
    }
  }

  return {
    nodes: [...nodes.values()],
    links: [...links.values()].filter((l) => l.value > 0),
    dimensions: dims,
    metric,
    truncated: keep.some((k) => k.dropped > 0),
  }
}

/* ------------------------------------------------------------ per-person */

export function peopleBreakdown({ issues, metric = 'count' }) {
  const map = new Map()
  for (const i of issues) {
    const id = i.assignee_id || 'unassigned'
    if (!map.has(id)) {
      map.set(id, {
        id,
        name: i.assignee_name || 'Unassigned',
        avatar: i.assignee_avatar,
        total: 0,
        done: 0,
        inProgress: 0,
        todo: 0,
        issues: 0,
        points: 0,
        hours: 0,
      })
    }
    const e = map.get(id)
    const w = metricValue(i, metric)
    e.total += w
    e.issues += 1
    e.points += i.story_points || 0
    e.hours += (i.time_spent || 0) / 3600
    if (i.status_category === 'done') e.done += w
    else if (i.status_category === 'indeterminate') e.inProgress += w
    else e.todo += w
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
}
```

*(B.6 continues in the next block — the file is split across two fenced blocks
purely for document length; concatenate B.6 part 1 and part 2 into one file.)*

### B.6 `server/src/reports.js` (part 2 of 2 — continues directly after `peopleBreakdown`)

```js
/* ---------------------------------------------------------------- burn-up */

/**
 * The story of a scope over time: how much work existed each day, how much of
 * it was done, and — per week — how much arrived versus finished. Rebuilt from
 * issue change history, counting leaf issues only.
 */
export function burnup({ issues, cloudId = activeCloudId(), metric = 'count', from }) {
  const parents = new Set(issues.map((i) => i.parent_id).filter(Boolean))
  const leaves = issues.filter((i) => !parents.has(i.id))
  if (!leaves.length) return { series: [], weekly: [], empty: true }

  const history = statusHistoryFor(cloudId, leaves.map((i) => i.id))
  const statusMeta = new Map(
    db.prepare('SELECT id, category_key FROM statuses WHERE cloud_id = ?').all(cloudId)
      .map((s) => [String(s.id), s.category_key])
  )
  const catOf = (statusId, fallback = 'indeterminate') =>
    statusMeta.get(String(statusId)) || fallback

  const toMs = (s) => (s ? new Date(s).getTime() : null)
  const scopeEvents = [] // { t, w }
  const doneEvents = [] // { t, w } (negative when leaving done)
  const perIssue = [] // { created, firstDone, w }
  let minT = Infinity

  for (const issue of leaves) {
    const w = metricValue(issue, metric)
    if (!w) continue
    const created = toMs(issue.created)
    if (!created) continue
    minT = Math.min(minT, created)
    scopeEvents.push({ t: created, w })

    const hist = (history.get(issue.id) || []).filter((h) => toMs(h.at) !== null)
    let cat = hist.length ? catOf(hist[0].from_id, 'new') : issue.status_category || 'new'
    let firstDone = null

    if (cat === 'done') {
      doneEvents.push({ t: created, w })
      firstDone = created
    }
    for (const h of hist) {
      const t = Math.max(toMs(h.at), created)
      const next = catOf(h.to_id)
      if (next === 'done' && cat !== 'done') {
        doneEvents.push({ t, w })
        if (firstDone === null) firstDone = t
      } else if (next !== 'done' && cat === 'done') {
        doneEvents.push({ t, w: -w })
      }
      cat = next
    }
    // Current state wins when history is missing its final hop.
    if (cat !== 'done' && issue.status_category === 'done') {
      const t = toMs(issue.resolved) ?? toMs(issue.status_changed) ?? created
      doneEvents.push({ t: Math.max(t, created), w })
      if (firstDone === null) firstDone = Math.max(t, created)
    }
    perIssue.push({ created, firstDone, w })
  }

  if (!scopeEvents.length) return { series: [], weekly: [], empty: true }

  scopeEvents.sort((a, b) => a.t - b.t)
  doneEvents.sort((a, b) => a.t - b.t)

  const start = Math.floor(minT / DAY) * DAY
  const end = Date.now()
  const fromMs = from ? new Date(from).getTime() : start
  const series = []
  let scope = 0
  let done = 0
  let si = 0
  let di = 0

  for (let day = start; day <= end; day += DAY) {
    const boundary = day + DAY - 1
    while (si < scopeEvents.length && scopeEvents[si].t <= boundary) scope += scopeEvents[si++].w
    while (di < doneEvents.length && doneEvents[di].t <= boundary) done += doneEvents[di++].w
    if (boundary < fromMs) continue
    series.push({
      date: dayKey(day),
      scope: Number(scope.toFixed(2)),
      done: Number(Math.max(0, done).toFixed(2)),
      pct: scope > 0 ? Number(((Math.max(0, done) / scope) * 100).toFixed(2)) : 0,
    })
  }

  // Long histories get thinned so the chart stays a readable series.
  const step = Math.ceil(series.length / 400)
  const thinned = step > 1 ? series.filter((_, i) => i % step === 0 || i === series.length - 1) : series

  const weekStart = (ts) => {
    const d = new Date(ts)
    const day = (d.getUTCDay() + 6) % 7
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)
  }
  const weekly = new Map()
  const bucket = (t) => {
    const k = dayKey(weekStart(t))
    if (!weekly.has(k)) weekly.set(k, { week: k, added: 0, completed: 0 })
    return weekly.get(k)
  }
  for (const p of perIssue) {
    if (p.created >= fromMs) bucket(p.created).added += p.w
    if (p.firstDone !== null && p.firstDone >= fromMs) bucket(p.firstDone).completed += p.w
  }

  return {
    metric,
    series: thinned,
    weekly: [...weekly.values()].sort((a, b) => a.week.localeCompare(b.week)),
  }
}

/* ------------------------------------------------------- temporal network */

/**
 * The delivery network with time attached: each node carries its creation time
 * and category transitions, so the client can replay the scope's history.
 */
export function graphTimeline({ issues, cloudId = activeCloudId(), maxStories = 250 }) {
  const always = issues.filter((i) => i.hierarchy_level >= 1 || i.type_name === 'Idea')
  const stories = issues
    .filter((i) => i.hierarchy_level === 0 && i.type_name !== 'Idea')
    .sort((a, b) => (a.created || '').localeCompare(b.created || ''))
  const kept = stories.slice(0, maxStories)
  const included = [...always, ...kept]
  const nodeSet = new Map(included.map((i) => [i.id, i]))

  const history = statusHistoryFor(cloudId, included.map((i) => i.id))
  const statusMeta = new Map(
    db.prepare('SELECT id, category_key FROM statuses WHERE cloud_id = ?').all(cloudId)
      .map((s) => [String(s.id), s.category_key])
  )
  const catOf = (statusId, fallback = 'indeterminate') =>
    statusMeta.get(String(statusId)) || fallback
  const toMs = (s) => (s ? new Date(s).getTime() : null)

  const nodes = included
    .map((i) => {
      const created = toMs(i.created)
      if (!created) return null
      const hist = (history.get(i.id) || []).filter((h) => toMs(h.at) !== null)
      const initial = hist.length ? catOf(hist[0].from_id, 'new') : i.status_category || 'new'
      const transitions = []
      let cat = initial
      for (const h of hist) {
        const next = catOf(h.to_id)
        if (next === cat) continue
        transitions.push({ at: Math.max(toMs(h.at), created), cat: next })
        cat = next
      }
      if (!hist.length && (i.status_category || 'new') !== initial) {
        transitions.push({ at: toMs(i.status_changed) ?? created, cat: i.status_category })
      }
      return {
        id: i.id,
        key: i.key,
        summary: i.summary,
        type: i.type_name,
        level: i.hierarchy_level,
        project: i.project_key,
        created,
        initial,
        transitions,
      }
    })
    .filter(Boolean)

  const edges = []
  for (const i of included) {
    if (i.parent_id && nodeSet.has(i.parent_id)) {
      edges.push({ source: i.parent_id, target: i.id, kind: 'parent' })
    }
  }
  const ids = [...nodeSet.keys()]
  const chunk = 450
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk)
    const rows = db
      .prepare(
        `SELECT source_id, target_id, type FROM issue_links
         WHERE cloud_id = ? AND direction = 'outward'
           AND source_id IN (${placeholders(part.length)})`
      )
      .all(cloudId, ...part)
    for (const r of rows) {
      if (nodeSet.has(r.target_id)) {
        edges.push({ source: r.source_id, target: r.target_id, kind: 'link', label: r.type })
      }
    }
  }

  return { nodes, edges, storiesDropped: Math.max(0, stories.length - maxStories) }
}

/* ------------------------------------------------------------ chord flows */

/**
 * Directed flows between entities of one kind, for a chord diagram.
 *
 * `handovers` — who hands work to whom, from assignee change history.
 * `projects`  — issue links crossing project boundaries.
 *
 * Entities are capped at 8 (the categorical palette's limit); the rest fold
 * into "Other", and self-flows are dropped after folding.
 */
export function chordFlows({ issues, cloudId = activeCloudId(), flow = 'handovers', maxEntities = 8 }) {
  const raw = new Map()

  const add = (from, to, v = 1) => {
    if (!from || !to || from === to) return
    const k = `${from}\u0000${to}`
    raw.set(k, (raw.get(k) || 0) + v)
  }

  if (flow === 'projects') {
    const inScope = new Set(issues.map((i) => i.id))
    const ids = [...inScope]
    const chunk = 900
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk)
      const rows = db
        .prepare(
          `SELECT s.project_key AS a, t.project_key AS b, COUNT(*) AS n
           FROM issue_links l
           JOIN issues s ON s.cloud_id = l.cloud_id AND s.id = l.source_id
           JOIN issues t ON t.cloud_id = l.cloud_id AND t.id = l.target_id
           WHERE l.cloud_id = ? AND l.direction = 'outward'
             AND l.source_id IN (${placeholders(part.length)})
           GROUP BY s.project_key, t.project_key`
        )
        .all(cloudId, ...part)
      for (const r of rows) add(r.a, r.b, r.n)
    }
  } else {
    const ids = issues.map((i) => i.id)
    const chunk = 900
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk)
      const rows = db
        .prepare(
          `SELECT from_name AS a, to_name AS b, COUNT(*) AS n
           FROM assignee_history
           WHERE cloud_id = ? AND from_id IS NOT NULL AND to_id IS NOT NULL
             AND issue_id IN (${placeholders(part.length)})
           GROUP BY from_name, to_name`
        )
        .all(cloudId, ...part)
      for (const r of rows) add(r.a, r.b, r.n)
    }
  }

  // Rank entities by total involvement, fold the tail into "Other".
  const totals = new Map()
  for (const [k, v] of raw) {
    const [a, b] = k.split('\u0000')
    totals.set(a, (totals.get(a) || 0) + v)
    totals.set(b, (totals.get(b) || 0) + v)
  }
  const ranked = [...totals.entries()].sort((x, y) => y[1] - x[1])
  const keep = new Set(ranked.slice(0, maxEntities).map(([name]) => name))
  const fold = (name) => (keep.has(name) ? name : 'Other')

  const flows = new Map()
  for (const [k, v] of raw) {
    const [a, b] = k.split('\u0000')
    const fa = fold(a)
    const fb = fold(b)
    if (fa === fb) continue
    const fk = `${fa}\u0000${fb}`
    flows.set(fk, (flows.get(fk) || 0) + v)
  }

  const entities = ranked.filter(([name]) => keep.has(name)).map(([name, total]) => ({ id: name, name, total }))
  if (ranked.length > maxEntities) {
    entities.push({ id: 'Other', name: `Other (${ranked.length - maxEntities})`, total: 0 })
  }

  return {
    flow,
    entities,
    flows: [...flows.entries()].map(([k, value]) => {
      const [source, target] = k.split('\u0000')
      return { source, target, value }
    }),
    truncated: ranked.length > maxEntities,
  }
}

/* ------------------------------------------------------------- cycle time */

function quantile(sorted, p) {
  if (!sorted.length) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/** Days from created to resolved, grouped — the dot-plot's data. */
export function cycleTime({ issues, groupBy = 'epic' }) {
  const byId = new Map(issues.map((i) => [i.id, i]))

  const groupOf = (issue) => {
    if (groupBy === 'assignee') return issue.assignee_name || 'Unassigned'
    if (groupBy === 'project') return issue.project_key || 'None'
    const epic = nearestAncestorAtLevel(issue, byId, 1)
    return epic ? `${epic.key} ${epic.summary}` : 'No epic'
  }

  const groups = new Map()
  for (const i of issues) {
    if (!i.resolved || !i.created || i.hierarchy_level > 0) continue
    const days = (new Date(i.resolved) - new Date(i.created)) / DAY
    if (!Number.isFinite(days) || days < 0) continue
    const key = groupOf(i)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(days)
  }

  const rows = [...groups.entries()]
    .map(([name, arr]) => {
      const sorted = arr.sort((a, b) => a - b)
      return {
        name,
        n: sorted.length,
        p50: quantile(sorted, 0.5),
        p90: quantile(sorted, 0.9),
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
      }
    })
    .filter((r) => r.n >= 2)
    .sort((a, b) => b.p50 - a.p50)

  return { groupBy, rows }
}

/* ---------------------------------------------------------------- network */

/**
 * The delivery network: initiatives, epics and ideas as nodes; parent edges and
 * issue links as edges. Leaf work rolls up into each node's size/completion.
 */
export function graphData({ issues, includeStories = false, maxStories = 120 }) {
  const byId = new Map(issues.map((i) => [i.id, i]))
  const nodeSet = new Map()

  for (const i of issues) {
    if (i.hierarchy_level >= 1 || i.type_name === 'Idea') nodeSet.set(i.id, i)
  }

  // Roll leaves up into every ancestor that is a node.
  const rollups = new Map() // nodeId -> { leaves, done, points }
  const bump = (nodeId, issue) => {
    if (!rollups.has(nodeId)) rollups.set(nodeId, { leaves: 0, done: 0, points: 0 })
    const r = rollups.get(nodeId)
    r.leaves += 1
    r.points += issue.story_points || 0
    if (issue.status_category === 'done') r.done += 1
  }
  for (const i of issues) {
    if (i.hierarchy_level >= 1) continue
    let cur = i
    const seen = new Set()
    while (cur?.parent_id && !seen.has(cur.parent_id)) {
      seen.add(cur.parent_id)
      if (nodeSet.has(cur.parent_id)) bump(cur.parent_id, i)
      cur = byId.get(cur.parent_id)
    }
  }

  let storyCount = 0
  let storiesDropped = 0
  if (includeStories) {
    for (const i of issues) {
      if (i.hierarchy_level !== 0 || i.type_name === 'Idea') continue
      if (!i.parent_id || !nodeSet.has(i.parent_id)) continue
      if (storyCount >= maxStories) {
        storiesDropped += 1
        continue
      }
      nodeSet.set(i.id, i)
      storyCount += 1
    }
  }

  const nodes = [...nodeSet.values()].map((i) => {
    const r = rollups.get(i.id)
    return {
      id: i.id,
      key: i.key,
      summary: i.summary,
      type: i.type_name,
      level: i.hierarchy_level,
      project: i.project_key,
      category: i.status_category,
      assignee: i.assignee_name,
      leaves: r?.leaves ?? 0,
      done: r?.done ?? 0,
      points: r?.points ?? (i.story_points || 0),
    }
  })

  const edges = []
  for (const i of nodeSet.values()) {
    if (i.parent_id && nodeSet.has(i.parent_id)) {
      edges.push({ source: i.parent_id, target: i.id, kind: 'parent' })
    }
  }
  const ids = [...nodeSet.keys()]
  const chunk = 450
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk)
    const rows = db
      .prepare(
        `SELECT source_id, target_id, type FROM issue_links
         WHERE cloud_id = ? AND direction = 'outward'
           AND source_id IN (${placeholders(part.length)})`
      )
      .all(activeCloudId(), ...part)
    for (const r of rows) {
      if (nodeSet.has(r.target_id)) {
        edges.push({ source: r.source_id, target: r.target_id, kind: 'link', label: r.type })
      }
    }
  }

  return { nodes, edges, storiesDropped }
}

/** Issues resolved per week — the throughput companion to the CFD. */
export function throughput({ issues, weeks = 12 }) {
  const now = Date.now()
  const startOfWeek = (ts) => {
    const d = new Date(ts)
    const day = (d.getUTCDay() + 6) % 7 // Monday = 0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)
  }
  const buckets = new Map()
  for (let w = weeks - 1; w >= 0; w -= 1) {
    buckets.set(dayKey(startOfWeek(now - w * 7 * DAY)), { week: dayKey(startOfWeek(now - w * 7 * DAY)), count: 0, points: 0 })
  }
  for (const i of issues) {
    if (!i.resolved) continue
    const k = dayKey(startOfWeek(new Date(i.resolved).getTime()))
    const b = buckets.get(k)
    if (b) {
      b.count += 1
      b.points += i.story_points || 0
    }
  }
  return [...buckets.values()]
}
```

### B.7 `server/src/routes.js`

```js
import express from 'express'
import { db, getConfig, setConfig } from './db.js'
import { WEB_ORIGIN } from './config.js'
import {
  authStatus,
  buildAuthUrl,
  consumeState,
  exchangeCode,
  disconnect,
  fetchAccessibleResources,
  setCredentials,
  activeCloudId,
} from './oauth.js'
import { runSync, syncStatus, cancelSync } from './sync.js'
import {
  resolveScope,
  summarise,
  cumulativeFlow,
  buildTree,
  sankey,
  peopleBreakdown,
  throughput,
  chordFlows,
  cycleTime,
  graphData,
  burnup,
  graphTimeline,
  SANKEY_DIMENSIONS,
  METRICS,
} from './reports.js'

export const router = express.Router()

const csv = (v) =>
  typeof v === 'string' && v.length ? v.split(',').map((s) => s.trim()).filter(Boolean) : []

function scopeFrom(query) {
  return resolveScope({
    projects: csv(query.projects),
    roots: csv(query.roots),
    types: csv(query.types),
    descendants: query.descendants !== 'false',
    followLinks: query.followLinks === 'true',
  })
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500
      res.status(status).json({ error: String(err.message || err) })
    }
  }
}

/* ------------------------------------------------------------------- auth */

router.get('/auth/status', (req, res) => res.json(authStatus()))

router.post('/auth/credentials', wrap(async (req, res) => {
  const { clientId, clientSecret, redirectUri, scopes } = req.body || {}
  setCredentials({ clientId, clientSecret, redirectUri, scopes })
  res.json(authStatus())
}))

router.get('/auth/login', wrap(async (req, res) => {
  res.redirect(buildAuthUrl())
}))

router.get('/auth/callback', async (req, res) => {
  const back = (params) => res.redirect(`${WEB_ORIGIN}/settings?${new URLSearchParams(params)}`)
  try {
    if (req.query.error) return back({ error: String(req.query.error_description || req.query.error) })
    if (!consumeState(String(req.query.state || ''))) {
      return back({ error: 'OAuth state mismatch — start the connection again' })
    }
    await exchangeCode(String(req.query.code))
    await fetchAccessibleResources()
    return back({ connected: '1' })
  } catch (err) {
    return back({ error: String(err.message || err) })
  }
})

router.post('/auth/disconnect', wrap(async (req, res) => {
  disconnect()
  res.json(authStatus())
}))

/* ------------------------------------------------------------------ sites */

router.get('/sites', wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM sites').all()
  res.json({ sites: rows, active: activeCloudId() })
}))

router.post('/sites/refresh', wrap(async (req, res) => {
  const sites = await fetchAccessibleResources()
  res.json({ sites, active: activeCloudId() })
}))

router.post('/sites/select', wrap(async (req, res) => {
  setConfig('cloud_id', req.body?.cloudId)
  res.json({ active: activeCloudId() })
}))

/* --------------------------------------------------------------- projects */

router.get('/projects', wrap(async (req, res) => {
  const cloudId = activeCloudId()
  const rows = cloudId
    ? db.prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM issues i WHERE i.cloud_id = p.cloud_id AND i.project_id = p.id) AS issue_count
         FROM projects p WHERE p.cloud_id = ? ORDER BY p.key`
      ).all(cloudId)
    : []
  res.json({ projects: rows, selected: getConfig('sync_projects', []) })
}))

router.post('/projects/select', wrap(async (req, res) => {
  setConfig('sync_projects', req.body?.keys || [])
  res.json({ selected: getConfig('sync_projects', []) })
}))

/* ------------------------------------------------------------------- sync */

router.post('/sync', wrap(async (req, res) => {
  if (syncStatus().running) return res.status(409).json({ error: 'A sync is already running' })
  const mode = req.body?.mode === 'full' ? 'full' : 'incremental'
  if (mode === 'full') setConfig('last_issue_sync', null)
  // Fire and forget; the client polls /sync/status, which also surfaces errors.
  runSync({ mode }).catch((err) => console.error('[sync]', err))
  res.json({ started: true, mode })
}))

router.get('/sync/status', (req, res) => res.json(syncStatus()))

router.post('/sync/cancel', wrap(async (req, res) => {
  res.json({ cancelled: cancelSync() })
}))

/* ---------------------------------------------------------------- catalog */

router.get('/catalog', wrap(async (req, res) => {
  const cloudId = activeCloudId()
  if (!cloudId) return res.json({ ready: false })

  const levels = db.prepare(
    `SELECT hierarchy_level AS level, type_name AS name, COUNT(*) AS n
     FROM issues WHERE cloud_id = ? GROUP BY hierarchy_level, type_name ORDER BY level DESC, n DESC`
  ).all(cloudId)

  const statuses = db.prepare(
    `SELECT status_name AS name, status_category AS category, COUNT(*) AS n
     FROM issues WHERE cloud_id = ? GROUP BY status_name, status_category ORDER BY n DESC`
  ).all(cloudId)

  const projects = db.prepare(
    `SELECT key, name, type_key, n FROM (
       SELECT p.key, p.name, p.type_key,
              (SELECT COUNT(*) FROM issues i WHERE i.cloud_id = p.cloud_id AND i.project_id = p.id) AS n
       FROM projects p WHERE p.cloud_id = ?
     ) WHERE n > 0 ORDER BY key`
  ).all(cloudId)

  const totals = db.prepare(
    'SELECT COUNT(*) AS issues, MAX(updated) AS newest FROM issues WHERE cloud_id = ?'
  ).get(cloudId)

  res.json({
    ready: totals.issues > 0,
    levels,
    statuses,
    projects,
    totals,
    metrics: Object.entries(METRICS).map(([k, v]) => ({ key: k, label: v.label })),
    dimensions: SANKEY_DIMENSIONS,
  })
}))

/**
 * Selectable report roots: initiatives, epics and Product Discovery ideas.
 * `level` filters the hierarchy tier; `q` is a substring match on key/summary.
 */
router.get('/roots', wrap(async (req, res) => {
  const cloudId = activeCloudId()
  if (!cloudId) return res.json({ roots: [] })

  const level = req.query.level
  const q = String(req.query.q || '').trim()
  const limit = Math.min(Number(req.query.limit) || 300, 1000)

  const where = ['i.cloud_id = ?']
  const params = [cloudId]

  if (level === 'idea') {
    where.push(`p.type_key = 'product_discovery'`)
  } else if (level !== undefined && level !== '' && level !== 'any') {
    where.push('i.hierarchy_level = ?')
    params.push(Number(level))
  }
  if (q) {
    where.push('(i.key LIKE ? OR i.summary LIKE ?)')
    params.push(`%${q}%`, `%${q}%`)
  }

  const roots = db.prepare(
    `SELECT i.id, i.key, i.summary, i.type_name, i.hierarchy_level, i.status_name,
            i.status_category, i.project_key, p.type_key AS project_type,
            (SELECT COUNT(*) FROM issues c WHERE c.cloud_id = i.cloud_id AND c.parent_id = i.id) AS child_count
     FROM issues i
     LEFT JOIN projects p ON p.cloud_id = i.cloud_id AND p.id = i.project_id
     WHERE ${where.join(' AND ')}
     ORDER BY child_count DESC, i.key
     LIMIT ?`
  ).all(...params, limit)

  res.json({ roots })
}))

/* ---------------------------------------------------------------- reports */

router.get('/reports/summary', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  const metric = req.query.metric || 'count'
  res.json({
    ...summarise(issues, metric),
    throughput: throughput({ issues, weeks: Number(req.query.weeks) || 12 }),
  })
}))

router.get('/reports/cfd', wrap(async (req, res) => {
  const { issues, cloudId } = scopeFrom(req.query)
  let set = issues
  if (req.query.leavesOnly === 'true') {
    // Anything that is somebody's parent within this scope is not a leaf.
    const parents = new Set(issues.map((i) => i.parent_id).filter(Boolean))
    set = issues.filter((i) => !parents.has(i.id))
  }
  res.json(
    cumulativeFlow({
      issues: set,
      cloudId,
      from: req.query.from,
      to: req.query.to,
      groupBy: req.query.groupBy === 'category' ? 'category' : 'status',
      metric: req.query.metric || 'count',
    })
  )
}))

router.get('/reports/tree', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  const tree = buildTree({ issues, metric: req.query.metric || 'count' })
  res.json({ tree, issueCount: issues.length })
}))

router.get('/reports/sankey', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  const dims = csv(req.query.dimensions)
  res.json(
    sankey({
      issues,
      dimensions: dims.length ? dims : ['assignee', 'epic', 'category'],
      metric: req.query.metric || 'count',
      maxPerColumn: Math.min(Number(req.query.maxPerColumn) || 12, 24),
    })
  )
}))

router.get('/reports/people', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  res.json({ people: peopleBreakdown({ issues, metric: req.query.metric || 'count' }) })
}))

router.get('/reports/issues', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  const limit = Math.min(Number(req.query.limit) || 500, 5000)
  res.json({
    total: issues.length,
    issues: issues
      .slice()
      .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))
      .slice(0, limit)
      .map((i) => ({
        key: i.key,
        summary: i.summary,
        type: i.type_name,
        level: i.hierarchy_level,
        status: i.status_name,
        category: i.status_category,
        assignee: i.assignee_name,
        project: i.project_key,
        points: i.story_points,
        hours: (i.time_spent || 0) / 3600,
        created: i.created,
        updated: i.updated,
        resolved: i.resolved,
        parent: i.parent_key,
      })),
  })
}))

router.get('/reports/chord', wrap(async (req, res) => {
  const { issues, cloudId } = scopeFrom(req.query)
  res.json(
    chordFlows({
      issues,
      cloudId,
      flow: req.query.flow === 'projects' ? 'projects' : 'handovers',
      maxEntities: Math.min(Number(req.query.maxEntities) || 8, 8),
    })
  )
}))

router.get('/reports/cycletime', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  const groupBy = ['epic', 'assignee', 'project'].includes(req.query.groupBy)
    ? req.query.groupBy
    : 'epic'
  res.json(cycleTime({ issues, groupBy }))
}))

router.get('/reports/graph', wrap(async (req, res) => {
  const { issues } = scopeFrom(req.query)
  res.json(
    graphData({
      issues,
      includeStories: req.query.includeStories === 'true',
      maxStories: Math.min(Number(req.query.maxStories) || 120, 300),
    })
  )
}))

router.get('/reports/burnup', wrap(async (req, res) => {
  const { issues, cloudId } = scopeFrom(req.query)
  res.json(
    burnup({
      issues,
      cloudId,
      metric: req.query.metric || 'count',
      from: req.query.from,
    })
  )
}))

router.get('/reports/graph-timeline', wrap(async (req, res) => {
  const { issues, cloudId } = scopeFrom(req.query)
  res.json(
    graphTimeline({
      issues,
      cloudId,
      maxStories: Math.min(Number(req.query.maxStories) || 250, 500),
    })
  )
}))

/* ------------------------------------------------------------- dashboards */

const dashboardRow = (row) => ({
  id: row.id,
  name: row.name,
  layout: JSON.parse(row.layout || '[]'),
  updatedAt: row.updated_at,
})

router.get('/dashboards', wrap(async (req, res) => {
  const rows = db.prepare('SELECT id, name, updated_at FROM dashboards ORDER BY name').all()
  res.json({ dashboards: rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at })) })
}))

router.get('/dashboards/:id', wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'No such dashboard' })
  res.json(dashboardRow(row))
}))

router.post('/dashboards', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim() || 'Untitled dashboard'
  const layout = JSON.stringify(req.body?.layout ?? [])
  const now = Date.now()
  const info = db
    .prepare('INSERT INTO dashboards (name, layout, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, layout, now, now)
  const row = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(info.lastInsertRowid)
  res.json(dashboardRow(row))
}))

router.put('/dashboards/:id', wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'No such dashboard' })
  const name = req.body?.name !== undefined ? String(req.body.name).trim() || row.name : row.name
  const layout = req.body?.layout !== undefined ? JSON.stringify(req.body.layout) : row.layout
  db.prepare('UPDATE dashboards SET name = ?, layout = ?, updated_at = ? WHERE id = ?')
    .run(name, layout, Date.now(), row.id)
  res.json(dashboardRow(db.prepare('SELECT * FROM dashboards WHERE id = ?').get(row.id)))
}))

router.delete('/dashboards/:id', wrap(async (req, res) => {
  db.prepare('DELETE FROM dashboards WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
}))

/** Site base URL so the UI can deep-link an issue key back into Jira. */
router.get('/site-url', wrap(async (req, res) => {
  const cloudId = activeCloudId()
  const row = cloudId ? db.prepare('SELECT url FROM sites WHERE cloud_id = ?').get(cloudId) : null
  res.json({ url: row?.url || null })
}))
```

### B.8 `server/src/index.js`

```js
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import cookieParser from 'cookie-parser'
import { PORT, ROOT, DATA_DIR } from './config.js'
import './db.js'
import { router } from './routes.js'

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(cookieParser())

app.use('/api', router)

// Serve the production build when it exists; in dev, Vite serves the UI and
// proxies /api here.
const dist = path.join(ROOT, 'web', 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.sendFile(path.join(dist, 'index.html'))
  })
}

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: String(err.message || err) })
})

app.listen(PORT, () => {
  console.log(`\n  jira-reports server  http://localhost:${PORT}`)
  console.log(`  data                 ${DATA_DIR}`)
  if (!fs.existsSync(dist)) console.log(`  ui (dev)             http://localhost:5173\n`)
})
```

### B.9 `server/scripts/seed-demo.mjs`

```js
/**
 * Seeds "Aurora Fintech", a fictional organisation, into the local cache so the
 * app can be explored without connecting a real Jira site.
 *
 *   node server/scripts/seed-demo.mjs            # add / refresh the demo org
 *   node server/scripts/seed-demo.mjs --remove   # delete it again
 *
 * Everything lives under its own cloud_id ('demo-aurora'), so a real Jira sync
 * never touches it — the demo shows up as one more site in Settings and the two
 * can coexist. Deterministic RNG: reseeding produces the same organisation.
 */
import { db, getConfig, setConfig, deleteConfig } from '../src/db.js'

const CID = 'demo-aurora'
const DAY = 86_400_000
const now = Date.now()
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+0000')

/* --------------------------------------------------------------- removal */

function removeDemo() {
  const tables = [
    'issues', 'issue_links', 'status_history', 'assignee_history',
    'changelog_cursor', 'projects', 'issue_types', 'statuses', 'fields', 'sites',
  ]
  const tx = db.transaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM ${t} WHERE cloud_id = ?`).run(CID)
    if (getConfig('cloud_id') === CID) {
      const next = db.prepare('SELECT cloud_id FROM sites LIMIT 1').get()
      if (next) setConfig('cloud_id', next.cloud_id)
      else deleteConfig('cloud_id')
    }
  })
  tx()
  console.log('Demo organisation removed.')
}

if (process.argv.includes('--remove')) {
  removeDemo()
  process.exit(0)
}

/* ------------------------------------------------------------------- rng */

let rngState = 20260816
const rand = () => {
  rngState = (rngState * 1103515245 + 12345) % 2147483648
  return rngState / 2147483648
}
const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1))
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const chance = (p) => rand() < p

/* ------------------------------------------------------------- the world */

const TEAMS = {
  PAY: {
    name: 'Payments',
    people: [
      ['u-priya', 'Priya Sharma'],
      ['u-marco', 'Marco Rossi'],
      ['u-elif', 'Elif Kaya'],
      ['u-tomas', 'Tomás Silva'],
      ['u-hannah', 'Hannah Berg'],
    ],
  },
  GRW: {
    name: 'Growth',
    people: [
      ['u-jonas', 'Jonas Weber'],
      ['u-aiko', 'Aiko Tanaka'],
      ['u-lucas', 'Lucas Moreau'],
      ['u-sofia', 'Sofia Petrova'],
    ],
  },
  PLT: {
    name: 'Platform',
    people: [
      ['u-david', 'David Okafor'],
      ['u-mei', 'Mei Chen'],
      ['u-karl', 'Karl Johansson'],
      ['u-ana', 'Ana Kovač'],
      ['u-ryan', "Ryan O'Brien"],
    ],
  },
}

const REPORTERS = [
  ['u-laura', 'Laura Novak'],
  ['u-ben', 'Ben Carter'],
  ...TEAMS.PAY.people.slice(0, 2),
  ...TEAMS.GRW.people.slice(0, 2),
]

// Initiatives live in the portfolio project; their epics span the team projects.
const INITIATIVES = [
  {
    summary: 'Launch in EU markets',
    epics: [
      ['PAY', 'SEPA instant payments'],
      ['PAY', 'PSD2 compliance & SCA'],
      ['GRW', 'Localised onboarding for DE/FR/ES'],
      ['PLT', 'Multi-region deployments'],
    ],
  },
  {
    summary: 'Reduce payment failure rate below 1%',
    epics: [
      ['PAY', 'Smart retry & routing'],
      ['PLT', 'Payment gateway observability'],
    ],
  },
  {
    summary: 'Self-serve onboarding',
    epics: [
      ['GRW', 'KYC without the wait'],
      ['GRW', 'In-product activation nudges'],
      ['PAY', 'Card issuing for new accounts'],
    ],
  },
  {
    summary: 'Reliability 99.95',
    epics: [
      ['PLT', 'Zero-downtime migrations'],
      ['PLT', 'Chaos & load testing programme'],
    ],
  },
]

const IDEAS = [
  'Apple Pay / Google Pay express checkout',
  'Subscription billing toolkit',
  'Open banking payouts',
  'Fraud scoring v2 with device signals',
  'Merchant cashflow dashboard',
]

const STATUSES = [
  ['1', 'To Do', 'new', 'To Do'],
  ['2', 'In Progress', 'indeterminate', 'In Progress'],
  ['3', 'In Review', 'indeterminate', 'In Progress'],
  ['4', 'QA', 'indeterminate', 'In Progress'],
  ['5', 'Done', 'done', 'Done'],
]

const TYPES = [
  ['t-init', 'Initiative', 0, 2],
  ['t-epic', 'Epic', 0, 1],
  ['t-story', 'Story', 0, 0],
  ['t-task', 'Task', 0, 0],
  ['t-bug', 'Bug', 0, 0],
  ['t-idea', 'Idea', 0, 0],
  ['t-sub', 'Sub-task', 1, -1],
]

const LABELS = ['backend', 'frontend', 'infra', 'compliance', 'experiment', 'mobile']

/* -------------------------------------------------------------- plumbing */

const insIssue = db.prepare(`INSERT INTO issues (
  cloud_id,id,key,project_id,project_key,type_id,type_name,hierarchy_level,
  status_id,status_name,status_category,resolution,priority,parent_id,parent_key,
  assignee_id,assignee_name,assignee_avatar,reporter_id,reporter_name,summary,labels,components,
  story_points,time_spent,original_estimate,created,updated,resolved,status_changed
) VALUES (
  @cloud_id,@id,@key,@project_id,@project_key,@type_id,@type_name,@hierarchy_level,
  @status_id,@status_name,@status_category,@resolution,@priority,@parent_id,@parent_key,
  @assignee_id,@assignee_name,@assignee_avatar,@reporter_id,@reporter_name,@summary,@labels,@components,
  @story_points,@time_spent,@original_estimate,@created,@updated,@resolved,@status_changed)`)

const insHist = db.prepare(`INSERT OR REPLACE INTO status_history
  (cloud_id,issue_id,at,from_id,from_status,to_id,to_status,author_id,author_name)
  VALUES (?,?,?,?,?,?,?,?,?)`)

const insAssign = db.prepare(`INSERT OR REPLACE INTO assignee_history
  (cloud_id,issue_id,at,from_id,from_name,to_id,to_name)
  VALUES (?,?,?,?,?,?,?)`)

const insLink = db.prepare(`INSERT OR IGNORE INTO issue_links
  (cloud_id,source_id,target_id,type,direction) VALUES (?,?,?,?,?)`)

let seq = 90000
const projectSeq = new Map()

function nextKey(projectKey) {
  const n = (projectSeq.get(projectKey) ?? 100) + 1
  projectSeq.set(projectKey, n)
  return `${projectKey}-${n}`
}

const TYPE_BY_NAME = new Map(TYPES.map((t) => [t[1], t]))
const STATUS_BY_IDX = STATUSES

/**
 * Creates one issue. `finalStage` is an index into STATUSES; the walk from
 * To Do to that stage is written into status_history with plausible gaps, and
 * the row's status reflects wherever the walk actually got to before "now".
 */
function makeIssue({
  projectId,
  projectKey,
  typeName,
  summary,
  parent = null,
  assignee = null,
  reporter = pick(REPORTERS),
  created,
  finalStage = 0,
  points = null,
  timeSpent = null,
  priority = pick(['Low', 'Medium', 'Medium', 'Medium', 'High', 'High', 'Highest']),
  labels = [],
}) {
  const id = String(++seq)
  const key = nextKey(projectKey)
  const type = TYPE_BY_NAME.get(typeName)

  // Walk the workflow one stage at a time; stop if we run out of calendar.
  const times = []
  let t = created
  for (let k = 1; k <= finalStage; k += 1) {
    t += randInt(1, 14) * DAY + randInt(0, 23) * 3_600_000
    if (t >= now - DAY) break
    times.push(t)
  }
  const reached = times.length
  const status = STATUS_BY_IDX[reached]
  const isDone = status[2] === 'done'
  const lastChange = times[times.length - 1] ?? created

  insIssue.run({
    cloud_id: CID,
    id,
    key,
    project_id: projectId,
    project_key: projectKey,
    type_id: type[0],
    type_name: type[1],
    hierarchy_level: type[3],
    status_id: status[0],
    status_name: status[1],
    status_category: status[2],
    resolution: isDone ? 'Done' : null,
    priority,
    parent_id: parent?.id ?? null,
    parent_key: parent?.key ?? null,
    assignee_id: assignee?.[0] ?? null,
    assignee_name: assignee?.[1] ?? null,
    assignee_avatar: null,
    reporter_id: reporter[0],
    reporter_name: reporter[1],
    summary,
    labels: JSON.stringify(labels),
    components: '[]',
    story_points: points,
    time_spent: timeSpent,
    original_estimate: null,
    created: iso(created),
    updated: iso(lastChange + randInt(0, 2) * DAY),
    resolved: isDone ? iso(lastChange) : null,
    status_changed: iso(lastChange),
  })

  times.forEach((at, i) => {
    insHist.run(
      CID, id, iso(at),
      STATUS_BY_IDX[i][0], STATUS_BY_IDX[i][1],
      STATUS_BY_IDX[i + 1][0], STATUS_BY_IDX[i + 1][1],
      assignee?.[0] ?? reporter[0], assignee?.[1] ?? reporter[1]
    )
  })

  return { id, key, created, reached }
}

/* ------------------------------------------------------------------ seed */

removeDemo()
console.log('Seeding Aurora Fintech…')

const seededStats = { epics: 0, stories: 0, subtasks: 0, loose: 0 }

const seed = db.transaction(() => {
  db.prepare('INSERT INTO sites (cloud_id,name,url,avatar,scopes) VALUES (?,?,?,?,?)').run(
    CID, 'Aurora Fintech (demo)', null, null, '[]'
  )
  setConfig('cloud_id', CID)

  const projects = [
    ['p-port', 'PORT', 'Portfolio', 'software', 'Laura Novak'],
    ['p-pay', 'PAY', 'Payments', 'software', 'Priya Sharma'],
    ['p-grw', 'GRW', 'Growth', 'software', 'Jonas Weber'],
    ['p-plt', 'PLT', 'Platform', 'software', 'David Okafor'],
    ['p-disc', 'DISC', 'Discovery', 'product_discovery', 'Ben Carter'],
  ]
  for (const [id, key, name, typeKey, lead] of projects) {
    db.prepare(
      'INSERT INTO projects (cloud_id,id,key,name,type_key,style,avatar,category,lead) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(CID, id, key, name, typeKey, 'classic', null, null, lead)
  }
  const projectId = new Map(projects.map((p) => [p[1], p[0]]))

  for (const [id, name, sub, lvl] of TYPES) {
    db.prepare(
      'INSERT INTO issue_types (cloud_id,id,name,subtask,hierarchy_level,icon) VALUES (?,?,?,?,?,?)'
    ).run(CID, id, name, sub, lvl, null)
  }
  for (const [id, name, cat, catName] of STATUSES) {
    db.prepare(
      'INSERT INTO statuses (cloud_id,id,name,category_key,category_name) VALUES (?,?,?,?,?)'
    ).run(CID, id, name, cat, catName)
  }

  const epicIndex = [] // [{ id, key, teamKey }]

  for (const init of INITIATIVES) {
    const initiative = makeIssue({
      projectId: projectId.get('PORT'),
      projectKey: 'PORT',
      typeName: 'Initiative',
      summary: init.summary,
      reporter: ['u-laura', 'Laura Novak'],
      created: now - randInt(260, 320) * DAY,
      finalStage: 1, // sits In Progress
    })

    for (const [teamKey, epicSummary] of init.epics) {
      const team = TEAMS[teamKey]
      const epicCreated = now - randInt(120, 240) * DAY
      const epic = makeIssue({
        projectId: projectId.get(teamKey),
        projectKey: teamKey,
        typeName: 'Epic',
        summary: epicSummary,
        parent: initiative,
        assignee: team.people[0],
        created: epicCreated,
        finalStage: 1,
      })
      epicIndex.push({ ...epic, teamKey })
      seededStats.epics += 1

      const storyCount = randInt(8, 14)
      for (let s = 0; s < storyCount; s += 1) {
        const created = epicCreated + randInt(3, 100) * DAY
        if (created >= now - 2 * DAY) continue
        const r = rand()
        const finalStage = r < 0.42 ? 4 : r < 0.52 ? 3 : r < 0.66 ? 2 : r < 0.86 ? 1 : 0
        const assignee = chance(0.88)
          ? chance(0.12)
            ? pick(Object.values(TEAMS).flatMap((t) => t.people)) // cross-team helper
            : pick(team.people)
          : null

        const story = makeIssue({
          projectId: projectId.get(teamKey),
          projectKey: teamKey,
          typeName: chance(0.18) ? 'Bug' : 'Story',
          summary: `${epicSummary} — ${STORY_NOUNS[randInt(0, STORY_NOUNS.length - 1)]}`,
          parent: epic,
          assignee,
          created,
          finalStage,
          points: chance(0.75) ? pick([1, 2, 3, 3, 5, 5, 8, 13]) : null,
          timeSpent: finalStage >= 1 && chance(0.6) ? randInt(2, 40) * 3600 : null,
          labels: chance(0.5) ? [pick(LABELS)] : [],
        })
        seededStats.stories += 1

        if (chance(0.15)) {
          const subs = randInt(1, 2)
          for (let k = 0; k < subs; k += 1) {
            makeIssue({
              projectId: projectId.get(teamKey),
              projectKey: teamKey,
              typeName: 'Sub-task',
              summary: pick(['Write tests', 'Update docs', 'Review rollout plan', 'Backfill data']),
              parent: story,
              assignee,
              created: created + randInt(1, 10) * DAY,
              finalStage: chance(0.6) ? 4 : 1,
            })
            seededStats.subtasks += 1
          }
        }

        // Handovers, recorded in assignee history — the chord diagram's data.
        if (assignee && chance(0.3)) {
          const other = chance(0.2)
            ? pick(Object.values(TEAMS).flatMap((t) => t.people))
            : pick(team.people)
          if (other[0] !== assignee[0]) {
            insAssign.run(CID, story.id, iso(created + randInt(2, 20) * DAY),
              other[0], other[1], assignee[0], assignee[1])
            // Some work bounces twice before settling.
            if (chance(0.25)) {
              const third = pick(team.people)
              if (third[0] !== other[0]) {
                insAssign.run(CID, story.id, iso(created + randInt(1, 2) * DAY),
                  third[0], third[1], other[0], other[1])
              }
            }
          }
        }
      }
    }
  }

  // Team-level work that belongs to no epic — keeps "No epic" flows honest.
  for (const teamKey of Object.keys(TEAMS)) {
    const team = TEAMS[teamKey]
    const n = randInt(6, 10)
    for (let i = 0; i < n; i += 1) {
      const created = now - randInt(10, 150) * DAY
      const r = rand()
      makeIssue({
        projectId: projectId.get(teamKey),
        projectKey: teamKey,
        typeName: chance(0.4) ? 'Bug' : 'Task',
        summary: pick(LOOSE_WORK),
        assignee: chance(0.8) ? pick(team.people) : null,
        created,
        finalStage: r < 0.5 ? 4 : r < 0.75 ? 1 : 0,
        points: chance(0.4) ? pick([1, 2, 3, 5]) : null,
        timeSpent: chance(0.5) ? randInt(1, 16) * 3600 : null,
      })
      seededStats.loose += 1
    }
  }

  // Discovery ideas, each linked to the epics that implement them.
  IDEAS.forEach((summary, i) => {
    const idea = makeIssue({
      projectId: projectId.get('DISC'),
      projectKey: 'DISC',
      typeName: 'Idea',
      summary,
      reporter: ['u-ben', 'Ben Carter'],
      created: now - randInt(60, 200) * DAY,
      finalStage: i < 2 ? 1 : 0,
    })
    const targets = new Set()
    while (targets.size < randInt(1, 2)) targets.add(pick(epicIndex).id)
    for (const target of targets) insLink.run(CID, idea.id, target, 'Implements', 'outward')
  })
})

const STORY_NOUNS = [
  'API contract', 'edge-case handling', 'error states', 'retry logic', 'admin tooling',
  'migration script', 'feature flag rollout', 'metrics & alerts', 'UX polish',
  'rate limiting', 'webhook delivery', 'audit logging', 'performance pass',
  'i18n strings', 'rollback plan', 'sandbox environment', 'documentation',
]

const LOOSE_WORK = [
  'Upgrade runtime to LTS', 'Flaky test in CI', 'Rotate signing keys',
  'Customer-reported timeout', 'Dependency audit', 'On-call runbook update',
  'Dashboard cleanup', 'Slow query on transactions table', 'Access review',
  'Intermittent 502 behind load balancer', 'Cost review for staging',
]

seed()

const counts = {
  issues: db.prepare('SELECT COUNT(*) n FROM issues WHERE cloud_id = ?').get(CID).n,
  transitions: db.prepare('SELECT COUNT(*) n FROM status_history WHERE cloud_id = ?').get(CID).n,
  links: db.prepare('SELECT COUNT(*) n FROM issue_links WHERE cloud_id = ?').get(CID).n,
}

console.log(
  `Seeded: 4 initiatives, ${seededStats.epics} epics, ${seededStats.stories} stories/bugs, ` +
    `${seededStats.subtasks} sub-tasks, ${seededStats.loose} loose tasks, ${IDEAS.length} ideas`
)
console.log(
  `Totals: ${counts.issues} issues, ${counts.transitions} status transitions, ${counts.links} idea links`
)
console.log('\nActive site is now "Aurora Fintech (demo)". Start the app and explore;')
console.log('remove again with: node server/scripts/seed-demo.mjs --remove')
```

## Appendix C — web configuration & tokens (copy verbatim)

### C.1 `web/vite.config.ts`

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
```

### C.2 `web/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

### C.3 `web/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Jira Reports</title>
    <script>
      // Apply the stored theme before first paint so there is no flash.
      try {
        var t = localStorage.getItem('theme')
        if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t
      } catch (e) {}
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### C.4 `web/src/main.tsx`

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles/theme.css'
import './styles/app.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
```

### C.5 `web/src/styles/theme.css` — every design token, exact values

```css
/*
 * Design tokens. Every value here is validated — the categorical set passes the
 * adjacent CVD / lightness / chroma / normal-vision gates in both modes, and the
 * blue ordinal ramp passes the ordinal gates at every length it is used at.
 * Light mode caps the ordinal ramp at 5 steps (see palette.ts).
 */

:root {
  color-scheme: light;

  /* surfaces & ink */
  --surface-1: #fcfcfb;
  --surface-2: #f9f9f7;
  --page: #f9f9f7;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #898781;
  --gridline: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11, 11, 11, 0.1);
  --hover-wash: rgba(11, 11, 11, 0.04);
  --selected-wash: rgba(42, 120, 214, 0.1);

  /* categorical slots — fixed order, never cycled */
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --series-3: #1baf7a;
  --series-4: #eda100;
  --series-5: #e87ba4;
  --series-6: #008300;
  --series-7: #4a3aa7;
  --series-8: #e34948;

  /* status — reserved, never used for a series */
  --status-good: #0ca30c;
  --status-warning: #fab219;
  --status-serious: #ec835a;
  --status-critical: #d03b3b;
  --delta-good: #006300;

  /* blue ramp (sequential / ordinal source) */
  --blue-100: #cde2fb;
  --blue-150: #b7d3f6;
  --blue-200: #9ec5f4;
  --blue-250: #86b6ef;
  --blue-300: #6da7ec;
  --blue-350: #5598e7;
  --blue-400: #3987e5;
  --blue-450: #2a78d6;
  --blue-500: #256abf;
  --blue-550: #1c5cab;
  --blue-600: #184f95;
  --blue-650: #104281;
  --blue-700: #0d366b;

  --accent: var(--blue-450);

  /* Meter segments are the validated 3-step ordinal ramp, darkest = done —
     the same reading direction as the cumulative flow. */
  --meter-done: var(--blue-700);
  --meter-progress: var(--blue-450);
  --meter-track: var(--blue-250);

  --radius: 10px;
  --shadow: 0 1px 2px rgba(11, 11, 11, 0.05);
}

@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme='light'])) {
    color-scheme: dark;

    --surface-1: #1a1a19;
    --surface-2: #131312;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --gridline: #2c2c2a;
    --axis: #383835;
    --border: rgba(255, 255, 255, 0.1);
    --hover-wash: rgba(255, 255, 255, 0.06);
    --selected-wash: rgba(57, 135, 229, 0.16);

    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
    --series-4: #c98500;
    --series-5: #d55181;
    --series-6: #008300;
    --series-7: #9085e9;
    --series-8: #e66767;

    --delta-good: #0ca30c;

    --accent: var(--blue-400);
    --meter-done: var(--blue-600);
    --meter-progress: var(--blue-350);
    --meter-track: var(--blue-100);
    --shadow: none;
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;

  --surface-1: #1a1a19;
  --surface-2: #131312;
  --page: #0d0d0d;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --text-muted: #898781;
  --gridline: #2c2c2a;
  --axis: #383835;
  --border: rgba(255, 255, 255, 0.1);
  --hover-wash: rgba(255, 255, 255, 0.06);
  --selected-wash: rgba(57, 135, 229, 0.16);

  --series-1: #3987e5;
  --series-2: #d95926;
  --series-3: #199e70;
  --series-4: #c98500;
  --series-5: #d55181;
  --series-6: #008300;
  --series-7: #9085e9;
  --series-8: #e66767;

  --delta-good: #0ca30c;

  --accent: var(--blue-400);
  --meter-done: var(--blue-600);
  --meter-progress: var(--blue-350);
  --meter-track: var(--blue-100);
  --shadow: none;
}
```

### C.6 `.env.example`

```ini
# Copy to .env  (or enter these in the app's Settings page instead — they are
# stored in the local SQLite file either way; .env simply pre-seeds them.)

# From https://developer.atlassian.com/console/myapps/ -> your app -> Settings
JIRA_CLIENT_ID=
JIRA_CLIENT_SECRET=

# Must match the callback registered under Authorization -> OAuth 2.0 (3LO) exactly.
OAUTH_REDIRECT_URI=http://localhost:8787/api/auth/callback

# Classic scopes. Add read:jira-work granular scopes only if your app requires them.
JIRA_SCOPES=read:jira-work read:jira-user offline_access

PORT=8787
# DATA_DIR=./data
```

### C.7 `.gitignore`

```
node_modules/
dist/
data/
.env
*.log
.DS_Store
```

The remaining web source files (`app.css`, `App.tsx`, components, charts,
dashboard, pages) are specified by §10–§17 plus Appendix A; they follow the
same patterns as the code shown there, and any implementation that passes the
§19 checks and renders per §14's geometry is correct.

---

*End of specification.*
