import { sql, type Insertable, type Kysely, type Selectable, type Transaction } from 'kysely'
import { appendLedgerEntry } from './ledger.js'
import type { Database } from '../types/database.js'
import { bigintFromUnknown, isTransaction } from '../features/gate/services/gate.utils.js'
import { WALLET_LEDGER_CURRENCY } from '../config/currency.js'
import { setRlsSession } from '../db/index.js'
import { BillingPeriodService } from './billing-period.service.js'

export type GrantProgramRow = Selectable<Database['grant_programs']>
export type GrantAssignmentRow = Selectable<Database['grant_assignments']>

export type GrantBindingSourceKind = Database['grant_assignments']['source_kind']
export type GrantBindingStatus = Database['grant_assignments']['status']

export type GrantBindingOverride = {
  programCode: string
  scaleByInvoiceQuantity?: boolean
  amountXusdOverride?: bigint
  onLedgerOverride?: boolean
  windowKindOverride?: 'period' | 'fixed' | 'forever' | 'relative_duration'
  issueAnchorOverride?: 'calendar_start' | 'binding_start' | 'first_use'
  windowRelativeSecondsOverride?: number
  allocSeqOverride?: number
  priorityOverride?: number
  kindOverride?: 'grant' | 'sponsorship' | 'promo' | 'credit' | 'cash' | 'wallet' | 'rollover' | 'nonexpiring' | 'fallback' | 'other'
  metadata?: Record<string, unknown>
}

export type EnsureGrantAssignmentParams = {
  billingUserId: string
  billingAccountId: string
  programId: string
  billingPlanAssignmentId?: string | null
  campaignId?: string | null
  sourceKind: GrantBindingSourceKind
  sourceRef: string
  windowStart: Date
  windowEnd?: Date | null
  status?: GrantBindingStatus
  metadata?: Record<string, unknown>
  decidedAt?: Date
}

export type IssueGrantParams = {
  realmId: string
  billingUserId: string
  billingAccountId: string
  program: GrantProgramRow
  assignment: GrantAssignmentRow
  override?: GrantBindingOverride
  quantity: number
  sourceKind?: string | null
  sourceRef?: string | null
  metadata?: Record<string, unknown>
  idempotencyKey?: string | null
  ledgerIdempotencyKey?: string | null
  now?: Date
  allocSeq?: number
  ledgerLabels?: Record<string, string>
  isRealmAdmin?: boolean
}

export type GrantIssuanceResult = {
  grantId: string
  amountXusd: bigint
  onLedger: boolean
  ledgerId: string | null
  ledgerEntryId: string | null
}

type ExistingGrantRow = {
  grant_id: string
  ledger_id: string | null
  source_entry_id: string | null
  on_ledger: boolean
  amount_xusd: string | number | bigint
}

const FALLBACK_PROGRAM_CODE = 'fallback-cash'
const FALLBACK_PROGRAM_NAME = 'Fallback Cash Anchor'

const billingPeriodService = new BillingPeriodService()

export function normalizeGrantBindingOverride(raw: unknown): GrantBindingOverride | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const programCode = toStringSafe(obj.grant_program_code ?? obj.program_code ?? obj.programCode)
  if (!programCode) return null

  const override: GrantBindingOverride = { programCode }

  if (typeof obj.scale_by_invoice_quantity === 'boolean') {
    override.scaleByInvoiceQuantity = obj.scale_by_invoice_quantity
  } else if (typeof obj.scaleByInvoiceQuantity === 'boolean') {
    override.scaleByInvoiceQuantity = obj.scaleByInvoiceQuantity
  }

  if (typeof obj.on_ledger_override === 'boolean') {
    override.onLedgerOverride = obj.on_ledger_override
  } else if (typeof obj.onLedgerOverride === 'boolean') {
    override.onLedgerOverride = obj.onLedgerOverride
  }
  const amountOverride = parseBigInt(obj.amount_xusd ?? obj.amountXusdOverride)
  if (amountOverride !== null) {
    override.amountXusdOverride = amountOverride
  }
  const issueAnchor = toStringSafe(obj.issue_anchor_override ?? obj.issueAnchorOverride)
  if (issueAnchor && isIssueAnchor(issueAnchor)) {
    override.issueAnchorOverride = issueAnchor
  }
  const windowKind = toStringSafe(obj.window_kind_override ?? obj.windowKindOverride)
  if (windowKind && isWindowKind(windowKind)) {
    override.windowKindOverride = windowKind
  }
  const windowSeconds = toPositiveInteger(obj.window_relative_seconds_override ?? obj.windowRelativeSecondsOverride)
  if (windowSeconds !== null) {
    override.windowRelativeSecondsOverride = windowSeconds
  }
  const allocSeq = toNonNegativeInteger(obj.alloc_seq_override ?? obj.allocSeqOverride)
  if (allocSeq !== null) {
    override.allocSeqOverride = allocSeq
  }
  const priority = toInteger(obj.priority_override ?? obj.priorityOverride)
  if (priority !== null) {
    override.priorityOverride = priority
  }
  const kind = toStringSafe(obj.kind_override ?? obj.kindOverride)
  if (kind && isGrantKind(kind)) {
    override.kindOverride = kind
  }
  if (obj.metadata && typeof obj.metadata === 'object') {
    override.metadata = obj.metadata as Record<string, unknown>
  }

  return override
}

