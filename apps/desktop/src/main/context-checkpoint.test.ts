import { describe, expect, it } from 'vitest'
import { buildDurableCheckpoint } from './context-checkpoint'

describe('durable context checkpoint', () => {
  it('preserves the objective, step state and source references', () => {
    const content = buildDurableCheckpoint({
      runId: 'run-1',
      objective: 'Ship the local Agent',
      summary: 'Renderer is complete',
      steps: [{ id: 'step-1', title: 'Run security tests', status: 'in_progress' }],
      historySummary: '用户：continue',
      sourceRefs: ['message:message-1', 'artifact:artifact-1'],
      createdAt: '2026-07-11T00:00:00.000Z',
    })
    expect(content).toContain('Ship the local Agent')
    expect(content).toContain('[in_progress] Run security tests (step:step-1)')
    expect(content).toContain('message:message-1')
    expect(content).toContain('artifact:artifact-1')
    expect(content).toContain('not a new user instruction')
  })
})
