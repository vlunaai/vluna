import { HttpException } from '@nestjs/common'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../types/database.js'
import { setRlsSession } from '../db/index.js'
import { runInTransaction } from '../features/gate/services/gate.utils.js'
import {
  ensureBillingPlanAssignment,
  ensureBillingPlanGrantsEnrollmentSyncedForUser,
  issueGrantsForBillingUser,
} from './billing-plan.service.js'

type DbOrTrx = Kysely<Database> | Transaction<Database>

export type BillingUserProvisioningRow = {
  billing_user_id: string
  realm_id: string
  billing_account_id: string
  billing_principal_id: string
  business_user_id: string
  status: 'active' | 'disabled' | 'deleted'
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

export type BillingAccountSeatSummary = {
  billing_account_id: string
  seat_limit: number | null
  seat_limit_source: string | null
  seat_limit_updated_at: Date | null
  active_user_count: number
  disabled_user_count: number
  deleted_user_count: number
  available_seats: number | null
  over_limit: boolean
}

type BillingAccountSeatRow = {
  billing_account_id: string
  realm_id: string
  billing_principal_id: string
  seat_limit: number | null
  seat_limit_source: string | null
  seat_limit_updated_at: Date | null
}

export async function provisionBillingUser(
  dbOrTrx: DbOrTrx,
  params: {
    realmId: string
    billingAccountId: string
    businessUserId: string
    metadata?: Record<string, unknown>
    reactivateExisting: boolean
    source: string
  },
): Promise<BillingUserProvisioningRow> {
  const realmId = normalizeRequiredString(params.realmId, 'realm_id')
  const billingAccountId = normalizeRequiredString(params.billingAccountId, 'billing_account_id')
  const businessUserId = normalizeRequiredString(params.businessUserId, 'user_id')
  const metadata = params.metadata ?? {}

  return runInTransaction(dbOrTrx, async (trx) => {
    await setRlsSession(trx, { realmId, billingAccountId, isRealmAdmin: true })
    await lockAccountSeats(trx, billingAccountId)
    await ensureBillingAccountSeatLimitInitialized(trx, realmId, billingAccountId)
    const account = await loadBillingAccountForSeatUpdate(trx, realmId, billingAccountId)

    const existing = await trx
      .selectFrom('billing_users')
      .select(['billing_user_id', 'metadata', 'status'])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .where('business_user_id', '=', businessUserId)
      .forUpdate()
      .executeTakeFirst()

    let billingUserId: string
    if (existing) {
      billingUserId = String(existing.billing_user_id)
      const currentStatus = normalizeBillingUserStatus(existing.status)
      if (currentStatus !== 'active') {
        if (!params.reactivateExisting) {
          return loadBillingUserProvisioningRow(trx, realmId, billingUserId)
        }
        await enforceSeatCapacityForNewActiveUser(trx, account)
      }
      await trx
        .updateTable('billing_users')
        .set({
          metadata: mergeMetadata((existing.metadata ?? {}) as Record<string, unknown>, metadata),
          status: 'active',
          updated_at: sql<Date>`now()`,
        })
        .where('billing_user_id', '=', billingUserId)
        .executeTakeFirst()
    } else {
      await enforceSeatCapacityForNewActiveUser(trx, account)
      const inserted = await trx
        .insertInto('billing_users')
        .values({
          realm_id: realmId,
          billing_account_id: billingAccountId,
          business_user_id: businessUserId,
          status: 'active',
          metadata,
        })
        .returning(['billing_user_id'])
        .executeTakeFirst()
      if (!inserted?.billing_user_id) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'billing user unavailable' }, 500)
      }
      billingUserId = String(inserted.billing_user_id)
    }

    await seedDefaultBillingPlanAssignment(trx, realmId, billingAccountId, billingUserId, params.source)
    return loadBillingUserProvisioningRow(trx, realmId, billingUserId)
  })
}

