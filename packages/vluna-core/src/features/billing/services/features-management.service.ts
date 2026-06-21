import { HttpException, Injectable } from '@nestjs/common'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { setRlsSession } from '../../../db/index.js'
import type { components as BillingComponents } from '../../../contracts/billing-mgt.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { Database } from '../../../types/database.js'
import { FeatureService, type FeatureMeterInput } from './feature.service.js'
import { DomainError } from '../../../utils/domain-errors.js'
import { invalidateGateRuntimeCaches } from '../../gate/services/quota.service.js'

type Feature = BillingComponents['schemas']['Feature']
type FeatureList = BillingComponents['schemas']['FeatureList']
type Meter = BillingComponents['schemas']['Meter']
type MeterPrice = BillingComponents['schemas']['MeterPrice']

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function clampLimit(value: number, fallback = 50, max = 200): number {
  if (!Number.isFinite(value)) return fallback
  if (value <= 0) return fallback
  return Math.min(Math.trunc(value), max)
}

function normalizeString(value: unknown): string {
  return String(value ?? '').trim()
}

function parseBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be boolean` }, 422)
  }
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be boolean` }, 422)
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'metadata must be an object' }, 422)
  }
  return { ...(value as Record<string, unknown>) }
}

function parseId(value: string, name: string): string {
  const trimmed = normalizeString(value)
  if (!trimmed || !UUID_RE.test(trimmed)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `invalid ${name}` }, 422)
  }
  return trimmed.toLowerCase()
}

function toDate(value: unknown, name: string): Date {
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} is required` }, 422)
  }
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be a valid date` }, 422)
  }
  return date
}

async function assertNotFallbackFeatureFamily(
  trx: Kysely<Database>,
  realmId: string,
  params: { featureFamilyId?: string; featureFamilyCode?: string },
): Promise<void> {
  const { featureFamilyId, featureFamilyCode } = params
  if (!featureFamilyId && !featureFamilyCode) return
  const row = await trx
    .selectFrom('feature_families')
    .select(['feature_family_id', 'is_fallback'])
    .where('realm_id', '=', realmId)
    .where((eb) => {
      if (featureFamilyId) return eb('feature_family_id', '=', featureFamilyId)
      return eb('feature_family_code', '=', featureFamilyCode ?? '')
    })
    .executeTakeFirst()
  if (row?.is_fallback) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'cannot assign fallback feature_family' }, 422)
  }
}

@Injectable()
export class FeaturesManagementService {
  async listFeatures(req: AppRequest, query: Record<string, unknown>): Promise<FeatureList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursor = typeof query?.cursor === 'string' ? query.cursor.trim() : ''
    const q = normalizeString(query?.q)
    const featureFamilyCode = normalizeString(query?.feature_family_code)
    const active = parseBoolean(query?.active, 'active')

    let builder = trx
      .selectFrom('features as f')
      .innerJoin('feature_families as c', 'c.feature_family_id', 'f.feature_family_id')
      .select([
        'f.feature_id as feature_id',
        'f.feature_family_id as feature_family_id',
        'c.feature_family_code as feature_family_code',
        'f.feature_code as feature_code',
        'f.name as name',
        'f.description as description',
        'f.entitlement_required as entitlement_required',
        'f.default_budget_strategy as default_budget_strategy',
        'f.active as active',
        'f.metadata as metadata',
        'f.created_at as created_at',
        'f.updated_at as updated_at',
      ])
      .where('f.realm_id', '=', realmId)
      .orderBy('f.feature_id', 'asc')

    if (featureFamilyCode) {
      builder = builder.where('c.feature_family_code', '=', featureFamilyCode)
    }

    if (q) {
      builder = builder.where((eb) =>
        eb.or([
          eb('f.feature_code', 'ilike', `%${q}%`),
          eb('f.name', 'ilike', `%${q}%`),
        ]),
      )
    }

