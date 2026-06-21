import { sql, type Kysely } from 'kysely'
import type { Database } from '../types/database.js'

type LedgerEntryReason = 'adjustment' | 'purchase' | 'consumption' | 'transfer' | 'refund' | 'reversal'

type AppendLedgerEntryParams = {
  billingUserId: string
  billingAccountId: string
  currencyCode: string
  amountXusd: bigint
  reason: LedgerEntryReason
  idempotencyKey: string
  sourceRef?: string | null
  labels?: Record<string, string>
}

export type LedgerSummary = {
  ledger_id: string
  balance_xusd: string
}

type AppendLedgerEntryResult = {
  inserted: boolean
  ledgerId: string
  entryId?: string
}

export async function appendLedgerEntry(
  trx: Kysely<Database>,
  params: AppendLedgerEntryParams,
): Promise<AppendLedgerEntryResult> {
  if (params.amountXusd === 0n) {
    const ledger = await getOrCreateLedgerAccount(trx, params.billingUserId, params.billingAccountId, params.currencyCode)
    return { inserted: false, ledgerId: ledger.ledger_id }
  }

  const ledger = await getOrCreateLedgerAccount(trx, params.billingUserId, params.billingAccountId, params.currencyCode)
  const amountText = params.amountXusd.toString()

  const inserted = await trx
    .insertInto('ledger_entries')
    .values({
      ledger_id: ledger.ledger_id,
      billing_user_id: ledger.billing_user_id,
      billing_account_id: ledger.billing_account_id,
      amount_xusd: amountText,
      reason: params.reason,
      idempotency_key: params.idempotencyKey,
      source_ref: params.sourceRef ?? null,
      econ_component_kind: 'charge',
      component_version: 1,
    })
    .onConflict((oc) => oc.columns(['ledger_id', 'idempotency_key']).doNothing())
    .returning(['entry_id'])
    .executeTakeFirst()

  if (!inserted) {
    return { inserted: false, ledgerId: ledger.ledger_id }
  }

  await trx
    .updateTable('ledger_accounts')
    .set({
      balance_xusd: sql`ledger_accounts.balance_xusd + ${amountText}`,
      updated_at: new Date(),
    })
    .where('ledger_id', '=', ledger.ledger_id)
    .execute()

  if (params.labels && Object.keys(params.labels).length > 0) {
    const labelRows = Object.entries(params.labels)
      .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
      .map(([key, value]) => ({
        entry_id: inserted.entry_id,
        label_key: key,
        value_text: value.trim(),
      }))

    if (labelRows.length > 0) {
      await trx
        .insertInto('ledger_entry_labels')
        .values(labelRows)
        .onConflict((oc) => oc.columns(['entry_id', 'label_key']).doNothing())
        .execute()
    }
  }

  return { inserted: true, ledgerId: ledger.ledger_id, entryId: inserted.entry_id }
}

export async function getOrCreateLedgerAccount(
  trx: Kysely<Database>,
  billingUserId: string,
  billingAccountId: string,
  currencyCode: string,
) {
  await trx
    .insertInto('ledger_accounts')
    .values({
      billing_user_id: billingUserId,
      billing_account_id: billingAccountId,
      currency_code: currencyCode,
      balance_xusd: '0',
    })
    .onConflict((oc) => oc.columns(['billing_user_id', 'currency_code']).doNothing())
    .execute()

  const ledger = await trx
    .selectFrom('ledger_accounts')
    .select(['ledger_id', 'billing_user_id', 'billing_account_id', 'balance_xusd'])
    .where('billing_user_id', '=', billingUserId)
    .where('billing_account_id', '=', billingAccountId)
    .where('currency_code', '=', currencyCode)
    .executeTakeFirst()

  if (!ledger) {
    throw new Error('credit ledger unavailable')
  }

  return ledger
}
