import { Injectable, HttpException, Inject } from '@nestjs/common'
import { sql, type Insertable, type Kysely, type Transaction } from 'kysely'
import type { AppRequest } from '../../../types/app-request.js'
import type { Database } from '../../../types/database.js'
import type { components as BillingComponents } from '../../../contracts/billing.js'
import { SettlementService } from '../../gate/services/settlement.service.js'
import { BudgetService } from '../../../services/budget.service.js'
import { setRlsSession } from '../../../db/index.js'
import { runInTransaction } from '../../gate/services/gate.utils.js'

type CloseBudgetBody = {
  reason?: string
  metadata?: Record<string, unknown>
}

type Budget = BillingComponents['schemas']['Budget']
type BudgetList = BillingComponents['schemas']['BudgetList']

type BudgetStatus = 'active' | 'closing' | 'closed' | 'expired' | 'canceled'

type BudgetRow = {
  budget_id: string
  billing_user_id: string
  billing_account_id: string
  name: string | null
  status: BudgetStatus
  scope_kind: 'global' | 'feature' | 'feature_set' | null
  scope_payload: Record<string, unknown> | null
  limit_xusd: string | null
  reserved_xusd: string
  consumed_xusd: string
  lwm_xusd: string | null
  hwm_xusd: string | null
  window_start: Date | null
  window_end: Date | null
  closed_at: Date | null
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

const BUDGET_SETTLEMENT_LIMIT = 1000

@Injectable()
export class BudgetsService {
  constructor(
    @Inject(SettlementService) private readonly settlementService: SettlementService,
    @Inject(BudgetService) private readonly budgetService: BudgetService,
  ) {}
  async listBudgets(
    req: AppRequest,
    query: Record<string, unknown>,
  ): Promise<BudgetList> {
    const db = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const billingUserId = this.requireBillingUserId(req)
    const billingAccountId = this.requireBillingAccountId(req)

    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursorId = parseCursorId(query?.cursor)
    const statusFilter = Array.isArray(query?.status)
      ? (query.status as string[]).filter((value): value is BudgetStatus => isBudgetStatus(value))
      : undefined
    const scopeKind = typeof query?.scope_kind === 'string' ? (query.scope_kind as Budget['scope_kind']) : undefined
    const nameFilter = typeof query?.name === 'string' ? String(query.name).trim() : undefined
    const windowStartGe = toDate(query?.window_start_ge)
    const windowStartLe = toDate(query?.window_start_le)
    const windowEndGe = toDate(query?.window_end_ge)
    const windowEndLe = toDate(query?.window_end_le)
    const createdAtGe = toDate(query?.created_at_ge)
    const createdAtLe = toDate(query?.created_at_le)

    let builder = db
      .selectFrom('budgets as b')
      .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'b.billing_account_id')
      .selectAll('b')
      .where('ba.realm_id', '=', realmId)
      .where('b.billing_user_id', '=', billingUserId)
      .where('b.billing_account_id', '=', billingAccountId)
      .orderBy('b.created_at', 'desc')

    if (cursorId !== undefined) {
      builder = builder.where('b.budget_id', '<', cursorId)
    }

    if (statusFilter && statusFilter.length > 0) {
      const effectiveStatuses = new Set<BudgetStatus>()
      for (const status of statusFilter) {
        if (status === 'closed') {
          effectiveStatuses.add('closed')
          effectiveStatuses.add('closing')
        } else {
          effectiveStatuses.add(status)
        }
      }
      builder = builder.where('b.status', 'in', Array.from(effectiveStatuses))
    }
    if (scopeKind) {
      builder = builder.where('b.scope_kind', '=', scopeKind)
    }
    if (nameFilter) {
      builder = builder.where('b.name', 'ilike', `%${nameFilter}%`)
    }
    if (typeof query?.feature === 'string' && query.feature) {
      const feature = String(query.feature)
      builder = builder.where((eb) =>
        eb.or([
          sql<boolean>`coalesce(b.scope_payload->>'feature', '') = ${feature}`,
          sql<boolean>`coalesce(b.metadata->>'feature', '') = ${feature}`,
        ]),
      )
    }
    if (windowStartGe) {
      builder = builder.where((eb) => eb('b.window_start', '>=', windowStartGe).or(eb('b.window_start', 'is', null)))
    }
    if (windowStartLe) {
      builder = builder.where((eb) => eb('b.window_start', '<=', windowStartLe).or(eb('b.window_start', 'is', null)))
    }
    if (windowEndGe) {
      builder = builder.where((eb) => eb('b.window_end', '>=', windowEndGe).or(eb('b.window_end', 'is', null)))
    }
    if (windowEndLe) {
      builder = builder.where((eb) => eb('b.window_end', '<=', windowEndLe).or(eb('b.window_end', 'is', null)))
    }
    if (createdAtGe) {
      builder = builder.where('b.created_at', '>=', createdAtGe)
    }
    if (createdAtLe) {
      builder = builder.where('b.created_at', '<=', createdAtLe)
    }

    const rows = await builder.limit(limit + 1).execute()
    const items = rows.slice(0, limit).map(mapBudgetRow)
    const nextCursor = rows.length > limit ? rows[limit].budget_id : undefined

    return {
      items,
      next_cursor: nextCursor,
    }
  }

  async createBudget(
    req: AppRequest,
    body: BillingComponents['schemas']['BudgetCreateRequest'],
  ): Promise<Budget> {
    const db = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const billingUserId = this.requireBillingUserId(req)
    const billingAccountId = this.requireBillingAccountId(req)

    if (!billingAccountId) {
      throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'billing_account_id mismatch' }, 403)
    }

    await ensureRealm(db, billingAccountId, realmId)

    const featureCode =
      body?.scope_kind === 'feature'
        ? extractFeatureCode(body.scope_payload ?? null, body.metadata ?? null)
        : null

    const allowedScopeKinds: Budget['scope_kind'][] = ['global', 'feature', 'feature_set']
    const scopeKindRaw = (body?.scope_kind ?? 'global') as Budget['scope_kind']
    if (!allowedScopeKinds.includes(scopeKindRaw)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'invalid scope_kind' }, 422)
    }
    const scopeKind = scopeKindRaw

    const scopePayloadInput = body?.scope_payload && typeof body.scope_payload === 'object' && !Array.isArray(body.scope_payload)
      ? (body.scope_payload as Record<string, unknown>)
      : undefined
    const scopePayload = scopePayloadInput ? { ...scopePayloadInput } : null
    const metadataInput = body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : undefined
    const metadata = metadataInput ? { ...metadataInput } : {}

    let scopeRef: string | null = null
    if (scopeKind === 'feature') {
      const derivedFeature = featureCode ?? extractFeatureCode(scopePayload, metadata)
      if (!derivedFeature) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'feature scope requires feature identifier' }, 422)
      }
      scopeRef = derivedFeature
    } else if (scopeKind === 'feature_set') {
      const payloadFeatureSet = scopePayload && typeof scopePayload.feature_set === 'string' ? scopePayload.feature_set.trim() : ''
      if (!payloadFeatureSet) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'feature_set scope requires feature_set identifier' }, 422)
      }
      scopeRef = payloadFeatureSet
    }

    const limitXusd = body?.limit_xusd !== undefined ? normalizeXusd(body.limit_xusd) : null
    const lwmXusd = null
    const hwmXusd = null

    let windowStart: Date | null | undefined
    if (body?.window_start === undefined) {
      windowStart = undefined
    } else if (body.window_start === null) {
      windowStart = null
    } else {
      const parsed = toDate(body.window_start)
      if (!parsed) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'window_start must be ISO-8601 timestamp or null' }, 422)
      }
      windowStart = parsed
    }

    let windowEnd: Date | null | undefined
    if (body?.window_end === undefined) {
      windowEnd = undefined
    } else if (body.window_end === null) {
      windowEnd = null
    } else {
      const parsed = toDate(body.window_end)
      if (!parsed) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'window_end must be ISO-8601 timestamp or null' }, 422)
      }
      windowEnd = parsed
    }

    const result = await runInTransaction<BudgetRow>(db, async (trx) => {
      await setRlsSession(trx, { realmId, billingAccountId, billingUserId, isRealmAdmin: true })

      if (scopeKind === 'feature' && scopeRef) {
        const featureRow = await trx
          .selectFrom('features')
          .select('feature_code')
          .where('realm_id', '=', realmId)
          .where('feature_code', '=', scopeRef)
          .executeTakeFirst()

        if (!featureRow) {
          throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: `feature ${scopeRef} not found` }, 404)
        }
      }

      const insertValues: Insertable<Database['budgets']> = {
        billing_user_id: billingUserId,
        billing_account_id: billingAccountId,
        name: typeof body?.name === 'string' ? body.name : undefined,
        status: 'active',
        scope_kind: scopeKind,
        scope_ref: scopeRef,
        scope_payload: scopePayload ?? null,
        limit_xusd: limitXusd,
        reserved_xusd: '0',
        consumed_xusd: '0',
        lwm_xusd: lwmXusd,
        hwm_xusd: hwmXusd,
        metadata,
      }
      if (windowStart !== undefined) insertValues.window_start = windowStart
      if (windowEnd !== undefined) insertValues.window_end = windowEnd

      const inserted = await trx
        .insertInto('budgets')
        .values(insertValues)
        .returningAll()
        .executeTakeFirst()

      if (!inserted) {
        throw new HttpException({ code: 'WRITE.FAILURE', message: 'failed to create budget' }, 500)
      }

      return inserted
    })

    return mapBudgetRow(result)
  }

  async getBudget(req: AppRequest, budgetId: string): Promise<Budget> {
    const db = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const billingUserId = this.requireBillingUserId(req)
    const billingAccountId = this.requireBillingAccountId(req)
    const sanitizedBudgetId = this.sanitizeBudgetId(budgetId)

    const row = await db
      .selectFrom('budgets as b')
      .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'b.billing_account_id')
      .selectAll('b')
      .where('b.budget_id', '=', sanitizedBudgetId)
      .where('b.billing_user_id', '=', billingUserId)
      .where('b.billing_account_id', '=', billingAccountId)
      .where('ba.realm_id', '=', realmId)
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'budget not found' }, 404)
    }

    return mapBudgetRow(row)
  }

  async closeBudget(
    req: AppRequest,
    budgetId: string,
    body?: CloseBudgetBody,
  ): Promise<BillingComponents['schemas']['BudgetOpResponse']> {
    const db = this.ensureDb(req)
    const sanitizedBudgetId = this.sanitizeBudgetId(budgetId)

    return await runInTransaction(db, async (trx) => {
      const row = await this.lockBudget(trx, req, sanitizedBudgetId)

      const now = new Date()
      const shouldClose = row.status !== 'closed'
      let closedAt = row.closed_at ?? now

      const metadataPatch: Record<string, unknown> = {}
      if (body && typeof body === 'object') {
        if (typeof body.reason === 'string') {
          metadataPatch.close_reason = body.reason
        }
        if (body.metadata && typeof body.metadata === 'object') {
          Object.assign(metadataPatch, body.metadata)
        }
      }

      const updated = shouldClose
        ? await trx
            .updateTable('budgets')
            .set({
              status: 'closed',
              closed_at: closedAt,
              updated_at: now,
              metadata: {
                ...(row.metadata ?? {}),
                ...(Object.keys(metadataPatch).length > 0 ? metadataPatch : {}),
              },
            })
            .where('budget_id', '=', row.budget_id)
            .returningAll()
            .executeTakeFirst()
        : row

      const effectiveRow = updated ?? row
      if (shouldClose && !updated) {
        throw new HttpException({ code: 'WRITE.FAILURE', message: 'failed to close budget' }, 500)
      }
      closedAt = effectiveRow.closed_at ?? closedAt

      await this.settleBudgetCommits(trx, effectiveRow.budget_id, closedAt)

      const limit = parseXusd(effectiveRow.limit_xusd)
      const reserved = parseXusd(effectiveRow.reserved_xusd) ?? 0
      const consumed = parseXusd(effectiveRow.consumed_xusd) ?? 0
      const remaining = limit === undefined ? undefined : Math.max(0, limit - reserved - consumed)

      return {
        budget_id: effectiveRow.budget_id,
        consumed_xusd: consumed.toString(),
        remaining_xusd: remaining?.toString(),
      }
    })
  }

  private async settleBudgetCommits(
    trx: Transaction<Database>,
    budgetId: string,
    closedAt: Date,
  ): Promise<void> {
    let iteration = 0
    // Run batches until we drain pending commits or hit safety cap
    while (true) {
      const result = await this.settlementService.processBudgetBatch(trx, {
        budgetId,
        closedAt,
        limit: BUDGET_SETTLEMENT_LIMIT,
        now: new Date(),
      })

      if (result.errors.length > 0) {
        const summary = result.errors.map((err) => `${err.billingAccountId}:${err.reason}`).join(', ')
        throw new HttpException({ code: 'SETTLEMENT.ERROR', message: `budget settlement failed: ${summary}` }, 500)
      }

      if (result.claimedCount < BUDGET_SETTLEMENT_LIMIT) {
        break
      }

      iteration += 1
      if (iteration >= 10) {
        // Prevent runaway loops; remaining rows can be retried by the scheduler
        break
      }
    }
  }

  private async lockBudget(
    trx: Kysely<Database>,
    req: AppRequest,
    budgetId: string,
  ): Promise<BudgetRow> {
    const realmId = this.ensureRealmId(req)
    const billingUserId = this.requireBillingUserId(req)
    const billingAccountId = this.requireBillingAccountId(req)
    const sanitizedBudgetId = this.sanitizeBudgetId(budgetId)
    const row = await sql<BudgetRow>`
      SELECT b.budget_id,
             b.billing_user_id,
             b.billing_account_id,
             b.name,
             b.status,
             b.scope_kind,
             b.scope_payload,
             b.limit_xusd,
             b.reserved_xusd,
             b.consumed_xusd,
             b.lwm_xusd,
             b.hwm_xusd,
             b.window_start,
             b.window_end,
             b.closed_at,
             b.metadata,
             b.created_at,
             b.updated_at
      FROM budgets b
      JOIN billing_accounts ba ON ba.billing_account_id = b.billing_account_id
      WHERE b.budget_id = ${sanitizedBudgetId}
        AND b.billing_user_id = ${billingUserId}
        AND b.billing_account_id = ${billingAccountId}
        AND ba.realm_id = ${realmId}
      FOR UPDATE
    `
      .execute(trx)
      .then((res) => res.rows[0])

    if (!row) {
      throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'budget not found' }, 404)
    }

    return row
  }

  private sanitizeBudgetId(rawId: string): string {
    const normalized = normalizeUuidId(rawId)
    if (!normalized) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'invalid budget_id' }, 422)
    }
    return normalized
  }

  private ensureDb(req: AppRequest): Kysely<Database> {
    const db = req.ctx?.db
    if (!db) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'database session unavailable' }, 500)
    }
    return db
  }

  private ensureRealmId(req: AppRequest): string {
    const realmId = req.ctx?.realmId
    if (!realmId) {
      throw new HttpException({ code: 'AUTH.MISSING_REALM', message: 'realm_id missing in context' }, 400)
    }
    return realmId
  }

  private requireBillingAccountId(req: AppRequest): string {
    const billingAccountId = req.ctx?.billingAccountId
    if (!billingAccountId) {
      throw new HttpException({ code: 'AUTH.MISSING_ACCOUNT', message: 'billing account context missing' }, 400)
    }
    return billingAccountId
  }

  private requireBillingUserId(req: AppRequest): string {
    const billingUserId = req.ctx?.billingUserId
    if (!billingUserId) {
      throw new HttpException({ code: 'AUTH.MISSING_USER', message: 'billing user context missing' }, 400)
    }
    return billingUserId
  }
}

