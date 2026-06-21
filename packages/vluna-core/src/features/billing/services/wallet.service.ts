import { HttpException, Inject, Injectable } from '@nestjs/common'
import type { Kysely } from 'kysely'

import { okEnvelope, errEnvelope } from '../../../common/envelope.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { Database } from '../../../types/database.js'
import type { operations as BillingOps, components as BillingComponents } from '../../../contracts/billing.js'
import { JsonRequestBody, JsonResponse, QueryParams } from '../../../contracts/openapi-helpers.js'
import { GrantBalanceService, type GrantBalance } from '../../../services/grant-balance.service.js'
import { WALLET_LEDGER_CURRENCY } from '../../../config/currency.js'
import { getOrCreateLedgerAccount } from '../../../services/ledger.js'
import { runInTransaction } from '../../gate/services/gate.utils.js'
import { setRlsSession } from '../../../db/index.js'
import { issueGrantForAssignment, type GrantAssignmentRow, type GrantProgramRow } from '../../../services/grant-issuance.service.js'
import { sql } from 'kysely'
import { allowCrossAccountAccess } from '../../../auth/utils/access.js'
const XUSD_PER_USD = 1_000_000n
const MAX_FRACTION_DIGITS = 12
const USD_PER_XUSD_DECIMAL = '0.000001'

export type GetBalanceQuery = QueryParams<BillingOps, 'getWalletBalance'>
export type GetBalance200 = JsonResponse<BillingOps, 'getWalletBalance', 200>
export type WalletConsumeBody = JsonRequestBody<BillingOps, 'walletConsume'>
export type WalletConsume200 = JsonResponse<BillingOps, 'walletConsume', 200>
export type WalletAdjustmentBody = JsonRequestBody<BillingOps, 'walletAdjustment'>
export type WalletAdjustment200 = JsonResponse<BillingOps, 'walletAdjustment', 200>
type LedgerReason = 'adjustment' | 'purchase' | 'consumption' | 'transfer' | 'refund' | 'reversal'
type SupportedUnit = 'xusd'

@Injectable()
export class WalletService {
  constructor(@Inject(GrantBalanceService) private readonly grantBalanceService: GrantBalanceService) {}

