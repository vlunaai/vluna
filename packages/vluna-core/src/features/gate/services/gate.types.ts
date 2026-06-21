import type { components as GateComponents } from '../../../contracts/gate.js'

export type PricingSnapshot = GateComponents['schemas']['PricingSnapshot']
export type QuotaWindow = GateComponents['schemas']['QuotaWindow']
export type RateWindow = GateComponents['schemas']['RateWindow']
export type MeterPriceView = GateComponents['schemas']['MeterPriceView']
export type MeterCoverage = GateComponents['schemas']['MeterCoverage']
export type MeterLimit = GateComponents['schemas']['MeterLimit']

export type RoundingMode = 'floor' | 'nearest' | 'ceil'

export const UNLIMITED_QUOTA_MINOR = -1
export const WILDCARD_FEATURE_CODE = '__wildcard_feature__'

export type PolicyWindowView = {
  policyId: string
  policyName: string
  subjectScope: 'account' | 'user'
  subjectId: string
  featureCode: string
  unit?: string | null
  limitMinor: number
  windowStart: Date
  windowEnd: Date
  windowMs: number
  windowKind: 'quota' | 'rate'
  counterKey: string
  policyStatus: 'assignable' | 'default' | 'ceiling' | 'disabled'
  bindingId?: string
}

export type CounterLookup = Map<string, number>

export type QuotaWindowMetadataEntry = {
  policy_id: string
  subject_scope: 'account' | 'user'
  subject_id: string
  counter_key: string
  window_start: string
  window_end: string
  limit_minor: number
  unit?: string
}

export type RateWindowMetadataEntry = {
  policy_id: string
  subject_scope: 'account' | 'user'
  subject_id: string
  counter_key: string
  window_start: string
  window_end: string
  limit_minor: number
  unit?: string
}

export type LeaseRow = {
  lease_id: string
  policy_id: string
  feature_code: string
  cap_minor: string | null
  state: 'active' | 'closed' | 'expired' | 'canceled'
  expires_at: Date | null
  reservation_minor: string | null
  budget_id: string | null
  metadata: Record<string, unknown> | null
  request_hash: string | null
}

export type MeterSemanticKind = 'activity' | 'outcome'

export type FeatureMeter = {
  meter_code: string
  semantic_kind: MeterSemanticKind
  metadata: Record<string, unknown> | null
  usageMetadata: Record<string, unknown> | null
  is_primary: boolean
}

export type CommitItemNormalized = {
  meter_code: string
  quantityMinor: number
}

export type FeatureLimitsExpand = Set<'quotas' | 'rates'>

export type FeatureLimitResponse = {
  feature_code: string
  feature_family_code?: string
  unit?: string
  meters?: string[]
  quotas?: QuotaWindow[]
  rates?: RateWindow[]
}
