import { createHash, randomUUID } from 'node:crypto'
import type { ModelProfile, RunAccessMode, RunDetail, RunEvent } from '@onmyworkbuddy/contracts'
import type { AppDatabase } from './database'
import type { ArtifactStore } from './artifact-store'
import type { SecretStore } from './secret-store'
import type { ToolBroker } from './tool-broker'
import { DEFAULT_LIMITS, modelSnapshot, normalizeRunLimits, presentArtifact, presentModel, presentRun, presentRunDetail } from './presenters'
import type { AgentHostBridge, ToolRunnerBridge } from './worker-bridge'
import { buildDurableCheckpoint } from './context-checkpoint'
import { RunPreparationPipeline } from './run-preparation-pipeline'
import { TraceRecorder } from './trace-recorder'

const ACTIVE_RUN_STATUSES = new Set(['understanding', 'planning', 'running', 'verifying', 'waiting_approval'])
const IGNORE_LATE_AGENT_EVENT_STATUSES = new Set(['waiting_user', 'paused', 'completed', 'failed', 'cancelled'])
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const STARTABLE_RUN_STATUSES = new Set(['understanding', 'paused', 'waiting_user'])

export class RunCoordinator {
  private sequences = new Map<string, number>()
  private streamingMessageIds = new Map<string, string>()
  private completionWaiters = new Map<string, Array<(run: any) => void>>()
  private lastPersistedProgressAt = new Map<string, number>()
  private lastPersistedProgressSignature = new Map<string, string>()
  private preparation: RunPreparationPipeline
  private traces: TraceRecorder

  constructor(
    private database: AppDatabase,
    private secrets: SecretStore,
    private host: AgentHostBridge,
    private runner: ToolRunnerBridge,
    private broker: ToolBroker,
    private artifacts: ArtifactStore,
    private broadcast: (event: RunEvent) => void,
    private notify: (title: string, body: string) => void,
  ) {
    this.preparation = new RunPreparationPipeline(database, artifacts, (runId, checkpoint) => this.persistContextCheckpoint(runId, checkpoint))
    this.traces = new TraceRecorder(database)
  }

