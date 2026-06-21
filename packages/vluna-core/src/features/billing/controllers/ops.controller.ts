import { Body, Controller, Delete, Get, HttpException, Param, Patch, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common'
import { sql, type ExpressionBuilder, type ReferenceExpression, type SelectQueryBuilder } from 'kysely'
import type { FastifyReply } from 'fastify'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { ServiceAccountGuard } from '../../../auth/guards/service-account.guard.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import { PrincipalGuard } from '../../../auth/guards/principal.guard.js'
import { BillingAccountGuard } from '../../../auth/guards/billing-account.guard.js'
import { okEnvelope, errEnvelope } from '../../../common/envelope.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { operations as OpsOps, components as OpsComponents } from '../../../contracts/ops.js'
import { JsonRequestBody, JsonResponse, PathParams, QueryParams } from '../../../contracts/openapi-helpers.js'
import { allowCrossAccountAccess } from '../../../auth/utils/access.js'
import { IdempotencyInterceptor } from '../../../support/idempotency.interceptor.js'
import { Audit } from '../../../support/audit/audit.decorator.js'
import { normalizeGrantBindingOverride } from '../../../services/grant-issuance.service.js'

// OpenAPI mapping: tag=Ops
// Path: GET /ops/reconciliations (operationId: listReconciliations)

type ListRecsQuery = QueryParams<OpsOps, 'listReconciliations'>
type ListRecs200 = JsonResponse<OpsOps, 'listReconciliations', 200>
type ListOpsEventsQuery = QueryParams<OpsOps, 'listOpsEvents'>
type ListOpsEvents200 = JsonResponse<OpsOps, 'listOpsEvents', 200>
type GetOpsEventQuery = QueryParams<OpsOps, 'getOpsEvent'>
type GetOpsEventParams = PathParams<OpsOps, 'getOpsEvent'>
type GetOpsEvent200 = JsonResponse<OpsOps, 'getOpsEvent', 200>
type ListOpsRatingsQuery = QueryParams<OpsOps, 'listOpsRatings'>
type ListOpsRatings200 = JsonResponse<OpsOps, 'listOpsRatings', 200>
type GetOpsRatingQuery = QueryParams<OpsOps, 'getOpsRating'>
type GetOpsRatingParams = PathParams<OpsOps, 'getOpsRating'>
type GetOpsRating200 = JsonResponse<OpsOps, 'getOpsRating', 200>
type ListOpsRatedRecordsQuery = QueryParams<OpsOps, 'listOpsRatedRecords'>
type ListOpsRatedRecords200 = JsonResponse<OpsOps, 'listOpsRatedRecords', 200>
type GetOpsRatedRecordQuery = QueryParams<OpsOps, 'getOpsRatedRecord'>
type GetOpsRatedRecordParams = PathParams<OpsOps, 'getOpsRatedRecord'>
type GetOpsRatedRecord200 = JsonResponse<OpsOps, 'getOpsRatedRecord', 200>
type OpsRevenueReportBody = JsonRequestBody<OpsOps, 'opsRevenueReport'>
type OpsRevenueReport200 = JsonResponse<OpsOps, 'opsRevenueReport', 200>
type ListOpsAllocationsQuery = QueryParams<OpsOps, 'listOpsAllocations'>
type ListOpsAllocations200 = JsonResponse<OpsOps, 'listOpsAllocations', 200>
type GetOpsAllocationQuery = QueryParams<OpsOps, 'getOpsAllocation'>
type GetOpsAllocationParams = PathParams<OpsOps, 'getOpsAllocation'>
type GetOpsAllocation200 = JsonResponse<OpsOps, 'getOpsAllocation', 200>
type ListOpsCatalogProductsQuery = QueryParams<OpsOps, 'listOpsCatalogProducts'>
type ListOpsCatalogProducts200 = JsonResponse<OpsOps, 'listOpsCatalogProducts', 200>
type GetOpsCatalogProductQuery = QueryParams<OpsOps, 'getOpsCatalogProduct'>
type GetOpsCatalogProductParams = PathParams<OpsOps, 'getOpsCatalogProduct'>
type GetOpsCatalogProduct200 = JsonResponse<OpsOps, 'getOpsCatalogProduct', 200>
type CreateOpsCatalogProductBody = JsonRequestBody<OpsOps, 'createOpsCatalogProduct'>
type CreateOpsCatalogProduct201 = JsonResponse<OpsOps, 'createOpsCatalogProduct', 201>
type CreateOpsCatalogProduct200 = JsonResponse<OpsOps, 'createOpsCatalogProduct', 200>
type UpdateOpsCatalogProductBody = JsonRequestBody<OpsOps, 'updateOpsCatalogProduct'>
type UpdateOpsCatalogProduct200 = JsonResponse<OpsOps, 'updateOpsCatalogProduct', 200>
type DeleteOpsCatalogProductParams = PathParams<OpsOps, 'deleteOpsCatalogProduct'>
type DeleteOpsCatalogProduct200 = JsonResponse<OpsOps, 'deleteOpsCatalogProduct', 200>
type ListOpsCatalogPricesQuery = QueryParams<OpsOps, 'listOpsCatalogPrices'>
type ListOpsCatalogPrices200 = JsonResponse<OpsOps, 'listOpsCatalogPrices', 200>
type GetOpsCatalogPriceQuery = QueryParams<OpsOps, 'getOpsCatalogPrice'>
type GetOpsCatalogPriceParams = PathParams<OpsOps, 'getOpsCatalogPrice'>
type GetOpsCatalogPrice200 = JsonResponse<OpsOps, 'getOpsCatalogPrice', 200>
type CreateOpsCatalogPriceBody = JsonRequestBody<OpsOps, 'createOpsCatalogPrice'>
type CreateOpsCatalogPrice201 = JsonResponse<OpsOps, 'createOpsCatalogPrice', 201>
type CreateOpsCatalogPrice200 = JsonResponse<OpsOps, 'createOpsCatalogPrice', 200>
type UpdateOpsCatalogPriceBody = JsonRequestBody<OpsOps, 'updateOpsCatalogPrice'>
type UpdateOpsCatalogPrice200 = JsonResponse<OpsOps, 'updateOpsCatalogPrice', 200>
type DeleteOpsCatalogPriceParams = PathParams<OpsOps, 'deleteOpsCatalogPrice'>
type DeleteOpsCatalogPrice200 = JsonResponse<OpsOps, 'deleteOpsCatalogPrice', 200>

@Controller('ops')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, ServiceAccountGuard, PrincipalGuard, BillingAccountGuard)
export class OpsController {
  @Get('reconciliations')
  async listReconciliations(@Req() req: AppRequest, @Query() q: ListRecsQuery): Promise<ListRecs200> {
    const ctxBa: string | undefined = req?.ctx?.billingAccountId
    const reqBa: string = String(q?.billing_account_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListRecs200
    }
    if (!allowCrossAccount && !targetBa) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListRecs200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const item: OpsComponents['schemas']['ReconciliationSummary'] = {
      id: 'rec_1',
      billing_account_id: targetBa ?? ctxBa ?? '',
      kind: String(q?.kind || 'usage_mismatch') as 'usage_mismatch',
      status: 'pending',
      diff: {},
      provider_state_snapshot_id: null as unknown as string,
      created_at: new Date().toISOString(),
      resolved_at: null as unknown as string,
    }
    const data: { items?: OpsComponents['schemas']['ReconciliationSummary'][]; next_cursor?: string | null } = { items: [item], next_cursor: null }
    return okEnvelope(data) as ListRecs200
  }

