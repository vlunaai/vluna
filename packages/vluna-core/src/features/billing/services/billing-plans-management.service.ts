import { HttpException, Injectable } from '@nestjs/common'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { setRlsSession } from '../../../db/index.js'
import type { components as BillingComponents } from '../../../contracts/billing-mgt.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { Database } from '../../../types/database.js'
import {
  ensureBillingPlanAssignment,
  upsertBillingPlan,
} from '../../../services/billing-plan.service.js'
import { allowCrossAccountAccess } from '../../../auth/utils/access.js'
import { invalidateGateRuntimeCaches } from '../../gate/services/quota.service.js'

type BillingPlan = BillingComponents['schemas']['BillingPlan']
type BillingPlanList = BillingComponents['schemas']['BillingPlanList']
type BillingPlanEntitlement = BillingComponents['schemas']['BillingPlanEntitlement']
type BillingPlanEntitlementList = BillingComponents['schemas']['BillingPlanEntitlementList']
type BillingPlanAssignment = BillingComponents['schemas']['BillingPlanAssignment']
type BillingPlanAssignmentList = BillingComponents['schemas']['BillingPlanAssignmentList']

type PlanKind = 'base' | 'addon' | 'promo'
type EntitlementEffect = 'allow' | 'deny'
type AssignmentScope = 'account' | 'user'
type AssignmentStatus = 'active' | 'paused' | 'canceled' | 'expired'
type AssignmentSourceKind =
  | 'signup.default'
  | 'provider.subscription_item'
  | 'provider.subscription'
  | 'ops.manual'
  | 'ops.campaign'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function clampLimit(value: number, fallback = 50, max = 200): number {
  if (!Number.isFinite(value)) return fallback
  if (value <= 0) return fallback
  return Math.min(Math.trunc(value), max)
}

function normalizeString(value: unknown): string {
  return String(value ?? '').trim()
}

function parseList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeString(entry)).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean)
  }
  const asString = normalizeString(value)
  return asString ? [asString] : []
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true
    if (value.toLowerCase() === 'false') return false
  }
  return undefined
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'metadata must be an object' }, 422)
  }
  return { ...(value as Record<string, unknown>) }
}

function normalizeAssignmentMetadata(value: unknown): Record<string, unknown> {
  const metadata = normalizeMetadata(value)
  if (Object.prototype.hasOwnProperty.call(metadata, 'gate_bundle_key')) {
    throw new HttpException({
      code: 'VALIDATION.INVALID_INPUT',
      message: 'billing plan assignment metadata must not contain gate_bundle_key',
    }, 422)
  }
  const gating = metadata.gating
  if (gating && typeof gating === 'object' && !Array.isArray(gating)) {
    const gatingObj = gating as Record<string, unknown>
    if (
      Object.prototype.hasOwnProperty.call(gatingObj, 'gate_bundle_key') ||
      Object.prototype.hasOwnProperty.call(gatingObj, 'bundle')
    ) {
      throw new HttpException({
        code: 'VALIDATION.INVALID_INPUT',
        message: 'billing plan assignment metadata must not contain runtime gate bundle fields',
      }, 422)
    }
  }
  return metadata
}

function parseId(value: string, name: string): string {
  const trimmed = normalizeString(value)
  if (!trimmed || !UUID_RE.test(trimmed)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `invalid ${name}` }, 422)
  }
  return trimmed.toLowerCase()
}

