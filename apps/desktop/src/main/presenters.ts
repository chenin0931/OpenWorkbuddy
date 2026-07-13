import type {
  AppSettings,
  ApprovalHistoryEntry,
  ApprovalRequest,
  ArtifactRef,
  AuditEntry,
  AutomationSpec,
  ChromeTabGrant,
  McpServerConfig,
  MemoryEntry,
  ModelCapabilities,
  ModelProfile,
  ModelSelectionSnapshot,
  ProviderId,
  Run,
  RunDetail,
  RunLimits,
  RunSummary,
  SkillManifest,
  SourceRef,
  ToolReceipt,
  Workspace,
} from '@onmyworkbuddy/contracts'

export const DEFAULT_LIMITS: RunLimits = { maxModelTurns: 60, maxDurationMs: 2 * 60 * 60 * 1000, maxSubagents: 3, maxParallelReadTools: 4 }

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'zh-CN',
  theme: 'system',
  defaultExecutionMode: 'execute',
  defaultAccessMode: 'approval',
  permissionMode: 'balanced',
  launchAtLogin: false,
  memoryEnabled: true,
  detailedLogRetentionDays: 90,
  detailedLogMaxBytes: 500 * 1024 * 1024,
  defaultRunLimits: DEFAULT_LIMITS,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
}

export function inferCapabilities(provider: ProviderId, modelId: string, partial: Partial<ModelCapabilities> = {}): ModelCapabilities {
  const kimiK27 = provider === 'moonshotai-cn' && /^kimi-k2\.7-code(?:-highspeed)?$/.test(modelId)
  return {
    contextWindow: provider === 'moonshotai-cn' ? 262_144 : provider === 'anthropic' ? 200_000 : 128_000,
    maxOutputTokens: kimiK27 ? 32_768 : 16_384,
    toolCalling: true,
    vision: true,
    reasoning: provider === 'moonshotai-cn' || /gpt-5|\bo\d|reason|claude-(sonnet|opus|fable)/i.test(modelId),
    promptCaching: true,
    ...partial,
  }
}

export function presentModel(row: any, subagentDefaultId?: string): ModelProfile {
  const provider = row.provider as ProviderId
  return {
    id: row.id,
    name: row.name,
    provider,
    modelId: row.model_id ?? row.modelId,
    capabilities: inferCapabilities(provider, row.model_id ?? row.modelId, row.capabilities ?? {}),
    keyConfigured: Boolean(row.hasKey ?? row.keyConfigured),
    isDefault: Boolean(row.isDefault ?? row.is_default),
    isSubagentDefault: row.id === subagentDefaultId,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  }
}

export function modelSnapshot(profile: ModelProfile): ModelSelectionSnapshot {
  return { profileId: profile.id, provider: profile.provider, modelId: profile.modelId, capabilities: profile.capabilities }
}

export function presentWorkspace(row: any, selectedId?: string): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.root_path ?? row.path,
    selected: row.id === selectedId || Boolean(row.selected),
    ...(row.rules ? { rules: row.rules } : {}),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  }
}

function currentTurnStartedAt(row: any): string | undefined {
  const event = [...(row.events ?? [])].reverse()
    .find((candidate: any) => candidate.type === 'run.turn_started')
  return event?.createdAt ?? event?.created_at
}

function currentVerification(row: any): any | undefined {
  if (row.status !== 'verifying' && row.status !== 'completed') return undefined
  if (row.outcome !== 'verified' && row.outcome !== 'partial') return undefined
  const reverseEvents = [...(row.events ?? [])].reverse()
  const turnStartedAt = currentTurnStartedAt(row)
  const operationalTools = (row.toolCalls ?? []).filter((call: any) => {
    const toolId = String(call.tool_id ?? call.toolId ?? call.toolName ?? '')
    const createdAt = String(call.createdAt ?? call.created_at ?? '')
    return !['task_complete', 'task_plan', 'task_step_update', 'memory_propose', 'skill_read'].includes(toolId)
      && (!turnStartedAt || createdAt >= String(turnStartedAt))
  })
  const operationalArtifacts = (row.artifacts ?? []).filter((artifact: any) => {
    const createdAt = String(artifact.createdAt ?? artifact.created_at ?? '')
    return ['diff', 'final_output'].includes(String(artifact.kind))
      && (!turnStartedAt || createdAt >= String(turnStartedAt))
  })
  if (operationalTools.length === 0 && operationalArtifacts.length === 0) return undefined
  return reverseEvents.find((event: any) => event.type === 'verification.completed'
    && event.payload?.verification
    && event.payload.verification.status === row.outcome
    && (!turnStartedAt || String(event.createdAt ?? event.created_at) >= String(turnStartedAt)))
    ?.payload?.verification
}