const BUDGET_STATUS_VALUES = new Set<BudgetStatus>(['active', 'closed', 'expired', 'canceled'])

function isBudgetStatus(value: unknown): value is BudgetStatus {
  return typeof value === 'string' && BUDGET_STATUS_VALUES.has(value as BudgetStatus)
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 50
  return Math.min(200, Math.max(1, Math.floor(value)))
}

function mapBudgetRow(row: BudgetRow): Budget {
  const budgetId = row.budget_id
  const limit = parseXusd(row.limit_xusd)
  const reserved = parseXusd(row.reserved_xusd) ?? 0
  const consumed = parseXusd(row.consumed_xusd) ?? 0
  const remaining = limit === undefined ? null : Math.max(0, limit - reserved - consumed)

  const statusForApi: Budget['status'] = row.status === 'closing' ? 'closed' : row.status

  return {
    budget_id: budgetId,
    billing_account_id: row.billing_account_id,
    name: row.name ?? undefined,
    status: statusForApi,
    scope_kind: row.scope_kind ?? null,
    scope_payload: (row.scope_payload ?? undefined) as Record<string, never> | undefined,
    limit_xusd: limit?.toString(),
    consumed_xusd: consumed.toString(),
    window_start: row.window_start?.toISOString() ?? null,
    window_end: row.window_end?.toISOString() ?? null,
    metadata: (row.metadata ?? {}) as Record<string, never>,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    remaining_xusd: remaining?.toString(),
  }
}

