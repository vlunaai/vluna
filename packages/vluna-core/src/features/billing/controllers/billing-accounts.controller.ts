import { Body, Controller, Get, HttpException, Inject, Param, Patch, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { RequireServiceAuthGuard } from '../../../auth/guards/require-service-auth.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import { IdempotencyInterceptor } from '../../../support/idempotency.interceptor.js'
import { Audit } from '../../../support/audit/audit.decorator.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { operations as BillingOps } from '../../../contracts/billing-mgt.js'
import { JsonRequestBody, JsonResponse, QueryParams } from '../../../contracts/openapi-helpers.js'
import { okEnvelope } from '../../../common/envelope.js'
import { BillingAccountsService } from '../services/billing-accounts.service.js'

// OpenAPI mapping: tag=BillingAccounts
// Paths:
// - GET /billing-accounts (operationId: listBillingAccounts)

type ListBillingAccountsQuery = QueryParams<BillingOps, 'listBillingAccounts'>
type ListBillingAccounts200 = JsonResponse<BillingOps, 'listBillingAccounts', 200>
type UpdateBillingDetailsBody = JsonRequestBody<BillingOps, 'updateBillingAccountBillingDetails'>
type UpdateBillingDetails200 = JsonResponse<BillingOps, 'updateBillingAccountBillingDetails', 200>

// Relaxed UUID shape check (accepts nil UUID and other "pretty" UUIDs).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseUuid(value: string, name: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed || !UUID_RE.test(trimmed)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `invalid ${name}` }, 422)
  }
  return trimmed
}

@Controller()
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, RequireServiceAuthGuard)
export class BillingAccountsController {
  constructor(@Inject(BillingAccountsService) private readonly billingAccountsService: BillingAccountsService) {}

  @Get('billing-accounts')
  async listBillingAccounts(
    @Req() req: AppRequest,
    @Query() query: ListBillingAccountsQuery,
  ): Promise<ListBillingAccounts200> {
    const data = await this.billingAccountsService.listBillingAccounts(req, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListBillingAccounts200
  }

  @Patch('billing-accounts/:billing_account_id/billing-details')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'billing_account.update_billing_details',
    operationId: 'updateBillingAccountBillingDetails',
    targetType: 'billing_account',
    targetIdFrom: 'params.billing_account_id',
  })
  async updateBillingAccountBillingDetails(
    @Req() req: AppRequest,
    @Param('billing_account_id') billingAccountIdParam: string,
    @Body() body: UpdateBillingDetailsBody,
  ): Promise<UpdateBillingDetails200> {
    const billingAccountId = parseUuid(billingAccountIdParam, 'billing_account_id')
    const data = await this.billingAccountsService.updateBillingAccountBillingDetails(req, billingAccountId, body ?? {})
    return okEnvelope(data) as UpdateBillingDetails200
  }
}
