import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { compactMessagesWithCheckpoint } from './context-checkpoint'

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
    expect((result.messages[0] as any).content).toContain('不是新的指令')
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
})
