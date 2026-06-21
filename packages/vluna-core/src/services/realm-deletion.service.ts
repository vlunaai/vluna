import { HttpException } from '@nestjs/common'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../types/database.js'
import { setRlsSession } from '../db/index.js'

export type RealmDeleteMode = 'soft' | 'hard'

type DatabaseHandle = Kysely<Database> | Transaction<Database>

type RealmDeleteResult = {
  realmId: string
  deleted: true
  mode: RealmDeleteMode
}

export function resolveRealmDeleteMode(env: NodeJS.ProcessEnv = process.env): RealmDeleteMode {
  const raw = String(env.VLUNA_REALM_DELETE_MODE || 'soft').trim().toLowerCase()
  if (raw !== 'soft' && raw !== 'hard') {
    throw new Error('VLUNA_REALM_DELETE_MODE must be "soft" or "hard"')
  }
  // if (raw === 'hard' && String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
  //   throw new Error('VLUNA_REALM_DELETE_MODE=hard is blocked in production')
  // }
  return raw
}

export async function cleanupRealmData(trx: DatabaseHandle, realmId: string): Promise<void> {
  const normalizedRealmId = normalizeRealmId(realmId)
  await setRlsSession(trx, { realmId: normalizedRealmId, isRealmAdmin: true })

  const billingAccounts = await trx
    .selectFrom('billing_accounts')
    .select('billing_account_id')
    .where('realm_id', '=', normalizedRealmId)
    .execute()
  const billingAccountIds = billingAccounts.map((row) => row.billing_account_id)
  const ratingRows = await trx
    .selectFrom('billing_ratings')
    .select('rating_id')
    .where('realm_id', '=', normalizedRealmId)
    .execute()
  const ratingIds = ratingRows.map((row) => row.rating_id)
  const allocationRows = await trx
    .selectFrom('billing_rating_allocations')
    .select('allocation_id')
    .where('realm_id', '=', normalizedRealmId)
    .execute()
  const allocationIds = allocationRows.map((row) => row.allocation_id)
  const invoiceRows = await trx
    .selectFrom('billing_invoices')
    .select('billing_invoice_id')
    .where('realm_id', '=', normalizedRealmId)
    .execute()
  const invoiceIds = invoiceRows.map((row) => row.billing_invoice_id)
  const paymentRows = await trx
    .selectFrom('billing_payments')
    .select('billing_payment_id')
    .where('realm_id', '=', normalizedRealmId)
    .execute()
  const paymentIds = paymentRows.map((row) => row.billing_payment_id)
  const assignmentRows = billingAccountIds.length > 0
    ? await trx
      .selectFrom('grant_assignments')
      .select('assignment_id')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    : []
  const assignmentIds = assignmentRows.map((row) => row.assignment_id)

  await trx.deleteFrom('idempotency_envelopes').where('realm_id', '=', normalizedRealmId).execute()
  if (billingAccountIds.length > 0) {
    await trx
      .deleteFrom('idempotency_envelopes')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
  }

  if (invoiceIds.length > 0) {
    await trx
      .deleteFrom('billing_invoice_allocations')
      .where('billing_invoice_id', 'in', invoiceIds)
      .execute()
    await trx
      .deleteFrom('billing_invoice_lines')
      .where('billing_invoice_id', 'in', invoiceIds)
      .execute()
  }
  if (allocationIds.length > 0) {
    await trx
      .deleteFrom('billing_invoice_allocations')
      .where('allocation_id', 'in', allocationIds)
      .execute()
  }
  if (paymentIds.length > 0) {
    await trx
      .deleteFrom('billing_payment_refunds')
      .where('billing_payment_id', 'in', paymentIds)
      .execute()
  }
  if (ratingIds.length > 0) {
    await trx
      .deleteFrom('billing_event_ratings')
      .where('rating_id', 'in', ratingIds)
      .execute()
    await trx
      .deleteFrom('billing_ratings_aggregation_runs')
      .where('rating_id', 'in', ratingIds)
      .execute()
    await trx
      .deleteFrom('billing_rated_records')
      .where('rating_id', 'in', ratingIds)
      .execute()
    await trx
      .deleteFrom('billing_rating_labels')
      .where('rating_id', 'in', ratingIds)
      .execute()
    await trx
      .deleteFrom('billing_rating_allocations')
      .where('rating_id', 'in', ratingIds)
      .execute()
    await trx
      .deleteFrom('billing_ratings')
      .where('rating_id', 'in', ratingIds)
      .execute()
  }
  if (assignmentIds.length > 0) {
    await trx
      .deleteFrom('ledger_grants')
      .where('assignment_id', 'in', assignmentIds)
      .execute()
  }
  if (billingAccountIds.length > 0) {
    await trx
      .deleteFrom('billing_event_processing')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('billing_events')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('billing_payments')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('billing_invoice_adjustments')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('billing_invoices')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('billing_period_closeouts')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('billing_periods')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('provider_events')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('reconciliations')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('provider_state_snapshots')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('provider_customers')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('gate_leases')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('gate_quota_counters')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('gate_residual_buckets')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('ledger_grants')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('grant_assignments')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('billing_plan_assignments')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('subscriptions')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('budgets')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
    await trx
      .deleteFrom('billing_account_billing_details')
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()
  }

  await trx.deleteFrom('billing_accounts').where('realm_id', '=', normalizedRealmId).execute()

  // Then clear remaining realm-scoped configuration and policy state.
  await trx.deleteFrom('event_rating_policies').where('realm_id', '=', normalizedRealmId).execute()
  await trx.deleteFrom('grant_campaigns').where('realm_id', '=', normalizedRealmId).execute()
  await trx.deleteFrom('grant_programs').where('realm_id', '=', normalizedRealmId).execute()
  await trx.deleteFrom('billing_plans').where('realm_id', '=', normalizedRealmId).execute()
  await trx.deleteFrom('catalog_products').where('realm_id', '=', normalizedRealmId).execute()
  await trx.deleteFrom('meter_prices').where('realm_id', '=', normalizedRealmId).execute()
  await trx.deleteFrom('feature_meters').where('feature_id', 'in', trx.selectFrom('features').select('feature_id').where('realm_id', '=', normalizedRealmId)).execute()
  await trx.deleteFrom('features').where('realm_id', '=', normalizedRealmId).execute()
  await trx.deleteFrom('feature_families').where('realm_id', '=', normalizedRealmId).execute()
  await trx.deleteFrom('meters').where('realm_id', '=', normalizedRealmId).execute()
  await trx.deleteFrom('gate_policy_bundles').where('realm_id', '=', normalizedRealmId).execute()
}

