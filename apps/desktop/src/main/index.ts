import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from 'electron'
import { DesktopEventSchema, DesktopInvokeContracts, type DesktopInvokeChannel, type RunEvent } from '@onmyworkbuddy/contracts'
import { AppDatabase } from './database'
import { SecretStore } from './secret-store'
import { ArtifactStore } from './artifact-store'
import { AgentHostBridge, ToolRunnerBridge } from './worker-bridge'
import { ChromeBridge } from './chrome-bridge'
import { ToolBroker } from './tool-broker'
import { RunCoordinator } from './run-coordinator'
import { SkillService } from './skill-service'
import { configureAutoUpdates } from './update-service'
import { AutomationService } from './automation-service'
import { IpcApi } from './ipc-api'
import { McpOAuthService, type McpOAuthStoredSecret } from './mcp-oauth'
import { createRendererNavigationPolicy, isRendererNavigationAllowed } from './navigation-policy'
import { migrateLegacyBrandDirectory } from './brand-migration'
import { DocumentRenderService } from './document-render-service'

app.setName('OpenWorkbuddy')
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
let cleanup: (() => Promise<void>) | undefined
let oauthCallbackHandler: ((url: string) => void) | undefined
const queuedOAuthCallbacks: string[] = []

function routeOAuthCallback(url: string): void {
  if (!url.startsWith('onmyworkbuddy://oauth/callback')) return
  if (oauthCallbackHandler) oauthCallbackHandler(url)
  else queuedOAuthCallbacks.push(url)
}

app.on('open-url', (event, url) => { event.preventDefault(); routeOAuthCallback(url) })

