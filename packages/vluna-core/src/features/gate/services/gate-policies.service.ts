import { HttpException, Injectable } from '@nestjs/common'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { setRlsSession } from '../../../db/index.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { Database } from '../../../types/database.js'
import { invalidateGateRuntimeCaches } from './quota.service.js'

type GatePolicy = {
  policy_id: string
  bundle_id: string
  bundle_key?: string
  name: string
  description?: string | null
  feature_code: string
  kind: 'rate' | 'quota'
  subject_scope: 'account' | 'user'
  unit: string
  window_sec: number
  limit_count?: string | null
  limit_minor?: string | null
  status: 'default' | 'assignable' | 'ceiling' | 'disabled'
  enforcement_mode: 'optimistic' | 'reserve'
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

type GatePolicyList = {
  items?: GatePolicy[]
  next_cursor?: string | null
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function clampLimit(value: number, fallback = 50, max = 200): number {
  if (!Number.isFinite(value)) return fallback
  if (value <= 0) return fallback
  return Math.min(Math.trunc(value), max)
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

function parseId(value: string, name: string): string {
  const trimmed = normalizeString(value)
  if (!trimmed || !UUID_RE.test(trimmed)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `invalid ${name}` }, 422)
  }
  return trimmed.toLowerCase()
}

function parseOptionalInteger(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be an integer` }, 422)
    }
    return String(Math.trunc(value))
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be an integer` }, 422)
    }
    if (!/^-?\d+$/.test(trimmed)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be an integer` }, 422)
    }
    return trimmed
  }
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be an integer` }, 422)
}

function parseWindowSec(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const n = typeof value === 'string' ? Number(value) : Number(value)
  if (!Number.isFinite(n)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'window_sec must be an integer' }, 422)
  }
  return Math.trunc(n)
}

function parsePolicyKind(value: unknown, name: string): GatePolicy['kind'] {
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be a string` }, 422)
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'rate' || normalized === 'quota') {
    return normalized
  }
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} is invalid` }, 422)
}

function parseSubjectScope(value: unknown, name: string): GatePolicy['subject_scope'] {
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be a string` }, 422)
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'account' || normalized === 'user') {
    return normalized
  }
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} is invalid` }, 422)
}

function parsePolicyStatus(value: unknown, name: string): GatePolicy['status'] {
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be a string` }, 422)
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'default' || normalized === 'assignable' || normalized === 'ceiling' || normalized === 'disabled') {
    return normalized
  }
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} is invalid` }, 422)
}

function parseEnforcementMode(value: unknown, name: string): GatePolicy['enforcement_mode'] {
  if (typeof value !== 'string') {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} must be a string` }, 422)
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'optimistic' || normalized === 'reserve') {
    return normalized
  }
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${name} is invalid` }, 422)
}

function validatePolicyShape(params: {
  kind: GatePolicy['kind']
  unit: string
  window_sec: number
  limit_count?: string | null
  limit_minor?: string | null
}): void {
  const { kind, window_sec, limit_count, limit_minor } = params
  if (kind === 'quota') {
    if (!limit_minor || limit_count !== null) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'quota policies require limit_minor and no limit_count' }, 422)
    }
    if (window_sec <= 0) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'quota policies require window_sec > 0' }, 422)
    }
  } else if (kind === 'rate') {
    if (!limit_count || limit_minor !== null) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'rate policies require limit_count and no limit_minor' }, 422)
    }
    if (window_sec < 0) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'rate policies require window_sec >= 0' }, 422)
    }
  }
}

@Injectable()
export class GatePoliciesService {
  async listPolicies(req: AppRequest, query: Record<string, unknown>): Promise<GatePolicyList> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const limit = clampLimit(Number(query?.limit ?? 50))
    const cursor = typeof query?.cursor === 'string' ? query.cursor.trim() : ''
    const bundleId = normalizeString(query?.bundle_id)
    const bundleKey = normalizeString(query?.bundle_key)
    const featureCode = normalizeString(query?.feature_code)
    const kind = normalizeString(query?.kind)
    const subjectScope = normalizeString(query?.subject_scope)
    const status = normalizeString(query?.status)

