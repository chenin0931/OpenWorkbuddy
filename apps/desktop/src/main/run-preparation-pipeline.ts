import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { lstat, readFile, realpath } from 'node:fs/promises'
import type { ContextItem, ModelProfile } from '@onmyworkbuddy/contracts'
import { compileContext, compressContext, renderContextItem } from '@onmyworkbuddy/core'
import type { AppDatabase } from './database'
import type { ArtifactStore } from './artifact-store'
import { selectMemoriesForRun } from './memory-selection'
import { BASE_SYSTEM_PROMPT, publicToolDescriptors, TOOL_DEFINITIONS } from './tool-registry'
import { presentMemory, presentSkill } from './presenters'

const MAX_RULE_FILE_BYTES = 128 * 1024
const MAX_RULES_TOTAL_BYTES = 256 * 1024

export type RunPreparationStageId =
  | 'platform_contract'
  | 'environment'
  | 'user_input'
  | 'workspace_rules'
  | 'skill_catalog'
  | 'memory_selection'
  | 'checkpoint'
  | 'tool_receipts'
  | 'model_budget'
  | 'context_budget'

export interface ContextStageDiagnostic {
  id: RunPreparationStageId
  durationMs: number
  itemCount: number
  tokenEstimate?: number
  warnings: string[]
}

export interface PreparedHistoryMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: number
  sourceRef?: string
}

export interface PreparedToolReceipt {
  providerCallId: string
  toolId: string
  state: string
  risk: string
  result?: unknown
  error?: string
  createdAt: string
  updatedAt: string
}

export interface CompiledRunInput {
  systemPrompt: string
  history: PreparedHistoryMessage[]
  images: Array<{ data: string; mimeType: string }>
  tools: ReturnType<typeof publicToolDescriptors>
  toolReceipts: PreparedToolReceipt[]
  contextStats: { estimatedTokens: number; checkpointThresholdTokens: number; itemCount: number; compressed: boolean }
  stageDiagnostics: ContextStageDiagnostic[]
}

interface PipelineState {
  run: any
  profile: ModelProfile
  workspace: any
  effectivePrompt: string
  contextInput: {
    platformContract: string
    userPreferences?: string
    workspaceRules: Array<{ source: string; content: string }>
    skills: Array<{ manifest: ReturnType<typeof presentSkill> }>
    task: { objective: string; progress?: string }
    environment: Record<string, string>
    memories: ReturnType<typeof presentMemory>[]
    previousCheckpoint?: ContextItem
    untrustedContent: ContextItem[]
    maxContextTokens: number
  }
  receiptSection: string
  toolReceipts: PreparedToolReceipt[]
  diagnostics: ContextStageDiagnostic[]
}

interface Stage {
  id: RunPreparationStageId
  apply(state: PipelineState): Promise<void>
}

function missingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT')
}

