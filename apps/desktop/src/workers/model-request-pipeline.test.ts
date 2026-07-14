import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { assertModelRequestReady, prepareModelRequestMessages } from './model-request-pipeline'

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const assistant = (content: any[]): AgentMessage => ({ role: 'assistant', content, api: 'openai-responses', provider: 'openai', model: 'test', usage, stopReason: 'toolUse', timestamp: 1 } as AgentMessage)

describe('model request integrity pipeline', () => {
  it('keeps tool calls and results adjacent and removes orphan results', () => {
    const source = [
      assistant([{ type: 'toolCall', id: 'call-1', name: 'web_search', arguments: { query: 'GraphRAG' } }]),
      { role: 'user', content: 'continue', timestamp: 2 },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'wrong', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 },
      { role: 'toolResult', toolCallId: 'orphan', toolName: 'web_search', content: [{ type: 'text', text: 'bad' }], isError: false, timestamp: 4 },
    ] as AgentMessage[]
    const prepared = prepareModelRequestMessages(source, new Set(['web_search']))
    expect((prepared.messages[1] as any).role).toBe('toolResult')
    expect((prepared.messages[1] as any).toolName).toBe('web_search')
    expect(prepared.report.removed).toBe(1)
    expect(prepared.report.providerAdjustments).toBe(1)
  })

  it('rehydrates an exact durable receipt without claiming unavailable output succeeded', () => {
    const source = [assistant([{ type: 'toolCall', id: 'call-2', name: 'file_read', arguments: { path: 'a.md' } }])] as AgentMessage[]
    const prepared = prepareModelRequestMessages(source, new Set(['file_read']), [{ providerCallId: 'call-2', toolId: 'file_read', state: 'succeeded', risk: 'readonly', result: { content: 'hello' } }])
    expect((prepared.messages[1] as any).isError).toBe(false)
    expect((prepared.messages[1] as any).content[0].text).toContain('hello')
    expect(prepared.report.repaired).toBe(1)
  })

  it('blocks a provider request while a durable tool receipt is still running', () => {
    const source = [assistant([{ type: 'toolCall', id: 'call-3', name: 'shell_run', arguments: { command: 'sleep 2' } }])] as AgentMessage[]
    const prepared = prepareModelRequestMessages(source, new Set(['shell_run']), [{ providerCallId: 'call-3', toolId: 'shell_run', state: 'running', risk: 'external_side_effect' }])
    expect(() => assertModelRequestReady(prepared)).toThrow(/等待执行结果/)
  })

  it('drops unknown or malformed tool calls and empty assistant envelopes', () => {
    const prepared = prepareModelRequestMessages([
      assistant([{ type: 'toolCall', id: 'bad', name: 'missing_tool', arguments: '{}' }]),
    ], new Set(['file_read']))
    expect(prepared.messages).toHaveLength(0)
    expect(prepared.report.removed).toBe(2)
  })
})
