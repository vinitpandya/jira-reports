import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type Dashboard, type DashboardMeta, type WidgetConfig } from './api'

/** Remembers the page last opened so /dashboards can land somewhere sensible. */
export const ACTIVE_KEY = 'jira-reports.dashboard'

export const STARTER: Omit<WidgetConfig, 'i'>[] = [
  { type: 'stat', title: '', x: 0, y: 0, w: 3, h: 2, options: { kind: 'percent' } },
  { type: 'stat', title: '', x: 3, y: 0, w: 3, h: 2, options: { kind: 'issues' } },
  { type: 'throughput', title: '', x: 6, y: 0, w: 6, h: 3, options: {} },
  { type: 'cfd', title: '', x: 0, y: 2, w: 6, h: 5, options: {} },
  { type: 'people-load', title: '', x: 6, y: 3, w: 6, h: 4, options: {} },
]

export const newWidgetId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `w${Date.now()}${Math.floor(Math.random() * 1e6)}`)

type Ctx = {
  pages: DashboardMeta[]
  loaded: boolean
  refresh: () => Promise<DashboardMeta[]>
  create: (name: string, withStarter: boolean) => Promise<Dashboard>
  rename: (id: number, name: string) => Promise<void>
  remove: (id: number) => Promise<void>
}

const DashboardsContext = createContext<Ctx | null>(null)

export function DashboardsProvider({ children }: { children: ReactNode }) {
  const [pages, setPages] = useState<DashboardMeta[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const d = await api.get<{ dashboards: DashboardMeta[] }>('/dashboards')
      setPages(d.dashboards)
      return d.dashboards
    } catch {
      return []
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = useCallback(
    async (name: string, withStarter: boolean) => {
      const layout = withStarter ? STARTER.map((w) => ({ ...w, i: newWidgetId() })) : []
      const d = await api.post<Dashboard>('/dashboards', { name: name.trim() || 'New page', layout })
      localStorage.setItem(ACTIVE_KEY, String(d.id))
      await refresh()
      return d
    },
    [refresh]
  )

  const rename = useCallback(
    async (id: number, name: string) => {
      await api.put(`/dashboards/${id}`, { name })
      await refresh()
    },
    [refresh]
  )

  const remove = useCallback(
    async (id: number) => {
      await api.del(`/dashboards/${id}`)
      if (localStorage.getItem(ACTIVE_KEY) === String(id)) localStorage.removeItem(ACTIVE_KEY)
      await refresh()
    },
    [refresh]
  )

  return (
    <DashboardsContext.Provider value={{ pages, loaded, refresh, create, rename, remove }}>
      {children}
    </DashboardsContext.Provider>
  )
}

export function useDashboards() {
  const ctx = useContext(DashboardsContext)
  if (!ctx) throw new Error('useDashboards must be used inside DashboardsProvider')
  return ctx
}
