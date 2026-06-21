import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common'
import { sql } from 'kysely'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { Scopes } from '../../../auth/decorators/scopes.decorator.js'
import { BILLING_SCOPES } from '../../../auth/constants/scopes.constants.js'
import { PrincipalGuard } from '../../../auth/guards/principal.guard.js'
import { BillingAccountGuard } from '../../../auth/guards/billing-account.guard.js'
import { okEnvelope, errEnvelope } from '../../../common/envelope.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { operations as BillingOps, components as BillingComponents } from '../../../contracts/billing.js'
import { JsonResponse, PathParams, QueryParams } from '../../../contracts/openapi-helpers.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { ServiceAccountGuard } from '../../../auth/guards/service-account.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import { allowCrossAccountAccess } from '../../../auth/utils/access.js'

// OpenAPI mapping: tag=Subscriptions
// Path: GET /subscriptions (operationId: listSubscriptions)

type ListSubsQuery = QueryParams<BillingOps, 'listSubscriptions'>
type ListSubs200 = JsonResponse<BillingOps, 'listSubscriptions', 200>
type GetSubQuery = QueryParams<BillingOps, 'getSubscription'>
type GetSubParams = PathParams<BillingOps, 'getSubscription'>
type GetSub200 = JsonResponse<BillingOps, 'getSubscription', 200>

abstract class SubscriptionsControllerBase {
  protected async handleListSubscriptions(req: AppRequest, q: ListSubsQuery): Promise<ListSubs200> {
    const ctxBa: string | undefined = req?.ctx?.billingAccountId
    const reqBa: string = String(q?.billing_account_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListSubs200
    }
    if (!allowCrossAccount && !targetBa) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListSubs200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as ListSubs200
    }

    const limit = clampLimit(q?.limit)
    const cursor = parseCursor(q?.cursor)
    const expandRaw = q?.expand
    const expandValues = Array.isArray(expandRaw)
      ? expandRaw
      : typeof expandRaw === 'string'
        ? [expandRaw]
        : []
    const expandSet = new Set<string>(expandValues as string[])
    const includeCatalogPrice = expandSet.has('items.catalog_price')

    let baseQuery = db
      .selectFrom('subscriptions as cs')
      .leftJoin('provider_subscription_links as psl', 'psl.subscription_id', 'cs.subscription_id')
      .select([
        'cs.subscription_id as cs_id',
        'cs.billing_account_id as cs_billing_account_id',
        'cs.status as cs_status',
        'cs.quantity as cs_quantity',
        'cs.current_period_start as cs_current_period_start',
        'cs.current_period_end as cs_current_period_end',
        'cs.cancel_at as cs_cancel_at',
        'cs.cancel_at_period_end as cs_cancel_at_period_end',
        'cs.created_at as cs_created_at',
        'cs.updated_at as cs_updated_at',
        'psl.external_subscription_id as external_subscription_id',
      ])
      .orderBy('cs.created_at', 'desc')
      .orderBy('cs.subscription_id', 'desc')
      .limit(limit + 1)
    if (targetBa) {
      baseQuery = baseQuery.where('cs.billing_account_id', '=', targetBa)
    }

    if (q?.status) {
      baseQuery = baseQuery.where('cs.status', '=', q.status)
    }
    if (q?.q) {
      const like = `%${q.q}%`
      baseQuery = baseQuery.where((eb) =>
        eb.or([
          eb(sql`cs.subscription_id::text`, 'ilike', like),
          eb('psl.external_subscription_id', 'ilike', like),
        ]),
      )
    }
    if (cursor) {
      baseQuery = baseQuery.where((eb) =>
        eb.or([
          eb('cs.created_at', '<', cursor.createdAt),
          eb.and([eb('cs.created_at', '=', cursor.createdAt), eb('cs.subscription_id', '<', cursor.id)]),
        ]),
      )
    }

    const subsRows = await baseQuery.execute()
    const windowRows = subsRows.slice(0, limit)
    const subIds = windowRows.map((r) => r.cs_id)

    const itemRows = subIds.length
      ? await db
          .selectFrom('subscription_items as csi')
          .leftJoin('catalog_prices as cp', 'cp.catalog_price_id', 'csi.catalog_price_id')
          .select([
            'csi.subscription_id as cs_id',
            'csi.catalog_price_id as cp_id',
            'csi.quantity as csi_quantity',
            'cp.catalog_product_id as cp_catalog_product_id',
            'cp.provider_price_id as cp_provider_price_id',
            'cp.currency as cp_currency',
            'cp.unit_amount as cp_unit_amount',
            'cp.recurring_interval as cp_recurring_interval',
            'cp.recurring_count as cp_recurring_count',
            'cp.display_priority as cp_display_priority',
            'cp.metadata as cp_metadata',
          ])
          .where('csi.subscription_id', 'in', subIds)
          .execute()
      : []

