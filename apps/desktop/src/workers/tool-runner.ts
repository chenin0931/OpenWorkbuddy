import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import process from 'node:process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { parseToolRunnerCommand, WORKER_PROTOCOL_VERSION, type ToolRunnerCommand } from '@onmyworkbuddy/contracts'

import {
  FingerprintedConnectionCache,
  prepareMcpConnection,
  replaceFileTextSafely,
  resolveAuthorizedPath,
  restoreFileSafely,
  safeFetch,
  safeWebSearch,
  trashFileSafely,
  writeFileSafely,
} from './runner-security'

type Command = ToolRunnerCommand

type ResultMessage = { type: 'result'; requestId: string; ok: true; result: any } | { type: 'result'; requestId: string; ok: false; error: string; code?: string }

const parent = process.parentPort
if (!parent && process.env.NODE_ENV !== 'test') throw new Error('Tool Runner 必须由 Electron utilityProcess 启动')

const processes = new Map<string, ChildProcess>()
type McpClientEntry = { client: Client; transport: StdioClientTransport | StreamableHTTPClientTransport; fingerprint: string }
type CachedMcpConnection = McpClientEntry & { close(): Promise<void> }
const mcpConnections = new FingerprintedConnectionCache<CachedMcpConnection>()
const MAX_TEXT = 2 * 1024 * 1024
const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024

const send = (message: Record<string, unknown>): void => {
  if (!parent) throw new Error('Tool Runner IPC 不可用')
  parent.postMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, ...message })
}
const hash = (content: Buffer | string): string => createHash('sha256').update(content).digest('hex')
function sanitizeEnv(): Record<string, string> {
  const blocked = /(api[_-]?key|token|secret|password|credential|authorization|cookie)/i
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !blocked.test(entry[0])))
}

export interface BoundedTextSnapshot {
  text: string
  truncated: boolean
  total: number
  omittedBytes: number
}

/**
 * Retains a fixed-size byte window while a process is running. The first
 * portion is stable and the second portion rolls forward, so diagnostics keep
 * both the command's opening context and its most recent output without ever
 * accumulating the complete stream in memory.
 */
export class BoundedTextCapture {
  private readonly headLimit: number
  private readonly tailLimit: number
  private head = Buffer.alloc(0)
  private tail = Buffer.alloc(0)
  private totalBytes = 0

  constructor(private readonly maxBytes = MAX_PROCESS_OUTPUT_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) throw new Error('maxBytes 必须是不小于 2 的整数')
    this.headLimit = Math.max(1, Math.floor(maxBytes * 0.75))
    this.tailLimit = maxBytes - this.headLimit
  }

  append(value: Buffer | string): void {
    const input = Buffer.isBuffer(value) ? value : Buffer.from(value)
    this.totalBytes += input.length

    let offset = 0
    if (this.head.length < this.headLimit) {
      const length = Math.min(this.headLimit - this.head.length, input.length)
      if (length > 0) {
        this.head = Buffer.concat([this.head, Buffer.from(input.subarray(0, length))])
        offset = length
      }
    }

    const remainder = input.subarray(offset)
    if (remainder.length === 0) return
    if (remainder.length >= this.tailLimit) {
      this.tail = Buffer.from(remainder.subarray(remainder.length - this.tailLimit))
      return
    }

    const combined = Buffer.concat([this.tail, remainder])
    this.tail = combined.length <= this.tailLimit
      ? combined
      : Buffer.from(combined.subarray(combined.length - this.tailLimit))
  }

  get retainedBytes(): number {
    return this.head.length + this.tail.length
  }

  snapshot(): BoundedTextSnapshot {
    const omittedBytes = Math.max(0, this.totalBytes - this.retainedBytes)
    if (omittedBytes === 0) {
      return {
        text: Buffer.concat([this.head, this.tail]).toString('utf8'),
        truncated: false,
        total: this.totalBytes,
        omittedBytes,
      }
    }
    return {
      text: `${this.head.toString('utf8')}\n\n…[已省略 ${omittedBytes} bytes]…\n\n${this.tail.toString('utf8')}`,
      truncated: true,
      total: this.totalBytes,
      omittedBytes,
    }
  }
}

async function connectMcp(server: Record<string, any>): Promise<McpClientEntry> {
  const serverId = String(server.id)
  const prepared = prepareMcpConnection(server)
  return mcpConnections.getOrCreate(serverId, prepared.fingerprint, async (): Promise<CachedMcpConnection> => {
      const client = new Client({ name: 'on-my-workbuddy', version: '0.3.0' })
      const transport = prepared.transport === 'stdio'
        ? new StdioClientTransport({
            command: prepared.stdio!.command,
            args: prepared.stdio!.args,
            ...(prepared.stdio!.cwd ? { cwd: prepared.stdio!.cwd } : {}),
            env: { ...sanitizeEnv(), ...prepared.stdio!.secretEnvironment },
            stderr: 'pipe',
          })
        : new StreamableHTTPClientTransport(prepared.http!.url, { requestInit: { headers: prepared.http!.headers } })
      try {
        // MCP SDK 1.29's concrete StreamableHTTP type is stricter than its
        // Transport interface under exactOptionalPropertyTypes, despite being
        // the SDK-provided implementation.
        await client.connect(transport as any)
      } catch (error) {
        await client.close().catch(() => {})
        throw error
      }
      return { client, transport, fingerprint: prepared.fingerprint, close: () => client.close() }
    })
}

async function disconnectMcp(serverId: string): Promise<boolean> {
  return mcpConnections.disconnect(serverId)
}

