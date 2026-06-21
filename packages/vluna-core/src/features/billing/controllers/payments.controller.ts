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
import type { Database } from '../../../types/database.js'
import type { operations as BillingOps, components as BillingComponents } from '../../../contracts/billing.js'
import { JsonResponse, PathParams, QueryParams } from '../../../contracts/openapi-helpers.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { ServiceAccountGuard } from '../../../auth/guards/service-account.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import { allowCrossAccountAccess } from '../../../auth/utils/access.js'

// OpenAPI mapping: tag=Payments
// Path: GET /payments (operationId: listPayments)

type ListPaymentsQuery = QueryParams<BillingOps, 'listPayments'>
type ListPayments200 = JsonResponse<BillingOps, 'listPayments', 200>
type GetPaymentQuery = QueryParams<BillingOps, 'getPayment'>
type GetPaymentParams = PathParams<BillingOps, 'getPayment'>
type GetPayment200 = JsonResponse<BillingOps, 'getPayment', 200>
type PaymentStatus = Database['billing_payments']['status']

abstract class PaymentsControllerBase {
  protected async handleListPayments(req: AppRequest, q: ListPaymentsQuery): Promise<ListPayments200> {
    const ctxBa: string | undefined = req?.ctx?.billingAccountId
    const reqBa: string = String(q?.billing_account_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListPayments200
    }
    if (!allowCrossAccount && !targetBa) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListPayments200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as ListPayments200
    }

    const limit = clampLimit(q?.limit)
    const cursor = parseCursor(q?.cursor)

    let query = db
      .selectFrom('billing_payments as bp')
      .leftJoin('billing_invoices as bi', (join) =>
        join
          .onRef('bi.billing_invoice_id', '=', 'bp.billing_invoice_id')
          .onRef('bi.billing_account_id', '=', 'bp.billing_account_id'),
      )
      .select([
        'bp.billing_payment_id',
        'bp.billing_account_id',
        'bi.billing_invoice_id as internal_invoice_id',
        'bp.status',
        'bp.amount_minor',
        'bp.currency',
        'bp.occurred_at',
        'bp.updated_at',
      ])
      .orderBy('bp.occurred_at', 'desc')
      .orderBy('bp.billing_payment_id', 'desc')
      .limit(limit + 1)
    if (targetBa) {
      query = query.where('bp.billing_account_id', '=', targetBa)
    }

