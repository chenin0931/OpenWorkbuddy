import { createHash, randomBytes } from 'node:crypto'
import { promises as dns } from 'node:dns'
import { link, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const MAX_PUBLIC_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_SEARCH_RESPONSE_BYTES = 512 * 1024

const BING_SEARCH_ENDPOINT = 'https://www.bing.com/search'
const BING_SEARCH_HOSTS = new Set(['bing.com', 'www.bing.com', 'cn.bing.com'])
const DUCKDUCKGO_REDIRECT_HOSTS = new Set(['lite.duckduckgo.com', 'html.duckduckgo.com', 'duckduckgo.com', 'www.duckduckgo.com'])

export interface PinnedHttpResponse {
  status: number
  statusMessage: string
  headers: IncomingHttpHeaders
  body: Buffer
}

export interface PublicFetchDependencies {
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  request?: (url: URL, address: string, maxBytes: number) => Promise<PinnedHttpResponse>
}

export interface PreparedMcpConnection {
  fingerprint: string
  transport: 'stdio' | 'http'
  stdio?: {
    command: string
    args: string[]
    cwd?: string
    secretEnvironment: Record<string, string>
  }
  http?: { url: URL; headers: Record<string, string> }
}

export interface ClosableConnection {
  close(): Promise<void>
}

/** Serializes connection replacement per server and closes stale fingerprints. */
export class FingerprintedConnectionCache<T extends ClosableConnection> {
  private readonly entries = new Map<string, { fingerprint: string; value: T }>()
  private readonly pending = new Map<string, Promise<T>>()

  async getOrCreate(serverId: string, fingerprint: string, create: () => Promise<T>): Promise<T> {
    for (;;) {
      const pending = this.pending.get(serverId)
      if (pending) {
        await pending.catch(() => undefined)
        continue
      }
      const existing = this.entries.get(serverId)
      if (existing?.fingerprint === fingerprint) return existing.value
      const replacement = (async (): Promise<T> => {
        if (existing) {
          this.entries.delete(serverId)
          await existing.value.close().catch(() => {})
        }
        const value = await create()
        this.entries.set(serverId, { fingerprint, value })
        return value
      })()
      this.pending.set(serverId, replacement)
      try {
        return await replacement
      } finally {
        if (this.pending.get(serverId) === replacement) this.pending.delete(serverId)
      }
    }
  }

  async disconnect(serverId: string): Promise<boolean> {
    await this.pending.get(serverId)?.catch(() => undefined)
    const existing = this.entries.get(serverId)
    if (!existing) return false
    this.entries.delete(serverId)
    await existing.value.close()
    return true
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.pending.values()])
    const values = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(values.map(({ value }) => value.close()))
  }
}

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')

const isWithin = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

const hasPrefix = (bytes: Uint8Array, prefix: Uint8Array, bits: number): boolean => {
  const fullBytes = Math.floor(bits / 8)
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false
  }
  const remaining = bits % 8
  if (!remaining) return true
  const mask = (0xff << (8 - remaining)) & 0xff
  return ((bytes[fullBytes] ?? 0) & mask) === ((prefix[fullBytes] ?? 0) & mask)
}

const parseIpv4 = (value: string): Uint8Array | undefined => {
  if (isIP(value) !== 4) return undefined
  const octets = value.split('.').map(Number)
  return octets.length === 4 ? Uint8Array.from(octets) : undefined
}

const parseIpv6 = (input: string): Uint8Array | undefined => {
  let value = input.toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (value.includes('%') || isIP(value) !== 6) return undefined

  const ipv4Tail = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (ipv4Tail) {
    const ipv4 = parseIpv4(ipv4Tail)
    if (!ipv4) return undefined
    value = `${value.slice(0, value.length - ipv4Tail.length)}${((ipv4[0] ?? 0) << 8 | (ipv4[1] ?? 0)).toString(16)}:${((ipv4[2] ?? 0) << 8 | (ipv4[3] ?? 0)).toString(16)}`
  }

  const halves = value.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const zeroCount = 8 - left.length - right.length
  if ((halves.length === 1 && zeroCount !== 0) || zeroCount < 0) return undefined
  const groups = [...left, ...Array.from({ length: zeroCount }, () => '0'), ...right]
  if (groups.length !== 8) return undefined
  const bytes = new Uint8Array(16)
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]
    if (!group || !/^[0-9a-f]{1,4}$/.test(group)) return undefined
    const number = Number.parseInt(group, 16)
    bytes[index * 2] = number >>> 8
    bytes[index * 2 + 1] = number & 0xff
  }
  return bytes
}

