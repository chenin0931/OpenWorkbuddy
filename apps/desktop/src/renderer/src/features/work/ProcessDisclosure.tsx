import { default as React, useId } from 'react'
import { Icon } from '../../icons'
import type { ProcessStepState, ProcessStepViewModel, ProcessTimelineViewModel } from '../../work-turn.types'
import { ProcessIcon } from './ProcessIcon'

const STATE_LABEL: Record<ProcessStepState, string> = {
  pending: '等待开始', running: '正在进行', succeeded: '已完成', warning: '已完成，有提示', failed: '未完成', waiting: '等待确认',
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

export function ProcessDisclosure({
  timeline,
  open,
  onToggle,
}: {
  timeline: ProcessTimelineViewModel
  open: boolean
  onToggle: () => void
}) {
  const panelId = useId()
  const current = timeline.steps.find((step) => step.state === 'running' || step.state === 'waiting' || step.state === 'failed')
    ?? timeline.steps.at(-1)
  const duration = durationLabel(timeline.totalDurationMs)

  return (
    <section className={`process-disclosure${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className={`process-trigger process-trigger-${timeline.state}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${open ? '收起' : '查看'}执行过程：${timeline.headline}`}
      >
        <span className="process-trigger-icon"><ProcessIcon kind={current?.kind ?? 'complete'} state={timeline.state} size={17} /></span>
        <strong>{timeline.headline}</strong>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div id={panelId} className="process-inline-panel">
          <header className="process-inline-header">
            <strong>执行过程</strong>
            <span>{timeline.steps.length} 个步骤{duration ? ` · ${duration}` : ''}</span>
          </header>
          <ProcessTimeline timeline={timeline} />
        </div>
      )}
    </section>
  )
}
