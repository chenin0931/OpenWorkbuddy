import type { Model, ModelThinkingLevel, SimpleStreamOptions } from '@earendil-works/pi-ai'

export const RUNTIME_PROVIDER_IDS = ['openai', 'anthropic', 'moonshotai-cn'] as const
export type RuntimeProviderName = (typeof RUNTIME_PROVIDER_IDS)[number]

export const KIMI_K27_CODE_MODEL_ID = 'kimi-k2.7-code'
export const MOONSHOTAI_CN_BASE_URL = 'https://api.moonshot.cn/v1'
export const KIMI_K27_CONTEXT_WINDOW = 262_144
export const KIMI_K27_MAX_OUTPUT_TOKENS = 32_768

type RuntimeStreamOptions = SimpleStreamOptions & { toolChoice?: unknown }

export interface PublicProviderError {
  message: string
  retryable: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function resolveRuntimeProvider(provider: unknown): RuntimeProviderName {
  if (typeof provider === 'string' && (RUNTIME_PROVIDER_IDS as readonly string[]).includes(provider)) {
    return provider as RuntimeProviderName
  }
  throw new Error(`不支持的模型 Provider：${typeof provider === 'string' ? provider : 'invalid'}`)
}

export function isKimiK27Code(provider: RuntimeProviderName, modelId: string): boolean {
  return provider === 'moonshotai-cn' && modelId.toLowerCase() === KIMI_K27_CODE_MODEL_ID
}

export function fallbackRuntimeModel(provider: RuntimeProviderName, id: string): Model<any> {
  if (provider === 'openai') {
    return {
      id,
      name: id,
      api: 'openai-responses',
      provider,
      baseUrl: 'https://api.openai.com/v1',
      reasoning: /reason|thinking|o\d|gpt-5/i.test(id),
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    }
  }
  if (provider === 'anthropic') {
    return {
      id,
      name: id,
      api: 'anthropic-messages',
      provider,
      baseUrl: 'https://api.anthropic.com',
      reasoning: /reason|thinking|claude-(opus|sonnet)/i.test(id),
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 16_384,
    }
  }
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: MOONSHOTAI_CN_BASE_URL,
    reasoning: /thinking|k2\.[567]|k2-?\.?(?:5|6|7)|k2\.7-code/i.test(id),
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: KIMI_K27_CONTEXT_WINDOW,
    maxTokens: KIMI_K27_MAX_OUTPUT_TOKENS,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
      thinkingFormat: 'deepseek',
    },
  }
}

/**
 * Keep Pi's provider catalog model as the source of truth, then apply the
 * narrower K2.7 Code contract documented by Moonshot. This intentionally
 * leaves Pi's deepseek-format response parser in charge of reasoning_content.
 */
export function normalizeRuntimeModel(
  provider: RuntimeProviderName,
  modelId: string,
  catalogModel: Model<any> | undefined,
): Model<any> {
  if (!isKimiK27Code(provider, modelId)) return catalogModel ?? fallbackRuntimeModel(provider, modelId)
  if (!catalogModel) throw new Error(`Pi 模型目录缺少必需模型：${KIMI_K27_CODE_MODEL_ID}`)

  return {
    ...catalogModel,
    id: KIMI_K27_CODE_MODEL_ID,
    api: 'openai-completions',
    provider: 'moonshotai-cn',
    baseUrl: MOONSHOTAI_CN_BASE_URL,
    reasoning: true,
    contextWindow: KIMI_K27_CONTEXT_WINDOW,
    maxTokens: KIMI_K27_MAX_OUTPUT_TOKENS,
    thinkingLevelMap: { ...catalogModel.thinkingLevelMap, off: null },
    compat: {
      ...catalogModel.compat,
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
      thinkingFormat: 'deepseek',
    },
  }
}

export function resolveRuntimeThinkingLevel(
  provider: RuntimeProviderName,
  modelId: string,
  requested: ModelThinkingLevel | undefined,
): ModelThinkingLevel {
  if (!isKimiK27Code(provider, modelId)) return requested ?? 'off'
  if (requested === 'off') throw new Error(`${KIMI_K27_CODE_MODEL_ID} 仅支持思考模式，不能关闭思考`)
  return requested ?? 'high'
}

function guardKimiPayload(payload: unknown, promptCacheKey?: string): unknown {
  if (!isRecord(payload)) throw new Error('Moonshot 请求 payload 必须是对象')
  const guarded: Record<string, unknown> = { ...payload }

  // K2.7 Code has a fixed thinking mode. Omit OpenAI-only or unsupported
  // controls rather than relying on a permissive compatible endpoint.
  for (const field of [
    'temperature',
    'reasoning_effort',
    'store',
    'prompt_cache_retention',
    'max_completion_tokens',
    'functions',
    'function_call',
    'parallel_tool_calls',
    'n',
    'top_p',
    'presence_penalty',
    'frequency_penalty',
  ]) delete guarded[field]

  const toolChoice = guarded.tool_choice
  if (toolChoice !== undefined && toolChoice !== null && toolChoice !== 'auto' && toolChoice !== 'none') {
    throw new Error('Moonshot K2.7 Code 不支持 required 或指定函数形式的 tool_choice')
  }

  const thinking = guarded.thinking
  if (isRecord(thinking) && thinking.type !== undefined && thinking.type !== 'enabled') {
    throw new Error('Moonshot K2.7 Code 仅支持 enabled thinking')
  }

  const requestedMax = typeof guarded.max_tokens === 'number' && Number.isFinite(guarded.max_tokens)
    ? Math.floor(guarded.max_tokens)
    : KIMI_K27_MAX_OUTPUT_TOKENS
  guarded.max_tokens = Math.max(1, Math.min(requestedMax, KIMI_K27_MAX_OUTPUT_TOKENS))

  if (promptCacheKey) guarded.prompt_cache_key = promptCacheKey
  else delete guarded.prompt_cache_key

  return guarded
}

