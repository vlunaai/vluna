import type Stripe from 'stripe'
import { createHash, randomUUID } from 'node:crypto'
import { callStripe } from './client.js'
import type { PaymentProvider, SyncReport, SyncItemNote, ProviderOpContext, CatalogSyncOptions } from '../payment/PaymentProvider.js'
import type { Database } from '../../types/database.js'
import type { Insertable, Kysely, Selectable, Transaction, Updateable } from 'kysely'
import type { RealmConfigService, RealmStripeRuntime } from '../../security/realm-config.service.js'
import { newTraceId } from '../../support/trace.util.js'

type StripeWebhookEntry = { name?: string; secret?: string; test?: string; live?: string; url?: string }
type StripeMetaLike = { webhooks?: StripeWebhookEntry[] }

type LocalProduct = Selectable<Database['catalog_products']>
type LocalPrice = Selectable<Database['catalog_prices']>
type LocalSubscriptionGroup = Selectable<Database['subscription_groups']>

function idemKey(parts: (string | number | null | undefined)[]): string {
  return parts.filter((p) => p !== null && p !== undefined && String(p).length > 0).join(':')
}

function hashIdempotencyPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload ?? {})
  return createHash('sha256').update(serialized).digest('hex').slice(0, 12)
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  return s.length > 0 ? s : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function deepMergePreserveBase(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (base === undefined) return patch
  if (Array.isArray(base)) {
    return Array.isArray(patch) ? patch : base
  }
  if (Array.isArray(patch)) return patch
  if (base && typeof base === 'object' && patch !== null && typeof patch !== 'object') {
    return base
  }
  const baseObj = asRecord(base)
  const patchObj = asRecord(patch)
  if (Object.keys(baseObj).length === 0 && Object.keys(patchObj).length === 0) {
    return patch
  }
  const out: Record<string, unknown> = { ...baseObj }
  for (const [k, v] of Object.entries(patchObj)) {
    out[k] = k in out ? deepMergePreserveBase(out[k], v) : v
  }
  return out
}

function mergeMetadataWithStripeNamespace(
  local: unknown,
  stripeMeta: Record<string, string>,
  p: { active?: boolean; livemode?: boolean; updatedAtIso?: string; allowTopLevelKeys?: Record<string, unknown> },
): Record<string, unknown> {
  const base = asRecord(local)
  const stripeNamespace: Record<string, unknown> = {
    ...stripeMeta,
    ...(typeof p.active === 'boolean' ? { active: p.active } : {}),
    ...(typeof p.livemode === 'boolean' ? { livemode: p.livemode } : {}),
    ...(p.updatedAtIso ? { updated_at: p.updatedAtIso } : {}),
  }

  const patch: Record<string, unknown> = {
    ...(p.allowTopLevelKeys || {}),
    stripe: deepMergePreserveBase(base['stripe'], stripeNamespace),
  }

  const merged = deepMergePreserveBase(base, patch)
  return asRecord(merged)
}

function parseStripeInt(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const raw = typeof value === 'string' ? value.trim() : String(value)
  if (!/^-?\d+$/.test(raw)) return null
  const num = Number(raw)
  if (!Number.isSafeInteger(num)) return null
  if (num > 2147483647 || num < -2147483648) return null
  return num
}

export class StripePaymentProvider implements PaymentProvider {
  constructor(private readonly realms: RealmConfigService) {}

  providerId = 'stripe'

  private normalizeStripeWebhooks(
    stripe: StripeMetaLike | undefined,
  ): Array<{ name: string; secret?: string; test?: string; live?: string; url?: string }> {
    if (!stripe) return []
    if (Array.isArray(stripe.webhooks)) {
      return stripe.webhooks
        .map((w: { name?: string; secret?: string; test?: string; live?: string; url?: string }) => ({
          name: String(w?.name || '').trim() || 'default',
          secret: w?.secret,
          test: w?.test,
          live: w?.live,
          url: w?.url,
        }))
        .filter((w: { name: string }) => w.name.length > 0)
    }
    return []
  }

  async bootstrap(ctx: ProviderOpContext): Promise<void> {
    const realmId = ctx.realmId
    if (!realmId) return
    try {
      await this.realms.getStripeRuntime(realmId)
    } catch (err) {
      console.log('[stripe-bootstrap] skip (realm missing Stripe config)', { realmId, error: (err as Error)?.message })
      return
    }
    const traceId = ctx.traceId || newTraceId()
    const db = (ctx.db as Kysely<Database> | undefined) || (await import('../../db/index.js')).db()
    try {
      await this.registerWebhooks({ ...ctx, realmId, db, traceId })
      const report = await this.syncProductsAndPrices({ ...ctx, realmId, db, traceId }, { dryRun: false })
      console.log(
        '[stripe-bootstrap] sync finished',
        JSON.stringify({ realmId, counters: report.counters, notes: report.notes.slice(0, 5) }),
      )
    } catch (e) {
      console.warn('[stripe-bootstrap] failed', e)
    }
  }

  private async runtime(ctx: ProviderOpContext): Promise<RealmStripeRuntime> {
    if (!ctx.realmId) {
      throw new Error('stripe_realm_required')
    }
    return this.realms.getStripeRuntime(ctx.realmId)
  }

