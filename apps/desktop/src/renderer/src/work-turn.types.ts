import type {
  ArtifactItem,
  DiffItem,
  PlanStepItem,
  SourceItem,
  ToolActivityItem,
  VerificationCheckItem,
  VerificationView,
} from './types'

export type AttentionState = 'working' | 'approval' | 'input' | 'paused' | 'failed'

export type ActivityKind = 'files' | 'shell' | 'web' | 'mcp' | 'plan' | 'other'

export type ActivityState = 'running' | 'completed' | 'warning' | 'failed'

export type ProcessStepKind =
  | 'understand'
  | 'plan'
  | 'search'
  | 'read_web'
  | 'browser'
  | 'file'
  | 'command'
  | 'connector'
  | 'write'
  | 'output'
  | 'verify'
  | 'approval'
  | 'recovery'
  | 'complete'

export type ProcessStepState = 'pending' | 'running' | 'succeeded' | 'warning' | 'failed' | 'waiting'

export interface ProcessStepViewModel {
  id: string
  kind: ProcessStepKind
  state: ProcessStepState
  title: string
  detail?: string
  count: number
  startedAt?: string
  endedAt?: string
  durationMs?: number
  sourceUrls: string[]
  artifactIds: string[]
  toolCallIds: string[]
  traceSpanIds: string[]
}

export interface ProcessTimelineViewModel {
  turnId: string
  state: ProcessStepState
  headline: string
  steps: ProcessStepViewModel[]
  totalDurationMs?: number
}

export interface UserPromptView {
  id: string
  content: string
  messageIds: string[]
  artifactIds: string[]
  createdAt?: string
}

export interface AssistantResponseView {
  id: string
  content: string
  messageIds: string[]
  createdAt?: string
  updatedAt?: string
}

export interface ActivityGroup {
  kind: ActivityKind
  state: ActivityState
  summary: string
  count: number
  eventIds: string[]
  toolCalls: ToolActivityItem[]
  steps: PlanStepItem[]
  startedAt?: string
  updatedAt?: string
}

export type ChangeSummary = DiffItem
export type CheckSummary = VerificationCheckItem
export type ArtifactSummary = ArtifactItem
export type SourceSummary = SourceItem

export interface ResultEvidence {
  status?: VerificationView['status']
  summary?: string
  changes?: ChangeSummary[]
  checks?: CheckSummary[]
  outputs?: ArtifactSummary[]
  sources?: SourceSummary[]
}

export interface WorkTurnViewModel {
  id: string
  prompt: UserPromptView
  response: AssistantResponseView
  activity: ActivityGroup[]
  process?: ProcessTimelineViewModel
  result?: ResultEvidence
  attention?: AttentionState
  startedAt?: string
  updatedAt?: string
}
