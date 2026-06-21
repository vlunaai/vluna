import { Inject, Injectable } from '@nestjs/common'
import { randomUUID, createHash } from 'node:crypto'
import { sql, type Insertable, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../../types/database.js'
import { appendLedgerEntry } from '../../../services/ledger.js'
import { bigintFromUnknown, runInTransaction } from './gate.utils.js'
import { GrantBalanceService } from '../../../services/grant-balance.service.js'
import { ensureFallbackGrantForPeriod } from '../../../services/grant-issuance.service.js'
import { WALLET_LEDGER_CURRENCY } from '../../../config/currency.js'
import { BillingPeriodService } from '../../../services/billing-period.service.js'

const DEFAULT_GUARD_MS = 2 * 60 * 1000
const DEFAULT_LIMIT = 1000
type BudgetStatus = 'active' | 'closing' | 'closed' | 'expired' | 'canceled'

type ClaimedSettlementRow = {
  allocation_id: string
  rating_id: string
  billing_user_id: string
  billing_account_id: string
  budget_id: string | null
  amount_xusd: string
  cost_xusd: string
  allocated_xusd: string
  applied_amount_xusd: string
  applied_cost_xusd: string
  applied_quantity_minor: string
  application_status: 'applied' | 'quarantined' | 'applied_clipped' | 'reversed' | 'error'
  reason_codes: string[] | null
  late_rating: boolean | null
  pricing_fingerprint: string | null
  grant_id: string | null
  funding_kind: 'grant' | 'cash' | 'credit' | 'other'
  decided_at: Date | null
  grant_ledger_id?: string | null
  grant_source_entry_id?: string | null
  grant_kind?: string | null
}

type PendingSettlementAllocation = {
  grantId: string | null
  fundingKind: 'grant' | 'cash' | 'credit' | 'other'
  allocatedAmountXusd: bigint
  allocSeq: number
  metadata?: Record<string, unknown>
}

type FundingAllocationPlan = {
  allocations: PendingSettlementAllocation[]
  grantCoverageXusd: bigint
  fallbackGrantId: string | null
}

type GroupedSettlement = {
  billingUserId: string
  billingAccountId: string
  allocationIds: string[]
  onLedgerAllocationIds: string[]
  offLedgerAllocationIds: string[]
  ratingIds: Set<string>
  pricingFingerprints: Set<string>
  totalApplied: bigint
  billableApplied: bigint
  promoApplied: bigint
}

export type SettlementBatchResult = {
  batchId: string
  runId: string
  claimedCount: number
  settledCount: number
  totalAmountPostedXusd: bigint
  errors: Array<{ billingAccountId: string; reason: string; details?: string }>
}

type RollingBatchParams = {
  guardDurationMs?: number
  limit?: number
  batchId?: string
  runId?: string
  now?: Date
}

type BudgetBatchParams = {
  budgetId: string
  closedAt?: Date | string
  committedBefore?: Date
  allowedStatuses?: BudgetStatus[]
  limit?: number
  batchId?: string
  runId?: string
  scopeKey?: string
  engine?: string
  now?: Date
}

export type BudgetSettlementCandidate = {
  budgetId: string
  billingAccountId: string
  realmId: string
  status: BudgetStatus
  closedAt: Date | null
  oldestCommitAt: Date | null
  lastCommitAt: Date | null
  pendingCount: number
  pendingOnLedgerCount: number
}

type BudgetCandidateQueryParams = {
  realmId: string
  limit?: number
  statuses?: BudgetStatus[]
  requireOnLedger?: boolean
}

type RollingSettlementCandidate = {
  billingAccountId: string
  realmId: string
  oldestCommitAt: Date
}

type BatchContext = {
  scopeKind: string
  scopeKey: string
  engine: string
  batchId: string
  runId: string
  now: Date
}

@Injectable()
export class SettlementService {
  constructor(
    @Inject(GrantBalanceService) private readonly grantBalanceService: GrantBalanceService,
    @Inject(BillingPeriodService) private readonly billingPeriodService: BillingPeriodService,
  ) {}

  private isSameInstant(a: Date | null, b: Date | null): boolean {
    if (!a && !b) return true
    if (!a || !b) return false
    return a.getTime() === b.getTime()
  }

  async ensurePendingSettlement(
    dbOrTrx: Kysely<Database> | Transaction<Database>,
    params: {
      realmId: string
      featureCode: string
      commitId: string
      billingUserId: string
      billingAccountId: string
      canonicalAmountXusd: bigint
      canonicalCostXusd: bigint
      committedAt: Date
      appliedAmountXusd: bigint
      appliedCostXusd: bigint
      appliedQuantityMinor: bigint
      applicationStatus: 'applied' | 'quarantined' | 'applied_clipped' | 'reversed' | 'error'
      reasonCodes?: string[] | null
      lateCommit?: boolean
      budgetId?: string | null
      pricingFingerprint?: string | null
      costFingerprint?: string | null
      usageStartedAt?: Date | null
      usageFinishedAt?: Date | null
      engine?: string
      metadata?: Record<string, unknown>
      decidedAt?: Date
      allocations: PendingSettlementAllocation[]
    },
  ): Promise<void> {
    const allocations = Array.isArray(params.allocations) ? params.allocations.slice() : []
    const decidedAt = params.decidedAt ?? new Date()
    const baseMetadata = params.metadata ?? {}

    const positiveAllocations = allocations.filter((allocation) => allocation.allocatedAmountXusd > 0n)
    const effectiveAllocations = positiveAllocations.length > 0 ? positiveAllocations : allocations

    const existingRows = await dbOrTrx
      .selectFrom('billing_rating_allocations')
      .select([
        'grant_id',
        'funding_kind',
        'alloc_seq',
        'allocated_xusd',
        'settlement_state',
      ])
      .where('rating_id', '=', params.commitId)
      .forUpdate()
      .execute()

    const existingMap = new Map<string, { allocated: bigint; state: Database['billing_rating_allocations']['settlement_state'] }>()
    for (const row of existingRows) {
      const grantId = row.grant_id === null ? null : String(row.grant_id)
      const key = this.makeSettlementKey(grantId, row.funding_kind, row.alloc_seq ?? 1)
      const allocated = bigintFromUnknown(row.allocated_xusd) ?? 0n
      existingMap.set(key, { allocated, state: row.settlement_state })
    }

    const pendingAdjustments = new Map<string, bigint>()

    const allocationWeights = effectiveAllocations.map((allocation) =>
      allocation.allocatedAmountXusd > 0n ? allocation.allocatedAmountXusd : 0n,
    )
    const appliedAmountSplits = this.distributeByWeight(params.appliedAmountXusd, allocationWeights)
    const appliedCostSplits = this.distributeByWeight(params.appliedCostXusd, allocationWeights)
    const appliedQuantitySplits = this.distributeByWeight(params.appliedQuantityMinor, allocationWeights)

    const rows: Insertable<Database['billing_rating_allocations']>[] = effectiveAllocations.map((allocation, index) => {
      const metadata = allocation.metadata ? { ...baseMetadata, ...allocation.metadata } : baseMetadata
      const allocSeq = allocation.allocSeq ?? 1
      const key = this.makeSettlementKey(allocation.grantId ?? null, allocation.fundingKind, allocSeq)
      const existing = existingMap.get(key)
      const previousContribution = existing && (existing.state === 'pending' || existing.state === 'settling')
        ? existing.allocated
        : 0n
      const pendingDelta = allocation.grantId ? allocation.allocatedAmountXusd - previousContribution : 0n
      if (allocation.grantId && pendingDelta !== 0n) {
        const current = pendingAdjustments.get(allocation.grantId) ?? 0n
        pendingAdjustments.set(allocation.grantId, current + pendingDelta)
      }
      return {
        realm_id: params.realmId,
        feature_code: params.featureCode,
        rating_id: params.commitId,
        billing_user_id: params.billingUserId,
        billing_account_id: params.billingAccountId,
        amount_xusd: params.canonicalAmountXusd.toString(),
        cost_xusd: params.canonicalCostXusd.toString(),
        grant_id: allocation.grantId ?? null,
        funding_kind: allocation.fundingKind,
        allocated_xusd: allocation.allocatedAmountXusd.toString(),
        alloc_seq: allocSeq,
        applied_amount_xusd: appliedAmountSplits[index]?.toString() ?? '0',
        applied_cost_xusd: appliedCostSplits[index]?.toString() ?? '0',
        applied_quantity_minor: appliedQuantitySplits[index]?.toString() ?? '0',
        rated_at: params.committedAt,
        settlement_state: 'pending',
        application_status: params.applicationStatus,
        reason_codes: params.reasonCodes ?? [],
        late_rating: params.lateCommit ?? false,
        pricing_fingerprint: params.pricingFingerprint ?? undefined,
        cost_fingerprint: params.costFingerprint ?? undefined,
        budget_id: params.budgetId ?? undefined,
        engine: params.engine ?? 'unspecified',
        usage_started_at: params.usageStartedAt ?? null,
        usage_finished_at: params.usageFinishedAt ?? null,
        metadata,
        decided_at: decidedAt,
      }
    })

    if (rows.length === 0) {
      return
    }

    await dbOrTrx
      .insertInto('billing_rating_allocations')
      .values(rows)
      .onConflict((oc) =>
        oc
          .columns(['rating_id', 'grant_id', 'funding_kind', 'alloc_seq'])
          .doUpdateSet({
            amount_xusd: sql`excluded.amount_xusd`,
            cost_xusd: sql`excluded.cost_xusd`,
            allocated_xusd: sql`excluded.allocated_xusd`,
            applied_amount_xusd: sql`excluded.applied_amount_xusd`,
            applied_cost_xusd: sql`excluded.applied_cost_xusd`,
            applied_quantity_minor: sql`excluded.applied_quantity_minor`,
            application_status: sql`excluded.application_status`,
            reason_codes: sql`excluded.reason_codes`,
            late_rating: sql`excluded.late_rating`,
            realm_id: sql`excluded.realm_id`,
            feature_code: sql`excluded.feature_code`,
            billing_user_id: sql`excluded.billing_user_id`,
            billing_account_id: sql`excluded.billing_account_id`,
            budget_id: sql`excluded.budget_id`,
            pricing_fingerprint: sql`excluded.pricing_fingerprint`,
            cost_fingerprint: sql`excluded.cost_fingerprint`,
            engine: sql`excluded.engine`,
            usage_started_at: sql`excluded.usage_started_at`,
            usage_finished_at: sql`excluded.usage_finished_at`,
            metadata: sql`excluded.metadata`,
            decided_at: sql`excluded.decided_at`,
            rated_at: sql`excluded.rated_at`,
            settlement_state: sql`'pending'`,
            settlement_scope_kind: sql`null`,
            settlement_scope_key: sql`null`,
            settlement_batch_id: sql`null`,
            engine_run_id: sql`null`,
            entry_id: sql`null`,
            entry_ref: sql`null`,
            entry_amount_xusd: sql`null`,
            entry_reason: sql`null`,
            settled_at: sql`null`,
            error_code: sql`null`,
            error_message: sql`null`,
            updated_at: sql`now()`,
          }),
      )
      .execute()

    if (pendingAdjustments.size > 0) {
      for (const [grantId, delta] of pendingAdjustments) {
        if (delta === 0n) continue
        await this.applyGrantAdjustments(dbOrTrx, grantId, { pending: delta }, decidedAt)
      }
    }
  }

  async planFundingAllocations(
    trx: Kysely<Database> | Transaction<Database>,
    params: { realmId: string; billingUserId: string; billingAccountId: string; amountXusd: bigint; now: Date },
  ): Promise<FundingAllocationPlan> {
    const required = params.amountXusd > 0n ? params.amountXusd : 0n
    if (required === 0n) {
      return { allocations: [], grantCoverageXusd: 0n, fallbackGrantId: null }
    }

    const period = await this.billingPeriodService.ensureBillingPeriodInstance(trx, {
      realmId: params.realmId,
      billingAccountId: params.billingAccountId,
      at: params.now,
    })

    const balances = await this.grantBalanceService.getAccountGrantBalances(trx, {
      billingUserId: params.billingUserId,
      billingAccountId: params.billingAccountId,
      asOf: params.now,
      includeExpired: false,
      lock: 'for_update_skip_locked',
    })

    const allocations: PendingSettlementAllocation[] = []
    let remaining = required
    let grantCoverage = 0n

    const sequenceByGrant = new Map<string, number>()

    const fallbackGrant = balances.grants.find(
      (grant) =>
        grant.kind === 'fallback'
        && this.isSameInstant(grant.windowStart, period.periodStart)
        && this.isSameInstant(grant.windowEnd, period.periodEnd),
    ) ?? null
    if (fallbackGrant) {
      sequenceByGrant.set(fallbackGrant.grantId, 0)
    }

    const spendableGrants = balances.grants.filter((grant) => grant.kind !== 'fallback')

    for (const grant of spendableGrants) {
      if (remaining <= 0n) break
      if (grant.availableXusd <= 0n) continue
      const use = grant.availableXusd >= remaining ? remaining : grant.availableXusd
      if (use <= 0n) continue

      const nextSeq = (sequenceByGrant.get(grant.grantId) ?? 0) + 1
      sequenceByGrant.set(grant.grantId, nextSeq)

      allocations.push({
        grantId: grant.grantId,
        fundingKind: 'grant',
        allocatedAmountXusd: use,
        allocSeq: nextSeq,
      })
      grantCoverage += use
      remaining -= use
    }

    let fallbackGrantId: string | null = fallbackGrant ? fallbackGrant.grantId : null

    if (remaining > 0n) {
      fallbackGrantId = fallbackGrantId
        ?? (await ensureFallbackGrantForPeriod(trx, {
          realmId: params.realmId,
          billingUserId: params.billingUserId,
          billingAccountId: params.billingAccountId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
        }))

      const nextSeq = (sequenceByGrant.get(fallbackGrantId) ?? 0) + 1
      sequenceByGrant.set(fallbackGrantId, nextSeq)

      allocations.push({
        grantId: fallbackGrantId,
        fundingKind: 'grant',
        allocatedAmountXusd: remaining,
        allocSeq: nextSeq,
        metadata: { fallback: true },
      })
      remaining = 0n
    }

    return { allocations, grantCoverageXusd: grantCoverage, fallbackGrantId }
  }

  async settleCommitsImmediately(
    trx: Transaction<Database>,
    params: {
      commits: Array<{
        commitId: string
        billingAccountId: string
        pricingFingerprint: string
        amountXusd: bigint
        committedAt: Date
        budgetId: string | null
      }>
      scope?: { kind: string; key: string; engine?: string }
      now?: Date
    },
  ): Promise<void> {
    if (params.commits.length === 0) return

    const now = params.now ?? new Date()
    const scopeKind = params.scope?.kind ?? 'immediate'
    const scopeKey = params.scope?.key ?? 'inline'
    const engine = params.scope?.engine ?? 'inline'
    const batchId = randomUUID()
    const runId = randomUUID()

    const commitIds = params.commits.map((commit) => commit.commitId)
    const claimed = await this.claimPending(trx, commitIds, {
      scopeKind,
      scopeKey,
      engine,
      batchId,
      runId,
      now,
    })

    if (claimed.length === 0) {
      return
    }

    await this.finalizeClaims(trx, claimed, {
      scopeKind,
      scopeKey,
      engine,
      batchId,
      runId,
      now,
    })
  }

  async processRollingBatch(
    db: Kysely<Database> | Transaction<Database>,
    params?: RollingBatchParams,
  ): Promise<SettlementBatchResult> {
    return runInTransaction(db, async (trx) => {
      const guardDurationMs = params?.guardDurationMs ?? DEFAULT_GUARD_MS
      const limit = params?.limit ?? DEFAULT_LIMIT
      const batchId = params?.batchId ?? randomUUID()
      const runId = params?.runId ?? randomUUID()
      const now = params?.now ?? new Date()
      const guardThreshold = new Date(now.getTime() - guardDurationMs)

      const candidates = await sql<{ rating_id: string }>`
        SELECT s.rating_id
        FROM billing_rating_allocations s
        WHERE s.settlement_state = 'pending'
          AND s.budget_id IS NULL
          AND s.rated_at <= ${guardThreshold}
        GROUP BY s.rating_id
        ORDER BY MIN(s.rated_at) ASC
        LIMIT ${limit}
      `.execute(trx)

      const commitIds = candidates.rows.map((row) => row.rating_id)

      if (commitIds.length === 0) {
        return {
          batchId,
          runId,
          claimedCount: 0,
          settledCount: 0,
          totalAmountPostedXusd: 0n,
          errors: [],
        }
      }

      const claimed = await this.claimPending(trx, commitIds, {
        scopeKind: 'time',
        scopeKey: 'rolling',
        engine: 'periodic',
        batchId,
        runId,
        now,
      })

      if (claimed.length === 0) {
        return {
          batchId,
          runId,
          claimedCount: 0,
          settledCount: 0,
          totalAmountPostedXusd: 0n,
          errors: [],
        }
      }

      const finalizeResult = await this.finalizeClaims(trx, claimed, {
        scopeKind: 'time',
        scopeKey: 'rolling',
        engine: 'periodic',
        batchId,
        runId,
        now,
      })

      return {
        batchId,
        runId,
        claimedCount: claimed.length,
        settledCount: finalizeResult.settledCount,
        totalAmountPostedXusd: finalizeResult.totalPosted,
        errors: finalizeResult.errors,
      }
    })
  }

  async listRollingSettlementCandidates(
    db: Kysely<Database> | Transaction<Database>,
    params: { realmId: string; guardThreshold: Date; limit?: number },
  ): Promise<RollingSettlementCandidate[]> {
    const limit = params.limit ?? DEFAULT_LIMIT
    const rows = await sql<{ billing_account_id: string; oldest_commit_at: Date | null }>`
      SELECT
        billing_account_id,
        MIN(rated_at) AS oldest_commit_at
      FROM billing_rating_allocations
      WHERE settlement_state = 'pending'
        AND budget_id IS NULL
        AND realm_id = ${params.realmId}
        AND rated_at <= ${params.guardThreshold}
      GROUP BY billing_account_id
      ORDER BY MIN(rated_at) ASC
      LIMIT ${limit}
    `.execute(db)

    return rows.rows.map((row) => ({
      billingAccountId: String(row.billing_account_id),
      realmId: params.realmId,
      oldestCommitAt: row.oldest_commit_at ? new Date(row.oldest_commit_at) : new Date(0),
    }))
  }

  async listBudgetSettlementCandidates(
    db: Kysely<Database> | Transaction<Database>,
    params: BudgetCandidateQueryParams,
  ): Promise<BudgetSettlementCandidate[]> {
    const limit = params.limit ?? DEFAULT_LIMIT
    const statuses = params.statuses ?? ['active', 'closing', 'closed', 'expired', 'canceled']
    const requireOnLedger = params.requireOnLedger ?? false
    const statusClause = statuses.length
      ? sql` AND b.status = ANY(${sql`ARRAY[${sql.join(statuses.map((status) => sql`${status}`), sql`, `)}]::text[]`})`
      : sql``

    const rows = await sql<{
      budget_id: string
      billing_account_id: string
      realm_id: string
      status: BudgetStatus
      closed_at: Date | null
      last_commit_at: Date | null
      pending_count: number
      oldest_commit_at: Date | null
      pending_on_ledger_count: number
    }>`
      SELECT
        s.budget_id,
        s.billing_account_id,
        s.realm_id,
        b.status,
        b.closed_at,
        MAX(r.rated_at) AS last_commit_at,
        MIN(r.rated_at) AS oldest_commit_at,
        COUNT(*) AS pending_count,
        SUM(
          CASE
            WHEN s.funding_kind <> 'grant' THEN 1
            WHEN lg.ledger_id IS NOT NULL OR lg.source_entry_id IS NOT NULL THEN 1
            ELSE 0
          END
        ) AS pending_on_ledger_count
      FROM billing_rating_allocations s
      JOIN budgets b ON b.budget_id = s.budget_id
      JOIN billing_ratings r ON r.rating_id = s.rating_id
      LEFT JOIN ledger_grants lg ON lg.grant_id = s.grant_id
      WHERE s.settlement_state = 'pending'
        AND s.realm_id = ${params.realmId}
        ${statusClause}
      GROUP BY s.budget_id, s.billing_account_id, s.realm_id, b.status, b.closed_at
      ORDER BY oldest_commit_at ASC NULLS FIRST
      LIMIT ${limit}
    `.execute(db)

    const candidates = rows.rows
      .map((row) => ({
        budgetId: String(row.budget_id),
        billingAccountId: String(row.billing_account_id),
        realmId: String(row.realm_id),
        status: row.status,
        closedAt: row.closed_at ? new Date(row.closed_at) : null,
        oldestCommitAt: row.oldest_commit_at ? new Date(row.oldest_commit_at) : null,
        lastCommitAt: row.last_commit_at ? new Date(row.last_commit_at) : null,
        pendingCount: Number(row.pending_count ?? 0),
        pendingOnLedgerCount: Number(row.pending_on_ledger_count ?? 0),
      }))
      .filter((candidate) => (requireOnLedger ? candidate.pendingOnLedgerCount > 0 : true))

    return candidates
  }

  async processBudgetBatch(
    db: Kysely<Database> | Transaction<Database>,
    params: BudgetBatchParams,
  ): Promise<SettlementBatchResult> {
    const closedAt = params.closedAt ? this.normalizeTimestamp(params.closedAt) : null
    const committedBefore = params.committedBefore ?? closedAt ?? new Date()
    const budgetId = params.budgetId.trim()
    const allowedStatuses = params.allowedStatuses && params.allowedStatuses.length > 0
      ? params.allowedStatuses
      : ['closing', 'closed', 'expired', 'canceled']

    return runInTransaction(db, async (trx) => {
      const limit = params.limit ?? DEFAULT_LIMIT
      const batchId = params.batchId ?? randomUUID()
      const runId = params.runId ?? randomUUID()
      const now = params.now ?? new Date()
      const scopeKey = params.scopeKey ?? `budget:${budgetId}`
      const engine = params.engine ?? 'budget_exhausted'

      const candidates = await sql<{ rating_id: string }>`
        SELECT s.rating_id
        FROM billing_rating_allocations s
        JOIN billing_ratings r ON r.rating_id = s.rating_id
        JOIN budgets b ON b.budget_id = r.budget_id
        WHERE s.settlement_state = 'pending'
          AND s.budget_id = ${budgetId}
          AND r.rated_at <= ${committedBefore}
          AND b.status = ANY(${sql`ARRAY[${sql.join(allowedStatuses.map((status) => sql`${status}`), sql`, `)}]::text[]`})
        GROUP BY s.rating_id
        ORDER BY MIN(s.rated_at) ASC
        LIMIT ${limit}
      `.execute(trx)

      const commitIds = candidates.rows.map((row) => String(row.rating_id))

      if (commitIds.length === 0) {
        return {
          batchId,
          runId,
          claimedCount: 0,
          settledCount: 0,
          totalAmountPostedXusd: 0n,
          errors: [],
        }
      }

      const claimed = await this.claimPending(trx, commitIds, {
        scopeKind: 'budget',
        scopeKey,
        engine,
        batchId,
        runId,
        now,
      })

      if (claimed.length === 0) {
        return {
          batchId,
          runId,
          claimedCount: 0,
          settledCount: 0,
          totalAmountPostedXusd: 0n,
          errors: [],
        }
      }

      const finalizeResult = await this.finalizeClaims(trx, claimed, {
        scopeKind: 'budget',
        scopeKey,
        engine,
        batchId,
        runId,
        now,
      })

      return {
        batchId,
        runId,
        claimedCount: claimed.length,
        settledCount: finalizeResult.settledCount,
        totalAmountPostedXusd: finalizeResult.totalPosted,
        errors: finalizeResult.errors,
      }
    })
  }

  async requeueStuckSettlements(
    db: Kysely<Database> | Transaction<Database>,
    olderThanMs = 10 * 60 * 1000,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs)
    const result = await db
      .updateTable('billing_rating_allocations')
      .set({
        settlement_state: 'pending',
        settlement_batch_id: null,
        engine_run_id: null,
        settlement_scope_kind: null,
        settlement_scope_key: null,
        updated_at: new Date(),
      })
      .where('settlement_state', '=', 'settling')
      .where((eb) =>
        eb.or([
          eb('settled_at', 'is', null),
          eb('settled_at', '<', cutoff),
        ]),
      )
      .where('updated_at', '<', cutoff)
      .executeTakeFirst()

    return result.numUpdatedRows ? Number(result.numUpdatedRows) : 0
  }

  private async claimPending(
    trx: Transaction<Database>,
    commitIds: string[],
    context: BatchContext,
  ): Promise<ClaimedSettlementRow[]> {
    if (!commitIds.length) return []

    const rows = await trx
      .updateTable('billing_rating_allocations')
      .set({
        settlement_state: 'settling',
        settlement_scope_kind: context.scopeKind,
        settlement_scope_key: context.scopeKey,
        settlement_batch_id: context.batchId,
        engine: context.engine,
        engine_run_id: context.runId,
        updated_at: context.now,
      })
      .where('rating_id', 'in', commitIds)
      .where('settlement_state', '=', 'pending')
      .returning([
        'allocation_id',
        'rating_id',
        'billing_user_id',
        'billing_account_id',
        'budget_id',
        'amount_xusd',
        'cost_xusd',
        'allocated_xusd',
        'applied_amount_xusd',
        'applied_cost_xusd',
        'applied_quantity_minor',
        'application_status',
        'reason_codes',
        'late_rating',
        'pricing_fingerprint',
        'grant_id',
        'funding_kind',
        'decided_at',
      ])
      .execute()

    if (rows.length === 0) {
      return []
    }

    const grantIds = Array.from(
      new Set(
        rows
          .map((row) => (row.grant_id === null ? null : String(row.grant_id)))
          .filter((value): value is string => value !== null && value.length > 0),
      ),
    )

    let grantLookup = new Map<string, { ledger_id: string | null; source_entry_id: string | null; kind: string | null }>()
    if (grantIds.length > 0) {
      const grantRows = await trx
        .selectFrom('ledger_grants')
        .select(['grant_id', 'ledger_id', 'source_entry_id', 'kind'])
        .where('grant_id', 'in', grantIds)
        .execute()
      grantLookup = new Map(grantRows.map((row) => [String(row.grant_id), row]))
    }

    return rows.map((row) => {
      const settlementId = String(row.allocation_id)
      const commitId = String(row.rating_id)
      const budgetId = row.budget_id === null ? null : String(row.budget_id)
      const grantId = row.grant_id === null ? null : String(row.grant_id)
      const grant = grantId !== null ? grantLookup.get(grantId) : undefined
      return {
        ...row,
        allocation_id: settlementId,
        rating_id: commitId,
        budget_id: budgetId,
        grant_id: grantId,
        grant_ledger_id: grant?.ledger_id ?? null,
        grant_source_entry_id: grant?.source_entry_id ?? null,
        grant_kind: grant?.kind ?? null,
      }
    })
  }

  private async finalizeClaims(
    trx: Transaction<Database>,
    claimed: ClaimedSettlementRow[],
    context: BatchContext,
  ): Promise<{ settledCount: number; totalPosted: bigint; errors: SettlementBatchResult['errors'] }> {
    const groups = this.groupByBillingUser(claimed)
    const errors: SettlementBatchResult['errors'] = []
    let settledCount = 0
    let totalPosted = 0n

    for (const [billingUserId, group] of groups) {
      const billingAccountId = group.billingAccountId
      if (group.totalApplied < 0n) {
        await this.markError(trx, group.allocationIds, 'SETTLEMENT.INVALID_AMOUNT', 'applied_amount_xusd must be non-negative', context.now)
        errors.push({ billingAccountId, reason: 'invalid_amount', details: 'applied_amount_xusd must be non-negative' })
        continue
      }

      const idempotencyKey = this.buildIdempotencyKey({
        scopeKind: context.scopeKind,
        scopeKey: context.scopeKey,
        batchId: context.batchId,
        billingUserId,
        billingAccountId,
        pricingFingerprints: Array.from(group.pricingFingerprints),
      })

      let entryId: string | null = null
      let postedAmountXusd = 0n
      const needsLedgerPosting = group.billableApplied > 0n

      try {
        if (needsLedgerPosting) {
          postedAmountXusd = -group.billableApplied
          const ledgerResult = await appendLedgerEntry(trx, {
            billingUserId,
            billingAccountId,
            currencyCode: WALLET_LEDGER_CURRENCY,
            amountXusd: postedAmountXusd,
            reason: 'consumption',
            idempotencyKey,
            sourceRef: `gate.settlement.${context.batchId}`,
            labels: {
              settlement_scope: `${context.scopeKind}:${context.scopeKey}`,
              settlement_batch_id: context.batchId,
            },
          })
          entryId = ledgerResult.entryId ?? null
        }

        if (group.onLedgerAllocationIds.length > 0) {
          await this.markSettled(trx, {
            allocationIds: group.onLedgerAllocationIds,
            entryId,
            entryRef: idempotencyKey,
            entryReason: entryId !== null ? 'consumption' : null,
            settledAt: context.now,
            copyAppliedAmount: entryId !== null,
          })
        }

        if (group.offLedgerAllocationIds.length > 0) {
          await this.markSettled(trx, {
            allocationIds: group.offLedgerAllocationIds,
            entryId: null,
            entryRef: null,
            entryReason: null,
            settledAt: context.now,
            copyAppliedAmount: false,
          })
        }

        settledCount += group.allocationIds.length
        totalPosted += postedAmountXusd
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.markError(trx, group.allocationIds, 'SETTLEMENT.LEDGER_FAIL', message, context.now)
        errors.push({ billingAccountId, reason: 'ledger_fail', details: message })
      }
    }

    return { settledCount, totalPosted, errors }
  }

  private groupByBillingUser(rows: ClaimedSettlementRow[]) {
    return rows.reduce(
      (acc, row) => {
        const applied = bigintFromUnknown(row.applied_amount_xusd) ?? 0n
        const bucket =
          acc.get(row.billing_user_id) ??
          ({
            billingUserId: row.billing_user_id,
            billingAccountId: row.billing_account_id,
            allocationIds: [] as string[],
            onLedgerAllocationIds: [] as string[],
            offLedgerAllocationIds: [] as string[],
            ratingIds: new Set<string>(),
            pricingFingerprints: new Set<string>(),
            totalApplied: 0n,
            billableApplied: 0n,
            promoApplied: 0n,
          } satisfies GroupedSettlement)

        bucket.allocationIds.push(row.allocation_id)
        bucket.ratingIds.add(row.rating_id)
        bucket.totalApplied += applied
        if (row.pricing_fingerprint) {
          bucket.pricingFingerprints.add(row.pricing_fingerprint)
        }

        if (this.isOnLedgerSettlement(row)) {
          bucket.onLedgerAllocationIds.push(row.allocation_id)
          bucket.billableApplied += applied
        } else {
          bucket.offLedgerAllocationIds.push(row.allocation_id)
          if (row.funding_kind === 'grant') {
            bucket.promoApplied += applied
          }
        }

        acc.set(row.billing_user_id, bucket)
        return acc
      },
      new Map<string, GroupedSettlement>(),
    )
  }

  private async markSettled(
    trx: Transaction<Database>,
    params: { allocationIds: string[]; entryId: string | null; entryRef: string | null; entryReason: string | null; settledAt: Date; copyAppliedAmount: boolean },
  ): Promise<void> {
    if (!params.allocationIds.length) return

    const rows = await trx
      .updateTable('billing_rating_allocations')
      .set({
        settlement_state: 'settled',
        entry_id: params.entryId,
        entry_ref: params.entryRef,
        entry_amount_xusd: params.copyAppliedAmount ? sql`applied_amount_xusd` : null,
        entry_reason: params.entryReason,
        settled_at: params.settledAt,
        error_code: null,
        error_message: null,
        decided_at: params.settledAt,
        updated_at: params.settledAt,
      })
      .where('allocation_id', 'in', params.allocationIds)
      .where('settlement_state', '=', 'settling')
      .returning(['allocation_id', 'grant_id', 'allocated_xusd', 'applied_amount_xusd', 'applied_cost_xusd'])
      .execute()

    for (const row of rows) {
      const grantId = row.grant_id === null ? null : String(row.grant_id)
      if (grantId === null) continue
      const allocated = bigintFromUnknown(row.allocated_xusd) ?? 0n
      const applied = bigintFromUnknown(row.applied_amount_xusd) ?? 0n
      const cost = bigintFromUnknown(row.applied_cost_xusd) ?? 0n
      const pendingDelta = allocated !== 0n ? -allocated : 0n
      await this.applyGrantAdjustments(
        trx,
        grantId,
        {
          pending: pendingDelta,
          posted: applied,
          cost,
        },
        params.settledAt,
      )
    }
  }

  private async markError(
    trx: Transaction<Database>,
    allocationIds: string[],
    code: string,
    message: string,
    now: Date,
  ): Promise<void> {
    if (!allocationIds.length) return

    const rows = await trx
      .updateTable('billing_rating_allocations')
      .set({
        settlement_state: 'error',
        error_code: code,
        error_message: message,
        entry_id: null,
        entry_ref: null,
        entry_amount_xusd: null,
        entry_reason: null,
        settled_at: null,
        updated_at: now,
      })
      .where('allocation_id', 'in', allocationIds)
      .where('settlement_state', '=', 'settling')
      .returning(['allocation_id', 'grant_id', 'allocated_xusd'])
      .execute()

    for (const row of rows) {
      const grantId = row.grant_id === null ? null : String(row.grant_id)
      if (grantId === null) continue
      const allocated = bigintFromUnknown(row.allocated_xusd) ?? 0n
      if (allocated === 0n) continue
      await this.applyGrantAdjustments(trx, grantId, { pending: -allocated }, now)
    }
  }

  private isOnLedgerSettlement(row: ClaimedSettlementRow): boolean {
    if (row.funding_kind !== 'grant') {
      return true
    }
    if (row.grant_ledger_id) {
      return true
    }
    if (row.grant_source_entry_id) {
      return true
    }
    return false
  }

  private makeSettlementKey(grantId: string | null, fundingKind: PendingSettlementAllocation['fundingKind'], allocSeq: number): string {
    const idPart = grantId === null ? 'null' : grantId
    return `${idPart}|${fundingKind}|${allocSeq}`
  }

  private async applyGrantAdjustments(
    dbOrTrx: Kysely<Database> | Transaction<Database>,
    grantId: string,
    deltas: { pending?: bigint; posted?: bigint; cost?: bigint },
    timestamp: Date,
  ): Promise<void> {
    let changed = false
    const set: Record<string, unknown> = {}

    if (deltas.pending !== undefined && deltas.pending !== 0n) {
      changed = true
      const delta = deltas.pending
      const abs = (delta >= 0n ? delta : -delta).toString()
      set.pending_reserved_xusd = delta >= 0n
        ? sql`ledger_grants.pending_reserved_xusd + ${abs}`
        : sql`greatest(ledger_grants.pending_reserved_xusd - ${abs}, 0)`
    }

    if (deltas.posted !== undefined && deltas.posted !== 0n) {
      changed = true
      const delta = deltas.posted
      const abs = (delta >= 0n ? delta : -delta).toString()
      set.posted_consumed_xusd = delta >= 0n
        ? sql`ledger_grants.posted_consumed_xusd + ${abs}`
        : sql`greatest(ledger_grants.posted_consumed_xusd - ${abs}, 0)`
    }

    if (deltas.cost !== undefined && deltas.cost !== 0n) {
      changed = true
      const delta = deltas.cost
      const abs = (delta >= 0n ? delta : -delta).toString()
      set.cost_xusd = delta >= 0n
        ? sql`ledger_grants.cost_xusd + ${abs}`
        : sql`greatest(ledger_grants.cost_xusd - ${abs}, 0)`
    }

    if (!changed) {
      return
    }

    set.updated_at = timestamp

    await dbOrTrx
      .updateTable('ledger_grants')
      .set(set)
      .where('grant_id', '=', grantId)
      .execute()
  }

  private distributeByWeight(total: bigint, weights: bigint[]): bigint[] {
    if (weights.length === 0) {
      return []
    }
    if (total === 0n) {
      return weights.map(() => 0n)
    }

    const positiveSum = weights.reduce((acc, weight) => (weight > 0n ? acc + weight : acc), 0n)

    if (positiveSum === 0n) {
      const count = BigInt(weights.length)
      const base = total / count
      let remainder = total - base * count
      return weights.map((_, index) => {
        if (index === weights.length - 1) {
          return base + remainder
        }
        if (remainder > 0n) {
          remainder -= 1n
          return base + 1n
        }
        return base
      })
    }

    let remainder = total
    return weights.map((weight, index) => {
      if (index === weights.length - 1) {
        return remainder
      }
      if (weight <= 0n) {
        return 0n
      }
      const portion = (total * weight) / positiveSum
      remainder -= portion
      return portion
    })
  }

  private buildIdempotencyKey(params: {
    scopeKind: string
    scopeKey: string
    batchId: string
    billingUserId: string
    billingAccountId: string
    pricingFingerprints: string[]
  }): string {
    const base = `scope:${params.scopeKind}:${params.scopeKey}:batch:${params.batchId}:ba:${params.billingAccountId}:bu:${params.billingUserId}`
    if (!params.pricingFingerprints.length) {
      return base
    }
    const sorted = params.pricingFingerprints.slice().sort()
    const hash = createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 16)
    return `${base}:pf:${hash}`
  }

  private normalizeTimestamp(value: Date | string): Date {
    if (value instanceof Date) {
      return value
    }
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('invalid timestamp provided to settlement service')
    }
    return parsed
  }

}