function parseDate(value: unknown, name: string): Date {
  if (value === undefined || value === null) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} is required` }, 422)
  }
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be a date string` }, 422)
  }
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be a valid date` }, 422)
  }
  return date
}

function normalizePlanKind(value: unknown): PlanKind | undefined {
  if (value === 'base' || value === 'addon' || value === 'promo') return value
  return undefined
}

function normalizeSort(value: unknown): string | undefined {
  const key = normalizeString(value)
  if (
    key === 'plan_id' ||
    key === 'plan_code' ||
    key === 'name' ||
    key === 'kind' ||
    key === 'priority' ||
    key === 'active' ||
    key === 'created_at' ||
    key === 'updated_at'
  ) {
    return key
  }
  return undefined
}

function normalizeOrder(value: unknown): 'asc' | 'desc' | undefined {
  const key = normalizeString(value).toLowerCase()
  if (key === 'asc' || key === 'desc') return key
  return undefined
}

function normalizeEntitlementEffect(value: unknown): EntitlementEffect | undefined {
  if (value === 'allow' || value === 'deny') return value
  return undefined
}

function normalizeAssignmentStatus(value: unknown): AssignmentStatus | undefined {
  if (value === 'active' || value === 'paused' || value === 'canceled' || value === 'expired') return value
  return undefined
}

function normalizeAssignmentScope(value: unknown): AssignmentScope | undefined {
  if (value === 'account' || value === 'user') return value
  return undefined
}

function normalizeAssignmentSourceKind(value: unknown): AssignmentSourceKind | undefined {
  if (
    value === 'signup.default' ||
    value === 'provider.subscription_item' ||
    value === 'provider.subscription' ||
    value === 'ops.manual' ||
    value === 'ops.campaign'
  ) {
    return value
  }
  return undefined
}

@Injectable()
export class BillingPlansManagementService {
  async listBillingPlans(req: AppRequest, query: Record<string, unknown>): Promise<BillingPlanList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursor = typeof query?.cursor === 'string' ? query.cursor.trim() : ''
    const sort = normalizeSort(query?.sort) ?? 'plan_id'
    const order = normalizeOrder(query?.order) ?? 'asc'
    const kindList = parseList(query?.kind)
      .map((value) => normalizePlanKind(value))
      .filter((value): value is PlanKind => Boolean(value))
    const active = normalizeBoolean(query?.active)
    const planIdList = parseList(query?.plan_id).map((value) => parseId(value, 'plan_id'))
    const planCodeList = parseList(query?.plan_code)
    const q = normalizeString(query?.q)
    const include = parseList(query?.include)
    const includeEntitlements = include.length === 0 || include.includes('entitlements')
    const featureFamilyCodes = parseList(query?.feature_family_code)
    const featureCodes = parseList(query?.feature_code)
    const gateBundleKey = normalizeString(query?.gate_bundle_key)
    const issueAnchor = normalizeString(query?.issue_anchor)
    const billingMode = normalizeString(query?.billing_mode)
    const grantProgramCodes = parseList(query?.grant_program_code)

    let builder = trx
      .selectFrom('billing_plans')
      .select([
        'plan_id',
        'plan_code',
        'name',
        'kind',
        'priority',
        'active',
        'metadata',
        'created_at',
        'updated_at',
      ])
      .where('realm_id', '=', realmId)
      .orderBy(sql.ref(sort), order)

    if (cursor) {
      builder = builder.where('plan_id', '>', parseId(cursor, 'cursor'))
    }
    if (kindList.length > 0) {
      builder = builder.where('kind', 'in', kindList)
    }
    if (active !== undefined) {
      builder = builder.where('active', '=', active)
    }
    if (planIdList.length > 0) {
      builder = builder.where('plan_id', 'in', planIdList)
    }
    if (planCodeList.length > 0) {
      builder = builder.where('plan_code', 'in', planCodeList)
    }
    if (q) {
      const like = `%${q}%`
      builder = builder.where((eb) => eb.or([eb('name', 'ilike', like), eb('plan_code', 'ilike', like)]))
    }
    if (gateBundleKey) {
      builder = builder.where(sql`billing_plans.metadata ->> 'gate_bundle_key'`, '=', gateBundleKey)
    }
    if (issueAnchor) {
      builder = builder.where(
        sql`billing_plans.metadata -> 'billing_defaults' -> 'period' ->> 'issue_anchor'`,
        '=',
        issueAnchor,
      )
    }
    if (billingMode) {
      builder = builder.where(
        sql`billing_plans.metadata -> 'billing_defaults' -> 'period' ->> 'billing_mode'`,
        '=',
        billingMode,
      )
    }
    if (featureFamilyCodes.length > 0) {
      builder = builder.where((eb) =>
        eb.exists(
          eb
            .selectFrom('billing_plan_entitlements as bpe')
            .innerJoin('feature_families as c', 'c.feature_family_id', 'bpe.feature_family_id')
            .select(sql`1`.as('one'))
            .whereRef('bpe.plan_id', '=', 'billing_plans.plan_id')
            .where('c.feature_family_code', 'in', featureFamilyCodes),
        ),
      )
    }
    if (featureCodes.length > 0) {
      builder = builder.where((eb) =>
        eb.exists(
          eb
            .selectFrom('billing_plan_entitlements as bpe')
            .innerJoin('features as f', 'f.feature_id', 'bpe.feature_id')
            .select(sql`1`.as('one'))
            .whereRef('bpe.plan_id', '=', 'billing_plans.plan_id')
            .where('f.feature_code', 'in', featureCodes),
        ),
      )
    }
    if (grantProgramCodes.length > 0) {
      builder = builder.where((eb) =>
        eb.or(
          grantProgramCodes.map((code) =>
            sql<boolean>`exists (
              select 1
              from jsonb_array_elements(billing_plans.metadata -> 'grants') as g
              where g ->> 'grant_program_code' = ${code}
            )`,
          ),
        ),
      )
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const slice = rows.slice(0, limit)
    const planIds = slice.map((row) => String(row.plan_id))
    const entitlementMap = includeEntitlements
      ? await this.listEntitlementCodes(trx, realmId, planIds)
      : new Map()

    const items = slice.map((row) =>
      this.mapPlanRow(row, entitlementMap.get(String(row.plan_id)), includeEntitlements),
    )
    const nextCursor = hasMore ? items[items.length - 1]?.plan_id ?? null : null
    return { items, next_cursor: nextCursor } satisfies BillingPlanList
  }

  async getBillingPlan(req: AppRequest, planId: string): Promise<BillingPlan> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(planId, 'plan_id')

    const row = await trx
      .selectFrom('billing_plans')
      .select([
        'plan_id',
        'plan_code',
        'name',
        'kind',
        'priority',
        'active',
        'metadata',
        'created_at',
        'updated_at',
      ])
      .where('realm_id', '=', realmId)
      .where('plan_id', '=', id)
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing plan not found' }, 404)
    }

    const entitlementMap = await this.listEntitlementCodes(trx, realmId, [String(row.plan_id)])
    return this.mapPlanRow(row, entitlementMap.get(String(row.plan_id)))
  }

  async upsertBillingPlan(
    req: AppRequest,
    body: {
      plan_code: string
      name: string
      kind: PlanKind
      priority?: number
      active?: boolean
      metadata?: Record<string, unknown>
      feature_codes?: string[]
      feature_family_codes?: string[]
    },
  ): Promise<{ created: boolean; plan: BillingPlan }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const planCode = normalizeString(body?.plan_code)
    if (!planCode) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'plan_code is required' }, 422)
    }
    const name = normalizeString(body?.name)
    if (!name) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'name is required' }, 422)
    }
    const kind = normalizePlanKind(body?.kind)
    if (!kind) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'kind is required' }, 422)
    }

    const priority = body?.priority ?? 0
    const active = body?.active ?? true
    const metadata = normalizeAssignmentMetadata(body?.metadata)

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('billing_plans')
      .select(['plan_id'])
      .where('realm_id', '=', realmId)
      .where('plan_code', '=', planCode)
      .executeTakeFirst()

    const planId = await upsertBillingPlan(trx, {
      realmId,
      planCode,
      name,
      kind,
      priority,
      active,
      metadata,
      featureCodes: body?.feature_codes,
      featureFamilyCodes: body?.feature_family_codes,
    })

    const plan = await this.getBillingPlan(req, planId)
    return { created: !existing, plan }
  }

  async updateBillingPlan(
    req: AppRequest,
    planId: string,
    body: {
      plan_code?: string
      name?: string
      kind?: PlanKind
      priority?: number
      active?: boolean
      metadata?: Record<string, unknown>
      feature_codes?: string[]
      feature_family_codes?: string[]
    },
  ): Promise<BillingPlan> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(planId, 'plan_id')

    const existing = await trx
      .selectFrom('billing_plans')
      .select([
        'plan_id',
        'plan_code',
        'name',
        'kind',
        'priority',
        'active',
        'metadata',
      ])
      .where('realm_id', '=', realmId)
      .where('plan_id', '=', id)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing plan not found' }, 404)
    }

    const planCode = body?.plan_code === undefined ? String(existing.plan_code) : normalizeString(body.plan_code)
    if (!planCode) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'plan_code is required' }, 422)
    }
    const name = body?.name === undefined ? String(existing.name) : normalizeString(body.name)
    if (!name) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'name is required' }, 422)
    }
    const kind = body?.kind === undefined ? (existing.kind as PlanKind) : normalizePlanKind(body.kind)
    if (!kind) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'kind is required' }, 422)
    }
    const priority = body?.priority === undefined ? Number(existing.priority) : Number(body.priority)
    const active = body?.active === undefined ? Boolean(existing.active) : Boolean(body.active)
    const metadata = body?.metadata === undefined ? (existing.metadata ?? {}) : normalizeMetadata(body.metadata)

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    await trx
      .updateTable('billing_plans')
      .set({
        plan_code: planCode,
        name,
        kind,
        priority,
        active,
        metadata,
        updated_at: sql`now()`,
      })
      .where('realm_id', '=', realmId)
      .where('plan_id', '=', id)
      .executeTakeFirst()

    invalidateGateRuntimeCaches()
    if (body?.feature_codes !== undefined || body?.feature_family_codes !== undefined) {
      await this.replacePlanEntitlements(trx, realmId, id, body?.feature_family_codes, body?.feature_codes)
      invalidateGateRuntimeCaches()
    }

    return this.getBillingPlan(req, id)
  }

  async listBillingPlanEntitlements(
    req: AppRequest,
    planId: string,
    query: Record<string, unknown>,
  ): Promise<BillingPlanEntitlementList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(planId, 'plan_id')
    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursor = typeof query?.cursor === 'string' ? query.cursor.trim() : ''

    let builder = trx
      .selectFrom('billing_plan_entitlements as bpe')
      .innerJoin('billing_plans as bp', 'bp.plan_id', 'bpe.plan_id')
      .leftJoin('feature_families as c', 'c.feature_family_id', 'bpe.feature_family_id')
      .leftJoin('features as f', 'f.feature_id', 'bpe.feature_id')
      .select([
        'bpe.bpe_id as bpe_id',
        'bpe.plan_id as plan_id',
        'bpe.feature_family_id as feature_family_id',
        'bpe.feature_id as feature_id',
        'bpe.effect as effect',
        'bpe.created_at as created_at',
        'bpe.updated_at as updated_at',
        'c.feature_family_code as feature_family_code',
        'f.feature_code as feature_code',
      ])
      .where('bp.realm_id', '=', realmId)
      .where('bpe.plan_id', '=', id)
      .orderBy('bpe.bpe_id', 'asc')

    if (cursor) {
      builder = builder.where('bpe.bpe_id', '>', parseId(cursor, 'cursor'))
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => this.mapEntitlementRow(row))
    const nextCursor = hasMore ? items[items.length - 1]?.bpe_id ?? null : null
    return { items, next_cursor: nextCursor } satisfies BillingPlanEntitlementList
  }

  async upsertBillingPlanEntitlements(
    req: AppRequest,
    planId: string,
    body: {
      mode: 'append' | 'replace'
      items: Array<{ feature_family_code?: string; feature_code?: string; effect?: EntitlementEffect }>
    },
  ): Promise<BillingPlanEntitlementList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(planId, 'plan_id')
    const mode = body?.mode === 'replace' ? 'replace' : 'append'
    const items = Array.isArray(body?.items) ? body.items : []

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    await this.ensurePlanExists(trx, realmId, id)

    if (mode === 'replace') {
      await trx.deleteFrom('billing_plan_entitlements').where('plan_id', '=', id).execute()
    }

    for (const item of items) {
      const effect = normalizeEntitlementEffect(item?.effect) ?? 'allow'
      const featureFamilyCode = item?.feature_family_code ? normalizeString(item.feature_family_code) : ''
      const featureCode = item?.feature_code ? normalizeString(item.feature_code) : ''
      if (!featureFamilyCode && !featureCode) {
        throw new HttpException({
          code: 'VALIDATION.INVALID_INPUT',
          message: 'feature_family_code or feature_code is required',
        }, 422)
      }
      if (featureFamilyCode && featureCode) {
        throw new HttpException({
          code: 'VALIDATION.INVALID_INPUT',
          message: 'feature_family_code and feature_code are mutually exclusive',
        }, 422)
      }

      if (featureFamilyCode) {
        const cap = await trx
          .selectFrom('feature_families')
          .select(['feature_family_id'])
          .where('realm_id', '=', realmId)
          .where('feature_family_code', '=', featureFamilyCode)
          .executeTakeFirst()
        if (!cap) {
          throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'feature_family_code not found' }, 422)
        }
        await trx
          .insertInto('billing_plan_entitlements')
          .values({
            plan_id: id,
            feature_family_id: cap.feature_family_id,
            feature_id: null,
            effect,
          })
          .onConflict((oc) =>
            oc.columns(['plan_id', 'feature_family_id']).doUpdateSet({
              effect,
              updated_at: sql`now()`,
            }),
          )
          .execute()
        continue
      }

      const feature = await trx
        .selectFrom('features')
        .select(['feature_id'])
        .where('realm_id', '=', realmId)
        .where('feature_code', '=', featureCode)
        .executeTakeFirst()
      if (!feature) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'feature_code not found' }, 422)
      }
      await trx
        .insertInto('billing_plan_entitlements')
        .values({
          plan_id: id,
          feature_family_id: null,
          feature_id: feature.feature_id,
          effect,
        })
        .onConflict((oc) =>
          oc.columns(['plan_id', 'feature_id']).doUpdateSet({
            effect,
            updated_at: sql`now()`,
          }),
        )
        .execute()
    }

    return this.listBillingPlanEntitlements(req, id, {})
  }

  async deleteBillingPlanEntitlement(
    req: AppRequest,
    planId: string,
    entitlementId: string,
  ): Promise<BillingPlanEntitlement> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const plan = parseId(planId, 'plan_id')
    const bpeId = parseId(entitlementId, 'bpe_id')

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const row = await trx
      .selectFrom('billing_plan_entitlements as bpe')
      .innerJoin('billing_plans as bp', 'bp.plan_id', 'bpe.plan_id')
      .leftJoin('feature_families as c', 'c.feature_family_id', 'bpe.feature_family_id')
      .leftJoin('features as f', 'f.feature_id', 'bpe.feature_id')
      .select([
        'bpe.bpe_id as bpe_id',
        'bpe.plan_id as plan_id',
        'bpe.feature_family_id as feature_family_id',
        'bpe.feature_id as feature_id',
        'bpe.effect as effect',
        'bpe.created_at as created_at',
        'bpe.updated_at as updated_at',
        'c.feature_family_code as feature_family_code',
        'f.feature_code as feature_code',
      ])
      .where('bp.realm_id', '=', realmId)
      .where('bpe.plan_id', '=', plan)
      .where('bpe.bpe_id', '=', bpeId)
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing plan entitlement not found' }, 404)
    }

    await trx.deleteFrom('billing_plan_entitlements').where('bpe_id', '=', bpeId).execute()
    return this.mapEntitlementRow(row)
  }

  async listBillingPlanAssignments(req: AppRequest, query: Record<string, unknown>): Promise<BillingPlanAssignmentList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const ctxBillingAccountId = req?.ctx?.billingAccountId
    const queryBillingAccountId = typeof query?.billing_account_id === 'string' ? query.billing_account_id.trim() : ''
    const queryBillingUserId = typeof query?.billing_user_id === 'string' ? query.billing_user_id.trim() : ''
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    if (allowCrossAccount && queryBillingAccountId && queryBillingAccountId !== ctxBillingAccountId) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = queryBillingAccountId
    }
    const billingAccountId = queryBillingAccountId || ctxBillingAccountId
    if (!billingAccountId) {
      throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'billing_account_id required' }, 403)
    }
    if (!allowCrossAccount && queryBillingAccountId && ctxBillingAccountId && queryBillingAccountId !== ctxBillingAccountId) {
      throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'billing_account_id mismatch' }, 403)
    }
    const billingUserId = queryBillingUserId ? parseId(queryBillingUserId, 'billing_user_id') : ''
    await setRlsSession(trx, {
      realmId,
      billingAccountId,
      billingUserId: billingUserId || undefined,
      isRealmAdmin: allowCrossAccount,
    })

    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursor = typeof query?.cursor === 'string' ? query.cursor.trim() : ''
    const status = normalizeAssignmentStatus(query?.status)
    const sourceKind = normalizeAssignmentSourceKind(query?.source_kind)
    const assignmentScope = normalizeAssignmentScope(query?.assignment_scope)
    const windowStart = query?.window_start ? parseDate(query.window_start, 'window_start') : undefined
    const windowEnd = query?.window_end ? parseDate(query.window_end, 'window_end') : undefined
    const planId = query?.plan_id ? parseId(String(query.plan_id), 'plan_id') : ''
    const planCode = normalizeString(query?.plan_code)
    const subscriptionItemId = normalizeString(query?.subscription_item_id)
    const providerSubscriptionId = normalizeString(query?.provider_subscription_id)
    const providerPriceId = normalizeString(query?.provider_price_id)
    const provider = normalizeString(query?.provider)
    const grantProgramId = normalizeString(query?.grant_program_id)
    const grantProgramCode = normalizeString(query?.grant_program_code)
    const campaignId = normalizeString(query?.campaign_id)

    let builder = trx
      .selectFrom('billing_plan_assignments as bpa')
      .innerJoin('billing_plans as bp', 'bp.plan_id', 'bpa.plan_id')
      .select([
        'bpa.assignment_id as assignment_id',
        'bpa.billing_account_id as billing_account_id',
        'bpa.assignment_scope as assignment_scope',
        'bpa.billing_user_id as billing_user_id',
        'bpa.plan_id as plan_id',
        'bp.plan_code as plan_code',
        'bpa.subscription_item_id as subscription_item_id',
        'bpa.source_kind as source_kind',
        'bpa.source_ref as source_ref',
        'bpa.window_start as window_start',
        'bpa.window_end as window_end',
        'bpa.status as status',
        'bpa.metadata as metadata',
        'bpa.created_at as created_at',
        'bpa.updated_at as updated_at',
      ])
      .where('bp.realm_id', '=', realmId)
      .where('bpa.billing_account_id', '=', billingAccountId)
      .orderBy('bpa.assignment_id', 'asc')

    if (billingUserId) {
      builder = builder.where('bpa.billing_user_id', '=', billingUserId)
    }
    if (cursor) {
      builder = builder.where('bpa.assignment_id', '>', parseId(cursor, 'cursor'))
    }
    if (status) {
      builder = builder.where('bpa.status', '=', status)
    }
    if (sourceKind) {
      builder = builder.where('bpa.source_kind', '=', sourceKind)
    }
    if (assignmentScope) {
      builder = builder.where('bpa.assignment_scope', '=', assignmentScope)
    }
    if (planId) {
      builder = builder.where('bpa.plan_id', '=', planId)
    }
    if (planCode) {
      builder = builder.where('bp.plan_code', '=', planCode)
    }
    if (subscriptionItemId) {
      builder = builder.where('bpa.subscription_item_id', '=', subscriptionItemId)
    }
    if (providerSubscriptionId) {
      builder = builder.where(sql`bpa.metadata ->> 'provider_subscription_id'`, '=', providerSubscriptionId)
    }
    if (providerPriceId) {
      builder = builder.where(sql`bpa.metadata ->> 'provider_price_id'`, '=', providerPriceId)
    }
    if (provider) {
      builder = builder.where(sql`bpa.metadata ->> 'provider'`, '=', provider)
    }
    if (windowStart) {
      builder = builder.where('bpa.window_start', '>=', windowStart)
    }
    if (windowEnd) {
      builder = builder.where((eb) =>
        eb.or([eb('bpa.window_end', 'is', null), eb('bpa.window_end', '<=', windowEnd)]),
      )
    }
    if (grantProgramId || grantProgramCode || campaignId) {
      builder = builder.where((eb) => {
        let subquery = eb
          .selectFrom('grant_assignments as ga')
          .select(sql`1`.as('one'))
          .whereRef('ga.billing_plan_assignment_id', '=', 'bpa.assignment_id')
        if (grantProgramId) {
          subquery = subquery.where('ga.program_id', '=', parseId(grantProgramId, 'grant_program_id'))
        }
        if (campaignId) {
          subquery = subquery.where('ga.campaign_id', '=', parseId(campaignId, 'campaign_id'))
        }
        if (grantProgramCode) {
          subquery = subquery.where(
            'ga.program_id',
            'in',
            eb
              .selectFrom('grant_programs as gp')
              .select('gp.program_id')
              .where('gp.program_code', '=', grantProgramCode)
              .where('gp.realm_id', '=', realmId),
          )
        }
        return eb.exists(subquery)
      })
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => this.mapAssignmentRow(row))
    const nextCursor = hasMore ? items[items.length - 1]?.assignment_id ?? null : null
    return { items, next_cursor: nextCursor } satisfies BillingPlanAssignmentList
  }

  async createBillingPlanAssignment(
    req: AppRequest,
    body: {
      billing_account_id: string
      assignment_scope: AssignmentScope
      billing_user_id?: string | null
      plan_id: string
      subscription_item_id?: string | null
      source_kind: AssignmentSourceKind
      source_ref: string
      window_start: string
      window_end?: string | null
      status?: AssignmentStatus
      metadata?: Record<string, unknown>
    },
  ): Promise<BillingPlanAssignment> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const billingAccountId = normalizeString(body?.billing_account_id)
    if (!billingAccountId) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'billing_account_id is required' }, 422)
    }
    const assignmentScope = normalizeAssignmentScope(body?.assignment_scope)
    if (!assignmentScope) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'assignment_scope is required' }, 422)
    }
    const billingUserIdRaw = normalizeString(body?.billing_user_id)
    const billingUserId = billingUserIdRaw ? parseId(billingUserIdRaw, 'billing_user_id') : null
    if (assignmentScope === 'user' && !billingUserId) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'billing_user_id is required for user assignments' }, 422)
    }
    if (assignmentScope === 'account' && billingUserId) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'billing_user_id must be omitted for account assignments' }, 422)
    }
    const ctxBillingAccountId = req?.ctx?.billingAccountId
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    if (!allowCrossAccount && ctxBillingAccountId && ctxBillingAccountId !== billingAccountId) {
      throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'billing_account_id mismatch' }, 403)
    }

    const planId = parseId(body?.plan_id, 'plan_id')
    const sourceKind = normalizeAssignmentSourceKind(body?.source_kind)
    if (!sourceKind) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'source_kind is required' }, 422)
    }
    const sourceRef = normalizeString(body?.source_ref)
    if (!sourceRef) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'source_ref is required' }, 422)
    }
    const windowStart = parseDate(body?.window_start, 'window_start')
    const windowEnd = body?.window_end ? parseDate(body.window_end, 'window_end') : null
    const status = normalizeAssignmentStatus(body?.status) ?? 'active'
    const metadata = normalizeMetadata(body?.metadata)

    await setRlsSession(trx, {
      realmId,
      billingAccountId,
      billingUserId: billingUserId ?? undefined,
      isRealmAdmin: true,
    })

    await this.ensurePlanExists(trx, realmId, planId)
    if (assignmentScope === 'user') {
      await this.ensureBillingUserBelongsToAccount(trx, realmId, billingAccountId, billingUserId as string)
    }

    const row = await ensureBillingPlanAssignment(trx, {
      billingAccountId,
      assignmentScope,
      billingUserId,
      planId,
      subscriptionItemId: body?.subscription_item_id ?? null,
      sourceKind,
      sourceRef,
      windowStart,
      windowEnd,
      status,
      metadata,
    })

    return this.fetchAssignment(trx, realmId, billingAccountId, String(row.assignment_id))
  }

  async updateBillingPlanAssignment(
    req: AppRequest,
    assignmentId: string,
    body: {
      subscription_item_id?: string | null
      window_start?: string
      window_end?: string | null
      status?: AssignmentStatus
      metadata?: Record<string, unknown>
    },
  ): Promise<BillingPlanAssignment> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(assignmentId, 'assignment_id')
    const ctxBillingAccountId = req?.ctx?.billingAccountId
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    let billingAccountId: string | undefined
    if (allowCrossAccount) {
      await setRlsSession(trx, { realmId, isRealmAdmin: true })
      const owner = await trx
        .selectFrom('billing_plan_assignments as bpa')
        .innerJoin('billing_plans as bp', 'bp.plan_id', 'bpa.plan_id')
        .select(['bpa.billing_account_id as billing_account_id'])
        .where('bp.realm_id', '=', realmId)
        .where('bpa.assignment_id', '=', id)
        .executeTakeFirst()

      if (!owner) {
        throw new HttpException({ code: 'NOT_FOUND', message: 'billing plan assignment not found' }, 404)
      }
      billingAccountId = String(owner.billing_account_id)
    } else {
      billingAccountId = ctxBillingAccountId
      if (!billingAccountId) {
        throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'billing_account_id required' }, 403)
      }
    }

    await setRlsSession(trx, { realmId, billingAccountId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('billing_plan_assignments')
      .select(['assignment_id', 'billing_user_id'])
      .where('billing_account_id', '=', billingAccountId)
      .where('assignment_id', '=', id)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing plan assignment not found' }, 404)
    }

    const updates: Record<string, unknown> = {}
    if (body?.subscription_item_id !== undefined) {
      updates.subscription_item_id = body.subscription_item_id
    }
    if (body?.window_start !== undefined) {
      updates.window_start = parseDate(body.window_start, 'window_start')
    }
    if (body?.window_end !== undefined) {
      updates.window_end = body.window_end ? parseDate(body.window_end, 'window_end') : null
    }
    if (body?.status !== undefined) {
      const status = normalizeAssignmentStatus(body.status)
      if (!status) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'invalid status' }, 422)
      }
      updates.status = status
    }
    if (body?.metadata !== undefined) {
      updates.metadata = normalizeAssignmentMetadata(body.metadata)
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = sql`now()`
      await trx
        .updateTable('billing_plan_assignments')
        .set(updates)
        .where('billing_account_id', '=', billingAccountId)
        .where('assignment_id', '=', id)
        .executeTakeFirst()
      invalidateGateRuntimeCaches()
    }

    return this.fetchAssignment(trx, realmId, billingAccountId, id)
  }

  private async listEntitlementCodes(
    trx: Kysely<Database>,
    realmId: string,
    planIds: string[],
  ): Promise<Map<string, { feature_codes: string[]; feature_family_codes: string[] }>> {
    const result = new Map<string, { feature_codes: string[]; feature_family_codes: string[] }>()
    if (planIds.length === 0) return result

    const rows = await trx
      .selectFrom('billing_plan_entitlements as bpe')
      .innerJoin('billing_plans as bp', 'bp.plan_id', 'bpe.plan_id')
      .leftJoin('feature_families as c', 'c.feature_family_id', 'bpe.feature_family_id')
      .leftJoin('features as f', 'f.feature_id', 'bpe.feature_id')
      .select(['bpe.plan_id as plan_id', 'c.feature_family_code as feature_family_code', 'f.feature_code as feature_code'])
      .where('bp.realm_id', '=', realmId)
      .where('bpe.plan_id', 'in', planIds)
      .execute()

    for (const row of rows) {
      const planId = String(row.plan_id)
      const current = result.get(planId) ?? { feature_codes: [], feature_family_codes: [] }
      if (row.feature_family_code) current.feature_family_codes.push(String(row.feature_family_code))
      if (row.feature_code) current.feature_codes.push(String(row.feature_code))
      result.set(planId, current)
    }
    return result
  }

  private mapPlanRow(
    row: {
      plan_id: unknown
      plan_code: unknown
      name: unknown
      kind: unknown
      priority: unknown
      active: unknown
      metadata: unknown
      created_at: Date
      updated_at: Date
    },
    entitlements?: { feature_codes: string[]; feature_family_codes: string[] },
    includeEntitlements = true,
  ): BillingPlan {
    return {
      plan_id: String(row.plan_id),
      plan_code: String(row.plan_code),
      name: String(row.name),
      kind: row.kind as PlanKind,
      priority: Number(row.priority ?? 0),
      active: Boolean(row.active),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      ...(includeEntitlements
        ? {
            feature_codes: entitlements?.feature_codes ?? [],
            feature_family_codes: entitlements?.feature_family_codes ?? [],
          }
        : {}),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies BillingPlan
  }

  private mapEntitlementRow(row: {
    bpe_id: unknown
    plan_id: unknown
    feature_family_id: unknown
    feature_id: unknown
    effect: unknown
    feature_family_code: unknown
    feature_code: unknown
    created_at: Date
    updated_at: Date
  }): BillingPlanEntitlement {
    return {
      bpe_id: String(row.bpe_id),
      plan_id: String(row.plan_id),
      feature_family_id: row.feature_family_id ? String(row.feature_family_id) : undefined,
      feature_family_code: row.feature_family_code ? String(row.feature_family_code) : undefined,
      feature_id: row.feature_id ? String(row.feature_id) : undefined,
      feature_code: row.feature_code ? String(row.feature_code) : undefined,
      effect: row.effect as EntitlementEffect,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies BillingPlanEntitlement
  }

  private mapAssignmentRow(row: {
    assignment_id: unknown
    billing_account_id: unknown
    assignment_scope: unknown
    billing_user_id: unknown
    plan_id: unknown
    plan_code: unknown
    subscription_item_id: unknown
    source_kind: unknown
    source_ref: unknown
    window_start: Date
    window_end: Date | null
    status: unknown
    metadata: unknown
    created_at: Date
    updated_at: Date
  }): BillingPlanAssignment {
    return {
      assignment_id: String(row.assignment_id),
      billing_account_id: String(row.billing_account_id),
      assignment_scope: row.assignment_scope as AssignmentScope,
      billing_user_id: row.billing_user_id ? String(row.billing_user_id) : null,
      plan_id: String(row.plan_id),
      plan_code: String(row.plan_code),
      subscription_item_id: row.subscription_item_id ? String(row.subscription_item_id) : null,
      source_kind: row.source_kind as AssignmentSourceKind,
      source_ref: String(row.source_ref),
      window_start: row.window_start.toISOString(),
      window_end: row.window_end ? row.window_end.toISOString() : null,
      status: row.status as AssignmentStatus,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies BillingPlanAssignment
  }

  private async fetchAssignment(
    trx: Kysely<Database>,
    realmId: string,
    billingAccountId: string,
    assignmentId: string,
  ): Promise<BillingPlanAssignment> {
    const row = await trx
      .selectFrom('billing_plan_assignments as bpa')
      .innerJoin('billing_plans as bp', 'bp.plan_id', 'bpa.plan_id')
      .select([
        'bpa.assignment_id as assignment_id',
        'bpa.billing_account_id as billing_account_id',
        'bpa.assignment_scope as assignment_scope',
        'bpa.billing_user_id as billing_user_id',
        'bpa.plan_id as plan_id',
        'bp.plan_code as plan_code',
        'bpa.subscription_item_id as subscription_item_id',
        'bpa.source_kind as source_kind',
        'bpa.source_ref as source_ref',
        'bpa.window_start as window_start',
        'bpa.window_end as window_end',
        'bpa.status as status',
        'bpa.metadata as metadata',
        'bpa.created_at as created_at',
        'bpa.updated_at as updated_at',
      ])
      .where('bp.realm_id', '=', realmId)
      .where('bpa.billing_account_id', '=', billingAccountId)
      .where('bpa.assignment_id', '=', assignmentId)
      .executeTakeFirst()
    if (!row) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing plan assignment not found' }, 404)
    }
    return this.mapAssignmentRow(row)
  }

  private async replacePlanEntitlements(
    trx: Kysely<Database>,
    realmId: string,
    planId: string,
    featureFamilyCodes?: string[],
    featureCodes?: string[],
  ): Promise<void> {
    await trx.deleteFrom('billing_plan_entitlements').where('plan_id', '=', planId).execute()

    const capCodes = Array.isArray(featureFamilyCodes) ? featureFamilyCodes.map((c) => normalizeString(c)).filter(Boolean) : []
    const featureCodesClean = Array.isArray(featureCodes) ? featureCodes.map((c) => normalizeString(c)).filter(Boolean) : []

    if (capCodes.length > 0) {
      const caps = await trx
        .selectFrom('feature_families')
        .select(['feature_family_id', 'feature_family_code'])
        .where('realm_id', '=', realmId)
        .where('feature_family_code', 'in', capCodes)
        .execute()
      const codes = new Set(caps.map((c) => String(c.feature_family_code)))
      for (const code of capCodes) {
        if (!codes.has(code)) {
          throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `feature_family_code not found: ${code}` }, 422)
        }
      }
      for (const cap of caps) {
        await trx
          .insertInto('billing_plan_entitlements')
          .values({ plan_id: planId, feature_family_id: cap.feature_family_id, feature_id: null, effect: 'allow' })
          .execute()
      }
    }

    if (featureCodesClean.length > 0) {
      const features = await trx
        .selectFrom('features')
        .select(['feature_id', 'feature_code'])
        .where('realm_id', '=', realmId)
        .where('feature_code', 'in', featureCodesClean)
        .execute()
      const codes = new Set(features.map((f) => String(f.feature_code)))
      for (const code of featureCodesClean) {
        if (!codes.has(code)) {
          throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `feature_code not found: ${code}` }, 422)
        }
      }
      for (const feature of features) {
        await trx
          .insertInto('billing_plan_entitlements')
          .values({ plan_id: planId, feature_family_id: null, feature_id: feature.feature_id, effect: 'allow' })
          .execute()
      }
    }
  }

  private async ensurePlanExists(trx: Kysely<Database>, realmId: string, planId: string): Promise<void> {
    const exists = await trx
      .selectFrom('billing_plans')
      .select(['plan_id'])
      .where('realm_id', '=', realmId)
      .where('plan_id', '=', planId)
      .executeTakeFirst()
    if (!exists) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing plan not found' }, 404)
    }
  }

  private async ensureBillingUserBelongsToAccount(
    trx: Kysely<Database>,
    realmId: string,
    billingAccountId: string,
    billingUserId: string,
  ): Promise<void> {
    const exists = await trx
      .selectFrom('billing_users')
      .select(['billing_user_id'])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .where('billing_user_id', '=', billingUserId)
      .executeTakeFirst()
    if (!exists) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing user not found for billing_account_id' }, 404)
    }
  }

  private ensureDb(req: AppRequest): Kysely<Database> {
    const db = req?.ctx?.db
    if (!db) {
      throw new HttpException({ code: 'SERVER.DB_UNAVAILABLE', message: 'database unavailable' }, 503)
    }
    return db
  }

  private ensureRealmId(req: AppRequest): string {
    const realmId = req?.ctx?.realmId
    if (!realmId) {
      throw new HttpException({ code: 'AUTH.MISSING_REALM', message: 'realm_id missing in context' }, 400)
    }
    return realmId
  }
}