export async function activateBillingUserById(
  dbOrTrx: DbOrTrx,
  params: {
    realmId: string
    billingUserId: string
    source: string
  },
): Promise<BillingUserProvisioningRow> {
  const realmId = normalizeRequiredString(params.realmId, 'realm_id')
  const billingUserId = normalizeRequiredString(params.billingUserId, 'billing_user_id')

  return runInTransaction(dbOrTrx, async (trx) => {
    const current = await loadBillingUserProvisioningRow(trx, realmId, billingUserId, true)
    await setRlsSession(trx, {
      realmId,
      billingAccountId: current.billing_account_id,
      billingUserId: current.billing_user_id,
      isRealmAdmin: true,
    })
    await lockAccountSeats(trx, current.billing_account_id)
    await ensureBillingAccountSeatLimitInitialized(trx, realmId, current.billing_account_id)
    const account = await loadBillingAccountForSeatUpdate(trx, realmId, current.billing_account_id)

    if (current.status !== 'active') {
      await enforceSeatCapacityForNewActiveUser(trx, account)
      await trx
        .updateTable('billing_users')
        .set({ status: 'active', updated_at: sql<Date>`now()` })
        .where('billing_user_id', '=', billingUserId)
        .executeTakeFirst()
    }

    await seedDefaultBillingPlanAssignment(trx, realmId, current.billing_account_id, current.billing_user_id, params.source)
    return loadBillingUserProvisioningRow(trx, realmId, billingUserId)
  })
}

export async function ensureBillingAccountSeatLimitInitialized(
  trx: Transaction<Database>,
  realmId: string,
  billingAccountId: string,
): Promise<void> {
  const account = await trx
    .selectFrom('billing_accounts')
    .select(['billing_account_id', 'seat_limit', 'seat_limit_source', 'seat_limit_updated_at'])
    .where('realm_id', '=', realmId)
    .where('billing_account_id', '=', billingAccountId)
    .forUpdate()
    .executeTakeFirst()

  if (!account) {
    throw new HttpException({ code: 'NOT_FOUND', message: 'billing account not found' }, 404)
  }
  if (account.seat_limit !== null || account.seat_limit_source || account.seat_limit_updated_at) {
    return
  }

  const seatLimit = await loadDefaultSeatLimit(trx, realmId)
  await trx
    .updateTable('billing_accounts')
    .set({
      seat_limit: seatLimit,
      seat_limit_source: 'default',
      seat_limit_updated_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where('billing_account_id', '=', billingAccountId)
    .executeTakeFirst()
}

export async function updateBillingAccountSeatLimit(
  dbOrTrx: DbOrTrx,
  params: {
    realmId: string
    billingAccountId: string
    seatLimit: number | null
    source: string
  },
): Promise<BillingAccountSeatSummary> {
  const realmId = normalizeRequiredString(params.realmId, 'realm_id')
  const billingAccountId = normalizeRequiredString(params.billingAccountId, 'billing_account_id')

  return runInTransaction(dbOrTrx, async (trx) => {
    await setRlsSession(trx, { realmId, billingAccountId, isRealmAdmin: true })
    await lockAccountSeats(trx, billingAccountId)
    const existing = await trx
      .selectFrom('billing_accounts')
      .select(['billing_account_id'])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .forUpdate()
      .executeTakeFirst()
    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing account not found' }, 404)
    }
    await trx
      .updateTable('billing_accounts')
      .set({
        seat_limit: params.seatLimit,
        seat_limit_source: params.source,
        seat_limit_updated_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      })
      .where('billing_account_id', '=', billingAccountId)
      .executeTakeFirst()
    return getBillingAccountSeatSummary(trx, { realmId, billingAccountId })
  })
}

export async function getBillingAccountSeatSummary(
  dbOrTrx: DbOrTrx,
  params: {
    realmId: string
    billingAccountId: string
  },
): Promise<BillingAccountSeatSummary> {
  const realmId = normalizeRequiredString(params.realmId, 'realm_id')
  const billingAccountId = normalizeRequiredString(params.billingAccountId, 'billing_account_id')

  return runInTransaction(dbOrTrx, async (trx) => {
    await setRlsSession(trx, { realmId, billingAccountId, isRealmAdmin: true })
    const account = await trx
      .selectFrom('billing_accounts')
      .select(['billing_account_id', 'seat_limit', 'seat_limit_source', 'seat_limit_updated_at'])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .executeTakeFirst()
    if (!account) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing account not found' }, 404)
    }

    const counts = await trx
      .selectFrom('billing_users')
      .select([
        sql<number>`count(*) filter (where status = 'active')::int`.as('active_user_count'),
        sql<number>`count(*) filter (where status = 'disabled')::int`.as('disabled_user_count'),
        sql<number>`count(*) filter (where status = 'deleted')::int`.as('deleted_user_count'),
      ])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .executeTakeFirst()

    const seatLimit = normalizeNullableInteger(account.seat_limit)
    const activeUserCount = Number(counts?.active_user_count ?? 0)
    const disabledUserCount = Number(counts?.disabled_user_count ?? 0)
    const deletedUserCount = Number(counts?.deleted_user_count ?? 0)
    const availableSeats = seatLimit === null ? null : Math.max(seatLimit - activeUserCount, 0)
    const overLimit = seatLimit !== null && activeUserCount > seatLimit

    return {
      billing_account_id: String(account.billing_account_id),
      seat_limit: seatLimit,
      seat_limit_source: account.seat_limit_source ? String(account.seat_limit_source) : null,
      seat_limit_updated_at: account.seat_limit_updated_at ?? null,
      active_user_count: activeUserCount,
      disabled_user_count: disabledUserCount,
      deleted_user_count: deletedUserCount,
      available_seats: availableSeats,
      over_limit: overLimit,
    }
  })
}

