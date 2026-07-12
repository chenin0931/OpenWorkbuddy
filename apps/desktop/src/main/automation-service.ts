import { Cron } from 'croner'

import {
  AutomationScheduleSchema,
  type AutomationInput,
  type AutomationSchedule,
  type AutomationSpec,
  type RunDetail,
} from '@onmyworkbuddy/contracts'

import type { AppDatabase } from './database'

const DEFAULT_CHECK_INTERVAL_MS = 20_000
const MIN_CHECK_INTERVAL_MS = 15_000
const MAX_CHECK_INTERVAL_MS = 30_000

interface AutomationRow {
  id: string
  name: string
  prompt: string
  scheduleType: AutomationSchedule['type']
  scheduleValue: string
  timezone: string
  workspaceId: string
  modelProfileId: string
  enabled: boolean
  nextRunAt?: string
  lastRunAt?: string
  createdAt: string
  updatedAt: string
}

export interface AutomationRunRequest {
  automationId: string
  workspaceId: string
  objective: string
  modelProfileId: string
  title: string
}

export type AutomationRunCallback<TResult = RunDetail> = (request: AutomationRunRequest) => Promise<TResult>

export interface AutomationServiceOptions {
  autoStart?: boolean
  checkIntervalMs?: number
  /** A due time older than this is recorded as missed instead of backfilled. */
  misfireGraceMs?: number
  clock?: () => Date
  systemTimezone?: string
  onError?: (error: unknown, automation: AutomationSpec) => void | Promise<void>
}

