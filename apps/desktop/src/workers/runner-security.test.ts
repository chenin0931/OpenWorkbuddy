import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  FingerprintedConnectionCache,
  isPublicNetworkAddress,
  mcpConnectionFingerprint,
  pinnedHttpRequest,
  prepareMcpConnection,
  replaceFileTextSafely,
  resolveAuthorizedPath,
  restoreFileSafely,
  safeFetch,
  safeWebSearch,
  trashFileSafely,
  writeFileSafely,
  writeBinaryFileSafely,
} from './runner-security'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const digestBuffer = (value: Buffer): string => createHash('sha256').update(value).digest('hex')
const temporaryRoots: string[] = []

const workspace = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'workbuddy-runner-'))
  temporaryRoots.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('public network fetch boundary', () => {
  it('fails closed for IPv4 and IPv6 special-purpose ranges', () => {
    const blocked = [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.255.255.255', '169.254.1.1',
      '172.31.255.255', '192.0.2.4', '192.168.1.1', '198.18.0.1', '198.51.100.2',
      '203.0.113.9', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1',
      '64:ff9b::7f00:1', '100::1', '2001::1', '2001:db8::1', '2002:7f00:1::',
      '3fff::1', 'fc00::1', 'fe80::1', 'ff02::1', '4000::1',
    ]
    for (const address of blocked) expect(isPublicNetworkAddress(address), address).toBe(false)
    expect(isPublicNetworkAddress('8.8.8.8')).toBe(true)
    expect(isPublicNetworkAddress('1.1.1.1')).toBe(true)
    expect(isPublicNetworkAddress('2606:4700:4700::1111')).toBe(true)
  })

  it('rejects userinfo and mixed public/private DNS answers before opening a socket', async () => {
    const request = async (): Promise<never> => { throw new Error('must not request') }
    await expect(safeFetch('https://user:pass@example.com/', { request })).rejects.toThrow('userinfo')
    await expect(safeFetch('https://example.com/', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
      request,
    })).rejects.toMatchObject({ code: 'NON_PUBLIC_ADDRESS' })
  })

  it('pins the validated DNS answer and revalidates every redirect target', async () => {
    const requested: Array<{ host: string; address: string }> = []
    const result = await safeFetch('https://first.example/start', {
      lookup: async (hostname) => hostname === 'first.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '1.1.1.1', family: 4 }],
      request: async (url, address) => {
        requested.push({ host: url.hostname, address })
        return requested.length === 1
          ? { status: 302, statusMessage: 'Found', headers: { location: 'https://second.example/end' }, body: Buffer.alloc(0) }
          : { status: 200, statusMessage: 'OK', headers: { 'content-type': 'text/plain' }, body: Buffer.from('done') }
      },
    })
    expect(requested).toEqual([
      { host: 'first.example', address: '93.184.216.34' },
      { host: 'second.example', address: '1.1.1.1' },
    ])
    expect(result).toMatchObject({ url: 'https://second.example/end', text: 'done' })

    let calls = 0
    await expect(safeFetch('https://public.example/', {
      lookup: async (hostname) => hostname === 'public.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '10.0.0.1', family: 4 }],
      request: async () => {
        calls += 1
        return { status: 302, statusMessage: 'Found', headers: { location: 'http://private.example/' }, body: Buffer.alloc(0) }
      },
    })).rejects.toMatchObject({ code: 'NON_PUBLIC_ADDRESS' })
    expect(calls).toBe(1)
  })

  it('decodes legacy Chinese HTML from the declared meta charset', async () => {
    const prefix = Buffer.from('<html><head><meta charset="gb2312"></head><body>', 'ascii')
    const chinese = Buffer.from('bdf1c8d5d0c2cec5', 'hex') // 今日新闻 in GBK/GB2312
    const suffix = Buffer.from('</body></html>', 'ascii')
    const result = await safeFetch('https://news.example/today', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async () => ({
        status: 200,
        statusMessage: 'OK',
        headers: { 'content-type': 'text/html' },
        body: Buffer.concat([prefix, chinese, suffix]),
      }),
    })
    expect(result).toMatchObject({ text: '今日新闻', charset: 'gbk' })
  })

  it('cuts off a chunked response while streaming after 2 MB', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      for (let index = 0; index < 40; index += 1) response.write(Buffer.alloc(64 * 1024, 0x61))
      response.end()
    })
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server failed')
    try {
      await expect(pinnedHttpRequest(new URL(`http://example.test:${address.port}/large`), '127.0.0.1')).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    }
  })
})

