import {
  errorResponse,
  isRecord,
  parseBridgeRequest,
  ProtocolError,
  successResponse,
  type BridgeEvent,
  type BridgeRequest,
} from './protocol.js'
import { resolveAuthorizedTabTarget, type TabGrant } from './tab-authority.js'

declare const chrome: any

const NATIVE_HOST_NAME = 'com.onmyworkbuddy.chrome'
const DEBUGGER_PROTOCOL_VERSION = '1.3'
const MAX_TEXT_BYTES = 1_048_576

interface ChromeTab {
  id?: number
  openerTabId?: number
  title?: string
  url?: string
  pendingUrl?: string
  status?: string
  active?: boolean
  windowId?: number
}

interface ChromePort {
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: { addListener(listener: (message: unknown) => void): void }
  onDisconnect: { addListener(listener: () => void): void }
}

interface Debuggee {
  tabId: number
}

interface PendingChildAuthorization {
  grantId: string
  expiresAt: number
}

const grants = new Map<string, TabGrant>()
const tabToGrant = new Map<number, string>()
const attachedTabs = new Set<number>()
const pendingChildAuthorizations = new Map<number, PendingChildAuthorization>()
let latestGrantId: string | undefined
let nativePort: ChromePort | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectDelayMs = 1_000

chrome.action.onClicked.addListener((tab: ChromeTab) => {
  void authorizeTabFromUserGesture(tab)
})

chrome.tabs.onCreated.addListener((tab: ChromeTab) => {
  if (tab.id === undefined || tab.openerTabId === undefined) return
  const pending = pendingChildAuthorizations.get(tab.openerTabId)
  if (!pending || pending.expiresAt < Date.now()) {
    pendingChildAuthorizations.delete(tab.openerTabId)
    return
  }
  pendingChildAuthorizations.delete(tab.openerTabId)
  const grant = grants.get(pending.grantId)
  if (!grant) return
  grant.tabIds.add(tab.id)
  tabToGrant.set(tab.id, grant.grantId)
  notifyNative('tab.childAdded', tabSummary(tab, grant))
})

chrome.tabs.onRemoved.addListener((tabId: number) => {
  revokeTab(tabId, 'tab_closed')
})

chrome.debugger.onDetach.addListener((source: Debuggee, reason: string) => {
  attachedTabs.delete(source.tabId)
  const grant = grantForTab(source.tabId)
  if (grant) {
    notifyNative('debugger.detached', {
      grantId: grant.grantId,
      taskId: grant.taskId,
      tabId: source.tabId,
      reason,
    })
  }
})

chrome.runtime.onStartup.addListener(() => ensureNativePort())
chrome.runtime.onInstalled.addListener(() => ensureNativePort())
ensureNativePort()

async function authorizeTabFromUserGesture(tab: ChromeTab): Promise<void> {
  if (tab.id === undefined) return
  if (!isInspectableUrl(tab.url ?? tab.pendingUrl)) {
    await showBadge('!', '#B42318')
    notifyNative('tab.authorizationFailed', {
      tabId: tab.id,
      message: 'This Chrome page cannot be controlled. Open an http(s) page and try again.',
    })
    return
  }

  const existing = grantForTab(tab.id)
  if (existing) {
    latestGrantId = existing.grantId
    await showBadge('ON', '#067647')
    notifyNative('tab.userSelected', tabSummary(tab, existing))
    return
  }

  const grant: TabGrant = {
    grantId: crypto.randomUUID(),
    rootTabId: tab.id,
    tabIds: new Set([tab.id]),
    authorizedAt: new Date().toISOString(),
  }
  grants.set(grant.grantId, grant)
  tabToGrant.set(tab.id, grant.grantId)
  latestGrantId = grant.grantId

  try {
    await ensureAttached(tab.id)
    await showBadge('ON', '#067647')
    notifyNative('tab.userAuthorized', tabSummary(tab, grant))
  } catch (error) {
    revokeGrant(grant.grantId, 'debugger_attach_failed')
    await showBadge('!', '#B42318')
    notifyNative('tab.authorizationFailed', {
      tabId: tab.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function ensureNativePort(): void {
  if (nativePort) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME) as ChromePort
    nativePort = port
    port.onMessage.addListener((message: unknown) => {
      void onNativeMessage(message)
    })
    port.onDisconnect.addListener(() => {
      if (nativePort === port) nativePort = undefined
      scheduleReconnect()
    })
    reconnectDelayMs = 1_000
  } catch {
    nativePort = undefined
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    ensureNativePort()
  }, reconnectDelayMs)
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000)
}

