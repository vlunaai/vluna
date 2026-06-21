import { Injectable, HttpException, Inject } from '@nestjs/common'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../../types/database.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { components as BillingComponents } from '../../../contracts/billing-mgt.js'
import { setRlsSession } from '../../../db/index.js'
import { GrantBalanceService } from '../../../services/grant-balance.service.js'
import {
  ensureBillingPlanGrantsEnrollmentSyncedForUser,
  issueGrantsForBillingUser,
} from '../../../services/billing-plan.service.js'
import {
  activateBillingUserById,
  getBillingAccountSeatSummary,
  normalizeSeatLimitValue,
  provisionBillingUser,
  updateBillingAccountSeatLimit,
  type BillingAccountSeatSummary as BillingAccountSeatSummaryModel,
} from '../../../services/billing-user-provisioning.js'
import { bigintFromUnknown, runInTransaction } from '../../gate/services/gate.utils.js'

type BillingAccountList = BillingComponents['schemas']['BillingAccountList']
type BillingAccount = BillingComponents['schemas']['BillingAccount']
type BillingAccountSeatSummary = BillingComponents['schemas']['BillingAccountSeatSummary']
type BillingAccountUpdateRequest = BillingComponents['schemas']['BillingAccountUpdateRequest']
type BillingAccountBillingDetailsMasked = BillingComponents['schemas']['BillingAccountBillingDetailsMasked']
type BillingAccountBillingDetailsUpdateRequest =
  BillingComponents['schemas']['BillingAccountBillingDetailsUpdateRequest']
type BillingAccountBillingDetailsAddress =
  BillingComponents['schemas']['BillingAccountBillingDetailsAddress']
type BillingUser = BillingComponents['schemas']['BillingUser']
type BillingUserList = BillingComponents['schemas']['BillingUserList']
type BillingUserCreateRequest = BillingComponents['schemas']['BillingUserCreateRequest']
type BillingUserUpdateRequest = BillingComponents['schemas']['BillingUserUpdateRequest']
type BillingUserStatus = BillingComponents['schemas']['BillingUserStatus']
type BillingUserWallet = BillingComponents['schemas']['BillingUserWallet']
type BillingUserSummary = BillingComponents['schemas']['BillingUserSummary']
type BillingUserSummaryCounts = BillingComponents['schemas']['BillingUserSummaryCounts']
type BillingUserActivityItem = BillingComponents['schemas']['BillingUserActivityItem']
type BillingUserActivityKind = BillingComponents['schemas']['BillingUserActivityKind']
type BillingUserActivityList = BillingComponents['schemas']['BillingUserActivityList']

@Injectable()
export class BillingAccountsService {
  constructor(@Inject(GrantBalanceService) private readonly grantBalanceService: GrantBalanceService) {}

  async listBillingAccounts(req: AppRequest, query: Record<string, unknown>): Promise<BillingAccountList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursorRaw = typeof query?.cursor === 'string' ? query.cursor.trim() : ''
    const sortBy = query?.sort_by === 'created_at' ? 'created_at' : 'billing_account_id'
    const sortOrder = query?.sort_order === 'desc' ? 'desc' : 'asc'
    const billingAccountIds = normalizeArray(query?.billing_account_id)
    const principalId = normalizeString(query?.billing_principal_id)
    const createdAfter = toDate(query?.created_after)
    const createdBefore = toDate(query?.created_before)
    const search = normalizeString(query?.q)
    const expand = normalizeArray(query?.expand)
    const includeBillingDetails = expand.includes('billing_details')
    const includeSeatSummary = expand.includes('seat_summary')

    let builder = trx
      .selectFrom('billing_accounts as ba')
      .leftJoin('billing_account_billing_details as bbd', 'bbd.billing_account_id', 'ba.billing_account_id')
      .select([
        'ba.billing_account_id',
        'ba.billing_principal_id',
        'ba.seat_limit',
        'ba.seat_limit_source',
        'ba.seat_limit_updated_at',
        'ba.metadata',
        'ba.created_at',
        sql`bbd.billing_account_id`.as('billing_details_id'),
        'bbd.billing_email',
        'bbd.legal_name',
        'bbd.entity_type',
        'bbd.default_address',
        'bbd.tax_ids',
        sql`bbd.metadata`.as('billing_details_metadata'),
        'bbd.last_updated_by',
        'bbd.source_updated_at',
        sql`bbd.created_at`.as('billing_details_created_at'),
        sql`bbd.updated_at`.as('billing_details_updated_at'),
      ])
      .where('ba.realm_id', '=', realmId)

    if (billingAccountIds.length > 0) {
      builder = builder.where('ba.billing_account_id', 'in', billingAccountIds)
    }
    if (principalId) {
      builder = builder.where('ba.billing_principal_id', '=', principalId)
    }
    if (createdAfter) {
      builder = builder.where('ba.created_at', '>', createdAfter)
    }
    if (createdBefore) {
      builder = builder.where('ba.created_at', '<', createdBefore)
    }
    if (search) {
      const like = `%${search}%`
      builder = builder.where((eb) =>
        eb.or([
          eb(sql`ba.billing_account_id::text`, 'ilike', like),
          eb('ba.billing_principal_id', 'ilike', like)
        ]),
      )
    }

    if (sortBy === 'created_at') {
      builder = builder.orderBy('ba.created_at', sortOrder)
      if (cursorRaw) {
        const cursorDate = toDate(cursorRaw)
        if (cursorDate) {
          builder = builder.where('ba.created_at', sortOrder === 'asc' ? '>' : '<', cursorDate)
        }
      }
    } else {
      builder = builder.orderBy('ba.billing_account_id', sortOrder)
      if (cursorRaw) {
        builder = builder.where('ba.billing_account_id', sortOrder === 'asc' ? '>' : '<', cursorRaw)
      }
    }

    builder = builder.orderBy('ba.billing_account_id', sortOrder)

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const seatSummaries = new Map<string, BillingAccountSeatSummaryModel>()
    if (includeSeatSummary) {
      for (const row of pageRows) {
        const billingAccountId = String(row.billing_account_id)
        seatSummaries.set(billingAccountId, await getBillingAccountSeatSummary(trx, { realmId, billingAccountId }))
      }
    }

