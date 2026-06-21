import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Kysely, RawBuilder, Transaction } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../types/database.js'
import { REALM_ADMIN_PLACEHOLDER_ACCOUNT, setRlsSession } from '../../../db/index.js'
import { envFlag } from '../../../platform/config.js'
import { runInTransaction } from '../../gate/services/gate.utils.js'
import type { MeterSemanticKind } from '../../gate/services/gate.types.js'
import { GateService } from '../../gate/services/gate.service.js'
import {
  compileEventToRatingsDsl,
  evaluateEventToRatingsDsl,
  getRequiredContractTermKeys,
  resolveEventToRatingsParams,
  ContractParamResolutionError,
} from '../../../services/event-to-ratings.dsl.js'

type ProcessingStatus = 'pending' | 'processing' | 'processed' | 'skipped' | 'skipped_no_policy' | 'failed' | 'quarantined'

type LinkKind = 'billed' | 'adjustment' | 'reversal' | 'shadow'

const POLICY_ID = 'event_to_ratings'
const PROCESSING_POLICY_VERSION = 'auto'

type CompiledPolicyVersion = {
  policyId: string
  policyVersion: string
  effectiveAt: Date
  dslHash: string
  compiled: ReturnType<typeof compileEventToRatingsDsl>
}

type PolicyCache = {
  fetchedAtMs: number
  versionsByPolicyId: Map<string, Array<{
    policyVersion: string
    effectiveAt: Date
    dslHash: string
    compiled?: ReturnType<typeof compileEventToRatingsDsl>
    compileError?: string
  }>>
  // Fast narrowing for group queries (exact match only for now).
  eventTypesWithAggregatePolicies: Set<string>
}

const DEFAULT_AGGREGATION_LATENESS_MS = Number.isFinite(Number(process.env.VLUNA_OUTCOME_BILLING_AGGREGATION_LATENESS_MS))
  ? Math.max(0, Math.floor(Number(process.env.VLUNA_OUTCOME_BILLING_AGGREGATION_LATENESS_MS)))
  : 2 * 60 * 60_000
const DEFAULT_AGGREGATION_GROUP_LIMIT = Number.isFinite(Number(process.env.VLUNA_OUTCOME_BILLING_AGGREGATION_GROUP_LIMIT))
  ? Math.max(1, Math.floor(Number(process.env.VLUNA_OUTCOME_BILLING_AGGREGATION_GROUP_LIMIT)))
  : 200

const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000
const DEFAULT_BATCH_LIMIT = 50
const DEFAULT_MAX_ATTEMPTS = 10
const DEFAULT_RETRY_BASE_DELAY_MS = 5_000
const DEFAULT_RETRY_MAX_DELAY_MS = 1 * 60_000

function normalizeCodeFromEventType(eventType: string): string | null {
  const normalized = eventType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/[._-]{2,}/g, '.')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')

  if (!normalized) return null
  if (!/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(normalized)) return null
  return normalized
}

function computeRetryDelayMs(attempts: number): number {
  const power = Math.min(20, Math.max(0, attempts))
  const delay = DEFAULT_RETRY_BASE_DELAY_MS * Math.pow(2, power)
  return Math.min(DEFAULT_RETRY_MAX_DELAY_MS, Math.max(DEFAULT_RETRY_BASE_DELAY_MS, Math.floor(delay)))
}

type AggregateAggExpr = {
  key: string
  op: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct'
  of?: { payload: string } | { label: string } | { event: 'subject_ref' | 'occurred_at' | 'billing_account_id' | 'event_type' | 'semantic_kind' }
}

function collectAggExprs(compiledPolicies: Array<ReturnType<typeof compileEventToRatingsDsl>>): AggregateAggExpr[] {
  const byKey = new Map<string, AggregateAggExpr>()

  const visit = (value: unknown) => {
    if (value === null || value === undefined) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object') return

    const obj = value as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(obj, 'agg')) {
      const aggRaw = obj.agg
      if (aggRaw && typeof aggRaw === 'object' && !Array.isArray(aggRaw)) {
        const a = aggRaw as Record<string, unknown>
        const key = typeof a.key === 'string' ? a.key : null
        const op = typeof a.op === 'string' ? a.op : null
        if (key && op && ['count', 'sum', 'avg', 'min', 'max', 'count_distinct'].includes(op)) {
          const ofRaw = a.of
          let of: AggregateAggExpr['of'] | undefined
          if (ofRaw && typeof ofRaw === 'object' && !Array.isArray(ofRaw)) {
            const o = ofRaw as Record<string, unknown>
            if (typeof o.payload === 'string') of = { payload: o.payload }
            else if (typeof o.label === 'string') of = { label: o.label }
            else if (typeof o.event === 'string') {
              const field = o.event
              if (field === 'subject_ref' || field === 'occurred_at' || field === 'billing_account_id' || field === 'event_type' || field === 'semantic_kind') {
                of = { event: field }
              }
            }
          }
          byKey.set(key, { key, op: op as AggregateAggExpr['op'], of })
        }
      }
    }

    for (const v of Object.values(obj)) visit(v)
  }

  for (const compiled of compiledPolicies) visit(compiled)
  return Array.from(byKey.values())
}

function splitDotPath(path: string): string[] {
  return path.split('.').map((p) => p.trim()).filter(Boolean)
}

function payloadTextExpr(path: string): RawBuilder<string | null> {
  const parts = splitDotPath(path)
  if (parts.length === 0) return sql<string | null>`null`
  const args = [sql.ref('billing_events.payload') as unknown as RawBuilder<unknown>, ...parts.map((p) => sql`${p}`)]
  return sql<string | null>`jsonb_extract_path_text(${sql.join(args, sql`, `)})`
}

function labelValueExpr(_labelKey: string): RawBuilder<string | null> {
  const valueText = sql.ref('bel.value_text')
  const valueUuid = sql.ref('bel.value_uuid')
  const valueBool = sql.ref('bel.value_bool')
  const valueNumber = sql.ref('bel.value_number')
  return sql<string | null>`coalesce(
    ${valueText},
    ${valueUuid},
    case when ${valueBool} is null then null when ${valueBool} then 'true' else 'false' end,
    ${valueNumber}
  )`
}

