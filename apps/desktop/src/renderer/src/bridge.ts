import type {
  ApprovalHistoryItem,
  ApprovalItem,
  ArtifactItem,
  AutomationItem,
  CapabilityPackageItem,
  ChromeStatusView,
  DiffItem,
  EventItem,
  JsonRecord,
  McpServerItem,
  MemoryItem,
  ModelProvider,
  ModelProfileItem,
  PlanStepItem,
  PersistentGrantItem,
  RunDetailView,
  RunItem,
  RunStatus,
  SourceItem,
  SettingsView,
  SkillItem,
  ToolActivityItem,
  VerificationView,
  WorkbenchSnapshot,
  WorkspaceItem,
} from './types'

type UnknownFn = (...args: unknown[]) => unknown

interface LocatedMethod {
  fn: UnknownFn
  owner: JsonRecord
  path: string
}

const EMPTY_CHROME: ChromeStatusView = { connected: false, grants: [] }

function rootBridge(): JsonRecord {
  const value = (window as Window & { workbuddy?: unknown }).workbuddy
  if (!value || typeof value !== 'object') {
    throw new Error('桌面安全组件尚未就绪，请重启应用后再试。')
  }
  return value as unknown as JsonRecord
}

function locate(path: string): LocatedMethod | undefined {
  const parts = path.split('.')
  let owner = rootBridge()
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = owner[parts[index] ?? '']
    if (!next || typeof next !== 'object') return undefined
    owner = next as JsonRecord
  }
  const key = parts.at(-1) ?? ''
  const fn = owner[key]
  return typeof fn === 'function' ? { fn: fn as UnknownFn, owner, path } : undefined
}

async function call<T>(variants: Array<{ path: string; args?: unknown[] }>): Promise<T> {
  for (const variant of variants) {
    const method = locate(variant.path)
    if (!method) continue
    return await Promise.resolve(method.fn.apply(method.owner, variant.args ?? [])) as T
  }
  const names = variants.map((variant) => variant.path).join(' / ')
  throw new Error(`当前桌面桥不支持此操作（${names}）。请升级或重启应用。`)
}

async function optionalCall<T>(variants: Array<{ path: string; args?: unknown[] }>): Promise<T | undefined> {
  for (const variant of variants) {
    const method = locate(variant.path)
    if (!method) continue
    return await Promise.resolve(method.fn.apply(method.owner, variant.args ?? [])) as T
  }
  return undefined
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function textValue(source: JsonRecord, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return fallback
}

function booleanValue(source: JsonRecord, keys: string[], fallback = false): boolean {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'boolean') return value
  }
  return fallback
}

function numberValue(source: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function arrayValue(value: unknown, keys: string[] = ['items']): unknown[] {
  if (Array.isArray(value)) return value
  const source = record(value)
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key] as unknown[]
  }
  return []
}

function idValue(source: JsonRecord, fallbackPrefix: string, index: number): string {
  return textValue(source, ['id', 'runId', 'workspaceId', 'profileId', 'memoryId'], `${fallbackPrefix}-${index}`)
}

function normalizeWorkspace(value: unknown, index: number): WorkspaceItem {
  const source = record(value)
  const path = textValue(source, ['path', 'rootPath', 'directory'])
  return {
    ...source,
    id: idValue(source, 'workspace', index),
    name: textValue(source, ['name', 'title'], path.split('/').filter(Boolean).at(-1) ?? '未命名工作区'),
    path,
    selected: booleanValue(source, ['selected', 'isSelected']),
  }
}

const statuses = new Set<RunStatus>([
  'understanding', 'planning', 'running', 'verifying', 'completed', 'waiting_approval',
  'waiting_user', 'paused', 'failed', 'cancelled',
])

function normalizeRun(value: unknown, index: number): RunItem {
  const source = record(value)
  const rawStatus = textValue(source, ['status', 'state'], 'understanding') as RunStatus
  const status = statuses.has(rawStatus) ? rawStatus : 'understanding'
  const item: RunItem = {
    ...source,
    id: idValue(source, 'run', index),
    title: textValue(source, ['title', 'name', 'goal', 'prompt'], '新工作'),
    status,
  }
  const prompt = textValue(source, ['prompt', 'request'])
  const goal = textValue(source, ['goal', 'objective'])
  const workspaceId = textValue(source, ['workspaceId', 'workspace_id'])
  const modelProfileId = textValue(source, ['modelProfileId', 'model_profile_id']) || textValue(record(source.model), ['profileId'])
  const createdAt = textValue(source, ['createdAt', 'created_at'])
  const updatedAt = textValue(source, ['updatedAt', 'updated_at'])
  const result = textValue(source, ['result', 'outcome', 'completionStatus'])
  if (prompt) item.prompt = prompt
  if (goal) item.goal = goal
  if (workspaceId) item.workspaceId = workspaceId
  if (modelProfileId) item.modelProfileId = modelProfileId
  if (createdAt) item.createdAt = createdAt
  if (updatedAt) item.updatedAt = updatedAt
  if (result === 'verified' || result === 'partial') item.result = result
  return item
}