  async consume(req: AppRequest, body: WalletConsumeBody): Promise<WalletConsume200> {
    const billingUserId = this.requireBillingUserId(req)
    const billingAccountId = this.requireBillingAccountId(req)
    const realmId = this.ensureRealm(req)
    const db = this.ensureDb(req)
    const idempotencyKey = this.ensureIdempotencyKey(req)

    const amountRaw = this.parseMinorUnits(body?.amount, 'amount')
    if (amountRaw <= 0n) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'amount must be positive' }, 422)
    }
    const amountXusd = this.toXusd(amountRaw, body?.unit)

    const result = await this.applyLedgerDelta(db, {
      billingUserId,
      billingAccountId,
      realmId,
      deltaXusd: -amountXusd,
      reason: 'consumption',
      idempotencyKey,
      sourceRef: body?.source_ref ?? null,
      enforceNonNegative: true,
    })

    const data: BillingComponents['schemas']['WalletConsumeResponse'] = {
      billing_account_id: billingAccountId,
      billing_user_id: billingUserId,
      unit: 'xusd',
      balance: result.balance.toString(),
      replay: result.replay,
    }

    return okEnvelope(data) as WalletConsume200
  }

  async adjust(req: AppRequest, body: WalletAdjustmentBody): Promise<WalletAdjustment200> {
    const billingUserId = this.requireBillingUserId(req)
    const billingAccountId = this.requireBillingAccountId(req)
    const realmId = this.ensureRealm(req)
    const db = this.ensureDb(req)
    const idempotencyKey = this.ensureIdempotencyKey(req)

    const deltaRaw = this.parseMinorUnits(body?.delta, 'delta')
    if (deltaRaw === 0n) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'delta must be non-zero' }, 422)
    }
    const deltaXusd = this.toXusd(deltaRaw, body?.unit)
    const reason: LedgerReason = body?.kind === 'debit' ? 'consumption' : 'adjustment'
    const labels = this.buildLabels(body)
    const sourceRef = body?.origin?.ref ?? body?.request_id ?? null

    const result = await this.applyLedgerDelta(db, {
      billingUserId,
      billingAccountId,
      realmId,
      deltaXusd,
      reason,
      idempotencyKey,
      sourceRef,
      labels,
      enforceNonNegative: false,
    })

    const data: BillingComponents['schemas']['WalletBalanceResponse'] = {
      billing_account_id: billingAccountId,
      billing_user_id: billingUserId,
      unit: 'xusd',
      balance: result.balance.toString(),
    }

    return okEnvelope(data) as WalletAdjustment200
  }

  async getWalletBalance(req: AppRequest, q: GetBalanceQuery): Promise<GetBalance200> {
    const allowCrossAccount = allowCrossAccountAccess(req?.ctx)
    let ctxBu: string | undefined = req?.ctx?.billingUserId
    let ctxBa: string | undefined = req?.ctx?.billingAccountId
    if (!ctxBa && allowCrossAccount) {
      const headerBa = this.getHeader(req.headers, 'x-billing-account-id')
      if (headerBa) {
        req.ctx = req.ctx || {}
        req.ctx.billingAccountId = headerBa
        ctxBa = headerBa
      }
    }
    if (!ctxBa) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_account_id mismatch' }) as unknown as GetBalance200
    }
    if (!ctxBu) {
      return errEnvelope('AUTH.INSUFFICIENT_SCOPE', { message: 'billing_user_id mismatch' }) as unknown as GetBalance200
    }

    const db = this.ensureDb(req)
    const refreshParam = (q as Record<string, unknown>)?.refresh_grants
    const refreshGrants =
      typeof refreshParam === 'string' ? refreshParam.toLowerCase() === 'true' : Boolean(refreshParam)

    if (refreshGrants) {
      await this.materializeLazyGrants(db, req)
    }

    const now = new Date()

    const ledgerBalanceXusd = await this.loadLedgerBalance(db, ctxBu, ctxBa)

    const grantBalances = await this.grantBalanceService.getAccountGrantBalances(db, {
      billingUserId: ctxBu,
      billingAccountId: ctxBa,
      asOf: now,
      includeExpired: false,
    })

    const grantDetails = await this.loadGrantDetails(db, grantBalances.grants.map((grant) => grant.grantId))

    let totalXusd = ledgerBalanceXusd
    let outstandingTotalXusd = ledgerBalanceXusd

    const grants: BillingComponents['schemas']['LedgerGrantView'][] = grantBalances.grants.map((grant) => {
      const detail = grantDetails.get(grant.grantId)
      const remaining = grant.remainingXusd
      const available = grant.availableXusd
      const onLedger = grant.ledgerId !== null
      if (!onLedger) {
        totalXusd += available
        outstandingTotalXusd += remaining
      }

      const issued = grant.amountXusd > 0n ? grant.amountXusd : 0n
      const status = deriveGrantStatus(grant, detail?.issuanceStatus, detail?.windowEnd ?? grant.windowEnd, now)

      const combinedMetadata = mergeMetadata(
        toRecord(detail?.profileMetadata),
        toRecord(detail?.bindingMetadata),
        toRecord(grant.metadata),
      )

      const { labels: rawLabels, ...metadata } = combinedMetadata
      const labels = extractStringMap(rawLabels)

      const displayHint = typeof metadata.display_hint === 'string' ? String(metadata.display_hint) : undefined
      const origin = deriveGrantOrigin(metadata, grant.kind)

      return {
        grant_id: grant.grantId,
        grant_program_code: detail?.grantProgramCode,
        name: detail?.profileName ?? (detail?.grantProgramCode ?? undefined),
        origin,
        on_ledger: onLedger,
        priority: grant.priority,
        status,
        window_start: toIsoString(detail?.windowStart ?? grant.windowStart) ?? undefined,
        window_end: toIsoString(detail?.windowEnd ?? grant.windowEnd) ?? undefined,
        issued: toCurrencyAmounts(issued),
        remaining: toSignedCurrencyAmounts(remaining),
        consumed_xusd: grant.postedConsumedXusd.toString(),
        labels: Object.keys(labels).length > 0 ? labels : undefined,
        metadata,
        display_hint: displayHint,
      }
    })

    const balances = toCurrencyAmounts(totalXusd)
    const outstandingBalances = toSignedCurrencyAmounts(outstandingTotalXusd)

    const data: BillingComponents['schemas']['WalletBalanceWithBreakdownResponse'] = {
      billing_account_id: ctxBa,
      billing_user_id: ctxBu,
      balances,
      outstanding_balances: outstandingBalances,
      conversion: {
        as_of: now.toISOString(),
        usd_per_xusd: USD_PER_XUSD_DECIMAL,
      },
      grants,
    }

    const envelope = okEnvelope(data) as BillingComponents['schemas']['WalletBalanceWithBreakdownEnvelope']

    return envelope as GetBalance200
  }

  private getHeader(headers: AppRequest['headers'], name: string): string | undefined {
    const raw = headers?.[name.toLowerCase() as keyof AppRequest['headers']] ?? headers?.[name as keyof AppRequest['headers']]
    if (typeof raw === 'string') return raw.trim()
    if (Array.isArray(raw)) return raw.join(',').trim()
    return undefined
  }

  private async materializeLazyGrants(db: Kysely<Database>, req: AppRequest): Promise<void> {
    const realmId = this.ensureRealm(req)
    const billingUserId = this.requireBillingUserId(req)
    const billingAccountId = this.requireBillingAccountId(req)
    const now = new Date()
    await runInTransaction(db, async (trx) => {
      const bindings = await trx
        .selectFrom('grant_assignments as ga')
        .innerJoin('grant_programs as gp', 'gp.program_id', 'ga.program_id')
        .select([
          'ga.assignment_id',
          'ga.program_id',
          'ga.source_kind',
          'ga.source_ref',
          'ga.window_start',
          'ga.window_end',
          'ga.metadata',
        ])
        .where('ga.billing_user_id', '=', billingUserId)
        .where('ga.billing_account_id', '=', billingAccountId)
        .where('ga.status', '=', 'active')
        .where('gp.issuance_mode', '=', 'lazy')
        .execute()

      if (bindings.length === 0) return

      const programIds = Array.from(new Set(bindings.map((b) => String(b.program_id))))
      const programs = await trx
        .selectFrom('grant_programs')
        .selectAll()
        .where('program_id', 'in', programIds)
        .execute()
      const programMap = new Map<string, (typeof programs)[number]>()
      for (const p of programs) {
        programMap.set(String(p.program_id), p)
      }

      await setRlsSession(trx, { realmId, billingAccountId, billingUserId, isRealmAdmin: false })

      for (const binding of bindings) {
        const program = programMap.get(String(binding.program_id))
        if (!program) continue
        await issueGrantForAssignment(trx, {
          realmId,
          billingUserId,
          billingAccountId,
          program: program as GrantProgramRow,
          assignment: {
            assignment_id: String(binding.assignment_id),
            billing_user_id: billingUserId,
            billing_account_id: billingAccountId,
            program_id: String(binding.program_id),
            billing_plan_assignment_id: null,
            campaign_id: null,
            source_kind: binding.source_kind as GrantAssignmentRow['source_kind'],
            source_ref: String(binding.source_ref),
            window_start: binding.window_start as Date,
            window_end: (binding.window_end as Date | null) ?? null,
            valid_range: null,
            status: 'active',
            metadata: (binding.metadata as Record<string, unknown>) ?? {},
            created_at: now,
            updated_at: now,
          },
          sourceKind: String(binding.source_kind),
          sourceRef: String(binding.source_ref),
          quantity: 1,
          now,
          isRealmAdmin: false,
        })
      }
    })
  }

  private ensureDb(req: AppRequest): Kysely<Database> {
    const trx = req.ctx?.db
    if (!trx) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'database context unavailable' }, 500)
    }
    return trx
  }

  private ensureRealm(req: AppRequest): string {
    const realmId = req.ctx?.realmId
    if (!realmId) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'realm_id is required' }, 500)
    }
    return realmId
  }

  private requireBillingAccountId(req: AppRequest): string {
    const billingAccountId = req?.ctx?.billingAccountId
    if (!billingAccountId) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'billing_account_id is required' }, 422)
    }
    return billingAccountId
  }

  private requireBillingUserId(req: AppRequest): string {
    const billingUserId = req?.ctx?.billingUserId
    if (!billingUserId) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'billing_user_id is required' }, 422)
    }
    return billingUserId
  }

  private ensureIdempotencyKey(req: AppRequest): string {
    const idk = req?.ctx?.idempotencyKey
    if (!idk) {
      throw new HttpException({ code: 'VALIDATION.FIELD_REQUIRED', message: 'Idempotency-Key is required' }, 400)
    }
    return idk
  }

  private parseMinorUnits(value: unknown, field: string): bigint {
    if (typeof value === 'bigint') return value
    if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (/^-?\d+$/.test(trimmed)) {
        try {
          return BigInt(trimmed)
        } catch {}
      }
    }
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${field} must be an integer string` }, 422)
  }

  private normalizeUnit(unitRaw: unknown): SupportedUnit {
    const unit = typeof unitRaw === 'string' ? unitRaw.trim().toLowerCase() : ''
    if (unit === 'xusd') return unit
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'unit must be xusd' }, 422)
  }

  private toXusd(amount: bigint, unitRaw: unknown): bigint {
    const unit = this.normalizeUnit(unitRaw)
    if (unit === 'xusd') return amount
    return amount
  }

  private toBigint(value: unknown, fallback = 0n): bigint {
    try {
      return BigInt(value as string)
    } catch {
      return fallback
    }
  }

  private buildLabels(body: WalletAdjustmentBody): Record<string, string> | undefined {
    const labels: Record<string, string> = {}
    if (body?.origin?.kind) labels.origin_kind = String(body.origin.kind)
    if (body?.origin?.labels) {
      for (const [key, value] of Object.entries(body.origin.labels)) {
        if (typeof value === 'string') labels[`origin_${key}`] = value
      }
    }
    if (body?.origin?.ref) labels.origin_ref = String(body.origin.ref)
    if (body?.reason_code) labels.reason_code = String(body.reason_code)
    if (body?.request_id) labels.request_id = String(body.request_id)
    if (body?.note) labels.note = String(body.note)
    return Object.keys(labels).length > 0 ? labels : undefined
  }

  private async applyLedgerDelta(
    db: Kysely<Database>,
    params: {
      billingUserId: string
      billingAccountId: string
      realmId: string
      deltaXusd: bigint
      reason: LedgerReason
      idempotencyKey: string
      sourceRef?: string | null
      labels?: Record<string, string>
      enforceNonNegative?: boolean
    },
  ): Promise<{ balance: bigint; replay: boolean }> {
    return runInTransaction(db, async (trx) => {
      const ledger = await getOrCreateLedgerAccount(trx, params.billingUserId, params.billingAccountId, WALLET_LEDGER_CURRENCY)

      const existing = await trx
        .selectFrom('ledger_entries')
        .select(['entry_id'])
        .where('ledger_id', '=', ledger.ledger_id)
        .where('idempotency_key', '=', params.idempotencyKey)
        .executeTakeFirst()

      const accountRow = await trx
        .selectFrom('ledger_accounts')
        .select(['balance_xusd'])
        .where('ledger_id', '=', ledger.ledger_id)
        .forUpdate()
        .executeTakeFirst()

      const currentBalance = this.toBigint(accountRow?.balance_xusd)

      if (existing) {
        return { balance: currentBalance, replay: true }
      }

      const nextBalance = currentBalance + params.deltaXusd
      if (params.enforceNonNegative && nextBalance < 0n) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'insufficient balance' }, 402)
      }

      const amountText = params.deltaXusd.toString()
      const inserted = await trx
        .insertInto('ledger_entries')
        .values({
          ledger_id: ledger.ledger_id,
          billing_user_id: params.billingUserId,
          billing_account_id: params.billingAccountId,
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

      if (inserted && params.labels && Object.keys(params.labels).length > 0) {
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

      await trx
        .updateTable('ledger_accounts')
        .set({
          balance_xusd: nextBalance.toString(),
          updated_at: new Date(),
        })
        .where('ledger_id', '=', ledger.ledger_id)
        .execute()

      await this.upsertCashGrant(trx, {
        realmId: params.realmId,
        billingUserId: params.billingUserId,
        billingAccountId: params.billingAccountId,
        deltaXusd: params.deltaXusd,
      })

      return { balance: nextBalance, replay: false }
    })
  }

  private async upsertCashGrant(
    trx: Kysely<Database>,
    params: { realmId: string; billingUserId: string; billingAccountId: string; deltaXusd: bigint },
  ): Promise<void> {
    // Wallet Cash Grant (kind='cash', source_kind='wallet.cash')
    // Purpose: a wallet-side "balance anchor" so the grants/balance view can reflect ledger_accounts.balance_xusd.
    // This is NOT the same as Gate's fallback/overage bucket; do not reuse it to represent unpaid overages.
    const grant = await this.ensureWalletCashGrant(trx, params.realmId, params.billingUserId, params.billingAccountId)
    await this.applyGrantDelta(trx, grant, params.deltaXusd)
  }

  private async applyGrantDelta(
    trx: Kysely<Database>,
    grant: { grant_id: unknown; amount_xusd: unknown; posted_consumed_xusd: unknown },
    deltaXusd: bigint,
  ): Promise<void> {
    const grantId = grant.grant_id ? String(grant.grant_id) : null
    if (!grantId) return

    let amount = this.toBigint(grant.amount_xusd)
    let consumed = this.toBigint(grant.posted_consumed_xusd)

    if (deltaXusd > 0n) {
      amount += deltaXusd
    } else if (deltaXusd < 0n) {
      consumed += -deltaXusd
    }

    if (consumed > amount) {
      amount = consumed
    }

    await trx
      .updateTable('ledger_grants')
      .set({
        amount_xusd: amount.toString(),
        posted_consumed_xusd: consumed.toString(),
        updated_at: new Date(),
      })
      .where('grant_id', '=', grantId)
      .execute()
  }

  private async ensureWalletCashGrant(
    trx: Kysely<Database>,
    realmId: string,
    billingUserId: string,
    billingAccountId: string,
  ): Promise<{ grant_id: string; amount_xusd: unknown; posted_consumed_xusd: unknown }> {
    // Ensures the per-account wallet cash grant exists. We keep it "evergreen" (no period_start/period_end)
    // because it's a projection of the current wallet ledger balance, not a billable period bucket.
    const existing = await trx
      .selectFrom('ledger_grants')
      .select(['grant_id', 'amount_xusd', 'posted_consumed_xusd'])
      .where('billing_user_id', '=', billingUserId)
      .where('billing_account_id', '=', billingAccountId)
      .where('kind', '=', 'cash')
      .where('source_kind', '=', 'wallet.cash')
      .forUpdate()
      .executeTakeFirst()

    if (existing) {
      return existing as { grant_id: string; amount_xusd: unknown; posted_consumed_xusd: unknown }
    }

    const program = await trx
      .insertInto('grant_programs')
      .values({
        realm_id: realmId,
        program_code: 'wallet-cash',
        name: 'Wallet Cash',
        active: true,
        cadence: 'once',
        issue_anchor: 'calendar_start',
        amount_xusd: '0',
        window_kind: 'forever',
        window_default_seconds: null,
        priority: 0,
        on_ledger: true,
        issuance_mode: 'eager',
        periodic_accounting: false,
        accrual_mode: null,
        metadata: { system: 'wallet-cash' },
      })
      .onConflict((oc) => oc.columns(['realm_id', 'program_code']).doNothing())
      .returning(['program_id'])
      .executeTakeFirst()

    const programIdRow = program
      ?? (await trx
        .selectFrom('grant_programs')
        .select(['program_id'])
        .where('realm_id', '=', realmId)
        .where('program_code', '=', 'wallet-cash')
        .executeTakeFirst())

    const programId = programIdRow?.program_id ? String(programIdRow.program_id) : null
    if (!programId) throw new Error('wallet cash program unavailable')

    const assignment = await trx
      .insertInto('grant_assignments')
      .values({
        billing_user_id: billingUserId,
        billing_account_id: billingAccountId,
        program_id: programId,
        source_kind: 'wallet.cash',
        source_ref: 'wallet-cash',
        window_start: new Date(0),
        window_end: null,
        status: 'active',
        billing_plan_assignment_id: null,
        campaign_id: null,
        metadata: { system: 'wallet-cash' },
      })
      .onConflict((oc) =>
        oc
          .columns(['billing_user_id', 'source_kind', 'source_ref', 'program_id'])
          .doUpdateSet({
            status: sql`excluded.status`,
            metadata: sql`excluded.metadata`,
            updated_at: sql`now()`,
          }),
      )
      .returning(['assignment_id'])
      .executeTakeFirst()

    const assignmentIdRow = assignment
      ?? (await trx
        .selectFrom('grant_assignments')
        .select(['assignment_id'])
        .where('billing_user_id', '=', billingUserId)
        .where('billing_account_id', '=', billingAccountId)
        .where('program_id', '=', programId)
        .where('source_kind', '=', 'wallet.cash')
        .where('source_ref', '=', 'wallet-cash')
        .executeTakeFirst())

    const assignmentId = assignmentIdRow?.assignment_id ? String(assignmentIdRow.assignment_id) : null
    if (!assignmentId) throw new Error('wallet cash assignment unavailable')

    const grant = await trx
      .insertInto('ledger_grants')
      .values({
        billing_user_id: billingUserId,
        billing_account_id: billingAccountId,
        assignment_id: assignmentId,
        program_id: programId,
        kind: 'cash',
        alloc_seq: 0,
        amount_xusd: '0',
        cost_xusd: '0',
        posted_consumed_xusd: '0',
        pending_reserved_xusd: '0',
        priority: 0,
        issuance_status: 'ready',
        on_ledger: true,
        period_start: null,
        period_end: null,
        window_start: null,
        window_end: null,
        ledger_id: null,
        idempotency_key: null,
        source_kind: 'wallet.cash',
        source_ref: 'wallet-cash',
        source_entry_id: null,
        metadata: { system: 'wallet-cash' },
      })
      .onConflict((oc) => oc.doNothing())
      .returning(['grant_id', 'amount_xusd', 'posted_consumed_xusd'])
      .executeTakeFirst()

    const grantRow =
      grant ??
      (await trx
        .selectFrom('ledger_grants')
        .select(['grant_id', 'amount_xusd', 'posted_consumed_xusd'])
        .where('billing_user_id', '=', billingUserId)
        .where('billing_account_id', '=', billingAccountId)
        .where('assignment_id', '=', assignmentId)
        .where('kind', '=', 'cash')
        .executeTakeFirst())

    if (!grantRow?.grant_id) throw new Error('wallet cash grant unavailable')

    return grantRow as { grant_id: string; amount_xusd: unknown; posted_consumed_xusd: unknown }
  }

  private async loadLedgerBalance(trx: Kysely<Database>, billingUserId: string, billingAccountId: string): Promise<bigint> {
    const row = await trx
      .selectFrom('ledger_accounts')
      .select(['balance_xusd'])
      .where('billing_user_id', '=', billingUserId)
      .where('billing_account_id', '=', billingAccountId)
      .where('currency_code', '=', WALLET_LEDGER_CURRENCY)
      .executeTakeFirst()

    if (!row) return 0n
    try {
      return BigInt(row.balance_xusd)
    } catch {
      return 0n
    }
  }

  private async loadGrantDetails(
    trx: Kysely<Database>,
    grantIds: string[],
  ): Promise<Map<string, {
    grantProgramCode?: string
    profileName?: string | null
    profileMetadata?: Record<string, unknown>
    bindingMetadata?: Record<string, unknown>
    windowStart?: Date | null
    windowEnd?: Date | null
    issuanceStatus?: string
  }>> {
    const map = new Map<string, {
      grantProgramCode?: string
      profileName?: string | null
      profileMetadata?: Record<string, unknown>
      bindingMetadata?: Record<string, unknown>
      windowStart?: Date | null
      windowEnd?: Date | null
      issuanceStatus?: string
    }>()
    if (grantIds.length === 0) return map

    const rows = await trx
      .selectFrom('ledger_grants as g')
      .innerJoin('grant_assignments as b', 'b.assignment_id', 'g.assignment_id')
      .leftJoin('grant_programs as p', 'p.program_id', 'b.program_id')
      .select([
        'g.grant_id as grant_id',
        'g.window_start as window_start',
        'g.window_end as window_end',
        'g.issuance_status as issuance_status',
        'b.metadata as binding_metadata',
        'p.program_code as grant_program_code',
        'p.name as profile_name',
        'p.metadata as profile_metadata',
      ])
      .where('g.grant_id', 'in', grantIds)
      .execute()

    for (const row of rows) {
      map.set(String(row.grant_id), {
        grantProgramCode: row.grant_program_code ? String(row.grant_program_code) : undefined,
        profileName: row.profile_name ? String(row.profile_name) : undefined,
        profileMetadata: toRecord(row.profile_metadata),
        bindingMetadata: toRecord(row.binding_metadata),
        windowStart: row.window_start ?? null,
        windowEnd: row.window_end ?? null,
        issuanceStatus: row.issuance_status ? String(row.issuance_status) : undefined,
      })
    }

    return map
  }
}

function toCurrencyAmounts(xusd: bigint): BillingComponents['schemas']['CurrencyAmounts'] {
  const safe = xusd >= 0n ? xusd : 0n
  return {
    xusd: safe.toString(),
    usd: formatFromRatio(safe, XUSD_PER_USD),
  }
}

function toSignedCurrencyAmounts(xusd: bigint): BillingComponents['schemas']['CurrencyAmounts'] {
  return {
    xusd: xusd.toString(),
    usd: formatFromRatio(xusd, XUSD_PER_USD),
  }
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function extractStringMap(value: unknown): Record<string, string> {
  const record = toRecord(value)
  if (!record) return {}
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'string') {
      out[key] = val
    }
  }
  return out
}

function deriveGrantOrigin(metadata: Record<string, unknown> | undefined, fallbackKind: string): string {
  const origin = metadata?.origin ?? metadata?.source ?? metadata?.issuance_origin
  if (typeof origin === 'string' && origin.trim()) {
    return origin.trim().toLowerCase()
  }
  return fallbackKind ?? 'other'
}

function mergeMetadata(...sources: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const source of sources) {
    if (!source) continue
    for (const [key, value] of Object.entries(source)) {
      merged[key] = value
    }
  }
  return merged
}

function deriveGrantStatus(
  grant: GrantBalance,
  issuanceStatus: string | undefined,
  windowEnd: Date | null | undefined,
  now: Date,
): 'active' | 'expired' | 'pending_close' | 'canceled' {
  const status = issuanceStatus?.toLowerCase()
  if (status === 'pending_close') return 'pending_close'
  if (status === 'canceled') return 'canceled'
  if (status === 'closed') return 'expired'
  if (status === 'suspended') return 'pending_close'
  if (windowEnd && windowEnd.getTime() <= now.getTime()) return 'expired'
  return 'active'
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function formatFromRatio(value: bigint, ratio: bigint): string {
  if (ratio <= 0n) {
    return value.toString()
  }

  const sign = value < 0n ? '-' : ''
  let remainder = value < 0n ? -value : value
  const integerPart = remainder / ratio
  remainder %= ratio

  if (remainder === 0n) {
    return `${sign}${integerPart.toString()}`
  }

  let fraction = ''
  let current = remainder
  let digits = 0
  while (current !== 0n && digits < MAX_FRACTION_DIGITS) {
    current *= 10n
    const digit = current / ratio
    fraction += digit.toString()
    current %= ratio
    digits += 1
  }

  fraction = fraction.replace(/0+$/, '')
  return fraction.length > 0 ? `${sign}${integerPart.toString()}.${fraction}` : `${sign}${integerPart.toString()}`
}
