import { describe, expect, it } from 'vitest'
import { RunDetailSchema, type ModelProfile } from '@onmyworkbuddy/contracts'
import { presentRunDetail } from './presenters'

const now = '2026-07-11T12:00:00.000Z'

const model: ModelProfile = {
  id: 'model-1',
  name: 'Test model',
  provider: 'openai',
  modelId: 'gpt-test',
  capabilities: {
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    toolCalling: true,
    vision: false,
    reasoning: false,
    promptCaching: true,
  },
  keyConfigured: true,
  isDefault: true,
  isSubagentDefault: false,
  createdAt: now,
  updatedAt: now,
}

describe('run detail public projection', () => {
  it('drops empty assistant envelopes and exposes bounded, redacted tool evidence', () => {
    const detail = presentRunDetail({
      id: 'run-1',
      workspaceId: 'workspace-1',
      accessMode: 'full_disk',
      title: 'Research',
      prompt: 'Find current news',
      goal: 'Find current news',
      status: 'completed',
      outcome: 'partial',
      modelSnapshot: { profileId: model.id, provider: model.provider, modelId: model.modelId, capabilities: model.capabilities },
      limits: {},
      modelTurns: 3,
      createdAt: now,
      updatedAt: now,
      messages: [
        { id: 'message-user', role: 'user', content: 'Find current news', createdAt: now },
        { id: 'message-empty', role: 'assistant', content: '   \n', createdAt: now },
        { id: 'message-answer', role: 'assistant', content: 'Result', createdAt: now },
      ],
      steps: [],
      events: [],
      artifacts: [],
      approvals: [],
      approvalHistory: [{
        id: 'approval-1', run_id: 'run-1', tool_call_id: 'tool-search', status: 'approved', scope: 'once',
        reason: 'Search terms leave this Mac', created_at: now, resolved_at: now,
        decision: { requestId: 'approval-1', decision: 'approve', scope: 'once', editedArguments: { password: 'must-not-leak' } },
        preview: {
          toolCallId: 'provider-tool-search', toolName: 'web.search', title: 'Search the web', riskLevel: 'external_side_effect', target: 'current news',
          arguments: { query: 'current news', apiKey: 'must-not-leak' }, sendsData: ['search query'], reversible: true,
        },
      }],
      toolCalls: [
        {
          id: 'tool-search', run_id: 'run-1', tool_id: 'web_search', state: 'succeeded', risk: 'external_side_effect',
          arguments: { query: 'current news', apiKey: 'must-not-leak' },
          result: {
            engine: 'bing-html', query: 'current news', resultCount: 1,
            results: [{ rank: 1, title: 'Example report', url: 'https://example.com/report?token=must-not-leak&lang=zh', snippet: 'A concise source summary' }],
          },
          createdAt: now, updatedAt: now,
        },
        {
          id: 'tool-fetch', run_id: 'run-1', tool_id: 'web_fetch', state: 'succeeded', risk: 'external_side_effect',
          arguments: { url: 'https://example.com/report?api_key=must-not-leak&lang=zh' },
          result: { url: 'https://example.com/report?api_key=must-not-leak&lang=zh', status: 200, contentType: 'text/html', text: 'FULL PAGE BODY MUST NOT LEAK', total: 4_096 },
          createdAt: now, updatedAt: now,
        },
        {
          id: 'tool-unsafe', run_id: 'run-1', tool_id: 'web_search', state: 'succeeded', risk: 'external_side_effect',
          arguments: { query: 'unsafe source' },
          result: { results: [
            { title: 'Credentials', url: 'https://user:password@example.com/private' },
            { title: 'Loopback', url: 'http://127.0.0.1/private' },
            { title: 'Script', url: 'javascript:alert(1)' },
          ] },
          createdAt: now, updatedAt: now,
        },
      ],
    }, model)

    expect(detail.messages.map((message) => message.id)).toEqual(['message-user', 'message-answer'])
    expect(detail.run.accessMode).toBe('full_disk')
    expect(detail.run.completionStatus).toBeUndefined()
    expect(detail.verification).toBeUndefined()
    expect(detail.toolCalls).toHaveLength(3)
    expect(detail.toolCalls[0]).toMatchObject({
      toolName: 'web_search',
      resultSummary: '找到 1 个搜索结果',
      sources: [{ title: 'Example report', domain: 'example.com', snippet: 'A concise source summary', status: 'discovered' }],
    })
    expect(detail.toolCalls[1]).toMatchObject({
      toolName: 'web_fetch',
      resultSummary: 'HTTP 200 · text/html · 4096 bytes',
      sources: [{ domain: 'example.com', status: 'fetched', fetchedAt: now }],
    })
    expect(detail.toolCalls[2]?.sources).toEqual([])
    expect(detail.approvalHistory[0]).toMatchObject({ toolCallId: 'provider-tool-search', status: 'approved', scope: 'once', resolvedAt: now })
    const publicJson = JSON.stringify(detail)
    expect(publicJson).not.toContain('must-not-leak')
    expect(publicJson).not.toContain('FULL PAGE BODY')
    expect(RunDetailSchema.parse(detail)).toEqual(detail)
  })

  it('does not surface a prior-turn verification after a new turn invalidates the outcome', () => {
    const later = '2026-07-11T12:05:00.000Z'
    const detail = presentRunDetail({
      id: 'run-turns', workspaceId: 'workspace-1', title: 'Conversation', prompt: 'Initial', status: 'running', outcome: null,
      modelSnapshot: { profileId: model.id, provider: model.provider, modelId: model.modelId, capabilities: model.capabilities },
      limits: {}, modelTurns: 1, createdAt: now, updatedAt: later, messages: [], toolCalls: [], artifacts: [], approvals: [], approvalHistory: [],
      steps: [{ id: 'old-step', title: 'old plan', ordinal: 0, status: 'completed', updatedAt: now, createdAt: now }],
      events: [
        { id: 1, type: 'verification.completed', payload: { verification: { status: 'verified', checks: [{ name: 'old', status: 'passed' }], summary: 'old verdict' } }, createdAt: now },
        { id: 2, type: 'run.turn_started', payload: { reason: 'follow_up' }, createdAt: later },
      ],
    }, model)
    expect(detail.run.completionStatus).toBeUndefined()
    expect(detail.verification).toBeUndefined()
    expect(detail.steps).toEqual([])
  })

  it('surfaces a completion verdict only when the current turn has a matching verification receipt', () => {
    const detail = presentRunDetail({
      id: 'run-verified', workspaceId: 'workspace-1', title: 'Verified task', prompt: 'Verify', status: 'completed', outcome: 'verified',
      modelSnapshot: { profileId: model.id, provider: model.provider, modelId: model.modelId, capabilities: model.capabilities },
      limits: {}, modelTurns: 1, createdAt: now, updatedAt: now, messages: [], steps: [], artifacts: [], approvals: [], approvalHistory: [],
      toolCalls: [{ id: 'verification-command', tool_id: 'shell_run', state: 'succeeded', createdAt: now, updatedAt: now, arguments: { command: 'pnpm test' }, result: { code: 0 } }],
      events: [{
        id: 1, type: 'verification.completed', createdAt: now,
        payload: { verification: { status: 'verified', checks: [{ name: 'tests', status: 'passed' }], summary: 'verified result' } },
      }],
    }, model)
    expect(detail.run.completionStatus).toBe('verified')
    expect(detail.verification).toMatchObject({ status: 'verified', summary: 'verified result' })
  })

  it('suppresses legacy task_complete-only partial verdicts for ordinary conversation', () => {
    const detail = presentRunDetail({
      id: 'run-chat', workspaceId: 'workspace-1', title: 'Hello', prompt: 'Hello', status: 'completed', outcome: 'partial',
      modelSnapshot: { profileId: model.id, provider: model.provider, modelId: model.modelId, capabilities: model.capabilities },
      limits: {}, modelTurns: 1, createdAt: now, updatedAt: now, messages: [], steps: [], artifacts: [], approvals: [], approvalHistory: [],
      toolCalls: [{ id: 'complete-only', tool_id: 'task_complete', state: 'succeeded', createdAt: now, updatedAt: now, arguments: {}, result: {} }],
      events: [{
        id: 1, type: 'verification.completed', createdAt: now,
        payload: { verification: { status: 'partial', checks: [{ name: 'correctness', status: 'not_run' }], summary: 'no evidence' } },
      }],
    }, model)
    expect(detail.run.completionStatus).toBeUndefined()
    expect(detail.verification).toBeUndefined()
  })
})
