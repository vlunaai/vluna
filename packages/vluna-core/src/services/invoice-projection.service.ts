import { Inject, Injectable } from '@nestjs/common'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../types/database.js'
import { BillingPeriodService } from './billing-period.service.js'
import { ensureFallbackGrantForPeriod } from './grant-issuance.service.js'
import { isTransaction } from '../features/gate/services/gate.utils.js'
import { generateInvoiceNumber } from './invoice-number.js'
import { setRlsSession } from '../db/index.js'

type DbOrTrx = Kysely<Database> | Transaction<Database>

const USD_CENT_IN_XUSD = 10_000n

function bigintFromDb(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  if (typeof value === 'string' && value.trim()) return BigInt(value)
  return 0n
}

function roundToMinor(xusd: bigint, rounding: 'floor' | 'nearest' | 'ceil'): bigint {
  if (USD_CENT_IN_XUSD <= 0n) return 0n
  if (rounding === 'floor') return xusd / USD_CENT_IN_XUSD
  if (rounding === 'ceil') return (xusd + (USD_CENT_IN_XUSD - 1n)) / USD_CENT_IN_XUSD
  return (xusd + (USD_CENT_IN_XUSD / 2n)) / USD_CENT_IN_XUSD
}

@Injectable()
export class InvoiceProjectionService {
  constructor(@Inject(BillingPeriodService) private readonly billingPeriodService: BillingPeriodService) {}

  async createInvoiceProposalForBillingPeriodId(
    dbOrTrx: DbOrTrx,
    params: { billingPeriodId: string; at?: Date },
  ): Promise<{ billingInvoiceId: string }> {
    if (!isTransaction(dbOrTrx)) {
      return dbOrTrx.transaction().execute((trx) => this.createInvoiceProposalForBillingPeriodId(trx, params))
    }
    const trx = dbOrTrx

    const at = params.at ?? new Date()

    await this.billingPeriodService.freezeIfDue(trx, { billingPeriodId: params.billingPeriodId, now: at })

    const period = await trx
      .selectFrom('billing_periods')
      .select(['billing_period_id', 'realm_id', 'billing_account_id', 'status', 'period_start', 'period_end'])
      .where('billing_period_id', '=', params.billingPeriodId)
      .executeTakeFirst()

    if (!period) {
      throw new Error('billing period not found')
    }

    if (period.status !== 'frozen') {
      throw new Error('billing period is not frozen; refuse to project invoice proposal')
    }

    await setRlsSession(trx, {
      realmId: String(period.realm_id),
      billingAccountId: String(period.billing_account_id),
      isRealmAdmin: true,
    })

    const fallbackGrantIds = await ensureFallbackGrantIdsForPeriod(trx, {
      realmId: String(period.realm_id),
      billingAccountId: String(period.billing_account_id),
      periodStart: period.period_start,
      periodEnd: period.period_end,
    })

    const allocations = fallbackGrantIds.length > 0
      ? await trx
          .selectFrom('billing_rating_allocations')
          .select([
            'allocation_id',
            'feature_code',
            'applied_amount_xusd',
          ])
          .where('billing_account_id', '=', String(period.billing_account_id))
          .where('rated_at', '>=', period.period_start)
          .where('rated_at', '<', period.period_end)
          .where('grant_id', 'in', fallbackGrantIds)
          .where('direction', '=', 'debit')
          .where('settlement_state', '=', 'settled')
          .where('application_status', 'in', ['applied', 'applied_clipped'])
          .where('reversal_of_allocation_id', 'is', null)
          .execute()
      : []

    const byFeature = new Map<string, bigint>()
    let totalXusd = 0n
    for (const a of allocations) {
      const applied = bigintFromDb(a.applied_amount_xusd)
      if (applied <= 0n) continue
      totalXusd += applied
      const key = String(a.feature_code)
      byFeature.set(key, (byFeature.get(key) ?? 0n) + applied)
    }

    const rounding: 'floor' | 'nearest' | 'ceil' = 'nearest'
    const subtotalMinor = roundToMinor(totalXusd, rounding)

    const invoiceNumber = generateInvoiceNumber({ billingPeriodId: String(period.billing_period_id) })

    const invoice = await trx
      .insertInto('billing_invoices')
      .values({
        realm_id: String(period.realm_id),
        billing_account_id: String(period.billing_account_id),
        billing_period_id: String(period.billing_period_id),
        invoice_number: invoiceNumber,
        provider: null,
        provider_invoice_id: null,
        provider_subscription_id: null,
        provider_customer_id: null,
        currency: 'USD',
        subtotal_minor: subtotalMinor.toString(),
        tax_minor: '0',
        total_minor: subtotalMinor.toString(),
        status: 'draft',
        period_start: period.period_start,
        period_end: period.period_end,
        due_at: null,
        finalized_at: null,
        paid_at: null,
        canceled_at: null,
        hosted_invoice_url: null,
        metadata: {
          conversion: {
            as_of: at.toISOString(),
            usd_per_xusd: '0.000001',
            minor_unit: 2,
            rounding,
          },
          scope: {
            fallback_grant_ids: fallbackGrantIds,
          },
        },
        raw_provider_payload: {},
      })
      .onConflict((oc) =>
        oc.columns(['realm_id', 'invoice_number']).doUpdateSet({
          updated_at: sql`now()`,
        }),
      )
      .returning(['billing_invoice_id'])
      .executeTakeFirstOrThrow()

    const billingInvoiceId = String(invoice.billing_invoice_id)

    for (const [featureCode, amountXusd] of byFeature.entries()) {
      const lineAmountMinor = roundToMinor(amountXusd, rounding)
      await trx
        .insertInto('billing_invoice_lines')
        .values({
          billing_invoice_id: billingInvoiceId,
          line_kind: 'usage',
          description: featureCode,
          quantity: '1',
          unit_amount_minor: lineAmountMinor.toString(),
          total_amount_minor: lineAmountMinor.toString(),
          catalog_price_id: null,
          meter_code: null,
          metadata: {
            amount_xusd: amountXusd.toString(),
            feature_code: featureCode,
          },
        })
        .execute()
    }

    for (const a of allocations) {
      const amountXusd = bigintFromDb(a.applied_amount_xusd)
      const amountMinor = roundToMinor(amountXusd, rounding)
      await trx
        .insertInto('billing_invoice_allocations')
        .values({
          billing_invoice_id: billingInvoiceId,
          allocation_id: String(a.allocation_id),
          amount_xusd: amountXusd.toString(),
          amount_minor: amountMinor.toString(),
          currency: 'USD',
        })
        .onConflict((oc) => oc.column('allocation_id').doNothing())
        .execute()
    }

    return { billingInvoiceId }
  }

  async createInvoiceProposalForPeriod(
    dbOrTrx: DbOrTrx,
    params: { realmId: string; billingAccountId: string; at: Date },
  ): Promise<{ billingInvoiceId: string }> {
    if (!isTransaction(dbOrTrx)) {
      return dbOrTrx.transaction().execute((trx) => this.createInvoiceProposalForPeriod(trx, params))
    }
    const trx = dbOrTrx

    const period = await this.billingPeriodService.ensureBillingPeriodInstance(trx, {
      realmId: params.realmId,
      billingAccountId: params.billingAccountId,
      at: params.at,
    })

    return this.createInvoiceProposalForBillingPeriodId(trx, { billingPeriodId: period.billingPeriodId, at: params.at })
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
