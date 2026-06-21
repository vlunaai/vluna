import { Controller, Get, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common'
import { okEnvelope } from '../../common/envelope.js'
import { RealmGuard } from '../../auth/guards/realm.guard.js'
import { TokenClaimsGuard } from '../../auth/guards/token-claims.guard.js'
import { Scopes } from '../../auth/decorators/scopes.decorator.js'
import { BILLING_SCOPES } from '../../auth/constants/scopes.constants.js'
import { IdempotencyInterceptor } from '../../support/idempotency.interceptor.js'
import { PrincipalGuard } from '../../auth/guards/principal.guard.js'
import { BillingAccountGuard } from '../../auth/guards/billing-account.guard.js'
import { RealmMembershipGuard } from '../../auth/guards/realm-membership.guard.js'
import type { AppRequest } from '../../types/app-request.js'

type Claims = { sub?: string; scope?: string | string[] }

// Use AppRequest; all custom state must be in req.ctx.

@Controller('billing/demo')
export class BillingDemoController {
  @UseGuards(RealmGuard, TokenClaimsGuard, RealmMembershipGuard, PrincipalGuard, BillingAccountGuard)
  @Scopes(BILLING_SCOPES.READ_ALL)
  @Get('read')
  read(@Req() req: AppRequest) {
    const claims: Claims = (req.ctx?.claims as Claims | undefined) || {}
    const realmId = (req.ctx?.realmId as string | undefined) || (req.headers?.['x-realm-id'] as string | undefined)
    const scopeRaw = claims.scope
    const scopeStr = Array.isArray(scopeRaw) ? scopeRaw.join(' ') : String(scopeRaw || '')
    return okEnvelope({
      realmId,
      sub: claims.sub,
      principal: req.ctx?.principal || null,
      billingAccountId: req.ctx?.billingAccountId || null,
      scope: scopeStr,
      note: 'Requires billing:read',
    })
  }

  @UseGuards(RealmGuard, TokenClaimsGuard, RealmMembershipGuard, PrincipalGuard, BillingAccountGuard)
  @Scopes(BILLING_SCOPES.WRITE)
  @UseInterceptors(IdempotencyInterceptor)
  @Post('write')
  write(@Req() req: AppRequest) {
    const claims: Claims = (req.ctx?.claims as Claims | undefined) || {}
    const realmId = (req.ctx?.realmId as string | undefined) || (req.headers?.['x-realm-id'] as string | undefined)
    return okEnvelope({
      realmId,
      sub: claims.sub,
      principal: req.ctx?.principal || null,
      billingAccountId: req.ctx?.billingAccountId || null,
      note: 'Requires billing:write and Idempotency-Key',
      idempotencyKey: req.ctx?.idempotencyKey || null,
    })
  }
}