  async retrieveCustomer(
    ctx: ProviderOpContext,
    p: { billingAccountId: string; principalId?: string; email?: string; name?: string; metadata?: Record<string, unknown> },
  ): Promise<string> {
    const runtime = await this.runtime(ctx)
    const stripe = runtime.client
    const realmId = runtime.realmId
    const db = ctx.db as Kysely<Database> | Transaction<Database> | undefined
    if (!db) throw new Error('DB handle missing')
    const existing = await db
      .selectFrom('provider_customers')
      .select(['provider_customer_id'])
      .where('billing_account_id', '=', p.billingAccountId)
      .where('provider', '=', 'stripe')
      .executeTakeFirst()
    if (existing?.provider_customer_id) return existing.provider_customer_id

    const idempotencyKey = idemKey(['cust', p.billingAccountId])
    const created: { id: string } = await callStripe(
      () =>
        stripe.customers.create(
          {
            // Include only non-PII unless explicitly provided
            ...(p.email ? { email: p.email } : {}),
            ...(p.name ? { name: p.name } : {}),
            metadata: { realm_id: realmId, billing_account_id: p.billingAccountId, principal_id: p.principalId ?? null, ...(p.metadata || {}) },
          },
          { idempotencyKey },
        ),
      { op: 'customers.create', traceId: ctx.traceId },
    )

    // Atomic upsert to avoid races
    await db
      .insertInto('provider_customers')
      .values({
        billing_account_id: p.billingAccountId,
        provider: 'stripe',
        provider_customer_id: created.id,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(['billing_account_id', 'provider']).doUpdateSet({ provider_customer_id: created.id, updated_at: new Date() }),
      )
      .execute()

    return created.id
  }

  private async registerWebhook(
    runtime: RealmStripeRuntime,
    webhook: { name: string; url: string },
    traceId?: string,
  ): Promise<{ id: string; url: string; secret?: string }> {
    const stripe = runtime.client
    const events: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
      'checkout.session.completed',
      'payment_intent.succeeded',
      'payment_intent.payment_failed',
      'invoice.paid',
      'invoice.payment_failed',
      'charge.refunded',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'customer.subscription.paused',
    ]

    const endpoints = await callStripe(
      async () => stripe.webhookEndpoints.list({ limit: 100 }),
      { op: 'webhookEndpoints.list', traceId },
    )

    const existing = endpoints.data.find((e) => e.url === webhook.url && e.livemode === (runtime.env === 'live'))
    if (existing) return { id: existing.id, url: existing.url }

    const created = await callStripe(
      async () =>
        stripe.webhookEndpoints.create(
          { url: webhook.url, enabled_events: events },
          // { idempotencyKey: idemKey(['wh', webhook.url, runtime.env]) },
        ),
      { op: 'webhookEndpoints.create', traceId },
    )
    return { id: created.id, url: created.url, secret: created.secret || undefined }
  }

  async registerWebhooks(ctx: ProviderOpContext): Promise<{ id: string; url: string }[]> {
    const runtime = await this.runtime(ctx)
    const realmId = runtime.realmId
    const base = runtime.config.publicWebhookBaseUrl
    if (!base) throw new Error('CONFIG: payments.stripe.public_webhook_base_url missing')
    const db = ctx.db as Kysely<Database> | undefined

    let stripeMeta: StripeMetaLike = {}
    if (db) {
      const row = await db.selectFrom('realms').select(['metadata']).where('realm_id', '=', realmId).executeTakeFirst()
      const realmMeta = (row?.metadata as { payments?: { stripe?: StripeMetaLike } } | null) || null
      stripeMeta = realmMeta?.payments?.stripe || {}
    }
    const webhooks = this.normalizeStripeWebhooks(stripeMeta)
    const paymentWebhook = webhooks.find((w) => w.name === 'payment')
    const pwUrl = `${base}/api/webhooks/stripe/${realmId}`
    if (!paymentWebhook) {
      webhooks.push({ name: 'payment', url: pwUrl })
    } else {
      paymentWebhook.url = pwUrl
    }

    const results: { id: string; url: string; name: string; secret?: string }[] = []
    for (const wh of webhooks) {
      const url = wh.url
      if (!url) continue
      const res = await this.registerWebhook(runtime, { name: wh.name, url }, ctx.traceId)
      if (res.secret) {
        const envField = runtime.env === 'live' ? 'live' : 'test'
        wh[envField] = res.secret
        wh.secret = res.secret
      }
      results.push({ ...res, name: wh.name })
    }

    if (db) {
      const existingRow = await db.selectFrom('realms').select(['metadata']).where('realm_id', '=', realmId).executeTakeFirst()
      const existingMeta = (existingRow?.metadata as Record<string, unknown> | null) || {}
      const mergedMetaPayments = {
        ...(existingMeta.payments as Record<string, unknown> | undefined),
        stripe: {
          ...((existingMeta.payments as { stripe?: StripeMetaLike } | undefined)?.stripe || {}),
          ...stripeMeta,
          webhooks,
        },
      }
      const mergedMeta = { ...existingMeta, payments: mergedMetaPayments }
      await db.updateTable('realms').set({ metadata: mergedMeta }).where('realm_id', '=', realmId).execute()
    }

    return results.map(({ id, url }) => ({ id, url }))
  }

  async syncProductsAndPrices(ctx: ProviderOpContext, p?: CatalogSyncOptions): Promise<SyncReport> {
    const opts: CatalogSyncOptions = p || {}
    const dir = opts.direction || 'push'
    if (dir === 'pull') return this.pullProductsAndPrices(ctx, opts)
    return this.pushProductsAndPrices(ctx, opts)
  }