const trayIcon = (): Electron.NativeImage => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path fill="black" d="M4 3.5A2.5 2.5 0 0 1 6.5 1h9A2.5 2.5 0 0 1 18 3.5v11a2.5 2.5 0 0 1-2.5 2.5H11l-4.8 3.2c-.5.33-1.2-.03-1.2-.64V17A2.5 2.5 0 0 1 2.5 14.5v-11H4Zm3.2 4.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm7.6 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6ZM7 12.4a.8.8 0 0 0-.64 1.28A5.78 5.78 0 0 0 11 16a5.78 5.78 0 0 0 4.64-2.32.8.8 0 1 0-1.28-.96A4.18 4.18 0 0 1 11 14.4a4.18 4.18 0 0 1-3.36-1.68A.8.8 0 0 0 7 12.4Z"/></svg>`
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
  icon.setTemplateImage(true)
  return icon
}

function showWindow(): void {
  if (!mainWindow) return
  mainWindow.show(); mainWindow.focus()
}

function createWindow(): BrowserWindow {
  const rendererEntryPath = join(__dirname, '../renderer/index.html')
  const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
  const navigationPolicy = createRendererNavigationPolicy(rendererEntryPath, rendererDevUrl)
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    title: 'OpenWorkbuddy',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  const enforceNavigationPolicy = (event: Electron.Event, url: string): void => {
    if (!isRendererNavigationAllowed(url, navigationPolicy)) event.preventDefault()
  }
  window.webContents.on('will-navigate', enforceNavigationPolicy)
  window.webContents.on('will-redirect', enforceNavigationPolicy)
  window.on('close', (event) => { if (!quitting) { event.preventDefault(); window.hide() } })
  window.once('ready-to-show', () => window.show())
  if (rendererDevUrl) void window.loadURL(rendererDevUrl)
  else void window.loadFile(rendererEntryPath)
  return window
}

async function initialize(): Promise<void> {
  const userData = app.getPath('userData')
  if (process.platform === 'darwin') {
    const migration = await migrateLegacyBrandDirectory(app.getPath('appData'), userData)
    if (migration.migrated) console.info('Migrated preview data to the OpenWorkbuddy application directory.')
  }
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  const database = new AppDatabase(join(userData, 'workbuddy.sqlite3'))
  database.interruptOpenTraces()
  database.interruptManagedProcesses()
  const startupRecovery = database.recoverInterruptedWork()
  const storedSettings = database.getSetting<any>('appSettings', {})
  const retentionDays = Number(storedSettings.detailedLogRetentionDays)
  const retentionBytes = Number(storedSettings.detailedLogMaxBytes)
  database.pruneDetailedLogs(
    Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 90,
    Number.isFinite(retentionBytes) && retentionBytes > 0 ? retentionBytes : 500 * 1024 * 1024,
  )
  const secrets = new SecretStore()
  const artifacts = new ArtifactStore(join(userData, 'artifacts'), database)
  const runner = new ToolRunnerBridge()
  const coordinatorRef: { current?: RunCoordinator } = {}
  const coordinatorInstance = (): RunCoordinator => {
    if (!coordinatorRef.current) throw new Error('Run Coordinator 尚未初始化')
    return coordinatorRef.current
  }
  const host = new AgentHostBridge((message) => coordinatorInstance().onHostMessage(message))
  const broadcast = (event: RunEvent): void => {
    const parsed = DesktopEventSchema.parse(event)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workbuddy:run-event', parsed)
  }
  const chrome = new ChromeBridge(join(userData, 'chrome.sock'), database, ({ event, data }) => {
    database.audit('chrome', event, `Chrome Bridge: ${event}`, { actor: 'tool', outcome: event.includes('Failed') ? 'failed' : 'succeeded', data })
    if (event === 'bridge.disconnected' && !quitting && coordinatorRef.current) coordinatorRef.current.handleChromeDisconnect()
  })
  await chrome.start()
  const notify = (title: string, body: string): void => { if (Notification.isSupported()) new Notification({ title, body, silent: false }).show() }
  const updateEligibility = configureAutoUpdates(notify)
  database.audit('app', 'configure_updates', `自动更新：${updateEligibility.reason}`, { actor: 'system', outcome: updateEligibility.enabled ? 'allowed' : 'blocked' })
  if (startupRecovery.pausedRuns) {
    notify('任务已恢复为暂停状态', `${startupRecovery.pausedRuns} 个未完成任务可从原记录继续。`)
  }
  const oauthRef: { current?: McpOAuthService } = {}
  const documentRenderer = new DocumentRenderService(runner, artifacts)
  const broker = new ToolBroker(
    database,
    runner,
    artifacts,
    chrome,
    secrets,
    (event) => coordinatorInstance().emit(event),
    (input) => coordinatorInstance().delegate(input),
    async (serverId, serverUrl) => {
      if (!oauthRef.current) throw new Error('MCP OAuth 服务尚未初始化')
      await oauthRef.current.refreshOAuthIfNeeded(serverId, serverUrl)
    },
    documentRenderer,
  )
  const coordinator = new RunCoordinator(database, secrets, host, runner, broker, artifacts, broadcast, notify)
  coordinatorRef.current = coordinator
  let lastWorkerRecoveryAt = 0
  const workerFailureHandler = (_event: Electron.Event, details: Electron.Details): void => {
    const name = String(details.serviceName ?? details.name ?? '')
    if (quitting || details.type !== 'Utility' || details.reason === 'clean-exit') return
    if (!name.includes('OpenWorkbuddy agent-host') && !name.includes('OpenWorkbuddy tool-runner')) return
    // Stopping the surviving peer can emit a second child-process-gone event.
    // A short suppression window makes the pair one recovery incident.
    if (Date.now() - lastWorkerRecoveryAt < 1_000) return
    lastWorkerRecoveryAt = Date.now()
    host.stop(); runner.stop()
    coordinator.recoverAfterWorkerFailure(name, details.reason)
  }
  app.on('child-process-gone', workerFailureHandler)
  const skills = new SkillService(database, join(userData, 'skills'))
  await skills.scan()
  const installedSkillNames = new Set((await skills.list()).map((skill) => skill.name))
  for (const skillName of ['data-analysis', 'document-export']) {
    if (installedSkillNames.has(skillName)) continue
    const bundledSkill = app.isPackaged
      ? join(process.resourcesPath, 'BundledSkills', skillName)
      : join(app.getAppPath(), 'resources', 'skills', skillName)
    try {
      await skills.importDirectory(bundledSkill)
    } catch (error) {
      database.audit('skill', 'install_bundled', `内置 ${skillName} Skill 安装失败`, {
        actor: 'system', outcome: 'failed', target: bundledSkill,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const automations = new AutomationService(database, (request) => coordinator.create({ workspaceId: request.workspaceId, objective: request.objective, title: request.title, modelProfileId: request.modelProfileId }), {
    onError: (error, automation) => notify('自动化执行失败', `${automation.name}: ${error instanceof Error ? error.message : String(error)}`),
  })
  const oauth = new McpOAuthService({
    persistence: {
      load: async (serverId): Promise<McpOAuthStoredSecret | undefined> => {
        const row = database.getMcpServer(serverId)
        if (!row?.encrypted_secret) return undefined
        try { return JSON.parse(await secrets.decrypt(row.encrypted_secret)) as McpOAuthStoredSecret } catch { return undefined }
      },
      save: async (serverId, value) => database.setMcpEncryptedSecret(serverId, await secrets.encrypt(JSON.stringify(value))),
    },
  })
  oauthRef.current = oauth
  const api = new IpcApi(database, secrets, host, runner, coordinator, broker, chrome, skills, automations, oauth, artifacts)
  oauthCallbackHandler = (url) => { void api.completeOAuthCallback(url).then(() => notify('MCP 已授权', 'OAuth 令牌已安全保存到本机。')).catch((error) => notify('MCP OAuth 失败', error instanceof Error ? error.message : String(error))) }
  for (const url of queuedOAuthCallbacks.splice(0)) oauthCallbackHandler(url)
  if (process.platform === 'darwin') app.setAsDefaultProtocolClient('onmyworkbuddy')

  ipcMain.handle('workbuddy:invoke', async (event, channel: DesktopInvokeChannel, input: unknown) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('拒绝未授权的 IPC 调用')
    const contract = DesktopInvokeContracts[channel]
    const handler = api.handlers[channel]
    if (!contract || !handler) throw new Error(`未知 IPC channel：${String(channel)}`)
    const parsedInput = contract.input.parse(input)
    const output = await handler(parsedInput)
    return contract.output.parse(output)
  })

  mainWindow = createWindow()
  tray = new Tray(trayIcon())
  tray.setToolTip('OpenWorkbuddy')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 OpenWorkbuddy', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } },
  ]))
  tray.on('click', showWindow)

  cleanup = async () => {
    app.removeListener('child-process-gone', workerFailureHandler)
    automations.dispose(); host.stop(); runner.stop(); await chrome.stop(); database.close()
  }
}

app.whenReady().then(initialize).catch((error) => {
  dialogError('OpenWorkbuddy 启动失败', error)
  app.quit()
})

app.on('second-instance', (_event, argv) => { showWindow(); const url = argv.find((argument) => argument.startsWith('onmyworkbuddy://oauth/callback')); if (url) routeOAuthCallback(url) })
app.on('activate', () => { if (!mainWindow) mainWindow = createWindow(); else showWindow() })
app.on('before-quit', () => { quitting = true })
app.on('will-quit', (event) => {
  if (!cleanup) return
  event.preventDefault()
  const operation = cleanup; cleanup = undefined
  void operation().finally(() => app.exit(0))
})
app.on('window-all-closed', () => { /* menu bar background service remains alive */ })

function dialogError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(title, message)
  if (Notification.isSupported()) new Notification({ title, body: message.slice(0, 500) }).show()
}
