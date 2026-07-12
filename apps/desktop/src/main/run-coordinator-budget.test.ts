import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from './database'
import { ArtifactStore } from './artifact-store'
import { RunCoordinator } from './run-coordinator'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  directory: string
  database: AppDatabase
  coordinator: RunCoordinator
  host: { startRun: ReturnType<typeof vi.fn> }
  artifacts: ArtifactStore
  broadcast: ReturnType<typeof vi.fn>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'on-my-workbuddy-budget-'))
  directories.push(directory)
  const database = new AppDatabase(join(directory, 'state.sqlite3'))
  const host = { startRun: vi.fn(), cancelRun: vi.fn(), toolResult: vi.fn(), steer: vi.fn() }
  const runner = { cancel: vi.fn() }
  const broker = { rejectRunApprovals: vi.fn() }
  const artifacts = new ArtifactStore(join(directory, 'artifacts'), database)
  const broadcast = vi.fn()
  const coordinator = new RunCoordinator(
    database,
    { decrypt: vi.fn(async () => 'test-api-key') } as any,
    host as any,
    runner as any,
    broker as any,
    artifacts,
    broadcast,
    vi.fn(),
  )
  return { directory, database, coordinator, host, artifacts, broadcast }
}

describe('task-wide run budgets', () => {
  it('uses an explicit subagent model default and otherwise inherits the parent snapshot', async () => {
    const { database, coordinator } = await fixture()
    const parentProfileId = database.saveModelProfile({ name: 'Parent', provider: 'openai', modelId: 'parent-model' })
    const childProfileId = database.saveModelProfile({ name: 'Child', provider: 'anthropic', modelId: 'child-model' })
    const workspaceId = database.addWorkspace('/tmp/subagent-model-workspace', 'Subagent workspace')
    const parent = database.createRun({
      title: 'Parent', prompt: 'Delegate', workspaceId, modelProfileId: parentProfileId,
      modelSnapshot: { profileId: parentProfileId, provider: 'openai', modelId: 'parent-model' },
      limits: { maxSubagents: 3 },
    })
    database.setSetting('appSettings', { subagentModelProfileId: childProfileId })
    const create = vi.spyOn(coordinator, 'create').mockResolvedValue({ run: { id: 'child-run' } } as any)
    vi.spyOn(coordinator, 'waitForCompletion').mockResolvedValue({ id: 'child-run', status: 'completed', completionStatus: 'verified' })

    await coordinator.delegate({ parentRunId: parent.id, task: 'Inspect', role: 'explore' })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ modelProfileId: childProfileId, fixedModelSnapshot: undefined, readOnly: true }))
    database.close()
  })

  it('ends as failed without inventing a completion verdict when the turn budget is exhausted', async () => {
    const { database, coordinator, host } = await fixture()
    const run = database.createRun({ prompt: 'Keep working', limits: { maxModelTurns: 2, maxDurationMs: 60_000 } })
    database.incrementRunModelTurns(run.id)
    database.incrementRunModelTurns(run.id)

    await coordinator.start(run.id)

    expect(host.startRun).not.toHaveBeenCalled()
    expect(database.getRun(run.id)).toMatchObject({ status: 'failed', outcome: null, modelTurns: 2 })
    expect(database.getRun(run.id)?.error).toContain('RUN_BUDGET_MODEL_TURNS_EXHAUSTED')
    expect(database.getRun(run.id)?.events.some((event: any) => event.type === 'run.budget_exhausted')).toBe(true)
    database.close()
  })

  it('persists a source-backed checkpoint artifact/event and rehydrates it', async () => {
    const { database, coordinator } = await fixture()
    const run = database.createRun({ prompt: 'Preserve this goal' })
    database.replaceSteps(run.id, [{ title: 'Keep this step', status: 'in_progress' }])

    await (coordinator as any).persistContextCheckpoint(run.id, {
      content: 'Earlier facts',
      sourceRefs: ['message:source-1', 'artifact:source-2'],
      signature: 'source-signature',
      estimatedTokens: 7_000,
    })

    const restored = database.getRun(run.id)
    const checkpoint = restored.artifacts.find((artifact: any) => artifact.kind === 'checkpoint')
    expect(checkpoint).toMatchObject({ kind: 'checkpoint', metadata: { sourceSignature: 'source-signature' } })
    expect(restored.events.some((event: any) => event.type === 'context.checkpoint' && event.payload.artifactId === checkpoint.id)).toBe(true)
    const contextItem = await (coordinator as any).loadPreviousCheckpoint(restored)
    expect(contextItem.source).toBe(`artifact:${checkpoint.id}`)
    expect(contextItem.content).toContain('Preserve this goal')
    expect(contextItem.content).toContain('Keep this step')
    expect(contextItem.content).toContain('message:source-1')
    database.close()
  })

  it('audits tool-only model usage without persisting an empty assistant bubble', async () => {
    const { database, coordinator, broadcast } = await fixture()
    const run = database.createRun({ prompt: 'Use a tool' })
    database.updateRun(run.id, { status: 'running' })

    await coordinator.onHostMessage({
      type: 'agent.event',
      runId: run.id,
      event: { type: 'message.assistant', content: '  \n', usage: { input: 10, output: 2 }, stopReason: 'toolUse' },
    })

    expect(database.getRun(run.id)?.messages).toHaveLength(1)
    expect(database.listAudit().some((entry: any) => entry.category === 'model' && entry.action === 'completion')).toBe(true)
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'message.completed' }))

    await coordinator.onHostMessage({
      type: 'agent.event',
      runId: run.id,
      event: { type: 'message.assistant', content: 'Visible result', usage: { input: 4, output: 3 }, stopReason: 'stop' },
    })
    expect(database.getRun(run.id)?.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Visible result' })
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message.completed' }))
    database.close()
  })

  it('clears the previous completion verdict before running a follow-up turn', async () => {
    const { directory, database, coordinator, host } = await fixture()
    const profileId = database.saveModelProfile({ name: 'Default', provider: 'openai', modelId: 'gpt-test', isDefault: true }, Buffer.from('encrypted'))
    const workspaceId = database.addWorkspace(directory, 'Workspace')
    const run = database.createRun({
      prompt: 'Initial task', workspaceId, modelProfileId: profileId,
      modelSnapshot: { profileId, provider: 'openai', modelId: 'gpt-test' },
    })
    database.addMessage(run.id, 'assistant', '   \n')
    database.updateRun(run.id, { status: 'completed', outcome: 'partial', summary: 'stale summary', error: 'stale error', finishedAt: now() })

    await coordinator.start(run.id, 'Continue with a follow-up')

    expect(host.startRun).toHaveBeenCalledOnce()
    expect(host.startRun.mock.calls[0]?.[0]?.history).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: '   \n' })]))
    expect(database.getRun(run.id)).toMatchObject({ status: 'running', outcome: null, summary: '', error: null, finishedAt: null })
    expect(database.getRun(run.id)?.events.at(-2)).toMatchObject({ type: 'run.turn_started', payload: { reason: 'follow_up' } })
    database.stopRunExecution(run.id)
    database.close()
  })

  it('completes a plain conversational turn without inventing a partial verification verdict or retaining an old summary', async () => {
    const { database, coordinator } = await fixture()
    const run = database.createRun({ prompt: 'Chat' })
    database.updateRun(run.id, { status: 'running', summary: 'old turn summary', outcome: null })

    await coordinator.onHostMessage({
      type: 'agent.event', runId: run.id,
      event: { type: 'agent.completed', content: 'Current answer', turns: 1 },
    })

    expect(database.getRun(run.id)).toMatchObject({ status: 'completed', outcome: null, summary: 'Current answer' })
    expect(coordinator.getDetail(run.id).run.completionStatus).toBeUndefined()
    expect(coordinator.getDetail(run.id).verification).toBeUndefined()
    database.close()
  })

  it('turns an exhausted terminal follow-up into a current failed result instead of stranding it under the old completion', async () => {
    const { database, coordinator, host } = await fixture()
    const run = database.createRun({ prompt: 'Initial', limits: { maxModelTurns: 1, maxDurationMs: 60_000 } })
    database.incrementRunModelTurns(run.id)
    database.updateRun(run.id, { status: 'completed', outcome: 'verified', summary: 'old verified result', finishedAt: now() })

    await coordinator.sendMessage(run.id, 'Follow up after budget')

    expect(host.startRun).not.toHaveBeenCalled()
    expect(database.getRun(run.id)).toMatchObject({ status: 'failed', outcome: null, summary: '' })
    expect(database.getRun(run.id)?.messages.at(-1)).toMatchObject({ role: 'user', content: 'Follow up after budget' })
    database.close()
  })
})

function now(): string {
  return new Date().toISOString()
}
