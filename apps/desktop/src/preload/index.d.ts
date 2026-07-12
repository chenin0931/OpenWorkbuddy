import type { DesktopApi } from '@onmyworkbuddy/contracts'

declare global {
  interface Window {
    workbuddy: DesktopApi
  }
}

export {}
