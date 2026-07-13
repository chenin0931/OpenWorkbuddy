import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ApprovalRequest, ApprovalResponse, JsonValue, MemoryEntry, RunEvent, TaskStep, ToolCall, ToolDescriptor, VerificationSummary } from '@onmyworkbuddy/contracts'
import { createApprovalRequest, evaluateCompletionGate, evaluateToolPolicy, isValidationShellCommand, resolveApproval } from '@onmyworkbuddy/core'
import type { AppDatabase } from './database'
import type { ArtifactStore } from './artifact-store'
import type { ChromeBridge } from './chrome-bridge'
import type { SecretStore } from './secret-store'
import { TOOL_DEFINITIONS, type ToolDefinition } from './tool-registry'
import { assertToolArguments } from './tool-argument-validator'
import type { ToolRunnerBridge } from './worker-bridge'

interface PendingApproval {
  approval: ApprovalRequest
  receiptId: string
  tool: ToolDefinition
  args: Record<string, unknown>
  resolve: (args: Record<string, unknown>) => void
  reject: (error: Error) => void
}

const sourceFor = (id: string): ToolDescriptor['source'] => id.startsWith('chrome_') ? 'chrome' : id.startsWith('mcp_') ? 'mcp' : 'builtin'
const policyName = (id: string): string => ({
  file_list: 'file.list', file_read: 'file.read', file_search: 'file.search', file_write: 'file.write', file_replace: 'file.edit', file_delete: 'file.delete',
  shell_run: 'shell.command', web_search: 'web.search', web_fetch: 'web.fetch', mcp_list_tools: 'mcp.list', mcp_call_tool: 'mcp.call', skill_read: 'skill.read', memory_propose: 'memory.propose',
  task_plan: 'task.plan', task_complete: 'task.complete', agent_delegate: 'agent.delegate', chrome_tabs: 'chrome.read', chrome_snapshot: 'chrome.read_dom',
  chrome_screenshot: 'chrome.screenshot', chrome_navigate: 'chrome.navigate', chrome_click: 'chrome.click', chrome_type: 'chrome.input_sensitive', chrome_open_tab: 'chrome.navigate',
}[id] ?? id)

function descriptorFor(tool: ToolDefinition): ToolDescriptor {
  const source = sourceFor(tool.id)
  const readonly = tool.risk === 'read'
  return {
    name: policyName(tool.id),
    title: tool.label,
    description: tool.description,
    source,
    inputSchema: tool.parameters as JsonValue,
    annotations: {
      readOnlyHint: readonly,
      destructiveHint: tool.risk === 'high',
      externalSideEffectHint: tool.risk === 'external',
      idempotentHint: readonly,
      sendsDataOffDeviceHint: source === 'chrome' || source === 'mcp' || tool.id === 'web_search' || tool.id === 'web_fetch',
    },
  }
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|credential)/i

function redactValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    const sanitized = value.replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET)[A-Za-z0-9_]*)=([^\s]+)/gi, '$1=[REDACTED]')
    return sanitized.length > 2_000 ? `${sanitized.slice(0, 2_000)}…[${sanitized.length} chars]` : sanitized
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redactValue(child, childKey)]))
}

function loggedArguments(toolId: string, args: Record<string, unknown>): JsonValue {
  const copy = redactValue(args) as Record<string, unknown>
  if (toolId === 'file_write' && typeof args.content === 'string') copy.content = `[FILE CONTENT REDACTED: ${args.content.length} chars]`
  if (toolId === 'file_replace') {
    if (typeof args.oldText === 'string') copy.oldText = `[OLD TEXT REDACTED: ${args.oldText.length} chars]`
    if (typeof args.newText === 'string') copy.newText = `[NEW TEXT REDACTED: ${args.newText.length} chars]`
  }
  if (toolId === 'chrome_type' && typeof args.text === 'string') copy.text = `[INPUT REDACTED: ${args.text.length} chars]`
  return asJson(copy)
}

function persistedResult(result: unknown): JsonValue {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return asJson(redactValue(result))
  const source = result as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (['content', 'text', 'preview', 'before', 'after', 'data'].includes(key)) {
      safe[key] = `[CONTENT OMITTED${typeof value === 'string' ? `: ${value.length} chars` : ''}]`
      continue
    }
    safe[key] = redactValue(value, key)
  }
  return asJson(safe)
}

const MEMORY_KIND_MAP: Record<string, MemoryEntry['type']> = {
  fact: 'stable_fact',
  stable_fact: 'stable_fact',
  knowledge: 'knowledge_background',
  knowledge_background: 'knowledge_background',
  behavior: 'behavior_signal',
  behavior_signal: 'behavior_signal',
  style: 'style_preference',
  style_preference: 'style_preference',
  continuation: 'continuation',
}

