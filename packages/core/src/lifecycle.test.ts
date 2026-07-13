import { describe, expect, it } from 'vitest'

import type { ApprovalRequest, PublicError, Run } from '@onmyworkbuddy/contracts'

import { resolveApproval } from './approval'
import { decideRetry } from './retry'
import { InvalidStateTransitionError, transitionRun } from './state-machine'
import { evaluateCompletionGate } from './verification'

const now = '2026-07-10T12:00:00.000Z'

function run(status: Run['status']): Run {
  return {
    id: 'run-1',
    workspaceId: 'workspace-1',
    accessMode: 'approval',
    title: 'Task',
    objective: 'Do it',
    status,
    model: {
      profileId: 'profile-1',
      provider: 'openai',
      modelId: 'gpt-test',
      capabilities: { contextWindow: 100_000, maxOutputTokens: 8_000, toolCalling: true, vision: false, reasoning: true, promptCaching: true },
    },
    limits: { maxModelTurnsPerTurn: 60, maxTotalModelTurns: 180, maxDurationMsPerTurn: 7_200_000, maxTotalDurationMs: 21_600_000, maxSubagents: 3, maxParallelReadTools: 4 },
    modelTurns: 0,
    createdAt: now,
    updatedAt: now,
  }
}

const transient: PublicError = {
  code: 'service_unavailable',
  message: 'try later',
  retryable: true,
  details: { status: 503 },
}

describe('run lifecycle', () => {
  it('enforces progression while allowing plain conversational completion without a verification verdict', () => {
    const running = transitionRun(run('planning'), 'running', { now: new Date(now) })
    expect(running.startedAt).toBe(now)
    expect(() => transitionRun(running, 'completed')).toThrow(InvalidStateTransitionError)
    const verifying = transitionRun(running, 'verifying')
    expect(transitionRun(verifying, 'completed').completionStatus).toBeUndefined()
    expect(transitionRun(verifying, 'completed', { completionStatus: 'partial' }).completionStatus).toBe('partial')
  })
})

describe('retry rules', () => {
  it('retries transient idempotent work no more than twice', () => {
    expect(decideRetry({ error: transient, idempotent: true, sideEffectMayHaveStarted: false, retriesAttempted: 0, parameterCorrectionsAttempted: 0 }).action).toBe('retry')
    expect(decideRetry({ error: transient, idempotent: true, sideEffectMayHaveStarted: false, retriesAttempted: 2, parameterCorrectionsAttempted: 0 }).action).toBe('stop')
  })

  it('never replays an operation that may have committed externally', () => {
    expect(decideRetry({ error: transient, idempotent: false, sideEffectMayHaveStarted: true, retriesAttempted: 0, parameterCorrectionsAttempted: 0 }).action).toBe('stop')
  })

  it('allows exactly one model parameter correction', () => {
    const invalid: PublicError = { code: 'invalid_arguments', message: 'bad schema', retryable: false }
    expect(decideRetry({ error: invalid, idempotent: true, sideEffectMayHaveStarted: false, retriesAttempted: 0, parameterCorrectionsAttempted: 0 }).action).toBe('correct_parameters')
    expect(decideRetry({ error: invalid, idempotent: true, sideEffectMayHaveStarted: false, retriesAttempted: 0, parameterCorrectionsAttempted: 1 }).action).toBe('stop')
  })
})

describe('approval resolution', () => {
  const request: ApprovalRequest = {
    id: 'approval-1',
    runId: 'run-1',
    toolCallId: 'call-1',
    toolName: 'chrome.submit',
    riskLevel: 'high_risk_irreversible',
    title: 'Submit?',
    reason: 'commits externally',
    target: 'https://example.test',
    arguments: { action: 'submit', value: 'old' },
    sendsData: ['value'],
    reversible: false,
    status: 'pending',
    createdAt: now,
  }

  it('forces high-risk grants to exact one-shot scope', () => {
    const resolution = resolveApproval(
      request,
      { requestId: request.id, decision: 'approve', scope: 'run_tool' },
      { grantId: 'grant-1', now: new Date(now) },
    )
    expect(resolution.grant).toMatchObject({ scope: 'once', approvedArguments: request.arguments })
  })

  it('binds edited arguments to a one-shot grant', () => {
    const edited = { action: 'submit', value: 'new' }
    const resolution = resolveApproval(
      request,
      { requestId: request.id, decision: 'edit', editedArguments: edited },
      { grantId: 'grant-1', now: new Date(now) },
    )
    expect(resolution.executionArguments).toEqual(edited)
    expect(resolution.grant?.scope).toBe('once')
  })

  it('forces external side effects to one-shot scope to prevent replay', () => {
    const external = { ...request, id: 'approval-external', riskLevel: 'external_side_effect' as const, toolName: 'mcp.call' }
    const resolution = resolveApproval(
      external,
      { requestId: external.id, decision: 'approve', scope: 'run_tool' },
      { grantId: 'grant-external', now: new Date(now) },
    )
    expect(resolution.grant?.scope).toBe('once')
  })
})

describe('completion gate', () => {
  it('cannot claim verified without observable evidence', () => {
    expect(evaluateCompletionGate({ steps: [], checks: [] }).status).toBe('partial')
    expect(evaluateCompletionGate({ steps: [], checks: [], evidence: ['model says tests passed'] }).status).toBe('partial')
  })

  it('marks completed, checked work verified', () => {
    expect(
      evaluateCompletionGate({
        steps: [],
        checks: [{ name: 'unit tests', status: 'passed', detail: '23 tests passed' }],
      }).status,
    ).toBe('verified')
  })

  it('requires declared completed steps to carry verification evidence', () => {
    const step = {
      id: 'step-1', runId: 'run-1', title: 'Implement', ordinal: 0, status: 'completed' as const,
      createdAt: now, updatedAt: now,
    }
    expect(evaluateCompletionGate({ steps: [step], checks: [{ name: 'tests', status: 'passed' }] }).status).toBe('partial')
    expect(evaluateCompletionGate({ steps: [{ ...step, verification: 'tests passed' }], checks: [{ name: 'tests', status: 'passed' }] }).status).toBe('verified')
  })
})