    if (active !== undefined) {
      builder = builder.where('f.active', '=', active)
    }

    if (cursor) {
      builder = builder.where('f.feature_id', '>', parseId(cursor, 'cursor'))
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const slice = rows.slice(0, limit)
    const featureIds = slice.map((row) => String(row.feature_id))
    const metersByFeatureId = await this.listMetersForFeatures(trx, realmId, featureIds)

    const items = slice.map((row) =>
      this.mapFeatureRow(row, metersByFeatureId.get(String(row.feature_id)) ?? []),
    )
    const nextCursor = hasMore ? items[items.length - 1]?.feature_id ?? null : null
    return { items, next_cursor: nextCursor } satisfies FeatureList
  }

  async listNeedsConfigFeatures(req: AppRequest, query: Record<string, unknown>): Promise<FeatureList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursor = typeof query?.cursor === 'string' ? query.cursor.trim() : ''
    const q = normalizeString(query?.q)
    const featureFamilyCode = normalizeString(query?.feature_family_code)
    const active = parseBoolean(query?.active, 'active')

    const missingPriceExpr = sql<boolean>`exists (
      select 1
        from feature_meters fm
        join meters m on m.meter_id = fm.meter_id
        left join meter_prices mp on mp.meter_code = m.meter_code and mp.realm_id = m.realm_id
       where fm.feature_id = f.feature_id
         and m.realm_id = ${realmId}
         and (
           mp.price_id is null
           or mp.unit_price_xusd is null
           or mp.unit_price_base_xusd is null
           or mp.unit_price_dynamic_xusd is null
           or mp.unit_quantity_minor is null
           or mp.rounding is null
           or mp.unit_cost_xusd is null
           or mp.cost_unit_quantity_minor is null
           or mp.cost_rounding is null
           or mp.effective_at is null
         )
    )`

    let builder = trx
      .selectFrom('features as f')
      .innerJoin('feature_families as c', 'c.feature_family_id', 'f.feature_family_id')
      .select([
        'f.feature_id as feature_id',
        'f.feature_family_id as feature_family_id',
        'c.feature_family_code as feature_family_code',
        'f.feature_code as feature_code',
        'f.name as name',
        'f.description as description',
        'f.entitlement_required as entitlement_required',
        'f.default_budget_strategy as default_budget_strategy',
        'f.active as active',
        'f.metadata as metadata',
        'f.created_at as created_at',
        'f.updated_at as updated_at',
        missingPriceExpr.as('missing_price'),
      ])
      .where('f.realm_id', '=', realmId)
      .where((eb) =>
        eb.or([
          eb('c.feature_family_code', '=', 'auto.registry'),
          eb(missingPriceExpr, '=', true),
        ]),
      )
      .orderBy('f.feature_id', 'asc')

    if (featureFamilyCode) {
      builder = builder.where('c.feature_family_code', '=', featureFamilyCode)
    }

    if (q) {
      builder = builder.where((eb) =>
        eb.or([
          eb('f.feature_code', 'ilike', `%${q}%`),
          eb('f.name', 'ilike', `%${q}%`),
        ]),
      )
    }

    if (active !== undefined) {
      builder = builder.where('f.active', '=', active)
    }

    if (cursor) {
      builder = builder.where('f.feature_id', '>', parseId(cursor, 'cursor'))
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const slice = rows.slice(0, limit)
    const featureIds = slice.map((row) => String(row.feature_id))
    const metersByFeatureId = await this.listMetersForFeatures(trx, realmId, featureIds)

    const items = slice.map((row) => {
      const feature_family = row.feature_family_code ? String(row.feature_family_code) : ''
      const autoRegistry = feature_family === 'auto.registry'
      const missingPrice = Boolean((row as { missing_price?: boolean }).missing_price)
      let missingPriceReason: Feature['missing_price_reason'] | undefined
      if (autoRegistry || missingPrice) {
        missingPriceReason = autoRegistry && missingPrice ? 'both' : autoRegistry ? 'auto_registry' : 'missing_price'
      }
      return this.mapFeatureRow(
        row,
        metersByFeatureId.get(String(row.feature_id)) ?? [],
        missingPriceReason,
      )
    })

    const nextCursor = hasMore ? items[items.length - 1]?.feature_id ?? null : null
    return { items, next_cursor: nextCursor } satisfies FeatureList
  }

