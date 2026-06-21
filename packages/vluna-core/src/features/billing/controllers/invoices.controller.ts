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

// OpenAPI mapping: tag=Invoices
// Path: GET /invoices (operationId: listInvoices)

type ListInvoicesQuery = QueryParams<BillingOps, 'listInvoices'>
type ListInvoices200 = JsonResponse<BillingOps, 'listInvoices', 200>
type GetInvoiceQuery = QueryParams<BillingOps, 'getInvoice'>
type GetInvoiceParams = PathParams<BillingOps, 'getInvoice'>
type GetInvoice200 = JsonResponse<BillingOps, 'getInvoice', 200>

abstract class InvoicesControllerBase {
  protected async handleListInvoices(req: AppRequest, q: ListInvoicesQuery): Promise<ListInvoices200> {
    const ctxBa: string | undefined = req?.ctx?.billingAccountId
    const reqBa: string = String(q?.billing_account_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListInvoices200
    }
    if (!allowCrossAccount && !targetBa) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListInvoices200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as ListInvoices200
    }

    const limit = clampLimit(q?.limit)
    const cursor = parseCursor(q?.cursor)

    let query = db
      .selectFrom('billing_invoices as bi')
      .select([
        'bi.billing_invoice_id',
        'bi.billing_account_id',
        'bi.invoice_number',
        'bi.provider_invoice_id',
        'bi.status',
        'bi.total_minor',
        'bi.currency',
        'bi.created_at',
        'bi.updated_at',
        'bi.hosted_invoice_url',
        'bi.raw_provider_payload',
      ])
      .orderBy('bi.created_at', 'desc')
      .orderBy('bi.billing_invoice_id', 'desc')
      .limit(limit + 1)
    if (targetBa) {
      query = query.where('bi.billing_account_id', '=', targetBa)
    }

    if (q?.status) {
      query = query.where('bi.status', '=', q.status)
    }
    if (q?.subscription_id) {
      query = query.where(sql`bi.subscription_id::text`, '=', String(q.subscription_id))
    }
    if (q?.q) {
      const like = `%${q.q}%`
      query = query.where((eb) =>
        eb.or([
          eb('bi.invoice_number', 'ilike', like),
          eb('bi.provider_invoice_id', 'ilike', like),
          eb(sql`bi.billing_invoice_id::text`, 'ilike', like),
        ]),
      )
    }
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb('bi.created_at', '<', cursor.createdAt),
          eb.and([eb('bi.created_at', '=', cursor.createdAt), eb('bi.billing_invoice_id', '<', cursor.id)]),
        ]),
      )
    }

    const rows = await query.execute()

    const invoices: BillingComponents['schemas']['Invoice'][] = rows.slice(0, limit).map((row) => {
      const amountTotal = toInt(row.total_minor)
      const status = row.status as BillingComponents['schemas']['Invoice']['status']
      const isPaid = status === 'paid'
      const hostedUrl = row.hosted_invoice_url ?? extractHostedInvoiceUrl(row.raw_provider_payload)
      return {
        invoice_id: String(row.billing_invoice_id),
        billing_account_id: String(row.billing_account_id),
        status,
        amount_due: amountTotal,
        amount_paid: isPaid ? amountTotal : 0,
        amount_remaining: isPaid ? 0 : amountTotal,
        currency: row.currency,
        hosted_invoice_url: hostedUrl ?? undefined,
        created_at: toIso(row.created_at),
        updated_at: toIso(row.updated_at),
      }
    })

    const hasMore = rows.length > limit
    const nextCursor = hasMore ? encodeCursor(rows[limit].created_at, rows[limit].billing_invoice_id) : null
    return okEnvelope(invoices, { meta: { next_cursor: nextCursor, has_more: hasMore, limit } }) as ListInvoices200
  }

  protected async handleGetInvoice(req: AppRequest, params: GetInvoiceParams, q: GetInvoiceQuery): Promise<GetInvoice200> {
    const ctxBa: string | undefined = req?.ctx?.billingAccountId
    const reqBa: string = String(q?.billing_account_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetInvoice200
    }
    if (!allowCrossAccount && !targetBa) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetInvoice200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as GetInvoice200
    }

    let query = db
      .selectFrom('billing_invoices as bi')
      .select([
        'bi.billing_invoice_id',
        'bi.billing_account_id',
        'bi.invoice_number',
        'bi.status',
        'bi.subtotal_minor',
        'bi.tax_minor',
        'bi.total_minor',
        'bi.currency',
        'bi.period_start',
        'bi.period_end',
        'bi.due_at',
        'bi.finalized_at',
        'bi.paid_at',
        'bi.canceled_at',
        'bi.created_at',
        'bi.updated_at',
        'bi.hosted_invoice_url',
        'bi.raw_provider_payload',
      ])
      .where(sql`bi.billing_invoice_id::text`, '=', String(params.invoice_id))
    if (targetBa) {
      query = query.where('bi.billing_account_id', '=', targetBa)
    }
    const row = await query.executeTakeFirst()

    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'invoice not found' }) as unknown as GetInvoice200
    }

    const expandRaw = q?.expand
    const expandValues = Array.isArray(expandRaw)
      ? expandRaw
      : typeof expandRaw === 'string'
        ? [expandRaw]
        : []
    const expandSet = new Set<string>(expandValues as string[])
    const includeCatalogPrice = expandSet.has('line_items.catalog_price')

    const lineRows = await db
      .selectFrom('billing_invoice_lines as bil')
      .leftJoin('catalog_prices as cp', (join) =>
        join.onRef('cp.catalog_price_id', '=', 'bil.catalog_price_id'),
      )
      .select([
        'bil.line_kind',
        'bil.description',
        'bil.quantity',
        'bil.unit_amount_minor',
        'bil.total_amount_minor',
        'bil.catalog_price_id',
        'bil.meter_code',
        'cp.catalog_product_id as cp_catalog_product_id',
        'cp.provider_price_id as cp_provider_price_id',
        'cp.currency as cp_currency',
        'cp.unit_amount as cp_unit_amount',
        'cp.recurring_interval as cp_recurring_interval',
        'cp.recurring_count as cp_recurring_count',
        'cp.display_priority as cp_display_priority',
      ])
      .where('bil.billing_invoice_id', '=', row.billing_invoice_id)
      .orderBy('bil.billing_invoice_line_id', 'asc')
      .execute()

    const status = row.status as BillingComponents['schemas']['Invoice']['status']
    const amountTotal = toInt(row.total_minor)
    const isPaid = status === 'paid'
    const hostedUrl = row.hosted_invoice_url ?? extractHostedInvoiceUrl(row.raw_provider_payload)

    const invoice: BillingComponents['schemas']['InvoiceDetail'] = {
      invoice_id: String(row.billing_invoice_id),
      billing_account_id: String(row.billing_account_id),
      invoice_number: row.invoice_number ?? undefined,
      status,
      amount_due: amountTotal,
      amount_paid: isPaid ? amountTotal : 0,
      amount_remaining: isPaid ? 0 : amountTotal,
      currency: row.currency,
      hosted_invoice_url: hostedUrl ?? undefined,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
      subtotal: toInt(row.subtotal_minor),
      tax: toInt(row.tax_minor),
      total: amountTotal,
      period_start: toIso(row.period_start),
      period_end: toIso(row.period_end),
      due_at: toIso(row.due_at),
      finalized_at: toIso(row.finalized_at),
      paid_at: toIso(row.paid_at),
      canceled_at: toIso(row.canceled_at),
      line_items: lineRows.map((line) => {
        const catalogPrice = includeCatalogPrice &&
          line.catalog_price_id &&
          line.cp_catalog_product_id &&
          line.cp_provider_price_id &&
          line.cp_currency
          ? {
              catalog_price_id: String(line.catalog_price_id),
              catalog_product_id: String(line.cp_catalog_product_id),
              provider_price_id: String(line.cp_provider_price_id),
              currency: String(line.cp_currency),
              unit_amount: Number(line.cp_unit_amount ?? 0),
              recurring_interval: (line.cp_recurring_interval as 'month' | 'year' | null) ?? null,
              recurring_count: line.cp_recurring_count ?? null,
              display_priority: line.cp_display_priority ?? 0,
            }
          : undefined
        return {
          line_kind: line.line_kind as BillingComponents['schemas']['InvoiceLineItem']['line_kind'],
          description: line.description ?? undefined,
          quantity: toInt(line.quantity, 1),
          unit_amount: toInt(line.unit_amount_minor),
          total_amount: toInt(line.total_amount_minor),
          catalog_price_id: line.catalog_price_id ? String(line.catalog_price_id) : null,
          meter_code: line.meter_code ?? null,
          catalog_price: catalogPrice,
        }
      }),
    }

    return okEnvelope(invoice) as GetInvoice200
  }
}

