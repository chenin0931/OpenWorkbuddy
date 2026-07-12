import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { app, dialog, shell } from 'electron'
import { DesktopInvokeContracts, type AppSettings, type DesktopInvokeChannel, type InstalledCapabilityPackage, type ModelProfile } from '@onmyworkbuddy/contracts'
import { classifyModelError, redactSecrets } from '@onmyworkbuddy/core'
import type { AppDatabase } from './database'
import type { SecretStore } from './secret-store'
import type { AgentHostBridge, ToolRunnerBridge } from './worker-bridge'
import type { RunCoordinator } from './run-coordinator'
import type { ToolBroker } from './tool-broker'
import type { ChromeBridge } from './chrome-bridge'
import type { SkillService } from './skill-service'
import type { AutomationService } from './automation-service'
import type { McpOAuthService } from './mcp-oauth'
import type { ArtifactStore } from './artifact-store'
import { DEFAULT_SETTINGS, presentArtifact, presentAudit, presentChromeGrant, presentMcp, presentMemory, presentModel, presentRunSummary, presentWorkspace } from './presenters'
import { CapabilityPackageService, type ParsedCapabilityPackage } from './capability-package-service'
import { getModelCatalog } from './model-providers'

type Handler = (input: any) => Promise<any> | any

export class IpcApi {
  readonly handlers: Record<DesktopInvokeChannel, Handler>
  private oauthServerByState = new Map<string, string>()
  private pendingWorkspaceSelections = new Map<string, number>()
  private capabilitySelections = new Map<string, { parsed: ParsedCapabilityPackage; fingerprint: string; expiresAt: number }>()
  private capabilityPackages = new CapabilityPackageService()

  constructor(
    private database: AppDatabase,
    private secrets: SecretStore,
    private host: AgentHostBridge,
    private runner: ToolRunnerBridge,
    private coordinator: RunCoordinator,
    private broker: ToolBroker,
    private chrome: ChromeBridge,
    private skills: SkillService,
    private automations: AutomationService<any>,
    private oauth: McpOAuthService,
    private artifacts: ArtifactStore,
  ) {
    this.handlers = this.createHandlers()
  }