  async getFeature(req: AppRequest, featureId: string): Promise<Feature> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(featureId, 'feature_id')

    const row = await trx
      .selectFrom('features as f')
      .innerJoin('feature_families as c', 'c.feature_family_id', 'f.feature_family_id')
      .select([
        'f.feature_id as feature_id',
        'f.feature_family_id as feature_family_id',
        'c.feature_family_code as feature_family_code',
        'f.feature_code as feature_code',
        'f.name as name',
        'f.description as description',
        'f.entitlement_required as entitlement_required',
        'f.default_budget_strategy as default_budget_strategy',
        'f.active as active',
        'f.metadata as metadata',
        'f.created_at as created_at',
        'f.updated_at as updated_at',
      ])
      .where('f.realm_id', '=', realmId)
      .where('f.feature_id', '=', id)
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'feature not found' }, 404)
    }

    const metersByFeatureId = await this.listMetersForFeatures(trx, realmId, [String(row.feature_id)])
    return this.mapFeatureRow(row, metersByFeatureId.get(String(row.feature_id)) ?? [])
  }

  async upsertFeature(
    req: AppRequest,
    body: {
      feature_family_id?: string
      feature_family_code?: string
      feature_code: string
      name?: string | null
      description?: string | null
      entitlement_required?: boolean
      active?: boolean
      metadata?: Record<string, unknown>
      unit?: string
      meters?: Array<{
        meter_code?: string
        feature_code?: string
        unit?: string
        scale?: number
        rounding?: 'round' | 'floor' | 'ceil' | 'truncate'
        semantic_kind?: 'activity' | 'outcome'
        active?: boolean
        metadata?: Record<string, unknown>
        meter_prices?: MeterPrice
      }>
    },
  ): Promise<{ created: boolean; feature: Feature }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const featureCode = normalizeString(body?.feature_code)
    if (!featureCode) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'feature_code is required' }, 422)
    }
    const name = normalizeString(body?.name) || featureCode

    const featureFamilyId = body?.feature_family_id ? normalizeString(body.feature_family_id) : undefined
    const featureFamilyCode = body?.feature_family_code ? normalizeString(body.feature_family_code) : undefined
    if (!featureFamilyId && !featureFamilyCode) {
      throw new HttpException({
        code: 'VALIDATION.INVALID_INPUT',
        message: 'feature_family_id or feature_family_code is required',
      }, 422)
    }

    const description = body?.description === undefined || body.description === null ? '' : String(body.description)
    const active = body?.active
    const entitlementRequired = body?.entitlement_required
    const metadata = normalizeMetadata(body?.metadata)

    const meters = (body?.meters ?? []).map((m) => this.mapFeatureMeterInput(m))

    await setRlsSession(trx, { realmId, isRealmAdmin: true })
    await assertNotFallbackFeatureFamily(trx, realmId, { featureFamilyId, featureFamilyCode })

    const existing = await trx
      .selectFrom('features')
      .select(['feature_id'])
      .where('realm_id', '=', realmId)
      .where('feature_code', '=', featureCode)
      .executeTakeFirst()

    if (existing?.feature_id) {
      const feature = await this.updateFeature(req, String(existing.feature_id), { ...body, name, description })
      return { created: false, feature }
    }

    let result: Awaited<ReturnType<typeof FeatureService.upsertFeature>>
    try {
      result = await FeatureService.upsertFeature(trx, {
        realmId,
        feature: {
          feature_family_id: featureFamilyId,
          feature_family_code: featureFamilyCode,
          feature_code: featureCode,
          name,
          description,
          active,
          entitlement_required: entitlementRequired,
          default_budget_strategy: 'auto',
          metadata,
          meters,
          unit: body?.unit,
        },
      })
    } catch (error) {
      if (error instanceof DomainError) {
        throw new HttpException({ code: error.code, message: error.message, details: error.details }, error.status)
      }
      throw error
    }

    const feature = await this.getFeature(req, result.featureId)
    invalidateGateRuntimeCaches()
    return { created: result.featureChange === 'created', feature }
  }

  async updateFeature(
    req: AppRequest,
    featureId: string,
    body: {
      feature_family_id?: string
      feature_family_code?: string
      name?: string
      description?: string | null
      entitlement_required?: boolean
      active?: boolean
      metadata?: Record<string, unknown>
      unit?: string
      meters?: Array<{
        meter_code?: string
        feature_code?: string
        unit?: string
        scale?: number
        rounding?: 'round' | 'floor' | 'ceil' | 'truncate'
        semantic_kind?: 'activity' | 'outcome'
        active?: boolean
        metadata?: Record<string, unknown>
        meter_prices?: MeterPrice
      }>
      delete_meters?: string[]
    },
  ): Promise<Feature> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(featureId, 'feature_id')

    const existing = await trx
      .selectFrom('features')
      .select([
        'feature_id',
        'feature_family_id',
        'feature_code',
        'name',
        'description',
        'entitlement_required',
        'default_budget_strategy',
        'active',
        'metadata',
      ])
      .where('realm_id', '=', realmId)
      .where('feature_id', '=', id)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'feature not found' }, 404)
    }

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const name = body?.name === undefined ? String(existing.name) : normalizeString(body.name)
    if (!name) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'name is required' }, 422)
    }

    let featureFamilyId = body?.feature_family_id ? normalizeString(body.feature_family_id) : undefined
    let featureFamilyCode = body?.feature_family_code ? normalizeString(body.feature_family_code) : undefined
    if (!featureFamilyId && !featureFamilyCode) {
      featureFamilyId = String(existing.feature_family_id)
    }
    await assertNotFallbackFeatureFamily(trx, realmId, { featureFamilyId, featureFamilyCode })

    const description =
      body?.description === undefined ? (existing.description ?? '') : (body.description ?? '')
    const entitlementRequired =
      body?.entitlement_required === undefined
        ? (existing.entitlement_required ?? null)
        : body.entitlement_required
    const active = body?.active === undefined ? Boolean(existing.active) : Boolean(body.active)
    const metadata = body?.metadata === undefined ? (existing.metadata ?? {}) : normalizeMetadata(body.metadata)

    const deleteMeterCodes = (body?.delete_meters ?? [])
      .map((code) => normalizeString(code))
      .filter((code) => code.length > 0)

    if (deleteMeterCodes.includes(String(existing.feature_code))) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'cannot delete primary meter' }, 422)
    }

    if (body?.meters !== undefined) {
      const meters = body.meters.map((m) => this.mapFeatureMeterInput(m))
      const upsertMeterCodes = new Set(
        meters.map((m) => normalizeString(m.meter_code ?? String(existing.feature_code))).filter((code) => code.length > 0),
      )
      const deleteOverlaps = deleteMeterCodes.filter((code) => upsertMeterCodes.has(code))
      if (deleteOverlaps.length > 0) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'meters cannot be both upserted and deleted' }, 422)
      }
      const defaultBudgetStrategy = (existing.default_budget_strategy ?? 'auto') as 'auto' | 'hot' | 'cold'
      try {
        await FeatureService.upsertFeature(trx, {
          realmId,
          feature: {
            feature_family_id: featureFamilyId,
            feature_family_code: featureFamilyCode,
            feature_code: String(existing.feature_code),
            name,
            description,
            active,
            entitlement_required: entitlementRequired ?? undefined,
            default_budget_strategy: defaultBudgetStrategy,
            metadata,
            meters,
            unit: body?.unit,
          },
        })
      } catch (error) {
        if (error instanceof DomainError) {
          throw new HttpException({ code: error.code, message: error.message, details: error.details }, error.status)
        }
        throw error
      }
      if (deleteMeterCodes.length > 0) {
        await this.deleteFeatureMeters(trx, {
          realmId,
          featureId: id,
          featureCode: String(existing.feature_code),
          meterCodes: deleteMeterCodes,
        })
      }
      invalidateGateRuntimeCaches()
      return this.getFeature(req, id)
    }

    const resolvedFeatureFamilyId =
      featureFamilyId ??
      (featureFamilyCode
        ? await this.resolveFeatureFamilyId(trx, realmId, featureFamilyCode)
        : String(existing.feature_family_id))

    await trx
      .updateTable('features')
      .set({
        feature_family_id: resolvedFeatureFamilyId,
        name,
        description,
        active,
        entitlement_required: entitlementRequired ?? null,
        metadata,
        updated_at: sql`now()`,
      })
      .where('realm_id', '=', realmId)
      .where('feature_id', '=', id)
      .executeTakeFirst()

    if (deleteMeterCodes.length > 0) {
      await this.deleteFeatureMeters(trx, {
        realmId,
        featureId: id,
        featureCode: String(existing.feature_code),
        meterCodes: deleteMeterCodes,
      })
    }
    invalidateGateRuntimeCaches()
    return this.getFeature(req, id)
  }

  async deleteFeature(req: AppRequest, featureId: string): Promise<{ deleted: boolean; soft_deleted: boolean }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(featureId, 'feature_id')

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('features')
      .select(['feature_id'])
      .where('realm_id', '=', realmId)
      .where('feature_id', '=', id)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'feature not found' }, 404)
    }

    const reference = await trx
      .selectFrom('billing_plan_entitlements')
      .select(['feature_id'])
      .where('feature_id', '=', id)
      .limit(1)
      .executeTakeFirst()

    if (reference) {
      await trx
        .updateTable('features')
        .set({ active: false, updated_at: sql`now()` })
        .where('realm_id', '=', realmId)
        .where('feature_id', '=', id)
        .executeTakeFirst()
      invalidateGateRuntimeCaches()
      return { deleted: false, soft_deleted: true }
    }

    const deleted = await trx
      .deleteFrom('features')
      .where('realm_id', '=', realmId)
      .where('feature_id', '=', id)
      .executeTakeFirst()

    const deletedCount = Number(deleted?.numDeletedRows ?? 0)
    if (deletedCount <= 0) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'feature to delete not found' }, 404)
    }

    invalidateGateRuntimeCaches()
    return { deleted: true, soft_deleted: false }
  }

  private mapFeatureMeterInput(input: {
    meter_code?: string
    feature_code?: string
    unit?: string
    scale?: number
    rounding?: 'round' | 'floor' | 'ceil' | 'truncate'
    semantic_kind?: 'activity' | 'outcome'
    active?: boolean
    metadata?: Record<string, unknown>
    meter_prices?: MeterPrice
  }): FeatureMeterInput {
    const price = input?.meter_prices
    return {
      meter_code: input?.meter_code,
      unit: input?.unit,
      scale: input?.scale,
      rounding: input?.rounding,
      semantic_kind: input?.semantic_kind,
      active: input?.active,
      metadata: input?.metadata ?? undefined,
      price: price
        ? {
            unit_cost_xusd: price.unit_cost_xusd ?? '0',
            unit_price_xusd: price.unit_price_xusd,
            unit_price_base_xusd: price.unit_price_base_xusd,
            unit_price_dynamic_xusd: price.unit_price_dynamic_xusd,
            unit_quantity_minor: price.unit_quantity_minor,
            rounding: price.rounding,
            cost_unit_quantity_minor: price.cost_unit_quantity_minor,
            cost_rounding: price.cost_rounding,
            effective_at: price.effective_at ? toDate(price.effective_at, 'effective_at') : undefined,
          }
        : undefined,
    }
  }

  private async resolveFeatureFamilyId(trx: Kysely<Database>, realmId: string, featureFamilyCode: string): Promise<string> {
    const row = await trx
      .selectFrom('feature_families')
      .select(['feature_family_id'])
      .where('realm_id', '=', realmId)
      .where('feature_family_code', '=', featureFamilyCode)
      .executeTakeFirst()
    if (!row?.feature_family_id) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'feature_family_code not found' }, 422)
    }
    return String(row.feature_family_id)
  }

  private async deleteFeatureMeters(
    trx: Kysely<Database>,
    params: { realmId: string; featureId: string; featureCode: string; meterCodes: string[] },
  ): Promise<void> {
    const codes = Array.from(new Set(params.meterCodes.map((code) => normalizeString(code)).filter((code) => code.length > 0)))
    if (codes.length === 0) return

    if (codes.includes(params.featureCode)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'cannot delete primary meter' }, 422)
    }

    const rows = await trx
      .selectFrom('meters as m')
      .leftJoin('feature_meters as fm', (join) =>
        join.onRef('fm.meter_id', '=', 'm.meter_id').on('fm.feature_id', '=', params.featureId),
      )
      .select(['m.meter_id as meter_id', 'm.meter_code as meter_code', 'fm.is_primary as is_primary', 'fm.feature_id as feature_id'])
      .where('m.realm_id', '=', params.realmId)
      .where('m.meter_code', 'in', codes)
      .execute()

    const foundCodes = new Set(rows.map((row) => String(row.meter_code)))
    const missingCodes = codes.filter((code) => !foundCodes.has(code))
    if (missingCodes.length > 0) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'meter not found' }, 422)
    }

    const unlinked = rows.filter((row) => !row.feature_id)
    if (unlinked.length > 0) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'meter not linked to feature' }, 422)
    }

    const primary = rows.filter((row) => Boolean(row.is_primary))
    if (primary.length > 0) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'cannot delete primary meter' }, 422)
    }

    await trx
      .deleteFrom('feature_meters')
      .where('feature_id', '=', params.featureId)
      .where('meter_id', 'in', rows.map((row) => row.meter_id))
      .execute()
  }

  private mapFeatureRow(row: {
    feature_id: unknown
    feature_family_id: unknown
    feature_family_code: unknown
    feature_code: unknown
    name: unknown
    description: unknown
    entitlement_required: unknown
    default_budget_strategy: unknown
    active: unknown
    metadata: unknown
    created_at: Date
    updated_at: Date
  }, meters: Meter[], missingPriceReason?: Feature['missing_price_reason']): Feature {
    const featureCode = String(row.feature_code)
    const description = row.description === null || row.description === undefined ? null : String(row.description)
    return {
      feature_id: String(row.feature_id),
      feature_family_id: String(row.feature_family_id),
      feature_family_code: row.feature_family_code ? String(row.feature_family_code) : undefined,
      missing_price_reason: missingPriceReason,
      feature_code: featureCode,
      name: normalizeString(row.name) || featureCode,
      description: description ?? '',
      entitlement_required: row.entitlement_required === null ? undefined : Boolean(row.entitlement_required),
      active: Boolean(row.active),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      unit: undefined,
      meters: meters.map((meter) => ({ ...meter, feature_code: featureCode })),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies Feature
  }

  private async listMetersForFeatures(
    trx: Kysely<Database>,
    realmId: string,
    featureIds: string[],
  ): Promise<Map<string, Meter[]>> {
    const result = new Map<string, Meter[]>()
    if (featureIds.length === 0) return result

    const rows = await trx
      .selectFrom('feature_meters as fm')
      .innerJoin('meters as m', 'm.meter_id', 'fm.meter_id')
      .leftJoin('meter_prices as mp', (join) =>
        join.onRef('mp.meter_code', '=', 'm.meter_code').onRef('mp.realm_id', '=', 'm.realm_id'),
      )
      .select([
        'fm.feature_id as feature_id',
        'm.meter_id as meter_id',
        'm.meter_code as meter_code',
        'm.unit as unit',
        'm.scale as scale',
        'm.rounding as rounding',
        'm.semantic_kind as semantic_kind',
        'm.active as active',
        'm.metadata as metadata',
        'm.created_at as created_at',
        'm.updated_at as updated_at',
        'mp.unit_price_xusd as unit_price_xusd',
        'mp.unit_price_base_xusd as unit_price_base_xusd',
        'mp.unit_price_dynamic_xusd as unit_price_dynamic_xusd',
        'mp.unit_quantity_minor as unit_quantity_minor',
        'mp.rounding as price_rounding',
        'mp.unit_cost_xusd as unit_cost_xusd',
        'mp.cost_unit_quantity_minor as cost_unit_quantity_minor',
        'mp.cost_rounding as cost_rounding',
        'mp.effective_at as effective_at',
      ])
      .where('m.realm_id', '=', realmId)
      .where('fm.feature_id', 'in', featureIds)
      .orderBy('m.meter_id', 'asc')
      .execute()

    for (const row of rows) {
      const featureId = String(row.feature_id)
      const meter: Meter = {
        meter_id: String(row.meter_id),
        meter_code: String(row.meter_code),
        feature_id: featureId,
        feature_code: '',
        unit: String(row.unit ?? ''),
        scale: Number(row.scale ?? 0),
        rounding: row.rounding as Meter['rounding'],
        semantic_kind: row.semantic_kind as Meter['semantic_kind'],
        active: Boolean(row.active),
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        meter_prices: this.mapMeterPrice(row),
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      }
      const list = result.get(featureId) ?? []
      list.push(meter)
      result.set(featureId, list)
    }

    return result
  }

  private mapMeterPrice(row: {
    unit_price_xusd: unknown
    unit_price_base_xusd: unknown
    unit_price_dynamic_xusd: unknown
    unit_quantity_minor: unknown
    price_rounding: unknown
    unit_cost_xusd: unknown
    cost_unit_quantity_minor: unknown
    cost_rounding: unknown
    effective_at: Date | null
  }): MeterPrice | undefined {
    const hasAnyPrice =
      row.unit_price_xusd !== undefined &&
      row.unit_price_xusd !== null
        ? true
        : row.unit_cost_xusd !== undefined && row.unit_cost_xusd !== null
          ? true
          : row.unit_price_base_xusd !== undefined && row.unit_price_base_xusd !== null
    if (!hasAnyPrice) {
      return undefined
    }
    return {
      unit_price_xusd: row.unit_price_xusd === undefined ? undefined : String(row.unit_price_xusd),
      unit_price_base_xusd: row.unit_price_base_xusd === undefined ? undefined : String(row.unit_price_base_xusd),
      unit_price_dynamic_xusd: row.unit_price_dynamic_xusd === undefined ? undefined : String(row.unit_price_dynamic_xusd),
      unit_quantity_minor: row.unit_quantity_minor === undefined ? undefined : String(row.unit_quantity_minor),
      rounding: row.price_rounding as MeterPrice['rounding'],
      unit_cost_xusd: row.unit_cost_xusd === undefined ? undefined : String(row.unit_cost_xusd),
      cost_unit_quantity_minor: row.cost_unit_quantity_minor === undefined ? undefined : String(row.cost_unit_quantity_minor),
      cost_rounding: row.cost_rounding as MeterPrice['cost_rounding'],
      effective_at: row.effective_at ? row.effective_at.toISOString() : undefined,
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
