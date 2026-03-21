import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { RequireServiceAuthGuard } from '../../../auth/guards/require-service-auth.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { ServiceAccountGuard } from '../../../auth/guards/service-account.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import { IdempotencyInterceptor } from '../../../support/idempotency.interceptor.js'
import { Audit } from '../../../support/audit/audit.decorator.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { operations as BillingOps } from '../../../contracts/billing-mgt.js'
import { JsonRequestBody, JsonResponse, QueryParams } from '../../../contracts/openapi-helpers.js'
import { okEnvelope } from '../../../common/envelope.js'
import { BillingPlansManagementService } from '../services/billing-plans-management.service.js'

// OpenAPI mapping: tag=BillingPlans
// Paths:
// - GET  /billing-plans (operationId: listBillingPlans)
// - POST /billing-plans (operationId: upsertBillingPlan)
// - GET  /billing-plans/{plan_id} (operationId: getBillingPlan)
// - PATCH /billing-plans/{plan_id} (operationId: updateBillingPlan)
// - GET  /billing-plans/{plan_id}/entitlements (operationId: listBillingPlanEntitlements)
// - POST /billing-plans/{plan_id}/entitlements (operationId: upsertBillingPlanEntitlements)
// - DELETE /billing-plans/{plan_id}/entitlements/{bpe_id} (operationId: deleteBillingPlanEntitlement)
// - GET  /billing-plan-assignments (operationId: listBillingPlanAssignments)
// - POST /billing-plan-assignments (operationId: createBillingPlanAssignment)
// - PATCH /billing-plan-assignments/{assignment_id} (operationId: updateBillingPlanAssignment)

type ListBillingPlansQuery = QueryParams<BillingOps, 'listBillingPlans'>
type ListBillingPlans200 = JsonResponse<BillingOps, 'listBillingPlans', 200>
type UpsertBillingPlanBody = JsonRequestBody<BillingOps, 'upsertBillingPlan'>
type UpsertBillingPlan201 = JsonResponse<BillingOps, 'upsertBillingPlan', 201>
type UpsertBillingPlan200 = JsonResponse<BillingOps, 'upsertBillingPlan', 200>
type GetBillingPlan200 = JsonResponse<BillingOps, 'getBillingPlan', 200>
type UpdateBillingPlanBody = JsonRequestBody<BillingOps, 'updateBillingPlan'>
type UpdateBillingPlan200 = JsonResponse<BillingOps, 'updateBillingPlan', 200>

type ListEntitlementsQuery = QueryParams<BillingOps, 'listBillingPlanEntitlements'>
type ListEntitlements200 = JsonResponse<BillingOps, 'listBillingPlanEntitlements', 200>
type UpsertEntitlementsBody = JsonRequestBody<BillingOps, 'upsertBillingPlanEntitlements'>
type UpsertEntitlements201 = JsonResponse<BillingOps, 'upsertBillingPlanEntitlements', 201>
type UpsertEntitlements200 = JsonResponse<BillingOps, 'upsertBillingPlanEntitlements', 200>
type DeleteEntitlement200 = JsonResponse<BillingOps, 'deleteBillingPlanEntitlement', 200>

type ListAssignmentsQuery = QueryParams<BillingOps, 'listBillingPlanAssignments'>
type ListAssignments200 = JsonResponse<BillingOps, 'listBillingPlanAssignments', 200>
type CreateAssignmentBody = JsonRequestBody<BillingOps, 'createBillingPlanAssignment'>
type CreateAssignment201 = JsonResponse<BillingOps, 'createBillingPlanAssignment', 201>
type UpdateAssignmentBody = JsonRequestBody<BillingOps, 'updateBillingPlanAssignment'>
type UpdateAssignment200 = JsonResponse<BillingOps, 'updateBillingPlanAssignment', 200>

@Controller()
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, RequireServiceAuthGuard)
export class BillingPlansController {
  constructor(@Inject(BillingPlansManagementService) private readonly plansService: BillingPlansManagementService) {}

