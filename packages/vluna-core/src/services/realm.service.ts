import type { Kysely, Transaction } from 'kysely'
import { randomBytes } from 'node:crypto'
import type { Database } from '../types/database.js'
import { UNLIMITED_QUOTA_MINOR, WILDCARD_FEATURE_CODE } from '../features/gate/services/gate.types.js'
import { BASE_GRANT_PROGRAMS, BASE_POLICY_NAME, DEFAULT_BUNDLE_KEY } from '../constants/billing.js'
import { ensureFallbackFeatureFamily } from './feature-family.service.js'
import { DEFAULT_SERVICE_API_KEY_PREFIX, ServiceApiKeyService } from '../security/service-api-key.service.js'

export { DEFAULT_BUNDLE_KEY, BASE_POLICY_NAME }

type RealmInput = {
  realmId: string
  name?: string
  status?: string
  metadata?: Record<string, unknown>
}

export type BootstrapRealmResult = {
  realmId: string
  realmName: string
  serviceKey: {
    keyId: string
    secretBase64: string
    envTag: string
  }
}

function randomAlphaNumericString(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  if (length <= 0) return ''
  const out: string[] = []
  while (out.length < length) {
    const bytes = randomBytes(Math.max(16, length))
    for (const b of bytes) {
      if (b >= 248) continue
      out.push(alphabet[b % 62])
      if (out.length === length) break
    }
  }
  return out.join('')
}

export function createRealmId(): string {
  return `realm-${randomAlphaNumericString(10)}`
}

async function ensureRealmRecord(trx: Kysely<Database> | Transaction<Database>, input: RealmInput): Promise<void> {
  const realmId = input.realmId
  const name = input.name ?? realmId
  const status = (input.status ?? 'active') as 'active' | 'suspended' | 'deleted'

  const existing = await trx
    .selectFrom('realms')
    .select(['realm_id', 'metadata'])
    .where('realm_id', '=', realmId)
    .executeTakeFirst()

  if (!existing) {
    const metadata = (input.metadata ?? {}) as Record<string, unknown>
    await trx
      .insertInto('realms')
      .values({
        realm_id: realmId,
        name,
        status,
        metadata,
      })
      .executeTakeFirst()
    return
  }

  const currentMetadata = (existing.metadata ?? {}) as Record<string, unknown>
  const nextMetadata = input.metadata
    ? { ...currentMetadata, ...(input.metadata as Record<string, unknown>) }
    : currentMetadata
  await trx
    .updateTable('realms')
    .set({
      name,
      status,
      metadata: nextMetadata,
    })
    .where('realm_id', '=', realmId)
    .executeTakeFirst()
}

async function ensureBaseGrantPrograms(
  trx: Kysely<Database> | Transaction<Database>,
  realmId: string,
): Promise<void> {
  for (const program of BASE_GRANT_PROGRAMS) {
    await trx
      .insertInto('grant_programs')
      .values({
        realm_id: realmId,
        program_code: program.program_code,
        name: program.name,
        active: true,
        cadence: program.cadence,
        issue_anchor: 'binding_start',
        amount_xusd: '0',
        window_kind: program.window_kind ?? 'period',
        window_default_seconds: program.window_default_seconds,
        priority: program.priority,
        on_ledger: program.on_ledger,
        issuance_mode: (program.issuance_mode ?? 'eager') as 'eager' | 'lazy' | 'hybrid',
        periodic_accounting: program.periodic_accounting ?? false,
        accrual_mode: (program.accrual_mode ?? 'full_at_period_start') as 'full_at_period_start' | 'earn_daily' | null,
        metadata: program.metadata,
      })
      .onConflict((oc) =>
        oc.columns(['realm_id', 'program_code']).doUpdateSet({
          name: program.name,
          active: true,
          cadence: program.cadence,
          issue_anchor: 'binding_start',
          amount_xusd: '0',
          window_kind: program.window_kind ?? 'period',
          window_default_seconds: program.window_default_seconds,
          priority: program.priority,
          on_ledger: program.on_ledger,
          issuance_mode: (program.issuance_mode ?? 'eager') as 'eager' | 'lazy' | 'hybrid',
          periodic_accounting: program.periodic_accounting ?? false,
          accrual_mode: (program.accrual_mode ?? 'full_at_period_start') as 'full_at_period_start' | 'earn_daily' | null,
          metadata: program.metadata,
        }),
      )
      .executeTakeFirst()
  }
}