async function onNativeMessage(message: unknown): Promise<void> {
  if (isRecord(message) && message.type === 'bridge.error') return

  let requestId = 'unknown'
  try {
    if (isRecord(message) && typeof message.requestId === 'string') requestId = message.requestId
    const request = parseBridgeRequest(message)
    nativePort?.postMessage(successResponse(request.requestId, await executeRequest(request)))
  } catch (error) {
    nativePort?.postMessage(errorResponse(requestId, error))
  }
}

async function executeRequest(request: BridgeRequest): Promise<unknown> {
  switch (request.command) {
    case 'tabs.list':
      return listAuthorizedTabs(optionalString(request.params, 'taskId'))
    case 'bind':
      return bindLatestGrant(request.params)
    case 'snapshot':
      return captureSnapshot(request.params)
    case 'dom':
      return captureDom(request.params)
    case 'ax':
      return captureAccessibilityTree(request.params)
    case 'screenshot':
      return captureScreenshot(request.params)
    case 'navigate':
      return navigate(request.params)
    case 'click':
      return click(request.params)
    case 'type':
      return typeText(request.params)
    case 'openTab':
      return openTab(request.params)
    case 'detach':
      return detach(request.params)
  }
}

async function listAuthorizedTabs(taskId?: string): Promise<unknown[]> {
  const items: unknown[] = []
  for (const grant of grants.values()) {
    if (taskId !== undefined && grant.taskId !== taskId) continue
    for (const tabId of grant.tabIds) {
      try {
        const tab = (await chrome.tabs.get(tabId)) as ChromeTab
        items.push(tabSummary(tab, grant))
      } catch {
        revokeTab(tabId, 'tab_missing')
      }
    }
  }
  return items
}

async function bindLatestGrant(params: Record<string, unknown>): Promise<unknown> {
  const requestedGrantId = optionalString(params, 'grantId')
  const taskId = requiredString(params, 'taskId', 200)
  const grantId = requestedGrantId ?? latestGrantId
  if (!grantId) {
    throw new ProtocolError('USER_GESTURE_REQUIRED', 'Click the On My WorkBuddy extension icon on the tab first.')
  }
  const grant = grants.get(grantId)
  if (!grant) throw new ProtocolError('GRANT_NOT_FOUND', 'The selected tab grant no longer exists.')
  if (grant.taskId !== undefined && grant.taskId !== taskId) {
    throw new ProtocolError('GRANT_IN_USE', 'This tab is already bound to another task.')
  }
  grant.taskId = taskId
  const tab = (await chrome.tabs.get(grant.rootTabId)) as ChromeTab
  await ensureAttached(grant.rootTabId)
  return tabSummary(tab, grant)
}

async function captureSnapshot(params: Record<string, unknown>): Promise<unknown> {
  const { tabId, grant } = resolveAuthorizedTarget(params)
  await ensureAttached(tabId)
  const computedStyles = optionalStringArray(params, 'computedStyles', 64)
  const snapshot = await sendDebuggerCommand(tabId, 'DOMSnapshot.captureSnapshot', {
    computedStyles,
    includeDOMRects: optionalBoolean(params, 'includeDOMRects') ?? true,
    includePaintOrder: optionalBoolean(params, 'includePaintOrder') ?? false,
    includeBlendedBackgroundColors: false,
    includeTextColorOpacities: false,
  })
  return { grantId: grant.grantId, taskId: grant.taskId, tabId, snapshot }
}