const ipv4 = (value: string): Uint8Array => parseIpv4(value)!
const ipv6 = (value: string): Uint8Array => parseIpv6(value)!

const BLOCKED_IPV4: Array<[Uint8Array, number]> = [
  [ipv4('0.0.0.0'), 8],
  [ipv4('10.0.0.0'), 8],
  [ipv4('100.64.0.0'), 10],
  [ipv4('127.0.0.0'), 8],
  [ipv4('169.254.0.0'), 16],
  [ipv4('172.16.0.0'), 12],
  [ipv4('192.0.0.0'), 24],
  [ipv4('192.0.2.0'), 24],
  [ipv4('192.88.99.0'), 24],
  [ipv4('192.168.0.0'), 16],
  [ipv4('198.18.0.0'), 15],
  [ipv4('198.51.100.0'), 24],
  [ipv4('203.0.113.0'), 24],
  [ipv4('224.0.0.0'), 4],
  [ipv4('240.0.0.0'), 4],
]

const BLOCKED_IPV6: Array<[Uint8Array, number]> = [
  [ipv6('::'), 96], // unspecified, IPv4-compatible and other reserved low addresses
  [ipv6('::ffff:0:0'), 96],
  [ipv6('64:ff9b::'), 96], // NAT64 can otherwise tunnel a private IPv4 target
  [ipv6('64:ff9b:1::'), 48],
  [ipv6('100::'), 64],
  [ipv6('2001::'), 23],
  [ipv6('2001:db8::'), 32],
  [ipv6('2002::'), 16],
  [ipv6('3fff::'), 20],
  [ipv6('5f00::'), 16],
  [ipv6('fc00::'), 7],
  [ipv6('fe80::'), 10],
  [ipv6('fec0::'), 10],
  [ipv6('ff00::'), 8],
]

/** True only for an IP literal suitable for an Internet-only fetch. */
export function isPublicNetworkAddress(addressInput: string): boolean {
  let address = addressInput
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  const v4 = parseIpv4(address)
  if (v4) return !BLOCKED_IPV4.some(([prefix, bits]) => hasPrefix(v4, prefix, bits))
  const v6 = parseIpv6(address)
  if (!v6) return false

  // Only currently allocated global-unicast space is accepted. This intentionally
  // fails closed for future/reserved ranges until the policy table is updated.
  if (!hasPrefix(v6, ipv6('2000::'), 3)) return false
  return !BLOCKED_IPV6.some(([prefix, bits]) => hasPrefix(v6, prefix, bits))
}

const normalizedHostname = (url: URL): string => url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname

export async function resolvePublicAddress(
  url: URL,
  lookup: NonNullable<PublicFetchDependencies['lookup']> = async (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
): Promise<string> {
  if (url.username || url.password) throw Object.assign(new Error('URL 不允许携带 userinfo 凭据'), { code: 'URL_CREDENTIALS_FORBIDDEN' })
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只允许 HTTP(S) URL')
  const hostname = normalizedHostname(url)
  const literalFamily = isIP(hostname)
  const records = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname)
  if (!records.length || records.some((record) => !isPublicNetworkAddress(record.address))) {
    throw Object.assign(new Error('禁止访问本机、私有或其他非公网地址'), { code: 'NON_PUBLIC_ADDRESS' })
  }
  return records[0]!.address
}