function safeNumericFromText(textExpr: RawBuilder<string | null>): RawBuilder<string | null> {
  const pattern = '^[+-]?[0-9]+(\\.[0-9]+)?$'
  return sql<string | null>`case when ${textExpr} ~ ${pattern} then (${textExpr})::numeric else null end`
}

function buildAggregateSelectSql(agg: AggregateAggExpr): RawBuilder<unknown> {
  if (agg.op === 'count') return sql<string>`count(*)`
  if (!agg.of) return sql<unknown>`null`

  const distinctExpr = (() => {
    if ('payload' in agg.of) return payloadTextExpr(agg.of.payload)
    if ('label' in agg.of) {
      const labelKey = agg.of.label
      return sql<string | null>`(
        select ${labelValueExpr(labelKey)}
        from billing_event_labels bel
        where bel.event_id = billing_events.event_id
          and bel.label_key = ${labelKey}
        limit 1
      )`
    }
    if ('event' in agg.of) return sql.ref(`billing_events.${agg.of.event}`)
    return sql<string | null>`null`
  })()

  if (agg.op === 'count_distinct') return sql<string>`count(distinct ${distinctExpr})`

  const numericExpr = (() => {
    if ('payload' in agg.of) return safeNumericFromText(payloadTextExpr(agg.of.payload))
    if ('label' in agg.of) {
      const labelKey = agg.of.label
      const textExpr = sql<string | null>`(
        select ${labelValueExpr(labelKey)}
        from billing_event_labels bel
        where bel.event_id = billing_events.event_id
          and bel.label_key = ${labelKey}
        limit 1
      )`
      return safeNumericFromText(textExpr)
    }
    return sql<string | null>`null`
  })()

  if (agg.op === 'sum') return sql<string | null>`sum(${numericExpr})`
  if (agg.op === 'min') return sql<string | null>`min(${numericExpr})`
  if (agg.op === 'max') return sql<string | null>`max(${numericExpr})`
  if (agg.op === 'avg') return sql<string | null>`avg(${numericExpr})`
  return sql<unknown>`null`
}

@Injectable()
export class EventToRatingsService {
  private readonly logger = new Logger(EventToRatingsService.name)
  private readonly dslCache = new Map<string, ReturnType<typeof compileEventToRatingsDsl>>()
  private readonly paramCache = new Map<string, { params: Record<string, number | string | string[] | boolean>; audit: Record<string, unknown> }>()
  private readonly policyCacheByRealm = new Map<string, PolicyCache>()

  constructor(@Inject(GateService) private readonly gateService: GateService) {}

  private async getPolicyCache(
    trx: Transaction<Database>,
    realmId: string,
    opts?: { force?: boolean },
  ): Promise<PolicyCache> {
    const cacheKey = realmId
    const nowMs = Date.now()
    const ttlMs = 5_000
    const existing = this.policyCacheByRealm.get(cacheKey)
    if (existing && !opts?.force && nowMs - existing.fetchedAtMs < ttlMs) {
      return existing
    }

    const rows = await trx
      .selectFrom('event_rating_policy_versions')
      .select(['policy_id', 'policy_version', 'effective_at', 'dsl_json', 'dsl_hash'])
      .where('realm_id', '=', realmId)
      .where('status', '=', 'active')
      .orderBy('policy_id', 'asc')
      .orderBy('effective_at', 'desc')
      .execute()

    const versionsByPolicyId = new Map<string, PolicyCache['versionsByPolicyId'] extends Map<string, infer V> ? V : never>()
    const eventTypesWithAggregatePolicies = new Set<string>()

    for (const row of rows) {
      const policyId = String(row.policy_id)
      const policyVersion = String(row.policy_version)
      const effectiveAt = row.effective_at
      const dslHash = String(row.dsl_hash)
      const dslCacheKey = `${policyId}:${policyVersion}:${dslHash}`

      let compiled: ReturnType<typeof compileEventToRatingsDsl> | undefined
      let compileError: string | undefined
      try {
        compiled = this.dslCache.get(dslCacheKey)
        if (!compiled) {
          compiled = compileEventToRatingsDsl(row.dsl_json)
          this.dslCache.set(dslCacheKey, compiled)
        }
        if (compiled.engine === 'aggregate') {
          eventTypesWithAggregatePolicies.add(compiled.match.eventTypeExact)
        }
      } catch (err) {
        compileError = err instanceof Error ? err.message : 'unknown error'
      }

      if (!versionsByPolicyId.has(policyId)) versionsByPolicyId.set(policyId, [])
      versionsByPolicyId.get(policyId)!.push({
        policyVersion,
        effectiveAt,
        dslHash,
        compiled,
        compileError,
      })
    }

    const next: PolicyCache = {
      fetchedAtMs: nowMs,
      versionsByPolicyId,
      eventTypesWithAggregatePolicies,
    }
    this.policyCacheByRealm.set(cacheKey, next)
    return next
  }

  private async getEffectiveCompiledPolicies(
    trx: Transaction<Database>,
    realmId: string,
    at: Date,
  ): Promise<CompiledPolicyVersion[]> {
    const cache = await this.getPolicyCache(trx, realmId)
    const out: CompiledPolicyVersion[] = []

    for (const [policyId, versions] of cache.versionsByPolicyId.entries()) {
      // versions are ordered by effectiveAt desc (from query order), but we don't rely on it.
      for (const v of versions) {
        if (v.effectiveAt > at) continue
        if (!v.compiled) continue
        out.push({
          policyId,
          policyVersion: v.policyVersion,
          effectiveAt: v.effectiveAt,
          dslHash: v.dslHash,
          compiled: v.compiled,
        })
        break
      }
    }

    return out
  }

