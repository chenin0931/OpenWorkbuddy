import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
  writeFileSafely,
} from './runner-security'

type Command = ToolRunnerCommand

type ResultMessage = { type: 'result'; requestId: string; ok: true; result: any } | { type: 'result'; requestId: string; ok: false; error: string; code?: string }

const parent = process.parentPort
if (!parent) throw new Error('Tool Runner 必须由 Electron utilityProcess 启动')

const processes = new Map<string, ChildProcess>()
type McpClientEntry = { client: Client; transport: StdioClientTransport | StreamableHTTPClientTransport; fingerprint: string }
type CachedMcpConnection = McpClientEntry & { close(): Promise<void> }
const mcpConnections = new FingerprintedConnectionCache<CachedMcpConnection>()
const MAX_TEXT = 2 * 1024 * 1024

const send = (message: Record<string, unknown>): void => parent.postMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, ...message })
const hash = (content: Buffer | string): string => createHash('sha256').update(content).digest('hex')
function sanitizeEnv(): Record<string, string> {
  const blocked = /(api[_-]?key|token|secret|password|credential|authorization|cookie)/i
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !blocked.test(entry[0])))
}

function truncate(value: string, max = 128 * 1024): { text: string; truncated: boolean; total: number } {
  const bytes = Buffer.byteLength(value)
  if (bytes <= max) return { text: value, truncated: false, total: bytes }
  const head = value.slice(0, Math.floor(max * 0.72))
  const tail = value.slice(-Math.floor(max * 0.24))
  return { text: `${head}\n\n…[已截断 ${bytes - max} bytes]…\n\n${tail}`, truncated: true, total: bytes }
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
  const { toolId, args, workspacePath } = command
  switch (toolId) {
    case 'file.list': {
      const { root, target } = await resolveAuthorizedPath(workspacePath, args.path ?? '.')
      const entries = await readdir(target, { withFileTypes: true })
      return { root, path: target, entries: entries.slice(0, args.limit ?? 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' })) }
    }
    case 'file.read': {
      const { target } = await resolveAuthorizedPath(workspacePath, args.path)
      const info = await stat(target)
      if (!info.isFile()) throw new Error('目标不是文件')
      if (info.size > MAX_TEXT) throw new Error('文件超过 2 MB；请使用 Shell 或专用工具分段读取')
      const content = await readFile(target, 'utf8')
      return { path: target, content, sha256: hash(content), mtimeMs: info.mtimeMs, size: info.size }
    }
    case 'file.search': {
      const { target } = await resolveAuthorizedPath(workspacePath, args.path ?? '.')
      const rgArgs = ['--json', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', String(args.query), target]
      return runProcess(command.requestId, 'rg', rgArgs, target, 60_000)
    }
    case 'file.write': {
      return writeFileSafely(workspacePath, String(args.path), String(args.content), args.expectedSha256)
    }
    case 'file.replace': {
      return replaceFileTextSafely(workspacePath, String(args.path), String(args.oldText), String(args.newText), Boolean(args.replaceAll), args.expectedSha256)
    }
    case 'file.restore': {
      if (typeof args.path !== 'string' || typeof args.content !== 'string' || typeof args.createdFile !== 'boolean') throw new Error('file.restore 参数无效')
      return restoreFileSafely(workspacePath, args.path, args.content, args.expectedCurrentSha256, args.createdFile)
    }
    case 'file.delete': {
      const { target, root } = await resolveAuthorizedPath(workspacePath, args.path)
      const info = await lstat(target)
      if (!info.isFile()) throw new Error('仅支持删除文件')
      const before = await readFile(target)
      const trash = join(root, '.on-my-workbuddy-trash')
      await mkdir(trash, { recursive: true })
      const destination = join(trash, `${Date.now()}-${basename(target)}`)
      await rename(target, destination)
      return { path: target, trashedTo: destination, beforeSha256: hash(before), size: before.byteLength }
    }
    case 'shell.run': {
      const cwd = (await resolveAuthorizedPath(workspacePath, args.cwd ?? '.')).target
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
    let stdout = ''; let stderr = ''; let settled = false
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGTERM') } catch { /* The process may have exited between timeout and signal delivery. */ }
      reject(new Error(`命令超时（${timeoutMs} ms）`))
    }, timeoutMs)
    const collect = (stream: NodeJS.ReadableStream | null, channel: 'stdout' | 'stderr'): void => {
      stream?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        if (channel === 'stdout') stdout += text; else stderr += text
        send({ type: 'progress', requestId, channel, text: text.slice(-16_384) })
      })
    }
    collect(child.stdout, 'stdout'); collect(child.stderr, 'stderr')
    child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); processes.delete(requestId); reject(error) } })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true; clearTimeout(timer); processes.delete(requestId)
      const out = truncate(stdout); const err = truncate(stderr)
      if (code !== 0) reject(Object.assign(new Error(`命令退出码 ${code}${signal ? ` (${signal})` : ''}\n${err.text || out.text}`), { code: 'COMMAND_FAILED', details: { code, signal, stdout: out, stderr: err } }))
      else resolvePromise({ code: code ?? 0, signal, stdout: out.text, stderr: err.text, stdoutTruncated: out.truncated, stderrTruncated: err.truncated, totalBytes: out.total + err.total })
    })
  })
}

parent.on('message', async (event: { data: unknown }) => {
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