export function pinnedHttpRequest(url: URL, address: string, maxBytes = MAX_PUBLIC_RESPONSE_BYTES): Promise<PinnedHttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const originalHostname = normalizedHostname(url)
    const limitLabel = maxBytes >= 1024 * 1024 && maxBytes % (1024 * 1024) === 0
      ? `${maxBytes / (1024 * 1024)} MB`
      : `${Math.ceil(maxBytes / 1024)} KB`
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: address,
      ...(url.port ? { port: Number(url.port) } : {}),
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: {
        host: url.host,
        'user-agent': 'OpenWorkbuddy/0.3.0',
        accept: 'text/plain,text/html,application/json;q=0.9,*/*;q=0.1',
        connection: 'close',
      },
      ...(url.protocol === 'https:' && isIP(originalHostname) === 0 ? { servername: originalHostname } : {}),
      ...(url.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
      signal: AbortSignal.timeout(30_000),
    }, (response) => {
      const declaredLength = Number(response.headers['content-length'] ?? 0)
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy()
        reject(Object.assign(new Error(`响应超过 ${limitLabel} 限制`), { code: 'RESPONSE_TOO_LARGE' }))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      let settled = false
      response.on('data', (chunk: Buffer | string) => {
        if (settled) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += bytes.byteLength
        if (total > maxBytes) {
          settled = true
          response.destroy(Object.assign(new Error(`响应超过 ${limitLabel} 限制`), { code: 'RESPONSE_TOO_LARGE' }))
          return
        }
        chunks.push(bytes)
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        resolvePromise({
          status: response.statusCode ?? 0,
          statusMessage: response.statusMessage ?? '',
          headers: response.headers,
          body: Buffer.concat(chunks, total),
        })
      })
      response.on('error', (error) => {
        if (settled && (error as NodeJS.ErrnoException).code !== 'RESPONSE_TOO_LARGE') return
        settled = true
        reject(error)
      })
    })
    request.on('error', reject)
    request.end()
  })
}

const firstHeader = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

interface PublicDocument {
  url: URL
  status: number
  contentType: string
  body: Buffer
}

async function fetchPublicDocument(
  urlInput: string,
  dependencies: PublicFetchDependencies,
  maxBytes: number,
  allowedHosts?: ReadonlySet<string>,
): Promise<PublicDocument> {
  let url = new URL(urlInput)
  const request = dependencies.request ?? pinnedHttpRequest
  for (let redirects = 0; redirects < 6; redirects += 1) {
    if (allowedHosts && (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase()))) {
      throw Object.assign(new Error('搜索服务重定向到了未授权主机'), { code: 'SEARCH_REDIRECT_FORBIDDEN' })
    }
    const address = await resolvePublicAddress(url, dependencies.lookup)
    const response = await request(url, address, maxBytes)
    if (response.status >= 300 && response.status < 400) {
      const location = firstHeader(response.headers, 'location')
      if (!location) throw new Error(`重定向缺少 Location (${response.status})`)
      url = new URL(location, url)
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error(`HTTP ${response.status} ${response.statusMessage}`), { code: 'HTTP_STATUS', status: response.status })
    }
    return {
      url,
      status: response.status,
      contentType: firstHeader(response.headers, 'content-type') ?? 'text/plain',
      body: response.body,
    }
  }
  throw new Error('重定向次数过多')
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', apos: "'", emsp: ' ', ensp: ' ', gt: '>', hellip: '…', lt: '<', nbsp: ' ', ndash: '–', quot: '"',
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|emsp|ensp|gt|hellip|lt|nbsp|ndash|quot);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return HTML_ENTITIES[entity.toLowerCase()] ?? match
    const codePoint = entity[1]?.toLowerCase() === 'x'
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10)
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match
    try { return String.fromCodePoint(codePoint) } catch { return match }
  })
}

function plainTextFromHtml(value: string): string {
  return decodeHtmlEntities(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?，。；：！？])/g, '$1')
    .trim()
}

function htmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes)
  return match?.[1] ?? match?.[2]
}

