import { z } from 'zod'

import {
  AppSettingsSchema,
  ApprovalGrantSchema,
  ApprovalResponseSchema,
  ArtifactRefSchema,
  AuditEntrySchema,
  AutomationScheduleSchema,
  AutomationSpecSchema,
  BootstrapSnapshotSchema,
  ChromeBridgeStatusSchema,
  ChromeTabGrantSchema,
  IdSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  McpServerConfigSchema,
  McpTransportSchema,
  MemoryEntrySchema,
  ModelConnectionTestSchema,
  ProviderIdSchema,
  ModelProfileInputSchema,
  ModelProfileSchema,
  PageRequestSchema,
  RunDetailSchema,
  RunEventSchema,
  RunLimitsSchema,
  RunSchema,
  RunStatusSchema,
  RunSummarySchema,
  SkillManifestSchema,
  WorkspaceSchema,
} from './schemas'
import type {
  AppSettings,
  ApprovalGrant,
  ApprovalResponse,
  ArtifactRef,
  AuditEntry,
  AutomationSchedule,
  AutomationSpec,
  BootstrapSnapshot,
  ChromeBridgeStatus,
  ChromeTabGrant,
  JsonValue,
  McpServerConfig,
  McpTransport,
  MemoryEntry,
  MemoryScope,
  MemoryType,
  ModelConnectionTest,
  ProviderId,
  ModelProfile,
  ModelProfileInput,
  Page,
  PageRequest,
  Run,
  RunDetail,
  RunEvent,
  RunLimits,
  RunSummary,
  SkillManifest,
  Workspace,
} from './types'

export const DESKTOP_API_VERSION = 1 as const

export interface AppInfo {
  name: string
  version: string
  platform: string
  arch: string
  locale: string
}

export interface CreateWorkspaceInput {
  path: string
  name?: string
}

export interface UpdateWorkspaceInput {
  id: string
  name?: string
  rules?: string
}

export interface CreateRunInput {
  workspaceId: string
  objective: string
  mode?: 'plan' | 'execute'
  title?: string
  modelProfileId?: string
  attachmentIds?: string[]
  limits?: Partial<RunLimits>
}

export interface SendRunMessageInput {
  runId: string
  content: string
  attachmentIds?: string[]
}

export interface ModelDefaultsInput {
  defaultModelProfileId: string
  subagentModelProfileId?: string
}

export interface ModelCatalogItem {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens: number
  vision: boolean
  reasoning: boolean
}

export interface PersistentGrantInput {
  workspaceId: string
  toolName: 'file.write' | 'file.edit'
  path: string
  expiresAt?: string
}

export interface CapabilityPackagePreview {
  selectionId: string
  name: string
  version: string
  directory: string
  skills: string[]
  mcpConfigs: JsonValue[]
  rules: string[]
  templates: Array<{ path: string; size: number; sha256: string }>
  fileCount: number
  totalBytes: number
}

export interface InstalledCapabilityPackage {
  id: string
  name: string
  version: string
  workspaceId?: string
  skillIds: string[]
  mcpServerIds: string[]
  ruleSources: string[]
  templatePaths: string[]
  installedAt: string
}

export interface MemoryProposalInput {
  workspaceId?: string
  type: MemoryType
  scope: MemoryScope
  content: string
  confidence: number
  source: { kind: 'run' | 'message' | 'file' | 'user'; reference: string; excerpt?: string }
}

export interface McpServerInput {
  id?: string
  name: string
  enabled: boolean
  transport: McpTransport
  toolNamespace: string
}

export interface McpConnectionTest {
  ok: boolean
  latencyMs: number
  serverVersion?: string
  toolCount?: number
  error?: { code: string; message: string; retryable: boolean }
}

export interface SkillDetail {
  manifest: SkillManifest
  instructions: string
  referenceFiles: string[]
  scriptFiles: string[]
}

export interface AutomationInput {
  id?: string
  workspaceId: string
  name: string
  enabled: boolean
  objective: string
  modelProfileId: string
  schedule: AutomationSchedule
}

export interface AuditQuery extends PageRequest {
  runId?: string
  outcome?: AuditEntry['outcome']
  since?: string
}

export interface DiagnosticExportResult {
  path: string
  entryCount: number
  redacted: boolean
}

