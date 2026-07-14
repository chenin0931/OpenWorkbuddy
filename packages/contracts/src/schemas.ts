import { z } from 'zod'

import type { JsonValue } from './types'

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

export const IsoDateTimeSchema = z.string().datetime({ offset: true })
export const IdSchema = z.string().min(1).max(256)
export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'moonshotai-cn'])

export const PublicErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    suggestedAction: z.string().optional(),
    details: JsonValueSchema.optional(),
  })
  .strict()

export const ModelCapabilitiesSchema = z
  .object({
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    toolCalling: z.boolean(),
    vision: z.boolean(),
    reasoning: z.boolean(),
    promptCaching: z.boolean(),
  })
  .strict()

export const ModelProfileSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(100),
    provider: ProviderIdSchema,
    modelId: z.string().min(1).max(200),
    capabilities: ModelCapabilitiesSchema,
    keyConfigured: z.boolean(),
    isDefault: z.boolean(),
    isSubagentDefault: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()

export const ModelProfileInputSchema = z
  .object({
    id: IdSchema.optional(),
    name: z.string().trim().min(1).max(100),
    provider: ProviderIdSchema,
    modelId: z.string().trim().min(1).max(200),
    capabilities: ModelCapabilitiesSchema.partial().optional(),
  })
  .strict()

export const ModelConnectionTestSchema = z
  .object({
    ok: z.boolean(),
    provider: ProviderIdSchema,
    modelId: z.string().min(1),
    latencyMs: z.number().int().nonnegative(),
    error: PublicErrorSchema.optional(),
  })
  .strict()

export const ModelSelectionSnapshotSchema = z
  .object({
    profileId: IdSchema,
    provider: ProviderIdSchema,
    modelId: z.string().min(1),
    capabilities: ModelCapabilitiesSchema,
  })
  .strict()

export const RunStatusSchema = z.enum([
  'understanding',
  'planning',
  'running',
  'verifying',
  'waiting_approval',
  'waiting_user',
  'paused',
  'completed',
  'failed',
  'cancelled',
])
export const CompletionStatusSchema = z.enum(['verified', 'partial'])
export const RunAccessModeSchema = z.enum(['approval', 'full_disk'])
export const TaskStepStatusSchema = z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'skipped'])

export const RunLimitsSchema = z
  .object({
    maxModelTurnsPerTurn: z.number().int().min(1).max(1_000),
    maxTotalModelTurns: z.number().int().min(1).max(10_000),
    maxDurationMsPerTurn: z.number().int().min(1_000).max(7 * 24 * 60 * 60 * 1_000),
    maxTotalDurationMs: z.number().int().min(1_000).max(30 * 24 * 60 * 60 * 1_000),
    maxSubagents: z.number().int().min(0).max(32),
    maxParallelReadTools: z.number().int().min(1).max(64),
  })
  .strict()

export const RunSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    accessMode: RunAccessModeSchema,
    title: z.string().min(1).max(500),
    objective: z.string().min(1),
    status: RunStatusSchema,
    completionStatus: CompletionStatusSchema.optional(),
    model: ModelSelectionSnapshotSchema,
    limits: RunLimitsSchema,
    modelTurns: z.number().int().nonnegative(),
    startedAt: IsoDateTimeSchema.optional(),
    completedAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    lastError: PublicErrorSchema.optional(),
  })
  .strict()

export const RunSummarySchema = RunSchema.extend({ unreadEventCount: z.number().int().nonnegative() }).strict()

