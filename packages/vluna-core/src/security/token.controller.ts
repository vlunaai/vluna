import { Body, Controller, Post, Req, UseGuards, UseInterceptors, HttpException, Inject, HttpCode } from '@nestjs/common'
import { RealmGuard } from '../auth/guards/realm.guard.js'
import { AuthRequiredGuard } from '../auth/guards/auth-required.guard.js'
import { ServiceAuthGuard } from '../auth/guards/service-auth.guard.js'
import { TokenClaimsGuard } from '../auth/guards/token-claims.guard.js'
import { IdempotencyInterceptor } from '../support/idempotency.interceptor.js'
import { PlatformTokenService } from './platform-token.service.js'
import type { operations as BillingOps } from '../contracts/billing.js'
import { JsonRequestBody, JsonResponse } from '../contracts/openapi-helpers.js'
import type { AppRequest } from '../types/app-request.js'
import { okEnvelope } from '../common/envelope.js'
import { ensureBillingAccount, ensureBillingUser } from './principal/billing-account.resolver.js'
import { Audit } from '../support/audit/audit.decorator.js'
import { ensureBillingPlanGrantsEnrollmentSyncedForUser, issueGrantsForBillingUser } from '../services/billing-plan.service.js'
import { db as coreDb } from '../db/index.js'

type IssueTokenBody = JsonRequestBody<BillingOps, 'issuePlatformToken'>
type IssueToken200 = JsonResponse<BillingOps, 'issuePlatformToken', 200>

@Controller('token')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard)
export class TokenController {
  constructor(@Inject(PlatformTokenService) private readonly platformTokenService: PlatformTokenService) {}

  @Post('issue')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'platform_token.issue',
    operationId: 'issuePlatformToken',
    targetType: 'platform_token',
  })
  async issuePlatformToken(@Req() req: AppRequest, @Body() body: IssueTokenBody): Promise<IssueToken200> {
    const realmId = String(req?.ctx?.realmId || '').trim()
    if (!realmId) {
      throw new HttpException('missing_realm', 400)
    }
    const principalId = String(body?.principal_id || '').trim()
    const userId = String(body?.user_id || '').trim()
    if (!principalId) {
      throw new HttpException('missing_principal', 422)
    }
    if (!userId) {
      throw new HttpException('missing_user_id', 422)
    }

    const platformScopes = this.normalizePlatformScopes(body?.scopes)
    const billingScopes = this.mapToBillingScopes(platformScopes)
    const ttl = typeof body?.session_ttl_sec === 'number' ? body.session_ttl_sec : 900
    const audienceRaw = req.ctx?.realmConfig?.auth?.issuers?.[0]?.audiences?.[0]
    const audience = typeof audienceRaw === 'string' && audienceRaw.trim() ? audienceRaw.trim() : undefined

    const account = await ensureBillingAccount({ realmId, principalId, autoCreate: true, ctx: req.ctx })
    if (!account) {
      throw new HttpException('billing_account_not_found', 404)
    }
    this.assertServiceKeyAllowsAccount(req, account.billingAccountId)
    req.ctx = req.ctx || {}
    req.ctx.billingAccountId = account.billingAccountId
    req.ctx.billingAccount = account
    const billingUser = await ensureBillingUser({
      realmId,
      billingAccountId: account.billingAccountId,
      userId,
      autoCreate: true,
      ctx: req.ctx,
    })
    if (!billingUser) {
      throw new HttpException('billing_user_not_found', 404)
    }
    const dbHandle = req.ctx.db ?? coreDb()
    await ensureBillingPlanGrantsEnrollmentSyncedForUser(dbHandle, account.billingAccountId, billingUser.billingUserId)
    await issueGrantsForBillingUser(dbHandle, account.billingAccountId, billingUser.billingUserId)

    const issueResult = await this.platformTokenService.issue({
      realmId,
      principalId,
      userId,
      billingAccountId: account.billingAccountId,
      billingUserId: billingUser.billingUserId,
      ttlSeconds: ttl,
      platformScopes,
      billingScopes,
      audience,
      nonce: typeof body?.nonce === 'string' ? body.nonce : undefined,
      traits: this.sanitizeTraits(body?.traits),
      issuedByServiceKeyId: req.ctx.serviceApiKey?.keyId,
    })

    const response = okEnvelope({
      access_token: issueResult.accessToken,
      token_type: 'Bearer',
      expires_in: issueResult.expiresIn,
      expires_at: issueResult.expiresAt.toISOString(),
      billing_account_id: account.billingAccountId,
      billing_user_id: billingUser.billingUserId,
    }) as IssueToken200
    return response
  }

  private assertServiceKeyAllowsAccount(req: AppRequest, billingAccountId: string): void {
    const allowedAccounts = req.ctx?.serviceApiKey?.allowedAccounts ?? []
    if (allowedAccounts.length > 0 && !allowedAccounts.includes(billingAccountId)) {
      throw new HttpException({ code: 'AUTH.SERVICE_KEY_ACCOUNT_FORBIDDEN', message: 'Service API key not authorized for billing account' }, 403)
    }
  }

  private normalizePlatformScopes(input?: string[] | null): string[] {
    if (!input || !Array.isArray(input)) {
      return DEFAULT_PLATFORM_SCOPES
    }
    const filtered = input
      .map((value) => String(value || '').trim())
      .filter((value) => value.length > 0)
    if (!filtered.length) return DEFAULT_PLATFORM_SCOPES
    const result: string[] = []
    for (const scope of filtered) {
      if (ALLOWED_PLATFORM_SCOPES.has(scope)) result.push(scope)
    }
    return result.length ? Array.from(new Set(result)) : DEFAULT_PLATFORM_SCOPES
  }

  private mapToBillingScopes(platformScopes: string[]): string[] {
    const out = new Set<string>()
    out.add('billing:read')
    for (const scope of platformScopes) {
      if (scope === 'checkout') {
        out.add('billing:write')
      }
    }
    return Array.from(out)
  }

  private sanitizeTraits(input?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!input || typeof input !== 'object') return undefined
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input).slice(0, 20)) {
      if (typeof key !== 'string' || !key) continue
      if (value === undefined) continue
      if (typeof value === 'function') continue
      result[key] = value
    }
    return Object.keys(result).length ? result : undefined
  }
}

const ALLOWED_PLATFORM_SCOPES = new Set(['checkout', 'portal'])
const DEFAULT_PLATFORM_SCOPES = ['checkout', 'portal']
