import { Injectable, HttpException } from '@nestjs/common'
import { Kysely, sql } from 'kysely'
import type { Database } from '../../../types/database.js'
import { DEFAULT_BUNDLE_KEY } from '../../../constants/billing.js'
import { FeatureService } from '../../billing/services/feature.service.js'
import { ensureFeatureFamilyForAutoRegistration } from '../../../services/feature-family.service.js'
import { envFlag } from '../../../platform/config.js'
import {
  CounterLookup,
  FeatureMeter,
  MeterSemanticKind,
  PolicyWindowView,
  QuotaWindow,
  QuotaWindowMetadataEntry,
  RateWindow,
  RateWindowMetadataEntry,
  UNLIMITED_QUOTA_MINOR,
  WILDCARD_FEATURE_CODE,
} from './gate.types.js'
import { parseMinor } from './gate.utils.js'
import { GateHint, rateLimitHint } from './gate.hints.js'

type RateCounterRow = {
  used_minor: string | number | null
}

type RateCounterIncrementResult =
  | { status: 'ok'; usedMinor: number; limitMinor: number }
  | { status: 'would_exceed'; limitMinor: number; currentUsedMinor: number }
  | { status: 'invalid_increment'; limitMinor: number }

type PolicyRowBase = {
  policy_id: string
  policy_name: string | null
  feature_code: string
  unit: string | null
  kind: string
  subject_scope: string | null
  window_sec: number | string
  limit_count: unknown
  limit_minor: unknown
  status: string
  policy_metadata: Record<string, unknown> | null
}

type PolicyStandaloneRow = PolicyRowBase

type GateBundleSource = {
  bundleId: string
  assignmentScope: 'account' | 'user' | 'default'
  allowedSubjectScopes: Array<'account' | 'user'>
}

type GateBundleCandidate = {
  bundleKey: string
  assignmentScope: 'account' | 'user'
  priority: number
  assignmentId: string
  windowEnd: Date | null
}

type CacheEntry<T> = {
  value: T
  expiresAtMs: number
}

const DEFAULT_GATE_RUNTIME_CACHE_TTL_MS = 5_000
const GATE_RUNTIME_CACHE_LIMIT = 2_000

const bundleSourceCache = new Map<string, CacheEntry<GateBundleSource[]>>()
const bundlePolicyCache = new Map<string, CacheEntry<PolicyStandaloneRow[]>>()
const featureCodeCache = new Map<string, CacheEntry<string[]>>()

export function invalidateGateRuntimeCaches(): void {
  bundleSourceCache.clear()
  bundlePolicyCache.clear()
  featureCodeCache.clear()
}

function gateRuntimeCacheTtlMs(): number {
  const raw = process.env.VLUNA_GATE_RUNTIME_CACHE_TTL_MS
  if (!raw) return DEFAULT_GATE_RUNTIME_CACHE_TTL_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_GATE_RUNTIME_CACHE_TTL_MS
  return Math.floor(parsed)
}

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string, nowMs = Date.now()): T | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAtMs <= nowMs) {
    cache.delete(key)
    return null
  }
  return entry.value
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, expiresAtMs: number): void {
  if (expiresAtMs <= Date.now()) return
  if (cache.size >= GATE_RUNTIME_CACHE_LIMIT) {
    cache.clear()
  }
  cache.set(key, { value, expiresAtMs })
}

function cloneBundleSources(sources: GateBundleSource[]): GateBundleSource[] {
  return sources.map((source) => ({
    ...source,
    allowedSubjectScopes: source.allowedSubjectScopes.slice(),
  }))
}

