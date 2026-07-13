import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { RunStatus, TaskStepStatus } from '@onmyworkbuddy/contracts'
import { assertRunTransition, assertStepTransition, isTerminalRunStatus } from '@onmyworkbuddy/core'

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null

const now = (): string => new Date().toISOString()
const json = (value: unknown): string => JSON.stringify(value ?? null)
const MODEL_PROFILE_PROVIDER_CHECK = "'openai','anthropic','moonshotai-cn'"
const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string') return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (!item || Array.isArray(item) || typeof item !== 'object') return item
  return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
})

const isConstraintMatch = (constraint: unknown, requested: unknown): boolean => {
  if (Array.isArray(constraint)) {
    return Array.isArray(requested) && constraint.length === requested.length
      && constraint.every((item, index) => isConstraintMatch(item, requested[index]))
  }
  if (constraint && typeof constraint === 'object') {
    if (!requested || Array.isArray(requested) || typeof requested !== 'object') return false
    return Object.entries(constraint as Record<string, unknown>)
      .every(([key, value]) => isConstraintMatch(value, (requested as Record<string, unknown>)[key]))
  }
  return Object.is(constraint, requested)
}

export class AppDatabase {
  readonly db: Database.Database

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.db = new Database(filePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.migrate()
  }

  close(): void { this.db.close() }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN (${MODEL_PROFILE_PROVIDER_CHECK})),
        model_id TEXT NOT NULL,
        encrypted_key BLOB,
        is_default INTEGER NOT NULL DEFAULT 0,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        rules TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        mode TEXT NOT NULL DEFAULT 'act',
        read_only INTEGER NOT NULL DEFAULT 0,
        access_mode TEXT NOT NULL DEFAULT 'approval' CHECK(access_mode IN ('approval','full_disk')),
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
        model_snapshot_json TEXT NOT NULL DEFAULT '{}',
        limits_json TEXT NOT NULL DEFAULT '{}',
        model_turns INTEGER NOT NULL DEFAULT 0,
        active_duration_ms INTEGER NOT NULL DEFAULT 0,
        active_segment_started_at TEXT,
        parent_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        goal TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_updated_idx ON runs(updated_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_run_idx ON messages(run_id, created_at);
      CREATE TABLE IF NOT EXISTS task_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_events_idx ON run_events(run_id, id);
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        provider_call_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        tool_id TEXT NOT NULL,
        state TEXT NOT NULL,
        risk TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        scope TEXT NOT NULL DEFAULT 'once',
        reason TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        decision_json TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS approval_grants (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        tool_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        constraints_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        confidence REAL NOT NULL DEFAULT 0.7,
        source_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, content, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        config_json TEXT NOT NULL,
        encrypted_secret BLOB,
        enabled INTEGER NOT NULL DEFAULT 1,
        health TEXT NOT NULL DEFAULT 'unknown',
        last_error TEXT,
        server_version TEXT,
        schema_fingerprint TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        version TEXT NOT NULL,
        scope TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        permissions_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        timezone TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chrome_grants (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        tab_id INTEGER NOT NULL,
        window_id INTEGER,
        url TEXT,
        title TEXT,
        parent_tab_id INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        run_id TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `)

    this.migrateModelProfileProviderConstraint()

    // CREATE TABLE IF NOT EXISTS does not evolve databases created by an older
    // build. Keep this additive migration local and deterministic so a task's
    // authority survives application upgrades and restarts.
    const runColumns = this.db.pragma('table_info(runs)') as Array<{ name: string }>
    if (!runColumns.some((column) => column.name === 'read_only')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0')
    }
    if (!runColumns.some((column) => column.name === 'access_mode')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'approval' CHECK(access_mode IN ('approval','full_disk'))")
    }
    if (!runColumns.some((column) => column.name === 'active_duration_ms')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN active_duration_ms INTEGER NOT NULL DEFAULT 0')
    }
    if (!runColumns.some((column) => column.name === 'active_segment_started_at')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN active_segment_started_at TEXT')
    }
    const mcpColumns = this.db.pragma('table_info(mcp_servers)') as Array<{ name: string }>
    if (!mcpColumns.some((column) => column.name === 'server_version')) {
      this.db.exec('ALTER TABLE mcp_servers ADD COLUMN server_version TEXT')
    }
    if (!mcpColumns.some((column) => column.name === 'last_checked_at')) {
      this.db.exec('ALTER TABLE mcp_servers ADD COLUMN last_checked_at TEXT')
    }
    // A provider tool-call id identifies a call only inside the provider's
    // conversation/response. Some providers restart their generated counter
    // for every new run or resumed turn (for example `web_search_0`), so it
    // cannot safely serve as this database's global primary key. Keep a
    // separate durable receipt id and retain the provider id for correlation.
    const toolCallColumns = this.db.pragma('table_info(tool_calls)') as Array<{ name: string }>
    if (!toolCallColumns.some((column) => column.name === 'provider_call_id')) {
      this.db.exec('ALTER TABLE tool_calls ADD COLUMN provider_call_id TEXT')
      this.db.exec('UPDATE tool_calls SET provider_call_id=id WHERE provider_call_id IS NULL')
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS tool_calls_provider_idx ON tool_calls(run_id, provider_call_id, created_at)')
  }

  private migrateModelProfileProviderConstraint(): void {
    const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='model_profiles'").get() as { sql?: string } | undefined
    if (table?.sql?.includes("'moonshotai-cn'")) return

    const foreignKeysEnabled = Boolean(this.db.pragma('foreign_keys', { simple: true }))
    this.db.pragma('foreign_keys = OFF')
    try {
      this.db.transaction(() => {
        this.db.exec(`
          DROP TABLE IF EXISTS model_profiles_provider_migration;
          CREATE TABLE model_profiles_provider_migration (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            provider TEXT NOT NULL CHECK(provider IN (${MODEL_PROFILE_PROVIDER_CHECK})),
            model_id TEXT NOT NULL,
            encrypted_key BLOB,
            is_default INTEGER NOT NULL DEFAULT 0,
            capabilities_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO model_profiles_provider_migration(
            id,name,provider,model_id,encrypted_key,is_default,capabilities_json,created_at,updated_at
          )
          SELECT id,name,provider,model_id,encrypted_key,is_default,capabilities_json,created_at,updated_at
          FROM model_profiles;
          DROP TABLE model_profiles;
          ALTER TABLE model_profiles_provider_migration RENAME TO model_profiles;
        `)
        const violations = this.db.pragma('foreign_key_check') as unknown[]
        if (violations.length > 0) throw new Error('model_profiles provider migration would violate foreign keys')
      })()
    } finally {
      if (foreignKeysEnabled) this.db.pragma('foreign_keys = ON')
    }
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json?: string } | undefined
    return parse(row?.value_json, fallback)
  }

  setSetting(key: string, value: Json): void {
    this.db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, json(value), now())
  }

  listModelProfiles(): any[] {
    return (this.db.prepare('SELECT * FROM model_profiles ORDER BY is_default DESC, updated_at DESC').all() as any[])
      .map(({ encrypted_key: key, capabilities_json, is_default, ...row }) => ({ ...row, isDefault: Boolean(is_default), hasKey: Boolean(key), capabilities: parse(capabilities_json, {}) }))
  }

  getModelProfileSecret(id: string): { id: string; provider: string; modelId: string; encryptedKey?: Buffer } | undefined {
    const row = this.db.prepare('SELECT id,provider,model_id,encrypted_key FROM model_profiles WHERE id=?').get(id) as any
    if (!row) return undefined
    return { id: row.id, provider: row.provider, modelId: row.model_id, ...(row.encrypted_key ? { encryptedKey: row.encrypted_key } : {}) }
  }

  saveModelProfile(input: any, encryptedKey?: Buffer): string {
    const id = input.id ?? randomUUID()
    const existing = this.db.prepare('SELECT encrypted_key FROM model_profiles WHERE id=?').get(id) as any
    const key = encryptedKey ?? existing?.encrypted_key
    const timestamp = now()
    const transaction = this.db.transaction(() => {
      if (input.isDefault) this.db.prepare('UPDATE model_profiles SET is_default=0').run()
      this.db.prepare(`INSERT INTO model_profiles(id,name,provider,model_id,encrypted_key,is_default,capabilities_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,
        model_id=excluded.model_id,encrypted_key=excluded.encrypted_key,is_default=excluded.is_default,
        capabilities_json=excluded.capabilities_json,updated_at=excluded.updated_at`)
        .run(id, input.name, input.provider, input.modelId, key ?? null, input.isDefault ? 1 : 0, json(input.capabilities ?? {}), timestamp, timestamp)
    })
    transaction()
    return id
  }

  deleteModelProfile(id: string): void { this.db.prepare('DELETE FROM model_profiles WHERE id=?').run(id) }
  setModelEncryptedKey(id: string, encryptedKey: Buffer | null): void { this.db.prepare('UPDATE model_profiles SET encrypted_key=?,updated_at=? WHERE id=?').run(encryptedKey, now(), id) }
  setDefaultModelProfile(id: string): void { this.db.transaction(() => { this.db.prepare('UPDATE model_profiles SET is_default=0').run(); this.db.prepare('UPDATE model_profiles SET is_default=1 WHERE id=?').run(id) })() }

  listWorkspaces(): any[] { return this.db.prepare('SELECT * FROM workspaces ORDER BY updated_at DESC').all() as any[] }
  getWorkspace(id?: string | null): any | undefined { return id ? this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id) : undefined }
  addWorkspace(rootPath: string, name: string): string {
    const existing = this.db.prepare('SELECT id FROM workspaces WHERE root_path=?').get(rootPath) as any
    if (existing) return existing.id
    const id = randomUUID(); const timestamp = now()
    this.db.prepare('INSERT INTO workspaces(id,name,root_path,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, name, rootPath, timestamp, timestamp)
    return id
  }
  updateWorkspaceRules(id: string, rules: string): void { this.db.prepare('UPDATE workspaces SET rules=?,updated_at=? WHERE id=?').run(rules, now(), id) }
  removeWorkspace(id: string): void { this.db.prepare('DELETE FROM workspaces WHERE id=?').run(id) }

  createRun(input: any): any {
    const id = randomUUID(); const timestamp = now()
    this.db.prepare(`INSERT INTO runs(id,title,prompt,status,mode,read_only,access_mode,workspace_id,model_profile_id,model_snapshot_json,limits_json,parent_run_id,goal,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.title || input.prompt.slice(0, 48), input.prompt, 'understanding', input.mode ?? 'act', input.readOnly ? 1 : 0, input.accessMode ?? 'approval', input.workspaceId ?? null, input.modelProfileId ?? null, json(input.modelSnapshot ?? {}), json(input.limits ?? {}), input.parentRunId ?? null, input.prompt, timestamp, timestamp)
    this.addMessage(id, 'user', input.prompt)
    this.appendRunEvent(id, 'run.created', '任务已创建', { mode: input.mode ?? 'act', accessMode: input.accessMode ?? 'approval' })
    return this.getRun(id)
  }

  getRun(id: string): any | undefined {
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as any
    if (!run) return undefined
    return this.hydrateRun(run)
  }

  listRuns(limit = 100): any[] { return (this.db.prepare('SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?').all(limit) as any[]).map((r) => this.hydrateRun(r)) }
  deleteRun(id: string): void { this.db.prepare('DELETE FROM runs WHERE id=?').run(id) }

  private hydrateRun(run: any): any {
    return {
      ...run,
      workspaceId: run.workspace_id,
      modelProfileId: run.model_profile_id,
      modelSnapshot: parse(run.model_snapshot_json, {}),
      limits: parse(run.limits_json, {}),
      modelTurns: run.model_turns ?? 0,
      activeDurationMs: run.active_duration_ms ?? 0,
      activeSegmentStartedAt: run.active_segment_started_at ?? undefined,
      parentRunId: run.parent_run_id,
      readOnly: Boolean(run.read_only),
      accessMode: run.access_mode === 'full_disk' ? 'full_disk' : 'approval',
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      messages: this.db.prepare('SELECT id,role,content,metadata_json,created_at FROM messages WHERE run_id=? ORDER BY created_at').all(run.id).map((m: any) => ({ ...m, metadata: parse(m.metadata_json, {}), createdAt: m.created_at })),
      steps: this.db.prepare('SELECT * FROM task_steps WHERE run_id=? ORDER BY ordinal').all(run.id).map((s: any) => {
        const evidence = parse<string[]>(s.evidence_json, [])
        return {
          ...s,
          evidence,
          ...(evidence.length > 0 ? { verification: evidence.join('\n') } : {}),
          createdAt: s.created_at,
          updatedAt: s.updated_at,
        }
      }),
      events: this.db.prepare('SELECT * FROM run_events WHERE run_id=? ORDER BY id DESC LIMIT 200').all(run.id).reverse().map((e: any) => ({ ...e, payload: parse(e.payload_json, {}), createdAt: e.created_at })),
      toolCalls: this.db.prepare(`SELECT id,provider_call_id,run_id,tool_id,state,risk,arguments_json,result_json,error,created_at,updated_at
        FROM tool_calls WHERE run_id=? ORDER BY created_at DESC LIMIT 200`).all(run.id).map((call: any) => ({
          ...call,
          arguments: parse(call.arguments_json, {}),
          result: parse(call.result_json, null),
          createdAt: call.created_at,
          updatedAt: call.updated_at,
        })).reverse(),
      artifacts: this.db.prepare('SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at DESC').all(run.id).map((a: any) => ({ ...a, metadata: parse(a.metadata_json, {}), createdAt: a.created_at })),
      approvals: this.db.prepare("SELECT * FROM approvals WHERE run_id=? AND status='pending' ORDER BY created_at").all(run.id).map((a: any) => ({ ...a, preview: parse(a.preview_json, {}), createdAt: a.created_at })),
      approvalHistory: this.db.prepare('SELECT * FROM approvals WHERE run_id=? ORDER BY created_at DESC LIMIT 200').all(run.id).map((approval: any) => ({
        ...approval,
        preview: parse(approval.preview_json, {}),
        decision: parse(approval.decision_json, null),
        createdAt: approval.created_at,
        resolvedAt: approval.resolved_at ?? undefined,
      })).reverse(),
    }
  }

  updateRun(id: string, patch: any): void {
    const fields: [string, unknown][] = []
    const map: Record<string, string> = { status: 'status', outcome: 'outcome', summary: 'summary', error: 'error', title: 'title', goal: 'goal', accessMode: 'access_mode', startedAt: 'started_at', finishedAt: 'finished_at', modelTurns: 'model_turns' }
    for (const [key, column] of Object.entries(map)) if (key in patch) fields.push([column, patch[key]])
    if (!fields.length) return
    fields.push(['updated_at', now()])
    this.db.prepare(`UPDATE runs SET ${fields.map(([column]) => `${column}=?`).join(',')} WHERE id=?`).run(...fields.map(([, value]) => value ?? null), id)
  }

  downgradeDescendantAccess(runId: string): { runIds: string[]; activeRunIds: string[] } {
    const rows = this.db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM runs WHERE parent_run_id=?
        UNION ALL
        SELECT child.id FROM runs child JOIN descendants parent ON child.parent_run_id=parent.id
      )
      SELECT runs.id,runs.status FROM runs
      JOIN descendants ON descendants.id=runs.id
      WHERE runs.access_mode='full_disk'
    `).all(runId) as Array<{ id: string; status: string }>
    if (!rows.length) return { runIds: [], activeRunIds: [] }

    const timestamp = now()
    this.db.transaction(() => {
      const update = this.db.prepare("UPDATE runs SET access_mode='approval',updated_at=? WHERE id=? AND access_mode='full_disk'")
      for (const row of rows) update.run(timestamp, row.id)
    })()
    const activeRunIds = rows
      .filter((row) => ['planning', 'running', 'verifying', 'waiting_approval'].includes(row.status))
      .map((row) => row.id)
    return { runIds: rows.map((row) => row.id), activeRunIds }
  }

  /**
   * Production lifecycle boundary. Ordinary transitions follow the shared
   * state machine. A terminal run may reopen only through an explicit new-turn
   * transition to `understanding`; callers cannot accidentally revive it by
   * writing `running` directly.
   */
  transitionRun(
    id: string,
    status: RunStatus,
    patch: Record<string, unknown> = {},
    options: { allowTerminalReopen?: boolean } = {},
  ): any {
    this.db.transaction(() => {
      const current = this.db.prepare('SELECT status FROM runs WHERE id=?').get(id) as { status?: RunStatus } | undefined
      if (!current?.status) throw new Error('任务不存在')
      const explicitReopen = options.allowTerminalReopen === true
        && isTerminalRunStatus(current.status)
        && status === 'understanding'
      if (!explicitReopen) assertRunTransition(current.status, status)
      this.updateRun(id, { ...patch, status })
    })()
    return this.getRun(id)
  }

  markRunTurnStarted(runId: string, reason: 'initial' | 'follow_up'): { turnId: string; startedAt: string } {
    const turnId = randomUUID()
    const startedAt = now()
    this.db.prepare('INSERT INTO run_events(run_id,type,level,summary,payload_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(runId, 'run.turn_started', 'info', reason === 'initial' ? '任务首轮开始' : '新一轮对话开始', json({ turnId, reason, startedAt }), startedAt)
    this.db.prepare('UPDATE runs SET updated_at=? WHERE id=?').run(startedAt, runId)
    return { turnId, startedAt }
  }

  getCurrentRunTurnStartedAt(runId: string): string | undefined {
    const row = this.db.prepare("SELECT created_at FROM run_events WHERE run_id=? AND type='run.turn_started' ORDER BY id DESC LIMIT 1")
      .get(runId) as { created_at?: string } | undefined
    return row?.created_at
  }

  getRunBudgetUsage(id: string, at: Date = new Date()): { modelTurns: number; activeDurationMs: number; active: boolean } {
    const row = this.db.prepare('SELECT model_turns,active_duration_ms,active_segment_started_at FROM runs WHERE id=?').get(id) as any
    if (!row) throw new Error('任务不存在')
    const segmentStartedAt = typeof row.active_segment_started_at === 'string' ? Date.parse(row.active_segment_started_at) : Number.NaN
    const segmentMs = Number.isFinite(segmentStartedAt) ? Math.max(0, at.getTime() - segmentStartedAt) : 0
    return {
      modelTurns: Math.max(0, Number(row.model_turns ?? 0)),
      activeDurationMs: Math.max(0, Number(row.active_duration_ms ?? 0)) + segmentMs,
      active: Number.isFinite(segmentStartedAt),
    }
  }

  beginRunExecution(id: string, at: Date = new Date()): { modelTurns: number; activeDurationMs: number; active: boolean } {
    const timestamp = at.toISOString()
    this.db.prepare('UPDATE runs SET active_segment_started_at=COALESCE(active_segment_started_at,?),updated_at=? WHERE id=?')
      .run(timestamp, timestamp, id)
    return this.getRunBudgetUsage(id, at)
  }

  stopRunExecution(id: string, at: Date = new Date()): { modelTurns: number; activeDurationMs: number; active: boolean } {
    const timestamp = at.toISOString()
    this.db.transaction(() => {
      const usage = this.getRunBudgetUsage(id, at)
      this.db.prepare('UPDATE runs SET active_duration_ms=?,active_segment_started_at=NULL,updated_at=? WHERE id=?')
        .run(usage.activeDurationMs, timestamp, id)
    })()
    return this.getRunBudgetUsage(id, at)
  }

  incrementRunModelTurns(id: string, count = 1): number {
    if (!Number.isInteger(count) || count <= 0) throw new RangeError('count must be a positive integer')
    const result = this.db.prepare('UPDATE runs SET model_turns=model_turns+?,updated_at=? WHERE id=?').run(count, now(), id)
    if (result.changes !== 1) throw new Error('任务不存在')
    return Number((this.db.prepare('SELECT model_turns FROM runs WHERE id=?').get(id) as any).model_turns)
  }

  addMessage(runId: string, role: string, content: string, metadata: Json = {}): string {
    const id = randomUUID()
    this.db.prepare('INSERT INTO messages(id,run_id,role,content,metadata_json,created_at) VALUES(?,?,?,?,?,?)').run(id, runId, role, content, json(metadata), now())
    this.db.prepare('UPDATE runs SET updated_at=? WHERE id=?').run(now(), runId)
    return id
  }

  messageBelongsToRun(messageId: string, runId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM messages WHERE id=? AND run_id=?').get(messageId, runId))
  }

  replaceSteps(runId: string, steps: Array<{ title: string; status?: string }>): any[] {
    const created: any[] = []
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_steps WHERE run_id=?').run(runId)
      const statement = this.db.prepare('INSERT INTO task_steps(id,run_id,title,status,ordinal,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      steps.forEach((step, index) => {
        const id = randomUUID()
        const timestamp = now()
        const status = step.status ?? 'pending'
        statement.run(id, runId, step.title, status, index, timestamp, timestamp)
        created.push({ id, runId, title: step.title, status, ordinal: index, createdAt: timestamp, updatedAt: timestamp })
      })
    })()
    return created
  }

  updateTaskStep(runId: string, stepId: string, patch: { status: TaskStepStatus; evidence?: string }): any {
    const current = this.db.prepare('SELECT * FROM task_steps WHERE id=? AND run_id=?').get(stepId, runId) as any
    if (!current) throw Object.assign(new Error('计划步骤不存在'), { code: 'TASK_STEP_NOT_FOUND' })
    assertStepTransition(current.status as TaskStepStatus, patch.status)
    const existing = parse<string[]>(current.evidence_json, [])
    const submitted = patch.evidence?.trim()
    const evidence = submitted && !existing.includes(submitted) ? [...existing, submitted] : existing
    if (patch.status === 'completed' && evidence.length === 0) {
      throw Object.assign(new Error('完成计划步骤时必须提供可观察证据'), { code: 'TASK_STEP_EVIDENCE_REQUIRED' })
    }
    const timestamp = now()
    this.db.prepare('UPDATE task_steps SET status=?,evidence_json=?,updated_at=? WHERE id=? AND run_id=?')
      .run(patch.status, json(evidence), timestamp, stepId, runId)
    return {
      id: current.id,
      runId,
      title: current.title,
      ordinal: current.ordinal,
      status: patch.status,
      ...(evidence.length > 0 ? { verification: evidence.join('\n') } : {}),
      createdAt: current.created_at,
      updatedAt: timestamp,
    }
  }

  appendRunEvent(runId: string, type: string, summary: string, payload: Json = {}, level = 'info'): void {
    this.db.prepare('INSERT INTO run_events(run_id,type,level,summary,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(runId, type, level, summary, json(payload), now())
    this.db.prepare('UPDATE runs SET updated_at=? WHERE id=?').run(now(), runId)
  }

  createToolCall(input: any): string {
    const run = this.db.prepare('SELECT read_only FROM runs WHERE id=?').get(input.runId) as { read_only: number } | undefined
    if (run?.read_only && input.risk !== 'readonly') {
      this.audit('security', 'readonly_tool_blocked', `只读子任务拒绝执行 ${String(input.toolId)}`, {
        actor: 'system', outcome: 'blocked', riskLevel: input.risk, target: String(input.toolId),
      }, input.runId)
      throw new Error('只读子任务只能调用只读工具')
    }
    // `id` is an application-owned receipt identity. Never use a provider's
    // toolCallId here: it is not globally unique and may be repeated after a
    // retry or when a conversation resumes.
    const id = input.id ?? randomUUID(); const timestamp = now()
    const providerCallId = input.providerCallId ?? id
    this.db.prepare('INSERT INTO tool_calls(id,provider_call_id,run_id,tool_id,state,risk,arguments_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, providerCallId, input.runId, input.toolId, input.state ?? 'requested', input.risk, json(input.arguments), timestamp, timestamp)
    return id
  }
  updateToolCall(id: string, state: string, result?: Json, error?: string): void {
    const current = this.db.prepare('SELECT state FROM tool_calls WHERE id=?').get(id) as { state?: string } | undefined
    // Cancellation is a durable recovery verdict. A late promise resolution
    // from a disconnected/crashed worker must not turn an unknown outcome into
    // a misleading success or ordinary failure.
    if (current?.state === 'cancelled' && state !== 'cancelled') return
    this.db.prepare('UPDATE tool_calls SET state=?,result_json=?,error=?,updated_at=? WHERE id=?').run(state, result === undefined ? null : json(result), error ?? null, now(), id)
  }
  createApproval(input: any): any {
    const id = input.id ?? randomUUID(); const timestamp = now()
    this.db.prepare('INSERT INTO approvals(id,run_id,tool_call_id,reason,preview_json,created_at) VALUES(?,?,?,?,?,?)').run(id, input.runId, input.toolCallId, input.reason, json(input.preview), timestamp)
    return { id, ...input, status: 'pending', createdAt: timestamp }
  }
  resolveApproval(id: string, decision: any): any {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as any
    if (!row) throw new Error('审批不存在')
    if (row.status !== 'pending') throw new Error('审批已处理')
    this.db.prepare('UPDATE approvals SET status=?,scope=?,decision_json=?,resolved_at=? WHERE id=?').run(decision.decision === 'reject' || decision.decision === 'deny' ? 'denied' : 'approved', decision.scope ?? 'once', json(decision), now(), id)
    return { ...row, preview: parse(row.preview_json, {}), decision }
  }
  getApproval(id: string): any | undefined { const row = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as any; return row ? { ...row, preview: parse(row.preview_json, {}), decision: parse(row.decision_json, null) } : undefined }
  hasRunGrant(runId: string, toolId: string, argumentsValue: Json = {}): boolean {
    const rows = this.db.prepare(`SELECT scope,constraints_json FROM approval_grants WHERE tool_id=? AND (run_id=? OR (run_id IS NULL AND scope='persistent_rule')) AND (expires_at IS NULL OR expires_at>?)`).all(toolId, runId, now()) as Array<{ scope: string; constraints_json: string }>
    const requested = canonicalJson(argumentsValue)
    const run = this.db.prepare('SELECT workspace_id FROM runs WHERE id=?').get(runId) as { workspace_id?: string } | undefined
    const persistentRequest = argumentsValue && !Array.isArray(argumentsValue) && typeof argumentsValue === 'object'
      ? { ...(argumentsValue as Record<string, unknown>), $workspaceId: run?.workspace_id }
      : argumentsValue
    return rows.some((row) => {
      const constraints = parse<Json>(row.constraints_json, {})
      // Task grants remain argument-exact. Persistent rules are intentionally
      // narrower: Settings only creates a tool + exact path subset constraint.
      return row.scope === 'persistent_rule'
        ? Boolean(run?.workspace_id) && isConstraintMatch(constraints, persistentRequest)
        : canonicalJson(constraints) === requested
    })
  }
  addGrant(runId: string | null, toolId: string, scope: string, constraints: Json = {}): void {
    this.db.prepare('INSERT INTO approval_grants(id,run_id,tool_id,scope,constraints_json,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), runId, toolId, scope, json(constraints), now())
  }
  listPersistentGrants(): any[] {
    return (this.db.prepare(`SELECT * FROM approval_grants WHERE run_id IS NULL AND scope='persistent_rule' ORDER BY created_at DESC`).all() as any[])
      .map((row) => {
        const constraints = parse<Record<string, unknown>>(row.constraints_json, {})
        return { id: row.id, toolName: row.tool_id, scope: row.scope, approvedArguments: { path: constraints.path, workspaceId: constraints.$workspaceId }, createdAt: row.created_at, ...(row.expires_at ? { expiresAt: row.expires_at } : {}) }
      })
  }
  addPersistentGrant(workspaceId: string, toolId: 'file.write' | 'file.edit', path: string, expiresAt?: string): any {
    if (!this.getWorkspace(workspaceId)) throw new Error('工作区不存在')
    const id = randomUUID(); const createdAt = now()
    this.db.prepare('INSERT INTO approval_grants(id,run_id,tool_id,scope,constraints_json,created_at,expires_at) VALUES(?,NULL,?,?,?,?,?)')
      .run(id, toolId, 'persistent_rule', json({ $workspaceId: workspaceId, path }), createdAt, expiresAt ?? null)
    return { id, toolName: toolId, scope: 'persistent_rule', approvedArguments: { workspaceId, path }, createdAt, ...(expiresAt ? { expiresAt } : {}) }
  }
  removePersistentGrant(id: string): void {
    const result = this.db.prepare(`DELETE FROM approval_grants WHERE id=? AND run_id IS NULL AND scope='persistent_rule'`).run(id)
    if (result.changes !== 1) throw new Error('永久授权不存在')
  }

  listMemory(): any[] { return (this.db.prepare('SELECT * FROM memory_entries ORDER BY updated_at DESC').all() as any[]).map((m) => ({ ...m, source: parse(m.source_json, []), workspaceId: m.workspace_id, createdAt: m.created_at, updatedAt: m.updated_at })) }
  getMemory(id: string): any | undefined { const m = this.db.prepare('SELECT * FROM memory_entries WHERE id=?').get(id) as any; return m ? { ...m, source: parse(m.source_json, []), workspaceId: m.workspace_id, createdAt: m.created_at, updatedAt: m.updated_at } : undefined }
  saveMemory(input: any): string {
    const id = input.id ?? randomUUID(); const timestamp = now()
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO memory_entries(id,scope,workspace_id,kind,content,status,confidence,source_json,created_at,updated_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,status=excluded.status,confidence=excluded.confidence,source_json=excluded.source_json,updated_at=excluded.updated_at,expires_at=excluded.expires_at`)
        .run(id, input.scope ?? 'user', input.workspaceId ?? null, input.kind ?? 'fact', input.content, input.status ?? 'proposed', input.confidence ?? 0.7, json(input.source ?? []), timestamp, timestamp, input.expiresAt ?? null)
      this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id)
      if ((input.status ?? 'proposed') === 'confirmed') this.db.prepare('INSERT INTO memory_fts(id,content) VALUES(?,?)').run(id, input.content)
    })()
    return id
  }
  updateMemoryStatus(id: string, status: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE memory_entries SET status=?,updated_at=? WHERE id=?').run(status, now(), id)
      const row = this.db.prepare('SELECT content FROM memory_entries WHERE id=?').get(id) as any
      this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id)
      if (status === 'confirmed' && row) this.db.prepare('INSERT INTO memory_fts(id,content) VALUES(?,?)').run(id, row.content)
    })()
  }
  deleteMemory(id: string): void { this.db.transaction(() => { this.db.prepare('DELETE FROM memory_entries WHERE id=?').run(id); this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id) })() }
  searchMemory(query: string, workspaceId?: string): any[] {
    if (!query.trim()) return this.listMemory().filter((m) => m.status === 'confirmed' && (!m.workspace_id || m.workspace_id === workspaceId)).slice(0, 12)
    try {
      return this.db.prepare(`SELECT m.* FROM memory_fts f JOIN memory_entries m ON m.id=f.id WHERE memory_fts MATCH ? AND m.status='confirmed' AND (m.workspace_id IS NULL OR m.workspace_id=?) ORDER BY bm25(memory_fts) LIMIT 12`).all(query.replace(/["']/g, ' '), workspaceId ?? '') as any[]
    } catch { return [] }
  }

  listMcpServers(): any[] { return (this.db.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as any[]).map(({ encrypted_secret: _secret, ...m }) => ({ ...m, config: parse(m.config_json, {}), enabled: Boolean(m.enabled), hasSecret: Boolean(_secret), createdAt: m.created_at, updatedAt: m.updated_at })) }
  getMcpServer(id: string): any { const m = this.db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id) as any; return m ? { ...m, config: parse(m.config_json, {}) } : undefined }
  saveMcpServer(input: any, encryptedSecret?: Buffer): string {
    const id = input.id ?? randomUUID(); const timestamp = now()
    const existing = this.db.prepare('SELECT encrypted_secret FROM mcp_servers WHERE id=?').get(id) as any
    this.db.prepare(`INSERT INTO mcp_servers(id,name,transport,config_json,encrypted_secret,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,transport=excluded.transport,config_json=excluded.config_json,encrypted_secret=excluded.encrypted_secret,enabled=excluded.enabled,updated_at=excluded.updated_at`)
      .run(id, input.name, input.transport, json(input.config), encryptedSecret ?? existing?.encrypted_secret ?? null, input.enabled === false ? 0 : 1, timestamp, timestamp)
    return id
  }
  setMcpEncryptedSecret(id: string, encryptedSecret: Buffer | null): void {
    const result = this.db.prepare('UPDATE mcp_servers SET encrypted_secret=?,updated_at=? WHERE id=?').run(encryptedSecret, now(), id)
    if (result.changes !== 1) throw new Error('MCP Server 不存在')
  }
  updateMcpHealth(id: string, health: string, lastError?: string, fingerprint?: string, serverVersion?: string): void {
    const timestamp = now()
    this.db.prepare('UPDATE mcp_servers SET health=?,last_error=?,schema_fingerprint=COALESCE(?,schema_fingerprint),server_version=COALESCE(?,server_version),last_checked_at=?,updated_at=? WHERE id=?')
      .run(health, lastError ?? null, fingerprint ?? null, serverVersion ?? null, timestamp, timestamp, id)
  }
  removeMcpServer(id: string): void { this.db.prepare('DELETE FROM mcp_servers WHERE id=?').run(id) }

  listSkills(): any[] { return (this.db.prepare('SELECT * FROM skills ORDER BY name').all() as any[]).map((s) => ({ ...s, permissions: parse(s.permissions_json, []), enabled: Boolean(s.enabled), createdAt: s.created_at, updatedAt: s.updated_at })) }
  getSkill(id: string): any | undefined { const s = this.db.prepare('SELECT * FROM skills WHERE id=?').get(id) as any; return s ? { ...s, permissions: parse(s.permissions_json, []), enabled: Boolean(s.enabled), createdAt: s.created_at, updatedAt: s.updated_at } : undefined }
  setSkillEnabled(id: string, enabled: boolean): void { this.db.prepare('UPDATE skills SET enabled=?,updated_at=? WHERE id=?').run(enabled ? 1 : 0, now(), id) }
  removeSkill(id: string): void { this.db.prepare('DELETE FROM skills WHERE id=?').run(id) }
  upsertSkill(input: any): string {
    const id = input.id ?? randomUUID(); const timestamp = now()
    this.db.prepare(`INSERT INTO skills(id,name,description,version,scope,path,permissions_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET name=excluded.name,description=excluded.description,version=excluded.version,scope=excluded.scope,permissions_json=excluded.permissions_json,enabled=excluded.enabled,updated_at=excluded.updated_at`)
      .run(id, input.name, input.description, input.version ?? '1.0.0', input.scope ?? 'user', input.path, json(input.permissions ?? []), input.enabled === false ? 0 : 1, timestamp, timestamp)
    return id
  }

  listAutomations(): any[] { return (this.db.prepare('SELECT * FROM automations ORDER BY updated_at DESC').all() as any[]).map((a) => ({ ...a, scheduleType: a.schedule_type, scheduleValue: a.schedule_value, workspaceId: a.workspace_id, modelProfileId: a.model_profile_id, enabled: Boolean(a.enabled), nextRunAt: a.next_run_at, lastRunAt: a.last_run_at, createdAt: a.created_at, updatedAt: a.updated_at })) }
  getAutomation(id: string): any | undefined { const a = this.db.prepare('SELECT * FROM automations WHERE id=?').get(id) as any; return a ? { ...a, scheduleType: a.schedule_type, scheduleValue: a.schedule_value, workspaceId: a.workspace_id, modelProfileId: a.model_profile_id, enabled: Boolean(a.enabled), nextRunAt: a.next_run_at, lastRunAt: a.last_run_at, createdAt: a.created_at, updatedAt: a.updated_at } : undefined }
  saveAutomation(input: any): string {
    const id = input.id ?? randomUUID(); const timestamp = now()
    this.db.prepare(`INSERT INTO automations(id,name,prompt,schedule_type,schedule_value,timezone,workspace_id,model_profile_id,enabled,next_run_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,prompt=excluded.prompt,schedule_type=excluded.schedule_type,schedule_value=excluded.schedule_value,timezone=excluded.timezone,workspace_id=excluded.workspace_id,model_profile_id=excluded.model_profile_id,enabled=excluded.enabled,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at`)
      .run(id, input.name, input.prompt, input.scheduleType, input.scheduleValue, input.timezone, input.workspaceId ?? null, input.modelProfileId ?? null, input.enabled === false ? 0 : 1, input.nextRunAt ?? null, timestamp, timestamp)
    return id
  }
  toggleAutomation(id: string, enabled: boolean): void { this.db.prepare('UPDATE automations SET enabled=?,updated_at=? WHERE id=?').run(enabled ? 1 : 0, now(), id) }
  removeAutomation(id: string): void { this.db.prepare('DELETE FROM automations WHERE id=?').run(id) }
  markAutomationRun(id: string, nextRunAt: string | null): void { this.db.prepare('UPDATE automations SET last_run_at=?,next_run_at=?,updated_at=? WHERE id=?').run(now(), nextRunAt, now(), id) }

  addChromeGrant(input: any): string {
    const id = randomUUID()
    this.db.prepare('INSERT INTO chrome_grants(id,run_id,tab_id,window_id,url,title,parent_tab_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, input.runId, input.tabId, input.windowId ?? null, input.url ?? null, input.title ?? null, input.parentTabId ?? null, now())
    return id
  }
  listChromeGrants(runId: string): any[] { return this.db.prepare('SELECT * FROM chrome_grants WHERE run_id=? ORDER BY created_at').all(runId) as any[] }
  listAllChromeGrants(): any[] { return this.db.prepare('SELECT * FROM chrome_grants ORDER BY created_at DESC').all() as any[] }
  removeChromeGrant(id: string): void { this.db.prepare('DELETE FROM chrome_grants WHERE id=?').run(id) }

  addArtifact(input: any): string {
    const id = input.id ?? randomUUID()
    this.db.prepare('INSERT INTO artifacts(id,run_id,kind,name,path,sha256,mime,size,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.runId ?? null, input.kind, input.name, input.path, input.sha256, input.mime, input.size, json(input.metadata ?? {}), now())
    return id
  }
  listArtifacts(runId?: string): any[] { return runId ? this.db.prepare('SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at DESC').all(runId) as any[] : this.db.prepare('SELECT * FROM artifacts ORDER BY created_at DESC LIMIT 200').all() as any[] }
  getArtifact(id: string): any | undefined { return this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as any }
  attachArtifactsToRun(runId: string, artifactIds: string[]): void {
    if (!artifactIds.length) return
    this.db.transaction(() => {
      const statement = this.db.prepare("UPDATE artifacts SET run_id=? WHERE id=? AND kind='attachment' AND (run_id IS NULL OR run_id=?)")
      for (const id of artifactIds) {
        const result = statement.run(runId, id, runId)
        if (result.changes !== 1) throw new Error(`附件不存在或已属于其他任务：${id}`)
      }
    })()
  }
  setInitialMessageArtifacts(runId: string, artifactIds: string[]): void {
    const message = this.db.prepare("SELECT id,metadata_json FROM messages WHERE run_id=? AND role='user' ORDER BY created_at LIMIT 1").get(runId) as any
    if (!message) return
    const metadata = parse<Record<string, unknown>>(message.metadata_json, {})
    this.db.prepare('UPDATE messages SET metadata_json=? WHERE id=?').run(json({ ...metadata, artifactIds }), message.id)
  }

  audit(category: string, action: string, summary: string, payload: Json = {}, runId?: string): void {
    this.db.prepare('INSERT INTO audit_events(category,action,run_id,summary,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(category, action, runId ?? null, summary, json(payload), now())
  }
  listAudit(limit = 5000): any[] { return (this.db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?').all(limit) as any[]).map((a) => ({ ...a, payload: parse(a.payload_json, {}), createdAt: a.created_at })) }

  listRecentToolReceipts(runId: string, limit = 40): any[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
    return (this.db.prepare(`SELECT tool_id,state,risk,arguments_json,(result_json IS NOT NULL) AS has_result,created_at
      FROM tool_calls WHERE run_id=? ORDER BY created_at DESC LIMIT ?`).all(runId, safeLimit) as any[])
      .map((row) => ({
        toolId: row.tool_id,
        state: row.state,
        risk: row.risk,
        arguments: parse(row.arguments_json, {}),
        hasResult: Boolean(row.has_result),
        createdAt: row.created_at,
      }))
  }

  cancelPendingRunWork(runId: string, reason: string): { expiredApprovals: number; cancelledToolCalls: number } {
    const timestamp = now()
    return this.db.transaction(() => {
      const expiredApprovals = this.db.prepare(`UPDATE approvals SET status='expired',decision_json=?,resolved_at=?
        WHERE run_id=? AND status='pending'`).run(json({ decision: 'reject', reason }), timestamp, runId).changes
      const cancelledToolCalls = this.db.prepare(`UPDATE tool_calls SET state='cancelled',error=?,updated_at=?
        WHERE run_id=? AND state IN ('requested','running','waiting_approval')`).run(reason, timestamp, runId).changes
      return { expiredApprovals, cancelledToolCalls }
    })()
  }

  hasPendingApprovals(runId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM approvals WHERE run_id=? AND status='pending' LIMIT 1").get(runId))
  }

  pauseChromeRunsForDisconnect(reason = 'Chrome Bridge 已断开，请重新连接后继续'): {
    runIds: string[]
    expiredApprovals: number
    cancelledToolCalls: number
  } {
    const activeStatuses = ['understanding', 'planning', 'running', 'verifying', 'waiting_approval']
    const timestamp = now()
    return this.db.transaction(() => {
      const statusPlaceholders = activeStatuses.map(() => '?').join(',')
      const rows = this.db.prepare(`SELECT DISTINCT r.id FROM runs r
        INNER JOIN chrome_grants g ON g.run_id=r.id
        WHERE r.status IN (${statusPlaceholders}) ORDER BY r.created_at`).all(...activeStatuses) as Array<{ id: string }>
      const runIds = rows.map((row) => row.id)
      if (!runIds.length) return { runIds, expiredApprovals: 0, cancelledToolCalls: 0 }
      for (const runId of runIds) this.stopRunExecution(runId, new Date(timestamp))
      const runPlaceholders = runIds.map(() => '?').join(',')
      this.db.prepare(`UPDATE runs SET status='waiting_user',outcome=NULL,finished_at=NULL,updated_at=? WHERE id IN (${runPlaceholders})`).run(timestamp, ...runIds)
      const expiredApprovals = this.db.prepare(`UPDATE approvals SET status='expired',decision_json=?,resolved_at=?
        WHERE status='pending' AND run_id IN (${runPlaceholders})`).run(json({ decision: 'reject', reason }), timestamp, ...runIds).changes
      const cancelledToolCalls = this.db.prepare(`UPDATE tool_calls SET state='cancelled',error=?,updated_at=?
        WHERE state IN ('running','waiting_approval') AND run_id IN (${runPlaceholders})`).run(reason, timestamp, ...runIds).changes
      const event = this.db.prepare(`INSERT INTO run_events(run_id,type,level,summary,payload_json,created_at) VALUES(?,?,?,?,?,?)`)
      for (const runId of runIds) event.run(runId, 'chrome.disconnected', 'warning', reason, json({ reason }), timestamp)
      this.db.prepare(`INSERT INTO audit_events(category,action,run_id,summary,payload_json,created_at) VALUES(?,?,?,?,?,?)`)
        .run('chrome', 'pause_on_disconnect', null, reason, json({ actor: 'system', outcome: 'succeeded', runIds, expiredApprovals, cancelledToolCalls }), timestamp)
      return { runIds, expiredApprovals, cancelledToolCalls }
    })()
  }

  pruneDetailedLogs(retentionDays: number, maxBytes: number): {
    runEvents: number
    toolCalls: number
    auditEvents: number
    estimatedBytes: number
  } {
    const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 90
    const byteLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.trunc(maxBytes) : 500 * 1024 * 1024
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    return this.db.transaction(() => {
      const deleted = { runEvents: 0, toolCalls: 0, auditEvents: 0 }
      deleted.runEvents += this.db.prepare('DELETE FROM run_events WHERE created_at<?').run(cutoff).changes
      deleted.toolCalls += this.db.prepare("DELETE FROM tool_calls WHERE created_at<? AND state IN ('succeeded','failed','cancelled')").run(cutoff).changes
      deleted.auditEvents += this.db.prepare('DELETE FROM audit_events WHERE created_at<?').run(cutoff).changes

      const estimate = (): number => {
        const row = this.db.prepare(`SELECT
          COALESCE((SELECT SUM(length(CAST(type AS BLOB))+length(CAST(summary AS BLOB))+length(CAST(payload_json AS BLOB))) FROM run_events),0) +
          COALESCE((SELECT SUM(length(CAST(tool_id AS BLOB))+length(CAST(arguments_json AS BLOB))+length(CAST(COALESCE(result_json,'') AS BLOB))+length(CAST(COALESCE(error,'') AS BLOB))) FROM tool_calls),0) +
          COALESCE((SELECT SUM(length(CAST(category AS BLOB))+length(CAST(action AS BLOB))+length(CAST(summary AS BLOB))+length(CAST(payload_json AS BLOB))) FROM audit_events),0)
          AS bytes`).get() as { bytes?: number }
        return Number(row.bytes ?? 0)
      }

      let estimatedBytes = estimate()
      while (estimatedBytes > byteLimit) {
        const candidates = this.db.prepare(`
          SELECT 'run_events' AS source,CAST(id AS TEXT) AS record_id,created_at,
            length(CAST(type AS BLOB))+length(CAST(summary AS BLOB))+length(CAST(payload_json AS BLOB)) AS bytes FROM run_events
          UNION ALL
          SELECT 'tool_calls',id,created_at,
            length(CAST(tool_id AS BLOB))+length(CAST(arguments_json AS BLOB))+length(CAST(COALESCE(result_json,'') AS BLOB))+length(CAST(COALESCE(error,'') AS BLOB)) FROM tool_calls
            WHERE state IN ('succeeded','failed','cancelled')
          UNION ALL
          SELECT 'audit_events',CAST(id AS TEXT),created_at,
            length(CAST(category AS BLOB))+length(CAST(action AS BLOB))+length(CAST(summary AS BLOB))+length(CAST(payload_json AS BLOB)) FROM audit_events
          ORDER BY created_at LIMIT 500`).all() as Array<{ source: string; record_id: string; bytes: number }>
        if (!candidates.length) break
        let removedInBatch = 0
        for (const candidate of candidates) {
          if (estimatedBytes <= byteLimit) break
          if (candidate.source === 'run_events') {
            deleted.runEvents += this.db.prepare('DELETE FROM run_events WHERE id=?').run(Number(candidate.record_id)).changes
          } else if (candidate.source === 'tool_calls') {
            deleted.toolCalls += this.db.prepare('DELETE FROM tool_calls WHERE id=?').run(candidate.record_id).changes
          } else {
            deleted.auditEvents += this.db.prepare('DELETE FROM audit_events WHERE id=?').run(Number(candidate.record_id)).changes
          }
          estimatedBytes = Math.max(0, estimatedBytes - Number(candidate.bytes ?? 0))
          removedInBatch += 1
        }
        if (!removedInBatch) break
      }
      return { ...deleted, estimatedBytes }
    })()
  }

  /**
   * Converts volatile execution state into a durable, resumable checkpoint.
   * The state changes and their audit evidence commit as one SQLite transaction,
   * so the UI never observes a paused run with a still-live approval/tool call.
   */
  recoverInterruptedWork(reason = '应用重启，未完成任务已暂停'): {
    runIds: string[]
    pausedRuns: number
    expiredApprovals: number
    cancelledToolCalls: number
  } {
    const activeStatuses = ['understanding', 'planning', 'running', 'verifying', 'waiting_approval', 'waiting_user']
    const timestamp = now()
    return this.db.transaction(() => {
      const placeholders = activeStatuses.map(() => '?').join(',')
      const rows = this.db.prepare(`SELECT id FROM runs WHERE status IN (${placeholders}) ORDER BY created_at`).all(...activeStatuses) as Array<{ id: string }>
      const runIds = rows.map((row) => row.id)
      for (const runId of runIds) this.stopRunExecution(runId, new Date(timestamp))
      const pausedRuns = this.db.prepare(`UPDATE runs SET status='paused',outcome=NULL,finished_at=NULL,updated_at=? WHERE status IN (${placeholders})`).run(timestamp, ...activeStatuses).changes
      const expiredApprovals = this.db.prepare(`UPDATE approvals SET status='expired',decision_json=?,resolved_at=? WHERE status='pending'`)
        .run(json({ decision: 'reject', reason }), timestamp).changes
      const cancelledToolCalls = this.db.prepare(`UPDATE tool_calls SET state='cancelled',error=?,updated_at=? WHERE state IN ('running','waiting_approval')`)
        .run(reason, timestamp).changes

      if (pausedRuns || expiredApprovals || cancelledToolCalls) {
        const event = this.db.prepare(`INSERT INTO run_events(run_id,type,level,summary,payload_json,created_at) VALUES(?,?,?,?,?,?)`)
        for (const runId of runIds) event.run(runId, 'run.recovered', 'warning', reason, json({ reason }), timestamp)
        this.db.prepare(`INSERT INTO audit_events(category,action,run_id,summary,payload_json,created_at) VALUES(?,?,?,?,?,?)`)
          .run('lifecycle', 'recover_interrupted_work', null, reason, json({
            actor: 'system', outcome: 'succeeded', runIds, pausedRuns, expiredApprovals, cancelledToolCalls,
          }), timestamp)
      }
      return { runIds, pausedRuns, expiredApprovals, cancelledToolCalls }
    })()
  }
}
