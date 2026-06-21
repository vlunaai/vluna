import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { db, setRlsSession } from '../db/index.js'
import type { Database } from '../types/database.js'
import type { Kysely, Transaction } from 'kysely'
import { createRealm } from '../services/realm.service.js'
import { DEFAULT_BUNDLE_KEY } from '../constants/billing.js'
import { FeatureService } from '../features/billing/services/feature.service.js'
import { MeterService } from '../features/billing/services/meter.service.js'
import { upsertBillingPlan } from '../services/billing-plan.service.js'
import { toJsonb } from '../utils/jsonb.js'
import { normalizeIdentifier } from '../utils/identifiers.js'

type RealmStatus = 'active' | 'suspended' | 'deleted'
type CurrencyKind = 'fiat' | 'credit' | 'crypto' | 'token' | 'other'
type ProductKind = 'subscription' | 'credit'
type ProductStatus = 'active' | 'archived' | 'draft'
type RecurringInterval = 'month' | 'year' | null
type GatePolicyKind = 'rate' | 'quota'
type GatePolicyStatus = 'default' | 'assignable' | 'ceiling' | 'disabled'
type GatePolicyEnforcement = 'optimistic' | 'reserve'
type GatePolicySubjectScope = 'user' | 'account'
type RoundingMode = 'round' | 'floor' | 'ceil' | 'truncate'
type PriceRounding = 'floor' | 'nearest' | 'ceil'
type BudgetStrategy = 'auto' | 'hot' | 'cold'
type MeterSemanticKind = 'activity' | 'outcome'
type GrantCadence = 'once' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'billing_period'
type GrantIssueAnchor = 'calendar_start' | 'binding_start' | 'first_use'
type GrantWindowKind = 'period' | 'fixed' | 'forever' | 'relative_duration'
type GrantIssuanceMode = 'eager' | 'lazy' | 'hybrid'
type GrantAccrualMode = 'full_at_period_start' | 'earn_daily' | null
type GrantCampaignStatus = 'scheduled' | 'active' | 'paused' | 'ended'
type EventRatingPolicyStatus = 'active' | 'disabled'
type EventRatingPolicyVersionStatus = 'draft' | 'active' | 'deprecated'
type BillingContractStatus = 'active' | 'disabled'
type ContractTermKind = 'pricing' | 'e2r_param'

type RealmSpec = {
  realm_id: string
  name: string
  status: RealmStatus
  metadata: Record<string, unknown>
}

const METADATA_PLACEHOLDER_PATTERN = /^<<<.+>>>$/

function metadataEnvKeys(realmId: string): string[] {
  const normalized = realmId.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  return [`SEED_REALM_METADATA_JSON_${normalized}`, 'SEED_REALM_METADATA_JSON']
}

function hasMetadataPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return METADATA_PLACEHOLDER_PATTERN.test(value)
  if (Array.isArray(value)) return value.some((entry) => hasMetadataPlaceholder(entry))
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) => hasMetadataPlaceholder(entry))
  }
  return false
}

function loadMetadataOverride(keys: string[]): { metadata: Record<string, unknown>; key: string } | null {
  for (const key of keys) {
    const raw = process.env[key]
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('value must be a JSON object')
      }
      return { metadata: parsed as Record<string, unknown>, key }
    } catch (err) {
      throw new Error(`Failed to parse ${key}: ${(err as Error).message}`)
    }
  }
  return null
}

function applyRealmMetadataOverride(spec: RealmSpec): RealmSpec {
  const currentMetadata = spec.metadata ?? {}
  const needsOverride = hasMetadataPlaceholder(currentMetadata)
  if (!needsOverride) return spec
  const keys = metadataEnvKeys(spec.realm_id)
  const override = loadMetadataOverride(keys)
  if (!override) {
    throw new Error(`Realm ${spec.realm_id} metadata contains placeholders; set one of ${keys.join(', ')}`)
  }
  const merged = mergeRealmMetadata(currentMetadata, override.metadata)
  return { ...spec, metadata: merged }
}

type StripeWebhookLike = { name: string; secret?: string; test?: string; live?: string; url?: string }
type StripeMetaLike = { webhooks?: StripeWebhookLike[]; }

function normalizeStripeWebhooks(stripe: StripeMetaLike | null | undefined): StripeWebhookLike[] {
  if (!stripe) return []
  if (Array.isArray(stripe.webhooks)) {
    return stripe.webhooks
      .map((w: StripeWebhookLike) => ({
        name: String(w?.name || '').trim() || 'default',
        secret: w?.secret,
        test: w?.test,
        live: w?.live,
        url: w?.url,
      }))
  }

  return []
}

function mergeRealmStripeMetadata(currentStripe: StripeMetaLike | null | undefined, incomingStripe: StripeMetaLike | null | undefined): StripeMetaLike {
  const currWebhooks = normalizeStripeWebhooks(currentStripe)
  const incWebhooks = normalizeStripeWebhooks(incomingStripe)
  const incByName = new Map<string, StripeWebhookLike>()
  for (const w of incWebhooks) incByName.set(w.name, { ...w })
  for (const curr of currWebhooks) {
    const incoming = incByName.get(curr.name) ?? ({} as StripeWebhookLike)
    incByName.set(curr.name, {
      name: curr.name,
      secret: curr.secret || incoming.secret,
      test: curr.test || incoming.test,
      live: curr.live || incoming.live,
      url: incoming.url || curr.url,
    })
  }
  const mergedWebhooks = Array.from(incByName.values())
  const mergedStripe = { ...(incomingStripe || {}) }
  mergedStripe.webhooks = mergedWebhooks
  return mergedStripe
}

type RealmMetadataLike = { payments?: { stripe?: StripeMetaLike }; [key: string]: unknown }

function mergeRealmMetadata(
  current: RealmMetadataLike | null | undefined,
  incoming: RealmMetadataLike | null | undefined,
): RealmMetadataLike {
  // start with current to preserve fields not present in incoming
  const merged: RealmMetadataLike = { ...(current || {}) }
  if (incoming) {
    Object.assign(merged, incoming)
  }

  const currentStripe = current?.payments?.stripe
  const incomingStripe = incoming?.payments?.stripe
  if (currentStripe || incomingStripe) {
    merged.payments = { ...(current?.payments || {}), ...(incoming?.payments || {}) }
    merged.payments.stripe = mergeRealmStripeMetadata(currentStripe || {}, incomingStripe || {})
  }
  return merged
}

type CurrencySpec = {
  code: string
  kind: CurrencyKind
  scale: number
}

type ServiceApiKeySpec = {
  key_id: string
  status: string
  allowed_realms: string[]
  allowed_accounts: string[]
  scopes: string[]
  kdf_alg: 'HMAC-SHA256' | 'HKDF-SHA256'
  kdf_salt: Buffer
  kdf_version: number
  env_tag: string
  expires_at?: Date | null
  last_used_at?: Date | null
}

type CatalogProductSpec = {
  catalog_product_id?: string
  realm_id: string
  product_code: string
  provider: string
  provider_product_id: string
  kind: ProductKind
  status: ProductStatus
  display_priority: number
  name: string
  default_currency: string
}

type CatalogPriceSpec = {
  catalog_price_id?: string
  realm_id: string
  price_code: string
  product_code: string
  provider_price_id: string
  status?: 'active' | 'archived'
  currency: string
  unit_amount: number
  recurring_interval: RecurringInterval
  recurring_count: number | null
  display_priority: number
  metadata: Record<string, unknown> | null
  subscription_group_key: string | null
}

type CatalogSubscriptionGroupSpec = {
  realm_id: string
  group_key: string
  title: string
  is_stackable: boolean
  is_exclusive: boolean
}

type FeatureFamilySpec = {
  realm_id: string
  feature_family_code: string
  name: string
  description: string
  active: boolean
  metadata: Record<string, unknown>
  feature_family_id?: string
}

// type CatalogSharedSpec = {
//   catalogProducts: CatalogProductSpec[]
//   catalogPrices: CatalogPriceSpec[]
//   catalogSubscriptionGroups: CatalogSubscriptionGroupSpec[]
// }

type FeatureSpec = {
  realm_id: string
  feature_family_code: string
  feature_code: string
  name: string
  description: string
  active: boolean
  entitlement_required?: boolean
  default_budget_strategy: BudgetStrategy
  metadata?: Record<string, unknown>
  unit?: string
  meters?: Omit<MeterSpec, 'realm_id'>[]
}

type MeterSpec = {
  realm_id: string
  meter_code: string
  feature_code?: string
  unit?: string
  scale?: number
  rounding?: RoundingMode
  semantic_kind?: MeterSemanticKind
  active?: boolean
  metadata?: Record<string, unknown>
  meter_prices?: MeterPriceSpec | null
}

type FeatureMeterSpec = {
  realm_id: string
  feature_code: string
  meter_code: string
  is_primary?: boolean
  metadata?: Record<string, unknown>
}

type GatePolicySpec = {
  realm_id: string
  bundle_key: string
  feature_code: string
  name: string
  description: string | null
  kind: GatePolicyKind
  subject_scope: GatePolicySubjectScope
  unit: string
  window_sec: number
  limit_count: string | null
  limit_minor: string | null
  status: GatePolicyStatus
  enforcement_mode: GatePolicyEnforcement
  metadata: Record<string, unknown>
}

type MeterPriceSpec = {
  realm_id: string
  meter_code: string
  unit_price_xusd?: string
  unit_price_base_xusd?: string
  unit_price_dynamic_xusd?: string
  unit_quantity_minor?: string
  rounding?: PriceRounding
  unit_cost_xusd?: string
  cost_unit_quantity_minor?: string
  cost_rounding?: PriceRounding
  effective_at?: Date
}

type GrantCampaignSpec = {
  realm_id: string
  name: string
  status: GrantCampaignStatus
  window_start: Date
  window_end: Date | null
  target_filter: Record<string, unknown>
  metadata: Record<string, unknown>
}

type GrantProgramSpec = {
  realm_id: string
  program_code: string
  name: string | null
  active: boolean
  cadence: GrantCadence
  issue_anchor: GrantIssueAnchor
  amount_xusd: string
  window_kind: GrantWindowKind
  window_default_seconds: number | null
  priority: number
  on_ledger: boolean
  issuance_mode: GrantIssuanceMode
  periodic_accounting: boolean
  accrual_mode: GrantAccrualMode
  metadata: Record<string, unknown>
}

type BillingPlanSpec = {
  realm_id: string
  plan_code: string
  name: string
  kind: 'base' | 'addon' | 'promo'
  priority?: number
  active?: boolean
  metadata?: Record<string, unknown>
  feature_codes?: string[]
  feature_family_codes?: string[]
}

type BillingAccountSpec = {
  realm_id: string
  billing_account_id: string
  billing_principal_id: string
  metadata?: Record<string, unknown>
}

type EventRatingPolicySpec = {
  realm_id: string
  policy_id: string
  name: string
  status: EventRatingPolicyStatus
}

type EventRatingPolicyVersionSpec = {
  realm_id: string
  policy_id: string
  policy_version: string
  status: EventRatingPolicyVersionStatus
  effective_at: Date
  dsl_json: Record<string, unknown>
  dsl_hash: string
}

type BillingContractSpec = {
  realm_id: string
  contract_id: string
  billing_account_id: string
  status: BillingContractStatus
  effective_at: Date
  name?: string | null
  metadata?: Record<string, unknown>
}

type ContractTermSpec = {
  realm_id: string
  contract_id: string
  kind: ContractTermKind
  term_key: string
  effective_at: Date
  value_json: unknown
}

type RealmDataSpec = {
  realm_id: string
  feature_families: FeatureFamilySpec[]
  catalogProducts?: CatalogProductSpec[]
  catalogPrices?: CatalogPriceSpec[]
  catalogSubscriptionGroups?: CatalogSubscriptionGroupSpec[]
  features: FeatureSpec[]
  meters: MeterSpec[]
  featureMeters: FeatureMeterSpec[]
  gatePolicies: GatePolicySpec[]
  meterPrices: MeterPriceSpec[]
  grantCampaigns: GrantCampaignSpec[]
  grantPrograms: GrantProgramSpec[]
  billingPlans: BillingPlanSpec[]
  billingAccounts: BillingAccountSpec[]
  eventRatingPolicies: EventRatingPolicySpec[]
  eventRatingPolicyVersions: EventRatingPolicyVersionSpec[]
  billingContracts: BillingContractSpec[]
  contractTerms: ContractTermSpec[]
}

export interface BillingImportSpec {
  realmId?: string
  realmIds: string[]
  realms: RealmSpec[]
  currencies: CurrencySpec[]
  serviceApiKeys: ServiceApiKeySpec[]
  catalogProducts: CatalogProductSpec[]
  catalogPrices: CatalogPriceSpec[]
  catalogSubscriptionGroups: CatalogSubscriptionGroupSpec[]
  feature_families: FeatureFamilySpec[]
  realmsData: RealmDataSpec[]
  features: FeatureSpec[]
  meters: MeterSpec[]
  featureMeters: FeatureMeterSpec[]
  gatePolicies: GatePolicySpec[]
  meterPrices: MeterPriceSpec[]
  grantCampaigns: GrantCampaignSpec[]
  grantPrograms: GrantProgramSpec[]
  billingPlans: BillingPlanSpec[]
  billingAccounts: BillingAccountSpec[]
  eventRatingPolicies: EventRatingPolicySpec[]
  eventRatingPolicyVersions: EventRatingPolicyVersionSpec[]
  billingContracts: BillingContractSpec[]
  contractTerms: ContractTermSpec[]
}

type SummaryAction = 'created' | 'updated' | 'unchanged' | 'disabled'
type DiffSample = Record<string, unknown>
type UpdateSample = { key: string; changes: Record<string, { current: unknown; next: unknown }> }
type CategorySummary = {
  created: number
  updated: number
  unchanged: number
  disabled: number
  samples: {
    created: DiffSample[]
    updated: UpdateSample[]
    disabled: DiffSample[]
  }
}

export type ImportSummary = Record<string, CategorySummary>

export interface ApplyOptions {
  mode?: 'merge' | 'replace'
  strict?: boolean
}

export interface PlanEntry {
  category: string
  created: number
  updated: number
  unchanged: number
  deprecated: number
  errors: string[]
  samples: {
    created?: unknown[]
    updated?: { key: string; changes: Record<string, { current: unknown; next: unknown }> }[]
    deprecated?: unknown[]
  }
}

export type PlanResult = {
  entries: PlanEntry[]
}

const defaultSummary: CategorySummary = {
  created: 0,
  updated: 0,
  unchanged: 0,
  disabled: 0,
  samples: { created: [], updated: [], disabled: [] },
}

const SAMPLE_LIMIT = 3

function getSummary(summary: ImportSummary, category: string): CategorySummary {
  if (!summary[category]) summary[category] = { ...defaultSummary, samples: { created: [], updated: [], disabled: [] } }
  return summary[category]
}

function bump(summary: ImportSummary, category: string, action: SummaryAction): void {
  const entry = getSummary(summary, category)
  entry[action]++
}

function recordCreated(summary: ImportSummary, category: string, sample: DiffSample): void {
  const entry = getSummary(summary, category)
  if (entry.samples.created.length < SAMPLE_LIMIT) entry.samples.created.push(sample)
}

function recordUpdated(summary: ImportSummary, category: string, key: string, changes: Record<string, { current: unknown; next: unknown }>): void {
  if (Object.keys(changes).length === 0) return
  const entry = getSummary(summary, category)
  if (entry.samples.updated.length < SAMPLE_LIMIT) entry.samples.updated.push({ key, changes })
}

function recordDisabled(summary: ImportSummary, category: string, sample: DiffSample): void {
  const entry = getSummary(summary, category)
  if (entry.samples.disabled.length < SAMPLE_LIMIT) entry.samples.disabled.push(sample)
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((v) => stableSerialize(v)).join(',') + ']'
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableSerialize(v)).join(',') + '}'
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableSerialize(a) === stableSerialize(b)
}

function normalizeMetadata(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {}
  if (Array.isArray(input)) return {}
  return { ...(input as Record<string, unknown>) }
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}

function resolveFile(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath
  return path.join(process.cwd(), filePath)
}

function parseDateMaybe(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^now\(\)$/i.test(trimmed)) return new Date()
    if (trimmed === '<<<NOW>>>') return new Date()
    const ms = Date.parse(trimmed)
    if (!Number.isNaN(ms)) return new Date(ms)
  }
  return null
}

function parseHexBuffer(input: unknown): Buffer | null {
  if (input == null) return null
  if (Buffer.isBuffer(input)) return input
  if (typeof input !== 'string') return null
  const hex = input.startsWith('0x') ? input.slice(2) : input
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null
  return Buffer.from(hex, 'hex')
}

function arraysEqual(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  const arrA = Array.isArray(a) ? a : []
  const arrB = Array.isArray(b) ? b : []
  if (arrA.length !== arrB.length) return false
  for (let i = 0; i < arrA.length; i += 1) {
    if (arrA[i] !== arrB[i]) return false
  }
  return true
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as UnknownRecord
  }
  return {}
}

function readString(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback
  return String(value)
}

function readTrimmedString(value: unknown, fallback = ''): string {
  const str = readString(value, fallback)
  const trimmed = str.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function readUppercaseString(value: unknown, fallback = ''): string {
  const trimmed = readTrimmedString(value, fallback)
  return trimmed.toUpperCase()
}

function readBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
  }
  return fallback
}

function readNumber(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const trimmed = readTrimmedString(value)
  return trimmed.length > 0 ? trimmed : null
}

function readCatalogPriceRecurringInterval(record: UnknownRecord): RecurringInterval {
  return record.recurring_interval === null || record.recurring_interval === undefined
    ? null
    : (record.recurring_interval as RecurringInterval)
}