// Replace BigInt with string recursively so JSONB serialization never throws.
function jsonSafe<T>(value: T, ctx?: string): T {
  const seen = new WeakSet()
  const convert = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString()
    if (Array.isArray(v)) return v.map(convert)
    if (v && typeof v === 'object') {
      if (seen.has(v as object)) return null
      seen.add(v as object)
      const out: Record<string, unknown> = {}
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = convert(vv)
      }
      return out
    }
    return v
  }
  try {
    return convert(value) as T
  } catch (err) {
    if (ctx) {
      throw new Error(`jsonSafe failed (${ctx}): ${(err as Error).message}`)
    }
    throw err
  }
}

export async function ensureGrantAssignment(
  dbOrTrx: Kysely<Database> | Transaction<Database>,
  params: EnsureGrantAssignmentParams,
): Promise<GrantAssignmentRow> {
  const metadataSafe = jsonSafe(params.metadata ?? {}, 'grant_assignments.metadata')
  const insert: Insertable<Database['grant_assignments']> = {
    billing_user_id: params.billingUserId,
    billing_account_id: params.billingAccountId,
    program_id: params.programId,
    billing_plan_assignment_id: params.billingPlanAssignmentId ?? null,
    campaign_id: params.campaignId ?? null,
    source_kind: params.sourceKind,
    source_ref: params.sourceRef,
    window_start: params.windowStart,
    window_end: params.windowEnd ?? null,
    status: params.status ?? 'active',
    metadata: metadataSafe,
  }
  const row = await dbOrTrx
    .insertInto('grant_assignments')
    .values(insert)
    .onConflict((oc) =>
      oc
        .columns(['billing_user_id', 'source_kind', 'source_ref', 'program_id'])
        .doUpdateSet({
          window_start: sql`least(grant_assignments.window_start, excluded.window_start)`,
          window_end: sql`case
            when excluded.window_end is null then grant_assignments.window_end
            when grant_assignments.window_end is null then excluded.window_end
            else greatest(grant_assignments.window_end, excluded.window_end)
          end`,
          billing_plan_assignment_id: sql`excluded.billing_plan_assignment_id`,
          campaign_id: sql`excluded.campaign_id`,
          status: sql`excluded.status`,
          metadata: sql`excluded.metadata`,
          updated_at: sql`now()`,
        }),
    )
    .returning([
      'assignment_id',
      'billing_user_id',
      'billing_account_id',
      'program_id',
      'billing_plan_assignment_id',
      'campaign_id',
      'source_kind',
      'source_ref',
      'window_start',
      'window_end',
      'valid_range',
      'status',
      'metadata',
      'created_at',
      'updated_at',
    ])
    .executeTakeFirst()

  if (!row) {
    throw new Error('failed to ensure grant_assignment')
  }

  return row
}

