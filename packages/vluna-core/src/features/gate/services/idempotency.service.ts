import { Injectable, HttpException } from '@nestjs/common'
import { Kysely, sql } from 'kysely'
import type { Database } from '../../../types/database.js'

export type IdempotencyStatus = 'pending' | 'completed' | 'failed'

export type IdempotencyEnvelopeRow = {
  idempotency_id: string
  realm_id: string
  service: string
  operation: string
  scope_type: string
  scope_id: string | null
  billing_user_id: string | null
  billing_account_id: string | null
  key: string
  request_hash: string
  status: IdempotencyStatus
  request_snapshot: Record<string, unknown> | null
  response_snapshot: Record<string, unknown> | null
  result_ref: Record<string, unknown> | null
  metadata: Record<string, unknown>
  created_at: Date
  finalized_at: Date | null
}

type AcquireParams = {
  realmId: string
  billingUserId?: string | null
  billingAccountId?: string | null
  operation: 'authorize' | 'commit' | 'cancel' | string
  scopeType: 'lease' | 'account' | 'user' | 'none' | string
  scopeId?: string | null
  key: string
  requestHash: string
  metadata?: Record<string, unknown>
  requestSnapshot?: Record<string, unknown>
}

type FinalizeParams = {
  idempotencyId: string
  status: Exclude<IdempotencyStatus, 'pending'>
  responseSnapshot?: Record<string, unknown>
  resultRef?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

@Injectable()
export class GateIdempotencyService {
  async acquire(
    trx: Kysely<Database>,
    params: AcquireParams,
  ): Promise<{ envelope: IdempotencyEnvelopeRow; isNew: boolean }> {
    const scopeId = params.scopeId ?? null
    const billingUserId = params.billingUserId ?? null
    const billingAccountId = params.billingAccountId ?? null
    const metadata = params.metadata ?? {}
    const requestSnapshot = params.requestSnapshot ?? null

    const inserted = await trx
      .insertInto('idempotency_envelopes')
      .values({
        realm_id: params.realmId,
        service: 'gate',
        operation: params.operation,
        scope_type: params.scopeType,
        scope_id: scopeId,
        billing_user_id: billingUserId,
        billing_account_id: billingAccountId,
        key: params.key,
        request_hash: params.requestHash,
        status: 'pending',
        metadata,
        request_snapshot: requestSnapshot,
      })
      // Use generic DO NOTHING so Postgres applies the relevant partial unique index.
      .onConflict((oc) => oc.doNothing())
      .returningAll()
      .executeTakeFirst()

    if (inserted) {
      return { envelope: this.mapRow(inserted), isNew: true }
    }

    const existing = await sql<IdempotencyEnvelopeRow>`
      SELECT
        idempotency_id,
        realm_id,
        service,
        operation,
        scope_type,
        scope_id,
        billing_user_id,
        billing_account_id,
        key,
        request_hash,
        status,
        request_snapshot,
        response_snapshot,
        result_ref,
        metadata,
        created_at,
        finalized_at
      FROM idempotency_envelopes
      WHERE realm_id = ${params.realmId}
        AND service = 'gate'
        AND operation = ${params.operation}
        AND scope_type = ${params.scopeType}
        AND COALESCE(scope_id, '') = COALESCE(${scopeId}, '')
        AND COALESCE(billing_user_id::text, '') = COALESCE(${billingUserId}, '')
        AND COALESCE(billing_account_id::text, '') = COALESCE(${billingAccountId}, '')
        AND key = ${params.key}
      FOR UPDATE
    `
      .execute(trx)
      .then((res) => res.rows[0])

    if (!existing) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'idempotency envelope missing' }, 500)
    }

    if (existing.request_hash !== params.requestHash) {
      throw new HttpException({ code: 'WRITE.INVALID_PAYLOAD', message: 'idempotency conflict' }, 409)
    }

    // Merge metadata/request snapshot if provided and envelope still pending.
    if (existing.status === 'pending' && (params.metadata || params.requestSnapshot)) {
      const mergedMetadata = {
        ...(existing.metadata ?? {}),
        ...(params.metadata ?? {}),
      }
      await trx
        .updateTable('idempotency_envelopes')
        .set({
          metadata: mergedMetadata,
          request_snapshot: params.requestSnapshot ?? existing.request_snapshot,
        })
        .where('idempotency_id', '=', existing.idempotency_id)
        .execute()
      existing.metadata = mergedMetadata
      if (params.requestSnapshot) {
        existing.request_snapshot = params.requestSnapshot
      }
    }

    return { envelope: existing, isNew: false }
  }

  async finalize(
    trx: Kysely<Database>,
    params: FinalizeParams,
  ): Promise<void> {
    const update: Record<string, unknown> = {
      status: params.status,
      finalized_at: new Date(),
    }
    if (params.responseSnapshot) {
      update.response_snapshot = params.responseSnapshot
    }
    if (params.resultRef) {
      update.result_ref = params.resultRef
    }
    if (params.metadata) {
      update.metadata = params.metadata
    }

    await trx
      .updateTable('idempotency_envelopes')
      .set(update)
      .where('idempotency_id', '=', params.idempotencyId)
      .execute()
  }

  private mapRow(row: IdempotencyEnvelopeRow): IdempotencyEnvelopeRow {
    return {
      idempotency_id: row.idempotency_id,
      realm_id: row.realm_id,
      service: row.service,
      operation: row.operation,
      scope_type: row.scope_type,
      scope_id: row.scope_id ?? null,
      billing_account_id: row.billing_account_id ?? null,
      billing_user_id: row.billing_user_id ?? null,
      key: row.key,
      request_hash: row.request_hash,
      status: row.status,
      request_snapshot: row.request_snapshot ?? null,
      response_snapshot: row.response_snapshot ?? null,
      result_ref: row.result_ref ?? null,
      metadata: row.metadata ?? {},
      created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      finalized_at: row.finalized_at instanceof Date || row.finalized_at === null
        ? row.finalized_at
        : new Date(row.finalized_at),
    }
  }
}
