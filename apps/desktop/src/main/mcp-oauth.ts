import { randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto'

import {
  auth,
  type AuthResult,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

export const MCP_OAUTH_CALLBACK_URL = 'onmyworkbuddy://oauth/callback'

const DEFAULT_FLOW_TTL_MS = 10 * 60 * 1_000
const MIN_FLOW_TTL_MS = 30_000
const MAX_FLOW_TTL_MS = 60 * 60 * 1_000

type MaybePromise<T> = T | Promise<T>

/**
 * The serializable OAuth material that the Electron main process may encrypt
 * with safeStorage before writing it to the MCP server row.
 *
 * The OAuth `state` and PKCE verifier are deliberately absent: they are
 * short-lived, process-local flow data and must never be persisted.
 */
export interface McpOAuthStoredSecret {
  clientInformation?: OAuthClientInformationMixed
  discoveryState?: OAuthDiscoveryState
  tokens?: OAuthTokens
  tokenExpiresAt?: number
}

export interface McpOAuthTokenSecret extends McpOAuthStoredSecret {
  tokens: OAuthTokens
}

export interface McpOAuthPersistence {
  load(serverId: string): MaybePromise<McpOAuthStoredSecret | undefined>
  save(serverId: string, secret: McpOAuthStoredSecret): MaybePromise<void>
}

export type McpOAuthAuthFunction = (
  provider: OAuthClientProvider,
  options: Parameters<typeof auth>[1],
) => Promise<AuthResult>

export interface McpOAuthServiceOptions {
  persistence?: Partial<McpOAuthPersistence>
  /** Primarily for deterministic tests; production should use the SDK auth orchestrator. */
  authFunction?: McpOAuthAuthFunction
  fetchFunction?: FetchLike
  randomBytes?: (size: number) => Uint8Array
  now?: () => number
  flowTtlMs?: number
}

interface PendingFlow {
  serverUrl: URL
  state: string
  provider: HostOAuthProvider
  createdAt: number
}

const CLIENT_METADATA: OAuthClientMetadata = {
  client_name: 'On My WorkBuddy',
  redirect_uris: [MCP_OAUTH_CALLBACK_URL],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  // A desktop app is a public client. PKCE protects the authorization code;
  // no client secret is embedded in the application bundle.
  token_endpoint_auth_method: 'none',
}

const clone = <T>(value: T): T => structuredClone(value)

const assertServerId = (serverId: string): void => {
  if (!serverId || serverId !== serverId.trim() || serverId.length > 256) {
    throw new Error('MCP Server ID 无效')
  }
}

const isLocalDevelopmentHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]'
}