export const TaskStepSchema = z
  .object({
    id: IdSchema,
    runId: IdSchema,
    parentStepId: IdSchema.optional(),
    assignedAgentId: IdSchema.optional(),
    title: z.string().min(1),
    detail: z.string().optional(),
    ordinal: z.number().int().nonnegative(),
    status: TaskStepStatusSchema,
    verification: z.string().optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()

export const ConversationMessageSchema = z
  .object({
    id: IdSchema,
    runId: IdSchema,
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
    createdAt: IsoDateTimeSchema,
    artifactIds: z.array(IdSchema).optional(),
  })
  .strict()

export const ArtifactKindSchema = z.enum([
  'tool_result',
  'attachment',
  'file_snapshot',
  'diff',
  'checkpoint',
  'final_output',
  'diagnostic',
])

export const ArtifactRefSchema = z
  .object({
    id: IdSchema,
    runId: IdSchema.optional(),
    kind: ArtifactKindSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    mediaType: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    displayName: z.string().min(1),
    createdAt: IsoDateTimeSchema,
    metadata: JsonValueSchema.optional(),
  })
  .strict()

export const RiskLevelSchema = z.enum(['readonly', 'reversible_write', 'external_side_effect', 'high_risk_irreversible'])
export const PolicyEffectSchema = z.enum(['allow', 'require_approval', 'deny'])
export const ToolSourceSchema = z.enum(['builtin', 'mcp', 'skill', 'chrome'])

export const ToolAnnotationsSchema = z
  .object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    externalSideEffectHint: z.boolean().optional(),
    sendsDataOffDeviceHint: z.boolean().optional(),
  })
  .strict()

export const ToolDescriptorSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    source: ToolSourceSchema,
    serverId: IdSchema.optional(),
    inputSchema: JsonValueSchema,
    annotations: ToolAnnotationsSchema.optional(),
  })
  .strict()

export const ModelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
  })
  .strict()

export const ModelMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
    toolCallId: IdSchema.optional(),
    name: z.string().optional(),
  })
  .strict()

export const ModelAdapterRequestSchema = z
  .object({
    modelId: z.string().min(1),
    messages: z.array(ModelMessageSchema),
    tools: z.array(ToolDescriptorSchema),
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict()

export const ModelStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), delta: z.string() }).strict(),
  z.object({ type: z.literal('tool_call'), id: IdSchema, name: z.string().min(1), arguments: JsonValueSchema }).strict(),
  z.object({ type: z.literal('usage'), usage: ModelUsageSchema }).strict(),
  z.object({ type: z.literal('finish'), reason: z.enum(['stop', 'tool_calls', 'length', 'cancelled']) }).strict(),
  z.object({ type: z.literal('error'), error: PublicErrorSchema }).strict(),
])

export const ToolCallSchema = z
  .object({
    id: IdSchema,
    runId: IdSchema,
    agentId: IdSchema.optional(),
    toolName: z.string().min(1),
    source: ToolSourceSchema,
    arguments: JsonValueSchema,
    status: z.enum(['requested', 'waiting_approval', 'running', 'succeeded', 'failed', 'cancelled']),
    riskLevel: RiskLevelSchema.optional(),
    idempotent: z.boolean(),
    resultArtifactId: IdSchema.optional(),
    error: PublicErrorSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()

export const PolicyDecisionSchema = z
  .object({
    effect: PolicyEffectSchema,
    riskLevel: RiskLevelSchema,
    reason: z.string().min(1),
    ruleId: z.string().min(1),
    reversible: z.boolean(),
    idempotent: z.boolean(),
    sendsDataOffDevice: z.boolean(),
    matchedGrantId: IdSchema.optional(),
  })
  .strict()

export const ApprovalScopeSchema = z.enum(['once', 'run_tool', 'persistent_rule'])
export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'edited', 'rejected', 'expired'])

export const ApprovalRequestSchema = z
  .object({
    id: IdSchema,
    runId: IdSchema,
    toolCallId: IdSchema,
    toolName: z.string().min(1),
    riskLevel: RiskLevelSchema,
    title: z.string().min(1),
    reason: z.string(),
    target: z.string(),
    arguments: JsonValueSchema,
    sendsData: z.array(z.string()),
    reversible: z.boolean(),
    status: ApprovalStatusSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.optional(),
  })
  .strict()

export const ApprovalGrantSchema = z
  .object({
    id: IdSchema,
    runId: IdSchema.optional(),
    toolName: z.string().min(1),
    scope: ApprovalScopeSchema,
    argumentFingerprint: z.string().optional(),
    approvedArguments: JsonValueSchema.optional(),
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.optional(),
    revokedAt: IsoDateTimeSchema.optional(),
  })
  .strict()

