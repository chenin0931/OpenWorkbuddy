import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolBroker } from './tool-broker'

const now = '2026-07-11T00:00:00.000Z'

class FakeDatabase {
  settings: Record<string, unknown> = { appSettings: { memoryEnabled: true, permissionMode: 'cautious' } }
  run: any = { id: 'run-1', workspaceId: 'workspace-1', steps: [], status: 'running', readOnly: false }
  toolRows: any[] = []
  artifactRows: any[] = []
  savedMemory: any
  granted = true
  approvals: any[] = []
  skills = new Map<string, any>()
  private nextToolReceipt = 0
  currentTurnStartedAt: string | undefined

  db = {
    prepare: (sql: string) => {
      if (sql.includes('FROM tool_calls')) {
        return { all: (runId: string) => this.toolRows.filter((row) => row.run_id === runId && row.tool_id !== 'task_complete') }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }

  getRun = (id: string) => id === this.run.id ? this.run : undefined
  getWorkspace = () => ({ root_path: '/workspace' })
  getSetting = <T>(key: string, fallback: T): T => (this.settings[key] ?? fallback) as T
  hasRunGrant = () => this.granted
  audit = () => undefined
  listArtifacts = () => this.artifactRows
  updateRun = (_id: string, patch: Record<string, unknown>) => Object.assign(this.run, patch)
  transitionRun = (_id: string, status: string, patch: Record<string, unknown> = {}) => Object.assign(this.run, patch, { status })
  getCurrentRunTurnStartedAt = () => this.currentTurnStartedAt
  hasPendingApprovals = () => this.approvals.some((approval) => approval.status === undefined || approval.status === 'pending')
  saveMemory = (input: any) => { this.savedMemory = input; return 'memory-1' }
  getSkill = (id: string) => this.skills.get(id)
  createApproval = (input: any) => { this.approvals.push({ ...input, status: 'pending' }); return input }
  resolveApproval = (id: string, decision: any) => { const approval = this.approvals.find((candidate) => candidate.id === id); if (approval) approval.status = decision.decision === 'reject' ? 'denied' : 'approved'; return { id, decision } }
  addGrant = () => undefined
  updateTaskStep = (runId: string, stepId: string, patch: { status: string; evidence?: string }) => {
    const step = this.run.steps.find((candidate: any) => candidate.id === stepId && candidate.runId === runId)
    if (!step) throw new Error('step not found')
    if (patch.status === 'completed' && !patch.evidence && !step.verification) throw new Error('evidence required')
    Object.assign(step, { status: patch.status, updatedAt: now }, patch.evidence ? { verification: patch.evidence, evidence: [patch.evidence] } : {})
    return step
  }
  createToolCall = (input: any) => {
    const id = input.id ?? `receipt-${++this.nextToolReceipt}`
    this.toolRows.push({ id, provider_call_id: input.providerCallId ?? id, run_id: input.runId, tool_id: input.toolId, state: 'requested', arguments_json: JSON.stringify(input.arguments), result_json: null, error: null, created_at: now, updated_at: now })
    return id
  }
  updateToolCall = (id: string, state: string, result?: unknown, error?: string) => {
    const row = this.toolRows.find((candidate) => candidate.id === id)
    if (row) Object.assign(row, { state, result_json: result === undefined ? null : JSON.stringify(result), error: error ?? null, updated_at: now })
  }
}

function brokerFixture(database = new FakeDatabase(), execute?: (input: any) => Promise<any>) {
  const stored: any[] = []
  const events: any[] = []
  const runner = { execute: execute ?? (async () => ({})) }
  const artifacts = {
    putText: async (input: any) => {
      const artifact = { id: `artifact-${stored.length + 1}`, ...input }
      stored.push(artifact)
      database.artifactRows.push({ ...artifact, name: input.name })
      return artifact
    },
    putBuffer: async () => { throw new Error('not used') },
  }
  const broker = new ToolBroker(database as any, runner as any, artifacts as any, {} as any, {} as any, (event) => events.push(event), async () => ({}))
  return { broker, database, stored, events }
}

describe('ToolBroker completion gate', () => {
  it('treats task_complete alone as ordinary conversation instead of inventing a partial verdict', async () => {
    const { broker, database, events } = brokerFixture()
    const result = await broker.handle({ runId: 'run-1', requestId: 'request-1', toolCallId: 'complete-1', toolId: 'task_complete', args: { summary: 'done', evidence: ['tests passed'], unverified: [] } }) as any
    expect(result).toMatchObject({ verificationRequired: false, outcome: null })
    expect(database.run.outcome).toBeNull()
    expect(events.some((event) => event.kind === 'verification.completed')).toBe(false)
  })

  it('does not treat one successful read or one durable Diff as a correctness check', async () => {
    const readFixture = brokerFixture()
    readFixture.database.toolRows.push({ id: 'read-1', run_id: 'run-1', tool_id: 'file_read', state: 'succeeded', arguments_json: JSON.stringify({ path: 'README.md' }), result_json: JSON.stringify({ sha256: 'x' }), error: null, created_at: now, updated_at: now })
    const readResult = await readFixture.broker.handle({ runId: 'run-1', requestId: 'request-read', toolCallId: 'complete-read', toolId: 'task_complete', args: { summary: 'read', evidence: [], unverified: [] } }) as any
    expect(readResult.outcome).toBe('partial')
    expect(readResult.verificationRequired).toBe(true)
    expect(readResult.evidence).toContain('读取回执：1 个可观察来源读取成功，0 个失败')

    const diffFixture = brokerFixture()
    diffFixture.database.artifactRows.push({ id: 'diff-1', run_id: 'run-1', kind: 'diff', name: 'change.diff' })
    const diffResult = await diffFixture.broker.handle({ runId: 'run-1', requestId: 'request-diff', toolCallId: 'complete-diff', toolId: 'task_complete', args: { summary: 'diff', evidence: [], unverified: [] } }) as any
    expect(diffResult.outcome).toBe('partial')
    expect(diffResult.evidence).toContain('文件 Diff：1 个持久化 Diff')
  })

  it('never bulk-completes pending steps during final verification', async () => {
    const fixture = brokerFixture()
    fixture.database.run.steps = [{ id: 'step-1', runId: 'run-1', title: 'implement', ordinal: 0, status: 'pending', createdAt: now, updatedAt: now }]
    fixture.database.toolRows.push({ id: 'shell-1', run_id: 'run-1', tool_id: 'shell_run', state: 'succeeded', arguments_json: JSON.stringify({ command: 'pnpm test' }), result_json: JSON.stringify({ code: 0 }), error: null, created_at: now, updated_at: now })
    const result = await fixture.broker.handle({ runId: 'run-1', requestId: 'request-1', toolCallId: 'complete-1', toolId: 'task_complete', args: { summary: 'done', evidence: [], unverified: [] } }) as any
    expect(result.outcome).toBe('partial')
    expect(fixture.database.run.steps[0].status).toBe('pending')
  })

  it('accepts explicitly completed steps with step evidence and successful validation', async () => {
    const fixture = brokerFixture()
    fixture.database.run.steps = [{ id: 'step-1', runId: 'run-1', title: 'implement', ordinal: 0, status: 'pending', createdAt: now, updatedAt: now }]
    await fixture.broker.handle({ runId: 'run-1', requestId: 'step-start', toolCallId: 'step-tool-1', toolId: 'task_step_update', args: { stepId: 'step-1', status: 'in_progress' } })
    await fixture.broker.handle({ runId: 'run-1', requestId: 'step-done', toolCallId: 'step-tool-2', toolId: 'task_step_update', args: { stepId: 'step-1', status: 'completed', evidence: '实现已保存并准备验证' } })
    fixture.database.toolRows.push({ id: 'shell-1', run_id: 'run-1', tool_id: 'shell_run', state: 'succeeded', arguments_json: JSON.stringify({ command: 'pnpm test' }), result_json: JSON.stringify({ code: 0 }), error: null, created_at: now, updated_at: now })
    const result = await fixture.broker.handle({ runId: 'run-1', requestId: 'request-1', toolCallId: 'complete-1', toolId: 'task_complete', args: { summary: 'done', evidence: [], unverified: [] } }) as any
    expect(result.outcome).toBe('verified')
    expect(fixture.database.run.steps[0]).toMatchObject({ status: 'completed', verification: '实现已保存并准备验证' })
    expect(fixture.events.some((event) => event.kind === 'step.updated' && event.step.verification)).toBe(true)
  })

  it('keeps file mutations partial without a successful post-mutation validation command', async () => {
    const fixture = brokerFixture()
    fixture.database.toolRows.push({ id: 'write-1', run_id: 'run-1', tool_id: 'file_write', state: 'succeeded', arguments_json: JSON.stringify({ path: 'x.ts', content: 'x' }), result_json: JSON.stringify({ sha256: 'x' }), error: null, created_at: now, updated_at: now })
    fixture.database.artifactRows.push({ id: 'diff-1', run_id: 'run-1', kind: 'diff', name: 'x.diff' })
    const result = await fixture.broker.handle({ runId: 'run-1', requestId: 'complete', toolCallId: 'complete-1', toolId: 'task_complete', args: { summary: 'done', evidence: [], unverified: [] } }) as any
    expect(result.outcome).toBe('partial')
    expect(result.verification.checks).toContainEqual(expect.objectContaining({ name: '文件修改验证', status: 'not_run' }))
  })

  it('verifies a file mutation after a successful validation command', async () => {
    const fixture = brokerFixture()
    fixture.database.toolRows.push(
      { id: 'write-1', run_id: 'run-1', tool_id: 'file_write', state: 'succeeded', arguments_json: JSON.stringify({ path: 'x.ts', content: 'x' }), result_json: JSON.stringify({ sha256: 'x' }), error: null, created_at: now, updated_at: now },
      { id: 'shell-1', run_id: 'run-1', tool_id: 'shell_run', state: 'succeeded', arguments_json: JSON.stringify({ command: 'pnpm test' }), result_json: JSON.stringify({ code: 0 }), error: null, created_at: now, updated_at: now },
    )
    const result = await fixture.broker.handle({ runId: 'run-1', requestId: 'complete', toolCallId: 'complete-1', toolId: 'task_complete', args: { summary: 'done', evidence: [], unverified: [] } }) as any
    expect(result.outcome).toBe('verified')
    expect(result.evidence).toContain('验证命令：pnpm test')
  })
})

describe('ToolBroker file leases and artifacts', () => {
  it('serializes the same normalized path and records new-file snapshot/diff metadata', async () => {
    let active = 0
    let maxActive = 0
    const fixture = brokerFixture(new FakeDatabase(), async (input) => {
      if (input.toolId === 'file.read') {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      }
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return { path: '/workspace/new.txt', before: null, after: 'hello', beforeSha256: null, sha256: 'after-hash', created: true }
    })
    await Promise.all([
      fixture.broker.handle({ runId: 'run-1', requestId: 'request-1', toolCallId: 'write-1', toolId: 'file_write', args: { path: './new.txt', content: 'hello' } }),
      fixture.broker.handle({ runId: 'run-1', requestId: 'request-2', toolCallId: 'write-2', toolId: 'file_write', args: { path: 'folder/../new.txt', content: 'hello' } }),
    ])
    expect(maxActive).toBe(1)
    const diff = fixture.stored.find((artifact) => artifact.kind === 'diff')
    expect(diff.metadata).toMatchObject({ path: '/workspace/new.txt', afterSha256: 'after-hash', createdFile: true })
    expect(diff.metadata.snapshotArtifactId).toMatch(/^artifact-/)
  })
})

describe('ToolBroker capability enforcement', () => {
  it('validates initial and approval-edited arguments before policy execution', async () => {
    const database = new FakeDatabase()
    const fixture = brokerFixture(database)
    await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'invalid-initial', toolCallId: 'read-invalid', toolId: 'file_read', args: { path: 42 } as any })).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' })
    expect(database.toolRows).toHaveLength(0)

    database.granted = false
    const pending = fixture.broker.handle({ runId: 'run-1', requestId: 'write-request', toolCallId: 'write-approval', toolId: 'file_write', args: { path: 'x.txt', content: 'safe' } })
    const pendingRejection = expect(pending).rejects.toThrow('test cleanup')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const approval = fixture.events.find((event) => event.kind === 'approval.requested')?.approval
    expect(approval).toBeDefined()
    expect(() => fixture.broker.respondToApproval({ requestId: approval.id, decision: 'edit', editedArguments: { path: 'x.txt' } })).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_ARGUMENTS' }))
    expect(database.approvals).toHaveLength(1)
    const receipt = database.toolRows.find((row) => row.provider_call_id === 'write-approval')
    expect(receipt?.state).toBe('waiting_approval')
    expect(database.approvals[0]).toMatchObject({ toolCallId: receipt.id, preview: { toolCallId: 'write-approval' } })
    expect(approval.toolCallId).toBe('write-approval')
    fixture.broker.rejectRunApprovals('run-1', 'test cleanup')
    await pendingRejection
  })

