import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../types/database.js'
import { isTransaction } from '../features/gate/services/gate.utils.js'
import { BillingPeriodService } from './billing-period.service.js'
import { ensureFallbackGrantForPeriod } from './grant-issuance.service.js'
import { setRlsSession } from '../db/index.js'

type DbOrTrx = Kysely<Database> | Transaction<Database>

function bigintFromDb(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  if (typeof value === 'string' && value.trim()) return BigInt(value)
  return 0n
}

type BillingMode = 'prepaid' | 'postpaid' | 'hybrid'

function readBillingModeFromPeriodMetadata(metadata: unknown): BillingMode {
  if (!metadata || typeof metadata !== 'object') return 'prepaid'
  const rule = (metadata as Record<string, unknown>).rule
  if (!rule || typeof rule !== 'object') return 'prepaid'
  const raw = (rule as Record<string, unknown>).billing_mode
  const v = typeof raw === 'string' ? raw.trim() : ''
  return v === 'postpaid' || v === 'hybrid' ? v : 'prepaid'
}

export class OverageCloseoutService {
  private readonly billingPeriodService = new BillingPeriodService()

  async closeoutWaiveForBillingPeriodId(
    dbOrTrx: DbOrTrx,
    params: { billingPeriodId: string; now?: Date; reason?: string },
  ): Promise<{ ok: boolean; skipped?: string }> {
    if (!isTransaction(dbOrTrx)) {
      return dbOrTrx.transaction().execute((trx) => this.closeoutWaiveForBillingPeriodId(trx, params))
    }
    const trx = dbOrTrx

    const now = params.now ?? new Date()

    const period = await trx
      .selectFrom('billing_periods')
      .select(['billing_period_id', 'realm_id', 'billing_account_id', 'status', 'period_start', 'period_end', 'metadata'])
      .where('billing_period_id', '=', params.billingPeriodId)
      .executeTakeFirst()
    if (!period) return { ok: false, skipped: 'period_not_found' }

    await setRlsSession(trx, {
      realmId: String(period.realm_id),
      billingAccountId: String(period.billing_account_id),
      isRealmAdmin: true,
    })

    await this.billingPeriodService.freezeIfDue(trx, { billingPeriodId: String(period.billing_period_id), now })

    const refreshed = await trx
      .selectFrom('billing_periods')
      .select(['status', 'period_start', 'period_end', 'metadata'])
      .where('billing_period_id', '=', params.billingPeriodId)
      .executeTakeFirstOrThrow()

    if (refreshed.status !== 'frozen') {
      return { ok: false, skipped: 'period_not_frozen' }
    }

    const billingMode = readBillingModeFromPeriodMetadata(refreshed.metadata)
    if (billingMode !== 'prepaid') {
      return { ok: false, skipped: `billing_mode_${billingMode}` }
    }

    const fallbackGrantIds = await ensureFallbackGrantIdsForPeriod(trx, {
      realmId: String(period.realm_id),
      billingAccountId: String(period.billing_account_id),
      periodStart: refreshed.period_start,
      periodEnd: refreshed.period_end,
    })
    const overageGrantId = fallbackGrantIds.length === 1 ? fallbackGrantIds[0] ?? null : null

    const totals = fallbackGrantIds.length > 0
      ? await trx
          .selectFrom('billing_rating_allocations')
          .select([
            sql`count(*)`.as('allocation_count'),
            sql`coalesce(sum(applied_amount_xusd), 0)`.as('totals_xusd'),
          ])
          .where('billing_account_id', '=', String(period.billing_account_id))
          .where('rated_at', '>=', refreshed.period_start)
          .where('rated_at', '<', refreshed.period_end)
          .where('grant_id', 'in', fallbackGrantIds)
          .where('direction', '=', 'debit')
          .where('settlement_state', '=', 'settled')
          .where('application_status', 'in', ['applied', 'applied_clipped'])
          .where('reversal_of_allocation_id', 'is', null)
          .executeTakeFirstOrThrow()
      : { allocation_count: 0, totals_xusd: '0' }

    const allocationCount = Number(totals.allocation_count ?? 0)
    const totalsXusd = bigintFromDb(totals.totals_xusd)

    await trx
      .insertInto('billing_period_closeouts')
      .values({
        realm_id: String(period.realm_id),
        billing_account_id: String(period.billing_account_id),
        billing_period_id: String(period.billing_period_id),
        mode: 'waive',
        status: 'completed',
        overage_grant_id: overageGrantId,
        totals_xusd: totalsXusd.toString(),
        allocation_count: allocationCount,
        started_at: now,
        completed_at: now,
        metadata: {
          reason: params.reason ?? 'subsidy',
          billing_period_id: String(period.billing_period_id),
          fallback_grant_ids: fallbackGrantIds,
        },
      })
      .onConflict((oc) =>
        oc.columns(['billing_period_id', 'mode']).doUpdateSet({
          status: 'completed',
          overage_grant_id: overageGrantId,
          totals_xusd: totalsXusd.toString(),
          allocation_count: allocationCount,
          completed_at: now,
          updated_at: now,
        }),
      )
      .execute()

    if (fallbackGrantIds.length > 0) {
      await trx
        .updateTable('ledger_grants')
        .set({
          issuance_status: 'closed',
          closure_kind: 'none',
          closed_at: now,
          updated_at: now,
        })
        .where('grant_id', 'in', fallbackGrantIds)
        .execute()
    }

    return { ok: true }
  }
}

async function ensureFallbackGrantIdsForPeriod(
  trx: Transaction<Database>,
  params: { realmId: string; billingAccountId: string; periodStart: Date; periodEnd: Date },
): Promise<string[]> {
  const billingUsers = await trx
    .selectFrom('billing_users')
    .select(['billing_user_id'])
    .where('billing_account_id', '=', params.billingAccountId)
    .where('status', '=', 'active')
    .execute()

  const grantIds: string[] = []
  for (const row of billingUsers) {
    grantIds.push(await ensureFallbackGrantForPeriod(trx, {
      realmId: params.realmId,
      billingUserId: String(row.billing_user_id),
      billingAccountId: params.billingAccountId,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
    }))
  }
  return grantIds
}
