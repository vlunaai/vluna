import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PlatformTokenService, PlatformTokenError } from '../../src/security/platform-token.service.js'
import { ServiceApiKeyService } from '../../src/security/service-api-key.service.js'

const ORIGINAL_ENV = { ...process.env }

describe('PlatformTokenService', { tags: ['unit'] }, () => {
  beforeEach(() => {
    process.env.BILLING_MASTER_KEY = '616263' // 'abc' hex
    process.env.NODE_ENV = 'local'
    process.env.VLUNA_PLATFORM_TOKEN_ISSUER = 'https://issuer.test'
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('issues and verifies a platform token with traits/scopes', async () => {
    const keyService = new ServiceApiKeyService()
    const tokenService = new PlatformTokenService(keyService)

    const res = await tokenService.issue({
      realmId: 'realm_test',
      principalId: 'user_123',
      userId: 'user_123',
      billingAccountId: 'ba_123',
      billingUserId: 'bu_123',
      ttlSeconds: 300,
      platformScopes: ['checkout', 'checkout'], // dedupe
      billingScopes: ['billing:read', 'billing:write'],
      audience: 'test-audience',
      nonce: 'abc',
      traits: { email: 'user@example.com', ignore: undefined },
      issuedByServiceKeyId: 'svc_test',
    })

    expect(res.expiresIn).toBe(300)
    expect(res.claims.realm_id).toBe('realm_test')
    expect(res.claims.billing_account_id).toBe('ba_123')
    expect(res.claims.billing_user_id).toBe('bu_123')
    expect(res.claims.plt_scopes).toEqual(['checkout'])
    expect(res.claims.plt_traits).toMatchObject({ email: 'user@example.com' })
    expect(res.claims.ib).toBe('svc_test')
    expect(res.claims.nonce).toBe('abc')

    const verified = await tokenService.verify(res.accessToken, { audience: 'test-audience' })
    expect(verified.realm_id).toBe('realm_test')
    expect(verified.billing_account_id).toBe('ba_123')
    expect(verified.billing_user_id).toBe('bu_123')
    expect(verified.plt_scopes).toEqual(['checkout'])
    expect(verified.tu).toBe('plt')
  })

  it('clamps ttl to min/max and defaults on invalid', async () => {
    const keyService = new ServiceApiKeyService()
    const tokenService = new PlatformTokenService(keyService)

    const short = await tokenService.issue({
      realmId: 'realm_ttl',
      principalId: 'u',
      userId: 'u',
      billingAccountId: 'ba',
      billingUserId: 'bu',
      ttlSeconds: 10, // below min 60
      platformScopes: [],
      billingScopes: [],
    })
    expect(short.expiresIn).toBe(60)

    const long = await tokenService.issue({
      realmId: 'realm_ttl',
      principalId: 'u',
      userId: 'u',
      billingAccountId: 'ba',
      billingUserId: 'bu',
      ttlSeconds: 10_000, // above max 3600
      platformScopes: [],
      billingScopes: [],
    })
    expect(long.expiresIn).toBe(3600)

    const fallback = await tokenService.issue({
      realmId: 'realm_ttl',
      principalId: 'u',
      userId: 'u',
      billingAccountId: 'ba',
      billingUserId: 'bu',
      // NaN → default 900
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ttlSeconds: 'not-a-number' as any,
      platformScopes: [],
      billingScopes: [],
    })
    expect(fallback.expiresIn).toBe(900)
  })

  it('rejects token with bad audience or kid format', async () => {
    const keyService = new ServiceApiKeyService()
    const tokenService = new PlatformTokenService(keyService)

    const res = await tokenService.issue({
      realmId: 'realm_test',
      principalId: 'p',
      userId: 'p',
      billingAccountId: 'ba',
      billingUserId: 'bu',
      ttlSeconds: 300,
      platformScopes: [],
      billingScopes: [],
      audience: 'expected',
    })

    await expect(tokenService.verify(res.accessToken, { audience: 'wrong' })).rejects.toBeInstanceOf(PlatformTokenError)
    await expect(tokenService.verify('not-a-jwt')).rejects.toBeInstanceOf(PlatformTokenError)
  })
})
