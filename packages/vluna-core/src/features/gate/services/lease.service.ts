import { Injectable, HttpException } from '@nestjs/common'
import { Kysely, sql } from 'kysely'
import type { Database } from '../../../types/database.js'
import { createLeaseToken, hashToken } from './gate.utils.js'
import type { LeaseRow } from './gate.types.js'

@Injectable()
export class LeaseService {
  async findIdempotentLease(
    trx: Kysely<Database>,
    params: { idempotencyKey: string; billingUserId: string },
  ): Promise<LeaseRow | undefined> {
    return await trx
      .selectFrom('gate_leases')
      .selectAll()
      .where('billing_user_id', '=', params.billingUserId)
      .where('idempotency_key', '=', params.idempotencyKey)
      .executeTakeFirst()
  }

  async createLease(
    trx: Kysely<Database>,
    params: {
      billingUserId: string
      billingAccountId: string
      policyId: string
      featureCode: string
      capMinor: number
      expiresAt: Date
      idempotencyKey: string
      requestHash: string
      budgetId: string | undefined
      reservationAmountXusd: number | string
      metadata: Record<string, unknown>
    },
  ): Promise<{ leaseId: string; leaseToken: string }> {
    const inserted = await trx
      .insertInto('gate_leases')
      .values({
        billing_user_id: params.billingUserId,
        billing_account_id: params.billingAccountId,
        policy_id: params.policyId,
        feature_code: params.featureCode,
        cap_minor: params.capMinor.toString(),
        state: 'active',
        expires_at: params.expiresAt,
        idempotency_key: params.idempotencyKey,
        request_hash: params.requestHash,
        budget_id: params.budgetId,
        reservation_minor: params.reservationAmountXusd.toString(),
        metadata: params.metadata,
      })
      .returning(['lease_id'])
      .executeTakeFirstOrThrow(() => new Error('failed to insert lease'))

    const leaseToken = createLeaseToken(String(inserted.lease_id))
    await trx
      .updateTable('gate_leases')
      .set({
        metadata: {
          ...params.metadata,
          lease_token: leaseToken,
          lease_token_hash: hashToken(leaseToken),
        },
      })
      .where('lease_id', '=', inserted.lease_id)
      .execute()

    return { leaseId: String(inserted.lease_id), leaseToken }
  }

  async findAndLockLeaseForCommit(
    trx: Kysely<Database>,
    params: { leaseId: string; billingUserId: string; billingAccountId: string },
  ): Promise<LeaseRow> {
    const leaseRow = await sql<LeaseRow>`
        SELECT lease_id, policy_id, feature_code, cap_minor, state, expires_at, reservation_minor, budget_id, metadata, request_hash
        FROM gate_leases
        WHERE lease_id = ${params.leaseId}
          AND billing_user_id = ${params.billingUserId}
          AND billing_account_id = ${params.billingAccountId}
        FOR UPDATE
      `
      .execute(trx)
      .then((res) => res.rows[0])

    if (!leaseRow) {
      throw new HttpException({
        code: 'RESOURCE.NOT_FOUND',
        message: 'lease not found'
      }, 422)
    }
    return leaseRow
  }

  async closeLease(
    trx: Kysely<Database>,
    params: {
      leaseId: string
      reservationRemainingXusd: bigint
      commitId: string | null
      finalMetadata: Record<string, unknown>
    },
  ): Promise<void> {
    await trx
      .updateTable('gate_leases')
      .set({
        state: 'closed',
        reservation_minor: params.reservationRemainingXusd.toString(),
        metadata: params.finalMetadata,
        updated_at: new Date(),
      })
      .where('lease_id', '=', params.leaseId)
      .execute()
  }

  async cancelLease(
    trx: Kysely<Database>,
    params: {
      leaseId: string
      billingUserId: string
      billingAccountId: string
      traceId: string
    },
  ): Promise<{ releasedCap: bigint; stateChanged: boolean }> {
    const row = await trx
      .selectFrom('gate_leases')
      .select(['lease_id', 'billing_account_id', 'state', 'reservation_minor', 'metadata'])
      .where('lease_id', '=', params.leaseId)
      .where('billing_user_id', '=', params.billingUserId)
      .where('billing_account_id', '=', params.billingAccountId)
      .forUpdate()
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'lease not found' }, 422)
    }

    if (row.state !== 'active') {
      return { releasedCap: 0n, stateChanged: false }
    }

    const releasedCap = BigInt(row.reservation_minor ?? '0')
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    const finalMetadata = {
      ...metadata,
      cancelled_at: new Date().toISOString(),
      cancel_trace_id: params.traceId,
    }

    await trx
      .updateTable('gate_leases')
      .set({
        state: 'canceled',
        reservation_minor: '0',
        metadata: finalMetadata,
        updated_at: new Date(),
      })
      .where('lease_id', '=', params.leaseId)
      .execute()

    return { releasedCap, stateChanged: true }
  }
}