const validDate = (value: string | Date, label: string): Date => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} 不是有效日期`)
  return date
}

const validateTimezone = (timezone: string): string => {
  const normalized = timezone.trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date())
  } catch {
    throw new Error(`无效时区：${timezone}`)
  }
  return normalized
}

const normalizeCronExpression = (expression: string): string => expression.trim().replace(/\s+/g, ' ')

const normalizeInputSchedule = (schedule: AutomationSchedule): AutomationSchedule => {
  const parsed = AutomationScheduleSchema.parse(schedule)
  if (parsed.type === 'once') {
    return { type: 'once', runAt: validDate(parsed.runAt, 'runAt').toISOString() }
  }
  if (parsed.type === 'interval') {
    const result: AutomationSchedule = { type: 'interval', everyMs: parsed.everyMs }
    if (parsed.startsAt) result.startsAt = validDate(parsed.startsAt, 'startsAt').toISOString()
    return result
  }

  const expression = normalizeCronExpression(parsed.expression)
  const timezone = validateTimezone(parsed.timezone)
  // Croner performs the authoritative syntax and calendar validation.
  new Cron(expression, { paused: true, timezone }).nextRun(new Date())
  return { type: 'cron', expression, timezone }
}

export const normalizeAutomationSchedule = (schedule: AutomationSchedule): string => {
  const normalized = normalizeInputSchedule(schedule)
  if (normalized.type === 'once') return `once:${normalized.runAt}`
  if (normalized.type === 'interval') {
    return `interval:${normalized.everyMs}${normalized.startsAt ? `@${normalized.startsAt}` : ''}`
  }
  return `cron:${normalized.expression}@${normalized.timezone}`
}

/** Returns the first run strictly after `after`; missed occurrences are skipped. */
export const nextRunForSchedule = (
  schedule: AutomationSchedule,
  after: Date,
  intervalAnchor?: Date,
): Date | null => {
  const normalized = normalizeInputSchedule(schedule)
  const reference = validDate(after, 'after')

  if (normalized.type === 'once') {
    const runAt = validDate(normalized.runAt, 'runAt')
    return runAt.getTime() > reference.getTime() ? runAt : null
  }

  if (normalized.type === 'interval') {
    const anchor = normalized.startsAt
      ? validDate(normalized.startsAt, 'startsAt')
      : intervalAnchor
        ? validDate(intervalAnchor, 'intervalAnchor')
        : reference
    if (anchor.getTime() > reference.getTime()) return anchor
    const elapsed = reference.getTime() - anchor.getTime()
    return new Date(anchor.getTime() + (Math.floor(elapsed / normalized.everyMs) + 1) * normalized.everyMs)
  }

  const cron = new Cron(normalized.expression, { paused: true, timezone: normalized.timezone })
  return cron.nextRun(reference)
}

const encodeSchedule = (schedule: AutomationSchedule): { type: AutomationSchedule['type']; value: string; timezone: string } => {
  if (schedule.type === 'once') return { type: 'once', value: schedule.runAt, timezone: '' }
  if (schedule.type === 'interval') return { type: 'interval', value: JSON.stringify(schedule), timezone: '' }
  return { type: 'cron', value: schedule.expression, timezone: schedule.timezone }
}

const decodeSchedule = (row: AutomationRow, systemTimezone: string): AutomationSchedule => {
  if (row.scheduleType === 'once') {
    let runAt = row.scheduleValue
    try {
      const parsed = JSON.parse(row.scheduleValue) as unknown
      if (typeof parsed === 'string') runAt = parsed
      else if (typeof parsed === 'object' && parsed !== null && 'runAt' in parsed && typeof parsed.runAt === 'string') runAt = parsed.runAt
    } catch {
      // Current storage format is the raw ISO timestamp.
    }
    return normalizeInputSchedule({ type: 'once', runAt })
  }

  if (row.scheduleType === 'interval') {
    try {
      const parsed = JSON.parse(row.scheduleValue) as unknown
      if (typeof parsed === 'object' && parsed !== null && 'everyMs' in parsed) {
        const everyMs = Number(parsed.everyMs)
        const startsAt = 'startsAt' in parsed && typeof parsed.startsAt === 'string' ? parsed.startsAt : undefined
        return normalizeInputSchedule({
          type: 'interval',
          everyMs,
          ...(startsAt ? { startsAt } : {}),
        })
      }
    } catch {
      // Legacy rows stored the interval as a numeric string.
    }
    return normalizeInputSchedule({ type: 'interval', everyMs: Number(row.scheduleValue) })
  }

  return normalizeInputSchedule({
    type: 'cron',
    expression: row.scheduleValue,
    timezone: row.timezone || systemTimezone,
  })
}

const toRow = (value: Record<string, unknown>): AutomationRow => ({
  id: String(value.id),
  name: String(value.name),
  prompt: String(value.prompt),
  scheduleType: String(value.scheduleType) as AutomationSchedule['type'],
  scheduleValue: String(value.scheduleValue),
  timezone: String(value.timezone ?? ''),
  workspaceId: String(value.workspaceId),
  modelProfileId: String(value.modelProfileId),
  enabled: Boolean(value.enabled),
  ...(typeof value.nextRunAt === 'string' ? { nextRunAt: value.nextRunAt } : {}),
  ...(typeof value.lastRunAt === 'string' ? { lastRunAt: value.lastRunAt } : {}),
  createdAt: String(value.createdAt),
  updatedAt: String(value.updatedAt),
})

export class AutomationService<TResult = RunDetail> {
  readonly checkIntervalMs: number
  readonly misfireGraceMs: number
  readonly systemTimezone: string

  private readonly clock: () => Date
  private readonly onError?: AutomationServiceOptions['onError']
  private timer: NodeJS.Timeout | undefined
  private tickInFlight: Promise<number> | undefined
  private readonly running = new Set<string>()

  constructor(
    private readonly database: AppDatabase,
    private readonly runCallback: AutomationRunCallback<TResult>,
    options: AutomationServiceOptions = {},
  ) {
    const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
    if (checkIntervalMs < MIN_CHECK_INTERVAL_MS || checkIntervalMs > MAX_CHECK_INTERVAL_MS) {
      throw new Error(`自动化检查间隔必须在 ${MIN_CHECK_INTERVAL_MS / 1000}-${MAX_CHECK_INTERVAL_MS / 1000} 秒之间`)
    }
    this.checkIntervalMs = checkIntervalMs
    this.misfireGraceMs = options.misfireGraceMs ?? checkIntervalMs + 5_000
    if (this.misfireGraceMs < 0) throw new Error('misfireGraceMs 不能为负数')
    this.clock = options.clock ?? (() => new Date())
    this.systemTimezone = validateTimezone(
      options.systemTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    )
    this.onError = options.onError
    if (options.autoStart !== false) this.start()
  }

  private rows(): AutomationRow[] {
    return this.database.listAutomations().map((row) => toRow(row as Record<string, unknown>))
  }

  private rowById(id: string): AutomationRow {
    const row = this.rows().find((candidate) => candidate.id === id)
    if (!row) throw new Error('自动化任务不存在')
    return row
  }

  private toSpec(row: AutomationRow): AutomationSpec {
    const schedule = decodeSchedule(row, this.systemTimezone)
    const spec: AutomationSpec = {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      enabled: row.enabled,
      objective: row.prompt,
      modelProfileId: row.modelProfileId,
      schedule,
      normalizedSchedule: normalizeAutomationSchedule(schedule),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
    if (row.nextRunAt) spec.nextRunAt = row.nextRunAt
    if (row.lastRunAt) spec.lastRunAt = row.lastRunAt
    return spec
  }

  private intervalAnchor(row: AutomationRow): Date {
    return validDate(row.createdAt, 'createdAt')
  }

  list(input?: { workspaceId?: string }): AutomationSpec[] {
    return this.rows()
      .filter((row) => !input?.workspaceId || row.workspaceId === input.workspaceId)
      .map((row) => this.toSpec(row))
  }

  upsert(input: AutomationInput): AutomationSpec {
    const reference = this.clock()
    let schedule = normalizeInputSchedule(input.schedule)
    // Persist an anchor so an interval remains stable across app restarts and
    // does not silently realign to the automation row's creation timestamp.
    if (schedule.type === 'interval' && !schedule.startsAt) {
      schedule = { ...schedule, startsAt: reference.toISOString() }
    }
    const next = input.enabled ? nextRunForSchedule(schedule, reference, reference) : null
    const encoded = encodeSchedule(schedule)
    const effectiveEnabled = input.enabled && next !== null
    const id = this.database.saveAutomation({
      ...(input.id ? { id: input.id } : {}),
      name: input.name.trim(),
      prompt: input.objective.trim(),
      scheduleType: encoded.type,
      scheduleValue: encoded.value,
      timezone: encoded.timezone || this.systemTimezone,
      workspaceId: input.workspaceId,
      modelProfileId: input.modelProfileId,
      enabled: effectiveEnabled,
      nextRunAt: next?.toISOString() ?? null,
    })
    return this.toSpec(this.rowById(id))
  }

  remove(input: string | { id: string }): void {
    const id = typeof input === 'string' ? input : input.id
    this.rowById(id)
    if (this.running.has(id)) throw new Error('自动化任务正在运行，暂时不能删除')
    this.database.removeAutomation(id)
  }

  setEnabled(input: { id: string; enabled: boolean } | string, enabled?: boolean): AutomationSpec {
    const id = typeof input === 'string' ? input : input.id
    const nextEnabled = typeof input === 'string' ? enabled : input.enabled
    if (nextEnabled === undefined) throw new Error('缺少 enabled 参数')
    const row = this.rowById(id)
    const schedule = decodeSchedule(row, this.systemTimezone)
    const nextRun = nextEnabled
      ? nextRunForSchedule(schedule, this.clock(), this.intervalAnchor(row))
      : null
    const timestamp = this.clock().toISOString()
    const effectiveEnabled = nextEnabled && nextRun !== null
    this.database.db.prepare('UPDATE automations SET enabled=?,next_run_at=?,updated_at=? WHERE id=?')
      .run(effectiveEnabled ? 1 : 0, nextRun?.toISOString() ?? null, timestamp, id)
    return this.toSpec(this.rowById(id))
  }

  async runNow(input: string | { id: string }): Promise<TResult> {
    const id = typeof input === 'string' ? input : input.id
    const row = this.rowById(id)
    const result = await this.invoke(row)
    const timestamp = this.clock().toISOString()
    this.database.db.prepare('UPDATE automations SET last_run_at=?,updated_at=? WHERE id=?')
      .run(timestamp, timestamp, id)
    return result
  }

  start(): void {
    if (this.timer) return
    this.reconcileMissingNextRuns(this.clock())
    void this.tick().catch(() => undefined)
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined)
    }, this.checkIntervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  dispose(): void {
    this.stop()
  }

  async tick(at: Date = this.clock()): Promise<number> {
    if (this.tickInFlight) return this.tickInFlight
    const operation = this.processDue(validDate(at, 'tick time'))
    this.tickInFlight = operation
    try {
      return await operation
    } finally {
      if (this.tickInFlight === operation) this.tickInFlight = undefined
    }
  }

  private reconcileMissingNextRuns(at: Date): void {
    for (const row of this.rows()) {
      if (!row.enabled || row.nextRunAt) continue
      const schedule = decodeSchedule(row, this.systemTimezone)
      const next = nextRunForSchedule(schedule, at, this.intervalAnchor(row))
      this.database.db.prepare('UPDATE automations SET next_run_at=?,enabled=?,updated_at=? WHERE id=?')
        .run(next?.toISOString() ?? null, next ? 1 : 0, at.toISOString(), row.id)
    }
  }

  private advance(row: AutomationRow, at: Date, triggered: boolean): Date | null {
    const schedule = decodeSchedule(row, this.systemTimezone)
    const next = nextRunForSchedule(schedule, at, this.intervalAnchor(row))
    const disable = !next
    const timestamp = at.toISOString()
    if (triggered) {
      this.database.db.prepare('UPDATE automations SET last_run_at=?,next_run_at=?,enabled=?,updated_at=? WHERE id=?')
        .run(timestamp, next?.toISOString() ?? null, disable ? 0 : 1, timestamp, row.id)
    } else {
      this.database.db.prepare('UPDATE automations SET next_run_at=?,enabled=?,updated_at=? WHERE id=?')
        .run(next?.toISOString() ?? null, disable ? 0 : 1, timestamp, row.id)
    }
    return next
  }

  private async processDue(at: Date): Promise<number> {
    let triggeredCount = 0
    const due = this.rows()
      .filter((row) => row.enabled && row.nextRunAt && validDate(row.nextRunAt, 'nextRunAt').getTime() <= at.getTime())
      .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))

    for (const row of due) {
      if (!row.nextRunAt) continue
      const dueAt = validDate(row.nextRunAt, 'nextRunAt')
      const spec = this.toSpec(row)
      if (at.getTime() - dueAt.getTime() > this.misfireGraceMs) {
        const next = this.advance(row, at, false)
        this.database.audit('automation', 'missed', `已跳过错过的自动化：${row.name}`, {
          automationId: row.id,
          scheduledFor: dueAt.toISOString(),
          nextRunAt: next?.toISOString() ?? null,
        })
        continue
      }

      // Advance before invoking the callback. A process crash cannot replay a
      // non-idempotent scheduled run on the next launch.
      this.advance(row, at, true)
      try {
        await this.invoke(row)
        triggeredCount += 1
      } catch (error) {
        this.database.audit('automation', 'run_failed', `自动化执行失败：${row.name}`, {
          automationId: row.id,
          error: error instanceof Error ? error.message : String(error),
        })
        if (this.onError) {
          try { await this.onError(error, spec) } catch { /* error reporting is best-effort */ }
        }
      }
    }
    return triggeredCount
  }

  private async invoke(row: AutomationRow): Promise<TResult> {
    if (this.running.has(row.id)) throw new Error('自动化任务已经在运行')
    this.running.add(row.id)
    try {
      return await this.runCallback({
        automationId: row.id,
        workspaceId: row.workspaceId,
        objective: row.prompt,
        modelProfileId: row.modelProfileId,
        title: row.name,
      })
    } finally {
      this.running.delete(row.id)
    }
  }
}