  async pushProductsAndPrices(ctx: ProviderOpContext, p?: CatalogSyncOptions): Promise<SyncReport> {
    const startedAt = new Date().toISOString()
    const notes: SyncItemNote[] = []
    const counters = { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }
    const dry = Boolean(p?.dryRun)
    const runtime = await this.runtime(ctx)
    const stripe = runtime.client
    const realmId = runtime.realmId

    const db = ctx.db as Kysely<Database> | undefined
    if (!db) throw new Error('DB handle missing in RequestContext')

    // Pull local catalog
    let productsQuery = db
      .selectFrom('catalog_products')
      .selectAll()
      .where('status', '=', 'active')
    let pricesQuery = db
      .selectFrom('catalog_prices')
      .selectAll()
      .where('status', '=', 'active')

    if (ctx.realmId) {
      productsQuery = productsQuery.where('realm_id', '=', ctx.realmId)
      pricesQuery = pricesQuery.where('realm_id', '=', ctx.realmId)
    }

    const products = (await productsQuery.execute()) as LocalProduct[]
    const prices = (await pricesQuery.execute()) as LocalPrice[]
    const pricesByProduct = new Map<string, LocalPrice[]>()
    for (const pr of prices) {
      const arr = pricesByProduct.get(pr.catalog_product_id) || []
      arr.push(pr)
      pricesByProduct.set(pr.catalog_product_id, arr)
    }

    // Pull provider state
    const stripeProducts = await this.listAllStripeProducts(stripe)
    const stripePrices = await this.listAllStripePrices(stripe)

    const stripeProductByMetaCatalogId = new Map<string, Stripe.Product>()
    const stripeProductById = new Map<string, Stripe.Product>()
    for (const sp of stripeProducts) {
      stripeProductById.set(sp.id, sp)
      const meta = sp.metadata || {}
      const catId = meta['catalog_product_id']
      if (catId) stripeProductByMetaCatalogId.set(catId, sp)
    }

    const stripePricesByProductId = new Map<string, Stripe.Price[]>()
    for (const pr of stripePrices) {
      const pid = typeof pr.product === 'string' ? (pr.product as string) : (pr.product as Stripe.Product).id
      const arr = stripePricesByProductId.get(pid) || []
      arr.push(pr)
      stripePricesByProductId.set(pid, arr)
    }

	    // Sync products
	    for (const lp of products) {
	      // Prefer provider_product_id if it looks like a Stripe id and exists; otherwise fallback to metadata match
	      let sp: Stripe.Product | undefined
	      if (lp.provider_product_id && /^prod_/.test(lp.provider_product_id)) {
	        sp = stripeProductById.get(lp.provider_product_id)
	      }
	      if (!sp) {
	        sp = stripeProductByMetaCatalogId.get(lp.catalog_product_id)
	      }
	      const desired: Stripe.ProductCreateParams = {
	        name: lp.name,
	        active: lp.status === 'active',
	        metadata: { catalog_product_id: lp.catalog_product_id, realm_id: realmId },
	      }
	      if (!sp) {
	        if (!dry) {
          const idempotencyKey = idemKey(['prod1', realmId, lp.catalog_product_id, hashIdempotencyPayload(desired), randomUUID()])
          const created = await callStripe(
            async () => stripe.products.create(desired, {
              idempotencyKey,
            }),
            { op: 'products.create', traceId: ctx.traceId },
          )
          notes.push({ kind: 'product', action: 'create', id: created.id })
          counters.products.created++
          // Persist provider_product_id back to local
          await db
            .updateTable('catalog_products')
            .set({ provider_product_id: created.id })
            .where('catalog_product_id', '=', lp.catalog_product_id)
            .execute()
          // Keep in-memory state consistent for subsequent steps
          lp.provider_product_id = created.id
          sp = created as unknown as Stripe.Product
          stripeProductById.set(created.id, created as unknown as Stripe.Product)
          stripeProductByMetaCatalogId.set(lp.catalog_product_id, created as unknown as Stripe.Product)
          if (!stripePricesByProductId.has(created.id)) stripePricesByProductId.set(created.id, [])
        } else {
          notes.push({ kind: 'product', action: 'create', reason: 'dryRun' })
        }
      } else {
        // Repair local provider_product_id if mismatched or missing
        if (!dry && lp.provider_product_id !== sp.id) {
          await db
            .updateTable('catalog_products')
            .set({ provider_product_id: sp.id })
            .where('catalog_product_id', '=', lp.catalog_product_id)
            .execute()
          lp.provider_product_id = sp.id
        }
        const mustUpdate = (sp.name ?? '') !== desired.name || (sp.active ?? true) !== desired.active
        if (mustUpdate) {
          if (!dry) {
            await callStripe(
              async () => stripe.products.update(sp!.id, { name: desired.name, active: desired.active }),
              { op: 'products.update', traceId: ctx.traceId },
            )
            counters.products.updated++
            notes.push({ kind: 'product', action: 'update', id: sp.id })
          } else {
            notes.push({ kind: 'product', action: 'update', id: sp.id, reason: 'dryRun' })
          }
        } else {
          counters.products.skipped++
          notes.push({ kind: 'product', action: 'skip', id: sp.id, reason: 'nochange' })
        }
      }
    }

    // Sync prices (immutable fields → create new + archive old when changed)
    for (const lp of products) {
      const sp = lp.provider_product_id ? stripeProductById.get(lp.provider_product_id) : stripeProductByMetaCatalogId.get(lp.catalog_product_id)
      if (!sp) continue // product must exist first
      const localPrices = pricesByProduct.get(lp.catalog_product_id) || []
      const remotePrices = (stripePricesByProductId.get(sp.id) || []).filter((rp) => !rp.deleted)
      // Map by metadata.catalog_price_id for quick lookup/repair
      const remoteByCatalogPriceId = new Map<string, Stripe.Price>()
      for (const rp of remotePrices) {
        const cp = rp.metadata?.catalog_price_id
        if (cp) remoteByCatalogPriceId.set(String(cp), rp)
      }

      for (const lpr of localPrices) {
        const explicitMatch = lpr.provider_price_id && /^price_/.test(lpr.provider_price_id)
          ? remotePrices.find((r) => r.id === lpr.provider_price_id)
          : undefined

        // Fallback: metadata mapping
        const metaMatch = remoteByCatalogPriceId.get(lpr.catalog_price_id)
        if (metaMatch && !dry && lpr.provider_price_id !== metaMatch.id) {
          await db
            .updateTable('catalog_prices')
            .set({ provider_price_id: metaMatch.id })
            .where('catalog_price_id', '=', lpr.catalog_price_id)
            .execute()
          lpr.provider_price_id = metaMatch.id
        }

        const semanticMatch = remotePrices.find((rp) =>
          rp.currency === lpr.currency.toLowerCase() &&
          rp.unit_amount === lpr.unit_amount &&
          ((rp.recurring && lpr.recurring_interval)
            ? (rp.recurring?.interval === lpr.recurring_interval && (rp.recurring?.interval_count || 1) === (lpr.recurring_count || 1))
            : (!rp.recurring && !lpr.recurring_interval))
        )

        const match = explicitMatch ?? metaMatch ?? semanticMatch

        if (lpr.status === 'archived') {
          if (match) {
            if (match.active) {
              if (!dry) {
                await callStripe(async () => stripe.prices.update(match.id, { active: false }), { op: 'prices.update', traceId: ctx.traceId })
                counters.prices.archived++
                notes.push({ kind: 'price', action: 'archive', id: match.id, reason: 'local_archived' })
              } else {
                notes.push({ kind: 'price', action: 'archive', id: match.id, reason: 'dryRun' })
              }
            } else {
              counters.prices.skipped++
              notes.push({ kind: 'price', action: 'skip', id: match.id, reason: 'already_archived' })
            }
          } else {
            counters.prices.skipped++
            notes.push({ kind: 'price', action: 'skip', reason: 'archived_no_remote' })
          }
          continue
        }

        if (match) {
          if (!match.active) {
            if (!dry) {
              await callStripe(async () => stripe.prices.update(match.id, { active: true }), { op: 'prices.update', traceId: ctx.traceId })
            }
            counters.prices.updated++
            notes.push({ kind: 'price', action: 'update', id: match.id, reason: dry ? 'dryRun' : 'activate' })
          } else {
            counters.prices.skipped++
            notes.push({ kind: 'price', action: 'skip', id: match.id, reason: 'nochange' })
          }
          // Repair provider_price_id if missing
          if (!dry && lpr.provider_price_id !== match.id) {
            await db
              .updateTable('catalog_prices')
              .set({ provider_price_id: match.id })
              .where('catalog_price_id', '=', lpr.catalog_price_id)
              .execute()
            lpr.provider_price_id = match.id
          }
          continue
        }

        // no exact match → create new price
        const createParams: Stripe.PriceCreateParams = {
          product: sp.id,
          currency: lpr.currency.toLowerCase(),
          unit_amount: lpr.unit_amount,
          metadata: { catalog_product_id: lp.catalog_product_id, catalog_price_id: lpr.catalog_price_id },
        }
        if (lpr.recurring_interval) {
          createParams.recurring = { interval: lpr.recurring_interval, interval_count: lpr.recurring_count || 1 }
        }
        if (!dry) {
            const idempotencyKey = idemKey(['price', realmId, lpr.catalog_price_id, hashIdempotencyPayload(createParams), randomUUID()])
            const created = await callStripe(
              async () => stripe.prices.create(createParams, {
                idempotencyKey,
              }),
              { op: 'prices.create', traceId: ctx.traceId },
            )
          counters.prices.created++
          notes.push({ kind: 'price', action: 'create', id: created.id })
          // Persist provider_price_id back to local
          await db
            .updateTable('catalog_prices')
            .set({ provider_price_id: created.id })
            .where('catalog_price_id', '=', lpr.catalog_price_id)
            .execute()
          // Update in-memory maps for consistency
          lpr.provider_price_id = created.id
          const arr = stripePricesByProductId.get(sp.id) || []
          arr.push(created as unknown as Stripe.Price)
          stripePricesByProductId.set(sp.id, arr)
        } else {
          notes.push({ kind: 'price', action: 'create', reason: 'dryRun' })
        }

        // If there is a conflicting remote price with same semantic but different immutable fields, archive it
        for (const rp of remotePrices) {
          const sameCurrency = rp.currency === lpr.currency.toLowerCase()
          const sameRecurring = (!!rp.recurring) === (!!lpr.recurring_interval)
          if (sameCurrency && sameRecurring) {
            const immutableChanged = rp.unit_amount !== lpr.unit_amount || (rp.recurring && lpr.recurring_interval && (
              rp.recurring.interval !== lpr.recurring_interval || (rp.recurring.interval_count || 1) !== (lpr.recurring_count || 1)
            ))
            if (immutableChanged && rp.active) {
              if (!dry) {
                await callStripe(async () => stripe.prices.update(rp.id, { active: false }), { op: 'prices.update', traceId: ctx.traceId })
                counters.prices.archived++
                notes.push({ kind: 'price', action: 'archive', id: rp.id, reason: 'immutable_changed' })
              } else {
                notes.push({ kind: 'price', action: 'archive', id: rp.id, reason: 'dryRun' })
              }
            }
          }
        }
      }
    }

    const finishedAt = new Date().toISOString()
    const report: SyncReport = { startedAt, finishedAt, counters, notes, suggestions: [
      'Review newly created prices and set tax_behavior/billing_scheme as needed.',
      'Persist provider_product_id/provider_price_id back to DB in a follow-up.',
    ] }
    return report
  }