export interface ArtifactText {
  artifact: ArtifactRef
  text: string
  truncated: boolean
}

export interface ArtifactRestoreResult {
  restored: true
  path: string
  createdFileRemoved: boolean
}

/**
 * Public renderer bridge. It intentionally exposes individual methods rather
 * than a generic IPC primitive, and never exposes an API key read method.
 */
export interface DesktopApi {
  readonly apiVersion: typeof DESKTOP_API_VERSION
  bootstrap(): Promise<BootstrapSnapshot>
  app: {
    getInfo(): Promise<AppInfo>
    chooseWorkspace(): Promise<string | null>
    chooseFiles(): Promise<string[]>
    importAttachments(): Promise<ArtifactRef[]>
    revealPath(input: { path: string }): Promise<void>
  }
  workspaces: {
    list(): Promise<Workspace[]>
    create(input: CreateWorkspaceInput): Promise<Workspace>
    update(input: UpdateWorkspaceInput): Promise<Workspace>
    remove(input: { id: string }): Promise<void>
    select(input: { id: string }): Promise<Workspace>
  }
  runs: {
    list(input?: PageRequest & { workspaceId?: string; status?: Run['status'] }): Promise<Page<RunSummary>>
    get(input: { id: string }): Promise<RunDetail>
    create(input: CreateRunInput): Promise<RunDetail>
    sendMessage(input: SendRunMessageInput): Promise<void>
    pause(input: { id: string }): Promise<Run>
    resume(input: { id: string }): Promise<Run>
    cancel(input: { id: string }): Promise<Run>
    remove(input: { id: string }): Promise<void>
    respondToApproval(input: ApprovalResponse): Promise<void>
  }
  models: {
    list(): Promise<ModelProfile[]>
    catalog(input: { provider: ProviderId }): Promise<ModelCatalogItem[]>
    upsert(input: ModelProfileInput): Promise<ModelProfile>
    remove(input: { id: string }): Promise<void>
    setSecret(input: { profileId: string; apiKey: string }): Promise<void>
    deleteSecret(input: { profileId: string }): Promise<void>
    test(input: { profileId: string }): Promise<ModelConnectionTest>
    setDefaults(input: ModelDefaultsInput): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    update(input: Partial<AppSettings>): Promise<AppSettings>
  }
  permissions: {
    listPersistent(): Promise<ApprovalGrant[]>
    createPersistent(input: PersistentGrantInput): Promise<ApprovalGrant>
    removePersistent(input: { id: string }): Promise<void>
  }
  capabilityPackages: {
    choose(): Promise<CapabilityPackagePreview | null>
    install(input: { selectionId: string; workspaceId?: string }): Promise<InstalledCapabilityPackage>
    list(): Promise<InstalledCapabilityPackage[]>
  }
  memory: {
    list(input?: { workspaceId?: string; state?: MemoryEntry['state']; scope?: MemoryScope }): Promise<MemoryEntry[]>
    propose(input: MemoryProposalInput): Promise<MemoryEntry>
    confirm(input: { id: string }): Promise<MemoryEntry>
    disable(input: { id: string }): Promise<MemoryEntry>
    remove(input: { id: string }): Promise<void>
  }
  mcp: {
    list(): Promise<McpServerConfig[]>
    upsert(input: McpServerInput & { secrets?: Record<string, string> }): Promise<McpServerConfig>
    remove(input: { id: string }): Promise<void>
    test(input: { id: string }): Promise<McpConnectionTest>
    startOAuth(input: { id: string }): Promise<{ authorizationUrl: string; state: string }>
    completeOAuth(input: { id: string; callbackUrl: string; state: string }): Promise<McpServerConfig>
  }
  skills: {
    list(): Promise<SkillManifest[]>
    get(input: { id: string }): Promise<SkillDetail>
    import(input: { directory: string }): Promise<SkillManifest>
    remove(input: { id: string }): Promise<void>
    setEnabled(input: { id: string; enabled: boolean }): Promise<SkillManifest>
  }
  automations: {
    list(input?: { workspaceId?: string }): Promise<AutomationSpec[]>
    upsert(input: AutomationInput): Promise<AutomationSpec>
    remove(input: { id: string }): Promise<void>
    setEnabled(input: { id: string; enabled: boolean }): Promise<AutomationSpec>
    runNow(input: { id: string }): Promise<RunDetail>
  }
  chrome: {
    getStatus(): Promise<ChromeBridgeStatus>
    listGrants(input?: { runId?: string }): Promise<ChromeTabGrant[]>
    requestBinding(input: { runId: string }): Promise<{ requested: true }>
    revokeGrant(input: { id: string }): Promise<void>
  }
  audit: {
    list(input?: AuditQuery): Promise<Page<AuditEntry>>
    exportDiagnostics(input?: { runId?: string }): Promise<DiagnosticExportResult | null>
  }
  artifacts: {
    getText(input: { id: string; maxBytes?: number }): Promise<ArtifactText>
    reveal(input: { id: string }): Promise<void>
    undoChange(input: { id: string }): Promise<ArtifactRestoreResult>
  }
  events: {
    subscribe(listener: (event: RunEvent) => void): () => void
  }
}