  @Get('catalog/products')
  async listCatalogProducts(@Req() req: AppRequest, @Query() q: ListOpsCatalogProductsQuery): Promise<ListOpsCatalogProducts200> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    if (!realmId) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'realm_id missing' }) as ListOpsCatalogProducts200
    }
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as ListOpsCatalogProducts200
    }

    const limit = clampLimit(q?.limit)
    const cursor = q?.cursor ? String(q.cursor) : null
    const expandSet = normalizeExpand(q?.expand)
    const includePrices = expandSet.has('prices')
    const includeDefaultPrice = expandSet.has('default_price')

    let query = db
      .selectFrom('catalog_products as cp')
      .select([
        'cp.catalog_product_id',
        'cp.realm_id',
        'cp.product_code',
        'cp.provider',
        'cp.provider_product_id',
        'cp.kind',
        'cp.status',
        'cp.display_priority',
        'cp.presentation_config',
        'cp.name',
        'cp.default_currency',
        'cp.metadata',
        'cp.created_at',
      ])
      .where('cp.realm_id', '=', realmId)
      .orderBy('cp.catalog_product_id')
      .limit(limit + 1)

    if (cursor) {
      query = query.where('cp.catalog_product_id', '>', cursor)
    }
    if (q?.kind) {
      query = query.where('cp.kind', '=', q.kind)
    }
    const statuses = normalizeArray(q?.status).filter((status): status is 'active' | 'archived' | 'draft' =>
      ['active', 'archived', 'draft'].includes(status),
    )
    if (statuses.length > 0) {
      query = query.where('cp.status', 'in', statuses)
    }
    if (q?.provider) {
      query = query.where('cp.provider', '=', q.provider)
    }
    if (q?.product_code) {
      query = query.where('cp.product_code', '=', q.product_code)
    }
    if (q?.provider_product_id) {
      query = query.where('cp.provider_product_id', '=', q.provider_product_id)
    }
    if (q?.name) {
      query = query.where('cp.name', '=', q.name)
    }
    if (q?.default_currency) {
      query = query.where('cp.default_currency', '=', q.default_currency)
    }
    if (q?.q) {
      const term = `%${q.q}%`
      query = query.where((eb) =>
        eb.or([
          eb('cp.product_code', 'ilike', term),
          eb('cp.name', 'ilike', term),
          eb('cp.provider_product_id', 'ilike', term),
        ]),
      )
    }

    const rows = await query.execute()
    const windowRows = rows.slice(0, limit)
    const productIds = windowRows.map((row) => String(row.catalog_product_id))
    const priceMap = (includePrices || includeDefaultPrice) && productIds.length > 0
      ? await fetchCatalogPricesForProducts(db, realmId, productIds)
      : new Map<string, CatalogPriceRow[]>()

    const data: OpsComponents['schemas']['OpsCatalogProduct'][] = windowRows.map((row) => {
      const base = mapCatalogProductRow(row)
      if (includePrices) {
        base.prices = (priceMap.get(String(row.catalog_product_id)) ?? []).map(mapCatalogPriceRow)
      }
      if (includeDefaultPrice) {
        const defaultPrice = selectDefaultPrice(priceMap.get(String(row.catalog_product_id)) ?? [], row.default_currency)
        if (defaultPrice) base.default_price = mapCatalogPriceRow(defaultPrice)
      }
      return base
    })

    const hasMore = rows.length > limit
    const nextCursor = hasMore ? String(rows[limit].catalog_product_id) : null
    return okEnvelope(data, { meta: { next_cursor: nextCursor, has_more: hasMore, limit } }) as ListOpsCatalogProducts200
  }

  @Get('catalog/products/:catalog_product_id')
  async getCatalogProduct(
    @Req() req: AppRequest,
    @Param() params: GetOpsCatalogProductParams,
    @Query() q: GetOpsCatalogProductQuery,
  ): Promise<GetOpsCatalogProduct200> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    if (!realmId) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'realm_id missing' }) as GetOpsCatalogProduct200
    }
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as GetOpsCatalogProduct200
    }

    const expandSet = normalizeExpand(q?.expand)
    const includePrices = expandSet.has('prices')
    const includeDefaultPrice = expandSet.has('default_price')

    const row = await db
      .selectFrom('catalog_products as cp')
      .select([
        'cp.catalog_product_id',
        'cp.realm_id',
        'cp.product_code',
        'cp.provider',
        'cp.provider_product_id',
        'cp.kind',
        'cp.status',
        'cp.display_priority',
        'cp.presentation_config',
        'cp.name',
        'cp.default_currency',
        'cp.metadata',
        'cp.created_at',
      ])
      .where('cp.realm_id', '=', realmId)
      .where(sql`cp.catalog_product_id::text`, '=', String(params.catalog_product_id))
      .executeTakeFirst()

    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'catalog product not found' }) as GetOpsCatalogProduct200
    }

    const priceMap = (includePrices || includeDefaultPrice)
      ? await fetchCatalogPricesForProducts(db, realmId, [String(row.catalog_product_id)])
      : new Map<string, CatalogPriceRow[]>()

    const product = mapCatalogProductRow(row)
    if (includePrices) {
      product.prices = (priceMap.get(String(row.catalog_product_id)) ?? []).map(mapCatalogPriceRow)
    }
    if (includeDefaultPrice) {
      const defaultPrice = selectDefaultPrice(priceMap.get(String(row.catalog_product_id)) ?? [], row.default_currency)
      if (defaultPrice) product.default_price = mapCatalogPriceRow(defaultPrice)
    }

    return okEnvelope(product) as GetOpsCatalogProduct200
  }

  @Post('catalog/products')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'ops_catalog_product.create',
    operationId: 'createOpsCatalogProduct',
    targetType: 'ops_catalog_product',
    targetIdFrom: 'response.data.catalog_product_id',
  })
  async createCatalogProduct(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: CreateOpsCatalogProductBody,
  ): Promise<CreateOpsCatalogProduct201 | CreateOpsCatalogProduct200> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    if (!realmId) {
      throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'realm_id missing' }, 403)
    }
    if (!db) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'DB session unavailable' }, 500)
    }

    const duplicateGrantCode = findDuplicateGrantProgramCode(body.metadata ?? {})
    if (duplicateGrantCode) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `duplicate grant_program_code in metadata.grants: ${duplicateGrantCode}` }, 400)
    }
    const presentationConfig = normalizePresentationConfig(body.presentation_config)
    if (presentationConfig === null) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'presentation_config must be an object' }, 400)
    }

    const row = await db
      .insertInto('catalog_products')
      .values({
        realm_id: realmId,
        product_code: body.product_code,
        provider: body.provider,
        provider_product_id: body.provider_product_id,
        kind: body.kind,
        status: body.status,
        display_priority: body.display_priority ?? 100,
        presentation_config: presentationConfig,
        name: body.name,
        default_currency: body.default_currency,
        metadata: body.metadata ?? {},
      })
      .returning([
        'catalog_product_id',
        'realm_id',
        'product_code',
        'provider',
        'provider_product_id',
        'kind',
        'status',
        'display_priority',
        'presentation_config',
        'name',
        'default_currency',
        'metadata',
        'created_at',
      ])
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'SERVER.UNEXPECTED', message: 'catalog product create failed' }, 500)
    }

    const payload = okEnvelope(mapCatalogProductRow(row)) as CreateOpsCatalogProduct201
    try { await res.status(201).send(payload) } catch {}
    return payload
  }

  @Patch('catalog/products/:catalog_product_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'ops_catalog_product.update',
    operationId: 'updateOpsCatalogProduct',
    targetType: 'ops_catalog_product',
    targetIdFrom: 'params.catalog_product_id',
  })
  async updateCatalogProduct(
    @Req() req: AppRequest,
    @Param() params: GetOpsCatalogProductParams,
    @Body() body: UpdateOpsCatalogProductBody,
  ): Promise<UpdateOpsCatalogProduct200> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    if (!realmId) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'realm_id missing' }) as UpdateOpsCatalogProduct200
    }
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as UpdateOpsCatalogProduct200
    }

    const updates: Partial<{
      product_code: string
      provider: string
      provider_product_id: string
      kind: 'subscription' | 'credit'
      status: 'active' | 'archived' | 'draft'
      display_priority: number
      presentation_config: Record<string, unknown>
      name: string
      default_currency: string
      metadata: Record<string, unknown>
    }> = {}

    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'product_code')) updates.product_code = body.product_code
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'provider')) updates.provider = body.provider
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'provider_product_id')) updates.provider_product_id = body.provider_product_id
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'kind')) updates.kind = body.kind
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'status')) updates.status = body.status
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'display_priority')) updates.display_priority = body.display_priority
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'presentation_config')) {
      const presentationConfig = normalizePresentationConfig(body.presentation_config)
      if (presentationConfig === null) {
        return errEnvelope('VALIDATION.INVALID_INPUT', { message: 'presentation_config must be an object' }) as UpdateOpsCatalogProduct200
      }
      updates.presentation_config = presentationConfig
    }
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'name')) updates.name = body.name
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'default_currency')) updates.default_currency = body.default_currency
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'metadata')) {
      const duplicateGrantCode = findDuplicateGrantProgramCode(body.metadata ?? {})
      if (duplicateGrantCode) {
        return errEnvelope('VALIDATION.INVALID_INPUT', { message: `duplicate grant_program_code in metadata.grants: ${duplicateGrantCode}` }) as UpdateOpsCatalogProduct200
      }
      updates.metadata = body.metadata ?? {}
    }

    if (Object.keys(updates).length === 0) {
      const existing = await db
        .selectFrom('catalog_products as cp')
        .select([
          'cp.catalog_product_id',
          'cp.realm_id',
          'cp.product_code',
          'cp.provider',
          'cp.provider_product_id',
          'cp.kind',
          'cp.status',
          'cp.display_priority',
          'cp.presentation_config',
          'cp.name',
          'cp.default_currency',
          'cp.metadata',
          'cp.created_at',
        ])
        .where('cp.realm_id', '=', realmId)
        .where(sql`cp.catalog_product_id::text`, '=', String(params.catalog_product_id))
        .executeTakeFirst()
      if (!existing) {
        return errEnvelope('RESOURCE.NOT_FOUND', { message: 'catalog product not found' }) as UpdateOpsCatalogProduct200
      }
      return okEnvelope(mapCatalogProductRow(existing)) as UpdateOpsCatalogProduct200
    }

    const row = await db
      .updateTable('catalog_products')
      .set(updates)
      .where('realm_id', '=', realmId)
      .where(sql`catalog_product_id::text`, '=', String(params.catalog_product_id))
      .returning([
        'catalog_product_id',
        'realm_id',
        'product_code',
        'provider',
        'provider_product_id',
        'kind',
        'status',
        'display_priority',
        'presentation_config',
        'name',
        'default_currency',
        'metadata',
        'created_at',
      ])
      .executeTakeFirst()

    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'catalog product not found' }) as UpdateOpsCatalogProduct200
    }

    return okEnvelope(mapCatalogProductRow(row)) as UpdateOpsCatalogProduct200
  }

  @Delete('catalog/products/:catalog_product_id')
  @Audit({
    action: 'ops_catalog_product.archive',
    operationId: 'deleteOpsCatalogProduct',
    targetType: 'ops_catalog_product',
    targetIdFrom: 'params.catalog_product_id',
  })
  async deleteCatalogProduct(
    @Req() req: AppRequest,
    @Param() params: DeleteOpsCatalogProductParams,
  ): Promise<DeleteOpsCatalogProduct200> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    if (!realmId) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'realm_id missing' }) as DeleteOpsCatalogProduct200
    }
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as DeleteOpsCatalogProduct200
    }

    const row = await db
      .updateTable('catalog_products')
      .set({ status: 'archived' })
      .where('realm_id', '=', realmId)
      .where(sql`catalog_product_id::text`, '=', String(params.catalog_product_id))
      .returning(['catalog_product_id'])
      .executeTakeFirst()

    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'catalog product not found' }) as DeleteOpsCatalogProduct200
    }

    return okEnvelope({ archived: true }) as DeleteOpsCatalogProduct200
  }

  @Get('catalog/prices')
  async listCatalogPrices(@Req() req: AppRequest, @Query() q: ListOpsCatalogPricesQuery): Promise<ListOpsCatalogPrices200> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    if (!realmId) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'realm_id missing' }) as ListOpsCatalogPrices200
    }
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as ListOpsCatalogPrices200
    }

    const limit = clampLimit(q?.limit)
    const cursor = q?.cursor ? String(q.cursor) : null
    const expandSet = normalizeExpand(q?.expand)
    const includeProduct = expandSet.has('product')

    const productIds = normalizeArray(q?.product_id).map((id) => String(id))

    let query = db
      .selectFrom('catalog_prices as cp')
      .select([
        'cp.catalog_price_id',
        'cp.realm_id',
        'cp.catalog_product_id',
        'cp.price_code',
        'cp.provider_price_id',
        'cp.status',
        'cp.currency',
        'cp.unit_amount',
        'cp.recurring_interval',
        'cp.recurring_count',
        'cp.display_priority',
        'cp.metadata',
        'cp.subscription_group_id',
        'cp.subscription_group_key',
        'cp.created_at',
      ])
      .where('cp.realm_id', '=', realmId)
      .orderBy('cp.display_priority')
      .orderBy('cp.unit_amount')
      .orderBy('cp.catalog_price_id')
      .limit(limit + 1)

    if (cursor) {
      query = query.where('cp.catalog_price_id', '>', cursor)
    }
    if (productIds.length > 0) {
      query = query.where('cp.catalog_product_id', 'in', productIds)
    }
    if (q?.price_code) {
      query = query.where('cp.price_code', '=', q.price_code)
    }
    const priceStatuses = normalizeArray(q?.status).filter((status): status is 'active' | 'archived' =>
      ['active', 'archived'].includes(status),
    )
    if (priceStatuses.length > 0) {
      query = query.where('cp.status', 'in', priceStatuses)
    }
    if (q?.provider_price_id) {
      query = query.where('cp.provider_price_id', '=', q.provider_price_id)
    }
    if (q?.q) {
      const term = `%${q.q}%`
      query = query.where((eb) =>
        eb.or([
          eb('cp.price_code', 'ilike', term),
          eb('cp.provider_price_id', 'ilike', term),
        ]),
      )
    }
    if (q?.currency) {
      query = query.where('cp.currency', '=', q.currency)
    }
    if (q?.recurring_interval) {
      query = query.where('cp.recurring_interval', '=', q.recurring_interval)
    }
    const recurringCount = typeof q?.recurring_count !== 'undefined' ? Number(q.recurring_count) : undefined
    if (typeof recurringCount === 'number' && Number.isFinite(recurringCount)) {
      query = query.where('cp.recurring_count', '=', recurringCount)
    }
    if (q?.subscription_group_id) {
      query = query.where('cp.subscription_group_id', '=', q.subscription_group_id)
    }
    if (q?.subscription_group_key) {
      query = query.where('cp.subscription_group_key', '=', q.subscription_group_key)
    }

    const rows = await query.execute()
    const windowRows = rows.slice(0, limit)
    const productMap = includeProduct
      ? await fetchCatalogProductsByIds(db, realmId, windowRows.map((row) => String(row.catalog_product_id)))
      : new Map<string, CatalogProductRow>()

    const data = windowRows.map((row) => {
      const base = mapCatalogPriceRow(row)
      if (includeProduct) {
        const product = productMap.get(String(row.catalog_product_id))
        if (product) base.product = mapCatalogProductRow(product)
      }
      return base
    })

    const hasMore = rows.length > limit
    const nextCursor = hasMore ? String(rows[limit].catalog_price_id) : null
    return okEnvelope(data, { meta: { next_cursor: nextCursor, has_more: hasMore, limit } }) as ListOpsCatalogPrices200
  }

  @Get('catalog/prices/:catalog_price_id')
  async getCatalogPrice(
    @Req() req: AppRequest,
    @Param() params: GetOpsCatalogPriceParams,
    @Query() q: GetOpsCatalogPriceQuery,
  ): Promise<GetOpsCatalogPrice200> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    if (!realmId) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'realm_id missing' }) as GetOpsCatalogPrice200
    }
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as GetOpsCatalogPrice200
    }

    const expandSet = normalizeExpand(q?.expand)
    const includeProduct = expandSet.has('product')

    const row = await db
      .selectFrom('catalog_prices as cp')
      .select([
        'cp.catalog_price_id',
        'cp.realm_id',
        'cp.catalog_product_id',
        'cp.price_code',
        'cp.provider_price_id',
        'cp.status',
        'cp.currency',
        'cp.unit_amount',
        'cp.recurring_interval',
        'cp.recurring_count',
        'cp.display_priority',
        'cp.metadata',
        'cp.subscription_group_id',
        'cp.subscription_group_key',
        'cp.created_at',
      ])
      .where('cp.realm_id', '=', realmId)
      .where(sql`cp.catalog_price_id::text`, '=', String(params.catalog_price_id))
      .executeTakeFirst()

    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'catalog price not found' }) as GetOpsCatalogPrice200
    }

    const price = mapCatalogPriceRow(row)
    if (includeProduct) {
      const products = await fetchCatalogProductsByIds(db, realmId, [String(row.catalog_product_id)])
      const product = products.get(String(row.catalog_product_id))
      if (product) price.product = mapCatalogProductRow(product)
    }

    return okEnvelope(price) as GetOpsCatalogPrice200
  }

  @Post('catalog/prices')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'ops_catalog_price.create',
    operationId: 'createOpsCatalogPrice',
    targetType: 'ops_catalog_price',
    targetIdFrom: 'response.data.catalog_price_id',
  })
  async createCatalogPrice(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: CreateOpsCatalogPriceBody,
  ): Promise<CreateOpsCatalogPrice201 | CreateOpsCatalogPrice200> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    if (!realmId) {
      throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'realm_id missing' }, 403)
    }
    if (!db) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'DB session unavailable' }, 500)
    }

    const recurringInterval = body.recurring_interval ?? null
    const recurringCount = body.recurring_count ?? null
    const subscriptionGroupKey = normalizeSubscriptionGroupKey(body.subscription_group_key)
    if ((recurringInterval && !recurringCount) || (!recurringInterval && recurringCount)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'recurring_interval and recurring_count must be provided together' }, 400)
    }
    if (recurringInterval && !subscriptionGroupKey) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'subscription_group_key is required for recurring prices' }, 400)
    }

    const productRow = await db
      .selectFrom('catalog_products as cp')
      .select(['cp.catalog_product_id'])
      .where('cp.realm_id', '=', realmId)
      .where(sql`cp.catalog_product_id::text`, '=', String(body.catalog_product_id))
      .executeTakeFirst()
    if (!productRow) {
      throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'catalog product not found' }, 404)
    }

    const duplicateGrantCode = findDuplicateGrantProgramCode(body.metadata ?? {})
    if (duplicateGrantCode) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `duplicate grant_program_code in metadata.grants: ${duplicateGrantCode}` }, 400)
    }

    const subscriptionGroupId = subscriptionGroupKey
      ? await resolveSubscriptionGroupId(db, realmId, subscriptionGroupKey)
      : null

    const row = await db
      .insertInto('catalog_prices')
      .values({
        realm_id: realmId,
        catalog_product_id: String(body.catalog_product_id),
        price_code: body.price_code,
        provider_price_id: body.provider_price_id,
        status: body.status ?? 'active',
        currency: body.currency,
        unit_amount: body.unit_amount,
        recurring_interval: recurringInterval,
        recurring_count: recurringCount,
        display_priority: body.display_priority,
        metadata: body.metadata ?? {},
        subscription_group_id: subscriptionGroupId,
        subscription_group_key: subscriptionGroupKey,
      })
      .returning([
        'catalog_price_id',
        'realm_id',
        'catalog_product_id',
        'price_code',
        'provider_price_id',
        'status',
        'currency',
        'unit_amount',
        'recurring_interval',
        'recurring_count',
        'display_priority',
        'metadata',
        'subscription_group_id',
        'subscription_group_key',
        'created_at',
      ])
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'SERVER.UNEXPECTED', message: 'catalog price create failed' }, 500)
    }

    const payload = okEnvelope(mapCatalogPriceRow(row)) as CreateOpsCatalogPrice201
    try { await res.status(201).send(payload) } catch {}
    return payload
  }

  @Patch('catalog/prices/:catalog_price_id')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'ops_catalog_price.update',
    operationId: 'updateOpsCatalogPrice',
    targetType: 'ops_catalog_price',
    targetIdFrom: 'params.catalog_price_id',
  })
  async updateCatalogPrice(
    @Req() req: AppRequest,
    @Param() params: GetOpsCatalogPriceParams,
    @Body() body: UpdateOpsCatalogPriceBody,
  ): Promise<UpdateOpsCatalogPrice200> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    if (!realmId) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'realm_id missing' }) as UpdateOpsCatalogPrice200
    }
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as UpdateOpsCatalogPrice200
    }

    const existing = await db
      .selectFrom('catalog_prices as cp')
      .select([
        'cp.catalog_price_id',
        'cp.realm_id',
        'cp.catalog_product_id',
        'cp.price_code',
        'cp.provider_price_id',
        'cp.status',
        'cp.currency',
        'cp.unit_amount',
        'cp.recurring_interval',
        'cp.recurring_count',
        'cp.display_priority',
        'cp.metadata',
        'cp.subscription_group_id',
        'cp.subscription_group_key',
        'cp.created_at',
      ])
      .where('cp.realm_id', '=', realmId)
      .where(sql`cp.catalog_price_id::text`, '=', String(params.catalog_price_id))
      .executeTakeFirst()

    if (!existing) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'catalog price not found' }) as UpdateOpsCatalogPrice200
    }

    const hasRecurringInterval = Object.prototype.hasOwnProperty.call(body ?? {}, 'recurring_interval')
    const hasRecurringCount = Object.prototype.hasOwnProperty.call(body ?? {}, 'recurring_count')
    const hasGroupKey = Object.prototype.hasOwnProperty.call(body ?? {}, 'subscription_group_key')

    const nextRecurringInterval = hasRecurringInterval ? body.recurring_interval ?? null : existing.recurring_interval
    const nextRecurringCount = hasRecurringCount ? body.recurring_count ?? null : existing.recurring_count
    const nextGroupKey = hasGroupKey ? normalizeSubscriptionGroupKey(body.subscription_group_key) : existing.subscription_group_key

    if ((nextRecurringInterval && !nextRecurringCount) || (!nextRecurringInterval && nextRecurringCount)) {
      return errEnvelope('VALIDATION.INVALID_INPUT', { message: 'recurring_interval and recurring_count must be provided together' }) as UpdateOpsCatalogPrice200
    }
    if (nextRecurringInterval && !nextGroupKey) {
      return errEnvelope('VALIDATION.INVALID_INPUT', { message: 'subscription_group_key is required for recurring prices' }) as UpdateOpsCatalogPrice200
    }

    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'catalog_product_id')) {
      const productRow = await db
        .selectFrom('catalog_products as cp')
        .select(['cp.catalog_product_id'])
        .where('cp.realm_id', '=', realmId)
        .where(sql`cp.catalog_product_id::text`, '=', String(body.catalog_product_id))
        .executeTakeFirst()
      if (!productRow) {
        return errEnvelope('RESOURCE.NOT_FOUND', { message: 'catalog product not found' }) as UpdateOpsCatalogPrice200
      }
    }

    const updates: Partial<{
      catalog_product_id: string
      price_code: string
      provider_price_id: string
      status: 'active' | 'archived'
      currency: string
      unit_amount: number
      recurring_interval: 'month' | 'year' | null
      recurring_count: number | null
      display_priority: number
      metadata: Record<string, unknown>
      subscription_group_id: string | null
      subscription_group_key: string | null
    }> = {}

    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'catalog_product_id')) updates.catalog_product_id = String(body.catalog_product_id)
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'price_code')) updates.price_code = body.price_code
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'provider_price_id')) updates.provider_price_id = body.provider_price_id
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'status')) updates.status = body.status
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'currency')) updates.currency = body.currency
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'unit_amount')) updates.unit_amount = body.unit_amount
    if (hasRecurringInterval) updates.recurring_interval = body.recurring_interval ?? null
    if (hasRecurringCount) updates.recurring_count = body.recurring_count ?? null
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'display_priority')) updates.display_priority = body.display_priority
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'metadata')) {
      const duplicateGrantCode = findDuplicateGrantProgramCode(body.metadata ?? {})
      if (duplicateGrantCode) {
        return errEnvelope('VALIDATION.INVALID_INPUT', { message: `duplicate grant_program_code in metadata.grants: ${duplicateGrantCode}` }) as UpdateOpsCatalogPrice200
      }
      updates.metadata = body.metadata ?? {}
    }
    if (hasRecurringInterval && !body.recurring_interval) {
      updates.subscription_group_id = null
      updates.subscription_group_key = null
    } else if (hasGroupKey || (nextRecurringInterval && nextGroupKey !== existing.subscription_group_key)) {
      const resolvedGroupId = nextGroupKey ? await resolveSubscriptionGroupId(db, realmId, nextGroupKey) : null
      updates.subscription_group_id = resolvedGroupId
      updates.subscription_group_key = nextGroupKey ?? null
    }

    if (Object.keys(updates).length === 0) {
      return okEnvelope(mapCatalogPriceRow(existing)) as UpdateOpsCatalogPrice200
    }

    const row = await db
      .updateTable('catalog_prices')
      .set(updates)
      .where('realm_id', '=', realmId)
      .where(sql`catalog_price_id::text`, '=', String(params.catalog_price_id))
      .returning([
        'catalog_price_id',
        'realm_id',
        'catalog_product_id',
        'price_code',
        'provider_price_id',
        'status',
        'currency',
        'unit_amount',
        'recurring_interval',
        'recurring_count',
        'display_priority',
        'metadata',
        'subscription_group_id',
        'subscription_group_key',
        'created_at',
      ])
      .executeTakeFirst()

    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'catalog price not found' }) as UpdateOpsCatalogPrice200
    }

    return okEnvelope(mapCatalogPriceRow(row)) as UpdateOpsCatalogPrice200
  }

  @Delete('catalog/prices/:catalog_price_id')
  @Audit({
    action: 'ops_catalog_price.archive',
    operationId: 'deleteOpsCatalogPrice',
    targetType: 'ops_catalog_price',
    targetIdFrom: 'params.catalog_price_id',
  })
  async deleteCatalogPrice(
    @Req() req: AppRequest,
    @Param() params: DeleteOpsCatalogPriceParams,
  ): Promise<DeleteOpsCatalogPrice200> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    if (!realmId) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'realm_id missing' }) as DeleteOpsCatalogPrice200
    }
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as DeleteOpsCatalogPrice200
    }

    const row = await db
      .updateTable('catalog_prices')
      .set({ status: 'archived' })
      .where('realm_id', '=', realmId)
      .where(sql`catalog_price_id::text`, '=', String(params.catalog_price_id))
      .returning(['catalog_price_id'])
      .executeTakeFirst()

    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'catalog price not found' }) as DeleteOpsCatalogPrice200
    }

    return okEnvelope({ archived: true }) as DeleteOpsCatalogPrice200
  }

  @Get('events')
  async listEvents(@Req() req: AppRequest, @Query() q: ListOpsEventsQuery): Promise<ListOpsEvents200> {
    const ctxBa = req?.ctx?.billingAccountId
    const reqBa = String(q?.billing_account_id || '')
    const reqBu = String(q?.billing_user_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListOpsEvents200
    }
    if (!targetBa && !allowCrossAccount) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListOpsEvents200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as ListOpsEvents200
    }

    const limit = clampLimit(q?.limit)
    const sortBy = q?.sort_by === 'created_at' ? 'created_at' : 'occurred_at'
    const sortOrder = q?.sort_order === 'asc' ? 'asc' : 'desc'
    const cursor = parseCursor(q?.cursor, sortBy, sortOrder)
    const expandSet = normalizeExpand(q?.expand)
    const includeLabels = expandSet.has('labels')

    let query = db
      .selectFrom('billing_events as be')
      .select([
        'be.event_id',
        'be.realm_id',
        'be.billing_account_id',
        'be.billing_user_id',
        'be.semantic_kind',
        'be.occurred_at',
        'be.event_type',
        'be.subject_ref',
        'be.request_hash',
        'be.payload',
        'be.created_at',
      ])
      .orderBy(`be.${sortBy}`, sortOrder)
      .orderBy('be.event_id', sortOrder)
      .limit(limit + 1)

    if (targetBa) {
      query = query.where('be.billing_account_id', '=', targetBa)
    }
    if (reqBu) {
      query = query.where('be.billing_user_id', '=', reqBu)
    }
    if (q?.semantic_kind) {
      query = query.where('be.semantic_kind', '=', q.semantic_kind)
    }
    const eventTypes = normalizeArray(q?.event_type)
    if (eventTypes.length > 0) {
      query = query.where('be.event_type', 'in', eventTypes)
    }
    if (q?.subject_ref) {
      query = query.where('be.subject_ref', '=', q.subject_ref)
    }
    if (q?.request_hash) {
      query = query.where('be.request_hash', '=', q.request_hash)
    }
    if (q?.occurred_after) {
      query = query.where('be.occurred_at', '>=', new Date(q.occurred_after))
    }
    if (q?.occurred_before) {
      query = query.where('be.occurred_at', '<=', new Date(q.occurred_before))
    }
    if (cursor) {
      query = applyCursor(query, `be.${sortBy}`, 'be.event_id', cursor, sortOrder)
    }

    const rows = await query.execute()
    const windowRows = rows.slice(0, limit)
    const eventIds = windowRows.map((row) => String(row.event_id))

    const labelsByEvent = includeLabels && eventIds.length > 0
      ? await fetchEventLabels(db, eventIds)
      : new Map<string, OpsComponents['schemas']['OpsEventLabel'][]>()

    const events: OpsComponents['schemas']['OpsEvent'][] = windowRows.map((row) => ({
      event_id: String(row.event_id),
      realm_id: String(row.realm_id),
      billing_account_id: String(row.billing_account_id),
      billing_user_id: String(row.billing_user_id),
      semantic_kind: row.semantic_kind,
      occurred_at: toIso(row.occurred_at),
      event_type: row.event_type,
      subject_ref: row.subject_ref ?? null,
      request_hash: row.request_hash,
      payload: row.payload as Record<string, unknown>,
      created_at: toIso(row.created_at),
      labels: includeLabels ? labelsByEvent.get(String(row.event_id)) ?? [] : undefined,
    }))

    const hasMore = rows.length > limit
    const nextCursor = hasMore ? encodeCursor(rows[limit][sortBy as 'occurred_at' | 'created_at'], rows[limit].event_id, sortBy, sortOrder) : null
    return okEnvelope(events, { meta: { next_cursor: nextCursor, has_more: hasMore, limit } }) as ListOpsEvents200
  }

  @Get('events/:event_id')
  async getEvent(
    @Req() req: AppRequest,
    @Param() params: GetOpsEventParams,
    @Query() q: GetOpsEventQuery,
  ): Promise<GetOpsEvent200> {
    const ctxBa = req?.ctx?.billingAccountId
    const reqBa = String(q?.billing_account_id || '')
    const reqBu = String(q?.billing_user_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetOpsEvent200
    }
    if (!targetBa && !allowCrossAccount) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetOpsEvent200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as GetOpsEvent200
    }
    const expandSet = normalizeExpand(q?.expand)
    const includeLabels = expandSet.has('labels')

    let query = db
      .selectFrom('billing_events as be')
      .select([
        'be.event_id',
        'be.realm_id',
        'be.billing_account_id',
        'be.billing_user_id',
        'be.semantic_kind',
        'be.occurred_at',
        'be.event_type',
        'be.subject_ref',
        'be.request_hash',
        'be.payload',
        'be.created_at',
      ])
      .where(sql`be.event_id::text`, '=', String(params.event_id))

    if (targetBa) {
      query = query.where('be.billing_account_id', '=', targetBa)
    }
    if (reqBu) {
      query = query.where('be.billing_user_id', '=', reqBu)
    }

    const row = await query.executeTakeFirst()
    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'event not found' }) as unknown as GetOpsEvent200
    }

    const labels = includeLabels ? await fetchEventLabels(db, [row.event_id]) : new Map()
    const event: OpsComponents['schemas']['OpsEvent'] = {
      event_id: String(row.event_id),
      realm_id: String(row.realm_id),
      billing_account_id: String(row.billing_account_id),
      billing_user_id: String(row.billing_user_id),
      semantic_kind: row.semantic_kind,
      occurred_at: toIso(row.occurred_at),
      event_type: row.event_type,
      subject_ref: row.subject_ref ?? null,
      request_hash: row.request_hash,
      payload: row.payload as Record<string, unknown>,
      created_at: toIso(row.created_at),
      labels: includeLabels ? labels.get(String(row.event_id)) ?? [] : undefined,
    }

    return okEnvelope(event) as GetOpsEvent200
  }

  @Get('ratings')
  async listRatings(@Req() req: AppRequest, @Query() q: ListOpsRatingsQuery): Promise<ListOpsRatings200> {
    const ctxBa = req?.ctx?.billingAccountId
    const reqBa = String(q?.billing_account_id || '')
    const reqBu = String(q?.billing_user_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListOpsRatings200
    }
    if (!targetBa && !allowCrossAccount) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListOpsRatings200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as ListOpsRatings200
    }

    const limit = clampLimit(q?.limit)
    const sortBy = q?.sort_by === 'created_at' ? 'created_at' : 'rated_at'
    const sortOrder = q?.sort_order === 'asc' ? 'asc' : 'desc'
    const cursor = parseCursor(q?.cursor, sortBy, sortOrder)

    let query = db
      .selectFrom('billing_ratings as br')
      .select([
        'br.rating_id',
        'br.realm_id',
        'br.billing_account_id',
        'br.billing_user_id',
        'br.rating_kind',
        'br.idempotency_id',
        'br.source_ref',
        'br.budget_id',
        'br.feature_code',
        'br.direction',
        'br.reversal_of_rating_id',
        'br.canonical_quantity_minor',
        'br.canonical_amount_xusd',
        'br.canonical_cost_xusd',
        'br.pricing_fingerprint',
        'br.pricing_cost_fingerprint',
        'br.cost_snapshot',
        'br.cost_fingerprint',
        'br.metadata',
        'br.rated_at',
        'br.created_at',
      ])
      .orderBy(`br.${sortBy}`, sortOrder)
      .orderBy('br.rating_id', sortOrder)
      .limit(limit + 1)

    if (targetBa) {
      query = query.where('br.billing_account_id', '=', targetBa)
    }
    if (reqBu) {
      query = query.where('br.billing_user_id', '=', reqBu)
    }
    if (q?.rating_kind) {
      query = query.where('br.rating_kind', '=', q.rating_kind)
    }
    if (q?.feature_code) {
      query = query.where('br.feature_code', '=', q.feature_code)
    }
    if (q?.meter_code) {
      query = query.where(
        sql<boolean>`exists (
          select 1
          from billing_rated_records as brr
          where brr.rating_id = ${sql.ref('br.rating_id')}
            and brr.meter_code = ${q.meter_code}
        )`,
      )
    }
    if (q?.budget_id) {
      query = query.where(sql`br.budget_id::text`, '=', String(q.budget_id))
    }
    if (q?.direction) {
      query = query.where('br.direction', '=', q.direction)
    }
    if (q?.pricing_fingerprint) {
      query = query.where('br.pricing_fingerprint', '=', q.pricing_fingerprint)
    }
    if (q?.idempotency_id) {
      query = query.where(sql`br.idempotency_id::text`, '=', String(q.idempotency_id))
    }
    if (q?.source_ref) {
      query = query.where('br.source_ref', '=', q.source_ref)
    }
    if (q?.rated_after) {
      query = query.where('br.rated_at', '>=', new Date(q.rated_after))
    }
    if (q?.rated_before) {
      query = query.where('br.rated_at', '<=', new Date(q.rated_before))
    }
    if (cursor) {
      query = applyCursor(query, `br.${sortBy}`, 'br.rating_id', cursor, sortOrder)
    }

    const rows = await query.execute()
    const ratings: OpsComponents['schemas']['OpsRating'][] = rows.slice(0, limit).map((row) => ({
      rating_id: String(row.rating_id),
      realm_id: String(row.realm_id),
      billing_account_id: String(row.billing_account_id),
      billing_user_id: String(row.billing_user_id),
      rating_kind: row.rating_kind,
      idempotency_id: String(row.idempotency_id),
      source_ref: row.source_ref ?? null,
      budget_id: row.budget_id ? String(row.budget_id) : null,
      feature_code: row.feature_code,
      direction: row.direction,
      reversal_of_rating_id: row.reversal_of_rating_id ? String(row.reversal_of_rating_id) : null,
      canonical_quantity_minor: String(row.canonical_quantity_minor),
      canonical_amount_xusd: String(row.canonical_amount_xusd),
      canonical_cost_xusd: String(row.canonical_cost_xusd),
      pricing_fingerprint: row.pricing_fingerprint,
      pricing_cost_fingerprint: row.pricing_cost_fingerprint,
      cost_snapshot: row.cost_snapshot as Record<string, unknown>,
      cost_fingerprint: row.cost_fingerprint,
      metadata: row.metadata as Record<string, unknown>,
      rated_at: toIso(row.rated_at),
      created_at: toIso(row.created_at),
    }))

    const hasMore = rows.length > limit
    const nextCursor = hasMore ? encodeCursor(rows[limit][sortBy as 'rated_at' | 'created_at'], rows[limit].rating_id, sortBy, sortOrder) : null
    return okEnvelope(ratings, { meta: { next_cursor: nextCursor, has_more: hasMore, limit } }) as ListOpsRatings200
  }

  @Get('ratings/:rating_id')
  async getRating(
    @Req() req: AppRequest,
    @Param() params: GetOpsRatingParams,
    @Query() q: GetOpsRatingQuery,
  ): Promise<GetOpsRating200> {
    const ctxBa = req?.ctx?.billingAccountId
    const reqBa = String(q?.billing_account_id || '')
    const reqBu = String(q?.billing_user_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetOpsRating200
    }
    if (!targetBa && !allowCrossAccount) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetOpsRating200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as GetOpsRating200
    }

    let query = db
      .selectFrom('billing_ratings as br')
      .select([
        'br.rating_id',
        'br.realm_id',
        'br.billing_account_id',
        'br.billing_user_id',
        'br.rating_kind',
        'br.idempotency_id',
        'br.source_ref',
        'br.budget_id',
        'br.feature_code',
        'br.direction',
        'br.reversal_of_rating_id',
        'br.canonical_quantity_minor',
        'br.canonical_amount_xusd',
        'br.canonical_cost_xusd',
        'br.pricing_fingerprint',
        'br.pricing_cost_fingerprint',
        'br.cost_snapshot',
        'br.cost_fingerprint',
        'br.metadata',
        'br.rated_at',
        'br.created_at',
      ])
      .where(sql`br.rating_id::text`, '=', String(params.rating_id))

    if (targetBa) {
      query = query.where('br.billing_account_id', '=', targetBa)
    }
    if (reqBu) {
      query = query.where('br.billing_user_id', '=', reqBu)
    }

    const expandSet = normalizeExpand(q?.expand)
    const includeRatedRecords = expandSet.has('rated_records')

    const row = await query.executeTakeFirst()
    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'rating not found' }) as unknown as GetOpsRating200
    }

    const rating: OpsComponents['schemas']['OpsRating'] = {
      rating_id: String(row.rating_id),
      realm_id: String(row.realm_id),
      billing_account_id: String(row.billing_account_id),
      billing_user_id: String(row.billing_user_id),
      rating_kind: row.rating_kind,
      idempotency_id: String(row.idempotency_id),
      source_ref: row.source_ref ?? null,
      budget_id: row.budget_id ? String(row.budget_id) : null,
      feature_code: row.feature_code,
      direction: row.direction,
      reversal_of_rating_id: row.reversal_of_rating_id ? String(row.reversal_of_rating_id) : null,
      canonical_quantity_minor: String(row.canonical_quantity_minor),
      canonical_amount_xusd: String(row.canonical_amount_xusd),
      canonical_cost_xusd: String(row.canonical_cost_xusd),
      pricing_fingerprint: row.pricing_fingerprint,
      pricing_cost_fingerprint: row.pricing_cost_fingerprint,
      cost_snapshot: row.cost_snapshot as Record<string, unknown>,
      cost_fingerprint: row.cost_fingerprint,
      metadata: row.metadata as Record<string, unknown>,
      rated_at: toIso(row.rated_at),
      created_at: toIso(row.created_at),
      rated_records: includeRatedRecords
        ? (await fetchRatedRecordsByRatingIds(db, [String(row.rating_id)])).get(String(row.rating_id)) ?? []
        : undefined,
    }

    return okEnvelope(rating) as GetOpsRating200
  }

  @Post('reports/revenue')
  async reportRevenue(@Req() req: AppRequest, @Body() body: OpsRevenueReportBody): Promise<OpsRevenueReport200> {
    const ctxBa = req?.ctx?.billingAccountId
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    if (!allowCrossAccount && !ctxBa) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as OpsRevenueReport200
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as OpsRevenueReport200
    }
    if (!body?.time?.from || !body?.time?.to || !body?.time?.granularity) {
      return errEnvelope('VALIDATION.FIELD_REQUIRED', { message: 'time range required' }) as unknown as OpsRevenueReport200
    }

    const timeBasis = body.time_basis ?? 'paid_at'
    const granularity = body.time.granularity
    const from = new Date(body.time.from)
    const to = new Date(body.time.to)
    const groupBy = (body.group_by?.length ? body.group_by : ['bucket_start', 'currency']) as string[]
    const useLines = groupBy.some((item) => ['line_kind', 'meter_code', 'catalog_price_id'].includes(item)) || (body.line_kinds?.length ?? 0) > 0

    const timeRef = sql.ref(`bi.${timeBasis}`)
    const granularityToken = dateTruncLiteral(granularity)
    const bucketExpr = sql<Date>`date_trunc(${granularityToken}, ${timeRef})`

    const applyCommonFilters = <T>(qb: T & { where: Function }) => {
      let scoped = qb
        .where(timeRef, '>=', from)
        .where(timeRef, '<', to)
      if (timeBasis === 'paid_at' || timeBasis === 'finalized_at') {
        scoped = scoped.where(timeRef, 'is not', null)
      }
      if (!allowCrossAccount && ctxBa) {
        scoped = scoped.where('bi.billing_account_id', '=', ctxBa)
      }
      if (body.billing_account_id?.length) {
        scoped = scoped.where('bi.billing_account_id', 'in', body.billing_account_id)
      }
      if (body.subscription_id?.length) {
        scoped = scoped.where(sql`bi.subscription_id::text`, 'in', body.subscription_id)
      }
      if (body.status?.length) {
        scoped = scoped.where('bi.status', 'in', body.status)
      } else {
        scoped = scoped.where('bi.status', 'in', ['paid'])
      }
      if (body.currency?.length) {
        scoped = scoped.where('bi.currency', 'in', body.currency)
      }
      return scoped
    }

    let rows: Array<Record<string, unknown>> = []

    if (useLines) {
      let query = applyCommonFilters(
        db
          .selectFrom('billing_invoices as bi')
          .innerJoin('billing_invoice_lines as bil', 'bil.billing_invoice_id', 'bi.billing_invoice_id')
          .select(bucketExpr.as('bucket_start')),
      )
      if (groupBy.includes('billing_account_id')) query = query.select('bi.billing_account_id').groupBy('bi.billing_account_id')
      if (groupBy.includes('currency')) query = query.select('bi.currency').groupBy('bi.currency')
      if (groupBy.includes('status')) query = query.select('bi.status').groupBy('bi.status')
      if (groupBy.includes('subscription_id')) query = query.select('bi.subscription_id').groupBy('bi.subscription_id')
      if (groupBy.includes('line_kind')) query = query.select('bil.line_kind').groupBy('bil.line_kind')
      if (groupBy.includes('meter_code')) query = query.select('bil.meter_code').groupBy('bil.meter_code')
      if (groupBy.includes('catalog_price_id')) query = query.select('bil.catalog_price_id').groupBy('bil.catalog_price_id')
      if (body.line_kinds?.length) {
        query = query.where('bil.line_kind', 'in', body.line_kinds)
      }
      rows = (await query
        .select(sql<string>`sum(bil.total_amount_minor)`.as('line_total_minor'))
        .groupBy(bucketExpr)
        .orderBy('bucket_start', 'asc')
        .execute()) as Array<Record<string, unknown>>
    } else {
      let query = applyCommonFilters(
        db
          .selectFrom('billing_invoices as bi')
          .select(bucketExpr.as('bucket_start')),
      )
      if (groupBy.includes('billing_account_id')) query = query.select('bi.billing_account_id').groupBy('bi.billing_account_id')
      if (groupBy.includes('currency')) query = query.select('bi.currency').groupBy('bi.currency')
      if (groupBy.includes('status')) query = query.select('bi.status').groupBy('bi.status')
      if (groupBy.includes('subscription_id')) query = query.select('bi.subscription_id').groupBy('bi.subscription_id')
      rows = (await query
        .select([
          sql<string>`sum(bi.subtotal_minor)`.as('subtotal_minor'),
          sql<string>`sum(bi.tax_minor)`.as('tax_minor'),
          sql<string>`sum(bi.total_minor)`.as('total_minor'),
        ])
        .groupBy(bucketExpr)
        .orderBy('bucket_start', 'asc')
        .execute()) as Array<Record<string, unknown>>
    }

    const data: OpsComponents['schemas']['OpsRevenueReportRow'][] = rows.map((row) => ({
      bucket_start: toIso(row.bucket_start),
      billing_account_id: row.billing_account_id ? String(row.billing_account_id) : undefined,
      currency: row.currency ? String(row.currency) : undefined,
      status: row.status ? String(row.status) : undefined,
      subscription_id: row.subscription_id ? String(row.subscription_id) : undefined,
      line_kind: row.line_kind ? String(row.line_kind) : undefined,
      meter_code: row.meter_code ? String(row.meter_code) : undefined,
      catalog_price_id: row.catalog_price_id ? String(row.catalog_price_id) : undefined,
      subtotal_minor: row.subtotal_minor != null ? String(row.subtotal_minor) : null,
      tax_minor: row.tax_minor != null ? String(row.tax_minor) : null,
      total_minor: row.total_minor != null ? String(row.total_minor) : null,
      line_total_minor: row.line_total_minor != null ? String(row.line_total_minor) : null,
    }))

    return okEnvelope(data) as OpsRevenueReport200
  }

  @Get('rated-records')
  async listRatedRecords(
    @Req() req: AppRequest,
    @Query() q: ListOpsRatedRecordsQuery,
  ): Promise<ListOpsRatedRecords200> {
    const ctxBa = req?.ctx?.billingAccountId
    const reqBa = String(q?.billing_account_id || '')
    const reqBu = String(q?.billing_user_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListOpsRatedRecords200
    }
    if (!targetBa && !allowCrossAccount) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListOpsRatedRecords200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as ListOpsRatedRecords200
    }

    const limit = clampLimit(q?.limit)
    const sortBy = q?.sort_by === 'rated_at' ? 'rated_at' : 'created_at'
    const sortOrder = q?.sort_order === 'asc' ? 'asc' : 'desc'
    const cursor = parseCursor(q?.cursor, sortBy, sortOrder)

    let query = db
      .selectFrom('billing_rated_records as brr')
      .innerJoin('billing_ratings as br', 'br.rating_id', 'brr.rating_id')
      .select([
        'brr.rated_record_id',
        'brr.rating_id',
        'brr.meter_code',
        'brr.quantity_minor',
        'brr.amount_xusd',
        'brr.cost_xusd',
        'brr.unit_price_xusd',
        'brr.unit_quantity_minor',
        'brr.rounding',
        'brr.unit_cost_xusd',
        'brr.cost_unit_quantity_minor',
        'brr.cost_rounding',
        'brr.pricing_snapshot',
        'brr.pricing_fingerprint',
        'brr.cost_snapshot',
        'brr.cost_fingerprint',
        'brr.metadata',
        'brr.created_at',
        'br.billing_account_id as billing_account_id',
        'br.billing_user_id as billing_user_id',
        'br.rated_at as rating_rated_at',
      ])
      .orderBy(sortBy === 'rated_at' ? 'br.rated_at' : 'brr.created_at', sortOrder)
      .orderBy('brr.rated_record_id', sortOrder)
      .limit(limit + 1)

    if (targetBa) {
      query = query.where('br.billing_account_id', '=', targetBa)
    }
    if (reqBu) {
      query = query.where('br.billing_user_id', '=', reqBu)
    }
    if (q?.rating_id) {
      query = query.where(sql`brr.rating_id::text`, '=', String(q.rating_id))
    }
    if (q?.meter_code) {
      query = query.where('brr.meter_code', '=', q.meter_code)
    }
    if (q?.feature_code) {
      query = query.where('br.feature_code', '=', q.feature_code)
    }
    if (q?.direction) {
      query = query.where('br.direction', '=', q.direction)
    }
    if (q?.pricing_fingerprint) {
      query = query.where('brr.pricing_fingerprint', '=', q.pricing_fingerprint)
    }
    if (q?.cost_fingerprint) {
      query = query.where('brr.cost_fingerprint', '=', q.cost_fingerprint)
    }
    if (q?.rated_after) {
      query = query.where('br.rated_at', '>=', new Date(q.rated_after))
    }
    if (q?.rated_before) {
      query = query.where('br.rated_at', '<=', new Date(q.rated_before))
    }
    if (cursor) {
      const timeColumn = sortBy === 'rated_at' ? 'br.rated_at' : 'brr.created_at'
      query = applyCursor(query, timeColumn, 'brr.rated_record_id', cursor, sortOrder)
    }

    const rows = await query.execute()
    const records: OpsComponents['schemas']['OpsRatedRecord'][] = rows.slice(0, limit).map((row) => ({
      rated_record_id: String(row.rated_record_id),
      rating_id: String(row.rating_id),
      billing_account_id: String(row.billing_account_id),
      billing_user_id: String(row.billing_user_id),
      meter_code: row.meter_code,
      quantity_minor: String(row.quantity_minor),
      amount_xusd: String(row.amount_xusd),
      cost_xusd: String(row.cost_xusd),
      unit_price_xusd: String(row.unit_price_xusd),
      unit_quantity_minor: String(row.unit_quantity_minor),
      rounding: row.rounding,
      unit_cost_xusd: String(row.unit_cost_xusd),
      cost_unit_quantity_minor: String(row.cost_unit_quantity_minor),
      cost_rounding: row.cost_rounding,
      pricing_snapshot: row.pricing_snapshot as Record<string, unknown>,
      pricing_fingerprint: row.pricing_fingerprint,
      cost_snapshot: row.cost_snapshot as Record<string, unknown>,
      cost_fingerprint: row.cost_fingerprint,
      metadata: row.metadata as Record<string, unknown>,
      created_at: toIso(row.created_at),
    }))

    const hasMore = rows.length > limit
    const cursorTime = sortBy === 'rated_at' ? rows[limit]?.rating_rated_at : rows[limit]?.created_at
    const nextCursor = hasMore ? encodeCursor(cursorTime as Date, rows[limit].rated_record_id, sortBy, sortOrder) : null
    return okEnvelope(records, { meta: { next_cursor: nextCursor, has_more: hasMore, limit } }) as ListOpsRatedRecords200
  }

  @Get('rated-records/:rated_record_id')
  async getRatedRecord(
    @Req() req: AppRequest,
    @Param() params: GetOpsRatedRecordParams,
    @Query() q: GetOpsRatedRecordQuery,
  ): Promise<GetOpsRatedRecord200> {
    const ctxBa = req?.ctx?.billingAccountId
    const reqBa = String(q?.billing_account_id || '')
    const reqBu = String(q?.billing_user_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetOpsRatedRecord200
    }
    if (!targetBa && !allowCrossAccount) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetOpsRatedRecord200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as GetOpsRatedRecord200
    }

    let query = db
      .selectFrom('billing_rated_records as brr')
      .innerJoin('billing_ratings as br', 'br.rating_id', 'brr.rating_id')
      .select([
        'brr.rated_record_id',
        'brr.rating_id',
        'brr.meter_code',
        'brr.quantity_minor',
        'brr.amount_xusd',
        'brr.cost_xusd',
        'brr.unit_price_xusd',
        'brr.unit_quantity_minor',
        'brr.rounding',
        'brr.unit_cost_xusd',
        'brr.cost_unit_quantity_minor',
        'brr.cost_rounding',
        'brr.pricing_snapshot',
        'brr.pricing_fingerprint',
        'brr.cost_snapshot',
        'brr.cost_fingerprint',
        'brr.metadata',
        'brr.created_at',
        'br.billing_account_id as billing_account_id',
        'br.billing_user_id as billing_user_id',
      ])
      .where(sql`brr.rated_record_id::text`, '=', String(params.rated_record_id))

    if (targetBa) {
      query = query.where('br.billing_account_id', '=', targetBa)
    }
    if (reqBu) {
      query = query.where('br.billing_user_id', '=', reqBu)
    }

    const row = await query.executeTakeFirst()
    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'rated record not found' }) as unknown as GetOpsRatedRecord200
    }

    const record: OpsComponents['schemas']['OpsRatedRecord'] = {
      rated_record_id: String(row.rated_record_id),
      rating_id: String(row.rating_id),
      billing_account_id: String(row.billing_account_id),
      billing_user_id: String(row.billing_user_id),
      meter_code: row.meter_code,
      quantity_minor: String(row.quantity_minor),
      amount_xusd: String(row.amount_xusd),
      cost_xusd: String(row.cost_xusd),
      unit_price_xusd: String(row.unit_price_xusd),
      unit_quantity_minor: String(row.unit_quantity_minor),
      rounding: row.rounding,
      unit_cost_xusd: String(row.unit_cost_xusd),
      cost_unit_quantity_minor: String(row.cost_unit_quantity_minor),
      cost_rounding: row.cost_rounding,
      pricing_snapshot: row.pricing_snapshot as Record<string, unknown>,
      pricing_fingerprint: row.pricing_fingerprint,
      cost_snapshot: row.cost_snapshot as Record<string, unknown>,
      cost_fingerprint: row.cost_fingerprint,
      metadata: row.metadata as Record<string, unknown>,
      created_at: toIso(row.created_at),
    }

    return okEnvelope(record) as GetOpsRatedRecord200
  }

  @Get('allocations')
  async listAllocations(@Req() req: AppRequest, @Query() q: ListOpsAllocationsQuery): Promise<ListOpsAllocations200> {
    const ctxBa = req?.ctx?.billingAccountId
    const reqBa = String(q?.billing_account_id || '')
    const reqBu = String(q?.billing_user_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListOpsAllocations200
    }
    if (!targetBa && !allowCrossAccount) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as ListOpsAllocations200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as ListOpsAllocations200
    }

    const limit = clampLimit(q?.limit)
    const sortBy = q?.sort_by === 'decided_at' ? 'decided_at' : 'rated_at'
    const sortOrder = q?.sort_order === 'asc' ? 'asc' : 'desc'
    const cursor = parseCursor(q?.cursor, sortBy, sortOrder)
    const expandSet = normalizeExpand(q?.expand)
    const includeRating = expandSet.has('rating') || expandSet.has('rating.rated_records')
    const includeRatedRecords = expandSet.has('rating.rated_records')

    let query = db
      .selectFrom('billing_rating_allocations as bra')
      .select([
        'bra.allocation_id',
        'bra.realm_id',
        'bra.rating_id',
        'bra.direction',
        'bra.billing_account_id',
        'bra.billing_user_id',
        'bra.budget_id',
        'bra.feature_code',
        'bra.pricing_fingerprint',
        'bra.cost_fingerprint',
        'bra.grant_id',
        'bra.funding_kind',
        'bra.allocated_xusd',
        'bra.alloc_seq',
        'bra.reversal_of_allocation_id',
        'bra.application_status',
        'bra.reason_codes',
        'bra.late_rating',
        'bra.amount_xusd',
        'bra.cost_xusd',
        'bra.rated_at',
        'bra.applied_quantity_minor',
        'bra.applied_amount_xusd',
        'bra.applied_cost_xusd',
        'bra.usage_started_at',
        'bra.usage_finished_at',
        'bra.decided_at',
        'bra.settlement_scope_kind',
        'bra.settlement_scope_key',
        'bra.settlement_batch_id',
        'bra.engine',
        'bra.engine_run_id',
        'bra.settlement_state',
        'bra.entry_id',
        'bra.entry_ref',
        'bra.entry_amount_xusd',
        'bra.entry_reason',
        'bra.settled_at',
        'bra.error_code',
        'bra.error_message',
        'bra.metadata',
        'bra.created_at',
        'bra.updated_at',
      ])
      .orderBy(`bra.${sortBy}`, sortOrder)
      .orderBy('bra.allocation_id', sortOrder)
      .limit(limit + 1)

    if (targetBa) {
      query = query.where('bra.billing_account_id', '=', targetBa)
    }
    if (reqBu) {
      query = query.where('bra.billing_user_id', '=', reqBu)
    }
    if (q?.rating_id) {
      query = query.where(sql`bra.rating_id::text`, '=', String(q.rating_id))
    }
    if (q?.grant_id) {
      query = query.where(sql`bra.grant_id::text`, '=', String(q.grant_id))
    }
    if (q?.budget_id) {
      query = query.where(sql`bra.budget_id::text`, '=', String(q.budget_id))
    }
    if (q?.feature_code) {
      query = query.where('bra.feature_code', '=', q.feature_code)
    }
    if (q?.meter_code) {
      query = query.where(
        sql<boolean>`exists (
          select 1
          from billing_rated_records as brr
          where brr.rating_id = ${sql.ref('bra.rating_id')}
            and brr.meter_code = ${q.meter_code}
        )`,
      )
    }
    if (q?.funding_kind) {
      query = query.where('bra.funding_kind', '=', q.funding_kind)
    }
    if (q?.application_status) {
      query = query.where('bra.application_status', '=', q.application_status)
    }
    if (q?.settlement_state) {
      query = query.where('bra.settlement_state', '=', q.settlement_state)
    }
    const lateRating = parseBool(q?.late_rating)
    if (lateRating !== undefined) {
      query = query.where('bra.late_rating', '=', lateRating)
    }
    if (q?.rated_after) {
      query = query.where('bra.rated_at', '>=', new Date(q.rated_after))
    }
    if (q?.rated_before) {
      query = query.where('bra.rated_at', '<=', new Date(q.rated_before))
    }
    if (q?.decided_after) {
      query = query.where('bra.decided_at', '>=', new Date(q.decided_after))
    }
    if (q?.decided_before) {
      query = query.where('bra.decided_at', '<=', new Date(q.decided_before))
    }
    if (q?.settlement_scope_kind) {
      query = query.where('bra.settlement_scope_kind', '=', q.settlement_scope_kind)
    }
    if (q?.settlement_scope_key) {
      query = query.where('bra.settlement_scope_key', '=', q.settlement_scope_key)
    }
    if (q?.engine) {
      query = query.where('bra.engine', '=', q.engine)
    }
    if (q?.entry_id) {
      query = query.where(sql`bra.entry_id::text`, '=', String(q.entry_id))
    }
    if (cursor) {
      query = applyCursor(query, `bra.${sortBy}`, 'bra.allocation_id', cursor, sortOrder)
    }

    const rows = await query.execute()
    const pageRows = rows.slice(0, limit)
    const allocations: OpsComponents['schemas']['OpsAllocation'][] = pageRows.map((row) => ({
      allocation_id: String(row.allocation_id),
      realm_id: String(row.realm_id),
      rating_id: String(row.rating_id),
      direction: row.direction,
      billing_account_id: String(row.billing_account_id),
      billing_user_id: String(row.billing_user_id),
      budget_id: row.budget_id ? String(row.budget_id) : null,
      feature_code: row.feature_code,
      pricing_fingerprint: row.pricing_fingerprint ?? null,
      cost_fingerprint: row.cost_fingerprint ?? null,
      grant_id: row.grant_id ? String(row.grant_id) : null,
      funding_kind: row.funding_kind,
      allocated_xusd: String(row.allocated_xusd),
      alloc_seq: Number(row.alloc_seq),
      reversal_of_allocation_id: row.reversal_of_allocation_id ? String(row.reversal_of_allocation_id) : null,
      application_status: row.application_status,
      reason_codes: (row.reason_codes as string[] | null | undefined) ?? [],
      late_rating: Boolean(row.late_rating),
      amount_xusd: String(row.amount_xusd),
      cost_xusd: String(row.cost_xusd),
      rated_at: toIso(row.rated_at),
      applied_quantity_minor: String(row.applied_quantity_minor),
      applied_amount_xusd: String(row.applied_amount_xusd),
      applied_cost_xusd: String(row.applied_cost_xusd),
      usage_started_at: toIso(row.usage_started_at),
      usage_finished_at: toIso(row.usage_finished_at),
      decided_at: toIso(row.decided_at),
      settlement_scope_kind: row.settlement_scope_kind ?? null,
      settlement_scope_key: row.settlement_scope_key ?? null,
      settlement_batch_id: row.settlement_batch_id ?? null,
      engine: row.engine ?? null,
      engine_run_id: row.engine_run_id ?? null,
      settlement_state: row.settlement_state,
      entry_id: row.entry_id ? String(row.entry_id) : null,
      entry_ref: row.entry_ref ?? null,
      entry_amount_xusd: row.entry_amount_xusd ? String(row.entry_amount_xusd) : null,
      entry_reason: row.entry_reason ?? null,
      settled_at: toIso(row.settled_at),
      error_code: row.error_code ?? null,
      error_message: row.error_message ?? null,
      metadata: row.metadata as Record<string, unknown>,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
    }))

    if (includeRating && allocations.length > 0) {
      const ratingIds = Array.from(new Set(allocations.map((allocation) => allocation.rating_id)))
      const ratingsById = await fetchRatingsByIds(db, ratingIds, includeRatedRecords)
      for (const allocation of allocations) {
        const rating = ratingsById.get(allocation.rating_id)
        if (rating) {
          allocation.rating = rating
        }
      }
    }

    const hasMore = rows.length > limit
    const nextCursor = hasMore ? encodeCursor(rows[limit][sortBy as 'rated_at' | 'decided_at'], rows[limit].allocation_id, sortBy, sortOrder) : null
    return okEnvelope(allocations, { meta: { next_cursor: nextCursor, has_more: hasMore, limit } }) as ListOpsAllocations200
  }

  @Get('allocations/:allocation_id')
  async getAllocation(
    @Req() req: AppRequest,
    @Param() params: GetOpsAllocationParams,
    @Query() q: GetOpsAllocationQuery,
  ): Promise<GetOpsAllocation200> {
    const ctxBa = req?.ctx?.billingAccountId
    const reqBa = String(q?.billing_account_id || '')
    const reqBu = String(q?.billing_user_id || '')
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    const targetBa = allowCrossAccount ? (reqBa || undefined) : ctxBa
    if (!allowCrossAccount && (!ctxBa || ctxBa !== reqBa)) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetOpsAllocation200
    }
    if (!targetBa && !allowCrossAccount) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetOpsAllocation200
    }
    if (allowCrossAccount && reqBa && reqBa !== ctxBa) {
      req.ctx = req.ctx || {}
      req.ctx.billingAccountId = reqBa
    }
    const db = req.ctx?.db
    if (!db) {
      return errEnvelope('SERVER.CONFIG', { message: 'DB session unavailable' }) as unknown as GetOpsAllocation200
    }

    let query = db
      .selectFrom('billing_rating_allocations as bra')
      .select([
        'bra.allocation_id',
        'bra.realm_id',
        'bra.rating_id',
        'bra.direction',
        'bra.billing_account_id',
        'bra.billing_user_id',
        'bra.budget_id',
        'bra.feature_code',
        'bra.pricing_fingerprint',
        'bra.cost_fingerprint',
        'bra.grant_id',
        'bra.funding_kind',
        'bra.allocated_xusd',
        'bra.alloc_seq',
        'bra.reversal_of_allocation_id',
        'bra.application_status',
        'bra.reason_codes',
        'bra.late_rating',
        'bra.amount_xusd',
        'bra.cost_xusd',
        'bra.rated_at',
        'bra.applied_quantity_minor',
        'bra.applied_amount_xusd',
        'bra.applied_cost_xusd',
        'bra.usage_started_at',
        'bra.usage_finished_at',
        'bra.decided_at',
        'bra.settlement_scope_kind',
        'bra.settlement_scope_key',
        'bra.settlement_batch_id',
        'bra.engine',
        'bra.engine_run_id',
        'bra.settlement_state',
        'bra.entry_id',
        'bra.entry_ref',
        'bra.entry_amount_xusd',
        'bra.entry_reason',
        'bra.settled_at',
        'bra.error_code',
        'bra.error_message',
        'bra.metadata',
        'bra.created_at',
        'bra.updated_at',
      ])
      .where(sql`bra.allocation_id::text`, '=', String(params.allocation_id))

    if (targetBa) {
      query = query.where('bra.billing_account_id', '=', targetBa)
    }
    if (reqBu) {
      query = query.where('bra.billing_user_id', '=', reqBu)
    }

    const expandSet = normalizeExpand(q?.expand)
    const includeRating = expandSet.has('rating') || expandSet.has('rating.rated_records')
    const includeRatedRecords = expandSet.has('rating.rated_records')

    const row = await query.executeTakeFirst()
    if (!row) {
      return errEnvelope('RESOURCE.NOT_FOUND', { message: 'allocation not found' }) as unknown as GetOpsAllocation200
    }

    const allocation: OpsComponents['schemas']['OpsAllocation'] = {
      allocation_id: String(row.allocation_id),
      realm_id: String(row.realm_id),
      rating_id: String(row.rating_id),
      direction: row.direction,
      billing_account_id: String(row.billing_account_id),
      billing_user_id: String(row.billing_user_id),
      budget_id: row.budget_id ? String(row.budget_id) : null,
      feature_code: row.feature_code,
      pricing_fingerprint: row.pricing_fingerprint ?? null,
      cost_fingerprint: row.cost_fingerprint ?? null,
      grant_id: row.grant_id ? String(row.grant_id) : null,
      funding_kind: row.funding_kind,
      allocated_xusd: String(row.allocated_xusd),
      alloc_seq: Number(row.alloc_seq),
      reversal_of_allocation_id: row.reversal_of_allocation_id ? String(row.reversal_of_allocation_id) : null,
      application_status: row.application_status,
      reason_codes: (row.reason_codes as string[] | null | undefined) ?? [],
      late_rating: Boolean(row.late_rating),
      amount_xusd: String(row.amount_xusd),
      cost_xusd: String(row.cost_xusd),
      rated_at: toIso(row.rated_at),
      applied_quantity_minor: String(row.applied_quantity_minor),
      applied_amount_xusd: String(row.applied_amount_xusd),
      applied_cost_xusd: String(row.applied_cost_xusd),
      usage_started_at: toIso(row.usage_started_at),
      usage_finished_at: toIso(row.usage_finished_at),
      decided_at: toIso(row.decided_at),
      settlement_scope_kind: row.settlement_scope_kind ?? null,
      settlement_scope_key: row.settlement_scope_key ?? null,
      settlement_batch_id: row.settlement_batch_id ?? null,
      engine: row.engine ?? null,
      engine_run_id: row.engine_run_id ?? null,
      settlement_state: row.settlement_state,
      entry_id: row.entry_id ? String(row.entry_id) : null,
      entry_ref: row.entry_ref ?? null,
      entry_amount_xusd: row.entry_amount_xusd ? String(row.entry_amount_xusd) : null,
      entry_reason: row.entry_reason ?? null,
      settled_at: toIso(row.settled_at),
      error_code: row.error_code ?? null,
      error_message: row.error_message ?? null,
      metadata: row.metadata as Record<string, unknown>,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
    }

    if (includeRating) {
      const ratingsById = await fetchRatingsByIds(db, [allocation.rating_id], includeRatedRecords)
      const rating = ratingsById.get(allocation.rating_id)
      if (rating) {
        allocation.rating = rating
      }
    }

    return okEnvelope(allocation) as GetOpsAllocation200
  }
}