function normalizeModel(value: unknown, index: number): ModelProfileItem {
  const source = record(value)
  const rawProvider = textValue(source, ['provider'], 'openai')
  const provider: ModelProvider = rawProvider === 'anthropic'
    ? 'anthropic'
    : rawProvider === 'moonshotai-cn'
      ? 'moonshotai-cn'
      : 'openai'
  const providerName = provider === 'openai' ? 'OpenAI' : provider === 'anthropic' ? 'Anthropic' : 'Kimi / Moonshot'
  return {
    ...source,
    id: idValue(source, 'model', index),
    name: textValue(source, ['name', 'label'], providerName),
    provider,
    modelId: textValue(source, ['modelId', 'model', 'model_id']),
    isDefault: booleanValue(source, ['isDefault', 'default']),
    isSubagentDefault: booleanValue(source, ['isSubagentDefault', 'subagentDefault']),
    hasSecret: booleanValue(source, ['hasSecret', 'secretConfigured', 'keyConfigured']),
  }
}

function normalizeMemory(value: unknown, index: number): MemoryItem {
  const source = record(value)
  const rawStatus = textValue(source, ['status', 'state'], 'proposed')
  const rawScope = textValue(source, ['scope'], 'user')
  const status = rawStatus === 'confirmed' || rawStatus === 'disabled' ? rawStatus : 'proposed'
  const scope = rawScope === 'workspace' || rawScope === 'thread' ? rawScope : 'user'
  const item: MemoryItem = {
    ...source,
    id: idValue(source, 'memory', index),
    content: textValue(source, ['content', 'text', 'summary']),
    status,
    scope,
  }
  const confidence = numberValue(source, ['confidence'])
  const kind = textValue(source, ['kind', 'type'])
  const sources = arrayValue(source.sources)
  const firstSource = record(sources[0])
  const origin = textValue(source, ['source', 'sourceLabel']) || textValue(firstSource, ['reference'])
  const createdAt = textValue(source, ['createdAt', 'created_at'])
  if (confidence !== undefined) item.confidence = confidence
  if (kind) item.kind = kind
  if (origin) item.source = origin
  if (createdAt) item.createdAt = createdAt
  return item
}

function normalizeMcp(value: unknown, index: number): McpServerItem {
  const source = record(value)
  const transportSource = record(source.transport)
  const rawTransport = textValue(source, ['type']) || textValue(transportSource, ['type'], 'stdio')
  const item: McpServerItem = {
    ...source,
    id: idValue(source, 'mcp', index),
    name: textValue(source, ['name', 'label'], 'MCP Server'),
    transport: rawTransport === 'http' || rawTransport === 'streamable-http' || rawTransport === 'streamable_http' ? 'http' : 'stdio',
  }
  const command = textValue(source, ['command']) || textValue(transportSource, ['command'])
  const url = textValue(source, ['url', 'endpoint']) || textValue(transportSource, ['url'])
  const health = textValue(source, ['health'])
  const status = textValue(source, ['status']) || (health === 'healthy' ? 'connected' : health === 'unhealthy' ? 'error' : 'stopped')
  const toolCount = numberValue(source, ['toolCount', 'toolsCount'])
  const auth = textValue(transportSource, ['auth'])
  if (command) item.command = command
  if (url) item.url = url
  if (status === 'connected' || status === 'stopped' || status === 'error' || status === 'testing') item.status = status
  if (toolCount !== undefined) item.toolCount = toolCount
  if (auth === 'none' || auth === 'bearer' || auth === 'headers' || auth === 'oauth') item.auth = auth
  item.secretConfigured = booleanValue(transportSource, ['secretConfigured'])
  return item
}

function normalizeSkill(value: unknown, index: number): SkillItem {
  const source = record(value)
  const item: SkillItem = {
    ...source,
    id: idValue(source, 'skill', index),
    name: textValue(source, ['name', 'title'], '未命名 Skill'),
    description: textValue(source, ['description', 'summary'], '暂无描述'),
    enabled: booleanValue(source, ['enabled', 'isEnabled'], true),
  }
  const origin = textValue(source, ['source', 'path', 'directory'])
  const version = textValue(source, ['version'])
  if (origin) item.source = origin
  if (version) item.version = version
  if (Array.isArray(source.permissions)) {
    item.permissions = source.permissions.map((entry) => {
      if (typeof entry === 'string') return entry
      return textValue(record(entry), ['capability', 'detail'])
    }).filter(Boolean)
  }
  return item
}

