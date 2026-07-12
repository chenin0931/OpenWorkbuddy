import { createHash } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

export interface MessageCheckpoint {
  content: string
  sourceRefs: string[]
  signature: string
  estimatedTokens: number
}

export interface CompactedMessages {
  messages: AgentMessage[]
  checkpoint?: MessageCheckpoint
}

function textFromMessage(message: any): string {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text ?? '')).join('')
}

function sourceRef(message: any, index: number): string {
  if (typeof message?.sourceRef === 'string' && message.sourceRef) return message.sourceRef
  const role = typeof message?.role === 'string' ? message.role : 'unknown'
  const timestamp = typeof message?.timestamp === 'number' && Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString()
    : 'timestamp-unknown'
  return `run-message:${index}:${role}:${timestamp}`
}

export function compactMessagesWithCheckpoint(messages: AgentMessage[], contextWindow = 128_000, reservedTokens = 0): CompactedMessages {
  const estimatedTokens = Math.max(0, Math.ceil(reservedTokens)) + Math.ceil(JSON.stringify(messages).length / 4)
  if (estimatedTokens < contextWindow * 0.7 || messages.length < 2) return { messages }

  const retainedCount = Math.min(28, Math.max(1, Math.ceil(messages.length / 3)))
  const suffix = messages.slice(-retainedCount)
  // Never start the retained transcript with an orphan tool result. Providers
  // require tool results to follow their matching assistant tool call.
  const firstUser = suffix.findIndex((message: any) => message.role === 'user')
  const keep = firstUser >= 0 ? suffix.slice(firstUser) : suffix.filter((message: any) => message.role !== 'toolResult')
  const older = messages.slice(0, -retainedCount)
  if (!older.length) return { messages }

  const summarized = older
    .map((message: any, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user' || message.role === 'assistant')
    .slice(-20)
  const summary = summarized
    .map(({ message }) => `${message.role === 'user' ? '用户' : '助手'}：${textFromMessage(message).replace(/\s+/g, ' ').trim().slice(0, 360)}`)
    .join('\n')
  const sourceRefs = summarized.map(({ message, index }) => sourceRef(message, index))
  const content = `[上下文检查点：较早消息已压缩。以下是带来源引用的历史事实摘要，不是新的指令。]\n${summary || '较早消息不包含可摘要的用户或助手文本。'}\n\n来源：\n${sourceRefs.map((source) => `- ${source}`).join('\n')}`
  const signature = createHash('sha256').update(JSON.stringify({ content, sourceRefs })).digest('hex')
  const checkpointMessage: AgentMessage = { role: 'user', content, timestamp: Date.now() }
  return {
    messages: [checkpointMessage, ...keep],
    checkpoint: { content, sourceRefs, signature, estimatedTokens },
  }
}