function readCatalogPriceSubscriptionGroupKey(record: UnknownRecord, recurringInterval: RecurringInterval): string | null {
  const explicitGroupKey = readTrimmedString(record.subscription_group_key ?? record.group_key ?? record.subscription_group)
  if (explicitGroupKey) return explicitGroupKey
  if (!recurringInterval) return null
  return readTrimmedString(record.product_code) || null
}

function readGatePolicySubjectScope(value: unknown): GatePolicySubjectScope {
  const normalized = readTrimmedString(value ?? 'user', 'user')
  if (normalized === 'user' || normalized === 'account') return normalized
  throw new Error(`importer: invalid gate_policy subject_scope: ${normalized}`)
}

function readOptionalUuid(value: unknown, field: string): string | undefined {
  const trimmed = readOptionalString(value)
  if (!trimmed) return undefined
  const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  if (!uuidRe.test(trimmed)) {
    throw new Error(`importer: ${field} must be a valid uuid`)
  }
  return trimmed.toLowerCase()
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => readTrimmedString(entry))
    .filter((entry) => entry.length > 0)
}

function mapRecords<T>(value: unknown, mapper: (item: UnknownRecord) => T): T[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => mapper(asRecord(item)))
}

function parseRealmBundle(raw: UnknownRecord, strict: boolean, legacyRealmId?: string): RealmDataSpec {
  const realmId = readTrimmedString(raw.realm_id ?? raw.realm ?? legacyRealmId, legacyRealmId ?? '')
  if (!realmId) throw new Error('importer: realm_data entry missing realm_id')

  const feature_families: FeatureFamilySpec[] = mapRecords(raw.feature_families, (record) => ({
    realm_id: realmId,
    feature_family_code: readTrimmedString(record.feature_family_code ?? record.code ?? record.slug ?? ''),
    name: readTrimmedString(record.name ?? record.feature_family_code ?? record.code ?? record.slug ?? ''),
    description: readTrimmedString(record.description ?? '', ''),
    active: record.active === undefined ? true : readBoolean(record.active, true),
    metadata: normalizeMetadata(record.metadata),
  })).filter((c) => c.feature_family_code)

  const catalogProducts: CatalogProductSpec[] = mapRecords(raw.catalog_products, (record) => ({
    catalog_product_id: readOptionalUuid(record.catalog_product_id, 'catalog_product_id'),
    realm_id: realmId,
    product_code: readTrimmedString(record.product_code),
    provider: readTrimmedString(record.provider, 'stripe'),
    provider_product_id: readTrimmedString(record.provider_product_id ?? record.product_code),
    kind: (record.kind ?? 'subscription') as ProductKind,
    status: (record.status ?? 'draft') as ProductStatus,
    display_priority: readNumber(record.display_priority, 100),
    name: readTrimmedString(record.name),
    default_currency: readUppercaseString(record.default_currency ?? 'USD'),
  }))

  const catalogPrices: CatalogPriceSpec[] = mapRecords(raw.catalog_prices, (record) => {
    const recurringInterval = readCatalogPriceRecurringInterval(record)
    return {
      catalog_price_id: readOptionalUuid(record.catalog_price_id, 'catalog_price_id'),
      realm_id: realmId,
      price_code: readTrimmedString(record.price_code),
      product_code: readTrimmedString(record.product_code),
      provider_price_id: readTrimmedString(record.provider_price_id ?? record.price_code),
      status: (record.status ?? 'active') as 'active' | 'archived',
      currency: readUppercaseString(record.currency ?? 'USD'),
      unit_amount: readNumber(record.unit_amount, 0),
      recurring_interval: recurringInterval,
      recurring_count: record.recurring_count === null || record.recurring_count === undefined ? null : readNumber(record.recurring_count),
      display_priority: readNumber(record.display_priority, 100),
      metadata: normalizeMetadata(record.metadata),
      subscription_group_key: readCatalogPriceSubscriptionGroupKey(record, recurringInterval),
    }
  })

  const catalogSubscriptionGroups: CatalogSubscriptionGroupSpec[] = mapRecords(
    raw.subscription_groups,
    (record) => ({
      realm_id: realmId,
      group_key: readTrimmedString(record.group_key),
      title: readTrimmedString(record.title ?? record.group_key),
      is_stackable: readBoolean(record.is_stackable, false),
      is_exclusive: record.is_exclusive === undefined ? true : readBoolean(record.is_exclusive, true),
    }),
  )

  const features: FeatureSpec[] = mapRecords(raw.features, (record) => ({
    realm_id: readTrimmedString(record.realm_id ?? realmId, realmId),
    feature_family_code: readTrimmedString(record.feature_family_code ?? record.feature_family ?? ''),
    feature_code: readTrimmedString(record.feature_code),
    name: readTrimmedString(record.name),
    description: readTrimmedString(record.description ?? ''),
    active: record.active === undefined ? true : readBoolean(record.active, true),
    entitlement_required:
      record.entitlement_required === undefined ? undefined : readBoolean(record.entitlement_required, true),
    default_budget_strategy: (record.default_budget_strategy ?? 'auto') as BudgetStrategy,
    metadata: record.metadata === undefined ? undefined : normalizeMetadata(record.metadata),
    unit: readTrimmedString(record.unit ?? '', '') || undefined,
	    meters: Array.isArray(record.meters)
	      ? (record.meters as UnknownRecord[]).map((m) => ({
	          meter_code: readTrimmedString(m.meter_code ?? record.feature_code ?? ''),
	          feature_code: readTrimmedString(m.feature_code ?? record.feature_code ?? ''),
	          unit: readTrimmedString(m.unit ?? record.unit ?? '', '') || undefined,
	          scale: m.scale === undefined ? undefined : readNumber(m.scale, 0),
	          rounding: (m.rounding ?? undefined) as RoundingMode | undefined,
	          semantic_kind: m.semantic_kind === undefined
	            ? undefined
	            : ((() => {
	                const kind = readTrimmedString(m.semantic_kind, '').toLowerCase()
	                if (kind === 'activity' || kind === 'outcome') return kind as MeterSemanticKind
	                throw new Error(`importer: invalid semantic_kind: ${kind}`)
	              })()),
	          active: m.active === undefined ? undefined : readBoolean(m.active, true),
	          metadata: m.metadata === undefined ? undefined : normalizeMetadata(m.metadata),
	          meter_prices:
	            m.meter_prices !== undefined
	              ? {
                  realm_id: readTrimmedString(record.realm_id ?? realmId, realmId),
                  meter_code: readTrimmedString(m.meter_code ?? record.feature_code ?? ''),
                  unit_price_xusd:
                    (m.meter_prices as UnknownRecord).unit_price_xusd !== undefined
                      ? readString((m.meter_prices as UnknownRecord).unit_price_xusd, '0')
                      : (m.meter_prices as UnknownRecord).unit_price !== undefined
                        ? readString((m.meter_prices as UnknownRecord).unit_price, '0')
                        : undefined,
                  unit_price_base_xusd:
                    (m.meter_prices as UnknownRecord).unit_price_base_xusd !== undefined
                      ? readString((m.meter_prices as UnknownRecord).unit_price_base_xusd, '0')
                      : (m.meter_prices as UnknownRecord).unit_price_base !== undefined
                        ? readString((m.meter_prices as UnknownRecord).unit_price_base, '0')
                        : (m.meter_prices as UnknownRecord).unit_price !== undefined
                          ? readString((m.meter_prices as UnknownRecord).unit_price, '0')
                          : undefined,
                  unit_price_dynamic_xusd:
                    (m.meter_prices as UnknownRecord).unit_price_dynamic_xusd !== undefined
                      ? readString((m.meter_prices as UnknownRecord).unit_price_dynamic_xusd, '0')
                      : undefined,
                  unit_quantity_minor:
                    (m.meter_prices as UnknownRecord).unit_quantity_minor !== undefined
                      ? readString((m.meter_prices as UnknownRecord).unit_quantity_minor, '1')
                      : undefined,
                  rounding: (m.meter_prices as UnknownRecord).rounding
                    ? ((m.meter_prices as UnknownRecord).rounding as PriceRounding)
                    : undefined,
                  unit_cost_xusd:
                    (m.meter_prices as UnknownRecord).unit_cost_xusd !== undefined
                      ? readString((m.meter_prices as UnknownRecord).unit_cost_xusd, '0')
                      : undefined,
                  cost_unit_quantity_minor:
                    (m.meter_prices as UnknownRecord).cost_unit_quantity_minor !== undefined
                      ? readString((m.meter_prices as UnknownRecord).cost_unit_quantity_minor, '1')
                      : undefined,
                  cost_rounding: (m.meter_prices as UnknownRecord).cost_rounding
                    ? ((m.meter_prices as UnknownRecord).cost_rounding as PriceRounding)
                    : undefined,
                  effective_at: parseDateMaybe((m.meter_prices as UnknownRecord).effective_at) ?? undefined,
                }
              : undefined,
        }))
      : undefined,
  }))

  const meters: MeterSpec[] = mapRecords(raw.meters, (record) => {
    const meterPriceRaw = (record.meter_prices ?? {}) as Record<string, unknown>
    const meterPrice =
      record.meter_prices !== undefined
        ? {
            realm_id: readTrimmedString(record.realm_id ?? realmId, realmId),
            meter_code: readTrimmedString(record.meter_code),
            unit_price_xusd: meterPriceRaw.unit_price_xusd
              ? readString(meterPriceRaw.unit_price_xusd, '0')
              : meterPriceRaw.unit_price
                ? readString(meterPriceRaw.unit_price, '0')
                : undefined,
            unit_price_base_xusd: meterPriceRaw.unit_price_base_xusd
              ? readString(meterPriceRaw.unit_price_base_xusd, '0')
              : meterPriceRaw.unit_price_base
                ? readString(meterPriceRaw.unit_price_base, '0')
                : meterPriceRaw.unit_price
                  ? readString(meterPriceRaw.unit_price, '0')
                  : undefined,
            unit_price_dynamic_xusd: meterPriceRaw.unit_price_dynamic_xusd
              ? readString(meterPriceRaw.unit_price_dynamic_xusd, '0')
              : undefined,
            unit_quantity_minor: meterPriceRaw.unit_quantity_minor
              ? readString(meterPriceRaw.unit_quantity_minor, '1')
              : undefined,
            rounding: meterPriceRaw.rounding ? (meterPriceRaw.rounding as PriceRounding) : undefined,
            unit_cost_xusd: meterPriceRaw.unit_cost_xusd ? readString(meterPriceRaw.unit_cost_xusd, '0') : undefined,
            cost_unit_quantity_minor: meterPriceRaw.cost_unit_quantity_minor
              ? readString(meterPriceRaw.cost_unit_quantity_minor, '1')
              : undefined,
            cost_rounding: meterPriceRaw.cost_rounding
              ? (meterPriceRaw.cost_rounding as PriceRounding)
              : meterPriceRaw.rounding
                ? (meterPriceRaw.rounding as PriceRounding)
                : undefined,
            effective_at: parseDateMaybe(meterPriceRaw.effective_at) ?? undefined,
          }
        : undefined

	    return {
	      realm_id: readTrimmedString(record.realm_id ?? realmId, realmId),
	      meter_code: readTrimmedString(record.meter_code),
	      feature_code: readTrimmedString(record.feature_code ?? record.feature ?? '', '') || undefined,
	      unit: readTrimmedString(record.unit ?? '', '') || undefined,
	      scale: record.scale === undefined ? undefined : readNumber(record.scale, 0),
	      rounding: (record.rounding ?? undefined) as RoundingMode | undefined,
	      semantic_kind: record.semantic_kind === undefined
	        ? undefined
	        : ((() => {
	            const kind = readTrimmedString(record.semantic_kind, '').toLowerCase()
	            if (kind === 'activity' || kind === 'outcome') return kind as MeterSemanticKind
	            throw new Error(`importer: invalid semantic_kind: ${kind}`)
	          })()),
	      active: record.active === undefined ? undefined : readBoolean(record.active, true),
	      metadata: record.metadata === undefined ? undefined : normalizeMetadata(record.metadata),
	      meter_prices: meterPrice,
	    }
	  })

  const featureMeters: FeatureMeterSpec[] = mapRecords(raw.feature_meters, (record) => {
    const hasPrimary = Object.prototype.hasOwnProperty.call(record, 'is_primary')
    const hasMetadata = Object.prototype.hasOwnProperty.call(record, 'metadata')
    return {
      realm_id: readTrimmedString(record.realm_id ?? realmId, realmId),
      feature_code: readTrimmedString(record.feature_code),
      meter_code: readTrimmedString(record.meter_code),
      is_primary: hasPrimary ? readBoolean(record.is_primary, false) : undefined,
      metadata: hasMetadata ? normalizeMetadata(record.metadata) : undefined,
    }
  })

  const gatePolicies: GatePolicySpec[] = mapRecords(raw.gate_policies, (record) => ({
    realm_id: readTrimmedString(record.realm_id ?? realmId, realmId),
    bundle_key: readTrimmedString(record.bundle_key ?? record.bundle ?? DEFAULT_BUNDLE_KEY, DEFAULT_BUNDLE_KEY),
    feature_code: readTrimmedString(record.feature_code),
    name: readTrimmedString(record.name),
    description: readTrimmedString(record.description ?? ''),
    kind: (record.kind ?? 'rate') as GatePolicyKind,
    subject_scope: readGatePolicySubjectScope(record.subject_scope ?? record.subjectScope),
    unit: readTrimmedString(record.unit ?? 'request'),
    window_sec: readNumber(record.window_sec, 0),
    limit_minor: record.limit_minor === null || record.limit_minor === undefined ? null : readString(record.limit_minor, '0'),
    limit_count: record.limit_count === null || record.limit_count === undefined ? null : readString(record.limit_count, '0'),
    status: (record.status ?? 'ceiling') as GatePolicyStatus,
    enforcement_mode: (record.enforcement_mode ?? 'optimistic') as GatePolicyEnforcement,
    metadata: normalizeMetadata(record.metadata),
  }))

  const meterPrices: MeterPriceSpec[] = mapRecords(raw.meter_prices, (record) => ({
    realm_id: readTrimmedString(record.realm_id ?? realmId, realmId),
    meter_code: readTrimmedString(record.meter_code),
    unit_price_xusd: readString(record.unit_price_xusd ?? '0', '0'),
    unit_price_base_xusd: readString(record.unit_price_base_xusd ?? record.unit_price_xusd ?? '0', '0'),
    unit_price_dynamic_xusd: readString(record.unit_price_dynamic_xusd ?? '0', '0'),
    unit_quantity_minor: readString(record.unit_quantity_minor ?? '1', '1'),
    rounding: (record.rounding ?? 'nearest') as PriceRounding,
    unit_cost_xusd: readString(record.unit_cost_xusd ?? record.unit_price_xusd ?? '0', '0'),
    cost_unit_quantity_minor: readString(record.cost_unit_quantity_minor ?? record.unit_quantity_minor ?? '1', '1'),
    cost_rounding: (record.cost_rounding ?? record.rounding ?? 'nearest') as PriceRounding,
    effective_at: parseDateMaybe(record.effective_at) ?? undefined,
  }))

  const grantCampaigns: GrantCampaignSpec[] = mapRecords(raw.grant_campaigns, (record) => {
    const realm = readTrimmedString(record.realm_id ?? realmId, realmId)
    const status = (record.status ?? 'scheduled') as GrantCampaignStatus
    const windowStart = parseDateMaybe(record.window_start) ?? new Date()
    const windowEnd = parseDateMaybe(record.window_end)
    const meta = normalizeMetadata(record.metadata)
    const rawBindings = (record as Record<string, unknown>).grants ?? meta.grants
    const bindings = Array.isArray(rawBindings) ? rawBindings : rawBindings ? [rawBindings] : []
    const explicitProgramCode = readOptionalString(record.grant_program_code ?? record.program_code ?? record.programCode)
    const bindingCodes = new Set(
      bindings
        .map((entry) => (entry && typeof entry === 'object' ? entry as Record<string, unknown> : null))
        .map((entry) => readOptionalString(entry?.grant_program_code ?? entry?.program_code ?? entry?.programCode))
        .filter((code): code is string => Boolean(code)),
    )
    if (explicitProgramCode && !bindingCodes.has(explicitProgramCode)) {
      bindings.push({ grant_program_code: explicitProgramCode })
    }
    if (bindings.length > 0) {
      meta.grants = bindings
    }
    return {
      realm_id: realm,
      name: readTrimmedString(record.name),
      status,
      window_start: windowStart,
      window_end: windowEnd,
      target_filter: normalizeMetadata(record.target_filter),
      metadata: meta,
    }
  })

  const grantPrograms: GrantProgramSpec[] = mapRecords(raw.grant_programs, (record) => {
    const programCode = readTrimmedString(record.program_code ?? record.programCode ?? record.slug)
    const realmForProfile = readTrimmedString(record.realm_id ?? realmId, realmId)
    const name = readOptionalString(record.name)
    const active = record.active === undefined ? true : readBoolean(record.active, true)
    const cadence = (record.cadence ?? 'monthly') as GrantCadence
    const issueAnchor = (record.issue_anchor ?? 'calendar_start') as GrantIssueAnchor
    const amountRaw = record.amount_xusd ?? record.amount
    const amount = amountRaw === undefined || amountRaw === null ? '0' : readString(amountRaw, '0')
    const windowKind = (record.window_kind ?? 'period') as GrantWindowKind
    const windowSecondsRaw = record.window_default_seconds ?? record.window_seconds ?? null
    const windowDefaultSeconds = windowSecondsRaw === null || windowSecondsRaw === undefined ? null : readNumber(windowSecondsRaw)
    const priorityRaw = record.priority === undefined || record.priority === null ? 0 : readNumber(record.priority)
    const onLedger = record.on_ledger === undefined ? false : readBoolean(record.on_ledger, false)
    const issuanceMode = (record.issuance_mode ?? 'eager') as GrantIssuanceMode
    const periodicAccounting = record.periodic_accounting === undefined ? false : readBoolean(record.periodic_accounting, false)
    const accrualModeRaw = record.accrual_mode ?? record.accrual
    const accrualMode = accrualModeRaw === null || accrualModeRaw === undefined
      ? null
      : (String(accrualModeRaw) as GrantAccrualMode)
    const normalizedWindowSeconds = typeof windowDefaultSeconds === 'number' && Number.isFinite(windowDefaultSeconds)
      ? Math.trunc(windowDefaultSeconds)
      : null
    const normalizedPriority = Number.isFinite(priorityRaw) ? Math.trunc(priorityRaw) : 0
    return {
      realm_id: realmForProfile,
      program_code: programCode,
      name,
      active,
      cadence,
      issue_anchor: issueAnchor,
      amount_xusd: amount,
      window_kind: windowKind,
      window_default_seconds: normalizedWindowSeconds,
      priority: normalizedPriority,
      on_ledger: onLedger,
      issuance_mode: issuanceMode,
      periodic_accounting: periodicAccounting,
      accrual_mode: accrualMode === 'full_at_period_start' || accrualMode === 'earn_daily' ? accrualMode : null,
      metadata: normalizeMetadata(record.metadata),
    } satisfies GrantProgramSpec
  })

  const billingPlans: BillingPlanSpec[] = mapRecords(raw.billing_plans, (record) => {
    const kind = (record.kind ?? 'base') as 'base' | 'addon' | 'promo'
    return {
      realm_id: readTrimmedString(record.realm_id ?? realmId, realmId),
      plan_code: readTrimmedString(record.plan_code ?? record.planCode ?? record.slug),
      name: readTrimmedString(record.name ?? record.plan_code ?? record.slug ?? ''),
      kind,
      priority: record.priority === undefined ? 0 : readNumber(record.priority, 0),
      active: record.active === undefined ? true : readBoolean(record.active, true),
      metadata: normalizeMetadata(record.metadata),
      feature_codes: readStringArray(record.feature_codes),
      feature_family_codes: readStringArray(record.feature_family_codes),
    } satisfies BillingPlanSpec
  })

  const billingAccounts: BillingAccountSpec[] = mapRecords(raw.billing_accounts, (record) => ({
    realm_id: realmId,
    billing_account_id: readTrimmedString(record.billing_account_id ?? record.id),
    billing_principal_id: readTrimmedString(record.billing_principal_id ?? record.principal_id ?? record.principal),
    metadata: record.metadata === undefined ? undefined : normalizeMetadata(record.metadata),
  }))

  const eventRatingPolicies: EventRatingPolicySpec[] = mapRecords(raw.event_rating_policies, (record) => ({
    realm_id: realmId,
    policy_id: readTrimmedString(record.policy_id ?? record.id),
    name: readTrimmedString(record.name ?? record.policy_id ?? ''),
    status: (record.status ?? 'active') as EventRatingPolicyStatus,
  }))

  const eventRatingPolicyVersions: EventRatingPolicyVersionSpec[] = mapRecords(raw.event_rating_policy_versions, (record) => {
    const effectiveAt = parseDateMaybe(record.effective_at) ?? new Date(Number.NaN)
    return {
      realm_id: realmId,
      policy_id: readTrimmedString(record.policy_id ?? record.id),
      policy_version: readTrimmedString(record.policy_version ?? record.version),
      status: (record.status ?? 'active') as EventRatingPolicyVersionStatus,
      effective_at: effectiveAt,
      dsl_json: normalizeMetadata(record.dsl_json ?? record.dsl),
      dsl_hash: readTrimmedString(record.dsl_hash ?? record.hash),
    } satisfies EventRatingPolicyVersionSpec
  })

  const billingContracts: BillingContractSpec[] = mapRecords(raw.billing_contracts, (record) => {
    const effectiveAt = parseDateMaybe(record.effective_at) ?? new Date(Number.NaN)
    return {
      realm_id: realmId,
      contract_id: readTrimmedString(record.contract_id),
      billing_account_id: readTrimmedString(record.billing_account_id),
      status: (record.status ?? 'active') as BillingContractStatus,
      effective_at: effectiveAt,
      name: readOptionalString(record.name),
      metadata: record.metadata === undefined ? undefined : normalizeMetadata(record.metadata),
    } satisfies BillingContractSpec
  })

  const contractTerms: ContractTermSpec[] = mapRecords(raw.contract_terms, (record) => {
    const effectiveAt = parseDateMaybe(record.effective_at) ?? new Date(Number.NaN)
    const kindRaw = readOptionalString(record.kind) ?? 'e2r_param'
    const kind: ContractTermKind = kindRaw === 'pricing' || kindRaw === 'e2r_param' ? kindRaw : 'e2r_param'
    return {
      realm_id: realmId,
      contract_id: readTrimmedString(record.contract_id),
      kind,
      term_key: normalizeIdentifier(readTrimmedString(record.term_key), 'term_key'),
      effective_at: effectiveAt,
      value_json: record.value_json,
    } satisfies ContractTermSpec
  })

  if (strict) {
    for (const feature of features) {
      if (!feature.feature_code) throw new Error('importer: feature entry missing feature_code')
    }
    for (const program of grantPrograms) {
      if (!program.program_code) throw new Error('importer: grant_program entry missing program_code')
    }
    for (const plan of billingPlans) {
      if (!plan.plan_code) throw new Error('importer: billing_plan entry missing plan_code')
    }
    for (const account of billingAccounts) {
      if (!account.billing_account_id) throw new Error('importer: billing_account entry missing billing_account_id')
      if (!account.billing_principal_id) {
        throw new Error(`importer: billing_account ${account.billing_account_id} missing billing_principal_id`)
      }
    }
    for (const campaign of grantCampaigns) {
      if (!campaign.name) throw new Error('importer: grant_campaign entry missing name')
      const bindingRaw = (campaign.metadata as Record<string, unknown>).grants
      const bindings = Array.isArray(bindingRaw) ? bindingRaw : bindingRaw ? [bindingRaw] : []
      const bindingCodes = bindings
        .map((entry) => (entry && typeof entry === 'object' ? entry as Record<string, unknown> : null))
        .map((entry) => readOptionalString(entry?.grant_program_code ?? entry?.program_code ?? entry?.programCode))
        .filter((code): code is string => Boolean(code))
      if (bindingCodes.length === 0) {
        throw new Error('importer: grant_campaign entry missing grants program_code')
      }
    }
    for (const policy of eventRatingPolicies) {
      if (!policy.policy_id) throw new Error('importer: event_rating_policy entry missing policy_id')
      if (!policy.name) throw new Error(`importer: event_rating_policy ${policy.policy_id} missing name`)
    }
    for (const version of eventRatingPolicyVersions) {
      if (!version.policy_id) throw new Error('importer: event_rating_policy_version entry missing policy_id')
      if (!version.policy_version) throw new Error(`importer: event_rating_policy_version ${version.policy_id} missing policy_version`)
      if (!version.dsl_hash) {
        throw new Error(`importer: event_rating_policy_version ${version.policy_id}:${version.policy_version} missing dsl_hash`)
      }
      const dslVersion = typeof version.dsl_json?.dsl_version === 'string' ? String(version.dsl_json.dsl_version) : ''
      if (!dslVersion) {
        throw new Error(`importer: event_rating_policy_version ${version.policy_id}:${version.policy_version} missing dsl_json.dsl_version`)
      }
      if (!(version.effective_at instanceof Date) || Number.isNaN(version.effective_at.valueOf())) {
        throw new Error(`importer: event_rating_policy_version ${version.policy_id}:${version.policy_version} missing effective_at`)
      }
    }
    for (const contract of billingContracts) {
      if (!contract.contract_id) throw new Error('importer: billing_contract entry missing contract_id')
      if (!contract.billing_account_id) throw new Error(`importer: billing_contract ${contract.contract_id} missing billing_account_id`)
      if (!(contract.effective_at instanceof Date) || Number.isNaN(contract.effective_at.valueOf())) {
        throw new Error(`importer: billing_contract ${contract.contract_id} missing effective_at`)
      }
    }
    for (const term of contractTerms) {
      if (!term.contract_id) throw new Error('importer: contract_term entry missing contract_id')
      if (!term.kind) throw new Error(`importer: contract_term ${term.contract_id} missing kind`)
      if (!term.term_key) throw new Error(`importer: contract_term ${term.contract_id} missing term_key`)
      if (!(term.effective_at instanceof Date) || Number.isNaN(term.effective_at.valueOf())) {
        throw new Error(`importer: contract_term ${term.contract_id}:${term.term_key} missing effective_at`)
      }
    }
  }

  return {
    realm_id: realmId,
    feature_families,
    catalogProducts,
    catalogPrices,
    catalogSubscriptionGroups,
    features,
    meters,
    featureMeters,
    gatePolicies,
    meterPrices,
    grantCampaigns,
    grantPrograms,
    billingPlans,
    billingAccounts,
    eventRatingPolicies,
    eventRatingPolicyVersions,
    billingContracts,
    contractTerms,
  }
}