@Controller('invoices')
@UseGuards(RealmGuard, TokenClaimsGuard, RealmMembershipGuard, PrincipalGuard, BillingAccountGuard)
export class InvoicesPublicController extends InvoicesControllerBase {
  @Get()
  @Scopes(BILLING_SCOPES.READ_ALL)
  async listInvoices(@Req() req: AppRequest, @Query() q: ListInvoicesQuery): Promise<ListInvoices200> {
    return this.handleListInvoices(req, q)
  }

  @Get(':invoice_id')
  @Scopes(BILLING_SCOPES.READ_ALL)
  async getInvoice(
    @Req() req: AppRequest,
    @Param() params: GetInvoiceParams,
    @Query() q: GetInvoiceQuery,
  ): Promise<GetInvoice200> {
    return this.handleGetInvoice(req, params, q)
  }
}

@Controller('invoices')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, ServiceAccountGuard, PrincipalGuard, BillingAccountGuard)
export class InvoicesServiceController extends InvoicesControllerBase {
  @Get()
  async listInvoices(@Req() req: AppRequest, @Query() q: ListInvoicesQuery): Promise<ListInvoices200> {
    return this.handleListInvoices(req, q)
  }

  @Get(':invoice_id')
  async getInvoice(
    @Req() req: AppRequest,
    @Param() params: GetInvoiceParams,
    @Query() q: GetInvoiceQuery,
  ): Promise<GetInvoice200> {
    return this.handleGetInvoice(req, params, q)
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
  try {
    return new Date(value as Date).toISOString()
  } catch {
    return undefined
  }
}

function toInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'bigint' ? Number(value) : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function extractHostedInvoiceUrl(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const direct = obj['hosted_invoice_url']
  if (typeof direct === 'string' && direct.trim()) return direct
  const invoice = obj['invoice'] as Record<string, unknown> | undefined
  const nested = invoice?.['hosted_invoice_url']
  if (typeof nested === 'string' && nested.trim()) return nested
  return undefined
}