type CatalogProductRow = {
  catalog_product_id: string
  realm_id: string
  product_code: string
  provider: string
  provider_product_id: string
  kind: 'subscription' | 'credit'
  status: 'active' | 'archived' | 'draft'
  display_priority: number
  presentation_config: Record<string, unknown> | null
  name: string
  default_currency: string
  metadata: Record<string, unknown> | null
  created_at: Date
}

type CatalogPriceRow = {
  catalog_price_id: string
  realm_id: string
  catalog_product_id: string
  price_code: string
  provider_price_id: string
  status: 'active' | 'archived'
  currency: string
  unit_amount: number
  recurring_interval: 'month' | 'year' | null
  recurring_count: number | null
  display_priority: number
  metadata: unknown | null
  subscription_group_id: string | null
  subscription_group_key: string | null
  created_at: Date
}

function mapCatalogProductRow(row: CatalogProductRow): OpsComponents['schemas']['OpsCatalogProduct'] {
  return {
    catalog_product_id: String(row.catalog_product_id),
    realm_id: String(row.realm_id),
    product_code: row.product_code,
    provider: row.provider,
    provider_product_id: row.provider_product_id,
    kind: row.kind,
    status: row.status,
    display_priority: Number(row.display_priority ?? 100),
    presentation_config: normalizePresentationConfig(row.presentation_config) ?? {},
    name: row.name,
    default_currency: row.default_currency,
    metadata: row.metadata ?? {},
    created_at: toIso(row.created_at),
  }
}

