import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { moonshotaiCnProvider } from '@earendil-works/pi-ai/providers/moonshotai-cn'

const PROVIDER = 'moonshotai-cn'
const MODEL_ID = 'kimi-k2.7-code'

async function readSecret() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('此测试必须在交互式终端运行，以避免 API Key 进入命令行参数、环境变量或管道日志。')
  }
  process.stdout.write('Kimi API Key（输入不会显示）：')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  let secret = ''
  try {
    for await (const chunk of process.stdin) {
      for (const byte of chunk) {
        if (byte === 3) throw new Error('已取消')
        if (byte === 13 || byte === 10) {
          process.stdout.write('\n')
          return secret.trim()
        }
        if (byte === 127 || byte === 8) {
          secret = secret.slice(0, -1)
          continue
        }
        secret += String.fromCharCode(byte)
      }
    }
    return secret.trim()
  } finally {
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
}

function redact(message, secret) {
  return String(message ?? 'Kimi 在线测试失败')
    .replaceAll(secret, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi, '$1[REDACTED]')
}

function textOf(message) {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

async function appConnectionSmoke(secret) {
  const { _electron: electron } = await import('@playwright/test')
  const desktopRoot = resolve(process.cwd())
  const userData = await mkdtemp(join(tmpdir(), 'workbuddy-kimi-app-smoke-'))
  let application
  try {
    application = await electron.launch({
      cwd: desktopRoot,
      args: ['dist/main/index.cjs', `--user-data-dir=${userData}`],
      env: { ...process.env, NODE_ENV: 'test' },
    })
    const window = await application.firstWindow()
    const result = await window.evaluate(async ({ apiKey, provider, modelId }) => {
      const api = globalThis.workbuddy
      if (!api) throw new Error('preload API 不可用')
      const profile = await api.models.upsert({ name: 'Kimi online smoke', provider, modelId })
      try {
        await api.models.setSecret({ profileId: profile.id, apiKey })
        return await api.models.test({ profileId: profile.id })
      } finally {
        await api.models.remove({ id: profile.id })
      }
    }, { apiKey: secret, provider: PROVIDER, modelId: MODEL_ID })
    if (!result?.ok) throw new Error(result?.error?.message ?? '应用内连接测试失败')
    return { ok: true, provider: result.provider, model: result.modelId, latencyMs: result.latencyMs }
  } finally {
    await application?.close().catch(() => undefined)
    await rm(userData, { recursive: true, force: true })
  }
}

let apiKey = ''
try {
  apiKey = await readSecret()
  if (!apiKey) throw new Error('API Key 不能为空')

  const credentials = new InMemoryCredentialStore()
  await credentials.modify(PROVIDER, async () => ({ type: 'api_key', key: apiKey }))
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } })
  models.setProvider(moonshotaiCnProvider())
  const catalogModel = models.getModel(PROVIDER, MODEL_ID)
  if (!catalogModel) throw new Error(`Pi 模型目录中没有 ${MODEL_ID}`)

  // Keep the smoke test bounded even if a future Pi catalog advertises a larger output cap.
  const model = { ...catalogModel, contextWindow: 262_144, maxTokens: 8_192 }
  const nonce = `workbuddy-${randomUUID()}`
  const tool = {
    name: 'echo_nonce',
    description: 'Return the nonce supplied by the user. Use this tool exactly once for the smoke test.',
    parameters: {
      type: 'object',
      properties: { nonce: { type: 'string' } },
      required: ['nonce'],
      additionalProperties: false,
    },
  }
  const messages = [{
    role: 'user',
    content: `这是连接与工具调用测试。必须调用 echo_nonce，nonce 必须精确填写为 ${nonce}。拿到工具结果后只输出该 nonce。`,
    timestamp: Date.now(),
  }]
  const options = { maxTokens: 8_192, reasoning: 'medium', maxRetries: 0, timeoutMs: 120_000, sessionId: `smoke-${randomUUID()}` }
  const started = Date.now()
  const first = await models.completeSimple(model, { systemPrompt: 'You are a deterministic connection-test agent. Follow the tool instruction exactly.', messages, tools: [tool] }, options)
  if (first.stopReason === 'error' || first.stopReason === 'aborted') throw new Error(first.errorMessage ?? '首次模型请求失败')
  const call = first.content.find((part) => part.type === 'toolCall' && part.name === 'echo_nonce')
  if (!call) throw new Error(`模型没有调用 echo_nonce（stopReason=${first.stopReason}）`)
  if (call.arguments?.nonce !== nonce) throw new Error('模型生成的工具参数与测试 nonce 不一致')

  messages.push(first)
  messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: nonce }],
    details: { verified: true },
    isError: false,
    timestamp: Date.now(),
  })
  const second = await models.completeSimple(model, { systemPrompt: 'You are a deterministic connection-test agent. Follow the tool instruction exactly.', messages, tools: [tool] }, options)
  if (second.stopReason === 'error' || second.stopReason === 'aborted') throw new Error(second.errorMessage ?? '工具结果回传后的模型请求失败')
  if (!textOf(second).includes(nonce)) throw new Error('最终回答没有包含经过工具验证的 nonce')

  const usage = {
    inputTokens: first.usage.input + second.usage.input,
    outputTokens: first.usage.output + second.usage.output,
    cachedInputTokens: first.usage.cacheRead + second.usage.cacheRead,
  }
  const appConnection = process.argv.includes('--app') ? await appConnectionSmoke(apiKey) : undefined
  process.stdout.write(`${JSON.stringify({ ok: true, provider: PROVIDER, model: MODEL_ID, toolRoundTrip: true, latencyMs: Date.now() - started, usage, ...(appConnection ? { appConnection } : {}) })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, provider: PROVIDER, model: MODEL_ID, error: redact(error instanceof Error ? error.message : error, apiKey) })}\n`)
  process.exitCode = 1
} finally {
  apiKey = ''
}