function normalizedSearchResultUrl(rawHref: string): string | undefined {
  try {
    let url = new URL(decodeHtmlEntities(rawHref), BING_SEARCH_ENDPOINT)
    if (DUCKDUCKGO_REDIRECT_HOSTS.has(url.hostname.toLowerCase()) && url.pathname.startsWith('/l/')) {
      const target = url.searchParams.get('uddg')
      if (!target) return undefined
      url = new URL(target)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username || url.password) return undefined
    const hostname = url.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return undefined
    if (isIP(hostname) && !isPublicNetworkAddress(hostname)) return undefined
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function parseBingResults(html: string, maxResults: number): Array<{ rank: number; title: string; url: string; snippet: string }> {
  const results: Array<{ rank: number; title: string; url: string; snippet: string }> = []
  const seen = new Set<string>()
  const blockPattern = /<li\b[^>]*class\s*=\s*(?:"[^"]*\bb_algo\b[^"]*"|'[^']*\bb_algo\b[^']*')[^>]*>([\s\S]*?)<\/li>/gi
  for (let blockMatch = blockPattern.exec(html); blockMatch && results.length < maxResults; blockMatch = blockPattern.exec(html)) {
    const block = blockMatch[1] ?? ''
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1] ?? ''
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(heading)
    const href = anchor ? htmlAttribute(anchor[1] ?? '', 'href') : undefined
    const url = href ? normalizedSearchResultUrl(href) : undefined
    const title = plainTextFromHtml(anchor?.[2] ?? '').slice(0, 300)
    if (!url || !title || seen.has(url)) continue
    const caption = /<div\b[^>]*class\s*=\s*(?:"[^"]*\bb_caption\b[^"]*"|'[^']*\bb_caption\b[^']*')[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? ''
    const snippet = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(caption)?.[1] ?? caption
    seen.add(url)
    results.push({
      rank: results.length + 1,
      title,
      url,
      snippet: plainTextFromHtml(snippet).slice(0, 600),
    })
  }
  return results
}

const truncate = (value: string, max = 128 * 1024): { text: string; truncated: boolean; total: number } => {
  const bytes = Buffer.byteLength(value)
  if (bytes <= max) return { text: value, truncated: false, total: bytes }
  const head = value.slice(0, Math.floor(max * 0.72))
  const tail = value.slice(-Math.floor(max * 0.24))
  return { text: `${head}\n\n…[已截断 ${bytes - max} bytes]…\n\n${tail}`, truncated: true, total: bytes }
}

function responseCharset(contentType: string, body: Buffer): string {
  const header = /charset\s*=\s*["']?([a-z0-9._-]+)/i.exec(contentType)?.[1]
  if (header) return header.toLowerCase()
  if (!contentType.toLowerCase().includes('html')) return 'utf-8'

  // Charset declarations are ASCII-compatible even when the document body is
  // encoded as GBK/Big5. Looking only at the first few KB avoids decoding the
  // entire page with the wrong codec just to discover its declaration.
  const head = body.subarray(0, 8 * 1024).toString('latin1')
  const meta = /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([a-z0-9._-]+)/i.exec(head)?.[1]
    ?? /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9._-]+)/i.exec(head)?.[1]
  return meta?.toLowerCase() ?? 'utf-8'
}

function decodePublicBody(contentType: string, body: Buffer): { text: string; charset: string } {
  const requested = responseCharset(contentType, body)
  try {
    const decoder = new TextDecoder(requested)
    return { text: decoder.decode(body), charset: decoder.encoding }
  } catch {
    return { text: new TextDecoder('utf-8').decode(body), charset: 'utf-8' }
  }
}

/** Fetches with a DNS-pinned socket, validating every redirect independently. */
export async function safeFetch(urlInput: string, dependencies: PublicFetchDependencies = {}): Promise<Record<string, unknown>> {
  const response = await fetchPublicDocument(urlInput, dependencies, MAX_PUBLIC_RESPONSE_BYTES)
  const decoded = decodePublicBody(response.contentType, response.body)
  const body = decoded.text
  const text = response.contentType.includes('html') ? plainTextFromHtml(body) : body
  return { url: response.url.toString(), status: response.status, contentType: response.contentType, charset: decoded.charset, ...truncate(text) }
}

/** Searches through a fixed public endpoint and returns links only; result pages are not fetched automatically. */
export async function safeWebSearch(
  queryInput: string,
  maxResultsInput = 8,
  dependencies: PublicFetchDependencies = {},
): Promise<Record<string, unknown>> {
  const query = queryInput.trim()
  if (!query || query.length > 500) throw Object.assign(new Error('搜索词长度必须为 1 到 500 个字符'), { code: 'INVALID_SEARCH_QUERY' })
  if (!Number.isInteger(maxResultsInput) || maxResultsInput < 1 || maxResultsInput > 10) {
    throw Object.assign(new Error('maxResults 必须是 1 到 10 的整数'), { code: 'INVALID_SEARCH_LIMIT' })
  }
  const searchUrl = new URL(BING_SEARCH_ENDPOINT)
  searchUrl.searchParams.set('q', query)
  searchUrl.searchParams.set('count', String(maxResultsInput))
  let response: PublicDocument
  try {
    response = await fetchPublicDocument(searchUrl.toString(), dependencies, MAX_SEARCH_RESPONSE_BYTES, BING_SEARCH_HOSTS)
  } catch (error: any) {
    if (error?.status === 403 || error?.status === 429) {
      throw Object.assign(new Error('搜索服务拒绝或限制了本次请求，请稍后重试或改用已授权 Chrome'), { code: 'SEARCH_BLOCKED' })
    }
    throw error
  }
  const html = decodePublicBody(response.contentType, response.body).text
  if (/captcha|unusual (?:traffic|activity)|verify (?:that )?you are (?:a )?human|our systems have detected/i.test(html)) {
    throw Object.assign(new Error('搜索服务要求人机验证，请改用已授权 Chrome'), { code: 'SEARCH_BLOCKED' })
  }
  const results = parseBingResults(html, maxResultsInput)
  if (results.length === 0 && !/no results(?: found)?|there are no results|没有与此相关的结果/i.test(plainTextFromHtml(html))) {
    throw Object.assign(new Error('搜索结果页面结构无法识别，请稍后重试或改用已授权 Chrome'), { code: 'SEARCH_PARSE_FAILED' })
  }
  return {
    engine: 'bing-html',
    query,
    resultCount: results.length,
    results,
  }
}

export async function resolveAuthorizedPath(rootInput: string | undefined, targetInput: string, allowMissing = false): Promise<{ root: string; target: string }> {
  if (!rootInput) throw Object.assign(new Error('未授权工作区'), { code: 'WORKSPACE_REQUIRED' })
  const root = await realpath(rootInput)
  const requested = isAbsolute(targetInput) ? resolve(targetInput) : resolve(root, targetInput)
  if (!isWithin(root, requested)) throw Object.assign(new Error('路径超出授权工作区'), { code: 'PATH_OUTSIDE_WORKSPACE' })
  let target: string
  try {
    target = await realpath(requested)
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Requiring the parent to exist avoids following an attacker-created symlink
    // while recursively creating a missing directory tree.
    const realParent = await realpath(dirname(requested))
    target = join(realParent, basename(requested))
  }
  if (!isWithin(root, target)) throw Object.assign(new Error('路径超出授权工作区'), { code: 'PATH_OUTSIDE_WORKSPACE' })
  return { root, target }
}

const assertExpectedHash = (value: unknown, field = 'expectedSha256'): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw Object.assign(new Error(`修改已有文件必须提供 ${field}`), { code: 'EXPECTED_HASH_REQUIRED' })
  }
  return value.toLowerCase()
}

