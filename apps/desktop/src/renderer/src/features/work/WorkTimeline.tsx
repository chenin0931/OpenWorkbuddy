import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BrandMark, Icon } from '../../icons'
import type { JsonRecord, RunDetailView, ToolActivityItem } from '../../types'
import { buildWorkTurns, type ActivityGroup, type ResultEvidence } from '../../work-turn'

interface WorkTimelineProps {
  detail: RunDetailView
  approvals?: ReactNode
  onOpenDetails: () => void
  onOpenChanges: () => void
}

const TOOL_LABELS: Record<string, string> = {
  web_search: '搜索网页', web_fetch: '读取网页', file_list: '浏览文件', file_read: '读取文件', file_search: '搜索工作区',
  file_write: '写入文件', file_replace: '修改文件', file_delete: '移入废纸篓', shell_run: '运行命令', task_plan: '整理计划',
  task_step_update: '更新步骤', task_complete: '完成检查', skill_read: '读取技能', memory_propose: '提出记忆', agent_delegate: '并行处理',
  chrome_tabs: '查看授权标签', chrome_snapshot: '读取网页', chrome_screenshot: '网页截图', chrome_navigate: '打开网页', chrome_click: '点击网页', chrome_type: '网页输入',
  mcp_list_tools: '发现连接能力', mcp_call_tool: '使用连接',
}

const GROUP_META: Record<ActivityGroup['kind'], { label: string; icon: 'file' | 'terminal' | 'globe' | 'plug' | 'tasks' | 'activity' }> = {
  files: { label: '文件', icon: 'file' },
  shell: { label: '命令', icon: 'terminal' },
  web: { label: '网页', icon: 'globe' },
  mcp: { label: '连接', icon: 'plug' },
  plan: { label: '计划', icon: 'tasks' },
  other: { label: '其他', icon: 'activity' },
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

function toolName(tool: ToolActivityItem): string {
  return tool.title ?? TOOL_LABELS[tool.toolName] ?? tool.toolName.replaceAll('_', ' ')
}

function diagnosticText(value: unknown): string {
  if (value === undefined) return ''
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

function activityHeadline(groups: ActivityGroup[]): string {
  const count = groups.reduce((sum, group) => sum + group.count, 0)
  const running = groups.some((group) => group.state === 'running')
  const failed = groups.some((group) => group.state === 'failed')
  if (running) return `正在处理 · ${count} 项活动`
  if (failed) return `${count} 项活动 · 有操作未完成`
  const names = groups.slice(0, 3).map((group) => `${GROUP_META[group.kind].label} ${group.count}`)
  return `已处理 ${names.join(' · ')}`
}

function ActivityDisclosure({ groups }: { groups: ActivityGroup[] }) {
  if (!groups.length) return null
  return (
    <details className="turn-activity">
      <summary>
        <span className="activity-symbol"><Icon name="activity" size={16} /></span>
        <strong>{activityHeadline(groups)}</strong>
        <Icon name="chevronDown" size={14} />
      </summary>
      <div className="turn-activity-content">
        {groups.map((group) => (
          <section key={group.kind} className={`activity-group activity-${group.state}`}>
            <header><Icon name={GROUP_META[group.kind].icon} size={15} /><strong>{GROUP_META[group.kind].label}</strong><span>{group.count}</span></header>
            {group.toolCalls.map((tool) => {
              const diagnostic = diagnosticText(tool.argumentsSummary ?? tool.arguments)
              return (
                <div key={tool.id} className={`activity-row tool-status-${tool.status}`}>
                  <span className="tool-status-dot" />
                  <span><strong>{toolName(tool)}</strong><small>{tool.error ?? tool.summary ?? (tool.status === 'succeeded' ? '已完成' : tool.status === 'failed' ? '没有完成' : '正在处理')}</small></span>
                  <time>{formatTime(tool.updatedAt ?? tool.createdAt)}</time>
                  {diagnostic && <details className="diagnostic-details"><summary>技术详情</summary><pre>{diagnostic}</pre></details>}
                </div>
              )
            })}
            {group.steps.map((step) => (
              <div key={step.id} className={`activity-row step-${step.status}`}>
                <span className="tool-status-dot" />
                <span><strong>{step.title}</strong>{step.detail && <small>{step.detail}</small>}</span>
                <time>{formatTime(step.updatedAt ?? step.createdAt)}</time>
              </div>
            ))}
          </section>
        ))}
      </div>
    </details>
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
    return '这次操作没有完成。你可以重试，或展开活动查看诊断信息。'
  }
  return raw.length > 180 ? `${raw.slice(0, 179)}…` : raw
}

export function WorkTimeline({ detail, approvals, onOpenDetails, onOpenChanges }: WorkTimelineProps) {
  const tailRef = useRef<HTMLDivElement>(null)
  const followTailRef = useRef(true)
  const turns = useMemo(() => buildWorkTurns(detail), [detail])
  const active = ['understanding', 'planning', 'running', 'verifying'].includes(detail.status)

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
                <div className="message-meta"><strong>On My WorkBuddy</strong><span>{formatTime(turn.response.updatedAt ?? turn.updatedAt)}</span></div>
                <div className="agent-turn-entries">
                  {turn.response.content && <div className="agent-turn-text"><Markdown>{turn.response.content}</Markdown></div>}
                  <ActivityDisclosure groups={turn.activity} />
                  {turn.result && <ResultSummary result={turn.result} onOpenDetails={onOpenDetails} onOpenChanges={onOpenChanges} />}
                </div>
              </div>
            </article>
            {index === turns.length - 1 ? approvals : null}
          </section>
        )
      })}
      {active && <div className="agent-working" role="status"><Icon name="activity" size={14} /><span>{detail.status === 'verifying' ? '正在检查结果' : detail.status === 'planning' ? '正在整理步骤' : '正在处理'}</span></div>}
      {detail.status === 'failed' && <div className="inline-notice error"><Icon name="warning" /><span>{safeFailureMessage(detail)}</span></div>}
      <div ref={tailRef} className="timeline-tail" aria-hidden="true" />
    </div>
  )
}
