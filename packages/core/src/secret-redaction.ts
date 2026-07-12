import type { PublicError } from '@onmyworkbuddy/contracts'

const KEY_SHAPED_SECRET = /\bsk-[A-Za-z0-9_-]{8,}\b/g
const BEARER_SECRET = /(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi
const NAMED_SECRET = /((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;"']+/gi

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '模型请求失败'
}

/** Redact runtime-known secret values before text crosses a process or UI boundary. */
export function redactSecrets(value: unknown, secrets: readonly string[] = []): string {
  let text = errorText(value)
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.replaceAll(secret, '[REDACTED]')
  }
  text = text.replace(KEY_SHAPED_SECRET, '[REDACTED]')
  text = text.replace(BEARER_SECRET, '$1[REDACTED]')
  text = text.replace(NAMED_SECRET, '$1[REDACTED]')
  return text
}

/** Convert provider/network failures into a minimal, retry-aware public error. */
export function classifyModelError(error: unknown, secrets: readonly string[] = []): PublicError {
  const message = redactSecrets(error, secrets)
  const normalized = message.toLowerCase()

  if (/\b(401|403)\b|unauthori[sz]ed|authentication|invalid api key|incorrect api key/.test(normalized)) {
    return { code: 'MODEL_AUTH_FAILED', message, retryable: false, suggestedAction: '检查或替换该模型配置的 API Key。' }
  }
  if (/\b429\b|rate.?limit|too many requests|quota/.test(normalized)) {
    return { code: 'MODEL_RATE_LIMITED', message, retryable: true, suggestedAction: '稍后重试，或检查账户余额与限速。' }
  }
  if (/\b(400|404|422)\b|invalid_request|invalid request|bad request|model .*not found/.test(normalized)) {
    return { code: 'MODEL_REQUEST_INVALID', message, retryable: false, suggestedAction: '检查模型 ID 和模型参数。' }
  }
  if (/\b5\d\d\b|timeout|timed out|econnreset|econnrefused|enotfound|network|socket hang up|fetch failed/.test(normalized)) {
    return { code: 'MODEL_CONNECTION_FAILED', message, retryable: true, suggestedAction: '检查网络后重试。' }
  }
  return { code: 'MODEL_CONNECTION_FAILED', message, retryable: false }
}
