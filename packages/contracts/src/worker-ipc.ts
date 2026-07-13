import { z } from 'zod'

import {
  ApprovalGrantSchema,
  ApprovalResponseSchema,
  ContextItemSchema,
  IdSchema,
  JsonValueSchema,
  ProviderIdSchema,
  PublicErrorSchema,
  RunEventSchema,
  RunSchema,
  ToolCallSchema,
  ToolDescriptorSchema,
} from './schemas'
import type {
  ApprovalGrant,
  ApprovalResponse,
  ArtifactRef,
  ContextItem,
  JsonValue,
  ModelProfile,
  ProviderId,
  PublicError,
  Run,
  RunEvent,
  ToolCall,
  ToolDescriptor,
} from './types'

export const WORKER_PROTOCOL_VERSION = 1 as const

interface WorkerMessageBase {
  protocolVersion: typeof WORKER_PROTOCOL_VERSION
}

export interface AgentRunStartPayload {
  run: Run
  context: ContextItem[]
  tools: ToolDescriptor[]
  initialUserMessage: string
}

export interface ToolExecutionResult {
  toolCallId: string
  ok: boolean
  output?: string
  structuredContent?: JsonValue
  artifact?: ArtifactRef
  truncated: boolean
  exitCode?: number
  error?: PublicError
}

export type MainToAgentHostMessage =
  | (WorkerMessageBase & { type: 'run.start'; requestId: string; payload: AgentRunStartPayload })
  | (WorkerMessageBase & { type: 'run.user-message'; requestId: string; payload: { runId: string; content: string; attachmentIds: string[] } })
  | (WorkerMessageBase & { type: 'run.pause' | 'run.resume' | 'run.cancel'; requestId: string; payload: { runId: string } })
  | (WorkerMessageBase & { type: 'approval.resolve'; requestId: string; payload: ApprovalResponse })
  | (WorkerMessageBase & { type: 'tool.result'; requestId: string; payload: ToolExecutionResult })
  | (WorkerMessageBase & { type: 'credential.provide'; requestId: string; payload: { profileId: string; apiKey: string } })
  | (WorkerMessageBase & { type: 'shutdown'; requestId: string; payload: Record<string, never> })

export type AgentHostToMainMessage =
  | (WorkerMessageBase & { type: 'ready'; capabilities: { providers: Array<ModelProfile['provider']> } })
  | (WorkerMessageBase & { type: 'response'; requestId: string; ok: true })
  | (WorkerMessageBase & { type: 'response'; requestId: string; ok: false; error: PublicError })
  | (WorkerMessageBase & { type: 'run.event'; event: RunEvent })
  | (WorkerMessageBase & { type: 'tool.execute'; requestId: string; call: ToolCall; descriptor: ToolDescriptor })
  | (WorkerMessageBase & { type: 'credential.request'; requestId: string; profileId: string })
  | (WorkerMessageBase & { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; metadata?: JsonValue })

export interface ToolRunnerConfiguration {
  workspaceRoots: string[]
  minimalEnvironment: Record<string, string>
  maxOutputBytes: number
  defaultTimeoutMs: number
}

export type MainToToolRunnerMessage =
  | (WorkerMessageBase & { type: 'configure'; requestId: string; payload: ToolRunnerConfiguration })
  | (WorkerMessageBase & {
      type: 'tool.execute'
      requestId: string
      payload: { call: ToolCall; descriptor: ToolDescriptor; grant?: ApprovalGrant; timeoutMs?: number }
    })
  | (WorkerMessageBase & { type: 'tool.cancel'; requestId: string; payload: { toolCallId: string } })
  | (WorkerMessageBase & { type: 'shutdown'; requestId: string; payload: Record<string, never> })

export type ToolRunnerToMainMessage =
  | (WorkerMessageBase & { type: 'ready' })
  | (WorkerMessageBase & { type: 'response'; requestId: string; ok: true; result?: ToolExecutionResult })
  | (WorkerMessageBase & { type: 'response'; requestId: string; ok: false; error: PublicError })
  | (WorkerMessageBase & { type: 'tool.progress'; toolCallId: string; message: string; completedUnits?: number; totalUnits?: number })
  | (WorkerMessageBase & { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; metadata?: JsonValue })

/**
 * Runtime-compatible Pi Agent protocol. These messages mirror the concrete
 * Agent Host and Tool Runner while retaining versioning and boundary parsing.
 */
export interface PiAgentToolDescriptor {
  id: string
  label: string
  description: string
  parameters: Record<string, JsonValue>
  executionMode?: 'parallel' | 'sequential'
}

