import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { bridge } from '../../bridge'
import { Icon, type IconName } from '../../icons'
import type { JsonRecord, RunDetailView, SourceItem, WorkbenchSnapshot } from '../../types'
import { EmptyState, Modal, Tabs } from '../../ui'
import { PanelResizer, usePersistentPanelWidth } from '../shell/panel-resizer'

export type WorkInspectorTab = 'details' | 'changes' | 'activity'

interface WorkInspectorProps {
  detail: RunDetailView
  snapshot: WorkbenchSnapshot
  requestedTab: WorkInspectorTab
  onBindChrome: () => void
  onOpenSettings: () => void
  onRevealArtifact: (id: string) => void
  onUndoChange: (id: string) => void
}

const TOOL_LABELS: Record<string, string> = {
  web_search: '搜索网页', web_fetch: '读取网页', file_list: '浏览文件', file_read: '读取文件', file_search: '搜索工作区',
  file_write: '写入文件', file_replace: '修改文件', file_delete: '移入废纸篓', shell_run: '运行命令', task_plan: '整理计划',
  task_step_update: '更新步骤', task_complete: '完成检查', skill_read: '读取技能', memory_propose: '提出记忆', agent_delegate: '并行处理',
  chrome_snapshot: '读取网页', chrome_screenshot: '网页截图', chrome_navigate: '打开网页', chrome_click: '点击网页', chrome_type: '网页输入',
  mcp_list_tools: '发现连接能力', mcp_call_tool: '使用连接',
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}

function formatTime(value?: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
}

function formatBytes(value?: number): string {
  if (value === undefined) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function sourceHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '网页来源' }
}

function sourcesFor(detail: RunDetailView): SourceItem[] {
  const items = new Map<string, SourceItem>()
  const add = (source: SourceItem) => { if (source.url) items.set(source.url, items.get(source.url) ?? source) }
  detail.sources.forEach(add)
  detail.toolCalls.forEach((tool) => tool.sources.forEach(add))
  return [...items.values()]
}

const INTERNAL_ARTIFACT_KINDS = new Set(['attachment', 'file_snapshot', 'checkpoint'])

export function isUserVisibleArtifact(artifact: { kind?: string; mime?: unknown; mediaType?: unknown }): boolean {
  const kind = String(artifact.kind ?? '')
  if (INTERNAL_ARTIFACT_KINDS.has(kind) || kind === 'diff') return false
  if (kind === 'final_output') return true
  const mediaType = String(artifact.mime ?? artifact.mediaType ?? '')
  return kind === 'tool_result' && mediaType.startsWith('image/')
}

function visibleOutputs(detail: RunDetailView) {
  return detail.artifacts.filter(isUserVisibleArtifact)
}

function artifactKindLabel(kind?: string): string {
  if (kind === 'final_output') return '最终产物'
  if (kind === 'tool_result') return '生成内容'
  return '文件'
}

function Section({ title, icon, children }: { title: string; icon: IconName; children: ReactNode }) {
  return <section className="inspector-section"><h3><Icon name={icon} size={15} />{title}</h3>{children}</section>
}

