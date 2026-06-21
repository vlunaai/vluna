import { Injectable, HttpException, Inject, Optional } from '@nestjs/common'
import type { Kysely, Transaction } from 'kysely'
import type { AppRequest } from '../../../types/app-request.js'
import type { Database } from '../../../types/database.js'
import type { components as GateComponents } from '../../../contracts/gate.js'
import { setRlsSession } from '../../../db/index.js'
import {
  runInTransaction,
  nowIso,
  hashRequest,
  buildErrorObject,
  toSafeNumber,
  bigintFromUnknown,
  parseLeaseToken,
  hashToken,
  parseStringArray,
  parseAsOfTimestamp,
  makeWindowSignature,
  parseOptionalNonNegativeInt,
  parsePositiveInt,
} from './gate.utils.js'
import { BudgetService } from '../../../services/budget.service.js'
import { LeaseService } from './lease.service.js'
import { PricingService, PricingItemResult, MeterPriceInfo, PricingComputation } from './pricing.service.js'
import { QuotaService } from './quota.service.js'
import { SettlementService } from './settlement.service.js'
import { GrantBalanceService } from '../../../services/grant-balance.service.js'
import { MeterService } from '../../billing/services/meter.service.js'
import { envFlag } from '../../../platform/config.js'
import { normalizeIdentifier } from '../../../utils/identifiers.js'
import { BillingPeriodService } from '../../../services/billing-period.service.js'
import {
  CommitItemNormalized,
  FeatureLimitResponse,
  PricingSnapshot,
  QuotaWindow,
  RateWindow,
  MeterCoverage,
  MeterPriceView,
  PolicyWindowView,
  LeaseRow,
  MeterSemanticKind,
  MeterLimit,
  UNLIMITED_QUOTA_MINOR,
} from './gate.types.js'
import type { GateHint } from './gate.hints.js'
import {
  lowHeadroomHint,
  pricingChangedHint,
  quotaRemainingHint,
  leaseExpiredHint,
  leaseClosedAtCommitHint,
  policyWindowNotFoundHint,
  featureMeterNotAllowedHint,
  pricingNotConfiguredHint,
  contractPricingInvalidTermHint,
  contractPricingMeterPriceMissingHint,
  xusdShortfallHint,
  budgetShortfallHint,
} from './gate.hints.js'
import { GateIdempotencyService } from './idempotency.service.js'
import { NoopUsageAttributionWriter, USAGE_ATTRIBUTION_WRITER, type UsageAttributionWriter } from './usage-attribution.writer.js'

type AuthorizeRequest = GateComponents['schemas']['AuthorizeRequest']
type AuthorizeResponse = GateComponents['schemas']['AuthorizeResponse']
type CommitRequest = GateComponents['schemas']['SingleCommit']
type CommitResponse = GateComponents['schemas']['CommitResponse']
type IngestRequest = GateComponents['schemas']['IngestCommit']
type BatchCommitRequest = GateComponents['schemas']['BatchCommitRequest']
type BatchCommitResponse = GateComponents['schemas']['BatchCommitResponse']
type BatchCommitItemResult = GateComponents['schemas']['BatchCommitItemResult']
type CancelRequest = GateComponents['schemas']['CancelRequest']
type CancelResponse = GateComponents['schemas']['CancelResponse']

const LEASE_TTL_SECONDS = Number(process.env.VLUNA_GATE_LEASE_TTL_SECONDS || 12 * 60 * 60)
const COMMIT_LEDGER_SYNC_ENABLED = (() => {
  const raw = process.env.VLUNA_GATE_ENABLE_LEDGER_SYNC
  if (!raw) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
})()
const LATE_COMMIT_GRACE_MS = (() => {
  const raw = process.env.VLUNA_GATE_LATE_COMMIT_GRACE_MS
  if (!raw) return 60_000
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return 12 * 60 * 60 * 1000
  return Math.floor(parsed)
})()

const LOW_HEADROOM_BASE_THRESHOLD_XUSD = 1_000
const LOW_HEADROOM_MULTIPLIER = 2
type AuthorizeResult = {
  leaseId: string
  leaseToken: string
  budgetId?: string
  reservationAmountXusd: number
  featureCode: string
  featureFamilyCode: string
  windowStart: string
  windowEnd: string
  hints: GateHint[]
  availableGrantXusd: bigint
  billingMode: 'prepaid' | 'postpaid' | 'hybrid'
}

type CommitExecutionResult = {
  response: CommitResponse
  hints: GateHint[]
  lineIds: string[]
  commitId: string | null
  closeContext?: {
    leaseRow: LeaseRow
    lastLineId: string | null
    commitId: string
    reservationRemainingXusd: bigint
  }
}

type ResidualMode = 'postpaid' | 'prepaid'

type NormalizedCommitItem = CommitItemNormalized & {
  clientPricingEtag?: string
  clientUnitPriceXusd?: number
  unit?: string
}

function muteFundingHintsForBillingMode(
  billingMode: 'prepaid' | 'postpaid' | 'hybrid',
  hints: GateHint[],
): GateHint[] {
  if (billingMode === 'prepaid') return hints
  return hints.filter((hint) => {
    const type = hint?.type
    return !(typeof type === 'string' && (type.startsWith('funding.') || type.startsWith('budget.')))
  })
}

@Injectable()
export class GateService {
  private readonly usageAttributionWriter: UsageAttributionWriter

  constructor(
    @Inject(LeaseService) private readonly leaseService: LeaseService,
    @Inject(PricingService) private readonly pricingService: PricingService,
    @Inject(QuotaService) private readonly quotaService: QuotaService,
    @Inject(BudgetService) private readonly budgetService: BudgetService,
    @Inject(SettlementService) private readonly settlementService: SettlementService,
    @Inject(GrantBalanceService) private readonly grantBalanceService: GrantBalanceService,
    @Inject(BillingPeriodService) private readonly billingPeriodService: BillingPeriodService,
    @Inject(GateIdempotencyService) private readonly idempotencyService: GateIdempotencyService,
    @Optional() @Inject(USAGE_ATTRIBUTION_WRITER) usageAttributionWriter?: UsageAttributionWriter,
  ) {
    this.usageAttributionWriter = usageAttributionWriter ?? new NoopUsageAttributionWriter()
  }

  async authorize(
    req: AppRequest,
    body: AuthorizeRequest,
  ): Promise<{ data: AuthorizeResponse; hints?: GateHint[] }> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    const billingUserId = req.ctx?.billingUserId
    const billingAccountId = req.ctx?.billingAccountId
    const idempotencyKey = req.ctx?.idempotencyKey
    const subject = (req.ctx?.businessUserId || billingUserId || '').trim()

