import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common'
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
import { FeatureFamiliesService } from '../services/feature-families.service.js'

// OpenAPI mapping: tag=FeatureFamilies
// Paths:
// - GET  /feature-families (operationId: listFeatureFamilies)
// - POST /feature-families (operationId: upsertFeatureFamily)
// - GET  /feature-families/{feature_family_id} (operationId: getFeatureFamily)
// - PATCH /feature-families/{feature_family_id} (operationId: updateFeatureFamily)

type ListFeatureFamiliesQuery = QueryParams<BillingOps, 'listFeatureFamilies'>
type ListFeatureFamilies200 = JsonResponse<BillingOps, 'listFeatureFamilies', 200>
type UpsertFeatureFamilyBody = JsonRequestBody<BillingOps, 'upsertFeatureFamily'>
type UpsertFeatureFamily201 = JsonResponse<BillingOps, 'upsertFeatureFamily', 201>
type UpsertFeatureFamily200 = JsonResponse<BillingOps, 'upsertFeatureFamily', 200>
type GetFeatureFamily200 = JsonResponse<BillingOps, 'getFeatureFamily', 200>
type UpdateFeatureFamilyBody = JsonRequestBody<BillingOps, 'updateFeatureFamily'>
type UpdateFeatureFamily200 = JsonResponse<BillingOps, 'updateFeatureFamily', 200>
type DeleteFeatureFamily200 = JsonResponse<BillingOps, 'deleteFeatureFamily', 200>

@Controller()
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, RequireServiceAuthGuard)
export class FeatureFamiliesController {
  constructor(@Inject(FeatureFamiliesService) private readonly feature_familiesService: FeatureFamiliesService) {}

  @Get('feature-families')
  async listFeatureFamilies(@Req() req: AppRequest, @Query() query: ListFeatureFamiliesQuery): Promise<ListFeatureFamilies200> {
    const data = await this.feature_familiesService.listFeatureFamilies(req, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListFeatureFamilies200
  }

  @Post('feature-families')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: ({ reply, error }) => {
      if (error) return 'feature_family.upsert'
      return reply.statusCode === 201 ? 'feature_family.create' : 'feature_family.update'
    },
    operationId: 'upsertFeatureFamily',
    targetType: 'feature_family',
    targetIdFrom: 'response.data.feature_family_id',
  })
  async upsertFeatureFamily(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: UpsertFeatureFamilyBody,
  ): Promise<UpsertFeatureFamily201 | UpsertFeatureFamily200> {
    const { created, feature_family } = await this.feature_familiesService.upsertFeatureFamily(req, body)
    const payload = okEnvelope(feature_family) as UpsertFeatureFamily201
    const status = created ? 201 : 200
    try { await res.status(status).send(payload) } catch {}
    return payload
  }

  @Get('feature-families/:feature_family_id')
  async getFeatureFamily(@Req() req: AppRequest, @Param('feature_family_id') featureFamilyId: string): Promise<GetFeatureFamily200> {
    const data = await this.feature_familiesService.getFeatureFamily(req, featureFamilyId)
    return okEnvelope(data) as GetFeatureFamily200
  }

  @Patch('feature-families/:feature_family_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'feature_family.update',
    operationId: 'updateFeatureFamily',
    targetType: 'feature_family',
    targetIdFrom: 'params.feature_family_id',
  })
  async updateFeatureFamily(
    @Req() req: AppRequest,
    @Param('feature_family_id') featureFamilyId: string,
    @Body() body: UpdateFeatureFamilyBody,
  ): Promise<UpdateFeatureFamily200> {
    const data = await this.feature_familiesService.updateFeatureFamily(req, featureFamilyId, body ?? {})
    return okEnvelope(data) as UpdateFeatureFamily200
  }

  @Delete('feature-families/:feature_family_id')
  @Audit({
    action: 'feature_family.delete',
    operationId: 'deleteFeatureFamily',
    targetType: 'feature_family',
    targetIdFrom: 'params.feature_family_id',
  })
  async deleteFeatureFamily(
    @Req() req: AppRequest,
    @Param('feature_family_id') featureFamilyId: string,
  ): Promise<DeleteFeatureFamily200> {
    const data = await this.feature_familiesService.deleteFeatureFamily(req, featureFamilyId)
    return okEnvelope(data) as DeleteFeatureFamily200
  }
}