export function normalizeSeatLimitValue(value: unknown, field = 'seat_limit'): number | null {
  if (value === null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${field} must be a non-negative integer or null` }, 422)
    }
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${field} must be a non-negative integer or null` }, 422)
    }
    if (!/^\d+$/.test(trimmed)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${field} must be a non-negative integer or null` }, 422)
    }
    return Number(trimmed)
  }
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${field} must be a non-negative integer or null` }, 422)
}

export function resolveSeatLimitFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  quantity = 1,
): number | null | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined
  const raw = metadata.seat_limit
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw === 'number' || typeof raw === 'string') {
    return normalizeSeatLimitValue(raw)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }

  const config = raw as Record<string, unknown>
  const mode = typeof config.mode === 'string' ? config.mode.trim() : ''
  if (config.unlimited === true || mode === 'unlimited') return null
  if (mode === 'fixed') {
    return normalizeSeatLimitValue(config.limit)
  }
  if (mode === 'per_unit') {
    const seatsPerUnit = normalizeSeatLimitValue(config.seats_per_unit ?? 1)
    if (seatsPerUnit === null) return null
    const normalizedQuantity = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1
    return seatsPerUnit * normalizedQuantity
  }
  if ('limit' in config) {
    return normalizeSeatLimitValue(config.limit)
  }
  return undefined
}

