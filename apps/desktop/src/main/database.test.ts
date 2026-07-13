import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'

const directories: string[] = []

async function temporaryDatabase(): Promise<{ directory: string; path: string; database: AppDatabase }> {
  const directory = await mkdtemp(join(tmpdir(), 'on-my-workbuddy-db-'))
  directories.push(directory)
  const path = join(directory, 'state.sqlite3')
  return { directory, path, database: new AppDatabase(path) }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('AppDatabase persistence boundary', () => {
  it('migrates the legacy provider constraint without losing profiles, encrypted bytes or foreign keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'on-my-workbuddy-db-legacy-provider-'))
    directories.push(directory)
    const path = join(directory, 'state.sqlite3')
    const legacy = new Database(path)
    const timestamp = '2026-07-12T00:00:00.000Z'
    const encryptedBytes = Buffer.from('synthetic-encrypted-bytes')
    legacy.pragma('foreign_keys = ON')
    legacy.exec(`
      CREATE TABLE model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic')),
        model_id TEXT NOT NULL,
        encrypted_key BLOB,
        is_default INTEGER NOT NULL DEFAULT 0,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        mode TEXT NOT NULL DEFAULT 'act',
        workspace_id TEXT,
        model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
        model_snapshot_json TEXT NOT NULL DEFAULT '{}',
        limits_json TEXT NOT NULL DEFAULT '{}',
        model_turns INTEGER NOT NULL DEFAULT 0,
        parent_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        goal TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        timezone TEXT NOT NULL,
        workspace_id TEXT,
        model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    legacy.prepare(`INSERT INTO model_profiles(
      id,name,provider,model_id,encrypted_key,is_default,capabilities_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      'legacy-profile', 'Legacy profile', 'anthropic', 'claude-test', encryptedBytes, 1, '{}', timestamp, timestamp,
    )
    legacy.prepare(`INSERT INTO runs(
      id,title,prompt,status,model_profile_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)`).run('legacy-run', 'Legacy run', 'Continue safely', 'paused', 'legacy-profile', timestamp, timestamp)
    legacy.prepare(`INSERT INTO automations(
      id,name,prompt,schedule_type,schedule_value,timezone,model_profile_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run('legacy-automation', 'Legacy automation', 'Check status', 'interval', '3600000', 'Asia/Shanghai', 'legacy-profile', timestamp, timestamp)
    legacy.close()

    const database = new AppDatabase(path)
    try {
      expect(database.db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(database.db.pragma('foreign_key_check')).toEqual([])
      const tableSql = database.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='model_profiles'").pluck().get()
      expect(String(tableSql)).toContain("'moonshotai-cn'")
      expect(database.getModelProfileSecret('legacy-profile')).toMatchObject({
        id: 'legacy-profile',
        provider: 'anthropic',
        modelId: 'claude-test',
        encryptedKey: encryptedBytes,
      })
      expect(database.db.prepare('SELECT model_profile_id FROM runs WHERE id=?').get('legacy-run')).toEqual({ model_profile_id: 'legacy-profile' })
      expect(database.getRun('legacy-run')).toMatchObject({ accessMode: 'approval' })
      expect(database.db.prepare('SELECT model_profile_id FROM automations WHERE id=?').get('legacy-automation')).toEqual({ model_profile_id: 'legacy-profile' })

      const kimiProfileId = database.saveModelProfile({ name: 'Kimi Code', provider: 'moonshotai-cn', modelId: 'kimi-k2.7-code' })
      expect(database.getModelProfileSecret(kimiProfileId)).toMatchObject({ provider: 'moonshotai-cn', modelId: 'kimi-k2.7-code' })
      expect(() => database.saveModelProfile({ name: 'Unsupported', provider: 'unsupported-provider', modelId: 'unknown' })).toThrow()
    } finally {
      database.close()
    }
  })

  it('uses WAL and restores durable task state after reopening', async () => {
    const { path, database } = await temporaryDatabase()
    expect(database.db.pragma('journal_mode', { simple: true })).toBe('wal')
    const profileId = database.saveModelProfile({
      name: 'Test model', provider: 'openai', modelId: 'gpt-test', isDefault: true,
      capabilities: { contextWindow: 128_000 },
    }, Buffer.from('ciphertext'))
    const workspaceId = database.addWorkspace('/tmp/example-workspace', 'Example')
    const run = database.createRun({
      title: 'Durable run', prompt: 'Inspect the workspace', workspaceId, modelProfileId: profileId,
      modelSnapshot: { profileId, provider: 'openai', modelId: 'gpt-test', capabilities: { contextWindow: 128_000 } },
      limits: { maxModelTurns: 60 },
      readOnly: true,
      accessMode: 'full_disk',
    })
    database.updateRun(run.id, { status: 'paused', summary: 'checkpoint' })
    database.close()

    const reopened = new AppDatabase(path)
    const restored = reopened.getRun(run.id)
    expect(restored).toMatchObject({ id: run.id, status: 'paused', summary: 'checkpoint', workspaceId, modelProfileId: profileId, readOnly: true, accessMode: 'full_disk' })
    expect(restored.messages).toHaveLength(1)
    expect(restored.messages[0]).toMatchObject({ role: 'user', content: 'Inspect the workspace' })
    reopened.updateRun(run.id, { accessMode: 'approval' })
    expect(reopened.getRun(run.id)).toMatchObject({ accessMode: 'approval' })
    reopened.close()
  })

  it('persists cumulative model turns and active duration across pause and reopen', async () => {
    const { path, database } = await temporaryDatabase()
    const run = database.createRun({ title: 'Budgeted run', prompt: 'Continue until done' })
    const startedAt = new Date('2026-07-11T00:00:00.000Z')
    database.beginRunExecution(run.id, startedAt)
    expect(database.incrementRunModelTurns(run.id)).toBe(1)
    expect(database.incrementRunModelTurns(run.id)).toBe(2)
    expect(database.stopRunExecution(run.id, new Date(startedAt.getTime() + 2_500))).toEqual({ modelTurns: 2, activeDurationMs: 2_500, active: false })
    database.close()

    const reopened = new AppDatabase(path)
    expect(reopened.getRunBudgetUsage(run.id, new Date(startedAt.getTime() + 60_000))).toEqual({ modelTurns: 2, activeDurationMs: 2_500, active: false })
    reopened.beginRunExecution(run.id, new Date(startedAt.getTime() + 60_000))
    expect(reopened.stopRunExecution(run.id, new Date(startedAt.getTime() + 61_000))).toEqual({ modelTurns: 2, activeDurationMs: 3_500, active: false })
    reopened.close()
  })

  it('hydrates durable tool receipts and resolved approval history separately from pending approvals', async () => {
    const { database } = await temporaryDatabase()
    const run = database.createRun({ title: 'Auditable research', prompt: 'Find sources' })
    const toolCallId = database.createToolCall({
      runId: run.id,
      toolId: 'web_search',
      risk: 'external_side_effect',
      arguments: { query: 'official source', maxResults: 3 },
    })
    database.updateToolCall(toolCallId, 'succeeded', {
      query: 'official source',
      resultCount: 1,
      results: [{ rank: 1, title: 'Example', url: 'https://example.com/source', snippet: 'Primary source' }],
    })
    const approval = database.createApproval({
      runId: run.id,
      toolCallId,
      reason: 'Search terms leave this Mac',
      preview: { toolName: 'web.search', title: 'Search', arguments: { query: 'official source' }, riskLevel: 'external_side_effect' },
    })
    database.resolveApproval(approval.id, { requestId: approval.id, decision: 'approve', scope: 'once' })

    const restored = database.getRun(run.id)
    expect(restored.approvals).toEqual([])
    expect(restored.toolCalls[0]).toMatchObject({
      id: toolCallId,
      tool_id: 'web_search',
      state: 'succeeded',
      arguments: { query: 'official source', maxResults: 3 },
      result: { resultCount: 1 },
    })
    expect(restored.approvalHistory[0]).toMatchObject({ id: approval.id, status: 'approved', scope: 'once', decision: { decision: 'approve' } })
    database.close()
  })

  it('uses unique receipt ids while retaining provider tool-call ids across runs and retries', async () => {
    const { database } = await temporaryDatabase()
    const firstRun = database.createRun({ title: 'First run', prompt: 'Search once' })
    const secondRun = database.createRun({ title: 'Second run', prompt: 'Search again' })

    // Kimi/Pi-style ids are response-scoped and commonly restart at zero.
    const firstReceipt = database.createToolCall({
      runId: firstRun.id,
      providerCallId: 'web_search_0',
      toolId: 'web_search',
      risk: 'readonly',
      arguments: { query: 'first' },
    })
    const retryReceipt = database.createToolCall({
      runId: firstRun.id,
      providerCallId: 'web_search_0',
      toolId: 'web_search',
      risk: 'readonly',
      arguments: { query: 'retry' },
    })
    const secondRunReceipt = database.createToolCall({
      runId: secondRun.id,
      providerCallId: 'web_search_0',
      toolId: 'web_search',
      risk: 'readonly',
      arguments: { query: 'second run' },
    })

    expect(new Set([firstReceipt, retryReceipt, secondRunReceipt]).size).toBe(3)
    const rows = database.db.prepare(`SELECT id,provider_call_id,run_id FROM tool_calls
      WHERE provider_call_id=? ORDER BY created_at`).all('web_search_0') as any[]
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.provider_call_id === 'web_search_0')).toBe(true)
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining([firstReceipt, retryReceipt, secondRunReceipt]))
    database.close()
  })

  it('backfills provider ids when opening a database with the legacy tool-call schema', async () => {
    const { path, database } = await temporaryDatabase()
    const run = database.createRun({ title: 'Legacy tool row', prompt: 'Resume' })
    const receiptId = database.createToolCall({
      id: 'legacy-provider-call-0',
      runId: run.id,
      toolId: 'file_list',
      risk: 'readonly',
      arguments: { path: '.' },
    })
    database.close()

    const legacy = new Database(path)
    legacy.exec('DROP INDEX IF EXISTS tool_calls_provider_idx')
    legacy.exec('ALTER TABLE tool_calls DROP COLUMN provider_call_id')
    legacy.close()

    const reopened = new AppDatabase(path)
    expect(reopened.db.prepare('SELECT id,provider_call_id FROM tool_calls WHERE id=?').get(receiptId))
      .toEqual({ id: receiptId, provider_call_id: receiptId })
    expect(reopened.db.pragma('foreign_key_check')).toEqual([])
    reopened.close()
  })

  it('does not expose encrypted model keys and binds task grants to exact arguments', async () => {
    const { database } = await temporaryDatabase()
    const profileId = database.saveModelProfile({ name: 'Private', provider: 'anthropic', modelId: 'claude-test' }, Buffer.from('encrypted-key'))
    const profiles = database.listModelProfiles()
    expect(profiles[0]).toMatchObject({ id: profileId, hasKey: true })
    expect(profiles[0]).not.toHaveProperty('encrypted_key')

    database.addGrant('run-1', 'shell.command', 'run_tool', { command: 'pnpm test' })
    expect(database.hasRunGrant('run-1', 'shell.command', { command: 'pnpm test' })).toBe(true)
    expect(database.hasRunGrant('run-1', 'shell.command', { command: 'pnpm publish' })).toBe(false)
    expect(database.hasRunGrant('run-2', 'shell.command', { command: 'pnpm test' })).toBe(false)
    database.close()
  })

  it('matches settings-only persistent grants by tool and exact path subset', async () => {
    const { database } = await temporaryDatabase()
    const workspaceId = database.addWorkspace('/tmp/persistent-grant-workspace', 'Grant workspace')
    const otherWorkspaceId = database.addWorkspace('/tmp/other-persistent-grant-workspace', 'Other workspace')
    const run = database.createRun({ title: 'Granted run', prompt: 'Write', workspaceId })
    const otherRun = database.createRun({ title: 'Other run', prompt: 'Write', workspaceId: otherWorkspaceId })
    const grant = database.addPersistentGrant(workspaceId, 'file.write', 'docs/report.md')
    expect(database.hasRunGrant(run.id, 'file.write', { path: 'docs/report.md', content: 'new content' })).toBe(true)
    expect(database.hasRunGrant(run.id, 'file.write', { path: 'docs/other.md', content: 'new content' })).toBe(false)
    expect(database.hasRunGrant(run.id, 'file.edit', { path: 'docs/report.md', oldText: 'a', newText: 'b' })).toBe(false)
    expect(database.hasRunGrant(otherRun.id, 'file.write', { path: 'docs/report.md', content: 'new content' })).toBe(false)
    expect(database.listPersistentGrants()).toEqual([grant])
    database.removePersistentGrant(grant.id)
    expect(database.listPersistentGrants()).toEqual([])
    database.close()
  })

  it('atomically pauses interrupted runs and expires volatile work on recovery', async () => {
    const { database } = await temporaryDatabase()
    const waiting = database.createRun({ title: 'Approval wait', prompt: 'Wait for approval' })
    database.updateRun(waiting.id, { status: 'waiting_approval' })
    const waitingTool = database.createToolCall({ runId: waiting.id, toolId: 'shell_run', risk: 'reversible_write', arguments: { command: 'pnpm test' } })
    database.updateToolCall(waitingTool, 'waiting_approval')
    database.createApproval({ runId: waiting.id, toolCallId: waitingTool, reason: 'Test approval', preview: {} })

    const running = database.createRun({ title: 'Running', prompt: 'Continue running' })
    database.updateRun(running.id, { status: 'running' })
    const runningTool = database.createToolCall({ runId: running.id, toolId: 'file_read', risk: 'readonly', arguments: { path: 'README.md' } })
    database.updateToolCall(runningTool, 'running')

    const result = database.recoverInterruptedWork('test restart')
    expect(result).toMatchObject({ pausedRuns: 2, expiredApprovals: 1, cancelledToolCalls: 2 })
    expect(result.runIds).toEqual(expect.arrayContaining([waiting.id, running.id]))
    expect(database.getRun(waiting.id)).toMatchObject({ status: 'paused', approvals: [] })
    expect(database.getRun(running.id)).toMatchObject({ status: 'paused' })
    expect(database.db.prepare('SELECT status FROM approvals WHERE tool_call_id=?').get(waitingTool)).toMatchObject({ status: 'expired' })
    expect(database.db.prepare('SELECT state,error FROM tool_calls WHERE id=?').get(waitingTool)).toMatchObject({ state: 'cancelled', error: 'test restart' })
    expect(database.db.prepare('SELECT state,error FROM tool_calls WHERE id=?').get(runningTool)).toMatchObject({ state: 'cancelled', error: 'test restart' })
    expect(database.listAudit(1)[0]).toMatchObject({ action: 'recover_interrupted_work', summary: 'test restart' })

    expect(database.recoverInterruptedWork('second restart')).toEqual({ runIds: [], pausedRuns: 0, expiredApprovals: 0, cancelledToolCalls: 0 })
    database.close()
  })

  it('enforces persisted read-only authority at the broker persistence boundary', async () => {
    const { database } = await temporaryDatabase()
    const run = database.createRun({ title: 'Read-only subagent', prompt: 'Inspect only', readOnly: true })
    expect(database.getRun(run.id)?.readOnly).toBe(true)
    expect(() => database.createToolCall({ runId: run.id, toolId: 'file_read', risk: 'readonly', arguments: { path: 'README.md' } })).not.toThrow()
    expect(() => database.createToolCall({ runId: run.id, toolId: 'file_write', risk: 'reversible_write', arguments: { path: 'README.md' } })).toThrow('只读子任务只能调用只读工具')
    expect(database.listAudit(1)[0]).toMatchObject({ action: 'readonly_tool_blocked', run_id: run.id })
    database.close()
  })

  it('moves active Chrome tasks to waiting_user when the bridge disconnects', async () => {
    const { database } = await temporaryDatabase()
    const run = database.createRun({ title: 'Chrome task', prompt: 'Inspect the granted tab' })
    database.updateRun(run.id, { status: 'running' })
    database.addChromeGrant({ runId: run.id, tabId: 42, windowId: 1, url: 'https://example.com' })
    const toolCallId = database.createToolCall({ runId: run.id, toolId: 'chrome_click', risk: 'external_side_effect', arguments: { tabId: 42, selector: '#submit' } })
    database.updateToolCall(toolCallId, 'waiting_approval')
    database.createApproval({ runId: run.id, toolCallId, reason: 'Submit', preview: {} })

    const result = database.pauseChromeRunsForDisconnect('bridge lost')
    expect(result).toEqual({ runIds: [run.id], expiredApprovals: 1, cancelledToolCalls: 1 })
    expect(database.getRun(run.id)).toMatchObject({ status: 'waiting_user', approvals: [] })
    expect(database.db.prepare('SELECT state FROM tool_calls WHERE id=?').get(toolCallId)).toMatchObject({ state: 'cancelled' })
    database.updateToolCall(toolCallId, 'failed', undefined, 'late disconnect rejection')
    expect(database.db.prepare('SELECT state,error FROM tool_calls WHERE id=?').get(toolCallId)).toMatchObject({ state: 'cancelled', error: 'bridge lost' })
    expect(database.listAudit(1)[0]).toMatchObject({ action: 'pause_on_disconnect' })
    database.close()
  })

  it('prunes only detailed logs by age and byte budget while retaining task state', async () => {
    const { database } = await temporaryDatabase()
    const run = database.createRun({ title: 'Retained task', prompt: 'Keep this task' })
    const toolCallId = database.createToolCall({ runId: run.id, toolId: 'file_read', risk: 'readonly', arguments: { path: 'README.md' } })
    database.updateToolCall(toolCallId, 'succeeded', { content: 'old detail' })
    database.audit('test', 'old_audit', 'old audit', { payload: 'x'.repeat(200) }, run.id)
    database.db.prepare("UPDATE run_events SET created_at='2000-01-01T00:00:00.000Z' WHERE run_id=?").run(run.id)
    database.db.prepare("UPDATE tool_calls SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(toolCallId)
    database.db.prepare("UPDATE audit_events SET created_at='2000-01-01T00:00:00.000Z' WHERE action='old_audit'").run()

    const byAge = database.pruneDetailedLogs(90, 10_000)
    expect(byAge).toMatchObject({ runEvents: 1, toolCalls: 1, auditEvents: 1 })
    expect(database.getRun(run.id)).toMatchObject({ id: run.id, title: 'Retained task' })

    for (let index = 0; index < 4; index += 1) database.audit('test', `large_${index}`, 'recent audit', { payload: 'y'.repeat(250) }, run.id)
    const byBudget = database.pruneDetailedLogs(3_650, 200)
    expect(byBudget.estimatedBytes).toBeLessThanOrEqual(200)
    expect(byBudget.auditEvents).toBeGreaterThan(0)
    expect(database.getRun(run.id)).toMatchObject({ id: run.id, title: 'Retained task' })
    database.close()
  })

  it('associates an imported attachment with only one run and records it on the initial message', async () => {
    const { database } = await temporaryDatabase()
    const profileId = database.saveModelProfile({ name: 'Model', provider: 'openai', modelId: 'gpt-test' })
    const workspaceId = database.addWorkspace('/tmp/attachment-workspace', 'Attachment')
    const first = database.createRun({ prompt: 'Read attachment', workspaceId, modelProfileId: profileId })
    const second = database.createRun({ prompt: 'Other run', workspaceId, modelProfileId: profileId })
    database.addArtifact({ id: 'attachment-1', kind: 'attachment', name: 'notes.txt', path: '/tmp/notes.txt', sha256: 'a'.repeat(64), mime: 'text/plain', size: 5 })

    database.attachArtifactsToRun(first.id, ['attachment-1'])
    database.setInitialMessageArtifacts(first.id, ['attachment-1'])
    expect(database.getRun(first.id)?.messages[0]?.metadata).toEqual({ artifactIds: ['attachment-1'] })
    expect(() => database.attachArtifactsToRun(second.id, ['attachment-1'])).toThrow('已属于其他任务')
    database.close()
  })

  it('persists explicit per-step transitions and exposes their verification evidence', async () => {
    const { database } = await temporaryDatabase()
    const run = database.createRun({ title: 'Step state', prompt: 'Implement and verify' })
    const [createdStep] = database.replaceSteps(run.id, [{ title: 'Implement change' }])
    const stepId = createdStep.id
    expect(stepId).toBe(database.getRun(run.id)?.steps[0]?.id)
    expect(() => database.updateTaskStep(run.id, stepId, { status: 'completed', evidence: 'claimed done' })).toThrow('Invalid step state transition')
    database.updateTaskStep(run.id, stepId, { status: 'in_progress' })
    database.updateTaskStep(run.id, stepId, { status: 'completed', evidence: 'pnpm test: 12 passed' })
    expect(database.getRun(run.id)?.steps[0]).toMatchObject({
      id: stepId,
      status: 'completed',
      evidence: ['pnpm test: 12 passed'],
      verification: 'pnpm test: 12 passed',
    })
    database.close()
  })
})