function normalizePresentationConfig(value: unknown): Record<string, unknown> | null {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function normalizeSubscriptionGroupKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized : null
}

async function resolveSubscriptionGroupId(
  db: NonNullable<NonNullable<AppRequest['ctx']>['db']>,
  realmId: string,
  subscriptionGroupKey: string,
): Promise<string> {
  const existing = await db
    .selectFrom('subscription_groups')
    .select(['subscription_group_id'])
    .where('realm_id', '=', realmId)
    .where('group_key', '=', subscriptionGroupKey)
    .executeTakeFirst()

  if (existing?.subscription_group_id) {
    return String(existing.subscription_group_id)
  }

  const inserted = await db
    .insertInto('subscription_groups')
    .values({
      realm_id: realmId,
      group_key: subscriptionGroupKey,
      title: subscriptionGroupKey,
      is_stackable: false,
      is_exclusive: true,
    })
    .returning(['subscription_group_id'])
    .executeTakeFirstOrThrow()

  return String(inserted.subscription_group_id)
}

function mapCatalogPriceRow(row: CatalogPriceRow): OpsComponents['schemas']['OpsCatalogPrice'] {
  return {
    catalog_price_id: String(row.catalog_price_id),
    realm_id: String(row.realm_id),
    catalog_product_id: String(row.catalog_product_id),
    price_code: row.price_code,
    provider_price_id: row.provider_price_id,
    status: row.status,
    currency: row.currency,
    unit_amount: Number(row.unit_amount),
    recurring_interval: row.recurring_interval ?? null,
    recurring_count: row.recurring_count ?? null,
    display_priority: Number(row.display_priority),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    subscription_group_id: row.subscription_group_id ?? null,
    subscription_group_key: row.subscription_group_key ?? null,
    created_at: toIso(row.created_at),
  }
}