function currentProgress(row: any): any | undefined {
  if (!['understanding', 'planning', 'running', 'verifying'].includes(String(row.status))) return undefined
  const turnStartedAt = currentTurnStartedAt(row)
  const event = [...(row.events ?? [])].reverse().find((candidate: any) =>
    candidate.type === 'progress.updated'
      && candidate.payload?.progress
      && (!turnStartedAt || String(candidate.createdAt ?? candidate.created_at) >= String(turnStartedAt)),
  )
  return event?.payload?.progress
}

export function presentRun(row: any, fallbackModel: ModelProfile): Run {
  const snapshot = row.modelSnapshot && Object.keys(row.modelSnapshot).length ? row.modelSnapshot : modelSnapshot(fallbackModel)
  const limits = { ...DEFAULT_LIMITS, ...(row.limits ?? {}) }
  const status = row.status === 'waiting_user' ? 'waiting_user' : row.status
  const verification = status === 'completed' ? currentVerification(row) : undefined
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? row.workspace_id ?? '',
    accessMode: row.accessMode ?? row.access_mode ?? 'approval',
    title: row.title,
    objective: row.goal ?? row.prompt ?? row.objective,
    status,
    ...(verification ? { completionStatus: verification.status } : {}),
    model: snapshot,
    limits,
    modelTurns: row.modelTurns ?? row.model_turns ?? 0,
    ...(row.startedAt ?? row.started_at ? { startedAt: row.startedAt ?? row.started_at } : {}),
    ...(row.finishedAt ?? row.finished_at ? { completedAt: row.finishedAt ?? row.finished_at } : {}),
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
    ...(row.error ? { lastError: { code: 'RUN_ERROR', message: row.error, retryable: true } } : {}),
  } as Run
}

export function presentArtifact(row: any): ArtifactRef {
  return {
    id: row.id,
    ...(row.run_id ?? row.runId ? { runId: row.run_id ?? row.runId } : {}),
    kind: row.kind,
    sha256: row.sha256,
    mediaType: row.mime ?? row.mediaType ?? 'application/octet-stream',
    byteLength: row.size ?? row.byteLength ?? 0,
    displayName: row.name ?? row.displayName,
    createdAt: row.created_at ?? row.createdAt,
    ...((row.metadata ?? row.metadata_json) ? { metadata: row.metadata ?? (() => { try { return JSON.parse(row.metadata_json) } catch { return {} } })() } : {}),
  }
}

const RECEIPT_SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|cookie|password|secret|credential)/i
const RECEIPT_CONTENT_KEY = /^(?:content|oldText|newText|text|data|body|html)$/i
const TOOL_CALL_STATUSES = new Set(['requested', 'waiting_approval', 'running', 'succeeded', 'failed', 'cancelled'])
const RISK_LEVELS = new Set(['readonly', 'reversible_write', 'external_side_effect', 'high_risk_irreversible'])

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function compactText(value: unknown, max = 500): string {
  const text = [...String(value ?? '')].map((character) => {
    const code = character.charCodeAt(0)
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127 ? ' ' : character
  }).join('').replace(/\s+/g, ' ').trim()
  const redacted = text
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET)[A-Za-z0-9_]*)=([^\s]+)/gi, '$1=[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted
}

function sanitizeReceiptValue(value: unknown, key = '', depth = 0): any {
  if (RECEIPT_SENSITIVE_KEY.test(key) || RECEIPT_CONTENT_KEY.test(key)) return '[REDACTED]'
  if (depth >= 4) return '[TRUNCATED]'
  if (typeof value === 'string') return compactText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeReceiptValue(entry, '', depth + 1))
  if (!value || typeof value !== 'object') return null
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([childKey, child]) => [childKey, sanitizeReceiptValue(child, childKey, depth + 1)]))
}

function safePublicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8_192) return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    if (url.username || url.password) return undefined
    if (/^(?:localhost|\[[^\]]+]|\d{1,3}(?:\.\d{1,3}){3})$/i.test(url.hostname)) return undefined
    if (url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) return undefined
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) if (RECEIPT_SENSITIVE_KEY.test(key) || /^(?:sig|signature|auth)$/i.test(key)) url.searchParams.delete(key)
    const normalized = url.toString()
    return normalized.length <= 4_096 ? normalized : undefined
  } catch {
    return undefined
  }
}