function normalizeAutomation(value: unknown, index: number): AutomationItem {
  const source = record(value)
  const item: AutomationItem = {
    ...source,
    id: idValue(source, 'automation', index),
    name: textValue(source, ['name', 'title'], '未命名自动化'),
    prompt: textValue(source, ['prompt', 'instruction', 'objective']),
    schedule: textValue(source, ['normalizedSchedule', 'cron', 'expression']) || textValue(record(source.schedule), ['expression', 'runAt']),
    enabled: booleanValue(source, ['enabled', 'isEnabled'], true),
  }
  const nextRunAt = textValue(source, ['nextRunAt', 'next_run_at'])
  const lastRunAt = textValue(source, ['lastRunAt', 'last_run_at'])
  const timezone = textValue(source, ['timezone', 'timeZone'])
  const status = textValue(source, ['status'])
  if (nextRunAt) item.nextRunAt = nextRunAt
  if (lastRunAt) item.lastRunAt = lastRunAt
  if (timezone) item.timezone = timezone
  if (status) item.status = status
  return item
}

function normalizeChrome(value: unknown): ChromeStatusView {
  const source = record(value)
  const grants = arrayValue(source.grants).map((value, index) => {
    const grant = record(value)
    const item: ChromeStatusView['grants'][number] = { id: idValue(grant, 'grant', index) }
    const runId = textValue(grant, ['runId'])
    const title = textValue(grant, ['title'])
    const url = textValue(grant, ['url'])
    const tabId = numberValue(grant, ['tabId'])
    if (runId) item.runId = runId
    if (title) item.title = title
    if (url) item.url = url
    if (tabId !== undefined) item.tabId = tabId
    return item
  })
  const result: ChromeStatusView = {
    ...source,
    connected: booleanValue(source, ['connected', 'bridgeConnected', 'isConnected']),
    extensionInstalled: booleanValue(source, ['extensionInstalled', 'installed']),
    nativeHostInstalled: booleanValue(source, ['nativeHostInstalled']),
    grants,
  }
  const extensionId = textValue(source, ['extensionId'])
  if (extensionId) result.extensionId = extensionId
  return result
}

function normalizeSettings(value: unknown): SettingsView {
  const source = record(value)
  return source as SettingsView
}

function normalizePersistentGrant(value: unknown, index: number): PersistentGrantItem {
  const source = record(value)
  const approved = record(source.approvedArguments)
  const rawTool = textValue(source, ['toolName'], 'file.write')
  const item: PersistentGrantItem = {
    ...source,
    id: idValue(source, 'persistent-grant', index),
    toolName: rawTool === 'file.edit' ? 'file.edit' : 'file.write',
    workspaceId: textValue(approved, ['workspaceId']),
    path: textValue(approved, ['path']),
  }
  const createdAt = textValue(source, ['createdAt'])
  const expiresAt = textValue(source, ['expiresAt'])
  if (createdAt) item.createdAt = createdAt
  if (expiresAt) item.expiresAt = expiresAt
  return item
}

function normalizeCapabilityPackage(value: unknown, index: number): CapabilityPackageItem {
  const source = record(value)
  const item: CapabilityPackageItem = {
    ...source,
    id: idValue(source, 'capability-package', index),
    name: textValue(source, ['name'], '本地能力包'),
    version: textValue(source, ['version'], '1.0.0'),
    skillIds: arrayValue(source.skillIds).filter((entry): entry is string => typeof entry === 'string'),
    mcpServerIds: arrayValue(source.mcpServerIds).filter((entry): entry is string => typeof entry === 'string'),
    ruleSources: arrayValue(source.ruleSources).filter((entry): entry is string => typeof entry === 'string'),
    templatePaths: arrayValue(source.templatePaths).filter((entry): entry is string => typeof entry === 'string'),
  }
  const workspaceId = textValue(source, ['workspaceId'])
  const installedAt = textValue(source, ['installedAt'])
  if (workspaceId) item.workspaceId = workspaceId
  if (installedAt) item.installedAt = installedAt
  return item
}

function section(snapshot: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (snapshot[key] !== undefined) return snapshot[key]
  }
  return undefined
}

