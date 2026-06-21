import { type Kysely, type Selectable, type Transaction } from 'kysely'
import crypto from 'node:crypto'
import type { Database } from '../../../types/database.js'
import type { components as BillingComponents } from '../../../contracts/billing.js'
import type { ErrorCode } from '../../../contracts/error-codes.js'
import { runInTransaction } from '../../gate/services/gate.utils.js'

type BillingEventPayload = BillingComponents['schemas']['BillingEventIngestRequest'] & {
  billing_user_id: string
  billing_account_id: string
}

type BillingEventRow = Selectable<Database['billing_events']>

export type BatchIngestItemInput = {
  index: number
  payload: BillingEventPayload
  labels: BillingEventPayload['labels'] | undefined
}

export type BatchIngestResult = {
  results: BillingComponents['schemas']['BillingEventBatchItemResult'][]
  acceptedCount: number
  failedCount: number
}

export type IngestResult = {
  created: boolean
  event: BillingComponents['schemas']['BillingEvent']
}

export class BillingEventsError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly errorCode: ErrorCode,
    message: string,
    readonly batchStatus: 'invalid' | 'failed' = 'failed',
  ) {
    super(message)
  }
}

export class BillingEventsService {
  static async ingestEvent(
    db: Kysely<Database> | Transaction<Database> | undefined,
    realmId: string | undefined,
    payload: BillingEventPayload,
    labels: BillingEventPayload['labels'] | undefined,
  ): Promise<IngestResult> {
    if (!db) throw new BillingEventsError(500, 'SERVER.CONFIG', 'database unavailable')
    if (!realmId) throw new BillingEventsError(500, 'SERVER.CONFIG', 'realm unavailable')

    const billingUserId = normalizeBillingAccountId(payload.billing_user_id)
    const billingAccountId = normalizeBillingAccountId(payload.billing_account_id)
    const semanticKind = normalizeEventSemanticKind(payload.semantic_kind)
    const occurredAt = normalizeTimestamp(payload.occurred_at)
    const eventType = normalizeEventType(payload.event_type)
    const subjectRef = normalizeOptionalSubjectRef(payload.subject_ref)
    const payloadObj = normalizePayload(payload.payload)

    const requestHash = computeRequestHash({
      billing_account_id: billingAccountId,
      billing_user_id: billingUserId,
      semantic_kind: semanticKind,
      event_type: eventType,
      occurred_at: occurredAt,
      subject_ref: subjectRef,
      payload: payloadObj,
    })

    const insertValues = {
      realm_id: realmId,
      billing_user_id: billingUserId,
      billing_account_id: billingAccountId,
      semantic_kind: semanticKind,
      occurred_at: occurredAt,
      event_type: eventType,
      subject_ref: subjectRef,
      payload: payloadObj,
      request_hash: requestHash,
    }

    const inserted = await db
      .insertInto('billing_events')
      .values(insertValues)
      .onConflict((oc) => oc.columns(['billing_user_id', 'request_hash']).doNothing())
      .returning(['event_id', 'realm_id', 'billing_user_id', 'billing_account_id', 'semantic_kind', 'occurred_at', 'event_type', 'subject_ref', 'payload', 'request_hash', 'created_at'])
      .executeTakeFirst()

    const eventRow: BillingEventRow = inserted
      ? inserted
          : await db
          .selectFrom('billing_events')
          .select(['event_id', 'realm_id', 'billing_user_id', 'billing_account_id', 'semantic_kind', 'occurred_at', 'event_type', 'subject_ref', 'payload', 'request_hash', 'created_at'])
          .where('billing_user_id', '=', billingUserId)
          .where('billing_account_id', '=', billingAccountId)
          .where('request_hash', '=', requestHash)
          .executeTakeFirstOrThrow(() =>
            new BillingEventsError(500, 'SERVER.UNEXPECTED', 'failed to fetch billing event after insert'),
          )

    if (inserted && labels) {
      const labelRows = buildLabelRows(eventRow.event_id, labels)
      if (labelRows.length > 0) {
        await db
          .insertInto('billing_event_labels')
          .values(labelRows)
          .onConflict((oc) => oc.doNothing())
          .execute()
      }
    }

    const event = mapRowToEnvelope(eventRow, labels)
    const created = Boolean(inserted)
    return { created, event }
  }