function sourceRef(value: unknown, status: SourceRef['status'], fetchedAt?: string): SourceRef | undefined {
  const item = recordValue(value)
  const url = safePublicUrl(item.url)
  if (!url) return undefined
  const parsed = new URL(url)
  const title = compactText(item.title || parsed.hostname, 500) || parsed.hostname
  const snippet = compactText(item.snippet, 240)
  return {
    title,
    url,
    domain: parsed.hostname,
    ...(snippet ? { snippet } : {}),
    ...(fetchedAt ? { fetchedAt } : {}),
    ...(status ? { status } : {}),
  }
}

function receiptSources(row: any): SourceRef[] {
  const toolName = String(row.tool_id ?? row.toolName ?? '')
  const result = recordValue(row.result)
  const argumentsValue = recordValue(row.arguments)
  const updatedAt = row.updatedAt ?? row.updated_at
  const sources: SourceRef[] = []
  if (toolName === 'web_search') {
    const status: SourceRef['status'] = row.state === 'failed' ? 'failed' : 'discovered'
    for (const candidate of Array.isArray(result.results) ? result.results.slice(0, 20) : []) {
      const ref = sourceRef(candidate, status)
      if (ref) sources.push(ref)
    }
  } else if (toolName === 'web_fetch') {
    const status: SourceRef['status'] = row.state === 'succeeded' ? 'fetched' : row.state === 'failed' ? 'failed' : 'discovered'
    const ref = sourceRef({ url: result.url ?? argumentsValue.url, title: result.title }, status, status === 'fetched' ? updatedAt : undefined)
    if (ref) sources.push(ref)
  }
  return [...new Map(sources.map((source) => [source.url, source])).values()]
}

function receiptArguments(toolName: string, value: unknown): any {
  const args = recordValue(value)
  if (toolName === 'web_search') return sanitizeReceiptValue({ query: args.query, ...(Number.isInteger(args.maxResults) ? { maxResults: args.maxResults } : {}) })
  if (toolName === 'web_fetch') return sanitizeReceiptValue({ url: safePublicUrl(args.url) ?? compactText(args.url) })
  if (toolName === 'mcp_call_tool') return sanitizeReceiptValue({ serverId: args.serverId, toolName: args.toolName, arguments: '[REDACTED]' })
  if (toolName === 'chrome_type') return sanitizeReceiptValue({ tabId: args.tabId, selector: args.selector, text: '[REDACTED]' })
  return sanitizeReceiptValue(args)
}

function receiptResultSummary(row: any, sources: SourceRef[]): string | undefined {
  const toolName = String(row.tool_id ?? row.toolName ?? '')
  const result = recordValue(row.result)
  if (row.state === 'failed') return compactText(row.error || '工具执行失败', 500)
  if (row.state === 'cancelled') return '工具调用已取消'
  if (row.state !== 'succeeded') return undefined
  if (toolName === 'web_search') return `找到 ${Number.isFinite(Number(result.resultCount)) ? Number(result.resultCount) : sources.length} 个搜索结果`
  if (toolName === 'web_fetch') {
    const details = [Number.isFinite(Number(result.status)) ? `HTTP ${Number(result.status)}` : '', compactText(result.contentType, 120), Number.isFinite(Number(result.total)) ? `${Number(result.total)} bytes` : ''].filter(Boolean)
    return details.length ? details.join(' · ') : '网页读取成功'
  }
  if (toolName === 'file_list' && Array.isArray(result.entries)) return `返回 ${result.entries.length} 个目录项`
  if (toolName === 'file_read' && Number.isFinite(Number(result.size))) return `读取 ${Number(result.size)} bytes`
  if (toolName === 'shell_run' && Number.isFinite(Number(result.code))) return `命令退出码 ${Number(result.code)}`
  return '工具执行成功'
}

