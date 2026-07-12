import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { app, autoUpdater } from 'electron'

export interface UpdateEligibility {
  enabled: boolean
  reason: string
  feedUrl?: string
}

export function evaluateUpdateEligibility(input: { packaged: boolean; platform: NodeJS.Platform; feedUrl: string | undefined; developerIdSigned: boolean }): UpdateEligibility {
  if (!input.packaged) return { enabled: false, reason: 'development-build' }
  if (input.platform !== 'darwin') return { enabled: false, reason: 'unsupported-platform' }
  if (!input.developerIdSigned) return { enabled: false, reason: 'unsigned-build' }
  if (!input.feedUrl) return { enabled: false, reason: 'feed-not-configured' }
  let url: URL
  try { url = new URL(input.feedUrl) } catch { return { enabled: false, reason: 'invalid-feed-url' } }
  if (url.protocol !== 'https:' || url.username || url.password) return { enabled: false, reason: 'insecure-feed-url' }
  return { enabled: true, reason: 'enabled', feedUrl: url.toString() }
}

function configuredFeedUrl(): string | undefined {
  if (process.env.WORKBUDDY_UPDATE_FEED_URL?.trim()) return process.env.WORKBUDDY_UPDATE_FEED_URL.trim()
  try {
    const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as Record<string, unknown>
    return typeof metadata.workbuddyUpdateFeed === 'string' && metadata.workbuddyUpdateFeed.trim()
      ? metadata.workbuddyUpdateFeed.trim()
      : undefined
  } catch { return undefined }
}

function hasDeveloperIdSignature(): boolean {
  if (!app.isPackaged || process.platform !== 'darwin') return false
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', app.getPath('exe')], { encoding: 'utf8', timeout: 5_000 })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return result.status === 0 && /Authority=Developer ID Application:/i.test(output)
}

export function configureAutoUpdates(notify: (title: string, body: string) => void): UpdateEligibility {
  const eligibility = evaluateUpdateEligibility({
    packaged: app.isPackaged,
    platform: process.platform,
    feedUrl: configuredFeedUrl(),
    developerIdSigned: hasDeveloperIdSignature(),
  })
  if (!eligibility.enabled || !eligibility.feedUrl) return eligibility
  autoUpdater.setFeedURL({ url: eligibility.feedUrl })
  autoUpdater.on('error', (error) => console.warn('Auto update check failed', error))
  autoUpdater.on('update-downloaded', (_event, _releaseNotes, releaseName) => {
    notify('On My WorkBuddy 更新已下载', `${releaseName || '新版本'}将在退出应用后安装。`)
  })
  const check = (): void => {
    try { autoUpdater.checkForUpdates() } catch (error) { console.warn('Auto update check failed', error) }
  }
  setTimeout(check, 15_000).unref()
  setInterval(check, 6 * 60 * 60 * 1_000).unref()
  return eligibility
}
