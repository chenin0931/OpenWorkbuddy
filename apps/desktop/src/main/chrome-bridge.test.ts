import { describe, expect, it, vi } from 'vitest'

import { ChromeBridge } from './chrome-bridge'

function grant(id: string, runId: string, tabId: number, parentTabId: number | null): Record<string, unknown> {
  return { id, run_id: runId, tab_id: tabId, parent_tab_id: parentTabId, created_at: new Date().toISOString() }
}

describe('ChromeBridge tab authority', () => {
  it('allows only the selected root and its persisted child, never an unrelated tab', async () => {
    const rows = [grant('root', 'run-1', 10, null), grant('child', 'run-1', 11, 10)]
    const database = {
      listChromeGrants: (runId: string) => rows.filter((row) => row.run_id === runId),
      addChromeGrant: vi.fn(),
    }
    const bridge = new ChromeBridge('/tmp/workbuddy-chrome-test.sock', database as never)
    const request = vi.spyOn(bridge, 'request').mockResolvedValue({ ok: true })

    await bridge.executeTool('run-1', 'chrome_snapshot', { tabId: 10, kind: 'dom' })
    await bridge.executeTool('run-1', 'chrome_snapshot', { tabId: 11, kind: 'dom' })
    await expect(bridge.executeTool('run-1', 'chrome_snapshot', { tabId: 99, kind: 'dom' })).rejects.toThrow(
      '不属于当前任务授权范围',
    )

    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.map((item) => item[1])).toEqual([
      expect.objectContaining({ taskId: 'run-1', tabId: 10 }),
      expect.objectContaining({ taskId: 'run-1', tabId: 11 }),
    ])
  })

  it('persists a child event only beneath an existing root grant for that task', () => {
    const rows = [grant('root', 'run-1', 10, null)]
    const addChromeGrant = vi.fn((input: Record<string, unknown>) => {
      rows.push(grant('added', String(input.runId), Number(input.tabId), Number(input.parentTabId)))
      return 'added'
    })
    const database = {
      listChromeGrants: (runId: string) => rows.filter((row) => row.run_id === runId),
      addChromeGrant,
    }
    const bridge = new ChromeBridge('/tmp/workbuddy-chrome-test.sock', database as never)
    const handle = (message: unknown): void => (bridge as unknown as { handle(value: unknown): void }).handle(message)

    handle({ type: 'event', event: 'tab.childAdded', data: { taskId: 'run-1', rootTabId: 10, tabId: 11 } })
    handle({ type: 'event', event: 'tab.childAdded', data: { taskId: 'run-1', rootTabId: 999, tabId: 12 } })
    handle({ type: 'event', event: 'tab.childAdded', data: { taskId: 'other-run', rootTabId: 10, tabId: 13 } })

    expect(addChromeGrant).toHaveBeenCalledOnce()
    expect(addChromeGrant).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      tabId: 11,
      parentTabId: 10,
    }))
  })
})
