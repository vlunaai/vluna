import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { Scopes } from '../../../auth/decorators/scopes.decorator.js'
import { BILLING_SCOPES } from '../../../auth/constants/scopes.constants.js'
import { PrincipalGuard } from '../../../auth/guards/principal.guard.js'
import { ServiceRuntimeUserGuard } from '../../../auth/guards/service-runtime-user.guard.js'
import { IdempotencyInterceptor } from '../../../support/idempotency.interceptor.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { operations as BillingOps } from '../../../contracts/billing.js'
import { JsonRequestBody, JsonResponse, QueryParams } from '../../../contracts/openapi-helpers.js'
import { BudgetsService } from '../services/budgets.service.js'
import { okEnvelope } from '../../../common/envelope.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'

type ListBudgetsQuery = QueryParams<BillingOps, 'listBudgets'>
type ListBudgets200 = JsonResponse<BillingOps, 'listBudgets', 200>
type CreateBudgetBody = JsonRequestBody<BillingOps, 'createBudget'>
type CreateBudget201 = JsonResponse<BillingOps, 'createBudget', 201>
type CreateBudget200 = JsonResponse<BillingOps, 'createBudget', 200>
type GetBudget200 = JsonResponse<BillingOps, 'getBudget', 200>
type CloseBudgetBody = JsonRequestBody<BillingOps, 'closeBudget'>
type CloseBudget200 = JsonResponse<BillingOps, 'closeBudget', 200>

abstract class BudgetsControllerBase {
  constructor(@Inject(BudgetsService) protected readonly budgetsService: BudgetsService) {}

  protected async handleListBudgets(req: AppRequest, query: ListBudgetsQuery): Promise<ListBudgets200> {
    const data = await this.budgetsService.listBudgets(req, query ?? {})
    return okEnvelope(data) as ListBudgets200
  }

  protected async handleCreateBudget(req: AppRequest, body: CreateBudgetBody): Promise<CreateBudget201 | CreateBudget200> {
    const budget = await this.budgetsService.createBudget(req, body)
    return okEnvelope(budget) as CreateBudget201
  }

  protected async handleGetBudget(req: AppRequest, budgetIdParam: string): Promise<GetBudget200> {
    const budgetId = parseUuidId(budgetIdParam)
    const budget = await this.budgetsService.getBudget(req, budgetId)
    return okEnvelope(budget) as GetBudget200
  }

  protected async handleCloseBudget(
    req: AppRequest,
    budgetIdParam: string,
    body: CloseBudgetBody,
  ): Promise<CloseBudget200> {
    const budgetId = parseUuidId(budgetIdParam)
    const result = await this.budgetsService.closeBudget(req, budgetId, body ?? {})
    return okEnvelope(result) as CloseBudget200
  }
}

@Controller('budgets')
@UseGuards(RealmGuard, TokenClaimsGuard, RealmMembershipGuard, PrincipalGuard, ServiceRuntimeUserGuard)
export class BudgetsController extends BudgetsControllerBase {
  @Get()
  @Scopes(BILLING_SCOPES.READ_ALL)
  async listBudgets(@Req() req: AppRequest, @Query() query: ListBudgetsQuery): Promise<ListBudgets200> {
    return this.handleListBudgets(req, query)
  }

  @Post()
  @Scopes(BILLING_SCOPES.WRITE)
  @UseInterceptors(IdempotencyInterceptor)
  async createBudget(
    @Req() req: AppRequest,
    @Body() body: CreateBudgetBody,
  ): Promise<CreateBudget201 | CreateBudget200> {
    return this.handleCreateBudget(req, body)
  }

  @Get(':budget_id')
  @Scopes(BILLING_SCOPES.READ_ALL)
  async getBudget(@Req() req: AppRequest, @Param('budget_id') budgetIdParam: string): Promise<GetBudget200> {
    return this.handleGetBudget(req, budgetIdParam)
  }

  @Post(':budget_id/close')
  @Scopes(BILLING_SCOPES.WRITE)
  @UseInterceptors(IdempotencyInterceptor)
  async closeBudget(
    @Req() req: AppRequest,
    @Param('budget_id') budgetIdParam: string,
    @Body() body: CloseBudgetBody,
  ): Promise<CloseBudget200> {
    return this.handleCloseBudget(req, budgetIdParam, body)
  }
}

@Controller('budgets')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, PrincipalGuard, ServiceRuntimeUserGuard)
export class BudgetsServiceController extends BudgetsControllerBase {
  @Get()
  async listBudgets(@Req() req: AppRequest, @Query() query: ListBudgetsQuery): Promise<ListBudgets200> {
    return this.handleListBudgets(req, query)
  }

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  async createBudget(
    @Req() req: AppRequest,
    @Body() body: CreateBudgetBody,
  ): Promise<CreateBudget201 | CreateBudget200> {
    return this.handleCreateBudget(req, body)
  }

  @Get(':budget_id')
  async getBudget(@Req() req: AppRequest, @Param('budget_id') budgetIdParam: string): Promise<GetBudget200> {
    return this.handleGetBudget(req, budgetIdParam)
  }

  @Post(':budget_id/close')
  @UseInterceptors(IdempotencyInterceptor)
  async closeBudget(
    @Req() req: AppRequest,
    @Param('budget_id') budgetIdParam: string,
    @Body() body: CloseBudgetBody,
  ): Promise<CloseBudget200> {
    return this.handleCloseBudget(req, budgetIdParam, body)
  }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function parseUuidId(value: string): string {
  const trimmed = String(value ?? '').trim()
  if (!UUID_RE.test(trimmed)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'invalid budget_id' }, 422)
  }
  return trimmed.toLowerCase()
}