export async function issueGrantForAssignment(
  dbOrTrx: Kysely<Database> | Transaction<Database>,
  params: IssueGrantParams,
): Promise<GrantIssuanceResult | null> {
  if (!isTransaction(dbOrTrx)) {
    return dbOrTrx.transaction().execute((trx) => issueGrantForAssignment(trx, params))
  }
  const trx = dbOrTrx

  await setRlsSession(trx, {
    realmId: params.realmId,
    billingUserId: params.billingUserId,
    billingAccountId: params.billingAccountId,
    isRealmAdmin: params.isRealmAdmin ?? false,
  })

  const program = params.program
  const assignment = params.assignment
  const override = params.override ?? undefined
  const now = params.now ?? new Date()
  const issuanceMode = program.issuance_mode

  const baseAmount = override?.amountXusdOverride ?? (parseBigInt(program.amount_xusd) ?? 0n)
  const quantity = params.quantity > 0 ? params.quantity : 1
  let amount = baseAmount

  if (override?.scaleByInvoiceQuantity ?? true) {
    amount *= BigInt(quantity)
  }

  if (amount <= 0n) {
    return null
  }

  const allocSeq = typeof params.allocSeq === 'number'
    ? params.allocSeq
    : override?.allocSeqOverride ?? 0

  const priority = override?.priorityOverride ?? (typeof program.priority === 'number' ? program.priority : 0)
  const grantKind = override?.kindOverride ?? 'grant'
  const onLedger = typeof override?.onLedgerOverride === 'boolean'
    ? override.onLedgerOverride
    : (program.on_ledger ?? false)

  const period = await deriveIssuancePeriod(trx, {
    realmId: params.realmId,
    billingAccountId: params.billingAccountId,
    program,
    assignment,
    override,
    reference: now,
  })
  const window = deriveGrantWindow(program, assignment, override, period, now)

  const metadata: Record<string, unknown> = {
    program_id: program.program_id,
    program_code: program.program_code,
    assignment_id: assignment.assignment_id,
    issuance_mode: issuanceMode,
    quantity,
    ...(override?.metadata ?? {}),
    ...(params.metadata ?? {}),
  }
  const metadataSafe = jsonSafe(metadata, 'ledger_grants.metadata')

  const idempotencyKey = params.idempotencyKey ?? buildGrantIdempotencyKey(String(assignment.assignment_id), allocSeq, period)
  const existingGrant = idempotencyKey
    ? await loadGrantByIdempotencyKey(trx, params.billingUserId, idempotencyKey)
    : await loadGrantByAssignmentPeriod(trx, String(assignment.assignment_id), allocSeq, period)

  const insert: Insertable<Database['ledger_grants']> = {
    billing_user_id: params.billingUserId,
    billing_account_id: params.billingAccountId,
    ledger_id: null,
    assignment_id: String(assignment.assignment_id),
    program_id: String(program.program_id),
    period_start: period.start,
    period_end: period.end,
    alloc_seq: allocSeq,
    idempotency_key: idempotencyKey ?? null,
    source_kind: params.sourceKind ?? null,
    source_ref: params.sourceRef ?? null,
    on_ledger: onLedger,
    issuance_status: 'ready',
    kind: grantKind,
    window_start: window.start,
    window_end: window.end,
    priority,
    amount_xusd: amount.toString(),
    cost_xusd: '0',
    posted_consumed_xusd: '0',
    pending_reserved_xusd: '0',
    metadata: metadataSafe,
  }

  const grantRow = existingGrant
    ?? await trx
      .insertInto('ledger_grants')
      .values(insert)
      .onConflict((oc) =>
        oc
          .columns(['assignment_id', 'period_start', 'period_end', 'alloc_seq'])
          .doUpdateSet({
            amount_xusd: sql`excluded.amount_xusd`,
            window_start: sql`excluded.window_start`,
            window_end: sql`excluded.window_end`,
            priority: sql`excluded.priority`,
            on_ledger: sql`excluded.on_ledger`,
            source_kind: sql`excluded.source_kind`,
            source_ref: sql`excluded.source_ref`,
            idempotency_key: sql`excluded.idempotency_key`,
            kind: sql`excluded.kind`,
            metadata: sql`excluded.metadata`,
            program_id: sql`excluded.program_id`,
            updated_at: sql`now()`,
          }),
      )
      .returning(['grant_id', 'ledger_id', 'source_entry_id', 'on_ledger', 'amount_xusd'])
      .executeTakeFirst()

  if (!grantRow) {
    throw new Error('failed to upsert ledger_grant')
  }

  let ledgerId: string | null = grantRow.ledger_id ?? null
  let ledgerEntryId: string | null = grantRow.source_entry_id ?? null
  const amountIssued = parseBigInt(grantRow.amount_xusd) ?? amount

  if (onLedger && amountIssued > 0n) {
    const ledgerKey = params.ledgerIdempotencyKey
      ?? buildLedgerEntryKey(String(assignment.assignment_id), period, params.sourceRef)
    const ledgerResult = await appendLedgerEntry(trx, {
      billingUserId: params.billingUserId,
      billingAccountId: params.billingAccountId,
      currencyCode: WALLET_LEDGER_CURRENCY,
      amountXusd: amountIssued,
      reason: 'purchase',
      idempotencyKey: ledgerKey,
      sourceRef: params.sourceRef ?? idempotencyKey ?? ledgerKey,
      labels: params.ledgerLabels,
    })
    ledgerId = ledgerResult.ledgerId ?? ledgerId
    ledgerEntryId = ledgerResult.entryId ?? ledgerEntryId

    await trx
      .updateTable('ledger_grants')
      .set({
        ledger_id: ledgerId,
        source_entry_id: ledgerEntryId ?? sql`ledger_grants.source_entry_id`,
        on_ledger: true,
        updated_at: sql`now()`,
      })
      .where('grant_id', '=', grantRow.grant_id)
      .execute()
  }

  return {
    grantId: String(grantRow.grant_id),
    amountXusd: amountIssued,
    onLedger,
    ledgerId,
    ledgerEntryId,
  }
}