export function presentToolReceipt(row: any): ToolReceipt {
  const toolName = compactText(row.tool_id ?? row.toolName ?? 'unknown', 200) || 'unknown'
  const status = TOOL_CALL_STATUSES.has(row.state ?? row.status) ? row.state ?? row.status : 'failed'
  const riskLevel = RISK_LEVELS.has(row.risk ?? row.riskLevel) ? row.risk ?? row.riskLevel : 'readonly'
  const sources = receiptSources(row)
  const resultSummary = receiptResultSummary(row, sources)
  return {
    id: String(row.id),
    runId: String(row.run_id ?? row.runId),
    toolName,
    status,
    riskLevel,
    argumentsSummary: receiptArguments(toolName, row.arguments),
    ...(resultSummary ? { resultSummary } : {}),
    sources,
    ...(row.error ? { error: { code: 'TOOL_FAILED', message: compactText(row.error, 500), retryable: riskLevel === 'readonly' } } : {}),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  }
}

export function presentApproval(row: any): ApprovalRequest {
  const preview = row.preview ?? {}
  const status = row.status === 'denied'
    ? 'rejected'
    : row.status === 'approved' && row.decision?.decision === 'edit'
      ? 'edited'
      : row.status
  return {
    id: row.id,
    runId: row.run_id ?? row.runId,
    // approvals.tool_call_id is the internal FK. The provider id remains in
    // the persisted public preview so approval semantics do not change after
    // the application reloads.
    toolCallId: preview.toolCallId ?? row.tool_call_id ?? row.toolCallId,
    toolName: preview.toolName ?? preview.toolId ?? 'unknown',
    riskLevel: preview.riskLevel ?? 'external_side_effect',
    title: preview.title ?? '需要批准操作',
    reason: row.reason,
    target: preview.target ?? preview.path ?? preview.url ?? '本地任务',
    arguments: sanitizeReceiptValue(preview.arguments ?? {}),
    sendsData: preview.sendsData ?? [],
    reversible: Boolean(preview.reversible),
    status,
    createdAt: row.created_at ?? row.createdAt,
    ...(preview.expiresAt ? { expiresAt: preview.expiresAt } : {}),
  }
}

export function presentApprovalHistory(row: any): ApprovalHistoryEntry {
  const approval = presentApproval(row)
  const scope = row.scope === 'once' || row.scope === 'run_tool' ? row.scope : undefined
  return {
    ...approval,
    ...(scope ? { scope } : {}),
    ...(row.resolvedAt ?? row.resolved_at ? { resolvedAt: row.resolvedAt ?? row.resolved_at } : {}),
  }
}

export function presentRunDetail(row: any, fallbackModel: ModelProfile): RunDetail {
  const persistedVerification = currentVerification(row)
  const progress = currentProgress(row)
  const turnStartedAt = currentTurnStartedAt(row)
  return {
    run: presentRun(row, fallbackModel),
    steps: (row.steps ?? [])
      .filter((step: any) => !turnStartedAt || String(step.updatedAt ?? step.updated_at) >= String(turnStartedAt))
      .map((step: any) => ({
        id: step.id,
        runId: step.run_id ?? step.runId ?? row.id,
        title: step.title,
        ordinal: step.ordinal,
        status: step.status,
        ...(step.detail ? { detail: step.detail } : {}),
        ...(step.verification
          ? { verification: step.verification }
          : Array.isArray(step.evidence) && step.evidence.length > 0
            ? { verification: step.evidence.filter((item: unknown): item is string => typeof item === 'string').join('\n') }
            : {}),
        createdAt: step.created_at ?? step.createdAt,
        updatedAt: step.updated_at ?? step.updatedAt,
      })),
    messages: (row.messages ?? []).filter((message: any) =>
      ['user', 'assistant', 'system'].includes(message.role) && (message.role !== 'assistant' || String(message.content ?? '').trim().length > 0),
    ).map((message: any) => ({
      id: message.id,
      runId: row.id,
      role: message.role,
      content: message.content,
      createdAt: message.created_at ?? message.createdAt,
      ...(Array.isArray(message.metadata?.artifactIds) ? { artifactIds: message.metadata.artifactIds } : {}),
    })),
    pendingApprovals: (row.approvals ?? []).map(presentApproval),
    toolCalls: (row.toolCalls ?? []).map(presentToolReceipt),
    approvalHistory: (row.approvalHistory ?? row.approvals ?? []).map(presentApprovalHistory),
    artifacts: (row.artifacts ?? []).map(presentArtifact),
    ...(persistedVerification ? { verification: persistedVerification } : {}),
    ...(progress ? { progress } : {}),
  }
}

export function presentRunSummary(row: any, fallbackModel: ModelProfile): RunSummary {
  return { ...presentRun(row, fallbackModel), unreadEventCount: 0 }
}