/** Compile-time channel map used by preload and ipcMain handlers. */
export interface DesktopInvokeMap {
  'bootstrap': { input: undefined; output: BootstrapSnapshot }
  'app:get-info': { input: undefined; output: AppInfo }
  'app:choose-workspace': { input: undefined; output: string | null }
  'app:choose-files': { input: undefined; output: string[] }
  'app:import-attachments': { input: undefined; output: ArtifactRef[] }
  'app:reveal-path': { input: { path: string }; output: undefined }
  'workspaces:list': { input: undefined; output: Workspace[] }
  'workspaces:create': { input: CreateWorkspaceInput; output: Workspace }
  'workspaces:update': { input: UpdateWorkspaceInput; output: Workspace }
  'workspaces:remove': { input: { id: string }; output: undefined }
  'workspaces:select': { input: { id: string }; output: Workspace }
  'runs:list': { input: (PageRequest & { workspaceId?: string; status?: Run['status'] }) | undefined; output: Page<RunSummary> }
  'runs:get': { input: { id: string }; output: RunDetail }
  'runs:create': { input: CreateRunInput; output: RunDetail }
  'runs:send-message': { input: SendRunMessageInput; output: undefined }
  'runs:pause': { input: { id: string }; output: Run }
  'runs:resume': { input: { id: string }; output: Run }
  'runs:cancel': { input: { id: string }; output: Run }
  'runs:remove': { input: { id: string }; output: undefined }
  'runs:respond-approval': { input: ApprovalResponse; output: undefined }
  'models:list': { input: undefined; output: ModelProfile[] }
  'models:catalog': { input: { provider: ProviderId }; output: ModelCatalogItem[] }
  'models:upsert': { input: ModelProfileInput; output: ModelProfile }
  'models:remove': { input: { id: string }; output: undefined }
  'models:set-secret': { input: { profileId: string; apiKey: string }; output: undefined }
  'models:delete-secret': { input: { profileId: string }; output: undefined }
  'models:test': { input: { profileId: string }; output: ModelConnectionTest }
  'models:set-defaults': { input: ModelDefaultsInput; output: undefined }
  'settings:get': { input: undefined; output: AppSettings }
  'settings:update': { input: Partial<AppSettings>; output: AppSettings }
  'permissions:list-persistent': { input: undefined; output: ApprovalGrant[] }
  'permissions:create-persistent': { input: PersistentGrantInput; output: ApprovalGrant }
  'permissions:remove-persistent': { input: { id: string }; output: undefined }
  'capability-packages:choose': { input: undefined; output: CapabilityPackagePreview | null }
  'capability-packages:install': { input: { selectionId: string; workspaceId?: string }; output: InstalledCapabilityPackage }
  'capability-packages:list': { input: undefined; output: InstalledCapabilityPackage[] }
  'memory:list': { input: { workspaceId?: string; state?: MemoryEntry['state']; scope?: MemoryScope } | undefined; output: MemoryEntry[] }
  'memory:propose': { input: MemoryProposalInput; output: MemoryEntry }
  'memory:confirm': { input: { id: string }; output: MemoryEntry }
  'memory:disable': { input: { id: string }; output: MemoryEntry }
  'memory:remove': { input: { id: string }; output: undefined }
  'mcp:list': { input: undefined; output: McpServerConfig[] }
  'mcp:upsert': { input: McpServerInput & { secrets?: Record<string, string> }; output: McpServerConfig }
  'mcp:remove': { input: { id: string }; output: undefined }
  'mcp:test': { input: { id: string }; output: McpConnectionTest }
  'mcp:start-oauth': { input: { id: string }; output: { authorizationUrl: string; state: string } }
  'mcp:complete-oauth': { input: { id: string; callbackUrl: string; state: string }; output: McpServerConfig }
  'skills:list': { input: undefined; output: SkillManifest[] }
  'skills:get': { input: { id: string }; output: SkillDetail }
  'skills:import': { input: { directory: string }; output: SkillManifest }
  'skills:remove': { input: { id: string }; output: undefined }
  'skills:set-enabled': { input: { id: string; enabled: boolean }; output: SkillManifest }
  'automations:list': { input: { workspaceId?: string } | undefined; output: AutomationSpec[] }
  'automations:upsert': { input: AutomationInput; output: AutomationSpec }
  'automations:remove': { input: { id: string }; output: undefined }
  'automations:set-enabled': { input: { id: string; enabled: boolean }; output: AutomationSpec }
  'automations:run-now': { input: { id: string }; output: RunDetail }
  'chrome:get-status': { input: undefined; output: ChromeBridgeStatus }
  'chrome:list-grants': { input: { runId?: string } | undefined; output: ChromeTabGrant[] }
  'chrome:request-binding': { input: { runId: string }; output: { requested: true } }
  'chrome:revoke-grant': { input: { id: string }; output: undefined }
  'audit:list': { input: AuditQuery | undefined; output: Page<AuditEntry> }
  'audit:export-diagnostics': { input: { runId?: string } | undefined; output: DiagnosticExportResult | null }
  'artifacts:get-text': { input: { id: string; maxBytes?: number }; output: ArtifactText }
  'artifacts:reveal': { input: { id: string }; output: undefined }
  'artifacts:undo-change': { input: { id: string }; output: ArtifactRestoreResult }
}

