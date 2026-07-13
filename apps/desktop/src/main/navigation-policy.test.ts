import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { createRendererNavigationPolicy, isRendererNavigationAllowed } from './navigation-policy'

describe('renderer navigation policy', () => {
  const entry = join('/Applications', 'OpenWorkbuddy.app', 'Contents', 'Resources', 'app.asar', 'dist', 'renderer', 'index.html')

  it('allows only the exact packaged entry URL, not another opaque file origin', () => {
    const policy = createRendererNavigationPolicy(entry)
    expect(isRendererNavigationAllowed(pathToFileURL(entry).href, policy)).toBe(true)
    expect(isRendererNavigationAllowed(pathToFileURL(join(entry, '..', 'secrets.html')).href, policy)).toBe(false)
    expect(isRendererNavigationAllowed('file:///etc/passwd', policy)).toBe(false)
    expect(isRendererNavigationAllowed(`${pathToFileURL(entry).href}?redirect=file:///etc/passwd`, policy)).toBe(false)
    expect(isRendererNavigationAllowed(`${pathToFileURL(entry).href}#other-document`, policy)).toBe(false)
  })

  it('allows the configured loopback dev origin and rejects other ports or credentials', () => {
    const policy = createRendererNavigationPolicy(entry, 'http://127.0.0.1:5173/app')
    expect(isRendererNavigationAllowed('http://127.0.0.1:5173/', policy)).toBe(true)
    expect(isRendererNavigationAllowed('http://127.0.0.1:5173/nested/route', policy)).toBe(true)
    expect(isRendererNavigationAllowed('http://127.0.0.1:4173/', policy)).toBe(false)
    expect(isRendererNavigationAllowed('http://user@127.0.0.1:5173/', policy)).toBe(false)
    expect(isRendererNavigationAllowed('https://example.com/', policy)).toBe(false)
  })

  it('rejects non-loopback development renderers', () => {
    expect(() => createRendererNavigationPolicy(entry, 'https://example.com')).toThrow('loopback')
    expect(() => createRendererNavigationPolicy(entry, 'file:///tmp/index.html')).toThrow('http(s)')
  })
})