  static async ingestEventsBatch(
    db: Kysely<Database> | Transaction<Database> | undefined,
    realmId: string | undefined,
    items: BatchIngestItemInput[],
  ): Promise<BatchIngestResult> {
    if (!db) throw new BillingEventsError(500, 'SERVER.CONFIG', 'database unavailable')
    if (!realmId) throw new BillingEventsError(500, 'SERVER.CONFIG', 'realm unavailable')
    if (items.length === 0) {
      return { results: [], acceptedCount: 0, failedCount: 0 }
    }

    type NormalizedBatchItem = {
      index: number
      billingUserId: string
      billingAccountId: string
      semanticKind: 'activity' | 'outcome'
      occurredAt: Date
      eventType: string
      subjectRef: string | null
      payload: Record<string, unknown>
      labels: BillingEventPayload['labels'] | undefined
    }

    const results: BillingComponents['schemas']['BillingEventBatchItemResult'][] = []
    let acceptedCount = 0
    let failedCount = 0
    const normalized: NormalizedBatchItem[] = []

    for (const item of items) {
      try {
        const billingUserId = normalizeBillingAccountId(item.payload.billing_user_id)
        const billingAccountId = normalizeBillingAccountId(item.payload.billing_account_id)
        const semanticKind = normalizeEventSemanticKind(item.payload.semantic_kind)
        const occurredAt = normalizeTimestamp(item.payload.occurred_at)
        const eventType = normalizeEventType(item.payload.event_type)
        const subjectRef = normalizeOptionalSubjectRef(item.payload.subject_ref)
        const payloadObj = normalizePayload(item.payload.payload)
        normalized.push({
          index: item.index,
          billingUserId,
          billingAccountId,
          semanticKind,
          occurredAt,
          eventType,
          subjectRef,
          payload: payloadObj,
          labels: item.labels,
        })
      } catch (err) {
        if (err instanceof BillingEventsError) {
          if (err.batchStatus === 'invalid' || err.batchStatus === 'failed') {
            failedCount += 1
          }
          results.push({
            index: item.index,
            status: err.batchStatus,
            error: { code: err.errorCode, message: err.message },
          })
          continue
        }
        throw err
      }
    }

    if (normalized.length === 0) {
      results.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      return { results, acceptedCount, failedCount }
    }

    const labelRows: LabelRow[] = []

    const runBatch = async (trx: Transaction<Database>) => {
      for (const item of normalized) {
        try {
          const requestHash = computeRequestHash({
            billing_account_id: item.billingAccountId,
            billing_user_id: item.billingUserId,
            semantic_kind: item.semanticKind,
            event_type: item.eventType,
            occurred_at: item.occurredAt,
            subject_ref: item.subjectRef,
            payload: item.payload,
          })

          const insertValues = {
            realm_id: realmId,
            billing_user_id: item.billingUserId,
            billing_account_id: item.billingAccountId,
            semantic_kind: item.semanticKind,
            occurred_at: item.occurredAt,
            event_type: item.eventType,
            subject_ref: item.subjectRef,
            payload: item.payload,
            request_hash: requestHash,
          }

          const inserted = await trx
            .insertInto('billing_events')
            .values(insertValues)
            .onConflict((oc) => oc.columns(['billing_user_id', 'request_hash']).doNothing())
            .returning(['event_id', 'realm_id', 'billing_user_id', 'billing_account_id', 'semantic_kind', 'occurred_at', 'event_type', 'subject_ref', 'payload', 'request_hash', 'created_at'])
            .executeTakeFirst()

          const eventRow: BillingEventRow = inserted
            ? inserted
            : await trx
                .selectFrom('billing_events')
                .select(['event_id', 'realm_id', 'billing_user_id', 'billing_account_id', 'semantic_kind', 'occurred_at', 'event_type', 'subject_ref', 'payload', 'request_hash', 'created_at'])
                .where('billing_user_id', '=', item.billingUserId)
                .where('billing_account_id', '=', item.billingAccountId)
                .where('request_hash', '=', requestHash)
                .executeTakeFirstOrThrow(() =>
                  new BillingEventsError(500, 'SERVER.UNEXPECTED', 'failed to fetch billing event after insert'),
                )

          if (inserted && item.labels) {
            const rows = buildLabelRows(eventRow.event_id, item.labels)
            if (rows.length > 0) labelRows.push(...rows)
          }

          const status: BillingComponents['schemas']['BillingEventBatchItemResult']['status'] = inserted ? 'accepted' : 'duplicate'
          if (status === 'accepted') acceptedCount += 1
          results.push({ index: item.index, status, event_id: String(eventRow.event_id) })
        } catch (err) {
          if (err instanceof BillingEventsError) {
            if (err.batchStatus === 'invalid' || err.batchStatus === 'failed') {
              failedCount += 1
            }
            results.push({
              index: item.index,
              status: err.batchStatus,
              error: { code: err.errorCode, message: err.message },
            })
            continue
          }
          throw err
        }
      }

      if (labelRows.length > 0) {
        await trx
          .insertInto('billing_event_labels')
          .values(labelRows)
          .onConflict((oc) => oc.doNothing())
          .execute()
      }
    }

    await runInTransaction(db, runBatch)

    results.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    return { results, acceptedCount, failedCount }
  }
}

