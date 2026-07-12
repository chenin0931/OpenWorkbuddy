export const BRIDGE_COMMANDS = [
  'tabs.list',
  'bind',
  'snapshot',
  'dom',
  'ax',
  'screenshot',
  'navigate',
  'click',
  'type',
  'openTab',
  'detach',
] as const

export type BridgeCommand = (typeof BRIDGE_COMMANDS)[number]

export interface BridgeRequest {
  requestId: string
  command: BridgeCommand
  params: Record<string, unknown>
}

export interface BridgeErrorBody {
  code: string
  message: string
  retryable: boolean
  details?: unknown
}

export interface BridgeResponse {
  type: 'response'
  requestId: string
  ok: boolean
  data?: unknown
  error?: BridgeErrorBody
}

export interface BridgeEvent {
  type: 'event'
  event: string
  data: unknown
}

const commandSet = new Set<string>(BRIDGE_COMMANDS)

export function parseBridgeRequest(value: unknown): BridgeRequest {
  if (!isRecord(value)) {
    throw new ProtocolError('INVALID_REQUEST', 'Bridge request must be an object.')
  }

  const requestId = value.requestId
  const command = value.command
  const params = value.params ?? {}

  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 200) {
    throw new ProtocolError('INVALID_REQUEST', 'requestId must be a non-empty string of at most 200 characters.')
  }
  if (typeof command !== 'string' || !commandSet.has(command)) {
    throw new ProtocolError('UNKNOWN_COMMAND', `Unsupported Chrome bridge command: ${String(command)}`)
  }
  if (!isRecord(params)) {
    throw new ProtocolError('INVALID_PARAMS', 'params must be an object.')
  }

  return {
    requestId,
    command: command as BridgeCommand,
    params,
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class ProtocolError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: unknown

  constructor(code: string, message: string, retryable = false, details?: unknown) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

export function errorResponse(requestId: string, error: unknown): BridgeResponse {
  const normalized = normalizeError(error)
  return {
    type: 'response',
    requestId,
    ok: false,
    error: normalized,
  }
}

export function successResponse(requestId: string, data: unknown): BridgeResponse {
  return {
    type: 'response',
    requestId,
    ok: true,
    data,
  }
}

export function normalizeError(error: unknown): BridgeErrorBody {
  if (error instanceof ProtocolError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }
  if (error instanceof Error) {
    return {
      code: 'CHROME_BRIDGE_ERROR',
      message: error.message,
      retryable: false,
    }
  }
  return {
    code: 'CHROME_BRIDGE_ERROR',
    message: String(error),
    retryable: false,
  }
}