export async function createRealm(
  trx: Kysely<Database> | Transaction<Database>,
  input: RealmInput,
): Promise<void> {
  await ensureRealmRecord(trx, input)
  await ensureBaseGrantPrograms(trx, input.realmId)
  await ensureDefaultServiceApiKey(trx, input.realmId)
  await ensureBaseGatingPolicy(trx, input.realmId)
  await ensureFallbackFeatureFamily(trx, input.realmId)
  await ensureDefaultBillingPlan(trx, input.realmId)
}

export async function ensureBootstrapRealm(
  trx: Kysely<Database> | Transaction<Database>,
  input: RealmInput,
): Promise<BootstrapRealmResult> {
  const realmId = input.realmId.trim()
  if (!realmId) {
    throw new Error('realm_id is required to bootstrap a realm')
  }

  await createRealm(trx, input)

  const row = await trx
    .selectFrom('realms')
    .select(['name'])
    .where('realm_id', '=', realmId)
    .executeTakeFirst()

  const serviceApiKeyService = new ServiceApiKeyService()
  await serviceApiKeyService.loadSecrets(trx as Kysely<Database>)

  const keyRow = await trx
    .selectFrom('service_api_keys')
    .select(['key_id', 'allowed_realms'])
    .execute()
  const bootstrapKey = keyRow.find((candidate) => {
    if (!candidate.key_id.startsWith(DEFAULT_SERVICE_API_KEY_PREFIX)) return false
    return candidate.allowed_realms.includes(realmId)
  })
  if (!bootstrapKey) {
    throw new Error(`bootstrap service key not found for realm ${realmId}`)
  }

  const derived = serviceApiKeyService.getKey(bootstrapKey.key_id)
  if (!derived) {
    throw new Error(`bootstrap service key secret unavailable for realm ${realmId}`)
  }

  return {
    realmId,
    realmName: String(row?.name || input.name || realmId),
    serviceKey: {
      keyId: bootstrapKey.key_id,
      secretBase64: derived.secretBase64,
      envTag: derived.envTag,
    },
  }
}

async function ensureDefaultServiceApiKey(
  trx: Kysely<Database> | Transaction<Database>,
  realmId: string,
): Promise<string> {
  const normalizedRealm = realmId.trim()
  if (!normalizedRealm) {
    throw new Error('realm_id is required to create a service API key')
  }

  const existing = await trx.selectFrom('service_api_keys').select(['key_id', 'allowed_realms']).execute()
  const found = existing.find((row) => {
    if (!row.key_id.startsWith(DEFAULT_SERVICE_API_KEY_PREFIX)) return false
    return row.allowed_realms.includes(normalizedRealm)
  })
  if (found) return found.key_id

  return ServiceApiKeyService.createServiceApiKey(trx, normalizedRealm)
}

async function ensureDefaultBundle(
  trx: Kysely<Database> | Transaction<Database>,
  realmId: string,
): Promise<string> {
  const existing = await trx
    .selectFrom('gate_policy_bundles')
    .select(['bundle_id'])
    .where('realm_id', '=', realmId)
    .where('bundle_key', '=', DEFAULT_BUNDLE_KEY)
    .executeTakeFirst()

  if (existing?.bundle_id) {
    return String(existing.bundle_id)
  }

  await trx
    .insertInto('gate_policy_bundles')
    .values({
      realm_id: realmId,
      bundle_key: DEFAULT_BUNDLE_KEY,
      name: 'Default bundle',
      status: 'active',
      metadata: { bundle_kind: 'default', feature_scope: 'all' },
    })
    .onConflict((oc) =>
      oc.columns(['realm_id', 'bundle_key']).doUpdateSet({
        name: 'Default bundle',
        status: 'active',
        metadata: { bundle_kind: 'default', feature_scope: 'all' },
        updated_at: new Date(),
      }),
    )
    .executeTakeFirst()

  const bundleRow = await trx
    .selectFrom('gate_policy_bundles')
    .select('bundle_id')
    .where('realm_id', '=', realmId)
    .where('bundle_key', '=', DEFAULT_BUNDLE_KEY)
    .executeTakeFirst()

  if (!bundleRow?.bundle_id) {
    throw new Error('default bundle not found after insert')
  }

  return String(bundleRow.bundle_id)
}

