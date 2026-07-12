import { describe, expect, it, vi } from 'vitest'

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

import {
  MCP_OAUTH_CALLBACK_URL,
  McpOAuthService,
  type McpOAuthAuthFunction,
  type McpOAuthStoredSecret,
} from './mcp-oauth'

const VERIFIER = 'v'.repeat(64)

function successfulAuth(onComplete?: () => void): McpOAuthAuthFunction {
  return vi.fn(async (provider: OAuthClientProvider, options) => {
    if (options.authorizationCode === undefined) {
      await provider.saveDiscoveryState?.({
        authorizationServerUrl: 'https://auth.example.com',
        authorizationServerMetadata: {
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        },
      })
      await provider.saveClientInformation?.({ client_id: 'desktop-client' })
      await provider.saveCodeVerifier(VERIFIER)
      const state = await provider.state?.()
      await provider.redirectToAuthorization(new URL(`https://auth.example.com/authorize?state=${state}`))
      return 'REDIRECT'
    }

    expect(options.authorizationCode).toBe('authorization-code')
    expect(await provider.codeVerifier()).toBe(VERIFIER)
    await provider.saveTokens({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      token_type: 'Bearer',
      expires_in: 3_600,
      scope: 'tools:read',
    })
    onComplete?.()
    return 'AUTHORIZED'
  })
}

const fixedRandom = (): Uint8Array => new Uint8Array(32).fill(7)