async function captureDom(params: Record<string, unknown>): Promise<unknown> {
  const { tabId, grant } = resolveAuthorizedTarget(params)
  await ensureAttached(tabId)
  const dom = await sendDebuggerCommand(tabId, 'DOM.getDocument', {
    depth: optionalInteger(params, 'depth', -1, 1000) ?? -1,
    pierce: optionalBoolean(params, 'pierce') ?? true,
  })
  return { grantId: grant.grantId, taskId: grant.taskId, tabId, dom }
}

async function captureAccessibilityTree(params: Record<string, unknown>): Promise<unknown> {
  const { tabId, grant } = resolveAuthorizedTarget(params)
  await ensureAttached(tabId)
  await sendDebuggerCommand(tabId, 'Accessibility.enable')
  const ax = await sendDebuggerCommand(tabId, 'Accessibility.getFullAXTree', {
    depth: optionalInteger(params, 'depth', 0, 1000),
  })
  return { grantId: grant.grantId, taskId: grant.taskId, tabId, ax }
}

async function captureScreenshot(params: Record<string, unknown>): Promise<unknown> {
  const { tabId, grant } = resolveAuthorizedTarget(params)
  await ensureAttached(tabId)
  const format = optionalEnum(params, 'format', ['png', 'jpeg', 'webp'] as const) ?? 'jpeg'
  const quality = format === 'png' ? undefined : optionalInteger(params, 'quality', 1, 100) ?? 80
  const screenshot = (await sendDebuggerCommand(tabId, 'Page.captureScreenshot', {
    format,
    ...(quality === undefined ? {} : { quality }),
    fromSurface: true,
    captureBeyondViewport: optionalBoolean(params, 'captureBeyondViewport') ?? false,
    optimizeForSpeed: true,
  })) as Record<string, unknown>
  return {
    grantId: grant.grantId,
    taskId: grant.taskId,
    tabId,
    format,
    data: screenshot.data,
  }
}

async function navigate(params: Record<string, unknown>): Promise<unknown> {
  const { tabId, grant } = resolveAuthorizedTarget(params)
  const url = validateNavigationUrl(requiredString(params, 'url', 16_384))
  await ensureAttached(tabId)
  const result = await sendDebuggerCommand(tabId, 'Page.navigate', { url })
  return { grantId: grant.grantId, taskId: grant.taskId, tabId, url, result }
}

async function click(params: Record<string, unknown>): Promise<unknown> {
  const { tabId, grant } = resolveAuthorizedTarget(params)
  await ensureAttached(tabId)
  const point = await resolveClickPoint(tabId, params)
  armChildAuthorization(tabId, grant.grantId)
  await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
  })
  await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: optionalEnum(params, 'button', ['left', 'middle', 'right'] as const) ?? 'left',
    clickCount: optionalInteger(params, 'clickCount', 1, 3) ?? 1,
  })
  await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: optionalEnum(params, 'button', ['left', 'middle', 'right'] as const) ?? 'left',
    clickCount: optionalInteger(params, 'clickCount', 1, 3) ?? 1,
  })
  return { grantId: grant.grantId, taskId: grant.taskId, tabId, point }
}

async function resolveClickPoint(tabId: number, params: Record<string, unknown>): Promise<{ x: number; y: number }> {
  const x = optionalNumber(params, 'x')
  const y = optionalNumber(params, 'y')
  if (x !== undefined || y !== undefined) {
    if (x === undefined || y === undefined) {
      throw new ProtocolError('INVALID_PARAMS', 'Both x and y are required for coordinate clicks.')
    }
    return { x, y }
  }

  const selector = requiredString(params, 'selector', 16_384)
  const expression = `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { error: 'Element not found' };
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { error: 'Element is not visible' };
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`
  const evaluation = (await sendDebuggerCommand(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })) as Record<string, unknown>
  const result = asRecord(evaluation.result, 'Runtime.evaluate result')
  const value = asRecord(result.value, 'click target')
  if (typeof value.error === 'string') throw new ProtocolError('TARGET_NOT_FOUND', value.error)
  if (typeof value.x !== 'number' || typeof value.y !== 'number') {
    throw new ProtocolError('TARGET_NOT_FOUND', 'Chrome did not return a clickable target.')
  }
  return { x: value.x, y: value.y }
}

