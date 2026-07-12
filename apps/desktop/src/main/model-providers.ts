import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { moonshotaiCnProvider } from '@earendil-works/pi-ai/providers/moonshotai-cn'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import type { ModelCatalogItem, ProviderId } from '@onmyworkbuddy/contracts'

export const KIMI_PROVIDER_ID = 'moonshotai-cn' as const
export const KIMI_DEFAULT_MODEL_ID = 'kimi-k2.7-code'
export const KIMI_CONTEXT_WINDOW = 262_144
export const KIMI_MAX_OUTPUT_TOKENS = 32_768

export function getModelProvider(provider: ProviderId) {
  switch (provider) {
    case 'openai': return openaiProvider()
    case 'anthropic': return anthropicProvider()
    case KIMI_PROVIDER_ID: return moonshotaiCnProvider()
    default: throw new Error(`不支持的模型服务商：${String(provider)}`)
  }
}

export function getModelCatalog(provider: ProviderId): ModelCatalogItem[] {
  return getModelProvider(provider).getModels().map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: provider === KIMI_PROVIDER_ID && /^kimi-k2\.7-code(?:-highspeed)?$/.test(model.id)
      ? KIMI_MAX_OUTPUT_TOKENS
      : model.maxTokens,
    vision: model.input.includes('image'),
    reasoning: model.reasoning,
  })).sort((left, right) => left.name.localeCompare(right.name))
}
