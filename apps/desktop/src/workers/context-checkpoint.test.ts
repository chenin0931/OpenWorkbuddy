import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { compactMessagesWithCheckpoint, estimateContextTokens } from './context-checkpoint'

const assistant = (content: any[], totalTokens = 0): AgentMessage => ({
  role: 'assistant',
  content,
  api: 'openai-responses',
  provider: 'openai',
  model: 'fixture',
  usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'toolUse',
  timestamp: Date.now(),
} as AgentMessage)

describe('Agent Host context checkpointing', () => {
  it('creates a source-bearing checkpoint after 70 percent and retains recent context', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: 'user',
      content: `${index}:${'x'.repeat(500)}`,
      timestamp: Date.parse(`2026-07-11T00:${String(index).padStart(2, '0')}:00.000Z`),
      sourceRef: `message:${index}`,
    })) as AgentMessage[]
    const result = compactMessagesWithCheckpoint(messages, 1_500)
    expect(result.checkpoint).toBeDefined()
    expect(result.checkpoint?.sourceRefs).toContain('message:0')
    expect(result.checkpoint?.signature).toMatch(/^[a-f0-9]{64}$/)
    expect(result.messages.length).toBeLessThan(messages.length)
    expect((result.messages[0] as any).content).toContain('不是新的用户指令')
  })

  it('does not checkpoint below the threshold', () => {
    const messages = [{ role: 'user', content: 'short', timestamp: Date.now() }] as AgentMessage[]
    expect(compactMessagesWithCheckpoint(messages, 100_000)).toEqual({ messages })
  })

  it('includes the fixed system context when applying the 70 percent threshold', () => {
    const messages = [
      { role: 'user', content: 'first source', timestamp: 1, sourceRef: 'message:first' },
      { role: 'user', content: 'recent answer', timestamp: 2, sourceRef: 'message:recent' },
      { role: 'user', content: 'latest request', timestamp: 3, sourceRef: 'message:latest' },
    ] as unknown as AgentMessage[]
    expect(compactMessagesWithCheckpoint(messages, 1_000, 750).checkpoint).toBeDefined()
  })

  it('uses provider-reported usage instead of re-estimating the complete Pi transcript', () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(20_000), timestamp: 1 },
      assistant([{ type: 'text', text: 'done' }], 4_200),
      { role: 'user', content: 'follow up', timestamp: 3 },
    ] as AgentMessage[]
    expect(estimateContextTokens(messages, 1_000)).toBeGreaterThanOrEqual(4_200)
    expect(estimateContextTokens(messages, 1_000)).toBeLessThan(4_300)
  })

  it('never separates a tool request from its successful result', () => {
    const messages = [
      { role: 'user', content: `research ${'x'.repeat(4_000)}`, timestamp: 1, sourceRef: 'message:prompt' },
      assistant([{ type: 'toolCall', id: 'call-search', name: 'web_search', arguments: { query: 'GraphRAG' } }]),
      { role: 'toolResult', toolCallId: 'call-search', toolName: 'web_search', content: [{ type: 'text', text: '13 results found' }], isError: false, timestamp: 3 },
      { role: 'user', content: `continue ${'y'.repeat(4_000)}`, timestamp: 4 },
      assistant([{ type: 'toolCall', id: 'call-fetch', name: 'web_fetch', arguments: { url: 'https://example.com' } }]),
      { role: 'toolResult', toolCallId: 'call-fetch', toolName: 'web_fetch', content: [{ type: 'text', text: 'official page loaded' }], isError: false, timestamp: 6 },
      { role: 'user', content: `cross-check ${'z'.repeat(4_000)}`, timestamp: 7 },
      { role: 'user', content: `outline ${'q'.repeat(4_000)}`, timestamp: 8 },
      { role: 'user', content: 'write the report', timestamp: 9 },
    ] as AgentMessage[]
    const result = compactMessagesWithCheckpoint(messages, 3_000)
    const retained = result.messages as any[]
    for (const message of retained.filter((item) => item.role === 'assistant')) {
      for (const call of message.content.filter((part: any) => part.type === 'toolCall')) {
        expect(retained.some((item) => item.role === 'toolResult' && item.toolCallId === call.id)).toBe(true)
      }
    }
    expect(result.checkpoint?.content).toContain('工具结果：web_search')
    expect(result.checkpoint?.content).toContain('成功')
  })

  it('reuses a checkpoint until enough new complete groups require another one', () => {
    const original = Array.from({ length: 10 }, (_, index) => ({
      role: 'user', content: `${index}:${'x'.repeat(600)}`, timestamp: index + 1, sourceRef: `message:${index}`,
    })) as AgentMessage[]
    const first = compactMessagesWithCheckpoint(original, 1_500)
    expect(first.state).toBeDefined()
    const next = compactMessagesWithCheckpoint([...original, { role: 'user', content: 'small follow-up', timestamp: 99 } as AgentMessage], 1_500, 0, first.state)
    expect(next.checkpoint).toBeUndefined()
    expect((next.messages[0] as any).content).toBe(first.state?.content)
  })
})
