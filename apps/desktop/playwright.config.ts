import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  // Electron and browser-only specs intentionally run in separate worker
  // processes. Mixing `_electron` and Chrome pages in one long-lived worker
  // leaves an fsevents handle open under Node 24/Playwright 1.61 on macOS.
  projects: [
    { name: 'electron-security', testMatch: '**/electron-security.spec.ts' },
    { name: 'renderer', testMatch: '**/renderer.spec.ts', dependencies: ['electron-security'] },
  ],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    channel: 'chrome',
    headless: true,
    colorScheme: 'light',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 4174 --bind 127.0.0.1 --directory dist/renderer',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 15_000,
  },
})