/**
 * Apply provider-specific request safety after any upstream onPayload hook so
 * no later transform can re-introduce incompatible Moonshot fields.
 */
export function prepareRuntimeStreamOptions(
  provider: RuntimeProviderName,
  modelId: string,
  options: RuntimeStreamOptions,
  promptCacheKey?: string,
): RuntimeStreamOptions {
  if (!isKimiK27Code(provider, modelId)) return options
  if (options.toolChoice !== undefined && options.toolChoice !== null && options.toolChoice !== 'auto' && options.toolChoice !== 'none') {
    throw new Error('Moonshot K2.7 Code 不支持 required 或指定函数形式的 tool_choice')
  }

  const upstreamOnPayload = options.onPayload
  const safeOptions: RuntimeStreamOptions = { ...options }
  delete safeOptions.temperature
  delete safeOptions.toolChoice
  return {
    ...safeOptions,
    ...(options.toolChoice === 'auto' || options.toolChoice === 'none' ? { toolChoice: options.toolChoice } : {}),
    maxTokens: Math.max(1, Math.min(options.maxTokens ?? KIMI_K27_MAX_OUTPUT_TOKENS, KIMI_K27_MAX_OUTPUT_TOKENS)),
    cacheRetention: 'none',
    reasoning: options.reasoning ?? 'high',
    onPayload: async (payload, model) => {
      const transformed = await upstreamOnPayload?.(payload, model)
      return guardKimiPayload(transformed ?? payload, promptCacheKey)
    },
  }
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  if (isRecord(error)) {
    const nested = isRecord(error.error) ? error.error.message : undefined
    if (typeof nested === 'string' && nested) return nested
    if (typeof error.message === 'string' && error.message) return error.message
  }
  return '模型服务请求失败'
}

function secretRepresentations(secret: string): string[] {
  const candidates = new Set<string>([secret, encodeURIComponent(secret)])
  const jsonEscaped = JSON.stringify(secret).slice(1, -1)
  if (jsonEscaped) candidates.add(jsonEscaped)
  return [...candidates].filter(Boolean).sort((a, b) => b.length - a.length)
}

export function redactSecretValues(message: string, secrets: readonly (string | undefined)[]): string {
  let redacted = message
  for (const secret of secrets) {
    if (!secret) continue
    for (const representation of secretRepresentations(secret)) redacted = redacted.split(representation).join('[REDACTED]')
  }

  redacted = redacted
    .replace(/(\b(?:authorization|x-api-key|api[_ -]?key)\b\s*[:=]\s*)(?:bearer\s+)?[^\s,;"'}\]]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|moonshot)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')

  return redacted.slice(0, 4_096)
}

function errorRecords(error: unknown): Record<string, unknown>[] {
  if (!isRecord(error)) return []
  const records = [error]
  if (isRecord(error.cause)) records.push(error.cause)
  if (isRecord(error.response)) records.push(error.response)
  if (isRecord(error.error)) records.push(error.error)
  return records
}

export function isRetryableProviderError(error: unknown): boolean {
  const records = errorRecords(error)
  const statuses = records.flatMap((record) => [record.status, record.statusCode]).filter((value): value is number => typeof value === 'number')
  if (statuses.some((status) => [408, 409, 425, 429, 500, 502, 503, 504].includes(status))) return true
  if (statuses.some((status) => [400, 401, 403, 404, 405, 413, 422].includes(status))) return false

  const codes = records
    .map((record) => record.code)
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETDOWN|ENETUNREACH|UND_ERR_(?:CONNECT_)?TIMEOUT/i.test(codes)) return true
  if (/INVALID|AUTH|PERMISSION|UNAUTHORIZED|FORBIDDEN/i.test(codes)) return false

  const message = rawErrorMessage(error)
  if (/abort(?:ed)?|cancel(?:led)?/i.test(message)) return false
  if (/rate.?limit|too many requests|temporar(?:y|ily) unavailable|service unavailable|gateway timeout|network error|fetch failed|connection reset|timed? ?out/i.test(message)) return true
  if (/invalid (?:request|api.?key)|unauthori[sz]ed|forbidden|permission|unsupported|context length|bad request/i.test(message)) return false
  return false
}

export function toPublicProviderError(error: unknown, secrets: readonly (string | undefined)[] = []): PublicProviderError {
  return {
    message: redactSecretValues(rawErrorMessage(error), secrets),
    retryable: isRetryableProviderError(error),
  }
}