export interface PiAgentStartCommand extends WorkerMessageBase {
  type: 'start'
  runId: string
  prompt: string
  provider: ProviderId
  modelId: string
  /** Internal broker-to-host credential; never part of DesktopApi or logging. */
  apiKey: string
  systemPrompt: string
  history?: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: number; sourceRef?: string }>
  images?: Array<{ data: string; mimeType: string }>
  tools: PiAgentToolDescriptor[]
  maxTurns?: number
  timeoutMs?: number
  maxParallelReadTools?: number
  contextWindow?: number
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export type PiAgentHostCommand =
  | PiAgentStartCommand
  | (WorkerMessageBase & { type: 'cancel'; runId: string })
  | (WorkerMessageBase & { type: 'steer'; runId: string; content: string; images?: Array<{ data: string; mimeType: string }> })
  | (WorkerMessageBase & { type: 'tool.result'; requestId: string; ok: boolean; result?: JsonValue; error?: string })
  | (WorkerMessageBase & { type: 'test-provider'; requestId: string; provider: ProviderId; modelId: string; apiKey: string })

export type PiAgentEventPayload =
  | { type: 'text.delta'; delta: string }
  | { type: 'message.assistant'; content: string; usage?: JsonValue; stopReason?: string; errorMessage?: string }
  | { type: 'agent.turn'; turn: number }
  | { type: 'agent.budget_exhausted'; budget: 'model_turns' | 'duration'; message: string; turns: number }
  | { type: 'agent.checkpoint'; content: string; sourceRefs: string[]; signature: string; estimatedTokens: number }
  | { type: 'tool.started'; toolCallId: string; toolId: string; args: JsonValue }
  | { type: 'tool.progress'; toolCallId: string; toolId: string; partial: JsonValue }
  | { type: 'tool.finished'; toolCallId: string; toolId: string; isError: boolean }
  | { type: 'agent.completed'; content: string; errorMessage?: string; turns: number }
  | { type: 'agent.started'; provider: ProviderId; modelId: string }
  | { type: 'agent.failed'; error: string }

export type PiAgentHostEvent =
  | (WorkerMessageBase & { type: 'agent.event'; runId: string; event: PiAgentEventPayload })
  | (WorkerMessageBase & { type: 'tool.request'; runId: string; requestId: string; toolCallId: string; toolId: string; args: JsonValue })
  | (WorkerMessageBase & { type: 'tool.cancel'; runId: string; requestId: string })
  | (WorkerMessageBase & { type: 'test-provider.result'; requestId: string; ok: true; model: string })
  | (WorkerMessageBase & { type: 'test-provider.result'; requestId: string; ok: false; error: string })

export type ToolRunnerCommand =
  | (WorkerMessageBase & {
      type: 'execute'
      requestId: string
      runId: string
      toolId: string
      /** Runtime-schema validated JSON; `any` preserves compatibility with tool-specific handlers. */
      args: Record<string, any>
      workspacePath?: string
      /** Filesystem authorization root. Relative paths still resolve from workspacePath. */
      authorizedRoot?: string
      mcpServer?: Record<string, any>
    })
  | (WorkerMessageBase & { type: 'cancel'; requestId: string })

export type ToolRunnerEvent =
  | (WorkerMessageBase & { type: 'progress'; requestId: string; channel: 'stdout' | 'stderr'; text: string })
  | (WorkerMessageBase & { type: 'result'; requestId: string; ok: true; result: JsonValue })
  | (WorkerMessageBase & { type: 'result'; requestId: string; ok: false; error: string; code?: string; details?: JsonValue })

const ProtocolSchema = z.literal(WORKER_PROTOCOL_VERSION)
const RequestBase = { protocolVersion: ProtocolSchema, requestId: IdSchema }

