import { describe, expect, it } from 'vitest'

import type { TabGrant } from './tab-authority'
import { resolveAuthorizedTabTarget } from './tab-authority'

const grant: TabGrant = {
  grantId: 'grant-1',
  taskId: 'run-1',
  rootTabId: 10,
  tabIds: new Set([10, 11]),
  authorizedAt: '2026-07-11T00:00:00.000Z',
}
const state = {
  grants: new Map([[grant.grantId, grant]]),
  tabToGrant: new Map([[10, grant.grantId], [11, grant.grantId]]),
  latestGrantId: grant.grantId,
}

describe('Chrome tab authority', () => {
  it('allows the selected root and a child explicitly recorded in the same grant', () => {
    expect(resolveAuthorizedTabTarget({ taskId: 'run-1', grantId: undefined, requestedTabId: 10 }, state).tabId).toBe(10)
    expect(resolveAuthorizedTabTarget({ taskId: 'run-1', grantId: undefined, requestedTabId: 11 }, state).tabId).toBe(11)
  })

  it('rejects an unrelated tab even when Chrome itself has that tab open', () => {
    expect(() => resolveAuthorizedTabTarget({ taskId: 'run-1', grantId: undefined, requestedTabId: 99 }, state)).toThrow(
      'outside the user-authorized tab grant',
    )
  })

  it('rejects a cross-task request and an unbound user selection', () => {
    expect(() => resolveAuthorizedTabTarget({ taskId: 'run-2', grantId: 'grant-1', requestedTabId: 10 }, state)).toThrow(
      'not bound to the requested task',
    )
    const unbound: TabGrant = { ...grant, grantId: 'unbound', taskId: undefined }
    expect(() => resolveAuthorizedTabTarget(
      { taskId: undefined, grantId: 'unbound', requestedTabId: 10 },
      { grants: new Map([['unbound', unbound]]), tabToGrant: new Map([[10, 'unbound']]), latestGrantId: 'unbound' },
    )).toThrow('Bind the user-selected tab')
  })
})