export function presentMemory(row: any): MemoryEntry {
  return {
    id: row.id,
    ...(row.workspaceId ?? row.workspace_id ? { workspaceId: row.workspaceId ?? row.workspace_id } : {}),
    type: row.kind ?? row.type,
    scope: row.scope,
    state: row.status ?? row.state,
    content: row.content,
    confidence: row.confidence,
    sources: row.source ?? row.sources ?? [],
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
    ...((row.status ?? row.state) === 'confirmed' ? { confirmedAt: row.updatedAt ?? row.updated_at } : {}),
    ...((row.status ?? row.state) === 'disabled' ? { disabledAt: row.updatedAt ?? row.updated_at } : {}),
  }
}

export function presentMcp(row: any): McpServerConfig {
  const config = row.config ?? {}
  const transport = row.transport === 'stdio'
    ? { type: 'stdio' as const, command: config.command ?? '', args: config.args ?? [], envKeys: Object.keys(config.env ?? {}) }
    : { type: 'streamable_http' as const, url: config.url ?? '', auth: config.auth ?? (row.hasSecret ? 'bearer' : 'none'), secretConfigured: Boolean(row.hasSecret) }
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    transport,
    toolNamespace: config.toolNamespace ?? row.toolNamespace ?? row.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_'),
    ...(row.server_version ? { serverVersion: row.server_version } : {}),
    ...(row.schema_fingerprint ? { schemaFingerprint: row.schema_fingerprint } : {}),
    health: row.health ?? 'unknown',
    ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
    ...(row.last_error ? { lastError: { code: 'MCP_ERROR', message: row.last_error, retryable: true } } : {}),
  }
}

export function presentSkill(row: any): SkillManifest {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    directory: row.path ?? row.directory,
    enabled: Boolean(row.enabled),
    permissions: row.permissions ?? [],
    entrypoint: row.entrypoint ?? `${row.path ?? row.directory}/SKILL.md`,
    ...(row.updatedAt ?? row.updated_at ? { loadedAt: row.updatedAt ?? row.updated_at } : {}),
  }
}

export function presentAutomation(row: any): AutomationSpec {
  const schedule = row.schedule ?? (row.scheduleType === 'once'
    ? { type: 'once', runAt: row.scheduleValue }
    : row.scheduleType === 'interval'
      ? { type: 'interval', everyMs: Number(row.scheduleValue) }
      : { type: 'cron', expression: row.scheduleValue, timezone: row.timezone })
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    enabled: Boolean(row.enabled),
    objective: row.prompt ?? row.objective,
    modelProfileId: row.modelProfileId,
    schedule,
    normalizedSchedule: row.normalizedSchedule ?? (schedule.type === 'cron' ? `${schedule.expression} (${schedule.timezone})` : schedule.type === 'interval' ? `每 ${schedule.everyMs} ms` : schedule.runAt),
    ...(row.nextRunAt ? { nextRunAt: row.nextRunAt } : {}),
    ...(row.lastRunAt ? { lastRunAt: row.lastRunAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as AutomationSpec
}

export function presentChromeGrant(row: any): ChromeTabGrant {
  const url = row.url ? new URL(row.url) : undefined
  return {
    id: row.id,
    runId: row.run_id ?? row.runId,
    tabId: Number(row.tab_id ?? row.tabId),
    windowId: Number(row.window_id ?? row.windowId ?? 0),
    origin: url?.origin ?? '',
    title: row.title ?? '',
    grantedAt: row.created_at ?? row.grantedAt,
    childTabIds: row.childTabIds ?? [],
  }
}

export function presentAudit(row: any): AuditEntry {
  const payload = row.payload ?? {}
  const outcomeMap: Record<string, AuditEntry['outcome']> = { allow: 'allowed', deny: 'blocked', approve: 'approved', reject: 'rejected', success: 'succeeded', error: 'failed' }
  return {
    id: String(row.id),
    ...(row.run_id ?? row.runId ? { runId: row.run_id ?? row.runId } : {}),
    actor: payload.actor ?? (row.category === 'tool' ? 'tool' : 'system'),
    action: row.action,
    ...(payload.target ? { target: payload.target } : {}),
    outcome: outcomeMap[payload.outcome] ?? payload.outcome ?? 'started',
    summary: row.summary,
    ...(payload.riskLevel ? { riskLevel: payload.riskLevel } : {}),
    ...(payload.durationMs ? { durationMs: payload.durationMs } : {}),
    createdAt: row.createdAt ?? row.created_at,
  }
}
