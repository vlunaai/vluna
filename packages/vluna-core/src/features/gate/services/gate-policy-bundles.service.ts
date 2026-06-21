import { HttpException, Injectable } from '@nestjs/common'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { setRlsSession } from '../../../db/index.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { Database } from '../../../types/database.js'
import { invalidateGateRuntimeCaches } from './quota.service.js'

type GatePolicyBundle = {
  bundle_id: string
  bundle_key: string
  name?: string | null
  status: 'active' | 'disabled'
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

type GatePolicyBundleList = {
  items?: GatePolicyBundle[]
  next_cursor?: string | null
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function clampLimit(value: number, fallback = 50, max = 200): number {
  if (!Number.isFinite(value)) return fallback
  if (value <= 0) return fallback
  return Math.min(Math.trunc(value), max)
}

function parseId(value: string, name: string): string {
  const trimmed = String(value ?? '').trim()
  if (!trimmed || !UUID_RE.test(trimmed)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `invalid ${name}` }, 422)
  }
  return trimmed.toLowerCase()
}

function normalizeString(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'metadata must be an object' }, 422)
  }
  return { ...(value as Record<string, unknown>) }
}

function parseStatus(value: unknown, name: string): 'active' | 'disabled' | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be a string` }, 422)
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'active' || normalized === 'disabled') return normalized
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be active or disabled` }, 422)
}

@Injectable()
export class GatePolicyBundlesService {
  async listPolicyBundles(req: AppRequest, query: Record<string, unknown>): Promise<GatePolicyBundleList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursor = typeof query?.cursor === 'string' ? query.cursor.trim() : ''

    const statusFilter = typeof query?.status === 'string' ? query.status.trim().toLowerCase() : ''

    let builder = trx
      .selectFrom('gate_policy_bundles')
      .select(['bundle_id', 'bundle_key', 'name', 'status', 'metadata', 'created_at', 'updated_at'])
      .where('realm_id', '=', realmId)
      .orderBy('bundle_id', 'asc')

    if (!statusFilter || statusFilter === 'active') {
      builder = builder.where('status', '=', 'active')
    } else if (statusFilter === 'disabled') {
      builder = builder.where('status', '=', 'disabled')
    }

    if (cursor) {
      builder = builder.where('bundle_id', '>', parseId(cursor, 'cursor'))
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => ({
      bundle_id: String(row.bundle_id),
      bundle_key: String(row.bundle_key),
      name: row.name ?? null,
      status: row.status === 'disabled' ? 'disabled' : 'active',
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies GatePolicyBundle))

    const nextCursor = hasMore ? items[items.length - 1]?.bundle_id ?? null : null
    return { items, next_cursor: nextCursor } satisfies GatePolicyBundleList
  }

  async getPolicyBundle(req: AppRequest, bundleId: string): Promise<GatePolicyBundle> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(bundleId, 'bundle_id')