const currentRegularFile = async (target: string, expected: string): Promise<{ content: Buffer; mode: number }> => {
  const currentRealPath = await realpath(target)
  if (currentRealPath !== target) throw Object.assign(new Error('文件真实路径已变化，请重新读取'), { code: 'STALE_WRITE' })
  const info = await stat(target)
  if (!info.isFile()) throw new Error('目标不是普通文件')
  const content = await readFile(target)
  if (sha256(content) !== expected) throw Object.assign(new Error('文件在读取后已变化，请重新读取'), { code: 'STALE_WRITE' })
  return { content, mode: info.mode & 0o777 }
}

const temporaryPath = (target: string): string => join(dirname(target), `.on-my-workbuddy-${process.pid}-${randomBytes(16).toString('hex')}.tmp`)

const syncDirectory = async (directory: string): Promise<void> => {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Some filesystems do not allow fsync on directories. The file itself was synced.
  } finally {
    await handle?.close().catch(() => {})
  }
}

const writeTemporaryFile = async (target: string, content: string, mode: number): Promise<string> => {
  const temp = temporaryPath(target)
  const handle = await open(temp, 'wx', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.chmod(mode)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
  await handle.close()
  return temp
}

const replaceExistingAtomically = async (target: string, content: string, expectedInput: unknown): Promise<{ before: string; beforeSha256: string; sha256: string }> => {
  const expected = assertExpectedHash(expectedInput)
  const initial = await currentRegularFile(target, expected)
  const temp = await writeTemporaryFile(target, content, initial.mode)
  try {
    // The check directly before rename is deliberate: validation performed when
    // the tool call was created is not sufficient for a later write.
    await currentRegularFile(target, expected)
    await rename(temp, target)
    await syncDirectory(dirname(target))
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  return { before: initial.content.toString('utf8'), beforeSha256: expected, sha256: sha256(content) }
}

const createFileExclusively = async (target: string, content: string): Promise<void> => {
  const parent = dirname(target)
  const realParent = await realpath(parent)
  if (join(realParent, basename(target)) !== target) throw Object.assign(new Error('目标父目录已变化，请重试'), { code: 'STALE_WRITE' })
  const temp = await writeTemporaryFile(target, content, 0o600)
  try {
    // link(2) fails with EEXIST and therefore never replaces a concurrently-created file.
    await link(temp, target)
    await unlink(temp)
    await syncDirectory(parent)
  } catch (error) {
    await unlink(temp).catch(() => {})
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw Object.assign(new Error('目标文件已由其他操作创建，请重新读取'), { code: 'STALE_WRITE' })
    }
    throw error
  }
}

export async function writeFileSafely(rootInput: string | undefined, pathInput: string, content: string, expectedSha256?: unknown): Promise<Record<string, unknown>> {
  const { target } = await resolveAuthorizedPath(rootInput, pathInput, true)
  let exists = true
  try {
    const info = await lstat(target)
    if (!info.isFile()) throw new Error('目标不是普通文件')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    exists = false
  }

  if (!exists) {
    if (expectedSha256 !== undefined && expectedSha256 !== null) {
      assertExpectedHash(expectedSha256)
      throw Object.assign(new Error('预期修改的文件已不存在，请重新读取'), { code: 'STALE_WRITE' })
    }
    await createFileExclusively(target, content)
    return { path: target, before: null, after: content, beforeSha256: null, sha256: sha256(content), created: true }
  }

  const replaced = await replaceExistingAtomically(target, content, expectedSha256)
  return { path: target, before: replaced.before, after: content, beforeSha256: replaced.beforeSha256, sha256: replaced.sha256, created: false }
}

export async function replaceFileTextSafely(
  rootInput: string | undefined,
  pathInput: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
  expectedSha256: unknown,
): Promise<Record<string, unknown>> {
  const { target } = await resolveAuthorizedPath(rootInput, pathInput)
  const expected = assertExpectedHash(expectedSha256)
  const initial = await currentRegularFile(target, expected)
  const before = initial.content.toString('utf8')
  const count = before.split(oldText).length - 1
  if (count === 0) throw new Error('未找到待替换文本')
  if (count > 1 && !replaceAll) throw new Error('待替换文本不唯一；请提供更多上下文或设置 replaceAll')
  const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText)
  const replaced = await replaceExistingAtomically(target, after, expected)
  return { path: target, before: replaced.before, after, replacements: replaceAll ? count : 1, beforeSha256: replaced.beforeSha256, sha256: replaced.sha256 }
}