export async function loadWorkbench(): Promise<WorkbenchSnapshot> {
  const rawBootstrap = await call<unknown>([{ path: 'bootstrap' }])
  const bootstrap = record(rawBootstrap)
  const results = await Promise.allSettled([
    optionalCall<unknown>([{ path: 'workspaces.list' }]),
    optionalCall<unknown>([{ path: 'runs.list' }]),
    optionalCall<unknown>([{ path: 'models.list' }]),
    optionalCall<unknown>([{ path: 'memory.list' }, { path: 'listMemory' }]),
    optionalCall<unknown>([{ path: 'mcp.list' }, { path: 'listMcpServers' }]),
    optionalCall<unknown>([{ path: 'skills.list' }, { path: 'listSkills' }]),
    optionalCall<unknown>([{ path: 'automations.list' }, { path: 'listAutomations' }]),
    optionalCall<unknown>([{ path: 'chrome.getStatus' }, { path: 'getChromeStatus' }]),
    optionalCall<unknown>([{ path: 'settings.get' }]),
    optionalCall<unknown>([{ path: 'app.getInfo' }]),
    optionalCall<unknown>([{ path: 'chrome.listGrants' }]),
    optionalCall<unknown>([{ path: 'permissions.listPersistent' }]),
    optionalCall<unknown>([{ path: 'capabilityPackages.list' }]),
  ])
  const settledValue = (index: number): unknown => {
    const result = results[index]
    return result?.status === 'fulfilled' ? result.value : undefined
  }
  const workspaceSource = settledValue(0) ?? section(bootstrap, ['workspaces'])
  const runSource = settledValue(1) ?? section(bootstrap, ['runs', 'recentRuns'])
  const modelSource = settledValue(2) ?? section(bootstrap, ['models', 'modelProfiles'])
  const memorySource = settledValue(3) ?? section(bootstrap, ['memory', 'memories'])
  const mcpSource = settledValue(4) ?? section(bootstrap, ['mcpServers', 'mcp'])
  const skillSource = settledValue(5) ?? section(bootstrap, ['skills'])
  const automationSource = settledValue(6) ?? section(bootstrap, ['automations'])
  const chromeSource = settledValue(7) ?? section(bootstrap, ['chrome', 'chromeStatus'])
  const settingsSource = settledValue(8) ?? section(bootstrap, ['settings'])
  const appInfoSource = settledValue(9) ?? section(bootstrap, ['appInfo', 'app'])
  const grantsSource = settledValue(10)
  const persistentGrantsSource = settledValue(11)
  const capabilityPackagesSource = settledValue(12)
  const normalizedChrome = chromeSource === undefined ? { ...EMPTY_CHROME, grants: [] } : normalizeChrome(chromeSource)
  if (grantsSource !== undefined) normalizedChrome.grants = normalizeChrome({ connected: normalizedChrome.connected, grants: arrayValue(grantsSource) }).grants
  const settings = normalizeSettings(settingsSource)
  if (typeof bootstrap.onboardingComplete === 'boolean') settings.onboardingCompleted = bootstrap.onboardingComplete

  return {
    workspaces: arrayValue(workspaceSource, ['items', 'workspaces']).map(normalizeWorkspace),
    runs: arrayValue(runSource, ['items', 'runs']).map(normalizeRun),
    models: arrayValue(modelSource, ['items', 'profiles', 'models']).map(normalizeModel),
    memory: arrayValue(memorySource, ['items', 'memories']).map(normalizeMemory),
    mcpServers: arrayValue(mcpSource, ['items', 'servers']).map(normalizeMcp),
    skills: arrayValue(skillSource, ['items', 'skills']).map(normalizeSkill),
    automations: arrayValue(automationSource, ['items', 'automations']).map(normalizeAutomation),
    chrome: normalizedChrome,
    settings,
    persistentGrants: arrayValue(persistentGrantsSource, ['items', 'grants']).map(normalizePersistentGrant),
    capabilityPackages: arrayValue(capabilityPackagesSource, ['items', 'packages']).map(normalizeCapabilityPackage),
    appInfo: record(appInfoSource),
  }
}

function normalizeStep(value: unknown, index: number): PlanStepItem {
  const source = record(value)
  const status = textValue(source, ['status'], 'pending')
  const item: PlanStepItem = {
    ...source,
    id: idValue(source, 'step', index),
    title: textValue(source, ['title', 'name', 'description'], `步骤 ${index + 1}`),
    status: status === 'running' || status === 'in_progress' ? 'running' : status === 'completed' ? 'completed' : status === 'failed' || status === 'blocked' ? 'failed' : 'pending',
  }
  const detail = textValue(source, ['detail', 'description'])
  if (detail && detail !== item.title) item.detail = detail
  return item
}

function normalizeEvent(value: unknown, index: number): EventItem {
  const source = record(value)
  const type = textValue(source, ['type', 'eventType'], 'info')
  const item: EventItem = {
    ...source,
    id: idValue(source, 'event', index),
    type,
    title: textValue(source, ['title', 'label'], type),
  }
  const content = textValue(source, ['content', 'message', 'summary', 'text'])
  const createdAt = textValue(source, ['createdAt', 'created_at', 'timestamp'])
  const level = textValue(source, ['level'])
  const actor = textValue(source, ['actor', 'role'])
  if (content) item.content = content
  if (createdAt) item.createdAt = createdAt
  if (level === 'success' || level === 'warning' || level === 'error' || level === 'info') item.level = level
  if (actor === 'assistant') item.actor = 'agent'
  else if (actor === 'user' || actor === 'agent' || actor === 'tool' || actor === 'system') item.actor = actor
  return item
}

