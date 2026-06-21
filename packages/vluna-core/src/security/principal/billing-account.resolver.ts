import { HttpException } from '@nestjs/common'
import { db, pool } from '../../db/index.js'
import { provisionBillingUser } from '../../services/billing-user-provisioning.js'

export interface BillingAccountResolution {
  realmId: string
  billingAccountId: string
  billingPrincipalId?: string
  metadata?: Record<string, unknown>
}

export interface BillingAccountParams {
  realmId: string
  principalId: string
  autoCreate?: boolean
  ctx?: { billingAccountId?: string; billingAccount?: BillingAccountResolution } & Record<string, unknown>
}

export interface BillingUserResolution {
  realmId: string
  billingUserId: string
  billingAccountId: string
  businessUserId: string
  status?: 'active' | 'disabled' | 'deleted'
  metadata?: Record<string, unknown>
}

export interface BillingUserParams {
  realmId: string
  billingAccountId: string
  userId: string
  autoCreate?: boolean
  ctx?: {
    billingUserId?: string
    billingUser?: BillingUserResolution
    businessUserId?: string
  } & Record<string, unknown>
}


const AUTOCREATE_ENABLED = (() => {
  const flag = (process.env.VLUNA_NO_AUTOCREATE_BILLING_ACCOUNT || '').toLowerCase()
  if (flag === 'true' || flag === '1') return false
  return true
})()

export async function ensureBillingAccount(params: BillingAccountParams): Promise<BillingAccountResolution | null> {
  const realmId = params.realmId.trim()
  const principalId = params.principalId.trim()
  if (!realmId) throw new HttpException('missing_realm', 400)
  if (!principalId) throw new HttpException('missing_principal', 401)

  const sql = `
    select billing_account_id, realm_id, billing_principal_id, metadata
    from billing_accounts
    where realm_id = $1
      and billing_principal_id = $2
  limit 1
  ` as const

  const out = await pool.query(sql, [realmId, principalId])
  const row = out?.rows?.[0]
  if (row?.billing_account_id) {
    const resolution: BillingAccountResolution = {
      realmId,
      billingAccountId: String(row.billing_account_id),
      billingPrincipalId: String(row.billing_principal_id),
      metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    }
    if (params.ctx) {
      params.ctx.billingAccountId = resolution.billingAccountId
      params.ctx.billingAccount = resolution
    }
    return resolution
  }

  const shouldAutocreate = params.autoCreate ?? AUTOCREATE_ENABLED
  if (!shouldAutocreate) {
    return null
  }

  const upsertSql = `
    insert into billing_accounts (realm_id, billing_principal_id)
    values ($1, $2)
    on conflict (realm_id, billing_principal_id)
    do update set billing_principal_id = excluded.billing_principal_id
    returning billing_account_id, realm_id, billing_principal_id, metadata
  ` as const
  const upserted = await pool.query(upsertSql, [realmId, principalId])
  const createdRow = upserted?.rows?.[0]
  if (createdRow?.billing_account_id) {
    const billingAccountId = String(createdRow.billing_account_id)
    await pool.query(
      `
      insert into billing_account_billing_details (billing_account_id)
      values ($1)
      on conflict (billing_account_id) do nothing
      `,
      [billingAccountId],
    )
    const resolution: BillingAccountResolution = {
      realmId,
      billingAccountId,
      billingPrincipalId: String(createdRow.billing_principal_id),
      metadata: (createdRow.metadata as Record<string, unknown> | null) ?? undefined,
    }
    if (params.ctx) {
      params.ctx.billingAccountId = resolution.billingAccountId
      params.ctx.billingAccount = resolution
    }
    return resolution
  }

  // Fallback (should not happen): re-read to avoid returning null on concurrent race
  const reread = await pool.query(sql, [realmId, principalId])
  const existing = reread?.rows?.[0]
  if (existing?.billing_account_id) {
    const resolution: BillingAccountResolution = {
      realmId,
      billingAccountId: String(existing.billing_account_id),
      billingPrincipalId: String(existing.billing_principal_id),
      metadata: (existing.metadata as Record<string, unknown> | null) ?? undefined,
    }
    if (params.ctx) {
      params.ctx.billingAccountId = resolution.billingAccountId
      params.ctx.billingAccount = resolution
    }
    return resolution
  }
  return null
}

export async function ensureBillingUser(params: BillingUserParams): Promise<BillingUserResolution | null> {
  const realmId = params.realmId.trim()
  const billingAccountId = params.billingAccountId.trim()
  const userId = params.userId.trim()
  if (!realmId) throw new HttpException('missing_realm', 400)
  if (!billingAccountId) throw new HttpException('missing_billing_account', 401)
  if (!userId) throw new HttpException('missing_user_id', 401)

  const sql = `
    select billing_user_id, realm_id, billing_account_id, business_user_id, status, metadata
    from billing_users
    where realm_id = $1
      and billing_account_id = $2
      and business_user_id = $3
    limit 1
  ` as const

  const out = await pool.query(sql, [realmId, billingAccountId, userId])
  const row = out?.rows?.[0]
  if (row?.billing_user_id) {
    const resolution: BillingUserResolution = {
      realmId,
      billingUserId: String(row.billing_user_id),
      billingAccountId: String(row.billing_account_id),
      businessUserId: String(row.business_user_id),
      status: row.status as BillingUserResolution['status'],
      metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    }
    if (params.ctx) {
      params.ctx.billingUserId = resolution.billingUserId
      params.ctx.billingUser = resolution
      params.ctx.businessUserId = resolution.businessUserId
    }
    return resolution
  }

  const shouldAutocreate = params.autoCreate ?? AUTOCREATE_ENABLED
  if (!shouldAutocreate) {
    return null
  }

  const createdRow = await provisionBillingUser(db(), {
    realmId,
    billingAccountId,
    businessUserId: userId,
    metadata: {},
    reactivateExisting: false,
    source: 'runtime.auto_create',
  })
  if (createdRow?.billing_user_id) {
    const resolution: BillingUserResolution = {
      realmId,
      billingUserId: String(createdRow.billing_user_id),
      billingAccountId: String(createdRow.billing_account_id),
      businessUserId: String(createdRow.business_user_id),
      status: createdRow.status as BillingUserResolution['status'],
      metadata: (createdRow.metadata as Record<string, unknown> | null) ?? undefined,
    }
    if (params.ctx) {
      params.ctx.billingUserId = resolution.billingUserId
      params.ctx.billingUser = resolution
      params.ctx.businessUserId = resolution.businessUserId
    }
    return resolution
  }

  const reread = await pool.query(sql, [realmId, billingAccountId, userId])
  const existing = reread?.rows?.[0]
  if (existing?.billing_user_id) {
    const resolution: BillingUserResolution = {
      realmId,
      billingUserId: String(existing.billing_user_id),
      billingAccountId: String(existing.billing_account_id),
      businessUserId: String(existing.business_user_id),
      status: existing.status as BillingUserResolution['status'],
      metadata: (existing.metadata as Record<string, unknown> | null) ?? undefined,
    }
    if (params.ctx) {
      params.ctx.billingUserId = resolution.billingUserId
      params.ctx.billingUser = resolution
      params.ctx.businessUserId = resolution.businessUserId
    }
    return resolution
  }
  return null
}