  emit = (event: RunEvent): void => {
    const persistedEvent = event.kind === 'approval.requested'
      ? { ...event, approval: { ...event.approval, arguments: this.redactApprovalArguments(event.approval.arguments) } }
      : event
    this.database.appendRunEvent(event.runId, event.kind, this.eventSummary(event), persistedEvent as any)
    this.broadcast(event)
    if (event.kind === 'approval.requested') {
      this.traces.startApproval(event.runId, event.approval.id, { toolName: event.approval.toolName, riskLevel: event.approval.riskLevel })
      this.notify('任务等待批准', `${event.approval.title}。打开 OpenWorkbuddy 查看详情。`)
    }
    if (event.kind === 'verification.completed') this.traces.recordVerification(event.runId, { status: event.verification.status, checks: event.verification.checks.length })
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
      const effectivePrompt = prompt ?? (raw.status === 'paused' || raw.status === 'waiting_user' ? '继续此前任务。先核对当前文件、持久化工具回执和任务状态，再从未完成项继续；不得自动重放外部副作用或高风险动作。' : raw.prompt)
      this.traces.startTurn(runId, { reason: prompt === undefined ? 'resume' : 'user_message', accessMode: raw.accessMode ?? 'approval' })
      const prepared = await this.preparation.prepare({ run: raw, profile, workspace, effectivePrompt })
      this.traces.recordContextStages(runId, prepared.stageDiagnostics)
      this.database.appendRunEvent(runId, 'context.pipeline_completed', '上下文 Pipeline 已完成', {
        contextStats: prepared.contextStats,
        stages: prepared.stageDiagnostics,
      })
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
        systemPrompt: prepared.systemPrompt,
        history: prepared.history,
        ...(prepared.images.length ? { images: prepared.images } : {}),
        tools: prepared.tools,
        toolReceipts: prepared.toolReceipts,
        maxTurns: remainingTurns,
        timeoutMs: Math.max(1, Math.ceil(remainingDurationMs)),
        maxParallelReadTools: limits.maxParallelReadTools,
        contextWindow: profile.capabilities.contextWindow,
        thinkingLevel: profile.capabilities.reasoning ? 'medium' : 'off',
      })
    } catch (error) {
      this.traces.finishRun(runId, 'failed', { error: error instanceof Error ? error.message : String(error) })
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
    const images = await this.preparation.loadArtifactsAsImages(attachmentIds)
    if (['running', 'planning', 'verifying', 'waiting_approval'].includes(raw.status)) {
      if (raw.outcome === 'verified' || raw.outcome === 'partial') {
        this.database.transitionRun(runId, 'running', { outcome: null, summary: '', error: null, finishedAt: null })
        this.database.markRunTurnStarted(runId, 'follow_up')
        this.emitRun(runId)
      }
      const runtimeAuthority = accessModeChanged
        ? `<runtime-authority source="OpenWorkbuddy" trusted="true">工作权限已切换为 ${raw.accessMode === 'full_disk' ? '完全访问；授权根为 /，相对路径仍以当前工作区为基准；普通读取、公开网页 GET/搜索、可逆写入和常规本地命令自动执行；删除、发送、发布、支付、上传、表单提交、凭据访问和未知外部副作用仍需单次确认' : '请求批准；授权根恢复为当前工作区；需要审批的操作必须等待用户处理'}。macOS TCC、只读子 Agent 与产品硬拒绝边界仍然有效。</runtime-authority>\n\n`
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
    this.database.interruptManagedProcesses(runId)
    this.database.finishRunTurn(runId, 'cancelled')
    this.database.transitionRun(runId, 'paused', { outcome: null, finishedAt: null })
    this.database.cancelPendingRunWork(runId, '任务已暂停；未完成工具和审批已失效')
    this.broker.rejectRunApprovals(runId, '任务已暂停；审批已失效')
    this.clearTransientEventState(runId)
    this.traces.finishRun(runId, 'cancelled', { reason: 'user_paused' })
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
    this.database.interruptManagedProcesses(runId)
    this.database.stopRunExecution(runId)
    this.database.transitionRun(runId, 'cancelled', { outcome: null, error: null, finishedAt: new Date().toISOString() })
    this.database.cancelPendingRunWork(runId, '任务已取消')
    this.broker.rejectRunApprovals(runId)
    this.clearTransientEventState(runId)
    this.traces.finishRun(runId, 'cancelled', { reason: 'user_cancelled' })
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
      this.traces.startModelTurn(runId, cumulativeTurns)
      this.emitRun(runId)
      return
    }
    if (event.type === 'agent.checkpoint') {
      await this.persistContextCheckpoint(runId, event)
      this.traces.recordCheckpoint(runId, { estimatedTokens: event.estimatedTokens, sourceCount: event.sourceRefs.length, signature: event.signature })
      return
    }
    // Abort/cancel and bridge-disconnect events race with worker event delivery.
    // Once the durable state says execution is no longer active, all late text,
    // tool and terminal events are ignored rather than mutating the checkpoint.
    if (IGNORE_LATE_AGENT_EVENT_STATUSES.has(current.status)) return
    if (event.type === 'agent.progress') {
      const at = new Date().toISOString()
      const progressEvent: RunEvent = {
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
      }
      const signature = JSON.stringify([event.phase, event.message, event.toolName ?? ''])
      const now = Date.now()
      const shouldPersist = signature !== this.lastPersistedProgressSignature.get(runId)
        || now - (this.lastPersistedProgressAt.get(runId) ?? 0) >= 2_500
      if (shouldPersist) {
        this.lastPersistedProgressAt.set(runId, now)
        this.lastPersistedProgressSignature.set(runId, signature)
        this.emit(progressEvent)
      } else {
        this.broadcast(progressEvent)
      }
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
      this.traces.finishModelTurn(runId, event.usage, event.errorMessage)
      const content = typeof event.content === 'string' ? event.content : ''
      if (!content.trim()) return
      const messageId = this.database.addMessage(runId, 'assistant', content, { usage: event.usage, stopReason: event.stopReason })
      const message = { id: messageId, runId, role: 'assistant' as const, content: event.content, createdAt: new Date().toISOString() }
      this.emit({ id: randomUUID(), runId, sequence: this.nextSequence(runId), at: new Date().toISOString(), kind: 'message.completed', message })
      return
    }
    if (event.type === 'tool.started') {
      this.traces.startTool(runId, event.toolCallId, event.toolId)
      this.database.appendRunEvent(runId, event.type, `开始执行 ${event.toolId}`, event)
      return
    }
    if (event.type === 'tool.finished') {
      this.traces.finishTool(runId, event.toolCallId, Boolean(event.isError))
      this.database.appendRunEvent(runId, event.type, `${event.toolId} ${event.isError ? '失败' : '完成'}`, event, event.isError ? 'warning' : 'info')
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
      this.traces.finishRun(runId, failed ? 'failed' : 'succeeded', { outcome: this.database.getRun(runId)?.outcome ?? null, turns: event.turns })
      this.clearTransientEventState(runId)
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
      this.traces.finishRun(runId, 'failed', { error: event.error })
      this.clearTransientEventState(runId)
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
    this.traces.finishRun(runId, 'interrupted', { reason: 'budget_exhausted', budget, scope: resolvedScope })
    this.database.appendRunEvent(runId, 'run.budget_exhausted', message, {
      budget,
      scope: resolvedScope,
      limits,
      usage: this.database.getRunBudgetUsage(runId),
      turnUsage: turnUsageBeforeFinish,
    }, 'warning')
    this.emitRun(runId)
    this.clearTransientEventState(runId)
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

  handleChromeDisconnect(reason = 'Chrome Bridge 已断开，请重新连接后继续'): ReturnType<AppDatabase['pauseChromeRunsForDisconnect']> {
    const paused = this.database.pauseChromeRunsForDisconnect(reason)
    for (const runId of paused.runIds) {
      this.broker.rejectRunApprovals(runId, reason)
      this.host.cancelRun(runId)
      this.runner.cancelRun(runId)
      this.database.interruptManagedProcesses(runId)
      this.streamingMessageIds.delete(runId)
      this.clearTransientEventState(runId)
      this.traces.finishRun(runId, 'interrupted', { reason: 'chrome_disconnected' })
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
      this.clearTransientEventState(runId)
      this.traces.interruptRun(runId, `${workerName}:${reason}`)
      this.database.interruptManagedProcesses(runId)
      this.emitRun(runId)
    }
    if (recovery.pausedRuns) this.notify('任务已暂停', `${workerName} 意外退出；${recovery.pausedRuns} 个任务可在重启执行进程后继续。`)
    return recovery
  }

  private emitRun(runId: string): void {
    const run = this.getRun(runId)
    this.emit({ id: randomUUID(), runId, sequence: this.nextSequence(runId), at: new Date().toISOString(), kind: 'run.updated', run })
  }
  private clearTransientEventState(runId: string): void {
    this.streamingMessageIds.delete(runId)
    this.lastPersistedProgressAt.delete(runId)
    this.lastPersistedProgressSignature.delete(runId)
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
