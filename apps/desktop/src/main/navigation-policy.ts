import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface RendererNavigationPolicy {
  packagedEntryUrl: string
  devOrigin?: string
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Build an immutable navigation allowlist before creating the renderer. */
export function createRendererNavigationPolicy(entryPath: string, devUrl?: string): RendererNavigationPolicy {
  const packagedEntryUrl = pathToFileURL(resolve(entryPath)).href
  if (!devUrl) return { packagedEntryUrl }

  let parsed: URL
  try {
    parsed = new URL(devUrl)
  } catch {
    throw new Error('ELECTRON_RENDERER_URL must be an absolute URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('ELECTRON_RENDERER_URL must use http(s)')
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error('ELECTRON_RENDERER_URL must use a credential-free loopback origin')
  }
  return { packagedEntryUrl, devOrigin: parsed.origin }
}

/**
 * `file:` URLs have an opaque `null` origin, so same-origin comparison is not
 * a filesystem boundary. Packaged builds allow only the one precomputed entry
 * URL; development allows the exact configured loopback origin.
 */
export function isRendererNavigationAllowed(url: string, policy: RendererNavigationPolicy): boolean {
  let candidate: URL
  try {
    candidate = new URL(url)
  } catch {
    return false
  }

  if (candidate.protocol === 'file:') return candidate.href === policy.packagedEntryUrl
  if (!policy.devOrigin || candidate.username || candidate.password) return false
  return (candidate.protocol === 'http:' || candidate.protocol === 'https:') && candidate.origin === policy.devOrigin
}