  it('rejects Memory writes when Memory is disabled', async () => {
    const database = new FakeDatabase()
    database.settings.appSettings = { memoryEnabled: false }
    const { broker } = brokerFixture(database)
    await expect(broker.handle({ runId: 'run-1', requestId: 'request-1', toolCallId: 'memory-1', toolId: 'memory_propose', args: { scope: 'user', kind: 'stable_fact', content: 'x', confidence: 0.9 } })).rejects.toMatchObject({ code: 'memory.disabled' })
    expect(database.savedMemory).toBeUndefined()
  })

  it('maps Memory types and rejects writes from a persisted read-only run', async () => {
    const database = new FakeDatabase()
    const fixture = brokerFixture(database)
    await fixture.broker.handle({ runId: 'run-1', requestId: 'request-1', toolCallId: 'memory-1', toolId: 'memory_propose', args: { scope: 'user', kind: 'knowledge_background', content: 'x', confidence: 0.9 } })
    expect(database.savedMemory.kind).toBe('knowledge_background')

    database.run.readOnly = true
    await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'request-2', toolCallId: 'write-1', toolId: 'file_write', args: { path: 'x.txt', content: 'x' } })).rejects.toMatchObject({ code: 'run.readonly-capability' })
  })

  it('requires approval before search and lets an approved read-only run execute it', async () => {
    const database = new FakeDatabase()
    database.run.readOnly = true
    database.granted = false
    const runnerCalls: any[] = []
    const fixture = brokerFixture(database, async (input) => {
      runnerCalls.push(input)
      return { engine: 'bing-html', query: input.args.query, resultCount: 0, results: [] }
    })

    await expect(fixture.broker.handle({
      runId: 'run-1',
      requestId: 'search-invalid',
      toolCallId: 'search-invalid',
      toolId: 'web_search',
      args: { query: '' },
    })).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' })
    expect(database.toolRows).toHaveLength(0)

    const pending = fixture.broker.handle({
      runId: 'run-1',
      requestId: 'search-request',
      toolCallId: 'search-approval',
      toolId: 'web_search',
      args: { query: 'OpenWorkbuddy', maxResults: 5 },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runnerCalls).toHaveLength(0)
    expect(database.toolRows[0]).toMatchObject({ tool_id: 'web_search', state: 'waiting_approval' })
    const approval = fixture.events.find((event) => event.kind === 'approval.requested')?.approval
    expect(approval).toMatchObject({ target: 'OpenWorkbuddy', sendsData: ['工具参数可能发送到外部系统'] })

    fixture.broker.respondToApproval({ requestId: approval.id, decision: 'approve', scope: 'once' })
    await expect(pending).resolves.toMatchObject({ engine: 'bing-html', query: 'OpenWorkbuddy' })
    expect(runnerCalls).toHaveLength(1)
    expect(runnerCalls[0]).toMatchObject({ toolId: 'web.search', args: { query: 'OpenWorkbuddy', maxResults: 5 } })
  })

  it('runs a public search without an approval in balanced mode', async () => {
    const database = new FakeDatabase()
    database.settings.appSettings = { memoryEnabled: true, permissionMode: 'balanced' }
    database.run.readOnly = true
    database.granted = false
    const runnerCalls: any[] = []
    const fixture = brokerFixture(database, async (input) => {
      runnerCalls.push(input)
      return { engine: 'bing-html', query: input.args.query, resultCount: 0, results: [] }
    })

    await expect(fixture.broker.handle({
      runId: 'run-1',
      requestId: 'search-balanced',
      toolCallId: 'search-balanced',
      toolId: 'web_search',
      args: { query: 'OpenWorkbuddy' },
    })).resolves.toMatchObject({ query: 'OpenWorkbuddy' })
    expect(runnerCalls).toHaveLength(1)
    expect(database.approvals).toHaveLength(0)
  })

  it('keeps fetched page text out of the persisted tool receipt', async () => {
    const database = new FakeDatabase()
    const fixture = brokerFixture(database, async () => ({
      url: 'https://news.example/article',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      charset: 'utf-8',
      text: 'sensitive untrusted page body',
      truncated: false,
      total: 29,
    }))

    const result = await fixture.broker.handle({
      runId: 'run-1',
      requestId: 'fetch-request',
      toolCallId: 'fetch-1',
      toolId: 'web_fetch',
      args: { url: 'https://news.example/article' },
    }) as any

    expect(result.text).toBe('sensitive untrusted page body')
    const persisted = JSON.parse(database.toolRows[0].result_json)
    expect(persisted).toMatchObject({
      url: 'https://news.example/article',
      status: 200,
      text: '[CONTENT OMITTED: 29 chars]',
    })
    expect(JSON.stringify(persisted)).not.toContain('sensitive untrusted page body')
  })

  it('preserves source metadata but omits previews when a fetched page is offloaded', async () => {
    const database = new FakeDatabase()
    const pageText = `private page content ${'x'.repeat(140 * 1024)}`
    const fixture = brokerFixture(database, async () => ({
      url: 'https://large.example/article',
      status: 200,
      contentType: 'text/html',
      charset: 'utf-8',
      text: pageText,
      truncated: false,
      total: pageText.length,
    }))

    const result = await fixture.broker.handle({
      runId: 'run-1',
      requestId: 'large-fetch-request',
      toolCallId: 'large-fetch-1',
      toolId: 'web_fetch',
      args: { url: 'https://large.example/article' },
    }) as any

    expect(result).toMatchObject({ url: 'https://large.example/article', status: 200, truncated: true })
    expect(result.artifact.kind).toBe('tool_result')
    const persisted = JSON.parse(database.toolRows[0].result_json)
    expect(persisted).toMatchObject({
      url: 'https://large.example/article',
      status: 200,
      preview: expect.stringContaining('[CONTENT OMITTED'),
    })
    expect(JSON.stringify(persisted)).not.toContain('private page content')
  })
})

