import { useCallback, useEffect, useRef, useState } from 'react'
import { bridge, errorMessage, getRunDetail, loadWorkbench } from './bridge'
import type { RunDetailView, ToastMessage, WorkbenchSnapshot } from './types'

const EMPTY_SNAPSHOT: WorkbenchSnapshot = {
  workspaces: [],
  runs: [],
  models: [],
  memory: [],
  mcpServers: [],
  skills: [],
  automations: [],
  chrome: { connected: false, grants: [] },
  settings: {},
  persistentGrants: [],
  capabilityPackages: [],
  appInfo: {},
}

export function useWorkbench() {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>(EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [runDetail, setRunDetail] = useState<RunDetailView>()
  const [runLoading, setRunLoading] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const eventTimer = useRef<number | undefined>(undefined)
  const toastSequence = useRef(0)
  const optimisticMessageSequence = useRef(0)
  const selectionInitialized = useRef(false)

  const notify = useCallback((kind: ToastMessage['kind'], title: string, detail?: string) => {
    const id = ++toastSequence.current
    const toast: ToastMessage = detail ? { id, kind, title, detail } : { id, kind, title }
    setToasts((current) => [...current.slice(-3), toast])
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id))
  }, [])

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true)
    try {
      const next = await loadWorkbench()
      setSnapshot(next)
      setError(undefined)
      const isInitialSelection = !selectionInitialized.current
      selectionInitialized.current = true
      setSelectedRunId((current) => {
        if (current && next.runs.some((run) => run.id === current)) return current
        if (isInitialSelection) return next.runs[0]?.id
        return undefined
      })
      return next
    } catch (cause) {
      const message = errorMessage(cause)
      setError(message)
      if (!quiet) notify('error', '无法加载本地工作台', message)
      return undefined
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [notify])

  const reloadRun = useCallback(async (runId: string, quiet = false) => {
    if (!quiet) setRunLoading(true)
    try {
      const fallback = snapshot.runs.find((run) => run.id === runId)
      const detail = await getRunDetail(runId, fallback)
      setRunDetail((current) => {
        if (!current || current.id !== detail.id) return detail
        const persistedIds = new Set(detail.events.map((item) => item.id))
        const ephemeral = current.events.filter((item) => {
          if (persistedIds.has(item.id)) return false
          if (item.type === 'message.optimistic') {
            const optimisticAt = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : Number.NaN
            const persistedCopy = detail.events.some((candidate) => {
              if (candidate.actor !== 'user' || candidate.content !== item.content) return false
              const persistedAt = typeof candidate.createdAt === 'string' ? Date.parse(candidate.createdAt) : Number.NaN
              return Number.isFinite(optimisticAt) && Number.isFinite(persistedAt) && persistedAt >= optimisticAt - 50
            })
            return !persistedCopy
          }
          return item.type === 'tool.updated' || item.type === 'error'
        })
        return ephemeral.length ? { ...detail, events: [...detail.events, ...ephemeral] } : detail
      })
      return detail
    } catch (cause) {
      if (!quiet) notify('error', '工作详情加载失败', errorMessage(cause))
      return undefined
    } finally {
      setRunLoading(false)
    }
  }, [notify, snapshot.runs])

  useEffect(() => {
    void refresh(true)
  }, [refresh])

  useEffect(() => {
    if (!selectedRunId) {
      setRunDetail(undefined)
      return
    }
    void reloadRun(selectedRunId)
  }, [reloadRun, selectedRunId])

  useEffect(() => bridge.subscribe((event) => {
    if (event && typeof event === 'object') {
      const value = event as Record<string, unknown>
      if (value.kind === 'message.delta' && value.runId === selectedRunId && typeof value.delta === 'string') {
        const messageId = typeof value.messageId === 'string' ? value.messageId : 'active'
        const streamId = `stream-${messageId}`
        setRunDetail((current) => {
          if (!current || current.id !== selectedRunId) return current
          const existing = current.events.find((item) => item.id === streamId)
          const events = existing
            ? current.events.map((item) => item.id === streamId ? { ...item, content: `${item.content ?? ''}${value.delta as string}` } : item)
            : [...current.events, { id: streamId, type: 'message.delta', title: 'WorkBuddy', content: value.delta as string, actor: 'agent' as const, createdAt: typeof value.at === 'string' ? value.at : new Date().toISOString() }]
          return { ...current, events }
        })
        return
      }
      if (value.kind === 'progress.updated' && value.runId === selectedRunId && value.progress && typeof value.progress === 'object') {
        const progress = value.progress as Record<string, unknown>
        if (typeof progress.message === 'string' && progress.message) {
          setRunDetail((current) => current && current.id === selectedRunId
            ? { ...current, progress: progress as NonNullable<RunDetailView['progress']> }
            : current)
        }
        return
      }
      if (value.kind === 'tool.updated' && value.runId === selectedRunId && value.toolCall && typeof value.toolCall === 'object') {
        const toolCall = value.toolCall as Record<string, unknown>
        const toolId = typeof toolCall.id === 'string' ? toolCall.id : String(value.id ?? 'tool')
        const eventId = `tool-${toolId}`
        const title = typeof toolCall.toolName === 'string' ? toolCall.toolName : '工具调用'
        const status = typeof toolCall.status === 'string' ? toolCall.status : 'running'
        setRunDetail((current) => {
          if (!current || current.id !== selectedRunId) return current
          const nextEvent = { id: eventId, type: 'tool.updated', title, content: `状态：${status}`, actor: 'tool' as const, createdAt: typeof value.at === 'string' ? value.at : new Date().toISOString(), level: status === 'failed' ? 'error' as const : status === 'succeeded' ? 'success' as const : 'info' as const }
          const exists = current.events.some((item) => item.id === eventId)
          return { ...current, events: exists ? current.events.map((item) => item.id === eventId ? { ...item, ...nextEvent } : item) : [...current.events, nextEvent] }
        })
        if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
          const completedRunId = selectedRunId
          if (!completedRunId) return
          window.clearTimeout(eventTimer.current)
          eventTimer.current = window.setTimeout(() => { void reloadRun(completedRunId, true) }, 140)
        }
        return
      }
    }
    window.clearTimeout(eventTimer.current)
    eventTimer.current = window.setTimeout(() => {
      void refresh(true)
      if (selectedRunId) void reloadRun(selectedRunId, true)
    }, 180)
  }), [refresh, reloadRun, selectedRunId])

  const perform = useCallback(async <T,>(
    action: () => Promise<T>,
    successTitle?: string,
    options?: { refresh?: boolean; refreshRun?: boolean },
  ): Promise<T | undefined> => {
    try {
      const result = await action()
      if (successTitle) notify('success', successTitle)
      if (options?.refresh !== false) await refresh(true)
      if (options?.refreshRun && selectedRunId) await reloadRun(selectedRunId, true)
      return result
    } catch (cause) {
      notify('error', '操作未完成', errorMessage(cause))
      return undefined
    }
  }, [notify, refresh, reloadRun, selectedRunId])

  const appendOptimisticUserMessage = useCallback((runId: string, content: string, attachmentIds: string[] = []) => {
    const createdAt = new Date().toISOString()
    const id = `optimistic-user-${Date.now()}-${++optimisticMessageSequence.current}`
    setRunDetail((current) => {
      if (!current || current.id !== runId) return current
      return {
        ...current,
        events: [...current.events, {
          id,
          type: 'message.optimistic',
          title: '你',
          content,
          actor: 'user' as const,
          createdAt,
          optimistic: true,
          ...(attachmentIds.length ? { attachmentIds } : {}),
        }],
      }
    })
    return id
  }, [])

  const removeOptimisticUserMessage = useCallback((runId: string, eventId: string) => {
    setRunDetail((current) => {
      if (!current || current.id !== runId) return current
      const events = current.events.filter((item) => item.id !== eventId)
      return events.length === current.events.length ? current : { ...current, events }
    })
  }, [])

  return {
    snapshot,
    loading,
    refreshing,
    error,
    selectedRunId,
    setSelectedRunId,
    runDetail,
    runLoading,
    refresh,
    reloadRun,
    appendOptimisticUserMessage,
    removeOptimisticUserMessage,
    perform,
    notify,
    toasts,
    dismissToast,
  }
}

export function useResolvedTheme(theme: unknown) {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const resolved = theme === 'dark' || (theme !== 'light' && systemDark) ? 'dark' : 'light'
  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    document.documentElement.style.colorScheme = resolved
  }, [resolved])
  return resolved
}
