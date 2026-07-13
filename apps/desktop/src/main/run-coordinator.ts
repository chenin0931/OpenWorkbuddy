import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { lstat, readFile, realpath } from 'node:fs/promises'
import type { ModelProfile, RunAccessMode, RunDetail, RunEvent } from '@onmyworkbuddy/contracts'
import { compileContext, compressContext, renderContextItem } from '@onmyworkbuddy/core'
import type { AppDatabase } from './database'
import type { ArtifactStore } from './artifact-store'
import type { SecretStore } from './secret-store'
import type { ToolBroker } from './tool-broker'
import { BASE_SYSTEM_PROMPT, publicToolDescriptors, TOOL_DEFINITIONS } from './tool-registry'
import { DEFAULT_LIMITS, modelSnapshot, normalizeRunLimits, presentArtifact, presentMemory, presentModel, presentRun, presentRunDetail, presentSkill } from './presenters'
import type { AgentHostBridge, ToolRunnerBridge } from './worker-bridge'
import { selectMemoriesForRun } from './memory-selection'
import { buildDurableCheckpoint } from './context-checkpoint'

const MAX_RULE_FILE_BYTES = 128 * 1024
const MAX_RULES_TOTAL_BYTES = 256 * 1024
const ACTIVE_RUN_STATUSES = new Set(['understanding', 'planning', 'running', 'verifying', 'waiting_approval'])
const IGNORE_LATE_AGENT_EVENT_STATUSES = new Set(['waiting_user', 'paused', 'completed', 'failed', 'cancelled'])
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const STARTABLE_RUN_STATUSES = new Set(['understanding', 'paused', 'waiting_user'])

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT')
}

