import { describe, expect, it } from 'vitest'
import { getModelCatalog, getModelProvider, KIMI_DEFAULT_MODEL_ID } from './model-providers'

describe('model provider routing', () => {
  it('routes Moonshot profiles to the dedicated China API provider', () => {
    const provider = getModelProvider('moonshotai-cn')
    expect(provider.id).toBe('moonshotai-cn')
    expect(provider.baseUrl).toBe('https://api.moonshot.cn/v1')
  })

  it('exposes Kimi K2.7 Code with product-safe limits', () => {
    expect(getModelCatalog('moonshotai-cn')).toContainEqual(expect.objectContaining({
      id: KIMI_DEFAULT_MODEL_ID,
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
      reasoning: true,
      vision: true,
    }))
  })

  it('fails closed for an unknown provider', () => {
    expect(() => getModelProvider('unknown' as never)).toThrow('不支持的模型服务商')
  })
})