async function loadBillingImportSpec(filePath: string, strict = false): Promise<BillingImportSpec> {
  const abs = resolveFile(filePath)
  const raw = await fs.readFile(abs, 'utf8')
  const data = YAML.parse(raw)
  if (!data || typeof data !== 'object') {
    throw new Error('importer: YAML root must be an object')
  }
  const realmDataRaw = Array.isArray(data.realm_data) ? data.realm_data : Array.isArray(data.realms_data) ? data.realms_data : null

  const realmBundles: RealmDataSpec[] = []
  if (realmDataRaw) {
    for (const entry of realmDataRaw) {
      realmBundles.push(parseRealmBundle(asRecord(entry), strict))
    }
  } else if (!Array.isArray(data.realms) || data.realms.length === 0) {
    throw new Error('importer: provide realm_data[] or at least one realm in realms[]')
  }

  const realmIdsFromBundles = realmBundles.map((r) => r.realm_id)

  const explicitRealms: RealmSpec[] = mapRecords(data.realms, (record) => ({
    realm_id: readTrimmedString(record.realm_id ?? record.id, ''),
    name: readTrimmedString(record.name ?? record.display_name ?? record.realm_id ?? '', ''),
    status: (record.status ?? 'active') as RealmStatus,
    metadata: normalizeMetadata(record.metadata),
  }))
    .filter((realm) => realm.realm_id)
    .map((realm) => applyRealmMetadataOverride(realm))

  const realms: RealmSpec[] = [...explicitRealms]
  const realmIds = Array.from(new Set([...realmIdsFromBundles, ...realms.map((r) => r.realm_id)]))

  const currencies: CurrencySpec[] = mapRecords(data.currencies, (record) => ({
    code: readUppercaseString(record.code, ''),
    kind: ((record.kind ?? 'fiat') as CurrencyKind) || 'fiat',
    scale: readNumber(record.scale, 0),
  }))

  const serviceApiKeys: ServiceApiKeySpec[] = mapRecords(data.service_api_keys, (record) => {
    const keyId = readTrimmedString(record.key_id)
    const kdfAlg = (record.kdf_alg ?? 'HKDF-SHA256') as 'HMAC-SHA256' | 'HKDF-SHA256'
    const kdfSalt = parseHexBuffer(record.kdf_salt_hex ?? record.kdf_salt)
    if (!keyId) throw new Error('importer: service_api_keys entry missing key_id')
    if (!kdfSalt) throw new Error(`importer: service_api_keys ${keyId} missing valid kdf_salt_hex`)
    const expiresAt = Object.prototype.hasOwnProperty.call(record, 'expires_at') ? parseDateMaybe(record.expires_at) : undefined
    const lastUsedAt = Object.prototype.hasOwnProperty.call(record, 'last_used_at') ? parseDateMaybe(record.last_used_at) : undefined
    return {
      key_id: keyId,
      status: readTrimmedString(record.status, 'active'),
      allowed_realms: readStringArray(record.allowed_realms),
      allowed_accounts: readStringArray(record.allowed_accounts),
      scopes: readStringArray(record.scopes),
      kdf_alg: kdfAlg,
      kdf_salt: kdfSalt,
      kdf_version: readNumber(record.kdf_version, 1),
      env_tag: readTrimmedString(record.env_tag),
      expires_at: expiresAt,
      last_used_at: lastUsedAt,
    }
  })

  const feature_families = realmBundles.flatMap((b) => b.feature_families)
  const features = realmBundles.flatMap((b) => b.features)
  const meters = realmBundles.flatMap((b) => b.meters)
  const featureMeters = realmBundles.flatMap((b) => b.featureMeters)
  const gatePolicies = realmBundles.flatMap((b) => b.gatePolicies)
  const meterPrices = realmBundles.flatMap((b) => b.meterPrices)
  const grantCampaigns = realmBundles.flatMap((b) => b.grantCampaigns)
  const grantPrograms = realmBundles.flatMap((b) => b.grantPrograms)
  const billingPlans = realmBundles.flatMap((b) => b.billingPlans ?? [])
  const billingAccounts = realmBundles.flatMap((b) => b.billingAccounts ?? [])
  const eventRatingPolicies = realmBundles.flatMap((b) => b.eventRatingPolicies ?? [])
  const eventRatingPolicyVersions = realmBundles.flatMap((b) => b.eventRatingPolicyVersions ?? [])
  const billingContracts = realmBundles.flatMap((b) => b.billingContracts ?? [])
  const contractTerms = realmBundles.flatMap((b) => b.contractTerms ?? [])

  const bundleCatalogProducts = realmBundles.flatMap((b) => b.catalogProducts ?? [])
  const bundleCatalogPrices = realmBundles.flatMap((b) => b.catalogPrices ?? [])
  const bundleCatalogSubscriptionGroups = realmBundles.flatMap((b) => b.catalogSubscriptionGroups ?? [])
  const defaultRealm = realmIds[0] ?? ''

  const catalogProducts = [...mapRecords(data.catalog_products, (record) => ({
    catalog_product_id: readOptionalUuid(record.catalog_product_id, 'catalog_product_id'),
    realm_id: readTrimmedString(record.realm_id ?? defaultRealm, defaultRealm),
    product_code: readTrimmedString(record.product_code),
    provider: readTrimmedString(record.provider, 'stripe'),
    provider_product_id: readTrimmedString(record.provider_product_id ?? record.product_code),
    kind: (record.kind ?? 'subscription') as ProductKind,
    status: (record.status ?? 'draft') as ProductStatus,
    display_priority: readNumber(record.display_priority, 100),
    name: readTrimmedString(record.name),
    default_currency: readUppercaseString(record.default_currency ?? 'USD'),
  })), ...bundleCatalogProducts]

  const catalogPrices = [...mapRecords(data.catalog_prices, (record) => {
    const recurringInterval = readCatalogPriceRecurringInterval(record)
    return {
      catalog_price_id: readOptionalUuid(record.catalog_price_id, 'catalog_price_id'),
      realm_id: readTrimmedString(record.realm_id ?? defaultRealm, defaultRealm),
      price_code: readTrimmedString(record.price_code),
      product_code: readTrimmedString(record.product_code),
      provider_price_id: readTrimmedString(record.provider_price_id ?? record.price_code),
      currency: readUppercaseString(record.currency ?? 'USD'),
      unit_amount: readNumber(record.unit_amount, 0),
      recurring_interval: recurringInterval,
      recurring_count: record.recurring_count === null || record.recurring_count === undefined ? null : readNumber(record.recurring_count),
      display_priority: readNumber(record.display_priority, 100),
      metadata: normalizeMetadata(record.metadata),
      subscription_group_key: readCatalogPriceSubscriptionGroupKey(record, recurringInterval),
    }
  }), ...bundleCatalogPrices]

  const catalogSubscriptionGroups = [...mapRecords(
    data.subscription_groups,
    (record) => ({
      realm_id: readTrimmedString(record.realm_id ?? '', ''),
      group_key: readTrimmedString(record.group_key),
      title: readTrimmedString(record.title ?? record.group_key),
      is_stackable: readBoolean(record.is_stackable, false),
      is_exclusive: record.is_exclusive === undefined ? true : readBoolean(record.is_exclusive, true),
    }),
  ), ...bundleCatalogSubscriptionGroups]

  // de-duplicate catalog entities by natural keys, keep later (realm_data) entries overriding earlier ones
  const dedupeByKey = <T>(items: T[], keyFn: (item: T) => string): T[] => {
    const map = new Map<string, T>()
    for (const item of items) {
      const key = keyFn(item)
      if (key) map.set(key, item)
    }
    return Array.from(map.values())
  }

  const catalogProductsDeduped = dedupeByKey(catalogProducts, (p) => p.product_code)
  const catalogPricesDeduped = dedupeByKey(catalogPrices, (p) => p.price_code)
  const inferredSubscriptionGroups: CatalogSubscriptionGroupSpec[] = []
  for (const price of catalogPricesDeduped) {
    if (!price.recurring_interval) continue
    if (!price.subscription_group_key) {
      throw new Error(`importer: subscription price ${price.price_code} missing subscription_group_key`)
    }
    inferredSubscriptionGroups.push({
      realm_id: price.realm_id,
      group_key: price.subscription_group_key,
      title: price.subscription_group_key,
      is_stackable: false,
      is_exclusive: true,
    })
  }

  const catalogSubscriptionGroupsDeduped = dedupeByKey(
    [...inferredSubscriptionGroups, ...catalogSubscriptionGroups],
    (g) => `${g.realm_id}::${g.group_key}`,
  )
  const feature_familiesDeduped = dedupeByKey(feature_families, (c) => `${c.realm_id}::${c.feature_family_code}`)

  if (strict) {
    for (const cap of feature_familiesDeduped) {
      if (!cap.realm_id) throw new Error('importer: feature_family entry missing realm_id')
      if (!cap.feature_family_code) throw new Error('importer: feature_family entry missing feature_family_code')
    }
    for (const product of catalogProductsDeduped) {
      if (!product.realm_id) throw new Error(`importer: catalog_product ${product.product_code} missing realm_id`)
      if (!product.product_code) throw new Error('importer: catalog_product.entry missing product_code')
    }
    for (const price of catalogPricesDeduped) {
      if (!price.realm_id) throw new Error(`importer: catalog_price ${price.price_code} missing realm_id`)
      if (!price.price_code) throw new Error('importer: catalog_price.entry missing price_code')
      if (!price.product_code) throw new Error(`importer: price ${price.price_code} missing product_code`)
    }
    for (const group of catalogSubscriptionGroupsDeduped) {
      if (!group.realm_id) throw new Error(`importer: subscription_group ${group.group_key} missing realm_id`)
      if (!group.group_key) throw new Error('importer: subscription_group entry missing group_key')
    }
    for (const key of serviceApiKeys) {
      if (!key.key_id) throw new Error('importer: service_api_key entry missing key_id')
    }
  }

  return {
    realmId: realmIds[0],
    realmIds,
    realms,
    currencies,
    serviceApiKeys,
    feature_families: feature_familiesDeduped,
    catalogProducts: catalogProductsDeduped,
    catalogPrices: catalogPricesDeduped,
    catalogSubscriptionGroups: catalogSubscriptionGroupsDeduped,
    realmsData: realmBundles,
    features,
    meters,
    featureMeters,
    gatePolicies,
    meterPrices,
    grantCampaigns,
    grantPrograms,
    billingPlans,
    billingAccounts,
    eventRatingPolicies,
    eventRatingPolicyVersions,
    billingContracts,
    contractTerms,
  }
}