const TOOL_STATUSES = new Set<ToolCall['status']>(['requested', 'waiting_approval', 'running', 'succeeded', 'failed', 'cancelled'])
const STEP_STATUSES = new Set<TaskStep['status']>(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'skipped'])
const FILE_MUTATION_TOOLS = new Set(['file_write', 'file_replace', 'file_delete'])

function parseJson(value: unknown, fallback: JsonValue = {}): JsonValue {
  if (typeof value !== 'string') return fallback
  try { return asJson(JSON.parse(value)) } catch { return fallback }
}

function validationCommand(command: string): boolean {
  return /(?:^|\s)(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)\b|\b(?:vitest|jest|pytest|eslint|xcodebuild|tsc\s+--noEmit|cargo\s+(?:test|check|build)|go\s+test|swift\s+test|git\s+diff\s+--check)\b/i.test(command)
}

function readOnlyRun(raw: any): boolean {
  return Boolean(raw?.readOnly ?? raw?.read_only ?? raw?.permissions?.readOnly)
}

function evaluateRunAccessPolicy(
  call: ToolCall,
  descriptor: ToolDescriptor,
  accessMode: 'approval' | 'full_disk',
): ReturnType<typeof evaluateToolPolicy> {
  const decision = evaluateToolPolicy({ call, descriptor })
  if (accessMode !== 'full_disk' || decision.effect !== 'require_approval') return decision

  const command = typeof call.arguments === 'object' && call.arguments && !Array.isArray(call.arguments)
    ? String((call.arguments as Record<string, unknown>).command ?? '')
    : ''
  const explicitlyAutomatic = decision.ruleId === 'filesystem.write'
    || (decision.ruleId === 'shell.unknown-write' && isValidationShellCommand(command))
  return explicitlyAutomatic
    ? { ...decision, effect: 'allow', ruleId: `${decision.ruleId}.run-full-disk` }
    : decision
}

export class ToolBroker {
  private pendingApprovals = new Map<string, PendingApproval>()
  private fileLeaseTails = new Map<string, Promise<void>>()

  constructor(
    private database: AppDatabase,
    private runner: ToolRunnerBridge,
    private artifacts: ArtifactStore,
    private chrome: ChromeBridge,
    private secrets: SecretStore,
    private emit: (event: RunEvent) => void,
    private delegate: (input: { parentRunId: string; task: string; role: string }) => Promise<unknown>,
    private refreshMcpOAuth?: (serverId: string, serverUrl: string) => Promise<void>,
  ) {}

