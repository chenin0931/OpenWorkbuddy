import { describe, expect, it, vi } from 'vitest'
import type { Model } from '@earendil-works/pi-ai'
import {
  KIMI_K27_CODE_MODEL_ID,
  KIMI_K27_CONTEXT_WINDOW,
  KIMI_K27_MAX_OUTPUT_TOKENS,
  MOONSHOTAI_CN_BASE_URL,
  isRetryableProviderError,
  normalizeRuntimeModel,
  prepareRuntimeStreamOptions,
  redactSecretValues,
  resolveRuntimeProvider,
  resolveRuntimeThinkingLevel,
  toPublicProviderError,
} from './agent-host-runtime'

const catalogKimiModel = {
  id: KIMI_K27_CODE_MODEL_ID,
  name: 'Kimi K2.7 Code',
  api: 'openai-completions',
  provider: 'moonshotai-cn',
  baseUrl: MOONSHOTAI_CN_BASE_URL,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStrictMode: false,
    thinkingFormat: 'deepseek',
  },
  reasoning: true,
  thinkingLevelMap: { off: null },
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_144,
  maxTokens: 262_144,
} as Model<any>

describe('Agent Host provider routing', () => {
  it('accepts only explicitly supported providers', () => {
    expect(resolveRuntimeProvider('openai')).toBe('openai')
    expect(resolveRuntimeProvider('anthropic')).toBe('anthropic')
    expect(resolveRuntimeProvider('moonshotai-cn')).toBe('moonshotai-cn')
    expect(() => resolveRuntimeProvider('moonshotai')).toThrow(/不支持的模型 Provider/)
    expect(() => resolveRuntimeProvider('openai-compatible')).toThrow(/不支持的模型 Provider/)
    expect(() => resolveRuntimeProvider(undefined)).toThrow(/不支持的模型 Provider/)
  })

  it('pins K2.7 Code to the Moonshot Chat Completions contract', () => {
    const model = normalizeRuntimeModel('moonshotai-cn', KIMI_K27_CODE_MODEL_ID, catalogKimiModel)
    expect(model).toMatchObject({
      id: KIMI_K27_CODE_MODEL_ID,
      api: 'openai-completions',
      provider: 'moonshotai-cn',
      baseUrl: MOONSHOTAI_CN_BASE_URL,
      reasoning: true,
      contextWindow: KIMI_K27_CONTEXT_WINDOW,
      maxTokens: KIMI_K27_MAX_OUTPUT_TOKENS,
      thinkingLevelMap: { off: null },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: 'max_tokens',
        supportsStrictMode: false,
        thinkingFormat: 'deepseek',
      },
    })
    expect(() => normalizeRuntimeModel('moonshotai-cn', KIMI_K27_CODE_MODEL_ID, undefined)).toThrow(/Pi 模型目录缺少/)
  })

  it('defaults K2.7 Code to thinking and rejects an explicit off level', () => {
    expect(resolveRuntimeThinkingLevel('moonshotai-cn', KIMI_K27_CODE_MODEL_ID, undefined)).toBe('high')
    expect(resolveRuntimeThinkingLevel('moonshotai-cn', KIMI_K27_CODE_MODEL_ID, 'medium')).toBe('medium')
    expect(() => resolveRuntimeThinkingLevel('moonshotai-cn', KIMI_K27_CODE_MODEL_ID, 'off')).toThrow(/仅支持思考模式/)
    expect(resolveRuntimeThinkingLevel('openai', 'gpt-5', undefined)).toBe('off')
  })
})