async function ensurePrimaryFeatureConstraint(spec: BillingImportSpec, _strict: boolean): Promise<void> {
  const perFeature = new Map<string, number>()
  for (const fm of spec.featureMeters) {
    if (fm.is_primary && fm.meter_code !== fm.feature_code) {
      throw new Error(
        `importer: feature_meters primary meter must equal feature_code (${fm.feature_code}) in realm ${fm.realm_id}`,
      )
    }
    if (fm.is_primary) {
      const key = `${fm.realm_id}::${fm.feature_code}`
      perFeature.set(key, (perFeature.get(key) ?? 0) + 1)
    }
  }
  const conflicts = Array.from(perFeature.entries()).filter(([, count]) => count > 1)
  if (conflicts.length > 0) {
    const message = conflicts.map(([k, count]) => `${k} has ${count} primary meters`).join('; ')
    throw new Error(`importer: feature_meters primary constraint violated: ${message}`)
  }
}

type ProductIdMap = Map<string, string>
type PriceIdMap = Map<string, { id: string; productId: string }>
type FeatureIdMap = Map<string, string>
type MeterIdMap = Map<string, string>
type ProfileIdMap = Map<string, string>

async function upsertRealms(trx: Transaction<Database>, spec: BillingImportSpec, summary: ImportSummary): Promise<void> {
  const existing = await trx.selectFrom('realms').select(['realm_id', 'name', 'status', 'metadata']).execute()
  const byId = new Map(existing.map((r) => [r.realm_id, r]))

  // Validate that every realm referenced by realm_data already exists or is declared explicitly.
  const explicitRealmIds = new Set(spec.realms.map((r) => r.realm_id))
  const missingImplicit = spec.realmIds
    .filter((realmId) => !explicitRealmIds.has(realmId))
    .filter((realmId) => !byId.has(realmId))
  if (missingImplicit.length > 0) {
    throw new Error(
      `importer: realms missing: ${missingImplicit.join(
        ', ',
      )}; declare them under realms[] or create them before importing realm_data`,
    )
  }

  for (const realm of spec.realms) {
    const current = byId.get(realm.realm_id)
    const incomingMetadata = realm.metadata ?? {}
    const hasIncomingMetadata = Object.keys(incomingMetadata).length > 0
    const mergedMetadata = mergeRealmMetadata(
      current?.metadata,
      hasIncomingMetadata ? incomingMetadata : current?.metadata,
    )
    realm.metadata = mergedMetadata

    if (!current) {
      await trx
        .insertInto('realms')
        .values({
          realm_id: realm.realm_id,
          name: realm.name,
          status: realm.status,
          metadata: realm.metadata,
        })
        .executeTakeFirst()
      bump(summary, 'realms', 'created')
      recordCreated(summary, 'realms', { realm_id: realm.realm_id })
    } else {
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      if (current.name !== realm.name) changes.name = { current: current.name, next: realm.name }
      if (current.status !== realm.status) changes.status = { current: current.status, next: realm.status }
      if (!deepEqual(current.metadata, realm.metadata)) changes.metadata = { current: current.metadata, next: realm.metadata }
      const needsUpdate = Object.keys(changes).length > 0
      if (needsUpdate) {
        await trx
          .updateTable('realms')
          .set({ name: realm.name, status: realm.status, metadata: realm.metadata })
          .where('realm_id', '=', realm.realm_id)
          .executeTakeFirst()
        bump(summary, 'realms', 'updated')
        recordUpdated(summary, 'realms', realm.realm_id, changes)
      } else {
        bump(summary, 'realms', 'unchanged')
      }
    }
  }
}

async function upsertCurrencies(trx: Transaction<Database>, spec: BillingImportSpec, summary: ImportSummary): Promise<void> {
  const existing = await trx.selectFrom('currencies').select(['code', 'kind', 'scale']).execute()
  const byCode = new Map(existing.map((c) => [c.code, c]))
  for (const currency of spec.currencies) {
    const current = byCode.get(currency.code)
    if (!current) {
      await trx.insertInto('currencies').values(currency).executeTakeFirst()
      bump(summary, 'currencies', 'created')
      recordCreated(summary, 'currencies', { code: currency.code })
    } else {
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      if (current.kind !== currency.kind) changes.kind = { current: current.kind, next: currency.kind }
      if (Number(current.scale) !== Number(currency.scale)) changes.scale = { current: current.scale, next: currency.scale }
      const needsUpdate = Object.keys(changes).length > 0
      if (needsUpdate) {
        await trx
          .updateTable('currencies')
          .set({ kind: currency.kind, scale: currency.scale })
          .where('code', '=', currency.code)
          .executeTakeFirst()
        bump(summary, 'currencies', 'updated')
        recordUpdated(summary, 'currencies', currency.code, changes)
      } else {
        bump(summary, 'currencies', 'unchanged')
      }
    }
  }
}

async function upsertServiceApiKeys(trx: Transaction<Database>, spec: BillingImportSpec, summary: ImportSummary, opts: ApplyOptions): Promise<void> {
  const rows = await trx
    .selectFrom('service_api_keys')
    .select([
      'key_id',
      'status',
      'allowed_realms',
      'allowed_accounts',
      'scopes',
      'kdf_alg',
      'kdf_salt',
      'kdf_version',
      'env_tag',
      'expires_at',
      'last_used_at',
    ] satisfies ReadonlyArray<keyof Database['service_api_keys']>)
    .execute()
  const byId = new Map(rows.map((r) => [r.key_id, r]))
  const desired = new Set<string>()
  for (const key of spec.serviceApiKeys) {
    desired.add(key.key_id)
    const current = byId.get(key.key_id)
    if (!current) {
      await trx
        .insertInto('service_api_keys')
        .values({
          key_id: key.key_id,
          status: key.status,
          allowed_realms: key.allowed_realms,
          allowed_accounts: key.allowed_accounts,
          scopes: key.scopes,
          kdf_alg: key.kdf_alg,
          kdf_salt: key.kdf_salt,
          kdf_version: key.kdf_version,
          env_tag: key.env_tag,
          expires_at: key.expires_at ?? null,
          last_used_at: key.last_used_at ?? null,
        })
        .executeTakeFirst()
      bump(summary, 'service_api_keys', 'created')
      recordCreated(summary, 'service_api_keys', { key_id: key.key_id })
    } else {
      const updates: Record<string, unknown> = {}
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      if (current.status !== key.status) {
        updates.status = key.status
        changes.status = { current: current.status, next: key.status }
      }
      if (!arraysEqual(current.allowed_realms, key.allowed_realms)) {
        updates.allowed_realms = key.allowed_realms
        changes.allowed_realms = { current: current.allowed_realms, next: key.allowed_realms }
      }
      if (!arraysEqual(current.allowed_accounts, key.allowed_accounts)) {
        updates.allowed_accounts = key.allowed_accounts
        changes.allowed_accounts = { current: current.allowed_accounts, next: key.allowed_accounts }
      }
      if (!arraysEqual(current.scopes, key.scopes)) {
        updates.scopes = key.scopes
        changes.scopes = { current: current.scopes, next: key.scopes }
      }
      if (current.kdf_alg !== key.kdf_alg) {
        updates.kdf_alg = key.kdf_alg
        changes.kdf_alg = { current: current.kdf_alg, next: key.kdf_alg }
      }
      if (Buffer.compare(current.kdf_salt, key.kdf_salt) !== 0) {
        updates.kdf_salt = key.kdf_salt
        changes.kdf_salt = { current: '[redacted]', next: '[redacted]' }
      }
      if (Number(current.kdf_version) !== Number(key.kdf_version)) {
        updates.kdf_version = key.kdf_version
        changes.kdf_version = { current: current.kdf_version, next: key.kdf_version }
      }
      if (current.env_tag !== key.env_tag) {
        updates.env_tag = key.env_tag
        changes.env_tag = { current: current.env_tag, next: key.env_tag }
      }
      if (key.expires_at !== undefined) {
        const currentExpires = current.expires_at ? new Date(current.expires_at).toISOString() : null
        const nextExpires = key.expires_at ? key.expires_at.toISOString() : null
        if (currentExpires !== nextExpires) {
          updates.expires_at = key.expires_at ?? null
          changes.expires_at = { current: currentExpires, next: nextExpires }
        }
      }
      if (key.last_used_at !== undefined) {
        const currentLast = current.last_used_at ? new Date(current.last_used_at).toISOString() : null
        const nextLast = key.last_used_at ? key.last_used_at.toISOString() : null
        if (currentLast !== nextLast) {
          updates.last_used_at = key.last_used_at ?? null
          changes.last_used_at = { current: currentLast, next: nextLast }
        }
      }
      if (Object.keys(updates).length > 0) {
        await trx.updateTable('service_api_keys').set(updates).where('key_id', '=', key.key_id).executeTakeFirst()
        bump(summary, 'service_api_keys', 'updated')
        recordUpdated(summary, 'service_api_keys', key.key_id, changes)
      } else {
        bump(summary, 'service_api_keys', 'unchanged')
      }
    }
  }
  if (opts.mode === 'replace') {
    for (const [keyId, _current] of byId.entries()) {
      if (!desired.has(keyId)) {
        await trx
          .updateTable('service_api_keys')
          .set({ status: 'disabled' })
          .where('key_id', '=', keyId)
          .executeTakeFirst()
        bump(summary, 'service_api_keys', 'disabled')
        recordDisabled(summary, 'service_api_keys', { key_id: keyId })
      }
    }
  }
}

async function upsertFeatureFamilies(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
): Promise<void> {
  if (spec.feature_families.length === 0) return
  const realmIds = Array.from(new Set(spec.feature_families.map((c) => c.realm_id))).filter(Boolean)
  const existing = await trx
    .selectFrom('feature_families')
    .select(['feature_family_id', 'realm_id', 'feature_family_code', 'name', 'description', 'active', 'metadata'])
    .where('realm_id', 'in', realmIds)
    .execute()
  const byKey = new Map<string, (typeof existing)[number]>()
  for (const row of existing) {
    byKey.set(`${row.realm_id}::${row.feature_family_code}`, row)
  }

  for (const cap of spec.feature_families) {
    const key = `${cap.realm_id}::${cap.feature_family_code}`
    const current = byKey.get(key)
    const name = cap.name || cap.feature_family_code
    const description = cap.description ?? ''
    const active = cap.active ?? true
    const metadata = cap.metadata ?? {}
    if (!current) {
      await trx
        .insertInto('feature_families')
        .values({
          realm_id: cap.realm_id,
          feature_family_code: cap.feature_family_code,
          name,
          description,
          active,
          metadata,
        })
        .executeTakeFirst()
      bump(summary, 'feature_families', 'created')
      recordCreated(summary, 'feature_families', { realm_id: cap.realm_id, feature_family_code: cap.feature_family_code })
    } else {
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      if (current.name !== name) changes.name = { current: current.name, next: name }
      if (current.description !== description) changes.description = { current: current.description, next: description }
      if (Boolean(current.active) !== Boolean(active)) changes.active = { current: current.active, next: active }
      if (JSON.stringify(current.metadata ?? {}) !== JSON.stringify(metadata ?? {})) {
        changes.metadata = { current: current.metadata ?? {}, next: metadata ?? {} }
      }
      const needsUpdate = Object.keys(changes).length > 0
      if (needsUpdate) {
        await trx
          .updateTable('feature_families')
          .set({
            name,
            description,
            active,
            metadata,
          })
          .where('realm_id', '=', cap.realm_id)
          .where('feature_family_code', '=', cap.feature_family_code)
          .executeTakeFirst()
        bump(summary, 'feature_families', 'updated')
        recordUpdated(summary, 'feature_families', key, changes)
      } else {
        bump(summary, 'feature_families', 'unchanged')
      }
    }
  }
}

async function upsertCatalogProducts(trx: Transaction<Database>, spec: BillingImportSpec, summary: ImportSummary): Promise<ProductIdMap> {
  const rows = await trx
    .selectFrom('catalog_products')
    .select([
      'catalog_product_id',
      'realm_id',
      'product_code',
      'provider',
      'provider_product_id',
      'kind',
      'status',
      'display_priority',
      'name',
      'default_currency',
    ])
    .execute()
  const byCode = new Map(rows.map((r) => [r.product_code, r]))
  const byId = new Map(rows.map((r) => [String(r.catalog_product_id), r]))
  const ids: ProductIdMap = new Map(rows.map((r) => [r.product_code, String(r.catalog_product_id)]))
  for (const product of spec.catalogProducts) {
    const targetRealm = product.realm_id || spec.realmId || spec.realmIds[0]
    if (!targetRealm) {
      throw new Error(`importer: catalog_product ${product.product_code} missing realm_id`)
    }
    const current = byCode.get(product.product_code)
    if (!current) {
      if (product.catalog_product_id) {
        const occupied = byId.get(product.catalog_product_id)
        if (occupied && occupied.product_code !== product.product_code) {
          throw new Error(`importer: catalog_product_id ${product.catalog_product_id} already belongs to product_code ${occupied.product_code}`)
        }
      }
      const inserted = await trx
        .insertInto('catalog_products')
        .values({
          ...(product.catalog_product_id ? { catalog_product_id: product.catalog_product_id } : {}),
          realm_id: targetRealm,
          product_code: product.product_code,
          provider: product.provider,
          provider_product_id: product.provider_product_id,
          kind: product.kind,
          status: product.status,
          display_priority: product.display_priority,
          name: product.name,
          default_currency: product.default_currency,
        })
        .returning(['catalog_product_id'])
        .executeTakeFirstOrThrow()
      ids.set(product.product_code, String(inserted.catalog_product_id))
      bump(summary, 'catalog_products', 'created')
      recordCreated(summary, 'catalog_products', { product_code: product.product_code })
    } else {
      if (current.realm_id !== targetRealm) {
        throw new Error(`importer: catalog_product ${product.product_code} already belongs to realm ${current.realm_id}, cannot upsert into ${targetRealm}`)
      }
      ids.set(product.product_code, String(current.catalog_product_id))
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      if (current.provider !== product.provider) changes.provider = { current: current.provider, next: product.provider }
      if (current.provider_product_id !== product.provider_product_id) {
        changes.provider_product_id = { current: current.provider_product_id, next: product.provider_product_id }
      }
      if (current.kind !== product.kind) changes.kind = { current: current.kind, next: product.kind }
      if (current.status !== product.status) changes.status = { current: current.status, next: product.status }
      if (Number(current.display_priority ?? 100) !== product.display_priority) {
        changes.display_priority = { current: current.display_priority, next: product.display_priority }
      }
      if (current.name !== product.name) changes.name = { current: current.name, next: product.name }
      if (current.default_currency !== product.default_currency) {
        changes.default_currency = { current: current.default_currency, next: product.default_currency }
      }
      const needsUpdate = Object.keys(changes).length > 0
      if (needsUpdate) {
        await trx
          .updateTable('catalog_products')
          .set({
            realm_id: targetRealm,
            provider: product.provider,
            provider_product_id: product.provider_product_id,
            kind: product.kind,
            status: product.status,
            display_priority: product.display_priority,
            name: product.name,
            default_currency: product.default_currency,
          })
          .where('product_code', '=', product.product_code)
          .executeTakeFirst()
        bump(summary, 'catalog_products', 'updated')
        recordUpdated(summary, 'catalog_products', product.product_code, changes)
      } else {
        bump(summary, 'catalog_products', 'unchanged')
      }
    }
  }
  return ids
}