export async function restoreFileSafely(
  rootInput: string | undefined,
  pathInput: string,
  content: string,
  expectedCurrentSha256: unknown,
  createdFile: boolean,
): Promise<Record<string, unknown>> {
  const { root, target } = await resolveAuthorizedPath(rootInput, pathInput)
  const expected = assertExpectedHash(expectedCurrentSha256, 'expectedCurrentSha256')
  const current = await currentRegularFile(target, expected)

  if (!createdFile) {
    const restored = await replaceExistingAtomically(target, content, expected)
    return {
      path: target,
      restored: true,
      removedCreatedFile: false,
      before: restored.before,
      after: content,
      beforeSha256: expected,
      sha256: restored.sha256,
    }
  }

  const trashInput = join(root, '.on-my-workbuddy-trash')
  await mkdir(trashInput, { mode: 0o700, recursive: true })
  const trash = await realpath(trashInput)
  if (!isWithin(root, trash)) throw Object.assign(new Error('工作区回收站路径不安全'), { code: 'PATH_OUTSIDE_WORKSPACE' })
  await currentRegularFile(target, expected)
  const destination = join(trash, `${Date.now()}-${randomBytes(12).toString('hex')}-${basename(target)}`)
  await rename(target, destination)
  await syncDirectory(dirname(target))
  await syncDirectory(trash)
  return {
    path: target,
    restored: true,
    removedCreatedFile: true,
    trashedTo: destination,
    beforeSha256: expected,
    size: current.content.byteLength,
  }
}

const plainRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue)
  const record = plainRecord(value)
  if (!record) return value
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]))
}