describe('Moonshot request guard', () => {
  it('keeps the upstream hook but removes incompatible fields and injects the stable cache key', async () => {
    const upstream = vi.fn(async (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      temperature: 0.2,
      reasoning_effort: 'high',
      prompt_cache_retention: '24h',
      custom_safe_field: 'preserved',
    }))
    const options = prepareRuntimeStreamOptions('moonshotai-cn', KIMI_K27_CODE_MODEL_ID, {
      temperature: 0.7,
      maxTokens: 99_999,
      reasoning: 'high',
      cacheRetention: 'long',
      onPayload: upstream,
    }, 'run-stable-cache-key')

    expect(options.temperature).toBeUndefined()
    expect(options.maxTokens).toBe(KIMI_K27_MAX_OUTPUT_TOKENS)
    expect(options.reasoning).toBe('high')
    expect(options.cacheRetention).toBe('none')

    const payload = await options.onPayload?.({
      model: KIMI_K27_CODE_MODEL_ID,
      messages: [{ role: 'assistant', content: null, reasoning_content: 'keep-for-pi-replay' }],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 262_144,
      max_tokens: 262_144,
      store: false,
      n: 2,
      top_p: 0.2,
      presence_penalty: 1,
      frequency_penalty: 1,
      functions: [],
      function_call: 'auto',
      parallel_tool_calls: true,
      tool_choice: 'auto',
      thinking: { type: 'enabled' },
    }, catalogKimiModel) as Record<string, unknown>

    expect(upstream).toHaveBeenCalledOnce()
    expect(payload).toMatchObject({
      model: KIMI_K27_CODE_MODEL_ID,
      stream: true,
      max_tokens: KIMI_K27_MAX_OUTPUT_TOKENS,
      prompt_cache_key: 'run-stable-cache-key',
      custom_safe_field: 'preserved',
      tool_choice: 'auto',
      thinking: { type: 'enabled' },
      messages: [{ role: 'assistant', content: null, reasoning_content: 'keep-for-pi-replay' }],
    })
    for (const field of [
      'temperature', 'reasoning_effort', 'prompt_cache_retention', 'max_completion_tokens',
      'store', 'n', 'top_p', 'presence_penalty', 'frequency_penalty',
      'functions', 'function_call', 'parallel_tool_calls',
    ]) expect(payload).not.toHaveProperty(field)
  })

  it('does not add a cache key to connection tests', async () => {
    const options = prepareRuntimeStreamOptions('moonshotai-cn', KIMI_K27_CODE_MODEL_ID, { maxTokens: 8 })
    const payload = await options.onPayload?.({ model: KIMI_K27_CODE_MODEL_ID, max_tokens: 8 }, catalogKimiModel) as Record<string, unknown>
    expect(payload.max_tokens).toBe(8)
    expect(payload).not.toHaveProperty('prompt_cache_key')
  })

  it('fails closed for unsupported tool choice and disabled thinking', async () => {
    expect(() => prepareRuntimeStreamOptions('moonshotai-cn', KIMI_K27_CODE_MODEL_ID, {
      toolChoice: 'required',
    })).toThrow(/不支持 required/)

    const options = prepareRuntimeStreamOptions('moonshotai-cn', KIMI_K27_CODE_MODEL_ID, {})
    await expect(options.onPayload?.({ thinking: { type: 'disabled' } }, catalogKimiModel)).rejects.toThrow(/仅支持 enabled thinking/)
  })
})

describe('public provider errors', () => {
  it('redacts exact, encoded and header secret values before publishing an error', () => {
    const secret = 'moonshot-test/value+not-real'
    const message = [
      `request failed for ${secret}`,
      `url=https://example.invalid?api_key=${encodeURIComponent(secret)}`,
      `Authorization: Bearer ${secret}`,
    ].join(' | ')
    const redacted = redactSecretValues(message, [secret])
    expect(redacted).not.toContain(secret)
    expect(redacted).not.toContain(encodeURIComponent(secret))
    expect(redacted).toContain('[REDACTED]')
  })

  it('classifies transient failures without treating auth or validation errors as retryable', () => {
    expect(isRetryableProviderError({ status: 429, message: 'rate limited' })).toBe(true)
    expect(isRetryableProviderError({ status: 503, message: 'unavailable' })).toBe(true)
    expect(isRetryableProviderError(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isRetryableProviderError({ status: 401, message: 'invalid api key' })).toBe(false)
    expect(isRetryableProviderError({ status: 400, message: 'invalid request' })).toBe(false)
    expect(isRetryableProviderError(new Error('unknown provider failure'))).toBe(false)
  })

  it('returns a redacted public connection-test error', () => {
    const secret = ['sk', 'not-a-real-secret-value'].join('-')
    const result = toPublicProviderError(Object.assign(new Error(`401 invalid api key ${secret}`), { status: 401 }), [secret])
    expect(result).toEqual({ message: '401 invalid api key [REDACTED]', retryable: false })
  })
})