async function typeText(params: Record<string, unknown>): Promise<unknown> {
  const { tabId, grant } = resolveAuthorizedTarget(params)
  const text = requiredString(params, 'text', MAX_TEXT_BYTES)
  const selector = optionalString(params, 'selector')
  const clear = optionalBoolean(params, 'clear') ?? false
  await ensureAttached(tabId)

  if (selector !== undefined) {
    const expression = `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return { error: 'Element not found' };
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      element.focus();
      if (${JSON.stringify(clear)} && 'value' in element) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
        if (setter) setter.call(element, ''); else element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return { focused: document.activeElement === element };
    })()`
    const evaluation = (await sendDebuggerCommand(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })) as Record<string, unknown>
    const result = asRecord(evaluation.result, 'Runtime.evaluate result')
    const value = asRecord(result.value, 'type target')
    if (typeof value.error === 'string') throw new ProtocolError('TARGET_NOT_FOUND', value.error)
    if (value.focused !== true) throw new ProtocolError('TARGET_NOT_FOCUSABLE', 'The target could not receive focus.')
  }

  await sendDebuggerCommand(tabId, 'Input.insertText', { text })
  return {
    grantId: grant.grantId,
    taskId: grant.taskId,
    tabId,
    insertedCharacters: Array.from(text).length,
  }
}

async function openTab(params: Record<string, unknown>): Promise<unknown> {
  const { tabId: openerTabId, grant } = resolveAuthorizedTarget(params)
  const url = validateNavigationUrl(optionalString(params, 'url') ?? 'about:blank')
  armChildAuthorization(openerTabId, grant.grantId)
  const tab = (await chrome.tabs.create({
    url,
    active: optionalBoolean(params, 'active') ?? true,
    openerTabId,
  })) as ChromeTab
  if (tab.id === undefined) throw new ProtocolError('TAB_CREATE_FAILED', 'Chrome created a tab without an id.')
  grant.tabIds.add(tab.id)
  tabToGrant.set(tab.id, grant.grantId)
  await ensureAttached(tab.id)
  return tabSummary(tab, grant)
}

async function detach(params: Record<string, unknown>): Promise<unknown> {
  const { tabId, grant } = resolveAuthorizedTarget(params)
  const revokeAll = optionalBoolean(params, 'all') ?? tabId === grant.rootTabId
  if (revokeAll) {
    const detachedTabIds = [...grant.tabIds]
    await revokeGrant(grant.grantId, 'desktop_detach')
    await showBadge('', '#000000')
    return { grantId: grant.grantId, detachedTabIds }
  }
  await detachDebugger(tabId)
  grant.tabIds.delete(tabId)
  tabToGrant.delete(tabId)
  return { grantId: grant.grantId, detachedTabIds: [tabId] }
}

function resolveAuthorizedTarget(params: Record<string, unknown>): { tabId: number; grant: TabGrant } {
  const taskId = optionalString(params, 'taskId')
  const grantId = optionalString(params, 'grantId')
  const requestedTabId = optionalInteger(params, 'tabId', 1, Number.MAX_SAFE_INTEGER)
  return resolveAuthorizedTabTarget(
    { taskId, grantId, requestedTabId },
    { grants, tabToGrant, latestGrantId },
  )
}

async function ensureAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION)
    attachedTabs.add(tabId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('Another debugger is already attached')) {
      throw new ProtocolError('DEBUGGER_BUSY', 'Chrome DevTools or another debugger is already attached to this tab.', true)
    }
    throw new ProtocolError('DEBUGGER_ATTACH_FAILED', message, true)
  }
}

async function detachDebugger(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) return
  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // The tab may already be closed or detached by Chrome.
  } finally {
    attachedTabs.delete(tabId)
  }
}