async function deriveIssuancePeriod(
  trx: Kysely<Database> | Transaction<Database>,
  params: {
    realmId: string
    billingAccountId: string
    program: GrantProgramRow
    assignment: GrantAssignmentRow
    override: GrantBindingOverride | undefined
    reference: Date
  },
): Promise<{ start: Date | null; end: Date | null }> {
  const cadence = params.program.cadence
  const reference = params.reference

  if (cadence === 'billing_period') {
    const resolved = await billingPeriodService.ensureBillingPeriodInstance(trx, {
      realmId: params.realmId,
      billingAccountId: params.billingAccountId,
      at: reference,
    })
    return { start: resolved.periodStart, end: resolved.periodEnd }
  }

  const issueAnchor = params.override?.issueAnchorOverride ?? params.program.issue_anchor
  const bindingStart = toDate(params.assignment.window_start)

  if (cadence === 'once') {
    return {
      start: bindingStart ?? reference,
      end: toDate(params.assignment.window_end),
    }
  }

  if (cadence === 'daily') {
    const anchor = issueAnchor === 'binding_start' && bindingStart ? bindingStart : reference
    const startAnchor = anchor <= reference ? reference : anchor
    const start = startOfUtcDay(startAnchor)
    const end = addDays(start, 1)
    return { start, end }
  }

  if (cadence === 'weekly') {
    const anchor = issueAnchor === 'binding_start' && bindingStart ? bindingStart : reference
    const startAnchor = anchor <= reference ? reference : anchor
    const start = startOfUtcWeek(startAnchor)
    const end = addWeeks(start, 1)
    return { start, end }
  }

  if (cadence === 'quarterly') {
    if (issueAnchor === 'binding_start' && bindingStart) {
      const start = computeMonthStepFromAnchor(bindingStart, reference, 3)
      const end = addUtcMonthsClamped(bindingStart, monthsBetween(bindingStart, start) + 3)
      return { start, end }
    }

    const startAnchor = reference
    const month = startAnchor.getUTCMonth()
    const quarterStartMonth = Math.floor(month / 3) * 3
    const start = new Date(Date.UTC(startAnchor.getUTCFullYear(), quarterStartMonth, 1, 0, 0, 0, 0))
    const end = addUtcMonthsClamped(start, 3)
    return { start, end }
  }

  if (cadence === 'yearly') {
    if (issueAnchor === 'binding_start' && bindingStart) {
      const start = computeMonthStepFromAnchor(bindingStart, reference, 12)
      const end = addUtcMonthsClamped(bindingStart, monthsBetween(bindingStart, start) + 12)
      return { start, end }
    }

    const start = startOfUtcYear(reference)
    const end = addYears(start, 1)
    return { start, end }
  }

  // default monthly cadence
  if (issueAnchor === 'calendar_start') {
    const start = startOfUtcMonth(reference)
    const end = addUtcMonthsClamped(start, 1)
    return { start, end }
  }

  if (issueAnchor === 'binding_start' && bindingStart) {
    if (bindingStart >= reference) {
      const start = bindingStart
      const end = addUtcMonthsClamped(bindingStart, 1)
      return { start, end }
    }
    const start = computeMonthStepFromAnchor(bindingStart, reference, 1)
    const end = addUtcMonthsClamped(bindingStart, monthsBetween(bindingStart, start) + 1)
    return { start, end }
  }

  const anchor = bindingStart ?? reference
  const monthDelta = monthsBetween(anchor, reference)
  const candidateStart = monthDelta > 0 ? addUtcMonthsClamped(anchor, monthDelta) : anchor
  const start = candidateStart <= reference ? candidateStart : addUtcMonthsClamped(anchor, monthDelta - 1)
  const end = addUtcMonthsClamped(anchor, monthsBetween(anchor, start) + 1)
  return { start, end }
}

function deriveGrantWindow(
  program: GrantProgramRow,
  assignment: GrantAssignmentRow,
  override: GrantBindingOverride | undefined,
  period: { start: Date | null; end: Date | null },
  reference: Date,
): { start: Date | null; end: Date | null } {
  const windowKind = override?.windowKindOverride ?? program.window_kind
  if (program.cadence === 'billing_period' && windowKind !== 'period') {
    throw new Error('grant program cadence=billing_period requires window_kind=period')
  }
  const bindingStart = toDate(assignment.window_start)
  const bindingEnd = toDate(assignment.window_end)

  let start = period.start ?? bindingStart ?? reference
  let end: Date | null = period.end ?? bindingEnd ?? null

  if (windowKind === 'fixed') {
    start = bindingStart ?? start
    end = bindingEnd ?? end
  } else if (windowKind === 'forever') {
    start = period.start ?? bindingStart ?? reference
    end = null
  } else if (windowKind === 'relative_duration') {
    start = period.start ?? bindingStart ?? reference
    const seconds = override?.windowRelativeSecondsOverride ?? program.window_default_seconds ?? null
    if (seconds && seconds > 0) {
      end = new Date(start.getTime() + seconds * 1000)
    } else if (bindingEnd) {
      end = bindingEnd
    } else {
      end = null
    }
  } else {
    // windowKind === 'period' or fallback
    start = period.start ?? bindingStart ?? reference
    end = period.end ?? bindingEnd ?? end
  }

  if (bindingStart && start < bindingStart) {
    start = bindingStart
  }
  if (bindingEnd && end && end > bindingEnd) {
    end = bindingEnd
  }
  if (end && start && end <= start) {
    end = new Date(start.getTime() + 1000)
  }

  return { start, end }
}