    const itemsBySub = new Map<string, typeof itemRows>()
    for (const row of itemRows) {
      const list = itemsBySub.get(row.cs_id) || []
      list.push(row)
      itemsBySub.set(row.cs_id, list)
    }

    const subscriptions: BillingComponents['schemas']['Subscription'][] = windowRows.map((row) => {
      const subId = String(row.cs_id)
      const itemList = itemsBySub.get(row.cs_id) || []
      const currencies = new Set<string>()
      const items: NonNullable<BillingComponents['schemas']['Subscription']['items']> = itemList.map((item) => {
        if (item.cp_currency) currencies.add(String(item.cp_currency))
        const qtyNum = Number(item.csi_quantity ?? 1)
        const quantity = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1
        const catalogPrice = includeCatalogPrice &&
          item.cp_id &&
          item.cp_catalog_product_id &&
          item.cp_provider_price_id &&
          item.cp_currency
          ? {
              catalog_price_id: String(item.cp_id),
              catalog_product_id: String(item.cp_catalog_product_id),
              provider_price_id: String(item.cp_provider_price_id),
              currency: String(item.cp_currency),
              unit_amount: Number(item.cp_unit_amount ?? 0),
              recurring_interval: (item.cp_recurring_interval as 'month' | 'year' | null) ?? null,
              recurring_count: item.cp_recurring_count ?? null,
              display_priority: item.cp_display_priority ?? 0,
            }
          : undefined
        return {
          subscription_item_id: item.cp_id ? String(item.cp_id) : undefined,
          price_id: item.cp_provider_price_id ? String(item.cp_provider_price_id) : undefined,
          quantity,
          catalog_price_id: item.cp_id ? String(item.cp_id) : undefined,
          catalog_price: catalogPrice,
        }
      })

      const currency = Array.from(currencies)[0]
      const qtyNum = Number(row.cs_quantity)
      const subscriptionQuantity = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1

      return {
        subscription_id: subId,
        billing_account_id: String(row.cs_billing_account_id),
        external_subscription_id: row.external_subscription_id ?? null,
        status: (row.cs_status as BillingComponents['schemas']['Subscription']['status']) || undefined,
        display_currency_code: currency,
        settlement_currency_code: currency,
        current_period_start: toIso(row.cs_current_period_start),
        current_period_end: toIso(row.cs_current_period_end),
        created_at: toIso(row.cs_created_at),
        updated_at: toIso(row.cs_updated_at),
        items,
        subscription_group_id: undefined,
        quantity: subscriptionQuantity,
      }
    })