  async pullProductsAndPrices(ctx: ProviderOpContext, p?: CatalogSyncOptions): Promise<SyncReport> {
    const startedAt = new Date().toISOString()
    const notes: SyncItemNote[] = []
    const counters = { products: { created: 0, updated: 0, skipped: 0 }, prices: { created: 0, updated: 0, archived: 0, skipped: 0 }, errors: 0 }
    const dry = Boolean(p?.dryRun)
    const runtime = await this.runtime(ctx)
    const stripe = runtime.client

    const db = ctx.db as Kysely<Database> | undefined
    if (!db) throw new Error('DB handle missing in RequestContext')

    const stripeProducts = await this.listAllStripeProducts(stripe)
    const stripePrices = await this.listAllStripePrices(stripe)

    const ctxRealmId = asTrimmedString(ctx.realmId)
    const includedProducts: Stripe.Product[] = []
    const targetRealmByProductId = new Map<string, string>()

    for (const sp of stripeProducts) {
      const metaRealm = asTrimmedString(sp.metadata?.realm_id)
      if (ctxRealmId) {
        if (metaRealm && metaRealm !== ctxRealmId) {
          counters.products.skipped++
          notes.push({ kind: 'product', action: 'skip', id: sp.id, reason: 'realm_mismatch', details: { metaRealm, ctxRealmId } })
          continue
        }
        includedProducts.push(sp)
        targetRealmByProductId.set(sp.id, ctxRealmId)
        continue
      }

      if (!metaRealm) {
        counters.errors++
        notes.push({ kind: 'product', action: 'error', id: sp.id, reason: 'missing_realm_id' })
        continue
      }
      includedProducts.push(sp)
      targetRealmByProductId.set(sp.id, metaRealm)
    }

    const targetRealms = Array.from(new Set(Array.from(targetRealmByProductId.values())))
    if (targetRealms.length === 0) {
      const finishedAt = new Date().toISOString()
      return { startedAt, finishedAt, counters, notes, suggestions: ['No Stripe products matched realm filter.'] }
    }

    const pricesByProductId = new Map<string, Stripe.Price[]>()
    for (const pr of stripePrices) {
      if ((pr as unknown as { deleted?: boolean }).deleted) continue
      const pid = typeof pr.product === 'string' ? (pr.product as string) : (pr.product as Stripe.Product).id
      if (!targetRealmByProductId.has(pid)) continue
      const arr = pricesByProductId.get(pid) || []
      arr.push(pr)
      pricesByProductId.set(pid, arr)
    }

    const localProducts = await db
      .selectFrom('catalog_products')
      .selectAll()
      .where('realm_id', 'in', targetRealms)
      .where('provider', '=', 'stripe')
      .execute() as LocalProduct[]

    const localPrices = await db
      .selectFrom('catalog_prices')
      .selectAll()
      .where('realm_id', 'in', targetRealms)
      .execute() as LocalPrice[]

    const localGroups = await db
      .selectFrom('subscription_groups')
      .selectAll()
      .where('realm_id', 'in', targetRealms)
      .execute() as LocalSubscriptionGroup[]

    const groupIdByKey = new Map<string, string>()
    for (const g of localGroups) groupIdByKey.set(`${String(g.realm_id)}::${String(g.group_key)}`, String(g.subscription_group_id))

    const localProductByProviderId = new Map<string, LocalProduct>()
    const localProductByCode = new Map<string, LocalProduct>()
    const localProductByCatalogId = new Map<string, LocalProduct>()
    for (const lp of localProducts) {
      if (lp.provider_product_id) localProductByProviderId.set(lp.provider_product_id, lp)
      if (lp.product_code) localProductByCode.set(lp.product_code, lp)
      localProductByCatalogId.set(String(lp.catalog_product_id), lp)
    }

    const localPriceByProviderId = new Map<string, LocalPrice>()
    const localPriceByCode = new Map<string, LocalPrice>()
    const localPriceByCatalogId = new Map<string, LocalPrice>()
    for (const lpr of localPrices) {
      if (lpr.provider_price_id) localPriceByProviderId.set(lpr.provider_price_id, lpr)
      if (lpr.price_code) localPriceByCode.set(lpr.price_code, lpr)
      localPriceByCatalogId.set(String(lpr.catalog_price_id), lpr)
    }

    const localProductIdByStripeProductId = new Map<string, string>()
    const localProductCodeByStripeProductId = new Map<string, string>()

    const ensureGroup = async (realmId: string, groupKey: string): Promise<{ groupKey: string; groupId: string }> => {
      const key = groupKey.trim()
      const existing = groupIdByKey.get(`${realmId}::${key}`)
      if (existing) return { groupKey: key, groupId: existing }
      if (dry) {
        const placeholder = `dry:${key}`
        groupIdByKey.set(`${realmId}::${key}`, placeholder)
        return { groupKey: key, groupId: placeholder }
      }
      const inserted = await db
        .insertInto('subscription_groups')
        .values({ realm_id: realmId, group_key: key, title: key, is_stackable: false, is_exclusive: true })
        .returning(['subscription_group_id'])
        .executeTakeFirstOrThrow()
      const id = String(inserted.subscription_group_id)
      groupIdByKey.set(`${realmId}::${key}`, id)
      return { groupKey: key, groupId: id }
    }

    for (const sp of includedProducts) {
      const targetRealm = targetRealmByProductId.get(sp.id)!
      const metaCatalogId = asTrimmedString(sp.metadata?.catalog_product_id)
      const metaProductCode = asTrimmedString(sp.metadata?.product_code)

      let match: LocalProduct | undefined = localProductByProviderId.get(sp.id)
      if (!match && metaCatalogId) match = localProductByCatalogId.get(metaCatalogId)
      if (!match && metaProductCode) match = localProductByCode.get(metaProductCode)
      if (match && String(match.realm_id) !== targetRealm) {
        counters.errors++
        notes.push({ kind: 'product', action: 'error', id: sp.id, reason: 'local_realm_conflict', details: { targetRealm, localRealm: match.realm_id } })
        continue
      }

      const inferredCurrency = (() => {
        const dp = sp.default_price
        const fromDefaultPrice = dp && typeof dp === 'object'
          ? asTrimmedString(dp.currency)?.toUpperCase()
          : undefined
        const fromAnyPrice = pricesByProductId.get(sp.id)?.[0]?.currency
          ? String(pricesByProductId.get(sp.id)![0]!.currency).toUpperCase()
          : undefined
        return fromDefaultPrice || fromAnyPrice || 'USD'
      })()

      const inferredKind = (() => {
        const raw = asTrimmedString(sp.metadata?.kind)
        if (raw === 'subscription' || raw === 'credit') return raw
        const hasRecurring = (pricesByProductId.get(sp.id) || []).some((pr) => Boolean(pr.recurring))
        return hasRecurring ? 'subscription' : 'credit'
      })()

      const status: LocalProduct['status'] =
        match?.status === 'draft'
          ? 'draft'
          : (sp.active ? 'active' : 'archived')

      const allowTopLevel: Record<string, unknown> = {}
      const kindRaw = asTrimmedString(sp.metadata?.kind)
      const nameKeyRaw = asTrimmedString(sp.metadata?.name)

      if (!match) {
        const productCode = metaProductCode || sp.id
        const insert: Insertable<Database['catalog_products']> = {
          realm_id: targetRealm,
          product_code: productCode,
          provider: 'stripe',
          provider_product_id: sp.id,
          kind: inferredKind,
          status,
          name: nameKeyRaw || productCode,
          default_currency: inferredCurrency,
          metadata: mergeMetadataWithStripeNamespace({}, sp.metadata || {}, { active: sp.active, livemode: sp.livemode, updatedAtIso: new Date().toISOString(), allowTopLevelKeys: allowTopLevel }),
        }
        if (!dry) {
          const inserted = await db
            .insertInto('catalog_products')
            .values(insert)
            .returning(['catalog_product_id'])
            .executeTakeFirstOrThrow()
          const newId = String(inserted.catalog_product_id)
          const lp: LocalProduct = {
            ...(insert as unknown as Omit<LocalProduct, 'catalog_product_id' | 'created_at'>),
            catalog_product_id: newId,
            created_at: new Date(),
          } as LocalProduct
          localProductByProviderId.set(sp.id, lp)
          localProductByCode.set(productCode, lp)
          localProductByCatalogId.set(newId, lp)
          localProductIdByStripeProductId.set(sp.id, newId)
          localProductCodeByStripeProductId.set(sp.id, productCode)
          counters.products.created++
          notes.push({ kind: 'product', action: 'create', id: sp.id })
        } else {
          counters.products.created++
          notes.push({ kind: 'product', action: 'create', id: sp.id, reason: 'dryRun' })
          localProductIdByStripeProductId.set(sp.id, `dry:${productCode}`)
          localProductCodeByStripeProductId.set(sp.id, productCode)
        }
        continue
      }

      localProductIdByStripeProductId.set(sp.id, String(match.catalog_product_id))
      localProductCodeByStripeProductId.set(sp.id, String(match.product_code))

      const nextMeta = mergeMetadataWithStripeNamespace(match.metadata, sp.metadata || {}, {
        active: sp.active,
        livemode: sp.livemode,
        updatedAtIso: new Date().toISOString(),
        allowTopLevelKeys: allowTopLevel,
      })

      const updates: Updateable<Database['catalog_products']> = {}
      if (match.provider_product_id !== sp.id) updates.provider_product_id = sp.id
      if (match.status !== status) updates.status = status
      if (kindRaw && (kindRaw === 'subscription' || kindRaw === 'credit') && match.kind !== kindRaw) updates.kind = kindRaw
      if (String(match.default_currency || '') !== inferredCurrency) updates.default_currency = inferredCurrency
      if (JSON.stringify(match.metadata ?? {}) !== JSON.stringify(nextMeta ?? {})) updates.metadata = nextMeta as unknown as Record<string, unknown>

      const hasUpdate = Object.keys(updates).length > 0
      if (!hasUpdate) {
        counters.products.skipped++
        notes.push({ kind: 'product', action: 'skip', id: sp.id, reason: 'nochange' })
        continue
      }
      if (!dry) {
        await db.updateTable('catalog_products').set(updates).where('catalog_product_id', '=', match.catalog_product_id).execute()
      }
      counters.products.updated++
      notes.push({ kind: 'product', action: 'update', id: sp.id, reason: dry ? 'dryRun' : undefined })
    }

    for (const [stripeProductId, remotePrices] of pricesByProductId.entries()) {
      const targetRealm = targetRealmByProductId.get(stripeProductId)!
      const localProductId = localProductIdByStripeProductId.get(stripeProductId)
      const localProductCode = localProductCodeByStripeProductId.get(stripeProductId) || stripeProductId
      if (!localProductId) continue

      for (const rp of remotePrices) {
        const metaCatalogPriceId = asTrimmedString(rp.metadata?.catalog_price_id)
        const metaPriceCode = asTrimmedString(rp.metadata?.price_code) || asTrimmedString((rp as unknown as { lookup_key?: string }).lookup_key)

        let match: LocalPrice | undefined = localPriceByProviderId.get(rp.id)
        if (!match && metaCatalogPriceId) match = localPriceByCatalogId.get(metaCatalogPriceId)
        if (!match && metaPriceCode) match = localPriceByCode.get(metaPriceCode)

        if (match && String(match.realm_id) !== targetRealm) {
          counters.errors++
          notes.push({ kind: 'price', action: 'error', id: rp.id, reason: 'local_realm_conflict', details: { targetRealm, localRealm: match.realm_id } })
          continue
        }

        const currency = String(rp.currency || '').toUpperCase()
        const unitAmount = rp.unit_amount ?? parseStripeInt((rp as unknown as { unit_amount_decimal?: string | null }).unit_amount_decimal)
        const billingScheme = (rp as unknown as { billing_scheme?: string | null }).billing_scheme
        const transformQty = (rp as unknown as { transform_quantity?: unknown }).transform_quantity
        if (!currency || unitAmount === null || unitAmount < 0) {
          counters.errors++
          notes.push({ kind: 'price', action: 'error', id: rp.id, reason: 'unsupported_unit_amount', details: { currency, unitAmount } })
          continue
        }
        if (billingScheme && billingScheme !== 'per_unit') {
          counters.errors++
          notes.push({ kind: 'price', action: 'error', id: rp.id, reason: 'unsupported_billing_scheme', details: { billingScheme } })
          continue
        }
        if (transformQty) {
          counters.errors++
          notes.push({ kind: 'price', action: 'error', id: rp.id, reason: 'unsupported_transform_quantity' })
          continue
        }

        const recurringIntervalRaw = rp.recurring?.interval ? String(rp.recurring.interval) : null
        const recurringInterval = recurringIntervalRaw === 'month' || recurringIntervalRaw === 'year' ? recurringIntervalRaw : null
        if (recurringIntervalRaw && !recurringInterval) {
          counters.errors++
          notes.push({ kind: 'price', action: 'error', id: rp.id, reason: 'unsupported_recurring_interval', details: { recurringIntervalRaw } })
          continue
        }
        const recurringCount = recurringInterval ? (rp.recurring?.interval_count || 1) : null

        const displayPriorityRemote = parseStripeInt(rp.metadata?.display_priority)
        const billingPlanCode = asTrimmedString(rp.metadata?.billing_plan_code)
        const remoteGroupKey = asTrimmedString(rp.metadata?.subscription_group_key)

        const allowTopLevel: Record<string, unknown> = {}
        if (billingPlanCode) allowTopLevel['billing_plan_code'] = billingPlanCode

        const nextMeta = mergeMetadataWithStripeNamespace(match?.metadata, rp.metadata || {}, {
          active: rp.active,
          livemode: rp.livemode,
          updatedAtIso: new Date().toISOString(),
          allowTopLevelKeys: allowTopLevel,
        })
        const desiredStatus: LocalPrice['status'] = rp.active === false ? 'archived' : 'active'

        const ensureRecurringGroup = async (): Promise<{ groupKey: string; groupId: string } | null> => {
          if (!recurringInterval) return null
          const groupKey = remoteGroupKey || String((match as unknown as { subscription_group_key?: string | null })?.subscription_group_key || '') || localProductCode
          if (!groupKey) return null
          return ensureGroup(targetRealm, groupKey)
        }

        if (!match) {
          const priceCode = metaPriceCode || rp.id
          const group = await ensureRecurringGroup()
          const insert: Insertable<Database['catalog_prices']> = {
            realm_id: targetRealm,
            catalog_product_id: localProductId,
            price_code: priceCode,
            provider_price_id: rp.id,
            status: rp.active === false ? 'archived' : 'active',
            currency,
            unit_amount: unitAmount,
            recurring_interval: recurringInterval,
            recurring_count: recurringCount,
            display_priority: displayPriorityRemote ?? 100,
            metadata: nextMeta as unknown,
            subscription_group_id: group ? group.groupId : null,
            subscription_group_key: group ? group.groupKey : null,
          }
          if (!dry) {
            const inserted = await db
              .insertInto('catalog_prices')
              .values(insert)
              .returning(['catalog_price_id'])
              .executeTakeFirstOrThrow()
            const newId = String(inserted.catalog_price_id)
            const lp: LocalPrice = {
              ...(insert as unknown as Omit<LocalPrice, 'catalog_price_id'>),
              catalog_price_id: newId,
            } as LocalPrice
            localPriceByProviderId.set(rp.id, lp)
            localPriceByCode.set(priceCode, lp)
            localPriceByCatalogId.set(newId, lp)
          }
          counters.prices.created++
          notes.push({ kind: 'price', action: 'create', id: rp.id, reason: dry ? 'dryRun' : undefined })
          continue
        }

        const immutableDiff =
          String(match.currency || '') !== currency ||
          Number(match.unit_amount) !== unitAmount ||
          (match.recurring_interval ?? null) !== (recurringInterval ?? null) ||
          (match.recurring_count ?? null) !== (recurringCount ?? null)

        if (immutableDiff) {
          counters.errors++
          notes.push({
            kind: 'price',
            action: 'error',
            id: rp.id,
            reason: 'immutable_mismatch',
            details: {
              local: { currency: match.currency, unit_amount: match.unit_amount, recurring_interval: match.recurring_interval, recurring_count: match.recurring_count },
              remote: { currency, unit_amount: unitAmount, recurring_interval: recurringInterval, recurring_count: recurringCount },
            },
          })
          continue
        }

        const group = await ensureRecurringGroup()
        const updates: Updateable<Database['catalog_prices']> = {}
        if (match.provider_price_id !== rp.id) updates.provider_price_id = rp.id
        if (match.status !== desiredStatus) updates.status = desiredStatus
        if (displayPriorityRemote !== null && Number(match.display_priority ?? 0) !== displayPriorityRemote) {
          updates.display_priority = displayPriorityRemote
        }
        if (group && String((match as unknown as { subscription_group_id?: string | null }).subscription_group_id || '') !== group.groupId) {
          updates.subscription_group_id = group.groupId
          updates.subscription_group_key = group.groupKey
        }
        if (JSON.stringify(match.metadata ?? {}) !== JSON.stringify(nextMeta ?? {})) {
          updates.metadata = nextMeta as unknown
        }

        const hasUpdate = Object.keys(updates).length > 0
        if (!hasUpdate) {
          counters.prices.skipped++
          notes.push({ kind: 'price', action: 'skip', id: rp.id, reason: 'nochange' })
          continue
        }
        if (!dry) {
          await db.updateTable('catalog_prices').set(updates).where('catalog_price_id', '=', match.catalog_price_id).execute()
        }
        counters.prices.updated++
        notes.push({ kind: 'price', action: 'update', id: rp.id, reason: dry ? 'dryRun' : undefined })
      }
    }

    const finishedAt = new Date().toISOString()
    return {
      startedAt,
      finishedAt,
      counters,
      notes,
      suggestions: [
        'Ensure Stripe Products/Prices include metadata.realm_id plus product_code/price_code to link to seeded catalog rows.',
        'Review any immutable_mismatch errors; fix by creating new local codes or adjusting Stripe objects.',
      ],
    }
  }