  async handle(input: { runId: string; requestId: string; toolCallId: string; toolId: string; args: Record<string, unknown> }): Promise<unknown> {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.id === input.toolId)
    if (!tool) throw new Error(`未知工具：${input.toolId}`)
    // Arguments cross a trust boundary from the model worker. Validate before
    // policy classification, persistence or any execution side effect.
    assertToolArguments(tool.id, tool.parameters, input.args)
    let rawRun = this.database.getRun(input.runId)
    if (!rawRun) throw new Error('任务不存在')
    if (rawRun.status === 'verifying' && input.toolId !== 'task_complete') {
      this.database.transitionRun(input.runId, 'running', { outcome: null, summary: '', finishedAt: null })
      rawRun = this.database.getRun(input.runId)
    }
    const descriptor = descriptorFor(tool)
    const call: ToolCall = {
      id: input.toolCallId,
      runId: input.runId,
      toolName: descriptor.name,
      source: descriptor.source,
      arguments: asJson(input.args),
      status: 'requested',
      idempotent: tool.risk === 'read',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    // The composer owns this run's durable authority. Ask mode deliberately
    // uses the conservative base policy; full-disk mode relaxes only the two
    // local actions enumerated above. It must not inherit unrelated global
    // conveniences such as outbound search.
    const accessMode = rawRun.accessMode === 'full_disk' ? 'full_disk' : 'approval'
    const baseDecision = evaluateRunAccessPolicy(call, descriptor, accessMode)
    const memoryDisabled = tool.id === 'memory_propose' && this.database.getSetting<any>('appSettings', {}).memoryEnabled === false
    const readOnlyViolation = readOnlyRun(rawRun) && (
      tool.risk !== 'read' ||
      tool.id === 'memory_propose' ||
      (tool.id === 'agent_delegate' && input.args.role === 'general')
    )
    const decision = memoryDisabled
      ? { ...baseDecision, effect: 'deny' as const, reason: 'Memory 已在设置中关闭。', ruleId: 'memory.disabled' }
      : readOnlyViolation
        ? { ...baseDecision, effect: 'deny' as const, reason: '只读子 Agent 不允许执行该操作。', ruleId: 'run.readonly-capability' }
        : baseDecision
    call.idempotent = decision.idempotent
    const providerCall: ToolCall = { ...call, arguments: loggedArguments(input.toolId, input.args) }
    // Provider call ids are scoped to a provider response and are routinely
    // reused across new runs/resumed turns. Persist under an application-owned
    // receipt id while keeping the original id for model and approval semantics.
    const receiptId = this.database.createToolCall({ providerCallId: call.id, runId: call.runId, toolId: input.toolId, risk: decision.riskLevel, arguments: providerCall.arguments })
    const receiptCall: ToolCall = { ...providerCall, id: receiptId }
    const rawTarget = String(input.args.path ?? input.args.url ?? input.args.query ?? input.args.command ?? input.toolId)
    this.database.audit('tool', input.toolId, `Agent 请求 ${tool.label}`, { actor: 'agent', outcome: decision.effect, riskLevel: decision.riskLevel, target: redactValue(rawTarget, 'target') as string }, input.runId)

    let args = input.args
    const hasGrant = this.database.hasRunGrant(input.runId, descriptor.name, asJson(input.args))
    if (decision.effect === 'deny') {
      const error = Object.assign(new Error(decision.reason), { code: decision.ruleId })
      this.database.updateToolCall(receiptId, 'failed', undefined, error.message)
      this.emitTool(input.runId, { ...receiptCall, error: { code: decision.ruleId, message: error.message, retryable: false } }, 'failed', decision.riskLevel)
      throw error
    }
    if (decision.effect === 'require_approval' && !hasGrant) args = await this.waitForApproval(input.runId, providerCall, receiptId, tool, decision, input.args)

    this.database.updateToolCall(receiptId, 'running')
    this.emitTool(input.runId, receiptCall, 'running', decision.riskLevel)
    const releaseLease = await this.acquireFileLease(rawRun, tool, args)
    try {
      const result = await this.execute(input.runId, input.requestId, tool, args)
      this.database.updateToolCall(receiptId, 'succeeded', persistedResult(result))
      this.database.audit('tool', input.toolId, `${tool.label}完成`, { actor: 'tool', outcome: 'succeeded', riskLevel: decision.riskLevel }, input.runId)
      this.emitTool(input.runId, receiptCall, 'succeeded', decision.riskLevel)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const safeMessage = String(redactValue(message))
      this.database.updateToolCall(receiptId, 'failed', undefined, safeMessage)
      this.database.audit('tool', input.toolId, `${tool.label}失败`, { actor: 'tool', outcome: 'failed', riskLevel: decision.riskLevel }, input.runId)
      this.emitTool(input.runId, { ...receiptCall, error: { code: (error as any)?.code ?? 'TOOL_FAILED', message: safeMessage, retryable: decision.idempotent } }, 'failed', decision.riskLevel)
      throw error
    } finally {
      releaseLease()
    }
  }