  async enqueueEvent(
    db: Kysely<Database> | Transaction<Database>,
    ctx: { realmId: string; billingUserId: string; billingAccountId: string; eventId: string },
    opts?: { policyId?: string; policyVersion?: string; now?: Date },
  ): Promise<void> {
    const now = opts?.now ?? new Date()
    const policyId = opts?.policyId ?? POLICY_ID
    const policyVersion = opts?.policyVersion ?? PROCESSING_POLICY_VERSION

    await runInTransaction(db, async (trx) => {
      await setRlsSession(trx, { realmId: ctx.realmId, billingAccountId: ctx.billingAccountId, billingUserId: ctx.billingUserId })
      await trx
        .insertInto('billing_event_processing')
        .values({
          billing_event_id: ctx.eventId,
          realm_id: ctx.realmId,
          billing_user_id: ctx.billingUserId,
          billing_account_id: ctx.billingAccountId,
          policy_id: policyId,
          policy_version: policyVersion,
          status: 'pending',
          attempts: 0,
          result_json: {},
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(['billing_event_id', 'policy_id', 'policy_version']).doNothing())
        .execute()
    })
  }

  async processSingleEvent(
    db: Kysely<Database> | Transaction<Database>,
    ctx: { realmId: string; billingUserId: string; billingAccountId: string; eventId: string },
    opts?: {
      lockOwner?: string
      lockTimeoutMs?: number
      maxAttempts?: number
      policyId?: string
      policyVersion?: string
      now?: Date
      expectedMeterSemanticKind?: MeterSemanticKind
    },
  ): Promise<
    | { status: 'processed'; ratingIds: string[] }
    | { status: 'skipped'; reason: string }
    | { status: 'busy' }
    | { status: 'failed'; nextRetryAt: Date | null }
  > {
    const now = opts?.now ?? new Date()
    const lockTimeoutMs = opts?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    const lockOwner = opts?.lockOwner ?? 'event-to-ratings'
    const queuePolicyId = opts?.policyId ?? POLICY_ID
    const queuePolicyVersion = opts?.policyVersion ?? PROCESSING_POLICY_VERSION
    const expectedMeterSemanticKind = opts?.expectedMeterSemanticKind ?? 'outcome'
    const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

    return runInTransaction(db, async (trx) => {
      await setRlsSession(trx, { realmId: ctx.realmId, billingAccountId: ctx.billingAccountId, billingUserId: ctx.billingUserId })

      await trx
        .insertInto('billing_event_processing')
        .values({
          billing_event_id: ctx.eventId,
          realm_id: ctx.realmId,
          billing_user_id: ctx.billingUserId,
          billing_account_id: ctx.billingAccountId,
          policy_id: queuePolicyId,
          policy_version: queuePolicyVersion,
          status: 'pending',
          attempts: 0,
          result_json: {},
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(['billing_event_id', 'policy_id', 'policy_version']).doNothing())
        .execute()

      const lockCutoff = new Date(now.getTime() - lockTimeoutMs)

      const claimed = await trx
        .updateTable('billing_event_processing')
        .set({
          status: 'processing',
          locked_by: lockOwner,
          locked_at: now,
          updated_at: now,
          attempts: sql`attempts + 1`,
        })
        .where('billing_event_id', '=', ctx.eventId)
        .where('realm_id', '=', ctx.realmId)
        .where('billing_user_id', '=', ctx.billingUserId)
        .where('billing_account_id', '=', ctx.billingAccountId)
        .where('policy_id', '=', queuePolicyId)
        .where('policy_version', '=', queuePolicyVersion)
        .where((eb) =>
          eb.or([
            eb('status', 'in', ['pending', 'failed'] as ProcessingStatus[]),
            eb.and([eb('status', '=', 'processing'), eb('locked_at', '<', lockCutoff)]),
          ]),
        )
        .where((eb) => eb.or([eb('next_retry_at', 'is', null), eb('next_retry_at', '<=', now)]))
        .returning(['attempts'])
        .executeTakeFirst()
      if (!claimed) {
        return { status: 'busy' }
      }

      const attemptNumber = Number(claimed.attempts ?? 0)
      if (attemptNumber > maxAttempts) {
        await trx
          .updateTable('billing_event_processing')
          .set({
            status: 'quarantined',
            last_error_code: 'event_to_ratings.max_attempts_exceeded',
            last_error_message: `max attempts exceeded (${attemptNumber})`,
            processed_at: now,
            updated_at: now,
          })
          .where('billing_event_id', '=', ctx.eventId)
          .where('realm_id', '=', ctx.realmId)
          .where('billing_user_id', '=', ctx.billingUserId)
          .where('billing_account_id', '=', ctx.billingAccountId)
          .where('policy_id', '=', queuePolicyId)
          .where('policy_version', '=', queuePolicyVersion)
          .execute()
        return { status: 'failed', nextRetryAt: null }
      }

      const eventRow = await trx
        .selectFrom('billing_events')
        .select(['event_id', 'billing_user_id', 'billing_account_id', 'semantic_kind', 'occurred_at', 'event_type', 'subject_ref', 'payload'])
        .where('event_id', '=', ctx.eventId)
        .where('billing_user_id', '=', ctx.billingUserId)
        .where('billing_account_id', '=', ctx.billingAccountId)
        .executeTakeFirst()

      if (!eventRow) {
        await trx
          .updateTable('billing_event_processing')
          .set({
            status: 'skipped',
            last_error_code: null,
            last_error_message: null,
            processed_at: now,
            updated_at: now,
            result_json: { reason: 'event_not_found' },
          })
          .where('billing_event_id', '=', ctx.eventId)
          .where('realm_id', '=', ctx.realmId)
          .where('billing_user_id', '=', ctx.billingUserId)
          .where('billing_account_id', '=', ctx.billingAccountId)
          .where('policy_id', '=', queuePolicyId)
          .where('policy_version', '=', queuePolicyVersion)
          .execute()
        return { status: 'skipped', reason: 'event_not_found' }
      }

      const effectivePolicies = await this.getEffectiveCompiledPolicies(trx, ctx.realmId, eventRow.occurred_at)

      if (effectivePolicies.length === 0) {
        await trx
          .updateTable('billing_event_processing')
          .set({
            status: 'skipped_no_policy',
            processed_at: now,
            updated_at: now,
            result_json: { reason: 'no_active_policies' },
          })
          .where('billing_event_id', '=', ctx.eventId)
          .where('realm_id', '=', ctx.realmId)
          .where('billing_user_id', '=', ctx.billingUserId)
          .where('billing_account_id', '=', ctx.billingAccountId)
          .where('policy_id', '=', queuePolicyId)
          .where('policy_version', '=', queuePolicyVersion)
          .execute()
        return { status: 'skipped', reason: 'no_active_policies' }
      }

      const labelRows = await trx
        .selectFrom('billing_event_labels')
        .select(['label_key', 'value_text', 'value_uuid', 'value_bool', 'value_number'])
        .where('event_id', '=', ctx.eventId)
        .execute()
      const labels: Record<string, unknown> = {}
      for (const row of labelRows) {
        const key = String(row.label_key)
        if (!key) continue
        if (row.value_text !== null && row.value_text !== undefined) labels[key] = row.value_text
        else if (row.value_uuid !== null && row.value_uuid !== undefined) labels[key] = row.value_uuid
        else if (row.value_bool !== null && row.value_bool !== undefined) labels[key] = Boolean(row.value_bool)
        else if (row.value_number !== null && row.value_number !== undefined) labels[key] = row.value_number
      }

      const eventInput = {
        source_kind: 'event',
        realm_id: ctx.realmId,
        billing_account_id: ctx.billingAccountId,
        semantic_kind: eventRow.semantic_kind,
        occurred_at: eventRow.occurred_at.toISOString(),
        event_type: eventRow.event_type,
        subject_ref: eventRow.subject_ref ?? null,
        payload: (eventRow.payload ?? {}) as Record<string, unknown>,
        labels,
      } as const

      const contractRow = await trx
        .selectFrom('billing_contracts')
        .select(['contract_id', 'effective_at'])
        .where('realm_id', '=', ctx.realmId)
        .where('billing_account_id', '=', ctx.billingAccountId)
        .where('status', '=', 'active')
        .where('effective_at', '<=', eventRow.occurred_at)
        .orderBy('effective_at', 'desc')
        .limit(1)
        .executeTakeFirst()
      const contractId = contractRow?.contract_id ? String(contractRow.contract_id) : null

      // Narrow candidates early by exact event_type + engine.
      // Aggregate policies are not evaluated on single-event input.
      const compiledCandidates = effectivePolicies.filter(
        (p) => p.compiled.engine === 'single' && p.compiled.match.eventTypeExact === eventRow.event_type,
      )

      const requiredTermKeys = new Set<string>()
      for (const cand of compiledCandidates) {
        for (const key of getRequiredContractTermKeys(cand.compiled)) {
          requiredTermKeys.add(key)
        }
      }

      const termValuesByKey: Record<string, unknown> = {}
      if (contractId && requiredTermKeys.size > 0) {
        const termRows = await trx
          .selectFrom('contract_terms')
          .select(['term_key', 'value_json', 'effective_at'])
          .distinctOn(['term_key'])
          .where('contract_id', '=', contractId)
          .where('kind', '=', 'e2r_param')
          .where('term_key', 'in', Array.from(requiredTermKeys))
          .where('effective_at', '<=', eventRow.occurred_at)
          .orderBy('term_key', 'asc')
          .orderBy('effective_at', 'desc')
          .execute()
        for (const row of termRows) {
          termValuesByKey[String(row.term_key)] = row.value_json
        }
      }

      const matches: Array<{
        policyId: string
        policyVersion: string
        effectiveAt: Date
        dslHash: string
        compiled: ReturnType<typeof compileEventToRatingsDsl>
        params: Record<string, number | string | string[] | boolean>
        paramAudit: Record<string, unknown>
        evaluation: NonNullable<ReturnType<typeof evaluateEventToRatingsDsl>>
      }> = []
      const blockedByMissingTerms: Array<{ policyId: string; policyVersion: string; code: string; message: string }> = []

      for (const cand of compiledCandidates) {
        try {
          const { params: resolvedParams, audit: paramAudit } = resolveEventToRatingsParams(cand.compiled, termValuesByKey)
          const evaluation = evaluateEventToRatingsDsl(cand.compiled, eventInput, resolvedParams)
          if (!evaluation) continue
          matches.push({
            policyId: cand.policyId,
            policyVersion: cand.policyVersion,
            effectiveAt: cand.effectiveAt,
            dslHash: cand.dslHash,
            compiled: cand.compiled,
            params: resolvedParams,
            paramAudit,
            evaluation,
          })
        } catch (error) {
          if (error instanceof ContractParamResolutionError) {
            blockedByMissingTerms.push({
              policyId: cand.policyId,
              policyVersion: cand.policyVersion,
              code: error.code,
              message: error instanceof Error ? error.message : 'unknown error',
            })
            continue
          }
          const message = error instanceof Error ? error.message : 'unknown error'
          this.logger.error(`E2R DSL eval failed policy=${cand.policyId}@${cand.policyVersion}: ${message}`)
        }
      }

      if (matches.length > 1) {
        await trx
          .updateTable('billing_event_processing')
          .set({
            status: 'quarantined',
            last_error_code: 'event_to_ratings.multiple_policies_matched',
            last_error_message: `Multiple active policies matched: ${matches.map((m) => `${m.policyId}@${m.policyVersion}`).join(', ')}`,
            processed_at: now,
            updated_at: now,
            result_json: {
              reason: 'multiple_policies_matched',
              matches: matches.map((m) => ({ policy_id: m.policyId, policy_version: m.policyVersion })),
            },
          })
          .where('billing_event_id', '=', ctx.eventId)
          .where('realm_id', '=', ctx.realmId)
          .where('billing_user_id', '=', ctx.billingUserId)
          .where('billing_account_id', '=', ctx.billingAccountId)
          .where('policy_id', '=', queuePolicyId)
          .where('policy_version', '=', queuePolicyVersion)
          .execute()
        return { status: 'failed', nextRetryAt: null }
      }

      if (matches.length === 0) {
        if (blockedByMissingTerms.length > 0) {
          const first = blockedByMissingTerms[0]!
          const delayMs = computeRetryDelayMs(attemptNumber)
          const nextRetryAt = new Date(now.getTime() + delayMs)
          await trx
            .updateTable('billing_event_processing')
            .set({
              status: 'failed',
              last_error_code: `event_to_ratings.${first.code}`,
              last_error_message: first.message,
              processed_at: null,
              next_retry_at: nextRetryAt,
              updated_at: now,
              result_json: {
                reason: 'policy_match_blocked_by_missing_terms',
                blocked: blockedByMissingTerms,
              },
            })
            .where('billing_event_id', '=', ctx.eventId)
            .where('realm_id', '=', ctx.realmId)
          .where('billing_user_id', '=', ctx.billingUserId)
            .where('billing_account_id', '=', ctx.billingAccountId)
            .where('policy_id', '=', queuePolicyId)
            .where('policy_version', '=', queuePolicyVersion)
            .execute()
          return { status: 'failed', nextRetryAt }
        }

        await trx
          .updateTable('billing_event_processing')
          .set({
            status: 'skipped_no_policy',
            processed_at: now,
            updated_at: now,
            result_json: { reason: 'no_matching_policy' },
          })
          .where('billing_event_id', '=', ctx.eventId)
          .where('realm_id', '=', ctx.realmId)
          .where('billing_user_id', '=', ctx.billingUserId)
          .where('billing_account_id', '=', ctx.billingAccountId)
          .where('policy_id', '=', queuePolicyId)
          .where('policy_version', '=', queuePolicyVersion)
          .execute()
        return { status: 'skipped', reason: 'no_matching_policy' }
      }

      const selected = matches[0]!
      const selectedPolicyId = selected.policyId
      const selectedPolicyVersion = selected.policyVersion
      const selectedEffectiveAt = selected.effectiveAt
      const selectedDslCacheKey = `${selectedPolicyId}:${selectedPolicyVersion}:${selected.dslHash}`
      const evaluation = selected.evaluation

      // stash for later result_json + ingest idempotency
      this.paramCache.set(
        `evt:${ctx.eventId}:${selectedDslCacheKey}`,
        { params: selected.params, audit: { contract_id: contractId, params: selected.paramAudit } },
      )

      if (!evaluation || evaluation.intents.length === 0) {
        await trx
          .updateTable('billing_event_processing')
          .set({
            status: 'skipped',
            processed_at: now,
            updated_at: now,
            result_json: {
              reason: 'no_match',
              policy_id: selectedPolicyId,
              resolved_policy_version: String(selectedPolicyVersion),
              resolved_effective_at: selectedEffectiveAt,
            },
          })
          .where('billing_event_id', '=', ctx.eventId)
          .where('realm_id', '=', ctx.realmId)
          .where('billing_user_id', '=', ctx.billingUserId)
          .where('billing_account_id', '=', ctx.billingAccountId)
          .where('policy_id', '=', queuePolicyId)
          .where('policy_version', '=', queuePolicyVersion)
          .execute()
        return { status: 'skipped', reason: 'no_match' }
      }

      if (eventRow.semantic_kind !== expectedMeterSemanticKind) {
        await trx
          .updateTable('billing_event_processing')
          .set({
            status: 'skipped',
            processed_at: now,
            updated_at: now,
            result_json: {
              reason: 'unexpected_semantic_kind',
              semantic_kind: eventRow.semantic_kind,
              expected_semantic_kind: expectedMeterSemanticKind,
              policy_id: selectedPolicyId,
              resolved_policy_version: String(selectedPolicyVersion),
              resolved_effective_at: selectedEffectiveAt,
            },
          })
          .where('billing_event_id', '=', ctx.eventId)
          .where('realm_id', '=', ctx.realmId)
          .where('billing_user_id', '=', ctx.billingUserId)
          .where('billing_account_id', '=', ctx.billingAccountId)
          .where('policy_id', '=', queuePolicyId)
          .where('policy_version', '=', queuePolicyVersion)
          .execute()
        return { status: 'skipped', reason: 'unexpected_semantic_kind' }
      }

      if (selected.compiled.engine === 'aggregate') {
        await trx
          .updateTable('billing_event_processing')
          .set({
            status: 'skipped',
            processed_at: now,
            updated_at: now,
            result_json: {
              reason: 'matched_aggregate_policy',
              policy_id: selectedPolicyId,
              resolved_policy_version: String(selectedPolicyVersion),
              resolved_effective_at: selectedEffectiveAt,
            },
          })
          .where('billing_event_id', '=', ctx.eventId)
          .where('realm_id', '=', ctx.realmId)
          .where('billing_user_id', '=', ctx.billingUserId)
          .where('billing_account_id', '=', ctx.billingAccountId)
          .where('policy_id', '=', queuePolicyId)
          .where('policy_version', '=', queuePolicyVersion)
          .execute()
        return { status: 'skipped', reason: 'matched_aggregate_policy' }
      }

      const ratingIds: string[] = []
      try {
        const cached = this.paramCache.get(`evt:${ctx.eventId}:${selectedDslCacheKey}`)
        const contractId = cached?.audit && typeof (cached.audit as { contract_id?: unknown }).contract_id === 'string'
          ? String((cached.audit as { contract_id: string }).contract_id)
          : null
        for (const [outputIndex, intent] of evaluation.intents.entries()) {
          const idempotencyKey = `evt:${ctx.eventId}:ct:${contractId ?? '-'}:policy:${selectedPolicyId}:v:${String(selectedPolicyVersion)}:i:${outputIndex}`
          const ingestBody = {
            feature_code: intent.featureCode,
            occurred_at: eventRow.occurred_at.toISOString(),
            budget_id: intent.budgetId ?? undefined,
            quantity_minor: typeof intent.quantityMinor === 'number' ? String(intent.quantityMinor) : undefined,
            meters: intent.meters.map((meter) => ({
              meter_code: meter.meterCode,
              quantity_minor: String(meter.quantityMinor),
            })),
            labels: intent.labels ?? undefined,
            metadata: intent.metadata ?? undefined,
          }
          const { response } = await this.gateService.ingestInternal(
            trx,
            { realmId: ctx.realmId, billingUserId: ctx.billingUserId, billingAccountId: ctx.billingAccountId },
            ingestBody,
            idempotencyKey,
            expectedMeterSemanticKind,
          )

          const ratingId = response.commit_id ? String(response.commit_id) : null
          if (!ratingId) {
            throw new Error('missing commit_id from ingest response')
          }
          ratingIds.push(ratingId)

          await trx
            .insertInto('billing_event_ratings')
            .values({
              realm_id: ctx.realmId,
              billing_user_id: ctx.billingUserId,
              billing_account_id: ctx.billingAccountId,
              billing_event_id: ctx.eventId,
              rating_id: ratingId,
              link_kind: intent.linkKind as LinkKind,
              policy_id: selectedPolicyId,
              policy_version: String(selectedPolicyVersion),
              output_index: outputIndex,
              idempotency_key: idempotencyKey,
              created_at: now,
            })
            .onConflict((oc) => oc.doNothing())
            .execute()
        }

        await trx
          .updateTable('billing_event_processing')
          .set({
            status: 'processed',
            processed_at: now,
            updated_at: now,
            next_retry_at: null,
            last_error_code: null,
            last_error_message: null,
            result_json: {
              policy_id: selectedPolicyId,
              resolved_policy_version: String(selectedPolicyVersion),
              resolved_effective_at: selectedEffectiveAt,
              matched_rule_index: 0,
              intents: evaluation.intents.length,
              rating_ids: ratingIds,
              ...(cached?.audit ?? {}),
            },
          })
          .where('billing_event_id', '=', ctx.eventId)
          .where('realm_id', '=', ctx.realmId)
          .where('billing_user_id', '=', ctx.billingUserId)
          .where('billing_account_id', '=', ctx.billingAccountId)
          .where('policy_id', '=', queuePolicyId)
          .where('policy_version', '=', queuePolicyVersion)
          .execute()

        return { status: 'processed', ratingIds }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error'
        const delayMs = computeRetryDelayMs(attemptNumber)
        const nextRetryAt = new Date(now.getTime() + delayMs)

        const cached = this.paramCache.get(`evt:${ctx.eventId}:${selectedDslCacheKey}`)
        await trx
          .updateTable('billing_event_processing')
          .set({
            status: 'failed',
            last_error_code: 'event_to_ratings.failed',
            last_error_message: message,
            next_retry_at: nextRetryAt,
            updated_at: now,
            result_json: {
              policy_id: selectedPolicyId,
              resolved_policy_version: String(selectedPolicyVersion),
              resolved_effective_at: selectedEffectiveAt,
              matched_rule_index: 0,
              partial_rating_ids: ratingIds,
              ...(cached?.audit ?? {}),
            },
          })
          .where('billing_event_id', '=', ctx.eventId)
          .where('realm_id', '=', ctx.realmId)
          .where('billing_user_id', '=', ctx.billingUserId)
          .where('billing_account_id', '=', ctx.billingAccountId)
          .where('policy_id', '=', queuePolicyId)
          .where('policy_version', '=', queuePolicyVersion)
          .execute()

        this.logger.error(`Failed E2R event_id=${ctx.eventId} queue=${queuePolicyId}@${queuePolicyVersion}: ${message}`)
        return { status: 'failed', nextRetryAt }
      }
    })
  }

  async processSingleEventIfEnabledFromApi(
    db: Kysely<Database> | Transaction<Database>,
    ctx: { realmId: string; billingUserId: string; billingAccountId: string; eventId: string },
  ): Promise<void> {
    // if (!envFlag('VLUNA_GATE_ENABLE_LEDGER_SYNC')) return
    await this.processSingleEvent(db, ctx, { lockOwner: 'events-api', expectedMeterSemanticKind: 'outcome' })
  }

  async processNextBatch(
    db: Kysely<Database> | Transaction<Database>,
    ctx: { realmId: string; billingAccountId?: string },
    opts?: { limit?: number; lockOwner?: string; asRealmAdmin?: boolean },
  ): Promise<{ attempted: number; processed: number; failed: number; skipped: number }> {
    const limit = opts?.limit ?? DEFAULT_BATCH_LIMIT
    const now = new Date()
    const lockOwner = opts?.lockOwner ?? 'event-to-ratings-worker'

    return runInTransaction(db, async (trx) => {
      await setRlsSession(trx, {
        realmId: ctx.realmId,
        billingAccountId: ctx.billingAccountId,
        isRealmAdmin: Boolean(opts?.asRealmAdmin),
      })

      const candidates = await trx
        .selectFrom('billing_event_processing')
        .select(['billing_event_id', 'billing_user_id', 'billing_account_id'])
        .where('realm_id', '=', ctx.realmId)
        .where('policy_id', '=', POLICY_ID)
        .where('policy_version', '=', PROCESSING_POLICY_VERSION)
        .where('status', 'in', ['pending', 'failed'] as ProcessingStatus[])
        .where((eb) => eb.or([eb('next_retry_at', 'is', null), eb('next_retry_at', '<=', now)]))
        .orderBy('billing_event_id', 'asc')
        .limit(limit)
        .execute()

      let processed = 0
      let failed = 0
      let skipped = 0
      for (const row of candidates) {
        const result = await this.processSingleEvent(
          trx,
          {
            realmId: ctx.realmId,
            billingUserId: String(row.billing_user_id),
            billingAccountId: String(row.billing_account_id),
            eventId: String(row.billing_event_id),
          },
          { lockOwner },
        )
        if (result.status === 'processed') processed += 1
        if (result.status === 'failed') failed += 1
        if (result.status === 'skipped') skipped += 1
      }

      return { attempted: candidates.length, processed, failed, skipped }
    })
  }

  async aggregateOutcomeEventsForRealm(
    db: Kysely<Database> | Transaction<Database>,
    ctx: { realmId: string },
  ): Promise<{ groupsConsidered: number; ratingsEmitted: number; linksInserted: number }> {
    const includeEventLinks = envFlag('VLUNA_OUTCOME_BILLING_AGGREGATION_LINK_EVENTS', true)
    const now = new Date()
    const cutoff = new Date(now.getTime() - DEFAULT_AGGREGATION_LATENESS_MS)
    const windowEndExclusive = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), cutoff.getUTCDate()))