describe('public web search boundary', () => {
  const publicLookup = async (hostname: string) => {
    expect(hostname).toBe('www.bing.com')
    return [{ address: '202.89.233.100', family: 4 }]
  }

  it('uses a fixed endpoint, encodes the query and returns normalized bounded results', async () => {
    const html = `
      <html><body>
        <ol id="b_results">
          <li class="b_algo"><h2><a href="https://example.com/docs?a=1">Official &amp; Docs</a></h2><div class="b_caption"><p>Primary <b>documentation</b> &#x27;summary&#x27;.</p></div></li>
          <li class='b_algo'><h2><a href="https://second.example/path#section">Second result</a></h2><div class='b_caption'><p>Another <em>summary</em>.</p></div></li>
          <li class="b_algo"><h2><a href="https://second.example/path#other">Duplicate URL</a></h2></li>
          <li class="b_algo"><h2><a href="http://127.0.0.1/private">Private result</a></h2></li>
        </ol>
      </body></html>`
    let requests = 0
    const result = await safeWebSearch('Moonshot AI & tools', 10, {
      lookup: publicLookup,
      request: async (url, address, maxBytes) => {
        requests += 1
        expect(url.hostname).toBe('www.bing.com')
        expect(url.searchParams.get('q')).toBe('Moonshot AI & tools')
        expect(url.searchParams.get('count')).toBe('10')
        expect(address).toBe('202.89.233.100')
        expect(maxBytes).toBe(512 * 1024)
        return { status: 200, statusMessage: 'OK', headers: { 'content-type': 'text/html; charset=UTF-8' }, body: Buffer.from(html) }
      },
    }) as any
    expect(requests).toBe(1)
    expect(result).toMatchObject({ engine: 'bing-html', query: 'Moonshot AI & tools', resultCount: 2 })
    expect(result.results).toEqual([
      { rank: 1, title: 'Official & Docs', url: 'https://example.com/docs?a=1', snippet: "Primary documentation 'summary'." },
      { rank: 2, title: 'Second result', url: 'https://second.example/path', snippet: 'Another summary.' },
    ])
  })

  it('fails closed for private DNS and redirects outside the fixed search service', async () => {
    await expect(safeWebSearch('query', 8, {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      request: async () => { throw new Error('must not request') },
    })).rejects.toMatchObject({ code: 'NON_PUBLIC_ADDRESS' })

    let requests = 0
    await expect(safeWebSearch('query', 8, {
      lookup: publicLookup,
      request: async () => {
        requests += 1
        return { status: 302, statusMessage: 'Found', headers: { location: 'https://search-redirect.example/results' }, body: Buffer.alloc(0) }
      },
    })).rejects.toMatchObject({ code: 'SEARCH_REDIRECT_FORBIDDEN' })
    expect(requests).toBe(1)
  })

  it('distinguishes no results, blocking and parser drift', async () => {
    const response = (body: string) => ({
      lookup: publicLookup,
      request: async () => ({ status: 200, statusMessage: 'OK', headers: { 'content-type': 'text/html' }, body: Buffer.from(body) }),
    })
    await expect(safeWebSearch('none', 8, response('<html><body>No results found</body></html>'))).resolves.toMatchObject({ resultCount: 0, results: [] })
    await expect(safeWebSearch('blocked', 8, response('<html><body><div class="anomaly-modal">Captcha</div></body></html>'))).rejects.toMatchObject({ code: 'SEARCH_BLOCKED' })
    await expect(safeWebSearch('drift', 8, response('<html><body>New unknown layout</body></html>'))).rejects.toMatchObject({ code: 'SEARCH_PARSE_FAILED' })
  })

  it('validates query and result limits before any network request', async () => {
    const request = async (): Promise<never> => { throw new Error('must not request') }
    await expect(safeWebSearch('   ', 8, { request })).rejects.toMatchObject({ code: 'INVALID_SEARCH_QUERY' })
    await expect(safeWebSearch('x'.repeat(501), 8, { request })).rejects.toMatchObject({ code: 'INVALID_SEARCH_QUERY' })
    await expect(safeWebSearch('query', 0, { request })).rejects.toMatchObject({ code: 'INVALID_SEARCH_LIMIT' })
    await expect(safeWebSearch('query', 1.5, { request })).rejects.toMatchObject({ code: 'INVALID_SEARCH_LIMIT' })
  })

  it.skipIf(process.env.WORKBUDDY_ONLINE_SEARCH !== '1')('returns parseable results from the live best-effort backend', async () => {
    const result = await safeWebSearch('Moonshot AI Kimi K2.7 Code', 3) as any
    expect(result.engine).toBe('bing-html')
    expect(result.resultCount).toBeGreaterThan(0)
    expect(result.results[0]).toMatchObject({ rank: 1 })
    expect(result.results[0].url).toMatch(/^https?:\/\//)
  })
})

describe('stale-safe atomic file mutation', () => {
  it('separates the authorization root from the project-relative path base', async () => {
    const authorizationRoot = await workspace()
    const project = join(authorizationRoot, 'project')
    const outsideProject = join(authorizationRoot, 'outside')
    await mkdir(project)
    await mkdir(outsideProject)
    await writeFile(join(project, 'local.txt'), 'local')
    await writeFile(join(outsideProject, 'global.txt'), 'global')

    await expect(resolveAuthorizedPath(project, join(outsideProject, 'global.txt'))).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
    await expect(resolveAuthorizedPath(authorizationRoot, 'local.txt', false, project)).resolves.toMatchObject({ target: await realpath(join(project, 'local.txt')) })
    await expect(resolveAuthorizedPath(authorizationRoot, join(outsideProject, 'global.txt'), false, project)).resolves.toMatchObject({ target: await realpath(join(outsideProject, 'global.txt')) })

    const trashed = await trashFileSafely(authorizationRoot, join(outsideProject, 'global.txt'), project, project)
    expect(trashed.trashedTo).toContain(join(await realpath(project), '.on-my-workbuddy-trash'))
    await expect(stat(join(outsideProject, 'global.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires a hash for existing files, writes atomically and preserves mode', async () => {
    const root = await workspace()
    const target = join(root, 'note.txt')
    await writeFile(target, 'before')
    await chmod(target, 0o640)

    await expect(writeFileSafely(root, 'note.txt', 'unsafe')).rejects.toMatchObject({ code: 'EXPECTED_HASH_REQUIRED' })
    const result = await writeFileSafely(root, 'note.txt', 'after', digest('before'))
    expect(result).toMatchObject({ before: 'before', after: 'after', created: false })
    expect(await readFile(target, 'utf8')).toBe('after')
    expect((await stat(target)).mode & 0o777).toBe(0o640)
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('writes binary outputs with the same stale-write guarantees', async () => {
    const root = await workspace()
    const first = Buffer.from('%PDF-1.7\nfirst\0binary')
    const second = Buffer.from('%PDF-1.7\nsecond\0binary')
    await writeBinaryFileSafely(root, 'report.pdf', first)
    await expect(writeBinaryFileSafely(root, 'report.pdf', second)).rejects.toMatchObject({ code: 'EXPECTED_HASH_REQUIRED' })
    const result = await writeBinaryFileSafely(root, 'report.pdf', second, digestBuffer(first))
    expect(result).toMatchObject({ sha256: digestBuffer(second), size: second.byteLength, created: false })
    expect(await readFile(join(root, 'report.pdf'))).toEqual(second)
  })

  it('refuses stale changes and creates a new file exclusively under contention', async () => {
    const root = await workspace()
    await writeFile(join(root, 'existing.txt'), 'changed elsewhere')
    await expect(writeFileSafely(root, 'existing.txt', 'new', digest('old'))).rejects.toMatchObject({ code: 'STALE_WRITE' })
    await expect(writeFileSafely(root, 'missing.txt', 'new', digest('expected-old-file'))).rejects.toMatchObject({ code: 'STALE_WRITE' })

    const outcomes = await Promise.allSettled([
      writeFileSafely(root, 'new.txt', 'first'),
      writeFileSafely(root, 'new.txt', 'second'),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    expect(['first', 'second']).toContain(await readFile(join(root, 'new.txt'), 'utf8'))
  })

  it('requires expectedSha256 for replace and supports stale-checked restore', async () => {
    const root = await workspace()
    const target = join(root, 'replace.txt')
    await writeFile(target, 'one one')
    await chmod(target, 0o604)
    await expect(replaceFileTextSafely(root, 'replace.txt', 'one', 'two', true, undefined)).rejects.toMatchObject({ code: 'EXPECTED_HASH_REQUIRED' })
    const replaced = await replaceFileTextSafely(root, 'replace.txt', 'one', 'two', true, digest('one one'))
    expect(replaced).toMatchObject({ after: 'two two', replacements: 2 })
    expect((await stat(target)).mode & 0o777).toBe(0o604)

    await expect(restoreFileSafely(root, 'replace.txt', 'one one', digest('wrong'), false)).rejects.toMatchObject({ code: 'STALE_WRITE' })
    const restored = await restoreFileSafely(root, 'replace.txt', 'one one', digest('two two'), false)
    expect(restored).toMatchObject({ restored: true, removedCreatedFile: false, after: 'one one' })
    expect(await readFile(target, 'utf8')).toBe('one one')
    expect((await stat(target)).mode & 0o777).toBe(0o604)
  })

  it('undoes a newly-created file by moving it to the workspace trash', async () => {
    const root = await workspace()
    await writeFileSafely(root, 'created.txt', 'generated')
    const restored = await restoreFileSafely(root, 'created.txt', '', digest('generated'), true)
    expect(restored).toMatchObject({ restored: true, removedCreatedFile: true })
    await expect(stat(join(root, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const trash = await readdir(join(root, '.on-my-workbuddy-trash'))
    expect(trash).toHaveLength(1)
    expect(await readFile(join(root, '.on-my-workbuddy-trash', trash[0]!), 'utf8')).toBe('generated')
  })
})

describe('MCP secret projection and cache identity', () => {
  it('injects only explicitly allowlisted stdio secret environment keys', () => {
    const prepared = prepareMcpConnection({
      id: 'stdio-1',
      transport: 'stdio',
      config: { type: 'stdio', command: 'node', args: ['server.js'], envKeys: ['ALLOWED'], env: { FORBIDDEN: 'public-config-value' } },
      secret: { env: { ALLOWED: 'yes', EXTRA: 'no' }, ALSO_EXTRA: 'no' },
    })
    expect(prepared.stdio?.secretEnvironment).toEqual({ ALLOWED: 'yes' })
  })

  it('projects bearer, OAuth and custom-header secrets without stringifying objects', () => {
    const bearer = prepareMcpConnection({ transport: 'http', config: { url: 'https://mcp.example/rpc', auth: 'bearer' }, secret: { bearer: 'b-token' } })
    expect(bearer.http?.headers).toEqual({ authorization: 'Bearer b-token' })

    const oauth = prepareMcpConnection({ transport: 'http', config: { url: 'https://mcp.example/rpc', auth: 'oauth' }, secret: { tokens: { access_token: 'oauth-token', refresh_token: 'hidden' } } })
    expect(oauth.http?.headers).toEqual({ authorization: 'Bearer oauth-token' })

    const headers = prepareMcpConnection({ transport: 'http', config: { url: 'https://mcp.example/rpc', auth: 'headers', headers: { 'x-public': 'visible' } }, secret: { headers: { 'X-API-Key': 'secret' } } })
    expect(headers.http?.headers).toEqual({ 'x-public': 'visible', 'x-api-key': 'secret' })
    expect(() => prepareMcpConnection({ transport: 'http', config: { url: 'https://user:pass@mcp.example/rpc', auth: 'none' } })).toThrow('userinfo')
  })

  it('uses a stable config-plus-secret fingerprint and changes it on secret rotation', () => {
    const first = mcpConnectionFingerprint({ transport: 'http', config: { auth: 'bearer', url: 'https://mcp.example' }, secret: { bearer: 'one', nested: { b: 2, a: 1 } } })
    const reordered = mcpConnectionFingerprint({ secret: { nested: { a: 1, b: 2 }, bearer: 'one' }, config: { url: 'https://mcp.example', auth: 'bearer' }, transport: 'http' })
    const rotated = mcpConnectionFingerprint({ transport: 'http', config: { auth: 'bearer', url: 'https://mcp.example' }, secret: { bearer: 'two', nested: { a: 1, b: 2 } } })
    expect(first).toBe(reordered)
    expect(rotated).not.toBe(first)
  })

  it('reuses identical fingerprints and closes the old connection on rotation', async () => {
    const cache = new FingerprintedConnectionCache<{ id: number; close(): Promise<void> }>()
    const closed: number[] = []
    let created = 0
    const make = async () => {
      const id = ++created
      return { id, close: async () => { closed.push(id) } }
    }
    const first = await cache.getOrCreate('server', 'fingerprint-one', make)
    const reused = await cache.getOrCreate('server', 'fingerprint-one', make)
    expect(reused).toBe(first)
    expect(created).toBe(1)
    const rotated = await cache.getOrCreate('server', 'fingerprint-two', make)
    expect(rotated.id).toBe(2)
    expect(closed).toEqual([1])
    expect(await cache.disconnect('server')).toBe(true)
    expect(closed).toEqual([1, 2])
  })
})
