import type { PublicError } from '@onmyworkbuddy/contracts'

export type RetryDecision =
  | { action: 'retry'; delayMs: number; reason: string }
  | { action: 'correct_parameters'; reason: string }
  | { action: 'stop'; reason: string }

export interface RetryEvaluationInput {
  error: PublicError
  idempotent: boolean
  /** True once a request may have reached an external system. */
  sideEffectMayHaveStarted: boolean
  retriesAttempted: number
  parameterCorrectionsAttempted: number
  maxTransientRetries?: number
}

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'rate_limit_exceeded',
  'overloaded',
  'service_unavailable',
  'timeout',
])
const PARAMETER_CODES = new Set(['invalid_arguments', 'invalid_request', 'schema_validation_failed', 'bad_request'])

function detailsRecord(error: PublicError): Record<string, unknown> | undefined {
  return typeof error.details === 'object' && error.details !== null && !Array.isArray(error.details)
    ? error.details
    : undefined
}

export function getErrorStatus(error: PublicError): number | undefined {
  const status = detailsRecord(error)?.status
  return typeof status === 'number' ? status : undefined
}

export function isTransientError(error: PublicError): boolean {
  if (error.retryable) return true
  const status = getErrorStatus(error)
  return (status !== undefined && (status === 408 || status === 429 || status >= 500)) || TRANSIENT_CODES.has(error.code)
}

export function isParameterError(error: PublicError): boolean {
  const status = getErrorStatus(error)
  return status === 400 || status === 422 || PARAMETER_CODES.has(error.code)
}

export function computeBackoffMs(retriesAttempted: number, random = Math.random): number {
  const base = Math.min(8_000, 500 * 2 ** Math.max(0, retriesAttempted))
  return Math.round(base * (0.8 + random() * 0.4))
}

export function decideRetry(input: RetryEvaluationInput): RetryDecision {
  if (isParameterError(input.error)) {
    return input.parameterCorrectionsAttempted < 1
      ? { action: 'correct_parameters', reason: 'Tool/provider parameters may be corrected once by the model.' }
      : { action: 'stop', reason: 'The single parameter-correction attempt has already been used.' }
  }

  if (!isTransientError(input.error)) return { action: 'stop', reason: 'Failure is not classified as transient.' }
  if (!input.idempotent || input.sideEffectMayHaveStarted) {
    return { action: 'stop', reason: 'A non-idempotent or possibly committed operation must never be replayed automatically.' }
  }

  const maxRetries = input.maxTransientRetries ?? 2
  if (input.retriesAttempted >= maxRetries) {
    return { action: 'stop', reason: `Transient retry budget of ${maxRetries} has been exhausted.` }
  }
  return {
    action: 'retry',
    delayMs: computeBackoffMs(input.retriesAttempted),
    reason: 'Transient failure on an idempotent operation.',
  }
}

export async function retryTransient<T>(
  operation: () => Promise<T>,
  options: {
    toPublicError(error: unknown): PublicError
    idempotent: boolean
    maxRetries?: number
    signal?: AbortSignal
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  },
): Promise<T> {
  let retriesAttempted = 0
  const sleep = options.sleep ?? abortableSleep
  while (true) {
    try {
      return await operation()
    } catch (error) {
      const publicError = options.toPublicError(error)
      const decision = decideRetry({
        error: publicError,
        idempotent: options.idempotent,
        sideEffectMayHaveStarted: !options.idempotent,
        retriesAttempted,
        parameterCorrectionsAttempted: 1,
        ...(options.maxRetries === undefined ? {} : { maxTransientRetries: options.maxRetries }),
      })
      if (decision.action !== 'retry') throw error
      await sleep(decision.delayMs, options.signal)
      retriesAttempted += 1
    }
  }
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds)
    if (!signal) return
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