    return runInTransaction(db, async (trx) => {
      await setRlsSession(trx, { realmId: ctx.realmId, billingAccountId: REALM_ADMIN_PLACEHOLDER_ACCOUNT, isRealmAdmin: true })

      const policyCache = await this.getPolicyCache(trx, ctx.realmId)
      const eventTypes = Array.from(policyCache.eventTypesWithAggregatePolicies)
      if (eventTypes.length === 0) {
        return { groupsConsidered: 0, ratingsEmitted: 0, linksInserted: 0 }
      }

      type GroupRow = {
        billing_user_id: string
        billing_account_id: string
        contract_id: string | null
        window_start: Date
        window_end: Date
        event_type: string
        cnt: string | number
      }

      const groupRows = await trx
        .selectFrom('billing_events')
        .select((eb) => [
          eb.ref('billing_user_id').as('billing_user_id'),
          eb.ref('billing_account_id').as('billing_account_id'),
          sql<string>`(
            select bc.contract_id
            from billing_contracts bc
            where bc.realm_id = billing_events.realm_id
              and bc.billing_account_id = billing_events.billing_account_id
              and bc.status = 'active'
              and bc.effective_at <= billing_events.occurred_at
            order by bc.effective_at desc
            limit 1
          )`.as('contract_id'),
          sql<Date>`date_trunc('day', billing_events.occurred_at)`.as('window_start'),
          sql<Date>`(date_trunc('day', billing_events.occurred_at) + interval '1 day')`.as('window_end'),
          eb.ref('event_type').as('event_type'),
          sql<string>`count(*)`.as('cnt'),
        ])
        .where('realm_id', '=', ctx.realmId)
        .where('semantic_kind', '=', 'outcome')
        .where('event_type', 'in', eventTypes)
        .where('occurred_at', '<', windowEndExclusive)
        .groupBy([
          'billing_user_id',
          'billing_account_id',
          'event_type',
          sql`date_trunc('day', billing_events.occurred_at)`,
          sql`(
            select bc.contract_id
            from billing_contracts bc
            where bc.realm_id = billing_events.realm_id
              and bc.billing_account_id = billing_events.billing_account_id
              and bc.status = 'active'
              and bc.effective_at <= billing_events.occurred_at
            order by bc.effective_at desc
            limit 1
          )`,
        ])
        .orderBy('billing_user_id', 'asc')
        .orderBy('billing_account_id', 'asc')
        .orderBy(sql`date_trunc('day', billing_events.occurred_at)`, 'asc')
        .orderBy('event_type', 'asc')
        .limit(DEFAULT_AGGREGATION_GROUP_LIMIT)
        .execute() as unknown as GroupRow[]

      let ratingsEmitted = 0
      let linksInserted = 0

      for (const row of groupRows) {
        const groupKey = normalizeCodeFromEventType(row.event_type)
        if (!groupKey) continue

        const count = typeof row.cnt === 'string' ? Number(row.cnt) : Number(row.cnt)
        if (!Number.isFinite(count) || count <= 0) continue

        const dateKey = `${row.window_start.getUTCFullYear()}-${String(row.window_start.getUTCMonth() + 1).padStart(2, '0')}-${String(row.window_start.getUTCDate()).padStart(2, '0')}`

        const effectivePolicies = await this.getEffectiveCompiledPolicies(trx, ctx.realmId, row.window_start)
        const compiledCandidates = effectivePolicies.filter(
          (p) => p.compiled.engine === 'aggregate' && p.compiled.match.eventTypeExact === row.event_type,
        )
        if (compiledCandidates.length === 0) continue

        const aggs: Record<string, number | null> = { count }
        const requiredAggExprs = collectAggExprs(compiledCandidates.map((c) => c.compiled))
        const nonCountAggs = requiredAggExprs.filter((a) => a.op !== 'count')

        if (nonCountAggs.length > 0) {
          const contractIdOrNull = row.contract_id ? String(row.contract_id) : null
          const contractIdExpr = sql<string | null>`(
            select bc.contract_id
            from billing_contracts bc
            where bc.realm_id = billing_events.realm_id
              and bc.billing_account_id = billing_events.billing_account_id
              and bc.status = 'active'
              and bc.effective_at <= billing_events.occurred_at
            order by bc.effective_at desc
            limit 1
          )`

          const q = trx
            .selectFrom('billing_events')
            .where('realm_id', '=', ctx.realmId)
            .where('billing_user_id', '=', String(row.billing_user_id))
            .where('billing_account_id', '=', String(row.billing_account_id))
            .where('semantic_kind', '=', 'outcome')
            .where('event_type', '=', row.event_type)
            .where('occurred_at', '>=', row.window_start)
            .where('occurred_at', '<', row.window_end)
            .where(sql<boolean>`${contractIdExpr} is not distinct from ${contractIdOrNull}`)

          const aliasByAggKey = new Map<string, string>()
          const selects = nonCountAggs.map((agg, index) => {
            const colAlias = `agg_${index}`
            aliasByAggKey.set(agg.key, colAlias)
            return buildAggregateSelectSql(agg).as(colAlias)
          })

          const rowAgg = await q.select(selects).executeTakeFirst()
          for (const [aggKey, colAlias] of aliasByAggKey.entries()) {
            const raw = rowAgg ? (rowAgg as Record<string, unknown>)[colAlias] : null
            if (raw === null || raw === undefined) {
              aggs[aggKey] = null
              continue
            }
            const num = typeof raw === 'number' ? raw : Number(raw)
            aggs[aggKey] = Number.isFinite(num) ? num : null
          }
        }

        const aggregateInput = {
          source_kind: 'aggregate',
          realm_id: ctx.realmId,
          billing_user_id: String(row.billing_user_id),
          billing_account_id: String(row.billing_account_id),
          semantic_kind: 'outcome',
          event_type: row.event_type,
          aggregation: {
            window_start: row.window_start.toISOString(),
            window_end: row.window_end.toISOString(),
          },
          aggs,
        } as const

        const requiredTermKeys = new Set<string>()
        for (const cand of compiledCandidates) {
          for (const key of getRequiredContractTermKeys(cand.compiled)) requiredTermKeys.add(key)
        }

        const contractIdOrNull = row.contract_id ? String(row.contract_id) : null
        const termValuesByKey: Record<string, unknown> = {}
        if (contractIdOrNull && requiredTermKeys.size > 0) {
          const termRows = await trx
            .selectFrom('contract_terms')
            .select(['term_key', 'value_json', 'effective_at'])
            .distinctOn(['term_key'])
            .where('contract_id', '=', contractIdOrNull)
            .where('kind', '=', 'e2r_param')
            .where('term_key', 'in', Array.from(requiredTermKeys))
            .where('effective_at', '<=', row.window_start)
            .orderBy('term_key', 'asc')
            .orderBy('effective_at', 'desc')
            .execute()
          for (const t of termRows) {
            termValuesByKey[String(t.term_key)] = t.value_json
          }
        }

        const matches: Array<{
          policyId: string
          policyVersion: string
          effectiveAt: Date
          dslHash: string
          compiled: ReturnType<typeof compileEventToRatingsDsl>
          params: Record<string, number | string | string[] | boolean>
          evaluation: NonNullable<ReturnType<typeof evaluateEventToRatingsDsl>>
        }> = []

        for (const cand of compiledCandidates) {
          try {
            const { params: resolvedParams } = resolveEventToRatingsParams(cand.compiled, termValuesByKey)
            const evaluation = evaluateEventToRatingsDsl(cand.compiled, aggregateInput, resolvedParams)
            if (!evaluation) continue
            matches.push({
              policyId: cand.policyId,
              policyVersion: cand.policyVersion,
              effectiveAt: cand.effectiveAt,
              dslHash: cand.dslHash,
              compiled: cand.compiled,
              params: resolvedParams,
              evaluation,
            })
          } catch (error) {
            if (error instanceof ContractParamResolutionError) {
              // Wait for missing/invalid terms to be fixed (next sweep will retry).
              continue
            }
            const message = error instanceof Error ? error.message : 'unknown error'
            this.logger.error(`Aggregation DSL eval failed policy=${cand.policyId}@${cand.policyVersion} event_type=${row.event_type}: ${message}`)
          }
        }

        if (matches.length !== 1) {
          if (matches.length > 1) {
            this.logger.error(
              `Aggregation multiple policies matched event_type=${row.event_type}: ${matches.map((m) => `${m.policyId}@${m.policyVersion}`).join(', ')}`,
            )
          }
          continue
        }

        const selected = matches[0]!
        if (selected.compiled.engine !== 'aggregate') continue

        const evaluation = selected.evaluation
        if (evaluation.intents.length !== 1) continue
        const intent = evaluation.intents[0]

        const contractId = contractIdOrNull ?? '-'
        const idem = `agg:${ctx.realmId}:bu:${row.billing_user_id}:ba:${row.billing_account_id}:ct:${contractId}:day:${dateKey}:g:${groupKey}:policy:${selected.policyId}:v:${String(selected.policyVersion)}`

        const { response } = await this.gateService.ingestInternal(
          trx,
          { realmId: ctx.realmId, billingUserId: String(row.billing_user_id), billingAccountId: String(row.billing_account_id) },
          {
            feature_code: intent.featureCode,
            occurred_at: row.window_start.toISOString(),
            budget_id: intent.budgetId ?? undefined,
            quantity_minor: typeof intent.quantityMinor === 'number' ? String(intent.quantityMinor) : undefined,
            meters: intent.meters.map((m) => ({ meter_code: m.meterCode, quantity_minor: String(m.quantityMinor) })),
            labels: {
              event_type: row.event_type,
              window_start: row.window_start.toISOString(),
              ...(intent.labels ?? {}),
            },
            metadata: intent.metadata ?? undefined,
          },
          idem,
          'outcome',
        )

        const ratingId = response.commit_id ? String(response.commit_id) : null
        if (!ratingId) continue
        ratingsEmitted += 1

        await trx
          .insertInto('billing_ratings_aggregation_runs')
          .values({
            realm_id: ctx.realmId,
            billing_user_id: String(row.billing_user_id),
            billing_account_id: String(row.billing_account_id),
            contract_id: row.contract_id ? String(row.contract_id) : null,
            policy_id: selected.policyId,
            policy_version: String(selected.policyVersion),
            window_kind: 'day',
            window_start: row.window_start,
            window_end: row.window_end,
            group_key: groupKey,
            aggregated_input_count: String(count),
            aggregated_quantity_minor: intent.meters.length === 1 ? String(intent.meters[0].quantityMinor) : null,
            aggregated_metrics: {
              count: String(count),
              matched_rule_index: 0,
              contract_id: row.contract_id ? String(row.contract_id) : null,
              resolved_policy_version: String(selected.policyVersion),
              resolved_effective_at: selected.effectiveAt.toISOString(),
            },
            rating_id: ratingId,
            idempotency_key: idem,
            metadata: { event_type: row.event_type },
            created_at: now,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc
              .columns(['realm_id', 'billing_user_id', 'contract_id', 'policy_id', 'policy_version', 'window_start', 'group_key'])
              .doNothing(),
          )
          .execute()

        if (!includeEventLinks) continue

        const inserted = await trx
          .insertInto('billing_event_ratings')
          .columns([
            'realm_id',
            'billing_user_id',
            'billing_account_id',
            'billing_event_id',
            'rating_id',
            'link_kind',
            'policy_id',
            'policy_version',
            'output_index',
            'engine_run_id',
            'idempotency_key',
            'created_at',
          ])
          .expression((eb) =>
            eb
              .selectFrom('billing_events')
              .select([
                eb.val(ctx.realmId).as('realm_id'),
                'billing_events.billing_user_id as billing_user_id',
                'billing_events.billing_account_id as billing_account_id',
                'billing_events.event_id as billing_event_id',
                eb.val(ratingId).as('rating_id'),
                eb.val(intent.linkKind).as('link_kind'),
                eb.val(selected.policyId).as('policy_id'),
                eb.val(String(selected.policyVersion)).as('policy_version'),
                eb.val(0).as('output_index'),
                eb.val(idem).as('engine_run_id'),
                eb.val(null).as('idempotency_key'),
                eb.val(now).as('created_at'),
              ])
              .where('billing_events.realm_id', '=', ctx.realmId)
              .where('billing_events.billing_user_id', '=', String(row.billing_user_id))
              .where('billing_events.billing_account_id', '=', String(row.billing_account_id))
              .where('billing_events.semantic_kind', '=', 'outcome')
              .where('billing_events.event_type', '=', row.event_type)
              .where('billing_events.occurred_at', '>=', row.window_start)
              .where('billing_events.occurred_at', '<', row.window_end),
          )
          .onConflict((oc) => oc.doNothing())
          .executeTakeFirst()

        linksInserted += Number(inserted?.numInsertedOrUpdatedRows ?? 0)
      }

      return { groupsConsidered: groupRows.length, ratingsEmitted, linksInserted }
    })
  }

}
