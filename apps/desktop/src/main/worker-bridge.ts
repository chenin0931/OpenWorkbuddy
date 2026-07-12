import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { parsePiAgentHostEvent, parseToolRunnerEvent, WORKER_PROTOCOL_VERSION } from '@onmyworkbuddy/contracts'
import { redactSecrets } from '@onmyworkbuddy/core'

type MessageHandler = (message: any) => void | Promise<void>

class ManagedWorker {
  private process: UtilityProcess | undefined
  private handlers = new Set<MessageHandler>()
  private exitHandlers = new Set<(code: number | null) => void>()

  constructor(private entryName: string) {}

  start(): void {
    if (this.process) return
    const entry = join(__dirname, `${this.entryName}.cjs`)
    if (!existsSync(entry)) throw new Error(`Worker 构建文件不存在：${entry}`)
    const child = utilityProcess.fork(entry, [], {
      serviceName: `On My WorkBuddy ${this.entryName}`,
      stdio: 'pipe',
      env: { LANG: process.env.LANG ?? 'zh_CN.UTF-8', PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
    })
    child.on('message', (message) => { for (const handler of this.handlers) void handler(message) })
    child.on('exit', (code) => {
      if (this.process !== child) return
      this.process = undefined
      for (const handler of this.exitHandlers) handler(code)
    })
    child.stderr?.on('data', (chunk) => console.error(`[${this.entryName}] ${redactSecrets(String(chunk).trimEnd())}`))
    this.process = child
  }

  onMessage(handler: MessageHandler): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler) }
  onExit(handler: (code: number | null) => void): () => void { this.exitHandlers.add(handler); return () => this.exitHandlers.delete(handler) }

  send(message: unknown): void {
    this.start()
    this.process!.postMessage(message)
  }

  stop(): void { const child = this.process; this.process = undefined; child?.kill() }
}

export class AgentHostBridge {
  private worker = new ManagedWorker('agent-host')
  private tests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private activeRuns = new Set<string>()

  constructor(onMessage: MessageHandler) {
    this.worker.onMessage((raw) => {
      let message: any
      try { message = parsePiAgentHostEvent(raw) } catch (error) { console.error('Invalid Agent Host event', error); return }
      if (message?.type === 'test-provider.result') {
        const pending = this.tests.get(message.requestId)
        if (!pending) return
        clearTimeout(pending.timer); this.tests.delete(message.requestId)
        if (message.ok) pending.resolve(message)
        else pending.reject(new Error(message.error ?? '连接测试失败'))
        return
      }
      if (message?.type === 'agent.event' && (message.event?.type === 'agent.completed' || message.event?.type === 'agent.failed')) this.activeRuns.delete(message.runId)
      return onMessage(message)
    })
    this.worker.onExit((code) => {
      const error = `Agent Host 进程意外退出${code === null ? '' : `（退出码 ${code}）`}`
      for (const pending of this.tests.values()) { clearTimeout(pending.timer); pending.reject(new Error(error)) }
      this.tests.clear()
      // app.child-process-gone performs one atomic recovery for both workers.
      // Do not race it by turning resumable runs into terminal failures here.
      this.activeRuns.clear()
    })
  }

  startRun(input: any): void { this.activeRuns.add(input.runId); this.worker.send({ protocolVersion: WORKER_PROTOCOL_VERSION, type: 'start', ...input }) }
  cancelRun(runId: string): void { this.worker.send({ protocolVersion: WORKER_PROTOCOL_VERSION, type: 'cancel', runId }) }
  steer(runId: string, content: string, images: Array<{ data: string; mimeType: string }> = []): void { this.worker.send({ protocolVersion: WORKER_PROTOCOL_VERSION, type: 'steer', runId, content, ...(images.length ? { images } : {}) }) }
  toolResult(requestId: string, ok: boolean, result?: unknown, error?: string): void { this.worker.send({ protocolVersion: WORKER_PROTOCOL_VERSION, type: 'tool.result', requestId, ok, ...(result !== undefined ? { result } : {}), ...(error ? { error } : {}) }) }
  async testProvider(input: { provider: string; modelId: string; apiKey: string }): Promise<any> {
    const requestId = randomUUID()
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.tests.delete(requestId); reject(new Error('连接测试超时')) }, 45_000)
      this.tests.set(requestId, { resolve, reject, timer })
    })
    this.worker.send({ protocolVersion: WORKER_PROTOCOL_VERSION, type: 'test-provider', requestId, ...input })
    return promise
  }
  stop(): void { this.worker.stop() }
}

export class ToolRunnerBridge {
  private worker = new ManagedWorker('tool-runner')
  private pending = new Map<string, { runId?: string; resolve: (value: any) => void; reject: (error: Error) => void; onProgress?: (event: any) => void }>()

  constructor() {
    this.worker.onMessage((raw) => {
      let message: any
      try { message = parseToolRunnerEvent(raw) } catch (error) { console.error('Invalid Tool Runner event', error); return }
      const pending = this.pending.get(message?.requestId)
      if (!pending) return
      if (message.type === 'progress') { pending.onProgress?.(message); return }
      if (message.type !== 'result') return
      this.pending.delete(message.requestId)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(Object.assign(new Error(message.error ?? '工具执行失败'), { code: message.code, details: message.details }))
    })
    this.worker.onExit((code) => {
      const error = new Error(`Tool Runner 进程意外退出${code === null ? '' : `（退出码 ${code}）`}`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
  }

  execute(input: any, onProgress?: (event: any) => void): Promise<any> {
    const requestId = input.requestId ?? randomUUID()
    const promise = new Promise((resolve, reject) => this.pending.set(requestId, {
      ...(typeof input.runId === 'string' ? { runId: input.runId } : {}),
      resolve,
      reject,
      ...(onProgress ? { onProgress } : {}),
    }))
    this.worker.send({ protocolVersion: WORKER_PROTOCOL_VERSION, type: 'execute', ...input, requestId })
    return promise
  }
  cancel(requestId: string): void { this.worker.send({ protocolVersion: WORKER_PROTOCOL_VERSION, type: 'cancel', requestId }) }
  cancelRun(runId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.runId === runId) this.cancel(requestId)
    }
  }
  stop(): void { this.worker.stop() }
}