async function execute(command: Extract<Command, { type: 'execute' }>): Promise<any> {
  const { toolId, args, workspacePath, authorizedRoot } = command
  const authorizationRoot = authorizedRoot ?? workspacePath
  switch (toolId) {
    case 'file.list': {
      const { root, target } = await resolveAuthorizedPath(authorizationRoot, args.path ?? '.', false, workspacePath)
      const entries = await readdir(target, { withFileTypes: true })
      return { root, path: target, entries: entries.slice(0, args.limit ?? 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' })) }
    }
    case 'file.read': {
      const { target } = await resolveAuthorizedPath(authorizationRoot, args.path, false, workspacePath)
      const info = await stat(target)
      if (!info.isFile()) throw new Error('目标不是文件')
      if (info.size > MAX_TEXT) throw new Error('文件超过 2 MB；请使用 Shell 或专用工具分段读取')
      const content = await readFile(target, 'utf8')
      return { path: target, content, sha256: hash(content), mtimeMs: info.mtimeMs, size: info.size }
    }
    case 'file.search': {
      const { target } = await resolveAuthorizedPath(authorizationRoot, args.path ?? '.', false, workspacePath)
      const rgArgs = ['--json', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', String(args.query), target]
      return runProcess(command.requestId, 'rg', rgArgs, target, 60_000)
    }
    case 'file.write': {
      return writeFileSafely(authorizationRoot, String(args.path), String(args.content), args.expectedSha256, workspacePath)
    }
    case 'file.replace': {
      return replaceFileTextSafely(authorizationRoot, String(args.path), String(args.oldText), String(args.newText), Boolean(args.replaceAll), args.expectedSha256, workspacePath)
    }
    case 'file.restore': {
      if (typeof args.path !== 'string' || typeof args.content !== 'string' || typeof args.createdFile !== 'boolean') throw new Error('file.restore 参数无效')
      return restoreFileSafely(authorizationRoot, args.path, args.content, args.expectedCurrentSha256, args.createdFile, workspacePath, workspacePath)
    }
    case 'file.delete': {
      return trashFileSafely(authorizationRoot, args.path, workspacePath, workspacePath)
    }
    case 'shell.run': {
      const cwd = (await resolveAuthorizedPath(authorizationRoot, args.cwd ?? '.', false, workspacePath)).target
      return runProcess(command.requestId, '/bin/zsh', ['-lc', String(args.command)], cwd, Math.min(Number(args.timeoutMs ?? 120_000), 600_000))
    }
    case 'web.search': return safeWebSearch(String(args.query), Number(args.maxResults ?? 8))
    case 'web.fetch': return safeFetch(String(args.url))
    case 'mcp.list_tools': {
      if (!command.mcpServer) throw new Error('未找到 MCP Server 配置')
      const { client } = await connectMcp(command.mcpServer)
      const result = await client.listTools()
      return { serverId: command.mcpServer.id, tools: result.tools, serverVersion: client.getServerVersion() }
    }
    case 'mcp.call_tool': {
      if (!command.mcpServer) throw new Error('未找到 MCP Server 配置')
      const { client } = await connectMcp(command.mcpServer)
      return client.callTool({ name: String(args.toolName), arguments: args.arguments ?? {} })
    }
    case 'mcp.disconnect': {
      return { disconnected: await disconnectMcp(String(args.serverId)) }
    }
    default: throw Object.assign(new Error(`未知 Runner 工具：${toolId}`), { code: 'UNKNOWN_TOOL' })
  }
}

function runProcess(requestId: string, executable: string, args: string[], cwd: string, timeoutMs: number): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, env: sanitizeEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    processes.set(requestId, child)
    const stdout = new BoundedTextCapture()
    const stderr = new BoundedTextCapture()
    let settled = false
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGTERM') } catch { /* The process may have exited between timeout and signal delivery. */ }
      reject(new Error(`命令超时（${timeoutMs} ms）`))
    }, timeoutMs)
    const collect = (stream: NodeJS.ReadableStream | null, channel: 'stdout' | 'stderr'): void => {
      stream?.on('data', (chunk: Buffer) => {
        if (channel === 'stdout') stdout.append(chunk); else stderr.append(chunk)
        const progressChunk = chunk.subarray(Math.max(0, chunk.length - 16_384))
        send({ type: 'progress', requestId, channel, text: progressChunk.toString('utf8') })
      })
    }
    collect(child.stdout, 'stdout'); collect(child.stderr, 'stderr')
    child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); processes.delete(requestId); reject(error) } })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true; clearTimeout(timer); processes.delete(requestId)
      const out = stdout.snapshot(); const err = stderr.snapshot()
      if (code !== 0) reject(Object.assign(new Error(`命令退出码 ${code}${signal ? ` (${signal})` : ''}\n${err.text || out.text}`), { code: 'COMMAND_FAILED', details: { code, signal, stdout: out, stderr: err } }))
      else resolvePromise({
        code: code ?? 0,
        signal,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        stdoutOmittedBytes: out.omittedBytes,
        stderrOmittedBytes: err.omittedBytes,
        totalBytes: out.total + err.total,
      })
    })
  })
}

parent?.on('message', async (event: { data: unknown }) => {
  let command: Command
  try { command = parseToolRunnerCommand(event.data) } catch (error) { console.error('Invalid Tool Runner IPC', error); return }
  if (command.type === 'cancel') {
    const child = processes.get(command.requestId)
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* The process may already be gone. */ }
    }
    return
  }
  try {
    const result = await execute(command)
    send({ type: 'result', requestId: command.requestId, ok: true, result } satisfies ResultMessage)
  } catch (error: any) {
    send({ type: 'result', requestId: command.requestId, ok: false, error: error instanceof Error ? error.message : String(error), code: error?.code, details: error?.details } satisfies ResultMessage & { details?: unknown })
  }
})

process.on('exit', () => { void mcpConnections.closeAll() })