describe('ToolBroker Skill resources', () => {
  it('reads managed text resources and rejects traversal and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbuddy-skill-'))
    try {
      const skillPath = join(root, 'skill')
      await mkdir(join(skillPath, 'references'), { recursive: true })
      await mkdir(join(skillPath, 'scripts'), { recursive: true })
      await writeFile(join(skillPath, 'SKILL.md'), '# Skill\n')
      await writeFile(join(skillPath, 'references', 'guide.md'), 'trusted guide\n')
      await writeFile(join(skillPath, 'scripts', 'check.sh'), '#!/bin/sh\necho checked\n')
      const outside = join(root, 'outside.md')
      await writeFile(outside, 'outside\n')
      await symlink(outside, join(skillPath, 'references', 'escape.md'))

      const database = new FakeDatabase()
      database.skills.set('skill-1', { id: 'skill-1', name: 'Skill One', path: skillPath, enabled: true, permissions: {} })
      const fixture = brokerFixture(database, async () => { throw new Error('runner must not execute Skill resources') })
      const guide = await fixture.broker.handle({ runId: 'run-1', requestId: 'guide', toolCallId: 'skill-guide', toolId: 'skill_read', args: { skillId: 'skill-1', resource: 'references/guide.md' } }) as any
      expect(guide.instructions).toBe('trusted guide\n')
      const script = await fixture.broker.handle({ runId: 'run-1', requestId: 'script', toolCallId: 'skill-script', toolId: 'skill_read', args: { skillId: 'skill-1', resource: 'scripts/check.sh' } }) as any
      expect(script.instructions).toContain('echo checked')
      await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'traversal', toolCallId: 'skill-traversal', toolId: 'skill_read', args: { skillId: 'skill-1', resource: '../outside.md' } })).rejects.toMatchObject({ code: 'INVALID_SKILL_RESOURCE' })
      await expect(fixture.broker.handle({ runId: 'run-1', requestId: 'symlink', toolCallId: 'skill-symlink', toolId: 'skill_read', args: { skillId: 'skill-1', resource: 'references/escape.md' } })).rejects.toMatchObject({ code: 'SKILL_RESOURCE_SYMLINK' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