function parseXusd(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string') {
    try {
      return toSafeNumber(BigInt(value))
    } catch {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? Math.floor(parsed) : undefined
    }
  }
  if (typeof value === 'bigint') {
    return toSafeNumber(value)
  }
  return undefined
}

function normalizeXusd(input: unknown): string | null {
  if (input === null || input === undefined) return null
  const parsed = Number(input)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'value must be non-negative integer' }, 422)
  }
  return BigInt(Math.floor(parsed)).toString()
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new HttpException({ code: 'SERVER.CONFIG', message: 'value exceeds numeric range' }, 500)
  }
  return Number(value)
}

async function ensureRealm(db: Kysely<Database>, billingAccountId: string, realmId: string): Promise<void> {
  const row = await db
    .selectFrom('billing_accounts')
    .select(['realm_id'])
    .where('billing_account_id', '=', billingAccountId)
    .executeTakeFirst()

  if (!row || row.realm_id !== realmId) {
    throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'billing account realm mismatch' }, 403)
  }
}

function toDate(input: unknown): Date | undefined {
  if (!input) return undefined
  const date = new Date(String(input))
  return Number.isNaN(date.getTime()) ? undefined : date
}

function normalizeUuidId(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined
  const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  return uuidRe.test(trimmed) ? trimmed.toLowerCase() : undefined
}

function parseCursorId(input: unknown): string | undefined {
  return normalizeUuidId(input)
}

function extractFeatureCode(scopePayload: unknown, metadata: unknown): string | null {
  const payloadFeature = scopePayload && typeof scopePayload === 'object' && scopePayload !== null
    ? (scopePayload as Record<string, unknown>).feature
    : undefined
  if (typeof payloadFeature === 'string' && payloadFeature.trim().length > 0) {
    return payloadFeature.trim()
  }

  const metadataFeature = metadata && typeof metadata === 'object' && metadata !== null
    ? (metadata as Record<string, unknown>).feature
    : undefined
  if (typeof metadataFeature === 'string' && metadataFeature.trim().length > 0) {
    return metadataFeature.trim()
  }

  return null
}