export type DesktopInvokeChannel = keyof DesktopInvokeMap
export type DesktopInvoker = <C extends DesktopInvokeChannel>(
  channel: C,
  input: DesktopInvokeMap[C]['input'],
) => Promise<DesktopInvokeMap[C]['output']>

const VoidSchema = z.undefined()
const ByIdSchema = z.object({ id: IdSchema }).strict()
const OptionalByWorkspaceSchema = z.object({ workspaceId: IdSchema.optional() }).strict().optional()
const PageSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().optional() }).strict()
const InstalledCapabilityPackageSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  workspaceId: IdSchema.optional(),
  skillIds: z.array(IdSchema),
  mcpServerIds: z.array(IdSchema),
  ruleSources: z.array(z.string()),
  templatePaths: z.array(z.string()),
  installedAt: IsoDateTimeSchema,
}).strict()
const CapabilityPackagePreviewSchema = z.object({
  selectionId: IdSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  directory: z.string().min(1),
  skills: z.array(z.string()),
  mcpConfigs: z.array(JsonValueSchema),
  rules: z.array(z.string()),
  templates: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
}).strict()

/** Runtime validators for every renderer-to-main invocation and response. */
export const DesktopInvokeContracts: Record<DesktopInvokeChannel, { input: z.ZodType; output: z.ZodType }> = {
  bootstrap: { input: VoidSchema, output: BootstrapSnapshotSchema },
  'app:get-info': { input: VoidSchema, output: z.object({ name: z.string(), version: z.string(), platform: z.string(), arch: z.string(), locale: z.string() }).strict() },
  'app:choose-workspace': { input: VoidSchema, output: z.string().nullable() },
  'app:choose-files': { input: VoidSchema, output: z.array(z.string()) },
  'app:import-attachments': { input: VoidSchema, output: z.array(ArtifactRefSchema) },
  'app:reveal-path': { input: z.object({ path: z.string().min(1) }).strict(), output: VoidSchema },
  'workspaces:list': { input: VoidSchema, output: z.array(WorkspaceSchema) },
  'workspaces:create': { input: z.object({ path: z.string().min(1), name: z.string().min(1).optional() }).strict(), output: WorkspaceSchema },
  'workspaces:update': { input: z.object({ id: IdSchema, name: z.string().min(1).optional(), rules: z.string().optional() }).strict(), output: WorkspaceSchema },
  'workspaces:remove': { input: ByIdSchema, output: VoidSchema },
  'workspaces:select': { input: ByIdSchema, output: WorkspaceSchema },
  'runs:list': { input: PageRequestSchema.extend({ workspaceId: IdSchema.optional(), status: RunStatusSchema.optional() }).strict().optional(), output: PageSchema(RunSummarySchema) },
  'runs:get': { input: ByIdSchema, output: RunDetailSchema },
  'runs:create': {
    input: z.object({ workspaceId: IdSchema, objective: z.string().min(1), mode: z.enum(['plan', 'execute']).optional(), title: z.string().min(1).optional(), modelProfileId: IdSchema.optional(), attachmentIds: z.array(IdSchema).optional(), limits: RunLimitsSchema.partial().optional() }).strict(),
    output: RunDetailSchema,
  },
  'runs:send-message': { input: z.object({ runId: IdSchema, content: z.string().min(1), attachmentIds: z.array(IdSchema).optional() }).strict(), output: VoidSchema },
  'runs:pause': { input: ByIdSchema, output: RunSchema },
  'runs:resume': { input: ByIdSchema, output: RunSchema },
  'runs:cancel': { input: ByIdSchema, output: RunSchema },
  'runs:remove': { input: ByIdSchema, output: VoidSchema },
  'runs:respond-approval': { input: ApprovalResponseSchema, output: VoidSchema },
  'models:list': { input: VoidSchema, output: z.array(ModelProfileSchema) },
  'models:catalog': {
    input: z.object({ provider: ProviderIdSchema }).strict(),
    output: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), contextWindow: z.number().int().positive(), maxOutputTokens: z.number().int().positive(), vision: z.boolean(), reasoning: z.boolean() }).strict()),
  },
  'models:upsert': { input: ModelProfileInputSchema, output: ModelProfileSchema },
  'models:remove': { input: ByIdSchema, output: VoidSchema },
  'models:set-secret': { input: z.object({ profileId: IdSchema, apiKey: z.string().min(1).max(20_000) }).strict(), output: VoidSchema },
  'models:delete-secret': { input: z.object({ profileId: IdSchema }).strict(), output: VoidSchema },
  'models:test': { input: z.object({ profileId: IdSchema }).strict(), output: ModelConnectionTestSchema },
  'models:set-defaults': { input: z.object({ defaultModelProfileId: IdSchema, subagentModelProfileId: IdSchema.optional() }).strict(), output: VoidSchema },
  'settings:get': { input: VoidSchema, output: AppSettingsSchema },
  'settings:update': { input: AppSettingsSchema.partial().strict(), output: AppSettingsSchema },
  'permissions:list-persistent': { input: VoidSchema, output: z.array(ApprovalGrantSchema) },
  'permissions:create-persistent': {
    input: z.object({
      workspaceId: IdSchema,
      toolName: z.enum(['file.write', 'file.edit']),
      path: z.string().trim().min(1).max(4096),
      expiresAt: IsoDateTimeSchema.optional(),
    }).strict(),
    output: ApprovalGrantSchema,
  },
  'permissions:remove-persistent': { input: ByIdSchema, output: VoidSchema },
  'capability-packages:choose': { input: VoidSchema, output: CapabilityPackagePreviewSchema.nullable() },
  'capability-packages:install': { input: z.object({ selectionId: IdSchema, workspaceId: IdSchema.optional() }).strict(), output: InstalledCapabilityPackageSchema },
  'capability-packages:list': { input: VoidSchema, output: z.array(InstalledCapabilityPackageSchema) },
  'memory:list': { input: z.object({ workspaceId: IdSchema.optional(), state: z.enum(['proposed', 'confirmed', 'disabled', 'deleted']).optional(), scope: z.enum(['thread', 'workspace', 'user', 'organization']).optional() }).strict().optional(), output: z.array(MemoryEntrySchema) },
  'memory:propose': {
    input: z.object({ workspaceId: IdSchema.optional(), type: z.enum(['stable_fact', 'knowledge_background', 'behavior_signal', 'style_preference', 'continuation']), scope: z.enum(['thread', 'workspace', 'user', 'organization']), content: z.string().min(1), confidence: z.number().min(0).max(1), source: z.object({ kind: z.enum(['run', 'message', 'file', 'user']), reference: z.string().min(1), excerpt: z.string().optional() }).strict() }).strict(),
    output: MemoryEntrySchema,
  },
  'memory:confirm': { input: ByIdSchema, output: MemoryEntrySchema },
  'memory:disable': { input: ByIdSchema, output: MemoryEntrySchema },
  'memory:remove': { input: ByIdSchema, output: VoidSchema },
  'mcp:list': { input: VoidSchema, output: z.array(McpServerConfigSchema) },
  'mcp:upsert': { input: z.object({ id: IdSchema.optional(), name: z.string().min(1), enabled: z.boolean(), transport: McpTransportSchema, toolNamespace: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/), secrets: z.record(z.string(), z.string()).optional() }).strict(), output: McpServerConfigSchema },
  'mcp:remove': { input: ByIdSchema, output: VoidSchema },
  'mcp:test': { input: ByIdSchema, output: z.object({ ok: z.boolean(), latencyMs: z.number().int().nonnegative(), serverVersion: z.string().optional(), toolCount: z.number().int().nonnegative().optional(), error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).strict().optional() }).strict() },
  'mcp:start-oauth': { input: ByIdSchema, output: z.object({ authorizationUrl: z.string().url(), state: z.string().min(1) }).strict() },
  'mcp:complete-oauth': { input: z.object({ id: IdSchema, callbackUrl: z.string().url(), state: z.string().min(1) }).strict(), output: McpServerConfigSchema },
  'skills:list': { input: VoidSchema, output: z.array(SkillManifestSchema) },
  'skills:get': { input: ByIdSchema, output: z.object({ manifest: SkillManifestSchema, instructions: z.string(), referenceFiles: z.array(z.string()), scriptFiles: z.array(z.string()) }).strict() },
  'skills:import': { input: z.object({ directory: z.string().min(1) }).strict(), output: SkillManifestSchema },
  'skills:remove': { input: ByIdSchema, output: VoidSchema },
  'skills:set-enabled': { input: z.object({ id: IdSchema, enabled: z.boolean() }).strict(), output: SkillManifestSchema },
  'automations:list': { input: OptionalByWorkspaceSchema, output: z.array(AutomationSpecSchema) },
  'automations:upsert': { input: z.object({ id: IdSchema.optional(), workspaceId: IdSchema, name: z.string().min(1), enabled: z.boolean(), objective: z.string().min(1), modelProfileId: IdSchema, schedule: AutomationScheduleSchema }).strict(), output: AutomationSpecSchema },
  'automations:remove': { input: ByIdSchema, output: VoidSchema },
  'automations:set-enabled': { input: z.object({ id: IdSchema, enabled: z.boolean() }).strict(), output: AutomationSpecSchema },
  'automations:run-now': { input: ByIdSchema, output: RunDetailSchema },
  'chrome:get-status': { input: VoidSchema, output: ChromeBridgeStatusSchema },
  'chrome:list-grants': { input: z.object({ runId: IdSchema.optional() }).strict().optional(), output: z.array(ChromeTabGrantSchema) },
  'chrome:request-binding': { input: z.object({ runId: IdSchema }).strict(), output: z.object({ requested: z.literal(true) }).strict() },
  'chrome:revoke-grant': { input: ByIdSchema, output: VoidSchema },
  'audit:list': { input: PageRequestSchema.extend({ runId: IdSchema.optional(), outcome: z.enum(['started', 'allowed', 'blocked', 'approved', 'rejected', 'succeeded', 'failed']).optional(), since: z.string().datetime({ offset: true }).optional() }).strict().optional(), output: PageSchema(AuditEntrySchema) },
  'audit:export-diagnostics': { input: z.object({ runId: IdSchema.optional() }).strict().optional(), output: z.object({ path: z.string(), entryCount: z.number().int().nonnegative(), redacted: z.boolean() }).strict().nullable() },
  'artifacts:get-text': { input: z.object({ id: IdSchema, maxBytes: z.number().int().positive().max(16 * 1024 * 1024).optional() }).strict(), output: z.object({ artifact: ArtifactRefSchema, text: z.string(), truncated: z.boolean() }).strict() },
  'artifacts:reveal': { input: ByIdSchema, output: VoidSchema },
  'artifacts:undo-change': { input: ByIdSchema, output: z.object({ restored: z.literal(true), path: z.string().min(1), createdFileRemoved: z.boolean() }).strict() },
}

export const DesktopEventSchema = RunEventSchema