async function upsertCatalogPrices(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
  productIds: ProductIdMap,
  groupIds: Map<string, string>,
  opts: ApplyOptions,
): Promise<PriceIdMap> {
  const rows = await trx
    .selectFrom('catalog_prices')
    .select([
      'catalog_price_id',
      'realm_id',
      'catalog_product_id',
      'price_code',
      'provider_price_id',
      'currency',
      'unit_amount',
      'recurring_interval',
      'recurring_count',
      'display_priority',
      'metadata',
      'subscription_group_id',
      'subscription_group_key',
    ])
    .execute()
  const byCode = new Map(rows.map((r) => [r.price_code, r]))
  const byId = new Map(rows.map((r) => [String(r.catalog_price_id), r]))
  const ids: PriceIdMap = new Map(
    rows.map((r) => [r.price_code, { id: String(r.catalog_price_id), productId: String(r.catalog_product_id) }]),
  )
  for (const price of spec.catalogPrices) {
    const targetRealm = price.realm_id || spec.realmId || spec.realmIds[0]
    if (!targetRealm) {
      throw new Error(`importer: catalog_price ${price.price_code} missing realm_id`)
    }
    const productId = productIds.get(price.product_code)
    if (!productId) {
      throw new Error(`importer: price ${price.price_code} references unknown product ${price.product_code}`)
    }
    const groupId = price.subscription_group_key ? groupIds.get(`${targetRealm}::${price.subscription_group_key}`) : null
    if (price.subscription_group_key && !groupId) {
      throw new Error(`importer: catalog_price ${price.price_code} missing subscription_group_key mapping`)
    }
    const subscriptionGroupKey = groupId ? price.subscription_group_key : null
    const current = byCode.get(price.price_code)
    if (!current) {
      if (price.catalog_price_id) {
        const occupied = byId.get(price.catalog_price_id)
        if (occupied && occupied.price_code !== price.price_code) {
          throw new Error(`importer: catalog_price_id ${price.catalog_price_id} already belongs to price_code ${occupied.price_code}`)
        }
      }
      const inserted = await trx
        .insertInto('catalog_prices')
        .values({
          ...(price.catalog_price_id ? { catalog_price_id: price.catalog_price_id } : {}),
          realm_id: targetRealm,
          catalog_product_id: productId,
          price_code: price.price_code,
          provider_price_id: price.provider_price_id,
          status: price.status ?? 'active',
          currency: price.currency,
          unit_amount: price.unit_amount,
          recurring_interval: price.recurring_interval,
          recurring_count: price.recurring_count,
          display_priority: price.display_priority,
          metadata: price.metadata ?? {},
          subscription_group_id: groupId ?? null,
          subscription_group_key: subscriptionGroupKey,
        })
        .returning(['catalog_price_id'])
        .executeTakeFirstOrThrow()
      ids.set(price.price_code, { id: String(inserted.catalog_price_id), productId })
      bump(summary, 'catalog_prices', 'created')
      recordCreated(summary, 'catalog_prices', { price_code: price.price_code })
    } else {
      if (current.realm_id !== targetRealm) {
        throw new Error(`importer: catalog_price ${price.price_code} already belongs to realm ${current.realm_id}, cannot upsert into ${targetRealm}`)
      }
      if (String(current.catalog_product_id) !== String(productId)) {
        throw new Error(`importer: price ${price.price_code} cannot change associated product`)
      }
      ids.set(price.price_code, { id: String(current.catalog_price_id), productId })
      const disallowedChange =
        current.currency !== price.currency ||
        Number(current.unit_amount) !== Number(price.unit_amount) ||
        current.recurring_interval !== price.recurring_interval ||
        (current.recurring_count ?? null) !== (price.recurring_count ?? null)
      if (disallowedChange) {
        throw new Error(`importer: price ${price.price_code} amount/interval change detected; create new price_code`)
      }
      const needsUpdate =
        current.provider_price_id !== price.provider_price_id ||
        Number(current.display_priority ?? 0) !== Number(price.display_priority ?? 0) ||
        !deepEqual(current.metadata ?? {}, price.metadata ?? {}) ||
        String(current.subscription_group_id ?? '') !== String(groupId ?? '') ||
        (current.subscription_group_key ?? null) !== subscriptionGroupKey
      if (needsUpdate) {
        const changes: Record<string, { current: unknown; next: unknown }> = {}
        if (current.provider_price_id !== price.provider_price_id) {
          changes.provider_price_id = { current: current.provider_price_id, next: price.provider_price_id }
        }
        if (Number(current.display_priority ?? 0) !== Number(price.display_priority ?? 0)) {
          changes.display_priority = { current: current.display_priority, next: price.display_priority }
        }
        if (!deepEqual(current.metadata ?? {}, price.metadata ?? {})) {
          changes.metadata = { current: current.metadata ?? {}, next: price.metadata ?? {} }
        }
        if (String(current.subscription_group_id ?? '') !== String(groupId ?? '')) {
          changes.subscription_group_id = { current: current.subscription_group_id, next: groupId }
        }
        if ((current.subscription_group_key ?? null) !== subscriptionGroupKey) {
          changes.subscription_group_key = { current: current.subscription_group_key, next: subscriptionGroupKey }
        }
        await trx
          .updateTable('catalog_prices')
          .set({
            provider_price_id: price.provider_price_id,
            display_priority: price.display_priority,
            metadata: price.metadata ?? {},
            subscription_group_id: groupId ?? null,
            subscription_group_key: subscriptionGroupKey,
          })
          .where('price_code', '=', price.price_code)
          .executeTakeFirst()
        bump(summary, 'catalog_prices', 'updated')
        recordUpdated(summary, 'catalog_prices', price.price_code, changes)
      } else {
        bump(summary, 'catalog_prices', 'unchanged')
      }
    }
  }
  if (opts.mode === 'replace') {
    const specCodes = new Set(spec.catalogPrices.map((p) => p.price_code))
    for (const existing of byCode.values()) {
      if (!specCodes.has(existing.price_code)) {
        // No-op for now; future enhancement: soft-hide missing prices via visibility rules.
        bump(summary, 'catalog_prices', 'unchanged')
      }
    }
  }
  return ids
}

async function upsertSubscriptionGroups(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
): Promise<Map<string, string>> {
  const rows = await trx.selectFrom('subscription_groups').select(['subscription_group_id', 'realm_id', 'group_key', 'title', 'is_stackable', 'is_exclusive']).execute()
  const byRealmKey = new Map(rows.map((r) => [`${r.realm_id}::${r.group_key}`, r]))
  const ids = new Map<string, string>(rows.map((r) => [`${r.realm_id}::${r.group_key}`, String(r.subscription_group_id)]))
  for (const group of spec.catalogSubscriptionGroups) {
    const realmKey = `${group.realm_id}::${group.group_key}`
    const current = byRealmKey.get(realmKey)
    if (!current) {
      const inserted = await trx
        .insertInto('subscription_groups')
        .values({
          realm_id: group.realm_id,
          group_key: group.group_key,
          title: group.title,
          is_stackable: group.is_stackable,
          is_exclusive: group.is_exclusive,
        })
        .returning(['subscription_group_id'])
        .executeTakeFirstOrThrow()
      ids.set(realmKey, String(inserted.subscription_group_id))
      bump(summary, 'subscription_groups', 'created')
      recordCreated(summary, 'subscription_groups', { realm_id: group.realm_id, group_key: group.group_key })
    } else {
      ids.set(realmKey, String(current.subscription_group_id))
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      if (current.title !== group.title) changes.title = { current: current.title, next: group.title }
      if (current.is_stackable !== group.is_stackable) {
        changes.is_stackable = { current: current.is_stackable, next: group.is_stackable }
      }
      if (current.is_exclusive !== group.is_exclusive) {
        changes.is_exclusive = { current: current.is_exclusive, next: group.is_exclusive }
      }
      const needsUpdate = Object.keys(changes).length > 0
      if (needsUpdate) {
        await trx
          .updateTable('subscription_groups')
          .set({
            title: group.title,
            is_stackable: group.is_stackable,
            is_exclusive: group.is_exclusive,
          })
          .where('realm_id', '=', group.realm_id)
          .where('group_key', '=', group.group_key)
          .executeTakeFirst()
        bump(summary, 'subscription_groups', 'updated')
        recordUpdated(summary, 'subscription_groups', realmKey, changes)
      } else {
        bump(summary, 'subscription_groups', 'unchanged')
      }
    }
  }
  return ids
}

type FeatureUpsertOutcome = {
  featureIds: FeatureIdMap
  meterIds: MeterIdMap
  primaryFeatureMeterKeys: Set<string>
  handledMeterKeys: Set<string>
  autoFeatureMeters: FeatureMeterSpec[]
  priceUpserts: {
    realm_id: string
    meter_code: string
    price?: MeterPriceSpec
  }[]
  extraMeters: MeterSpec[]
}

async function upsertFeaturesAndPrimaryMeters(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
): Promise<FeatureUpsertOutcome> {
  const meterByRealmCode = new Map<string, MeterSpec>()
  const meterByFeature = new Map<string, MeterSpec>()
  for (const meter of spec.meters) {
    const key = `${meter.realm_id}::${meter.meter_code}`
    meterByRealmCode.set(key, meter)
    if (meter.feature_code) {
      const featureKey = `${meter.realm_id}::${meter.feature_code}`
      if (!meterByFeature.has(featureKey)) meterByFeature.set(featureKey, meter)
    }
  }

  const featureIds: FeatureIdMap = new Map()
  const meterIds: MeterIdMap = new Map()
  const primaryFeatureMeterKeys = new Set<string>()
  const handledMeterKeys = new Set<string>()
  const autoFeatureMeters: FeatureMeterSpec[] = []
  const priceUpserts: { realm_id: string; meter_code: string; price?: MeterPriceSpec }[] = []
  const extraMeters: MeterSpec[] = []

  for (const feature of spec.features) {
    if (!feature.feature_family_code) {
      throw new Error(`importer: feature ${feature.feature_code} in realm ${feature.realm_id} missing feature_family_code`)
    }
    const featureKey = `${feature.realm_id}::${feature.feature_code}`
    const featureMeters = Array.isArray(feature.meters) ? feature.meters : []
    for (const m of featureMeters) {
      const meterCode = readTrimmedString(m.meter_code ?? feature.feature_code)
      const meterKey = `${feature.realm_id}::${meterCode}`
      const meter: MeterSpec = {
        realm_id: feature.realm_id,
        meter_code: meterCode,
        feature_code: feature.feature_code,
        unit: readTrimmedString(m.unit ?? feature.unit ?? '', '') || undefined,
        scale: m.scale === undefined ? undefined : readNumber(m.scale, 0),
        rounding: (m.rounding ?? undefined) as RoundingMode | undefined,
        active: m.active === undefined ? undefined : readBoolean(m.active, true),
        metadata: m.metadata === undefined ? undefined : normalizeMetadata(m.metadata),
        meter_prices: m.meter_prices
          ? {
              realm_id: feature.realm_id,
              meter_code: meterCode,
              unit_price_xusd:
                m.meter_prices.unit_price_xusd !== undefined
                  ? readString(m.meter_prices.unit_price_xusd, '0')
                  : undefined,
              unit_price_base_xusd:
                m.meter_prices.unit_price_base_xusd !== undefined
                  ? readString(m.meter_prices.unit_price_base_xusd, '0')
                  : undefined,
              unit_price_dynamic_xusd:
                m.meter_prices.unit_price_dynamic_xusd !== undefined
                  ? readString(m.meter_prices.unit_price_dynamic_xusd, '0')
                  : undefined,
              unit_quantity_minor:
                m.meter_prices.unit_quantity_minor !== undefined
                  ? readString(m.meter_prices.unit_quantity_minor, '1')
                  : undefined,
              rounding: m.meter_prices.rounding ? (m.meter_prices.rounding as PriceRounding) : undefined,
              unit_cost_xusd:
                m.meter_prices.unit_cost_xusd !== undefined ? readString(m.meter_prices.unit_cost_xusd, '0') : undefined,
              cost_unit_quantity_minor:
                m.meter_prices.cost_unit_quantity_minor !== undefined
                  ? readString(m.meter_prices.cost_unit_quantity_minor, '1')
                  : undefined,
              cost_rounding: m.meter_prices.cost_rounding
                ? (m.meter_prices.cost_rounding as PriceRounding)
                : m.meter_prices.rounding
                  ? (m.meter_prices.rounding as PriceRounding)
                  : undefined,
              effective_at: parseDateMaybe(m.meter_prices.effective_at) ?? undefined,
            }
          : undefined,
      }
      // Primary meter inferred when meter_code matches feature_code
      if (!meterByRealmCode.has(meterKey)) {
        meterByRealmCode.set(meterKey, meter)
      }
      extraMeters.push(meter)
      if (meter.meter_prices) {
        priceUpserts.push({ realm_id: feature.realm_id, meter_code: meterCode, price: meter.meter_prices })
      }
      if (meter.meter_code !== feature.feature_code) {
        autoFeatureMeters.push({
          realm_id: feature.realm_id,
          feature_code: feature.feature_code,
          meter_code: meter.meter_code,
          is_primary: false,
          metadata: meter.metadata ?? {},
        })
      }
    }

    // Ensure primary meter exists in feature.meters list
    const featureMetersList = Array.isArray(feature.meters) ? [...feature.meters] : []
    const hasPrimaryInList = featureMetersList.some(
      (m) => (m.meter_code ?? feature.feature_code) === feature.feature_code,
    )
    if (!hasPrimaryInList) {
      const primarySpec = meterByRealmCode.get(`${feature.realm_id}::${feature.feature_code}`)
	      if (primarySpec) {
	        featureMetersList.push({
	          meter_code: primarySpec.meter_code,
	          unit: primarySpec.unit,
	          scale: primarySpec.scale,
	          rounding: primarySpec.rounding,
	          semantic_kind: primarySpec.semantic_kind,
	          active: primarySpec.active,
	          metadata: primarySpec.metadata,
	        })
	      } else {
        featureMetersList.push({
          meter_code: feature.feature_code,
        })
      }
    }

	    const metersForFeature = featureMetersList.map((m) => ({
	      meter_code: m.meter_code ?? feature.feature_code,
	      unit: m.unit ?? feature.unit ?? undefined,
	      scale: m.scale,
	      rounding: m.rounding,
	      semantic_kind: m.semantic_kind,
	      active: m.active,
	      metadata: m.metadata,
	          price: m.meter_prices
	            ? {
	                unit_cost_xusd: m.meter_prices.unit_cost_xusd ?? '0',
                unit_price_xusd: m.meter_prices.unit_price_xusd,
                unit_price_base_xusd: m.meter_prices.unit_price_base_xusd,
                unit_price_dynamic_xusd: m.meter_prices.unit_price_dynamic_xusd,
                unit_quantity_minor: m.meter_prices.unit_quantity_minor,
                rounding: m.meter_prices.rounding,
                cost_unit_quantity_minor: m.meter_prices.cost_unit_quantity_minor,
                cost_rounding: m.meter_prices.cost_rounding ?? m.meter_prices.rounding,
                effective_at: m.meter_prices.effective_at,
              }
            : undefined,
          priceCostRatio: (m as unknown as { priceCostRatio?: number }).priceCostRatio,
        }))

    const result = await FeatureService.upsertFeature(trx, {
      realmId: feature.realm_id,
      feature: { ...feature, meters: metersForFeature },
    })

    featureIds.set(featureKey, result.featureId)
    const meterKey = `${feature.realm_id}::${feature.feature_code}`
    meterIds.set(meterKey, result.meterId)
    handledMeterKeys.add(meterKey)
    primaryFeatureMeterKeys.add(`${result.featureId}::${result.meterId}`)

    if (result.featureChange === 'created') {
      bump(summary, 'features', 'created')
      recordCreated(summary, 'features', { realm_id: feature.realm_id, feature_code: feature.feature_code })
    } else if (result.featureChange === 'updated') {
      bump(summary, 'features', 'updated')
      recordUpdated(summary, 'features', featureKey, result.featureDiff ?? {})
    } else {
      bump(summary, 'features', 'unchanged')
    }

    if (result.meterChange === 'created') {
      bump(summary, 'meters', 'created')
      recordCreated(summary, 'meters', { realm_id: feature.realm_id, meter_code: feature.feature_code })
    } else if (result.meterChange === 'updated') {
      bump(summary, 'meters', 'updated')
      recordUpdated(summary, 'meters', meterKey, result.meterDiff ?? {})
    } else {
      bump(summary, 'meters', 'unchanged')
    }

    if (result.mappingChange === 'created') {
      bump(summary, 'feature_meters', 'created')
      recordCreated(summary, 'feature_meters', {
        realm_id: feature.realm_id,
        feature_code: feature.feature_code,
        meter_code: feature.feature_code,
      })
    } else if (result.mappingChange === 'updated') {
      bump(summary, 'feature_meters', 'updated')
      recordUpdated(summary, 'feature_meters', featureKey, {
        is_primary: { current: false, next: true },
      })
    } else {
      bump(summary, 'feature_meters', 'unchanged')
    }
  }

  return { featureIds, meterIds, primaryFeatureMeterKeys, handledMeterKeys, autoFeatureMeters, priceUpserts, extraMeters }
}

