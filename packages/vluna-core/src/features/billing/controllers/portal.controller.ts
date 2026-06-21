import { Controller, Post, Body, Req, UseGuards, UseInterceptors } from '@nestjs/common'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { Scopes } from '../../../auth/decorators/scopes.decorator.js'
import { BILLING_SCOPES } from '../../../auth/constants/scopes.constants.js'
import { IdempotencyInterceptor } from '../../../support/idempotency.interceptor.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { operations as BillingOps } from '../../../contracts/billing.js'
import { JsonRequestBody, JsonResponse } from '../../../contracts/openapi-helpers.js'
import { PrincipalGuard } from '../../../auth/guards/principal.guard.js'
import { BillingAccountGuard } from '../../../auth/guards/billing-account.guard.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { ServiceAccountGuard } from '../../../auth/guards/service-account.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import { PortalApiService } from '../services/portal-api.service.js'

// OpenAPI mapping: tag=Portal
// Path: POST /portal/sessions (operationId: createPortalSession)

type CreatePortalBody = JsonRequestBody<BillingOps, 'createPortalSession'>
type CreatePortal201 = JsonResponse<BillingOps, 'createPortalSession', 201>

@Controller('portal')
@UseGuards(RealmGuard, TokenClaimsGuard, RealmMembershipGuard, PrincipalGuard, BillingAccountGuard)
export class PortalPublicController {
  constructor(private readonly portalApi: PortalApiService) {}

  @Post('sessions')
  @Scopes(BILLING_SCOPES.WRITE)
  @UseInterceptors(IdempotencyInterceptor)
  async createPortalSession(@Req() req: AppRequest, @Body() body: CreatePortalBody): Promise<CreatePortal201> {
    return this.portalApi.createPortalSession({
      traceId: req.ctx.traceId,
      realmId: req.ctx.realmId || '',
      billingAccountId: req.ctx.billingAccountId!,
      idempotencyKey: req.ctx.idempotencyKey,
      principalId: req.ctx.principal?.id,
      db: req.ctx.db,
      body,
    })
  }
}

@Controller('portal')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, ServiceAccountGuard, PrincipalGuard, BillingAccountGuard)
export class PortalServiceController {
  constructor(private readonly portalApi: PortalApiService) {}

  @Post('sessions')
  @UseInterceptors(IdempotencyInterceptor)
  async createPortalSession(@Req() req: AppRequest, @Body() body: CreatePortalBody): Promise<CreatePortal201> {
    return this.portalApi.createPortalSession({
      traceId: req.ctx.traceId,
      realmId: req.ctx.realmId || '',
      billingAccountId: req.ctx.billingAccountId!,
      idempotencyKey: req.ctx.idempotencyKey,
      principalId: req.ctx.principal?.id,
      db: req.ctx.db,
      body,
    })
  }
}
