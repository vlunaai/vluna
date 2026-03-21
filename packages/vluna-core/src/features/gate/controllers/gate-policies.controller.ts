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
import { okEnvelope } from '../../../common/envelope.js'
import { GatePoliciesService } from '../services/gate-policies.service.js'
import { BASE_POLICY_NAME } from '../../../constants/billing.js'

type GatePolicyEnvelope = {
  data: Record<string, unknown>
  meta?: Record<string, unknown>
}

type GatePolicyListEnvelope = {
  data: {
    items?: Array<Record<string, unknown>>
    next_cursor?: string | null
  }
  meta?: Record<string, unknown>
}

function isSystemReservedPolicyName(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return value.trim() === BASE_POLICY_NAME
}

function stripEnforcementMode(policy: Record<string, unknown>): Record<string, unknown> {
  const { enforcement_mode: _ignored, ...rest } = policy
  return rest
}

function stripEnforcementFromList(data: { items?: Array<Record<string, unknown>>; next_cursor?: string | null }) {
  const items = (data.items ?? []).map((item) => stripEnforcementMode(item))
  return { ...data, items }
}

function filterSystemPolicies(data: { items?: Array<Record<string, unknown>>; next_cursor?: string | null }) {
  const items = (data.items ?? []).filter((item) => !isSystemReservedPolicyName(item.name))
  return { ...data, items }
}

@Controller('gate/policies')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, RequireServiceAuthGuard)
export class GatePoliciesController {
  constructor(@Inject(GatePoliciesService) private readonly policies: GatePoliciesService) {}

  @Get()
  async listPolicies(@Req() req: AppRequest, @Query() query: Record<string, unknown>): Promise<GatePolicyListEnvelope> {
    const data = await this.policies.listPolicies(req, query ?? {})
    return okEnvelope(stripEnforcementFromList(filterSystemPolicies(data))) as GatePolicyListEnvelope
  }

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'gate_policy.create',
    operationId: 'createGatePolicy',
    targetType: 'gate_policy',
    targetIdFrom: 'response.data.policy_id',
  })
  async createPolicy(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: Record<string, unknown>,
  ): Promise<GatePolicyEnvelope> {
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'enforcement_mode')) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'enforcement_mode is not supported' }, 422)
    }
    if (isSystemReservedPolicyName(body?.name)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'cannot modify system policy' }, 422)
    }
    const { policy } = await this.policies.createPolicy(req, body)
    const payload = okEnvelope(stripEnforcementMode(policy)) as GatePolicyEnvelope
    try { await res.status(201).send(payload) } catch {}
    return payload
  }

  @Get(':policy_id')
  async getPolicy(@Req() req: AppRequest, @Param('policy_id') policyId: string): Promise<GatePolicyEnvelope> {
    const data = await this.policies.getPolicy(req, policyId)
    return okEnvelope(stripEnforcementMode(data)) as GatePolicyEnvelope
  }

  @Patch(':policy_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'gate_policy.update',
    operationId: 'updateGatePolicy',
    targetType: 'gate_policy',
    targetIdFrom: 'params.policy_id',
  })
  async updatePolicy(
    @Req() req: AppRequest,
    @Param('policy_id') policyId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<GatePolicyEnvelope> {
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'enforcement_mode')) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'enforcement_mode is not supported' }, 422)
    }
    const existing = await this.policies.getPolicy(req, policyId)
    if (isSystemReservedPolicyName(existing?.name)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'cannot modify system policy' }, 422)
    }
    const data = await this.policies.updatePolicy(req, policyId, body ?? {})
    return okEnvelope(stripEnforcementMode(data)) as GatePolicyEnvelope
  }

  @Delete(':policy_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'gate_policy.delete',
    operationId: 'deleteGatePolicy',
    targetType: 'gate_policy',
    targetIdFrom: 'params.policy_id',
  })
  async deletePolicy(
    @Req() req: AppRequest,
    @Param('policy_id') policyId: string,
  ): Promise<GatePolicyEnvelope> {
    const existing = await this.policies.getPolicy(req, policyId)
    if (isSystemReservedPolicyName(existing?.name)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'cannot modify system policy' }, 422)
    }
    const data = await this.policies.deletePolicy(req, policyId)
    return okEnvelope(data) as GatePolicyEnvelope
  }
}