function toStringSafe(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  return null
}

function parseBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    return BigInt(trimmed)
  }
  return null
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value > 0) return Math.floor(value)
    return null
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

function toNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0) return Math.floor(value)
    return null
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return null
}

function toInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return Math.trunc(value)
    return null
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function isIssueAnchor(anchor: string | undefined): anchor is GrantBindingOverride['issueAnchorOverride'] {
  return anchor === 'calendar_start' || anchor === 'binding_start' || anchor === 'first_use'
}

function isWindowKind(kind: string | undefined): kind is GrantBindingOverride['windowKindOverride'] {
  return kind === 'period' || kind === 'fixed' || kind === 'forever' || kind === 'relative_duration'
}

function isGrantKind(kind: string): kind is NonNullable<GrantBindingOverride['kindOverride']> {
  return kind === 'grant'
    || kind === 'sponsorship'
    || kind === 'promo'
    || kind === 'credit'
    || kind === 'cash'
    || kind === 'wallet'
    || kind === 'other'
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0))
}

function daysInUtcMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
}

function addUtcMonthsClamped(date: Date, months: number): Date {
  const year = date.getUTCFullYear()
  const month0 = date.getUTCMonth()
  const day = date.getUTCDate()
  const hours = date.getUTCHours()
  const minutes = date.getUTCMinutes()
  const seconds = date.getUTCSeconds()
  const ms = date.getUTCMilliseconds()

  const targetMonth0 = month0 + months
  const targetYear = year + Math.floor(targetMonth0 / 12)
  const normalizedMonth0 = ((targetMonth0 % 12) + 12) % 12
  const maxDay = daysInUtcMonth(targetYear, normalizedMonth0)
  const clampedDay = Math.min(day, maxDay)

  return new Date(Date.UTC(targetYear, normalizedMonth0, clampedDay, hours, minutes, seconds, ms))
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
}

function computeMonthStepFromAnchor(anchor: Date, at: Date, stepMonths: number): Date {
  const step = Math.max(1, Math.floor(stepMonths))
  const monthDelta = monthsBetween(anchor, at)
  const steps = Math.floor(monthDelta / step)
  let start = addUtcMonthsClamped(anchor, steps * step)
  if (start.getTime() > at.getTime() && steps > 0) {
    start = addUtcMonthsClamped(anchor, (steps - 1) * step)
  }
  return start
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0))
}

function addDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()))
}

function startOfUtcWeek(date: Date): Date {
  const day = date.getUTCDay() || 7 // Monday start; JS Sunday=0
  const diff = day - 1
  const startDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0))
  startDate.setUTCDate(startDate.getUTCDate() - diff)
  return startDate
}

function addWeeks(date: Date, weeks: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + weeks * 7, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()))
}

function startOfUtcYear(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0))
}

function addYears(date: Date, years: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()))
}

async function loadGrantByIdempotencyKey(
  trx: Transaction<Database>,
  billingUserId: string,
  idempotencyKey: string,
): Promise<ExistingGrantRow | null> {
  const row = await trx
    .selectFrom('ledger_grants')
    .select(['grant_id', 'ledger_id', 'source_entry_id', 'on_ledger', 'amount_xusd'])
    .where('billing_user_id', '=', billingUserId)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst()

  return row ? {
    grant_id: String(row.grant_id),
    ledger_id: row.ledger_id ?? null,
    source_entry_id: row.source_entry_id ?? null,
    on_ledger: Boolean(row.on_ledger),
    amount_xusd: row.amount_xusd,
  } : null
}

async function loadGrantByAssignmentPeriod(
  trx: Transaction<Database>,
  assignmentId: string,
  allocSeq: number,
  period: { start: Date | null; end: Date | null },
): Promise<ExistingGrantRow | null> {
  let query = trx
    .selectFrom('ledger_grants')
    .select(['grant_id', 'ledger_id', 'source_entry_id', 'on_ledger', 'amount_xusd'])
    .where('assignment_id', '=', assignmentId)
    .where('alloc_seq', '=', allocSeq)

  query = period.start
    ? query.where('period_start', '=', period.start)
    : query.where('period_start', 'is', null)

  query = period.end
    ? query.where('period_end', '=', period.end)
    : query.where('period_end', 'is', null)

  const row = await query.executeTakeFirst()

  return row ? {
    grant_id: String(row.grant_id),
    ledger_id: row.ledger_id ?? null,
    source_entry_id: row.source_entry_id ?? null,
    on_ledger: Boolean(row.on_ledger),
    amount_xusd: row.amount_xusd,
  } : null
}