    if (q?.invoice_id) {
      query = query.where(sql`bp.billing_invoice_id::text`, '=', String(q.invoice_id))
    }
    if (q?.status) {
      const statuses = resolvePaymentStatuses(q.status)
      if (statuses.length > 0) {
        query = query.where('bp.status', 'in', statuses)
      }
    }
    if (q?.q) {
      const like = `%${q.q}%`
      query = query.where((eb) =>
        eb.or([
          eb(sql`bp.billing_payment_id::text`, 'ilike', like),
          eb('bp.provider_payment_id', 'ilike', like),
        ]),
      )
    }
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb('bp.occurred_at', '<', cursor.createdAt),
          eb.and([eb('bp.occurred_at', '=', cursor.createdAt), eb('bp.billing_payment_id', '<', cursor.id)]),
        ]),
      )
    }

    const rows = await query.execute()

    const payments: BillingComponents['schemas']['Payment'][] = rows.slice(0, limit).map((row) => {
      return {
        payment_id: String(row.billing_payment_id),
        invoice_id: row.internal_invoice_id ? String(row.internal_invoice_id) : null,
        billing_account_id: String(row.billing_account_id),
        status: mapPaymentStatus(row.status),
        amount: toInt(row.amount_minor),
        currency: row.currency,
        created_at: toIso(row.occurred_at),
        updated_at: toIso(row.updated_at),
      }
    })

    const hasMore = rows.length > limit
    const nextCursor = hasMore ? encodeCursor(rows[limit].occurred_at, rows[limit].billing_payment_id) : null
    return okEnvelope(payments, { meta: { next_cursor: nextCursor, has_more: hasMore, limit } }) as ListPayments200
  }

  protected async handleGetPayment(req: AppRequest, params: GetPaymentParams, q: GetPaymentQuery): Promise<GetPayment200> {
    const ctxBa: string | undefined = req?.ctx?.billingAccountId
    const reqBa: string = String(q?.billing_account_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetPayment200
    }
    if (!allowCrossAccount && !targetBa) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetPayment200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as GetPayment200
    }

    let query = db
      .selectFrom('billing_payments as bp')
      .leftJoin('billing_invoices as bi', (join) =>
        join
          .onRef('bi.billing_invoice_id', '=', 'bp.billing_invoice_id')
          .onRef('bi.billing_account_id', '=', 'bp.billing_account_id'),
      )
      .select([
        'bp.billing_payment_id',
        'bp.billing_account_id',
        'bi.billing_invoice_id as internal_invoice_id',
        'bp.status',
        'bp.amount_minor',
        'bp.currency',
        'bp.occurred_at',
        'bp.updated_at',
      ])
      .where(sql`bp.billing_payment_id::text`, '=', String(params.payment_id))
    if (targetBa) {
      query = query.where('bp.billing_account_id', '=', targetBa)
    }
    const row = await query.executeTakeFirst()

    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'payment not found' }) as unknown as GetPayment200
    }

    const payment: BillingComponents['schemas']['Payment'] = {
      payment_id: String(row.billing_payment_id),
      invoice_id: row.internal_invoice_id ? String(row.internal_invoice_id) : null,
      billing_account_id: String(row.billing_account_id),
      status: mapPaymentStatus(row.status),
      amount: toInt(row.amount_minor),
      currency: row.currency,
      created_at: toIso(row.occurred_at),
      updated_at: toIso(row.updated_at),
    }

    return okEnvelope(payment) as GetPayment200
  }
}

@Controller('payments')
@UseGuards(RealmGuard, TokenClaimsGuard, RealmMembershipGuard, PrincipalGuard, BillingAccountGuard)
export class PaymentsPublicController extends PaymentsControllerBase {
  @Get()
  @Scopes(BILLING_SCOPES.READ_ALL)
  async listPayments(@Req() req: AppRequest, @Query() q: ListPaymentsQuery): Promise<ListPayments200> {
    return this.handleListPayments(req, q)
  }

  @Get(':payment_id')
  @Scopes(BILLING_SCOPES.READ_ALL)
  async getPayment(
    @Req() req: AppRequest,
    @Param() params: GetPaymentParams,
    @Query() q: GetPaymentQuery,
  ): Promise<GetPayment200> {
    return this.handleGetPayment(req, params, q)
  }
}

@Controller('payments')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, ServiceAccountGuard, PrincipalGuard, BillingAccountGuard)
export class PaymentsServiceController extends PaymentsControllerBase {
  @Get()
  async listPayments(@Req() req: AppRequest, @Query() q: ListPaymentsQuery): Promise<ListPayments200> {
    return this.handleListPayments(req, q)
  }

  @Get(':payment_id')
  async getPayment(
    @Req() req: AppRequest,
    @Param() params: GetPaymentParams,
    @Query() q: GetPaymentQuery,
  ): Promise<GetPayment200> {
    return this.handleGetPayment(req, params, q)
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

function mapPaymentStatus(status: string | null | undefined): BillingComponents['schemas']['Payment']['status'] {
  if (!status) return 'pending'
  const s = status.toLowerCase()
  if (s === 'succeeded' || s === 'partially_refunded' || s === 'refunded') return 'succeeded'
  if (s === 'failed' || s === 'canceled') return 'failed'
  return 'pending'
}

function resolvePaymentStatuses(status: string): PaymentStatus[] {
  if (!status) return []
  const s = status.toLowerCase()
  if (s === 'succeeded') return ['succeeded', 'partially_refunded', 'refunded']
  if (s === 'failed') return ['failed', 'canceled']
  if (s === 'pending') {
    return [
      'requires_payment_method',
      'requires_confirmation',
      'requires_capture',
      'requires_action',
      'processing',
    ]
  }
  return [status as PaymentStatus]
}
