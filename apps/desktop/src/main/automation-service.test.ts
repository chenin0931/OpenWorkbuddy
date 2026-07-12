import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AppDatabase } from './database'
import {
  AutomationService,
  nextRunForSchedule,
  normalizeAutomationSchedule,
  type AutomationRunRequest,
} from './automation-service'

describe('AutomationService', () => {
  let temporaryRoot: string
  let database: AppDatabase
  let workspaceId: string
  let modelProfileId: string
  let now: Date
  let requests: AutomationRunRequest[]
  let service: AutomationService<{ runId: string }>

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'workbuddy-automation-'))
    database = new AppDatabase(join(temporaryRoot, 'app.sqlite3'))
    workspaceId = database.addWorkspace(temporaryRoot, 'Test workspace')
    modelProfileId = database.saveModelProfile({
      name: 'Test model',
      provider: 'openai',
      modelId: 'gpt-test',
      capabilities: {},
    }, Buffer.from('encrypted-test-key'))
    now = new Date('2026-07-10T08:00:00.000Z')
    requests = []
    service = new AutomationService(database, async (request) => {
      requests.push(request)
      return { runId: `run-${requests.length}` }
    }, {
      autoStart: false,
      clock: () => new Date(now),
      systemTimezone: 'Asia/Shanghai',
    })
  })

  afterEach(async () => {
    service.dispose()
    database.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('triggers a due one-time automation once and disables it before execution', async () => {
    const automation = service.upsert({
      workspaceId,
      modelProfileId,
      name: 'One time check',
      enabled: true,
      objective: 'Check the workspace',
      schedule: { type: 'once', runAt: '2026-07-10T08:00:10.000Z' },
    })
    expect(automation.nextRunAt).toBe('2026-07-10T08:00:10.000Z')

    now = new Date('2026-07-10T08:00:15.000Z')
    expect(await service.tick()).toBe(1)
    expect(requests).toEqual([expect.objectContaining({
      automationId: automation.id,
      workspaceId,
      modelProfileId,
      objective: 'Check the workspace',
    })])
    expect(service.list()[0]).toMatchObject({ enabled: false, lastRunAt: now.toISOString() })
    expect(service.list()[0]?.nextRunAt).toBeUndefined()

    expect(await service.tick()).toBe(0)
    expect(requests).toHaveLength(1)
  })

  it('records an overdue occurrence as missed and advances without backfilling', async () => {
    const automation = service.upsert({
      workspaceId,
      modelProfileId,
      name: 'Interval check',
      enabled: true,
      objective: 'Check periodically',
      schedule: { type: 'interval', everyMs: 60_000 },
    })
    expect(automation.schedule).toEqual({
      type: 'interval',
      everyMs: 60_000,
      startsAt: '2026-07-10T08:00:00.000Z',
    })

    now = new Date('2026-07-10T08:04:30.000Z')
    expect(await service.tick()).toBe(0)
    expect(requests).toHaveLength(0)
    expect(service.list()[0]?.nextRunAt).toBe('2026-07-10T08:05:00.000Z')
    expect(database.listAudit().some((entry) => entry.action === 'missed')).toBe(true)
  })

  it('normalizes cron schedules and computes the next time in their timezone', () => {
    const schedule = { type: 'cron' as const, expression: '  0   9 * * 1-5 ', timezone: 'Asia/Shanghai' }
    expect(normalizeAutomationSchedule(schedule)).toBe('cron:0 9 * * 1-5@Asia/Shanghai')
    expect(nextRunForSchedule(schedule, new Date('2026-07-10T00:30:00.000Z'))?.toISOString())
      .toBe('2026-07-10T01:00:00.000Z')
  })

  it('runs disabled automations manually without changing their next scheduled time', async () => {
    const automation = service.upsert({
      workspaceId,
      modelProfileId,
      name: 'Manual task',
      enabled: false,
      objective: 'Run only when asked',
      schedule: { type: 'interval', everyMs: 60_000 },
    })
    const result = await service.runNow(automation.id)
    expect(result).toEqual({ runId: 'run-1' })
    expect(service.list()[0]).toMatchObject({ enabled: false, lastRunAt: now.toISOString() })
    expect(service.list()[0]?.nextRunAt).toBeUndefined()
  })
})
