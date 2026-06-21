import { Body, Controller, Get, HttpException, Inject, Param, Patch, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
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
// - PATCH /billing-accounts/{billing_account_id} (operationId: updateBillingAccount)
// - GET /billing-accounts/{billing_account_id}/seat-summary (operationId: getBillingAccountSeatSummary)
// - GET /billing-accounts/{billing_account_id}/users (operationId: listBillingUsers)
// - POST /billing-accounts/{billing_account_id}/users (operationId: createBillingUser)
// - GET /billing-users/{billing_user_id} (operationId: getBillingUser)
// - PATCH /billing-users/{billing_user_id} (operationId: updateBillingUser)
// - POST /billing-users/{billing_user_id}/disable (operationId: disableBillingUser)
// - POST /billing-users/{billing_user_id}/restore (operationId: restoreBillingUser)
// - GET /billing-users/{billing_user_id}/summary (operationId: getBillingUserSummary)
// - GET /billing-users/{billing_user_id}/wallet (operationId: getBillingUserWallet)
// - GET /billing-users/{billing_user_id}/activity (operationId: listBillingUserActivity)

type ListBillingAccountsQuery = QueryParams<BillingOps, 'listBillingAccounts'>
type ListBillingAccounts200 = JsonResponse<BillingOps, 'listBillingAccounts', 200>
type UpdateBillingAccountBody = JsonRequestBody<BillingOps, 'updateBillingAccount'>
type UpdateBillingAccount200 = JsonResponse<BillingOps, 'updateBillingAccount', 200>
type GetBillingAccountSeatSummary200 = JsonResponse<BillingOps, 'getBillingAccountSeatSummary', 200>
type UpdateBillingDetailsBody = JsonRequestBody<BillingOps, 'updateBillingAccountBillingDetails'>
type UpdateBillingDetails200 = JsonResponse<BillingOps, 'updateBillingAccountBillingDetails', 200>
type ListBillingUsersQuery = QueryParams<BillingOps, 'listBillingUsers'>
type ListBillingUsers200 = JsonResponse<BillingOps, 'listBillingUsers', 200>
type CreateBillingUserBody = JsonRequestBody<BillingOps, 'createBillingUser'>
type CreateBillingUser201 = JsonResponse<BillingOps, 'createBillingUser', 201>
type GetBillingUser200 = JsonResponse<BillingOps, 'getBillingUser', 200>
type UpdateBillingUserBody = JsonRequestBody<BillingOps, 'updateBillingUser'>
type UpdateBillingUser200 = JsonResponse<BillingOps, 'updateBillingUser', 200>
type DisableBillingUser200 = JsonResponse<BillingOps, 'disableBillingUser', 200>
type RestoreBillingUser200 = JsonResponse<BillingOps, 'restoreBillingUser', 200>
type GetBillingUserSummary200 = JsonResponse<BillingOps, 'getBillingUserSummary', 200>
type GetBillingUserWalletQuery = QueryParams<BillingOps, 'getBillingUserWallet'>
type GetBillingUserWallet200 = JsonResponse<BillingOps, 'getBillingUserWallet', 200>
type ListBillingUserActivityQuery = QueryParams<BillingOps, 'listBillingUserActivity'>
type ListBillingUserActivity200 = JsonResponse<BillingOps, 'listBillingUserActivity', 200>

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

  @Patch('billing-accounts/:billing_account_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'billing_account.update',
    operationId: 'updateBillingAccount',
    targetType: 'billing_account',
    targetIdFrom: 'params.billing_account_id',
  })
  async updateBillingAccount(
    @Req() req: AppRequest,
    @Param('billing_account_id') billingAccountIdParam: string,
    @Body() body: UpdateBillingAccountBody,
  ): Promise<UpdateBillingAccount200> {
    const billingAccountId = parseUuid(billingAccountIdParam, 'billing_account_id')
    const data = await this.billingAccountsService.updateBillingAccount(req, billingAccountId, body ?? {})
    return okEnvelope(data) as UpdateBillingAccount200
  }

  @Get('billing-accounts/:billing_account_id/seat-summary')
  async getBillingAccountSeatSummary(
    @Req() req: AppRequest,
    @Param('billing_account_id') billingAccountIdParam: string,
  ): Promise<GetBillingAccountSeatSummary200> {
    const billingAccountId = parseUuid(billingAccountIdParam, 'billing_account_id')
    const data = await this.billingAccountsService.getBillingAccountSeatSummary(req, billingAccountId)
    return okEnvelope(data) as GetBillingAccountSeatSummary200
  }

  @Get('billing-accounts/:billing_account_id/users')
  async listBillingUsers(
    @Req() req: AppRequest,
    @Param('billing_account_id') billingAccountIdParam: string,
    @Query() query: ListBillingUsersQuery,
  ): Promise<ListBillingUsers200> {
    const billingAccountId = parseUuid(billingAccountIdParam, 'billing_account_id')
    const data = await this.billingAccountsService.listBillingUsers(req, billingAccountId, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListBillingUsers200
  }

  @Post('billing-accounts/:billing_account_id/users')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'billing_user.create',
    operationId: 'createBillingUser',
    targetType: 'billing_user',
    targetIdFrom: 'response.data.billing_user_id',
  })
  async createBillingUser(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Param('billing_account_id') billingAccountIdParam: string,
    @Body() body: CreateBillingUserBody,
  ): Promise<CreateBillingUser201> {
    const billingAccountId = parseUuid(billingAccountIdParam, 'billing_account_id')
    const data = await this.billingAccountsService.createBillingUser(req, billingAccountId, body)
    const payload = okEnvelope(data) as CreateBillingUser201
    try { await res.status(201).send(payload) } catch {}
    return payload
  }

  @Get('billing-users/:billing_user_id')
  async getBillingUser(
    @Req() req: AppRequest,
    @Param('billing_user_id') billingUserIdParam: string,
  ): Promise<GetBillingUser200> {
    const billingUserId = parseUuid(billingUserIdParam, 'billing_user_id')
    const data = await this.billingAccountsService.getBillingUser(req, billingUserId)
    return okEnvelope(data) as GetBillingUser200
  }

  @Patch('billing-users/:billing_user_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'billing_user.update',
    operationId: 'updateBillingUser',
    targetType: 'billing_user',
    targetIdFrom: 'params.billing_user_id',
  })
  async updateBillingUser(
    @Req() req: AppRequest,
    @Param('billing_user_id') billingUserIdParam: string,
    @Body() body: UpdateBillingUserBody,
  ): Promise<UpdateBillingUser200> {
    const billingUserId = parseUuid(billingUserIdParam, 'billing_user_id')
    const data = await this.billingAccountsService.updateBillingUser(req, billingUserId, body ?? {})
    return okEnvelope(data) as UpdateBillingUser200
  }

  @Post('billing-users/:billing_user_id/disable')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'billing_user.disable',
    operationId: 'disableBillingUser',
    targetType: 'billing_user',
    targetIdFrom: 'params.billing_user_id',
  })
  async disableBillingUser(
    @Req() req: AppRequest,
    @Param('billing_user_id') billingUserIdParam: string,
  ): Promise<DisableBillingUser200> {
    const billingUserId = parseUuid(billingUserIdParam, 'billing_user_id')
    const data = await this.billingAccountsService.disableBillingUser(req, billingUserId)
    return okEnvelope(data) as DisableBillingUser200
  }

  @Post('billing-users/:billing_user_id/restore')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'billing_user.restore',
    operationId: 'restoreBillingUser',
    targetType: 'billing_user',
    targetIdFrom: 'params.billing_user_id',
  })
  async restoreBillingUser(
    @Req() req: AppRequest,
    @Param('billing_user_id') billingUserIdParam: string,
  ): Promise<RestoreBillingUser200> {
    const billingUserId = parseUuid(billingUserIdParam, 'billing_user_id')
    const data = await this.billingAccountsService.restoreBillingUser(req, billingUserId)
    return okEnvelope(data) as RestoreBillingUser200
  }

  @Get('billing-users/:billing_user_id/summary')
  async getBillingUserSummary(
    @Req() req: AppRequest,
    @Param('billing_user_id') billingUserIdParam: string,
  ): Promise<GetBillingUserSummary200> {
    const billingUserId = parseUuid(billingUserIdParam, 'billing_user_id')
    const data = await this.billingAccountsService.getBillingUserSummary(req, billingUserId)
    return okEnvelope(data) as GetBillingUserSummary200
  }

  @Get('billing-users/:billing_user_id/wallet')
  async getBillingUserWallet(
    @Req() req: AppRequest,
    @Param('billing_user_id') billingUserIdParam: string,
    @Query() query: GetBillingUserWalletQuery,
  ): Promise<GetBillingUserWallet200> {
    const billingUserId = parseUuid(billingUserIdParam, 'billing_user_id')
    const data = await this.billingAccountsService.getBillingUserWallet(req, billingUserId, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as GetBillingUserWallet200
  }

  @Get('billing-users/:billing_user_id/activity')
  async listBillingUserActivity(
    @Req() req: AppRequest,
    @Param('billing_user_id') billingUserIdParam: string,
    @Query() query: ListBillingUserActivityQuery,
  ): Promise<ListBillingUserActivity200> {
    const billingUserId = parseUuid(billingUserIdParam, 'billing_user_id')
    const data = await this.billingAccountsService.listBillingUserActivity(req, billingUserId, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListBillingUserActivity200
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
