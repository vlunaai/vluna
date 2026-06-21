import { describe, expect, it, vi, beforeEach } from 'vitest'
import { TokenController } from '../../src/security/token.controller.js'
import type { PlatformTokenService } from '../../src/security/platform-token.service.js'
import type { AppRequest } from '../../src/types/app-request.js'
import type { Mock } from 'vitest'

vi.mock('../../src/security/principal/billing-account.resolver.js', () => ({
  ensureBillingAccount: vi.fn(),
  ensureBillingUser: vi.fn(),
}))

vi.mock('../../src/services/billing-plan.service.js', () => ({
  ensureBillingPlanGrantsEnrollmentSynced: vi.fn(async () => undefined),
  ensureBillingPlanGrantsEnrollmentSyncedForUser: vi.fn(async () => undefined),
  issueGrantsForAccount: vi.fn(async () => undefined),
  issueGrantsForBillingUser: vi.fn(async () => undefined),
}))

const { ensureBillingAccount, ensureBillingUser } = await import('../../src/security/principal/billing-account.resolver.js')

describe('TokenController.issuePlatformToken', { tags: ['api'] }, () => {
  const platformTokenService = {
    issue: vi.fn(),
  }

  beforeEach(() => {
    vi.resetAllMocks()
  })

  const makeReq = (overrides: Partial<AppRequest> = {}): AppRequest => ({
    ctx: {
      realmId: 'realm1',
      realmConfig: { realmId: 'r1', paymentProvider: 'stripe', auth: { issuers: [{ issuer: 'https://issuer', audiences: ['api://billing'] }] } },
      serviceApiKey: { keyId: 'k1' },
      ...overrides.ctx,
    },
    headers: {},
    ...overrides,
  } as AppRequest)

  it('returns token payload on success', async () => {
    ;(ensureBillingAccount as Mock).mockResolvedValue({ billingAccountId: 'ba-123' })
    ;(ensureBillingUser as Mock).mockResolvedValue({ billingUserId: 'bu-123', businessUserId: 'u1' })
    platformTokenService.issue.mockResolvedValue({
      accessToken: 'tok',
      expiresIn: 900,
      expiresAt: new Date('2025-01-01T00:00:00Z'),
    })
    const controller = new TokenController(platformTokenService as unknown as PlatformTokenService)

    const req = makeReq()
    const res = await controller.issuePlatformToken(req, {
      principal_id: 'p1',
      user_id: 'u1',
      scopes: ['checkout'],
      session_ttl_sec: 600,
    })

    expect(res.ok).toBe(true)
    expect(res.data?.access_token).toBe('tok')
    expect(platformTokenService.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        realmId: 'realm1',
        principalId: 'p1',
        userId: 'u1',
        billingAccountId: 'ba-123',
        billingUserId: 'bu-123',
        ttlSeconds: 600,
      }),
    )
  })

  it('rejects when service key is not allowed for the resolved account', async () => {
    ;(ensureBillingAccount as Mock).mockResolvedValue({ billingAccountId: 'ba-123' })
    const controller = new TokenController(platformTokenService as unknown as PlatformTokenService)
    const req = makeReq({
      ctx: {
        realmId: 'realm1',
        realmConfig: { realmId: 'r1', paymentProvider: 'stripe', auth: { issuers: [{ issuer: 'https://issuer', audiences: ['api://billing'] }] } },
        serviceApiKey: {
          keyId: 'k1',
          status: 'active',
          envTag: 'local',
          scopes: [],
          allowedRealms: [],
          allowedAccounts: ['ba-other'],
          signature: { timestampISO: '2025-01-01T00:00:00Z', nonce: 'n', algorithm: 'HMAC-SHA256' },
          canonicalRequest: 'canon',
        },
      } as AppRequest['ctx'],
    })

    await expect(controller.issuePlatformToken(req, {
      principal_id: 'p1',
      user_id: 'u1',
      session_ttl_sec: 600,
    })).rejects.toBeInstanceOf(Error)
    expect(ensureBillingUser).not.toHaveBeenCalled()
    expect(platformTokenService.issue).not.toHaveBeenCalled()
  })

  it('throws when realm missing', async () => {
    const controller = new TokenController(platformTokenService as unknown as PlatformTokenService)
    const req = makeReq({
      ctx: { realmId: undefined, realmConfig: { realmId: 'r1', paymentProvider: 'stripe', auth: { issuers: [{ issuer: '', audiences: ['a'] }] } } } as AppRequest['ctx'],
    })
    await expect(controller.issuePlatformToken(req, { principal_id: 'p', user_id: 'u', session_ttl_sec: 900 })).rejects.toBeInstanceOf(Error)
  })

  it('validates required principal and user ids', async () => {
    const controller = new TokenController(platformTokenService as unknown as PlatformTokenService)
    const req = makeReq()
    await expect(controller.issuePlatformToken(req, { user_id: 'u', session_ttl_sec: 900, principal_id: '' })).rejects.toBeInstanceOf(Error)
    await expect(controller.issuePlatformToken(req, { principal_id: 'p', session_ttl_sec: 900, user_id: '' })).rejects.toBeInstanceOf(Error)
  })
})