const secureHttpUrl = (value: string | URL, label: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} 不是有效 URL`)
  }

  if (!url.hostname || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error(`${label} 必须使用 HTTP(S)`)
  }
  if (url.protocol !== 'https:' && !isLocalDevelopmentHost(url.hostname)) {
    throw new Error(`${label} 必须使用 HTTPS；仅 localhost 开发环境可使用 HTTP`)
  }
  if (url.username || url.password) throw new Error(`${label} 不允许在 URL 中携带凭据`)
  if (url.hash) throw new Error(`${label} 不允许包含 fragment`)
  return url
}

const callbackUrl = (value: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('OAuth 回调不是有效 URL')
  }

  if (
    url.protocol !== 'onmyworkbuddy:'
    || url.hostname !== 'oauth'
    || url.port !== ''
    || url.pathname !== '/callback'
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
  ) {
    throw new Error(`OAuth 回调必须使用 ${MCP_OAUTH_CALLBACK_URL}`)
  }
  return url
}

const singleParameter = (url: URL, name: string): string | undefined => {
  const values = url.searchParams.getAll(name)
  if (values.length > 1) throw new Error(`OAuth 回调包含重复的 ${name} 参数`)
  const value = values[0]
  return value ? value : undefined
}

const equalSecret = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

class HostOAuthProvider implements OAuthClientProvider {
  private readonly stored: McpOAuthStoredSecret
  private authorizationUrlValue: URL | undefined
  private codeVerifierValue: string | undefined

  constructor(
    private readonly serverId: string,
    private readonly stateValue: string,
    initial: McpOAuthStoredSecret,
    private readonly saveStored?: McpOAuthPersistence['save'],
    private readonly useStoredTokens = false,
    private readonly now: () => number = Date.now,
  ) {
    this.stored = clone(initial)
  }

  get redirectUrl(): string {
    return MCP_OAUTH_CALLBACK_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    return clone(CLIENT_METADATA)
  }

  state(): string {
    return this.stateValue
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.stored.clientInformation ? clone(this.stored.clientInformation) : undefined
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.stored.clientInformation = clone(clientInformation)
    await this.persist()
  }

  /** Starting this service always means beginning a fresh interactive flow. */
  tokens(): OAuthTokens | undefined {
    return this.useStoredTokens && this.stored.tokens ? clone(this.stored.tokens) : undefined
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    if (!tokens.access_token || !tokens.token_type) throw new Error('OAuth Server 返回了无效令牌')
    this.stored.tokens = clone({
      ...tokens,
      ...(tokens.refresh_token ? {} : this.stored.tokens?.refresh_token ? { refresh_token: this.stored.tokens.refresh_token } : {}),
    })
    if (typeof tokens.expires_in === 'number') this.stored.tokenExpiresAt = this.now() + Math.max(0, tokens.expires_in) * 1_000
    else delete this.stored.tokenExpiresAt
    await this.persist()
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrlValue = new URL(authorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (codeVerifier.length < 43 || codeVerifier.length > 128) {
      throw new Error('OAuth PKCE verifier 长度无效')
    }
    this.codeVerifierValue = codeVerifier
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) throw new Error('OAuth PKCE verifier 不存在或已失效')
    return this.codeVerifierValue
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.stored.discoveryState ? clone(this.stored.discoveryState) : undefined
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.stored.discoveryState = clone(state)
    await this.persist()
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'client') delete this.stored.clientInformation
    if (scope === 'all' || scope === 'tokens') delete this.stored.tokens
    if (scope === 'all' || scope === 'discovery') delete this.stored.discoveryState
    if (scope === 'all' || scope === 'verifier') this.codeVerifierValue = undefined
    if (scope !== 'verifier') await this.persist()
  }

  authorizationUrl(): URL | undefined {
    return this.authorizationUrlValue ? new URL(this.authorizationUrlValue) : undefined
  }

  snapshot(): McpOAuthStoredSecret {
    return clone(this.stored)
  }

  private async persist(): Promise<void> {
    await this.saveStored?.(this.serverId, this.snapshot())
  }
}

/**
 * Main-process OAuth host for Streamable HTTP MCP servers.
 *
 * It delegates OAuth discovery, dynamic client registration, PKCE generation,
 * and token exchange to the official MCP TypeScript SDK. A flow cannot survive
 * an application restart because its state and PKCE verifier intentionally live
 * only in this service instance.
 */
export class McpOAuthService {
  private readonly pending = new Map<string, PendingFlow>()
  private readonly busy = new Set<string>()
  private readonly authFunction: McpOAuthAuthFunction
  private readonly fetchFunction: FetchLike
  private readonly randomBytes: (size: number) => Uint8Array
  private readonly now: () => number
  private readonly flowTtlMs: number

  constructor(private readonly options: McpOAuthServiceOptions = {}) {
    this.authFunction = options.authFunction ?? auth
    const baseFetch: FetchLike = options.fetchFunction ?? ((url, init) => fetch(url, init))
    this.fetchFunction = (url, init) => baseFetch(secureHttpUrl(url, 'OAuth endpoint'), init)
    this.randomBytes = options.randomBytes ?? cryptoRandomBytes
    this.now = options.now ?? Date.now
    this.flowTtlMs = options.flowTtlMs ?? DEFAULT_FLOW_TTL_MS
    if (this.flowTtlMs < MIN_FLOW_TTL_MS || this.flowTtlMs > MAX_FLOW_TTL_MS) {
      throw new Error(`OAuth flowTtlMs 必须在 ${MIN_FLOW_TTL_MS}-${MAX_FLOW_TTL_MS} 毫秒之间`)
    }
  }

  async startOAuth(serverId: string, serverUrl: string): Promise<{ authorizationUrl: string; state: string }> {
    assertServerId(serverId)
    const validatedServerUrl = secureHttpUrl(serverUrl, 'MCP Server URL')

    return this.exclusive(serverId, async () => {
      const state = Buffer.from(this.randomBytes(32)).toString('base64url')
      if (state.length < 32) throw new Error('无法生成安全的 OAuth state')
      const initial = clone(await this.options.persistence?.load?.(serverId) ?? {})
      const saveStored = this.options.persistence?.save
        ? (id: string, secret: McpOAuthStoredSecret) => this.options.persistence!.save!(id, secret)
        : undefined
      const provider = new HostOAuthProvider(serverId, state, initial, saveStored, false, this.now)
      const result = await this.authFunction(provider, {
        serverUrl: validatedServerUrl,
        fetchFn: this.fetchFunction,
      })
      if (result !== 'REDIRECT') throw new Error('OAuth SDK 未返回授权重定向')

      const authorizationUrl = provider.authorizationUrl()
      if (!authorizationUrl) throw new Error('OAuth SDK 未提供授权 URL')
      const validatedAuthorizationUrl = secureHttpUrl(authorizationUrl, 'OAuth authorization URL')
      const returnedState = validatedAuthorizationUrl.searchParams.get('state')
      if (returnedState === null || !equalSecret(returnedState, state)) {
        throw new Error('OAuth SDK 返回的授权 URL state 不一致')
      }

      this.pending.set(serverId, {
        serverUrl: validatedServerUrl,
        state,
        provider,
        createdAt: this.now(),
      })
      return { authorizationUrl: validatedAuthorizationUrl.toString(), state }
    })
  }

  async completeOAuth(
    serverId: string,
    callback: string,
    state: string,
  ): Promise<McpOAuthTokenSecret> {
    assertServerId(serverId)
    if (!state || state.length > 1_024) throw new Error('OAuth state 无效')

    return this.exclusive(serverId, async () => {
      const pending = this.pending.get(serverId)
      if (!pending) throw new Error('尚未开始 OAuth 授权，或授权流程已经完成')
      if (this.now() - pending.createdAt > this.flowTtlMs) {
        this.pending.delete(serverId)
        throw new Error('OAuth 授权流程已过期，请重新开始')
      }

      const parsedCallback = callbackUrl(callback)
      const callbackState = singleParameter(parsedCallback, 'state')
      if (!callbackState || !equalSecret(state, pending.state) || !equalSecret(callbackState, pending.state)) {
        throw new Error('OAuth state 校验失败')
      }

      const oauthError = singleParameter(parsedCallback, 'error')
      if (oauthError) {
        this.pending.delete(serverId)
        const description = singleParameter(parsedCallback, 'error_description')
        throw new Error(`OAuth 授权失败：${oauthError}${description ? ` (${description})` : ''}`)
      }

      const code = singleParameter(parsedCallback, 'code')
      if (!code) throw new Error('OAuth 回调缺少 authorization code')

      // Consume the state before exchanging the one-time authorization code so
      // concurrent or replayed callbacks cannot exchange it twice.
      this.pending.delete(serverId)
      const result = await this.authFunction(pending.provider, {
        serverUrl: pending.serverUrl,
        authorizationCode: code,
        fetchFn: this.fetchFunction,
      })
      if (result !== 'AUTHORIZED') throw new Error('OAuth SDK 未完成令牌交换')

      const secret = pending.provider.snapshot()
      if (!secret.tokens?.access_token || !secret.tokens.token_type) {
        throw new Error('OAuth SDK 未返回有效令牌')
      }
      return { ...secret, tokens: secret.tokens }
    })
  }

  /** Refreshes a stored access token before expiry without opening a browser. */
  async refreshOAuthIfNeeded(serverId: string, serverUrl: string): Promise<McpOAuthTokenSecret> {
    assertServerId(serverId)
    const validatedServerUrl = secureHttpUrl(serverUrl, 'MCP Server URL')
    return this.exclusive(serverId, async () => {
      const initial = clone(await this.options.persistence?.load?.(serverId) ?? {})
      if (!initial.tokens?.access_token || !initial.tokens.token_type) throw new Error('MCP OAuth access token 缺失，请重新授权')
      if (!initial.tokenExpiresAt || initial.tokenExpiresAt > this.now() + 60_000) {
        return { ...initial, tokens: initial.tokens }
      }
      if (!initial.tokens.refresh_token) throw new Error('MCP OAuth 令牌已过期且没有 refresh token，请重新授权')
      const saveStored = this.options.persistence?.save
        ? (id: string, secret: McpOAuthStoredSecret) => this.options.persistence!.save!(id, secret)
        : undefined
      const provider = new HostOAuthProvider(serverId, '', initial, saveStored, true, this.now)
      const result = await this.authFunction(provider, { serverUrl: validatedServerUrl, fetchFn: this.fetchFunction })
      if (result !== 'AUTHORIZED') throw new Error('MCP OAuth 自动刷新失败，请重新授权')
      const secret = provider.snapshot()
      if (!secret.tokens?.access_token || !secret.tokens.token_type) throw new Error('MCP OAuth 自动刷新未返回有效令牌')
      return { ...secret, tokens: secret.tokens }
    })
  }

  private async exclusive<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    if (this.busy.has(serverId)) throw new Error('该 MCP Server 的 OAuth 操作正在进行')
    this.busy.add(serverId)
    try {
      return await operation()
    } finally {
      this.busy.delete(serverId)
    }
  }
}