  @Get('billing-plans')
  async listBillingPlans(@Req() req: AppRequest, @Query() query: ListBillingPlansQuery): Promise<ListBillingPlans200> {
    const data = await this.plansService.listBillingPlans(req, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListBillingPlans200
  }

  @Post('billing-plans')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: ({ reply, error }) => {
      if (error) return 'plan.upsert'
      return reply.statusCode === 201 ? 'plan.create' : 'plan.update'
    },
    operationId: 'upsertBillingPlan',
    targetType: 'billing_plan',
    targetIdFrom: 'response.data.plan_id',
  })
  async upsertBillingPlan(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: UpsertBillingPlanBody,
  ): Promise<UpsertBillingPlan201 | UpsertBillingPlan200> {
    const { created, plan } = await this.plansService.upsertBillingPlan(req, body)
    const payload = okEnvelope(plan) as UpsertBillingPlan201
    const status = created ? 201 : 200
    try { await res.status(status).send(payload) } catch {}
    return payload
  }

  @Get('billing-plans/:plan_id')
  async getBillingPlan(@Req() req: AppRequest, @Param('plan_id') planId: string): Promise<GetBillingPlan200> {
    const data = await this.plansService.getBillingPlan(req, planId)
    return okEnvelope(data) as GetBillingPlan200
  }

  @Patch('billing-plans/:plan_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'plan.update',
    operationId: 'updateBillingPlan',
    targetType: 'billing_plan',
    targetIdFrom: 'params.plan_id',
  })
  async updateBillingPlan(
    @Req() req: AppRequest,
    @Param('plan_id') planId: string,
    @Body() body: UpdateBillingPlanBody,
  ): Promise<UpdateBillingPlan200> {
    const data = await this.plansService.updateBillingPlan(req, planId, body ?? {})
    return okEnvelope(data) as UpdateBillingPlan200
  }

  @Get('billing-plans/:plan_id/entitlements')
  async listBillingPlanEntitlements(
    @Req() req: AppRequest,
    @Param('plan_id') planId: string,
    @Query() query: ListEntitlementsQuery,
  ): Promise<ListEntitlements200> {
    const data = await this.plansService.listBillingPlanEntitlements(req, planId, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListEntitlements200
  }

  @Post('billing-plans/:plan_id/entitlements')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'plan_entitlement.upsert',
    operationId: 'upsertBillingPlanEntitlements',
    targetType: 'billing_plan',
    targetIdFrom: 'params.plan_id',
  })
  async upsertBillingPlanEntitlements(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Param('plan_id') planId: string,
    @Body() body: UpsertEntitlementsBody,
  ): Promise<UpsertEntitlements201 | UpsertEntitlements200> {
    const data = await this.plansService.upsertBillingPlanEntitlements(
      req,
      planId,
      body as Parameters<BillingPlansManagementService['upsertBillingPlanEntitlements']>[2],
    )
    const payload = okEnvelope(data) as UpsertEntitlements201
    const status = body?.mode === 'replace' ? 200 : 201
    try { await res.status(status).send(payload) } catch {}
    return payload
  }

  @Delete('billing-plans/:plan_id/entitlements/:bpe_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'plan_entitlement.delete',
    operationId: 'deleteBillingPlanEntitlement',
    targetType: 'billing_plan_entitlement',
    targetIdFrom: 'params.bpe_id',
  })
  async deleteBillingPlanEntitlement(
    @Req() req: AppRequest,
    @Param('plan_id') planId: string,
    @Param('bpe_id') bpeId: string,
  ): Promise<DeleteEntitlement200> {
    const data = await this.plansService.deleteBillingPlanEntitlement(req, planId, bpeId)
    return okEnvelope(data) as DeleteEntitlement200
  }

  @Get('billing-plan-assignments')
  @UseGuards(ServiceAccountGuard)
  async listBillingPlanAssignments(
    @Req() req: AppRequest,
    @Query() query: ListAssignmentsQuery,
  ): Promise<ListAssignments200> {
    const data = await this.plansService.listBillingPlanAssignments(req, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListAssignments200
  }

  @Post('billing-plan-assignments')
  @UseGuards(ServiceAccountGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'plan_assignment.create',
    operationId: 'createBillingPlanAssignment',
    targetType: 'billing_plan_assignment',
    targetIdFrom: 'response.data.assignment_id',
  })
  async createBillingPlanAssignment(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: CreateAssignmentBody,
  ): Promise<CreateAssignment201> {
    const data = await this.plansService.createBillingPlanAssignment(req, body)
    const payload = okEnvelope(data) as CreateAssignment201
    try { await res.status(201).send(payload) } catch {}
    return payload
  }

  @Patch('billing-plan-assignments/:assignment_id')
  @UseGuards(ServiceAccountGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'plan_assignment.update',
    operationId: 'updateBillingPlanAssignment',
    targetType: 'billing_plan_assignment',
    targetIdFrom: 'params.assignment_id',
  })
  async updateBillingPlanAssignment(
    @Req() req: AppRequest,
    @Param('assignment_id') assignmentId: string,
    @Body() body: UpdateAssignmentBody,
  ): Promise<UpdateAssignment200> {
    const data = await this.plansService.updateBillingPlanAssignment(req, assignmentId, body ?? {})
    return okEnvelope(data) as UpdateAssignment200
  }
}
