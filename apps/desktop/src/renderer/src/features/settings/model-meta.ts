import type { ModelProvider } from '../../types'

export const MODEL_PROVIDER_META: Record<ModelProvider, {
  name: string
  mark: string
  defaultModelId: string
  keyPlaceholder: string
}> = {
  openai: { name: 'OpenAI', mark: 'O', defaultModelId: 'gpt-5.2', keyPlaceholder: 'sk-…' },
  anthropic: { name: 'Anthropic', mark: 'A', defaultModelId: 'claude-opus-4-6', keyPlaceholder: 'sk-ant-…' },
  'moonshotai-cn': { name: 'Kimi / Moonshot', mark: 'K', defaultModelId: 'kimi-k2.7-code', keyPlaceholder: 'Moonshot API Key' },
}