export const ToolExecutionResultSchema = z
  .object({
    toolCallId: IdSchema,
    ok: z.boolean(),
    output: z.string().optional(),
    structuredContent: JsonValueSchema.optional(),
    artifact: z
      .object({
        id: IdSchema,
        runId: IdSchema.optional(),
        kind: z.enum(['tool_result', 'attachment', 'file_snapshot', 'diff', 'checkpoint', 'final_output', 'diagnostic']),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i),
        mediaType: z.string().min(1),
        byteLength: z.number().int().nonnegative(),
        displayName: z.string().min(1),
        createdAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .optional(),
    truncated: z.boolean(),
    exitCode: z.number().int().optional(),
    error: PublicErrorSchema.optional(),
  })
  .strict()

export const MainToAgentHostMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...RequestBase, type: z.literal('run.start'), payload: z.object({ run: RunSchema, context: z.array(ContextItemSchema), tools: z.array(ToolDescriptorSchema), initialUserMessage: z.string() }).strict() }).strict(),
  z.object({ ...RequestBase, type: z.literal('run.user-message'), payload: z.object({ runId: IdSchema, content: z.string(), attachmentIds: z.array(IdSchema) }).strict() }).strict(),
  z.object({ ...RequestBase, type: z.literal('run.pause'), payload: z.object({ runId: IdSchema }).strict() }).strict(),
  z.object({ ...RequestBase, type: z.literal('run.resume'), payload: z.object({ runId: IdSchema }).strict() }).strict(),
  z.object({ ...RequestBase, type: z.literal('run.cancel'), payload: z.object({ runId: IdSchema }).strict() }).strict(),
  z.object({ ...RequestBase, type: z.literal('approval.resolve'), payload: ApprovalResponseSchema }).strict(),
  z.object({ ...RequestBase, type: z.literal('tool.result'), payload: ToolExecutionResultSchema }).strict(),
  z.object({ ...RequestBase, type: z.literal('credential.provide'), payload: z.object({ profileId: IdSchema, apiKey: z.string().min(1) }).strict() }).strict(),
  z.object({ ...RequestBase, type: z.literal('shutdown'), payload: z.object({}).strict() }).strict(),
])

export const AgentHostToMainMessageSchema = z.union([
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('ready'), capabilities: z.object({ providers: z.array(ProviderIdSchema) }).strict() }).strict(),
  z.object({ ...RequestBase, type: z.literal('response'), ok: z.literal(true) }).strict(),
  z.object({ ...RequestBase, type: z.literal('response'), ok: z.literal(false), error: PublicErrorSchema }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('run.event'), event: RunEventSchema }).strict(),
  z.object({ ...RequestBase, type: z.literal('tool.execute'), call: ToolCallSchema, descriptor: ToolDescriptorSchema }).strict(),
  z.object({ ...RequestBase, type: z.literal('credential.request'), profileId: IdSchema }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('log'), level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string(), metadata: JsonValueSchema.optional() }).strict(),
])

export const ToolRunnerConfigurationSchema = z
  .object({
    workspaceRoots: z.array(z.string().min(1)).min(1),
    minimalEnvironment: z.record(z.string(), z.string()),
    maxOutputBytes: z.number().int().min(1_024),
    defaultTimeoutMs: z.number().int().min(100),
  })
  .strict()

export const MainToToolRunnerMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...RequestBase, type: z.literal('configure'), payload: ToolRunnerConfigurationSchema }).strict(),
  z.object({ ...RequestBase, type: z.literal('tool.execute'), payload: z.object({ call: ToolCallSchema, descriptor: ToolDescriptorSchema, grant: ApprovalGrantSchema.optional(), timeoutMs: z.number().int().min(100).optional() }).strict() }).strict(),
  z.object({ ...RequestBase, type: z.literal('tool.cancel'), payload: z.object({ toolCallId: IdSchema }).strict() }).strict(),
  z.object({ ...RequestBase, type: z.literal('shutdown'), payload: z.object({}).strict() }).strict(),
])

export const ToolRunnerToMainMessageSchema = z.union([
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('ready') }).strict(),
  z.object({ ...RequestBase, type: z.literal('response'), ok: z.literal(true), result: ToolExecutionResultSchema.optional() }).strict(),
  z.object({ ...RequestBase, type: z.literal('response'), ok: z.literal(false), error: PublicErrorSchema }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('tool.progress'), toolCallId: IdSchema, message: z.string(), completedUnits: z.number().nonnegative().optional(), totalUnits: z.number().positive().optional() }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('log'), level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string(), metadata: JsonValueSchema.optional() }).strict(),
])

const PiAgentToolDescriptorSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1),
    description: z.string(),
    parameters: z.record(z.string(), JsonValueSchema),
    executionMode: z.enum(['parallel', 'sequential']).optional(),
  })
  .strict()

const PiAgentEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text.delta'), delta: z.string() }).strict(),
  z.object({ type: z.literal('message.assistant'), content: z.string(), usage: JsonValueSchema.optional(), stopReason: z.string().optional(), errorMessage: z.string().optional() }).strict(),
  z.object({ type: z.literal('agent.turn'), turn: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('agent.budget_exhausted'), budget: z.enum(['model_turns', 'duration']), message: z.string().min(1), turns: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('agent.checkpoint'), content: z.string().min(1), sourceRefs: z.array(z.string().min(1)), signature: z.string().min(1), estimatedTokens: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('tool.started'), toolCallId: IdSchema, toolId: IdSchema, args: JsonValueSchema }).strict(),
  z.object({ type: z.literal('tool.progress'), toolCallId: IdSchema, toolId: IdSchema, partial: JsonValueSchema }).strict(),
  z.object({ type: z.literal('tool.finished'), toolCallId: IdSchema, toolId: IdSchema, isError: z.boolean() }).strict(),
  z.object({ type: z.literal('agent.completed'), content: z.string(), errorMessage: z.string().optional(), turns: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('agent.started'), provider: ProviderIdSchema, modelId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('agent.failed'), error: z.string() }).strict(),
])

