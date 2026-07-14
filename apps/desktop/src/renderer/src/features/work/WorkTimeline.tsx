import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BrandMark, Icon } from '../../icons'
import type { JsonRecord, RunDetailView } from '../../types'
import { buildWorkTurns, type ResultEvidence } from '../../work-turn'
import { ProcessDisclosure } from './ProcessDisclosure'

interface WorkTimelineProps {
  detail: RunDetailView
  approvals?: ReactNode
  onOpenDetails: () => void
  onOpenChanges: () => void
}

function formatTime(value?: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
}

function safeHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children: linkChildren, ...props }) => {
            const target = safeHref(href)
            return target
              ? <a {...props} href={target} target="_blank" rel="noreferrer noopener">{linkChildren}</a>
              : <span>{linkChildren}</span>
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

function ResultSummary({ result, onOpenDetails, onOpenChanges }: { result: ResultEvidence; onOpenDetails: () => void; onOpenChanges: () => void }) {
  const changes = result.changes?.length ?? 0
  const outputs = result.outputs?.filter((item) => item.kind !== 'diff').length ?? 0
  const checks = result.checks?.length ?? 0
  const sources = result.sources?.length ?? 0
  if (!changes && !outputs && !checks && !sources) return null
  return (
    <div className="result-summary">
      <div className="result-summary-items">
        {changes > 0 && <span><Icon name="edit" size={15} />修改了 {changes} 个文件</span>}
        {checks > 0 && <span><Icon name={result.status === 'partial' ? 'warning' : 'check'} size={15} />{result.status === 'partial' ? `还有内容未检查` : `${checks} 项检查通过`}</span>}
        {sources > 0 && <span><Icon name="globe" size={15} />{sources} 条来源</span>}
        {outputs > 0 && <span><Icon name="file" size={15} />{outputs} 个输出</span>}
      </div>
      <div className="result-summary-actions">
        {changes > 0 || outputs > 0 ? <button type="button" onClick={onOpenChanges}>查看变更</button> : null}
        {checks > 0 || sources > 0 ? <button type="button" onClick={onOpenDetails}>查看依据</button> : null}
      </div>
    </div>
  )
}

function safeFailureMessage(detail: RunDetailView): string {
  const raw = typeof detail.lastError === 'object' && detail.lastError
    ? String((detail.lastError as JsonRecord).message ?? '')
    : ''
  if (!raw || /constraint|sqlite|stack|tool_calls|\bid\b/i.test(raw)) {
    return '这次操作没有完成。你可以重试，或打开右侧诊断查看技术信息。'
  }
  return raw.length > 180 ? `${raw.slice(0, 179)}…` : raw
}

export function WorkTimeline({ detail, approvals, onOpenDetails, onOpenChanges }: WorkTimelineProps) {
  const tailRef = useRef<HTMLDivElement>(null)
  const followTailRef = useRef(true)
  const [openProcessTurnId, setOpenProcessTurnId] = useState<string>()
  const turns = useMemo(() => buildWorkTurns(detail), [detail])

  useEffect(() => {
    const scroller = tailRef.current?.closest('.run-scroll')
    if (!(scroller instanceof HTMLElement)) return undefined
    followTailRef.current = true
    const frame = requestAnimationFrame(() => tailRef.current?.scrollIntoView({ block: 'end' }))
    const update = () => { followTailRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 180 }
    scroller.addEventListener('scroll', update, { passive: true })
    return () => { cancelAnimationFrame(frame); scroller.removeEventListener('scroll', update) }
  }, [detail.id])

  useEffect(() => {
    if (!followTailRef.current) return undefined
    const frame = requestAnimationFrame(() => tailRef.current?.scrollIntoView({ block: 'end' }))
    return () => cancelAnimationFrame(frame)
  }, [detail.status, detail.toolCalls.length, detail.events.length, detail.approvals.length])

  return (
    <div className="timeline work-timeline">
      {turns.map((turn, index) => {
        const optimistic = turn.prompt.messageIds.some((id) => detail.events.some((event) => event.id === id && event.optimistic))
        return (
          <section key={turn.id} className="work-turn">
            <article className={`message user-message${optimistic ? ' is-optimistic' : ''}`}>
              <div className="message-content"><div className="message-meta"><strong>你</strong><span>{formatTime(turn.prompt.createdAt)}</span></div><Markdown>{turn.prompt.content}</Markdown></div>
            </article>
            <article className="message agent-message agent-turn">
              <div className="message-avatar agent"><BrandMark size={17} /></div>
              <div className="message-content">
                <div className="message-meta"><strong>OpenWorkbuddy</strong><span>{formatTime(turn.response.updatedAt ?? turn.updatedAt)}</span></div>
                <div className="agent-turn-entries">
                  {turn.process && (
                    <ProcessDisclosure
                      timeline={turn.process}
                      open={openProcessTurnId === turn.id}
                      onToggle={() => setOpenProcessTurnId((current) => current === turn.id ? undefined : turn.id)}
                    />
                  )}
                  {turn.response.content && <div className="agent-turn-text"><Markdown>{turn.response.content}</Markdown></div>}
                  {turn.result && <ResultSummary result={turn.result} onOpenDetails={onOpenDetails} onOpenChanges={onOpenChanges} />}
                </div>
              </div>
            </article>
            {index === turns.length - 1 ? approvals : null}
          </section>
        )
      })}
      {detail.status === 'failed' && <div className="inline-notice error"><Icon name="warning" /><span>{safeFailureMessage(detail)}</span></div>}
      <div ref={tailRef} className="timeline-tail" aria-hidden="true" />
    </div>
  )
}
