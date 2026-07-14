import type {
  ApprovalItem,
  ArtifactItem,
  JsonRecord,
  PlanStepItem,
  RunStatus,
  ToolActivityItem,
  TraceSpanItem,
  VerificationView,
} from './types'
import type {
  ProcessStepKind,
  ProcessStepState,
  ProcessStepViewModel,
  ProcessTimelineViewModel,
} from './work-turn.types'

interface BuildProcessTimelineInput {
  turnId: string
  prompt: string
  tools: ToolActivityItem[]
  steps: PlanStepItem[]
  traceSpans: TraceSpanItem[]
  approvals: ApprovalItem[]
  artifacts: ArtifactItem[]
  verification?: VerificationView | undefined
  runStatus: RunStatus
  isLatest: boolean
  startedAt?: string | undefined
  endedAt?: string | undefined
}

interface DraftStep extends ProcessStepViewModel {
  mergeKey: string
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[已隐藏密钥]'],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[已隐藏]'],
  [/(authorization|cookie|x-api-key|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1: [已隐藏]'],
]

const PHASE_LABELS: Record<ProcessStepKind, string> = {
  understand: '分析任务', plan: '整理计划', search: '检索资料', read_web: '读取来源', browser: '操作网页', file: '检查文件', command: '运行命令', connector: '使用连接', write: '写入内容', output: '生成产物', verify: '验证结果', approval: '等待确认', recovery: '恢复执行', complete: '整理结果',
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function stringValue(source: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function sanitizeProcessText(value: unknown, maxLength = 120): string {
  let text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement)
  text = text
    .replace(/\/Users\/[^/\s]+\//g, '…/')
    .replace(/\/home\/[^/\s]+\//g, '…/')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text
}

function safePath(value: unknown): string {
  const cleaned = sanitizeProcessText(value, 180)
  if (!cleaned) return ''
  const parts = cleaned.split('/').filter(Boolean)
  if (parts.length <= 3 && !cleaned.startsWith('/')) return cleaned
  return `…/${parts.slice(-3).join('/')}`
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function baseStep(input: {
  id: string
  kind: ProcessStepKind
  state: ProcessStepState
  title: string
  detail?: string | undefined
  startedAt?: string | undefined
  endedAt?: string | undefined
  durationMs?: number | undefined
  sourceUrls?: string[] | undefined
  artifactIds?: string[] | undefined
  toolCallIds?: string[] | undefined
  traceSpanIds?: string[] | undefined
  mergeKey?: string | undefined
}): DraftStep {
  return {
    id: input.id,
    kind: input.kind,
    state: input.state,
    title: sanitizeProcessText(input.title, 120),
    ...(input.detail ? { detail: sanitizeProcessText(input.detail, 200) } : {}),
    count: 1,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.endedAt ? { endedAt: input.endedAt } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    sourceUrls: unique(input.sourceUrls ?? []),
    artifactIds: unique(input.artifactIds ?? []),
    toolCallIds: unique(input.toolCallIds ?? []),
    traceSpanIds: unique(input.traceSpanIds ?? []),
    mergeKey: input.mergeKey ?? `${input.kind}:${sanitizeProcessText(input.title, 80).toLocaleLowerCase()}`,
  }
}

function toolState(tool: ToolActivityItem): ProcessStepState {
  if (tool.status === 'waiting_approval') return 'waiting'
  if (tool.status === 'requested' || tool.status === 'running') return 'running'
  if (tool.status === 'failed' || tool.status === 'cancelled') return /^(?:web_search|web_fetch)$/.test(tool.toolName) ? 'warning' : 'failed'
  return 'succeeded'
}

function semanticToolKind(name: string): ProcessStepKind {
  if (name === 'web_search') return 'search'
  if (name === 'web_fetch') return 'read_web'
  if (name.startsWith('chrome_') || name.startsWith('browser_')) return 'browser'
  if (/^(?:output_register|document_render)$/.test(name)) return 'output'
  if (/^(?:file_write|file_replace|file_delete|file_draft_)/.test(name)) return 'write'
  if (/^(?:file_|attachment_)/.test(name)) return 'file'
  if (/^(?:shell_|process_|terminal_|exec_)/.test(name)) return 'command'
  if (/^(?:mcp_|[^/]+\/[^/]+$)/.test(name)) return 'connector'
  if (/^(?:task_plan|task_step_update|agent_delegate)$/.test(name)) return 'plan'
  if (name === 'task_complete') return 'verify'
  return 'file'
}

function sourceDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function toolPresentation(tool: ToolActivityItem): { kind: ProcessStepKind; title: string; detail?: string; mergeKey: string } {
  const name = tool.toolName
  const args = record(tool.argumentsSummary ?? tool.arguments)
  const kind = semanticToolKind(name)
  const summary = sanitizeProcessText(tool.error ?? tool.summary, 180)
  if (name === 'web_search') {
    const query = sanitizeProcessText(stringValue(args, ['query', 'q', 'keywords']), 80)
    return { kind, title: query ? `搜索了“${query}”` : '搜索了相关网页', ...(summary ? { detail: summary } : {}), mergeKey: `search:${query.toLocaleLowerCase()}` }
  }
  if (name === 'web_fetch') {
    const source = tool.sources[0]
    const label = sanitizeProcessText(source?.title, 80) || (source?.url ? sourceDomain(source.url) : '')
    return { kind, title: label ? `读取了 ${label}` : '读取了网页内容', ...(summary ? { detail: summary } : {}), mergeKey: 'read_web' }
  }
  if (kind === 'browser') {
    const titles: Record<string, string> = { chrome_navigate: '打开了网页', chrome_snapshot: '读取了当前网页', chrome_screenshot: '截取了网页画面', chrome_click: '操作了网页内容', chrome_type: '在网页中输入了内容', chrome_tabs: '检查了授权标签页' }
    return { kind, title: titles[name] ?? '操作了网页', ...(summary ? { detail: summary } : {}), mergeKey: `browser:${name}` }
  }
  if (kind === 'file' || kind === 'write') {
    const path = safePath(stringValue(args, ['path', 'filePath', 'target', 'outputPath']))
    const action = kind === 'write' ? '更新了' : name === 'file_search' ? '搜索了' : name === 'file_list' ? '浏览了' : '读取了'
    return { kind, title: path ? `${action} ${path}` : kind === 'write' ? '更新了工作区文件' : '检查了工作区文件', ...(summary ? { detail: summary } : {}), mergeKey: `${kind}:${name}` }
  }
  if (kind === 'command') {
    const title = sanitizeProcessText(tool.title, 80) || (name.startsWith('process_') ? '运行了后台任务' : '运行了本地命令')
    return { kind, title, ...(summary ? { detail: summary } : {}), mergeKey: `command:${name}` }
  }
  if (kind === 'connector') {
    const namespace = sanitizeProcessText(name.includes('/') ? name.split('/')[0] : stringValue(args, ['server', 'serverId', 'namespace']), 60)
    return { kind, title: namespace ? `使用了 ${namespace} 连接` : '使用了外部连接', ...(summary ? { detail: summary } : {}), mergeKey: `connector:${namespace || name}` }
  }
  if (kind === 'output') {
    const path = safePath(stringValue(args, ['outputPath', 'path']))
    return { kind, title: path ? `生成了《${path.split('/').at(-1)}》` : '登记了最终产物', ...(summary ? { detail: summary } : {}), mergeKey: `output:${path || name}` }
  }
  if (kind === 'verify') return { kind, title: '检查了任务完成条件', ...(summary ? { detail: summary } : {}), mergeKey: 'verify' }
  return { kind, title: '整理了执行计划', ...(summary ? { detail: summary } : {}), mergeKey: 'plan' }
}

function spanForTool(tool: ToolActivityItem, spans: TraceSpanItem[]): TraceSpanItem | undefined {
  return spans.find((span) => span.kind === 'tool_call' && (span.attributes.toolCallId === tool.id || span.name === tool.toolName))
}

function makeToolSteps(tools: ToolActivityItem[], spans: TraceSpanItem[], hasPlanSteps: boolean): DraftStep[] {
  return tools
    .filter((tool) => !(hasPlanSteps && /^(?:task_plan|task_step_update)$/.test(tool.toolName)))
    .map((tool) => {
      const presentation = toolPresentation(tool)
      const span = spanForTool(tool, spans)
      return baseStep({
        id: `tool-${tool.id}`,
        kind: presentation.kind,
        state: toolState(tool),
        title: presentation.title,
        detail: presentation.detail,
        startedAt: tool.createdAt,
        endedAt: tool.updatedAt,
        durationMs: span?.durationMs,
        sourceUrls: tool.sources.map((source) => source.url),
        toolCallIds: [tool.id],
        traceSpanIds: span ? [span.id] : [],
        mergeKey: presentation.mergeKey,
      })
    })
}

function mergedTitle(step: DraftStep): string {
  if (step.count <= 1) return step.title
  if (step.kind === 'read_web') return `读取了 ${step.count} 个网页来源`
  if (step.kind === 'file') return `检查了工作区中的 ${step.count} 个文件`
  if (step.kind === 'command') return `运行了 ${step.count} 个本地任务`
  if (step.kind === 'connector') return `使用连接完成了 ${step.count} 项操作`
  if (step.kind === 'browser') return `完成了 ${step.count} 项网页操作`
  return `${step.title} × ${step.count}`
}

function mergeState(left: ProcessStepState, right: ProcessStepState): ProcessStepState {
  const order: ProcessStepState[] = ['succeeded', 'warning', 'pending', 'running', 'waiting', 'failed']
  return order.indexOf(right) > order.indexOf(left) ? right : left
}

function mergeConsecutive(steps: DraftStep[]): ProcessStepViewModel[] {
  const merged: DraftStep[] = []
  for (const step of steps) {
    const previous = merged.at(-1)
    const canMerge = previous && previous.mergeKey === step.mergeKey && step.kind !== 'search'
    if (!canMerge) { merged.push({ ...step }); continue }
    previous.count += step.count
    previous.state = mergeState(previous.state, step.state)
    const mergedEndedAt = step.endedAt ?? step.startedAt ?? previous.endedAt
    if (mergedEndedAt) previous.endedAt = mergedEndedAt
    previous.durationMs = (previous.durationMs ?? 0) + (step.durationMs ?? 0)
    previous.sourceUrls = unique([...previous.sourceUrls, ...step.sourceUrls])
    previous.artifactIds = unique([...previous.artifactIds, ...step.artifactIds])
    previous.toolCallIds = unique([...previous.toolCallIds, ...step.toolCallIds])
    previous.traceSpanIds = unique([...previous.traceSpanIds, ...step.traceSpanIds])
    previous.title = mergedTitle(previous)
  }
  return merged.map(({ mergeKey: _mergeKey, ...step }) => step)
}

function processState(steps: ProcessStepViewModel[]): ProcessStepState {
  if (steps.some((step) => step.state === 'waiting')) return 'waiting'
  if (steps.some((step) => step.state === 'running' || step.state === 'pending')) return 'running'
  if (steps.some((step) => step.state === 'failed')) return 'failed'
  if (steps.some((step) => step.state === 'warning')) return 'warning'
  return 'succeeded'
}

function processHeadline(steps: ProcessStepViewModel[], state: ProcessStepState): string {
  const total = steps.length
  if (state === 'waiting') return `需要确认 · ${total} 个步骤`
  if (state === 'running') {
    const current = steps.find((step) => step.state === 'running' || step.state === 'pending')
    const completed = steps.filter((step) => step.state === 'succeeded' || step.state === 'warning').length
    return `${current ? `正在${PHASE_LABELS[current.kind]}` : '正在处理'} · ${completed}/${total} 步`
  }
  if (state === 'failed') return `执行未完成 · ${total} 个步骤`
  if (state === 'warning') return `已完成 · ${total} 个步骤 · 有提示`
  return `${total} 个步骤`
}

function totalDuration(steps: ProcessStepViewModel[]): number | undefined {
  const starts = steps.map((step) => timestamp(step.startedAt)).filter((value): value is number => value !== undefined)
  const ends = steps.map((step) => timestamp(step.endedAt) ?? timestamp(step.startedAt)).filter((value): value is number => value !== undefined)
  if (!starts.length || !ends.length) return undefined
  return Math.max(0, Math.max(...ends) - Math.min(...starts))
}

export function buildProcessTimeline(input: BuildProcessTimelineInput): ProcessTimelineViewModel | undefined {
  const isActive = input.isLatest && ['understanding', 'planning', 'running', 'verifying'].includes(input.runStatus)
  const operationalSpans = input.traceSpans.filter((span) => ['tool_call', 'approval_wait', 'checkpoint', 'verification', 'managed_process'].includes(span.kind))
  const visibleArtifacts = input.artifacts.filter((artifact) => artifact.kind === 'final_output')
  const hasOperationalWork = isActive || input.tools.length > 0 || input.steps.length > 0 || input.approvals.length > 0 || operationalSpans.length > 0 || (input.isLatest && (visibleArtifacts.length > 0 || Boolean(input.verification)))
  if (!hasOperationalWork) return undefined

  const onlyPreparing = isActive && !input.tools.length && !input.steps.length && !input.approvals.length && !operationalSpans.length
  const drafts: DraftStep[] = [baseStep({ id: `${input.turnId}-understand`, kind: 'understand', state: onlyPreparing ? 'running' : 'succeeded', title: onlyPreparing ? '正在分析任务要求' : '已分析任务要求', detail: sanitizeProcessText(input.prompt, 120), startedAt: input.startedAt, endedAt: onlyPreparing ? undefined : input.startedAt, mergeKey: 'understand' })]

  if (input.steps.length) {
    const completed = input.steps.filter((step) => step.status === 'completed').length
    const failed = input.steps.filter((step) => step.status === 'failed').length
    const running = input.steps.some((step) => step.status === 'running' || step.status === 'pending')
    drafts.push(baseStep({
      id: `${input.turnId}-plan`, kind: 'plan', state: failed ? 'failed' : running ? 'running' : 'succeeded',
      title: `制定了 ${input.steps.length} 个执行步骤`,
      detail: failed ? `${failed} 个步骤未完成` : `${completed}/${input.steps.length} 个步骤已完成`,
      startedAt: typeof input.steps[0]?.createdAt === 'string' ? input.steps[0].createdAt : input.startedAt,
      endedAt: typeof input.steps.at(-1)?.updatedAt === 'string' ? input.steps.at(-1)?.updatedAt as string : undefined,
      mergeKey: 'plan',
    }))
  }

  const toolSteps = makeToolSteps(input.tools, input.traceSpans, input.steps.length > 0)
  const recoveredFailures = toolSteps.filter((step, index) => step.state === 'failed' && toolSteps.slice(index + 1).some((later) => later.state === 'succeeded'))
  for (const failed of recoveredFailures) failed.state = 'warning'
  drafts.push(...toolSteps)

  const representedSpanIds = new Set(drafts.flatMap((step) => step.traceSpanIds))
  for (const span of operationalSpans) {
    if (representedSpanIds.has(span.id) || span.kind === 'checkpoint') continue
    if (span.kind === 'managed_process') drafts.push(baseStep({ id: `span-${span.id}`, kind: 'command', state: span.status === 'running' ? 'running' : span.status === 'succeeded' ? 'succeeded' : span.status === 'waiting' ? 'waiting' : 'failed', title: '运行了后台任务', detail: sanitizeProcessText(span.name, 100), startedAt: span.startedAt, endedAt: span.endedAt, durationMs: span.durationMs, traceSpanIds: [span.id], mergeKey: 'command:managed' }))
  }

  if (recoveredFailures.length) drafts.push(baseStep({
    id: `${input.turnId}-recovery`, kind: 'recovery', state: 'warning', title: '一次操作未完成，已切换到其他方案',
    detail: `${recoveredFailures.length} 项失败已被后续执行恢复`,
    startedAt: recoveredFailures[0]?.startedAt,
    endedAt: [...toolSteps].reverse().find((step) => step.state === 'succeeded')?.endedAt,
    toolCallIds: recoveredFailures.flatMap((step) => step.toolCallIds),
    mergeKey: 'recovery',
  }))

  if (input.isLatest && input.approvals.length) {
    const approval = input.approvals[0]!
    drafts.push(baseStep({ id: `approval-${approval.id}`, kind: 'approval', state: approval.status === 'rejected' ? 'failed' : approval.status === 'approved' ? 'succeeded' : 'waiting', title: approval.status === 'approved' ? `已确认：${approval.title}` : approval.status === 'rejected' ? `已拒绝：${approval.title}` : `等待你确认：${approval.title}`, detail: approval.summary, startedAt: typeof approval.createdAt === 'string' ? approval.createdAt : undefined, toolCallIds: typeof approval.toolCallId === 'string' ? [approval.toolCallId] : [], mergeKey: `approval:${approval.id}` }))
  }

  if (input.isLatest && visibleArtifacts.length && !drafts.some((step) => step.kind === 'output')) {
    const names = visibleArtifacts.map((artifact) => sanitizeProcessText(artifact.name, 80)).filter(Boolean)
    drafts.push(baseStep({ id: `${input.turnId}-outputs`, kind: 'output', state: 'succeeded', title: names.length === 1 ? `生成了《${names[0]}》` : `生成了 ${names.length} 个产物`, artifactIds: visibleArtifacts.map((artifact) => artifact.id), mergeKey: 'outputs' }))
  }

  if (input.isLatest && input.verification) {
    const passed = input.verification.checks.filter((check) => check.status === 'passed').length
    const failed = input.verification.checks.filter((check) => check.status === 'failed').length
    const pending = input.verification.checks.length - passed - failed
    drafts.push(baseStep({ id: `${input.turnId}-verify`, kind: 'verify', state: failed ? 'failed' : pending || input.verification.status === 'partial' ? 'warning' : 'succeeded', title: failed ? `${failed} 项检查未通过` : passed ? `${passed} 项检查通过` : '检查了任务结果', detail: input.verification.summary, mergeKey: 'verify' }))
  }

  if (input.runStatus === 'completed') {
    for (const step of drafts) {
      if (step.state === 'running' || step.state === 'pending') {
        step.state = input.verification?.status === 'partial' ? 'warning' : 'succeeded'
      }
    }
  }

  const sorted = drafts.sort((left, right) => (timestamp(left.startedAt) ?? Number.MAX_SAFE_INTEGER) - (timestamp(right.startedAt) ?? Number.MAX_SAFE_INTEGER))
  if (input.isLatest && input.runStatus === 'completed') sorted.push(baseStep({ id: `${input.turnId}-complete`, kind: 'complete', state: input.verification?.status === 'partial' ? 'warning' : 'succeeded', title: '已整理并交付结果', endedAt: input.endedAt, mergeKey: 'complete' }))
  const steps = mergeConsecutive(sorted)
  const state = processState(steps)
  const duration = totalDuration(steps)
  return { turnId: input.turnId, state, headline: processHeadline(steps, state), steps, ...(duration !== undefined ? { totalDurationMs: duration } : {}) }
}

export type { BuildProcessTimelineInput }