function withinRoot(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function safeLabel(value: unknown): string {
  const printable = Array.from(String(value ?? 'unknown'), (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127 ? ' ' : character
  }).join('')
  return printable.replace(/\s+/g, ' ').slice(0, 120)
}

function receiptTarget(toolId: string, rawArguments: unknown): string {
  const args = rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
    ? rawArguments as Record<string, unknown>
    : {}
  if (typeof args.path === 'string') return `file:${safeLabel(basename(args.path))}`
  if (typeof args.url === 'string') {
    try { return `origin:${new URL(args.url).origin}` } catch { return 'web-target' }
  }
  if (typeof args.command === 'string') {
    const executable = args.command.trim().split(/\s+/).find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
    const name = executable ? basename(executable).replace(/[^A-Za-z0-9._+-]/g, '') : ''
    return name ? `shell:${name}` : 'shell-command'
  }
  if (typeof args.toolName === 'string') {
    const server = typeof args.serverId === 'string' ? safeLabel(args.serverId) : 'server'
    return `mcp:${server}/${safeLabel(args.toolName)}`
  }
  if (typeof args.tabId === 'number') return `chrome-tab:${args.tabId}`
  return safeLabel(toolId)
}

export class RunPreparationPipeline {
  constructor(
    private readonly database: AppDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly persistCheckpoint: (runId: string, checkpoint: { content: string; sourceRefs: string[]; signature: string; estimatedTokens: number }) => Promise<void>,
  ) {}

  private readonly stages: Stage[] = [
    { id: 'platform_contract', apply: async (state) => {
      state.contextInput.platformContract = BASE_SYSTEM_PROMPT
      state.contextInput.userPreferences = this.database.getSetting<string>('userPreferences', '')
    } },
    { id: 'environment', apply: async (state) => {
      state.contextInput.environment = {
        os: process.platform,
        arch: process.arch,
        shell: process.env.SHELL ?? '/bin/zsh',
        time: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        workspace: state.workspace.root_path,
        accessMode: state.run.accessMode ?? 'approval',
        authorizedRoot: state.run.accessMode === 'full_disk' ? '/' : state.workspace.root_path,
      }
    } },
    { id: 'user_input', apply: async (state) => {
      state.contextInput.untrustedContent = await this.attachmentContextItems(state.run.id)
    } },
    { id: 'workspace_rules', apply: async (state) => {
      state.contextInput.workspaceRules = await this.loadWorkspaceRules(state.run, state.workspace)
    } },
    { id: 'skill_catalog', apply: async (state) => {
      state.contextInput.skills = this.database.listSkills().filter((skill) => skill.enabled).map((skill) => ({ manifest: presentSkill(skill) }))
    } },
    { id: 'memory_selection', apply: async (state) => {
      const settings = this.database.getSetting<any>('appSettings', {})
      state.contextInput.memories = settings.memoryEnabled === false ? [] : selectMemoriesForRun(
        this.database.listMemory().map(presentMemory),
        {
          runId: state.run.id,
          workspaceId: state.workspace.id,
          messageBelongsToRun: (messageId, candidateRunId) => this.database.messageBelongsToRun(messageId, candidateRunId),
        },
      )
    } },
    { id: 'checkpoint', apply: async (state) => {
      const checkpoint = await this.loadPreviousCheckpoint(state.run)
      if (checkpoint) state.contextInput.previousCheckpoint = checkpoint
      else delete state.contextInput.previousCheckpoint
    } },
    { id: 'tool_receipts', apply: async (state) => {
      const receipts = this.database.listToolReceiptsForModel(state.run.id, 40)
      state.toolReceipts = receipts.map((receipt) => ({
        providerCallId: receipt.providerCallId,
        toolId: receipt.toolId,
        state: receipt.state,
        risk: receipt.risk,
        ...(receipt.result !== undefined ? { result: receipt.result } : {}),
        ...(receipt.error ? { error: receipt.error } : {}),
        createdAt: receipt.createdAt,
        updatedAt: receipt.updatedAt,
      }))
      state.receiptSection = this.renderReceiptSection(receipts)
    } },
    { id: 'model_budget', apply: async (state) => {
      const progress = [
        state.run.summary || '',
        ...(state.run.steps ?? []).map((step: any) => `[${step.status}] ${step.title} (step:${step.id})`),
      ].filter(Boolean).join('\n')
      state.contextInput.task = { objective: state.run.goal ?? state.run.prompt, ...(progress ? { progress } : {}) }
      state.contextInput.maxContextTokens = state.profile.capabilities.contextWindow
    } },
    { id: 'context_budget', apply: async () => undefined },
  ]

  async prepare(input: { run: any; profile: ModelProfile; workspace: any; effectivePrompt: string }): Promise<CompiledRunInput> {
    const state: PipelineState = {
      ...input,
      contextInput: {
        platformContract: '',
        workspaceRules: [],
        skills: [],
        task: { objective: input.run.goal ?? input.run.prompt },
        environment: {},
        memories: [],
        untrustedContent: [],
        maxContextTokens: input.profile.capabilities.contextWindow,
      },
      receiptSection: '',
      toolReceipts: [],
      diagnostics: [],
    }
    for (const stage of this.stages) {
      const started = performance.now()
      const warnings: string[] = []
      await stage.apply(state).catch((error) => {
        warnings.push(error instanceof Error ? error.message : String(error))
        throw error
      })
      state.diagnostics.push({
        id: stage.id,
        durationMs: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
        itemCount: this.stageItemCount(stage.id, state),
        warnings,
      })
    }

    const context = compileContext(state.contextInput)
    let stablePrefix = context.stablePrefix
    let dynamicSuffix = context.dynamicSuffix
    let compressed = false
    if (context.needsCheckpoint) {
      compressed = true
      const result = compressContext(context.items, Math.max(1, Math.floor(input.profile.capabilities.contextWindow * 0.6)), { checkpointId: `checkpoint-${input.run.id}` })
      const droppedIds = new Set(result.droppedItemIds)
      const sourceRefs = context.items.filter((entry) => droppedIds.has(entry.id)).map((entry) => `${entry.kind}:${entry.source}`)
      const content = result.checkpoint?.content ?? `Context crossed the 70% checkpoint threshold. Re-open these sources before relying on omitted detail:\n${sourceRefs.map((source) => `- ${source}`).join('\n')}`
      const signature = createHash('sha256').update(JSON.stringify({ content, sourceRefs })).digest('hex')
      await this.persistCheckpoint(input.run.id, { content, sourceRefs, signature, estimatedTokens: context.estimatedTokens })
      stablePrefix = result.items.filter((entry) => entry.stable).map(renderContextItem).join('\n\n')
      dynamicSuffix = result.items.filter((entry) => !entry.stable).map(renderContextItem).join('\n\n')
    }
    const contextBudgetDiagnostic = state.diagnostics.find((entry) => entry.id === 'context_budget')
    if (contextBudgetDiagnostic) contextBudgetDiagnostic.tokenEstimate = context.estimatedTokens

    let history: PreparedHistoryMessage[] = input.run.messages
      .filter((message: any) => (message.role === 'user' || message.role === 'assistant') && (message.role !== 'assistant' || String(message.content ?? '').trim().length > 0))
      .map((message: any) => ({ role: message.role, content: message.content, timestamp: Date.parse(message.createdAt ?? message.created_at), sourceRef: `message:${message.id}` }))
    const last = history.at(-1)
    if (last?.role === 'user' && last.content === input.effectivePrompt) history = history.slice(0, -1)
    const tools = publicToolDescriptors().filter((tool) => !input.run.readOnly || TOOL_DEFINITIONS.find((definition) => definition.id === tool.id)?.risk === 'read')
    const images = await this.loadRunImages(input.run.id)
    return {
      systemPrompt: `${stablePrefix}\n\n${dynamicSuffix}${state.receiptSection ? `\n\n${state.receiptSection}` : ''}`,
      history,
      images,
      tools,
      toolReceipts: state.toolReceipts,
      contextStats: {
        estimatedTokens: context.estimatedTokens,
        checkpointThresholdTokens: context.checkpointThresholdTokens,
        itemCount: context.items.length,
        compressed,
      },
      stageDiagnostics: state.diagnostics,
    }
  }

  async loadArtifactsAsImages(ids: string[]): Promise<Array<{ data: string; mimeType: string }>> {
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

  private async loadRunImages(runId: string): Promise<Array<{ data: string; mimeType: string }>> {
    return this.loadArtifactsAsImages(this.database.listArtifacts(runId)
      .filter((artifact: any) => artifact.kind === 'attachment' && String(artifact.mime).startsWith('image/'))
      .map((artifact: any) => String(artifact.id)))
  }

  private stageItemCount(id: RunPreparationStageId, state: PipelineState): number {
    if (id === 'workspace_rules') return state.contextInput.workspaceRules.length
    if (id === 'skill_catalog') return state.contextInput.skills.length
    if (id === 'memory_selection') return state.contextInput.memories.length
    if (id === 'user_input') return state.contextInput.untrustedContent.length
    if (id === 'tool_receipts') return state.toolReceipts.length
    if (id === 'checkpoint') return state.contextInput.previousCheckpoint ? 1 : 0
    return 1
  }

  private async loadWorkspaceRules(run: any, workspace: any): Promise<Array<{ source: string; content: string }>> {
    const rules: Array<{ source: string; content: string }> = []
    let totalBytes = 0
    if (workspace.rules?.trim()) {
      const bytes = Buffer.byteLength(workspace.rules)
      if (bytes <= MAX_RULE_FILE_BYTES && bytes <= MAX_RULES_TOTAL_BYTES) {
        rules.push({ source: 'workspace-settings', content: workspace.rules }); totalBytes += bytes
      } else this.database.audit('security', 'workspace_rules_rejected', '工作区设置规则超过上下文大小限制', { actor: 'system', outcome: 'blocked', target: 'workspace-settings', byteLength: bytes }, run.id)
    }
    const root = await realpath(workspace.root_path)
    for (const file of ['WORKBUDDY.md', 'AGENTS.md', join('.on-my-workbuddy', 'rules.md')]) {
      try {
        let candidate = root
        for (const segment of file.split(/[\\/]/).filter(Boolean)) {
          candidate = join(candidate, segment)
          if ((await lstat(candidate)).isSymbolicLink()) throw new Error(`规则路径不允许符号链接：${file}`)
        }
        const info = await lstat(candidate)
        if (!info.isFile()) throw new Error(`规则路径不是普通文件：${file}`)
        if (info.size > MAX_RULE_FILE_BYTES) throw new Error(`规则文件超过 ${MAX_RULE_FILE_BYTES} 字节：${file}`)
        const resolved = await realpath(candidate)
        if (!withinRoot(root, resolved)) throw new Error(`规则文件超出授权工作区：${file}`)
        const content = await readFile(resolved)
        if (totalBytes + content.byteLength > MAX_RULES_TOTAL_BYTES) throw new Error(`规则文件总量超过 ${MAX_RULES_TOTAL_BYTES} 字节`)
        rules.push({ source: file, content: content.toString('utf8') }); totalBytes += content.byteLength
      } catch (error) {
        if (missingFile(error)) continue
        this.database.audit('security', 'workspace_rule_rejected', `拒绝加载工作区规则 ${file}`, { actor: 'system', outcome: 'blocked', target: file, reason: error instanceof Error ? error.message : String(error) }, run.id)
      }
    }
    return rules
  }

  private async loadPreviousCheckpoint(run: any): Promise<ContextItem | undefined> {
    const latest = run.artifacts.find((artifact: any) => artifact.kind === 'checkpoint')
    if (!latest) return undefined
    try {
      return { id: `checkpoint-${latest.id}`, kind: 'checkpoint', content: (await this.artifacts.read(latest.path)).toString('utf8'), source: `artifact:${latest.id}`, trusted: true, priority: 980, stable: false, createdAt: latest.createdAt ?? latest.created_at }
    } catch (error) {
      this.database.audit('context', 'checkpoint_read_failed', '无法读取持久化上下文检查点', { actor: 'system', outcome: 'failed', artifactId: latest.id, reason: error instanceof Error ? error.message : String(error) }, run.id)
      return undefined
    }
  }

  private async attachmentContextItems(runId: string): Promise<ContextItem[]> {
    const rows = this.database.listArtifacts(runId).filter((artifact: any) => artifact.kind === 'attachment')
    const items: ContextItem[] = []
    let totalBytes = 0
    for (const row of rows) {
      const mime = String(row.mime ?? '')
      items.push({ id: `attachment-manifest-${row.id}`, kind: 'environment', content: `用户已附加文件。artifactId: ${row.id}\n名称：${row.name}\n媒体类型：${mime || 'application/octet-stream'}\n大小：${row.size} bytes\n需要读取或交给 Shell 时调用 attachment_open({ artifactId: "${row.id}" })；禁止按文件名扫描磁盘。`, source: `attachment-manifest:${row.id}`, trusted: true, priority: 910, stable: false })
      const isText = mime.startsWith('text/') || /(?:json|xml|yaml|javascript)/i.test(mime)
      if (!isText || Number(row.size) > 128 * 1024 || totalBytes + Number(row.size) > 256 * 1024) {
        items.push({ id: `attachment-meta-${row.id}`, kind: 'untrusted_content', content: `附件 ${row.name} 的内容未以内联文本加载。`, source: `attachment:${row.name}`, trusted: false, priority: 500, stable: false })
        continue
      }
      const content = await readFile(row.path, 'utf8'); totalBytes += Buffer.byteLength(content)
      items.push({ id: `attachment-${row.id}`, kind: 'untrusted_content', content, source: `attachment:${row.name}`, trusted: false, priority: 650, stable: false })
    }
    return items
  }

  private renderReceiptSection(receipts: any[]): string {
    if (!receipts.length) return ''
    const uncertain = new Set(['requested', 'waiting_approval', 'running', 'cancelled'])
    const important = receipts.filter((receipt) => receipt.risk === 'external_side_effect' || receipt.risk === 'high_risk_irreversible' || uncertain.has(receipt.state))
    const selected = [...important, ...receipts.filter((receipt) => !important.includes(receipt))].slice(0, 12)
    return [
      '## 持久化工具回执与恢复约束',
      '以下内容由本地数据库生成。不得把 external/high 成功记录或状态不明记录当作可自动重试动作；必须先核对真实状态。',
      ...selected.map((receipt) => {
        const caution = receipt.risk === 'external_side_effect' || receipt.risk === 'high_risk_irreversible' || uncertain.has(receipt.state) ? '；禁止自动重放' : ''
        return `- ${receipt.createdAt} | ${safeLabel(receipt.toolId)} | target=${receiptTarget(receipt.toolId, receipt.arguments)} | risk=${receipt.risk} | state=${receipt.state} | ${receipt.result !== undefined ? '有本地回执' : '无本地结果正文'}${caution}`
      }),
    ].join('\n')
  }
}
