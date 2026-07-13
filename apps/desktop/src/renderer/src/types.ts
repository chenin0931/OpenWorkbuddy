export type ViewKey =
  | 'tasks'
  | 'memory'
  | 'mcp'
  | 'skills'
  | 'automations'
  | 'settings'
  | 'audit'

export type RunStatus =
  | 'understanding'
  | 'planning'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'waiting_approval'
  | 'waiting_user'
  | 'paused'
  | 'failed'
  | 'cancelled'

export type JsonRecord = Record<string, unknown>

export type RunAccessMode = 'approval' | 'full_disk'

export interface WorkspaceItem extends JsonRecord {
  id: string
  name: string
  path: string
  selected?: boolean
}

export interface RunItem extends JsonRecord {
  id: string
  title: string
  prompt?: string
  goal?: string
  status: RunStatus
  result?: 'verified' | 'partial'
  workspaceId?: string
  modelProfileId?: string
  accessMode?: RunAccessMode
  createdAt?: string
  updatedAt?: string
}

export interface PlanStepItem extends JsonRecord {
  id: string
  title: string
  detail?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
}

export interface EventItem extends JsonRecord {
  id: string
  type: string
  title: string
  content?: string
  createdAt?: string
  level?: 'info' | 'success' | 'warning' | 'error'
  actor?: 'user' | 'agent' | 'tool' | 'system'
}

export interface ToolActivityItem extends JsonRecord {
  id: string
  toolName: string
  title?: string
  status: 'requested' | 'waiting_approval' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  arguments?: JsonRecord
  argumentsSummary?: unknown
  summary?: string
  error?: string
  sources: SourceItem[]
  createdAt?: string
  updatedAt?: string
}

export interface SourceItem extends JsonRecord {
  id: string
  url: string
  title?: string
  publisher?: string
  status?: 'found' | 'fetched' | 'verified' | 'failed'
  createdAt?: string
}

export interface VerificationCheckItem extends JsonRecord {
  name: string
  status: 'passed' | 'failed' | 'not_run'
  detail?: string
}

export interface VerificationView extends JsonRecord {
  status: 'verified' | 'partial'
  summary?: string
  checks: VerificationCheckItem[]
}

export interface ApprovalItem extends JsonRecord {
  id: string
  title: string
  summary: string
  risk: 'reversible_write' | 'external_effect' | 'irreversible'
  arguments?: JsonRecord
  dataShared?: string
  reversible?: boolean
  status?: 'pending' | 'approved' | 'rejected'
}

export interface ApprovalHistoryItem extends JsonRecord {
  id: string
  title: string
  summary: string
  status: 'pending' | 'approved' | 'rejected' | 'edited'
  scope?: 'once' | 'run_tool'
  createdAt?: string
  resolvedAt?: string
}

export interface ArtifactItem extends JsonRecord {
  id: string
  name: string
  kind?: string
  path?: string
  size?: number
}

export interface DiffItem extends JsonRecord {
  id: string
  path: string
  additions?: number
  deletions?: number
}

export interface RunDetailView extends RunItem {
  steps: PlanStepItem[]
  events: EventItem[]
  toolCalls: ToolActivityItem[]
  sources: SourceItem[]
  approvals: ApprovalItem[]
  approvalHistory: ApprovalHistoryItem[]
  artifacts: ArtifactItem[]
  diffs: DiffItem[]
  context: JsonRecord[]
  verification?: VerificationView
}

export type ModelProvider = 'openai' | 'anthropic' | 'moonshotai-cn'

export interface ModelProfileItem extends JsonRecord {
  id: string
  name: string
  provider: ModelProvider
  modelId: string
  isDefault?: boolean
  isSubagentDefault?: boolean
  hasSecret?: boolean
  status?: 'ready' | 'untested' | 'error'
}

export interface MemoryItem extends JsonRecord {
  id: string
  content: string
  status: 'proposed' | 'confirmed' | 'disabled'
  scope: 'user' | 'workspace' | 'thread'
  kind?: string
  confidence?: number
  source?: string
  createdAt?: string
}

export interface McpServerItem extends JsonRecord {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  url?: string
  status?: 'connected' | 'stopped' | 'error' | 'testing'
  toolCount?: number
  auth?: 'none' | 'bearer' | 'headers' | 'oauth'
  secretConfigured?: boolean
}

export interface SkillItem extends JsonRecord {
  id: string
  name: string
  description: string
  enabled: boolean
  source?: string
  version?: string
  permissions?: string[]
}

export interface AutomationItem extends JsonRecord {
  id: string
  name: string
  prompt: string
  schedule: string
  enabled: boolean
  nextRunAt?: string
  lastRunAt?: string
  timezone?: string
  status?: string
}

export interface ChromeStatusView extends JsonRecord {
  connected: boolean
  extensionInstalled?: boolean
  nativeHostInstalled?: boolean
  extensionId?: string
  grants: Array<{
    id: string
    runId?: string
    tabId?: number
    title?: string
    url?: string
  }>
}

export type PermissionMode = 'cautious' | 'balanced' | 'autonomous'

export interface SettingsView extends JsonRecord {
  onboardingCompleted?: boolean
  theme?: 'system' | 'light' | 'dark'
  language?: string
  memoryEnabled?: boolean
  defaultExecutionMode?: 'plan' | 'execute'
  defaultAccessMode?: RunAccessMode
  permissionMode?: PermissionMode
  maxIterations?: number
  maxRunMinutes?: number
  maxSubagents?: number
  maxReadTools?: number
  userPreferences?: string
}

export interface PersistentGrantItem extends JsonRecord {
  id: string
  workspaceId: string
  toolName: 'file.write' | 'file.edit'
  path: string
  createdAt?: string
  expiresAt?: string
}

export interface CapabilityPackageItem extends JsonRecord {
  id: string
  name: string
  version: string
  workspaceId?: string
  skillIds: string[]
  mcpServerIds: string[]
  ruleSources: string[]
  templatePaths: string[]
  installedAt?: string
}

export interface WorkbenchSnapshot {
  workspaces: WorkspaceItem[]
  runs: RunItem[]
  models: ModelProfileItem[]
  memory: MemoryItem[]
  mcpServers: McpServerItem[]
  skills: SkillItem[]
  automations: AutomationItem[]
  chrome: ChromeStatusView
  settings: SettingsView
  persistentGrants: PersistentGrantItem[]
  capabilityPackages: CapabilityPackageItem[]
  appInfo: JsonRecord
}

export interface ToastMessage {
  id: number
  kind: 'success' | 'error' | 'info'
  title: string
  detail?: string
}