  async refundPayment(_ctx: ProviderOpContext, _p: unknown): Promise<unknown> {
    // TODO
    return { ok: true }
  }

  async createCheckoutSession(
    ctx: ProviderOpContext,
    p: {
      billingAccountId: string
      principalId?: string
      items: Array<{ catalogPriceId?: string; priceId?: string; quantity: number }>
      successUrl: string
      cancelUrl: string
      metadata?: Record<string, unknown>
    },
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    const runtime = await this.runtime(ctx)
    const stripe = runtime.client
    const realmId = runtime.realmId
    if (!Array.isArray(p.items) || p.items.length === 0) throw new Error('No items')
    const db = ctx.db as Kysely<Database> | undefined
    if (!db) throw new Error('DB handle missing')

    // Resolve Stripe price ids and detect mode
    const lineItems: { price: string; quantity: number }[] = []
    let hasRecurring = false
    // Ensure provider customer exists (creates if missing)
    const providerCustomerId = await this.retrieveCustomer(ctx, { billingAccountId: p.billingAccountId, principalId: p.principalId })

    for (const it of p.items) {
      const qty = Math.max(1, Number(it.quantity || 1))
      if (it.catalogPriceId) {
        const row = await db
          .selectFrom('catalog_prices')
          .select(['provider_price_id', 'recurring_interval'])
          .where('catalog_price_id', '=', it.catalogPriceId)
          .executeTakeFirst()
        if (!row || !row.provider_price_id) throw new Error(`catalog_price_id ${it.catalogPriceId} not linked to provider price`)
        lineItems.push({ price: row.provider_price_id, quantity: qty })
        if (row.recurring_interval) hasRecurring = true
      } else if (it.priceId) {
        lineItems.push({ price: it.priceId, quantity: qty })
        // Best effort: fetch price to detect recurring
        try {
          const pr = await callStripe(() => stripe.prices.retrieve(it.priceId as string), { op: 'prices.retrieve', traceId: ctx.traceId })
          if (pr.recurring) hasRecurring = true
        } catch {}
      } else {
        throw new Error('Item must have catalogPriceId or priceId')
      }
    }

    const mode: 'payment' | 'subscription' = hasRecurring ? 'subscription' : 'payment'
    const idempotencyKey = ctx.idempotencyKey || idemKey(['co', p.billingAccountId, ...lineItems.map((li) => `${li.price}:${li.quantity}`), mode])

    const metadata: Stripe.MetadataParam = {
      realm_id: realmId,
      billing_account_id: p.billingAccountId,
      ...(p.metadata as Stripe.MetadataParam | undefined),
    }
    if (p.principalId) metadata.principal_id = p.principalId

    const session = await callStripe<Stripe.Checkout.Session>(
      () =>
        stripe.checkout.sessions.create(
          {
            mode,
            success_url: p.successUrl,
            cancel_url: p.cancelUrl,
            line_items: lineItems,
            customer: providerCustomerId,
            client_reference_id: p.billingAccountId,
            metadata,
          },
          { idempotencyKey },
        ),
      { op: 'checkout.sessions.create', traceId: ctx.traceId },
    )

    // Upsert mapping if session has a customer
    const sessCustomerId = typeof session.customer === 'string' ? (session.customer as string) : session.customer?.id
    if (sessCustomerId && p.billingAccountId && providerCustomerId !== sessCustomerId) {
      await db
        .insertInto('provider_customers')
        .values({
          billing_account_id: p.billingAccountId,
          provider: 'stripe',
          provider_customer_id: sessCustomerId,
        })
        .onConflict((oc) =>
          oc.columns(['billing_account_id', 'provider']).doUpdateSet({ provider_customer_id: sessCustomerId, updated_at: new Date() }),
        )
        .execute()
    }

    return { checkoutUrl: session.url!, sessionId: session.id }
  }