async function ensureBaseGatingPolicy(
  trx: Kysely<Database> | Transaction<Database>,
  realmId: string,
): Promise<void> {
  const bundleId = await ensureDefaultBundle(trx, realmId)

  // Base policy: unlimited wildcard
  await trx
    .insertInto('gate_policies')
    .values({
      realm_id: realmId,
      bundle_id: bundleId,
      name: BASE_POLICY_NAME,
      description: 'Base wildcard policy',
      feature_code: WILDCARD_FEATURE_CODE,
      kind: 'quota',
      unit: 'unit',
      window_sec: 86_400,
      limit_minor: UNLIMITED_QUOTA_MINOR,
      limit_count: null,
      status: 'default',
      enforcement_mode: 'optimistic',
      metadata: { auto: true, description: 'Base unlimited quota for new realms' },
    })
    .onConflict((oc) =>
      oc.columns(['realm_id', 'name']).doUpdateSet({
        bundle_id: bundleId,
        description: 'Base wildcard policy',
        feature_code: WILDCARD_FEATURE_CODE,
        kind: 'quota',
        unit: 'unit',
        window_sec: 86_400,
        limit_minor: UNLIMITED_QUOTA_MINOR,
        limit_count: null,
        status: 'default',
        enforcement_mode: 'optimistic',
        metadata: { auto: true, description: 'Base unlimited quota for new realms' },
        updated_at: new Date(),
      }),
    )
    .executeTakeFirst()
}

async function ensureDefaultBillingPlan(trx: Kysely<Database> | Transaction<Database>, realmId: string): Promise<void> {
  const planCode = 'default_billing_plan'

  const existing = await trx
    .selectFrom('billing_plans')
    .select(['plan_id', 'metadata'])
    .where('realm_id', '=', realmId)
    .where('plan_code', '=', planCode)
    .executeTakeFirst()

  const meta = {
    built_in: true,
    // grants: [
    //   {
    //     grant_program_code: 'monthly_xusd',
    //     amount_xusd: 100000,
    //     issue_anchor_override: 'binding_start'
    //   }
    // ]
  }
  let planId: string
  if (existing?.plan_id) {
    planId = String(existing.plan_id)
  } else {
    await trx
      .insertInto('billing_plans')
      .values({
        realm_id: realmId,
        plan_code: planCode,
        name: 'Default billing plan',
        kind: 'base',
        priority: 0,
        active: true,
        metadata: meta,
      })
      .executeTakeFirst()

    const created = await trx
      .selectFrom('billing_plans')
      .select('plan_id')
      .where('realm_id', '=', realmId)
      .where('plan_code', '=', planCode)
      .executeTakeFirst()
    if (!created?.plan_id) {
      // In test doubles, insert/select may be no-op; skip silently.
      return
    }
    planId = String(created.plan_id)
  }

  await trx
    .deleteFrom('billing_plan_entitlements')
    .where('plan_id', '=', planId)
    .where('feature_id', 'is', null)
    .where('feature_family_id', 'is', null)
    .execute()

  await trx
    .insertInto('billing_plan_entitlements')
    .values({
      plan_id: planId,
      feature_id: null,
      feature_family_id: null,
      effect: 'allow',
    })
    .execute()

  const realmRow = await trx.selectFrom('realms').select(['metadata']).where('realm_id', '=', realmId).executeTakeFirst()
  const metadata = (realmRow?.metadata ?? {}) as Record<string, unknown>
  if ((metadata.default_plan_id as string | undefined) !== planId) {
    const nextMeta = { ...metadata, default_plan_id: planId }
    await trx
      .updateTable('realms')
      .set({ metadata: nextMeta })
      .where('realm_id', '=', realmId)
      .execute()
  }
}
