import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import net, { type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import type { ChromeBridgeStatus } from '@onmyworkbuddy/contracts'
import type { AppDatabase } from './database'

const MAX_FRAME = 64 * 1024 * 1024

class FrameDecoder {
  private buffer = Buffer.alloc(0)
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const values: unknown[] = []
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0)
      if (size > MAX_FRAME) throw new Error('Chrome bridge frame 超过限制')
      if (this.buffer.length < size + 4) break
      const body = this.buffer.subarray(4, 4 + size)
      this.buffer = this.buffer.subarray(4 + size)
      values.push(JSON.parse(body.toString('utf8')))
    }
    return values
  }
}

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

export class ChromeBridge {
  private server: net.Server | undefined
  private sockets = new Set<Socket>()
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private lastSeenAt?: string
  private latestGrant?: any

  constructor(
    private socketPath: string,
    private database: AppDatabase,
    private onEvent?: (event: { event: string; data: any }) => void,
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    await mkdir(dirname(this.socketPath), { recursive: true })
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath) } catch (error) { console.warn('Could not remove stale Chrome Bridge socket', error) }
    }
    const server = net.createServer((socket) => this.attach(socket))
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.socketPath, () => { server.off('error', reject); resolve() }) })
    this.server = server
  }

  private attach(socket: Socket): void {
    this.sockets.add(socket)
    this.lastSeenAt = new Date().toISOString()
    this.database.setSetting('chromeExtensionSeenAt', this.lastSeenAt)
    const decoder = new FrameDecoder()
    socket.on('data', (chunk) => {
      try { for (const message of decoder.push(chunk)) this.handle(message as any) }
      catch (error) { console.error('Chrome bridge frame error', error); socket.destroy() }
    })
    let removed = false
    const remove = (): void => {
      if (removed) return
      removed = true
      this.sockets.delete(socket); this.lastSeenAt = new Date().toISOString()
      if (this.sockets.size === 0) {
        for (const [requestId, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error('Chrome Bridge 已断开，任务可在重新连接后恢复')); this.pending.delete(requestId) }
        this.onEvent?.({ event: 'bridge.disconnected', data: { at: this.lastSeenAt } })
      }
    }
    socket.on('close', remove); socket.on('error', remove)
  }

  private handle(message: any): void {
    this.lastSeenAt = new Date().toISOString()
    if (message?.type === 'response' && typeof message.requestId === 'string') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.requestId)
      if (message.ok) pending.resolve(message.data)
      else pending.reject(Object.assign(new Error(message.error?.message ?? 'Chrome Bridge 操作失败'), { code: message.error?.code, retryable: message.error?.retryable }))
      return
    }
    if (message?.type === 'event') {
      if (message.event === 'tab.userAuthorized' || message.event === 'tab.userSelected') this.latestGrant = message.data
      if (message.event === 'tab.childAdded' && typeof message.data?.taskId === 'string' && Number.isInteger(message.data?.tabId)) {
        const existing = this.database.listChromeGrants(message.data.taskId)
        const rootTabId = Number(message.data.rootTabId)
        const hasPersistedRoot = Number.isInteger(rootTabId) && existing.some((grant) => (
          grant.parent_tab_id == null && Number(grant.tab_id) === rootTabId
        ))
        if (hasPersistedRoot && !existing.some((grant) => Number(grant.tab_id) === Number(message.data.tabId))) {
          this.database.addChromeGrant({
            runId: message.data.taskId,
            tabId: Number(message.data.tabId),
            windowId: message.data.windowId,
            url: message.data.url,
            title: message.data.title,
            parentTabId: rootTabId,
          })
        }
      }
      this.onEvent?.({ event: String(message.event), data: message.data })
    }
  }

  async request(command: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
    const socket = [...this.sockets].at(-1)
    if (!socket || socket.destroyed) throw new Error('Chrome Bridge 未连接。请安装扩展和 Native Host，并点击扩展图标。')
    const requestId = randomUUID()
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`Chrome Bridge 超时：${command}`)) }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
    })
    socket.write(frame({ requestId, command, params }))
    return result
  }

  async bindLatest(runId: string): Promise<any> {
    const data = await this.request('bind', { taskId: runId, ...(this.latestGrant?.grantId ? { grantId: this.latestGrant.grantId } : {}) })
    const id = this.database.addChromeGrant({ runId, tabId: data.tabId ?? data.rootTabId, windowId: data.windowId, url: data.url, title: data.title })
    return { id, ...data }
  }

  async executeTool(runId: string, toolId: string, args: Record<string, any>): Promise<any> {
    const grants = this.database.listChromeGrants(runId)
    if (!grants.length) throw new Error('当前任务没有 Chrome 标签授权。请先点击扩展图标并在应用中绑定。')
    const rootGrant = grants.find((grant) => grant.parent_tab_id == null)
    if (!rootGrant) throw new Error('当前任务的 Chrome 根标签授权已失效，请重新绑定。')
    const tabId = Number(args.tabId ?? rootGrant.tab_id)
    if (toolId !== 'chrome_open_tab' && toolId !== 'chrome_tabs' && !grants.some((grant) => Number(grant.tab_id) === tabId)) {
      throw new Error('该 Chrome 标签不属于当前任务授权范围')
    }
    const map: Record<string, string> = {
      chrome_tabs: 'tabs.list', chrome_snapshot: args.kind === 'ax' ? 'ax' : 'dom', chrome_screenshot: 'screenshot',
      chrome_navigate: 'navigate', chrome_click: 'click', chrome_type: 'type', chrome_open_tab: 'openTab',
    }
    const command = map[toolId]
    if (!command) throw new Error(`未知 Chrome 工具：${toolId}`)
    const params: Record<string, unknown> = { ...args, taskId: runId }
    if (toolId === 'chrome_open_tab') params.tabId = Number(rootGrant.tab_id)
    const result = await this.request(command, params, toolId === 'chrome_navigate' ? 45_000 : 30_000)
    if (toolId === 'chrome_open_tab' && result?.tabId) this.database.addChromeGrant({ runId, tabId: result.tabId, windowId: result.windowId, url: result.url, title: result.title, parentTabId: rootGrant.tab_id })
    return result
  }

  async revokeStoredGrant(id: string): Promise<void> {
    const row = this.database.listAllChromeGrants().find((grant) => grant.id === id)
    if (!row) return
    try { await this.request('detach', { taskId: row.run_id, tabId: Number(row.tab_id), all: row.parent_tab_id == null }) } catch (error) {
      // Local revocation remains authoritative even when Chrome is offline.
      console.warn('Chrome detach during revocation failed', error)
    }
    if (row.parent_tab_id == null) this.database.db.prepare('DELETE FROM chrome_grants WHERE run_id=?').run(row.run_id)
    else this.database.removeChromeGrant(id)
  }

  getStatus(): ChromeBridgeStatus {
    const manifest = join(process.env.HOME ?? '', 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.onmyworkbuddy.chrome.json')
    return {
      // A prior Native Messaging connection is durable installation evidence.
      // Connection state is separate so offline Chrome is not "uninstalled".
      extensionInstalled: Boolean(this.database.getSetting<string | undefined>('chromeExtensionSeenAt', undefined)),
      nativeHostInstalled: existsSync(manifest),
      connected: this.sockets.size > 0,
      version: '0.3.0',
      ...(this.lastSeenAt ? { lastSeenAt: this.lastSeenAt } : {}),
    }
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Chrome Bridge 已停止')) }
    this.pending.clear()
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = undefined
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath) } catch (error) { console.warn('Could not remove Chrome Bridge socket', error) }
    }
  }
}
