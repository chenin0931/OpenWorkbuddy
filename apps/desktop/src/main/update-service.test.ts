import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '', getPath: () => '' },
  autoUpdater: { setFeedURL: vi.fn(), on: vi.fn(), checkForUpdates: vi.fn() },
}))

import { evaluateUpdateEligibility } from './update-service'

describe('automatic update eligibility', () => {
  it('enables only signed packaged macOS builds with an HTTPS feed', () => {
    expect(evaluateUpdateEligibility({ packaged: true, platform: 'darwin', developerIdSigned: true, feedUrl: 'https://updates.example.com/mac' })).toEqual({
      enabled: true,
      reason: 'enabled',
      feedUrl: 'https://updates.example.com/mac',
    })
    expect(evaluateUpdateEligibility({ packaged: true, platform: 'darwin', developerIdSigned: false, feedUrl: 'https://updates.example.com/mac' }).reason).toBe('unsigned-build')
    expect(evaluateUpdateEligibility({ packaged: true, platform: 'darwin', developerIdSigned: true, feedUrl: 'http://updates.example.com/mac' }).reason).toBe('insecure-feed-url')
    expect(evaluateUpdateEligibility({ packaged: false, platform: 'darwin', developerIdSigned: true, feedUrl: 'https://updates.example.com/mac' }).reason).toBe('development-build')
  })
})