@Injectable()
export class QuotaService {
  async loadActivePolicyWindows(
    db: Kysely<Database>,
    realmId: string,
    billingAccountId: string,
    billingUserId: string,
    now: Date,
  ): Promise<PolicyWindowView[]> {
    const accountRow = await db
      .selectFrom('billing_accounts')
      .select(['billing_account_id', 'realm_id'])
      .where('billing_account_id', '=', billingAccountId)
      .where('realm_id', '=', realmId)
      .executeTakeFirst()

    if (!accountRow) {
      throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'billing account not found for bundle resolution' }, 404)
    }

    const sources = await this.resolveEffectiveGateBundleSources(db, {
      realmId,
      billingAccountId,
      billingUserId,
      now,
    })

    if (sources.length === 0) {
      return []
    }

    const rowsBySource = await Promise.all(
      sources.map(async (source) => {
        const rows = await this.loadBundlePolicyRows(db, realmId, source.bundleId)
        const allowed = new Set(source.allowedSubjectScopes)
        return rows.filter((row) => allowed.has(this.normalizeSubjectScope(row.subject_scope)))
      }),
    )

    const policyRows = rowsBySource.flat()

    if (policyRows.length === 0) {
      return []
    }

    const features = new Set<string>(await this.loadFeatureCodes(db, realmId))

    for (const row of policyRows as PolicyStandaloneRow[]) {
      const feature = row.feature_code
      if (feature && feature !== WILDCARD_FEATURE_CODE) {
        features.add(feature)
      }
    }

    const policiesByFeature = new Map<string, PolicyStandaloneRow[]>()
    for (const row of policyRows as PolicyStandaloneRow[]) {
      const feature = row.feature_code
      const arr = policiesByFeature.get(feature) ?? []
      arr.push(row)
      policiesByFeature.set(feature, arr)
    }

    if (features.size === 0 && policiesByFeature.has(WILDCARD_FEATURE_CODE)) {
      features.add(WILDCARD_FEATURE_CODE)
    }

    const windows: PolicyWindowView[] = []
    for (const feature of features) {
      const specific = policiesByFeature.get(feature) ?? []
      const wildcardCurrentBundle = policiesByFeature.get(WILDCARD_FEATURE_CODE) ?? []
      const wildcard = wildcardCurrentBundle

      const specificWindows = specific
        .map((row) => this.buildWindowFromPolicy(row, now, { billingAccountId, billingUserId }))
        .filter((window): window is PolicyWindowView => Boolean(window))
      const wildcardWindows = wildcard
        .map((row) =>
          this.buildWindowFromPolicy(row, now, {
            billingAccountId,
            billingUserId,
            featureOverride: feature,
            counterKeySuffix: `|feature:${feature}`,
          }),
        )
        .filter((window): window is PolicyWindowView => Boolean(window))

      if (specificWindows.length > 0 || wildcardWindows.length > 0) {
        windows.push(...specificWindows, ...wildcardWindows)
      }
    }

    return windows
  }

  private async resolveEffectiveGateBundleSources(
    db: Kysely<Database>,
    params: { realmId: string; billingAccountId: string; billingUserId: string; now: Date },
  ): Promise<GateBundleSource[]> {
    const ttlMs = gateRuntimeCacheTtlMs()
    const cacheBucket = ttlMs > 0 ? Math.floor(params.now.getTime() / ttlMs) : 0
    const cacheKey = [
      'bundle-sources',
      params.realmId,
      params.billingAccountId,
      params.billingUserId,
      cacheBucket,
    ].join(':')
    if (ttlMs > 0) {
      const cached = getCached(bundleSourceCache, cacheKey)
      if (cached) return cloneBundleSources(cached)
    }

    const rows = await db
      .selectFrom('billing_plan_assignments as bpa')
      .innerJoin('billing_plans as bpl', 'bpl.plan_id', 'bpa.plan_id')
      .select([
        'bpa.assignment_id as assignment_id',
        'bpa.assignment_scope as assignment_scope',
        'bpa.window_end as window_end',
        'bpl.priority as priority',
        sql<Record<string, unknown>>`bpl.metadata`.as('plan_metadata'),
      ])
      .where('bpa.billing_account_id', '=', params.billingAccountId)
      .where('bpa.status', '=', 'active')
      .where((eb) =>
        eb.and([
          eb('bpa.window_start', '<=', params.now),
          eb.or([eb('bpa.window_end', '>', params.now), eb('bpa.window_end', 'is', null)]),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb('bpa.assignment_scope', '=', 'account'),
          eb.and([eb('bpa.assignment_scope', '=', 'user'), eb('bpa.billing_user_id', '=', params.billingUserId)]),
        ]),
      )
      .where('bpl.realm_id', '=', params.realmId)
      .where('bpl.active', '=', true)
      .where('bpl.kind', 'in', ['base', 'addon'])
      .execute()

    const candidates: GateBundleCandidate[] = []
    for (const row of rows) {
      const planMetadata = (row.plan_metadata ?? {}) as Record<string, unknown>
      const bundleKey = typeof planMetadata.gate_bundle_key === 'string' ? planMetadata.gate_bundle_key.trim() : ''
      if (!bundleKey) continue
      candidates.push({
        bundleKey,
        assignmentScope: row.assignment_scope === 'account' ? 'account' : 'user',
        priority: Number(row.priority ?? 0),
        assignmentId: String(row.assignment_id ?? ''),
        windowEnd: (row.window_end as Date | null) ?? null,
      })
    }

    const bestAccount = this.pickBestBundleCandidate(candidates.filter((candidate) => candidate.assignmentScope === 'account'))
    const bestUser = this.pickBestBundleCandidate(candidates.filter((candidate) => candidate.assignmentScope === 'user'))
    const selected = [bestAccount, bestUser].filter((candidate): candidate is GateBundleCandidate => Boolean(candidate))

    if (selected.length === 0) {
      const defaultBundle = await db
        .selectFrom('gate_policy_bundles')
        .select(['bundle_id'])
        .where('realm_id', '=', params.realmId)
        .where('bundle_key', '=', DEFAULT_BUNDLE_KEY)
        .where('status', '=', 'active')
        .executeTakeFirst()
      if (!defaultBundle?.bundle_id) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'default bundle not configured for realm' }, 500)
      }
      const sources: GateBundleSource[] = [
        {
          bundleId: String(defaultBundle.bundle_id),
          assignmentScope: 'default',
          allowedSubjectScopes: ['account', 'user'],
        },
      ]
      this.cacheBundleSources(cacheKey, sources, params.now, ttlMs, [])
      return cloneBundleSources(sources)
    }

    const bundleKeys = Array.from(new Set(selected.map((candidate) => candidate.bundleKey)))
    const bundleRows = await db
      .selectFrom('gate_policy_bundles')
      .select(['bundle_id', 'bundle_key'])
      .where('realm_id', '=', params.realmId)
      .where('status', '=', 'active')
      .where('bundle_key', 'in', bundleKeys)
      .execute()
    const bundleIdByKey = new Map(bundleRows.map((row) => [String(row.bundle_key), String(row.bundle_id)]))

    const sources: GateBundleSource[] = []
    if (bestAccount) {
      const bundleId = bundleIdByKey.get(bestAccount.bundleKey)
      if (bundleId) {
        sources.push({
          bundleId,
          assignmentScope: 'account',
          allowedSubjectScopes: bestUser ? ['account'] : ['account', 'user'],
        })
      }
    }
    if (bestUser) {
      const bundleId = bundleIdByKey.get(bestUser.bundleKey)
      if (bundleId) {
        sources.push({
          bundleId,
          assignmentScope: 'user',
          allowedSubjectScopes: ['user'],
        })
      }
    }

    this.cacheBundleSources(cacheKey, sources, params.now, ttlMs, selected.map((candidate) => candidate.windowEnd))
    return cloneBundleSources(sources)
  }

  private async loadBundlePolicyRows(db: Kysely<Database>, realmId: string, bundleId: string): Promise<PolicyStandaloneRow[]> {
    const ttlMs = gateRuntimeCacheTtlMs()
    const cacheKey = ['bundle-policies', realmId, bundleId].join(':')
    if (ttlMs > 0) {
      const cached = getCached(bundlePolicyCache, cacheKey)
      if (cached) return cached
    }

    const rows = await db
      .selectFrom('gate_policies as p')
      .innerJoin('gate_policy_bundles as b', 'b.bundle_id', 'p.bundle_id')
      .select([
        'p.policy_id as policy_id',
        'p.name as policy_name',
        'p.feature_code as feature_code',
        'p.kind as kind',
        'p.subject_scope as subject_scope',
        'p.unit as unit',
        'p.window_sec as window_sec',
        'p.limit_count as limit_count',
        'p.limit_minor as limit_minor',
        'p.status as status',
        'p.metadata as policy_metadata',
      ])
      .where('p.realm_id', '=', realmId)
      .where('p.bundle_id', '=', bundleId)
      .where('p.status', '<>', 'disabled')
      .where('b.status', '=', 'active')
      .execute()

    if (ttlMs > 0) {
      setCached(bundlePolicyCache, cacheKey, rows as PolicyStandaloneRow[], Date.now() + ttlMs)
    }
    return rows as PolicyStandaloneRow[]
  }

  private async loadFeatureCodes(db: Kysely<Database>, realmId: string): Promise<string[]> {
    const ttlMs = gateRuntimeCacheTtlMs()
    const cacheKey = ['feature-codes', realmId].join(':')
    if (ttlMs > 0) {
      const cached = getCached(featureCodeCache, cacheKey)
      if (cached) return cached
    }

    const rows = await db
      .selectFrom('features')
      .select(['feature_code'])
      .where('realm_id', '=', realmId)
      .execute()
    const codes = rows
      .map((row) => row.feature_code)
      .filter((code): code is string => typeof code === 'string' && code.trim().length > 0)

    if (ttlMs > 0) {
      setCached(featureCodeCache, cacheKey, codes, Date.now() + ttlMs)
    }
    return codes
  }

  private cacheBundleSources(
    cacheKey: string,
    sources: GateBundleSource[],
    now: Date,
    ttlMs: number,
    assignmentBoundaries: Array<Date | null>,
  ): void {
    if (ttlMs <= 0) return
    let expiresAtMs = Date.now() + ttlMs
    const nowMs = now.getTime()
    for (const boundary of assignmentBoundaries) {
      if (!boundary) continue
      const boundaryMs = boundary.getTime()
      if (Number.isFinite(boundaryMs) && boundaryMs > nowMs) {
        expiresAtMs = Math.min(expiresAtMs, boundaryMs)
      }
    }
    setCached(bundleSourceCache, cacheKey, cloneBundleSources(sources), expiresAtMs)
  }

  private pickBestBundleCandidate(candidates: GateBundleCandidate[]): GateBundleCandidate | null {
    if (candidates.length === 0) return null
    return candidates
      .slice()
      .sort((a, b) => {
        const priorityDiff = b.priority - a.priority
        if (priorityDiff !== 0) return priorityDiff
        return b.assignmentId.localeCompare(a.assignmentId)
      })[0]
  }

  private normalizeSubjectScope(value: unknown): 'account' | 'user' {
    return value === 'account' ? 'account' : 'user'
  }

  async loadCounterLookup(
    db: Kysely<Database>,
    realmId: string,
    billingAccountId: string,
    billingUserId: string,
    windows: PolicyWindowView[],
  ): Promise<CounterLookup> {
    const lookup: CounterLookup = new Map()
    if (windows.length === 0) {
      return lookup
    }

    const rows = await db
      .selectFrom('gate_quota_counters as qc')
      .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'qc.billing_account_id')
      .select([
        'qc.feature_code as feature_code',
        'qc.subject_scope as subject_scope',
        'qc.subject_id as subject_id',
        'qc.key as key',
        'qc.window_start as window_start',
        'qc.window_end as window_end',
        'qc.used_minor as used_minor',
      ])
      .where('qc.billing_account_id', '=', billingAccountId)
      .where('ba.realm_id', '=', realmId)
      .where((eb) =>
        eb.or(
          windows.map((window) =>
            eb.and([
              eb('qc.subject_scope', '=', window.subjectScope),
              eb('qc.subject_id', '=', window.subjectId),
              eb('qc.feature_code', '=', window.featureCode),
              eb('qc.key', '=', window.counterKey),
              eb('qc.window_start', '=', window.windowStart),
              eb('qc.window_end', '=', window.windowEnd),
            ]),
          ),
        ),
      )
      .execute()

    for (const row of rows) {
      const used = parseMinor(row.used_minor) ?? 0
      const key = this.makeCounterStorageKey(
        row.subject_scope as 'account' | 'user',
        String(row.subject_id),
        row.feature_code,
        row.key ?? '',
        row.window_start,
        row.window_end,
      )
      lookup.set(key, used)
    }

    return lookup
  }

  async applyCounterDelta(
    trx: Kysely<Database>,
    params: {
      realmId: string
      billingUserId: string
      billingAccountId: string
      window: PolicyWindowView
      quantityMinor: number
    },
  ): Promise<void> {
    const limitStr = params.window.limitMinor.toString()
    const counterKey = params.window.counterKey ?? `policy:${params.window.policyName}`
    const billingUserId = params.window.subjectScope === 'user' ? params.billingUserId : null

    await trx
      .insertInto('gate_quota_counters')
      .values({
        subject_scope: params.window.subjectScope,
        subject_id: params.window.subjectId,
        billing_user_id: billingUserId,
        billing_account_id: params.billingAccountId,
        feature_code: params.window.featureCode,
        key: counterKey,
        window_start: params.window.windowStart,
        window_end: params.window.windowEnd,
        limit_minor: limitStr,
        used_minor: params.quantityMinor.toString(),
      })
      .onConflict((oc) =>
        oc
          .columns(['billing_account_id', 'subject_scope', 'subject_id', 'feature_code', 'key', 'window_start', 'window_end'])
          .doUpdateSet({
            used_minor: sql`gate_quota_counters.used_minor + ${params.quantityMinor}`,
            limit_minor: limitStr,
            updated_at: new Date(),
          }),
      )
      .execute()
  }

  async enforceRateWindows(
    trx: Kysely<Database>,
    params: { billingUserId: string; billingAccountId: string; windows: PolicyWindowView[]; increment: number; now: Date },
  ): Promise<{ hints: GateHint[] }> {
    const hints: GateHint[] = []
    if (params.increment <= 0 || params.windows.length === 0) {
      return { hints }
    }

    const ordered = params.windows
      .slice()
      .sort((a, b) => a.limitMinor - b.limitMinor || a.windowMs - b.windowMs || a.policyName.localeCompare(b.policyName))

    for (const window of ordered) {
      if (!window.counterKey) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'rate window missing counter key' }, 500)
      }
      const result = await this.incrementRateCounter(trx, {
        billingUserId: params.billingUserId,
        billingAccountId: params.billingAccountId,
        window,
        increment: params.increment,
        now: params.now,
      })
      if (result.status === 'invalid_increment') {
        throw new HttpException({
          code: 'LIMIT.RATE_INCREMENT_TOO_LARGE',
          message: 'requested increment exceeds the rate window capacity',
          meta: {
            limit_minor: result.limitMinor.toString(),
          },
        }, 400)
      }
      if (result.status === 'would_exceed') {
        throw new HttpException({
          code: 'LIMIT.RATE_EXCEEDED',
          message: 'rate limit exceeded',
          hints: [
            rateLimitHint(
              Math.max(0, Math.ceil((window.windowEnd.getTime() - params.now.getTime()) / 1000)),
              Math.max(0, result.limitMinor - result.currentUsedMinor),
              window.windowEnd
            ),
          ],
        }, 429)
      }

      if (result.usedMinor + 3 >= result.limitMinor) {
        const secondsRemaining = Math.max(0, Math.ceil((window.windowEnd.getTime() - params.now.getTime()) / 1000))
        hints.push(rateLimitHint(secondsRemaining, result.limitMinor - result.usedMinor, window.windowEnd))
      }
    }
    return { hints }
  }

  async ensureEntitlement(
    trx: Kysely<Database>,
    params: {
      realmId: string
      billingAccountId: string
      billingUserId: string
      featureCode: string
      now: Date
      feature: {
        feature_id: string
        feature_family_id: string
        feature_family?: { entitlement_required: boolean }
        entitlement_required: boolean | null
      }
    },
  ): Promise<EntRow | null> {
    const feature = params.feature
    const effectiveRequired =
      feature.entitlement_required === null || feature.entitlement_required === undefined
        ? Boolean(feature.feature_family?.entitlement_required)
        : Boolean(feature.entitlement_required)

    if (!effectiveRequired) return null

    const rows = await trx
      .selectFrom('billing_plan_assignments as bpa')
      .innerJoin('billing_plans as bpl', 'bpl.plan_id', 'bpa.plan_id')
      .innerJoin('billing_plan_entitlements as bpe', 'bpe.plan_id', 'bpl.plan_id')
      .select([
        'bpe.effect',
        'bpl.priority',
        'bpe.feature_id',
        'bpe.feature_family_id',
        'bpa.assignment_id as assignment_id',
        'bpl.plan_id as plan_id',
        'bpl.plan_code as plan_code',
        'bpl.kind as plan_kind',
      ])
      .where('bpa.billing_account_id', '=', params.billingAccountId)
      .where((eb) =>
        eb.or([
          eb('bpa.assignment_scope', '=', 'account'),
          eb.and([eb('bpa.assignment_scope', '=', 'user'), eb('bpa.billing_user_id', '=', params.billingUserId)]),
        ]),
      )
      .where('bpa.status', '=', 'active')
      .where((eb) =>
        eb.and([
          eb('bpa.window_start', '<=', params.now),
          eb.or([eb('bpa.window_end', '>', params.now), eb('bpa.window_end', 'is', null)]),
        ]),
      )
      .where('bpl.realm_id', '=', params.realmId)
      .where('bpl.active', '=', true)
      .where((eb) =>
        eb.or([
          eb('bpe.feature_id', '=', feature.feature_id),
          eb('bpe.feature_family_id', '=', feature.feature_family_id),
          eb.and([eb('bpe.feature_id', 'is', null), eb('bpe.feature_family_id', 'is', null)]),
        ]),
      )
      .execute()

    const decision = pickEntitlementWithWildcard(rows, feature.feature_id, feature.feature_family_id)

    if (!decision) {
      throw new HttpException(
        {
          code: 'ENTITLEMENT.REQUIRED',
          message: 'entitlement required',
        },
        403,
      )
    }
    if (decision.effect === 'deny') {
      throw new HttpException(
        {
          code: 'ENTITLEMENT.DENIED',
          message: 'entitlement denied',
        },
        403,
      )
    }
    return decision
  }

  async loadEntitledFeatures(
    trx: Kysely<Database>,
    params: {
      realmId: string
      billingAccountId: string
      billingUserId: string
      at: Date
      featureCodes?: string[]
      featureFamilyCodes?: string[]
    },
  ): Promise<{
    entitledFeatureCodes: Set<string>
    entitledFeatureIdByCode: Map<string, string>
    featureFamilyCodeByFeatureCode: Map<string, string>
  }> {
    const requestedCodes = params.featureCodes?.filter(Boolean) ?? []
    const applyCodeFilter = requestedCodes.length > 0
    const requestedFeatureFamilyCodes = params.featureFamilyCodes?.filter(Boolean) ?? []
    const applyFeatureFamilyFilter = requestedFeatureFamilyCodes.length > 0

    const features = await trx
      .selectFrom('features as f')
      .innerJoin('feature_families as c', 'c.feature_family_id', 'f.feature_family_id')
      .select([
        'f.feature_id',
        'f.feature_code',
        'f.feature_family_id',
        'c.feature_family_code',
        'f.entitlement_required',
        'c.entitlement_required as cap_entitlement_required',
      ])
      .where('f.realm_id', '=', params.realmId)
      .where((eb) =>
        applyCodeFilter
          ? eb('f.feature_code', 'in', requestedCodes)
          : eb('f.feature_code', '<>', ''),
      )
      .where((eb) =>
        applyFeatureFamilyFilter
          ? eb('c.feature_family_code', 'in', requestedFeatureFamilyCodes)
          : eb('c.feature_family_code', '<>', ''),
      )
      .execute()

    if (features.length === 0) {
      return {
        entitledFeatureCodes: new Set<string>(),
        entitledFeatureIdByCode: new Map<string, string>(),
        featureFamilyCodeByFeatureCode: new Map<string, string>(),
      }
    }

    const featureIds = features.map((feature) => feature.feature_id)
    const featureFamilyIds = Array.from(
      new Set(features.map((feature) => feature.feature_family_id).filter(Boolean)),
    ) as string[]

    const entRows = await trx
      .selectFrom('billing_plan_assignments as bpa')
      .innerJoin('billing_plans as bpl', 'bpl.plan_id', 'bpa.plan_id')
      .innerJoin('billing_plan_entitlements as bpe', 'bpe.plan_id', 'bpl.plan_id')
      .select([
        'bpe.feature_id',
        'bpe.feature_family_id',
        'bpe.effect',
        'bpl.priority',
        'bpa.assignment_id as assignment_id',
        'bpl.plan_id as plan_id',
        'bpl.plan_code as plan_code',
        'bpl.kind as plan_kind',
      ])
      .where('bpa.billing_account_id', '=', params.billingAccountId)
      .where((eb) =>
        eb.or([
          eb('bpa.assignment_scope', '=', 'account'),
          eb.and([eb('bpa.assignment_scope', '=', 'user'), eb('bpa.billing_user_id', '=', params.billingUserId)]),
        ]),
      )
      .where('bpa.status', '=', 'active')
      .where((eb) =>
        eb.and([
          eb('bpa.window_start', '<=', params.at),
          eb.or([eb('bpa.window_end', '>', params.at), eb('bpa.window_end', 'is', null)]),
        ]),
      )
      .where('bpl.realm_id', '=', params.realmId)
      .where('bpl.active', '=', true)
      .where((eb) =>
        eb.or([
          featureIds.length > 0 ? eb('bpe.feature_id', 'in', featureIds) : eb('bpe.feature_id', '=', null),
          featureFamilyIds.length > 0 ? eb('bpe.feature_family_id', 'in', featureFamilyIds) : eb('bpe.feature_family_id', '=', null),
          eb.and([eb('bpe.feature_id', 'is', null), eb('bpe.feature_family_id', 'is', null)]),
        ]),
      )
      .execute()

    const entitledFeatureCodes = new Set<string>()
    const entitledFeatureIdByCode = new Map<string, string>()
    const featureFamilyCodeByFeatureCode = new Map<string, string>()

    for (const feature of features) {
      const capRequired = Boolean(feature.cap_entitlement_required)
      const entitlementRequired =
        feature.entitlement_required === null || feature.entitlement_required === undefined
          ? capRequired
          : Boolean(feature.entitlement_required)

      const matchingRows = entRows.filter(
        (row) =>
          (row.feature_id && String(row.feature_id) === feature.feature_id) ||
          (row.feature_family_id && String(row.feature_family_id) === feature.feature_family_id) ||
          (!row.feature_id && !row.feature_family_id),
      )

      let allowed = false
      if (!entitlementRequired) {
        allowed = true
      } else {
        const decision = pickEntitlementWithWildcard(matchingRows, feature.feature_id, feature.feature_family_id)
        allowed = decision?.effect === 'allow'
      }

      if (!allowed) continue
      const code = String(feature.feature_code || '').trim()
      const id = String(feature.feature_id || '').trim()
      if (!code || !id) continue
      entitledFeatureCodes.add(code)
      entitledFeatureIdByCode.set(code, id)
      if (feature.feature_family_code) {
        featureFamilyCodeByFeatureCode.set(code, String(feature.feature_family_code))
      }
    }

    return { entitledFeatureCodes, entitledFeatureIdByCode, featureFamilyCodeByFeatureCode }
  }

  async loadFeatureMeters(
    trx: Kysely<Database>,
    realmId: string,
    featureCode: string,
  ): Promise<FeatureMeter[]> {
    const rows = await trx
      .selectFrom('feature_meters as fm')
      .innerJoin('features as f', 'f.feature_id', 'fm.feature_id')
      .innerJoin('meters as um', 'um.meter_id', 'fm.meter_id')
      .select((eb) => [
        eb.ref('um.meter_code').as('meter_code'),
        eb.ref('um.semantic_kind').as('semantic_kind'),
        eb.ref('fm.metadata').as('metadata'),
        sql<Record<string, unknown>>`um.metadata`.as('meter_metadata'),
        eb.ref('fm.is_primary').as('is_primary'),
      ])
      .where('f.realm_id', '=', realmId)
      .where('f.feature_code', '=', featureCode)
      .orderBy('fm.is_primary', 'desc')
      .orderBy('um.meter_code', 'asc')
      .execute()

    return rows.map((row) => ({
      meter_code: row.meter_code,
      semantic_kind: row.semantic_kind as MeterSemanticKind,
      metadata: (row.metadata ?? null) as Record<string, unknown> | null,
      usageMetadata: (row.meter_metadata ?? null) as Record<string, unknown> | null,
      is_primary: Boolean(row.is_primary),
    }))
  }

  async loadFeatureWithMeters(
    trx: Kysely<Database>,
    params: {
      realmId: string
      featureCode: string
      featureFamilyCode?: string | null
      autoRegistryMeterSemanticKind?: MeterSemanticKind
    },
  ): Promise<{
    feature: {
      feature_id: string
      feature_family_id: string
      feature_family_code: string | null
      feature_family?: { entitlement_required: boolean }
      entitlement_required: boolean | null
      active: boolean
    }
    meters: FeatureMeter[]
  }> {
    let rows = await trx
      .selectFrom('features as f')
      .leftJoin('feature_meters as fm', 'fm.feature_id', 'f.feature_id')
      .leftJoin('meters as m', 'm.meter_id', 'fm.meter_id')
      .leftJoin('feature_families as c', 'c.feature_family_id', 'f.feature_family_id')
      .select((eb) => [
        eb.ref('f.feature_id').as('feature_id'),
        eb.ref('f.feature_family_id').as('feature_family_id'),
        eb.ref('c.feature_family_code').as('feature_family_code'),
        eb.ref('c.entitlement_required').as('cap_entitlement_required'),
        eb.ref('f.entitlement_required').as('entitlement_required'),
        eb.ref('f.active').as('active'),
        eb.ref('m.meter_code').as('meter_code'),
        eb.ref('m.semantic_kind').as('semantic_kind'),
        eb.ref('fm.is_primary').as('is_primary'),
        eb.ref('fm.metadata').as('metadata'),
        sql<Record<string, unknown>>`m.metadata`.as('meter_metadata'),
      ])
      .where('f.realm_id', '=', params.realmId)
      .where('f.feature_code', '=', params.featureCode)
      .execute()

    const allowAutoCreate = envFlag('VLUNA_GATE_ENABLE_AUTO_REGISTRY')
    if (rows.length === 0) {
      if (!allowAutoCreate) {
        throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'feature not found' }, 422)
      }
      // Auto-register feature + primary meter.
      const featureFamilyId = await ensureFeatureFamilyForAutoRegistration(
        trx,
        params.realmId,
        params.featureFamilyCode ?? null,
      )
      await FeatureService.upsertFeature(trx, {
        realmId: params.realmId,
        feature: {
          feature_family_id: featureFamilyId,
          feature_code: params.featureCode,
          name: params.featureCode,
          description: 'Auto-registered feature',
          active: true,
          entitlement_required: false,
          default_budget_strategy: 'auto',
          metadata: { auto: true, source: 'authorize' },
          meters: [
            {
              meter_code: params.featureCode,
              semantic_kind: params.autoRegistryMeterSemanticKind ?? 'activity',
              unit: 'unit',
              scale: 0,
              rounding: 'round',
              active: true,
              metadata: { auto: true, source: 'authorize' },
            },
          ],
        },
      })
      invalidateGateRuntimeCaches()
      rows = await trx
        .selectFrom('features as f')
        .leftJoin('feature_meters as fm', 'fm.feature_id', 'f.feature_id')
        .leftJoin('meters as m', 'm.meter_id', 'fm.meter_id')
        .leftJoin('feature_families as c', 'c.feature_family_id', 'f.feature_family_id')
        .select((eb) => [
          eb.ref('f.feature_id').as('feature_id'),
          eb.ref('f.feature_family_id').as('feature_family_id'),
          eb.ref('c.feature_family_code').as('feature_family_code'),
          eb.ref('c.entitlement_required').as('cap_entitlement_required'),
          eb.ref('f.entitlement_required').as('entitlement_required'),
          eb.ref('f.active').as('active'),
          eb.ref('m.meter_code').as('meter_code'),
          eb.ref('m.semantic_kind').as('semantic_kind'),
          eb.ref('fm.is_primary').as('is_primary'),
          eb.ref('fm.metadata').as('metadata'),
          sql<Record<string, unknown>>`m.metadata`.as('meter_metadata'),
        ])
        .where('f.realm_id', '=', params.realmId)
        .where('f.feature_code', '=', params.featureCode)
        .execute()
    }

    const meters: FeatureMeter[] = rows
      .filter((row) => row.meter_code !== null)
      .map((row) => ({
        meter_code: String(row.meter_code),
        semantic_kind: (row.semantic_kind ?? 'activity') as MeterSemanticKind,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        usageMetadata: (row.meter_metadata ?? {}) as Record<string, unknown>,
        is_primary: Boolean(row.is_primary),
      }))

    const feature = {
      feature_id: String(rows[0].feature_id),
      feature_family_id: String(rows[0].feature_family_id),
      feature_family_code: rows[0].feature_family_code ? String(rows[0].feature_family_code) : null,
      feature_family: { entitlement_required: Boolean(rows[0].cap_entitlement_required) },
      entitlement_required:
        rows[0].entitlement_required === null || rows[0].entitlement_required === undefined
          ? null
          : Boolean(rows[0].entitlement_required),
      active: Boolean(rows[0].active),
    }

    return { feature, meters }
  }

  async loadFeatureMetersMapByFeatureIds(
    trx: Kysely<Database>,
    params: { featureIdByCode: Map<string, string>; meterCodes?: string[] },
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>()
    const featureIdByCodeEntries = Array.from(params.featureIdByCode.entries())
    if (featureIdByCodeEntries.length === 0) {
      return result
    }

    const codeByFeatureId = new Map<string, string>()
    for (const [code, featureId] of featureIdByCodeEntries) {
      const normalizedCode = String(code || '').trim()
      const normalizedId = String(featureId || '').trim()
      if (!normalizedCode || !normalizedId) continue
      result.set(normalizedCode, [])
      codeByFeatureId.set(normalizedId, normalizedCode)
    }

    const featureIds = Array.from(codeByFeatureId.keys())
    if (featureIds.length === 0) {
      return result
    }

    const meterCodes = params.meterCodes?.filter(Boolean) ?? []
    const applyMeterFilter = meterCodes.length > 0

    const rows = await trx
      .selectFrom('feature_meters as fm')
      .innerJoin('meters as um', 'um.meter_id', 'fm.meter_id')
      .select([
        'fm.feature_id as feature_id',
        'um.meter_code as meter_code',
      ])
      .where('fm.feature_id', 'in', featureIds)
      .where((eb) =>
        applyMeterFilter
          ? eb('um.meter_code', 'in', meterCodes)
          : eb('um.meter_code', '<>', ''),
      )
      .execute()

    for (const row of rows) {
      const featureId = String(row.feature_id || '').trim()
      const meterCode = String(row.meter_code || '').trim()
      if (!featureId || !meterCode) continue
      const featureCode = codeByFeatureId.get(featureId)
      if (!featureCode) continue
      const current = result.get(featureCode) ?? []
      if (!current.includes(meterCode)) {
        current.push(meterCode)
        result.set(featureCode, current)
      }
    }

    for (const [code, meters] of result.entries()) {
      if (meters.length > 1) {
        meters.sort((a, b) => a.localeCompare(b))
        result.set(code, meters)
      }
    }

    return result
  }

  private buildWindowFromPolicy(
    row: PolicyStandaloneRow,
    now: Date,
    opts: { billingAccountId: string; billingUserId: string; featureOverride?: string; unitFallback?: string | null; counterKeySuffix?: string },
  ): PolicyWindowView | null {
    const policyMetadata = row.policy_metadata ?? null
    const { limit, windowMs, windowKind } = this.parsePolicyLimit(row)
    const nowMs = now.getTime()
    const alignedStartMs = windowMs > 0 ? nowMs - (nowMs % windowMs) : nowMs
    const rangeStart = new Date(alignedStartMs)
    const bounds = this.computeWindowBounds(rangeStart, null, now, windowMs)
    if (!bounds) return null
    const featureCode = opts?.featureOverride ?? this.resolveFeatureCode(row.feature_code, policyMetadata, null)
    const baseCounterKey = this.resolveCounterKey(row, policyMetadata, null)
    const counterKey = opts?.counterKeySuffix ? `${baseCounterKey}${opts.counterKeySuffix}` : baseCounterKey
    const unit = row.unit ?? opts?.unitFallback ?? undefined
    const subjectScope = this.normalizeSubjectScope(row.subject_scope)
    const subjectId = subjectScope === 'account' ? opts.billingAccountId : opts.billingUserId

    const status: 'default' | 'ceiling' =
      row.status === 'ceiling' ? 'ceiling' : 'default'

    return {
      policyId: row.policy_id,
      policyName: row.policy_name ?? `policy-${row.policy_id}`,
      subjectScope,
      subjectId,
      featureCode,
      unit,
      limitMinor: limit,
      windowStart: bounds.start,
      windowEnd: bounds.end,
      windowMs,
      windowKind,
      counterKey,
      policyStatus: status,
    }
  }

  private parsePolicyLimit(row: PolicyRowBase): { limit: number; windowMs: number; windowKind: 'quota' | 'rate' } {
    const kind = typeof row.kind === 'string' ? row.kind.toLowerCase() : ''
    const windowSecRaw =
      typeof row.window_sec === 'number' ? row.window_sec : parseMinor(row.window_sec)
    const windowSec = windowSecRaw ?? 0

    if (kind === 'quota') {
      const limitMinor = parseMinor(row.limit_minor)
      if (limitMinor === undefined || limitMinor < UNLIMITED_QUOTA_MINOR) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: `quota policy ${row.policy_id} missing limit_minor` }, 500)
      }
      if (windowSec <= 0) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: `quota policy ${row.policy_id} requires window_sec > 0` }, 500)
      }
      return {
        limit: Math.floor(limitMinor),
        windowMs: Math.floor(windowSec) * 1000,
        windowKind: 'quota',
      }
    }

    if (kind === 'rate') {
      const limitCount = parseMinor(row.limit_count)
      if (limitCount === undefined || limitCount <= 0) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: `rate policy ${row.policy_id} missing limit_count` }, 500)
      }
      if (windowSec <= 0) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: `rate policy ${row.policy_id} requires window_sec > 0` }, 500)
      }
      return {
        limit: Math.floor(limitCount),
        windowMs: Math.floor(windowSec) * 1000,
        windowKind: 'rate',
      }
    }

    throw new HttpException({ code: 'SERVER.CONFIG', message: `unsupported policy kind ${row.kind ?? 'unknown'} for policy ${row.policy_id}` }, 500)
  }

  private resolveFeatureCode(
    fallback: string,
    policyMetadata: Record<string, unknown> | null,
    bindingMetadata: Record<string, unknown> | null,
  ): string {
    const bindingFeature = typeof bindingMetadata?.feature_code === 'string' ? bindingMetadata.feature_code.trim() : ''
    if (bindingFeature) return bindingFeature

    const policyFeature = typeof policyMetadata?.feature_code === 'string' ? policyMetadata.feature_code.trim() : ''
    if (policyFeature) return policyFeature

    const params = policyMetadata?.params
    if (params && typeof params === 'object') {
      const paramFeature = (params as Record<string, unknown>).feature_code
      if (typeof paramFeature === 'string' && paramFeature.trim().length > 0) {
        return paramFeature.trim()
      }
    }

    return fallback
  }

  private resolveCounterKey(
    row: PolicyRowBase,
    policyMetadata: Record<string, unknown> | null,
    bindingMetadata: Record<string, unknown> | null,
    bindingId?: string,
  ): string {
    const bindingKey = typeof bindingMetadata?.counter_key === 'string' ? bindingMetadata.counter_key.trim() : ''
    if (bindingKey) return bindingKey

    const policyKey = typeof policyMetadata?.counter_key === 'string' ? policyMetadata.counter_key.trim() : ''
    if (policyKey) return policyKey

    const params = policyMetadata?.params
    if (params && typeof params === 'object') {
      const paramKey = (params as Record<string, unknown>).counter_key
      if (typeof paramKey === 'string' && paramKey.trim().length > 0) {
        return paramKey.trim()
      }
    }

    const baseKey = `policy:${row.policy_id}`
    if (bindingId !== undefined) {
      return `${baseKey}#${bindingId}`
    }
    return baseKey
  }

  private async incrementRateCounter(
    trx: Kysely<Database>,
    params: { billingUserId: string; billingAccountId: string; window: PolicyWindowView; increment: number; now: Date },
  ): Promise<RateCounterIncrementResult> {
    const limitMinor = params.window.limitMinor
    if (params.increment <= 0) {
      return { status: 'ok', usedMinor: 0, limitMinor }
    }
    if (params.increment > limitMinor) {
      return { status: 'invalid_increment', limitMinor }
    }

    const counterKey = params.window.counterKey
    if (!counterKey) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'rate window missing counter key' }, 500)
    }
    const billingUserId = params.window.subjectScope === 'user' ? params.billingUserId : null

    const insertResult = await sql<RateCounterRow>`
      INSERT INTO gate_quota_counters (
        subject_scope,
        subject_id,
        billing_user_id,
        billing_account_id,
        feature_code,
        key,
        window_start,
        window_end,
        limit_minor,
        used_minor
      ) VALUES (
        ${params.window.subjectScope},
        ${params.window.subjectId},
        ${billingUserId},
        ${params.billingAccountId},
        ${params.window.featureCode},
        ${counterKey},
        ${params.window.windowStart},
        ${params.window.windowEnd},
        ${limitMinor},
        ${params.increment}
      )
      ON CONFLICT (billing_account_id, subject_scope, subject_id, feature_code, key, window_start, window_end)
      DO UPDATE SET
        used_minor = gate_quota_counters.used_minor + ${params.increment},
        limit_minor = ${limitMinor},
        updated_at = ${params.now}
      WHERE gate_quota_counters.used_minor + ${params.increment} <= ${limitMinor}
      RETURNING used_minor
    `
      .execute(trx)
      .then((res) => res.rows[0])

    if (!insertResult) {
      const existing = await trx
        .selectFrom('gate_quota_counters')
        .select('used_minor')
        .where('billing_account_id', '=', params.billingAccountId)
        .where('subject_scope', '=', params.window.subjectScope)
        .where('subject_id', '=', params.window.subjectId)
        .where('feature_code', '=', params.window.featureCode)
        .where('key', '=', counterKey)
        .where('window_start', '=', params.window.windowStart)
        .where('window_end', '=', params.window.windowEnd)
        .executeTakeFirst()

      const currentUsedMinor = parseMinor(existing?.used_minor) ?? 0
      return { status: 'would_exceed', limitMinor, currentUsedMinor }
    }

    const usedMinor = parseMinor(insertResult.used_minor) ?? 0
    if (usedMinor > limitMinor) {
      return { status: 'would_exceed', limitMinor, currentUsedMinor: usedMinor }
    }

    return { status: 'ok', usedMinor, limitMinor }
  }

  computeWindowBounds(
    rangeStart: Date,
    rangeEnd: Date | null,
    now: Date,
    windowMs: number,
  ): { start: Date; end: Date } | null {
    const startMs = rangeStart.getTime()
    const nowMs = now.getTime()
    const offset = nowMs > startMs ? Math.floor((nowMs - startMs) / windowMs) : 0
    const windowStartMs = startMs + offset * windowMs
    const windowStart = new Date(windowStartMs)
    let windowEnd = new Date(windowStartMs + windowMs)

    if (rangeEnd && windowEnd > rangeEnd) {
      windowEnd = rangeEnd
    }

    if (windowEnd <= windowStart) return null

    return { start: windowStart, end: windowEnd }
  }

  selectPrimaryWindow(windows: PolicyWindowView[]): PolicyWindowView | undefined {
    if (windows.length === 0) return undefined
    return windows
      .slice()
      .sort((a, b) => {
        const featureCompare = a.featureCode.localeCompare(b.featureCode)
        if (featureCompare !== 0) return featureCompare
        const durationCompare = a.windowMs - b.windowMs
        if (durationCompare !== 0) return durationCompare
        return a.policyName.localeCompare(b.policyName)
      })[0]
  }

  getWindowUsage(window: PolicyWindowView, counters: CounterLookup): number {
    if (!window.counterKey) return 0
    const key = this.makeCounterStorageKey(
      window.subjectScope,
      window.subjectId,
      window.featureCode,
      window.counterKey,
      window.windowStart,
      window.windowEnd,
    )
    return counters.get(key) ?? 0
  }

  makeCounterStorageKey(
    subjectScope: 'account' | 'user',
    subjectId: string,
    featureCode: string,
    counterKey: string,
    windowStart: Date,
    windowEnd: Date,
  ): string {
    return `${subjectScope}|${subjectId}|${featureCode}|${counterKey}|${windowStart.toISOString()}|${windowEnd.toISOString()}`
  }

  buildQuotaWindow(window: PolicyWindowView, counters: CounterLookup): QuotaWindow {
    return {
      subject_scope: window.subjectScope,
      window_start: window.windowStart.toISOString(),
      window_end: window.windowEnd.toISOString(),
      limit_minor: window.limitMinor.toString(),
      used_minor: this.getWindowUsage(window, counters).toString(),
    }
  }

  buildRateWindow(window: PolicyWindowView, counters: CounterLookup): RateWindow {
    return {
      subject_scope: window.subjectScope,
      window_start: window.windowStart.toISOString(),
      window_end: window.windowEnd.toISOString(),
      limit_minor: window.limitMinor.toString(),
      used_minor: this.getWindowUsage(window, counters).toString(),
    }
  }

  public toQuotaWindowMetadata(window: PolicyWindowView): QuotaWindowMetadataEntry {
    if (!window.counterKey) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'quota window missing counter key' }, 500)
    }
    return {
      policy_id: window.policyId,
      subject_scope: window.subjectScope,
      subject_id: window.subjectId,
      counter_key: window.counterKey,
      window_start: window.windowStart.toISOString(),
      window_end: window.windowEnd.toISOString(),
      limit_minor: window.limitMinor,
      unit: window.unit ?? undefined,
    }
  }

  public toRateWindowMetadata(window: PolicyWindowView): RateWindowMetadataEntry {
    if (!window.counterKey) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'rate window missing counter key' }, 500)
    }
    return {
      policy_id: window.policyId,
      subject_scope: window.subjectScope,
      subject_id: window.subjectId,
      counter_key: window.counterKey,
      window_start: window.windowStart.toISOString(),
      window_end: window.windowEnd.toISOString(),
      limit_minor: window.limitMinor,
      unit: window.unit ?? undefined,
    }
  }

  allocateQuotaQuantity(
    windows: PolicyWindowView[],
    counters: CounterLookup,
    quantityMinor: number,
  ): { allocations: { window: PolicyWindowView; allocated: number }[] } {
    const allocations: { window: PolicyWindowView; allocated: number }[] = []
    if (quantityMinor <= 0) {
      return { allocations }
    }


    for (const window of windows) {
      const isUnlimited = window.limitMinor === UNLIMITED_QUOTA_MINOR
      if (isUnlimited) {
        allocations.push({ window, allocated: quantityMinor })
        continue
      }
      const available = Math.max(0, window.limitMinor - this.getWindowUsage(window, counters))
      const allocated = available < quantityMinor ? available : quantityMinor
      allocations.push({ window, allocated })
    }

    return { allocations }
  }

  extractQuotaWindowMetadata(metadata: Record<string, unknown> | null): QuotaWindowMetadataEntry[] {
    if (!metadata) return []
    const raw = (metadata['quota_windows'] ?? []) as unknown
    if (!Array.isArray(raw)) return []

    const entries: QuotaWindowMetadataEntry[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      const policyId = typeof obj.policy_id === 'string' ? obj.policy_id : String(obj.policy_id)
      const subjectScope = this.normalizeSubjectScope(obj.subject_scope)
      const subjectId = typeof obj.subject_id === 'string' ? obj.subject_id : undefined
      const counterKey = typeof obj.counter_key === 'string' ? obj.counter_key : undefined
      const windowStart = typeof obj.window_start === 'string' ? obj.window_start : undefined
      const windowEnd = typeof obj.window_end === 'string' ? obj.window_end : undefined
      const limitMinorRaw = typeof obj.limit_minor === 'number' ? obj.limit_minor : Number(obj.limit_minor)
      if (
        !policyId ||
        !subjectId ||
        !counterKey ||
        !windowStart ||
        !windowEnd ||
        Number.isNaN(limitMinorRaw) ||
        limitMinorRaw < UNLIMITED_QUOTA_MINOR
      ) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'invalid quota window metadata on lease' }, 500)
      }
      const limitMinor = Math.trunc(limitMinorRaw)
      entries.push({
        policy_id: policyId,
        subject_scope: subjectScope,
        subject_id: subjectId,
        counter_key: counterKey,
        window_start: windowStart,
        window_end: windowEnd,
        limit_minor: limitMinor,
        unit: typeof obj.unit === 'string' ? obj.unit : undefined,
      })
    }
    return entries
  }

  matchQuotaWindow(entry: QuotaWindowMetadataEntry, windows: PolicyWindowView[]): PolicyWindowView | undefined {
    const targetKey = this.makeQuotaMetadataKey(entry.policy_id, entry.subject_scope, entry.subject_id, entry.counter_key, entry.window_start, entry.window_end)
    return windows.find((window) => {
      if (!window.counterKey) return false
      const windowKey = this.makeQuotaMetadataKey(
        window.policyId,
        window.subjectScope,
        window.subjectId,
        window.counterKey,
        window.windowStart.toISOString(),
        window.windowEnd.toISOString(),
      )
      return windowKey === targetKey
    })
  }

  makeQuotaMetadataKey(policyId: string, subjectScope: 'account' | 'user', subjectId: string, counterKey: string, windowStartIso: string, windowEndIso: string): string {
    return `${policyId}|${subjectScope}|${subjectId}|${counterKey}|${windowStartIso}|${windowEndIso}`
  }

}