    if (!db || !realmId || !billingUserId || !billingAccountId) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED', message: 'missing context' }, 401)
    }
    if (!idempotencyKey) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'missing idempotency key' }, 400)
    }

    let featureCode: string
    try {
      featureCode = normalizeIdentifier(body?.feature_code, 'feature_code')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'feature_code is invalid'
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message }, 422)
    }
    if (!subject) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'subject is required' }, 422)
    }

    const estimatedQuantity = parseOptionalNonNegativeInt(body.estimated_quantity_minor, 'estimated_quantity_minor')
    const labels = this.normalizeLabels(body.labels)
    const requestHash = this.buildAuthorizeRequestHash({
      subject,
      featureCode,
      featureFamilyCode: body.feature_family_code ?? undefined,
      estimatedQuantity,
      budgetId: body.budget_id,
      labels,
    })

    const result = await runInTransaction<AuthorizeResult>(db, async (trx) => {
      await setRlsSession(trx, { realmId, billingAccountId, billingUserId })

      const { feature, meters: featureMeters } = await this.quotaService.loadFeatureWithMeters(trx, {
        realmId,
        featureCode,
        featureFamilyCode: body.feature_family_code,
        autoRegistryMeterSemanticKind: 'activity',
      })
      const featureFamilyCode = feature.feature_family_code ?? body.feature_family_code ?? null
      if (!featureFamilyCode) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'feature_family_code missing for feature' }, 500)
      }
      if (!feature.active) {
        throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'feature inactive' }, 422)
      }

      const now = new Date()
      await this.quotaService.ensureEntitlement(trx, {
        realmId,
        billingAccountId,
        billingUserId,
        featureCode,
        now,
        feature,
      })

      const billingDefaultsPeriod = req.ctx?.realmConfig?.billingDefaultsPeriod ?? null
      const billingModeResolved = await this.billingPeriodService.resolveBillingModeForAt(trx, {
        realmId,
        billingAccountId,
        at: now,
        realmMeta: billingDefaultsPeriod
          ? { billing_defaults: { period: billingDefaultsPeriod } }
          : undefined,
      })
      const shouldEmitFundingHints = billingModeResolved.billingMode === 'prepaid'

      const grantBalances = await this.grantBalanceService.getAccountGrantBalances(trx, {
        billingUserId,
        billingAccountId,
        asOf: now,
      })
      const availableGrantXusd = grantBalances.totals.availableXusd
      const pricingWarnings: GateHint[] = []
      if (availableGrantXusd <= 0 && shouldEmitFundingHints) {
        const meterCodes = featureMeters.map((meter) => meter.meter_code)
        const priceMap = meterCodes.length
          ? await this.pricingService.fetchMeterPricesBatch(trx, {
              realmId,
              meterCodes,
              featureCode,
              billingAccountId,
              at: now,
              onWarning: (warning) => {
                pricingWarnings.push(
                  warning.kind === 'meter_price_missing'
                    ? contractPricingMeterPriceMissingHint({
                        meterCode: warning.meterCode,
                        contractId: warning.contractId,
                        termKey: warning.termKey,
                        message: warning.message,
                      })
                    : contractPricingInvalidTermHint({
                        meterCode: warning.meterCode,
                        contractId: warning.contractId,
                        termKey: warning.termKey,
                        message: warning.message,
                      }),
                )
              },
            })
          : new Map<string, MeterPriceInfo>()

        const isZeroCostFeature =
          featureMeters.length === 0
            ? false
            : featureMeters.every((meter) => {
                const price = priceMap.get(meter.meter_code)
                if (!price) return true // treat missing pricing as zero-cost
                return price.unitPriceXusd === 0n && price.unitCostXusd === 0n
              })

        if (!isZeroCostFeature) {
          throw new HttpException(
            {
              code: 'SERVER.CONFIG',
              message: 'grant balance exhausted',
            },
            402,
          )
        }
      }

      const existingLease = await this.leaseService.findIdempotentLease(trx, {
        idempotencyKey,
        billingUserId,
      })

      if (existingLease) {
        const storedHash = existingLease.request_hash ?? null
        if (storedHash && storedHash !== requestHash) {
          throw new HttpException({ code: 'WRITE.INVALID_PAYLOAD', message: 'idempotency conflict' }, 409)
        }
        const metadata = (existingLease.metadata ?? {}) as Record<string, unknown>
        const storedToken = typeof metadata.lease_token === 'string' ? metadata.lease_token : undefined
        if (!storedToken) {
          throw new HttpException({ code: 'SERVER.CONFIG', message: 'lease token metadata missing' }, 500)
        }
        const hints = Array.isArray(metadata.hints) ? (metadata.hints as GateHint[]) : []
        const storedFeatureFamilyCode =
          typeof metadata.feature_family_code === 'string' && metadata.feature_family_code.trim().length > 0
            ? String(metadata.feature_family_code)
            : featureFamilyCode
        return {
          leaseId: existingLease.lease_id,
          leaseToken: storedToken,
          budgetId: existingLease.budget_id ? String(existingLease.budget_id) : undefined,
          reservationAmountXusd: 0,
          featureCode,
          featureFamilyCode: storedFeatureFamilyCode ?? undefined,
          windowStart: String(metadata.window_start || nowIso()),
          windowEnd: String(metadata.window_end || nowIso()),
          hints,
          availableGrantXusd,
          billingMode: billingModeResolved.billingMode,
        }
      }

      const policyWindows = await this.quotaService.loadActivePolicyWindows(trx, realmId, billingAccountId, billingUserId, now)
      const featureWindows = policyWindows.filter((window) => window.featureCode === featureCode)
      if (featureWindows.length === 0) {
        throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'no active policy for feature' }, 422)
      }

      const quotaWindows = featureWindows.filter((window) => window.windowKind === 'quota')
      if (quotaWindows.length === 0) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'no quota policy window configured for feature' }, 500)
      }

      const counters = await this.quotaService.loadCounterLookup(trx, realmId, billingAccountId, billingUserId, quotaWindows)
      const quotaSummaries = quotaWindows.map((window) => {
        if (!window.counterKey) {
          throw new HttpException({ code: 'SERVER.CONFIG', message: 'quota window missing counter key' }, 500)
        }
        const usedMinor = this.quotaService.getWindowUsage(window, counters)
        const isUnlimited = window.limitMinor === UNLIMITED_QUOTA_MINOR
        const remainingQuantityMinor = isUnlimited ? Number.MAX_SAFE_INTEGER : Math.max(0, window.limitMinor - usedMinor)
        return { window, usedMinor, remainingQuantityMinor, isUnlimited }
      })

      let smallestRemaining = Infinity
      for (const quotaSummary of quotaSummaries) {
        if (!quotaSummary.isUnlimited && quotaSummary.remainingQuantityMinor <= 0) {
          throw new HttpException(
            {
              code: 'SERVER.CONFIG',
              message: 'quota limit exhausted',
            },
            402,
          )
        }
        if (!quotaSummary.isUnlimited && quotaSummary.remainingQuantityMinor < smallestRemaining) {
          smallestRemaining = quotaSummary.remainingQuantityMinor
        }
      }
      if (!Number.isFinite(smallestRemaining)) {
        smallestRemaining = Number.MAX_SAFE_INTEGER
      }

      const hints: GateHint[] = []
      hints.push(...pricingWarnings)
      const requestedQuantity = estimatedQuantity !== undefined ? estimatedQuantity : smallestRemaining

      if (estimatedQuantity === undefined && requestedQuantity > smallestRemaining) {
        hints.push(quotaRemainingHint(smallestRemaining))
      }

      const rateWindows = featureWindows.filter((window) => window.windowKind === 'rate')
      if (rateWindows.length > 0) {
        const { hints: rateHints } = await this.quotaService.enforceRateWindows(trx, {
          billingUserId,
          billingAccountId,
          windows: rateWindows,
          increment: 1,
          now,
        })
        hints.push(...rateHints)
      }

      const requestedBudgetId = body.budget_id ? String(body.budget_id) : undefined
      let effectiveBudgetId: string | undefined
      if (requestedBudgetId) {
        const budgetSnapshot = await this.budgetService.previewBudgetLimit(trx, {
          realmId,
          billingUserId,
          billingAccountId,
          budgetId: requestedBudgetId,
          now,
        })
        effectiveBudgetId = budgetSnapshot.budgetId
        if (shouldEmitFundingHints) {
          hints.push(...budgetSnapshot.hints)
        }

        if (budgetSnapshot.remainingHeadroomXusd !== null) {
          const availableForNext = budgetSnapshot.remainingHeadroomXusd + budgetSnapshot.reservedXusd
          if (availableForNext <= 0n) {
            if (shouldEmitFundingHints) {
              throw new HttpException(
                {
                  code: 'BUDGET.EXHAUSTED',
                  message: 'budget has no headroom after refill',
                  hints,
                },
                402,
              )
            }
          }
        }
      }

      const estimatedQuantityMinor = estimatedQuantity !== undefined
        ? BigInt(Math.max(0, Math.floor(estimatedQuantity)))
        : null

      if (estimatedQuantityMinor !== null && estimatedQuantityMinor > 0n && featureMeters.length > 0) {
        const meterCodes = featureMeters.map((meter) => meter.meter_code)
        const meterPriceMap = await this.pricingService.fetchMeterPricesBatch(trx, {
          realmId,
          meterCodes,
          featureCode,
          billingAccountId,
          at: now,
          onWarning: (warning) => {
            hints.push(
              warning.kind === 'meter_price_missing'
                ? contractPricingMeterPriceMissingHint({
                    meterCode: warning.meterCode,
                    contractId: warning.contractId,
                    termKey: warning.termKey,
                    message: warning.message,
                  })
                : contractPricingInvalidTermHint({
                    meterCode: warning.meterCode,
                    contractId: warning.contractId,
                    termKey: warning.termKey,
                    message: warning.message,
                  }),
            )
          },
        })

        const coverageInputs = featureMeters
          .map((meter) => {
            const price = meterPriceMap.get(meter.meter_code)
            if (!price) return null
            return {
              meterCode: meter.meter_code,
              featureCode,
              price,
            }
          })
          .filter((entry): entry is { meterCode: string; featureCode: string; price: MeterPriceInfo } => entry !== null)

        const missingPricing = featureMeters
          .filter((meter) => !meterPriceMap.has(meter.meter_code))
          .map((meter) => meter.meter_code)
        if (missingPricing.length > 0) {
          hints.push(pricingNotConfiguredHint(featureCode, missingPricing))
        }

        if (coverageInputs.length > 0) {
          const coverageMap = await this.buildMeterCoverages(trx, {
            realmId,
            billingUserId,
            billingAccountId,
            asOf: now,
            profile: 'conservative',
            inputs: coverageInputs,
            budgetId: effectiveBudgetId,
          })

          const bestGrant = coverageInputs.reduce<{
            meterCode: string
            available: bigint
            price: MeterPriceInfo
          }>(
            (acc, input) => {
              const entry = coverageMap.get(input.meterCode)
              const coverage = entry?.grants
              if (!coverage) return acc
              const available = bigintFromUnknown(coverage.max_quantity_minor_estimated) ?? 0n
              if (available > acc.available) {
                return { meterCode: input.meterCode, available, price: input.price }
              }
              return acc
            },
            { meterCode: coverageInputs[0].meterCode, available: 0n, price: coverageInputs[0].price },
          )

          const grantSatisfied = coverageInputs.some((input) => {
            const entry = coverageMap.get(input.meterCode)
            const coverage = entry?.grants
            if (!coverage) return false
            const available = bigintFromUnknown(coverage.max_quantity_minor_estimated) ?? 0n
            return available >= estimatedQuantityMinor
          })

          if (!grantSatisfied) {
            const shortfallQuantity = estimatedQuantityMinor > bestGrant.available
              ? estimatedQuantityMinor - bestGrant.available
              : estimatedQuantityMinor
            const shortfallXusd = this.computeAuthorizeWorstCaseAmount(shortfallQuantity, bestGrant.price)
            if (shouldEmitFundingHints && shortfallXusd > 0n) {
              hints.push(xusdShortfallHint(shortfallXusd))
            }
            const hintQuantity = bestGrant.available > BigInt(Number.MAX_SAFE_INTEGER)
              ? Number.MAX_SAFE_INTEGER
              : Number(bestGrant.available)
            if (shouldEmitFundingHints) {
              hints.push(quotaRemainingHint(hintQuantity, 'insufficient credits to cover estimated usage'))
            }
          }

          if (effectiveBudgetId) {
            const bestBudget = coverageInputs.reduce<{
              meterCode: string
              available: bigint
              price: MeterPriceInfo
            }>(
              (acc, input) => {
                const entry = coverageMap.get(input.meterCode)
                const coverage = entry?.budget
                if (!coverage) return acc
                const available = bigintFromUnknown(coverage.max_quantity_minor_estimated) ?? 0n
                if (available > acc.available) {
                  return { meterCode: input.meterCode, available, price: input.price }
                }
                return acc
              },
              { meterCode: coverageInputs[0].meterCode, available: 0n, price: coverageInputs[0].price },
            )

            const budgetSatisfied = coverageInputs.some((input) => {
              const entry = coverageMap.get(input.meterCode)
              const coverage = entry?.budget
              if (!coverage) return false
              const available = bigintFromUnknown(coverage.max_quantity_minor_estimated) ?? 0n
              return available >= estimatedQuantityMinor
            })

            if (!budgetSatisfied) {
              const shortfallQuantity = estimatedQuantityMinor > bestBudget.available
                ? estimatedQuantityMinor - bestBudget.available
                : estimatedQuantityMinor
              const shortfallXusd = this.computeAuthorizeWorstCaseAmount(shortfallQuantity, bestBudget.price)
              if (shouldEmitFundingHints && shortfallXusd > 0n) {
                hints.push(budgetShortfallHint(effectiveBudgetId, shortfallXusd))
              }
              const hintQuantity = bestBudget.available > BigInt(Number.MAX_SAFE_INTEGER)
                ? Number.MAX_SAFE_INTEGER
                : Number(bestBudget.available)
              if (shouldEmitFundingHints) {
                hints.push(quotaRemainingHint(hintQuantity, 'budget cannot cover estimated usage'))
              }
            }
          }
        }
      }

      const expiresAt = new Date(now.getTime() + LEASE_TTL_SECONDS * 1000)
      const quotaMetadata = quotaWindows.map((window) => this.quotaService.toQuotaWindowMetadata(window))
      const rateMetadata =
        rateWindows.length > 0 ? rateWindows.map((window) => this.quotaService.toRateWindowMetadata(window)) : undefined

      const metadata: Record<string, unknown> = {
        schema: 'gate.authorize.v2',
        subject,
        feature_code: featureCode,
        feature_family_code: featureFamilyCode,
        estimated_quantity_minor: estimatedQuantity ?? null,
        hints: muteFundingHintsForBillingMode(billingModeResolved.billingMode, hints),
        labels,
        quota_windows: quotaMetadata,
        rate_windows: rateMetadata,
        window_start: quotaWindows[0]?.windowStart.toISOString() ?? nowIso(),
        window_end: quotaWindows[0]?.windowEnd.toISOString() ?? nowIso(),
      }
      const { leaseId, leaseToken } = await this.leaseService.createLease(trx, {
        billingUserId,
        billingAccountId,
        policyId: quotaWindows[0].policyId,
        featureCode,
        capMinor: requestedQuantity,
        expiresAt,
        idempotencyKey,
        requestHash,
        budgetId: effectiveBudgetId ?? undefined,
        reservationAmountXusd: 0,
        metadata,
      })

      return {
        leaseId,
        leaseToken,
        budgetId: effectiveBudgetId,
        reservationAmountXusd: 0,
        featureCode,
        featureFamilyCode,
        windowStart: metadata.window_start as string,
        windowEnd: metadata.window_end as string,
        hints: muteFundingHintsForBillingMode(billingModeResolved.billingMode, hints),
        availableGrantXusd,
        billingMode: billingModeResolved.billingMode,
      }
    })

    const leaseId = result.leaseId
    if (!leaseId) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'invalid lease identifier' }, 500)
    }

    const response: AuthorizeResponse = {
      lease_token: result.leaseToken,
      lease_id: leaseId,
      budget_id: result.budgetId,
      feature_code: result.featureCode,
      feature_family_code: result.featureFamilyCode,
      window_start: result.windowStart,
      window_end: result.windowEnd,
    }

    const hints: GateHint[] = []
    hints.push(...result.hints)
    if (result.billingMode === 'prepaid' && result.availableGrantXusd <= 0n) {
      hints.push(xusdShortfallHint(1))
    }

    return {
      data: response,
      hints: hints.length > 0 ? hints : undefined,
    }
  }

  async commit(req: AppRequest, body: CommitRequest): Promise<{ data: CommitResponse; hints?: GateHint[] }> {
    const idempotencyKey = req.ctx?.idempotencyKey
    if (!idempotencyKey) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'missing idempotency key' }, 400)
    }
    const { response, hints } = await this.executeCommit(req, body, idempotencyKey)
    return { data: response, hints: hints.length > 0 ? hints : undefined }
  }

  async ingest(req: AppRequest, body: IngestRequest): Promise<{ data: CommitResponse; hints?: GateHint[] }> {
    const idempotencyKey = req.ctx?.idempotencyKey
    if (!idempotencyKey) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'missing idempotency key' }, 400)
    }
    const { response, hints } = await this.executeIngest(req, body, idempotencyKey, 'activity')
    return { data: response, hints: hints.length > 0 ? hints : undefined }
  }

  async ingestInternal(
    db: Kysely<Database> | Transaction<Database>,
    ctx: { realmId: string; billingUserId: string; billingAccountId: string },
    body: IngestRequest,
    idempotencyKey: string,
    expectedMeterSemanticKind: MeterSemanticKind,
  ): Promise<{ response: CommitResponse; hints: GateHint[] }> {
    const req = {
      ctx: {
        db,
        realmId: ctx.realmId,
        billingUserId: ctx.billingUserId,
        billingAccountId: ctx.billingAccountId,
      },
    } as AppRequest
    return this.executeIngest(req, body, idempotencyKey, expectedMeterSemanticKind)
  }

  async batchCommit(req: AppRequest, body: BatchCommitRequest): Promise<BatchCommitResponse> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    const billingUserId = req.ctx?.billingUserId
    const billingAccountId = req.ctx?.billingAccountId
    if (!db || !realmId || !billingUserId || !billingAccountId) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED', message: 'missing context' }, 401)
    }
    const ensuredDb = db as NonNullable<typeof db>
    const ensuredRealmId = realmId as NonNullable<typeof realmId>
    const ensuredBillingUserId = billingUserId as NonNullable<typeof billingUserId>
    const ensuredBillingAccountId = billingAccountId as NonNullable<typeof billingAccountId>

    const items = Array.isArray(body?.items) ? body.items : []
    if (items.length === 0) {
      return { items: [], committed_count: 0, failed_count: 0 }
    }

    const results: BatchCommitItemResult[] = []
    let committedCount = 0
    let failedCount = 0
    const closeContexts: NonNullable<CommitExecutionResult['closeContext']>[] = []

    for (const [index, item] of items.entries()) {
      const itemIdem = item.idempotency_key.trim()
      if (!itemIdem) {
        results.push({
          index,
          status: 'invalid',
          error: {
            type: 'VALIDATION.INVALID_INPUT',
            details: 'idempotency_key is required for each batch item',
          },
        })
        failedCount += 1
        continue
      }

      try {
        const commitBody: CommitRequest = {
          lease_token: item.lease_token,
          feature_code: item.feature_code,
          quantity_minor: item.quantity_minor,
          labels: item.labels,
          meters: item.meters,
        }
        const exec = await this.executeCommit(req, commitBody, itemIdem, { deferLeaseClose: true })
        if (exec.closeContext) closeContexts.push(exec.closeContext)
        results.push({ index, status: 'committed', commit: exec.response })
        committedCount += 1
      } catch (error) {
        const errorObject = buildErrorObject(error)
        const statusCode = error instanceof HttpException ? error.getStatus() : 500
        const status: BatchCommitItemResult['status'] = statusCode === 422 ? 'invalid' : 'failed'
        results.push({ index, status, error: errorObject })
        failedCount += 1
      }
    }

    if (closeContexts.length > 0) {
      for (const ctx of closeContexts) {
        await runInTransaction(ensuredDb, async (trx) => {
          await setRlsSession(trx, { realmId: ensuredRealmId, billingAccountId: ensuredBillingAccountId, billingUserId: ensuredBillingUserId })
          await this.closeLeaseAfterCommit(trx, ctx.leaseRow, {
            reservationRemainingXusd: ctx.reservationRemainingXusd,
            lastCommitId: ctx.lastLineId,
            commitId: ctx.commitId,
          })
        })
      }
    }

    return {
      items: results,
      committed_count: committedCount,
      failed_count: failedCount,
    }
  }

  async cancel(req: AppRequest, body: CancelRequest): Promise<CancelResponse> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    const billingUserId = req.ctx?.billingUserId
    const billingAccountId = req.ctx?.billingAccountId
    if (!db || !realmId || !billingUserId || !billingAccountId) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED', message: 'missing context' }, 401)
    }

    const leaseToken = (body?.lease_token || '').trim()
    if (!leaseToken) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'lease_token is required' }, 422)
    }

    const leaseId = parseLeaseToken(leaseToken)
    if (!leaseId) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'invalid lease_token' }, 422)
    }

    const traceId = `cancel_${Date.now().toString(36)}`

    const result = await runInTransaction(db, async (trx) => {
      await setRlsSession(trx, { realmId, billingAccountId, billingUserId })
      const { releasedCap, stateChanged } = await this.leaseService.cancelLease(trx, {
        leaseId,
        billingUserId,
        billingAccountId,
        traceId,
      })
      return { releasedCap, stateChanged }
    })

    return {
      cancelled: result.stateChanged,
      released_cap: result.releasedCap.toString(),
      trace_id: traceId,
    }
  }

  async listFeatureLimits(req: AppRequest): Promise<FeatureLimitResponse[]> {
    const db = req.ctx?.db
    const billingUserId = req.ctx?.billingUserId
    const billingAccountId = req.ctx?.billingAccountId
    const realmId = req.ctx?.realmId
    if (!db || !billingUserId || !billingAccountId || !realmId) return []

    await setRlsSession(db, { realmId, billingAccountId, billingUserId })

    const query = (req.query ?? {}) as Record<string, unknown>
    const featureFilter = parseStringArray(query.feature_code)
    const feature_familyFilter = parseStringArray(query.feature_family_code)
    const expandSet = new Set(parseStringArray(query.expand).map((value) => value.toLowerCase()))
    const includeQuotas = expandSet.has('quotas')
    const includeRates = expandSet.has('rates')
    const asOf = parseAsOfTimestamp(query.as_of)

    const entitlements = await this.quotaService.loadEntitledFeatures(db, {
      realmId,
      billingAccountId,
      billingUserId,
      at: asOf,
      featureCodes: featureFilter.length > 0 ? featureFilter : undefined,
      featureFamilyCodes: feature_familyFilter.length > 0 ? feature_familyFilter : undefined,
    })
    if (entitlements.entitledFeatureCodes.size === 0) return []

    const featureCodes = Array.from(entitlements.entitledFeatureCodes.values()).sort((a, b) => a.localeCompare(b))
    const featureMeters = await this.quotaService.loadFeatureMetersMapByFeatureIds(db, {
      featureIdByCode: entitlements.entitledFeatureIdByCode,
    })

    const policyWindows = await this.quotaService.loadActivePolicyWindows(db, realmId, billingAccountId, billingUserId, asOf)
    const featureSet = new Set(featureCodes)
    const filteredWindows = policyWindows.filter((window) => featureSet.has(window.featureCode))

    const counters =
      includeQuotas || includeRates
        ? await this.quotaService.loadCounterLookup(db, realmId, billingAccountId, billingUserId, filteredWindows)
        : new Map<string, number>()
    const grouped = new Map<string, PolicyWindowView[]>()
    for (const window of filteredWindows) {
      const list = grouped.get(window.featureCode)
      if (list) {
        list.push(window)
      } else {
        grouped.set(window.featureCode, [window])
      }
    }

    const results: FeatureLimitResponse[] = []
    for (const featureCode of featureCodes) {
      const windowsForFeature = grouped.get(featureCode) ?? []

      const unit = windowsForFeature.find((window) => typeof window.unit === 'string')?.unit ?? undefined

      let quotas: QuotaWindow[] | undefined
      if (includeQuotas) {
        const quotaWindows = windowsForFeature.filter((window) => window.windowKind === 'quota')
        quotas = quotaWindows.map((window) => this.quotaService.buildQuotaWindow(window, counters))
      }

      let rates: RateWindow[] | undefined
      if (includeRates) {
        const rateWindows = windowsForFeature.filter((window) => window.windowKind === 'rate')
        rates = rateWindows.map((window) => this.quotaService.buildRateWindow(window, counters))
      }

      const meters = featureMeters.get(featureCode) ?? []

      results.push({
        feature_code: featureCode,
        feature_family_code: entitlements.featureFamilyCodeByFeatureCode.get(featureCode),
        unit,
        quotas,
        rates,
        meters: meters.length > 0 ? meters : undefined,
      })
    }

    return results
  }

  async listMeters(req: AppRequest): Promise<MeterLimit[]> {
    const db = req.ctx?.db
    const billingUserId = req.ctx?.billingUserId
    const billingAccountId = req.ctx?.billingAccountId
    const realmId = req.ctx?.realmId
    if (!db || !billingUserId || !billingAccountId || !realmId) return []

    await setRlsSession(db, { realmId, billingAccountId, billingUserId })

    const query = (req.query ?? {}) as Record<string, unknown>

    const meterFilter = parseStringArray(query.meter_code)
    const meterSetFilter = meterFilter.length > 0 ? new Set(meterFilter) : null

    const featureFilter = parseStringArray(query.feature_code)
    const featureSetFilter = featureFilter.length > 0 ? new Set(featureFilter) : null
    const feature_familyFilter = parseStringArray(query.feature_family_code)
    const feature_familySetFilter = feature_familyFilter.length > 0 ? new Set(feature_familyFilter) : null

    const expandSet = new Set(parseStringArray(query.expand).map((value) => value.toLowerCase()))
    const includeLimits = expandSet.has('limits')
    const includeLimitsQuotas = includeLimits || expandSet.has('limits.quotas')
    const includeLimitsRates = includeLimits || expandSet.has('limits.rates')
    const includePricing = expandSet.has('pricing')
    const includeCoverage = expandSet.has('coverage')

    const coverageBasisRaw = String(query.coverage_basis || '').toLowerCase()
    const coverageBasis = coverageBasisRaw === 'budget' ? 'budget' : 'xusd'
    const coverageProfileRaw = String(query.coverage_profile || '').toLowerCase()
    const coverageProfile = coverageProfileRaw === 'optimistic' ? 'optimistic' : 'conservative'
    const coverageBudgetId = typeof query.coverage_budget_id === 'string' ? query.coverage_budget_id : undefined
    const coverageAsOf = parseAsOfTimestamp(query.coverage_as_of)

    if (coverageBasis === 'budget' && !coverageBudgetId) {
      throw new HttpException(
        { code: 'VALIDATION.INVALID_INPUT', message: 'coverage.budget_id is required when basis=budget' },
        422,
      )
    }

    const entitlements = await this.quotaService.loadEntitledFeatures(db, {
      realmId,
      billingAccountId,
      billingUserId,
      at: coverageAsOf,
      featureCodes: featureFilter.length > 0 ? featureFilter : undefined,
      featureFamilyCodes: feature_familyFilter.length > 0 ? feature_familyFilter : undefined,
    })
    if (entitlements.entitledFeatureCodes.size === 0) return []

    const entitledFeatureCodes = Array.from(entitlements.entitledFeatureCodes.values())
      .filter((code) => {
        if (featureSetFilter && !featureSetFilter.has(code)) return false
        if (feature_familySetFilter) {
          const cap = entitlements.featureFamilyCodeByFeatureCode.get(code)
          if (!cap || !feature_familySetFilter.has(cap)) return false
        }
        return true
      })
      .sort((a, b) => a.localeCompare(b))
    if (entitledFeatureCodes.length === 0) return []

    const policyWindows = await this.quotaService.loadActivePolicyWindows(db, realmId, billingAccountId, billingUserId, coverageAsOf)
    const entitledFeatureSet = new Set(entitledFeatureCodes)
    const filteredWindows = policyWindows.filter((window) => entitledFeatureSet.has(window.featureCode))

    const includeLimitsAny = includeLimitsQuotas || includeLimitsRates
    const counterLookup: Map<string, number> = includeLimitsAny
      ? await this.quotaService.loadCounterLookup(db, realmId, billingAccountId, billingUserId, filteredWindows)
      : new Map<string, number>()

    const groupedByFeature = new Map<string, PolicyWindowView[]>()
    for (const window of filteredWindows) {
      const list = groupedByFeature.get(window.featureCode)
      if (list) {
        list.push(window)
      } else {
        groupedByFeature.set(window.featureCode, [window])
      }
    }

    const entitledFeatureIdByCode = new Map<string, string>()
    for (const code of entitledFeatureCodes) {
      const featureId = entitlements.entitledFeatureIdByCode.get(code)
      if (featureId) entitledFeatureIdByCode.set(code, featureId)
    }

    const featureMeters = await this.quotaService.loadFeatureMetersMapByFeatureIds(db, {
      featureIdByCode: entitledFeatureIdByCode,
      meterCodes: meterFilter.length > 0 ? meterFilter : undefined,
    })

    type MeterAggregation = {
      features: Set<string>
      featureFamilyCodes: Set<string>
      unit?: string
      quotaWindows?: Map<string, QuotaWindow>
      rateWindows?: Map<string, RateWindow>
    }

    const aggregations = new Map<string, MeterAggregation>()

    for (const featureCode of entitledFeatureCodes) {
      const windowsForFeature = groupedByFeature.get(featureCode) ?? []

      const allowedMeters = featureMeters.get(featureCode) ?? []
      if (allowedMeters.length === 0) continue

      const windowUnit = windowsForFeature.find((window) => typeof window.unit === 'string')?.unit ?? undefined
      const quotaWindows = includeLimitsQuotas
        ? windowsForFeature.filter((window) => window.windowKind === 'quota')
        : []
      const rateWindows = includeLimitsRates
        ? windowsForFeature.filter((window) => window.windowKind === 'rate')
        : []

      for (const meter of allowedMeters) {
        if (meterSetFilter && !meterSetFilter.has(meter)) {
          continue
        }

        const existing = aggregations.get(meter)
        const entry: MeterAggregation = existing ?? {
          features: new Set<string>(),
          featureFamilyCodes: new Set<string>(),
          unit: windowUnit,
          quotaWindows: includeLimitsQuotas ? new Map<string, QuotaWindow>() : undefined,
          rateWindows: includeLimitsRates ? new Map<string, RateWindow>() : undefined,
        }

        if (!entry.unit && windowUnit) {
          entry.unit = windowUnit
        }

        entry.features.add(featureCode)
        const capCode = entitlements.featureFamilyCodeByFeatureCode.get(featureCode)
        if (capCode) entry.featureFamilyCodes.add(capCode)

        if (includeLimitsQuotas && entry.quotaWindows) {
          for (const window of quotaWindows) {
            const signature = makeWindowSignature(window)
            if (!entry.quotaWindows.has(signature)) {
              entry.quotaWindows.set(signature, this.quotaService.buildQuotaWindow(window, counterLookup))
            }
          }
        }

        if (includeLimitsRates && entry.rateWindows) {
          for (const window of rateWindows) {
            const signature = makeWindowSignature(window)
            if (!entry.rateWindows.has(signature)) {
              entry.rateWindows.set(signature, this.quotaService.buildRateWindow(window, counterLookup))
            }
          }
        }

        aggregations.set(meter, entry)
      }
    }

    const sortedMeters = Array.from(aggregations.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    const results: MeterLimit[] = []

    let priceMap = new Map<string, MeterPriceInfo>()
    if (includePricing || includeCoverage) {
      const meterCodes = sortedMeters.map(([meterCode]) => meterCode)
      priceMap = await this.pricingService.fetchMeterPricesBatch(db, {
        realmId,
        meterCodes,
      })
    }

    let coverageMap = new Map<string, { grants: MeterCoverage; budget?: MeterCoverage }>()
    if (includeCoverage) {
      const coverageInputs = sortedMeters
        .map(([meterCode, aggregation]) => {
          const features = Array.from(aggregation.features).sort((a, b) => a.localeCompare(b))
          if (features.length === 0) return null
          const priceInfo = priceMap.get(meterCode)
          if (!priceInfo) return null
          return {
            meterCode,
            featureCode: features[0],
            price: priceInfo,
          }
        })
        .filter((entry): entry is { meterCode: string; featureCode: string; price: MeterPriceInfo } => entry !== null)

      if (coverageInputs.length > 0) {
        coverageMap = await this.buildMeterCoverages(db, {
          realmId,
          billingUserId,
          billingAccountId,
          budgetId: coverageBasis === 'budget' ? coverageBudgetId : undefined,
          profile: coverageProfile,
          asOf: coverageAsOf,
          inputs: coverageInputs,
        })
      }
    }

    for (const [meterCode, aggregation] of sortedMeters) {
      const features = Array.from(aggregation.features).sort((a, b) => a.localeCompare(b))
      if (features.length === 0) continue

      const primaryFeature = features[0]
      const featureFamilyCodes =
        aggregation.featureFamilyCodes.size > 0
          ? Array.from(aggregation.featureFamilyCodes).sort((a, b) => a.localeCompare(b))
          : undefined
      const priceInfo = priceMap.get(meterCode) ?? null
      const pricingView =
        includePricing && priceInfo
          ? this.buildMeterPriceView({
              featureCode: primaryFeature,
              meterCode,
              unit: aggregation.unit,
              price: priceInfo,
            })
          : undefined
      let coverage: MeterCoverage | undefined
      if (includeCoverage) {
        const entry = coverageMap.get(meterCode)
        coverage = coverageBasis === 'budget' ? entry?.budget : entry?.grants
      }

      const quotas = includeLimitsQuotas ? Array.from(aggregation.quotaWindows?.values() ?? []) : undefined
      const rates = includeLimitsRates ? Array.from(aggregation.rateWindows?.values() ?? []) : undefined

      results.push({
        meter_code: meterCode,
        unit: aggregation.unit,
        features,
        feature_family_codes: featureFamilyCodes,
        quotas,
        rates,
        pricing: pricingView,
        coverage,
      })
    }

    return results
  }

  private async executeCommit(
    req: AppRequest,
    body: CommitRequest,
    idempotencyKey: string,
    opts?: { deferLeaseClose?: boolean },
  ): Promise<{ response: CommitResponse; hints: GateHint[]; closeContext?: CommitExecutionResult['closeContext'] }> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    const billingUserId = req.ctx?.billingUserId
    const billingAccountId = req.ctx?.billingAccountId
    if (!db || !realmId || !billingUserId || !billingAccountId) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED', message: 'missing context' }, 401)
    }
    const ensuredDb = db as NonNullable<typeof db>
    const ensuredRealmId = realmId as NonNullable<typeof realmId>
    const ensuredBillingUserId = billingUserId as NonNullable<typeof billingUserId>
    const ensuredBillingAccountId = billingAccountId as NonNullable<typeof billingAccountId>

    const leaseToken = (body?.lease_token || '').trim()
    let featureCodeInput: string
    try {
      featureCodeInput = normalizeIdentifier(body?.feature_code, 'feature_code')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'feature_code is invalid'
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message }, 422)
    }
    const normalizedQuantity = parsePositiveInt(body?.quantity_minor, 'quantity_minor')

    if (!leaseToken) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'lease_token is required' }, 422)
    }

    const leaseId = parseLeaseToken(leaseToken)
    const labels = this.normalizeLabels(body.labels)
    const normalizedItems = this.normalizeCommitItems(body)
    const requestHash = this.buildCommitRequestHash({
      leaseToken,
      featureCode: featureCodeInput,
      quantityMinor: normalizedQuantity,
      labels,
      items: normalizedItems,
    })

    const execution = await runInTransaction<CommitExecutionResult>(ensuredDb, async (trx) => {
      await setRlsSession(trx, { realmId: ensuredRealmId, billingAccountId: ensuredBillingAccountId, billingUserId: ensuredBillingUserId })

      const { feature, meters: featureMetersInitial } = await this.quotaService.loadFeatureWithMeters(trx, {
        realmId: ensuredRealmId,
        featureCode: featureCodeInput,
        autoRegistryMeterSemanticKind: 'activity',
      })
      let featureMeters = featureMetersInitial
      if (!feature.active) {
        throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'feature inactive' }, 422)
      }

      const now = new Date()
      const entitlementDecision = await this.quotaService.ensureEntitlement(trx, {
        realmId: ensuredRealmId,
        billingAccountId: ensuredBillingAccountId,
        billingUserId: ensuredBillingUserId,
        featureCode: featureCodeInput,
        now,
        feature,
      })
      const attributionEntitlement = this.normalizeEntitlementDecision(entitlementDecision)

      const { envelope } = await this.idempotencyService.acquire(trx, {
        realmId: ensuredRealmId,
        billingUserId: ensuredBillingUserId,
        billingAccountId: ensuredBillingAccountId,
        operation: 'commit',
        scopeType: 'lease',
        scopeId: String(leaseId),
        key: idempotencyKey,
        requestHash,
        metadata: {
          feature_code: featureCodeInput,
        },
        requestSnapshot: {
          feature_code: featureCodeInput,
          lease_token: leaseToken,
          quantity_minor: normalizedQuantity,
          labels,
          items: normalizedItems,
        },
      })

      if (envelope.status === 'completed' && envelope.response_snapshot) {
        const snapshot = envelope.response_snapshot as { data: CommitResponse; hints?: GateHint[] }
        const resultRef = (envelope.result_ref ?? {}) as Record<string, unknown>
        const storedLineIds = Array.isArray(resultRef.line_ids)
          ? (resultRef.line_ids as unknown[])
              .map((value) => {
                if (typeof value === 'string' && value.trim().length > 0) return value.trim()
                if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value))
                return null
              })
              .filter((value): value is string => value !== null)
          : []
        const storedCommitIdRaw = resultRef.commit_id
        const storedCommitId =
          typeof storedCommitIdRaw === 'string' && storedCommitIdRaw.trim().length > 0
            ? storedCommitIdRaw.trim()
            : typeof storedCommitIdRaw === 'number' && Number.isFinite(storedCommitIdRaw)
              ? String(Math.trunc(storedCommitIdRaw))
              : null
        return {
          response: snapshot.data,
          hints: snapshot.hints ?? [],
          lineIds: storedLineIds,
          commitId: storedCommitId,
        }
      }

      const leaseRow = await this.loadAndValidateLease(trx, {
        leaseId,
        billingUserId: ensuredBillingUserId,
        billingAccountId: ensuredBillingAccountId,
        featureCode: featureCodeInput,
        leaseToken,
      })

      const runtimeHints: GateHint[] = []
      const reasonCodes = new Set<string>()
      let applicationStatus: 'applied' | 'applied_clipped' | 'quarantined' = 'applied'
      let appliedQuantityNumber = normalizedQuantity
      let lateCommit = false

      if (leaseRow.state !== 'active') {
        applicationStatus = 'quarantined'
        reasonCodes.add('lease_closed_at_commit')
        runtimeHints.push(leaseClosedAtCommitHint(leaseRow.state))
      }

      const leaseExpiresAt = leaseRow.expires_at instanceof Date ? leaseRow.expires_at : leaseRow.expires_at ? new Date(leaseRow.expires_at) : null
      if (leaseExpiresAt) {
        const deltaMs = now.getTime() - leaseExpiresAt.getTime()
        if (deltaMs > 0) {
          lateCommit = true
          reasonCodes.add('late_commit')
          if (deltaMs > LATE_COMMIT_GRACE_MS) {
            applicationStatus = 'quarantined'
            reasonCodes.add('late_commit_exceeded')
          }
          runtimeHints.push(leaseExpiredHint({ expiresAt: leaseExpiresAt, deltaMs, graceMs: LATE_COMMIT_GRACE_MS }))
        }
      }

      const matchedQuotaWindows = this.resolveQuotaWindowsFromLease(leaseRow, {
        billingAccountId: ensuredBillingAccountId,
        billingUserId: ensuredBillingUserId,
      })
      const counters = await this.quotaService.loadCounterLookup(trx, ensuredRealmId, ensuredBillingAccountId, ensuredBillingUserId, matchedQuotaWindows)
      const exhaustedWindows = matchedQuotaWindows.filter((window) => {
        if (window.limitMinor === UNLIMITED_QUOTA_MINOR) return false
        const remaining = Math.max(0, window.limitMinor - this.quotaService.getWindowUsage(window, counters))
        return normalizedQuantity > remaining
      })
      if (exhaustedWindows.length > 0) {
        const maxQuantity = Math.max(
          0,
          Math.min(
            ...exhaustedWindows.map((window) =>
              Math.max(0, window.limitMinor - this.quotaService.getWindowUsage(window, counters)),
            ),
          ),
        )
        runtimeHints.push(quotaRemainingHint(maxQuantity))
      }
      if (matchedQuotaWindows.length === 0) {
        applicationStatus = 'quarantined'
        reasonCodes.add('policy_window_not_found')
        runtimeHints.push(policyWindowNotFoundHint(featureCodeInput))
      }

      const { allocations: quotaAllocations } = this.quotaService.allocateQuotaQuantity(matchedQuotaWindows, counters, normalizedQuantity)
      const primaryWindow = matchedQuotaWindows.length > 0 ? this.quotaService.selectPrimaryWindow(matchedQuotaWindows) : undefined
      const unitForPricing = primaryWindow?.unit || 'unit'
      const meterResidualModes = new Map<string, ResidualMode>()
      for (const meter of featureMeters) {
        meterResidualModes.set(meter.meter_code, this.resolveMeterResidualMode(meter.usageMetadata))
      }

      const expectedMeterSemanticKind: MeterSemanticKind = 'activity'
      const featureMetersForKind = featureMeters.filter((entry) => entry.semantic_kind === expectedMeterSemanticKind)
      const knownMeterCodes = new Set(featureMeters.map((entry) => entry.meter_code))
      let allowedMeters = new Set(featureMetersForKind.map((entry) => entry.meter_code))

      let commitItems = normalizedItems.slice()
      const primaryMeter = featureMetersForKind.find((meter) => meter.is_primary) ?? featureMetersForKind[0]
      if (commitItems.length === 0 && primaryMeter) {
        commitItems = [{ meter_code: primaryMeter.meter_code, quantityMinor: normalizedQuantity }]
      }
      if (commitItems.length === 0) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'meters[] is required' }, 422)
      }

      let invalidMeters =
        featureMeters.length === 0
          ? commitItems.map((item) => item.meter_code)
          : commitItems.filter((item) => !allowedMeters.has(item.meter_code)).map((item) => item.meter_code)

      const autoRegistryEnabled = envFlag('VLUNA_GATE_ENABLE_AUTO_REGISTRY')
      if (autoRegistryEnabled && invalidMeters.length > 0) {
        const unknownInvalidMeters = invalidMeters.filter((meterCode) => !knownMeterCodes.has(meterCode))
        for (const meterCode of new Set(unknownInvalidMeters)) {
          const trimmed = meterCode.trim()
          if (!trimmed) continue
          const explicitUnit =
            normalizedItems.find((item) => item.meter_code === meterCode)?.unit?.trim() || undefined
          const meterUnit = explicitUnit && explicitUnit.length > 0 ? explicitUnit : 'unit'
          await MeterService.upsertMeter(trx, {
            realmId: ensuredRealmId,
            feature_code: featureCodeInput,
            meter_code: trimmed,
            semantic_kind: expectedMeterSemanticKind,
            unit: meterUnit,
            scale: 0,
            rounding: 'round',
            active: true,
            metadata: { auto: true, source: 'commit' },
          })
        }
        featureMeters = await this.quotaService.loadFeatureMeters(trx, ensuredRealmId, featureCodeInput)
        allowedMeters = new Set(
          featureMeters
            .filter((entry) => entry.semantic_kind === expectedMeterSemanticKind)
            .map((entry) => entry.meter_code),
        )
        invalidMeters =
          featureMeters.length === 0
            ? commitItems.map((item) => item.meter_code)
            : commitItems.filter((item) => !allowedMeters.has(item.meter_code)).map((item) => item.meter_code)
      }

      if (featureMeters.length === 0 || invalidMeters.length > 0) {
        applicationStatus = 'quarantined'
        reasonCodes.add('meter_not_allowed_for_feature')
        const invalidHintMeters = Array.from(
          new Set((invalidMeters.length > 0 ? invalidMeters : commitItems.map((item) => item.meter_code)).map((code) => code.trim())),
        )
        runtimeHints.push(featureMeterNotAllowedHint(featureCodeInput, invalidHintMeters))
      }

      const uniqueMeterCodes = Array.from(new Set(commitItems.map((item) => item.meter_code)))
      const priceInfoMap = await this.pricingService.fetchMeterPricesBatch(trx, {
        realmId,
        featureCode: featureCodeInput,
        meterCodes: uniqueMeterCodes,
        billingAccountId: ensuredBillingAccountId,
        at: now,
        onWarning: (warning) => {
          runtimeHints.push(
            warning.kind === 'meter_price_missing'
              ? contractPricingMeterPriceMissingHint({
                  meterCode: warning.meterCode,
                  contractId: warning.contractId,
                  termKey: warning.termKey,
                  message: warning.message,
                })
              : contractPricingInvalidTermHint({
                  meterCode: warning.meterCode,
                  contractId: warning.contractId,
                  termKey: warning.termKey,
                  message: warning.message,
                }),
          )
        },
      })

      const pricingEntries: Array<{
        item: NormalizedCommitItem
        computation: PricingComputation
        priceInfo: MeterPriceInfo | null
      }> = []
      const pricedResults: PricingItemResult[] = []
      const invalidMeterSet = new Set(invalidMeters)
      const missingPricingMeters: string[] = []
      let totalAmount = 0n
      let totalBlocks = 0n
      let totalCost = 0n
      let totalCostBlocks = 0n
      let latestEffectiveAt: Date | undefined

      for (const item of commitItems) {
        if (invalidMeterSet.has(item.meter_code)) {
          const computation = this.pricingService.buildMissingPricingComputation({
            featureCode: featureCodeInput,
            meterCode: item.meter_code,
            unit: unitForPricing,
            quantityMinor: item.quantityMinor,
            now,
          })
          pricingEntries.push({ item, computation, priceInfo: null })
          continue
        }

        const priceInfo = priceInfoMap.get(item.meter_code)
        if (!priceInfo) {
          missingPricingMeters.push(item.meter_code)
          const computation = this.pricingService.buildMissingPricingComputation({
            featureCode: featureCodeInput,
            meterCode: item.meter_code,
            unit: unitForPricing,
            quantityMinor: item.quantityMinor,
            now,
          })
          pricingEntries.push({ item, computation, priceInfo: null })
          continue
        }

        const residualMode = meterResidualModes.get(item.meter_code) ?? 'postpaid'
        const identityResidualMode = residualMode === 'prepaid' ? 'prepaid' : undefined
        const revenueIdentity = this.pricingService.createPricingIdentity({
          featureCode: featureCodeInput,
          meterCode: item.meter_code,
          unitPriceXusd: priceInfo.unitPriceXusd,
          unitQuantityMinor: priceInfo.unitQuantityMinor,
          rounding: priceInfo.rounding,
          effectiveAt: priceInfo.effectiveAt,
          kind: 'revenue',
          residualMode: identityResidualMode,
        })
        const previousXusdRemainder = await this.pricingService.loadResidualBucketRemainder(trx, {
          billingUserId: ensuredBillingUserId,
          billingAccountId: ensuredBillingAccountId,
          meterCode: item.meter_code,
          pricingIdentity: revenueIdentity,
          expectedDenom: priceInfo.unitQuantityMinor,
          expectedRounding: priceInfo.rounding,
        })
        const costIdentity = this.pricingService.createPricingIdentity({
          featureCode: featureCodeInput,
          meterCode: item.meter_code,
          unitPriceXusd: priceInfo.unitCostXusd,
          unitQuantityMinor: priceInfo.costUnitQuantityMinor,
          rounding: priceInfo.costRounding,
          effectiveAt: priceInfo.effectiveAt,
          kind: 'cost',
          residualMode: identityResidualMode,
        })
        const previousCostRemainder = await this.pricingService.loadResidualBucketRemainder(trx, {
          billingUserId: ensuredBillingUserId,
          billingAccountId: ensuredBillingAccountId,
          meterCode: item.meter_code,
          pricingIdentity: costIdentity,
          expectedDenom: priceInfo.costUnitQuantityMinor,
          expectedRounding: priceInfo.costRounding,
        })

        const computation = residualMode === 'prepaid'
          ? this.pricingService.computePrepaidPricingComputation({
              featureCode: featureCodeInput,
              meterCode: item.meter_code,
              unit: unitForPricing,
              quantityMinor: item.quantityMinor,
              price: priceInfo,
              previousXusdRemainder,
              previousCostRemainder,
            })
          : this.pricingService.computePricingComputation({
              featureCode: featureCodeInput,
              meterCode: item.meter_code,
              unit: unitForPricing,
              quantityMinor: item.quantityMinor,
              price: priceInfo,
              previousXusdRemainder,
              previousCostRemainder,
            })

        pricingEntries.push({ item, computation, priceInfo })
        pricedResults.push({ item, price: priceInfo, computation })
        totalAmount += computation.amountXusd
        totalBlocks += computation.blocksCharged
        totalCost += computation.costXusd
        totalCostBlocks += computation.costBlocksCharged
        if (!latestEffectiveAt || priceInfo.effectiveAt > latestEffectiveAt) {
          latestEffectiveAt = priceInfo.effectiveAt
        }
      }

      if (missingPricingMeters.length > 0) {
        applicationStatus = 'quarantined'
        reasonCodes.add('pricing_not_configured')
        const missingHintMeters = Array.from(new Set(missingPricingMeters.map((code) => code.trim())))
        runtimeHints.push(pricingNotConfiguredHint(featureCodeInput, missingHintMeters))
      }

      const aggregate = this.pricingService.buildAggregatePricing(
        featureCodeInput,
        unitForPricing,
        normalizedQuantity,
        totalAmount,
        totalBlocks,
        totalCost,
        totalCostBlocks,
        latestEffectiveAt ?? now,
        pricedResults,
      )

      const totalAmountXusd = aggregate.amountXusd
      const totalCostXusd = aggregate.costXusd
      let settlementAmountXusd = totalAmountXusd

      if (applicationStatus === 'quarantined') {
        appliedQuantityNumber = 0
        settlementAmountXusd = 0n
      }
      const appliedQuantityMinorBigInt = BigInt(Math.max(0, Math.floor(appliedQuantityNumber)))

      let appliedCostXusd = totalCostXusd
      if (settlementAmountXusd === 0n || totalAmountXusd === 0n || applicationStatus === 'quarantined') {
        appliedCostXusd = 0n
      } else if (settlementAmountXusd < totalAmountXusd) {
        appliedCostXusd = (totalCostXusd * settlementAmountXusd) / totalAmountXusd
      }

      if (appliedQuantityNumber > 0) {
        for (const allocation of quotaAllocations) {
          const scaledQuantity =
            normalizedQuantity > 0 ? Math.floor((allocation.allocated * appliedQuantityNumber) / normalizedQuantity) : 0
          if (scaledQuantity <= 0) continue
          await this.quotaService.applyCounterDelta(trx, {
            realmId: ensuredRealmId,
            billingUserId: ensuredBillingUserId,
            billingAccountId: ensuredBillingAccountId,
            window: allocation.window,
            quantityMinor: scaledQuantity,
          })
        }
      }

      let budgetHints: GateHint[] = []
      let budgetUsage:
        | Awaited<ReturnType<typeof this.budgetService.updateBudgetUsage>>
        | undefined
      if (leaseRow.budget_id !== null && settlementAmountXusd > 0n) {
        budgetUsage = await this.budgetService.updateBudgetUsage(trx, {
          realmId,
          billingUserId: ensuredBillingUserId,
          billingAccountId: ensuredBillingAccountId,
          budgetId: String(leaseRow.budget_id),
          consumeAmountXusd: settlementAmountXusd,
          now,
        })
        budgetHints = budgetUsage.hints
        if (budgetUsage.status === 'limit_exceeded') {
          reasonCodes.add('budget_limit_exceeded')
        } else {
          reasonCodes.add('budget_consumed')
        }
      }

      const fundingPlan = await this.settlementService.planFundingAllocations(trx, {
        realmId: ensuredRealmId,
        billingUserId: ensuredBillingUserId,
        billingAccountId: ensuredBillingAccountId,
        amountXusd: settlementAmountXusd,
        now,
      })

      if (fundingPlan.allocations.some((allocation) => Boolean(allocation.metadata?.fallback))) {
        reasonCodes.add('cash_funding_applied')
      }

      const appliedAmountXusd = settlementAmountXusd
      const settlementQuantityMinor = settlementAmountXusd > 0n ? appliedQuantityMinorBigInt : 0n

      const lineIds: string[] = []
      const itemSummaries = pricingEntries.map((entry) => ({
        line_id: '0',
        meter_code: entry.item.meter_code,
        quantity_minor: entry.item.quantityMinor,
        unit_price_xusd: toSafeNumber(entry.computation.unitPriceXusd),
        unit_price_xusd_bigint: entry.computation.unitPriceXusd,
        unit_quantity_minor: toSafeNumber(entry.computation.unitQuantityMinor),
        unit_quantity_minor_bigint: entry.computation.unitQuantityMinor,
        rounding: entry.computation.rounding,
        amount_xusd: toSafeNumber(entry.computation.amountXusd),
        amount_xusd_bigint: entry.computation.amountXusd,
        pricing_snapshot: entry.computation.snapshot,
        pricing_fingerprint: entry.computation.pricingFingerprint,
        cost_xusd: toSafeNumber(entry.computation.costXusd),
        cost_xusd_bigint: entry.computation.costXusd,
        unit_cost_xusd: toSafeNumber(entry.computation.unitCostXusd),
        unit_cost_xusd_bigint: entry.computation.unitCostXusd,
        cost_unit_quantity_minor: toSafeNumber(entry.computation.costUnitQuantityMinor),
        cost_unit_quantity_minor_bigint: entry.computation.costUnitQuantityMinor,
        cost_rounding: entry.computation.costRounding,
        cost_snapshot: entry.computation.costSnapshot,
        cost_fingerprint: entry.computation.costPricingFingerprint,
      }))

      const settlementMetadata: Record<string, unknown> = {
        cost: {
          canonical_xusd: totalCostXusd.toString(),
          applied_xusd: appliedCostXusd.toString(),
        },
        funding: {
          grant_coverage_xusd: fundingPlan.grantCoverageXusd.toString(),
          sources: fundingPlan.allocations.map((allocation) => ({
            grant_id: allocation.grantId,
            kind: allocation.fundingKind,
            allocated_xusd: allocation.allocatedAmountXusd.toString(),
            alloc_seq: allocation.allocSeq,
          })),
        },
      }
      if (leaseRow.budget_id !== null && budgetUsage) {
        settlementMetadata.budget = {
          consumed_delta_xusd: budgetUsage.consumedDeltaXusd.toString(),
          remaining_xusd:
            budgetUsage.remainingAmountXusd !== null ? budgetUsage.remainingAmountXusd.toString() : null,
          reserved_xusd: budgetUsage.reservedXusd.toString(),
          status: budgetUsage.status,
        }
      }

      const commitMetadata: Record<string, unknown> = {
        feature_code: featureCodeInput,
        lease_id: leaseRow.lease_id,
        application_status: applicationStatus,
        reason_codes: Array.from(reasonCodes),
        late_commit: lateCommit,
      }
      if (labels && Object.keys(labels).length > 0) {
        commitMetadata.labels = labels
      }
      commitMetadata.aggregate_pricing_snapshot = aggregate.snapshot
      commitMetadata.aggregate_cost_snapshot = aggregate.costSnapshot

      const commitRow = await trx
        .insertInto('billing_ratings')
        .values({
          realm_id: realmId,
          billing_user_id: ensuredBillingUserId,
          billing_account_id: ensuredBillingAccountId,
          idempotency_id: envelope.idempotency_id,
          source_ref: `gate_lease:${leaseRow.lease_id}`,
          budget_id: leaseRow.budget_id ?? undefined,
          feature_code: featureCodeInput,
          canonical_quantity_minor: normalizedQuantity.toString(),
          canonical_amount_xusd: aggregate.amountXusd.toString(),
          canonical_cost_xusd: totalCostXusd.toString(),
          pricing_fingerprint: aggregate.pricingFingerprint,
          pricing_cost_fingerprint: aggregate.costPricingFingerprint,
          cost_snapshot: aggregate.costSnapshot as Record<string, unknown>,
          cost_fingerprint: aggregate.costSnapshot.fingerprint ?? aggregate.costPricingFingerprint,
          metadata: commitMetadata,
        })
        .returning(['rating_id', 'rated_at'])
        .executeTakeFirstOrThrow(() => new Error('failed to insert commit commit'))

      const commitId = String(commitRow.rating_id)
      if (!commitId) {
        throw new Error('failed to resolve commit id')
      }
      const committedAt =
        commitRow.rated_at instanceof Date ? commitRow.rated_at : new Date(commitRow.rated_at as string)

      await this.usageAttributionWriter.write(trx, {
        ratingId: commitId,
        realmId: ensuredRealmId,
        billingAccountId: ensuredBillingAccountId,
        featureCode: featureCodeInput,
        ratedAt: committedAt,
        entitlement: attributionEntitlement,
      })

      if (labels && Object.keys(labels).length > 0) {
        const labelRows = Object.entries(labels).map(([key, value]) => ({
          rating_id: commitId,
          key,
          value,
        }))
        await trx.insertInto('billing_rating_labels').values(labelRows).execute()
      }

      for (const summary of itemSummaries) {
        const inserted = await trx
          .insertInto('billing_rated_records')
          .values({
            rating_id: commitId,
            meter_code: summary.meter_code,
            quantity_minor: summary.quantity_minor.toString(),
            amount_xusd: summary.amount_xusd_bigint.toString(),
            cost_xusd: summary.cost_xusd_bigint.toString(),
            unit_price_xusd: summary.unit_price_xusd_bigint.toString(),
            unit_quantity_minor: summary.unit_quantity_minor_bigint.toString(),
            rounding: summary.rounding,
            unit_cost_xusd: summary.unit_cost_xusd_bigint.toString(),
            cost_unit_quantity_minor: summary.cost_unit_quantity_minor_bigint.toString(),
            cost_rounding: summary.cost_rounding,
            pricing_snapshot: summary.pricing_snapshot as Record<string, unknown>,
            pricing_fingerprint: summary.pricing_fingerprint || '',
            cost_snapshot: summary.cost_snapshot as Record<string, unknown>,
            cost_fingerprint: summary.cost_fingerprint || '',
            metadata: {
              feature_code: featureCodeInput,
              lease_id: leaseRow.lease_id,
              labels,
            },
          })
          .returning('rated_record_id')
          .executeTakeFirstOrThrow(() => new Error('failed to insert commit row'))
        const lineId = String(inserted.rated_record_id)
        lineIds.push(lineId)
        summary.line_id = lineId
      }

      await this.updateResidualBuckets(trx, ensuredBillingUserId, ensuredBillingAccountId, pricedResults, now)
      await this.settlementService.ensurePendingSettlement(trx, {
        realmId: ensuredRealmId,
        featureCode: featureCodeInput,
        commitId,
        billingUserId: ensuredBillingUserId,
        billingAccountId: ensuredBillingAccountId,
        canonicalAmountXusd: aggregate.amountXusd,
        canonicalCostXusd: totalCostXusd,
        appliedAmountXusd,
        appliedCostXusd,
        appliedQuantityMinor: settlementQuantityMinor,
        committedAt,
        applicationStatus,
        reasonCodes: Array.from(reasonCodes),
        lateCommit,
        budgetId: leaseRow.budget_id ?? null,
        pricingFingerprint: aggregate.pricingFingerprint,
        costFingerprint: aggregate.costSnapshot.fingerprint ?? aggregate.costPricingFingerprint,
        engine: 'inline',
        metadata: settlementMetadata,
        allocations: fundingPlan.allocations,
        decidedAt: now,
      })
      const lastLineId = lineIds.length > 0 ? lineIds[lineIds.length - 1] : null
      if (!opts?.deferLeaseClose) {
        await this.closeLeaseAfterCommit(trx, leaseRow, {
          reservationRemainingXusd: 0n,
          lastCommitId: lastLineId,
          commitId,
        })
      }

      if (COMMIT_LEDGER_SYNC_ENABLED && settlementAmountXusd > 0n) {
        await this.settlementService.settleCommitsImmediately(trx, {
          commits: [
            {
              commitId,
              billingAccountId: ensuredBillingAccountId,
              pricingFingerprint: aggregate.pricingFingerprint,
              amountXusd: settlementAmountXusd,
              committedAt,
              budgetId: leaseRow.budget_id ?? null,
            },
          ],
          scope: {
            kind: 'immediate',
            key: `gate.commit:${commitId}`,
            engine: 'inline',
          },
          now,
        })
      }

      const response: CommitResponse = {
        commit_id: commitId ?? undefined,
        budget_id: leaseRow.budget_id ?? undefined,
        amount_xusd: aggregate.amountXusd.toString(),
        cost_xusd: aggregate.costXusd.toString(),
        lines: itemSummaries.map((summary) => ({
          line_id: summary.line_id,
          meter_code: summary.meter_code,
          quantity_minor: summary.quantity_minor.toString(),
          unit_price_xusd: summary.unit_price_xusd.toString(),
          amount_xusd: summary.amount_xusd.toString(),
          pricing_snapshot: summary.pricing_snapshot as PricingSnapshot,
          pricing_fingerprint: summary.pricing_fingerprint,
          cost_xusd: summary.cost_xusd.toString(),
          unit_cost_xusd: summary.unit_cost_xusd.toString(),
          cost_unit_quantity_minor: summary.cost_unit_quantity_minor.toString(),
          cost_rounding: summary.cost_rounding,
          cost_snapshot: summary.cost_snapshot as PricingSnapshot,
          cost_fingerprint: summary.cost_fingerprint,
        })),
      }

      const hints: GateHint[] = []
      hints.push(...runtimeHints)
      hints.push(...budgetHints)
      const pricingHints = this.computePricingHints(commitItems, itemSummaries)
      hints.push(...pricingHints)
      if (budgetUsage && budgetUsage.remainingAmountXusd !== null && applicationStatus !== 'quarantined') {
        const headroom = toSafeNumber(budgetUsage.remainingAmountXusd)
        const appliedAmount = toSafeNumber(aggregate.amountXusd)
        const threshold = Math.max(
          LOW_HEADROOM_BASE_THRESHOLD_XUSD,
          Math.floor(appliedAmount * LOW_HEADROOM_MULTIPLIER),
        )
        if (headroom <= threshold) {
          hints.push(lowHeadroomHint(headroom, threshold))
        }
      }

      await this.idempotencyService.finalize(trx, {
        idempotencyId: envelope.idempotency_id,
        status: 'completed',
        responseSnapshot: { data: response, hints },
        resultRef: {
          line_ids: lineIds,
          commit_id: commitId,
          application_status: applicationStatus,
          reason_codes: Array.from(reasonCodes),
          cost_xusd: aggregate.costXusd.toString(),
        },
      })

      return {
        response,
        hints,
        lineIds,
        commitId,
        closeContext: opts?.deferLeaseClose
          ? {
              leaseRow,
              lastLineId,
              commitId,
              reservationRemainingXusd: 0n,
            }
          : undefined,
      }
    })

    return {
      response: execution.response,
      hints: execution.hints,
    }
  }

  private async executeIngest(
    req: AppRequest,
    body: IngestRequest,
    idempotencyKey: string,
    expectedMeterSemanticKind: MeterSemanticKind,
  ): Promise<{ response: CommitResponse; hints: GateHint[] }> {
    const db = req.ctx?.db
    const realmId = req.ctx?.realmId
    const billingUserId = req.ctx?.billingUserId
    const billingAccountId = req.ctx?.billingAccountId
    if (!db || !realmId || !billingUserId || !billingAccountId) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED', message: 'missing context' }, 401)
    }
    const ensuredDb = db as NonNullable<typeof db>
    const ensuredRealmId = realmId as NonNullable<typeof realmId>
    const ensuredBillingUserId = billingUserId as NonNullable<typeof billingUserId>
    const ensuredBillingAccountId = billingAccountId as NonNullable<typeof billingAccountId>

    let featureCodeInput: string
    try {
      featureCodeInput = normalizeIdentifier(body?.feature_code, 'feature_code')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'feature_code is invalid'
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message }, 422)
    }

    const budgetIdInput = typeof (body as { budget_id?: unknown } | null)?.budget_id === 'string'
      ? String((body as { budget_id: string }).budget_id).trim()
      : ''
    const budgetId = budgetIdInput.length > 0 ? budgetIdInput : undefined
    if (budgetId && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(budgetId)) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'invalid budget_id' }, 422)
    }

    const labels = this.normalizeLabels(body?.labels)
    const occurredAt = this.normalizeOccurredAt((body as { occurred_at?: unknown } | null)?.occurred_at, 'occurred_at')
    const quantityMinor = parseOptionalNonNegativeInt(body?.quantity_minor, 'quantity_minor')
    const rawItems = this.normalizeMeterItems(body?.meters, 'meters')
    if (quantityMinor === undefined && rawItems.length === 0) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'quantity_minor or meters[] is required' }, 422)
    }
    const requestHash = hashRequest({
      schema: 'gate.ingest.request.v3',
      feature_code: featureCodeInput,
      occurred_at: occurredAt ? occurredAt.toISOString() : null,
      quantity_minor: quantityMinor ?? null,
      budget_id: budgetId ?? null,
      labels: labels ?? null,
      items: rawItems.map((item) => ({
        meter_code: item.meter_code,
        quantity_minor: item.quantityMinor,
        client_pricing_etag: item.clientPricingEtag ?? null,
        client_unit_price_xusd: item.clientUnitPriceXusd ?? null,
      })),
    })

    const execution = await runInTransaction<{ response: CommitResponse; hints: GateHint[] }>(ensuredDb, async (trx) => {
      await setRlsSession(trx, { realmId: ensuredRealmId, billingAccountId: ensuredBillingAccountId, billingUserId: ensuredBillingUserId })

      const { feature, meters: featureMetersInitial } = await this.quotaService.loadFeatureWithMeters(trx, {
        realmId: ensuredRealmId,
        featureCode: featureCodeInput,
        autoRegistryMeterSemanticKind: expectedMeterSemanticKind,
      })
      let featureMeters = featureMetersInitial
      if (!feature.active) {
        throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'feature inactive' }, 422)
      }

      const systemNow = new Date()
      const effectiveAt = occurredAt ?? systemNow
      const entitlementDecision = await this.quotaService.ensureEntitlement(trx, {
        realmId: ensuredRealmId,
        billingAccountId: ensuredBillingAccountId,
        billingUserId: ensuredBillingUserId,
        featureCode: featureCodeInput,
        now: effectiveAt,
        feature,
      })
      const attributionEntitlement = this.normalizeEntitlementDecision(entitlementDecision)

      const { envelope } = await this.idempotencyService.acquire(trx, {
        realmId: ensuredRealmId,
        billingUserId: ensuredBillingUserId,
        billingAccountId: ensuredBillingAccountId,
        operation: 'ingest',
        scopeType: 'user',
        key: idempotencyKey,
        requestHash,
        metadata: {
          feature_code: featureCodeInput,
          budget_id: budgetId ?? null,
          commit_kind: 'ingest',
          occurred_at: effectiveAt.toISOString(),
        },
        requestSnapshot: {
          feature_code: featureCodeInput,
          occurred_at: occurredAt ? occurredAt.toISOString() : null,
          quantity_minor: quantityMinor ?? null,
          budget_id: budgetId ?? null,
          labels,
          items: rawItems,
        },
      })

      if (envelope.status === 'completed' && envelope.response_snapshot) {
        const snapshot = envelope.response_snapshot as { data: CommitResponse; hints?: GateHint[] }
        return { response: snapshot.data, hints: snapshot.hints ?? [] }
      }

      const hints: GateHint[] = []

      let normalizedItems = rawItems.slice()
      if (normalizedItems.length === 0) {
        if (quantityMinor === undefined) {
          throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'meters[] is required' }, 422)
        }
        const featureMetersForKind = featureMeters.filter((meter) => meter.semantic_kind === expectedMeterSemanticKind)
        const featureMeterCodes = featureMetersForKind.map((meter) => meter.meter_code).filter((code) => code.trim().length > 0)
        if (featureMeterCodes.length === 0) {
          throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'meters[] is required' }, 422)
        }

        let selectedMeterCode: string | undefined =
          featureMetersForKind.find((meter) => meter.is_primary)?.meter_code ?? undefined

        if (!selectedMeterCode && featureMeterCodes.length > 1) {
          const priceMapForSelection = await this.pricingService.fetchMeterPricesBatch(trx, {
            realmId: ensuredRealmId,
            featureCode: featureCodeInput,
            meterCodes: featureMeterCodes,
            billingAccountId: ensuredBillingAccountId,
            at: effectiveAt,
            onWarning: (warning) => {
              hints.push(
                warning.kind === 'meter_price_missing'
                  ? contractPricingMeterPriceMissingHint({
                      meterCode: warning.meterCode,
                      contractId: warning.contractId,
                      termKey: warning.termKey,
                      message: warning.message,
                    })
                  : contractPricingInvalidTermHint({
                      meterCode: warning.meterCode,
                      contractId: warning.contractId,
                      termKey: warning.termKey,
                      message: warning.message,
                    }),
              )
            },
          })
          const pricedCodes = featureMeterCodes.filter((code) => priceMapForSelection.has(code))
          if (pricedCodes.length === 1) {
            selectedMeterCode = pricedCodes[0]
          } else if (pricedCodes.length > 1) {
            selectedMeterCode = pricedCodes.slice().sort((a, b) => a.localeCompare(b))[0]
          }
        }

        if (!selectedMeterCode) {
          selectedMeterCode = featureMeterCodes.slice().sort((a, b) => a.localeCompare(b))[0]
        }

        normalizedItems = [{ meter_code: selectedMeterCode, quantityMinor }]
      }
      const sumMeters = normalizedItems.reduce((sum, item) => sum + item.quantityMinor, 0)
      const canonicalQuantityMinor = quantityMinor ?? sumMeters

      const meterResidualModes = new Map<string, ResidualMode>()
      for (const meter of featureMeters) {
        meterResidualModes.set(meter.meter_code, this.resolveMeterResidualMode(meter.usageMetadata))
      }

      const knownMeterCodes = new Set(featureMeters.map((entry) => entry.meter_code))
      let allowedMeters = new Set(
        featureMeters
          .filter((entry) => entry.semantic_kind === expectedMeterSemanticKind)
          .map((entry) => entry.meter_code),
      )
      let invalidMeters =
        featureMeters.length === 0
          ? normalizedItems.map((item) => item.meter_code)
          : normalizedItems.filter((item) => !allowedMeters.has(item.meter_code)).map((item) => item.meter_code)

      const autoRegistryEnabled = envFlag('VLUNA_GATE_ENABLE_AUTO_REGISTRY')
      if (autoRegistryEnabled && invalidMeters.length > 0) {
        const unknownInvalidMeters = invalidMeters.filter((meterCode) => !knownMeterCodes.has(meterCode))
        for (const meterCode of new Set(unknownInvalidMeters)) {
          const trimmed = meterCode.trim()
          if (!trimmed) continue
          const explicitUnit = normalizedItems.find((item) => item.meter_code === meterCode)?.unit?.trim() || undefined
          const meterUnit = explicitUnit && explicitUnit.length > 0 ? explicitUnit : 'unit'
          await MeterService.upsertMeter(trx, {
            realmId: ensuredRealmId,
            feature_code: featureCodeInput,
            meter_code: trimmed,
            semantic_kind: expectedMeterSemanticKind,
            unit: meterUnit,
            scale: 0,
            rounding: 'round',
            active: true,
            metadata: { auto: true, source: 'ingest' },
          })
        }
        featureMeters = await this.quotaService.loadFeatureMeters(trx, ensuredRealmId, featureCodeInput)
        allowedMeters = new Set(
          featureMeters
            .filter((entry) => entry.semantic_kind === expectedMeterSemanticKind)
            .map((entry) => entry.meter_code),
        )
        invalidMeters =
          featureMeters.length === 0
            ? normalizedItems.map((item) => item.meter_code)
            : normalizedItems.filter((item) => !allowedMeters.has(item.meter_code)).map((item) => item.meter_code)
      }

      if (featureMeters.length === 0 || invalidMeters.length > 0) {
        const invalid = Array.from(new Set((invalidMeters.length > 0 ? invalidMeters : normalizedItems.map((item) => item.meter_code)).map((code) => code.trim())))
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `meter_not_allowed_for_feature: ${invalid.join(',')}` }, 422)
      }

      const uniqueMeterCodes = Array.from(new Set(normalizedItems.map((item) => item.meter_code)))
      const priceInfoMap = await this.pricingService.fetchMeterPricesBatch(trx, {
        realmId: ensuredRealmId,
        featureCode: featureCodeInput,
        meterCodes: uniqueMeterCodes,
        billingAccountId: ensuredBillingAccountId,
        at: effectiveAt,
        onWarning: (warning) => {
          hints.push(
            warning.kind === 'meter_price_missing'
              ? contractPricingMeterPriceMissingHint({
                  meterCode: warning.meterCode,
                  contractId: warning.contractId,
                  termKey: warning.termKey,
                  message: warning.message,
                })
              : contractPricingInvalidTermHint({
                  meterCode: warning.meterCode,
                  contractId: warning.contractId,
                  termKey: warning.termKey,
                  message: warning.message,
                }),
          )
        },
      })

      const pricingEntries: Array<{
        item: NormalizedCommitItem
        computation: PricingComputation
        priceInfo: MeterPriceInfo | null
      }> = []
      const pricedResults: PricingItemResult[] = []
      const missingPricingMeters: string[] = []
      let totalAmount = 0n
      let totalBlocks = 0n
      let totalCost = 0n
      let totalCostBlocks = 0n
      let latestEffectiveAt: Date | undefined

      for (const item of normalizedItems) {
        const priceInfo = priceInfoMap.get(item.meter_code)
        if (!priceInfo) {
          missingPricingMeters.push(item.meter_code)
          const unitForPricing = item.unit?.trim() || 'unit'
          const computation = this.pricingService.buildMissingPricingComputation({
            featureCode: featureCodeInput,
            meterCode: item.meter_code,
            unit: unitForPricing,
            quantityMinor: item.quantityMinor,
            now: effectiveAt,
          })
          pricingEntries.push({ item, computation, priceInfo: null })
          continue
        }

        const residualMode = meterResidualModes.get(item.meter_code) ?? 'postpaid'
        const identityResidualMode = residualMode === 'prepaid' ? 'prepaid' : undefined
        const revenueIdentity = this.pricingService.createPricingIdentity({
          featureCode: featureCodeInput,
          meterCode: item.meter_code,
          unitPriceXusd: priceInfo.unitPriceXusd,
          unitQuantityMinor: priceInfo.unitQuantityMinor,
          rounding: priceInfo.rounding,
          effectiveAt: priceInfo.effectiveAt,
          kind: 'revenue',
          residualMode: identityResidualMode,
        })
        const previousXusdRemainder = await this.pricingService.loadResidualBucketRemainder(trx, {
          billingUserId: ensuredBillingUserId,
          billingAccountId: ensuredBillingAccountId,
          meterCode: item.meter_code,
          pricingIdentity: revenueIdentity,
          expectedDenom: priceInfo.unitQuantityMinor,
          expectedRounding: priceInfo.rounding,
        })
        const costIdentity = this.pricingService.createPricingIdentity({
          featureCode: featureCodeInput,
          meterCode: item.meter_code,
          unitPriceXusd: priceInfo.unitCostXusd,
          unitQuantityMinor: priceInfo.costUnitQuantityMinor,
          rounding: priceInfo.costRounding,
          effectiveAt: priceInfo.effectiveAt,
          kind: 'cost',
          residualMode: identityResidualMode,
        })
        const previousCostRemainder = await this.pricingService.loadResidualBucketRemainder(trx, {
          billingUserId: ensuredBillingUserId,
          billingAccountId: ensuredBillingAccountId,
          meterCode: item.meter_code,
          pricingIdentity: costIdentity,
          expectedDenom: priceInfo.costUnitQuantityMinor,
          expectedRounding: priceInfo.costRounding,
        })

        const unitForPricing = item.unit?.trim() || 'unit'
        const computation = residualMode === 'prepaid'
          ? this.pricingService.computePrepaidPricingComputation({
              featureCode: featureCodeInput,
              meterCode: item.meter_code,
              unit: unitForPricing,
              quantityMinor: item.quantityMinor,
              price: priceInfo,
              previousXusdRemainder,
              previousCostRemainder,
            })
          : this.pricingService.computePricingComputation({
              featureCode: featureCodeInput,
              meterCode: item.meter_code,
              unit: unitForPricing,
              quantityMinor: item.quantityMinor,
              price: priceInfo,
              previousXusdRemainder,
              previousCostRemainder,
            })

        pricingEntries.push({ item, computation, priceInfo })
        pricedResults.push({ item, price: priceInfo, computation })
        totalAmount += computation.amountXusd
        totalBlocks += computation.blocksCharged
        totalCost += computation.costXusd
        totalCostBlocks += computation.costBlocksCharged
        if (!latestEffectiveAt || priceInfo.effectiveAt > latestEffectiveAt) {
          latestEffectiveAt = priceInfo.effectiveAt
        }
      }

      const aggregate = this.pricingService.buildAggregatePricing(
        featureCodeInput,
        'unit',
        canonicalQuantityMinor,
        totalAmount,
        totalBlocks,
        totalCost,
        totalCostBlocks,
        latestEffectiveAt ?? effectiveAt,
        pricedResults,
      )

      const settlementAmountXusd = aggregate.amountXusd
      const totalCostXusd = aggregate.costXusd
      const appliedQuantityMinorBigInt = BigInt(Math.max(0, Math.floor(canonicalQuantityMinor)))
      const appliedQuantityMinor = settlementAmountXusd > 0n ? appliedQuantityMinorBigInt : 0n

      const fundingPlan = await this.settlementService.planFundingAllocations(trx, {
        realmId: ensuredRealmId,
        billingUserId: ensuredBillingUserId,
        billingAccountId: ensuredBillingAccountId,
        amountXusd: settlementAmountXusd,
        now: effectiveAt,
      })

      const reasonCodes = new Set<string>(['ingest'])
      if (missingPricingMeters.length > 0) {
        reasonCodes.add('pricing_not_configured')
      }
      if (fundingPlan.allocations.some((allocation) => Boolean(allocation.metadata?.fallback))) {
        reasonCodes.add('cash_funding_applied')
      }

      const lineIds: string[] = []
      const itemSummaries = pricingEntries.map((entry) => ({
        line_id: '0',
        meter_code: entry.item.meter_code,
        quantity_minor: entry.item.quantityMinor,
        unit_price_xusd: toSafeNumber(entry.computation.unitPriceXusd),
        unit_price_xusd_bigint: entry.computation.unitPriceXusd,
        unit_quantity_minor: toSafeNumber(entry.computation.unitQuantityMinor),
        unit_quantity_minor_bigint: entry.computation.unitQuantityMinor,
        rounding: entry.computation.rounding,
        amount_xusd: toSafeNumber(entry.computation.amountXusd),
        amount_xusd_bigint: entry.computation.amountXusd,
        pricing_snapshot: entry.computation.snapshot,
        pricing_fingerprint: entry.computation.pricingFingerprint,
        cost_xusd: toSafeNumber(entry.computation.costXusd),
        cost_xusd_bigint: entry.computation.costXusd,
        unit_cost_xusd: toSafeNumber(entry.computation.unitCostXusd),
        unit_cost_xusd_bigint: entry.computation.unitCostXusd,
        cost_unit_quantity_minor: toSafeNumber(entry.computation.costUnitQuantityMinor),
        cost_unit_quantity_minor_bigint: entry.computation.costUnitQuantityMinor,
        cost_rounding: entry.computation.costRounding,
        cost_snapshot: entry.computation.costSnapshot,
        cost_fingerprint: entry.computation.costPricingFingerprint,
      }))

      const commitMetadata: Record<string, unknown> = {
        commit_kind: 'ingest',
        feature_code: featureCodeInput,
        application_status: 'applied',
        reason_codes: Array.from(reasonCodes),
        occurred_at: effectiveAt.toISOString(),
        occurred_at_source: occurredAt ? 'client' : 'server_default',
        system_recorded_at: systemNow.toISOString(),
      }
      if (occurredAt) {
        commitMetadata.backfill = occurredAt.getTime() < systemNow.getTime()
      }
      if (budgetId) {
        commitMetadata.budget_id = budgetId
      }
      if (labels && Object.keys(labels).length > 0) {
        commitMetadata.labels = labels
      }
      commitMetadata.aggregate_pricing_snapshot = aggregate.snapshot
      commitMetadata.aggregate_cost_snapshot = aggregate.costSnapshot

      const commitRow = await trx
        .insertInto('billing_ratings')
        .values({
          realm_id: ensuredRealmId,
          billing_user_id: ensuredBillingUserId,
          billing_account_id: ensuredBillingAccountId,
          rating_kind: 'ingest',
          idempotency_id: envelope.idempotency_id,
          source_ref: null,
          budget_id: budgetId ?? undefined,
          feature_code: featureCodeInput,
          canonical_quantity_minor: canonicalQuantityMinor.toString(),
          canonical_amount_xusd: aggregate.amountXusd.toString(),
          canonical_cost_xusd: totalCostXusd.toString(),
          pricing_fingerprint: aggregate.pricingFingerprint,
          pricing_cost_fingerprint: aggregate.costPricingFingerprint,
          cost_snapshot: aggregate.costSnapshot as Record<string, unknown>,
          cost_fingerprint: aggregate.costSnapshot.fingerprint ?? aggregate.costPricingFingerprint,
          metadata: commitMetadata,
          rated_at: effectiveAt,
        })
        .returning(['rating_id', 'rated_at'])
        .executeTakeFirstOrThrow(() => new Error('failed to insert ingest commit'))

      const commitId = String(commitRow.rating_id)
      if (!commitId) {
        throw new Error('failed to resolve ingest commit id')
      }
      const committedAt =
        commitRow.rated_at instanceof Date ? commitRow.rated_at : new Date(commitRow.rated_at as string)

      await this.usageAttributionWriter.write(trx, {
        ratingId: commitId,
        realmId: ensuredRealmId,
        billingAccountId: ensuredBillingAccountId,
        featureCode: featureCodeInput,
        ratedAt: committedAt,
        entitlement: attributionEntitlement,
      })

      if (labels && Object.keys(labels).length > 0) {
        const labelRows = Object.entries(labels).map(([key, value]) => ({
          rating_id: commitId,
          key,
          value,
        }))
        await trx.insertInto('billing_rating_labels').values(labelRows).execute()
      }

      for (const summary of itemSummaries) {
        const inserted = await trx
          .insertInto('billing_rated_records')
          .values({
            rating_id: commitId,
            meter_code: summary.meter_code,
            quantity_minor: summary.quantity_minor.toString(),
            amount_xusd: summary.amount_xusd_bigint.toString(),
            cost_xusd: summary.cost_xusd_bigint.toString(),
            unit_price_xusd: summary.unit_price_xusd_bigint.toString(),
            unit_quantity_minor: summary.unit_quantity_minor_bigint.toString(),
            rounding: summary.rounding,
            unit_cost_xusd: summary.unit_cost_xusd_bigint.toString(),
            cost_unit_quantity_minor: summary.cost_unit_quantity_minor_bigint.toString(),
            cost_rounding: summary.cost_rounding,
            pricing_snapshot: summary.pricing_snapshot as Record<string, unknown>,
            pricing_fingerprint: summary.pricing_fingerprint || '',
            cost_snapshot: summary.cost_snapshot as Record<string, unknown>,
            cost_fingerprint: summary.cost_fingerprint || '',
            metadata: {
              commit_kind: 'ingest',
              feature_code: featureCodeInput,
              labels,
            },
          })
          .returning('rated_record_id')
          .executeTakeFirstOrThrow(() => new Error('failed to insert ingest line'))
        const lineId = String(inserted.rated_record_id)
        lineIds.push(lineId)
        summary.line_id = lineId
      }

      await this.updateResidualBuckets(trx, ensuredBillingUserId, ensuredBillingAccountId, pricedResults, systemNow)
      await this.settlementService.ensurePendingSettlement(trx, {
        realmId: ensuredRealmId,
        featureCode: featureCodeInput,
        commitId,
        billingUserId: ensuredBillingUserId,
        billingAccountId: ensuredBillingAccountId,
        canonicalAmountXusd: aggregate.amountXusd,
        canonicalCostXusd: totalCostXusd,
        appliedAmountXusd: settlementAmountXusd,
        appliedCostXusd: totalCostXusd,
        appliedQuantityMinor,
        committedAt,
        applicationStatus: 'applied',
        reasonCodes: Array.from(reasonCodes),
        lateCommit: false,
        budgetId: budgetId ?? null,
        pricingFingerprint: aggregate.pricingFingerprint,
        costFingerprint: aggregate.costSnapshot.fingerprint ?? aggregate.costPricingFingerprint,
        engine: 'inline',
        metadata: {
          occurred_at: effectiveAt.toISOString(),
          occurred_at_source: occurredAt ? 'client' : 'server_default',
          system_recorded_at: systemNow.toISOString(),
          ...(occurredAt ? { backfill: occurredAt.getTime() < systemNow.getTime() } : {}),
          funding: {
            grant_coverage_xusd: fundingPlan.grantCoverageXusd.toString(),
            sources: fundingPlan.allocations.map((allocation) => ({
              grant_id: allocation.grantId,
              kind: allocation.fundingKind,
              allocated_xusd: allocation.allocatedAmountXusd.toString(),
              alloc_seq: allocation.allocSeq,
            })),
          },
          cost: {
            canonical_xusd: totalCostXusd.toString(),
            applied_xusd: totalCostXusd.toString(),
          },
        },
        allocations: fundingPlan.allocations,
        decidedAt: systemNow,
      })

      if (COMMIT_LEDGER_SYNC_ENABLED && settlementAmountXusd > 0n) {
        await this.settlementService.settleCommitsImmediately(trx, {
          commits: [
            {
              commitId,
              billingAccountId: ensuredBillingAccountId,
              pricingFingerprint: aggregate.pricingFingerprint,
              amountXusd: settlementAmountXusd,
              committedAt,
              budgetId: budgetId ?? null,
            },
          ],
          scope: {
            kind: 'immediate',
            key: `gate.ingest:${commitId}`,
            engine: 'inline',
          },
          now: systemNow,
        })
      }

      const response: CommitResponse = {
        commit_id: commitId ?? undefined,
        budget_id: budgetId ?? undefined,
        amount_xusd: aggregate.amountXusd.toString(),
        cost_xusd: aggregate.costXusd.toString(),
        lines: itemSummaries.map((summary) => ({
          line_id: summary.line_id,
          meter_code: summary.meter_code,
          quantity_minor: summary.quantity_minor.toString(),
          unit_price_xusd: summary.unit_price_xusd.toString(),
          amount_xusd: summary.amount_xusd.toString(),
          pricing_snapshot: summary.pricing_snapshot as PricingSnapshot,
          pricing_fingerprint: summary.pricing_fingerprint,
          cost_xusd: summary.cost_xusd.toString(),
          unit_cost_xusd: summary.unit_cost_xusd.toString(),
          cost_unit_quantity_minor: summary.cost_unit_quantity_minor.toString(),
          cost_rounding: summary.cost_rounding,
          cost_snapshot: summary.cost_snapshot as PricingSnapshot,
          cost_fingerprint: summary.cost_fingerprint,
        })),
      }

      await this.idempotencyService.finalize(trx, {
        idempotencyId: envelope.idempotency_id,
        status: 'completed',
        responseSnapshot: { data: response, hints },
        resultRef: {
          line_ids: lineIds,
          commit_id: commitId,
          commit_kind: 'ingest',
          reason_codes: Array.from(reasonCodes),
          cost_xusd: aggregate.costXusd.toString(),
        },
      })

      return { response, hints }
    })

    return execution
  }

	  private async loadAndValidateLease(
	    trx: Kysely<Database> | Transaction<Database>,
	    params: { leaseId: string; billingUserId: string; billingAccountId: string; featureCode: string; leaseToken: string },
	  ): Promise<LeaseRow> {
    const leaseRow = await this.leaseService.findAndLockLeaseForCommit(trx, {
      leaseId: params.leaseId,
      billingUserId: params.billingUserId,
      billingAccountId: params.billingAccountId,
    })

    if (leaseRow.feature_code !== params.featureCode) {
      throw new HttpException({ code: 'WRITE.INVALID_PAYLOAD', message: 'feature mismatch for lease' }, 422)
    }
    const metadata = (leaseRow.metadata ?? {}) as Record<string, unknown>
    const storedToken = typeof metadata.lease_token === 'string' ? metadata.lease_token : undefined
    const storedHash = typeof metadata.lease_token_hash === 'string' ? metadata.lease_token_hash : undefined
    if (!storedToken || !storedHash || storedToken !== params.leaseToken || storedHash !== hashToken(params.leaseToken)) {
      throw new HttpException({ code: 'WRITE.INVALID_PAYLOAD', message: 'invalid lease token' }, 422)
    }

    return leaseRow
  }

  private resolveQuotaWindowsFromLease(
    leaseRow: LeaseRow,
    params: {
      billingAccountId: string
      billingUserId: string
    },
  ): PolicyWindowView[] {
    const metadata = (leaseRow.metadata ?? {}) as Record<string, unknown>
    const entries = this.quotaService.extractQuotaWindowMetadata(metadata)
    if (entries.length === 0) {
      throw new HttpException({ code: 'WRITE.INVALID_PAYLOAD', message: 'lease metadata missing quota_windows' }, 422)
    }

    const matched: PolicyWindowView[] = []
    for (const entry of entries) {
      const expectedSubjectId = entry.subject_scope === 'account' ? params.billingAccountId : params.billingUserId
      if (entry.subject_id !== expectedSubjectId) {
        throw new HttpException({ code: 'WRITE.INVALID_PAYLOAD', message: 'lease quota window subject mismatch' }, 422)
      }
      const windowStart = new Date(entry.window_start)
      const windowEnd = new Date(entry.window_end)
      if (Number.isNaN(windowStart.valueOf()) || Number.isNaN(windowEnd.valueOf()) || windowEnd <= windowStart) {
        throw new HttpException({ code: 'WRITE.INVALID_PAYLOAD', message: 'invalid lease quota window bounds' }, 422)
      }
      matched.push({
        policyId: entry.policy_id,
        policyName: `policy-${entry.policy_id}`,
        subjectScope: entry.subject_scope,
        subjectId: entry.subject_id,
        featureCode: leaseRow.feature_code,
        unit: entry.unit,
        limitMinor: entry.limit_minor,
        windowStart,
        windowEnd,
        windowMs: windowEnd.getTime() - windowStart.getTime(),
        windowKind: 'quota',
        counterKey: entry.counter_key,
        policyStatus: 'assignable',
      })
    }
    return matched
  }

  private async updateResidualBuckets(
    trx: Kysely<Database> | Transaction<Database>,
    billingUserId: string,
    billingAccountId: string,
    pricingResults: PricingItemResult[],
    now: Date,
  ): Promise<void> {
    for (const entry of pricingResults) {
      await this.pricingService.upsertResidualBucket(trx, {
        billingUserId,
        billingAccountId,
        meterCode: entry.item.meter_code,
        pricingIdentity: entry.computation.pricingIdentity,
        denom: entry.computation.unitQuantityMinor,
        rounding: entry.computation.rounding,
        remainder: entry.computation.residualRemainder,
        now,
      })
      await this.pricingService.upsertResidualBucket(trx, {
        billingUserId,
        billingAccountId,
        meterCode: entry.item.meter_code,
        pricingIdentity: entry.computation.costPricingIdentity,
        denom: entry.computation.costUnitQuantityMinor,
        rounding: entry.computation.costRounding,
        remainder: entry.computation.costResidualRemainder,
        now,
      })
    }
  }

  private async closeLeaseAfterCommit(
    trx: Kysely<Database> | Transaction<Database>,
    leaseRow: LeaseRow,
    params: {
      reservationRemainingXusd: bigint
      lastCommitId: string | null
      commitId: string
    },
  ): Promise<void> {
    const metadata = (leaseRow.metadata ?? {}) as Record<string, unknown>
    const finalMetadata = {
      ...metadata,
      committed_at: nowIso(),
      ...(params.lastCommitId !== null ? { last_commit_id: params.lastCommitId } : {}),
      last_commit_id: params.commitId,
    }
    await this.leaseService.closeLease(trx, {
      leaseId: leaseRow.lease_id,
      reservationRemainingXusd: params.reservationRemainingXusd,
      commitId: params.commitId,
      finalMetadata,
    })
  }

  private computePricingHints(
    items: NormalizedCommitItem[],
    summaries: Array<{
      meter_code: string
      unit_price_xusd: number
      pricing_fingerprint?: string
      amount_xusd: number
    }>,
  ): GateHint[] {
    const hints: GateHint[] = []
    const summaryByMeter = new Map<string, { unitPrice: number; fingerprint?: string }>()
    for (const summary of summaries) {
      summaryByMeter.set(summary.meter_code, {
        unitPrice: summary.unit_price_xusd,
        fingerprint: summary.pricing_fingerprint,
      })
    }
    for (const item of items) {
      if (!item.clientPricingEtag && item.clientUnitPriceXusd === undefined) continue
      const summary = summaryByMeter.get(item.meter_code)
      if (!summary) continue
      const fingerprintChanged =
        item.clientPricingEtag && summary.fingerprint && item.clientPricingEtag !== summary.fingerprint
      const unitPriceChanged =
        item.clientUnitPriceXusd !== undefined && item.clientUnitPriceXusd !== summary.unitPrice
      if (fingerprintChanged || unitPriceChanged) {
        hints.push(pricingChangedHint(item.clientPricingEtag || 'client', summary.fingerprint || 'server'))
      }
    }
    return hints
  }

  private normalizeEntitlementDecision(decision: {
    assignment_id?: unknown
    plan_id?: unknown
    plan_code?: unknown
    plan_kind?: unknown
  } | null | undefined) {
    if (!decision) return null
    const assignmentId = decision.assignment_id ? String(decision.assignment_id) : null
    const planId = decision.plan_id ? String(decision.plan_id) : null
    const planCode = decision.plan_code ? String(decision.plan_code) : null
    const planKind = decision.plan_kind ? String(decision.plan_kind) : null
    if (!assignmentId && !planId && !planCode && !planKind) return null
    return { assignmentId, planId, planCode, planKind }
  }

  private normalizeLabels(input: Record<string, unknown> | undefined): Record<string, string> | undefined {
    if (!input) return undefined
    const entries = Object.entries(input).flatMap(([key, value]) => {
      if (typeof key !== 'string' || key.trim().length === 0) return []
      const normalizedValue = typeof value === 'string' ? value.trim() : String(value ?? '')
      if (normalizedValue.length === 0) return []
      return [[key.trim(), normalizedValue]] as Array<[string, string]>
    })
    if (entries.length === 0) return undefined
    return Object.fromEntries(entries)
  }

  private normalizeOccurredAt(input: unknown, fieldLabel: string): Date | undefined {
    if (input === undefined || input === null || input === '') {
      return undefined
    }
    const raw = input instanceof Date ? input.toISOString() : typeof input === 'string' ? input.trim() : ''
    if (!raw) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${fieldLabel} must be a valid date-time` }, 422)
    }
    const parsed = new Date(raw)
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${fieldLabel} must be a valid date-time` }, 422)
    }
    return parsed
  }

  private normalizeCommitItems(body: CommitRequest): NormalizedCommitItem[] {
    return this.normalizeMeterItems(body?.meters, 'items')
  }

  private normalizeMeterItems(rawMeters: unknown, fieldLabel: string): NormalizedCommitItem[] {
    const rawItems = Array.isArray(rawMeters) ? rawMeters : []

    const normalized: NormalizedCommitItem[] = []
    for (const item of rawItems) {
      const meterCodeRaw = typeof (item as { meter_code?: unknown } | null)?.meter_code === 'string'
        ? String((item as { meter_code: string }).meter_code).trim()
        : ''
      const itemQuantity = parsePositiveInt((item as { quantity_minor?: unknown } | null)?.quantity_minor, `${fieldLabel}[].quantity_minor`)
      if (!meterCodeRaw) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${fieldLabel}[].meter_code is required` }, 422)
      }
      let meterCode: string
      try {
        meterCode = normalizeIdentifier(meterCodeRaw, 'meter_code')
      } catch (error) {
        const message = error instanceof Error ? error.message : `${fieldLabel}[].meter_code is invalid`
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message }, 422)
      }

      const normalizedItem: NormalizedCommitItem = {
        meter_code: meterCode,
        quantityMinor: itemQuantity,
      }

      const unit = (item as { unit?: unknown } | null)?.unit
      if (typeof unit === 'string' && unit.trim().length > 0) {
        normalizedItem.unit = unit.trim()
      }

      const clientPricingEtag = (item as { client_pricing_etag?: unknown } | null)?.client_pricing_etag
      if (typeof clientPricingEtag === 'string') {
        normalizedItem.clientPricingEtag = clientPricingEtag.trim()
      }
      const clientUnitPrice = parseOptionalNonNegativeInt((item as { client_unit_price_xusd?: unknown } | null)?.client_unit_price_xusd, `${fieldLabel}[].client_unit_price_xusd`)
      if (clientUnitPrice !== undefined) {
        normalizedItem.clientUnitPriceXusd = clientUnitPrice
      }

      normalized.push(normalizedItem)
    }
    return normalized
  }

  private resolveMeterResidualMode(metadata: Record<string, unknown> | null | undefined): ResidualMode {
    if (metadata && typeof metadata === 'object') {
      const raw = (metadata as { residual_mode?: unknown }).residual_mode
      if (typeof raw === 'string') {
        const normalized = raw.trim().toLowerCase()
        if (normalized === 'prepaid') {
          return 'prepaid'
        }
      }
    }
    return 'postpaid'
  }

  private buildAuthorizeRequestHash(payload: {
    subject: string
    featureCode: string
    featureFamilyCode?: string | null
    estimatedQuantity?: number
    budgetId?: string
    labels?: Record<string, string> | undefined
  }): string {
    return hashRequest({
      schema: 'gate.authorize.request.v2',
      subject: payload.subject,
      feature_code: payload.featureCode,
      feature_family_code: payload.featureFamilyCode ?? null,
      estimated_quantity_minor: payload.estimatedQuantity ?? null,
      budget_id: payload.budgetId ?? null,
      labels: payload.labels ?? null,
    })
  }

  private buildCommitRequestHash(payload: {
    leaseToken: string
    featureCode: string
    quantityMinor: number
    labels?: Record<string, string> | undefined
    items: NormalizedCommitItem[]
  }): string {
    return hashRequest({
      schema: 'gate.commit.request.v3',
      lease_token: payload.leaseToken,
      feature_code: payload.featureCode,
      quantity_minor: payload.quantityMinor,
      labels: payload.labels ?? null,
      items: payload.items.map((item) => ({
        meter_code: item.meter_code,
        quantity_minor: item.quantityMinor,
        client_pricing_etag: item.clientPricingEtag ?? null,
        client_unit_price_xusd: item.clientUnitPriceXusd ?? null,
      })),
    })
  }

  private buildMeterPriceView(params: {
    featureCode: string
    meterCode: string
    unit?: string
    price: MeterPriceInfo
  }): MeterPriceView {
    return {
      unit_price_xusd: params.price.unitPriceXusd.toString(),
      unit_quantity_minor: params.price.unitQuantityMinor.toString(),
      rounding: params.price.rounding,
      effective_at: params.price.effectiveAt.toISOString(),
      fingerprint: this.pricingService.createPricingIdentity({
        featureCode: params.featureCode,
        meterCode: params.meterCode,
        unitPriceXusd: params.price.unitPriceXusd,
        unitQuantityMinor: params.price.unitQuantityMinor,
        rounding: params.price.rounding,
        effectiveAt: params.price.effectiveAt,
      }),
      unit: params.unit,
    }
  }

  private computeAuthorizeWorstCaseAmount(quantityMinor: bigint, price: MeterPriceInfo): bigint {
    if (quantityMinor <= 0n) {
      return 0n
    }
    const denom = price.unitQuantityMinor > 0n ? price.unitQuantityMinor : 1n
    const blocks = denom <= 1n ? quantityMinor : (quantityMinor + denom - 1n) / denom
    return blocks * price.unitPriceXusd
  }

  private async buildMeterCoverages(
    db: Kysely<Database>,
    params: {
      realmId: string
      billingUserId: string
      billingAccountId: string
      profile: 'conservative' | 'optimistic'
      asOf: Date
      inputs: Array<{ meterCode: string; featureCode: string; price: MeterPriceInfo }>
      budgetId?: string
    },
  ): Promise<Map<string, { grants: MeterCoverage; budget?: MeterCoverage }>> {
    const coverageMap = new Map<string, { grants: MeterCoverage; budget?: MeterCoverage }>()
    if (params.inputs.length === 0) {
      return coverageMap
    }

    const grantBalances = await this.grantBalanceService.getAccountGrantBalances(db, {
      billingUserId: params.billingUserId,
      billingAccountId: params.billingAccountId,
      asOf: params.asOf,
    })

    const grantBalance = grantBalances.totals.availableXusd > 0n ? grantBalances.totals.availableXusd : 0n
    const grantBaseNotes = grantBalances.grants.length === 0 ? 'no active grants' : undefined

    let budgetBalance: bigint | null = null
    let budgetBaseNotes: string | undefined
    if (params.budgetId) {
      const budgetId = params.budgetId.trim()
      if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(budgetId)) {
        throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'invalid budget_id' }, 422)
      }

      const budgetRow = await db
        .selectFrom('budgets as b')
        .innerJoin('billing_accounts as ba', 'ba.billing_account_id', 'b.billing_account_id')
        .select([
          'b.limit_xusd as limit_xusd',
          'b.reserved_xusd as reserved_xusd',
          'b.consumed_xusd as consumed_xusd',
          'b.status as status',
          'b.window_start as window_start',
          'b.window_end as window_end',
        ])
        .where('b.budget_id', '=', budgetId)
        .where('b.billing_user_id', '=', params.billingUserId)
        .where('b.billing_account_id', '=', params.billingAccountId)
        .where('ba.realm_id', '=', params.realmId)
        .executeTakeFirst()

      if (!budgetRow) {
        throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'budget not found' }, 404)
      }

      if (budgetRow.status !== 'active') {
        throw new HttpException({ code: 'RESOURCE.NOT_FOUND', message: 'budget inactive' }, 404)
      }

      if (budgetRow.window_start && budgetRow.window_start > params.asOf) {
        budgetBalance = 0n
        budgetBaseNotes = 'budget window not yet active'
      } else if (budgetRow.window_end && budgetRow.window_end <= params.asOf) {
        budgetBalance = 0n
        budgetBaseNotes = 'budget window expired'
      } else {
        const limit = bigintFromUnknown(budgetRow.limit_xusd)
        const reserved = bigintFromUnknown(budgetRow.reserved_xusd) ?? 0n
        const consumed = bigintFromUnknown(budgetRow.consumed_xusd) ?? 0n

        if (limit === null || limit === undefined) {
          budgetBalance = 0n
          budgetBaseNotes = 'budget has no limit configured'
        } else {
          const remaining = limit - reserved - consumed
          budgetBalance = remaining > 0n ? remaining : 0n
        }
      }
    }

    const grantBalanceNormalized = grantBalance > 0n ? grantBalance : 0n
    const budgetBalanceNormalized = params.budgetId
      ? budgetBalance === null
        ? null
        : budgetBalance > 0n ? budgetBalance : 0n
      : null

    for (const input of params.inputs) {
      const grantsCoverage = this.buildMeterCoverageEntry({
        balance: grantBalanceNormalized,
        baseNotes: grantBaseNotes,
        featureCode: input.featureCode,
        price: input.price,
        profile: params.profile,
        basis: 'xusd',
        asOf: params.asOf,
      })

      let budgetCoverage: MeterCoverage | undefined
      if (params.budgetId && budgetBalanceNormalized !== null) {
        budgetCoverage = this.buildMeterCoverageEntry({
          balance: budgetBalanceNormalized,
          baseNotes: budgetBaseNotes,
          featureCode: input.featureCode,
          price: input.price,
          profile: params.profile,
          basis: 'budget',
          budgetId: params.budgetId,
          asOf: params.asOf,
        })
      }

      coverageMap.set(input.meterCode, {
        grants: grantsCoverage,
        ...(budgetCoverage ? { budget: budgetCoverage } : {}),
      })
    }

    return coverageMap
  }

  private buildMeterCoverageEntry(params: {
    balance: bigint
    baseNotes?: string
    featureCode?: string
    price: MeterPriceInfo
    profile: 'conservative' | 'optimistic'
    basis: 'xusd' | 'budget'
    budgetId?: string
    asOf: Date
  }): MeterCoverage {
    const notesParts: string[] = []
    if (params.baseNotes) notesParts.push(params.baseNotes)
    if (params.featureCode) notesParts.push(`feature=${params.featureCode}`)

    const pricePerBlock = params.price.unitPriceXusd
    const denom = params.price.unitQuantityMinor

    if (pricePerBlock <= 0n || denom <= 0n) {
      notesParts.push('pricing unavailable')
      const notes = notesParts.length > 0 ? notesParts.join('; ') : undefined
      const coverage: MeterCoverage = {
        basis: params.basis,
        balance_xusd: (params.balance > 0n ? params.balance : 0n).toString(),
        max_quantity_minor_estimated: '0',
        optimistic_quantity_minor: params.profile === 'optimistic' ? '0' : undefined,
        advisory: true,
        as_of: params.asOf.toISOString(),
        budget_id: params.basis === 'budget' ? params.budgetId : undefined,
      }
      if (notes) coverage.notes = notes
      return coverage
    }

    const balance = params.balance > 0n ? params.balance : 0n
    const maxBlocks = balance / pricePerBlock
    const maxQuantity = maxBlocks * denom
    const optimisticBlocks = balance % pricePerBlock > 0n ? maxBlocks + 1n : maxBlocks

    const coverage: MeterCoverage = {
      basis: params.basis,
      balance_xusd: balance.toString(),
      max_quantity_minor_estimated: maxQuantity.toString(),
      advisory: true,
      as_of: params.asOf.toISOString(),
      budget_id: params.basis === 'budget' ? params.budgetId : undefined,
    }

    if (notesParts.length > 0) {
      coverage.notes = notesParts.join('; ')
    }

    if (params.profile === 'optimistic') {
      coverage.optimistic_quantity_minor = (optimisticBlocks * denom).toString()
    }

    return coverage
  }
}