function normalizeToolActivity(value: unknown, index: number): ToolActivityItem {
  const source = record(value)
  const rawStatus = textValue(source, ['status', 'state'], 'requested')
  const status: ToolActivityItem['status'] = rawStatus === 'waiting_approval' || rawStatus === 'running' || rawStatus === 'succeeded' || rawStatus === 'failed' || rawStatus === 'cancelled'
    ? rawStatus
    : 'requested'
  const item: ToolActivityItem = {
    ...source,
    id: idValue(source, 'tool', index),
    toolName: textValue(source, ['toolName', 'toolId', 'name'], '工具调用'),
    status,
    sources: arrayValue(source.sources).map(normalizeSource).filter((item): item is SourceItem => Boolean(item)),
  }
  const title = textValue(source, ['title', 'label'])
  const argumentsSummary = source.argumentsSummary ?? source.arguments ?? source.args
  const argumentsValue = record(argumentsSummary)
  const summary = textValue(source, ['summary', 'content', 'resultSummary'])
  const error = typeof source.error === 'string' ? source.error : textValue(record(source.error), ['message'])
  const createdAt = textValue(source, ['createdAt', 'created_at', 'timestamp'])
  const updatedAt = textValue(source, ['updatedAt', 'updated_at', 'finishedAt'])
  if (title) item.title = title
  if (Object.keys(argumentsValue).length) item.arguments = argumentsValue
  if (argumentsSummary !== undefined) item.argumentsSummary = argumentsSummary
  if (summary) item.summary = summary
  if (error) item.error = error
  if (createdAt) item.createdAt = createdAt
  if (updatedAt) item.updatedAt = updatedAt
  return item
}