type EntRow = {
  effect: string
  priority: number
  feature_id?: unknown
  feature_family_id?: unknown
  assignment_id?: unknown
  plan_id?: unknown
  plan_code?: unknown
  plan_kind?: unknown
}

function pickEntitlementWithWildcard(rows: EntRow[], featureId?: string, featureFamilyId?: string): EntRow | null {
  if (!rows || rows.length === 0) return null
  const featureKey = featureId ? String(featureId) : null
  const feature_familyKey = featureFamilyId ? String(featureFamilyId) : null

  const specificityRank = (row: EntRow): number => {
    if (row.feature_id && featureKey && String(row.feature_id) === featureKey) return 0
    if (row.feature_family_id && feature_familyKey && String(row.feature_family_id) === feature_familyKey) return 1
    return 2 // wildcard
  }

  let best: (EntRow & { rank: number }) | null = null
  for (const row of rows) {
    const priority = Number(row.priority ?? 0)
    const rank = specificityRank(row)
    if (!best || priority > best.priority) {
      best = { ...row, rank }
      continue
    }
    if (priority < best.priority) continue

    // same priority
    const rowIsDeny = row.effect === 'deny'
    const bestIsDeny = best.effect === 'deny'
    if (rowIsDeny && !bestIsDeny) {
      best = { ...row, rank }
      continue
    }
    if (rowIsDeny === bestIsDeny && rank < best.rank) {
      best = { ...row, rank }
    }
  }

  return best
}