  private async acquireFileLease(run: any, tool: ToolDefinition, args: Record<string, unknown>): Promise<() => void> {
    if (!FILE_MUTATION_TOOLS.has(tool.id) || typeof args.path !== 'string') return () => undefined
    const workspace = this.database.getWorkspace(run.workspaceId ?? run.workspace_id)
    if (!workspace?.root_path) throw Object.assign(new Error('任务工作区不存在或已被移除'), { code: 'WORKSPACE_REQUIRED' })
    const root = String(workspace.root_path)
    const absolute = resolve(root, args.path).normalize('NFC')
    const key = process.platform === 'darwin' ? absolute.toLocaleLowerCase('en-US') : absolute
    const previous = this.fileLeaseTails.get(key) ?? Promise.resolve()
    let unlock!: () => void
    const current = new Promise<void>((resolveCurrent) => { unlock = resolveCurrent })
    const tail = previous.then(() => current)
    this.fileLeaseTails.set(key, tail)
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      unlock()
      if (this.fileLeaseTails.get(key) === tail) this.fileLeaseTails.delete(key)
    }
  }

  private waitForApproval(runId: string, call: ToolCall, receiptId: string, tool: ToolDefinition, decision: ReturnType<typeof evaluateToolPolicy>, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = randomUUID()
    const approval = createApprovalRequest({
      id, call, decision, title: tool.label,
      target: String(args.path ?? args.url ?? args.query ?? args.command ?? args.selector ?? tool.id),
      sendsData: decision.sendsDataOffDevice ? ['工具参数可能发送到外部系统'] : [],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    // The FK targets the durable receipt, while the public approval keeps the
    // provider id produced by the model. This separation survives reloads.
    this.database.createApproval({ id, runId, toolCallId: receiptId, reason: approval.reason, preview: { ...approval, toolCallId: call.id, arguments: loggedArguments(tool.id, args) } })
    this.database.updateToolCall(receiptId, 'waiting_approval')
    this.database.transitionRun(runId, 'waiting_approval', { outcome: null, finishedAt: null })
    this.emit({ id: randomUUID(), runId, sequence: Date.now(), at: new Date().toISOString(), kind: 'approval.requested', approval })
    return new Promise((resolve, reject) => this.pendingApprovals.set(id, { approval, receiptId, tool, args, resolve, reject }))
  }

  respondToApproval(response: ApprovalResponse): void {
    const pending = this.pendingApprovals.get(response.requestId)
    if (!pending) throw new Error('审批不存在或已失效')
    const resolution = resolveApproval(pending.approval, response, { grantId: randomUUID() })
    if (resolution.executionArguments !== undefined) {
      // An edited approval is a second untrusted argument source. Keep the
      // approval pending if validation fails so the user can correct it.
      assertToolArguments(pending.tool.id, pending.tool.parameters, resolution.executionArguments)
      const editedDecision = evaluateToolPolicy({
        call: {
          id: pending.approval.toolCallId,
          runId: pending.approval.runId,
          toolName: pending.approval.toolName,
          source: descriptorFor(pending.tool).source,
          arguments: resolution.executionArguments,
          status: 'waiting_approval',
          idempotent: pending.tool.risk === 'read',
          createdAt: pending.approval.createdAt,
          updatedAt: new Date().toISOString(),
        },
        descriptor: descriptorFor(pending.tool),
      })
      const riskRank = { readonly: 0, reversible_write: 1, external_side_effect: 2, high_risk_irreversible: 3 } as const
      if (editedDecision.effect === 'deny' || riskRank[editedDecision.riskLevel] > riskRank[pending.approval.riskLevel]) {
        throw Object.assign(new Error('编辑后的参数改变了权限风险，请修改为同级操作后重试'), { code: 'APPROVAL_POLICY_CHANGED' })
      }
    }
    this.pendingApprovals.delete(response.requestId)
    this.database.resolveApproval(response.requestId, response)
    if (resolution.request.status === 'rejected' || !resolution.executionArguments) {
      this.database.audit('approval', pending.tool.id, `用户拒绝 ${pending.tool.label}`, { actor: 'user', outcome: 'rejected', riskLevel: pending.approval.riskLevel }, pending.approval.runId)
      this.database.updateToolCall(pending.receiptId, 'failed', undefined, '用户拒绝了该操作')
      pending.reject(new Error('用户拒绝了该操作'))
      if (!this.database.hasPendingApprovals(pending.approval.runId)) this.database.transitionRun(pending.approval.runId, 'running')
      return
    }
    if (resolution.grant && resolution.grant.scope === 'run_tool') this.database.addGrant(resolution.grant.runId ?? null, resolution.grant.toolName, resolution.grant.scope, resolution.grant.approvedArguments ?? {})
    this.database.audit('approval', pending.tool.id, `用户批准 ${pending.tool.label}`, { actor: 'user', outcome: 'approved', riskLevel: pending.approval.riskLevel }, pending.approval.runId)
    if (!this.database.hasPendingApprovals(pending.approval.runId)) this.database.transitionRun(pending.approval.runId, 'running')
    pending.resolve(resolution.executionArguments as Record<string, unknown>)
  }

  rejectRunApprovals(runId: string, reason = '任务已取消'): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.approval.runId !== runId) continue
      this.pendingApprovals.delete(id); pending.reject(new Error(reason))
    }
  }

  private async execute(runId: string, requestId: string, tool: ToolDefinition, args: Record<string, unknown>): Promise<any> {
    if (tool.id === 'task_plan') {
      const steps = Array.isArray(args.steps) ? args.steps as Array<{ title: string }> : []
      const persistedSteps = this.database.replaceSteps(runId, steps)
      this.database.transitionRun(runId, 'running', { outcome: null, summary: '', finishedAt: null })
      return { updated: true, steps: persistedSteps }
    }
    if (tool.id === 'task_step_update') {
      const step = this.database.updateTaskStep(runId, String(args.stepId), {
        status: String(args.status) as TaskStep['status'],
        ...(typeof args.evidence === 'string' ? { evidence: args.evidence } : {}),
      }) as TaskStep
      this.emit({ id: randomUUID(), runId, sequence: Date.now(), at: new Date().toISOString(), kind: 'step.updated', step })
      return { updated: true, step }
    }
    if (tool.id === 'task_complete') {
      return this.completeTask(runId, args)
    }
    if (tool.id === 'memory_propose') {
      if (this.database.getSetting<any>('appSettings', {}).memoryEnabled === false) throw Object.assign(new Error('Memory 已在设置中关闭。'), { code: 'MEMORY_DISABLED' })
      const kind = MEMORY_KIND_MAP[String(args.kind)]
      if (!kind) throw Object.assign(new Error(`不支持的 Memory 类型：${String(args.kind)}`), { code: 'INVALID_MEMORY_TYPE' })
      const id = this.database.saveMemory({ workspaceId: args.scope === 'workspace' ? this.database.getRun(runId)?.workspaceId : undefined, scope: args.scope, kind, content: args.content, confidence: args.confidence, status: 'proposed', source: [{ kind: 'run', reference: runId }] })
      return { id, state: 'proposed', message: '记忆候选已保存，等待用户确认后才会生效。' }
    }
    if (tool.id === 'skill_read') {
      const skill = this.database.getSkill(String(args.skillId))
      if (!skill || !skill.enabled) throw new Error('Skill 不存在或未启用')
      const resource = typeof args.resource === 'string' ? args.resource : 'SKILL.md'
      const content = await this.readSkillResource(String(skill.path), resource)
      return { id: skill.id, name: skill.name, resource, instructions: content, permissions: skill.permissions }
    }
    if (tool.id === 'agent_delegate') return this.delegate({ parentRunId: runId, task: String(args.task), role: String(args.role) })
    if (tool.id.startsWith('chrome_')) {
      const result = await this.chrome.executeTool(runId, tool.id, args)
      if (tool.id === 'chrome_screenshot' && typeof result?.data === 'string') {
        const artifact = await this.artifacts.putBuffer({ runId, name: `chrome-${Date.now()}.${result.format ?? 'jpeg'}`, kind: 'tool_result', data: Buffer.from(result.data, 'base64'), mime: `image/${result.format ?? 'jpeg'}`, metadata: { tabId: result.tabId } })
        return { ...result, data: undefined, artifact }
      }
      return result
    }

    const run = this.database.getRun(runId)
    if (!run) throw Object.assign(new Error('任务不存在'), { code: 'RUN_NOT_FOUND' })
    const workspace = this.database.getWorkspace(run.workspaceId)
    if (!workspace?.root_path) throw Object.assign(new Error('任务工作区不存在或已被移除'), { code: 'WORKSPACE_REQUIRED' })
    const authorizedRoot = run.accessMode === 'full_disk' ? '/' : workspace.root_path
    const preMutationSnapshot = tool.id === 'file_write' || tool.id === 'file_replace'
      ? await this.prepareFileSnapshot(runId, requestId, tool, args, workspace.root_path, authorizedRoot)
      : undefined
    let mcpServer: any
    if (tool.id.startsWith('mcp_')) {
      let raw = this.database.getMcpServer(String(args.serverId))
      if (!raw || !raw.enabled) throw new Error('MCP Server 不存在或未启用')
      if (raw.config?.auth === 'oauth' && typeof raw.config?.url === 'string') {
        await this.refreshMcpOAuth?.(raw.id, raw.config.url)
        raw = this.database.getMcpServer(String(args.serverId))
      }
      let secrets: Record<string, unknown> | string | undefined
      if (raw.encrypted_secret) secrets = this.decodeSecret(await this.secrets.decrypt(raw.encrypted_secret))
      mcpServer = { id: raw.id, transport: raw.transport, config: raw.config, ...(secrets ? { secrets } : {}) }
    }
    const result = await this.runner.execute({ runId, requestId, toolId: tool.runnerId, args, workspacePath: workspace.root_path, authorizedRoot, ...(mcpServer ? { mcpServer } : {}) }, (progress) => {
      this.database.appendRunEvent(runId, 'tool.progress', `${tool.label}: ${String(progress.text).slice(-500)}`, { channel: progress.channel })
    })
    return this.captureArtifacts(runId, tool, result, preMutationSnapshot)
  }

  private async prepareFileSnapshot(runId: string, requestId: string, tool: ToolDefinition, args: Record<string, unknown>, workspacePath: string, authorizedRoot: string): Promise<any> {
    try {
      const before = await this.runner.execute({ runId, requestId: `${requestId}-snapshot`, toolId: 'file.read', args: { path: args.path }, workspacePath, authorizedRoot })
      if (typeof before?.content !== 'string') throw new Error('写入前快照读取失败')
      if (typeof args.expectedSha256 === 'string' && before.sha256 !== args.expectedSha256) throw Object.assign(new Error('文件在读取后已变化，请重新读取'), { code: 'STALE_WRITE' })
      return this.artifacts.putText({ runId, name: `${String(args.path).split('/').at(-1)}.before`, kind: 'file_snapshot', content: before.content, metadata: { path: before.path, sha256: before.sha256, createdFile: false, capturedBeforeMutation: true } })
    } catch (error: any) {
      if (tool.id !== 'file_write' || error?.code !== 'ENOENT') throw error
      return this.artifacts.putText({ runId, name: `${String(args.path).split('/').at(-1)}.before`, kind: 'file_snapshot', content: '', metadata: { path: args.path, sha256: null, createdFile: true, capturedBeforeMutation: true } })
    }
  }

  private completeTask(runId: string, args: Record<string, unknown>): { accepted: true; verificationRequired: boolean; outcome: VerificationSummary['status'] | null; evidence: string[]; reportedEvidence: string[]; unverified: string[]; verification?: VerificationSummary } {
    const reportedEvidence = Array.isArray(args.evidence) ? args.evidence.filter((item): item is string => typeof item === 'string') : []
    const unverified = Array.isArray(args.unverified) ? args.unverified.filter((item): item is string => typeof item === 'string') : []
    const turnStartedAt = this.database.getCurrentRunTurnStartedAt(runId)
    const rows = (turnStartedAt
      ? this.database.db.prepare(`SELECT id,tool_id,state,arguments_json,result_json,error,created_at,updated_at
          FROM tool_calls WHERE run_id=? AND tool_id<>'task_complete' AND created_at>=? ORDER BY created_at`).all(runId, turnStartedAt)
      : this.database.db.prepare(`SELECT id,tool_id,state,arguments_json,result_json,error,created_at,updated_at
          FROM tool_calls WHERE run_id=? AND tool_id<>'task_complete' ORDER BY created_at`).all(runId)) as any[]
    const toolCalls = rows.map((row): ToolCall => {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.id === row.tool_id)
      const descriptor = definition ? descriptorFor(definition) : undefined
      const status = TOOL_STATUSES.has(row.state as ToolCall['status']) ? row.state as ToolCall['status'] : 'failed'
      return {
        id: String(row.id),
        runId,
        toolName: descriptor?.name ?? String(row.tool_id),
        source: descriptor?.source ?? 'builtin',
        arguments: parseJson(row.arguments_json),
        status,
        idempotent: definition?.risk === 'read',
        ...(row.error ? { error: { code: 'TOOL_FAILED', message: String(row.error), retryable: false } } : {}),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }
    })
    const artifacts = this.database.listArtifacts(runId).filter((artifact: any) => !turnStartedAt || String(artifact.created_at ?? artifact.createdAt) >= turnStartedAt)
    const verificationRelevantTools = rows.filter((row) => !['task_plan', 'task_step_update', 'memory_propose', 'skill_read'].includes(String(row.tool_id)))
    const verificationRelevantArtifacts = artifacts.filter((artifact: any) => ['diff', 'final_output'].includes(String(artifact.kind)))
    if (verificationRelevantTools.length === 0 && verificationRelevantArtifacts.length === 0) {
      // A model may still call task_complete after a greeting or a plain answer.
      // Do not manufacture a partial verdict when there was no operational work
      // for the completion gate to verify.
      this.database.updateRun(runId, { outcome: null, summary: '' })
      return { accepted: true, verificationRequired: false, outcome: null, evidence: [], reportedEvidence, unverified }
    }
    const checks: VerificationSummary['checks'] = []
    const observableEvidence: string[] = []

    const diffArtifacts = artifacts.filter((artifact: any) => artifact.kind === 'diff')
    if (diffArtifacts.length > 0) observableEvidence.push(`文件 Diff：${diffArtifacts.length} 个持久化 Diff`)
    const finalArtifacts = artifacts.filter((artifact: any) => artifact.kind === 'final_output')
    if (finalArtifacts.length > 0) observableEvidence.push(`最终产物：${finalArtifacts.length} 个持久化产物`)

    const validationRows: Array<{ row: any; command: string }> = []
    for (const row of rows.filter((candidate) => candidate.tool_id === 'shell_run')) {
      const toolArgs = parseJson(row.arguments_json)
      const command = typeof toolArgs === 'object' && toolArgs !== null && !Array.isArray(toolArgs) && typeof toolArgs.command === 'string' ? toolArgs.command : ''
      if (!validationCommand(command)) continue
      validationRows.push({ row, command })
      checks.push({
        name: `验证命令：${command.slice(0, 120)}`,
        status: row.state === 'succeeded' ? 'passed' : row.state === 'failed' ? 'failed' : 'not_run',
        ...(row.error ? { detail: String(row.error).slice(0, 500) } : {}),
      })
    }

    const succeededMutations = rows.filter((row) => FILE_MUTATION_TOOLS.has(String(row.tool_id)) && row.state === 'succeeded')
    if (succeededMutations.length > 0) {
      const latestMutationAt = Math.max(...succeededMutations.map((row) => Date.parse(String(row.updated_at ?? row.created_at)) || 0))
      const hasPostMutationValidation = validationRows.some(({ row }) =>
        row.state === 'succeeded' && (Date.parse(String(row.updated_at ?? row.created_at)) || 0) >= latestMutationAt,
      )
      if (!hasPostMutationValidation) {
        checks.push({ name: '文件修改验证', status: 'not_run', detail: '文件修改后没有成功的测试、类型检查、构建或等价验证命令' })
      }
    }

    const receiptChecks: Array<{ name: string; rows: any[] }> = [
      { name: 'Chrome 回执', rows: rows.filter((row) => ['chrome_navigate', 'chrome_click', 'chrome_type', 'chrome_open_tab'].includes(String(row.tool_id))) },
      { name: 'MCP 回执', rows: rows.filter((row) => row.tool_id === 'mcp_call_tool') },
    ]
    for (const receipt of receiptChecks) {
      if (receipt.rows.length === 0) continue
      const failed = receipt.rows.filter((row) => row.state === 'failed').length
      const succeeded = receipt.rows.filter((row) => row.state === 'succeeded' && row.result_json !== null).length
      checks.push({
        name: receipt.name,
        status: failed > 0 ? 'failed' : succeeded > 0 ? 'passed' : 'not_run',
        detail: `${succeeded} 成功，${failed} 失败`,
      })
    }
    const observableReads = rows.filter((row) => ['file_list', 'file_read', 'file_search', 'web_search', 'web_fetch', 'skill_read', 'chrome_snapshot'].includes(String(row.tool_id)))
    if (observableReads.length > 0) {
      const failedReads = observableReads.filter((row) => row.state === 'failed').length
      const succeededReads = observableReads.filter((row) => row.state === 'succeeded' && row.result_json !== null).length
      observableEvidence.push(`读取回执：${succeededReads} 个可观察来源读取成功，${failedReads} 个失败`)
    }
    // Durable output existence proves observability, not correctness. Only
    // validation commands and scoped external-system receipts become checks.
    if (checks.length === 0) checks.push({ name: '正确性验证', status: 'not_run', detail: '未发现成功的验证命令或可核验外部系统回执' })

    const raw = this.database.getRun(runId)
    const currentSteps = (raw?.steps ?? []).filter((step: any) => !turnStartedAt || String(step.updatedAt ?? step.updated_at) >= turnStartedAt)
    const steps = currentSteps.map((step: any, index: number): TaskStep => {
      const stepEvidence = Array.isArray(step.evidence) ? step.evidence.filter((item: unknown): item is string => typeof item === 'string') : []
      const verification = typeof step.verification === 'string' ? step.verification : stepEvidence.join('\n')
      return {
        id: String(step.id),
        runId,
        title: String(step.title),
        ordinal: Number(step.ordinal ?? index),
        status: STEP_STATUSES.has(step.status as TaskStep['status']) ? step.status as TaskStep['status'] : 'pending',
        ...(verification ? { verification } : {}),
        createdAt: String(step.createdAt ?? step.created_at),
        updatedAt: String(step.updatedAt ?? step.updated_at),
      }
    })
    const gate = evaluateCompletionGate({ steps, toolCalls, checks, evidence: reportedEvidence, unverified })
    const submittedSummary = String(args.summary ?? '').trim()
    const verification: VerificationSummary = {
      ...gate,
      summary: gate.status === 'verified'
        ? submittedSummary || gate.summary
        : [submittedSummary, gate.summary].filter(Boolean).join('\n'),
    }
    this.database.transitionRun(runId, 'verifying', { outcome: verification.status, summary: submittedSummary || verification.summary })
    this.emit({ id: randomUUID(), runId, sequence: Date.now(), at: new Date().toISOString(), kind: 'verification.completed', verification })
    const evidence = [
      ...observableEvidence,
      ...checks.filter((check) => check.status === 'passed').map((check) => check.detail ? `${check.name}: ${check.detail}` : check.name),
    ]
    return { accepted: true, verificationRequired: true, outcome: verification.status, evidence, reportedEvidence, unverified, verification }
  }

  private async captureArtifacts(runId: string, tool: ToolDefinition, result: any, preMutationSnapshot?: any): Promise<any> {
    if ((tool.id === 'file_write' || tool.id === 'file_replace') && (typeof result?.before === 'string' || result?.before === null) && typeof result?.after === 'string') {
      const createdFile = result.before === null || result.created === true
      const before = createdFile ? '' : String(result.before)
      const afterSha256 = String(result.sha256 ?? '')
      const snapshot = preMutationSnapshot ?? await this.artifacts.putText({
        runId,
        name: `${String(result.path).split('/').at(-1)}.before`,
        kind: 'file_snapshot',
        content: before,
        metadata: { path: result.path, sha256: result.beforeSha256 ?? null, createdFile, capturedBeforeMutation: false },
      })
      const diffText = `${createdFile ? '--- /dev/null' : `--- before/${result.path}`}\n+++ after/${result.path}\n@@\n-${before.replaceAll('\n', '\n-')}\n+${String(result.after).replaceAll('\n', '\n+')}\n`
      const diff = await this.artifacts.putText({
        runId,
        name: `${String(result.path).split('/').at(-1)}.diff`,
        kind: 'diff',
        content: diffText,
        mime: 'text/x-diff',
        metadata: {
          path: result.path,
          snapshotArtifactId: snapshot.id,
          afterSha256,
          createdFile,
          accessModeAtMutation: this.database.getRun(runId)?.accessMode ?? 'approval',
          additions: String(result.after).split('\n').length,
          deletions: before ? before.split('\n').length : 0,
        },
      })
      const safe = { ...result }
      delete safe.before
      delete safe.after
      return { ...safe, snapshotArtifactId: snapshot.id, diffArtifactId: diff.id }
    }
    const serialized = JSON.stringify(result)
    if (Buffer.byteLength(serialized) > 128 * 1024) {
      const artifact = await this.artifacts.putText({ runId, name: `${tool.id}-${Date.now()}.json`, kind: 'tool_result', content: serialized, mime: 'application/json' })
      const source = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {}
      const metadata = Object.fromEntries(['url', 'status', 'contentType', 'charset', 'total', 'engine', 'query', 'resultCount']
        .filter((key) => key in source)
        .map((key) => [key, source[key]]))
      const artifactRef = Object.fromEntries(['id', 'runId', 'kind', 'name', 'displayName', 'sha256', 'mime', 'mediaType', 'size', 'byteLength']
        .filter((key) => key in artifact)
        .map((key) => [key, artifact[key]]))
      return { ...metadata, truncated: true, artifact: artifactRef, preview: serialized.slice(0, 24_000) }
    }
    return result
  }

  private emitTool(runId: string, call: ToolCall, status: ToolCall['status'], riskLevel: any): void {
    this.emit({
      id: randomUUID(), runId, sequence: Date.now(), at: new Date().toISOString(), kind: 'tool.updated',
      toolCall: { ...call, status, riskLevel, updatedAt: new Date().toISOString() },
    })
  }

  private decodeSecret(value: string): Record<string, unknown> | string {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : value
    } catch {
      return value
    }
  }

  private async readSkillResource(skillPath: string, requestedResource: string): Promise<string> {
    const resource = requestedResource.replaceAll('\\', '/')
    const segments = resource.split('/')
    if (!resource || resource.includes('\0') || isAbsolute(resource) || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw Object.assign(new Error('Skill 资源必须是包内的规范相对路径'), { code: 'INVALID_SKILL_RESOURCE' })
    }

    const root = await realpath(skillPath)
    let target = root
    for (const segment of segments) {
      target = resolve(target, segment)
      const entry = await lstat(target)
      if (entry.isSymbolicLink()) throw Object.assign(new Error('Skill 资源不允许使用符号链接'), { code: 'SKILL_RESOURCE_SYMLINK' })
    }
    const canonical = await realpath(target)
    const inside = relative(root, canonical)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw Object.assign(new Error('Skill 资源超出已安装 Skill 目录'), { code: 'SKILL_RESOURCE_ESCAPE' })
    }

    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile()) throw Object.assign(new Error('Skill 资源必须是普通文件'), { code: 'INVALID_SKILL_RESOURCE' })
      const limit = 1024 * 1024
      if (metadata.size > limit) throw Object.assign(new Error('Skill 文本资源超过 1 MB 上限'), { code: 'SKILL_RESOURCE_TOO_LARGE' })
      const chunks: Buffer[] = []
      let total = 0
      while (true) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > limit) throw Object.assign(new Error('Skill 文本资源超过 1 MB 上限'), { code: 'SKILL_RESOURCE_TOO_LARGE' })
        chunks.push(chunk.subarray(0, bytesRead))
      }
      const data = Buffer.concat(chunks, total)
      if (data.includes(0)) throw Object.assign(new Error('Skill 资源不是文本文件'), { code: 'INVALID_SKILL_TEXT' })
      try { return new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { throw Object.assign(new Error('Skill 资源必须是有效 UTF-8 文本'), { code: 'INVALID_SKILL_TEXT' }) }
    } finally {
      await handle.close()
    }
  }
}