function selectDefaultPrice(prices: CatalogPriceRow[], defaultCurrency: string): CatalogPriceRow | null {
  if (prices.length === 0) return null
  const match = prices.find((price) => price.currency === defaultCurrency)
  return match ?? prices[0] ?? null
}

async function fetchCatalogPricesForProducts(
  db: AppRequest['ctx']['db'],
  realmId: string,
  productIds: string[],
): Promise<Map<string, CatalogPriceRow[]>> {
  const ids = Array.from(new Set(productIds.map((id) => String(id)).filter((id) => id.length > 0)))
  const map = new Map<string, CatalogPriceRow[]>()
  if (!db || ids.length === 0) return map

  const rows = await db
    .selectFrom('catalog_prices as cp')
    .select([
      'cp.catalog_price_id',
      'cp.realm_id',
      'cp.catalog_product_id',
      'cp.price_code',
      'cp.provider_price_id',
      'cp.status',
      'cp.currency',
      'cp.unit_amount',
      'cp.recurring_interval',
      'cp.recurring_count',
      'cp.display_priority',
      'cp.metadata',
      'cp.subscription_group_id',
      'cp.subscription_group_key',
      'cp.created_at',
    ])
    .where('cp.realm_id', '=', realmId)
    .where('cp.catalog_product_id', 'in', ids)
    .orderBy('cp.catalog_product_id')
    .orderBy('cp.display_priority')
    .orderBy('cp.unit_amount')
    .orderBy('cp.catalog_price_id')
    .execute()

  for (const row of rows as CatalogPriceRow[]) {
    const key = String(row.catalog_product_id)
    const list = map.get(key) ?? []
    list.push(row)
    map.set(key, list)
  }
  return map
}