async function upsertMeters(
  trx: Transaction<Database>,
  meters: MeterSpec[],
  summary: ImportSummary,
  existingIds: MeterIdMap,
  skipKeys: Set<string>,
  priceUpserts: { realm_id: string; meter_code: string; price?: MeterPriceSpec }[],
): Promise<MeterIdMap> {
  const ids: MeterIdMap = new Map(existingIds ? Array.from(existingIds.entries()) : [])

  for (const meter of meters) {
    const key = `${meter.realm_id}::${meter.meter_code}`
    if (skipKeys.has(key)) continue

    const priceInputRaw =
      priceUpserts.find((p) => p.realm_id === meter.realm_id && p.meter_code === meter.meter_code)?.price ??
      meter.meter_prices
    const priceInput =
      priceInputRaw &&
      (priceInputRaw.unit_cost_xusd !== undefined ||
        priceInputRaw.unit_price_xusd !== undefined ||
        priceInputRaw.unit_price_base_xusd !== undefined ||
        priceInputRaw.unit_price_dynamic_xusd !== undefined ||
        priceInputRaw.unit_quantity_minor !== undefined ||
        priceInputRaw.cost_unit_quantity_minor !== undefined ||
        priceInputRaw.rounding !== undefined ||
        priceInputRaw.cost_rounding !== undefined ||
        priceInputRaw.effective_at !== undefined)
        ? priceInputRaw
        : undefined

	    const result = await MeterService.upsertMeter(trx, {
	      realmId: meter.realm_id,
	      meter_code: meter.meter_code,
	      feature_code: meter.feature_code,
	      unit: meter.unit,
	      scale: meter.scale,
	      rounding: meter.rounding,
	      semantic_kind: meter.semantic_kind,
	      active: meter.active,
	      metadata: meter.metadata,
	      price: priceInput
	        ? {
            unit_cost_xusd: priceInput.unit_cost_xusd ?? '0',
            unit_price_xusd: priceInput.unit_price_xusd,
            unit_price_base_xusd: priceInput.unit_price_base_xusd,
            unit_price_dynamic_xusd: priceInput.unit_price_dynamic_xusd,
            unit_quantity_minor: priceInput.unit_quantity_minor,
            rounding: priceInput.rounding,
            cost_unit_quantity_minor: priceInput.cost_unit_quantity_minor,
            cost_rounding: priceInput.cost_rounding,
            effective_at: priceInput.effective_at,
          }
        : undefined,
      priceCostRatio: 1,
    })

    ids.set(key, result.meterId)

    if (result.meterChange === 'created') {
      bump(summary, 'meters', 'created')
      recordCreated(summary, 'meters', { realm_id: meter.realm_id, meter_code: meter.meter_code })
    } else if (result.meterChange === 'updated') {
      bump(summary, 'meters', 'updated')
      recordUpdated(summary, 'meters', key, result.meterDiff ?? {})
    } else {
      bump(summary, 'meters', 'unchanged')
    }

    if (result.priceChange === 'created') {
      bump(summary, 'meter_prices', 'created')
      recordCreated(summary, 'meter_prices', { realm_id: meter.realm_id, meter_code: meter.meter_code })
    } else if (result.priceChange === 'updated') {
      bump(summary, 'meter_prices', 'updated')
      recordUpdated(summary, 'meter_prices', key, result.priceDiff ?? {})
    } else if (priceInput) {
      // price provided but unchanged
      bump(summary, 'meter_prices', 'unchanged')
    }
  }

  return ids
}

async function upsertFeatureMeters(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
  featureIds: FeatureIdMap,
  meterIds: MeterIdMap,
  opts: ApplyOptions,
  protectedKeys?: Set<string>,
): Promise<void> {
  const featureIdCache = new Map<string, string>()
  const meterIdCache = new Map<string, string>()
  const rows = await trx
    .selectFrom('feature_meters')
    .select(['feature_id', 'meter_id', 'is_primary', 'metadata'])
    .execute()
  const byKey = new Map<string, typeof rows[number]>()
  for (const row of rows) {
    byKey.set(`${row.feature_id}::${row.meter_id}`, row)
  }
  const featureInfoById = new Map<string, { realm_id: string; feature_code: string }>()
  for (const [composite, fid] of featureIds.entries()) {
    const [realmId, featureCode] = composite.split('::')
    featureInfoById.set(String(fid), { realm_id: realmId, feature_code: featureCode })
  }
  const meterInfoById = new Map<string, { realm_id: string; meter_code: string }>()
  for (const [composite, mid] of meterIds.entries()) {
    meterInfoById.set(String(mid), { realm_id: composite.split('::')[0], meter_code: composite.split('::')[1] })
  }
  const seenSpec = new Set<string>()
  const desired = new Set<string>(protectedKeys ?? [])
  for (const fm of spec.featureMeters) {
    const dedupeKey = `${fm.realm_id}::${fm.feature_code}::${fm.meter_code}`
    if (seenSpec.has(dedupeKey)) continue
    seenSpec.add(dedupeKey)
    if (fm.is_primary && fm.feature_code !== fm.meter_code) {
      throw new Error(
        `importer: primary meter must match feature_code for feature ${fm.feature_code} in realm ${fm.realm_id}`,
      )
    }
    let featureId = featureIds.get(`${fm.realm_id}::${fm.feature_code}`) ?? featureIdCache.get(dedupeKey)
    if (!featureId) {
      const featureRow = await trx
        .selectFrom('features')
        .select('feature_id')
        .where('realm_id', '=', fm.realm_id)
        .where('feature_code', '=', fm.feature_code)
        .executeTakeFirst()
      if (featureRow) {
        featureId = String(featureRow.feature_id)
        featureIdCache.set(dedupeKey, featureId)
        featureInfoById.set(featureId, { realm_id: fm.realm_id, feature_code: fm.feature_code })
      }
    }
    let meterId = meterIds.get(`${fm.realm_id}::${fm.meter_code}`) ?? meterIdCache.get(dedupeKey)
    if (!meterId) {
      const meterRow = await trx
        .selectFrom('meters')
        .select(['meter_id'])
        .where('realm_id', '=', fm.realm_id)
        .where('meter_code', '=', fm.meter_code)
        .executeTakeFirst()
      if (meterRow) {
        meterId = String(meterRow.meter_id)
        meterIdCache.set(dedupeKey, meterId)
        meterInfoById.set(meterId, { realm_id: fm.realm_id, meter_code: fm.meter_code })
      }
    }
    if (!featureId) throw new Error(`importer: feature_meter references unknown feature ${fm.feature_code}`)
    if (!meterId) throw new Error(`importer: feature_meter references unknown meter ${fm.meter_code}`)
    const key = `${featureId}::${meterId}`
    desired.add(key)
    const current = byKey.get(key)
    if (!current) {
      const insertPrimary = Boolean(fm.is_primary)
      if (insertPrimary) {
        await trx.updateTable('feature_meters').set({ is_primary: false }).where('feature_id', '=', featureId).execute()
      }
      await trx
        .insertInto('feature_meters')
        .values({
          feature_id: featureId,
          meter_id: meterId,
          is_primary: insertPrimary,
          metadata: fm.metadata !== undefined ? normalizeMetadata(fm.metadata) : {},
        })
        .executeTakeFirst()
      bump(summary, 'feature_meters', 'created')
      recordCreated(summary, 'feature_meters', {
        realm_id: fm.realm_id,
        feature_code: fm.feature_code,
        meter_code: fm.meter_code,
      })
    } else {
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      const primaryProvided = fm.is_primary !== undefined
      const wantsPrimary = Boolean(fm.is_primary)
      const needsPrimaryChange = primaryProvided && Boolean(current.is_primary) !== wantsPrimary
      if (needsPrimaryChange) {
        changes.is_primary = { current: current.is_primary, next: wantsPrimary }
      }
      const nextMetadata = fm.metadata === undefined ? current.metadata ?? {} : normalizeMetadata(fm.metadata)
      const needsMetadataChange = fm.metadata !== undefined && !deepEqual(current.metadata ?? {}, nextMetadata)
      if (needsMetadataChange) {
        changes.metadata = { current: current.metadata ?? {}, next: nextMetadata }
      }
      const needsUpdate = Object.keys(changes).length > 0
      if (needsUpdate) {
        if (needsPrimaryChange && wantsPrimary) {
          await trx.updateTable('feature_meters').set({ is_primary: false }).where('feature_id', '=', featureId).execute()
        }
        const updatePayload: Record<string, unknown> = {}
        if (primaryProvided) {
          updatePayload.is_primary = wantsPrimary
        }
        if (fm.metadata !== undefined) {
          updatePayload.metadata = normalizeMetadata(fm.metadata)
        }
        await trx
          .updateTable('feature_meters')
          .set(updatePayload)
          .where('feature_id', '=', featureId)
          .where('meter_id', '=', meterId)
          .executeTakeFirst()
        bump(summary, 'feature_meters', 'updated')
        recordUpdated(summary, 'feature_meters', `${fm.realm_id}::${fm.feature_code}::${fm.meter_code}`, changes)
      } else {
        bump(summary, 'feature_meters', 'unchanged')
      }
    }
  }
  if (opts.mode === 'replace') {
    for (const key of byKey.keys()) {
      if (!desired.has(key)) {
        const [featureId, meterId] = key.split('::')
        await trx
          .deleteFrom('feature_meters')
          .where('feature_id', '=', featureId)
          .where('meter_id', '=', meterId)
          .executeTakeFirst()
        bump(summary, 'feature_meters', 'disabled')
        const featureInfo = featureInfoById.get(String(featureId))
        const meterInfo = meterInfoById.get(String(meterId))
        recordDisabled(summary, 'feature_meters', {
          realm_id: featureInfo?.realm_id,
          feature_code: featureInfo?.feature_code,
          meter_code: meterInfo?.meter_code,
        })
      }
    }
  }
}