function isWithinRoot(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

export class RunCoordinator {
  private sequences = new Map<string, number>()
  private streamingMessageIds = new Map<string, string>()
  private completionWaiters = new Map<string, Array<(run: any) => void>>()

  constructor(
    private database: AppDatabase,
    private secrets: SecretStore,
    private host: AgentHostBridge,
    private runner: ToolRunnerBridge,
    private broker: ToolBroker,
    private artifacts: ArtifactStore,
    private broadcast: (event: RunEvent) => void,
    private notify: (title: string, body: string) => void,
  ) {}

  emit = (event: RunEvent): void => {
    const persistedEvent = event.kind === 'approval.requested'
      ? { ...event, approval: { ...event.approval, arguments: this.redactApprovalArguments(event.approval.arguments) } }
      : event
    this.database.appendRunEvent(event.runId, event.kind, this.eventSummary(event), persistedEvent as any)
    this.broadcast(event)
    if (event.kind === 'approval.requested') this.notify('任务等待批准', `${event.approval.title}。打开 OpenWorkbuddy 查看详情。`)
  }

  async onHostMessage(message: any): Promise<void> {
    if (message.type === 'tool.request') {
      const run = this.database.getRun(message.runId)
      if (!run || !ACTIVE_RUN_STATUSES.has(run.status)) {
        this.host.toolResult(message.requestId, false, undefined, '任务当前未处于可执行状态')
        return
      }
      try {
        const result = await this.broker.handle({ runId: message.runId, requestId: message.requestId, toolCallId: message.toolCallId, toolId: message.toolId, args: message.args })
        this.host.toolResult(message.requestId, true, result)
      } catch (error) {
        const current = this.database.getRun(message.runId)
        // A worker failure can reject in-memory approvals while the host is
        // already gone. Do not respawn an idle host merely to deliver that late
        // rejection; a user resume will start a fresh, checkpointed run.
        if (current && ACTIVE_RUN_STATUSES.has(current.status)) {
          this.host.toolResult(message.requestId, false, undefined, error instanceof Error ? error.message : String(error))
        }
      }
      return
    }
    if (message.type === 'tool.cancel') { this.runner.cancel(message.requestId); return }
    if (message.type !== 'agent.event') return
    await this.handleAgentEvent(message.runId, message.event)
  }

  async create(input: { workspaceId: string; objective: string; accessMode?: RunAccessMode; mode?: 'plan' | 'execute'; title?: string; modelProfileId?: string; limits?: any; parentRunId?: string; readOnly?: boolean; fixedModelSnapshot?: any; attachmentIds?: string[] }): Promise<RunDetail> {
    const profile = this.selectProfile(input.modelProfileId)
    const settings = this.database.getSetting<any>('appSettings', {})
    const limits = normalizeRunLimits({ ...(settings.defaultRunLimits ?? {}), ...(input.limits ?? {}) })
    const raw = this.database.createRun({
      prompt: input.objective,
      title: input.title ?? input.objective.slice(0, 48),
      workspaceId: input.workspaceId,
      modelProfileId: profile.id,
      modelSnapshot: input.fixedModelSnapshot ?? modelSnapshot(profile),
      limits,
      mode: input.mode === 'plan' ? 'plan' : 'act',
      accessMode: input.accessMode ?? 'approval',
      parentRunId: input.parentRunId,
      readOnly: input.readOnly ?? (input.mode === 'plan'),
    })
    if (input.attachmentIds?.length) {
      this.database.attachArtifactsToRun(raw.id, input.attachmentIds)
      this.database.setInitialMessageArtifacts(raw.id, input.attachmentIds)
    }
    await this.start(raw.id, input.objective)
    return this.getDetail(raw.id)
  }

  async start(runId: string, prompt?: string): Promise<void> {
    let raw = this.database.getRun(runId)
    if (!raw) throw new Error('任务不存在')
    if (TERMINAL_RUN_STATUSES.has(raw.status)) {
      if (prompt === undefined) throw new Error('已结束的任务只能通过发送新消息开始下一轮')
      this.database.transitionRun(runId, 'understanding', {
        outcome: null,
        summary: '',
        error: null,
        finishedAt: null,
      }, { allowTerminalReopen: true })
      this.database.markRunTurnStarted(runId, 'follow_up')
      raw = this.database.getRun(runId)
    } else if (raw.status === 'understanding' && prompt !== undefined && !this.database.getCurrentRunTurnStartedAt(runId)) {
      this.database.updateRun(runId, { outcome: null, summary: '', error: null, finishedAt: null })
      this.database.markRunTurnStarted(runId, 'initial')
      raw = this.database.getRun(runId)
    } else if (prompt !== undefined && !this.database.getCurrentRunTurnStartedAt(runId)) {
      this.database.markRunTurnStarted(runId, 'follow_up')
      raw = this.database.getRun(runId)
    }
    if (!raw || !STARTABLE_RUN_STATUSES.has(raw.status)) throw new Error(`任务当前状态不能启动：${raw?.status ?? 'missing'}`)
    const limits = normalizeRunLimits(raw.limits)
    const usage = this.database.getRunBudgetUsage(runId)
    const turnUsage = this.database.getRunTurnBudgetUsage(runId)
    const remainingTurnTurns = Math.max(0, limits.maxModelTurnsPerTurn - turnUsage.modelTurns)
    const remainingTotalTurns = Math.max(0, limits.maxTotalModelTurns - usage.modelTurns)
    const remainingTurns = Math.min(remainingTurnTurns, remainingTotalTurns)
    const remainingTurnDurationMs = Math.max(0, limits.maxDurationMsPerTurn - turnUsage.activeDurationMs)
    const remainingTotalDurationMs = Math.max(0, limits.maxTotalDurationMs - usage.activeDurationMs)
    const remainingDurationMs = Math.min(remainingTurnDurationMs, remainingTotalDurationMs)
    if (remainingTurns <= 0) {
      const total = remainingTotalTurns <= 0
      this.finishBudgetExhausted(runId, 'model_turns', total ? '任务已用尽总模型回合预算，请在设置中提高总预算后继续。' : '本轮已用尽模型回合预算；发送一条新消息即可开始下一轮。', total ? 'total' : 'turn')
      return
    }
    if (remainingDurationMs <= 0) {
      const total = remainingTotalDurationMs <= 0
      this.finishBudgetExhausted(runId, 'duration', total ? '任务已用尽总执行时长预算，请在设置中提高总预算后继续。' : '本轮已用尽执行时长预算；发送一条新消息即可开始下一轮。', total ? 'total' : 'turn')
      return
    }
    try {
      const storedProfile = this.selectProfile(raw.modelProfileId)
      // A run owns an immutable model selection snapshot. Editing the default or
      // the profile's model id only affects subsequently created runs.
      const profile: ModelProfile = raw.modelSnapshot?.provider && raw.modelSnapshot?.modelId
        ? { ...storedProfile, provider: raw.modelSnapshot.provider, modelId: raw.modelSnapshot.modelId, capabilities: raw.modelSnapshot.capabilities ?? storedProfile.capabilities }
        : storedProfile
      const secret = this.database.getModelProfileSecret(raw.modelSnapshot?.profileId ?? profile.id)
      if (!secret?.encryptedKey) throw new Error(`模型配置 ${profile.name} 尚未设置 API Key`)
      const apiKey = await this.secrets.decrypt(secret.encryptedKey)
      const workspace = this.database.getWorkspace(raw.workspaceId)
      if (!workspace) throw new Error('任务工作区不存在')
      const systemPrompt = await this.compileSystemPrompt(raw, profile, workspace)
      const images = await this.loadRunImages(runId)
      let history = raw.messages
        .filter((message: any) => (message.role === 'user' || message.role === 'assistant') && (message.role !== 'assistant' || String(message.content ?? '').trim().length > 0))
        .map((message: any) => ({ role: message.role, content: message.content, timestamp: Date.parse(message.createdAt ?? message.created_at), sourceRef: `message:${message.id}` }))
      const tools = publicToolDescriptors().filter((tool) => !raw.readOnly || TOOL_DEFINITIONS.find((definition) => definition.id === tool.id)?.risk === 'read')
      const effectivePrompt = prompt ?? (raw.status === 'paused' || raw.status === 'waiting_user' ? '继续此前任务。先核对当前文件、持久化工具回执和任务状态，再从未完成项继续；不得自动重放外部副作用或高风险动作。' : raw.prompt)
      // createRun/sendMessage persist the current user turn before starting Pi. Pi's
      // prompt() appends that turn itself, so remove only the matching tail to avoid
      // presenting the same instruction twice while preserving all earlier history.
      const last = history.at(-1)
      if (last?.role === 'user' && last.content === effectivePrompt) history = history.slice(0, -1)
      this.database.transitionRun(runId, 'running', {
        startedAt: raw.startedAt ?? new Date().toISOString(),
        error: null,
        outcome: null,
        finishedAt: null,
      })
      this.database.beginRunExecution(runId)
      this.emitRun(runId)
      this.host.startRun({
        runId,
        prompt: effectivePrompt,
        provider: profile.provider,
        modelId: profile.modelId,
        apiKey,
        systemPrompt,
        history,
        ...(images.length ? { images } : {}),
        tools,
        maxTurns: remainingTurns,
        timeoutMs: Math.max(1, Math.ceil(remainingDurationMs)),
        maxParallelReadTools: limits.maxParallelReadTools,
        contextWindow: profile.capabilities.contextWindow,
        thinkingLevel: profile.capabilities.reasoning ? 'medium' : 'off',
      })
    } catch (error) {
      this.database.stopRunExecution(runId)
      const current = this.database.getRun(runId)
      if (current && !TERMINAL_RUN_STATUSES.has(current.status)) {
        this.database.transitionRun(runId, 'failed', { outcome: null, error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() })
      }
      this.emitRun(runId)
      throw error
    }
  }

  async sendMessage(runId: string, content: string, accessMode?: RunAccessMode, attachmentIds: string[] = []): Promise<void> {
    let raw = this.database.getRun(runId)
    if (!raw) throw new Error('任务不存在')
    let accessModeChanged = false
    if (accessMode && raw.accessMode !== accessMode) {
      if (accessMode === 'full_disk' && raw.parentRunId) {
        const parent = this.database.getRun(raw.parentRunId)
        if (!parent || parent.accessMode !== 'full_disk') {
          throw Object.assign(new Error('子 Agent 不能获得高于父任务的文件访问权限。请先在父任务中切换为“完全访问”。'), { code: 'PARENT_ACCESS_MODE_REQUIRED' })
        }
      }
      accessModeChanged = true
      const previousAccessMode = raw.accessMode ?? 'approval'
      this.database.updateRun(runId, { accessMode })
      const descendantDowngrade = previousAccessMode === 'full_disk' && accessMode === 'approval'
        ? this.database.downgradeDescendantAccess(runId)
        : { runIds: [], activeRunIds: [] }
      for (const childRunId of descendantDowngrade.activeRunIds) {
        this.runner.cancelRun(childRunId)
        this.host.steer(childRunId, '<runtime-authority source="OpenWorkbuddy" trusted="true">父任务已收回完全访问权限。本子任务后续只能访问当前工作区，并按请求批准策略执行。</runtime-authority>', [])
      }
      for (const childRunId of descendantDowngrade.runIds) {
        this.database.appendRunEvent(childRunId, 'run.access_mode_changed', '父任务已将文件访问收紧为请求批准', {
          accessMode: 'approval', parentRunId: runId,
        })
        this.emitRun(childRunId)
      }
      this.database.audit('security', 'run_access_mode_changed', accessMode === 'full_disk' ? '任务已切换为完全访问' : '任务已切换为请求批准', {
        actor: 'user', outcome: 'succeeded', previousAccessMode, accessMode,
        downgradedDescendantRunIds: descendantDowngrade.runIds,
      }, runId)
      raw = this.database.getRun(runId)
      if (!raw) throw new Error('任务不存在')
    }
    if (attachmentIds.length) this.database.attachArtifactsToRun(runId, attachmentIds)
    this.database.addMessage(runId, 'user', content, attachmentIds.length ? { artifactIds: attachmentIds } : {})
    const images = await this.loadArtifactsAsImages(attachmentIds)
    if (['running', 'planning', 'verifying', 'waiting_approval'].includes(raw.status)) {
      if (raw.outcome === 'verified' || raw.outcome === 'partial') {
        this.database.transitionRun(runId, 'running', { outcome: null, summary: '', error: null, finishedAt: null })
        this.database.markRunTurnStarted(runId, 'follow_up')
        this.emitRun(runId)
      }
      const runtimeAuthority = accessModeChanged
        ? `<runtime-authority source="OpenWorkbuddy" trusted="true">工作权限已切换为 ${raw.accessMode === 'full_disk' ? '完全访问；授权根为 /，相对路径仍以当前工作区为基准；所有未被策略硬拒绝的文件、Shell、网络、MCP 与浏览器操作自动执行，不再逐项确认' : '请求批准；授权根恢复为当前工作区；需要审批的操作必须等待用户处理'}。macOS TCC、只读子 Agent 与产品硬拒绝边界仍然有效。</runtime-authority>\n\n`
        : ''
      this.host.steer(runId, `${runtimeAuthority}${content}`, images)
    }
    else await this.start(runId, content)
  }

  pause(runId: string): any {
    const raw = this.database.getRun(runId)
    if (!raw) throw new Error('任务不存在')
    if (TERMINAL_RUN_STATUSES.has(raw.status)) throw new Error('已结束的任务不能暂停')
    this.host.cancelRun(runId)
    this.runner.cancelRun(runId)
    this.database.finishRunTurn(runId, 'cancelled')
    this.database.transitionRun(runId, 'paused', { outcome: null, finishedAt: null })
    this.database.cancelPendingRunWork(runId, '任务已暂停；未完成工具和审批已失效')
    this.broker.rejectRunApprovals(runId, '任务已暂停；审批已失效')
    this.emitRun(runId)
    return this.getRun(runId)
  }

  async resume(runId: string): Promise<any> {
    const raw = this.database.getRun(runId)
    if (!raw) throw new Error('任务不存在')
    if (raw.status !== 'paused' && raw.status !== 'waiting_user') throw new Error(`只有暂停或等待用户的任务可以继续：${raw.status}`)
    await this.start(runId)
    return this.getRun(runId)
  }

  cancel(runId: string): any {
    const raw = this.database.getRun(runId)
    if (!raw) throw new Error('任务不存在')
    if (raw.status === 'cancelled') return this.getRun(runId)
    if (raw.status === 'completed' || raw.status === 'failed') throw new Error('已结束的任务不能取消')
    this.host.cancelRun(runId); this.runner.cancelRun(runId)
    this.database.stopRunExecution(runId)
    this.database.transitionRun(runId, 'cancelled', { outcome: null, error: null, finishedAt: new Date().toISOString() })
    this.database.cancelPendingRunWork(runId, '任务已取消')
    this.broker.rejectRunApprovals(runId)
    this.emitRun(runId)
    const cancelled = this.getRun(runId)
    for (const resolve of this.completionWaiters.get(runId) ?? []) resolve(cancelled)
    this.completionWaiters.delete(runId)
    return cancelled
  }

  delete(runId: string): void {
    const raw = this.database.getRun(runId)
    if (!raw) return
    if (!TERMINAL_RUN_STATUSES.has(raw.status)) this.cancel(runId)
    this.database.deleteRun(runId)
  }
  getRun(runId: string): any { const raw = this.database.getRun(runId); if (!raw) throw new Error('任务不存在'); return presentRun(raw, this.profileForDisplay(raw)) }
  getDetail(runId: string): RunDetail { const raw = this.database.getRun(runId); if (!raw) throw new Error('任务不存在'); return presentRunDetail(raw, this.profileForDisplay(raw)) }

  async delegate(input: { parentRunId: string; task: string; role: string }): Promise<unknown> {
    const parent = this.database.getRun(input.parentRunId)
    if (!parent) throw new Error('父任务不存在')
    const count = (this.database.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE parent_run_id=? AND status NOT IN ('completed','failed','cancelled')").get(input.parentRunId) as any).count as number
    const limit = parent.limits?.maxSubagents ?? DEFAULT_LIMITS.maxSubagents
    if (count >= limit) throw new Error(`子 Agent 数量已达上限 ${limit}`)
    const settings = this.database.getSetting<any>('appSettings', {})
    const configuredChildProfile = typeof settings.subagentModelProfileId === 'string'
      ? this.database.listModelProfiles().find((profile) => profile.id === settings.subagentModelProfileId)
      : undefined
    const detail = await this.create({
      workspaceId: parent.workspaceId,
      objective: input.task,
      title: `${input.role}: ${input.task.slice(0, 36)}`,
      modelProfileId: configuredChildProfile?.id ?? parent.modelProfileId,
      // With no explicit child default, inherit the parent's immutable model
      // snapshot. A configured child default gets its own snapshot at creation.
      fixedModelSnapshot: configuredChildProfile ? undefined : parent.modelSnapshot,
      parentRunId: input.parentRunId,
      accessMode: parent.accessMode ?? 'approval',
      // A child can narrow authority, never widen it by selecting another role.
      readOnly: parent.readOnly || input.role !== 'general',
    })
    const completed = await this.waitForCompletion(detail.run.id)
    return { runId: completed.id, status: completed.status, completionStatus: completed.completionStatus, summary: this.database.getRun(completed.id)?.summary }
  }

  waitForCompletion(runId: string): Promise<any> {
    const run = this.database.getRun(runId)
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) return Promise.resolve(this.getRun(runId))
    return new Promise((resolve) => this.completionWaiters.set(runId, [...(this.completionWaiters.get(runId) ?? []), resolve]))
  }

  private async handleAgentEvent(runId: string, event: any): Promise<void> {
    const current = this.database.getRun(runId)
    if (!current) return
    // Turn consumption and generated checkpoints are monotonic evidence. Keep
    // them even if a pause/cancel IPC races ahead of the worker's event queue.
    if (event.type === 'agent.turn') {
      const cumulativeTurns = this.database.incrementRunModelTurns(runId)
      this.database.appendRunEvent(runId, 'agent.turn', `模型回合 ${cumulativeTurns}`, { ...event, cumulativeTurns })
      this.emitRun(runId)
      return
    }
    if (event.type === 'agent.checkpoint') {
      await this.persistContextCheckpoint(runId, event)
      return
    }
    // Abort/cancel and bridge-disconnect events race with worker event delivery.
    // Once the durable state says execution is no longer active, all late text,
    // tool and terminal events are ignored rather than mutating the checkpoint.
    if (IGNORE_LATE_AGENT_EVENT_STATUSES.has(current.status)) return
    if (event.type === 'agent.progress') {
      const at = new Date().toISOString()
      this.emit({
        id: randomUUID(),
        runId,
        sequence: this.nextSequence(runId),
        at,
        kind: 'progress.updated',
        progress: {
          phase: event.phase,
          message: String(event.message).slice(0, 500),
          ...(typeof event.toolName === 'string' ? { toolName: event.toolName.slice(0, 200) } : {}),
          ...(Number.isInteger(event.generatedChars) && event.generatedChars >= 0 ? { generatedChars: event.generatedChars } : {}),
          updatedAt: at,
        },
      })
      return
    }
    if (event.type === 'agent.started') {
      this.database.appendRunEvent(runId, 'agent.started', `使用 ${event.provider}/${event.modelId} 开始`, event)
      return
    }
    if (event.type === 'agent.budget_exhausted') {
      this.finishBudgetExhausted(runId, event.budget, event.message)
      return
    }
    if (event.type === 'text.delta') {
      let messageId = this.streamingMessageIds.get(runId)
      if (!messageId) { messageId = randomUUID(); this.streamingMessageIds.set(runId, messageId) }
      this.emit({ id: randomUUID(), runId, sequence: this.nextSequence(runId), at: new Date().toISOString(), kind: 'message.delta', messageId, delta: event.delta })
      return
    }
    if (event.type === 'message.assistant') {
      this.streamingMessageIds.delete(runId)
      // Pi emits an assistant message for tool-call-only turns. Keep its usage
      // accounting, but do not turn an empty model envelope into a chat bubble.
      if (event.usage) this.database.audit('model', 'completion', '模型回合完成', { actor: 'agent', outcome: 'succeeded', usage: event.usage }, runId)
      const content = typeof event.content === 'string' ? event.content : ''
      if (!content.trim()) return
      const messageId = this.database.addMessage(runId, 'assistant', content, { usage: event.usage, stopReason: event.stopReason })
      const message = { id: messageId, runId, role: 'assistant' as const, content: event.content, createdAt: new Date().toISOString() }
      this.emit({ id: randomUUID(), runId, sequence: this.nextSequence(runId), at: new Date().toISOString(), kind: 'message.completed', message })
      return
    }
    if (event.type === 'agent.completed') {
      let raw = this.database.getRun(runId)
      // abort() is also used to implement pause/cancel. Ignore the worker's late
      // terminal event so it cannot overwrite the user-visible control state.
      if (!raw || ['paused', 'cancelled', 'completed', 'failed'].includes(raw.status)) return
      const failed = Boolean(event.errorMessage)
      this.database.finishRunTurn(runId, failed ? 'failed' : 'completed')
      if (failed) {
        this.database.transitionRun(runId, 'failed', {
          outcome: null,
          error: event.errorMessage,
          finishedAt: new Date().toISOString(),
          summary: event.content || raw.summary,
        })
      } else {
        if (raw.outcome !== 'verified' && raw.outcome !== 'partial') {
          this.broker.finalizeTurn(runId, event.content || raw.summary || '工作已结束')
          raw = this.database.getRun(runId)
          if (!raw) return
        }
        // A plain conversational answer is complete but is not automatically a
        // partial verification verdict. Only task_complete may set outcome.
        if (raw.status !== 'verifying') this.database.transitionRun(runId, 'verifying', { outcome: null })
        const latest = this.database.getRun(runId)
        this.database.transitionRun(runId, 'completed', {
          outcome: latest?.outcome ?? null,
          error: null,
          finishedAt: new Date().toISOString(),
          summary: latest?.outcome ? (latest.summary || event.content) : event.content,
        })
      }
      this.emitRun(runId)
      const finished = this.getRun(runId)
      this.notify(failed ? '任务失败' : '任务完成', finished.title)
      for (const resolve of this.completionWaiters.get(runId) ?? []) resolve(finished)
      this.completionWaiters.delete(runId)
      return
    }
    if (event.type === 'agent.failed') {
      const raw = this.database.getRun(runId)
      if (!raw || ['paused', 'cancelled', 'completed', 'failed'].includes(raw.status)) return
      this.database.finishRunTurn(runId, 'failed')
      this.database.transitionRun(runId, 'failed', { outcome: null, error: event.error, finishedAt: new Date().toISOString() })
      this.emitRun(runId)
      const failed = this.getRun(runId)
      this.notify('任务失败', failed.title)
      for (const resolve of this.completionWaiters.get(runId) ?? []) resolve(failed)
      this.completionWaiters.delete(runId)
      return
    }
    this.database.appendRunEvent(runId, event.type, event.type, event)
  }

  private finishBudgetExhausted(runId: string, budget: 'model_turns' | 'duration', message: string, scope?: 'turn' | 'total'): void {
    const raw = this.database.getRun(runId)
    if (!raw || ['completed', 'failed', 'cancelled'].includes(raw.status)) return
    const limits = normalizeRunLimits(raw.limits)
    const usageBeforeFinish = this.database.getRunBudgetUsage(runId)
    const turnUsageBeforeFinish = this.database.getRunTurnBudgetUsage(runId)
    const resolvedScope = scope ?? (budget === 'model_turns'
      ? (usageBeforeFinish.modelTurns >= limits.maxTotalModelTurns ? 'total' : 'turn')
      : (usageBeforeFinish.activeDurationMs >= limits.maxTotalDurationMs ? 'total' : 'turn'))
    this.database.finishRunTurn(runId, 'budget_exhausted')
    this.database.transitionRun(runId, 'waiting_user', { outcome: null, error: null, finishedAt: null })
    this.database.appendRunEvent(runId, 'run.budget_exhausted', message, {
      budget,
      scope: resolvedScope,
      limits,
      usage: this.database.getRunBudgetUsage(runId),
      turnUsage: turnUsageBeforeFinish,
    }, 'warning')
    this.emitRun(runId)
    const waiting = this.getRun(runId)
    this.notify('任务需要继续', waiting.title)
    for (const resolve of this.completionWaiters.get(runId) ?? []) resolve(waiting)
    this.completionWaiters.delete(runId)
  }

  private async persistContextCheckpoint(runId: string, event: { content: string; sourceRefs: string[]; signature: string; estimatedTokens: number }): Promise<void> {
    const raw = this.database.getRun(runId)
    if (!raw) return
    const durableSignature = createHash('sha256').update(JSON.stringify({
      sourceSignature: event.signature,
      objective: raw.goal || raw.prompt,
      summary: raw.summary,
      steps: raw.steps.map((step: any) => ({ id: step.id, title: step.title, status: step.status, evidence: step.evidence })),
    })).digest('hex')
    const latest = raw.artifacts.find((artifact: any) => artifact.kind === 'checkpoint')
    if (latest?.metadata?.signature === durableSignature) return
    const createdAt = new Date().toISOString()
    const content = buildDurableCheckpoint({
      runId,
      objective: raw.goal || raw.prompt,
      summary: raw.summary,
      steps: raw.steps.map((step: any) => ({ id: step.id, title: step.title, status: step.status, evidence: step.evidence })),
      historySummary: event.content,
      sourceRefs: event.sourceRefs,
      createdAt,
    })
    const artifact = await this.artifacts.putText({
      runId,
      name: `context-checkpoint-${createdAt.replace(/[:.]/g, '-')}.md`,
      kind: 'checkpoint',
      content,
      mime: 'text/markdown; charset=utf-8',
      metadata: {
        signature: durableSignature,
        sourceSignature: event.signature,
        sourceRefs: event.sourceRefs,
        estimatedTokens: event.estimatedTokens,
        objective: raw.goal || raw.prompt,
        stepIds: raw.steps.map((step: any) => step.id),
      },
    })
    this.database.appendRunEvent(runId, 'context.checkpoint', '已保存可恢复的上下文检查点', {
      artifactId: artifact.id,
      signature: durableSignature,
      sourceSignature: event.signature,
      sourceRefs: event.sourceRefs,
      estimatedTokens: event.estimatedTokens,
    })
    this.emit({
      id: randomUUID(),
      runId,
      sequence: this.nextSequence(runId),
      at: new Date().toISOString(),
      kind: 'artifact.created',
      artifact: presentArtifact(artifact),
    })
  }

  private selectProfile(id?: string): ModelProfile {
    const settings = this.database.getSetting<any>('appSettings', {})
    const profiles = this.database.listModelProfiles().map((profile) => presentModel(profile, settings.subagentModelProfileId))
    const selected = profiles.find((profile) => profile.id === id) ?? profiles.find((profile) => profile.id === settings.defaultModelProfileId) ?? profiles.find((profile) => profile.isDefault) ?? profiles[0]
    if (!selected) throw new Error('请先在设置中添加 OpenAI 或 Anthropic 模型配置')
    return selected
  }

  private profileForDisplay(raw: any): ModelProfile {
    try {
      return this.selectProfile(raw.modelProfileId)
    } catch {
      const snapshot = raw.modelSnapshot ?? {}
      return {
        id: snapshot.profileId ?? raw.modelProfileId ?? 'deleted-profile',
        name: '已删除的模型配置',
        provider: snapshot.provider ?? 'openai',
        modelId: snapshot.modelId ?? 'unknown',
        capabilities: snapshot.capabilities ?? { contextWindow: 128_000, maxOutputTokens: 16_384, toolCalling: true, vision: false, reasoning: false, promptCaching: false },
        keyConfigured: false,
        isDefault: false,
        isSubagentDefault: false,
        createdAt: raw.createdAt ?? new Date(0).toISOString(),
        updatedAt: raw.updatedAt ?? new Date(0).toISOString(),
      }
    }
  }

  private async compileSystemPrompt(run: any, profile: ModelProfile, workspace: any): Promise<string> {
    const files = ['WORKBUDDY.md', 'AGENTS.md', join('.on-my-workbuddy', 'rules.md')]
    const workspaceRules: Array<{ source: string; content: string }> = []
    let totalRuleBytes = 0
    if (workspace.rules?.trim()) {
      const byteLength = Buffer.byteLength(workspace.rules)
      if (byteLength <= MAX_RULE_FILE_BYTES && byteLength <= MAX_RULES_TOTAL_BYTES) {
        workspaceRules.push({ source: 'workspace-settings', content: workspace.rules })
        totalRuleBytes += byteLength
      } else {
        this.database.audit('security', 'workspace_rules_rejected', '工作区设置规则超过上下文大小限制', {
          actor: 'system', outcome: 'blocked', target: 'workspace-settings', byteLength,
        }, run.id)
      }
    }

    const root = await realpath(workspace.root_path)
    for (const file of files) {
      try {
        let candidate = root
        // Inspect every component instead of trusting only the final realpath:
        // a symlinked parent directory is also an authority escape surface.
        for (const segment of file.split(/[\\/]/).filter(Boolean)) {
          candidate = join(candidate, segment)
          const info = await lstat(candidate)
          if (info.isSymbolicLink()) throw new Error(`规则路径不允许符号链接：${file}`)
        }
        const info = await lstat(candidate)
        if (!info.isFile()) throw new Error(`规则路径不是普通文件：${file}`)
        if (info.size > MAX_RULE_FILE_BYTES) throw new Error(`规则文件超过 ${MAX_RULE_FILE_BYTES} 字节：${file}`)
        const resolved = await realpath(candidate)
        if (!isWithinRoot(root, resolved)) throw new Error(`规则文件超出授权工作区：${file}`)
        const content = await readFile(resolved)
        if (content.byteLength > MAX_RULE_FILE_BYTES) throw new Error(`规则文件读取后超过大小限制：${file}`)
        if (totalRuleBytes + content.byteLength > MAX_RULES_TOTAL_BYTES) throw new Error(`规则文件总量超过 ${MAX_RULES_TOTAL_BYTES} 字节`)
        workspaceRules.push({ source: file, content: content.toString('utf8') })
        totalRuleBytes += content.byteLength
      } catch (error) {
        if (isMissingFile(error)) continue
        this.database.audit('security', 'workspace_rule_rejected', `拒绝加载工作区规则 ${file}`, {
          actor: 'system', outcome: 'blocked', target: file,
          reason: error instanceof Error ? error.message : String(error),
        }, run.id)
      }
    }
    const settings = this.database.getSetting<any>('appSettings', {})
    const memories = settings.memoryEnabled === false
      ? []
      : selectMemoriesForRun(this.database.listMemory().map(presentMemory), {
          runId: run.id,
          workspaceId: workspace.id,
          messageBelongsToRun: (messageId, candidateRunId) => this.database.messageBelongsToRun(messageId, candidateRunId),
        })
    const skills = this.database.listSkills().filter((skill) => skill.enabled).map((skill) => ({ manifest: presentSkill(skill) }))
    const progress = [
      run.summary || '',
      ...(run.steps ?? []).map((step: any) => `[${step.status}] ${step.title} (step:${step.id})`),
    ].filter(Boolean).join('\n')
    const previousCheckpoint = await this.loadPreviousCheckpoint(run)
    const context = compileContext({
      platformContract: BASE_SYSTEM_PROMPT,
      userPreferences: this.database.getSetting<string>('userPreferences', ''),
      workspaceRules,
      skills,
      task: { objective: run.goal ?? run.prompt, ...(progress ? { progress } : {}) },
      environment: {
        os: process.platform,
        arch: process.arch,
        shell: process.env.SHELL ?? '/bin/zsh',
        time: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        workspace: workspace.root_path,
        accessMode: run.accessMode ?? 'approval',
        authorizedRoot: run.accessMode === 'full_disk' ? '/' : workspace.root_path,
      },
      memories,
      ...(previousCheckpoint ? { previousCheckpoint } : {}),
      untrustedContent: await this.attachmentContextItems(run.id),
      maxContextTokens: profile.capabilities.contextWindow,
    })
    let stablePrefix = context.stablePrefix
    let dynamicSuffix = context.dynamicSuffix
    if (context.needsCheckpoint) {
      const compressed = compressContext(context.items, Math.max(1, Math.floor(profile.capabilities.contextWindow * 0.6)), {
        checkpointId: `checkpoint-${run.id}`,
      })
      const droppedIds = new Set(compressed.droppedItemIds)
      const sourceRefs = context.items
        .filter((entry) => droppedIds.has(entry.id))
        .map((entry) => `${entry.kind}:${entry.source}`)
      const checkpointContent = compressed.checkpoint?.content
        ?? `Context crossed the 70% checkpoint threshold. Re-open these sources before relying on omitted detail:\n${sourceRefs.map((source) => `- ${source}`).join('\n')}`
      const sourceSignature = createHash('sha256').update(JSON.stringify({ checkpointContent, sourceRefs })).digest('hex')
      await this.persistContextCheckpoint(run.id, {
        content: checkpointContent,
        sourceRefs,
        signature: sourceSignature,
        estimatedTokens: context.estimatedTokens,
      })
      stablePrefix = compressed.items.filter((entry) => entry.stable).map(renderContextItem).join('\n\n')
      dynamicSuffix = compressed.items.filter((entry) => !entry.stable).map(renderContextItem).join('\n\n')
    }
    const receipts = this.compileToolReceiptSection(run.id)
    return `${stablePrefix}\n\n${dynamicSuffix}${receipts ? `\n\n${receipts}` : ''}`
  }

  private async loadPreviousCheckpoint(run: any): Promise<any | undefined> {
    const latest = run.artifacts.find((artifact: any) => artifact.kind === 'checkpoint')
    if (!latest) return undefined
    try {
      const content = (await this.artifacts.read(latest.path)).toString('utf8')
      return {
        id: `checkpoint-${latest.id}`,
        kind: 'checkpoint',
        content,
        source: `artifact:${latest.id}`,
        trusted: true,
        priority: 980,
        stable: false,
        createdAt: latest.createdAt ?? latest.created_at,
      }
    } catch (error) {
      this.database.audit('context', 'checkpoint_read_failed', '无法读取持久化上下文检查点', {
        actor: 'system', outcome: 'failed', artifactId: latest.id,
        reason: error instanceof Error ? error.message : String(error),
      }, run.id)
      return undefined
    }
  }

  private async attachmentContextItems(runId: string): Promise<any[]> {
    const rows = this.database.listArtifacts(runId).filter((artifact: any) => artifact.kind === 'attachment')
    const items: any[] = []
    let totalBytes = 0
    for (const row of rows) {
      const mime = String(row.mime ?? '')
      items.push({
        id: `attachment-manifest-${row.id}`,
        kind: 'environment',
        content: `用户已附加文件。artifactId: ${row.id}\n名称：${row.name}\n媒体类型：${mime || 'application/octet-stream'}\n大小：${row.size} bytes\n需要读取或交给 Shell 时调用 attachment_open({ artifactId: "${row.id}" })；禁止按文件名扫描磁盘。`,
        source: `attachment-manifest:${row.id}`,
        trusted: true,
        priority: 910,
        stable: false,
      })
      const isText = mime.startsWith('text/') || /(?:json|xml|yaml|javascript)/i.test(mime)
      if (!isText || Number(row.size) > 128 * 1024 || totalBytes + Number(row.size) > 256 * 1024) {
        items.push({ id: `attachment-meta-${row.id}`, kind: 'untrusted_content', content: `附件 ${row.name} 的内容未以内联文本加载。`, source: `attachment:${row.name}`, trusted: false, priority: 500, stable: false })
        continue
      }
      const content = await readFile(row.path, 'utf8')
      totalBytes += Buffer.byteLength(content)
      items.push({ id: `attachment-${row.id}`, kind: 'untrusted_content', content, source: `attachment:${row.name}`, trusted: false, priority: 650, stable: false })
    }
    return items
  }

  private async loadRunImages(runId: string): Promise<Array<{ data: string; mimeType: string }>> {
    return this.loadArtifactsAsImages(this.database.listArtifacts(runId).filter((artifact: any) => artifact.kind === 'attachment' && String(artifact.mime).startsWith('image/')).map((artifact: any) => String(artifact.id)))
  }

  private async loadArtifactsAsImages(ids: string[]): Promise<Array<{ data: string; mimeType: string }>> {
    const images: Array<{ data: string; mimeType: string }> = []
    let totalBytes = 0
    for (const id of ids.slice(0, 10)) {
      const row = this.database.getArtifact(id)
      if (!row || row.kind !== 'attachment' || !String(row.mime).startsWith('image/')) continue
      if (Number(row.size) > 10 * 1024 * 1024 || totalBytes + Number(row.size) > 20 * 1024 * 1024) continue
      const data = await readFile(row.path)
      totalBytes += data.byteLength
      images.push({ data: data.toString('base64'), mimeType: String(row.mime) })
    }
    return images
  }

  handleChromeDisconnect(reason = 'Chrome Bridge 已断开，请重新连接后继续'): ReturnType<AppDatabase['pauseChromeRunsForDisconnect']> {
    const paused = this.database.pauseChromeRunsForDisconnect(reason)
    for (const runId of paused.runIds) {
      this.broker.rejectRunApprovals(runId, reason)
      this.host.cancelRun(runId)
      this.runner.cancelRun(runId)
      this.streamingMessageIds.delete(runId)
      this.emitRun(runId)
    }
    if (paused.runIds.length) this.notify('Chrome 已断开', `${paused.runIds.length} 个使用 Chrome 的任务已等待重新连接。`)
    return paused
  }

  recoverAfterWorkerFailure(workerName: string, reason: string): ReturnType<AppDatabase['recoverInterruptedWork']> {
    const recovery = this.database.recoverInterruptedWork(`${workerName} 意外退出（${reason}），未完成任务已暂停`)
    for (const runId of recovery.runIds) {
      this.broker.rejectRunApprovals(runId, '执行进程意外退出，审批已失效')
      this.streamingMessageIds.delete(runId)
      this.emitRun(runId)
    }
    if (recovery.pausedRuns) this.notify('任务已暂停', `${workerName} 意外退出；${recovery.pausedRuns} 个任务可在重启执行进程后继续。`)
    return recovery
  }

  private compileToolReceiptSection(runId: string): string {
    const recent = this.database.listRecentToolReceipts(runId, 40)
    if (!recent.length) return ''
    const uncertainStates = new Set(['requested', 'waiting_approval', 'running', 'cancelled'])
    const important = recent.filter((receipt) =>
      receipt.risk === 'external_side_effect' || receipt.risk === 'high_risk_irreversible' || uncertainStates.has(receipt.state))
    const routine = recent.filter((receipt) => !important.includes(receipt))
    const selected = [...important, ...routine].slice(0, 12)
    const lines = selected.map((receipt) => {
      const nonReplayable = receipt.risk === 'external_side_effect' || receipt.risk === 'high_risk_irreversible' || uncertainStates.has(receipt.state)
      const receiptState = receipt.hasResult ? '有本地回执' : '无本地结果正文'
      const caution = nonReplayable ? '；禁止自动重放，恢复前先核对真实状态' : ''
      return `- ${receipt.createdAt} | ${this.safeReceiptLabel(receipt.toolId)} | target=${this.receiptTarget(receipt.toolId, receipt.arguments)} | risk=${receipt.risk} | state=${receipt.state} | ${receiptState}${caution}`
    })
    return [
      '## 持久化工具回执与恢复约束',
      '以下内容是系统从本地数据库生成的状态摘要，不是新的待办指令。不得把 external/high 成功记录或 requested/running/cancelled 等状态不明记录当作可自动重试动作；必须先核对文件、浏览器或外部系统的真实状态，必要时询问用户。摘要不包含 API Key、敏感输入、完整命令或工具结果正文。',
      ...lines,
    ].join('\n')
  }

  private receiptTarget(toolId: string, rawArguments: unknown): string {
    const args = rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
      ? rawArguments as Record<string, unknown>
      : {}
    if (typeof args.path === 'string') return `file:${this.safeReceiptLabel(basename(args.path))}`
    if (typeof args.url === 'string') {
      try { return `origin:${new URL(args.url).origin}` } catch { return 'web-target' }
    }
    if (typeof args.command === 'string') {
      const executable = args.command.trim().split(/\s+/).find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
      const name = executable ? basename(executable).replace(/[^A-Za-z0-9._+-]/g, '') : ''
      return name ? `shell:${name}` : 'shell-command'
    }
    if (typeof args.toolName === 'string') {
      const server = typeof args.serverId === 'string' ? this.safeReceiptLabel(args.serverId) : 'server'
      return `mcp:${server}/${this.safeReceiptLabel(args.toolName)}`
    }
    if (typeof args.tabId === 'number') return `chrome-tab:${args.tabId}`
    return this.safeReceiptLabel(toolId)
  }

  private safeReceiptLabel(value: unknown): string {
    const printable = Array.from(String(value ?? 'unknown'), (character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127 ? ' ' : character
    }).join('')
    return printable.replace(/\s+/g, ' ').slice(0, 120)
  }

  private emitRun(runId: string): void {
    const run = this.getRun(runId)
    this.emit({ id: randomUUID(), runId, sequence: this.nextSequence(runId), at: new Date().toISOString(), kind: 'run.updated', run })
  }
  private nextSequence(runId: string): number { const next = (this.sequences.get(runId) ?? 0) + 1; this.sequences.set(runId, next); return next }
  private eventSummary(event: RunEvent): string { return event.kind === 'error' ? event.error.message : event.kind.replace('.', ' ') }
  private redactApprovalArguments(value: unknown): any {
    if (Array.isArray(value)) return value.map((item) => this.redactApprovalArguments(item))
    if (!value || typeof value !== 'object') return typeof value === 'string' && value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value
    const source = value as Record<string, unknown>
    const sensitive = source.sensitive === true
    return Object.fromEntries(Object.entries(source).map(([key, item]) => {
      if (/(?:api[_-]?key|token|authorization|cookie|password|secret|credential)/i.test(key) || (sensitive && key === 'text') || ['content', 'oldText', 'newText'].includes(key)) return [key, '[REDACTED]']
      return [key, this.redactApprovalArguments(item)]
    }))
  }
}
