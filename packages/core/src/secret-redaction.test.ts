import { describe, expect, it } from 'vitest'
import { classifyModelError, redactSecrets } from './secret-redaction'

describe('runtime secret redaction', () => {
  it('removes exact and key-shaped secrets from public text', () => {
    const secret = 'sentinel-not-a-real-key'
    const shapedSecret = ['sk', 'example123456789'].join('-')
    const result = redactSecrets(`Authorization: Bearer ${secret}; api_key=${shapedSecret}; ${secret}`, [secret])
    expect(result).not.toContain(secret)
    expect(result).not.toContain(shapedSecret)
    expect(result).toContain('[REDACTED]')
  })

  it('does not retry authentication or invalid model requests', () => {
    expect(classifyModelError(new Error('401 Unauthorized')).retryable).toBe(false)
    expect(classifyModelError(new Error('400 invalid_request_error: model not found')).retryable).toBe(false)
  })

  it('allows retry for rate limits and transient failures', () => {
    expect(classifyModelError(new Error('429 rate limit exceeded')).retryable).toBe(true)
    expect(classifyModelError(new Error('503 upstream timeout')).retryable).toBe(true)
  })
})
