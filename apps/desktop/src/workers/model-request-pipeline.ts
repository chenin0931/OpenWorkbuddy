import type { AgentMessage } from '@earendil-works/pi-agent-core'

export interface DurableToolReceipt {
  providerCallId: string
  toolId: string
  state: string
  risk: string
  result?: unknown
  error?: string
}

export interface ModelRequestIntegrityReport {
  removed: number
  repaired: number
  blocked: number
  providerAdjustments: number
  diagnostics: string[]
}

export interface PreparedModelMessages {
  messages: AgentMessage[]
  report: ModelRequestIntegrityReport
}

const LIVE_RECEIPT_STATES = new Set(['requested', 'waiting_approval', 'running'])

function toolCalls(message: any): any[] {
  return message?.role === 'assistant' && Array.isArray(message.content)
    ? message.content.filter((part: any) => part?.type === 'toolCall')
    : []
}

function resultText(receipt: DurableToolReceipt): string {
  if (receipt.result !== undefined) {
    try { return JSON.stringify(receipt.result, null, 2) } catch { return String(receipt.result) }
  }
  return receipt.error || '本地持久化回执没有结果正文。不得假定该操作成功，也不得自动重放非幂等动作。'
}

function repairedResult(call: any, receipt: DurableToolReceipt | undefined): AgentMessage {
  const missing = !receipt || receipt.result === undefined
  return {
    role: 'toolResult',
    toolCallId: String(call.id),
    toolName: String(call.name),
    content: [{
      type: 'text',
      text: receipt
        ? `[SYSTEM RECOVERED TOOL RECEIPT]\n${resultText(receipt)}\n[END RECOVERED TOOL RECEIPT]`
        : '[SYSTEM TOOL RECEIPT ERROR] 工具结果在恢复后不可用。不得假定成功；外部副作用与高风险动作禁止自动重放。',
    }],
    details: receipt ? { recovered: true, state: receipt.state } : { recovered: false },
    isError: missing || receipt?.state === 'failed' || receipt?.state === 'cancelled',
    timestamp: Date.now(),
  } as AgentMessage
}

/**
 * Produces a provider-safe transcript without mutating Pi state. Tool calls and
 * their results are emitted as one atomic group. Missing results are restored
 * only from the durable receipt with the exact provider call id.
 */
export function prepareModelRequestMessages(
  source: AgentMessage[],
  availableToolNames: ReadonlySet<string>,
  receipts: readonly DurableToolReceipt[] = [],
): PreparedModelMessages {
  const report: ModelRequestIntegrityReport = { removed: 0, repaired: 0, blocked: 0, providerAdjustments: 0, diagnostics: [] }
  const receiptByCallId = new Map(receipts.map((receipt) => [receipt.providerCallId, receipt]))
  const resultByCallId = new Map<string, any>()
  for (const message of source as any[]) {
    if (message?.role !== 'toolResult' || typeof message.toolCallId !== 'string') continue
    if (resultByCallId.has(message.toolCallId)) {
      report.removed += 1
      report.diagnostics.push(`duplicate_tool_result:${message.toolCallId}`)
      continue
    }
    resultByCallId.set(message.toolCallId, message)
  }

  const messages: AgentMessage[] = []
  const consumedResults = new Set<string>()
  for (const original of source as any[]) {
    if (original?.role === 'toolResult') continue
    if (original?.role !== 'assistant') {
      messages.push(original as AgentMessage)
      continue
    }

    const content = Array.isArray(original.content) ? original.content : []
    const validContent = content.filter((part: any) => {
      if (part?.type !== 'toolCall') return Boolean(part && typeof part.type === 'string')
      const valid = typeof part.id === 'string'
        && part.id.length > 0
        && typeof part.name === 'string'
        && availableToolNames.has(part.name)
        && part.arguments !== null
        && !Array.isArray(part.arguments)
        && typeof part.arguments === 'object'
      if (!valid) {
        report.removed += 1
        report.diagnostics.push(`invalid_tool_call:${String(part?.id ?? 'missing')}:${String(part?.name ?? 'missing')}`)
      }
      return valid
    })
    if (validContent.length === 0) {
      report.removed += 1
      report.diagnostics.push('empty_assistant_envelope')
      continue
    }
    const assistant = { ...original, content: validContent } as AgentMessage
    messages.push(assistant)

    for (const call of toolCalls(assistant)) {
      const existing = resultByCallId.get(call.id)
      if (existing) {
        consumedResults.add(call.id)
        const normalized = existing.toolName === call.name ? existing : { ...existing, toolName: call.name }
        if (normalized !== existing) report.providerAdjustments += 1
        messages.push(normalized as AgentMessage)
        continue
      }
      const receipt = receiptByCallId.get(call.id)
      if (receipt && LIVE_RECEIPT_STATES.has(receipt.state)) {
        report.blocked += 1
        report.diagnostics.push(`tool_result_pending:${call.id}:${receipt.state}`)
        continue
      }
      messages.push(repairedResult(call, receipt))
      report.repaired += 1
      report.diagnostics.push(receipt ? `tool_result_rehydrated:${call.id}` : `tool_result_missing:${call.id}`)
    }
  }

  for (const callId of resultByCallId.keys()) {
    if (consumedResults.has(callId)) continue
    report.removed += 1
    report.diagnostics.push(`orphan_tool_result:${callId}`)
  }
  return { messages, report }
}

export function assertModelRequestReady(result: PreparedModelMessages): void {
  if (result.report.blocked === 0) return
  throw Object.assign(new Error('模型请求已暂停：仍有工具调用等待执行结果。'), {
    code: 'MODEL_REQUEST_WAITING_FOR_TOOL_RESULTS',
    diagnostics: result.report.diagnostics,
  })
}