function buildGrantIdempotencyKey(
  assignmentId: string,
  allocSeq: number,
  period: { start: Date | null; end: Date | null },
): string {
  const startPart = period.start ? period.start.toISOString() : 'null'
  const endPart = period.end ? period.end.toISOString() : 'null'
  return `grant:${assignmentId}:${allocSeq}:${startPart}:${endPart}`
}

function buildLedgerEntryKey(
  assignmentId: string,
  period: { start: Date | null; end: Date | null },
  sourceRef?: string | null,
): string {
  const startPart = period.start ? period.start.toISOString() : 'null'
  const endPart = period.end ? period.end.toISOString() : 'null'
  const ref = sourceRef ? sourceRef : 'unspecified'
  return `grant-ledger:${assignmentId}:${startPart}:${endPart}:${ref}`
}

export async function ensureFallbackGrantForPeriod(
  trx: Kysely<Database> | Transaction<Database>,
  params: { realmId: string; billingUserId: string; billingAccountId: string; periodStart: Date; periodEnd: Date },
): Promise<string> {
  // Gate Fallback Grant (kind='fallback')
  // Purpose: a gating/settlement "overage bucket" used when spendable grants are exhausted, so we can still
  // produce authoritative priced facts (allocations/ratings). This is intentionally separate from the
  // wallet cash grant (kind='cash', source_kind='wallet.cash'), which mirrors wallet ledger balance.
  // In postpaid mode this should evolve into a period-scoped overage bucket with explicit close-out modes
  // (e.g., waive vs invoice), rather than being treated as a permanent wallet balance.
  const existing = await trx
    .selectFrom('ledger_grants')
    .select('grant_id')
    .where('billing_user_id', '=', params.billingUserId)
    .where('billing_account_id', '=', params.billingAccountId)
    .where('kind', '=', 'fallback')
    .where('period_start', '=', params.periodStart)
    .where('period_end', '=', params.periodEnd)
    .executeTakeFirst()

  if (existing) {
    return String(existing.grant_id)
  }

  const programId = await ensureFallbackProgram(trx, params.realmId)
  const assignmentId = await ensureFallbackAssignment(trx, params.billingUserId, params.billingAccountId, programId)

  const insertValues: Insertable<Database['ledger_grants']> = {
    billing_user_id: params.billingUserId,
    billing_account_id: params.billingAccountId,
    assignment_id: assignmentId,
    program_id: programId,
    kind: 'fallback',
    alloc_seq: 0,
    amount_xusd: '0',
    cost_xusd: '0',
    posted_consumed_xusd: '0',
    pending_reserved_xusd: '0',
    priority: -100000,
    issuance_status: 'ready',
    on_ledger: false,
    period_start: params.periodStart,
    period_end: params.periodEnd,
    window_start: params.periodStart,
    window_end: params.periodEnd,
    ledger_id: null,
    idempotency_key: null,
    source_kind: null,
    source_ref: null,
    source_entry_id: null,
    metadata: {
      system: 'fallback',
      period_start: params.periodStart.toISOString(),
      period_end: params.periodEnd.toISOString(),
    },
  }

  const upserted = await trx
    .insertInto('ledger_grants')
    .values(insertValues)
    .onConflict((oc) =>
      oc
        .columns(['billing_user_id', 'kind', 'period_start', 'period_end'])
        .where('kind', '=', 'fallback')
        // Keep this predicate aligned with the partial unique index
        // `ux_grants_fallback_one_per_user_period`, otherwise Postgres
        // cannot infer the conflict target and will error at runtime.
        .where('period_start', 'is not', null)
        .where('period_end', 'is not', null)
        .doUpdateSet({
          assignment_id: sql`excluded.assignment_id`,
          program_id: sql`excluded.program_id`,
          window_start: sql`excluded.window_start`,
          window_end: sql`excluded.window_end`,
          updated_at: sql`now()`,
        }),
    )
    .returning('grant_id')
    .executeTakeFirst()

  if (upserted?.grant_id) {
    return String(upserted.grant_id)
  }

  const fallback = await trx
    .selectFrom('ledger_grants')
    .select('grant_id')
    .where('billing_user_id', '=', params.billingUserId)
    .where('billing_account_id', '=', params.billingAccountId)
    .where('kind', '=', 'fallback')
    .where('period_start', '=', params.periodStart)
    .where('period_end', '=', params.periodEnd)
    .executeTakeFirst()

  if (!fallback) {
    throw new Error('failed to ensure fallback grant')
  }

  return String(fallback.grant_id)
}