    const items = pageRows.map((row) => {
      const billingAccountId = String(row.billing_account_id)
      const base = {
        billing_account_id: billingAccountId,
        billing_principal_id: row.billing_principal_id,
        seat_limit: normalizeNullableNumber(row.seat_limit),
        seat_limit_source: row.seat_limit_source ? String(row.seat_limit_source) : null,
        seat_limit_updated_at: row.seat_limit_updated_at ? row.seat_limit_updated_at.toISOString() : null,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        created_at: row.created_at.toISOString(),
      } satisfies BillingAccount
      const seatSummary = seatSummaries.get(billingAccountId)
      const account = seatSummary ? { ...base, seat_summary: mapSeatSummary(seatSummary) } : base

      if (!includeBillingDetails) return account

      const details = mapBillingDetailsMasked(row, String(row.billing_account_id))
      return {
        ...account,
        billing_details: details,
      } satisfies BillingAccount
    })
    const nextCursor =
      hasMore
        ? (sortBy === 'created_at'
            ? items[items.length - 1]?.created_at ?? null
            : items[items.length - 1]?.billing_account_id ?? null)
        : null

    return { items, next_cursor: nextCursor } satisfies BillingAccountList
  }

  async updateBillingAccount(
    req: AppRequest,
    billingAccountId: string,
    body: BillingAccountUpdateRequest,
  ): Promise<BillingAccount> {
    const db = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'seat_limit')) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'seat_limit is required' }, 422)
    }
    const seatLimit = normalizeSeatLimitValue(body?.seat_limit)
    await updateBillingAccountSeatLimit(db, {
      realmId,
      billingAccountId,
      seatLimit,
      source: 'ops.manual',
    })
    await setRlsSession(db, { realmId, billingAccountId, isRealmAdmin: true })

    const row = await db
      .selectFrom('billing_accounts')
      .select([
        'billing_account_id',
        'billing_principal_id',
        'seat_limit',
        'seat_limit_source',
        'seat_limit_updated_at',
        'metadata',
        'created_at',
      ])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .executeTakeFirst()
    if (!row) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing account not found' }, 404)
    }
    return mapBillingAccount(row)
  }

  async getBillingAccountSeatSummary(
    req: AppRequest,
    billingAccountId: string,
  ): Promise<BillingAccountSeatSummary> {
    const db = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    return mapSeatSummary(await getBillingAccountSeatSummary(db, { realmId, billingAccountId }))
  }

  async listBillingUsers(
    req: AppRequest,
    billingAccountId: string,
    query: Record<string, unknown>,
  ): Promise<BillingUserList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    await this.ensureBillingAccountExists(trx, realmId, billingAccountId)
    await setRlsSession(trx, { realmId, billingAccountId, isRealmAdmin: true })

    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursorRaw = normalizeString(query?.cursor)
    const search = normalizeString(query?.q)
    const userId = normalizeString(query?.user_id) || normalizeString(query?.business_user_id)
    const statuses = normalizeBillingUserStatuses(query?.status)

    let builder = trx
      .selectFrom('billing_users as bu')
      .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'bu.billing_account_id')
      .select([
        'bu.billing_user_id',
        'bu.realm_id',
        'bu.billing_account_id',
        'ba.billing_principal_id',
        'bu.business_user_id',
        'bu.status',
        'bu.metadata',
        'bu.created_at',
        'bu.updated_at',
      ])
      .where('bu.realm_id', '=', realmId)
      .where('bu.billing_account_id', '=', billingAccountId)
      .orderBy('bu.billing_user_id', 'asc')

    if (cursorRaw) {
      builder = builder.where('bu.billing_user_id', '>', cursorRaw)
    }
    if (userId) {
      builder = builder.where('bu.business_user_id', '=', userId)
    }
    if (statuses.length > 0) {
      builder = builder.where('bu.status', 'in', statuses)
    }
    if (search) {
      const like = `%${search}%`
      builder = builder.where((eb) =>
        eb.or([
          eb(sql`bu.billing_user_id::text`, 'ilike', like),
          eb('bu.business_user_id', 'ilike', like),
          eb(sql`coalesce(bu.metadata->>'display_name', '')`, 'ilike', like),
          eb(sql`coalesce(bu.metadata->>'email', '')`, 'ilike', like),
        ]),
      )
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => mapBillingUser(row as BillingUserRow))
    const nextCursor = hasMore ? items[items.length - 1]?.billing_user_id ?? null : null
    return { items, next_cursor: nextCursor } satisfies BillingUserList
  }

  async createBillingUser(
    req: AppRequest,
    billingAccountId: string,
    body: BillingUserCreateRequest,
  ): Promise<BillingUser> {
    const db = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const businessUserId = normalizeRequiredUserId(body?.user_id, 'user_id')
    const metadata = buildBillingUserMetadata({}, body ?? {})

    return runInTransaction(db, async (trx) => {
      const row = await provisionBillingUser(trx, {
        realmId,
        billingAccountId,
        businessUserId,
        metadata,
        reactivateExisting: true,
        source: 'billing_user.create',
      })
      return mapBillingUser(row)
    })
  }

  async getBillingUser(req: AppRequest, billingUserId: string): Promise<BillingUser> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const row = await this.loadBillingUserRow(trx, realmId, billingUserId)
    await setRlsSession(trx, {
      realmId,
      billingAccountId: row.billing_account_id,
      billingUserId: row.billing_user_id,
      isRealmAdmin: true,
    })
    return mapBillingUser(row)
  }

  async updateBillingUser(
    req: AppRequest,
    billingUserId: string,
    body: BillingUserUpdateRequest,
  ): Promise<BillingUser> {
    const db = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    return runInTransaction(db, async (trx) => {
      const current = await this.loadBillingUserRow(trx, realmId, billingUserId, true)
      await setRlsSession(trx, {
        realmId,
        billingAccountId: current.billing_account_id,
        billingUserId: current.billing_user_id,
        isRealmAdmin: true,
      })

      const patch: {
        status?: BillingUserStatus
        metadata?: Record<string, unknown>
        updated_at?: Date
      } = {}
      const nextMetadata = buildBillingUserMetadata(current.metadata, body ?? {})
      if (Object.keys(nextMetadata).length !== Object.keys(current.metadata).length || !shallowEqual(nextMetadata, current.metadata)) {
        patch.metadata = nextMetadata
      }
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'status')) {
        patch.status = normalizeBillingUserStatus(body?.status)
      }

      const activating = patch.status === 'active' && current.status !== 'active'
      const updatePatch = { ...patch }
      if (activating) {
        delete updatePatch.status
      }

      if (Object.keys(updatePatch).length > 0) {
        updatePatch.updated_at = new Date()
        await trx.updateTable('billing_users').set(updatePatch).where('billing_user_id', '=', billingUserId).executeTakeFirst()
      }

      if (activating) {
        const activated = await activateBillingUserById(trx, {
          realmId,
          billingUserId,
          source: 'billing_user.update',
        })
        return mapBillingUser(activated)
      }

      const loaded = await this.loadBillingUserRow(trx, realmId, billingUserId)
      return mapBillingUser(loaded)
    })
  }

  async disableBillingUser(req: AppRequest, billingUserId: string): Promise<BillingUser> {
    const db = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    return runInTransaction(db, async (trx) => {
      const current = await this.loadBillingUserRow(trx, realmId, billingUserId, true)
      await setRlsSession(trx, {
        realmId,
        billingAccountId: current.billing_account_id,
        billingUserId: current.billing_user_id,
        isRealmAdmin: true,
      })
      await trx
        .updateTable('billing_users')
        .set({ status: 'disabled', updated_at: sql<Date>`now()` })
        .where('billing_user_id', '=', billingUserId)
        .executeTakeFirst()
      return mapBillingUser(await this.loadBillingUserRow(trx, realmId, billingUserId))
    })
  }

  async restoreBillingUser(req: AppRequest, billingUserId: string): Promise<BillingUser> {
    const db = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    return runInTransaction(db, async (trx) => {
      const row = await activateBillingUserById(trx, {
        realmId,
        billingUserId,
        source: 'billing_user.restore',
      })
      return mapBillingUser(row)
    })
  }

  async getBillingUserSummary(req: AppRequest, billingUserId: string): Promise<BillingUserSummary> {
    const db = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    return runInTransaction(db, async (trx) => {
      const row = await this.loadBillingUserRow(trx, realmId, billingUserId)
      await setRlsSession(trx, {
        realmId,
        billingAccountId: row.billing_account_id,
        billingUserId: row.billing_user_id,
        isRealmAdmin: true,
      })

      const wallet = await this.buildWalletSnapshot(trx, row, false)
      const grants = await countUserRows(
        trx,
        'ledger_grants',
        row.billing_account_id,
        row.billing_user_id,
        "issuance_status in ('ready', 'active')",
      )
      const grantAssignments = await countUserRows(
        trx,
        'grant_assignments',
        row.billing_account_id,
        row.billing_user_id,
        "status = 'active'",
      )
      const budgets = await countUserRows(
        trx,
        'budgets',
        row.billing_account_id,
        row.billing_user_id,
        "status = 'active'",
      )
      const usage30d = await sql<{
        amount_xusd: string | null
        cost_xusd: string | null
        commit_count: number | string | null
      }>`
        select
          coalesce(sum((canonical_amount_xusd)::numeric), 0)::text as amount_xusd,
          coalesce(sum((canonical_cost_xusd)::numeric), 0)::text as cost_xusd,
          count(*)::int as commit_count
        from billing_ratings
        where billing_account_id = ${row.billing_account_id}::uuid
          and billing_user_id = ${row.billing_user_id}::uuid
          and rated_at >= now() - interval '30 days'
      `.execute(trx)
      const usageRow = usage30d.rows[0]
      const usageAmount = bigintFromUnknown(usageRow?.amount_xusd) ?? 0n
      const usageCost = bigintFromUnknown(usageRow?.cost_xusd) ?? 0n
      const lastActivity = await sql<{ last_activity_at: Date | null }>`
        select max(activity_at) as last_activity_at
        from (
          select max(occurred_at) as activity_at from billing_events where billing_account_id = ${row.billing_account_id}::uuid and billing_user_id = ${row.billing_user_id}::uuid
          union all
          select max(rated_at) as activity_at from billing_ratings where billing_account_id = ${row.billing_account_id}::uuid and billing_user_id = ${row.billing_user_id}::uuid
          union all
          select max(created_at) as activity_at from billing_rating_allocations where billing_account_id = ${row.billing_account_id}::uuid and billing_user_id = ${row.billing_user_id}::uuid
          union all
          select max(created_at) as activity_at from ledger_entries where billing_account_id = ${row.billing_account_id}::uuid and billing_user_id = ${row.billing_user_id}::uuid
          union all
          select max(created_at) as activity_at from ledger_grants where billing_account_id = ${row.billing_account_id}::uuid and billing_user_id = ${row.billing_user_id}::uuid
          union all
          select max(updated_at) as activity_at from budgets where billing_account_id = ${row.billing_account_id}::uuid and billing_user_id = ${row.billing_user_id}::uuid
        ) activity
      `.execute(trx)

      return {
        user: mapBillingUser(row),
        wallet,
        grants,
        grant_assignments: grantAssignments,
        budgets,
        usage_30d: {
          amount_xusd: usageAmount.toString(),
          cost_xusd: usageCost.toString(),
          margin_xusd: (usageAmount - usageCost).toString(),
          commit_count: Number(usageRow?.commit_count ?? 0),
        },
        last_activity_at: lastActivity.rows[0]?.last_activity_at ? lastActivity.rows[0].last_activity_at.toISOString() : null,
      } satisfies BillingUserSummary
    })
  }

  async getBillingUserWallet(
    req: AppRequest,
    billingUserId: string,
    query: Record<string, unknown>,
  ): Promise<BillingUserWallet> {
    const db = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const refreshGrants = parseBoolean(query?.refresh_grants)

    return runInTransaction(db, async (trx) => {
      const row = await this.loadBillingUserRow(trx, realmId, billingUserId)
      return this.buildWalletSnapshot(trx, row, refreshGrants)
    })
  }

  async listBillingUserActivity(
    req: AppRequest,
    billingUserId: string,
    query: Record<string, unknown>,
  ): Promise<BillingUserActivityList> {
    const db = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursor = toDate(query?.cursor)
    const kinds = normalizeActivityKinds(query?.kind)

    return runInTransaction(db, async (trx) => {
      const row = await this.loadBillingUserRow(trx, realmId, billingUserId)
      await setRlsSession(trx, {
        realmId,
        billingAccountId: row.billing_account_id,
        billingUserId: row.billing_user_id,
        isRealmAdmin: true,
      })

      const items: BillingUserActivityItem[] = []
      if (shouldIncludeActivityKind(kinds, 'event')) {
        items.push(...await fetchEventActivity(trx, row, limit + 1, cursor))
      }
      if (shouldIncludeActivityKind(kinds, 'rating')) {
        items.push(...await fetchRatingActivity(trx, row, limit + 1, cursor))
      }
      if (shouldIncludeActivityKind(kinds, 'allocation')) {
        items.push(...await fetchAllocationActivity(trx, row, limit + 1, cursor))
      }
      if (shouldIncludeActivityKind(kinds, 'grant')) {
        items.push(...await fetchGrantActivity(trx, row, limit + 1, cursor))
      }
      if (shouldIncludeActivityKind(kinds, 'ledger_entry')) {
        items.push(...await fetchLedgerEntryActivity(trx, row, limit + 1, cursor))
      }
      if (shouldIncludeActivityKind(kinds, 'budget')) {
        items.push(...await fetchBudgetActivity(trx, row, limit + 1, cursor))
      }

      items.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.activity_id.localeCompare(a.activity_id))
      const page = items.slice(0, limit)
      const nextCursor = items.length > limit ? page[page.length - 1]?.occurred_at ?? null : null
      return { items: page, next_cursor: nextCursor } satisfies BillingUserActivityList
    })
  }

  async updateBillingAccountBillingDetails(
    req: AppRequest,
    billingAccountId: string,
    body: BillingAccountBillingDetailsUpdateRequest,
  ): Promise<BillingAccountBillingDetailsMasked> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const exists = await trx
      .selectFrom('billing_accounts')
      .select(['billing_account_id'])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .executeTakeFirst()

    if (!exists) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing account not found' }, 404)
    }

    const patch = normalizeBillingDetailsPatch(body)
    if (!patch.hasChanges) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'no billing details updates provided' }, 422)
    }

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const upsertValues = {
      billing_account_id: billingAccountId,
      ...toDbJsonValues(patch.values),
      last_updated_by: 'ops',
      updated_at: sql<Date>`now()`,
    } as const

    await trx
      .insertInto('billing_account_billing_details')
      .values(upsertValues)
      .onConflict((oc) =>
        oc.column('billing_account_id').doUpdateSet({
          ...toDbJsonValues(patch.values),
          last_updated_by: 'ops',
          updated_at: sql<Date>`now()`,
        }),
      )
      .executeTakeFirst()

    const row = await trx
      .selectFrom('billing_account_billing_details')
      .select([
        sql`billing_account_id`.as('billing_details_id'),
        'billing_email',
        'legal_name',
        'entity_type',
        'default_address',
        'tax_ids',
        sql`metadata`.as('billing_details_metadata'),
        'last_updated_by',
        'source_updated_at',
        sql`created_at`.as('billing_details_created_at'),
        sql`updated_at`.as('billing_details_updated_at'),
      ])
      .where('billing_account_id', '=', billingAccountId)
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'billing details unavailable' }, 500)
    }

    const details = mapBillingDetailsMasked(row, billingAccountId)
    if (!details) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'billing details unavailable' }, 500)
    }
    return details
  }

  private ensureDb(req: AppRequest): Kysely<Database> {
    const trx = req?.ctx?.db
    if (!trx) throw new HttpException({ code: 'SERVER.CONFIG', message: 'DB session unavailable' }, 500)
    return trx
  }

  private ensureRealmId(req: AppRequest): string {
    const realmId = req?.ctx?.realmId
    if (!realmId) throw new HttpException({ code: 'AUTH.MISSING_REALM', message: 'realm_id missing' }, 400)
    return realmId
  }

  private async ensureBillingAccountExists(
    trx: Kysely<Database> | Transaction<Database>,
    realmId: string,
    billingAccountId: string,
  ): Promise<{ billing_account_id: string; billing_principal_id: string }> {
    const account = await trx
      .selectFrom('billing_accounts')
      .select(['billing_account_id', 'billing_principal_id'])
      .where('realm_id', '=', realmId)
      .where('billing_account_id', '=', billingAccountId)
      .executeTakeFirst()

    if (!account) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing account not found' }, 404)
    }
    return {
      billing_account_id: String(account.billing_account_id),
      billing_principal_id: String(account.billing_principal_id),
    }
  }

  private async loadBillingUserRow(
    trx: Kysely<Database> | Transaction<Database>,
    realmId: string,
    billingUserId: string,
    lock = false,
  ): Promise<BillingUserRow> {
    let builder = trx
      .selectFrom('billing_users as bu')
      .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'bu.billing_account_id')
      .select([
        'bu.billing_user_id',
        'bu.realm_id',
        'bu.billing_account_id',
        'ba.billing_principal_id',
        'bu.business_user_id',
        'bu.status',
        'bu.metadata',
        'bu.created_at',
        'bu.updated_at',
      ])
      .where('bu.realm_id', '=', realmId)
      .where('bu.billing_user_id', '=', billingUserId)

    if (lock) {
      builder = builder.forUpdate()
    }

    const row = await builder.executeTakeFirst()
    if (!row) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'billing user not found' }, 404)
    }
    return row as BillingUserRow
  }

  private async buildWalletSnapshot(
    trx: Transaction<Database>,
    row: BillingUserRow,
    refreshGrants: boolean,
  ): Promise<BillingUserWallet> {
    await setRlsSession(trx, {
      realmId: row.realm_id,
      billingAccountId: row.billing_account_id,
      billingUserId: row.billing_user_id,
      isRealmAdmin: true,
    })

    if (refreshGrants && row.status === 'active') {
      await ensureBillingPlanGrantsEnrollmentSyncedForUser(trx, row.billing_account_id, row.billing_user_id)
      await issueGrantsForBillingUser(trx, row.billing_account_id, row.billing_user_id)
    }

    const ledger = await trx
      .selectFrom('ledger_entries')
      .select(sql<string>`coalesce(sum((amount_xusd)::numeric), 0)::text`.as('balance_xusd'))
      .where('billing_account_id', '=', row.billing_account_id)
      .where('billing_user_id', '=', row.billing_user_id)
      .executeTakeFirst()
    const ledgerBalance = bigintFromUnknown(ledger?.balance_xusd) ?? 0n
    const grantBalances = await this.grantBalanceService.getAccountGrantBalances(trx, {
      billingAccountId: row.billing_account_id,
      billingUserId: row.billing_user_id,
      includeExpired: false,
      includeSuspended: false,
    })
    const grantIds = grantBalances.grants.map((grant) => grant.grantId)
    const grantRows = grantIds.length > 0
      ? await trx
          .selectFrom('ledger_grants as lg')
          .leftJoin('grant_programs as gp', 'gp.program_id', 'lg.program_id')
          .select(['lg.grant_id', 'lg.issuance_status', 'gp.program_code'])
          .where('lg.grant_id', 'in', grantIds)
          .execute()
      : []
    const grantMeta = new Map(
      grantRows.map((grant) => [
        String(grant.grant_id),
        {
          status: String(grant.issuance_status),
          programCode: typeof grant.program_code === 'string' ? grant.program_code : null,
        },
      ]),
    )

    return {
      billing_user_id: row.billing_user_id,
      billing_account_id: row.billing_account_id,
      as_of: grantBalances.asOf.toISOString(),
      ledger_balance_xusd: ledgerBalance.toString(),
      grant_total_xusd: grantBalances.totals.amountXusd.toString(),
      grant_remaining_xusd: grantBalances.totals.remainingXusd.toString(),
      grant_available_xusd: grantBalances.totals.availableXusd.toString(),
      outstanding_balance_xusd: ledgerBalance < 0n ? (-ledgerBalance).toString() : '0',
      grants: grantBalances.grants.map((grant) => {
        const meta = grantMeta.get(grant.grantId)
        return {
          grant_id: grant.grantId,
          grant_program_code: meta?.programCode ?? null,
          kind: grant.kind,
          status: meta?.status ?? 'active',
          amount_xusd: grant.amountXusd.toString(),
          remaining_xusd: grant.remainingXusd.toString(),
          available_xusd: grant.availableXusd.toString(),
          window_start: grant.windowStart ? grant.windowStart.toISOString() : null,
          window_end: grant.windowEnd ? grant.windowEnd.toISOString() : null,
        }
      }),
    } satisfies BillingUserWallet
  }
}