async function fetchCatalogProductsByIds(
  db: AppRequest['ctx']['db'],
  realmId: string,
  productIds: string[],
): Promise<Map<string, CatalogProductRow>> {
  const ids = Array.from(new Set(productIds.map((id) => String(id)).filter((id) => id.length > 0)))
  const map = new Map<string, CatalogProductRow>()
  if (!db || ids.length === 0) return map

  const rows = await db
    .selectFrom('catalog_products as cp')
    .select([
      'cp.catalog_product_id',
      'cp.realm_id',
      'cp.product_code',
      'cp.provider',
      'cp.provider_product_id',
      'cp.kind',
      'cp.status',
      'cp.display_priority',
      'cp.presentation_config',
      'cp.name',
      'cp.default_currency',
      'cp.metadata',
      'cp.created_at',
    ])
    .where('cp.realm_id', '=', realmId)
    .where('cp.catalog_product_id', 'in', ids)
    .execute()

  for (const row of rows as CatalogProductRow[]) {
    map.set(String(row.catalog_product_id), row)
  }
  return map
}

function clampLimit(raw: unknown, fallback = 50, max = 200): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.trunc(n), max)
}

function findDuplicateGrantProgramCode(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const raw = (metadata as Record<string, unknown>).grants
  if (!raw) return null
  const list = Array.isArray(raw) ? raw : [raw]
  const seen = new Set<string>()
  for (const candidate of list) {
    const override = normalizeGrantBindingOverride(candidate)
    const programCode = override?.programCode
    if (!programCode) continue
    if (seen.has(programCode)) return programCode
    seen.add(programCode)
  }
  return null
}

