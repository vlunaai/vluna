import { Injectable } from '@nestjs/common'
import { type Kysely, type Transaction } from 'kysely'
import type { Database } from '../types/database.js'
import { bigintFromUnknown } from '../features/gate/services/gate.utils.js'

export type GrantBalance = {
  grantId: string
  amountXusd: bigint
  pendingReservedXusd: bigint
  postedConsumedXusd: bigint
  remainingXusd: bigint
  availableXusd: bigint
  windowStart: Date | null
  windowEnd: Date | null
  priority: number
  kind: string
  ledgerId: string | null
  metadata: Record<string, unknown>
}

export type AccountGrantBalances = {
  asOf: Date
  totals: {
    amountXusd: bigint
    pendingReservedXusd: bigint
    postedConsumedXusd: bigint
    remainingXusd: bigint
    availableXusd: bigint
  }
  grants: GrantBalance[]
}

type BalanceQueryOptions = {
  billingUserId: string
  billingAccountId: string
  asOf?: Date
  includeExpired?: boolean
  includeSuspended?: boolean
  lock?: 'for_update' | 'for_update_skip_locked'
}

@Injectable()
export class GrantBalanceService {
  async getAccountGrantBalances(
    dbOrTrx: Kysely<Database> | Transaction<Database>,
    options: BalanceQueryOptions,
  ): Promise<AccountGrantBalances> {
    const asOf = options.asOf ?? new Date()
    const includeExpired = options.includeExpired ?? false
    const includeSuspended = options.includeSuspended ?? false

    let query = dbOrTrx
      .selectFrom('ledger_grants as g')
      .select([
        'g.grant_id as grant_id',
        'g.amount_xusd as amount_xusd',
        'g.pending_reserved_xusd as pending_reserved_xusd',
        'g.posted_consumed_xusd as posted_consumed_xusd',
        'g.window_start as window_start',
        'g.window_end as window_end',
        'g.priority as priority',
        'g.kind as kind',
        'g.ledger_id as ledger_id',
        'g.metadata as metadata',
      ])
      .where('g.billing_user_id', '=', options.billingUserId)
      .where('g.billing_account_id', '=', options.billingAccountId)
      .where('g.issuance_status', 'in', includeSuspended ? ['ready', 'active', 'suspended'] : ['ready', 'active'])

    if (!includeExpired) {
      query = query
        .where((eb) =>
          eb.or([
            eb('g.window_start', 'is', null),
            eb('g.window_start', '<=', asOf),
          ]),
        )
        .where((eb) =>
          eb.or([
            eb('g.window_end', 'is', null),
            eb('g.window_end', '>', asOf),
          ]),
        )
    }

    if (options.lock === 'for_update' || options.lock === 'for_update_skip_locked') {
      query = query.forUpdate()
      if (options.lock === 'for_update_skip_locked') {
        query = query.skipLocked()
      }
    }

    const rows = await query
      .orderBy('g.window_end', 'asc')
      .orderBy('g.priority', 'desc')
      .orderBy('g.grant_id', 'asc')
      .execute()

    const grants: GrantBalance[] = []
    let totalAmount = 0n
    let totalPending = 0n
    let totalPosted = 0n
    let totalRemaining = 0n
    let totalAvailable = 0n

    for (const row of rows) {
      const windowStart = row.window_start instanceof Date
        ? row.window_start
        : row.window_start
          ? new Date(row.window_start)
          : null
      const windowEnd = row.window_end instanceof Date
        ? row.window_end
        : row.window_end
          ? new Date(row.window_end)
          : null
      const priority = typeof row.priority === 'number' ? row.priority : Number(row.priority ?? 0)
      const amount = bigintFromUnknown(row.amount_xusd) ?? 0n
      const pending = bigintFromUnknown(row.pending_reserved_xusd) ?? 0n
      const posted = bigintFromUnknown(row.posted_consumed_xusd) ?? 0n
      const remaining = amount - posted - pending
      const available = remaining > 0n ? remaining : 0n

      grants.push({
        grantId: String(row.grant_id),
        amountXusd: amount,
        pendingReservedXusd: pending,
        postedConsumedXusd: posted,
        remainingXusd: remaining,
        availableXusd: available,
        windowStart,
        windowEnd,
        priority,
        kind: row.kind ?? 'grant',
        ledgerId: row.ledger_id ?? null,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
      })

      totalAmount += amount
      totalPending += pending
      totalPosted += posted
      totalRemaining += remaining
      totalAvailable += available
    }

    grants.sort((a, b) => {
      const aEnd = a.windowEnd ? a.windowEnd.getTime() : Number.POSITIVE_INFINITY
      const bEnd = b.windowEnd ? b.windowEnd.getTime() : Number.POSITIVE_INFINITY
      if (aEnd !== bEnd) return aEnd - bEnd
      if (a.priority !== b.priority) return b.priority - a.priority
      return a.grantId.localeCompare(b.grantId)
    })

    return {
      asOf,
      totals: {
        amountXusd: totalAmount,
        pendingReservedXusd: totalPending,
        postedConsumedXusd: totalPosted,
        remainingXusd: totalRemaining,
        availableXusd: totalAvailable,
      },
      grants,
    }
  }
}