type BillingUserRow = {
  billing_user_id: string
  realm_id: string
  billing_account_id: string
  billing_principal_id: string
  business_user_id: string
  status: BillingUserStatus
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

type BillingAccountRow = {
  billing_account_id: string
  billing_principal_id: string
  seat_limit: number | string | null
  seat_limit_source: string | null
  seat_limit_updated_at: Date | string | null
  metadata: Record<string, unknown> | null
  created_at: Date | string
}

type CountableUserTable = 'ledger_grants' | 'grant_assignments' | 'budgets'

function mapBillingAccount(row: BillingAccountRow): BillingAccount {
  return {
    billing_account_id: String(row.billing_account_id),
    billing_principal_id: String(row.billing_principal_id),
    seat_limit: normalizeNullableNumber(row.seat_limit),
    seat_limit_source: normalizeOptionalString(row.seat_limit_source),
    seat_limit_updated_at: row.seat_limit_updated_at ? toIsoString(row.seat_limit_updated_at) : null,
    metadata: normalizeMetadataRecord(row.metadata),
    created_at: toIsoString(row.created_at),
  } satisfies BillingAccount
}

function mapSeatSummary(summary: BillingAccountSeatSummaryModel): BillingAccountSeatSummary {
  return {
    billing_account_id: String(summary.billing_account_id),
    seat_limit: summary.seat_limit,
    seat_limit_source: summary.seat_limit_source,
    seat_limit_updated_at: summary.seat_limit_updated_at ? toIsoString(summary.seat_limit_updated_at) : null,
    active_user_count: summary.active_user_count,
    disabled_user_count: summary.disabled_user_count,
    deleted_user_count: summary.deleted_user_count,
    available_seats: summary.available_seats,
    over_limit: summary.over_limit,
  } satisfies BillingAccountSeatSummary
}

function mapBillingUser(row: BillingUserRow): BillingUser {
  const metadata = normalizeMetadataRecord(row.metadata)
  return {
    billing_user_id: String(row.billing_user_id),
    billing_account_id: String(row.billing_account_id),
    billing_principal_id: String(row.billing_principal_id),
    business_user_id: String(row.business_user_id),
    user_id: String(row.business_user_id),
    status: normalizeBillingUserStatus(row.status),
    display_name: normalizeOptionalString(metadata.display_name),
    email: normalizeOptionalString(metadata.email),
    metadata,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  } satisfies BillingUser
}

function normalizeRequiredUserId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${field} must be a string` }, 422)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${field} is required` }, 422)
  }
  if (trimmed.length > 512) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${field} is too long` }, 422)
  }
  return trimmed
}

function normalizeBillingUserStatus(value: unknown): BillingUserStatus {
  if (value === 'active' || value === 'disabled' || value === 'deleted') return value
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'status is invalid' }, 422)
}

function normalizeBillingUserStatuses(value: unknown): BillingUserStatus[] {
  return normalizeArray(value).map(normalizeBillingUserStatus)
}

function normalizeMetadataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function mergeMetadata(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    next[key] = value
  }
  return next
}

function buildBillingUserMetadata(
  existing: Record<string, unknown>,
  patch: Partial<BillingUserCreateRequest & BillingUserUpdateRequest>,
): Record<string, unknown> {
  let next = { ...existing }
  if (Object.prototype.hasOwnProperty.call(patch, 'metadata')) {
    next = mergeMetadata(next, normalizeMetadata(patch.metadata))
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'display_name')) {
    const displayName = normalizeNullableString(patch.display_name)
    if (displayName) next.display_name = displayName
    else delete next.display_name
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'email')) {
    const email = normalizeNullableString(patch.email)
    if (email) next.email = email
    else delete next.email
  }
  return next
}

function shallowEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => left[key] === right[key])
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  return false
}

function normalizeActivityKinds(value: unknown): Set<BillingUserActivityKind> {
  const valid = new Set<BillingUserActivityKind>(['event', 'rating', 'allocation', 'grant', 'ledger_entry', 'budget'])
  const requested = normalizeArray(value)
  const out = new Set<BillingUserActivityKind>()
  for (const item of requested) {
    if (!valid.has(item as BillingUserActivityKind)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'activity kind is invalid' }, 422)
    }
    out.add(item as BillingUserActivityKind)
  }
  return out
}

function shouldIncludeActivityKind(kinds: Set<BillingUserActivityKind>, kind: BillingUserActivityKind): boolean {
  return kinds.size === 0 || kinds.has(kind)
}

async function countUserRows(
  trx: Transaction<Database>,
  table: CountableUserTable,
  billingAccountId: string,
  billingUserId: string,
  activePredicate: string,
): Promise<BillingUserSummaryCounts> {
  const result = await sql<{ total: number | string; active: number | string }>`
    select
      count(*)::int as total,
      count(*) filter (where ${sql.raw(activePredicate)})::int as active
    from ${sql.raw(table)}
    where billing_account_id = ${billingAccountId}::uuid
      and billing_user_id = ${billingUserId}::uuid
  `.execute(trx)
  const row = result.rows[0]
  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
  } satisfies BillingUserSummaryCounts
}

async function fetchEventActivity(
  trx: Transaction<Database>,
  user: BillingUserRow,
  limit: number,
  cursor: Date | null,
): Promise<BillingUserActivityItem[]> {
  const rows = await trx
    .selectFrom('billing_events')
    .select(['event_id', 'occurred_at', 'event_type', 'subject_ref', 'payload'])
    .where('billing_account_id', '=', user.billing_account_id)
    .where('billing_user_id', '=', user.billing_user_id)
    .$if(Boolean(cursor), (qb) => qb.where('occurred_at', '<', cursor as Date))
    .orderBy('occurred_at', 'desc')
    .orderBy('event_id', 'desc')
    .limit(limit)
    .execute()

  return rows.map((row) => ({
    kind: 'event',
    activity_id: `event:${String(row.event_id)}`,
    occurred_at: toIsoString(row.occurred_at),
    title: String(row.event_type || 'Billing event'),
    status: null,
    amount_xusd: null,
    feature_code: null,
    metadata: {
      event_id: String(row.event_id),
      subject_ref: row.subject_ref ?? null,
      payload: normalizeMetadataRecord(row.payload),
    },
  }))
}

async function fetchRatingActivity(
  trx: Transaction<Database>,
  user: BillingUserRow,
  limit: number,
  cursor: Date | null,
): Promise<BillingUserActivityItem[]> {
  const rows = await trx
    .selectFrom('billing_ratings')
    .select(['rating_id', 'rated_at', 'feature_code', 'direction', 'canonical_amount_xusd', 'metadata'])
    .where('billing_account_id', '=', user.billing_account_id)
    .where('billing_user_id', '=', user.billing_user_id)
    .$if(Boolean(cursor), (qb) => qb.where('rated_at', '<', cursor as Date))
    .orderBy('rated_at', 'desc')
    .orderBy('rating_id', 'desc')
    .limit(limit)
    .execute()

  return rows.map((row) => ({
    kind: 'rating',
    activity_id: `rating:${String(row.rating_id)}`,
    occurred_at: toIsoString(row.rated_at),
    title: `Rating ${String(row.feature_code)}`,
    status: String(row.direction),
    amount_xusd: String(row.canonical_amount_xusd ?? '0'),
    feature_code: String(row.feature_code),
    metadata: {
      rating_id: String(row.rating_id),
      ...normalizeMetadataRecord(row.metadata),
    },
  }))
}

async function fetchAllocationActivity(
  trx: Transaction<Database>,
  user: BillingUserRow,
  limit: number,
  cursor: Date | null,
): Promise<BillingUserActivityItem[]> {
  const rows = await trx
    .selectFrom('billing_rating_allocations')
    .select([
      'allocation_id',
      'created_at',
      'rated_at',
      'feature_code',
      'allocated_xusd',
      'settlement_state',
      'application_status',
      'grant_id',
      'metadata',
    ])
    .where('billing_account_id', '=', user.billing_account_id)
    .where('billing_user_id', '=', user.billing_user_id)
    .$if(Boolean(cursor), (qb) => qb.where('created_at', '<', cursor as Date))
    .orderBy('created_at', 'desc')
    .orderBy('allocation_id', 'desc')
    .limit(limit)
    .execute()

  return rows.map((row) => ({
    kind: 'allocation',
    activity_id: `allocation:${String(row.allocation_id)}`,
    occurred_at: toIsoString(row.created_at),
    title: `Allocation ${String(row.feature_code)}`,
    status: `${String(row.settlement_state)}:${String(row.application_status)}`,
    amount_xusd: String(row.allocated_xusd ?? '0'),
    feature_code: String(row.feature_code),
    metadata: {
      allocation_id: String(row.allocation_id),
      rated_at: toIsoString(row.rated_at),
      grant_id: row.grant_id ? String(row.grant_id) : null,
      ...normalizeMetadataRecord(row.metadata),
    },
  }))
}

async function fetchGrantActivity(
  trx: Transaction<Database>,
  user: BillingUserRow,
  limit: number,
  cursor: Date | null,
): Promise<BillingUserActivityItem[]> {
  const rows = await trx
    .selectFrom('ledger_grants as lg')
    .leftJoin('grant_programs as gp', 'gp.program_id', 'lg.program_id')
    .select(['lg.grant_id', 'lg.created_at', 'lg.issuance_status', 'lg.kind', 'lg.amount_xusd', 'lg.metadata', 'gp.program_code'])
    .where('lg.billing_account_id', '=', user.billing_account_id)
    .where('lg.billing_user_id', '=', user.billing_user_id)
    .$if(Boolean(cursor), (qb) => qb.where('lg.created_at', '<', cursor as Date))
    .orderBy('lg.created_at', 'desc')
    .orderBy('lg.grant_id', 'desc')
    .limit(limit)
    .execute()

  return rows.map((row) => ({
    kind: 'grant',
    activity_id: `grant:${String(row.grant_id)}`,
    occurred_at: toIsoString(row.created_at),
    title: row.program_code ? `Grant ${String(row.program_code)}` : `Grant ${String(row.kind)}`,
    status: String(row.issuance_status),
    amount_xusd: String(row.amount_xusd ?? '0'),
    feature_code: null,
    metadata: {
      grant_id: String(row.grant_id),
      program_code: row.program_code ?? null,
      kind: String(row.kind),
      ...normalizeMetadataRecord(row.metadata),
    },
  }))
}

async function fetchLedgerEntryActivity(
  trx: Transaction<Database>,
  user: BillingUserRow,
  limit: number,
  cursor: Date | null,
): Promise<BillingUserActivityItem[]> {
  const rows = await trx
    .selectFrom('ledger_entries')
    .select(['entry_id', 'created_at', 'reason', 'amount_xusd', 'source_ref', 'econ_component_kind', 'econ_component_code'])
    .where('billing_account_id', '=', user.billing_account_id)
    .where('billing_user_id', '=', user.billing_user_id)
    .$if(Boolean(cursor), (qb) => qb.where('created_at', '<', cursor as Date))
    .orderBy('created_at', 'desc')
    .orderBy('entry_id', 'desc')
    .limit(limit)
    .execute()

  return rows.map((row) => ({
    kind: 'ledger_entry',
    activity_id: `ledger_entry:${String(row.entry_id)}`,
    occurred_at: toIsoString(row.created_at),
    title: `Ledger ${String(row.reason)}`,
    status: String(row.reason),
    amount_xusd: String(row.amount_xusd ?? '0'),
    feature_code: null,
    metadata: {
      entry_id: String(row.entry_id),
      source_ref: row.source_ref ?? null,
      econ_component_kind: row.econ_component_kind ?? null,
      econ_component_code: row.econ_component_code ?? null,
    },
  }))
}

async function fetchBudgetActivity(
  trx: Transaction<Database>,
  user: BillingUserRow,
  limit: number,
  cursor: Date | null,
): Promise<BillingUserActivityItem[]> {
  const rows = await trx
    .selectFrom('budgets')
    .select(['budget_id', 'updated_at', 'status', 'name', 'scope_kind', 'scope_ref', 'limit_xusd', 'metadata'])
    .where('billing_account_id', '=', user.billing_account_id)
    .where('billing_user_id', '=', user.billing_user_id)
    .$if(Boolean(cursor), (qb) => qb.where('updated_at', '<', cursor as Date))
    .orderBy('updated_at', 'desc')
    .orderBy('budget_id', 'desc')
    .limit(limit)
    .execute()

  return rows.map((row) => ({
    kind: 'budget',
    activity_id: `budget:${String(row.budget_id)}`,
    occurred_at: toIsoString(row.updated_at),
    title: row.name ? `Budget ${String(row.name)}` : 'Budget',
    status: String(row.status),
    amount_xusd: row.limit_xusd === null || row.limit_xusd === undefined ? null : String(row.limit_xusd),
    feature_code: row.scope_kind === 'feature' && row.scope_ref ? String(row.scope_ref) : null,
    metadata: {
      budget_id: String(row.budget_id),
      scope_kind: row.scope_kind ?? null,
      scope_ref: row.scope_ref ?? null,
      ...normalizeMetadataRecord(row.metadata),
    },
  }))
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const date = new Date(String(value))
  if (!Number.isNaN(date.valueOf())) return date.toISOString()
  return new Date(0).toISOString()
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 50
  return Math.min(200, Math.max(1, Math.floor(value)))
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  return [String(value).trim()].filter(Boolean)
}

function toDate(value: unknown): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.valueOf()) ? null : date
}

type BillingDetailsRow = {
  billing_details_id: string | null
  billing_email: string | null
  legal_name: string | null
  entity_type: string | null
  default_address: BillingAccountBillingDetailsAddress | null
  tax_ids: Record<string, unknown>[] | null
  billing_details_metadata: Record<string, unknown> | null
  last_updated_by: string | null
  source_updated_at: Date | null
  billing_details_created_at: Date | null
  billing_details_updated_at: Date | null
}

type TaxIdInput = {
  type?: unknown
  value?: unknown
  country_code?: unknown
  status?: unknown
}

type BillingDetailsPatch = {
  hasChanges: boolean
  values: {
    billing_email?: string | null
    legal_name?: string | null
    entity_type?: 'individual' | 'company' | 'unknown' | null
    default_address?: BillingAccountBillingDetailsAddress | null
    tax_ids?: Record<string, unknown>[] | null
    metadata?: Record<string, unknown>
  }
}

function toDbJsonValues(values: BillingDetailsPatch['values']): BillingDetailsPatch['values'] {
  const next = { ...values }
  if (Object.prototype.hasOwnProperty.call(values, 'default_address')) {
    next.default_address =
      values.default_address === null
        ? null
        : (sql`${JSON.stringify(values.default_address)}::jsonb` as unknown as BillingDetailsPatch['values']['default_address'])
  }
  if (Object.prototype.hasOwnProperty.call(values, 'tax_ids')) {
    next.tax_ids =
      values.tax_ids === null
        ? null
        : (sql`${JSON.stringify(values.tax_ids)}::jsonb` as unknown as BillingDetailsPatch['values']['tax_ids'])
  }
  return next
}

function mapBillingDetailsMasked(row: unknown, fallbackBillingAccountId: string): BillingAccountBillingDetailsMasked | null {
  const detailsRow = row as BillingDetailsRow
  if (!detailsRow.billing_details_id) return null

  const taxIds = normalizeTaxIds(detailsRow.tax_ids)
  const maskedTaxIds = taxIds
    ? taxIds
        .map((taxId) => {
          const type = normalizeOptionalString(taxId.type)
          const value = normalizeOptionalString(taxId.value)
          if (!type || !value) return null
          return {
            type,
            value_masked: maskSensitive(value),
            country_code: normalizeOptionalString(taxId.country_code),
            status: normalizeOptionalString(taxId.status),
          }
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : null

  return {
    billing_account_id: detailsRow.billing_details_id ?? fallbackBillingAccountId,
    billing_email: normalizeOptionalString(detailsRow.billing_email),
    legal_name: normalizeOptionalString(detailsRow.legal_name),
    entity_type: normalizeEntityTypeFromDb(detailsRow.entity_type),
    default_address: normalizeAddressFromDb(detailsRow.default_address),
    tax_ids: maskedTaxIds,
    metadata: detailsRow.billing_details_metadata ?? {},
    last_updated_by: normalizeLastUpdatedBy(detailsRow.last_updated_by),
    source_updated_at: detailsRow.source_updated_at ? detailsRow.source_updated_at.toISOString() : null,
    created_at: detailsRow.billing_details_created_at
      ? detailsRow.billing_details_created_at.toISOString()
      : new Date(0).toISOString(),
    updated_at: detailsRow.billing_details_updated_at
      ? detailsRow.billing_details_updated_at.toISOString()
      : new Date(0).toISOString(),
  }
}

function normalizeBillingDetailsPatch(body: BillingAccountBillingDetailsUpdateRequest): BillingDetailsPatch {
  const values: BillingDetailsPatch['values'] = {}

  if (Object.prototype.hasOwnProperty.call(body, 'billing_email')) {
    values.billing_email = normalizeNullableString(body.billing_email)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'legal_name')) {
    values.legal_name = normalizeNullableString(body.legal_name)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'entity_type')) {
    values.entity_type = parseEntityType(body.entity_type)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'default_address')) {
    values.default_address = normalizeAddress(body.default_address)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'tax_ids')) {
    values.tax_ids = normalizeTaxIdsPayload(body.tax_ids)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'metadata')) {
    values.metadata = normalizeMetadata(body.metadata)
  }

  return { hasChanges: Object.keys(values).length > 0, values }
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'value must be a string or null' }, 422)
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function parseEntityType(value: unknown): 'individual' | 'company' | 'unknown' | null {
  if (value === null || value === undefined) return null
  if (value === 'individual' || value === 'company' || value === 'unknown') return value
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'entity_type is invalid' }, 422)
}

function normalizeEntityTypeFromDb(value: unknown): 'individual' | 'company' | 'unknown' | null {
  if (value === 'individual' || value === 'company' || value === 'unknown') return value
  return null
}

function normalizeLastUpdatedBy(value: unknown): 'user' | 'provider' | 'ops' | 'system' {
  if (value === 'user' || value === 'provider' || value === 'ops' || value === 'system') return value
  return 'system'
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'metadata must be an object' }, 422)
}

function normalizeAddress(value: unknown): BillingAccountBillingDetailsAddress | null {
  if (value === null) return null
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>
    const line1 = normalizeOptionalString(candidate.line1)
    const city = normalizeOptionalString(candidate.city)
    const countryCode = normalizeOptionalString(candidate.country_code)
    if (!line1 || !city || !countryCode) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'default_address is missing required fields' }, 422)
    }
    const line2 = candidate.line2 === undefined ? undefined : normalizeNullableString(candidate.line2)
    const region = candidate.region === undefined ? undefined : normalizeNullableString(candidate.region)
    const postalCode = candidate.postal_code === undefined ? undefined : normalizeNullableString(candidate.postal_code)
    return {
      line1,
      line2,
      city,
      region,
      postal_code: postalCode,
      country_code: countryCode,
    }
  }
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'default_address must be an object' }, 422)
}

function normalizeAddressFromDb(value: unknown): BillingAccountBillingDetailsAddress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const line1 = normalizeOptionalString(candidate.line1)
  const city = normalizeOptionalString(candidate.city)
  const countryCode = normalizeOptionalString(candidate.country_code)
  if (!line1 || !city || !countryCode) return null
  const line2 = candidate.line2 === undefined ? undefined : normalizeNullableString(candidate.line2)
  const region = candidate.region === undefined ? undefined : normalizeNullableString(candidate.region)
  const postalCode = candidate.postal_code === undefined ? undefined : normalizeNullableString(candidate.postal_code)
  return {
    line1,
    line2,
    city,
    region,
    postal_code: postalCode,
    country_code: countryCode,
  }
}

function normalizeTaxIds(value: unknown): TaxIdInput[] | null {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) return null
  return value
    .map((item) => (item && typeof item === 'object' ? (item as TaxIdInput) : null))
    .filter((item): item is TaxIdInput => Boolean(item))
}

function normalizeTaxIdsPayload(value: unknown): Record<string, unknown>[] | null {
  if (value === null) return null
  if (!Array.isArray(value)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'tax_ids must be an array' }, 422)
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'tax_ids items must be objects' }, 422)
    }
    return item as Record<string, unknown>
  })
}

function maskSensitive(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 4) return '*'.repeat(trimmed.length)
  return `${'*'.repeat(trimmed.length - 4)}${trimmed.slice(-4)}`
}
