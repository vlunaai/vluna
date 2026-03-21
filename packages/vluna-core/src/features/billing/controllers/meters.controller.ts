import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common'
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
import { MetersManagementService } from '../services/meters-management.service.js'

// OpenAPI mapping: tag=Meters
// Paths:
// - GET  /meters (operationId: listMeters)
// - POST /meters (operationId: upsertMeter)
// - GET  /meters/{meter_id} (operationId: getMeter)
// - PATCH /meters/{meter_id} (operationId: updateMeter)

type ListMetersQuery = QueryParams<BillingOps, 'listMeters'>
type ListMeters200 = JsonResponse<BillingOps, 'listMeters', 200>
type UpsertMeterBody = JsonRequestBody<BillingOps, 'upsertMeter'>
type UpsertMeter201 = JsonResponse<BillingOps, 'upsertMeter', 201>
type UpsertMeter200 = JsonResponse<BillingOps, 'upsertMeter', 200>
type GetMeter200 = JsonResponse<BillingOps, 'getMeter', 200>
type UpdateMeterBody = JsonRequestBody<BillingOps, 'updateMeter'>
type UpdateMeter200 = JsonResponse<BillingOps, 'updateMeter', 200>

@Controller()
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, RequireServiceAuthGuard)
export class MetersController {
  constructor(@Inject(MetersManagementService) private readonly metersService: MetersManagementService) {}

  @Get('meters')
  async listMeters(@Req() req: AppRequest, @Query() query: ListMetersQuery): Promise<ListMeters200> {
    const data = await this.metersService.listMeters(req, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListMeters200
  }

  @Post('meters')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: ({ reply, error }) => {
      if (error) return 'meter.upsert'
      return reply.statusCode === 201 ? 'meter.create' : 'meter.update'
    },
    operationId: 'upsertMeter',
    targetType: 'meter',
    targetIdFrom: 'response.data.meter_id',
  })
  async upsertMeter(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: UpsertMeterBody,
  ): Promise<UpsertMeter201 | UpsertMeter200> {
    const { created, meter } = await this.metersService.upsertMeter(req, body)
    const payload = okEnvelope(meter) as UpsertMeter201
    const status = created ? 201 : 200
    try { await res.status(status).send(payload) } catch {}
    return payload
  }

  @Get('meters/:meter_id')
  async getMeter(@Req() req: AppRequest, @Param('meter_id') meterId: string): Promise<GetMeter200> {
    const data = await this.metersService.getMeter(req, meterId)
    return okEnvelope(data) as GetMeter200
  }

  @Patch('meters/:meter_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'meter.update',
    operationId: 'updateMeter',
    targetType: 'meter',
    targetIdFrom: 'params.meter_id',
  })
  async updateMeter(
    @Req() req: AppRequest,
    @Param('meter_id') meterId: string,
    @Body() body: UpdateMeterBody,
  ): Promise<UpdateMeter200> {
    const data = await this.metersService.updateMeter(req, meterId, body ?? {})
    return okEnvelope(data) as UpdateMeter200
  }
}
