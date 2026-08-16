import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Dashboard, type WidgetConfig } from '../lib/api'
import { useScope } from '../lib/scope'
import { Banner, Empty } from '../components/ui'
import { DashGrid, compactAll, nextFreeY, type LayoutItem } from '../dashboard/Grid'
import {
  WIDGETS,
  WidgetBody,
  bodyHeight,
  defaultTitle,
  widgetDef,
  type WidgetDef,
} from '../dashboard/registry'
import { NoData } from './Overview'

const ACTIVE_KEY = 'jira-reports.dashboard'

const STARTER: Omit<WidgetConfig, 'i'>[] = [
  { type: 'stat', title: '', x: 0, y: 0, w: 3, h: 2, options: { kind: 'percent' } },
  { type: 'stat', title: '', x: 3, y: 0, w: 3, h: 2, options: { kind: 'issues' } },
  { type: 'throughput', title: '', x: 6, y: 0, w: 6, h: 3, options: {} },
  { type: 'cfd', title: '', x: 0, y: 2, w: 6, h: 5, options: {} },
  { type: 'people-load', title: '', x: 6, y: 3, w: 6, h: 4, options: {} },
]

const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `w${Date.now()}${Math.floor(Math.random() * 1e6)}`)

export function Dashboards() {
  const { catalog, sync } = useScope()
  const [list, setList] = useState<{ id: number; name: string }[]>([])
  const [active, setActive] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<WidgetConfig | null>(null)
  const [renaming, setRenaming] = useState(false)
  const saveTimer = useRef<number>()

  const loadList = useCallback(async () => {
    try {
      const d = await api.get<{ dashboards: { id: number; name: string }[] }>('/dashboards')
      setList(d.dashboards)
      return d.dashboards
    } catch (err) {
      setError(String((err as Error).message))
      return []
    }
  }, [])

  const open = useCallback(async (id: number) => {
    try {
      const d = await api.get<Dashboard>(`/dashboards/${id}`)
      setActive(d)
      localStorage.setItem(ACTIVE_KEY, String(id))
    } catch (err) {
      setError(String((err as Error).message))
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const dashboards = await loadList()
      if (!dashboards.length) return
      const stored = Number(localStorage.getItem(ACTIVE_KEY))
      const target = dashboards.find((d) => d.id === stored) ?? dashboards[0]
      await open(target.id)
    })()
  }, [loadList, open])

  const persist = useCallback((dashboard: Dashboard) => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      api.put(`/dashboards/${dashboard.id}`, { layout: dashboard.layout }).catch((err) => {
        setError(String((err as Error).message))
      })
    }, 500)
  }, [])

  const updateLayout = (positions: LayoutItem[]) => {
    if (!active) return
    const byId = new Map(positions.map((p) => [p.i, p]))
    setActive({
      ...active,
      layout: active.layout.map((w) => {
        const p = byId.get(w.i)
        return p ? { ...w, x: p.x, y: p.y, w: p.w, h: p.h } : w
      }),
    })
  }

  const commit = () => {
    if (active) persist(active)
  }

  const createDashboard = async (withStarter: boolean) => {
    const name = `Dashboard ${list.length + 1}`
    const layout = withStarter ? STARTER.map((w) => ({ ...w, i: newId() })) : []
    try {
      const d = await api.post<Dashboard>('/dashboards', { name, layout })
      await loadList()
      setActive(d)
      localStorage.setItem(ACTIVE_KEY, String(d.id))
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  const removeDashboard = async () => {
    if (!active) return
    await api.del(`/dashboards/${active.id}`)
    localStorage.removeItem(ACTIVE_KEY)
    setActive(null)
    const dashboards = await loadList()
    if (dashboards.length) await open(dashboards[0].id)
  }

  const addWidget = (def: WidgetDef) => {
    if (!active) return
    const widget: WidgetConfig = {
      i: newId(),
      type: def.type,
      title: '',
      x: 0,
      y: nextFreeY(active.layout),
      w: def.w,
      h: def.h,
      options: Object.fromEntries(
        def.fields.filter((f) => f.kind === 'select' && f.choices?.length).map((f) => [f.key, f.choices![0].value])
      ),
    }
    const next = { ...active, layout: [...active.layout, widget] }
    setActive(next)
    persist(next)
    setAdding(false)
  }

  const removeWidget = (id: string) => {
    if (!active) return
    const next = {
      ...active,
      layout: compactAll(active.layout.filter((w) => w.i !== id)).map((p) => {
        const w = active.layout.find((l) => l.i === p.i)!
        return { ...w, x: p.x, y: p.y, w: p.w, h: p.h }
      }),
    }
    setActive(next)
    persist(next)
  }

  const saveWidget = (widget: WidgetConfig) => {
    if (!active) return
    const next = { ...active, layout: active.layout.map((w) => (w.i === widget.i ? widget : w)) }
    setActive(next)
    persist(next)
    setEditing(null)
  }

  const rename = async (name: string) => {
    setRenaming(false)
    if (!active || !name.trim() || name === active.name) return
    const d = await api.put<Dashboard>(`/dashboards/${active.id}`, { name: name.trim() })
    setActive({ ...active, name: d.name })
    await loadList()
  }

  if (!catalog?.ready && !sync?.running) return <NoData />

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboards</h1>
          <p>
            Your own arrangement of widgets. Drag a card by its header, resize from the corner —
            everything is saved locally and scoped by the filter row above.
          </p>
        </div>
        <div className="row">
          {list.length > 0 && (
            <select
              value={active?.id ?? ''}
              onChange={(e) => void open(Number(e.target.value))}
              aria-label="Dashboard"
            >
              {list.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          {active && (
            <>
              <button type="button" className="ghost" onClick={() => setRenaming(true)}>
                Rename
              </button>
              <button type="button" className="ghost danger" onClick={() => void removeDashboard()}>
                Delete
              </button>
            </>
          )}
          <button type="button" onClick={() => void createDashboard(list.length === 0)}>
            New dashboard
          </button>
          {active && (
            <button type="button" className="primary" onClick={() => setAdding(true)}>
              + Add widget
            </button>
          )}
        </div>
      </div>

      {error && (
        <Banner kind="error" title="Dashboard error" actions={<button type="button" className="ghost" onClick={() => setError(null)}>Dismiss</button>}>
          {error}
        </Banner>
      )}

      {!active ? (
        <Empty title="No dashboards yet">
          <button type="button" className="primary" onClick={() => void createDashboard(true)}>
            Create one with starter widgets
          </button>
        </Empty>
      ) : active.layout.length === 0 ? (
        <Empty title="This dashboard is empty">
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            + Add a widget
          </button>
        </Empty>
      ) : (
        <DashGrid
          layout={active.layout}
          minSize={(id) => {
            const w = active.layout.find((l) => l.i === id)
            const def = w ? widgetDef(w.type) : undefined
            return { w: def?.minW ?? 2, h: def?.minH ?? 2 }
          }}
          onChange={updateLayout}
          onCommit={commit}
          render={(item, handles) => {
            const widget = active.layout.find((w) => w.i === item.i)!
            return (
              <>
                <div className="widget-head" onPointerDown={handles.onMoveDown}>
                  <span className="widget-title">{widget.title || defaultTitle(widget)}</span>
                  <span className="row" style={{ gap: 2 }}>
                    <button
                      type="button"
                      className="ghost widget-btn"
                      aria-label="Configure widget"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setEditing(widget)}
                    >
                      ⚙
                    </button>
                    <button
                      type="button"
                      className="ghost widget-btn"
                      aria-label="Remove widget"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => removeWidget(widget.i)}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <div className="widget-body" style={{ maxHeight: bodyHeight(widget.h) + 8 }}>
                  <WidgetBody widget={widget} />
                </div>
                <div className="resize-handle" onPointerDown={handles.onResizeDown} aria-hidden="true" />
              </>
            )
          }}
        />
      )}

      {adding && (
        <Modal title="Add a widget" onClose={() => setAdding(false)}>
          <div className="type-grid">
            {WIDGETS.map((def) => (
              <button key={def.type} type="button" className="type-card" onClick={() => addWidget(def)}>
                <strong>{def.label}</strong>
                <span>{def.desc}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {editing && (
        <WidgetEditor
          widget={editing}
          onSave={saveWidget}
          onClose={() => setEditing(null)}
        />
      )}

      {renaming && active && (
        <Modal title="Rename dashboard" onClose={() => setRenaming(false)}>
          <RenameForm initial={active.name} onSubmit={rename} />
        </Modal>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- modals */

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>{title}</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function RenameForm({ initial, onSubmit }: { initial: string; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(initial)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(name)
      }}
      className="row"
    >
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus style={{ flex: 1 }} />
      <button type="submit" className="primary">
        Save
      </button>
    </form>
  )
}

function WidgetEditor({
  widget,
  onSave,
  onClose,
}: {
  widget: WidgetConfig
  onSave: (w: WidgetConfig) => void
  onClose: () => void
}) {
  const def = widgetDef(widget.type)
  const [title, setTitle] = useState(widget.title ?? '')
  const [options, setOptions] = useState({ ...widget.options })

  if (!def) return null

  return (
    <Modal title={`Configure ${def.label.toLowerCase()}`} onClose={onClose}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="field">
          <label htmlFor="wtitle">Title</label>
          <input
            id="wtitle"
            type="text"
            value={title}
            placeholder={defaultTitle(widget)}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {def.fields.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`wf-${f.key}`}>{f.label}</label>
            {f.kind === 'select' ? (
              <select
                id={`wf-${f.key}`}
                value={options[f.key] ?? ''}
                onChange={(e) => setOptions({ ...options, [f.key]: e.target.value })}
              >
                {f.choices?.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`wf-${f.key}`}
                type="text"
                value={options[f.key] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setOptions({ ...options, [f.key]: e.target.value })}
              />
            )}
          </div>
        ))}

        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Leave scope fields empty to inherit the filter row above the page.
        </p>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onSave({ ...widget, title: title.trim(), options })}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  )
}
