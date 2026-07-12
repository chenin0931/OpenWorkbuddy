import { ProtocolError } from './protocol.js'

export interface TabGrant {
  grantId: string
  taskId?: string
  rootTabId: number
  tabIds: Set<number>
  authorizedAt: string
}

export interface TabAuthorityState {
  grants: ReadonlyMap<string, TabGrant>
  tabToGrant: ReadonlyMap<number, string>
  latestGrantId: string | undefined
}

export interface TabAuthorityRequest {
  taskId: string | undefined
  grantId: string | undefined
  requestedTabId: number | undefined
}

/** Resolve a CDP target without ever broadening a user-selected tab grant. */
export function resolveAuthorizedTabTarget(
  request: TabAuthorityRequest,
  state: TabAuthorityState,
): { tabId: number; grant: TabGrant } {
  let grant: TabGrant | undefined
  if (request.grantId !== undefined) grant = state.grants.get(request.grantId)
  else if (request.taskId !== undefined) grant = [...state.grants.values()].find((candidate) => candidate.taskId === request.taskId)
  else if (state.latestGrantId !== undefined) grant = state.grants.get(state.latestGrantId)

  if (!grant) throw new ProtocolError('TAB_NOT_AUTHORIZED', 'No user-authorized Chrome tab matches this request.')
  if (request.taskId !== undefined && grant.taskId !== request.taskId) {
    throw new ProtocolError('TAB_NOT_AUTHORIZED', 'This tab is not bound to the requested task.')
  }
  if (grant.taskId === undefined) {
    throw new ProtocolError('TAB_NOT_BOUND', 'Bind the user-selected tab to a task before controlling it.')
  }

  const tabId = request.requestedTabId ?? grant.rootTabId
  if (!grant.tabIds.has(tabId) || state.tabToGrant.get(tabId) !== grant.grantId) {
    throw new ProtocolError('TAB_NOT_AUTHORIZED', 'The requested tab is outside the user-authorized tab grant.')
  }
  return { tabId, grant }
}
