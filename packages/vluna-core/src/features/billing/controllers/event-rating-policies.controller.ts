import { Body, Controller, Delete, Get, HttpException, Inject, Param, Patch, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common'
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
import { EventRatingPoliciesService } from '../services/event-rating-policies.service.js'

// OpenAPI mapping: tag=EventRatingPolicies
// Paths:
// - GET  /event-rating-policies (operationId: listEventRatingPolicies)
// - POST /event-rating-policies (operationId: upsertEventRatingPolicy)
// - GET  /event-rating-policies/{policy_id} (operationId: getEventRatingPolicy)
// - POST /event-rating-policies/{policy_id} (operationId: updateEventRatingPolicy)
// - DELETE /event-rating-policies/{policy_id} (operationId: deleteEventRatingPolicy)
// - GET  /event-rating-policies/{policy_id}/versions (operationId: listEventRatingPolicyVersions)
// - POST /event-rating-policies/{policy_id}/versions (operationId: createEventRatingPolicyVersion)
// - GET  /event-rating-policies/{policy_id}/versions/{policy_version} (operationId: getEventRatingPolicyVersion)
// - PATCH /event-rating-policies/{policy_id}/versions/{policy_version} (operationId: updateEventRatingPolicyVersion)
// - DELETE /event-rating-policies/{policy_id}/versions/{policy_version} (operationId: deleteEventRatingPolicyVersion)
// - POST /event-rating-policies/versions:validate (operationId: validateEventRatingPolicyVersion)

type ListPoliciesQuery = QueryParams<BillingOps, 'listEventRatingPolicies'>
type ListPolicies200 = JsonResponse<BillingOps, 'listEventRatingPolicies', 200>
type UpsertPolicyBody = JsonRequestBody<BillingOps, 'upsertEventRatingPolicy'>
type UpsertPolicy201 = JsonResponse<BillingOps, 'upsertEventRatingPolicy', 201>
type UpsertPolicy200 = JsonResponse<BillingOps, 'upsertEventRatingPolicy', 200>
type GetPolicy200 = JsonResponse<BillingOps, 'getEventRatingPolicy', 200>
type UpdatePolicyBody = JsonRequestBody<BillingOps, 'updateEventRatingPolicy'>
type UpdatePolicy200 = JsonResponse<BillingOps, 'updateEventRatingPolicy', 200>
type DeletePolicy200 = JsonResponse<BillingOps, 'deleteEventRatingPolicy', 200>

type ListVersionsQuery = QueryParams<BillingOps, 'listEventRatingPolicyVersions'>
type ListVersions200 = JsonResponse<BillingOps, 'listEventRatingPolicyVersions', 200>
type CreateVersionBody = JsonRequestBody<BillingOps, 'createEventRatingPolicyVersion'>
type CreateVersion201 = JsonResponse<BillingOps, 'createEventRatingPolicyVersion', 201>
type CreateVersion200 = JsonResponse<BillingOps, 'createEventRatingPolicyVersion', 200>
type GetVersion200 = JsonResponse<BillingOps, 'getEventRatingPolicyVersion', 200>
type UpdateVersionBody = JsonRequestBody<BillingOps, 'updateEventRatingPolicyVersion'>
type UpdateVersion200 = JsonResponse<BillingOps, 'updateEventRatingPolicyVersion', 200>
type DeleteVersion200 = JsonResponse<BillingOps, 'deleteEventRatingPolicyVersion', 200>

type ValidateBody = JsonRequestBody<BillingOps, 'validateEventRatingPolicyVersion'>
type Validate200 = JsonResponse<BillingOps, 'validateEventRatingPolicyVersion', 200>

function requireSlug(value: string, name: string): string {
  const normalized = String(value || '').trim()
  if (!normalized) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} is required` }, 422)
  }
  return normalized
}

@Controller()
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, RequireServiceAuthGuard)
export class EventRatingPoliciesController {
  constructor(@Inject(EventRatingPoliciesService) private readonly policiesService: EventRatingPoliciesService) {}

  @Get('event-rating-policies')
  async listEventRatingPolicies(@Req() req: AppRequest, @Query() query: ListPoliciesQuery): Promise<ListPolicies200> {
    const data = await this.policiesService.listPolicies(req, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListPolicies200
  }

  @Post('event-rating-policies')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: ({ reply, error }) => {
      if (error) return 'event_rating_policy.upsert'
      return reply.statusCode === 201 ? 'event_rating_policy.create' : 'event_rating_policy.update'
    },
    operationId: 'upsertEventRatingPolicy',
    targetType: 'event_rating_policy',
    targetIdFrom: 'response.data.policy_id',
  })
  async upsertEventRatingPolicy(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: UpsertPolicyBody,
  ): Promise<UpsertPolicy201 | UpsertPolicy200> {
    const { created, policy } = await this.policiesService.upsertPolicy(req, body)
    const payload = okEnvelope(policy) as UpsertPolicy201
    const status = created ? 201 : 200
    try { await res.status(status).send(payload) } catch {}
    return payload
  }

  @Get('event-rating-policies/:policy_id')
  async getEventRatingPolicy(@Req() req: AppRequest, @Param('policy_id') policyIdParam: string): Promise<GetPolicy200> {
    const policyId = requireSlug(policyIdParam, 'policy_id')
    const data = await this.policiesService.getPolicy(req, policyId)
    return okEnvelope(data) as GetPolicy200
  }

  @Post('event-rating-policies/:policy_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'event_rating_policy.update',
    operationId: 'updateEventRatingPolicy',
    targetType: 'event_rating_policy',
    targetIdFrom: 'params.policy_id',
  })
  async updateEventRatingPolicy(
    @Req() req: AppRequest,
    @Param('policy_id') policyIdParam: string,
    @Body() body: UpdatePolicyBody,
  ): Promise<UpdatePolicy200> {
    const policyId = requireSlug(policyIdParam, 'policy_id')
    const data = await this.policiesService.updatePolicy(req, policyId, body ?? {})
    return okEnvelope(data) as UpdatePolicy200
  }

  @Delete('event-rating-policies/:policy_id')
  @Audit({
    action: 'event_rating_policy.delete',
    operationId: 'deleteEventRatingPolicy',
    targetType: 'event_rating_policy',
    targetIdFrom: 'params.policy_id',
  })
  async deleteEventRatingPolicy(
    @Req() req: AppRequest,
    @Param('policy_id') policyIdParam: string,
  ): Promise<DeletePolicy200> {
    const policyId = requireSlug(policyIdParam, 'policy_id')
    const data = await this.policiesService.deletePolicy(req, policyId)
    return okEnvelope(data) as DeletePolicy200
  }

  @Get('event-rating-policies/:policy_id/versions')
  async listEventRatingPolicyVersions(
    @Req() req: AppRequest,
    @Param('policy_id') policyIdParam: string,
    @Query() query: ListVersionsQuery,
  ): Promise<ListVersions200> {
    const policyId = requireSlug(policyIdParam, 'policy_id')
    const data = await this.policiesService.listPolicyVersions(req, policyId, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListVersions200
  }

  @Post('event-rating-policies/:policy_id/versions')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: ({ reply, error }) => {
      if (error) return 'event_rating_policy_version.upsert'
      return reply.statusCode === 201 ? 'event_rating_policy_version.create' : 'event_rating_policy_version.update'
    },
    operationId: 'createEventRatingPolicyVersion',
    targetType: 'event_rating_policy_version',
    targetIdFrom: ({ req, responseBody }) => {
      const params = (req.params ?? {}) as Record<string, unknown>
      const policyId = typeof params.policy_id === 'string' ? params.policy_id.trim() : ''
      const response = responseBody as { data?: { policy_version?: unknown } } | undefined
      const policyVersion = typeof response?.data?.policy_version === 'string' ? response.data.policy_version.trim() : ''
      if (policyId && policyVersion) return `${policyId}:${policyVersion}`
      return policyId || policyVersion || undefined
    },
  })
  async createEventRatingPolicyVersion(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Param('policy_id') policyIdParam: string,
    @Body() body: CreateVersionBody,
  ): Promise<CreateVersion201 | CreateVersion200> {
    const policyId = requireSlug(policyIdParam, 'policy_id')
    const { created, version } = await this.policiesService.createPolicyVersion(req, policyId, body)
    const payload = okEnvelope(version) as CreateVersion201
    const status = created ? 201 : 200
    try { await res.status(status).send(payload) } catch {}
    return payload
  }

  @Get('event-rating-policies/:policy_id/versions/:policy_version')
  async getEventRatingPolicyVersion(
    @Req() req: AppRequest,
    @Param('policy_id') policyIdParam: string,
    @Param('policy_version') policyVersionParam: string,
  ): Promise<GetVersion200> {
    const policyId = requireSlug(policyIdParam, 'policy_id')
    const policyVersion = requireSlug(policyVersionParam, 'policy_version')
    const data = await this.policiesService.getPolicyVersion(req, policyId, policyVersion)
    return okEnvelope(data) as GetVersion200
  }

  @Patch('event-rating-policies/:policy_id/versions/:policy_version')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'event_rating_policy_version.update',
    operationId: 'updateEventRatingPolicyVersion',
    targetType: 'event_rating_policy_version',
    targetIdFrom: ({ req }) => {
      const params = (req.params ?? {}) as Record<string, unknown>
      const policyId = typeof params.policy_id === 'string' ? params.policy_id.trim() : ''
      const policyVersion = typeof params.policy_version === 'string' ? params.policy_version.trim() : ''
      if (policyId && policyVersion) return `${policyId}:${policyVersion}`
      return policyId || policyVersion || undefined
    },
  })
  async updateEventRatingPolicyVersion(
    @Req() req: AppRequest,
    @Param('policy_id') policyIdParam: string,
    @Param('policy_version') policyVersionParam: string,
    @Body() body: UpdateVersionBody,
  ): Promise<UpdateVersion200> {
    const policyId = requireSlug(policyIdParam, 'policy_id')
    const policyVersion = requireSlug(policyVersionParam, 'policy_version')
    const data = await this.policiesService.updatePolicyVersion(req, policyId, policyVersion, body ?? {})
    return okEnvelope(data) as UpdateVersion200
  }

  @Delete('event-rating-policies/:policy_id/versions/:policy_version')
  @Audit({
    action: 'event_rating_policy_version.delete',
    operationId: 'deleteEventRatingPolicyVersion',
    targetType: 'event_rating_policy_version',
    targetIdFrom: ({ req }) => {
      const params = (req.params ?? {}) as Record<string, unknown>
      const policyId = typeof params.policy_id === 'string' ? params.policy_id.trim() : ''
      const policyVersion = typeof params.policy_version === 'string' ? params.policy_version.trim() : ''
      if (policyId && policyVersion) return `${policyId}:${policyVersion}`
      return policyId || policyVersion || undefined
    },
  })
  async deleteEventRatingPolicyVersion(
    @Req() req: AppRequest,
    @Param('policy_id') policyIdParam: string,
    @Param('policy_version') policyVersionParam: string,
  ): Promise<DeleteVersion200> {
    const policyId = requireSlug(policyIdParam, 'policy_id')
    const policyVersion = requireSlug(policyVersionParam, 'policy_version')
    const data = await this.policiesService.deletePolicyVersion(req, policyId, policyVersion)
    return okEnvelope(data) as DeleteVersion200
  }

  @Post('event-rating-policies/versions:validate')
  @UseInterceptors(IdempotencyInterceptor)
  async validateEventRatingPolicyVersion(@Req() req: AppRequest, @Body() body: ValidateBody): Promise<Validate200> {
    const data = await this.policiesService.validateDsl(req, body?.dsl_json)
    return okEnvelope(data) as Validate200
  }
}
