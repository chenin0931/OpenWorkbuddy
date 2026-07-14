import {
  default as React,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Icon } from '../../icons'
import type { ProcessStepState, ProcessStepViewModel, ProcessTimelineViewModel } from '../../work-turn.types'
import { ProcessIcon } from './ProcessIcon'

const FOCUSABLE = 'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])'
const STATE_LABEL: Record<ProcessStepState, string> = {
  pending: '等待开始', running: '正在进行', succeeded: '已完成', warning: '已完成，有提示', failed: '未完成', waiting: '等待确认',
}

function clampHeight(value: number): number {
  const minimum = Math.min(360, window.innerHeight * .62)
  return Math.min(Math.max(value, minimum), window.innerHeight * .82)
}

function durationLabel(durationMs?: number): string {
  if (durationMs === undefined) return ''
  if (durationMs < 1_000) return `${durationMs} 毫秒`
  if (durationMs < 60_000) return `${Math.max(1, Math.round(durationMs / 1_000))} 秒`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1_000)
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
}

function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined
  } catch { return undefined }
}

function sourceLabel(value: string): string {
  try { return new URL(value).hostname.replace(/^www\./, '') } catch { return '网页来源' }
}

function StepEvidence({ step }: { step: ProcessStepViewModel }) {
  const sources = step.sourceUrls.map((url) => ({ url: safeUrl(url), label: sourceLabel(url) })).filter((item) => item.url)
  const duration = durationLabel(step.durationMs)
  if (!sources.length && !duration && !step.artifactIds.length) return null
  return (
    <details className="process-evidence">
      <summary>查看依据</summary>
      <div>
        {duration && <span>耗时 {duration}</span>}
        {step.artifactIds.length > 0 && <span>{step.artifactIds.length} 个相关产物</span>}
        {sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer noopener">{source.label}<Icon name="external" size={12} /></a>)}
      </div>
    </details>
  )
}

export function ProcessTimeline({ timeline }: { timeline: ProcessTimelineViewModel }) {
  return (
    <ol className="process-timeline" aria-label="执行步骤">
      {timeline.steps.map((step) => (
        <li key={step.id} className={`process-step process-step-${step.state}`}>
          <span className="process-step-node"><ProcessIcon kind={step.kind} state={step.state} /></span>
          <div className="process-step-copy">
            <div><strong>{step.title}</strong><span>{STATE_LABEL[step.state]}</span></div>
            {step.detail && <p>{step.detail}</p>}
            <StepEvidence step={step} />
          </div>
        </li>
      ))}
    </ol>
  )
}

export function ProcessTrigger({ timeline, onOpen }: { timeline: ProcessTimelineViewModel; onOpen: () => void }) {
  const current = timeline.steps.find((step) => step.state === 'running' || step.state === 'waiting' || step.state === 'failed')
    ?? timeline.steps.at(-1)
  return (
    <button
      type="button"
      className={`process-trigger process-trigger-${timeline.state}`}
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`查看执行过程：${timeline.headline}`}
    >
      <span className="process-trigger-icon"><ProcessIcon kind={current?.kind ?? 'complete'} state={timeline.state} size={17} /></span>
      <strong>{timeline.headline}</strong>
      <Icon name="arrowRight" size={14} />
    </button>
  )
}

export function ProcessSheet({ open, timeline, onClose }: { open: boolean; timeline?: ProcessTimelineViewModel | undefined; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ pointerY: number; height: number } | null>(null)
  const [height, setHeight] = useState<number | undefined>()
  const titleId = useId()

  useEffect(() => {
    if (!open) return undefined
    const dialog = dialogRef.current
    if (!dialog) return undefined
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = requestAnimationFrame(() => dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus() ?? dialog.focus())
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null)
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return }
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', keydown)
      document.body.style.overflow = previousOverflow
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus()
      previousFocusRef.current = null
    }
  }, [onClose, open])

  if (!open || !timeline) return null

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    dragRef.current = { pointerY: event.clientY, height: dialogRef.current?.getBoundingClientRect().height ?? window.innerHeight * .62 }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const resize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return
    setHeight(clampHeight(dragRef.current.height + dragRef.current.pointerY - event.clientY))
  }
  const endResize = () => { dragRef.current = null }
  const resizeKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = height ?? window.innerHeight * .62
    if (event.key === 'Home') setHeight(clampHeight(360))
    else if (event.key === 'End') setHeight(clampHeight(window.innerHeight * .82))
    else setHeight(clampHeight(current + (event.key === 'ArrowUp' ? 40 : -40)))
  }

  return (
    <div className="process-sheet-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section
        ref={dialogRef}
        className="process-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={height ? { height } : undefined}
      >
        <button
          type="button"
          className="process-sheet-handle"
          aria-label="调整执行过程面板高度"
          onPointerDown={beginResize}
          onPointerMove={resize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onKeyDown={resizeKey}
        ><span /></button>
        <header className="process-sheet-header">
          <div><h2 id={titleId}>执行过程</h2><p>{timeline.steps.length} 个步骤{timeline.totalDurationMs !== undefined ? ` · ${durationLabel(timeline.totalDurationMs)}` : ''}</p></div>
          <button type="button" className="icon-button" aria-label="关闭执行过程" data-autofocus onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="process-sheet-content"><ProcessTimeline timeline={timeline} /></div>
      </section>
    </div>
  )
}