    let builder = trx
      .selectFrom('gate_policies as p')
      .innerJoin('gate_policy_bundles as b', 'b.bundle_id', 'p.bundle_id')
      .select([
        'p.policy_id as policy_id',
        'p.bundle_id as bundle_id',
        'b.bundle_key as bundle_key',
        'p.name as name',
        'p.description as description',
        'p.feature_code as feature_code',
        'p.kind as kind',
        'p.subject_scope as subject_scope',
        'p.unit as unit',
        'p.window_sec as window_sec',
        'p.limit_count as limit_count',
        'p.limit_minor as limit_minor',
        'p.status as status',
        'p.enforcement_mode as enforcement_mode',
        'p.metadata as metadata',
        'p.created_at as created_at',
        'p.updated_at as updated_at',
      ])
      .where('p.realm_id', '=', realmId)
      .orderBy('p.policy_id', 'asc')

    if (bundleId) {
      builder = builder.where('p.bundle_id', '=', bundleId)
    }
    if (bundleKey) {
      builder = builder.where('b.bundle_key', '=', bundleKey)
    }
    if (featureCode) {
      builder = builder.where('p.feature_code', '=', featureCode)
    }
    if (kind) {
      builder = builder.where('p.kind', '=', parsePolicyKind(kind, 'kind'))
    }
    if (subjectScope) {
      builder = builder.where('p.subject_scope', '=', parseSubjectScope(subjectScope, 'subject_scope'))
    }
    if (status) {
      builder = builder.where('p.status', '=', parsePolicyStatus(status, 'status'))
    }
    if (cursor) {
      builder = builder.where('p.policy_id', '>', parseId(cursor, 'cursor'))
    }

    const rows = await builder.limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => ({
      policy_id: String(row.policy_id),
      bundle_id: String(row.bundle_id),
      bundle_key: row.bundle_key ? String(row.bundle_key) : undefined,
      name: String(row.name),
      description: row.description ?? null,
      feature_code: String(row.feature_code),
      kind: row.kind as GatePolicy['kind'],
      subject_scope: row.subject_scope as GatePolicy['subject_scope'],
      unit: String(row.unit),
      window_sec: Number(row.window_sec),
      limit_count: row.limit_count === null ? null : String(row.limit_count),
      limit_minor: row.limit_minor === null ? null : String(row.limit_minor),
      status: row.status as GatePolicy['status'],
      enforcement_mode: row.enforcement_mode as GatePolicy['enforcement_mode'],
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies GatePolicy))

