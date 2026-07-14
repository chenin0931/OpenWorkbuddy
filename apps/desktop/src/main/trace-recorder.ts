import { randomUUID } from 'node:crypto'
import type { AppDatabase } from './database'

export type TraceSpanKind = 'run_turn' | 'context_stage' | 'model_turn' | 'tool_call' | 'approval_wait' | 'checkpoint' | 'verification' | 'managed_process'
export type TraceSpanStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'waiting' | 'interrupted'

interface ActiveTrace {
  traceId: string
  rootSpanId: string
  modelSpanId?: string
  toolSpans: Map<string, string>
  approvalSpans: Map<string, string>
}

export class TraceRecorder {
  private readonly active = new Map<string, ActiveTrace>()

  constructor(private readonly database: AppDatabase) {}

  startTurn(runId: string, attributes: Record<string, unknown> = {}): ActiveTrace {
    this.interruptRun(runId, 'superseded_by_new_turn')
    const traceId = randomUUID()
    const rootSpanId = randomUUID()
    this.database.createRunTrace({ id: traceId, runId, rootSpanId, metadata: { version: 1 } })
    this.database.createTraceSpan({ id: rootSpanId, traceId, kind: 'run_turn', name: '用户任务轮次', attributes })
    const trace = { traceId, rootSpanId, toolSpans: new Map<string, string>(), approvalSpans: new Map<string, string>() }
    this.active.set(runId, trace)
    return trace
  }

  recordContextStages(runId: string, stages: Array<{ id: string; durationMs: number; itemCount: number; tokenEstimate?: number; warnings?: string[] }>): void {
    const trace = this.active.get(runId)
    if (!trace) return
    for (const stage of stages) {
      const id = this.database.createTraceSpan({ traceId: trace.traceId, parentSpanId: trace.rootSpanId, kind: 'context_stage', name: stage.id, attributes: { itemCount: stage.itemCount, ...(stage.tokenEstimate !== undefined ? { tokenEstimate: stage.tokenEstimate } : {}), warnings: stage.warnings ?? [] } })
      this.database.finishTraceSpan(id, stage.warnings?.length ? 'failed' : 'succeeded', { attributes: { measuredDurationMs: stage.durationMs } })
    }
  }

  startModelTurn(runId: string, turn: number): void {
    const trace = this.active.get(runId)
    if (!trace) return
    if (trace.modelSpanId) this.database.finishTraceSpan(trace.modelSpanId, 'succeeded')
    trace.modelSpanId = this.database.createTraceSpan({ traceId: trace.traceId, parentSpanId: trace.rootSpanId, kind: 'model_turn', name: `模型回合 ${turn}`, attributes: { turn } })
  }

  finishModelTurn(runId: string, usage?: Record<string, unknown>, error?: string): void {
    const trace = this.active.get(runId)
    if (!trace?.modelSpanId) return
    this.database.finishTraceSpan(trace.modelSpanId, error ? 'failed' : 'succeeded', { ...(usage ? { usage } : {}), ...(error ? { error: { message: error } } : {}) })
    delete trace.modelSpanId
  }

  startTool(runId: string, toolCallId: string, toolId: string): void {
    const trace = this.active.get(runId)
    if (!trace || trace.toolSpans.has(toolCallId)) return
    const parentSpanId = trace.modelSpanId ?? trace.rootSpanId
    const spanId = this.database.createTraceSpan({ traceId: trace.traceId, parentSpanId, kind: 'tool_call', name: toolId, attributes: { toolCallId, toolId } })
    trace.toolSpans.set(toolCallId, spanId)
  }

  finishTool(runId: string, toolCallId: string, failed: boolean): void {
    const trace = this.active.get(runId)
    const spanId = trace?.toolSpans.get(toolCallId)
    if (!trace || !spanId) return
    this.database.finishTraceSpan(spanId, failed ? 'failed' : 'succeeded')
    trace.toolSpans.delete(toolCallId)
  }

  recordCheckpoint(runId: string, attributes: Record<string, unknown>): void {
    this.recordInstant(runId, 'checkpoint', '上下文检查点', attributes)
  }

  recordVerification(runId: string, attributes: Record<string, unknown>): void {
    this.recordInstant(runId, 'verification', '完成门禁', attributes)
  }

  startApproval(runId: string, approvalId: string, attributes: Record<string, unknown>): void {
    const trace = this.active.get(runId)
    if (!trace || trace.approvalSpans.has(approvalId)) return
    const spanId = this.database.createTraceSpan({ traceId: trace.traceId, parentSpanId: trace.rootSpanId, kind: 'approval_wait', name: '等待用户确认', status: 'waiting', attributes })
    trace.approvalSpans.set(approvalId, spanId)
  }

  finishApproval(runId: string, approvalId: string, approved: boolean): void {
    const trace = this.active.get(runId)
    const spanId = trace?.approvalSpans.get(approvalId)
    if (!trace || !spanId) return
    this.database.finishTraceSpan(spanId, approved ? 'succeeded' : 'cancelled')
    trace.approvalSpans.delete(approvalId)
  }

  finishRun(runId: string, status: Exclude<TraceSpanStatus, 'running' | 'waiting'>, metadata: Record<string, unknown> = {}): void {
    const trace = this.active.get(runId)
    if (!trace) return
    if (trace.modelSpanId) this.database.finishTraceSpan(trace.modelSpanId, status)
    for (const spanId of trace.toolSpans.values()) this.database.finishTraceSpan(spanId, status)
    for (const spanId of trace.approvalSpans.values()) this.database.finishTraceSpan(spanId, status)
    this.database.finishTraceSpan(trace.rootSpanId, status, { attributes: metadata })
    this.database.finishRunTrace(trace.traceId, status, metadata)
    this.active.delete(runId)
  }

  interruptRun(runId: string, reason: string): void {
    if (this.active.has(runId)) this.finishRun(runId, 'interrupted', { reason })
    else this.database.interruptOpenTraces(runId)
  }

  private recordInstant(runId: string, kind: TraceSpanKind, name: string, attributes: Record<string, unknown>): void {
    const trace = this.active.get(runId)
    if (!trace) return
    const id = this.database.createTraceSpan({ traceId: trace.traceId, parentSpanId: trace.rootSpanId, kind, name, attributes })
    this.database.finishTraceSpan(id, 'succeeded')
  }
}