    const row = await trx
      .selectFrom('gate_policy_bundles')
      .select(['bundle_id', 'bundle_key', 'name', 'status', 'metadata', 'created_at', 'updated_at'])
      .where('realm_id', '=', realmId)
      .where('bundle_id', '=', id)
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'bundle not found' }, 404)
    }

    return {
      bundle_id: String(row.bundle_id),
      bundle_key: String(row.bundle_key),
      name: row.name ?? null,
      status: row.status === 'disabled' ? 'disabled' : 'active',
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies GatePolicyBundle
  }

  async upsertPolicyBundle(
    req: AppRequest,
    body: {
      bundle_key?: string
      name?: string
      status?: 'active' | 'disabled'
      metadata?: Record<string, unknown>
    },
  ): Promise<{ created: boolean; bundle: GatePolicyBundle }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const bundleKey = normalizeString(body?.bundle_key)
    if (!bundleKey) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'bundle_key is required' }, 422)
    }

    const name = body?.name === undefined ? undefined : normalizeString(body?.name)
    const status = body?.status ? parseStatus(body.status, 'status') : undefined
    const metadataProvided = body?.metadata !== undefined
    const metadata = metadataProvided ? normalizeMetadata(body?.metadata) : undefined

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('gate_policy_bundles')
      .select(['bundle_id'])
      .where('realm_id', '=', realmId)
      .where('bundle_key', '=', bundleKey)
      .executeTakeFirst()

    const row = await trx
      .insertInto('gate_policy_bundles')
      .values({
        realm_id: realmId,
        bundle_key: bundleKey,
        name: name === undefined ? null : name,
        status: status ?? 'active',
        metadata: metadata ?? {},
      })
      .onConflict((oc) =>
        oc.columns(['realm_id', 'bundle_key']).doUpdateSet({
          name: name === undefined ? sql`gate_policy_bundles.name` : name,
          status: status ?? sql`gate_policy_bundles.status`,
          metadata: metadataProvided ? metadata : sql`gate_policy_bundles.metadata`,
          updated_at: sql`now()`,
        }),
      )
      .returning(['bundle_id', 'bundle_key', 'name', 'status', 'metadata', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow()

    invalidateGateRuntimeCaches()
    return {
      created: !existing,
      bundle: {
        bundle_id: String(row.bundle_id),
        bundle_key: String(row.bundle_key),
        name: row.name ?? null,
        status: row.status === 'disabled' ? 'disabled' : 'active',
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      } satisfies GatePolicyBundle,
    }
  }

  async updatePolicyBundle(
    req: AppRequest,
    bundleId: string,
    body: {
      name?: string
      status?: 'active' | 'disabled'
      metadata?: Record<string, unknown>
    },
  ): Promise<GatePolicyBundle> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(bundleId, 'bundle_id')

    const existing = await trx
      .selectFrom('gate_policy_bundles')
      .select(['bundle_id', 'name', 'status', 'metadata'])
      .where('realm_id', '=', realmId)
      .where('bundle_id', '=', id)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'bundle not found' }, 404)
    }

    const name = body?.name === undefined ? (existing.name ?? null) : normalizeString(body?.name)
    const status = body?.status === undefined ? (existing.status as 'active' | 'disabled') : parseStatus(body.status, 'status')
    const metadata = body?.metadata === undefined ? (existing.metadata ?? {}) : normalizeMetadata(body?.metadata)

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const row = await trx
      .updateTable('gate_policy_bundles')
      .set({
        name,
        status,
        metadata,
        updated_at: sql`now()`,
      })
      .where('realm_id', '=', realmId)
      .where('bundle_id', '=', id)
      .returning(['bundle_id', 'bundle_key', 'name', 'status', 'metadata', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow()

    invalidateGateRuntimeCaches()
    return {
      bundle_id: String(row.bundle_id),
      bundle_key: String(row.bundle_key),
      name: row.name ?? null,
      status: row.status === 'disabled' ? 'disabled' : 'active',
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies GatePolicyBundle
  }

  async deletePolicyBundle(req: AppRequest, bundleId: string): Promise<{ deleted: boolean }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(bundleId, 'bundle_id')

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('gate_policy_bundles')
      .select(['bundle_id'])
      .where('realm_id', '=', realmId)
      .where('bundle_id', '=', id)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'bundle not found' }, 404)
    }

    await trx
      .deleteFrom('gate_policy_bundles')
      .where('realm_id', '=', realmId)
      .where('bundle_id', '=', id)
      .executeTakeFirst()

    invalidateGateRuntimeCaches()
    return { deleted: true }
  }

  private ensureDb(req: AppRequest): Kysely<Database> {
    const db = req?.ctx?.db
    if (!db) {
      throw new HttpException({ code: 'SERVER.DB_UNAVAILABLE', message: 'database unavailable' }, 503)
    }
    return db
  }

  private ensureRealmId(req: AppRequest): string {
    const realmId = req?.ctx?.realmId
    if (!realmId) {
      throw new HttpException({ code: 'AUTH.MISSING_REALM', message: 'realm_id missing in context' }, 400)
    }
    return realmId
  }
}