function normalizeBillingAccountId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new BillingEventsError(422, 'VALIDATION.INVALID_INPUT', 'billing_account_id is required', 'invalid')
  return id
}

function normalizeTimestamp(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.valueOf())) {
    throw new BillingEventsError(422, 'VALIDATION.INVALID_INPUT', 'occurred_at must be a valid ISO timestamp', 'invalid')
  }
  return date
}

function normalizeEventType(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) throw new BillingEventsError(422, 'VALIDATION.INVALID_INPUT', 'event_type is required', 'invalid')
  if (raw.length > 128) throw new BillingEventsError(422, 'VALIDATION.INVALID_INPUT', 'event_type is too long', 'invalid')
  return raw
}

function normalizeEventSemanticKind(value: unknown): 'activity' | 'outcome' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw !== 'activity' && raw !== 'outcome') {
    throw new BillingEventsError(422, 'VALIDATION.INVALID_INPUT', 'semantic_kind must be activity or outcome', 'invalid')
  }
  return raw
}

function normalizeOptionalSubjectRef(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  if (raw.length > 256) throw new BillingEventsError(422, 'VALIDATION.INVALID_INPUT', 'subject_ref is too long', 'invalid')
  return raw
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b))
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(String(value))
}

function computeRequestHash(input: {
  billing_user_id: string
  billing_account_id: string
  semantic_kind: 'activity' | 'outcome'
  event_type: string
  occurred_at: Date
  subject_ref: string | null
  payload: Record<string, unknown>
}): string {
  const canonical = stableStringify({
    billing_user_id: input.billing_user_id,
    billing_account_id: input.billing_account_id,
    semantic_kind: input.semantic_kind,
    event_type: input.event_type,
    occurred_at: input.occurred_at.toISOString(),
    subject_ref: input.subject_ref,
    payload: input.payload,
  })
  return crypto.createHash('sha256').update(canonical).digest('base64url')
}

type LabelRow = {
  event_id: string
  label_key: string
  value_text: string | null
  value_uuid: string | null
  value_bool: boolean | null
  value_number: string | null
}

function buildLabelRows(eventId: unknown, labels: BillingEventPayload['labels']): LabelRow[] {
  if (!labels) return []
  const eventIdStr = String(eventId)
  const rows: LabelRow[] = []
  for (const [key, raw] of Object.entries(labels)) {
    if (raw === undefined || raw === null) continue
    const base: LabelRow = { event_id: eventIdStr, label_key: key.toLowerCase(), value_text: null, value_uuid: null, value_bool: null, value_number: null }
    if (typeof raw === 'string') {
      base.value_text = raw
    } else if (typeof raw === 'boolean') {
      base.value_bool = raw
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      base.value_number = raw.toString()
    } else {
      continue
    }
    rows.push(base)
  }
  return rows
}

function mapRowToEnvelope(
  row: BillingEventRow,
  labels: BillingEventPayload['labels'] | undefined,
): BillingComponents['schemas']['BillingEvent'] {
  return {
    event_id: String(row.event_id),
    semantic_kind: row.semantic_kind,
    occurred_at: row.occurred_at.toISOString(),
    event_type: row.event_type,
    subject_ref: row.subject_ref ?? undefined,
    request_hash: row.request_hash,
    payload: row.payload as Record<string, unknown>,
    labels: labels ?? undefined,
    created_at: row.created_at.toISOString(),
  }
}