async function ensureFallbackProgram(
  trx: Kysely<Database> | Transaction<Database>,
  realmId: string,
): Promise<string> {
  const existing = await trx
    .selectFrom('grant_programs')
    .select('program_id')
    .where('realm_id', '=', realmId)
    .where('program_code', '=', FALLBACK_PROGRAM_CODE)
    .executeTakeFirst()

  if (existing) {
    return String(existing.program_id)
  }

  const insertValues: Insertable<Database['grant_programs']> = {
    realm_id: realmId,
    program_code: FALLBACK_PROGRAM_CODE,
    name: FALLBACK_PROGRAM_NAME,
    active: true,
    cadence: 'once',
    issue_anchor: 'calendar_start',
    amount_xusd: '0',
    window_kind: 'forever',
    window_default_seconds: null,
    priority: -100000,
    on_ledger: false,
    issuance_mode: 'eager',
    periodic_accounting: false,
    accrual_mode: null,
    metadata: { system: 'fallback' },
  }

  const inserted = await trx
    .insertInto('grant_programs')
    .values(insertValues)
    .onConflict((oc) => oc.columns(['realm_id', 'program_code']).doNothing())
    .returning('program_id')
    .executeTakeFirst()

  if (inserted?.program_id) {
    return String(inserted.program_id)
  }

  const fallback = await trx
    .selectFrom('grant_programs')
    .select('program_id')
    .where('realm_id', '=', realmId)
    .where('program_code', '=', FALLBACK_PROGRAM_CODE)
    .executeTakeFirst()

  if (!fallback) {
    throw new Error('failed to ensure fallback program')
  }

  return String(fallback.program_id)
}

async function ensureFallbackAssignment(
  trx: Kysely<Database> | Transaction<Database>,
  billingUserId: string,
  billingAccountId: string,
  programId: string,
): Promise<string> {
  const sourceRef = `fallback:${billingUserId}`

  const existing = await trx
    .selectFrom('grant_assignments')
    .select('assignment_id')
    .where('billing_user_id', '=', billingUserId)
    .where('billing_account_id', '=', billingAccountId)
    .where('program_id', '=', programId)
    .where('source_kind', '=', 'internal.catalog')
    .where('source_ref', '=', sourceRef)
    .executeTakeFirst()

  if (existing) {
    return String(existing.assignment_id)
  }

  const insertValues: Insertable<Database['grant_assignments']> = {
    billing_user_id: billingUserId,
    billing_account_id: billingAccountId,
    program_id: programId,
    source_kind: 'internal.catalog',
    source_ref: sourceRef,
    window_start: new Date(0),
    window_end: null,
    status: 'active',
    billing_plan_assignment_id: null,
    campaign_id: null,
    metadata: { system: 'fallback' },
  }

  const inserted = await trx
    .insertInto('grant_assignments')
    .values(insertValues)
    .onConflict((oc) =>
      oc
        .columns(['billing_user_id', 'source_kind', 'source_ref', 'program_id'])
        .doNothing(),
    )
    .returning('assignment_id')
    .executeTakeFirst()

  if (inserted?.assignment_id) {
    return String(inserted.assignment_id)
  }

  const fallback = await trx
    .selectFrom('grant_assignments')
    .select('assignment_id')
    .where('billing_user_id', '=', billingUserId)
    .where('billing_account_id', '=', billingAccountId)
    .where('program_id', '=', programId)
    .where('source_kind', '=', 'internal.catalog')
    .where('source_ref', '=', sourceRef)
    .executeTakeFirst()

  if (!fallback) {
    throw new Error('failed to ensure fallback assignment')
  }

  return String(fallback.assignment_id)
}

type ExpiredGrantRow = {
  grant_id: string
  realm_id: string
  billing_user_id: string
  billing_account_id: string
  ledger_id: string | null
  currency_code: string | null
  on_ledger: boolean
  amount_xusd: unknown
  pending_reserved_xusd: unknown
  posted_consumed_xusd: unknown
  metadata: Record<string, unknown> | null
  assignment_metadata: Record<string, unknown> | null
}

export async function markExpiredGrantsPendingClose(
  trx: Kysely<Database> | Transaction<Database>,
  params: { now: Date; limit?: number; realmId: string },
): Promise<number> {
  const limit = params.limit ?? 100
  const candidates = await trx
    .selectFrom('ledger_grants as g')
    .innerJoin('grant_assignments as a', 'a.assignment_id', 'g.assignment_id')
    .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'g.billing_account_id')
    .select([
      'g.grant_id as grant_id',
    ])
    .where('ba.realm_id', '=', params.realmId)
    .where('g.window_end', 'is not', null)
    .where('g.window_end', '<=', params.now)
    .where('g.closure_kind', 'is', null)
    .where('g.issuance_status', 'in', ['ready', 'active', 'suspended'] as const)
    .orderBy('g.window_end', 'asc')
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute()

  if (candidates.length === 0) {
    return 0
  }

  const grantIds = candidates.map((row) => row.grant_id)

  await trx
    .updateTable('ledger_grants')
    .set({
      issuance_status: 'pending_close',
      updated_at: params.now,
    })
    .where('grant_id', 'in', grantIds)
    .execute()

  return grantIds.length
}