  async createPortalSession(
    ctx: ProviderOpContext,
    p: { billingAccountId: string; principalId?: string; returnUrl: string },
  ): Promise<{ portalUrl: string; sessionId: string }> {
    const runtime = await this.runtime(ctx)
    const stripe = runtime.client
    const customerId = await this.retrieveCustomer(ctx, { billingAccountId: p.billingAccountId, principalId: p.principalId })

    const session = await callStripe<Stripe.BillingPortal.Session>(
      () => stripe.billingPortal.sessions.create({ customer: customerId, return_url: p.returnUrl }),
      { op: 'billingPortal.sessions.create', traceId: ctx.traceId },
    )

    return { portalUrl: session.url, sessionId: session.id }
  }

  private async listAllStripeProducts(stripe: Stripe): Promise<Stripe.Product[]> {
    const out: Stripe.Product[] = []
    let startingAfter: string | undefined
    while (true) {
      const page = await callStripe(
        async () => stripe.products.list({ limit: 100, starting_after: startingAfter }),
        { op: 'products.list' },
      )
      out.push(...page.data)
      if (!page.has_more || page.data.length === 0) break
      startingAfter = page.data[page.data.length - 1]!.id
    }
    return out
  }

  private async listAllStripePrices(stripe: Stripe): Promise<Stripe.Price[]> {
    const out: Stripe.Price[] = []
    let startingAfter: string | undefined
    while (true) {
      const page = await callStripe(
        async () => stripe.prices.list({ limit: 100, starting_after: startingAfter, expand: ['data.product'] }),
        { op: 'prices.list' },
      )
      out.push(...page.data)
      if (!page.has_more || page.data.length === 0) break
      startingAfter = page.data[page.data.length - 1]!.id
    }
    return out
  }