async function upsertGatePolicies(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
  opts: ApplyOptions,
): Promise<void> {
  const bundleCache = new Map<string, Map<string, string>>() // realm_id -> bundle_key -> bundle_id

  const ensureBundleId = async (realmId: string, bundleKey: string): Promise<string> => {
    const trimmedKey = bundleKey.trim() || DEFAULT_BUNDLE_KEY
    const cachedRealm = bundleCache.get(realmId)
    if (cachedRealm?.has(trimmedKey)) return cachedRealm.get(trimmedKey)!

    const existing = await trx
      .selectFrom('gate_policy_bundles')
      .select(['bundle_id'])
      .where('realm_id', '=', realmId)
      .where('bundle_key', '=', trimmedKey)
      .executeTakeFirst()
    if (existing?.bundle_id) {
      const realmMap = cachedRealm ?? new Map<string, string>()
      realmMap.set(trimmedKey, String(existing.bundle_id))
      bundleCache.set(realmId, realmMap)
      return String(existing.bundle_id)
    }

    const inserted = await trx
      .insertInto('gate_policy_bundles')
        .values({
          realm_id: realmId,
          bundle_key: trimmedKey,
          name: trimmedKey,
          status: 'active',
          metadata: { source: 'importer' },
        })
      .returning(['bundle_id'])
      .executeTakeFirst()
    const realmMap = cachedRealm ?? new Map<string, string>()
    const bundleId = String(inserted?.bundle_id ?? '')
    realmMap.set(trimmedKey, bundleId)
    bundleCache.set(realmId, realmMap)
    return bundleId
  }

  const rows = await trx
    .selectFrom('gate_policies')
    .select([
      'policy_id',
      'realm_id',
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
    .execute()
  const byKey = new Map<string, typeof rows[number]>()
  for (const row of rows) {
    byKey.set(`${row.realm_id}::${row.name}`, row)
  }
  const desired = new Set<string>()
  for (const policy of spec.gatePolicies) {
    const bundleId = await ensureBundleId(policy.realm_id, policy.bundle_key)
    const key = `${policy.realm_id}::${policy.name}`
    desired.add(key)
    const current = byKey.get(key)
    if (!current) {
      await trx
        .insertInto('gate_policies')
        .values({
          realm_id: policy.realm_id,
          bundle_id: bundleId,
          name: policy.name,
          description: policy.description ?? undefined,
          feature_code: policy.feature_code,
          kind: policy.kind,
          subject_scope: policy.subject_scope,
          unit: policy.unit,
          window_sec: policy.window_sec,
          limit_count: policy.limit_count ?? undefined,
          limit_minor: policy.limit_minor ?? undefined,
          status: policy.status,
          enforcement_mode: policy.enforcement_mode,
          metadata: policy.metadata ?? {},
        })
        .executeTakeFirst()
      bump(summary, 'gate_policies', 'created')
      recordCreated(summary, 'gate_policies', { realm_id: policy.realm_id, name: policy.name })
    } else {
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      if (current.description !== policy.description) {
        changes.description = { current: current.description, next: policy.description }
      }
      if (current.feature_code !== policy.feature_code) {
        changes.feature_code = { current: current.feature_code, next: policy.feature_code }
      }
      if (String(current.bundle_id ?? '') !== bundleId) {
        changes.bundle_id = { current: String(current.bundle_id ?? ''), next: bundleId }
      }
      if (current.kind !== policy.kind) changes.kind = { current: current.kind, next: policy.kind }
      if (current.subject_scope !== policy.subject_scope) {
        changes.subject_scope = { current: current.subject_scope, next: policy.subject_scope }
      }
      if (current.unit !== policy.unit) changes.unit = { current: current.unit, next: policy.unit }
      if (Number(current.window_sec) !== Number(policy.window_sec)) {
        changes.window_sec = { current: current.window_sec, next: policy.window_sec }
      }
      const limitCountCurrent = toStringOrNull(current.limit_count)
      const limitCountNext = toStringOrNull(policy.limit_count)
      if (limitCountCurrent !== limitCountNext) {
        changes.limit_count = { current: limitCountCurrent, next: limitCountNext }
      }
      const limitMinorCurrent = toStringOrNull(current.limit_minor)
      const limitMinorNext = toStringOrNull(policy.limit_minor)
      if (limitMinorCurrent !== limitMinorNext) {
        changes.limit_minor = { current: limitMinorCurrent, next: limitMinorNext }
      }
      if (current.status !== policy.status) {
        changes.status = { current: current.status, next: policy.status }
      }
      if (current.enforcement_mode !== policy.enforcement_mode) {
        changes.enforcement_mode = { current: current.enforcement_mode, next: policy.enforcement_mode }
      }
      if (!deepEqual(current.metadata ?? {}, policy.metadata ?? {})) {
        changes.metadata = { current: current.metadata ?? {}, next: policy.metadata ?? {} }
      }
      const needsUpdate = Object.keys(changes).length > 0
      if (needsUpdate) {
        await trx
          .updateTable('gate_policies')
          .set({
            description: policy.description ?? undefined,
            feature_code: policy.feature_code,
            bundle_id: bundleId,
            kind: policy.kind,
            subject_scope: policy.subject_scope,
            unit: policy.unit,
            window_sec: policy.window_sec,
            limit_count: policy.limit_count ?? undefined,
            limit_minor: policy.limit_minor ?? undefined,
            status: policy.status,
            enforcement_mode: policy.enforcement_mode,
            metadata: policy.metadata ?? {},
          })
          .where('realm_id', '=', policy.realm_id)
          .where('name', '=', policy.name)
          .executeTakeFirst()
        bump(summary, 'gate_policies', 'updated')
        recordUpdated(summary, 'gate_policies', `${policy.realm_id}::${policy.name}`, changes)
      } else {
        bump(summary, 'gate_policies', 'unchanged')
      }
    }
  }
  if (opts.mode === 'replace') {
    for (const key of byKey.keys()) {
      if (!desired.has(key)) {
        const [realmId, name] = key.split('::')
        await trx
          .updateTable('gate_policies')
          .set({ status: 'disabled' })
          .where('realm_id', '=', realmId)
          .where('name', '=', name)
          .executeTakeFirst()
        bump(summary, 'gate_policies', 'disabled')
        recordDisabled(summary, 'gate_policies', { realm_id: realmId, name })
      }
    }
  }
}

async function upsertMeterPrices(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
  opts: ApplyOptions,
): Promise<void> {
  const rows = await trx
    .selectFrom('meter_prices')
    .select([
      'price_id',
      'realm_id',
      'meter_code',
      'unit_price_xusd',
      'unit_price_base_xusd',
      'unit_price_dynamic_xusd',
      'unit_quantity_minor',
      'rounding',
      'unit_cost_xusd',
      'cost_unit_quantity_minor',
      'cost_rounding',
      'effective_at',
    ])
    .execute()
  const byKey = new Map<string, typeof rows[number]>()
  for (const row of rows) {
    byKey.set(`${row.realm_id}::${row.meter_code}`, row)
  }
  const desired = new Set<string>()
  for (const price of spec.meterPrices) {
    const key = `${price.realm_id}::${price.meter_code}`
    desired.add(key)
    if (price.unit_cost_xusd === undefined) {
      continue
    }
    const current = byKey.get(key)
    if (!current) {
      await trx
        .insertInto('meter_prices')
        .values({
          realm_id: price.realm_id,
          meter_code: price.meter_code,
          unit_price_xusd: price.unit_price_xusd ?? '0',
          unit_price_base_xusd: price.unit_price_base_xusd ?? price.unit_price_xusd ?? '0',
          unit_price_dynamic_xusd: price.unit_price_dynamic_xusd ?? '0',
          unit_quantity_minor: price.unit_quantity_minor ?? '1',
          rounding: price.rounding ?? 'nearest',
          unit_cost_xusd: price.unit_cost_xusd,
          cost_unit_quantity_minor: price.cost_unit_quantity_minor ?? price.unit_quantity_minor ?? '1',
          cost_rounding: price.cost_rounding ?? price.rounding ?? 'nearest',
          effective_at: price.effective_at ?? new Date(),
        })
        .executeTakeFirst()
      bump(summary, 'meter_prices', 'created')
      recordCreated(summary, 'meter_prices', { realm_id: price.realm_id, meter_code: price.meter_code })
    } else {
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      const currentPrice = toStringOrNull(current.unit_price_xusd)
      const nextPrice = price.unit_price_xusd === undefined ? currentPrice : String(price.unit_price_xusd)
      if (currentPrice !== nextPrice) changes.unit_price_xusd = { current: currentPrice, next: nextPrice }
      const currentBase = toStringOrNull(current.unit_price_base_xusd)
      const nextBase = price.unit_price_base_xusd === undefined ? currentBase : String(price.unit_price_base_xusd)
      if (currentBase !== nextBase) changes.unit_price_base_xusd = { current: currentBase, next: nextBase }
      const currentDynamic = toStringOrNull(current.unit_price_dynamic_xusd)
      const nextDynamic =
        price.unit_price_dynamic_xusd === undefined ? currentDynamic : String(price.unit_price_dynamic_xusd)
      if (currentDynamic !== nextDynamic) changes.unit_price_dynamic_xusd = { current: currentDynamic, next: nextDynamic }
      const currentQty = toStringOrNull(current.unit_quantity_minor)
      const nextQty = price.unit_quantity_minor === undefined ? currentQty : String(price.unit_quantity_minor)
      if (currentQty !== nextQty) changes.unit_quantity_minor = { current: currentQty, next: nextQty }
      if (price.rounding !== undefined && current.rounding !== price.rounding) {
        changes.rounding = { current: current.rounding, next: price.rounding }
      }
      const currentCost = toStringOrNull(current.unit_cost_xusd)
      const nextCost = price.unit_cost_xusd === undefined ? currentCost : String(price.unit_cost_xusd)
      if (currentCost !== nextCost) changes.unit_cost_xusd = { current: currentCost, next: nextCost }
      const currentCostQty = toStringOrNull(current.cost_unit_quantity_minor)
      const nextCostQty =
        price.cost_unit_quantity_minor === undefined ? currentCostQty : String(price.cost_unit_quantity_minor)
      if (currentCostQty !== nextCostQty) changes.cost_unit_quantity_minor = { current: currentCostQty, next: nextCostQty }
      if (price.cost_rounding !== undefined && current.cost_rounding !== price.cost_rounding) {
        changes.cost_rounding = { current: current.cost_rounding, next: price.cost_rounding }
      }
      const needsUpdate = Object.keys(changes).length > 0
      if (needsUpdate) {
        await trx
          .updateTable('meter_prices')
          .set({
            unit_price_xusd: price.unit_price_xusd,
            unit_price_base_xusd: price.unit_price_base_xusd,
            unit_price_dynamic_xusd: price.unit_price_dynamic_xusd,
            unit_quantity_minor: price.unit_quantity_minor,
            rounding: price.rounding,
            unit_cost_xusd: price.unit_cost_xusd,
            cost_unit_quantity_minor: price.cost_unit_quantity_minor,
            cost_rounding: price.cost_rounding,
            effective_at: price.effective_at ?? new Date(),
          })
          .where('realm_id', '=', price.realm_id)
          .where('meter_code', '=', price.meter_code)
          .executeTakeFirst()
        bump(summary, 'meter_prices', 'updated')
        recordUpdated(summary, 'meter_prices', `${price.realm_id}::${price.meter_code}`, changes)
      } else {
        bump(summary, 'meter_prices', 'unchanged')
      }
    }
  }
  if (opts.mode === 'replace') {
    for (const key of byKey.keys()) {
      if (!desired.has(key)) {
        const [realmId, meterCode] = key.split('::')
        await trx.deleteFrom('meter_prices').where('realm_id', '=', realmId).where('meter_code', '=', meterCode).executeTakeFirst()
        bump(summary, 'meter_prices', 'disabled')
        recordDisabled(summary, 'meter_prices', { realm_id: realmId, meter_code: meterCode })
      }
    }
  }
}

async function upsertGrantPrograms(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
): Promise<ProfileIdMap> {
  const realmIds = Array.from(
    new Set([
      ...spec.grantPrograms.map((program) => program.realm_id),
      ...spec.grantCampaigns.map((campaign) => campaign.realm_id),
    ]),
  ).filter((id) => id)
  if (realmIds.length === 0) return new Map()
  const rows = realmIds.length
    ? await trx
        .selectFrom('grant_programs')
        .select([
          'program_id',
          'realm_id',
          'program_code',
          'name',
          'active',
          'cadence',
          'issue_anchor',
          'amount_xusd',
          'window_kind',
          'window_default_seconds',
          'priority',
          'on_ledger',
          'issuance_mode',
          'periodic_accounting',
          'accrual_mode',
          'metadata',
        ])
        .where('realm_id', 'in', realmIds)
        .execute()
    : []
  const byKey = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    byKey.set(`${row.realm_id}::${row.program_code}`, row)
  }
  for (const program of spec.grantPrograms) {
    if (!program.program_code) continue
    const key = `${program.realm_id}::${program.program_code}`
    const current = byKey.get(key)
    if (!current) {
      await trx
        .insertInto('grant_programs')
        .values({
          realm_id: program.realm_id,
          program_code: program.program_code,
          name: program.name,
          active: program.active,
          cadence: program.cadence,
          issue_anchor: program.issue_anchor,
          amount_xusd: program.amount_xusd,
          window_kind: program.window_kind,
          window_default_seconds: program.window_default_seconds,
          priority: program.priority,
          on_ledger: program.on_ledger,
          issuance_mode: program.issuance_mode,
          periodic_accounting: program.periodic_accounting,
          accrual_mode: program.accrual_mode,
          metadata: program.metadata ?? {},
        })
        .executeTakeFirst()
      bump(summary, 'grant_programs', 'created')
      recordCreated(summary, 'grant_programs', { realm_id: program.realm_id, program_code: program.program_code })
    } else {
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      if ((current.name ?? null) !== program.name) {
        changes.name = { current: current.name, next: program.name }
      }
      if (Boolean(current.active) !== Boolean(program.active)) {
        changes.active = { current: current.active, next: program.active }
      }
      if (current.cadence !== program.cadence) {
        changes.cadence = { current: current.cadence, next: program.cadence }
      }
      if (current.issue_anchor !== program.issue_anchor) {
        changes.issue_anchor = { current: current.issue_anchor, next: program.issue_anchor }
      }
      const currentAmount = toStringOrNull(current.amount_xusd)
      if (currentAmount !== program.amount_xusd) {
        changes.amount_xusd = { current: currentAmount, next: program.amount_xusd }
      }
      if (current.window_kind !== program.window_kind) {
        changes.window_kind = { current: current.window_kind, next: program.window_kind }
      }
      const currentWindowSeconds = current.window_default_seconds === null || current.window_default_seconds === undefined
        ? null
        : Number(current.window_default_seconds)
      if ((currentWindowSeconds ?? null) !== (program.window_default_seconds ?? null)) {
        changes.window_default_seconds = { current: currentWindowSeconds, next: program.window_default_seconds }
      }
      const currentPriority = current.priority === null || current.priority === undefined ? 0 : Number(current.priority)
      if (currentPriority !== program.priority) {
        changes.priority = { current: currentPriority, next: program.priority }
      }
      if (Boolean(current.on_ledger) !== Boolean(program.on_ledger)) {
        changes.on_ledger = { current: current.on_ledger, next: program.on_ledger }
      }
      if (current.issuance_mode !== program.issuance_mode) {
        changes.issuance_mode = { current: current.issuance_mode, next: program.issuance_mode }
      }
      if (Boolean(current.periodic_accounting) !== Boolean(program.periodic_accounting)) {
        changes.periodic_accounting = { current: current.periodic_accounting, next: program.periodic_accounting }
      }
      const currentAccrual = current.accrual_mode ?? null
      if (currentAccrual !== program.accrual_mode) {
        changes.accrual_mode = { current: currentAccrual, next: program.accrual_mode }
      }
      if (!deepEqual(current.metadata ?? {}, program.metadata ?? {})) {
        changes.metadata = { current: current.metadata ?? {}, next: program.metadata ?? {} }
      }
      const needsUpdate = Object.keys(changes).length > 0
      if (needsUpdate) {
        await trx
          .updateTable('grant_programs')
          .set({
            name: program.name,
            active: program.active,
            cadence: program.cadence,
            issue_anchor: program.issue_anchor,
            amount_xusd: program.amount_xusd,
            window_kind: program.window_kind,
            window_default_seconds: program.window_default_seconds,
            priority: program.priority,
            on_ledger: program.on_ledger,
            issuance_mode: program.issuance_mode,
            periodic_accounting: program.periodic_accounting,
            accrual_mode: program.accrual_mode,
            metadata: program.metadata ?? {},
          })
          .where('realm_id', '=', program.realm_id)
          .where('program_code', '=', program.program_code)
          .executeTakeFirst()
        bump(summary, 'grant_programs', 'updated')
        recordUpdated(summary, 'grant_programs', key, changes)
      } else {
        bump(summary, 'grant_programs', 'unchanged')
      }
    }
  }

  const profileIdMap: ProfileIdMap = new Map()
  const refreshed = await trx
    .selectFrom('grant_programs')
    .select(['program_id', 'realm_id', 'program_code'])
    .where('realm_id', 'in', realmIds)
    .execute()
  for (const row of refreshed) {
    profileIdMap.set(`${row.realm_id}::${row.program_code}`, String(row.program_id))
  }
  return profileIdMap
}

async function upsertBillingPlans(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
): Promise<ProfileIdMap> {
  if (spec.billingPlans.length === 0) return new Map()
  const ids: ProfileIdMap = new Map()
  for (const bp of spec.billingPlans) {
    const id = await upsertBillingPlan(trx, {
      realmId: bp.realm_id,
      planCode: bp.plan_code,
      name: bp.name,
      kind: bp.kind,
      priority: bp.priority,
      active: bp.active,
      metadata: bp.metadata,
      featureCodes: bp.feature_codes,
      featureFamilyCodes: bp.feature_family_codes,
    })
    ids.set(`${bp.realm_id}::${bp.plan_code}`, id)
    bump(summary, 'billing_plans', 'created')
    recordCreated(summary, 'billing_plans', { realm_id: bp.realm_id, plan_code: bp.plan_code })
  }

  return ids
}

async function upsertBillingAccounts(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
): Promise<void> {
  if (spec.billingAccounts.length === 0) return
  const realmIds = Array.from(new Set(spec.billingAccounts.map((a) => a.realm_id))).filter(Boolean)
  const accountIds = Array.from(new Set(spec.billingAccounts.map((a) => a.billing_account_id))).filter(Boolean)

  const existing = await trx
    .selectFrom('billing_accounts')
    .select(['billing_account_id', 'realm_id', 'billing_principal_id', 'metadata'])
    .where('realm_id', 'in', realmIds)
    .where('billing_account_id', 'in', accountIds)
    .execute()

  const byId = new Map(existing.map((row) => [String(row.billing_account_id), row]))

  for (const account of spec.billingAccounts) {
    const id = account.billing_account_id
    const current = byId.get(id)
    if (!current) {
      await trx
        .insertInto('billing_accounts')
        .values({
          billing_account_id: id,
          realm_id: account.realm_id,
          billing_principal_id: account.billing_principal_id,
          metadata: account.metadata ?? {},
        })
        .executeTakeFirst()
      await trx
        .insertInto('billing_account_billing_details')
        .values({ billing_account_id: id })
        .onConflict((oc) => oc.column('billing_account_id').doNothing())
        .executeTakeFirst()
      bump(summary, 'billing_accounts', 'created')
      recordCreated(summary, 'billing_accounts', { realm_id: account.realm_id, billing_account_id: id })
      byId.set(id, {
        billing_account_id: id,
        realm_id: account.realm_id,
        billing_principal_id: account.billing_principal_id,
        metadata: account.metadata ?? {},
      } as (typeof existing)[number])
      continue
    }

    if (current.realm_id !== account.realm_id) {
      throw new Error(`importer: billing_account immutable: realm_id mismatch for ${id}`)
    }
    if (current.billing_principal_id !== account.billing_principal_id) {
      throw new Error(`importer: billing_account immutable: billing_principal_id mismatch for ${id}`)
    }

    const metadataNext = account.metadata ?? {}
    if (!deepEqual(current.metadata ?? {}, metadataNext)) {
      await trx
        .updateTable('billing_accounts')
        .set({ metadata: metadataNext })
        .where('billing_account_id', '=', id)
        .executeTakeFirst()
      bump(summary, 'billing_accounts', 'updated')
      recordUpdated(summary, 'billing_accounts', id, {
        metadata: { current: current.metadata ?? {}, next: metadataNext },
      })
    } else {
      bump(summary, 'billing_accounts', 'unchanged')
    }
  }
}

async function upsertGrantCampaigns(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
  profileIds: ProfileIdMap,
): Promise<void> {
  if (spec.grantCampaigns.length === 0) return
  const realmIds = Array.from(new Set(spec.grantCampaigns.map((c) => c.realm_id))).filter(Boolean)
  const rows = await trx
    .selectFrom('grant_campaigns')
    .select([
      'campaign_id',
      'realm_id',
      'name',
      'status',
      'window_start',
      'window_end',
      'target_filter',
      'metadata',
    ])
    .where('realm_id', 'in', realmIds)
    .execute()

  const byKey = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    byKey.set(`${row.realm_id}::${row.name}`, row)
  }

  for (const campaign of spec.grantCampaigns) {
    const key = `${campaign.realm_id}::${campaign.name}`
    const bindingRaw = (campaign.metadata as Record<string, unknown>).grants
    const bindings = Array.isArray(bindingRaw) ? bindingRaw : bindingRaw ? [bindingRaw] : []
    const bindingCodes = bindings
      .map((entry) => (entry && typeof entry === 'object' ? entry as Record<string, unknown> : null))
      .map((entry) => readOptionalString(entry?.grant_program_code ?? entry?.program_code ?? entry?.programCode))
      .filter((code): code is string => Boolean(code))
    for (const code of bindingCodes) {
      let profileId = profileIds.get(`${campaign.realm_id}::${code}`)
      if (!profileId) {
        const fetched = await trx
          .selectFrom('grant_programs')
          .select('program_id')
          .where('realm_id', '=', campaign.realm_id)
          .where('program_code', '=', code)
          .executeTakeFirst()
        if (!fetched) {
          throw new Error(`importer: grant_campaign ${campaign.name} references unknown program ${code}`)
        }
        profileId = String(fetched.program_id)
        profileIds.set(`${campaign.realm_id}::${code}`, profileId)
      }
    }
    const current = byKey.get(key)
    if (!current) {
      await trx
        .insertInto('grant_campaigns')
        .values({
          realm_id: campaign.realm_id,
          name: campaign.name,
          status: campaign.status,
          window_start: campaign.window_start ?? new Date(),
          window_end: campaign.window_end ?? null,
          target_filter: campaign.target_filter ?? {},
          metadata: campaign.metadata ?? {},
        })
        .executeTakeFirst()
      bump(summary, 'grant_campaigns', 'created')
      recordCreated(summary, 'grant_campaigns', { realm_id: campaign.realm_id, name: campaign.name })
    } else {
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      const currentWindowStart = current.window_start instanceof Date ? current.window_start.toISOString() : String(current.window_start)
      const nextWindowStart = (campaign.window_start ?? new Date()).toISOString()
      const currentWindowEnd = current.window_end ? (current.window_end instanceof Date ? current.window_end.toISOString() : String(current.window_end)) : null
      const nextWindowEnd = campaign.window_end ? campaign.window_end.toISOString() : null
      if (current.status !== campaign.status) {
        changes.status = { current: current.status, next: campaign.status }
      }
      if (currentWindowStart !== nextWindowStart) {
        changes.window_start = { current: currentWindowStart, next: nextWindowStart }
      }
      if (currentWindowEnd !== nextWindowEnd) {
        changes.window_end = { current: currentWindowEnd, next: nextWindowEnd }
      }
      if (!deepEqual(current.target_filter ?? {}, campaign.target_filter ?? {})) {
        changes.target_filter = { current: current.target_filter ?? {}, next: campaign.target_filter ?? {} }
      }
      if (!deepEqual(current.metadata ?? {}, campaign.metadata ?? {})) {
        changes.metadata = { current: current.metadata ?? {}, next: campaign.metadata ?? {} }
      }
      const needsUpdate = Object.keys(changes).length > 0
      if (needsUpdate) {
        await trx
          .updateTable('grant_campaigns')
          .set({
            status: campaign.status,
            window_start: campaign.window_start ?? new Date(),
            window_end: campaign.window_end ?? null,
            target_filter: campaign.target_filter ?? {},
            metadata: campaign.metadata ?? {},
            updated_at: new Date(),
          })
          .where('campaign_id', '=', current.campaign_id)
          .executeTakeFirst()
        bump(summary, 'grant_campaigns', 'updated')
        recordUpdated(summary, 'grant_campaigns', key, changes)
      } else {
        bump(summary, 'grant_campaigns', 'unchanged')
      }
    }
  }
}

async function upsertEventRatingPolicies(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
  opts: ApplyOptions,
): Promise<void> {
  if (spec.eventRatingPolicies.length === 0) return
  const realmIds = Array.from(new Set(spec.eventRatingPolicies.map((p) => p.realm_id))).filter(Boolean)
  const existing = await trx
    .selectFrom('event_rating_policies')
    .select(['realm_id', 'policy_id', 'name', 'status'])
    .where('realm_id', 'in', realmIds)
    .execute()

  const byKey = new Map(existing.map((row) => [`${row.realm_id}::${row.policy_id}`, row]))
  const desired = new Set<string>()

  for (const policy of spec.eventRatingPolicies) {
    const key = `${policy.realm_id}::${policy.policy_id}`
    desired.add(key)
    const current = byKey.get(key)
    if (!current) {
      await trx
        .insertInto('event_rating_policies')
        .values({
          realm_id: policy.realm_id,
          policy_id: policy.policy_id,
          name: policy.name,
          status: policy.status ?? 'active',
        })
        .executeTakeFirst()
      bump(summary, 'event_rating_policies', 'created')
      recordCreated(summary, 'event_rating_policies', { realm_id: policy.realm_id, policy_id: policy.policy_id })
    } else {
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      const updates: Record<string, unknown> = {}
      if (current.name !== policy.name) {
        updates.name = policy.name
        changes.name = { current: current.name, next: policy.name }
      }
      if (current.status !== policy.status) {
        updates.status = policy.status
        changes.status = { current: current.status, next: policy.status }
      }
      if (Object.keys(updates).length > 0) {
        await trx
          .updateTable('event_rating_policies')
          .set(updates)
          .where('realm_id', '=', policy.realm_id)
          .where('policy_id', '=', policy.policy_id)
          .executeTakeFirst()
        bump(summary, 'event_rating_policies', 'updated')
        recordUpdated(summary, 'event_rating_policies', key, changes)
      } else {
        bump(summary, 'event_rating_policies', 'unchanged')
      }
    }
  }

  if (opts.mode === 'replace') {
    for (const row of existing) {
      const key = `${row.realm_id}::${row.policy_id}`
      if (desired.has(key)) continue
      if (row.status === 'disabled') continue
      await trx
        .updateTable('event_rating_policies')
        .set({ status: 'disabled' })
        .where('realm_id', '=', row.realm_id)
        .where('policy_id', '=', row.policy_id)
        .executeTakeFirst()
      bump(summary, 'event_rating_policies', 'disabled')
      recordDisabled(summary, 'event_rating_policies', { realm_id: row.realm_id, policy_id: row.policy_id })
    }
  }
}

