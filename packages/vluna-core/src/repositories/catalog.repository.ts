import type { Kysely, Selectable } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../types/database.js'

type ProductTable = Selectable<Database['catalog_products']>
type PriceTable = Selectable<Database['catalog_prices']>

export type ProductRow = Pick<
  ProductTable,
  'catalog_product_id' | 'provider' | 'kind' | 'status' | 'display_priority' | 'presentation_config' | 'name' | 'default_currency'
>
export type PriceRow = Pick<
  PriceTable,
  'catalog_price_id' | 'catalog_product_id' | 'provider_price_id' | 'currency' | 'unit_amount' | 'recurring_interval' | 'recurring_count' | 'display_priority' | 'metadata'
>

export type FeatureFamilyRow = {
  feature_family_code: string
  name: string
  description: string | null
  metadata: Record<string, unknown> | null
  catalog_product_id?: string
  catalog_price_id?: string
}

export async function listRealmProducts(
  db: Kysely<Database>,
  params: { realmId: string; kind?: 'subscription' | 'credit'; currency?: string; limit: number; cursorId?: string | null },
): Promise<{ items: ProductRow[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = Math.max(1, Math.min(200, params.limit || 50))
  const cursorId = params.cursorId ?? null

  let q = db
    .selectFrom('catalog_products as p')
    .select([
      'p.catalog_product_id',
      'p.provider',
      'p.kind',
      'p.status',
      'p.display_priority',
      'p.presentation_config',
      'p.name',
      'p.default_currency',
    ])
    .where('p.realm_id', '=', params.realmId)
    .where('p.status', '=', 'active')
    .orderBy('p.display_priority')
    .orderBy('p.name')
    .orderBy('p.catalog_product_id')
    .limit(limit + 1)

  if (cursorId) q = q.where('p.catalog_product_id', '>', cursorId)
  if (params.kind) q = q.where('p.kind', '=', params.kind)
  if (params.currency) q = q.where('p.default_currency', '=', params.currency)

  const rows = await q.execute()
  const items = rows.slice(0, limit)
  const hasMore = rows.length > limit
  const nextCursor = hasMore ? String(items[items.length - 1]?.catalog_product_id ?? '') : null
  return { items, nextCursor, hasMore }
}

export async function listRealmPrices(
  db: Kysely<Database>,
  params: { realmId: string; productIds: string[]; currency?: string; limit: number; cursorId?: string | null; recurring_interval?: 'month' | 'year'; recurring_count?: number },
): Promise<{ items: PriceRow[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = Math.max(1, Math.min(200, params.limit || 50))
  const cursorId = params.cursorId ?? null
  const pids = Array.from(new Set((params.productIds || []).filter((s) => !!s)))
  if (pids.length === 0) return { items: [], nextCursor: null, hasMore: false }

  let q = db
    .selectFrom('catalog_prices as pr')
    .innerJoin('catalog_products as p', 'p.catalog_product_id', 'pr.catalog_product_id')
    .select([
      'pr.catalog_price_id',
      'pr.catalog_product_id',
      'pr.provider_price_id',
      'pr.currency',
      'pr.unit_amount',
      'pr.recurring_interval',
      'pr.recurring_count',
      'pr.display_priority',
      'pr.metadata',
    ])
    .where('pr.catalog_product_id', 'in', pids)
    .where('p.realm_id', '=', params.realmId)
    .where('pr.realm_id', '=', params.realmId)
    .where('pr.status', '=', 'active')
    .where('p.status', '=', 'active')
    .orderBy('pr.display_priority')
    .orderBy('pr.unit_amount')
    .orderBy('pr.catalog_price_id')
    .limit(limit + 1)

  if (params.currency) q = q.where('pr.currency', '=', params.currency)
  if (params.recurring_interval) q = q.where('pr.recurring_interval', '=', params.recurring_interval)
  if (typeof params.recurring_count === 'number') q = q.where('pr.recurring_count', '=', params.recurring_count)
  if (cursorId) q = q.where('pr.catalog_price_id', '>', cursorId)

  const rows = await q.execute()
  const items = rows.slice(0, limit)
  const hasMore = rows.length > limit
  const nextCursor = hasMore ? String(items[items.length - 1]?.catalog_price_id ?? '') : null
  return { items, nextCursor, hasMore }
}

export async function getDefaultPricesMap(
  db: Kysely<Database>,
  p: { realmId: string; productIds: string[]; currency?: string },
): Promise<Map<string, PriceRow>> {
  const ids = Array.from(new Set(p.productIds)).filter((s) => typeof s === 'string' && s.length > 0) as string[]
  const out = new Map<string, PriceRow>()
  if (ids.length === 0) return out

  let q = db
    .selectFrom('catalog_prices as pr')
    .innerJoin('catalog_products as p', 'p.catalog_product_id', 'pr.catalog_product_id')
    .select([
      'pr.catalog_price_id',
      'pr.catalog_product_id',
      'pr.provider_price_id',
      'pr.currency',
      'pr.unit_amount',
      'pr.recurring_interval',
      'pr.recurring_count',
      'pr.display_priority',
      'pr.metadata',
    ])
    .where('pr.catalog_product_id', 'in', ids)
    .where('p.realm_id', '=', p.realmId)
    .where('pr.realm_id', '=', p.realmId)
    .where('pr.status', '=', 'active')
    .where('p.status', '=', 'active')
    .orderBy('pr.catalog_product_id')
    .orderBy('pr.display_priority')
    .orderBy('pr.unit_amount')
    .orderBy('pr.catalog_price_id')

  if (p.currency) q = q.where('pr.currency', '=', p.currency)
  const rows = await q.execute()
  for (const r of rows) {
    const pid = r.catalog_product_id
    if (!out.has(pid)) out.set(pid, r)
  }
  return out
}

export async function listPricesForProducts(
  db: Kysely<Database>,
  params: { realmId: string; productIds: string[]; currency?: string },
): Promise<Map<string, PriceRow[]>> {
  const pids = Array.from(new Set((params.productIds || []).filter((s) => !!s)))
  const map = new Map<string, PriceRow[]>()
  if (pids.length === 0) return map

  let q = db
    .selectFrom('catalog_prices as pr')
    .innerJoin('catalog_products as p', 'p.catalog_product_id', 'pr.catalog_product_id')
    .select([
      'pr.catalog_price_id',
      'pr.catalog_product_id',
      'pr.provider_price_id',
      'pr.currency',
      'pr.unit_amount',
      'pr.recurring_interval',
      'pr.recurring_count',
      'pr.display_priority',
      'pr.metadata',
    ])
    .where('pr.catalog_product_id', 'in', pids)
    .where('p.realm_id', '=', params.realmId)
    .where('pr.realm_id', '=', params.realmId)
    .where('pr.status', '=', 'active')
    .where('p.status', '=', 'active')
    .orderBy('pr.catalog_product_id')
    .orderBy('pr.display_priority')
    .orderBy('pr.unit_amount')
    .orderBy('pr.catalog_price_id')

  if (params.currency) q = q.where('pr.currency', '=', params.currency)

  const rows = await q.execute()
  for (const row of rows) {
    const pid = row.catalog_product_id
    const list = map.get(pid) ?? []
    list.push(row)
    map.set(pid, list)
  }
  return map
}

export async function listProductFeatureFamilies(
  db: Kysely<Database>,
  params: { realmId: string; productIds: string[] },
): Promise<Map<string, FeatureFamilyRow[]>> {
  const ids = Array.from(new Set((params.productIds || []).filter((s) => !!s)))
  const map = new Map<string, FeatureFamilyRow[]>()
  if (ids.length === 0) return map

  const rows = await db
    .selectFrom('catalog_products as p')
    .leftJoin('billing_plans as bp', (join) =>
      join
        .onRef('bp.realm_id', '=', 'p.realm_id')
        .on(sql`bp.plan_code = (p.metadata ->> 'billing_plan_code')`),
    )
    .leftJoin('billing_plan_entitlements as bpe', 'bpe.plan_id', 'bp.plan_id')
    .leftJoin('feature_families as c', 'c.feature_family_id', 'bpe.feature_family_id')
    .select([
      'p.catalog_product_id as catalog_product_id',
      'c.feature_family_code as feature_family_code',
      'c.name as name',
      'c.description as description',
      'c.metadata as metadata',
    ])
    .where('p.catalog_product_id', 'in', ids)
    .where('p.realm_id', '=', params.realmId)
    .where('p.status', '=', 'active')
    .where('bp.active', '=', true)
    .where('c.active', '=', true)
    .execute()

  for (const row of rows) {
    if (!row.feature_family_code) continue
    const pid = row.catalog_product_id
    const list = map.get(pid) ?? []
    const item: FeatureFamilyRow = {
      catalog_product_id: pid,
      feature_family_code: row.feature_family_code,
      name: row.name ?? row.feature_family_code,
      description: row.description ?? null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    }
    if (!list.find((x) => x.feature_family_code === item.feature_family_code)) {
      list.push(item)
    }
    map.set(pid, list)
  }

  // sort for determinism
  for (const [pid, caps] of map.entries()) {
    caps.sort((a, b) => a.feature_family_code.localeCompare(b.feature_family_code))
    map.set(pid, caps)
  }
  return map
}

export async function listPriceFeatureFamilies(
  db: Kysely<Database>,
  params: { realmId: string; priceIds: string[] },
): Promise<Map<string, FeatureFamilyRow[]>> {
  const ids = Array.from(new Set((params.priceIds || []).filter((s) => !!s)))
  const map = new Map<string, FeatureFamilyRow[]>()
  if (ids.length === 0) return map

  const rows = await db
    .selectFrom('catalog_prices as pr')
    .innerJoin('catalog_products as p', 'p.catalog_product_id', 'pr.catalog_product_id')
    .leftJoin('billing_plans as bp', (join) =>
      join
        .onRef('bp.realm_id', '=', 'pr.realm_id')
        .on(sql`bp.plan_code = COALESCE(pr.metadata ->> 'billing_plan_code', p.metadata ->> 'billing_plan_code')`),
    )
    .leftJoin('billing_plan_entitlements as bpe', 'bpe.plan_id', 'bp.plan_id')
    .leftJoin('feature_families as c', 'c.feature_family_id', 'bpe.feature_family_id')
    .select([
      'pr.catalog_price_id as catalog_price_id',
      'c.feature_family_code as feature_family_code',
      'c.name as name',
      'c.description as description',
      'c.metadata as metadata',
    ])
    .where('pr.catalog_price_id', 'in', ids)
    .where('pr.realm_id', '=', params.realmId)
    .where('p.realm_id', '=', params.realmId)
    .where('p.status', '=', 'active')
    .where('bp.active', '=', true)
    .where('c.active', '=', true)
    .execute()

  for (const row of rows) {
    if (!row.feature_family_code) continue
    const pid = row.catalog_price_id
    const list = map.get(pid) ?? []
    const item: FeatureFamilyRow = {
      catalog_price_id: pid,
      feature_family_code: row.feature_family_code,
      name: row.name ?? row.feature_family_code,
      description: row.description ?? null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    }
    if (!list.find((x) => x.feature_family_code === item.feature_family_code)) {
      list.push(item)
    }
    map.set(pid, list)
  }

  for (const [priceId, caps] of map.entries()) {
    caps.sort((a, b) => a.feature_family_code.localeCompare(b.feature_family_code))
    map.set(priceId, caps)
  }
  return map
}