export async function deleteRealm(
  trx: DatabaseHandle,
  params: { realmId: string; mode?: RealmDeleteMode },
): Promise<RealmDeleteResult> {
  const normalizedRealmId = normalizeRealmId(params.realmId)
  const mode = params.mode ?? resolveRealmDeleteMode()

  await cleanupRealmData(trx, normalizedRealmId)
  await cleanupRealmAccessArtifacts(trx, normalizedRealmId)

  if (mode === 'hard') {
    await trx.deleteFrom('realms').where('realm_id', '=', normalizedRealmId).executeTakeFirst()
  } else {
    await trx
      .updateTable('realms')
      .set({
        status: 'deleted',
        updated_at: new Date(),
      })
      .where('realm_id', '=', normalizedRealmId)
      .executeTakeFirst()
  }

  return {
    realmId: normalizedRealmId,
    deleted: true,
    mode,
  }
}

async function cleanupRealmAccessArtifacts(trx: DatabaseHandle, realmId: string): Promise<void> {
  await setRlsSession(trx, { realmId, isRealmAdmin: true })

  await trx.deleteFrom('audit_logs').where('realm_id', '=', realmId).execute()
  await trx.deleteFrom('cloud_realm_members').where('realm_id', '=', realmId).execute()

  await pruneRealmFromServiceApiKeys(trx, realmId)
  await pruneRealmFromDatBootstrapTokens(trx, realmId)
}

async function pruneRealmFromServiceApiKeys(trx: DatabaseHandle, realmId: string): Promise<void> {
  const rows = await trx.selectFrom('service_api_keys').select(['key_id', 'allowed_realms']).execute()
  for (const row of rows) {
    const allowedRealms = (row.allowed_realms ?? []).filter((value) => value !== realmId)
    if (allowedRealms.length === (row.allowed_realms ?? []).length) continue
    if (allowedRealms.length === 0) {
      await trx.deleteFrom('service_api_keys').where('key_id', '=', row.key_id).executeTakeFirst()
      continue
    }
    await trx
      .updateTable('service_api_keys')
      .set({ allowed_realms: allowedRealms })
      .where('key_id', '=', row.key_id)
      .executeTakeFirst()
  }
}

async function pruneRealmFromDatBootstrapTokens(trx: DatabaseHandle, realmId: string): Promise<void> {
  const rows = await trx.selectFrom('dat_bootstrap_tokens').select(['token_id', 'allowed_realms']).execute()
  for (const row of rows) {
    const current = Array.isArray(row.allowed_realms) ? row.allowed_realms : []
    const allowedRealms = current.filter((value) => value !== realmId)
    if (allowedRealms.length === current.length) continue
    if (allowedRealms.length === 0) {
      await trx.deleteFrom('dat_bootstrap_tokens').where('token_id', '=', row.token_id).executeTakeFirst()
      continue
    }
    await trx
      .updateTable('dat_bootstrap_tokens')
      .set({ allowed_realms: allowedRealms })
      .where('token_id', '=', row.token_id)
      .executeTakeFirst()
  }
}

function normalizeRealmId(realmId: string): string {
  const normalizedRealmId = String(realmId || '').trim()
  if (!normalizedRealmId) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'realmId is required' }, 422)
  }
  return normalizedRealmId
}
