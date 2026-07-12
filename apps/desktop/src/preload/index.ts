import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi, DesktopInvokeChannel, DesktopInvokeMap, RunEvent } from '@onmyworkbuddy/contracts'

const DESKTOP_API_VERSION = 1 as const

const invoke = <C extends DesktopInvokeChannel>(channel: C, input: DesktopInvokeMap[C]['input']): Promise<DesktopInvokeMap[C]['output']> => ipcRenderer.invoke('workbuddy:invoke', channel, input)
const noInput = <C extends DesktopInvokeChannel>(channel: C) => () => invoke(channel, undefined as DesktopInvokeMap[C]['input'])

const api: DesktopApi = {
  apiVersion: DESKTOP_API_VERSION,
  bootstrap: noInput('bootstrap'),
  app: {
    getInfo: noInput('app:get-info'),
    chooseWorkspace: noInput('app:choose-workspace'),
    chooseFiles: noInput('app:choose-files'),
    importAttachments: noInput('app:import-attachments'),
    revealPath: (input) => invoke('app:reveal-path', input),
  },
  workspaces: {
    list: noInput('workspaces:list'), create: (input) => invoke('workspaces:create', input), update: (input) => invoke('workspaces:update', input),
    remove: (input) => invoke('workspaces:remove', input), select: (input) => invoke('workspaces:select', input),
  },
  runs: {
    list: (input) => invoke('runs:list', input), get: (input) => invoke('runs:get', input), create: (input) => invoke('runs:create', input),
    sendMessage: (input) => invoke('runs:send-message', input), pause: (input) => invoke('runs:pause', input), resume: (input) => invoke('runs:resume', input),
    cancel: (input) => invoke('runs:cancel', input), remove: (input) => invoke('runs:remove', input), respondToApproval: (input) => invoke('runs:respond-approval', input),
  },
  models: {
    list: noInput('models:list'), catalog: (input) => invoke('models:catalog', input), upsert: (input) => invoke('models:upsert', input), remove: (input) => invoke('models:remove', input),
    setSecret: (input) => invoke('models:set-secret', input), deleteSecret: (input) => invoke('models:delete-secret', input), test: (input) => invoke('models:test', input),
    setDefaults: (input) => invoke('models:set-defaults', input),
  },
  settings: { get: noInput('settings:get'), update: (input) => invoke('settings:update', input) },
  permissions: {
    listPersistent: noInput('permissions:list-persistent'),
    createPersistent: (input) => invoke('permissions:create-persistent', input),
    removePersistent: (input) => invoke('permissions:remove-persistent', input),
  },
  capabilityPackages: {
    choose: noInput('capability-packages:choose'),
    install: (input) => invoke('capability-packages:install', input),
    list: noInput('capability-packages:list'),
  },
  memory: {
    list: (input) => invoke('memory:list', input), propose: (input) => invoke('memory:propose', input), confirm: (input) => invoke('memory:confirm', input),
    disable: (input) => invoke('memory:disable', input), remove: (input) => invoke('memory:remove', input),
  },
  mcp: {
    list: noInput('mcp:list'), upsert: (input) => invoke('mcp:upsert', input), remove: (input) => invoke('mcp:remove', input), test: (input) => invoke('mcp:test', input),
    startOAuth: (input) => invoke('mcp:start-oauth', input), completeOAuth: (input) => invoke('mcp:complete-oauth', input),
  },
  skills: {
    list: noInput('skills:list'), get: (input) => invoke('skills:get', input), import: (input) => invoke('skills:import', input),
    remove: (input) => invoke('skills:remove', input), setEnabled: (input) => invoke('skills:set-enabled', input),
  },
  automations: {
    list: (input) => invoke('automations:list', input), upsert: (input) => invoke('automations:upsert', input), remove: (input) => invoke('automations:remove', input),
    setEnabled: (input) => invoke('automations:set-enabled', input), runNow: (input) => invoke('automations:run-now', input),
  },
  chrome: {
    getStatus: noInput('chrome:get-status'), listGrants: (input) => invoke('chrome:list-grants', input), requestBinding: (input) => invoke('chrome:request-binding', input),
    revokeGrant: (input) => invoke('chrome:revoke-grant', input),
  },
  audit: { list: (input) => invoke('audit:list', input), exportDiagnostics: (input) => invoke('audit:export-diagnostics', input) },
  artifacts: { getText: (input) => invoke('artifacts:get-text', input), reveal: (input) => invoke('artifacts:reveal', input), undoChange: (input) => invoke('artifacts:undo-change', input) },
  events: {
    subscribe(listener) {
      const handler = (_event: Electron.IpcRendererEvent, value: RunEvent) => listener(value)
      ipcRenderer.on('workbuddy:run-event', handler)
      return () => ipcRenderer.removeListener('workbuddy:run-event', handler)
    },
  },
}

contextBridge.exposeInMainWorld('workbuddy', api)
