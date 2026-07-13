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
  host: { startRun: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn> }
  runner: { cancel: ReturnType<typeof vi.fn>; cancelRun: ReturnType<typeof vi.fn> }
  artifacts: ArtifactStore
  broadcast: ReturnType<typeof vi.fn>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'on-my-workbuddy-budget-'))
  directories.push(directory)
  const database = new AppDatabase(join(directory, 'state.sqlite3'))
  const host = { startRun: vi.fn(), cancelRun: vi.fn(), toolResult: vi.fn(), steer: vi.fn() }
  const runner = { cancel: vi.fn(), cancelRun: vi.fn() }
  const broker = { rejectRunApprovals: vi.fn(), finalizeTurn: vi.fn(() => ({ verificationRequired: false, outcome: null })) }
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
  return { directory, database, coordinator, host, runner, artifacts, broadcast }
}

describe('turn-aware run budgets', () => {
  it('broadcasts live progress while persisting an unchanged progress state at most once per 2.5 seconds', async () => {
    const { database, coordinator, broadcast } = await fixture()
    const run = database.createRun({ prompt: 'Long analysis' })
    database.updateRun(run.id, { status: 'running' })

    for (const generatedChars of [100, 200, 300]) {
      await coordinator.onHostMessage({
        type: 'agent.event',
        runId: run.id,
        event: { type: 'agent.progress', phase: 'composing_tool', message: '正在准备写入文件…', toolName: 'file_write', generatedChars },
      })
    }

    expect(broadcast.mock.calls.filter(([event]) => event.kind === 'progress.updated')).toHaveLength(3)
    expect(database.getRun(run.id)?.events.filter((event: any) => event.type === 'progress.updated')).toHaveLength(1)
    database.close()
  })

  it('uses an explicit subagent model default and otherwise inherits the parent snapshot', async () => {
    const { database, coordinator } = await fixture()
    const parentProfileId = database.saveModelProfile({ name: 'Parent', provider: 'openai', modelId: 'parent-model' })
    const childProfileId = database.saveModelProfile({ name: 'Child', provider: 'anthropic', modelId: 'child-model' })
    const workspaceId = database.addWorkspace('/tmp/subagent-model-workspace', 'Subagent workspace')
    const parent = database.createRun({
      title: 'Parent', prompt: 'Delegate', workspaceId, modelProfileId: parentProfileId,
      modelSnapshot: { profileId: parentProfileId, provider: 'openai', modelId: 'parent-model' },
      limits: { maxSubagents: 3 },
      accessMode: 'full_disk',
    })
    database.setSetting('appSettings', { subagentModelProfileId: childProfileId })
    const create = vi.spyOn(coordinator, 'create').mockResolvedValue({ run: { id: 'child-run' } } as any)
    vi.spyOn(coordinator, 'waitForCompletion').mockResolvedValue({ id: 'child-run', status: 'completed', completionStatus: 'verified' })

    await coordinator.delegate({ parentRunId: parent.id, task: 'Inspect', role: 'explore' })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ modelProfileId: childProfileId, fixedModelSnapshot: undefined, readOnly: true, accessMode: 'full_disk' }))
    database.close()
  })

  it('waits for a new user turn without inventing a completion verdict when the turn budget is exhausted', async () => {
    const { database, coordinator, host } = await fixture()
    const run = database.createRun({ prompt: 'Keep working', limits: { maxModelTurnsPerTurn: 2, maxTotalModelTurns: 6, maxDurationMsPerTurn: 60_000, maxTotalDurationMs: 180_000 } })
    database.markRunTurnStarted(run.id, 'initial')
    database.incrementRunModelTurns(run.id)
    database.incrementRunModelTurns(run.id)

    await coordinator.start(run.id)

    expect(host.startRun).not.toHaveBeenCalled()
    expect(database.getRun(run.id)).toMatchObject({ status: 'waiting_user', outcome: null, modelTurns: 2, error: null })
    expect(database.getRun(run.id)?.events.some((event: any) => event.type === 'run.budget_exhausted' && event.payload.scope === 'turn')).toBe(true)
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
      accessMode: 'full_disk',
    })
    database.addMessage(run.id, 'assistant', '   \n')
    database.updateRun(run.id, { status: 'completed', outcome: 'partial', summary: 'stale summary', error: 'stale error', finishedAt: now() })

    await coordinator.start(run.id, 'Continue with a follow-up')

    expect(host.startRun).toHaveBeenCalledOnce()
    expect(host.startRun.mock.calls[0]?.[0]?.history).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: '   \n' })]))
    expect(host.startRun.mock.calls[0]?.[0]?.systemPrompt).toContain('accessMode: full_disk')
    expect(host.startRun.mock.calls[0]?.[0]?.systemPrompt).toContain('authorizedRoot: /')
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

  it('gives an exhausted terminal task a fresh per-turn budget on follow-up', async () => {
    const { directory, database, coordinator, host } = await fixture()
    const profileId = database.saveModelProfile({ name: 'Default', provider: 'openai', modelId: 'gpt-test', isDefault: true }, Buffer.from('encrypted'))
    const workspaceId = database.addWorkspace(directory, 'Workspace')
    const run = database.createRun({
      prompt: 'Initial', workspaceId, modelProfileId: profileId,
      modelSnapshot: { profileId, provider: 'openai', modelId: 'gpt-test' },
      limits: { maxModelTurnsPerTurn: 1, maxTotalModelTurns: 3, maxDurationMsPerTurn: 60_000, maxTotalDurationMs: 180_000 },
    })
    database.markRunTurnStarted(run.id, 'initial')
    database.incrementRunModelTurns(run.id)
    database.finishRunTurn(run.id, 'completed')
    database.updateRun(run.id, { status: 'completed', outcome: 'verified', summary: 'old verified result', finishedAt: now() })

    await coordinator.sendMessage(run.id, 'Follow up after budget')

    expect(host.startRun).toHaveBeenCalledOnce()
    expect(host.startRun.mock.calls[0]?.[0]).toMatchObject({ maxTurns: 1 })
    expect(database.getRun(run.id)).toMatchObject({ status: 'running', outcome: null, summary: '' })
    expect(database.getRun(run.id)?.messages.at(-1)).toMatchObject({ role: 'user', content: 'Follow up after budget' })
    database.close()
  })

  it('keeps the full 60-turn follow-up allowance after a 46-turn first request', async () => {
    const { directory, database, coordinator, host } = await fixture()
    const profileId = database.saveModelProfile({ name: 'Default', provider: 'openai', modelId: 'gpt-test', isDefault: true }, Buffer.from('encrypted'))
    const workspaceId = database.addWorkspace(directory, 'G318')
    const run = database.createRun({
      prompt: 'Create the guide', workspaceId, modelProfileId: profileId,
      modelSnapshot: { profileId, provider: 'openai', modelId: 'gpt-test' },
      limits: { maxModelTurnsPerTurn: 60, maxTotalModelTurns: 180, maxDurationMsPerTurn: 7_200_000, maxTotalDurationMs: 21_600_000 },
    })
    database.markRunTurnStarted(run.id, 'initial')
    database.incrementRunModelTurns(run.id, 46)
    database.finishRunTurn(run.id, 'completed')
    database.updateRun(run.id, { status: 'completed', outcome: 'partial', finishedAt: now() })

    await coordinator.sendMessage(run.id, 'Convert the Markdown to PDF')

    expect(host.startRun.mock.calls[0]?.[0]).toMatchObject({ maxTurns: 60 })
    expect(database.getRunBudgetUsage(run.id).modelTurns).toBe(46)
    expect(database.getRunTurnBudgetUsage(run.id).modelTurns).toBe(0)
    database.stopRunExecution(run.id)
    database.close()
  })

  it('persists a composer access-mode change before steering an active run', async () => {
    const { database, coordinator, host } = await fixture()
    const run = database.createRun({ prompt: 'Initial', accessMode: 'approval' })
    database.updateRun(run.id, { status: 'running' })

    await coordinator.sendMessage(run.id, 'Continue with full access', 'full_disk')

    expect(database.getRun(run.id)).toMatchObject({ accessMode: 'full_disk' })
    expect(database.getRun(run.id)?.messages.at(-1)).toMatchObject({ role: 'user', content: 'Continue with full access' })
    expect(host.steer).toHaveBeenCalledWith(run.id, expect.stringContaining('授权根为 /'), [])
    expect(host.steer.mock.calls[0]?.[1]).toContain('Continue with full access')
    expect(database.listAudit().some((event: any) => event.action === 'run_access_mode_changed')).toBe(true)
    database.close()
  })

  it('recursively revokes full-disk access from descendants when the parent is downgraded', async () => {
    const { database, coordinator, host, runner } = await fixture()
    const parent = database.createRun({ prompt: 'Parent', accessMode: 'full_disk' })
    const child = database.createRun({ prompt: 'Child', parentRunId: parent.id, accessMode: 'full_disk' })
    const grandchild = database.createRun({ prompt: 'Grandchild', parentRunId: child.id, accessMode: 'full_disk' })
    database.updateRun(parent.id, { status: 'running' })
    database.updateRun(child.id, { status: 'running' })
    database.updateRun(grandchild.id, { status: 'paused' })

    await coordinator.sendMessage(parent.id, 'Return to approval mode', 'approval')

    expect(database.getRun(parent.id)).toMatchObject({ accessMode: 'approval' })
    expect(database.getRun(child.id)).toMatchObject({ accessMode: 'approval' })
    expect(database.getRun(grandchild.id)).toMatchObject({ accessMode: 'approval' })
    expect(runner.cancelRun).toHaveBeenCalledWith(child.id)
    expect(runner.cancelRun).not.toHaveBeenCalledWith(grandchild.id)
    expect(host.steer).toHaveBeenCalledWith(child.id, expect.stringContaining('收回完全访问权限'), [])
    expect(database.getRun(child.id)?.events.some((event: any) => event.type === 'run.access_mode_changed')).toBe(true)
    database.close()
  })

  it('does not let a child run elevate beyond its parent access mode', async () => {
    const { database, coordinator, host } = await fixture()
    const parent = database.createRun({ prompt: 'Parent', accessMode: 'approval' })
    const child = database.createRun({ prompt: 'Child', parentRunId: parent.id, accessMode: 'approval' })
    database.updateRun(child.id, { status: 'running' })

    await expect(coordinator.sendMessage(child.id, 'Try full disk', 'full_disk')).rejects.toMatchObject({ code: 'PARENT_ACCESS_MODE_REQUIRED' })

    expect(database.getRun(child.id)).toMatchObject({ accessMode: 'approval' })
    expect(database.getRun(child.id)?.messages.at(-1)).toMatchObject({ role: 'user', content: 'Child' })
    expect(host.steer).not.toHaveBeenCalled()
    database.close()
  })
})

function now(): string {
  return new Date().toISOString()
}