export const mcpConnectionFingerprint = (server: Record<string, unknown>): string => {
  const material = {
    transport: server.transport,
    config: server.config,
    secret: server.secret ?? server.secrets ?? null,
  }
  return sha256(JSON.stringify(stableValue(material)))
}

const validateHeaderRecord = (value: unknown): Record<string, string> => {
  const source = plainRecord(value)
  if (!source) return {}
  const blocked = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade'])
  const result: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(source)) {
    const name = rawName.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || blocked.has(name)) throw new Error(`MCP Header 名称不安全：${rawName}`)
    if (typeof rawValue !== 'string' || /[\r\n]/.test(rawValue)) throw new Error(`MCP Header 值无效：${rawName}`)
    result[name] = rawValue
  }
  return result
}

const secretRecord = (server: Record<string, unknown>): Record<string, unknown> | undefined => plainRecord(server.secret ?? server.secrets)

const firstString = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === 'string' && value.length > 0)

const bearerToken = (secret: unknown): string | undefined => {
  if (typeof secret === 'string') return secret || undefined
  const record = plainRecord(secret)
  const tokens = plainRecord(record?.tokens)
  return firstString(tokens?.access_token, record?.access_token, record?.accessToken, record?.bearer, record?.token, record?.credential)
}

const customSecretHeaders = (secret: unknown): Record<string, string> => {
  if (typeof secret === 'string') {
    try { return validateHeaderRecord(JSON.parse(secret)) } catch { throw new Error('自定义 Header Secret 必须是 JSON 对象') }
  }
  const record = plainRecord(secret)
  if (!record) return {}
  if (record.headers !== undefined) return validateHeaderRecord(record.headers)
  if (typeof record.credential === 'string') {
    try { return validateHeaderRecord(JSON.parse(record.credential)) } catch { throw new Error('自定义 Header credential 必须是 JSON 对象') }
  }
  return validateHeaderRecord(record)
}

export function prepareMcpConnection(server: Record<string, unknown>): PreparedMcpConnection {
  const config = plainRecord(server.config) ?? {}
  const fingerprint = mcpConnectionFingerprint(server)
  if (server.transport === 'stdio' || config.type === 'stdio') {
    if (typeof config.command !== 'string' || !config.command) throw new Error('stdio MCP 缺少 command')
    const args = Array.isArray(config.args) && config.args.every((value) => typeof value === 'string') ? config.args as string[] : []
    const envKeys = Array.isArray(config.envKeys) && config.envKeys.every((value) => typeof value === 'string') ? config.envKeys as string[] : []
    const secrets = secretRecord(server)
    const nestedEnvironment = plainRecord(secrets?.env)
    const secretEnvironment: Record<string, string> = {}
    for (const key of envKeys) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`MCP 环境变量名无效：${key}`)
      const value = firstString(nestedEnvironment?.[key], secrets?.[key])
      if (!value) throw new Error(`MCP 缺少允许注入的 Secret：${key}`)
      secretEnvironment[key] = value
    }
    return {
      fingerprint,
      transport: 'stdio',
      stdio: {
        command: config.command,
        args,
        ...(typeof config.cwd === 'string' && config.cwd ? { cwd: config.cwd } : {}),
        secretEnvironment,
      },
    }
  }

  if (typeof config.url !== 'string') throw new Error('HTTP MCP 缺少 URL')
  const url = new URL(config.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('HTTP MCP URL 必须使用 HTTP(S)')
  if (url.username || url.password) throw new Error('HTTP MCP URL 不允许携带 userinfo 凭据')
  const auth = typeof config.auth === 'string' ? config.auth : 'none'
  const headers = validateHeaderRecord(config.headers)
  const secret = server.secret ?? server.secrets
  if (auth === 'bearer' || auth === 'oauth') {
    const token = bearerToken(secret)
    if (!token) throw new Error(auth === 'oauth' ? 'MCP OAuth access token 缺失' : 'MCP Bearer token 缺失')
    if (/[\r\n]/.test(token)) throw new Error('MCP access token 包含非法换行')
    headers.authorization = `Bearer ${token}`
  } else if (auth === 'headers') {
    Object.assign(headers, customSecretHeaders(secret))
  } else if (auth !== 'none') {
    throw new Error(`不支持的 MCP HTTP 认证类型：${auth}`)
  }
  return { fingerprint, transport: 'http', http: { url, headers } }
}
