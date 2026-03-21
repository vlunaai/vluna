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
import { okEnvelope } from '../../../common/envelope.js'
import type { AppRequest } from '../../../types/app-request.js'
import { GatePolicyBundlesService } from '../services/gate-policy-bundles.service.js'
import { GatePoliciesService } from '../services/gate-policies.service.js'
import { BASE_POLICY_NAME, DEFAULT_BUNDLE_KEY } from '../../../constants/billing.js'

type GatePolicyBundleListEnvelope = {
  data: {
    items?: Array<Record<string, unknown>>
    next_cursor?: string | null
  }
  meta?: Record<string, unknown>
}

type GatePolicyBundleEnvelope = {
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

function isSystemReservedBundleKey(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return value.trim() === DEFAULT_BUNDLE_KEY
}

function isSystemReservedPolicyName(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return value.trim() === BASE_POLICY_NAME
}

function filterSystemBundles(data: { items?: Array<Record<string, unknown>>; next_cursor?: string | null }) {
  const items = (data.items ?? []).filter((item) => !isSystemReservedBundleKey(item.bundle_key))
  return { ...data, items }
}

function filterSystemPolicies(data: { items?: Array<Record<string, unknown>>; next_cursor?: string | null }) {
  const items = (data.items ?? []).filter((item) => !isSystemReservedPolicyName(item.name))
  return { ...data, items }
}

function stripEnforcementFromList(data: { items?: Array<Record<string, unknown>>; next_cursor?: string | null }) {
  const items = (data.items ?? []).map((item) => {
    const { enforcement_mode: _ignored, ...rest } = item
    return rest
  })
  return { ...data, items }
}

@Controller('gate/policy-bundles')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, RequireServiceAuthGuard)
export class GatePolicyBundlesController {
  constructor(
    @Inject(GatePolicyBundlesService) private readonly bundles: GatePolicyBundlesService,
    @Inject(GatePoliciesService) private readonly policies: GatePoliciesService,
  ) {}

  @Get()
  async listPolicyBundles(@Req() req: AppRequest, @Query() query: Record<string, unknown>): Promise<GatePolicyBundleListEnvelope> {
    const data = await this.bundles.listPolicyBundles(req, query ?? {})
    return okEnvelope(filterSystemBundles(data)) as GatePolicyBundleListEnvelope
  }

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: ({ reply, error }) => {
      if (error) return 'gate_policy_bundle.upsert'
      return reply.statusCode === 201 ? 'gate_policy_bundle.create' : 'gate_policy_bundle.update'
    },
    operationId: 'upsertGatePolicyBundle',
    targetType: 'gate_policy_bundle',
    targetIdFrom: 'response.data.bundle_id',
  })
  async upsertPolicyBundle(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: Record<string, unknown>,
  ): Promise<GatePolicyBundleEnvelope> {
    if (isSystemReservedBundleKey(body?.bundle_key)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'cannot modify system bundle' }, 422)
    }
    const { created, bundle } = await this.bundles.upsertPolicyBundle(req, body ?? {})
    const payload = okEnvelope(bundle) as GatePolicyBundleEnvelope
    const status = created ? 201 : 200
    try { await res.status(status).send(payload) } catch {}
    return payload
  }

  @Get(':bundle_id')
  async getPolicyBundle(@Req() req: AppRequest, @Param('bundle_id') bundleId: string): Promise<GatePolicyBundleEnvelope> {
    const data = await this.bundles.getPolicyBundle(req, bundleId)
    return okEnvelope(data) as GatePolicyBundleEnvelope
  }

  @Patch(':bundle_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'gate_policy_bundle.update',
    operationId: 'updateGatePolicyBundle',
    targetType: 'gate_policy_bundle',
    targetIdFrom: 'params.bundle_id',
  })
  async updatePolicyBundle(
    @Req() req: AppRequest,
    @Param('bundle_id') bundleId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<GatePolicyBundleEnvelope> {
    const existing = await this.bundles.getPolicyBundle(req, bundleId)
    if (isSystemReservedBundleKey(existing?.bundle_key)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'cannot modify system bundle' }, 422)
    }
    const data = await this.bundles.updatePolicyBundle(req, bundleId, body ?? {})
    return okEnvelope(data) as GatePolicyBundleEnvelope
  }

  @Delete(':bundle_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'gate_policy_bundle.delete',
    operationId: 'deleteGatePolicyBundle',
    targetType: 'gate_policy_bundle',
    targetIdFrom: 'params.bundle_id',
  })
  async deletePolicyBundle(
    @Req() req: AppRequest,
    @Param('bundle_id') bundleId: string,
  ): Promise<GatePolicyBundleEnvelope> {
    const existing = await this.bundles.getPolicyBundle(req, bundleId)
    if (isSystemReservedBundleKey(existing?.bundle_key)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'cannot modify system bundle' }, 422)
    }
    const data = await this.bundles.deletePolicyBundle(req, bundleId)
    return okEnvelope(data) as GatePolicyBundleEnvelope
  }

  @Get(':bundle_id/policies')
  async listPoliciesForBundle(
    @Req() req: AppRequest,
    @Param('bundle_id') bundleId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<GatePolicyListEnvelope> {
    const data = await this.policies.listPoliciesForBundle(req, bundleId, query ?? {})
    return okEnvelope(stripEnforcementFromList(filterSystemPolicies(data))) as GatePolicyListEnvelope
  }
}