  async sendInvoice(
    ctx: ProviderOpContext,
    p: {
      billingAccountId: string
      billingInvoiceId: string
      invoiceNumber: string
      currency: string
      dueAt?: Date | null
      lines: Array<{ description: string; amountMinor: string; currency: string; metadata?: Record<string, unknown> }>
      metadata?: Record<string, unknown>
      finalize?: boolean
    },
  ): Promise<{
    providerInvoiceId: string
    providerCustomerId?: string
    hostedInvoiceUrl?: string
    status?: string
    rawProviderPayload?: Record<string, unknown>
  }> {
    const runtime = await this.runtime(ctx)
    const stripe = runtime.client
    const traceId = ctx.traceId || newTraceId()
    const db = ctx.db as Kysely<Database> | undefined
    if (!db) throw new Error('DB handle missing')

    const providerCustomerId = await this.retrieveCustomer(ctx, {
      billingAccountId: p.billingAccountId,
      metadata: p.metadata,
    })

    const invoiceCreateKey = idemKey(['inv', p.billingInvoiceId, 'create'])
    const createdInvoice = await callStripe(
      async () =>
        stripe.invoices.create(
          {
            customer: providerCustomerId,
            collection_method: 'send_invoice',
            ...(p.dueAt ? { due_date: Math.floor(p.dueAt.getTime() / 1000) } : {}),
            auto_advance: false,
            metadata: {
              realm_id: runtime.realmId,
              billing_account_id: p.billingAccountId,
              billing_invoice_id: p.billingInvoiceId,
              invoice_number: p.invoiceNumber,
            },
          },
          { idempotencyKey: invoiceCreateKey },
        ),
      { op: 'invoices.create', traceId },
    )

    for (let i = 0; i < p.lines.length; i++) {
      const line = p.lines[i]
      const amount = Number.parseInt(line.amountMinor, 10)
      if (!Number.isFinite(amount) || amount <= 0) continue
      const itemKey = idemKey(['inv', p.billingInvoiceId, 'item', i, amount, line.currency])
      await callStripe(
        async () =>
          stripe.invoiceItems.create(
            {
              customer: providerCustomerId,
              invoice: createdInvoice.id,
              currency: line.currency.toLowerCase(),
              amount,
              description: line.description,
              metadata: {
                billing_invoice_id: p.billingInvoiceId,
                ...(line.metadata || {}),
              },
            },
            { idempotencyKey: itemKey },
          ),
        { op: 'invoiceItems.create', traceId },
      )
    }

    const finalize = p.finalize !== false
    const finalizedInvoice = finalize
      ? await callStripe(
        async () =>
          stripe.invoices.finalizeInvoice(createdInvoice.id, {}, { idempotencyKey: idemKey(['inv', p.billingInvoiceId, 'finalize']) }),
        { op: 'invoices.finalizeInvoice', traceId },
      )
      : createdInvoice

    return {
      providerInvoiceId: finalizedInvoice.id,
      providerCustomerId,
      hostedInvoiceUrl: (finalizedInvoice as unknown as { hosted_invoice_url?: string | null }).hosted_invoice_url ?? undefined,
      status: (finalizedInvoice as unknown as { status?: string | null }).status ?? undefined,
      rawProviderPayload: (finalizedInvoice as unknown as Record<string, unknown>) ?? undefined,
    }
  }
}