    const nextCursor = hasMore ? items[items.length - 1]?.policy_id ?? null : null
    return { items, next_cursor: nextCursor } satisfies GatePolicyList
  }

  async listPoliciesForBundle(
    req: AppRequest,
    bundleId: string,
    query: Record<string, unknown>,
  ): Promise<GatePolicyList> {
    return this.listPolicies(req, { ...query, bundle_id: bundleId })
  }

  async getPolicy(req: AppRequest, policyId: string): Promise<GatePolicy> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(policyId, 'policy_id')

    const row = await trx
      .selectFrom('gate_policies as p')
      .innerJoin('gate_policy_bundles as b', 'b.bundle_id', 'p.bundle_id')
      .select([
        'p.policy_id as policy_id',
        'p.bundle_id as bundle_id',
        'b.bundle_key as bundle_key',
        'p.name as name',
        'p.description as description',
        'p.feature_code as feature_code',
        'p.kind as kind',
        'p.subject_scope as subject_scope',
        'p.unit as unit',
        'p.window_sec as window_sec',
        'p.limit_count as limit_count',
        'p.limit_minor as limit_minor',
        'p.status as status',
        'p.enforcement_mode as enforcement_mode',
        'p.metadata as metadata',
        'p.created_at as created_at',
        'p.updated_at as updated_at',
      ])
      .where('p.realm_id', '=', realmId)
      .where('p.policy_id', '=', id)
      .executeTakeFirst()

    if (!row) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'policy not found' }, 404)
    }

    return {
      policy_id: String(row.policy_id),
      bundle_id: String(row.bundle_id),
      bundle_key: row.bundle_key ? String(row.bundle_key) : undefined,
      name: String(row.name),
      description: row.description ?? null,
      feature_code: String(row.feature_code),
      kind: row.kind as GatePolicy['kind'],
      subject_scope: row.subject_scope as GatePolicy['subject_scope'],
      unit: String(row.unit),
      window_sec: Number(row.window_sec),
      limit_count: row.limit_count === null ? null : String(row.limit_count),
      limit_minor: row.limit_minor === null ? null : String(row.limit_minor),
      status: row.status as GatePolicy['status'],
      enforcement_mode: row.enforcement_mode as GatePolicy['enforcement_mode'],
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    } satisfies GatePolicy
  }

  async createPolicy(req: AppRequest, body: Record<string, unknown>): Promise<{ policy: GatePolicy }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)

    const name = normalizeString(body?.name)
    if (!name) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'name is required' }, 422)
    }
    const description = body?.description === undefined ? null : (body.description as string | null)
    const featureCode = normalizeString(body?.feature_code)
    if (!featureCode) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'feature_code is required' }, 422)
    }
    const kind = parsePolicyKind(body?.kind, 'kind')
    if (!kind) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'kind is required' }, 422)
    }
    if (body?.subject_scope === undefined) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'subject_scope is required' }, 422)
    }
    const subjectScope = parseSubjectScope(body?.subject_scope, 'subject_scope')
    const unit = normalizeString(body?.unit)
    if (!unit) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'unit is required' }, 422)
    }
    const windowSec = parseWindowSec(body?.window_sec)
    if (windowSec === undefined) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'window_sec is required' }, 422)
    }
    const limitCount = parseOptionalInteger(body?.limit_count, 'limit_count')
    const limitMinor = parseOptionalInteger(body?.limit_minor, 'limit_minor')
    const status = body?.status === undefined ? 'assignable' : parsePolicyStatus(body?.status, 'status')
    const enforcementMode = body?.enforcement_mode === undefined
      ? 'optimistic'
      : parseEnforcementMode(body?.enforcement_mode, 'enforcement_mode')
    const metadata = normalizeMetadata(body?.metadata)

    const bundleId = normalizeString(body?.bundle_id)
    const bundleKey = normalizeString(body?.bundle_key)
    if (!bundleId && !bundleKey) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'bundle_id or bundle_key is required' }, 422)
    }

    validatePolicyShape({
      kind,
      unit,
      window_sec: windowSec,
      limit_count: limitCount ?? null,
      limit_minor: limitMinor ?? null,
    })

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const resolvedBundleId = await this.resolveBundleId(trx, realmId, bundleId, bundleKey)

    const row = await trx
      .insertInto('gate_policies')
      .values({
        realm_id: realmId,
        bundle_id: resolvedBundleId,
        name,
        description: description ?? undefined,
        feature_code: featureCode,
        kind,
        subject_scope: subjectScope,
        unit,
        window_sec: windowSec,
        limit_count: limitCount ?? null,
        limit_minor: limitMinor ?? null,
        status: status as GatePolicy['status'],
        enforcement_mode: enforcementMode as GatePolicy['enforcement_mode'],
        metadata,
      })
      .returning(['policy_id'])
      .executeTakeFirstOrThrow()

    invalidateGateRuntimeCaches()
    const policy = await this.getPolicy(req, String(row.policy_id))
    return { policy }
  }

  async updatePolicy(req: AppRequest, policyId: string, body: Record<string, unknown>): Promise<GatePolicy> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(policyId, 'policy_id')

    const existing = await trx
      .selectFrom('gate_policies')
      .select([
        'policy_id',
        'bundle_id',
        'name',
        'description',
        'feature_code',
        'kind',
        'subject_scope',
        'unit',
        'window_sec',
        'limit_count',
        'limit_minor',
        'status',
        'enforcement_mode',
        'metadata',
      ])
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'policy not found' }, 404)
    }

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const name = body?.name === undefined ? String(existing.name) : normalizeString(body?.name)
    if (!name) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'name is required' }, 422)
    }
    const description = body?.description === undefined ? (existing.description ?? null) : (body.description as string | null)
    const featureCode = body?.feature_code === undefined ? String(existing.feature_code) : normalizeString(body?.feature_code)
    const kind = body?.kind === undefined ? (existing.kind as GatePolicy['kind']) : parsePolicyKind(body?.kind, 'kind')
    const subjectScope = body?.subject_scope === undefined
      ? (existing.subject_scope as GatePolicy['subject_scope'])
      : parseSubjectScope(body?.subject_scope, 'subject_scope')
    const unit = body?.unit === undefined ? String(existing.unit) : normalizeString(body?.unit)
    const windowSec = body?.window_sec === undefined ? Number(existing.window_sec) : (parseWindowSec(body?.window_sec) ?? Number(existing.window_sec))
    const limitCount = body?.limit_count === undefined ? (existing.limit_count === null ? null : String(existing.limit_count)) : parseOptionalInteger(body?.limit_count, 'limit_count')
    const limitMinor = body?.limit_minor === undefined ? (existing.limit_minor === null ? null : String(existing.limit_minor)) : parseOptionalInteger(body?.limit_minor, 'limit_minor')
    const status = body?.status === undefined
      ? (existing.status as GatePolicy['status'])
      : parsePolicyStatus(body?.status, 'status')
    const enforcementMode = body?.enforcement_mode === undefined
      ? (existing.enforcement_mode as GatePolicy['enforcement_mode'])
      : parseEnforcementMode(body?.enforcement_mode, 'enforcement_mode')
    const metadata = body?.metadata === undefined ? (existing.metadata ?? {}) : normalizeMetadata(body?.metadata)

    validatePolicyShape({
      kind,
      unit,
      window_sec: windowSec,
      limit_count: limitCount ?? null,
      limit_minor: limitMinor ?? null,
    })

    await trx
      .updateTable('gate_policies')
      .set({
        name,
        description,
        feature_code: featureCode,
        kind,
        subject_scope: subjectScope,
        unit,
        window_sec: windowSec,
        limit_count: limitCount ?? null,
        limit_minor: limitMinor ?? null,
        status: status as GatePolicy['status'],
        enforcement_mode: enforcementMode as GatePolicy['enforcement_mode'],
        metadata,
        updated_at: sql`now()`,
      })
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .executeTakeFirst()

    invalidateGateRuntimeCaches()
    return this.getPolicy(req, id)
  }

  async deletePolicy(req: AppRequest, policyId: string): Promise<{ deleted: boolean }> {
    const trx = this.ensureDb(req)
    const realmId = this.ensureRealmId(req)
    const id = parseId(policyId, 'policy_id')

    await setRlsSession(trx, { realmId, isRealmAdmin: true })

    const existing = await trx
      .selectFrom('gate_policies')
      .select(['policy_id'])
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .executeTakeFirst()

    if (!existing) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'policy not found' }, 404)
    }

    await trx
      .deleteFrom('gate_policies')
      .where('realm_id', '=', realmId)
      .where('policy_id', '=', id)
      .executeTakeFirst()

    invalidateGateRuntimeCaches()
    return { deleted: true }
  }

  private async resolveBundleId(
    trx: Kysely<Database>,
    realmId: string,
    bundleId: string,
    bundleKey: string,
  ): Promise<string> {
    if (bundleId) return bundleId
    const row = await trx
      .selectFrom('gate_policy_bundles')
      .select(['bundle_id'])
      .where('realm_id', '=', realmId)
      .where('bundle_key', '=', bundleKey)
      .executeTakeFirst()
    if (!row) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'bundle_key not found' }, 422)
    }
    return String(row.bundle_id)
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