export const PiAgentHostCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      protocolVersion: ProtocolSchema,
      type: z.literal('start'),
      runId: IdSchema,
      prompt: z.string(),
      provider: ProviderIdSchema,
      modelId: z.string().min(1),
      apiKey: z.string().min(1),
      systemPrompt: z.string(),
      history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string(), timestamp: z.number().finite().optional(), sourceRef: z.string().min(1).optional() }).strict()).optional(),
      images: z.array(z.object({ data: z.string(), mimeType: z.string().regex(/^image\//) }).strict()).max(10).optional(),
      tools: z.array(PiAgentToolDescriptorSchema),
      maxTurns: z.number().int().min(1).max(1_000).optional(),
      timeoutMs: z.number().int().min(1).optional(),
      maxParallelReadTools: z.number().int().min(1).max(64).optional(),
      contextWindow: z.number().int().positive().optional(),
      thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    })
    .strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('cancel'), runId: IdSchema }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('steer'), runId: IdSchema, content: z.string(), images: z.array(z.object({ data: z.string(), mimeType: z.string().regex(/^image\//) }).strict()).max(10).optional() }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('tool.result'), requestId: IdSchema, ok: z.boolean(), result: JsonValueSchema.optional(), error: z.string().optional() }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('test-provider'), requestId: IdSchema, provider: ProviderIdSchema, modelId: z.string().min(1), apiKey: z.string().min(1) }).strict(),
])

export const PiAgentHostEventSchema = z.union([
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('agent.event'), runId: IdSchema, event: PiAgentEventPayloadSchema }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('tool.request'), runId: IdSchema, requestId: IdSchema, toolCallId: IdSchema, toolId: IdSchema, args: JsonValueSchema }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('tool.cancel'), runId: IdSchema, requestId: IdSchema }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('test-provider.result'), requestId: IdSchema, ok: z.literal(true), model: z.string().min(1) }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('test-provider.result'), requestId: IdSchema, ok: z.literal(false), error: z.string() }).strict(),
])

export const ToolRunnerCommandSchema = z.discriminatedUnion('type', [
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('execute'), requestId: IdSchema, runId: IdSchema, toolId: IdSchema, args: z.record(z.string(), JsonValueSchema), workspacePath: z.string().min(1).optional(), authorizedRoot: z.string().min(1).optional(), mcpServer: z.record(z.string(), JsonValueSchema).optional() }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('cancel'), requestId: IdSchema }).strict(),
])

export const ToolRunnerEventSchema = z.union([
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('progress'), requestId: IdSchema, channel: z.enum(['stdout', 'stderr']), text: z.string() }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('result'), requestId: IdSchema, ok: z.literal(true), result: JsonValueSchema }).strict(),
  z.object({ protocolVersion: ProtocolSchema, type: z.literal('result'), requestId: IdSchema, ok: z.literal(false), error: z.string(), code: z.string().optional(), details: JsonValueSchema.optional() }).strict(),
])

/** Narrow helpers make the process boundary validation hard to accidentally skip. */
export function parseMainToAgentHostMessage(value: unknown): MainToAgentHostMessage {
  return MainToAgentHostMessageSchema.parse(value) as MainToAgentHostMessage
}

export function parseAgentHostToMainMessage(value: unknown): AgentHostToMainMessage {
  return AgentHostToMainMessageSchema.parse(value) as AgentHostToMainMessage
}

export function parseMainToToolRunnerMessage(value: unknown): MainToToolRunnerMessage {
  return MainToToolRunnerMessageSchema.parse(value) as MainToToolRunnerMessage
}

export function parseToolRunnerToMainMessage(value: unknown): ToolRunnerToMainMessage {
  return ToolRunnerToMainMessageSchema.parse(value) as ToolRunnerToMainMessage
}

export function parsePiAgentHostCommand(value: unknown): PiAgentHostCommand {
  return PiAgentHostCommandSchema.parse(value) as PiAgentHostCommand
}

export function parsePiAgentHostEvent(value: unknown): PiAgentHostEvent {
  return PiAgentHostEventSchema.parse(value) as PiAgentHostEvent
}

export function parseToolRunnerCommand(value: unknown): ToolRunnerCommand {
  return ToolRunnerCommandSchema.parse(value) as ToolRunnerCommand
}

export function parseToolRunnerEvent(value: unknown): ToolRunnerEvent {
  return ToolRunnerEventSchema.parse(value) as ToolRunnerEvent
}