function normalizeSource(value: unknown, index: number): SourceItem | undefined {
  const source = typeof value === 'string' ? { url: value } : record(value)
  const url = textValue(source, ['url', 'href', 'sourceUrl'])
  if (!/^https?:\/\//i.test(url)) return undefined
  const rawStatus = textValue(source, ['status'], 'found')
  const status: SourceItem['status'] = rawStatus === 'fetched' || rawStatus === 'verified' || rawStatus === 'failed' ? rawStatus : 'found'
  const item: SourceItem = { ...source, id: idValue(source, 'source', index), url, status }
  const title = textValue(source, ['title', 'name'])
  const publisher = textValue(source, ['publisher', 'siteName', 'domain'])
  const createdAt = textValue(source, ['createdAt', 'created_at', 'fetchedAt'])
  if (title) item.title = title
  if (publisher) item.publisher = publisher
  if (createdAt) item.createdAt = createdAt
  return item
}

function normalizeVerification(value: unknown): VerificationView | undefined {
  const source = record(value)
  const rawStatus = textValue(source, ['status', 'result', 'outcome'])
  if (rawStatus !== 'verified' && rawStatus !== 'partial') return undefined
  const checks = arrayValue(source.checks).map((value) => {
    const check = record(value)
    const rawCheckStatus = textValue(check, ['status'], 'not_run')
    const status: VerificationView['checks'][number]['status'] = rawCheckStatus === 'passed' || rawCheckStatus === 'failed' ? rawCheckStatus : 'not_run'
    return {
      ...check,
      name: textValue(check, ['name', 'title'], '验证项'),
      status,
      ...(textValue(check, ['detail', 'summary']) ? { detail: textValue(check, ['detail', 'summary']) } : {}),
    }
  })
  const summary = textValue(source, ['summary', 'detail'])
  return { ...source, status: rawStatus, checks, ...(summary ? { summary } : {}) }
}

function normalizeApproval(value: unknown, index: number): ApprovalItem {
  const source = record(value)
  const rawRisk = textValue(source, ['risk', 'riskLevel'], 'reversible_write')
  const risk = rawRisk === 'external_effect' || rawRisk === 'external_side_effect'
    ? 'external_effect'
    : rawRisk === 'irreversible' || rawRisk === 'high_risk_irreversible'
      ? 'irreversible'
      : 'reversible_write'
  const item: ApprovalItem = {
    ...source,
    id: idValue(source, 'approval', index),
    title: textValue(source, ['title', 'toolName', 'action'], '需要批准的操作'),
    summary: textValue(source, ['summary', 'description', 'reason', 'target']),
    risk,
    reversible: booleanValue(source, ['reversible'], risk === 'reversible_write'),
  }
  const args = record(source.arguments ?? source.args)
  if (Object.keys(args).length) item.arguments = args
  const sendsData = arrayValue(source.sendsData).filter((entry): entry is string => typeof entry === 'string')
  const dataShared = textValue(source, ['dataShared', 'externalData']) || sendsData.join('、')
  const status = textValue(source, ['status'])
  if (dataShared) item.dataShared = dataShared
  if (status === 'pending' || status === 'approved' || status === 'rejected') item.status = status
  return item
}

function normalizeApprovalHistory(value: unknown, index: number): ApprovalHistoryItem {
  const source = record(value)
  const rawStatus = textValue(source, ['status'], 'pending')
  const status: ApprovalHistoryItem['status'] = rawStatus === 'approved' || rawStatus === 'rejected' || rawStatus === 'edited' ? rawStatus : 'pending'
  const item: ApprovalHistoryItem = {
    ...source,
    id: idValue(source, 'approval-history', index),
    title: textValue(source, ['title', 'toolName', 'action'], '操作审批'),
    summary: textValue(source, ['summary', 'reason', 'target']),
    status,
  }
  const scope = textValue(source, ['scope'])
  const createdAt = textValue(source, ['createdAt', 'created_at'])
  const resolvedAt = textValue(source, ['resolvedAt', 'resolved_at'])
  if (scope === 'once' || scope === 'run_tool') item.scope = scope
  if (createdAt) item.createdAt = createdAt
  if (resolvedAt) item.resolvedAt = resolvedAt
  return item
}

function normalizeArtifact(value: unknown, index: number): ArtifactItem {
  const source = record(value)
  const item: ArtifactItem = {
    ...source,
    id: idValue(source, 'artifact', index),
    name: textValue(source, ['name', 'filename', 'path', 'displayName'], '输出'),
  }
  const kind = textValue(source, ['kind', 'type'])
  const metadata = record(source.metadata)
  const path = textValue(source, ['path']) || textValue(metadata, ['path'])
  const size = numberValue(source, ['size', 'sizeBytes', 'byteLength'])
  if (kind) item.kind = kind
  if (path) item.path = path
  if (size !== undefined) item.size = size
  return item
}

function normalizeDiff(value: unknown, index: number): DiffItem {
  const source = record(value)
  const item: DiffItem = {
    ...source,
    id: idValue(source, 'diff', index),
    path: textValue(source, ['path', 'filePath'], '未知文件'),
  }
  const additions = numberValue(source, ['additions', 'added'])
  const deletions = numberValue(source, ['deletions', 'removed'])
  if (additions !== undefined) item.additions = additions
  if (deletions !== undefined) item.deletions = deletions
  return item
}

export async function getRunDetail(runId: string, fallback?: RunItem): Promise<RunDetailView> {
  const raw = await optionalCall<unknown>([
    { path: 'runs.get', args: [{ id: runId }] },
    { path: 'getRun', args: [runId] },
  ])
  const source = record(raw ?? fallback)
  const base = normalizeRun(source.run ?? source, 0)
  const artifacts = arrayValue(section(source, ['artifacts', 'outputs']), ['items', 'artifacts']).map(normalizeArtifact)
  const explicitDiffs = arrayValue(section(source, ['diffs', 'changes']), ['items', 'diffs']).map(normalizeDiff)
  const artifactDiffs = artifacts.filter((artifact) => artifact.kind === 'diff').map((artifact, index) => {
    const metadata = record(artifact.metadata)
    return normalizeDiff({ id: artifact.id, path: artifact.path ?? artifact.name, additions: metadata.additions, deletions: metadata.deletions }, index)
  })
  const directSources = arrayValue(section(source, ['sources', 'evidenceSources']), ['items', 'sources'])
    .map(normalizeSource)
    .filter((item): item is SourceItem => Boolean(item))
  const verification = normalizeVerification(source.verification)
  return {
    ...base,
    steps: arrayValue(section(source, ['steps', 'plan']), ['items', 'steps']).map(normalizeStep),
    events: arrayValue(section(source, ['events', 'timeline', 'messages']), ['items', 'events']).map(normalizeEvent),
    toolCalls: arrayValue(section(source, ['toolCalls', 'toolActivity']), ['items', 'toolCalls']).map(normalizeToolActivity),
    sources: directSources,
    approvals: arrayValue(section(source, ['approvals', 'pendingApprovals']), ['items', 'approvals']).map(normalizeApproval),
    approvalHistory: arrayValue(section(source, ['approvalHistory']), ['items', 'approvals']).map(normalizeApprovalHistory),
    artifacts,
    diffs: explicitDiffs.length ? explicitDiffs : artifactDiffs,
    context: arrayValue(section(source, ['context', 'contextItems']), ['items']).map(record),
    ...(verification ? { verification } : {}),
  }
}

export const bridge = {
  createRun: (input: JsonRecord) => call<unknown>([
    { path: 'runs.create', args: [input] },
    { path: 'createRun', args: [input] },
  ]),
  sendMessage: (runId: string, content: string, attachmentIds: string[] = []) => call<unknown>([
    { path: 'runs.sendMessage', args: [{ runId, content, ...(attachmentIds.length ? { attachmentIds } : {}) }] },
    { path: 'sendMessage', args: [{ runId, content, attachmentIds }] },
  ]),
  pauseRun: (runId: string) => call<unknown>([
    { path: 'runs.pause', args: [{ id: runId }] },
    { path: 'pauseRun', args: [runId] },
  ]),
  resumeRun: (runId: string) => call<unknown>([
    { path: 'runs.resume', args: [{ id: runId }] },
    { path: 'resumeRun', args: [runId] },
  ]),
  cancelRun: (runId: string) => call<unknown>([
    { path: 'runs.cancel', args: [{ id: runId }] },
    { path: 'cancelRun', args: [runId] },
  ]),
  removeRun: (runId: string) => call<unknown>([
    { path: 'runs.remove', args: [{ id: runId }] },
    { path: 'removeRun', args: [runId] },
  ]),
  respondApproval: (input: JsonRecord) => call<unknown>([
    { path: 'runs.respondToApproval', args: [input] },
    { path: 'respondApproval', args: [input] },
  ]),
  chooseWorkspace: async () => {
    const chosen = await call<unknown>([
      { path: 'app.chooseWorkspace' },
      { path: 'pickWorkspace' },
    ])
    const source = record(chosen)
    return typeof chosen === 'string' ? chosen : textValue(source, ['path', 'rootPath'])
  },
  importAttachments: async (): Promise<ArtifactItem[]> => {
    const result = await call<unknown>([
      { path: 'app.importAttachments' },
      { path: 'importAttachments' },
    ])
    return arrayValue(result, ['items', 'artifacts']).map(normalizeArtifact)
  },
  addWorkspace: (path: string) => call<unknown>([
    { path: 'workspaces.create', args: [{ path }] },
    { path: 'addWorkspace', args: [path] },
  ]),
  selectWorkspace: (id: string) => call<unknown>([
    { path: 'workspaces.select', args: [{ id }] },
    { path: 'selectWorkspace', args: [id] },
  ]),
  updateWorkspace: (input: JsonRecord) => call<unknown>([
    { path: 'workspaces.update', args: [input] },
    { path: 'updateWorkspace', args: [input] },
  ]),
  removeWorkspace: (id: string) => call<unknown>([
    { path: 'workspaces.remove', args: [{ id }] },
    { path: 'removeWorkspace', args: [id] },
  ]),
  saveModel: (input: JsonRecord) => call<unknown>([
    { path: 'models.upsert', args: [input] },
    { path: 'saveModelProfile', args: [input] },
  ]),
  listModelCatalog: (provider: ModelProvider) => call<unknown>([
    { path: 'models.catalog', args: [{ provider }] },
  ]),
  setModelSecret: (input: JsonRecord) => call<unknown>([
    { path: 'models.setSecret', args: [input] },
    { path: 'setModelSecret', args: [input] },
  ]),
  testModel: (input: JsonRecord) => call<unknown>([
    { path: 'models.test', args: [input] },
    { path: 'testModelProfile', args: [input] },
  ]),
  setDefaultModel: (id: string) => call<unknown>([
    { path: 'models.setDefaults', args: [{ defaultModelProfileId: id }] },
    { path: 'setDefaultModelProfile', args: [id] },
  ]),
  setModelDefaults: (defaultModelProfileId: string, subagentModelProfileId?: string) => {
    const input: JsonRecord = { defaultModelProfileId }
    if (subagentModelProfileId) input.subagentModelProfileId = subagentModelProfileId
    return call<unknown>([
      { path: 'models.setDefaults', args: [input] },
      { path: 'setModelDefaults', args: [input] },
    ])
  },
  removeModel: (id: string) => call<unknown>([
    { path: 'models.remove', args: [{ id }] },
    { path: 'deleteModelProfile', args: [id] },
  ]),
  updateSettings: (input: JsonRecord) => call<unknown>([
    { path: 'settings.update', args: [input] },
    { path: 'updateSettings', args: [input] },
  ]),
  createPersistentGrant: (input: JsonRecord) => call<unknown>([
    { path: 'permissions.createPersistent', args: [input] },
  ]),
  chooseCapabilityPackage: () => call<unknown>([
    { path: 'capabilityPackages.choose' },
  ]),
  installCapabilityPackage: (selectionId: string, workspaceId?: string) => call<unknown>([
    { path: 'capabilityPackages.install', args: [{ selectionId, ...(workspaceId ? { workspaceId } : {}) }] },
  ]),
  removePersistentGrant: (id: string) => call<unknown>([
    { path: 'permissions.removePersistent', args: [{ id }] },
  ]),
  proposeMemory: (input: JsonRecord) => call<unknown>([
    { path: 'memory.propose', args: [input] },
    { path: 'proposeMemory', args: [input] },
  ]),
  updateMemory: (id: string, action: 'confirm' | 'disable' | 'remove') => {
    const grouped = action === 'remove' ? 'memory.remove' : `memory.${action}`
    return call<unknown>([
      { path: grouped, args: [{ id }] },
      { path: 'updateMemory', args: [id, action] },
    ])
  },
  saveMcp: (input: JsonRecord) => call<unknown>([
    { path: 'mcp.upsert', args: [input] },
    { path: 'saveMcpServer', args: [input] },
  ]),
  testMcp: (input: JsonRecord) => call<unknown>([
    { path: 'mcp.test', args: [input] },
    { path: 'testMcpServer', args: [input] },
  ]),
  removeMcp: (id: string) => call<unknown>([
    { path: 'mcp.remove', args: [{ id }] },
    { path: 'removeMcpServer', args: [id] },
  ]),
  authorizeMcp: (id: string) => call<unknown>([
    { path: 'mcp.startOAuth', args: [{ id }] },
    { path: 'startMcpOAuth', args: [id] },
  ]),
  importSkill: async () => {
    const directory = await bridge.chooseWorkspace()
    if (!directory) return undefined
    return await call<unknown>([
      { path: 'skills.import', args: [{ directory }] },
      { path: 'installSkill', args: [directory] },
    ])
  },
  toggleSkill: (id: string, enabled: boolean) => call<unknown>([
    { path: 'skills.setEnabled', args: [{ id, enabled }] },
    { path: 'toggleSkill', args: [id, enabled] },
  ]),
  removeSkill: (id: string) => call<unknown>([
    { path: 'skills.remove', args: [{ id }] },
    { path: 'removeSkill', args: [id] },
  ]),
  saveAutomation: (input: JsonRecord) => call<unknown>([
    { path: 'automations.upsert', args: [input] },
    { path: 'saveAutomation', args: [input] },
  ]),
  toggleAutomation: (id: string, enabled: boolean) => call<unknown>([
    { path: 'automations.setEnabled', args: [{ id, enabled }] },
    { path: 'toggleAutomation', args: [id, enabled] },
  ]),
  runAutomation: (id: string) => call<unknown>([
    { path: 'automations.runNow', args: [{ id }] },
    { path: 'runAutomation', args: [id] },
  ]),
  removeAutomation: (id: string) => call<unknown>([
    { path: 'automations.remove', args: [{ id }] },
    { path: 'removeAutomation', args: [id] },
  ]),
  requestChromeBinding: (runId: string) => call<unknown>([
    { path: 'chrome.requestBinding', args: [{ runId }] },
    { path: 'requestChromeBinding', args: [runId] },
  ]),
  revokeChromeGrant: (id: string) => call<unknown>([
    { path: 'chrome.revokeGrant', args: [{ id }] },
    { path: 'revokeChromeGrant', args: [id] },
  ]),
  exportAudit: () => call<unknown>([
    { path: 'audit.exportDiagnostics' },
    { path: 'exportAudit' },
  ]),
  listAudit: () => call<unknown>([
    { path: 'audit.list', args: [{ limit: 100 }] },
    { path: 'listAudit', args: [{ limit: 100 }] },
  ]),
  revealArtifact: (id: string) => call<unknown>([
    { path: 'artifacts.reveal', args: [{ id }] },
    { path: 'revealArtifact', args: [id] },
  ]),
  getArtifactText: (id: string, maxBytes = 2 * 1024 * 1024) => call<unknown>([
    { path: 'artifacts.getText', args: [{ id, maxBytes }] },
    { path: 'getArtifactText', args: [id, maxBytes] },
  ]),
  undoChange: (id: string) => call<unknown>([
    { path: 'artifacts.undoChange', args: [{ id }] },
    { path: 'undoArtifactChange', args: [id] },
  ]),
  subscribe(listener: (event: unknown) => void): () => void {
    try {
      const method = locate('events.subscribe') ?? locate('onEvent')
      if (!method) return () => undefined
      const unsubscribe = method.fn.call(method.owner, listener)
      return typeof unsubscribe === 'function' ? unsubscribe as () => void : () => undefined
    } catch {
      return () => undefined
    }
  },
}

export function resultId(value: unknown): string | undefined {
  const source = record(value)
  return textValue(source, ['id', 'runId']) || textValue(record(source.run), ['id', 'runId']) || undefined
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  const source = record(error)
  return textValue(source, ['message', 'error'], '操作失败，请重试。')
}
