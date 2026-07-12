import { describe, expect, it } from 'vitest'

import { DesktopInvokeContracts } from './api'
import { ApprovalResponseSchema, ModelProfileSchema, ProviderIdSchema, RunDetailSchema, RunEventSchema, SourceRefSchema } from './schemas'
import {
  AgentHostToMainMessageSchema,
  MainToAgentHostMessageSchema,
  MainToToolRunnerMessageSchema,
  parsePiAgentHostCommand,
  parsePiAgentHostEvent,
  parseToolRunnerEvent,
  WORKER_PROTOCOL_VERSION,
} from './worker-ipc'

const now = '2026-07-10T12:00:00.000Z'

describe('renderer contracts', () => {
  it('never accepts secret fields in a renderer-visible model profile', () => {
    const profile = {
      id: 'model-1',
      name: 'Primary',
      provider: 'openai',
      modelId: 'gpt-test',
      capabilities: {
        contextWindow: 100_000,
        maxOutputTokens: 8_000,
        toolCalling: true,
        vision: true,
        reasoning: true,
        promptCaching: true,
      },
      keyConfigured: true,
      isDefault: true,
      isSubagentDefault: false,
      createdAt: now,
      updatedAt: now,
      apiKey: 'must-not-leak',
    }
    expect(ModelProfileSchema.safeParse(profile).success).toBe(false)
  })

  it('requires edited arguments and limits interactive approval scopes', () => {
    expect(ApprovalResponseSchema.safeParse({ requestId: 'a', decision: 'edit' }).success).toBe(false)
    expect(
      ApprovalResponseSchema.safeParse({ requestId: 'a', decision: 'approve', scope: 'persistent_rule' }).success,
    ).toBe(false)
    expect(
      ApprovalResponseSchema.safeParse({ requestId: 'a', decision: 'approve', scope: 'run_tool' }).success,
    ).toBe(true)
  })

  it('rejects unknown fields at an IPC boundary', () => {
    const contract = DesktopInvokeContracts['workspaces:create']
    expect(contract.input.safeParse({ path: '/tmp/project', injected: true }).success).toBe(false)
    expect(contract.input.safeParse({ path: '/tmp/project', name: 'Project' }).success).toBe(true)
  })

  it('accepts Moonshot AI China across provider and renderer model contracts', () => {
    expect(ProviderIdSchema.parse('moonshotai-cn')).toBe('moonshotai-cn')
    expect(DesktopInvokeContracts['models:catalog'].input.parse({ provider: 'moonshotai-cn' })).toEqual({ provider: 'moonshotai-cn' })
    expect(ModelProfileSchema.parse({
      id: 'model-kimi',
      name: 'Kimi Code',
      provider: 'moonshotai-cn',
      modelId: 'kimi-k2.7-code',
      capabilities: {
        contextWindow: 256_000,
        maxOutputTokens: 32_000,
        toolCalling: true,
        vision: false,
        reasoning: true,
        promptCaching: false,
      },
      keyConfigured: true,
      isDefault: false,
      isSubagentDefault: true,
      createdAt: now,
      updatedAt: now,
    }).provider).toBe('moonshotai-cn')
  })

  it('parses a discriminated run event', () => {
    const parsed = RunEventSchema.parse({
      id: 'event-1',
      runId: 'run-1',
      sequence: 1,
      at: now,
      kind: 'message.delta',
      messageId: 'message-1',
      delta: 'hello',
    })
    expect(parsed.kind).toBe('message.delta')
  })

  it('exposes only bounded tool receipts and approval history in run details', () => {
    const detail = RunDetailSchema.parse({
      run: {
        id: 'run-1', workspaceId: 'workspace-1', title: 'Research', objective: 'Find sources', status: 'completed', completionStatus: 'partial',
        model: {
          profileId: 'model-1', provider: 'openai', modelId: 'gpt-test',
          capabilities: { contextWindow: 128_000, maxOutputTokens: 16_384, toolCalling: true, vision: false, reasoning: false, promptCaching: true },
        },
        limits: { maxModelTurns: 60, maxDurationMs: 7_200_000, maxSubagents: 3, maxParallelReadTools: 4 },
        modelTurns: 2, createdAt: now, updatedAt: now,
      },
      steps: [],
      messages: [],
      pendingApprovals: [],
      toolCalls: [{
        id: 'tool-1', runId: 'run-1', toolName: 'web_search', status: 'succeeded', riskLevel: 'external_side_effect',
        argumentsSummary: { query: 'official documentation' }, resultSummary: '找到 1 个搜索结果',
        sources: [{ title: 'Example', url: 'https://example.com/docs', domain: 'example.com', snippet: 'Primary source', status: 'discovered' }],
        createdAt: now, updatedAt: now,
      }],
      approvalHistory: [{
        id: 'approval-1', runId: 'run-1', toolCallId: 'tool-1', toolName: 'web.search', riskLevel: 'external_side_effect',
        title: '搜索网页', reason: '关键词会发送到外部服务', target: 'official documentation', arguments: { query: 'official documentation' },
        sendsData: ['搜索词'], reversible: true, status: 'approved', scope: 'once', createdAt: now, resolvedAt: now,
      }],
      artifacts: [],
    })
    expect(detail.toolCalls[0]?.sources[0]?.domain).toBe('example.com')
    expect(detail.approvalHistory[0]).toMatchObject({ status: 'approved', scope: 'once' })
  })

  it('rejects unsafe renderer-visible source URLs', () => {
    const base = { title: 'Source', status: 'discovered' as const }
    expect(SourceRefSchema.safeParse({ ...base, url: 'https://example.com/news' }).success).toBe(true)
    expect(SourceRefSchema.safeParse({ ...base, url: 'javascript:alert(1)' }).success).toBe(false)
    expect(SourceRefSchema.safeParse({ ...base, url: 'https://user:password@example.com/news' }).success).toBe(false)
    expect(SourceRefSchema.safeParse({ ...base, url: 'http://127.0.0.1/private' }).success).toBe(false)
    expect(SourceRefSchema.safeParse({ ...base, url: 'http://service.internal/private' }).success).toBe(false)
  })
})