async function sendDebuggerCommand(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params)
  } catch (error) {
    attachedTabs.delete(tabId)
    throw new ProtocolError(
      'CDP_COMMAND_FAILED',
      `${method} failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    )
  }
}

async function revokeGrant(grantId: string, reason: string): Promise<void> {
  const grant = grants.get(grantId)
  if (!grant) return
  grants.delete(grantId)
  if (latestGrantId === grantId) latestGrantId = undefined
  for (const tabId of grant.tabIds) {
    tabToGrant.delete(tabId)
    await detachDebugger(tabId)
  }
  notifyNative('tab.grantRevoked', { grantId, taskId: grant.taskId, reason })
}

function revokeTab(tabId: number, reason: string): void {
  attachedTabs.delete(tabId)
  const grantId = tabToGrant.get(tabId)
  if (!grantId) return
  tabToGrant.delete(tabId)
  const grant = grants.get(grantId)
  if (!grant) return
  grant.tabIds.delete(tabId)
  notifyNative('tab.revoked', { grantId, taskId: grant.taskId, tabId, reason })
  if (tabId === grant.rootTabId || grant.tabIds.size === 0) {
    void revokeGrant(grantId, reason)
  }
}

function grantForTab(tabId: number): TabGrant | undefined {
  const grantId = tabToGrant.get(tabId)
  return grantId === undefined ? undefined : grants.get(grantId)
}

function armChildAuthorization(openerTabId: number, grantId: string): void {
  const pending: PendingChildAuthorization = {
    grantId,
    expiresAt: Date.now() + 3_000,
  }
  pendingChildAuthorizations.set(openerTabId, pending)
  setTimeout(() => {
    if (pendingChildAuthorizations.get(openerTabId) === pending) {
      pendingChildAuthorizations.delete(openerTabId)
    }
  }, 3_000)
}

function tabSummary(tab: ChromeTab, grant: TabGrant): Record<string, unknown> {
  return {
    grantId: grant.grantId,
    taskId: grant.taskId,
    authorizedAt: grant.authorizedAt,
    tabId: tab.id,
    rootTabId: grant.rootTabId,
    isRoot: tab.id === grant.rootTabId,
    title: tab.title,
    url: tab.url ?? tab.pendingUrl,
    status: tab.status,
    active: tab.active,
    windowId: tab.windowId,
    debuggerAttached: tab.id === undefined ? false : attachedTabs.has(tab.id),
  }
}

function notifyNative(event: string, data: unknown): void {
  ensureNativePort()
  const message: BridgeEvent = { type: 'event', event, data }
  try {
    nativePort?.postMessage(message)
  } catch {
    nativePort = undefined
    scheduleReconnect()
  }
}

async function showBadge(text: string, color: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color })
  await chrome.action.setBadgeText({ text })
}

function isInspectableUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || url === 'about:blank'
  } catch {
    return false
  }
}

function validateNavigationUrl(value: string): string {
  if (value === 'about:blank') return value
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ProtocolError('INVALID_URL', 'url must be an absolute http(s) URL or about:blank.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProtocolError('DISALLOWED_URL', `Navigation to ${parsed.protocol} URLs is not allowed.`)
  }
  return parsed.toString()
}

function requiredString(params: Record<string, unknown>, key: string, maxLength: number): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).length > maxLength) {
    throw new ProtocolError('INVALID_PARAMS', `${key} must be a non-empty string no larger than ${maxLength} bytes.`)
  }
  return value
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolError('INVALID_PARAMS', `${key} must be a non-empty string when provided.`)
  }
  return value
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new ProtocolError('INVALID_PARAMS', `${key} must be a boolean.`)
  return value
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError('INVALID_PARAMS', `${key} must be a finite number.`)
  }
  return value
}

function optionalInteger(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ProtocolError('INVALID_PARAMS', `${key} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

function optionalStringArray(params: Record<string, unknown>, key: string, maxItems: number): string[] {
  const value = params[key]
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string')) {
    throw new ProtocolError('INVALID_PARAMS', `${key} must be an array of at most ${maxItems} strings.`)
  }
  return value as string[]
}

function optionalEnum<const Values extends readonly string[]>(
  params: Record<string, unknown>,
  key: string,
  values: Values,
): Values[number] | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ProtocolError('INVALID_PARAMS', `${key} must be one of: ${values.join(', ')}.`)
  }
  return value as Values[number]
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolError('CDP_RESULT_INVALID', `${label} was not an object.`)
  return value
}
