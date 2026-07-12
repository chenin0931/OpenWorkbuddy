import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent,
  type PointerEvent,
  type SetStateAction,
} from 'react'

export const DEFAULT_PANEL_WIDTH = 330
export const MIN_PANEL_WIDTH = 300
export const MAX_PANEL_WIDTH = 420

export function clampPanelWidth(
  width: number,
  minWidth = MIN_PANEL_WIDTH,
  maxWidth = MAX_PANEL_WIDTH,
): number {
  const finiteMin = Number.isFinite(minWidth) ? minWidth : MIN_PANEL_WIDTH
  const finiteMax = Number.isFinite(maxWidth) ? maxWidth : MAX_PANEL_WIDTH
  const lowerBound = Math.min(finiteMin, finiteMax)
  const upperBound = Math.max(finiteMin, finiteMax)
  const fallback = Math.min(upperBound, Math.max(lowerBound, DEFAULT_PANEL_WIDTH))

  if (!Number.isFinite(width)) return fallback
  return Math.min(upperBound, Math.max(lowerBound, Math.round(width)))
}

export interface PersistentPanelWidthOptions {
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
}

function readStoredWidth(
  storageKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
): number {
  const fallback = clampPanelWidth(defaultWidth, minWidth, maxWidth)
  if (typeof window === 'undefined') return fallback

  try {
    const stored = window.localStorage.getItem(storageKey)
    if (stored === null || stored.trim() === '') return fallback
    const parsedWidth = Number(stored)
    return Number.isFinite(parsedWidth)
      ? clampPanelWidth(parsedWidth, minWidth, maxWidth)
      : fallback
  } catch {
    return fallback
  }
}

function persistWidth(storageKey: string, width: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey, String(width))
  } catch {
    // Storage can be unavailable in hardened or private browser contexts.
  }
}

export function usePersistentPanelWidth(
  storageKey: string,
  {
    defaultWidth = DEFAULT_PANEL_WIDTH,
    minWidth = MIN_PANEL_WIDTH,
    maxWidth = MAX_PANEL_WIDTH,
  }: PersistentPanelWidthOptions = {},
): readonly [number, Dispatch<SetStateAction<number>>] {
  const [width, setWidthState] = useState(() => readStoredWidth(
    storageKey,
    defaultWidth,
    minWidth,
    maxWidth,
  ))

  useEffect(() => {
    setWidthState(readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth))
  }, [defaultWidth, maxWidth, minWidth, storageKey])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return
      const parsedWidth = event.newValue === null ? defaultWidth : Number(event.newValue)
      const nextWidth = Number.isFinite(parsedWidth) ? parsedWidth : defaultWidth
      setWidthState(clampPanelWidth(nextWidth, minWidth, maxWidth))
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [defaultWidth, maxWidth, minWidth, storageKey])

  const setWidth = useCallback<Dispatch<SetStateAction<number>>>((nextWidth) => {
    setWidthState((currentWidth) => {
      const resolvedWidth = typeof nextWidth === 'function'
        ? nextWidth(currentWidth)
        : nextWidth
      const clampedWidth = clampPanelWidth(resolvedWidth, minWidth, maxWidth)
      persistWidth(storageKey, clampedWidth)
      return clampedWidth
    })
  }, [maxWidth, minWidth, storageKey])

  return [width, setWidth] as const
}

interface DragState {
  pointerId: number
  startX: number
  startWidth: number
}

interface DocumentDragStyle {
  cursor: string
  userSelect: string
}

export interface PanelResizerProps {
  width: number
  onWidthChange: (width: number) => void
  minWidth?: number
  maxWidth?: number
  edge?: 'left' | 'right'
  step?: number
  largeStep?: number
  label?: string
  controls?: string
  className?: string
  style?: CSSProperties
}

export function PanelResizer({
  width,
  onWidthChange,
  minWidth = MIN_PANEL_WIDTH,
  maxWidth = MAX_PANEL_WIDTH,
  edge = 'left',
  step = 8,
  largeStep = 32,
  label = '调整详情面板宽度',
  controls,
  className = '',
  style,
}: PanelResizerProps) {
  const dragRef = useRef<DragState | undefined>(undefined)
  const documentStyleRef = useRef<DocumentDragStyle | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const clampedWidth = clampPanelWidth(width, minWidth, maxWidth)

  const restoreDocumentStyle = useCallback(() => {
    const previousStyle = documentStyleRef.current
    if (!previousStyle || typeof document === 'undefined') return
    document.body.style.cursor = previousStyle.cursor
    document.body.style.userSelect = previousStyle.userSelect
    documentStyleRef.current = undefined
  }, [])

  const endDrag = useCallback(() => {
    dragRef.current = undefined
    setDragging(false)
    restoreDocumentStyle()
  }, [restoreDocumentStyle])

  useEffect(() => () => restoreDocumentStyle(), [restoreDocumentStyle])

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: clampedWidth,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)

    if (typeof document !== 'undefined' && !documentStyleRef.current) {
      documentStyleRef.current = {
        cursor: document.body.style.cursor,
        userSelect: document.body.style.userSelect,
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const pointerDelta = event.clientX - drag.startX
    const widthDelta = edge === 'left' ? -pointerDelta : pointerDelta
    onWidthChange(clampPanelWidth(drag.startWidth + widthDelta, minWidth, maxWidth))
  }

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    endDrag()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keyStep = Math.abs(event.shiftKey ? largeStep : step)
    let nextWidth: number | undefined

    if (event.key === 'ArrowLeft') {
      nextWidth = clampedWidth + (edge === 'left' ? keyStep : -keyStep)
    } else if (event.key === 'ArrowRight') {
      nextWidth = clampedWidth + (edge === 'left' ? -keyStep : keyStep)
    } else if (event.key === 'Home') {
      nextWidth = minWidth
    } else if (event.key === 'End') {
      nextWidth = maxWidth
    }

    if (nextWidth === undefined) return
    event.preventDefault()
    onWidthChange(clampPanelWidth(nextWidth, minWidth, maxWidth))
  }

  return (
    <div
      className={`panel-resizer ${dragging ? 'is-resizing' : ''} ${className}`.trim()}
      style={{ cursor: 'col-resize', touchAction: 'none', ...style }}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={Math.min(minWidth, maxWidth)}
      aria-valuemax={Math.max(minWidth, maxWidth)}
      aria-valuenow={clampedWidth}
      aria-valuetext={`${clampedWidth} 像素`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={endDrag}
    />
  )
}
