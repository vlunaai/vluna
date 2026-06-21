import { Injectable, HttpException, Inject } from '@nestjs/common'
import { Kysely, sql } from 'kysely'
import { appendLedgerEntry, getOrCreateLedgerAccount } from './ledger.js'
import { budgetShortfallHint, xusdShortfallHint, GateHint } from '../features/gate/services/gate.hints.js'
import type { Database } from '../types/database.js'
import { bigintFromUnknown, toSafeNumber } from '../features/gate/services/gate.utils.js'
import { GrantBalanceService } from './grant-balance.service.js'
import type { PricingComputation, PricingEstimate } from '../features/gate/services/pricing.service.js'
import { WALLET_LEDGER_CURRENCY } from '../config/currency.js'

const AUTO_BUDGET_MAX_LIMIT = 1_000_000n
const DEFAULT_LWM = 1_000_000n
const DEFAULT_HWM = 2_000_000n

type BudgetRow = {
  budget_id: string
  limit_xusd: string | null
  reserved_xusd: string
  consumed_xusd: string
  status: 'active' | 'closed' | 'expired' | 'canceled'
  window_start: Date | null
  window_end: Date | null
  scope_kind: 'global' | 'feature' | 'feature_set' | null
  scope_ref: string | null
  scope_payload: Record<string, unknown> | null
  metadata: Record<string, unknown>
}

function normalizeBudgetId(value: string | number): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(trimmed)) {
      return trimmed.toLowerCase()
    }
  }
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'budget_id must be a uuid string' }, 422)
}

type BudgetWaterlineRow = BudgetRow & {
  lwm_xusd: string | null
  hwm_xusd: string | null
}

export type BudgetReservationResult = {
  budgetId: string
  reservationAmountXusd: number
  remainingAmountXusd?: number
  hints: GateHint[]
}

export type BudgetCommitResult = {
  budgetId: string
  consumedDeltaXusd: bigint
  remainingAmountXusd: bigint | null
  reservationRemainingXusd: bigint
  hints: GateHint[]
}

export type EnsureBudgetParams = {
  realmId: string
  billingUserId: string
  billingAccountId: string
  featureCode?: string | null
  now: Date
}

export type EnsureBudgetResult = {
  budgetId: string
  hints: GateHint[]
  scopeKind: 'global' | 'feature'
}

export type BudgetWaterlineResult = {
  budgetId: string
  reservedXusd: bigint
  consumedXusd: bigint
  remainingHeadroomXusd: bigint | null
  wantedRefillXusd: bigint
  appliedRefillXusd: bigint
  appliedConsumptionXusd: bigint
  tailXusd: bigint
  hints: GateHint[]
}

export type BudgetLimitSnapshot = {
  budgetId: string
  limitXusd: bigint | null
  reservedXusd: bigint
  consumedXusd: bigint
  remainingHeadroomXusd: bigint | null
  hints: GateHint[]
}

export type BudgetUsageUpdate = {
  budgetId: string
  consumedDeltaXusd: bigint
  remainingAmountXusd: bigint | null
  reservedXusd: bigint
  hints: GateHint[]
  status: 'ok' | 'limit_exceeded'
}

type BudgetWaterlineComputation = {
  reservedBaseXusd: bigint
  consumedAfterXusd: bigint
  wantedRefillXusd: bigint
  limitXusd: bigint | null
  invalid: boolean
  appliedConsumptionXusd: bigint
  tailXusd: bigint
}


@Injectable()
export class BudgetService {
  constructor(@Inject(GrantBalanceService) private readonly grantBalanceService: GrantBalanceService) {}