  private settings(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...this.database.getSetting<Partial<AppSettings>>('appSettings', {}) }
  }

  private modelProfiles(): ModelProfile[] {
    const settings = this.settings()
    return this.database.listModelProfiles().map((row) => presentModel(row, settings.subagentModelProfileId))
  }

  private createHandlers(): Record<DesktopInvokeChannel, Handler> {
    return {
      bootstrap: () => {
        const settings = this.settings()
        const selectedId = this.database.getSetting<string | undefined>('selectedWorkspaceId', undefined)
        const workspaces = this.database.listWorkspaces().map((row) => presentWorkspace(row, selectedId))
        const profiles = this.modelProfiles()
        return {
          app: this.appInfo(),
          onboardingComplete: workspaces.length > 0 && profiles.some((profile) => profile.keyConfigured),
          settings,
          ...(selectedId ? { selectedWorkspaceId: selectedId } : {}),
          workspaces,
          modelProfiles: profiles,
          chrome: this.chrome.getStatus(),
        }
      },
      'app:get-info': () => this.appInfo(),
      'app:choose-workspace': async () => {
        const selected = (await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择 Agent 工作区' })).filePaths[0]
        if (!selected) return null
        const canonical = await realpath(selected)
        this.pendingWorkspaceSelections.set(canonical, Date.now() + 5 * 60_000)
        return canonical
      },
      'app:choose-files': async () => (await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: '选择附件' })).filePaths,
      'app:import-attachments': async () => {
        const selected = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: '选择附件（单个最大 25 MB）' })
        if (selected.canceled) return []
        const rows = []
        let total = 0
        for (const path of selected.filePaths.slice(0, 10)) {
          const data = await readFile(path)
          if (data.byteLength > 25 * 1024 * 1024) throw new Error(`${basename(path)} 超过 25 MB`)
          total += data.byteLength
          if (total > 100 * 1024 * 1024) throw new Error('本次附件总大小超过 100 MB')
          rows.push(presentArtifact(await this.artifacts.putBuffer({ name: basename(path), kind: 'attachment', data, metadata: { importedAt: new Date().toISOString() } })))
        }
        return rows
      },
      'app:reveal-path': async ({ path }) => { shell.showItemInFolder(path) },

      'workspaces:list': () => { const selected = this.database.getSetting<string | undefined>('selectedWorkspaceId', undefined); return this.database.listWorkspaces().map((row) => presentWorkspace(row, selected)) },
      'workspaces:create': async ({ path, name }) => {
        const canonical = await realpath(path)
        const expiry = this.pendingWorkspaceSelections.get(canonical)
        this.pendingWorkspaceSelections.delete(canonical)
        if (!expiry || expiry < Date.now()) throw new Error('工作区授权已失效，请通过文件夹选择器重新选择')
        const id = this.database.addWorkspace(canonical, name ?? basename(canonical))
        if (!this.database.getSetting('selectedWorkspaceId', '')) this.database.setSetting('selectedWorkspaceId', id)
        return presentWorkspace(this.database.getWorkspace(id), this.database.getSetting('selectedWorkspaceId', id))
      },
      'workspaces:update': ({ id, name, rules }) => {
        const existing = this.database.getWorkspace(id)
        if (!existing) throw new Error('工作区不存在')
        this.database.db.prepare('UPDATE workspaces SET name=?,rules=?,updated_at=? WHERE id=?').run(name ?? existing.name, rules ?? existing.rules, new Date().toISOString(), id)
        return presentWorkspace(this.database.getWorkspace(id), this.database.getSetting('selectedWorkspaceId', ''))
      },
      'workspaces:remove': ({ id }) => { this.database.removeWorkspace(id) },
      'workspaces:select': ({ id }) => { const row = this.database.getWorkspace(id); if (!row) throw new Error('工作区不存在'); this.database.setSetting('selectedWorkspaceId', id); return presentWorkspace(row, id) },

      'runs:list': (input) => {
        const profiles = this.modelProfiles()
        let rows = this.database.listRuns(Math.min(input?.limit ?? 50, 100))
        if (input?.workspaceId) rows = rows.filter((row) => row.workspaceId === input.workspaceId)
        if (input?.status) rows = rows.filter((row) => row.status === input.status)
        return { items: rows.map((row) => presentRunSummary(row, profiles.find((profile) => profile.id === row.modelProfileId) ?? this.snapshotProfile(row))) }
      },
      'runs:get': ({ id }) => this.coordinator.getDetail(id),
      'runs:create': (input) => this.coordinator.create({ workspaceId: input.workspaceId, objective: input.objective, mode: input.mode, title: input.title, modelProfileId: input.modelProfileId, limits: input.limits, attachmentIds: input.attachmentIds, readOnly: input.mode === 'plan' }),
      'runs:send-message': async ({ runId, content, attachmentIds }) => { await this.coordinator.sendMessage(runId, content, attachmentIds) },
      'runs:pause': ({ id }) => this.coordinator.pause(id),
      'runs:resume': ({ id }) => this.coordinator.resume(id),
      'runs:cancel': ({ id }) => this.coordinator.cancel(id),
      'runs:remove': ({ id }) => { this.coordinator.delete(id) },
      'runs:respond-approval': (input) => { this.broker.respondToApproval(input) },

      'models:list': () => this.modelProfiles(),
      'models:catalog': ({ provider }) => getModelCatalog(provider),
      'models:upsert': (input) => {
        const existing = input.id ? this.database.listModelProfiles().find((row) => row.id === input.id) : undefined
        const id = this.database.saveModelProfile({ ...input, isDefault: existing?.isDefault ?? this.database.listModelProfiles().length === 0, capabilities: input.capabilities ?? {} })
        return this.modelProfiles().find((profile) => profile.id === id)!
      },
      'models:remove': ({ id }) => { this.database.deleteModelProfile(id) },
      'models:set-secret': async ({ profileId, apiKey }) => { this.database.setModelEncryptedKey(profileId, await this.secrets.encrypt(apiKey)); this.database.audit('secret', 'set_model_key', '模型密钥已更新', { actor: 'user', outcome: 'succeeded', target: profileId }) },
      'models:delete-secret': ({ profileId }) => { this.database.setModelEncryptedKey(profileId, null) },
      'models:test': async ({ profileId }) => {
        const started = Date.now(); const raw = this.database.getModelProfileSecret(profileId)
        if (!raw?.encryptedKey) throw new Error('模型配置尚未设置 API Key')
        let apiKey = ''
        try {
          apiKey = await this.secrets.decrypt(raw.encryptedKey)
          await this.host.testProvider({ provider: raw.provider, modelId: raw.modelId, apiKey })
          return { ok: true, provider: raw.provider, modelId: raw.modelId, latencyMs: Date.now() - started }
        } catch (error) {
          return { ok: false, provider: raw.provider, modelId: raw.modelId, latencyMs: Date.now() - started, error: classifyModelError(error, apiKey ? [apiKey] : []) }
        } finally {
          apiKey = ''
        }
      },
      'models:set-defaults': ({ defaultModelProfileId, subagentModelProfileId }) => {
        this.database.setDefaultModelProfile(defaultModelProfileId)
        const settings = this.settings(); settings.defaultModelProfileId = defaultModelProfileId
        if (subagentModelProfileId) settings.subagentModelProfileId = subagentModelProfileId; else delete settings.subagentModelProfileId
        this.database.setSetting('appSettings', settings as any)
      },

      'settings:get': () => this.settings(),
      'settings:update': (input) => {
        const settings = { ...this.settings(), ...input, defaultRunLimits: { ...this.settings().defaultRunLimits, ...(input.defaultRunLimits ?? {}) } }
        this.database.setSetting('appSettings', settings as any)
        app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
        return settings
      },

      'permissions:list-persistent': () => this.database.listPersistentGrants(),
      'permissions:create-persistent': ({ workspaceId, toolName, path, expiresAt }) => {
        const normalizedPath = path.trim()
        if (!normalizedPath || normalizedPath.includes('\0')) throw new Error('授权路径无效')
        const grant = this.database.addPersistentGrant(workspaceId, toolName, normalizedPath, expiresAt)
        this.database.audit('security', 'create_persistent_grant', `已创建 ${toolName} 的永久授权`, { actor: 'user', outcome: 'approved', target: normalizedPath })
        return grant
      },
      'permissions:remove-persistent': ({ id }) => {
        this.database.removePersistentGrant(id)
        this.database.audit('security', 'remove_persistent_grant', '已撤销永久授权', { actor: 'user', outcome: 'succeeded', target: id })
      },

      'capability-packages:choose': async () => {
        const result = await dialog.showOpenDialog({ title: '选择本地能力包', properties: ['openDirectory'] })
        if (result.canceled || !result.filePaths[0]) return null
        const parsed = await this.capabilityPackages.inspect(result.filePaths[0])
        const selectionId = randomUUID()
        const fingerprint = this.capabilityFingerprint(parsed)
        this.capabilitySelections.set(selectionId, { parsed, fingerprint, expiresAt: Date.now() + 10 * 60_000 })
        return this.presentCapabilityPreview(selectionId, parsed)
      },
      'capability-packages:install': async ({ selectionId, workspaceId }) => {
        const selection = this.capabilitySelections.get(selectionId)
        this.capabilitySelections.delete(selectionId)
        if (!selection || selection.expiresAt < Date.now()) throw new Error('能力包选择已失效，请重新选择')
        const parsed = await this.capabilityPackages.inspect(selection.parsed.rootDirectory)
        if (this.capabilityFingerprint(parsed) !== selection.fingerprint) throw new Error('能力包在确认后发生变化，请重新选择')
        const installed = this.installedCapabilityPackages()
        if (installed.some((item) => item.name === parsed.manifest.name && item.version === parsed.manifest.version)) throw new Error('该版本能力包已经安装')
        const workspace = workspaceId ? this.database.getWorkspace(workspaceId) : undefined
        if (parsed.rules.length && !workspace) throw new Error('能力包包含规则，安装时必须选择作用工作区')

        const mcpInputs = parsed.mcpConfigs.map(({ relativePath, config }) => {
          if ('id' in config || 'secrets' in config) throw new Error(`能力包 MCP 配置不得携带 id 或 Secret：${relativePath}`)
          return DesktopInvokeContracts['mcp:upsert'].input.parse(config) as any
        })
        const ruleBlock = parsed.rules.map((rule) => `\n<!-- capability:${parsed.manifest.name}@${parsed.manifest.version}:${rule.relativePath} -->\n${rule.content.trim()}\n`).join('')
        if (workspace && Buffer.byteLength(`${workspace.rules ?? ''}${ruleBlock}`) > 128 * 1024) throw new Error('能力包规则会使工作区规则超过 128 KB 上限')
        const templateContents = await Promise.all(parsed.templates.map(async (template) => {
          const source = join(parsed.rootDirectory, template.relativePath)
          const info = await lstat(source)
          const canonical = await realpath(source)
          const fromRoot = relative(parsed.rootDirectory, canonical)
          if (info.isSymbolicLink() || !info.isFile() || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) throw new Error(`模板路径不安全：${template.relativePath}`)
          const content = await readFile(canonical)
          if (createHash('sha256').update(content).digest('hex') !== template.sha256) throw new Error(`模板在安装期间发生变化：${template.relativePath}`)
          return { template, content }
        }))
        const skillIds: string[] = []
        for (const skill of parsed.skills) skillIds.push((await this.skills.import({ directory: skill.directory })).id)
        const mcpServerIds = mcpInputs.map((input) => this.database.saveMcpServer({
          name: input.name,
          enabled: input.enabled,
          transport: input.transport.type === 'stdio' ? 'stdio' : 'http',
          config: { ...input.transport, toolNamespace: input.toolNamespace },
        }))
        if (workspace && parsed.rules.length) {
          this.database.updateWorkspaceRules(workspace.id, `${workspace.rules ?? ''}${ruleBlock}`.trim())
        }
        const packageId = randomUUID()
        const templateRoot = join(app.getPath('userData'), 'capability-packages', packageId)
        const templatePaths: string[] = []
        for (const { template, content } of templateContents) {
          const target = join(templateRoot, template.relativePath)
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await writeFile(target, content, { mode: 0o600 })
          templatePaths.push(target)
        }
        const entry: InstalledCapabilityPackage = {
          id: packageId,
          name: parsed.manifest.name,
          version: parsed.manifest.version,
          ...(workspace ? { workspaceId: workspace.id } : {}),
          skillIds,
          mcpServerIds,
          ruleSources: parsed.rules.map((rule) => rule.relativePath),
          templatePaths,
          installedAt: new Date().toISOString(),
        }
        this.database.setSetting('installedCapabilityPackages', [...installed, entry] as any)
        this.database.audit('capability', 'install_package', `已安装能力包 ${entry.name}@${entry.version}`, { actor: 'user', outcome: 'succeeded', target: entry.id, skillIds, mcpServerIds })
        return entry
      },
      'capability-packages:list': () => this.installedCapabilityPackages(),

      'memory:list': (input) => this.database.listMemory().map(presentMemory).filter((entry) => (!input?.workspaceId || entry.workspaceId === input.workspaceId) && (!input?.state || entry.state === input.state) && (!input?.scope || entry.scope === input.scope)),
      'memory:propose': (input) => { const id = this.database.saveMemory({ workspaceId: input.workspaceId, kind: input.type, scope: input.scope, content: input.content, confidence: input.confidence, source: [input.source], status: 'proposed' }); return presentMemory(this.database.getMemory(id)) },
      'memory:confirm': ({ id }) => { this.database.updateMemoryStatus(id, 'confirmed'); return presentMemory(this.database.getMemory(id)) },
      'memory:disable': ({ id }) => { this.database.updateMemoryStatus(id, 'disabled'); return presentMemory(this.database.getMemory(id)) },
      'memory:remove': ({ id }) => { this.database.deleteMemory(id) },

      'mcp:list': () => this.database.listMcpServers().map(presentMcp),
      'mcp:upsert': async (input) => {
        const secretValue = input.secrets && Object.keys(input.secrets).length ? await this.secrets.encrypt(JSON.stringify(input.secrets)) : undefined
        const id = this.database.saveMcpServer({ id: input.id, name: input.name, enabled: input.enabled, transport: input.transport.type === 'stdio' ? 'stdio' : 'http', config: { ...input.transport, toolNamespace: input.toolNamespace } }, secretValue)
        void this.runner.execute({ runId: 'system', toolId: 'mcp.disconnect', args: { serverId: id } }).catch(() => {})
        return presentMcp(this.database.listMcpServers().find((server) => server.id === id))
      },
      'mcp:remove': ({ id }) => { void this.runner.execute({ runId: 'system', toolId: 'mcp.disconnect', args: { serverId: id } }).catch(() => {}); for (const [state, serverId] of this.oauthServerByState) if (serverId === id) this.oauthServerByState.delete(state); this.database.removeMcpServer(id) },
      'mcp:test': async ({ id }) => {
        const started = Date.now(); let row = this.database.getMcpServer(id)
        if (!row) throw new Error('MCP Server 不存在')
        try {
          if (row.config?.auth === 'oauth' && typeof row.config?.url === 'string') {
            await this.oauth.refreshOAuthIfNeeded(id, row.config.url)
            row = this.database.getMcpServer(id)
          }
          const decrypted = row.encrypted_secret ? await this.secrets.decrypt(row.encrypted_secret) : undefined
          const secrets = decrypted ? this.decodeSecret(decrypted) : undefined
          const result = await this.runner.execute({ runId: 'system', toolId: 'mcp.list_tools', args: { serverId: id }, mcpServer: { id, transport: row.transport, config: row.config, ...(secrets ? { secrets } : {}) } })
          const fingerprint = createHash('sha256').update(JSON.stringify(result.tools ?? [])).digest('hex')
          const serverVersion = typeof result.serverVersion?.version === 'string' ? result.serverVersion.version : undefined
          this.database.updateMcpHealth(id, 'healthy', undefined, fingerprint, serverVersion)
          return { ok: true, latencyMs: Date.now() - started, ...(serverVersion ? { serverVersion } : {}), toolCount: result.tools?.length ?? 0 }
        } catch (error) {
          this.database.updateMcpHealth(id, 'unhealthy', error instanceof Error ? error.message : String(error))
          return { ok: false, latencyMs: Date.now() - started, error: { code: 'MCP_CONNECTION_FAILED', message: error instanceof Error ? error.message : String(error), retryable: true } }
        }
      },
      'mcp:start-oauth': async ({ id }) => {
        const row = this.database.getMcpServer(id)
        if (!row || row.transport !== 'http' || row.config?.auth !== 'oauth' || typeof row.config?.url !== 'string') throw new Error('该 MCP Server 未配置 OAuth Streamable HTTP')
        const started = await this.oauth.startOAuth(id, row.config.url)
        this.oauthServerByState.set(started.state, id)
        await shell.openExternal(started.authorizationUrl)
        this.database.audit('mcp', 'oauth_start', '已打开 MCP OAuth 授权页面', { actor: 'user', outcome: 'started', target: id })
        return started
      },
      'mcp:complete-oauth': ({ id, callbackUrl, state }) => this.completeOAuth(id, callbackUrl, state),

      'skills:list': () => this.skills.list(),
      'skills:get': ({ id }) => this.skills.get({ id }),
      'skills:import': ({ directory }) => this.skills.import({ directory }),
      'skills:remove': ({ id }) => this.skills.remove({ id }),
      'skills:set-enabled': (input) => this.skills.setEnabled(input),

      'automations:list': (input) => this.automations.list(input),
      'automations:upsert': (input) => this.automations.upsert(input),
      'automations:remove': ({ id }) => this.automations.remove(id),
      'automations:set-enabled': (input) => this.automations.setEnabled(input),
      'automations:run-now': ({ id }) => this.automations.runNow(id),

      'chrome:get-status': () => this.chrome.getStatus(),
      'chrome:list-grants': (input) => (input?.runId ? this.database.listChromeGrants(input.runId) : this.database.listAllChromeGrants()).map(presentChromeGrant),
      'chrome:request-binding': async ({ runId }) => { await this.chrome.bindLatest(runId); return { requested: true as const } },
      'chrome:revoke-grant': ({ id }) => this.chrome.revokeStoredGrant(id),

      'audit:list': (input) => { let items = this.database.listAudit(input?.limit ?? 100).map(presentAudit); if (input?.runId) items = items.filter((item) => item.runId === input.runId); if (input?.outcome) items = items.filter((item) => item.outcome === input.outcome); return { items } },
      'audit:export-diagnostics': async (input) => {
        const entries = this.database.listAudit().filter((entry) => !input?.runId || entry.run_id === input.runId)
        const result = await dialog.showSaveDialog({ title: '导出脱敏诊断包', defaultPath: `on-my-workbuddy-diagnostics-${new Date().toISOString().slice(0, 10)}.json` })
        if (result.canceled || !result.filePath) return null
        const redacted = redactSecrets(JSON.stringify(entries, null, 2))
          .replace(/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|secret|password)"\s*:\s*")[^"]+/gi, '$1REDACTED')
        await writeFile(result.filePath, redacted, { mode: 0o600 })
        return { path: result.filePath, entryCount: entries.length, redacted: true }
      },
      'artifacts:get-text': async ({ id, maxBytes }) => {
        const row = this.database.getArtifact(id); if (!row) throw new Error('产物不存在')
        const buffer = await readFile(row.path); const limit = maxBytes ?? 2 * 1024 * 1024
        return { artifact: presentArtifact(row), text: buffer.subarray(0, limit).toString('utf8'), truncated: buffer.length > limit }
      },
      'artifacts:reveal': ({ id }) => { const row = this.database.getArtifact(id); if (!row) throw new Error('产物不存在'); shell.showItemInFolder(row.path) },
      'artifacts:undo-change': async ({ id }) => {
        const diff = this.database.getArtifact(id)
        if (!diff || diff.kind !== 'diff') throw new Error('只能撤销文件 Diff 产物')
        const metadata = this.parseObject(diff.metadata_json)
        const path = typeof metadata.path === 'string' ? metadata.path : ''
        const afterSha256 = typeof metadata.afterSha256 === 'string' ? metadata.afterSha256 : ''
        const createdFile = metadata.createdFile === true
        if (!path || !afterSha256 || !diff.run_id) throw new Error('Diff 缺少安全撤销信息')
        const run = this.database.getRun(diff.run_id)
        const workspace = this.database.getWorkspace(run?.workspaceId)
        if (!run || !workspace?.root_path) throw new Error('Diff 所属工作区已不可用')
        let content = ''
        if (!createdFile) {
          const snapshotId = typeof metadata.snapshotArtifactId === 'string' ? metadata.snapshotArtifactId : ''
          const snapshot = this.database.getArtifact(snapshotId)
          if (!snapshot || snapshot.kind !== 'file_snapshot' || snapshot.run_id !== diff.run_id) throw new Error('原文件快照不存在')
          content = (await readFile(snapshot.path)).toString('utf8')
        }
        await this.runner.execute({ runId: run.id, toolId: 'file.restore', workspacePath: workspace.root_path, args: { path, content, expectedCurrentSha256: afterSha256, createdFile } })
        this.database.audit('artifact', 'undo_change', `已撤销 ${basename(path)} 的 Agent 变更`, { actor: 'user', outcome: 'succeeded', target: path }, run.id)
        return { restored: true as const, path, createdFileRemoved: createdFile }
      },
    }
  }

  private appInfo() { return { name: 'On My WorkBuddy', version: app.getVersion(), platform: process.platform, arch: process.arch, locale: app.getLocale() || 'zh-CN' } }
  async completeOAuthCallback(callbackUrl: string): Promise<void> {
    const state = new URL(callbackUrl).searchParams.get('state')
    if (!state) throw new Error('OAuth 回调缺少 state')
    const id = this.oauthServerByState.get(state)
    if (!id) throw new Error('OAuth 回调已失效或不属于当前应用会话')
    await this.completeOAuth(id, callbackUrl, state)
  }

  private async completeOAuth(id: string, callbackUrl: string, state: string): Promise<any> {
    await this.oauth.completeOAuth(id, callbackUrl, state)
    this.oauthServerByState.delete(state)
    this.database.updateMcpHealth(id, 'unknown')
    this.database.audit('mcp', 'oauth_complete', 'MCP OAuth 授权完成', { actor: 'user', outcome: 'succeeded', target: id })
    return presentMcp(this.database.listMcpServers().find((server) => server.id === id))
  }

  private decodeSecret(value: string): Record<string, unknown> | string {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : value
    } catch { return value }
  }
  private installedCapabilityPackages(): InstalledCapabilityPackage[] {
    const value = this.database.getSetting<unknown>('installedCapabilityPackages', [])
    return Array.isArray(value) ? value as InstalledCapabilityPackage[] : []
  }
  private capabilityFingerprint(parsed: ParsedCapabilityPackage): string {
    return createHash('sha256').update(JSON.stringify(parsed.files.map((file) => [file.relativePath, file.sha256]))).digest('hex')
  }
  private presentCapabilityPreview(selectionId: string, parsed: ParsedCapabilityPackage): any {
    return {
      selectionId,
      name: parsed.manifest.name,
      version: parsed.manifest.version,
      directory: parsed.rootDirectory,
      skills: parsed.skills.map((skill) => skill.relativePath),
      mcpConfigs: parsed.mcpConfigs.map((entry) => entry.config),
      rules: parsed.rules.map((entry) => entry.relativePath),
      templates: parsed.templates.map((entry) => ({ path: entry.relativePath, size: entry.size, sha256: entry.sha256 })),
      fileCount: parsed.files.length,
      totalBytes: parsed.totalBytes,
    }
  }
  private snapshotProfile(row: any): ModelProfile {
    const snapshot = row.modelSnapshot ?? {}
    return {
      id: snapshot.profileId ?? row.modelProfileId ?? 'deleted-profile',
      name: '任务模型快照',
      provider: snapshot.provider ?? 'openai',
      modelId: snapshot.modelId ?? 'unknown',
      capabilities: snapshot.capabilities ?? { contextWindow: 128_000, maxOutputTokens: 16_384, toolCalling: true, vision: false, reasoning: false, promptCaching: false },
      keyConfigured: false,
      isDefault: false,
      isSubagentDefault: false,
      createdAt: row.createdAt ?? new Date(0).toISOString(),
      updatedAt: row.updatedAt ?? new Date(0).toISOString(),
    }
  }
  private parseObject(value: unknown): Record<string, unknown> {
    if (typeof value !== 'string') return {}
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } catch { return {} }
  }
}