export const ApprovalResponseSchema = z
  .object({
    requestId: IdSchema,
    decision: z.enum(['approve', 'edit', 'reject']),
    scope: z.enum(['once', 'run_tool']).optional(),
    editedArguments: JsonValueSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === 'edit' && value.editedArguments === undefined) {
      context.addIssue({ code: 'custom', path: ['editedArguments'], message: 'editedArguments is required when decision is edit' })
    }
    if (value.decision === 'approve' && value.scope === undefined) {
      context.addIssue({ code: 'custom', path: ['scope'], message: 'scope is required when approving' })
    }
  })

export const ContextKindSchema = z.enum([
  'platform_contract',
  'user_preferences',
  'workspace_rules',
  'skill',
  'task',
  'environment',
  'memory',
  'tool_result',
  'untrusted_content',
  'checkpoint',
])

export const ContextItemSchema = z
  .object({
    id: IdSchema,
    kind: ContextKindSchema,
    content: z.string(),
    source: z.string(),
    trusted: z.boolean(),
    priority: z.number().finite(),
    stable: z.boolean(),
    tokenEstimate: z.number().int().nonnegative().optional(),
    createdAt: IsoDateTimeSchema.optional(),
  })
  .strict()

export const MemorySourceSchema = z
  .object({
    kind: z.enum(['run', 'message', 'file', 'user']),
    reference: z.string().min(1),
    excerpt: z.string().optional(),
  })
  .strict()

export const MemoryEntrySchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema.optional(),
    type: z.enum(['stable_fact', 'knowledge_background', 'behavior_signal', 'style_preference', 'continuation']),
    scope: z.enum(['thread', 'workspace', 'user', 'organization']),
    state: z.enum(['proposed', 'confirmed', 'disabled', 'deleted']),
    content: z.string().min(1),
    confidence: z.number().min(0).max(1),
    sources: z.array(MemorySourceSchema).min(1),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    confirmedAt: IsoDateTimeSchema.optional(),
    disabledAt: IsoDateTimeSchema.optional(),
  })
  .strict()

export const SkillPermissionSchema = z
  .object({
    capability: z.enum(['filesystem_read', 'filesystem_write', 'shell', 'network', 'browser', 'mcp']),
    detail: z.string().optional(),
  })
  .strict()

export const SkillManifestSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    description: z.string(),
    version: z.string().min(1),
    directory: z.string().min(1),
    enabled: z.boolean(),
    permissions: z.array(SkillPermissionSchema),
    entrypoint: z.string().min(1),
    loadedAt: IsoDateTimeSchema.optional(),
  })
  .strict()

export const McpTransportSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()), envKeys: z.array(z.string()) }).strict(),
  z
    .object({
      type: z.literal('streamable_http'),
      url: z.string().url(),
      auth: z.enum(['none', 'bearer', 'headers', 'oauth']),
      secretConfigured: z.boolean(),
    })
    .strict(),
])

export const McpServerConfigSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    enabled: z.boolean(),
    transport: McpTransportSchema,
    toolNamespace: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
    serverVersion: z.string().optional(),
    schemaFingerprint: z.string().optional(),
    health: z.enum(['unknown', 'healthy', 'unhealthy', 'authorizing']),
    lastCheckedAt: IsoDateTimeSchema.optional(),
    lastError: PublicErrorSchema.optional(),
  })
  .strict()

export const AutomationScheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('once'), runAt: IsoDateTimeSchema }).strict(),
  z.object({ type: z.literal('interval'), everyMs: z.number().int().min(60_000), startsAt: IsoDateTimeSchema.optional() }).strict(),
  z.object({ type: z.literal('cron'), expression: z.string().min(5), timezone: z.string().min(1) }).strict(),
])

export const AutomationSpecSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    name: z.string().min(1),
    enabled: z.boolean(),
    objective: z.string().min(1),
    modelProfileId: IdSchema,
    schedule: AutomationScheduleSchema,
    normalizedSchedule: z.string(),
    nextRunAt: IsoDateTimeSchema.optional(),
    lastRunAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()

