import type {
  ApprovalItem,
  EventItem,
  PlanStepItem,
  RunDetailView,
  RunStatus,
  ToolActivityItem,
  TraceSpanItem,
} from './types'
import { buildProcessTimeline } from './process-view'
import type {
  ActivityGroup,
  ActivityKind,
  ActivityState,
  AssistantResponseView,
  AttentionState,
  ResultEvidence,
  UserPromptView,
  WorkTurnViewModel,
} from './work-turn.types'

interface OrderedMessage {
  event: EventItem
  index: number
  at?: number
}

interface TurnDraft {
  id: string
  prompt: UserPromptView
  assistantEvents: EventItem[]
  tools: ToolActivityItem[]
  steps: PlanStepItem[]
  traceSpans: TraceSpanItem[]
  approvals: ApprovalItem[]
  startedAt?: string
  boundaryAt?: number
}

const TOOL_KIND_PATTERNS: Array<[ActivityKind, RegExp]> = [
  ['mcp', /^(?:mcp(?:[._:/-]|$))|(?:[^/]+\/[^/]+$)/i],
  ['plan', /^(?:task_(?:plan|step_update|complete)|plan(?:[._-]|$)|agent_delegate)/i],
  ['files', /^(?:file(?:[._-]|$)|attachment(?:[._-]|$)|output(?:[._-]|$)|read_file|write_file|edit_file|apply_patch|glob$|grep$|rg$)/i],
  ['shell', /^(?:shell(?:[._-]|$)|terminal(?:[._-]|$)|exec(?:[._-]|$)|bash$|command(?:[._-]|$))/i],
  ['web', /^(?:web(?:[._-]|$)|chrome(?:[._-]|$)|browser(?:[._-]|$)|fetch_url$)/i],
]

const ACTIVITY_NOUNS: Record<ActivityKind, string> = {
  files: '项文件操作',
  shell: '条命令',
  web: '项网页操作',
  mcp: '项连接操作',
  plan: '个计划步骤',
  other: '项操作',
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
}

function eventContent(event: EventItem): string {
  return text(event.content) ?? text(event.message) ?? text(event.text) ?? ''
}

function messageOrder(events: EventItem[]): OrderedMessage[] {
  return events
    .map((event, index): OrderedMessage => {
      const at = timestamp(event.createdAt)
      return { event, index, ...(at !== undefined ? { at } : {}) }
    })
    .filter(({ event }) => (event.actor === 'user' || event.actor === 'agent') && Boolean(eventContent(event)))
    .sort((left, right) => {
      if (left.at !== undefined && right.at !== undefined && left.at !== right.at) return left.at - right.at
      if (left.at !== undefined && right.at === undefined) return -1
      if (left.at === undefined && right.at !== undefined) return 1
      return left.index - right.index
    })
}

function makePrompt(event: EventItem): UserPromptView {
  const artifactIds = stringArray(event.artifactIds)
  return {
    id: event.id,
    content: eventContent(event),
    messageIds: [event.id],
    artifactIds,
    ...(event.createdAt ? { createdAt: event.createdAt } : {}),
  }
}

function syntheticPrompt(detail: RunDetailView): UserPromptView {
  return {
    id: `${detail.id}-prompt`,
    content: detail.prompt ?? detail.goal ?? detail.title,
    messageIds: [],
    artifactIds: [],
    ...(detail.createdAt ? { createdAt: detail.createdAt } : {}),
  }
}

function coalesceAssistantContent(events: EventItem[]): string {
  const chunks: string[] = []
  for (const event of events) {
    const content = eventContent(event)
    if (!content) continue
    const previous = chunks.at(-1)
    if (previous === content || previous?.startsWith(content)) continue
    if (previous && content.startsWith(previous)) {
      chunks[chunks.length - 1] = content
      continue
    }
    chunks.push(content)
  }
  return chunks.join('\n\n')
}