async function lockAccountSeats(trx: Transaction<Database>, billingAccountId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${billingAccountId}), hashtext('billing.account.seats'))`.execute(trx)
}

async function loadBillingAccountForSeatUpdate(
  trx: Transaction<Database>,
  realmId: string,
  billingAccountId: string,
): Promise<BillingAccountSeatRow> {
  const account = await trx
    .selectFrom('billing_accounts')
    .select([
      'billing_account_id',
      'realm_id',
      'billing_principal_id',
      'seat_limit',
      'seat_limit_source',
      'seat_limit_updated_at',
    ])
    .where('realm_id', '=', realmId)
    .where('billing_account_id', '=', billingAccountId)
    .forUpdate()
    .executeTakeFirst()
  if (!account) {
    throw new HttpException({ code: 'NOT_FOUND', message: 'billing account not found' }, 404)
  }
  return {
    billing_account_id: String(account.billing_account_id),
    realm_id: String(account.realm_id),
    billing_principal_id: String(account.billing_principal_id),
    seat_limit: normalizeNullableInteger(account.seat_limit),
    seat_limit_source: account.seat_limit_source ? String(account.seat_limit_source) : null,
    seat_limit_updated_at: account.seat_limit_updated_at ?? null,
  }
}

async function enforceSeatCapacityForNewActiveUser(
  trx: Transaction<Database>,
  account: BillingAccountSeatRow,
): Promise<void> {
  if (account.seat_limit === null) return

  const countRow = await trx
    .selectFrom('billing_users')
    .select((eb) => eb.fn.countAll<number>().as('active_user_count'))
    .where('realm_id', '=', account.realm_id)
    .where('billing_account_id', '=', account.billing_account_id)
    .where('status', '=', 'active')
    .executeTakeFirst()
  const activeUserCount = Number(countRow?.active_user_count ?? 0)
  if (!Number.isFinite(activeUserCount) || activeUserCount >= account.seat_limit) {
    throw new HttpException({
      code: 'SEAT.CAPACITY_EXCEEDED',
      message: 'billing account seat capacity exceeded',
      details: {
        billing_account_id: account.billing_account_id,
        seat_limit: account.seat_limit,
        active_user_count: activeUserCount,
      },
    }, 403)
  }
}

async function seedDefaultBillingPlanAssignment(
  trx: Transaction<Database>,
  realmId: string,
  billingAccountId: string,
  billingUserId: string,
  source: string,
): Promise<void> {
  await setRlsSession(trx, { realmId, billingAccountId, billingUserId, isRealmAdmin: true })

  const realmRow = await trx.selectFrom('realms').select(['metadata']).where('realm_id', '=', realmId).executeTakeFirst()
  const realmMetadata = (realmRow?.metadata ?? {}) as Record<string, unknown>
  const defaultPlanId = typeof realmMetadata.default_plan_id === 'string' ? realmMetadata.default_plan_id : null
  const plan = defaultPlanId
    ? await trx
        .selectFrom('billing_plans')
        .select(['plan_id'])
        .where('realm_id', '=', realmId)
        .where('plan_id', '=', defaultPlanId)
        .where('active', '=', true)
        .executeTakeFirst()
    : await trx
        .selectFrom('billing_plans')
        .select(['plan_id'])
        .where('realm_id', '=', realmId)
        .where('plan_code', '=', 'default_billing_plan')
        .where('active', '=', true)
        .executeTakeFirst()

  if (!plan?.plan_id) return

  await ensureBillingPlanAssignment(trx, {
    billingAccountId,
    assignmentScope: 'user',
    billingUserId,
    planId: String(plan.plan_id),
    sourceKind: 'signup.default',
    sourceRef: defaultPlanId ? 'default_plan_id' : 'default_billing_plan',
    windowStart: new Date(),
    windowEnd: null,
    status: 'active',
    metadata: { reason: source },
  })

  await ensureBillingPlanGrantsEnrollmentSyncedForUser(trx, billingAccountId, billingUserId)
  await issueGrantsForBillingUser(trx, billingAccountId, billingUserId)
}

async function loadBillingUserProvisioningRow(
  trx: Transaction<Database>,
  realmId: string,
  billingUserId: string,
  lock = false,
): Promise<BillingUserProvisioningRow> {
  let builder = trx
    .selectFrom('billing_users as bu')
    .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'bu.billing_account_id')
    .select([
      'bu.billing_user_id',
      'bu.realm_id',
      'bu.billing_account_id',
      'ba.billing_principal_id',
      'bu.business_user_id',
      'bu.status',
      'bu.metadata',
      'bu.created_at',
      'bu.updated_at',
    ])
    .where('bu.realm_id', '=', realmId)
    .where('bu.billing_user_id', '=', billingUserId)

  if (lock) {
    builder = builder.forUpdate()
  }

  const row = await builder.executeTakeFirst()
  if (!row) {
    throw new HttpException({ code: 'NOT_FOUND', message: 'billing user not found' }, 404)
  }
  return {
    billing_user_id: String(row.billing_user_id),
    realm_id: String(row.realm_id),
    billing_account_id: String(row.billing_account_id),
    billing_principal_id: String(row.billing_principal_id),
    business_user_id: String(row.business_user_id),
    status: normalizeBillingUserStatus(row.status),
    metadata: normalizeMetadataRecord(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function loadDefaultSeatLimit(trx: Transaction<Database>, realmId: string): Promise<number | null> {
  const realmRow = await trx.selectFrom('realms').select(['metadata']).where('realm_id', '=', realmId).executeTakeFirst()
  const realmMetadata = (realmRow?.metadata ?? {}) as Record<string, unknown>
  const defaultPlanId = typeof realmMetadata.default_plan_id === 'string' ? realmMetadata.default_plan_id : null
  const plan = defaultPlanId
    ? await trx
        .selectFrom('billing_plans')
        .select(['metadata'])
        .where('realm_id', '=', realmId)
        .where('plan_id', '=', defaultPlanId)
        .where('active', '=', true)
        .executeTakeFirst()
    : await trx
        .selectFrom('billing_plans')
        .select(['metadata'])
        .where('realm_id', '=', realmId)
        .where('plan_code', '=', 'default_billing_plan')
        .where('active', '=', true)
        .executeTakeFirst()

  const resolved = resolveSeatLimitFromMetadata(plan?.metadata as Record<string, unknown> | null | undefined)
  return resolved === undefined ? null : resolved
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${field} must be a string` }, 422)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${field} is required` }, 422)
  }
  return trimmed
}

function normalizeBillingUserStatus(value: unknown): BillingUserProvisioningRow['status'] {
  if (value === 'active' || value === 'disabled' || value === 'deleted') return value
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'status is invalid' }, 422)
}

function normalizeMetadataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function normalizeNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : null
}

function mergeMetadata(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    next[key] = value
  }
  return next
}