describe('worker protocol', () => {
  it('validates an internal credential response without exposing it through DesktopApi', () => {
    const parsed = MainToAgentHostMessageSchema.parse({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: 'credential.provide',
      requestId: 'request-1',
      payload: { profileId: 'profile-1', apiKey: 'secret' },
    })
    expect(parsed.type).toBe('credential.provide')
    expect('getSecret' in DesktopInvokeContracts).toBe(false)
  })

  it('rejects tool execution messages with an unversioned or malformed payload', () => {
    expect(
      MainToToolRunnerMessageSchema.safeParse({
        type: 'tool.execute',
        requestId: 'request-1',
        payload: {},
      }).success,
    ).toBe(false)
  })

  it('validates the concrete Pi Agent Host and Tool Runner compatibility protocol', () => {
    const command = parsePiAgentHostCommand({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: 'start',
      runId: 'run-1',
      prompt: 'Do the task',
      provider: 'anthropic',
      modelId: 'claude-test',
      apiKey: 'internal-only',
      systemPrompt: 'contract',
      tools: [],
      maxTurns: 60,
      timeoutMs: 7_200_000,
      maxParallelReadTools: 4,
    })
    expect(command.type).toBe('start')
    if (command.type === 'start') expect(command.maxParallelReadTools).toBe(4)

    const event = parseToolRunnerEvent({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: 'result',
      requestId: 'request-1',
      ok: false,
      error: 'failed',
      code: 'COMMAND_FAILED',
      details: { exitCode: 1 },
    })
    expect(event.type).toBe('result')
  })

  it('accepts Moonshot AI China across Pi host commands, events and capabilities', () => {
    const command = parsePiAgentHostCommand({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: 'test-provider',
      requestId: 'request-kimi',
      provider: 'moonshotai-cn',
      modelId: 'kimi-k2.7-code',
      apiKey: 'test-credential-only',
    })
    expect(command.type).toBe('test-provider')
    if (command.type === 'test-provider') expect(command.provider).toBe('moonshotai-cn')

    const event = parsePiAgentHostEvent({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: 'agent.event',
      runId: 'run-kimi',
      event: { type: 'agent.started', provider: 'moonshotai-cn', modelId: 'kimi-k2.7-code' },
    })
    expect(event.type).toBe('agent.event')
    if (event.type === 'agent.event' && event.event.type === 'agent.started') expect(event.event.provider).toBe('moonshotai-cn')

    expect(AgentHostToMainMessageSchema.parse({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: 'ready',
      capabilities: { providers: ['openai', 'anthropic', 'moonshotai-cn'] },
    }).type).toBe('ready')
  })
})
