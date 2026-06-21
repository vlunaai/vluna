import { Controller, Post, Body, Req, UseGuards, UseInterceptors } from '@nestjs/common'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { Scopes } from '../../../auth/decorators/scopes.decorator.js'
import { BILLING_SCOPES } from '../../../auth/constants/scopes.constants.js'
import { IdempotencyInterceptor } from '../../../support/idempotency.interceptor.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { operations as BillingOps } from '../../../contracts/billing.js'
import { JsonRequestBody, JsonResponse } from '../../../contracts/openapi-helpers.js'
import { BillingAccountGuard } from '../../../auth/guards/billing-account.guard.js'
import { PrincipalGuard } from '../../../auth/guards/principal.guard.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { ServiceAccountGuard } from '../../../auth/guards/service-account.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import { CheckoutApiService } from '../services/checkout-api.service.js'

// OpenAPI mapping: tag=Checkout
// Path: POST /checkout/sessions (operationId: createCheckoutSession)

type CreateCheckoutBody = JsonRequestBody<BillingOps, 'createCheckoutSession'>
type CreateCheckout201 = JsonResponse<BillingOps, 'createCheckoutSession', 201>

@Controller('checkout')
@UseGuards(RealmGuard, TokenClaimsGuard, RealmMembershipGuard, PrincipalGuard, BillingAccountGuard)
export class CheckoutPublicController {
  constructor(private readonly checkoutApi: CheckoutApiService) {}

  @Post('sessions')
  @UseInterceptors(IdempotencyInterceptor)
  @Scopes(BILLING_SCOPES.WRITE)
  async createCheckoutSession(@Req() req: AppRequest, @Body() body: CreateCheckoutBody): Promise<CreateCheckout201> {
    return this.checkoutApi.createCheckoutSession({
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

@Controller('checkout')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, ServiceAccountGuard, PrincipalGuard, BillingAccountGuard)
export class CheckoutServiceController {
  constructor(private readonly checkoutApi: CheckoutApiService) {}

  @Post('sessions')
  @UseInterceptors(IdempotencyInterceptor)
  async createCheckoutSession(@Req() req: AppRequest, @Body() body: CreateCheckoutBody): Promise<CreateCheckout201> {
    return this.checkoutApi.createCheckoutSession({
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
