import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, expect, test } from '@playwright/test'

test('真实 Electron 窗口通过 preload 暴露具名 IPC，且 Renderer 没有 Node', async () => {
  const desktopRoot = resolve(__dirname, '../..')
  const userData = await mkdtemp(join(tmpdir(), 'workbuddy-electron-e2e-'))
  const application = await electron.launch({
    cwd: desktopRoot,
    args: ['dist/main/index.cjs', `--user-data-dir=${userData}`],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  try {
    const window = await application.firstWindow()
    await expect(window).toHaveTitle(/On My WorkBuddy/)
    const boundary = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { workbuddy?: { apiVersion: number; app: { getInfo(): Promise<unknown> }; bootstrap(): Promise<unknown> } }).workbuddy
      return {
        hasRequire: typeof (globalThis as typeof globalThis & { require?: unknown }).require !== 'undefined',
        hasProcess: typeof (globalThis as typeof globalThis & { process?: unknown }).process !== 'undefined',
        apiVersion: api?.apiVersion,
        info: await api?.app.getInfo(),
        bootstrap: await api?.bootstrap(),
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
      }
    })
    expect(boundary).toMatchObject({ hasRequire: false, hasProcess: false, apiVersion: 1 })
    expect(boundary.info).toMatchObject({ name: 'On My WorkBuddy', platform: 'darwin' })
    expect(boundary.bootstrap).toBeTruthy()
    expect(boundary.csp).toContain("script-src 'self'")
  } finally {
    await application.close()
    await rm(userData, { recursive: true, force: true })
  }
})