async function upsertEventRatingPolicyVersions(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
  opts: ApplyOptions,
): Promise<void> {
  if (spec.eventRatingPolicyVersions.length === 0) return
  const realmIds = Array.from(new Set(spec.eventRatingPolicyVersions.map((v) => v.realm_id))).filter(Boolean)
  const policyIds = Array.from(new Set(spec.eventRatingPolicyVersions.map((v) => v.policy_id))).filter(Boolean)
  const existing = await trx
    .selectFrom('event_rating_policy_versions')
    .select(['realm_id', 'policy_id', 'policy_version', 'status', 'effective_at', 'dsl_hash', 'dsl_json'])
    .where('realm_id', 'in', realmIds)
    .where('policy_id', 'in', policyIds)
    .execute()

  const byKey = new Map(existing.map((row) => [`${row.realm_id}::${row.policy_id}::${row.policy_version}`, row]))
  const desired = new Set<string>()
  const desiredByPolicy = new Map<string, Set<string>>()

  for (const version of spec.eventRatingPolicyVersions) {
    const key = `${version.realm_id}::${version.policy_id}::${version.policy_version}`
    desired.add(key)
    const policyKey = `${version.realm_id}::${version.policy_id}`
    if (!desiredByPolicy.has(policyKey)) desiredByPolicy.set(policyKey, new Set())
    desiredByPolicy.get(policyKey)!.add(key)

    const current = byKey.get(key)
    if (!current) {
      await trx
        .insertInto('event_rating_policy_versions')
        .values({
          realm_id: version.realm_id,
          policy_id: version.policy_id,
          policy_version: version.policy_version,
          status: version.status ?? 'active',
          effective_at: version.effective_at,
          dsl_json: version.dsl_json,
          dsl_hash: version.dsl_hash,
        })
        .executeTakeFirst()
      bump(summary, 'event_rating_policy_versions', 'created')
      recordCreated(summary, 'event_rating_policy_versions', {
        realm_id: version.realm_id,
        policy_id: version.policy_id,
        policy_version: version.policy_version,
      })
    } else {
      const changes: Record<string, { current: unknown; next: unknown }> = {}
      const updates: Record<string, unknown> = {}
      if (current.status !== version.status) {
        updates.status = version.status
        changes.status = { current: current.status, next: version.status }
      }

      // Policy versions are immutable: allow status changes, but forbid changing DSL/effective_at once created.
      const currentEffectiveAt = current.effective_at instanceof Date ? current.effective_at.toISOString() : String(current.effective_at)
      const nextEffectiveAt = version.effective_at.toISOString()
      if (currentEffectiveAt !== nextEffectiveAt) {
        throw new Error(
          `importer: event_rating_policy_version immutable: cannot change effective_at for ${key} (${currentEffectiveAt} -> ${nextEffectiveAt})`,
        )
      }
      if (current.dsl_hash !== version.dsl_hash) {
        throw new Error(
          `importer: event_rating_policy_version immutable: cannot change dsl_hash for ${key} (${current.dsl_hash} -> ${version.dsl_hash})`,
        )
      }
      if (!deepEqual(current.dsl_json, version.dsl_json)) {
        throw new Error(`importer: event_rating_policy_version immutable: cannot change dsl_json for ${key}`)
      }
      if (Object.keys(updates).length > 0) {
        await trx
          .updateTable('event_rating_policy_versions')
          .set(updates)
          .where('realm_id', '=', version.realm_id)
          .where('policy_id', '=', version.policy_id)
          .where('policy_version', '=', version.policy_version)
          .executeTakeFirst()
        bump(summary, 'event_rating_policy_versions', 'updated')
        recordUpdated(summary, 'event_rating_policy_versions', key, changes)
      } else {
        bump(summary, 'event_rating_policy_versions', 'unchanged')
      }
    }
  }

  if (opts.mode === 'replace') {
    for (const row of existing) {
      const key = `${row.realm_id}::${row.policy_id}::${row.policy_version}`
      const policyKey = `${row.realm_id}::${row.policy_id}`
      const desiredKeysForPolicy = desiredByPolicy.get(policyKey)
      if (!desiredKeysForPolicy) continue
      if (desiredKeysForPolicy.has(key)) continue
      if (row.status === 'deprecated') continue
      await trx
        .updateTable('event_rating_policy_versions')
        .set({ status: 'deprecated' })
        .where('realm_id', '=', row.realm_id)
        .where('policy_id', '=', row.policy_id)
        .where('policy_version', '=', row.policy_version)
        .executeTakeFirst()
      bump(summary, 'event_rating_policy_versions', 'disabled')
      recordDisabled(summary, 'event_rating_policy_versions', {
        realm_id: row.realm_id,
        policy_id: row.policy_id,
        policy_version: row.policy_version,
      })
    }
  }
}

async function upsertBillingContracts(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
  opts: ApplyOptions,
): Promise<void> {
  if (spec.billingContracts.length === 0) return
  const realmIds = Array.from(new Set(spec.billingContracts.map((c) => c.realm_id))).filter(Boolean)
  const contractIds = Array.from(new Set(spec.billingContracts.map((c) => c.contract_id))).filter(Boolean)

  const existingById = await trx
    .selectFrom('billing_contracts')
    .select(['contract_id', 'realm_id', 'billing_account_id', 'status', 'effective_at', 'name', 'metadata'])
    .where('contract_id', 'in', contractIds)
    .execute()

  const byId = new Map(existingById.map((row) => [String(row.contract_id), row]))

  for (const contract of spec.billingContracts) {
    const current = byId.get(contract.contract_id)
    if (!current) {
      await trx
        .insertInto('billing_contracts')
        .values({
          contract_id: contract.contract_id,
          realm_id: contract.realm_id,
          billing_account_id: contract.billing_account_id,
          status: contract.status,
          effective_at: contract.effective_at,
          name: contract.name ?? null,
          metadata: contract.metadata ?? {},
        })
        .executeTakeFirst()
      bump(summary, 'billing_contracts', 'created')
      recordCreated(summary, 'billing_contracts', { realm_id: contract.realm_id, contract_id: contract.contract_id })
      continue
    }

    // Contracts are treated as immutable w.r.t. realm/account bindings. If an import tries to "change"
    // realm_id or billing_account_id for an existing contract_id, ignore those fields (do not crash).
    const currentEffectiveAt = current.effective_at instanceof Date ? current.effective_at.toISOString() : String(current.effective_at)
    const nextEffectiveAt = contract.effective_at.toISOString()
    if (currentEffectiveAt !== nextEffectiveAt) {
      throw new Error(`importer: billing_contract immutable: effective_at mismatch for ${contract.contract_id}`)
    }

    const changes: Record<string, { current: unknown; next: unknown }> = {}
    const updates: Record<string, unknown> = {}
    if (current.status !== contract.status) {
      updates.status = contract.status
      changes.status = { current: current.status, next: contract.status }
    }
    const nameNext = contract.name ?? null
    if ((current.name ?? null) !== nameNext) {
      updates.name = nameNext
      changes.name = { current: current.name ?? null, next: nameNext }
    }
    const metadataNext = contract.metadata ?? {}
    if (!deepEqual(current.metadata ?? {}, metadataNext)) {
      updates.metadata = metadataNext
      changes.metadata = { current: current.metadata ?? {}, next: metadataNext }
    }

    if (Object.keys(updates).length > 0) {
      await trx.updateTable('billing_contracts').set(updates).where('contract_id', '=', contract.contract_id).executeTakeFirst()
      bump(summary, 'billing_contracts', 'updated')
      recordUpdated(summary, 'billing_contracts', contract.contract_id, changes)
    } else {
      bump(summary, 'billing_contracts', 'unchanged')
    }
  }

  if (opts.mode === 'replace') {
    const existingForReplace = await trx
      .selectFrom('billing_contracts')
      .select(['contract_id', 'realm_id', 'status'])
      .where('realm_id', 'in', realmIds)
      .execute()
    const desired = new Set(spec.billingContracts.map((c) => c.contract_id))
    for (const row of existingForReplace) {
      const id = String(row.contract_id)
      if (desired.has(id)) continue
      if (row.status === 'disabled') continue
      await trx.updateTable('billing_contracts').set({ status: 'disabled' }).where('contract_id', '=', id).executeTakeFirst()
      bump(summary, 'billing_contracts', 'disabled')
      recordDisabled(summary, 'billing_contracts', { realm_id: row.realm_id, contract_id: id })
    }
  }
}

async function upsertContractTerms(
  trx: Transaction<Database>,
  spec: BillingImportSpec,
  summary: ImportSummary,
): Promise<void> {
  if (spec.contractTerms.length === 0) return
  const contractIds = Array.from(new Set(spec.contractTerms.map((t) => t.contract_id))).filter(Boolean)
  const existing = await trx
    .selectFrom('contract_terms')
    .select(['contract_id', 'kind', 'term_key', 'effective_at', 'value_json'])
    .where('contract_id', 'in', contractIds)
    .execute()
  const byKey = new Map<string, (typeof existing)[number]>()
  for (const row of existing) {
    const effective = row.effective_at instanceof Date ? row.effective_at.toISOString() : String(row.effective_at)
    byKey.set(`${row.contract_id}::${row.kind}::${row.term_key}::${effective}`, row)
  }

  for (const term of spec.contractTerms) {
    const effective = term.effective_at.toISOString()
    const key = `${term.contract_id}::${term.kind}::${term.term_key}::${effective}`
    const current = byKey.get(key)
    if (!current) {
      await trx
        .insertInto('contract_terms')
        .values({
          contract_id: term.contract_id,
          kind: term.kind,
          term_key: term.term_key,
          effective_at: term.effective_at,
          value_json: toJsonb(term.value_json),
        })
        .executeTakeFirst()
      bump(summary, 'contract_terms', 'created')
      recordCreated(summary, 'contract_terms', { contract_id: term.contract_id, kind: term.kind, term_key: term.term_key, effective_at: effective })
      byKey.set(key, {
        contract_id: term.contract_id,
        kind: term.kind,
        term_key: term.term_key,
        effective_at: term.effective_at,
        value_json: term.value_json,
      } as (typeof existing)[number])
      continue
    }

    if (!deepEqual(current.value_json, term.value_json)) {
      throw new Error(`importer: contract_terms immutable: cannot change value_json for ${key}`)
    }
    bump(summary, 'contract_terms', 'unchanged')
  }
}

class PlanComputationError extends Error {
  summary: ImportSummary
  constructor(summary: ImportSummary) {
    super('import-plan')
    this.summary = summary
  }
}

async function performImport(spec: BillingImportSpec, opts: ApplyOptions, planMode: boolean): Promise<ImportSummary> {
  const summary: ImportSummary = {}
  const run = async (trx: Transaction<Database>) => {
    const sessionRealm = spec.realmIds[0]
    if (sessionRealm) {
      await setRlsSession(trx as unknown as Kysely<Database>, { realmId: sessionRealm, isRealmAdmin: true })
    }

    // Ensure explicitly-declared realms exist (insert only; never overwrite)
    if (spec.realms.length > 0) {
      const explicitIds = spec.realms.map((r) => r.realm_id)
      const existing = await trx
        .selectFrom('realms')
        .select('realm_id')
        .where('realm_id', 'in', explicitIds)
        .execute()
      const existingIds = new Set(existing.map((r) => r.realm_id))
      for (const realm of spec.realms) {
        if (existingIds.has(realm.realm_id)) continue
        await setRlsSession(trx as unknown as Kysely<Database>, { realmId: realm.realm_id, isRealmAdmin: true })
        await createRealm(trx, {
          realmId: realm.realm_id,
          name: realm.name ?? realm.realm_id,
          status: realm.status ?? 'active',
          metadata: realm.metadata ?? {},
        })
      }
    }

    await upsertRealms(trx, spec, summary)
    await upsertCurrencies(trx, spec, summary)
    await upsertServiceApiKeys(trx, spec, summary, opts)
    const groupIds = await upsertSubscriptionGroups(trx, spec, summary)
    for (const realmId of spec.realmIds) {
      const realmSpec: BillingImportSpec = {
        ...spec,
        realmId,
        feature_families: spec.feature_families.filter((c) => c.realm_id === realmId),
        catalogProducts: spec.catalogProducts.filter((p) => p.realm_id === realmId || !p.realm_id),
        catalogPrices: spec.catalogPrices.filter((p) => p.realm_id === realmId || !p.realm_id),
        features: spec.features.filter((f) => f.realm_id === realmId),
        meters: spec.meters.filter((m) => m.realm_id === realmId),
        featureMeters: spec.featureMeters.filter((fm) => fm.realm_id === realmId),
        gatePolicies: spec.gatePolicies.filter((p) => p.realm_id === realmId),
        meterPrices: spec.meterPrices.filter((mp) => mp.realm_id === realmId),
        grantCampaigns: spec.grantCampaigns.filter((c) => c.realm_id === realmId),
        grantPrograms: spec.grantPrograms.filter((p) => p.realm_id === realmId),
        billingPlans: spec.billingPlans.filter((p) => p.realm_id === realmId),
        billingAccounts: spec.billingAccounts.filter((a) => a.realm_id === realmId),
        eventRatingPolicies: spec.eventRatingPolicies.filter((p) => p.realm_id === realmId),
        eventRatingPolicyVersions: spec.eventRatingPolicyVersions.filter((v) => v.realm_id === realmId),
        billingContracts: spec.billingContracts.filter((c) => c.realm_id === realmId),
        contractTerms: spec.contractTerms.filter((t) => t.realm_id === realmId),
      }

      await setRlsSession(trx as unknown as Kysely<Database>, { realmId, isRealmAdmin: true })

      await upsertFeatureFamilies(trx, realmSpec, summary)
      const productIds = await upsertCatalogProducts(trx, realmSpec, summary)
      const _priceIds = await upsertCatalogPrices(trx, realmSpec, summary, productIds, groupIds, opts)
      const featureResult = await upsertFeaturesAndPrimaryMeters(trx, realmSpec, summary)
      const mergedMeters = [
        ...realmSpec.meters,
        ...featureResult.extraMeters.filter((m) => m.realm_id === realmId),
      ]

      const meterIds = await upsertMeters(trx, mergedMeters, summary, featureResult.meterIds, featureResult.handledMeterKeys, featureResult.priceUpserts)
      const featureIds = featureResult.featureIds
      const combinedFeatureMeters = [
        ...realmSpec.featureMeters,
        ...featureResult.autoFeatureMeters.filter((fm) => fm.realm_id === realmId),
      ]
      await upsertFeatureMeters(
        trx,
        { ...realmSpec, featureMeters: combinedFeatureMeters },
        summary,
        featureIds,
        meterIds,
        opts,
        featureResult.primaryFeatureMeterKeys,
      )
      await upsertGatePolicies(trx, realmSpec, summary, opts)
      await upsertMeterPrices(trx, realmSpec, summary, opts)
      const _billingPlanIds = await upsertBillingPlans(trx, realmSpec, summary)
      const programIds = await upsertGrantPrograms(trx, realmSpec, summary)
      await upsertGrantCampaigns(trx, realmSpec, summary, programIds)
      await upsertEventRatingPolicies(trx, realmSpec, summary, opts)
      await upsertEventRatingPolicyVersions(trx, realmSpec, summary, opts)
      await upsertBillingAccounts(trx, realmSpec, summary)
      await upsertBillingContracts(trx, realmSpec, summary, opts)
      await upsertContractTerms(trx, realmSpec, summary)
    }

    if (planMode) throw new PlanComputationError(summary)
  }

  if (planMode) {
    try {
      await db().transaction().execute(run)
    } catch (err) {
      if (err instanceof PlanComputationError) {
        return err.summary
      }
      throw err
    }
    return summary
  } else {
    await db().transaction().execute(run)
    return summary
  }
}

export async function applyBillingImportFromFile(filePath: string, options?: ApplyOptions): Promise<ImportSummary> {
  const opts: ApplyOptions = { mode: 'merge', strict: false, ...(options ?? {}) }
  if (opts.mode && !['merge', 'replace'].includes(opts.mode)) {
    throw new Error(`importer: unsupported mode ${opts.mode}`)
  }
  const spec = await loadBillingImportSpec(filePath, Boolean(opts.strict))
  await ensurePrimaryFeatureConstraint(spec, Boolean(opts.strict))
  return performImport(spec, opts, false)
}

export async function planBillingImportFromFile(filePath: string, options?: ApplyOptions): Promise<PlanResult> {
  const opts: ApplyOptions = { ...(options ?? {}), mode: 'merge' }
  const spec = await loadBillingImportSpec(filePath, Boolean(opts.strict))
  await ensurePrimaryFeatureConstraint(spec, Boolean(opts.strict))
  const summary = await performImport(spec, opts, true)
  return {
    entries: Object.entries(summary).map(([category, counts]) => ({
      category,
      created: counts.created,
      updated: counts.updated,
      unchanged: counts.unchanged,
      deprecated: counts.disabled,
      errors: [],
      samples: {
        created: counts.samples.created.slice(0, SAMPLE_LIMIT),
        updated: counts.samples.updated.slice(0, SAMPLE_LIMIT),
        deprecated: counts.samples.disabled.slice(0, SAMPLE_LIMIT),
      },
    })),
  }
}