function parseCursor(
  cursor?: string | null,
  sortBy: string = 'occurred_at',
  sortOrder: string = 'desc',
): { time: Date; id: string } | null {
  if (!cursor) return null
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as { t: string; id: string; sort_by?: string; sort_order?: string }
    if (parsed.sort_by && parsed.sort_by !== sortBy) return null
    if (parsed.sort_order && parsed.sort_order !== sortOrder) return null
    const dt = new Date(parsed.t)
    if (Number.isNaN(dt.getTime())) return null
    if (!parsed.id || typeof parsed.id !== 'string') return null
    return { time: dt, id: parsed.id }
  } catch {
    return null
  }
}

function encodeCursor(time: Date | string, id: unknown, sortBy: string, sortOrder: string): string {
  const t = time instanceof Date ? time.toISOString() : new Date(time).toISOString()
  const payload = { t, id: String(id), sort_by: sortBy, sort_order: sortOrder }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function applyCursor<DB, TB extends keyof DB, O>(
  query: SelectQueryBuilder<DB, TB, O>,
  timeColumn: string,
  idColumn: string,
  cursor: { time: Date; id: string },
  sortOrder: 'asc' | 'desc',
) {
  const timeRef = timeColumn as unknown as ReferenceExpression<DB, TB>
  const idRef = idColumn as unknown as ReferenceExpression<DB, TB>
  if (sortOrder === 'asc') {
    return query.where((eb: ExpressionBuilder<DB, TB>) =>
      eb.or([
        eb(timeRef, '>', cursor.time),
        eb.and([eb(timeRef, '=', cursor.time), eb(idRef, '>', cursor.id)]),
      ]),
    )
  }
  return query.where((eb: ExpressionBuilder<DB, TB>) =>
    eb.or([
      eb(timeRef, '<', cursor.time),
      eb.and([eb(timeRef, '=', cursor.time), eb(idRef, '<', cursor.id)]),
    ]),
  )
}

function normalizeArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

function normalizeExpand(value: unknown): Set<string> {
  const items = normalizeArray(value)
  return new Set(items)
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return new Date(value).toISOString()
  return new Date(value as Date).toISOString()
}

function dateTruncLiteral(granularity: 'day' | 'month'): ReturnType<typeof sql.raw> {
  if (granularity === 'month') return sql.raw("'month'")
  return sql.raw("'day'")
}

async function fetchEventLabels(
  db: AppRequest['ctx']['db'],
  eventIds: string[],
): Promise<Map<string, OpsComponents['schemas']['OpsEventLabel'][]>> {
  if (!db) return new Map()
  const rows = await db
    .selectFrom('billing_event_labels as bel')
    .select(['bel.event_id', 'bel.label_key', 'bel.value_text', 'bel.value_uuid', 'bel.value_bool', 'bel.value_number'])
    .where('bel.event_id', 'in', eventIds)
    .execute()
  const map = new Map<string, OpsComponents['schemas']['OpsEventLabel'][]>()
  for (const row of rows) {
    const key = String(row.event_id)
    const list = map.get(key) || []
    list.push({
      label_key: row.label_key,
      value_text: row.value_text ?? null,
      value_uuid: row.value_uuid ?? null,
      value_bool: row.value_bool ?? null,
      value_number: row.value_number ? Number(row.value_number) : null,
    })
    map.set(key, list)
  }
  return map
}

async function fetchRatingsByIds(
  db: AppRequest['ctx']['db'],
  ratingIds: string[],
  includeRatedRecords: boolean,
): Promise<Map<string, OpsComponents['schemas']['OpsRating']>> {
  if (!db || ratingIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('billing_ratings as br')
    .select([
      'br.rating_id',
      'br.realm_id',
      'br.billing_account_id',
      'br.billing_user_id',
      'br.rating_kind',
      'br.idempotency_id',
      'br.source_ref',
      'br.budget_id',
      'br.feature_code',
      'br.direction',
      'br.reversal_of_rating_id',
      'br.canonical_quantity_minor',
      'br.canonical_amount_xusd',
      'br.canonical_cost_xusd',
      'br.pricing_fingerprint',
      'br.pricing_cost_fingerprint',
      'br.cost_snapshot',
      'br.cost_fingerprint',
      'br.metadata',
      'br.rated_at',
      'br.created_at',
    ])
    .where('br.rating_id', 'in', ratingIds)
    .execute()

  const ratedRecordsByRating = includeRatedRecords ? await fetchRatedRecordsByRatingIds(db, ratingIds) : new Map()
  const map = new Map<string, OpsComponents['schemas']['OpsRating']>()
  for (const row of rows) {
    const ratingId = String(row.rating_id)
    map.set(ratingId, {
      rating_id: ratingId,
      realm_id: String(row.realm_id),
      billing_account_id: String(row.billing_account_id),
      billing_user_id: String(row.billing_user_id),
      rating_kind: row.rating_kind,
      idempotency_id: row.idempotency_id,
      source_ref: row.source_ref ?? null,
      budget_id: row.budget_id ? String(row.budget_id) : null,
      feature_code: row.feature_code,
      direction: row.direction,
      reversal_of_rating_id: row.reversal_of_rating_id ? String(row.reversal_of_rating_id) : null,
      canonical_quantity_minor: String(row.canonical_quantity_minor),
      canonical_amount_xusd: String(row.canonical_amount_xusd),
      canonical_cost_xusd: String(row.canonical_cost_xusd),
      pricing_fingerprint: row.pricing_fingerprint,
      pricing_cost_fingerprint: row.pricing_cost_fingerprint,
      cost_snapshot: row.cost_snapshot as Record<string, unknown>,
      cost_fingerprint: row.cost_fingerprint,
      metadata: row.metadata as Record<string, unknown>,
      rated_at: toIso(row.rated_at),
      created_at: toIso(row.created_at),
      rated_records: includeRatedRecords ? ratedRecordsByRating.get(ratingId) ?? [] : undefined,
    })
  }
  return map
}

async function fetchRatedRecordsByRatingIds(
  db: AppRequest['ctx']['db'],
  ratingIds: string[],
): Promise<Map<string, OpsComponents['schemas']['OpsRatedRecord'][]>> {
  if (!db || ratingIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('billing_rated_records as brr')
    .innerJoin('billing_ratings as br', 'br.rating_id', 'brr.rating_id')
    .select([
      'brr.rated_record_id',
      'brr.rating_id',
      'br.billing_account_id as billing_account_id',
      'br.billing_user_id as billing_user_id',
      'brr.meter_code',
      'brr.quantity_minor',
      'brr.amount_xusd',
      'brr.cost_xusd',
      'brr.unit_price_xusd',
      'brr.unit_quantity_minor',
      'brr.rounding',
      'brr.unit_cost_xusd',
      'brr.cost_unit_quantity_minor',
      'brr.cost_rounding',
      'brr.pricing_snapshot',
      'brr.pricing_fingerprint',
      'brr.cost_snapshot',
      'brr.cost_fingerprint',
      'brr.metadata',
      'brr.created_at',
    ])
    .where('brr.rating_id', 'in', ratingIds)
    .execute()

  const map = new Map<string, OpsComponents['schemas']['OpsRatedRecord'][]>()
  for (const row of rows) {
    const ratingId = String(row.rating_id)
    const list = map.get(ratingId) || []
    list.push({
      rated_record_id: String(row.rated_record_id),
      rating_id: ratingId,
      billing_account_id: String(row.billing_account_id),
      billing_user_id: String(row.billing_user_id),
      meter_code: row.meter_code,
      quantity_minor: String(row.quantity_minor),
      amount_xusd: String(row.amount_xusd),
      cost_xusd: String(row.cost_xusd),
      unit_price_xusd: String(row.unit_price_xusd),
      unit_quantity_minor: String(row.unit_quantity_minor),
      rounding: row.rounding,
      unit_cost_xusd: String(row.unit_cost_xusd),
      cost_unit_quantity_minor: String(row.cost_unit_quantity_minor),
      cost_rounding: row.cost_rounding,
      pricing_snapshot: row.pricing_snapshot as Record<string, unknown>,
      pricing_fingerprint: row.pricing_fingerprint,
      cost_snapshot: row.cost_snapshot as Record<string, unknown>,
      cost_fingerprint: row.cost_fingerprint,
      metadata: row.metadata as Record<string, unknown>,
      created_at: toIso(row.created_at),
    })
    map.set(ratingId, list)
  }
  return map
}