    const hasMore = subsRows.length > limit
    const nextCursor = hasMore ? encodeCursor(subsRows[limit].cs_created_at, subsRows[limit].cs_id) : null
    return okEnvelope(subscriptions, { meta: { next_cursor: nextCursor, has_more: hasMore, limit } }) as ListSubs200
  }

  protected async handleGetSubscription(req: AppRequest, params: GetSubParams, q: GetSubQuery): Promise<GetSub200> {
    const ctxBa: string | undefined = req?.ctx?.billingAccountId
    const reqBa: string = String(q?.billing_account_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetSub200
    }
    if (!allowCrossAccount && !targetBa) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetSub200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as GetSub200
    }
    const expandRaw = q?.expand
    const expandValues = Array.isArray(expandRaw)
      ? expandRaw
      : typeof expandRaw === 'string'
        ? [expandRaw]
        : []
    const expandSet = new Set<string>(expandValues as string[])
    const includeCatalogPrice = expandSet.has('items.catalog_price')

    let query = db
      .selectFrom('subscriptions as cs')
      .leftJoin('provider_subscription_links as psl', 'psl.subscription_id', 'cs.subscription_id')
      .select([
        'cs.subscription_id as cs_id',
        'cs.billing_account_id as cs_billing_account_id',
        'cs.status as cs_status',
        'cs.quantity as cs_quantity',
        'cs.current_period_start as cs_current_period_start',
        'cs.current_period_end as cs_current_period_end',
        'cs.cancel_at as cs_cancel_at',
        'cs.cancel_at_period_end as cs_cancel_at_period_end',
        'cs.created_at as cs_created_at',
        'cs.updated_at as cs_updated_at',
        'psl.external_subscription_id as external_subscription_id',
      ])
      .where(sql`cs.subscription_id::text`, '=', String(params.subscription_id))
    if (targetBa) {
      query = query.where('cs.billing_account_id', '=', targetBa)
    }
    const row = await query.executeTakeFirst()

    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'subscription not found' }) as unknown as GetSub200
    }

    const itemRows = await db
      .selectFrom('subscription_items as csi')
      .leftJoin('catalog_prices as cp', 'cp.catalog_price_id', 'csi.catalog_price_id')
      .select([
        'csi.subscription_id as cs_id',
        'csi.catalog_price_id as cp_id',
        'csi.quantity as csi_quantity',
        'cp.catalog_product_id as cp_catalog_product_id',
        'cp.provider_price_id as cp_provider_price_id',
        'cp.currency as cp_currency',
        'cp.unit_amount as cp_unit_amount',
        'cp.recurring_interval as cp_recurring_interval',
        'cp.recurring_count as cp_recurring_count',
        'cp.display_priority as cp_display_priority',
        'cp.metadata as cp_metadata',
      ])
      .where('csi.subscription_id', '=', row.cs_id)
      .execute()

    const currencies = new Set<string>()
    const items: NonNullable<BillingComponents['schemas']['Subscription']['items']> = itemRows.map((item) => {
      if (item.cp_currency) currencies.add(String(item.cp_currency))
      const qtyNum = Number(item.csi_quantity ?? 1)
      const quantity = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1
      const catalogPrice = includeCatalogPrice &&
        item.cp_id &&
        item.cp_catalog_product_id &&
        item.cp_provider_price_id &&
        item.cp_currency
        ? {
            catalog_price_id: String(item.cp_id),
            catalog_product_id: String(item.cp_catalog_product_id),
            provider_price_id: String(item.cp_provider_price_id),
            currency: String(item.cp_currency),
            unit_amount: Number(item.cp_unit_amount ?? 0),
            recurring_interval: (item.cp_recurring_interval as 'month' | 'year' | null) ?? null,
            recurring_count: item.cp_recurring_count ?? null,
            display_priority: item.cp_display_priority ?? 0,
          }
        : undefined
      return {
        subscription_item_id: item.cp_id ? String(item.cp_id) : undefined,
        price_id: item.cp_provider_price_id ? String(item.cp_provider_price_id) : undefined,
        quantity,
        catalog_price_id: item.cp_id ? String(item.cp_id) : undefined,
        catalog_price: catalogPrice,
      }
    })

    const currency = Array.from(currencies)[0]
    const qtyNum = Number(row.cs_quantity)
    const subscriptionQuantity = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1

    const subscription: BillingComponents['schemas']['Subscription'] = {
      subscription_id: String(row.cs_id),
      billing_account_id: String(row.cs_billing_account_id),
      external_subscription_id: row.external_subscription_id ?? null,
      status: (row.cs_status as BillingComponents['schemas']['Subscription']['status']) || undefined,
      display_currency_code: currency,
      settlement_currency_code: currency,
      current_period_start: toIso(row.cs_current_period_start),
      current_period_end: toIso(row.cs_current_period_end),
      created_at: toIso(row.cs_created_at),
      updated_at: toIso(row.cs_updated_at),
      items,
      subscription_group_id: undefined,
      quantity: subscriptionQuantity,
    }

    return okEnvelope(subscription) as GetSub200
  }
}

@Controller('subscriptions')
@UseGuards(RealmGuard, TokenClaimsGuard, RealmMembershipGuard, PrincipalGuard, BillingAccountGuard)
export class SubscriptionsPublicController extends SubscriptionsControllerBase {
  @Get()
  @Scopes(BILLING_SCOPES.READ_ALL)
  async listSubscriptions(@Req() req: AppRequest, @Query() q: ListSubsQuery): Promise<ListSubs200> {
    return this.handleListSubscriptions(req, q)
  }

  @Get(':subscription_id')
  @Scopes(BILLING_SCOPES.READ_ALL)
  async getSubscription(
    @Req() req: AppRequest,
    @Param() params: GetSubParams,
    @Query() q: GetSubQuery,
  ): Promise<GetSub200> {
    return this.handleGetSubscription(req, params, q)
  }
}

@Controller('subscriptions')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, ServiceAccountGuard, PrincipalGuard, BillingAccountGuard)
export class SubscriptionsServiceController extends SubscriptionsControllerBase {
  @Get()
  async listSubscriptions(@Req() req: AppRequest, @Query() q: ListSubsQuery): Promise<ListSubs200> {
    return this.handleListSubscriptions(req, q)
  }

  @Get(':subscription_id')
  async getSubscription(
    @Req() req: AppRequest,
    @Param() params: GetSubParams,
    @Query() q: GetSubQuery,
  ): Promise<GetSub200> {
    return this.handleGetSubscription(req, params, q)
  }
}

function clampLimit(raw: unknown, fallback = 50, max = 100): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.trunc(n), max)
}

function parseCursor(cursor?: string | null): { createdAt: Date; id: string } | null {
  if (!cursor) return null
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as { t: string; id: string }
    const dt = new Date(parsed.t)
    if (Number.isNaN(dt.getTime())) return null
    if (!parsed.id || typeof parsed.id !== 'string') return null
    return { createdAt: dt, id: parsed.id }
  } catch {
    return null
  }
}

function encodeCursor(createdAt: Date | string, id: unknown): string {
  const t = createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString()
  const payload = { t, id: String(id) }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function toIso(value: unknown): string | undefined {
  if (!value) return undefined
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  if (typeof value === 'number') return new Date(value).toISOString()
  try {
    return new Date(value as Date).toISOString()
  } catch {
    return undefined
  }
}