export const ChromeTabGrantSchema = z
  .object({
    id: IdSchema,
    runId: IdSchema,
    tabId: z.number().int().nonnegative(),
    windowId: z.number().int().nonnegative(),
    origin: z.string(),
    title: z.string(),
    grantedAt: IsoDateTimeSchema,
    childTabIds: z.array(z.number().int().nonnegative()),
    revokedAt: IsoDateTimeSchema.optional(),
  })
  .strict()

export const ChromeBridgeStatusSchema = z
  .object({
    extensionInstalled: z.boolean(),
    nativeHostInstalled: z.boolean(),
    connected: z.boolean(),
    version: z.string().optional(),
    lastSeenAt: IsoDateTimeSchema.optional(),
  })
  .strict()

export const WorkspaceSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    path: z.string().min(1),
    selected: z.boolean(),
    rules: z.string().optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()

export const AppSettingsSchema = z
  .object({
    locale: z.string().min(2),
    theme: z.enum(['system', 'light', 'dark']),
    defaultExecutionMode: z.enum(['plan', 'execute']),
    defaultAccessMode: RunAccessModeSchema,
    permissionMode: z.enum(['cautious', 'balanced', 'autonomous']),
    defaultModelProfileId: IdSchema.optional(),
    subagentModelProfileId: IdSchema.optional(),
    launchAtLogin: z.boolean(),
    memoryEnabled: z.boolean(),
    detailedLogRetentionDays: z.number().int().min(1).max(3650),
    detailedLogMaxBytes: z.number().int().min(1_000_000),
    defaultRunLimits: RunLimitsSchema,
    timezone: z.string().min(1),
  })
  .strict()

export const AuditEntrySchema = z
  .object({
    id: IdSchema,
    runId: IdSchema.optional(),
    actor: z.enum(['user', 'agent', 'system', 'tool']),
    action: z.string().min(1),
    target: z.string().optional(),
    outcome: z.enum(['started', 'allowed', 'blocked', 'approved', 'rejected', 'succeeded', 'failed']),
    summary: z.string(),
    riskLevel: RiskLevelSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
    tokenUsage: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), cached: z.number().int().nonnegative() }).strict().optional(),
    artifactIds: z.array(IdSchema).optional(),
    error: PublicErrorSchema.optional(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()

export const VerificationSummarySchema = z
  .object({
    status: CompletionStatusSchema,
    checks: z.array(
      z.object({ name: z.string().min(1), status: z.enum(['passed', 'failed', 'not_run']), detail: z.string().optional() }).strict(),
    ),
    summary: z.string(),
  })
  .strict()

export const SourceRefSchema = z
  .object({
    title: z.string().min(1).max(500),
    url: z.string().url().max(4_096).superRefine((value, context) => {
      try {
        const url = new URL(value)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
          context.addIssue({ code: 'custom', message: 'Source URL must be credential-free HTTP(S)' })
        }
        if (/^(?:localhost|\[[^\]]+]|\d{1,3}(?:\.\d{1,3}){3})$/i.test(url.hostname) || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) {
          context.addIssue({ code: 'custom', message: 'Source URL must use a public hostname' })
        }
      } catch {
        context.addIssue({ code: 'custom', message: 'Invalid source URL' })
      }
    }),
    domain: z.string().min(1).max(255).optional(),
    snippet: z.string().max(240).optional(),
    fetchedAt: IsoDateTimeSchema.optional(),
    status: z.enum(['discovered', 'fetched', 'failed']).optional(),
  })
  .strict()