  async reserveBudget(
    trx: Kysely<Database>,
    params: {
      realmId: string
      billingUserId: string
      billingAccountId: string
      budgetId: string
      now: Date
      estimate: PricingEstimate
    },
  ): Promise<BudgetReservationResult> {
    const budgetId = normalizeBudgetId(params.budgetId)

    const row = await sql<BudgetRow>`
      SELECT b.budget_id, b.limit_xusd, b.reserved_xusd, b.consumed_xusd, b.status, b.window_start, b.window_end
      FROM budgets b
      JOIN billing_accounts ba ON ba.billing_account_id = b.billing_account_id
      WHERE b.billing_user_id = ${params.billingUserId}
        AND b.billing_account_id = ${params.billingAccountId}
        AND b.budget_id = ${budgetId}
        AND b.status = 'active'
        AND (b.window_start IS NULL OR b.window_start <= ${params.now})
        AND (b.window_end IS NULL OR b.window_end > ${params.now})
        AND ba.realm_id = ${params.realmId}
      FOR UPDATE
    `
      .execute(trx)
      .then((res) => res.rows[0])

    if (!row) {
      throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'budget not found or inactive' }, 422)
    }

    const limit = row.limit_xusd === null ? null : bigintFromUnknown(row.limit_xusd) ?? null
    const reserved = bigintFromUnknown(row.reserved_xusd) ?? 0n
    const consumed = bigintFromUnknown(row.consumed_xusd) ?? 0n
    const remaining = limit === null || limit === undefined ? null : limit - reserved - consumed
    const hints: GateHint[] = []

    const estimateAmount = params.estimate.estimateAmountXusd
    if (estimateAmount === undefined) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'missing amount estimate for budget reservation' }, 422)
    }

    const desiredRequested = BigInt(Math.max(0, Math.floor(estimateAmount)))
    let desired = desiredRequested
    if (remaining !== null && remaining >= 0 && desired > remaining) {
      desired = remaining
    }

    if (desired <= 0n) {
      return {
        budgetId: row.budget_id,
        reservationAmountXusd: 0,
        remainingAmountXusd: remaining === null ? undefined : toSafeNumber(remaining),
        hints,
      }
    }
    if (remaining !== null && remaining < desired) {
      const shortfall = desired - remaining
      hints.push(budgetShortfallHint(row.budget_id, toSafeNumber(shortfall)))
      throw new HttpException({
        code: 'SERVER.CONFIG',
        message: 'budget exhausted',
      }, 402)
    }

    const updatedReserved = reserved + desired
    await trx
      .updateTable('budgets')
      .set({
        reserved_xusd: updatedReserved.toString(),
        updated_at: params.now,
      })
      .where('budget_id', '=', row.budget_id)
      .execute()

    return {
      budgetId: row.budget_id,
      reservationAmountXusd: toSafeNumber(desired),
      remainingAmountXusd: remaining === null ? undefined : toSafeNumber(remaining - desired),
      hints,
    }
  }

  async settleBudget(
    trx: Kysely<Database>,
    params: {
      realmId: string
      billingUserId: string
      billingAccountId: string
      budgetId: string
      now: Date
      reservationAmountXusd: bigint
      pricing: PricingComputation
    },
  ): Promise<BudgetCommitResult> {
    const budgetId = normalizeBudgetId(params.budgetId)

    const row = await sql<BudgetRow>`
      SELECT b.budget_id, b.limit_xusd, b.reserved_xusd, b.consumed_xusd, b.status, b.window_start, b.window_end
      FROM budgets b
      JOIN billing_accounts ba ON ba.billing_account_id = b.billing_account_id
      WHERE b.billing_user_id = ${params.billingUserId}
        AND b.billing_account_id = ${params.billingAccountId}
        AND b.budget_id = ${budgetId}
        AND b.status = 'active'
        AND (b.window_start IS NULL OR b.window_start <= ${params.now})
        AND (b.window_end IS NULL OR b.window_end > ${params.now})
        AND ba.realm_id = ${params.realmId}
      FOR UPDATE
    `
      .execute(trx)
      .then((res) => res.rows[0])

    if (!row) {
      throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'budget not found or inactive' }, 422)
    }

    const limit = row.limit_xusd === null ? null : bigintFromUnknown(row.limit_xusd) ?? null
    const reserved = bigintFromUnknown(row.reserved_xusd) ?? 0n
    const consumed = bigintFromUnknown(row.consumed_xusd) ?? 0n

    const actual = params.pricing.amountXusd
    const hints: GateHint[] = []

    let reservationRemainingXusd = params.reservationAmountXusd
    let additionalRequired = 0n
    if (actual <= params.reservationAmountXusd) {
      reservationRemainingXusd = params.reservationAmountXusd - actual
    } else {
      reservationRemainingXusd = 0n
      additionalRequired = actual - params.reservationAmountXusd
    }

    const remaining = limit === null || limit === undefined ? null : limit - reserved - consumed
    if (additionalRequired > 0n && remaining !== null && remaining < additionalRequired) {
      const shortfall = additionalRequired - remaining
      hints.push(budgetShortfallHint(row.budget_id, toSafeNumber(shortfall)))
    }

    const newReserved = reserved - params.reservationAmountXusd + reservationRemainingXusd
    const newConsumed = consumed + actual

    await trx
      .updateTable('budgets')
      .set({
        reserved_xusd: newReserved.toString(),
        consumed_xusd: newConsumed.toString(),
        updated_at: params.now,
      })
      .where('budget_id', '=', row.budget_id)
      .execute()

    const remainingAfter = limit === null || limit === undefined ? null : limit - newReserved - newConsumed

    return {
      budgetId: row.budget_id,
      consumedDeltaXusd: actual,
      remainingAmountXusd: remainingAfter,
      reservationRemainingXusd,
      hints,
    }
  }

  async ensureBudget(trx: Kysely<Database>, params: EnsureBudgetParams): Promise<EnsureBudgetResult> {
    const hints: GateHint[] = []

    const featureCode = params.featureCode ?? null
    let scopeKind: 'global' | 'feature' = 'global'
    let scopeRef: string | null = null
    let scopePayload: Record<string, unknown> | null = null
    let featureBudgetStrategy: Record<string, unknown> | null = null

    if (featureCode) {
      const featureRow = await trx
        .selectFrom('features')
        .select(['default_budget_strategy', 'metadata'])
        .where('realm_id', '=', params.realmId)
        .where('feature_code', '=', featureCode)
        .executeTakeFirst()

      if (featureRow && featureRow.default_budget_strategy === 'hot') {
        scopeKind = 'feature'
        scopeRef = featureCode
        const meta = (featureRow.metadata ?? {}) as Record<string, unknown>
        const strategyMeta = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).budget_strategy : undefined
        if (strategyMeta && typeof strategyMeta === 'object') {
          featureBudgetStrategy = strategyMeta as Record<string, unknown>
        }
      }
    }

    if (scopeKind === 'feature') {
      scopePayload = {
        feature_code: featureCode,
        ...(featureBudgetStrategy ? { budget_strategy: featureBudgetStrategy } : {}),
      }
    } else {
      scopePayload = { scope: 'global' }
    }

    await getOrCreateLedgerAccount(trx, params.billingUserId, params.billingAccountId, WALLET_LEDGER_CURRENCY)

    const grantBalances = await this.grantBalanceService.getAccountGrantBalances(trx, {
      billingUserId: params.billingUserId,
      billingAccountId: params.billingAccountId,
      asOf: params.now,
    })
    const availableGrantXusd = grantBalances.totals.availableXusd > 0n ? grantBalances.totals.availableXusd : 0n
    if (availableGrantXusd <= 0n) {
      hints.push(xusdShortfallHint(1))
      throw new HttpException({
        code: 'BUDGET.INSUFFICIENT_BALANCE',
        message: 'insufficient credits to allocate budget',
      }, 402)
    }

    const scopeCondition = scopeKind === 'feature'
      ? sql` AND b.scope_kind = 'feature' AND b.scope_ref = ${scopeRef}`
      : sql` AND b.scope_kind = 'global' AND b.scope_ref IS NULL`

    const existingResult = await sql<BudgetRow>`
      SELECT b.budget_id,
             b.limit_xusd,
             b.reserved_xusd,
             b.consumed_xusd,
             b.status,
             b.window_start,
             b.window_end,
             b.scope_kind,
             b.scope_ref,
             b.scope_payload,
             b.metadata
      FROM budgets b
      JOIN billing_accounts ba ON ba.billing_account_id = b.billing_account_id
      WHERE b.billing_user_id = ${params.billingUserId}
        AND b.billing_account_id = ${params.billingAccountId}
        AND b.status = 'active'
        AND (b.window_start IS NULL OR b.window_start <= ${params.now})
        AND (b.window_end IS NULL OR b.window_end > ${params.now})
        AND ba.realm_id = ${params.realmId}
        ${scopeCondition}
      ORDER BY b.created_at DESC
      LIMIT 1
      FOR UPDATE
    `
      .execute(trx)

    const existing = existingResult.rows[0]

    const effectiveLimit = availableGrantXusd < AUTO_BUDGET_MAX_LIMIT ? availableGrantXusd : AUTO_BUDGET_MAX_LIMIT
    if (existing) {
      const currentLimit = existing.limit_xusd === null ? null : bigintFromUnknown(existing.limit_xusd)
      if (typeof currentLimit === 'bigint' && currentLimit < effectiveLimit) {
        await trx
          .updateTable('budgets')
          .set({
            limit_xusd: effectiveLimit.toString(),
            updated_at: params.now,
          })
          .where('budget_id', '=', existing.budget_id)
          .execute()
      }
      return {
        budgetId: String(existing.budget_id),
        hints,
        scopeKind,
      }
    }

    if (effectiveLimit <= 0n) {
      const deficit = effectiveLimit < 0n ? -effectiveLimit : 0n
      const shortfallXusd = deficit > 0n ? Math.max(1, toSafeNumber(deficit + 1n)) : 1
      hints.push(xusdShortfallHint(shortfallXusd))
      throw new HttpException({
        code: 'BUDGET.INSUFFICIENT_BALANCE',
        message: 'insufficient credits to allocate budget',
      }, 402)
    }

    const metadata: Record<string, unknown> = {
      source: 'gate.auto',
      strategy: scopeKind === 'feature' ? 'feature' : 'global',
    }
    if (scopeKind === 'feature' && featureCode) metadata.feature_code = featureCode

    const inserted = await trx
      .insertInto('budgets')
      .values({
        billing_user_id: params.billingUserId,
        billing_account_id: params.billingAccountId,
        status: 'active',
        scope_kind: scopeKind,
        scope_ref: scopeRef,
        scope_payload: scopePayload,
        limit_xusd: effectiveLimit.toString(),
        reserved_xusd: '0',
        consumed_xusd: '0',
        metadata,
        name: scopeKind === 'feature' && featureCode ? `auto:${featureCode}` : 'auto:global',
      })
      .returning(['budget_id'])
      .executeTakeFirst()

    if (!inserted) {
      throw new HttpException({ code: 'WRITE.FAILURE', message: 'failed to create budget' }, 500)
    }

    return {
      budgetId: String(inserted.budget_id),
      hints,
      scopeKind,
    }
  }

  async previewBudgetLimit(
    trx: Kysely<Database>,
    params: { realmId: string; billingUserId: string; billingAccountId: string; budgetId: string; now: Date },
  ): Promise<BudgetLimitSnapshot> {
    const budgetId = normalizeBudgetId(params.budgetId)

    const row = await sql<BudgetRow>`
      SELECT b.budget_id,
             b.limit_xusd,
             b.reserved_xusd,
             b.consumed_xusd,
             b.status,
             b.window_start,
             b.window_end
      FROM budgets b
      JOIN billing_accounts ba ON ba.billing_account_id = b.billing_account_id
      WHERE b.budget_id = ${budgetId}
        AND b.billing_user_id = ${params.billingUserId}
        AND b.billing_account_id = ${params.billingAccountId}
        AND ba.realm_id = ${params.realmId}
        AND b.status = 'active'
        AND (b.window_start IS NULL OR b.window_start <= ${params.now})
        AND (b.window_end IS NULL OR b.window_end > ${params.now})
      FOR SHARE
    `
      .execute(trx)
      .then((res) => res.rows[0])

    if (!row) {
      throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'budget not found or inactive' }, 422)
    }

    const limit = row.limit_xusd === null ? null : bigintFromUnknown(row.limit_xusd) ?? null
    const reserved = bigintFromUnknown(row.reserved_xusd) ?? 0n
    const consumed = bigintFromUnknown(row.consumed_xusd) ?? 0n
    const remaining = limit === null ? null : limit - reserved - consumed
    const hints: GateHint[] = []
    if (remaining !== null && remaining <= 0n) {
      const shortfall = -remaining
      hints.push(budgetShortfallHint(row.budget_id, toSafeNumber(shortfall > 0n ? shortfall : 1n)))
    }

    return {
      budgetId: row.budget_id,
      limitXusd: limit,
      reservedXusd: reserved,
      consumedXusd: consumed,
      remainingHeadroomXusd: remaining,
      hints,
    }
  }

  async updateBudgetUsage(
    trx: Kysely<Database>,
    params: { realmId: string; billingUserId: string; billingAccountId: string; budgetId: string; consumeAmountXusd: bigint; now: Date },
  ): Promise<BudgetUsageUpdate> {
    const budgetIdForUpdate = normalizeBudgetId(params.budgetId)

    const row = await sql<BudgetRow>`
      SELECT b.budget_id,
             b.limit_xusd,
             b.reserved_xusd,
             b.consumed_xusd,
             b.status,
             b.window_start,
             b.window_end
      FROM budgets b
      JOIN billing_accounts ba ON ba.billing_account_id = b.billing_account_id
      WHERE b.budget_id = ${budgetIdForUpdate}
        AND b.billing_user_id = ${params.billingUserId}
        AND b.billing_account_id = ${params.billingAccountId}
        AND ba.realm_id = ${params.realmId}
        AND b.status = 'active'
        AND (b.window_start IS NULL OR b.window_start <= ${params.now})
        AND (b.window_end IS NULL OR b.window_end > ${params.now})
      FOR UPDATE
    `
      .execute(trx)
      .then((res) => res.rows[0])

    if (!row) {
      throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'budget not found or inactive' }, 422)
    }

    const consume = params.consumeAmountXusd > 0n ? params.consumeAmountXusd : 0n
    const limit = row.limit_xusd === null ? null : bigintFromUnknown(row.limit_xusd) ?? null
    const reserved = bigintFromUnknown(row.reserved_xusd) ?? 0n
    const consumed = bigintFromUnknown(row.consumed_xusd) ?? 0n

    const newConsumed = consumed + consume
    const remaining = limit === null ? null : limit - reserved - newConsumed

    const hints: GateHint[] = []
    let status: 'ok' | 'limit_exceeded' = 'ok'
    if (remaining !== null && remaining < 0n) {
      const shortfall = -remaining
      hints.push(budgetShortfallHint(row.budget_id, toSafeNumber(shortfall)))
      status = 'limit_exceeded'
    }

    if (consume > 0n) {
      await trx
        .updateTable('budgets')
        .set({
          consumed_xusd: newConsumed.toString(),
          updated_at: params.now,
        })
        .where('budget_id', '=', row.budget_id)
        .execute()
    }

    return {
      budgetId: row.budget_id,
      consumedDeltaXusd: consume,
      remainingAmountXusd: remaining,
      reservedXusd: reserved,
      hints,
      status,
    }
  }

  async applyPayLaterWaterline(
    trx: Kysely<Database>,
    params: {
      realmId: string
      billingUserId: string
      billingAccountId: string
      budgetId: string
      needAmountXusd: bigint
      now: Date
      idempotencyKey?: string
      defaultLwm?: bigint
      defaultHwm?: bigint
    },
  ): Promise<BudgetWaterlineResult> {
    const budgetId = normalizeBudgetId(params.budgetId)

    const row = await sql<BudgetWaterlineRow>`
      SELECT b.budget_id,
             b.limit_xusd,
             b.reserved_xusd,
             b.consumed_xusd,
             b.status,
             b.window_start,
             b.window_end,
             b.scope_kind,
             b.scope_ref,
             b.scope_payload,
             b.metadata,
             b.lwm_xusd,
             b.hwm_xusd
      FROM budgets b
      JOIN billing_accounts ba ON ba.billing_account_id = b.billing_account_id
      WHERE b.billing_user_id = ${params.billingUserId}
        AND b.billing_account_id = ${params.billingAccountId}
        AND b.budget_id = ${budgetId}
        AND ba.realm_id = ${params.realmId}
      FOR UPDATE
    `
      .execute(trx)
      .then((res) => res.rows[0])

    if (!row) {
      throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'budget not found' }, 422)
    }

    const payload = (row.scope_payload ?? {}) as Record<string, unknown>
    const strategyConfig = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).budget_strategy : undefined

    const toBigIntOrNull = (value: unknown): bigint | null => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        const normalized = Math.floor(value)
        return normalized >= 0 ? BigInt(normalized) : null
      }
      if (typeof value === 'string') {
        try {
          const parsed = BigInt(value)
          return parsed >= 0n ? parsed : null
        } catch {
          return null
        }
      }
      if (typeof value === 'bigint' && value >= 0n) return value
      return null
    }

    let defaultLwm = params.defaultLwm ?? DEFAULT_LWM
    let defaultHwm = params.defaultHwm ?? DEFAULT_HWM

    if (strategyConfig && typeof strategyConfig === 'object') {
      const overrides = strategyConfig as Record<string, unknown>
      const overrideLwm = toBigIntOrNull(overrides.default_lwm_xusd)
      const overrideHwm = toBigIntOrNull(overrides.default_hwm_xusd)
      if (overrideLwm !== null) defaultLwm = overrideLwm
      if (overrideHwm !== null) defaultHwm = overrideHwm
    }

    const computation = this.computeBudgetWaterline(row, {
      needAmountXusd: params.needAmountXusd,
      now: params.now,
      defaultLwm,
      defaultHwm,
    })

    return await this.applyFundingForWaterline(trx, {
      row,
      computation,
      realmId: params.realmId,
      billingAccountId: params.billingAccountId,
      billingUserId: params.billingUserId,
      now: params.now,
      idempotencyKey: params.idempotencyKey,
    })
  }

  private computeBudgetWaterline(
    row: BudgetWaterlineRow,
    input: { needAmountXusd: bigint; now: Date; defaultLwm: bigint; defaultHwm: bigint },
  ): BudgetWaterlineComputation {
    const limit = bigintFromUnknown(row.limit_xusd) ?? null
    // const lwmEff = bigintFromUnknown(row.lwm_xusd) ?? input.defaultLwm
    const hwmEff = bigintFromUnknown(row.hwm_xusd) ?? input.defaultHwm

    const need = input.needAmountXusd > 0n ? input.needAmountXusd : 0n
    const reservedOriginal = bigintFromUnknown(row.reserved_xusd) ?? 0n
    const consumedOriginal = bigintFromUnknown(row.consumed_xusd) ?? 0n

    const inactive = row.status !== 'active'
    const expired = row.window_end !== null && row.window_end <= input.now

    if (inactive || expired) {
      return {
        reservedBaseXusd: reservedOriginal,
        consumedAfterXusd: consumedOriginal,
        wantedRefillXusd: 0n,
        limitXusd: limit,
        invalid: true,
        appliedConsumptionXusd: 0n,
        tailXusd: need,
      }
    }

    let availableHeadroom: bigint | null = null
    if (limit !== null) {
      availableHeadroom = limit - reservedOriginal - consumedOriginal
    }

    const refillTarget = availableHeadroom !== null ? hwmEff - availableHeadroom : hwmEff
    const refillAllowed = refillTarget > 0n ? refillTarget : 0n
    const refillApplied = refillAllowed >= need ? need : refillAllowed
    const tail = need - refillApplied

    return {
      reservedBaseXusd: reservedOriginal,
      consumedAfterXusd: consumedOriginal,
      wantedRefillXusd: refillApplied,
      limitXusd: limit,
      invalid: false,
      appliedConsumptionXusd: refillApplied,
      tailXusd: tail > 0n ? tail : 0n,
    }
  }

  private async applyFundingForWaterline(
    trx: Kysely<Database>,
    params: {
      row: BudgetWaterlineRow
      computation: BudgetWaterlineComputation
      realmId: string
      billingUserId: string
      billingAccountId: string
      now: Date
      idempotencyKey?: string
    },
  ): Promise<BudgetWaterlineResult> {
    const hints: GateHint[] = []

    const refillWanted = params.computation.wantedRefillXusd
    const tail = params.computation.tailXusd
    const limit = params.computation.limitXusd

    if (params.computation.invalid) {
      return {
        budgetId: params.row.budget_id,
        reservedXusd: bigintFromUnknown(params.row.reserved_xusd) ?? 0n,
        consumedXusd: bigintFromUnknown(params.row.consumed_xusd) ?? 0n,
        remainingHeadroomXusd: limit !== null ? limit - (bigintFromUnknown(params.row.reserved_xusd) ?? 0n) - (bigintFromUnknown(params.row.consumed_xusd) ?? 0n) : null,
        wantedRefillXusd: refillWanted,
        appliedRefillXusd: 0n,
        appliedConsumptionXusd: 0n,
        tailXusd: tail,
        hints,
      }
    }

    let appliedRefill = refillWanted
    if (appliedRefill > 0n) {
      // const metadata: Record<string, unknown> = {
      //   strategy: 'autofill',
      //   budget_id: params.row.budget_id,
      // }

      await appendLedgerEntry(trx, {
        billingUserId: params.billingUserId,
        billingAccountId: params.billingAccountId,
        currencyCode: WALLET_LEDGER_CURRENCY,
        amountXusd: -appliedRefill,
        reason: 'transfer',
        idempotencyKey: params.idempotencyKey ?? `budget-refill:${params.row.budget_id}:${params.now.toISOString()}`,
        sourceRef: `budget:${params.row.budget_id}`,
        labels: {
          operation: 'budget_refill',
        },
      })

      const newReserved = (bigintFromUnknown(params.row.reserved_xusd) ?? 0n) + appliedRefill
      await trx
        .updateTable('budgets')
        .set({
          reserved_xusd: newReserved.toString(),
          updated_at: params.now,
        })
        .where('budget_id', '=', params.row.budget_id)
        .execute()
    }

    return {
      budgetId: params.row.budget_id,
      reservedXusd: bigintFromUnknown(params.row.reserved_xusd) ?? 0n,
      consumedXusd: bigintFromUnknown(params.row.consumed_xusd) ?? 0n,
      remainingHeadroomXusd: limit !== null ? limit - (bigintFromUnknown(params.row.reserved_xusd) ?? 0n) - (bigintFromUnknown(params.row.consumed_xusd) ?? 0n) : null,
      wantedRefillXusd: refillWanted,
      appliedRefillXusd: appliedRefill,
      appliedConsumptionXusd: appliedRefill,
      tailXusd: tail,
      hints,
    }
  }
}