describe('McpOAuthService', () => {
  it('refreshes an expiring stored token without opening an interactive flow', async () => {
    let stored: McpOAuthStoredSecret = {
      clientInformation: { client_id: 'desktop-client' },
      discoveryState: { authorizationServerUrl: 'https://auth.example.com' },
      tokens: { access_token: 'expired', refresh_token: 'refresh-secret', token_type: 'Bearer', expires_in: 1 },
      tokenExpiresAt: 1_000,
    }
    const authFunction: McpOAuthAuthFunction = vi.fn(async (provider) => {
      expect(await provider.tokens()).toMatchObject({ access_token: 'expired', refresh_token: 'refresh-secret' })
      await provider.saveTokens({ access_token: 'refreshed', token_type: 'Bearer', expires_in: 3_600 })
      return 'AUTHORIZED' as const
    })
    const service = new McpOAuthService({
      authFunction,
      now: () => 2_000,
      persistence: {
        load: () => stored,
        save: (_serverId, secret) => { stored = structuredClone(secret) },
      },
    })

    const secret = await service.refreshOAuthIfNeeded('refresh-server', 'https://mcp.example.com/mcp')

    expect(secret.tokens).toMatchObject({ access_token: 'refreshed', refresh_token: 'refresh-secret' })
    expect(secret.tokenExpiresAt).toBe(3_602_000)
    expect(authFunction).toHaveBeenCalledOnce()
  })

  it('uses the SDK provider flow and returns a persistable token secret without state or PKCE', async () => {
    const saves: McpOAuthStoredSecret[] = []
    const authFunction = successfulAuth()
    const service = new McpOAuthService({
      authFunction,
      randomBytes: fixedRandom,
      persistence: {
        load: () => ({ tokens: { access_token: 'old', token_type: 'Bearer' } }),
        save: (_serverId, secret) => { saves.push(structuredClone(secret)) },
      },
    })

    const started = await service.startOAuth('server-1', 'https://mcp.example.com/mcp')

    expect(started.authorizationUrl).toContain('https://auth.example.com/authorize')
    expect(new URL(started.authorizationUrl).searchParams.get('state')).toBe(started.state)
    expect(authFunction).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      serverUrl: new URL('https://mcp.example.com/mcp'),
      fetchFn: expect.any(Function),
    }))

    const secret = await service.completeOAuth(
      'server-1',
      `${MCP_OAUTH_CALLBACK_URL}?code=authorization-code&state=${started.state}`,
      started.state,
    )

    expect(secret).toEqual(expect.objectContaining({
      clientInformation: { client_id: 'desktop-client' },
      tokens: {
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        token_type: 'Bearer',
        expires_in: 3_600,
        scope: 'tools:read',
      },
    }))
    expect(secret.discoveryState?.authorizationServerUrl).toBe('https://auth.example.com')
    expect(secret).not.toHaveProperty('state')
    expect(secret).not.toHaveProperty('codeVerifier')
    expect(saves.at(-1)).toEqual(secret)
  })

  it('requires HTTPS while allowing explicit localhost development URLs', async () => {
    const authFunction = successfulAuth()
    const service = new McpOAuthService({ authFunction, randomBytes: fixedRandom })

    await expect(service.startOAuth('remote', 'http://mcp.example.com/mcp')).rejects.toThrow('必须使用 HTTPS')
    await expect(service.startOAuth('lookalike', 'http://localhost.example.com/mcp')).rejects.toThrow('必须使用 HTTPS')
    await expect(service.startOAuth('credentials', 'https://user:pass@mcp.example.com/mcp')).rejects.toThrow('不允许在 URL 中携带凭据')

    await expect(service.startOAuth('local', 'http://localhost:3131/mcp')).resolves.toEqual({
      authorizationUrl: expect.stringContaining('https://auth.example.com/authorize'),
      state: expect.any(String),
    })
  })

  it('validates the exact callback and both copies of state without consuming a valid pending flow', async () => {
    let completed = 0
    const service = new McpOAuthService({
      authFunction: successfulAuth(() => { completed += 1 }),
      randomBytes: fixedRandom,
    })
    const started = await service.startOAuth('server-state', 'https://mcp.example.com/mcp')
    const valid = `${MCP_OAUTH_CALLBACK_URL}?code=authorization-code&state=${started.state}`

    await expect(service.completeOAuth('server-state', valid, 'wrong-state')).rejects.toThrow('state 校验失败')
    await expect(service.completeOAuth(
      'server-state',
      `otherapp://oauth/callback?code=authorization-code&state=${started.state}`,
      started.state,
    )).rejects.toThrow(`必须使用 ${MCP_OAUTH_CALLBACK_URL}`)
    await expect(service.completeOAuth(
      'server-state',
      `${MCP_OAUTH_CALLBACK_URL}?code=authorization-code&state=wrong-state`,
      started.state,
    )).rejects.toThrow('state 校验失败')

    await expect(service.completeOAuth('server-state', valid, started.state)).resolves.toHaveProperty('tokens.access_token', 'access-secret')
    expect(completed).toBe(1)
    await expect(service.completeOAuth('server-state', valid, started.state)).rejects.toThrow('已经完成')
  })

  it('expires flows and consumes state when the authorization server returns an OAuth error', async () => {
    let now = 1_000
    const expiredService = new McpOAuthService({
      authFunction: successfulAuth(),
      randomBytes: fixedRandom,
      now: () => now,
      flowTtlMs: 30_000,
    })
    const expired = await expiredService.startOAuth('expired', 'https://mcp.example.com/mcp')
    now += 30_001
    await expect(expiredService.completeOAuth(
      'expired',
      `${MCP_OAUTH_CALLBACK_URL}?code=authorization-code&state=${expired.state}`,
      expired.state,
    )).rejects.toThrow('已过期')

    const deniedService = new McpOAuthService({ authFunction: successfulAuth(), randomBytes: fixedRandom })
    const denied = await deniedService.startOAuth('denied', 'https://mcp.example.com/mcp')
    const deniedCallback = `${MCP_OAUTH_CALLBACK_URL}?error=access_denied&error_description=No&state=${denied.state}`
    await expect(deniedService.completeOAuth('denied', deniedCallback, denied.state)).rejects.toThrow('access_denied (No)')
    await expect(deniedService.completeOAuth('denied', deniedCallback, denied.state)).rejects.toThrow('已经完成')
  })

  it('rejects duplicate security parameters before exchanging a code', async () => {
    const authFunction = successfulAuth()
    const service = new McpOAuthService({ authFunction, randomBytes: fixedRandom })
    const started = await service.startOAuth('duplicates', 'https://mcp.example.com/mcp')
    const callback = `${MCP_OAUTH_CALLBACK_URL}?code=authorization-code&code=other&state=${started.state}`

    await expect(service.completeOAuth('duplicates', callback, started.state)).rejects.toThrow('重复的 code')
    expect(authFunction).toHaveBeenCalledTimes(1)
  })
})