export const ToolReceiptSchema = z
  .object({
    id: IdSchema,
    runId: IdSchema,
    toolName: z.string().min(1),
    status: z.enum(['requested', 'waiting_approval', 'running', 'succeeded', 'failed', 'cancelled']),
    riskLevel: RiskLevelSchema,
    argumentsSummary: JsonValueSchema,
    resultSummary: z.string().max(2_000).optional(),
    sources: z.array(SourceRefSchema).max(20),
    error: PublicErrorSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()

export const ApprovalHistoryEntrySchema = ApprovalRequestSchema.extend({
  scope: z.enum(['once', 'run_tool']).optional(),
  resolvedAt: IsoDateTimeSchema.optional(),
}).strict()

export const RunProgressSchema = z.object({
  phase: z.enum(['thinking', 'composing_tool', 'executing', 'verifying']),
  message: z.string().min(1).max(500),
  toolName: z.string().min(1).max(200).optional(),
  generatedChars: z.number().int().nonnegative().optional(),
  updatedAt: IsoDateTimeSchema,
}).strict()

export const TraceSpanStatusSchema = z.enum(['running', 'succeeded', 'failed', 'cancelled', 'waiting', 'interrupted'])
export const RunTraceSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  rootSpanId: IdSchema,
  status: TraceSpanStatusSchema,
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.optional(),
  metadata: JsonValueSchema,
}).strict()
export const TraceSpanSchema = z.object({
  id: IdSchema,
  traceId: IdSchema,
  parentSpanId: IdSchema.optional(),
  kind: z.enum(['run_turn', 'context_stage', 'model_turn', 'tool_call', 'approval_wait', 'checkpoint', 'verification', 'managed_process']),
  name: z.string().min(1),
  status: TraceSpanStatusSchema,
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  usage: JsonValueSchema.optional(),
  error: JsonValueSchema.optional(),
  attributes: JsonValueSchema,
  artifactIds: z.array(IdSchema),
}).strict()

export const RunDetailSchema = z
  .object({
    run: RunSchema,
    steps: z.array(TaskStepSchema),
    messages: z.array(ConversationMessageSchema),
    pendingApprovals: z.array(ApprovalRequestSchema),
    toolCalls: z.array(ToolReceiptSchema),
    approvalHistory: z.array(ApprovalHistoryEntrySchema),
    artifacts: z.array(ArtifactRefSchema),
    verification: VerificationSummarySchema.optional(),
    progress: RunProgressSchema.optional(),
    traces: z.array(RunTraceSchema).optional(),
    traceSpans: z.array(TraceSpanSchema).optional(),
  })
  .strict()

const RunEventBaseSchema = z.object({ id: IdSchema, runId: IdSchema, sequence: z.number().int().nonnegative(), at: IsoDateTimeSchema })
export const RunEventSchema = z.discriminatedUnion('kind', [
  RunEventBaseSchema.extend({ kind: z.literal('run.updated'), run: RunSchema }).strict(),
  RunEventBaseSchema.extend({ kind: z.literal('message.delta'), messageId: IdSchema, delta: z.string() }).strict(),
  RunEventBaseSchema.extend({ kind: z.literal('message.completed'), message: ConversationMessageSchema }).strict(),
  RunEventBaseSchema.extend({ kind: z.literal('step.updated'), step: TaskStepSchema }).strict(),
  RunEventBaseSchema.extend({ kind: z.literal('tool.updated'), toolCall: ToolCallSchema }).strict(),
  RunEventBaseSchema.extend({ kind: z.literal('approval.requested'), approval: ApprovalRequestSchema }).strict(),
  RunEventBaseSchema.extend({ kind: z.literal('artifact.created'), artifact: ArtifactRefSchema }).strict(),
  RunEventBaseSchema.extend({ kind: z.literal('verification.completed'), verification: VerificationSummarySchema }).strict(),
  RunEventBaseSchema.extend({ kind: z.literal('progress.updated'), progress: RunProgressSchema }).strict(),
  RunEventBaseSchema.extend({ kind: z.literal('error'), error: PublicErrorSchema }).strict(),
])

export const BootstrapSnapshotSchema = z
  .object({
    app: z.object({ name: z.string(), version: z.string(), platform: z.string(), arch: z.string(), locale: z.string() }).strict(),
    onboardingComplete: z.boolean(),
    settings: AppSettingsSchema,
    selectedWorkspaceId: IdSchema.optional(),
    workspaces: z.array(WorkspaceSchema),
    modelProfiles: z.array(ModelProfileSchema),
    chrome: ChromeBridgeStatusSchema,
  })
  .strict()

export const PageRequestSchema = z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }).strict()
