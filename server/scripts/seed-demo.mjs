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