function makeResponse(
  turnId: string,
  events: EventItem[],
  tools: ToolActivityItem[],
  runStatus: RunStatus,
): AssistantResponseView {
  const dated = events.filter((event) => event.createdAt)
  const createdAt = dated[0]?.createdAt
  const updatedAt = dated.at(-1)?.createdAt
  const terminal = !['understanding', 'planning', 'running', 'verifying'].includes(runStatus)
  const lastToolAt = Math.max(
    ...tools
      .map((tool) => timestamp(tool.updatedAt ?? tool.createdAt))
      .filter((value): value is number => value !== undefined),
    Number.NEGATIVE_INFINITY,
  )
  const afterTools = Number.isFinite(lastToolAt)
    ? events.filter((event) => {
      const at = timestamp(event.createdAt)
      return at !== undefined && at >= lastToolAt
    })
    : events
  const selected = tools.length
    ? (terminal ? afterTools.at(-1) ?? events.at(-1) : undefined)
    : undefined
  return {
    id: `${turnId}-response`,
    content: selected ? eventContent(selected) : tools.length ? '' : coalesceAssistantContent(events),
    messageIds: events.map((event) => event.id),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

function toolKind(tool: ToolActivityItem): ActivityKind {
  const source = text(tool.source)
  if (source?.toLocaleLowerCase() === 'mcp') return 'mcp'
  const name = tool.toolName.trim()
  return TOOL_KIND_PATTERNS.find(([, pattern]) => pattern.test(name))?.[0] ?? 'other'
}

export function classifyToolActivity(tool: ToolActivityItem): ActivityKind {
  return toolKind(tool)
}

export function isSourceWarning(tool: ToolActivityItem): boolean {
  return (tool.status === 'failed' || tool.status === 'cancelled') && /^(?:web_search|web_fetch)$/.test(tool.toolName)
}

function toolState(tool: ToolActivityItem): ActivityState {
  if (isSourceWarning(tool)) return 'warning'
  if (tool.status === 'failed' || tool.status === 'cancelled') return 'failed'
  if (tool.status === 'succeeded') return 'completed'
  return 'running'
}

function stepState(status: PlanStepItem['status']): ActivityState {
  if (status === 'failed') return 'failed'
  if (status === 'completed') return 'completed'
  return 'running'
}

function aggregateState(states: ActivityState[]): ActivityState {
  if (states.includes('failed')) return 'failed'
  if (states.includes('running')) return 'running'
  if (states.includes('warning')) return 'warning'
  return 'completed'
}

function activitySummary(kind: ActivityKind, state: ActivityState, count: number): string {
  const quantity = `${count} ${ACTIVITY_NOUNS[kind]}`
  if (state === 'running') return `正在处理 ${quantity}`
  if (state === 'failed') return `${quantity}未完成`
  if (state === 'warning') return `已处理 ${quantity}，部分来源不可用`
  return `已完成 ${quantity}`
}

function activityTime(item: ToolActivityItem | PlanStepItem): string | undefined {
  return 'toolName' in item
    ? text(item.createdAt) ?? text(item.updatedAt)
    : text(item.updatedAt) ?? text(item.createdAt)
}

function buildActivityGroups(tools: ToolActivityItem[], steps: PlanStepItem[]): ActivityGroup[] {
  const ordered = [
    ...tools.map((tool, index) => ({
      kind: toolKind(tool),
      id: tool.id,
      state: toolState(tool),
      tool,
      index,
      at: timestamp(activityTime(tool)),
    })),
    ...steps.map((step, index) => ({
      kind: 'plan' as const,
      id: step.id,
      state: stepState(step.status),
      step,
      index: tools.length + index,
      at: timestamp(activityTime(step)),
    })),
  ].sort((left, right) => {
    if (left.at !== undefined && right.at !== undefined && left.at !== right.at) return left.at - right.at
    if (left.at !== undefined && right.at === undefined) return -1
    if (left.at === undefined && right.at !== undefined) return 1
    return left.index - right.index
  })

  const grouped = new Map<ActivityKind, typeof ordered>()
  for (const item of ordered) {
    const group = grouped.get(item.kind)
    if (group) group.push(item)
    else grouped.set(item.kind, [item])
  }

  return [...grouped.entries()].map(([kind, items]) => {
    const state = aggregateState(items.map((item) => item.state))
    const times = items.map((item) => activityTime('tool' in item ? item.tool : item.step)).filter((value): value is string => Boolean(value))
    const startedAt = times[0]
    const updatedAt = times.at(-1)
    return {
      kind,
      state,
      summary: activitySummary(kind, state, items.length),
      count: items.length,
      eventIds: items.map((item) => item.id),
      toolCalls: items.flatMap((item) => 'tool' in item ? [item.tool] : []),
      steps: items.flatMap((item) => 'step' in item ? [item.step] : []),
      ...(startedAt ? { startedAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    }
  })
}

function settleActivityGroups(groups: ActivityGroup[], detail: RunDetailView): ActivityGroup[] {
  if (detail.status !== 'completed') return groups
  return groups.map((group) => {
    if (group.state !== 'running') return group
    const state: ActivityState = detail.result === 'partial' ? 'failed' : 'completed'
    return { ...group, state, summary: activitySummary(group.kind, state, group.count) }
  })
}

export function attentionForRun(status: RunStatus, hasPendingApproval = false): AttentionState | undefined {
  if (hasPendingApproval || status === 'waiting_approval') return 'approval'
  if (status === 'waiting_user') return 'input'
  if (status === 'paused') return 'paused'
  if (status === 'failed') return 'failed'
  if (status === 'understanding' || status === 'planning' || status === 'running' || status === 'verifying') return 'working'
  return undefined
}

function targetTurnIndex(turns: TurnDraft[], value: ToolActivityItem | PlanStepItem): number {
  if (turns.length <= 1) return 0
  const at = timestamp(activityTime(value))
  if (at === undefined) return turns.length - 1
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const boundary = turns[index]?.boundaryAt
    if (boundary === undefined || at >= boundary) return index
  }
  return 0
}

function targetTimestampIndex(turns: TurnDraft[], value: unknown): number {
  if (turns.length <= 1) return 0
  const at = timestamp(value)
  if (at === undefined) return turns.length - 1
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const boundary = turns[index]?.boundaryAt
    if (boundary === undefined || at >= boundary) return index
  }
  return 0
}

function buildResult(detail: RunDetailView): ResultEvidence | undefined {
  const result: ResultEvidence = {
    ...(detail.verification?.status ? { status: detail.verification.status } : {}),
    ...(detail.verification?.summary ? { summary: detail.verification.summary } : {}),
    ...(detail.diffs.length ? { changes: [...detail.diffs] } : {}),
    ...(detail.verification?.checks.length ? { checks: [...detail.verification.checks] } : {}),
    ...(detail.artifacts.length ? { outputs: [...detail.artifacts] } : {}),
    ...(detail.sources.length ? { sources: [...detail.sources] } : {}),
  }
  return Object.keys(result).length ? result : undefined
}

export function buildWorkTurns(detail: RunDetailView): WorkTurnViewModel[] {
  const messages = messageOrder(detail.events)
  const drafts: TurnDraft[] = []

  for (const message of messages) {
    if (message.event.actor === 'user') {
      drafts.push({
        id: `${detail.id}-turn-${message.event.id}`,
        prompt: makePrompt(message.event),
        assistantEvents: [],
        tools: [],
        steps: [],
        traceSpans: [],
        approvals: [],
        ...(message.event.createdAt ? { startedAt: message.event.createdAt } : {}),
        ...(message.at !== undefined ? { boundaryAt: message.at } : {}),
      })
      continue
    }
    drafts.at(-1)?.assistantEvents.push(message.event)
  }

  if (!drafts.length) {
    const boundaryAt = timestamp(detail.createdAt)
    drafts.push({
      id: `${detail.id}-turn-0`,
      prompt: syntheticPrompt(detail),
      assistantEvents: messages.filter(({ event }) => event.actor === 'agent').map(({ event }) => event),
      tools: [],
      steps: [],
      traceSpans: [],
      approvals: [],
      ...(detail.createdAt ? { startedAt: detail.createdAt } : {}),
      ...(boundaryAt !== undefined ? { boundaryAt } : {}),
    })
  }

  for (const tool of detail.toolCalls) drafts[targetTurnIndex(drafts, tool)]?.tools.push(tool)
  for (const step of detail.steps) drafts[targetTurnIndex(drafts, step)]?.steps.push(step)
  for (const span of detail.traceSpans) drafts[targetTimestampIndex(drafts, span.startedAt)]?.traceSpans.push(span)
  for (const approval of detail.approvals) {
    const createdAt = typeof approval.createdAt === 'string' ? approval.createdAt : undefined
    drafts[targetTimestampIndex(drafts, createdAt)]?.approvals.push(approval)
  }

  const lastIndex = drafts.length - 1
  const result = buildResult(detail)
  const attention = attentionForRun(
    detail.status,
    detail.approvals.some((approval) => approval.status === undefined || approval.status === 'pending'),
  )

  return drafts.map((draft, index): WorkTurnViewModel => {
    const isLatest = index === lastIndex
    const response = makeResponse(draft.id, draft.assistantEvents, draft.tools, isLatest ? detail.status : 'completed')
    const updatedAt = response.updatedAt
      ?? draft.tools.map((tool) => tool.updatedAt ?? tool.createdAt).filter((value): value is string => Boolean(value)).at(-1)
      ?? draft.startedAt
    return {
      id: draft.id,
      prompt: draft.prompt,
      response,
      activity: settleActivityGroups(buildActivityGroups(draft.tools, draft.steps), detail),
      ...(() => {
        const process = buildProcessTimeline({
          turnId: draft.id,
          prompt: draft.prompt.content,
          tools: draft.tools,
          steps: draft.steps,
          traceSpans: draft.traceSpans,
          approvals: draft.approvals,
          artifacts: isLatest ? detail.artifacts : [],
          verification: isLatest ? detail.verification : undefined,
          runStatus: isLatest ? detail.status : 'completed',
          isLatest,
          startedAt: draft.startedAt,
          endedAt: isLatest ? detail.updatedAt : updatedAt,
        })
        return process ? { process } : {}
      })(),
      ...(isLatest && result ? { result } : {}),
      ...(isLatest && attention ? { attention } : {}),
      ...(draft.startedAt ? { startedAt: draft.startedAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    }
  })
}

export type {
  ActivityGroup,
  ActivityKind,
  ActivityState,
  AssistantResponseView,
  AttentionState,
  ResultEvidence,
  UserPromptView,
  WorkTurnViewModel,
} from './work-turn.types'