export async function closeGrants(
  trx: Kysely<Database> | Transaction<Database>,
  params: { now: Date; limit?: number; realmId: string },
): Promise<number> {
  const limit = params.limit ?? 100
  const rows = (await trx
    .selectFrom('ledger_grants as g')
    .innerJoin('grant_assignments as a', 'a.assignment_id', 'g.assignment_id')
    .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'g.billing_account_id')
    .select([
      sql`g.grant_id`.as('grant_id'),
      sql`ba.realm_id`.as('realm_id'),
      sql`g.billing_user_id`.as('billing_user_id'),
      sql`ba.billing_account_id`.as('billing_account_id'),
      sql`g.ledger_id`.as('ledger_id'),
      sql`g.on_ledger`.as('on_ledger'),
      sql`g.amount_xusd`.as('amount_xusd'),
      sql`g.pending_reserved_xusd`.as('pending_reserved_xusd'),
      sql`g.posted_consumed_xusd`.as('posted_consumed_xusd'),
      sql`g.metadata`.as('metadata'),
      sql`a.metadata`.as('assignment_metadata'),
    ])
    .where('ba.realm_id', '=', params.realmId)
    .where('g.issuance_status', '=', 'pending_close')
    .where('g.closure_kind', 'is', null)
    .orderBy('g.updated_at', 'asc')
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute()) as unknown as ExpiredGrantRow[]

  const ledgerIds = rows
    .filter((row) => row.ledger_id !== null)
    .map((row) => String(row.ledger_id))

  const ledgerCurrency = new Map<string, string>()
  if (ledgerIds.length > 0) {
    const ledgerRows = await trx
      .selectFrom('ledger_accounts')
      .select(['ledger_id', 'currency_code'])
      .where('ledger_id', 'in', ledgerIds)
      .execute()

    for (const row of ledgerRows) {
      ledgerCurrency.set(String(row.ledger_id), String(row.currency_code))
    }
  }

  let processed = 0
  for (const row of rows) {
    const policy = parseExpiryPolicy(row.assignment_metadata)
    if (policy === 'forfeit') {
      const currencyCode = row.ledger_id ? ledgerCurrency.get(row.ledger_id) ?? null : null
      await forfeitGrant(trx, { ...row, currency_code: currencyCode }, params.now)
      processed += 1
    }
    // Other policies ('refund', 'carryover', 'none') currently no-op.
  }

  return processed
}

function parseExpiryPolicy(metadata: Record<string, unknown> | null | undefined): 'forfeit' | 'refund' | 'carryover' | 'none' {
  if (!metadata || typeof metadata !== 'object') return 'forfeit'
  const raw = metadata.expiry_policy
  if (typeof raw !== 'string') return 'forfeit'
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'refund' || normalized === 'carryover' || normalized === 'none' || normalized === 'forfeit') {
    return normalized as 'forfeit' | 'refund' | 'carryover' | 'none'
  }
  return 'forfeit'
}

async function forfeitGrant(
  trx: Kysely<Database> | Transaction<Database>,
  row: ExpiredGrantRow,
  now: Date,
): Promise<void> {
  const amount = bigintFromUnknown(row.amount_xusd) ?? 0n
  const pending = bigintFromUnknown(row.pending_reserved_xusd) ?? 0n
  const posted = bigintFromUnknown(row.posted_consumed_xusd) ?? 0n
  let remaining = amount - posted - pending
  if (remaining < 0n) remaining = 0n

  let closureEntryId: string | null = null

  if (remaining > 0n) {
    if (row.on_ledger && row.ledger_id && row.currency_code) {
      await setRlsSession(trx, {
        realmId: row.realm_id,
        billingUserId: row.billing_user_id,
        billingAccountId: row.billing_account_id,
        isRealmAdmin: true,
      })
      const result = await appendLedgerEntry(trx, {
        billingUserId: row.billing_user_id,
        billingAccountId: row.billing_account_id,
        currencyCode: row.currency_code,
        amountXusd: -remaining,
        reason: 'adjustment',
        idempotencyKey: `grant-forfeit:${row.grant_id}`,
        sourceRef: `grant:${row.grant_id}:forfeit`,
        labels: {
          grant_id: row.grant_id,
          action: 'grant_forfeit',
        },
      })

      if (result.inserted && result.entryId) {
        closureEntryId = result.entryId
      }
    }
  }

  const update: Record<string, unknown> = {
    issuance_status: 'closed',
    closure_kind: 'forfeit',
    closure_entry_id: closureEntryId,
    closed_at: now,
    closed_remaining_xusd: remaining.toString(),
    pending_reserved_xusd: '0',
    updated_at: now,
  }

  await trx
    .updateTable('ledger_grants')
    .set(update)
    .where('grant_id', '=', row.grant_id)
    .execute()
}