function DetailsPanel({ detail, snapshot, onBindChrome, onOpenSettings }: Pick<WorkInspectorProps, 'detail' | 'snapshot' | 'onBindChrome' | 'onOpenSettings'>) {
  const workspace = snapshot.workspaces.find((item) => item.id === detail.workspaceId)
  const model = snapshot.models.find((item) => item.id === detail.modelProfileId)
  const sources = sourcesFor(detail)
  const verification = detail.verification
  const browserRelevant = snapshot.chrome.grants.some((grant) => grant.runId === detail.id)
    || detail.toolCalls.some((tool) => tool.toolName.startsWith('chrome_'))

  return <>
    {verification?.status && <Section title="检查" icon={verification.status === 'partial' ? 'warning' : 'check'}>
      <div className={`verification-card verification-${verification.status}`}>
        <span><Icon name={verification.status === 'partial' ? 'warning' : 'check'} /></span>
        <div><strong>{verification.status === 'partial' ? '还有内容未检查' : '检查通过'}</strong><p>{verification.summary || (verification.status === 'partial' ? '现有结果仍缺少部分依据。' : '现有检查支持本次结果。')}</p></div>
      </div>
      {verification.checks.length > 0 && <div className="verification-checks">{verification.checks.map((check, index) => <div key={`${check.name}-${index}`} className={`check-${check.status}`}><Icon name={check.status === 'passed' ? 'check' : check.status === 'failed' ? 'warning' : 'clock'} size={14} /><span><strong>{check.name}</strong>{check.detail && <small>{check.detail}</small>}</span></div>)}</div>}
    </Section>}

    {sources.length > 0 && <Section title="来源" icon="globe"><div className="source-list">{sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer noopener" key={source.url}><span>{index + 1}</span><span><strong>{source.title || sourceHost(source.url)}</strong><small>{source.publisher || sourceHost(source.url)} · {source.status === 'verified' ? '已核验' : source.status === 'fetched' ? '已读取' : source.status === 'failed' ? '读取失败' : '搜索发现'}</small></span><Icon name="external" size={14} /></a>)}</div></Section>}

    <Section title="当前目标" icon="tasks"><p className="inspector-goal">{detail.goal ?? detail.prompt ?? detail.title}</p></Section>

    {browserRelevant && <Section title="浏览器连接" icon="globe"><div className="chrome-card"><div className="connection-line"><span className={`connection-dot ${snapshot.chrome.connected ? 'online' : ''}`} /><strong>{snapshot.chrome.connected ? '已连接' : '需要重新连接'}</strong></div><p>{snapshot.chrome.connected ? `${snapshot.chrome.grants.length} 个标签页已授权；只能访问你主动绑定的标签页。` : '这项工作使用了浏览器能力，继续前需要恢复连接。'}</p>{snapshot.chrome.connected ? <button type="button" className="button secondary small" onClick={onBindChrome}>绑定当前标签页</button> : <button type="button" className="button secondary small" onClick={onOpenSettings}>查看连接设置</button>}</div></Section>}

    <details className="technical-disclosure">
      <summary><Icon name="layers" size={15} /><span>本次使用</span><Icon name="chevronDown" size={14} /></summary>
      <div className="context-list">
        {workspace && <div><span className="context-icon"><Icon name="folder" size={14} /></span><span><strong>{workspace.name}</strong><small>{shortPath(workspace.path)}</small></span></div>}
        {model && <div><span className="context-icon"><Icon name="layers" size={14} /></span><span><strong>{model.name}</strong><small>{model.modelId}</small></span></div>}
        <div><span className="context-icon trusted"><Icon name="shield" size={14} /></span><span><strong>执行权限</strong><small>{detail.accessMode === 'full_disk' ? '完全访问整个磁盘 · 工具自动执行' : '工作区内操作按需批准'}</small></span></div>
      </div>
    </details>
  </>
}

function ActivityPanel({ detail }: { detail: RunDetailView }) {
  if (!detail.steps.length && !detail.toolCalls.length && !detail.approvalHistory.length) {
    return <EmptyState compact icon="activity" title="还没有活动" description="读取、命令、网页操作和确认记录会显示在这里。" />
  }
  return <>
    {detail.steps.length > 0 && <Section title="步骤" icon="tasks"><div className="plan-list">{detail.steps.map((step, index) => <div key={step.id} className={`plan-step step-${step.status}`}><span>{step.status === 'completed' ? <Icon name="check" size={14} /> : step.status === 'failed' ? <Icon name="warning" size={14} /> : index + 1}</span><div><strong>{step.title}</strong>{step.detail && <small>{step.detail}</small>}</div></div>)}</div></Section>}
    {detail.toolCalls.length > 0 && <Section title="执行记录" icon="terminal"><div className="inspector-activity-list">{detail.toolCalls.map((tool) => <div key={tool.id} className={`tool-status-${tool.status}`}><span className="tool-status-dot" /><span><strong>{tool.title ?? TOOL_LABELS[tool.toolName] ?? tool.toolName.replaceAll('_', ' ')}</strong><small>{tool.error ?? tool.summary ?? (tool.status === 'succeeded' ? '已完成' : tool.status === 'failed' ? '没有完成' : '正在处理')}</small></span><time>{formatTime(tool.updatedAt ?? tool.createdAt)}</time></div>)}</div></Section>}
    {detail.approvalHistory.length > 0 && <Section title="确认记录" icon="shield"><div className="inspector-activity-list">{detail.approvalHistory.map((approval) => <div key={approval.id} className={`approval-${approval.status}`}><Icon name={approval.status === 'approved' || approval.status === 'edited' ? 'check' : approval.status === 'rejected' ? 'warning' : 'clock'} size={14} /><span><strong>{approval.title}</strong><small>{approval.status === 'approved' ? '已允许' : approval.status === 'edited' ? '修改后允许' : approval.status === 'rejected' ? '已拒绝' : '需要确认'}</small></span><time>{formatTime(approval.resolvedAt ?? approval.createdAt)}</time></div>)}</div></Section>}
  </>
}

function ChangesPanel({ detail, onRevealArtifact, onUndoChange, onPreview }: Pick<WorkInspectorProps, 'detail' | 'onRevealArtifact' | 'onUndoChange'> & { onPreview: (value: { name: string; text: string; truncated: boolean }) => void }) {
  const outputs = visibleOutputs(detail)
  return <>
    {detail.diffs.length > 0 && <Section title="文件变更" icon="edit"><div className="file-change-list">{detail.diffs.map((diff) => <div key={diff.id}><Icon name="file" /><span><strong>{diff.path.split('/').at(-1)}</strong><small>{shortPath(diff.path)}</small></span><em className="additions">+{diff.additions ?? 0}</em><em className="deletions">−{diff.deletions ?? 0}</em><button type="button" className="text-button" onClick={async () => { const result = await bridge.getArtifactText(diff.id); const value = result && typeof result === 'object' ? result as JsonRecord : {}; onPreview({ name: diff.path.split('/').at(-1) ?? 'Diff', text: String(value.text ?? ''), truncated: value.truncated === true }) }}>查看</button><button type="button" className="text-button" onClick={() => onUndoChange(diff.id)}>撤销</button></div>)}</div></Section>}
    {outputs.length > 0 && <Section title="输出" icon="file"><div className="artifact-list">{outputs.map((artifact) => <button type="button" key={artifact.id} onClick={() => onRevealArtifact(artifact.id)}><span className="artifact-icon"><Icon name="file" /></span><span><strong>{artifact.name}</strong><small>{artifactKindLabel(artifact.kind)} {formatBytes(artifact.size)}</small></span><Icon name="external" size={14} /></button>)}</div></Section>}
    {!detail.diffs.length && !outputs.length && <EmptyState compact icon="edit" title="没有文件或输出" description="有实际变更或生成文件后会显示在这里。" />}
  </>
}

function ArtifactShelf({ detail, onRevealArtifact, onOpenChanges }: Pick<WorkInspectorProps, 'detail' | 'onRevealArtifact'> & { onOpenChanges: () => void }) {
  const outputs = visibleOutputs(detail)
  const total = outputs.length + detail.diffs.length
  return (
    <section className="inspector-artifact-shelf" aria-label="产物">
      <header><span><Icon name="file" size={15} /><strong>产物</strong></span>{total > 0 && <em>{total}</em>}</header>
      {total === 0 ? (
        <p>Agent 生成的文件、报告、截图和变更会集中在这里。</p>
      ) : (
        <div className="artifact-shelf-list">
          {outputs.slice(0, 3).map((artifact) => <button type="button" key={artifact.id} onClick={() => onRevealArtifact(artifact.id)}><span className="artifact-shelf-icon"><Icon name="file" size={14} /></span><span><strong>{artifact.name}</strong><small>{artifactKindLabel(artifact.kind)} {formatBytes(artifact.size)}</small></span><Icon name="external" size={13} /></button>)}
          {detail.diffs.length > 0 && <button type="button" onClick={onOpenChanges}><span className="artifact-shelf-icon change"><Icon name="edit" size={14} /></span><span><strong>文件变更</strong><small>{detail.diffs.length} 项可查看或撤销</small></span><Icon name="arrowRight" size={13} /></button>}
          {outputs.length > 3 && <button type="button" className="artifact-shelf-more" onClick={onOpenChanges}>查看另外 {outputs.length - 3} 项产物</button>}
        </div>
      )}
    </section>
  )
}

export function WorkInspector(props: WorkInspectorProps) {
  const { detail, requestedTab } = props
  const [tab, setTab] = useState<WorkInspectorTab>(requestedTab)
  const [diffPreview, setDiffPreview] = useState<{ name: string; text: string; truncated: boolean }>()
  const [width, setWidth] = usePersistentPanelWidth('workbuddy.inspector-width')
  const outputs = useMemo(() => visibleOutputs(detail), [detail])
  const available = useMemo(() => ({
    details: true,
    changes: detail.diffs.length > 0 || outputs.length > 0,
    activity: detail.steps.length > 0 || detail.toolCalls.length > 0 || detail.approvalHistory.length > 0,
  }), [detail, outputs.length])

  useEffect(() => { setTab(available[requestedTab] ? requestedTab : 'details') }, [available, requestedTab])

  const items = [
    { id: 'details' as const, label: '详细', panel: <DetailsPanel {...props} /> },
    ...(available.changes ? [{ id: 'changes' as const, label: `变更 ${detail.diffs.length || ''}`.trim(), panel: <ChangesPanel {...props} onPreview={setDiffPreview} /> }] : []),
    ...(available.activity ? [{ id: 'activity' as const, label: '活动', panel: <ActivityPanel detail={detail} /> }] : []),
  ]

  return (
    <aside className="inspector" style={{ width }}>
      <PanelResizer width={width} onWidthChange={setWidth} />
      <ArtifactShelf detail={detail} onRevealArtifact={props.onRevealArtifact} onOpenChanges={() => setTab('changes')} />
      <Tabs className="inspector-tab-shell" ariaLabel="工作详情" value={tab} onValueChange={setTab} tabListClassName="inspector-tabs" tabPanelClassName="inspector-content" items={items} />
      <Modal open={Boolean(diffPreview)} onClose={() => setDiffPreview(undefined)} title={diffPreview?.name ?? '文件变更'} description={diffPreview?.truncated ? '这里只显示部分内容，可在 Finder 中打开完整文件。' : 'WorkBuddy 保存的本地文件变更。'} wide><pre className="diff-preview">{diffPreview?.text}</pre></Modal>
    </aside>
  )
}
