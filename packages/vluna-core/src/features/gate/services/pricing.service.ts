import { Injectable, HttpException, Logger } from '@nestjs/common'
import { Kysely, sql } from 'kysely'
import type { Database } from '../../../types/database.js'
import type { CommitItemNormalized, PricingSnapshot, RoundingMode } from './gate.types.js'
import {
  applyPrepaidRounding,
  applyRoundingWithResidual,
  bigintFromUnknown,
  hashRequest,
  nowIso,
  toSafeNumber,
} from './gate.utils.js'
import {
  applyContractPricingAdjustments,
  parseContractPricingTermV1,
  resolveContractPricingBase,
} from './contract-pricing.js'

export type MeterPriceInfo = {
  unitPriceXusd: bigint
  unitPriceBaseXusd: bigint
  unitPriceDynamicXusd: bigint
  unitQuantityMinor: bigint
  rounding: RoundingMode
  unitCostXusd: bigint
  costUnitQuantityMinor: bigint
  costRounding: RoundingMode
  effectiveAt: Date
}

export type PricingEstimateCandidate = {
  meter_code: string
  estimate: PricingEstimate
}

export type PricingItemResult = {
  item: CommitItemNormalized
  price: MeterPriceInfo
  computation: PricingComputation
}

export type PricingEstimate = {
  featureCode: string
  meterCode: string
  unitPriceXusd: bigint
  unitQuantityMinor: bigint
  rounding: RoundingMode
  effectiveAt: Date
  estimateAmountXusd: number
  worstCaseBlocks: bigint
  pricingIdentity: string
}

export type PricingComputation = {
  snapshot: PricingSnapshot
  costSnapshot: PricingSnapshot
  unitPriceXusd: bigint
  unitQuantityMinor: bigint
  rounding: RoundingMode
  unitCostXusd: bigint
  costUnitQuantityMinor: bigint
  costRounding: RoundingMode
  featureCode: string
  amountXusd: bigint
  costXusd: bigint
  pricingFingerprint: string
  costPricingFingerprint: string
  pricingIdentity: string
  costPricingIdentity: string
  effectiveAt: Date
  blocksCharged: bigint
  costBlocksCharged: bigint
  residualRemainder: bigint
  costResidualRemainder: bigint
}

export type ResidualBucketRow = {
  billing_user_id: string
  billing_account_id: string
  meter_code: string
  pricing_fingerprint: string
  denom: string
  rounding: RoundingMode
  remainder_numer: string
}

export type ContractPricingWarning = {
  kind: 'invalid_term' | 'meter_price_missing'
  meterCode: string
  contractId: string
  termKey: string
  message: string
}

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name)

  createPricingIdentity(params: {
    featureCode: string
    meterCode: string
    unitPriceXusd: bigint
    unitQuantityMinor: bigint
    rounding: RoundingMode
    effectiveAt: Date
    kind?: 'revenue' | 'cost'
    residualMode?: 'postpaid' | 'prepaid'
  }): string {
    const kind = params.kind ?? 'revenue'
    const payload: Record<string, unknown> = {
      schema: 'gate/price-identity:v2',
      kind,
      feature_code: params.featureCode,
      meterCode: params.meterCode,
      unit_price_xusd: params.unitPriceXusd.toString(),
      unit_quantity_minor: params.unitQuantityMinor.toString(),
      rounding: params.rounding,
      effective_at: params.effectiveAt.toISOString(),
    }
    if (params.residualMode === 'prepaid') {
      payload.residual_mode = 'prepaid'
    }
    return hashRequest(payload)
  }

  async fetchMeterPrice(
    trx: Kysely<Database>,
    params: { realmId: string; featureCode: string; meterCode: string },
  ): Promise<MeterPriceInfo> {
    const map = await this.fetchMeterPricesBatch(trx, {
      realmId: params.realmId,
      featureCode: params.featureCode,
      meterCodes: [params.meterCode],
    })
    const entry = map.get(params.meterCode)
    if (!entry) {
      throw new HttpException(
        {
          code: 'RESOURCE.NOT_FOUND',
          message: `pricing not configured for feature ${params.featureCode} / meter ${params.meterCode}`,
        },
        422,
      )
    }
    return entry
  }

  async fetchMeterPricesBatch(
    trx: Kysely<Database>,
    params: {
      realmId: string
      meterCodes: string[]
      featureCode?: string
      billingAccountId?: string
      at?: Date
      onWarning?: (warning: ContractPricingWarning) => void
    },
  ): Promise<Map<string, MeterPriceInfo>> {
    const meterCodes = Array.from(
      new Set(
        params.meterCodes
          .map((code) => code?.trim())
          .filter((code): code is string => Boolean(code)),
      ),
    )
    const result = new Map<string, MeterPriceInfo>()
    if (meterCodes.length === 0) {
      return result
    }

    const ranked = trx
      .selectFrom('meter_prices')
      .select([
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
        sql<number>`row_number() over (partition by meter_code order by effective_at desc)`.as('rn'),
      ])
      .where('realm_id', '=', params.realmId)
      .where('meter_code', 'in', meterCodes)
      .as('ranked')

    const rows = await trx
      .selectFrom(ranked)
      .select([
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
      .where('rn', '=', 1)
      .execute()

    for (const row of rows) {
      const meterCode = row.meter_code
      const unitPrice = bigintFromUnknown(row.unit_price_xusd) ?? 0n
      const unitPriceBase = bigintFromUnknown(row.unit_price_base_xusd) ?? unitPrice
      const unitPriceDynamic = bigintFromUnknown(row.unit_price_dynamic_xusd) ?? 0n
      const unitQuantity = bigintFromUnknown(row.unit_quantity_minor) ?? 1n
      const rounding = (row.rounding ?? 'nearest') as RoundingMode
      const unitCost = bigintFromUnknown(row.unit_cost_xusd) ?? unitPrice
      const costUnitQuantity = bigintFromUnknown(row.cost_unit_quantity_minor) ?? unitQuantity
      const costRounding = (row.cost_rounding ?? row.rounding ?? 'nearest') as RoundingMode
      const effectiveAt = row.effective_at instanceof Date ? row.effective_at : new Date(row.effective_at)

      if (unitPrice < 0n) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'unit_price_xusd must be non-negative' }, 500)
      }
      if (unitPriceBase < 0n) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'unit_price_base_xusd must be non-negative' }, 500)
      }
      if (unitQuantity < 1n) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'unit_quantity_minor must be >= 1' }, 500)
      }
      if (!(rounding === 'floor' || rounding === 'nearest' || rounding === 'ceil')) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'invalid rounding mode' }, 500)
      }
      if (unitCost < 0n) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'unit_cost_xusd must be non-negative' }, 500)
      }
      if (costUnitQuantity < 1n) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'cost_unit_quantity_minor must be >= 1' }, 500)
      }
      if (!(costRounding === 'floor' || costRounding === 'nearest' || costRounding === 'ceil')) {
        throw new HttpException({ code: 'SERVER.CONFIG', message: 'invalid cost rounding mode' }, 500)
      }

      result.set(meterCode, {
        unitPriceXusd: unitPrice,
        unitPriceBaseXusd: unitPriceBase,
        unitPriceDynamicXusd: unitPriceDynamic,
        unitQuantityMinor: unitQuantity,
        rounding,
        unitCostXusd: unitCost,
        costUnitQuantityMinor: costUnitQuantity,
        costRounding,
        effectiveAt,
      })
    }

    const billingAccountId = params.billingAccountId?.trim()
    if (billingAccountId) {
      const at = params.at ?? new Date()

      // Optimization: resolve active contract and latest terms in one DB round-trip.
      const activeContract = trx
        .selectFrom('billing_contracts')
        .select(['contract_id', 'effective_at'])
        .where('realm_id', '=', params.realmId)
        .where('billing_account_id', '=', billingAccountId)
        .where('status', '=', 'active')
        .where('effective_at', '<=', at)
        .orderBy('effective_at', 'desc')
        .limit(1)
        .as('ac')

      const termRows = await trx
        .selectFrom(activeContract)
        .innerJoin('contract_terms as ct', 'ct.contract_id', 'ac.contract_id')
        .select((eb) => [
          eb.ref('ac.contract_id').as('contract_id'),
          eb.ref('ct.term_key').as('term_key'),
          eb.ref('ct.value_json').as('value_json'),
          eb.ref('ct.effective_at').as('effective_at'),
        ])
        .distinctOn(['ct.term_key'])
        .where('ct.kind', '=', 'pricing')
        .where('ct.term_key', 'in', meterCodes)
        .where('ct.effective_at', '<=', at)
        .orderBy('ct.term_key', 'asc')
        .orderBy('ct.effective_at', 'desc')
        .execute()

      const termByKey = new Map<string, { contractId: string; valueJson: unknown; effectiveAt: Date }>()
      for (const row of termRows) {
        termByKey.set(String(row.term_key), {
          contractId: String(row.contract_id),
          valueJson: row.value_json,
          effectiveAt: row.effective_at instanceof Date ? row.effective_at : new Date(row.effective_at),
        })
      }

      for (const [meterCode, term] of termByKey.entries()) {
        if (result.has(meterCode)) continue
        const message = 'contract pricing ignored: meter_prices has no active row for meter_code as-of at (strict mode)'
        this.logger.warn(`contract pricing ignored: contract_id=${term.contractId} meter_code=${meterCode} term_key=${meterCode}: ${message}`)
        params.onWarning?.({
          kind: 'meter_price_missing',
          meterCode,
          contractId: term.contractId,
          termKey: meterCode,
          message,
        })
      }

      for (const [meterCode, basePrice] of result.entries()) {
        const term = termByKey.get(meterCode)
        if (!term) continue
        try {
          const parsed = parseContractPricingTermV1(term.valueJson)

          const resolvedCostBase = resolveContractPricingBase({
            side: 'cost',
            base: parsed.cost?.base,
            baseUnitPriceXusd: basePrice.unitPriceXusd,
            baseUnitCostXusd: basePrice.unitCostXusd,
          })
          const resolvedCost = applyContractPricingAdjustments(resolvedCostBase, parsed.cost?.adjustments)

          const resolvedPriceBase = resolveContractPricingBase({
            side: 'price',
            base: parsed.price?.base,
            baseUnitPriceXusd: basePrice.unitPriceXusd,
            baseUnitCostXusd: basePrice.unitCostXusd,
            resolvedCostXusd: resolvedCost,
          })
          const resolvedPrice = applyContractPricingAdjustments(resolvedPriceBase, parsed.price?.adjustments)

          result.set(meterCode, {
            ...basePrice,
            unitPriceXusd: resolvedPrice,
            unitCostXusd: resolvedCost,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'invalid contract pricing term'
          this.logger.warn(
            `contract pricing ignored: contract_id=${term.contractId} meter_code=${meterCode} term_key=${meterCode}: ${message}`,
          )
          params.onWarning?.({
            kind: 'invalid_term',
            meterCode,
            contractId: term.contractId,
            termKey: meterCode,
            message,
          })
        }
      }
    }

    return result
  }

  computeAuthorizeEstimate(
    quantity: number,
    featureCode: string,
    meterCode: string,
    price: MeterPriceInfo,
  ): PricingEstimate {
    const safeQuantity = quantity > 0 ? BigInt(Math.floor(quantity)) : 0n
    const worstCaseBlocks =
      price.unitQuantityMinor <= 1n
        ? safeQuantity
        : (safeQuantity + price.unitQuantityMinor - 1n) / price.unitQuantityMinor
    const estimateAmount = worstCaseBlocks * price.unitPriceXusd
    const identity = this.createPricingIdentity({
      featureCode,
      meterCode,
      unitPriceXusd: price.unitPriceXusd,
      unitQuantityMinor: price.unitQuantityMinor,
      rounding: price.rounding,
      effectiveAt: price.effectiveAt,
    })

    return {
      featureCode,
      meterCode,
      unitPriceXusd: price.unitPriceXusd,
      unitQuantityMinor: price.unitQuantityMinor,
      rounding: price.rounding,
      effectiveAt: price.effectiveAt,
      estimateAmountXusd: toSafeNumber(estimateAmount),
      worstCaseBlocks,
      pricingIdentity: identity,
    }
  }

  computePricingComputation(params: {
    featureCode: string
    meterCode: string
    unit: string
    quantityMinor: number
    price: MeterPriceInfo
    previousXusdRemainder: bigint
    previousCostRemainder: bigint
  }): PricingComputation {
    const quantity = BigInt(Math.floor(Math.max(0, params.quantityMinor)))
    const creditsDenom = params.price.unitQuantityMinor
    const creditsRounding = params.price.rounding
    const costDenom = params.price.costUnitQuantityMinor
    const costRounding = params.price.costRounding

    let creditsRemainder = params.previousXusdRemainder
    if (creditsRemainder < 0n) creditsRemainder = 0n
    if (creditsDenom > 0n && creditsRemainder >= creditsDenom) {
      creditsRemainder %= creditsDenom
    }

    let costRemainder = params.previousCostRemainder
    if (costRemainder < 0n) costRemainder = 0n
    if (costDenom > 0n && costRemainder >= costDenom) {
      costRemainder %= costDenom
    }

    const creditsTotal = creditsDenom <= 1n ? quantity : creditsRemainder + quantity
    const { blocks: creditBlocks, remainder: newCreditsRemainder } = applyRoundingWithResidual(
      creditsTotal,
      creditsDenom,
      creditsRounding,
    )
    const amountXusd = creditBlocks * params.price.unitPriceXusd

    const costTotal = costDenom <= 1n ? quantity : costRemainder + quantity
    const { blocks: costBlocks, remainder: newCostRemainder } = applyRoundingWithResidual(costTotal, costDenom, costRounding)
    const cost = costBlocks * params.price.unitCostXusd

    const computedAt = nowIso()
    const revenueIdentity = this.createPricingIdentity({
      featureCode: params.featureCode,
      meterCode: params.meterCode,
      unitPriceXusd: params.price.unitPriceXusd,
      unitQuantityMinor: params.price.unitQuantityMinor,
      rounding: creditsRounding,
      effectiveAt: params.price.effectiveAt,
      kind: 'revenue',
    })
    const costIdentity = this.createPricingIdentity({
      featureCode: params.featureCode,
      meterCode: params.meterCode,
      unitPriceXusd: params.price.unitCostXusd,
      unitQuantityMinor: params.price.costUnitQuantityMinor,
      rounding: costRounding,
      effectiveAt: params.price.effectiveAt,
      kind: 'cost',
    })

    const pricingFingerprintPayload: Record<string, unknown> = {
      schema: 'gate/pricing:v2',
      pricing_kind: 'revenue',
      feature_code: params.featureCode,
      meter_code: params.meterCode,
      unit: params.unit,
      quantity_minor: quantity.toString(),
      unit_price_xusd: params.price.unitPriceXusd.toString(),
      unit_quantity_minor: params.price.unitQuantityMinor.toString(),
      rounding: creditsRounding,
      effective_at: params.price.effectiveAt.toISOString(),
      computed_at: computedAt,
    }
    if (params.price.unitPriceDynamicXusd !== 0n) {
      pricingFingerprintPayload.unit_price_base_xusd = params.price.unitPriceBaseXusd.toString()
      pricingFingerprintPayload.unit_price_dynamic_xusd = params.price.unitPriceDynamicXusd.toString()
    }
    const pricingFingerprint = hashRequest(pricingFingerprintPayload)

    const costPricingFingerprint = hashRequest({
      schema: 'gate/pricing:v2',
      pricing_kind: 'cost',
      feature_code: params.featureCode,
      meter_code: params.meterCode,
      unit: params.unit,
      quantity_minor: quantity.toString(),
      unit_price_xusd: params.price.unitCostXusd.toString(),
      unit_quantity_minor: params.price.costUnitQuantityMinor.toString(),
      rounding: costRounding,
      effective_at: params.price.effectiveAt.toISOString(),
      computed_at: computedAt,
    })

    const snapshot: PricingSnapshot = {
      computed_at: computedAt,
      unit: params.unit,
      fingerprint: pricingFingerprint,
      unit_price_xusd: params.price.unitPriceXusd.toString(),
      unit_quantity_minor: params.price.unitQuantityMinor.toString(),
      rounding: creditsRounding,
      effective_at: params.price.effectiveAt.toISOString(),
      provenance: {
        source: 'live',
        inputs: {
          feature_code: params.featureCode,
          meter_code: params.meterCode,
        },
      },
    }
    if (params.price.unitPriceDynamicXusd !== 0n) {
      snapshot.unit_price_base_xusd = params.price.unitPriceBaseXusd.toString()
      snapshot.unit_price_dynamic_xusd = params.price.unitPriceDynamicXusd.toString()
    }

    const costSnapshot: PricingSnapshot = {
      computed_at: computedAt,
      unit: params.unit,
      fingerprint: costPricingFingerprint,
      unit_price_xusd: params.price.unitCostXusd.toString(),
      unit_quantity_minor: params.price.costUnitQuantityMinor.toString(),
      rounding: costRounding,
      effective_at: params.price.effectiveAt.toISOString(),
      provenance: {
        source: 'live',
        inputs: {
          feature_code: params.featureCode,
          meter_code: params.meterCode,
        },
      },
    }

    return {
      snapshot,
      costSnapshot,
      unitPriceXusd: params.price.unitPriceXusd,
      unitQuantityMinor: params.price.unitQuantityMinor,
      rounding: creditsRounding,
      unitCostXusd: params.price.unitCostXusd,
      costUnitQuantityMinor: params.price.costUnitQuantityMinor,
      costRounding,
      featureCode: params.featureCode,
      amountXusd,
      costXusd: cost,
      pricingFingerprint,
      costPricingFingerprint,
      pricingIdentity: revenueIdentity,
      costPricingIdentity: costIdentity,
      effectiveAt: params.price.effectiveAt,
      blocksCharged: creditBlocks,
      costBlocksCharged: costBlocks,
      residualRemainder: creditsDenom <= 1n ? 0n : newCreditsRemainder,
      costResidualRemainder: costDenom <= 1n ? 0n : newCostRemainder,
    }
  }

  computePrepaidPricingComputation(params: {
    featureCode: string
    meterCode: string
    unit: string
    quantityMinor: number
    price: MeterPriceInfo
    previousXusdRemainder: bigint
    previousCostRemainder: bigint
  }): PricingComputation {
    const quantity = BigInt(Math.floor(Math.max(0, params.quantityMinor)))
    const creditsDenom = params.price.unitQuantityMinor
    const costDenom = params.price.costUnitQuantityMinor

    let prepaidCredits = params.previousXusdRemainder
    if (prepaidCredits < 0n) prepaidCredits = 0n
    if (creditsDenom > 1n && prepaidCredits >= creditsDenom) {
      prepaidCredits %= creditsDenom
    }

    let prepaidCost = params.previousCostRemainder
    if (prepaidCost < 0n) prepaidCost = 0n
    if (costDenom > 1n && prepaidCost >= costDenom) {
      prepaidCost %= costDenom
    }

    const { blocks: creditBlocks, remainder: newCreditsRemainder } = applyPrepaidRounding(quantity, creditsDenom, prepaidCredits)
    const amountXusd = creditBlocks * params.price.unitPriceXusd

    const { blocks: costBlocks, remainder: newCostRemainder } = applyPrepaidRounding(quantity, costDenom, prepaidCost)
    const cost = costBlocks * params.price.unitCostXusd

    const computedAt = nowIso()
    const revenueIdentity = this.createPricingIdentity({
      featureCode: params.featureCode,
      meterCode: params.meterCode,
      unitPriceXusd: params.price.unitPriceXusd,
      unitQuantityMinor: params.price.unitQuantityMinor,
      rounding: params.price.rounding,
      effectiveAt: params.price.effectiveAt,
      kind: 'revenue',
      residualMode: 'prepaid',
    })
    const costIdentity = this.createPricingIdentity({
      featureCode: params.featureCode,
      meterCode: params.meterCode,
      unitPriceXusd: params.price.unitCostXusd,
      unitQuantityMinor: params.price.costUnitQuantityMinor,
      rounding: params.price.costRounding,
      effectiveAt: params.price.effectiveAt,
      kind: 'cost',
      residualMode: 'prepaid',
    })

    const pricingFingerprintPayload: Record<string, unknown> = {
      schema: 'gate/pricing:v2',
      pricing_kind: 'revenue',
      feature_code: params.featureCode,
      meter_code: params.meterCode,
      unit: params.unit,
      quantity_minor: quantity.toString(),
      unit_price_xusd: params.price.unitPriceXusd.toString(),
      unit_quantity_minor: params.price.unitQuantityMinor.toString(),
      rounding: params.price.rounding,
      effective_at: params.price.effectiveAt.toISOString(),
      computed_at: computedAt,
      residual_mode: 'prepaid',
    }
    if (params.price.unitPriceDynamicXusd !== 0n) {
      pricingFingerprintPayload.unit_price_base_xusd = params.price.unitPriceBaseXusd.toString()
      pricingFingerprintPayload.unit_price_dynamic_xusd = params.price.unitPriceDynamicXusd.toString()
    }
    const pricingFingerprint = hashRequest(pricingFingerprintPayload)

    const costPricingFingerprint = hashRequest({
      schema: 'gate/pricing:v2',
      pricing_kind: 'cost',
      feature_code: params.featureCode,
      meter_code: params.meterCode,
      unit: params.unit,
      quantity_minor: quantity.toString(),
      unit_price_xusd: params.price.unitCostXusd.toString(),
      unit_quantity_minor: params.price.costUnitQuantityMinor.toString(),
      rounding: params.price.costRounding,
      effective_at: params.price.effectiveAt.toISOString(),
      computed_at: computedAt,
      residual_mode: 'prepaid',
    })

    const snapshot: PricingSnapshot = {
      computed_at: computedAt,
      unit: params.unit,
      fingerprint: pricingFingerprint,
      unit_price_xusd: params.price.unitPriceXusd.toString(),
      unit_quantity_minor: params.price.unitQuantityMinor.toString(),
      rounding: params.price.rounding,
      effective_at: params.price.effectiveAt.toISOString(),
      provenance: {
        source: 'live',
        inputs: {
          feature_code: params.featureCode,
          meter_code: params.meterCode,
        },
      },
    }
    if (params.price.unitPriceDynamicXusd !== 0n) {
      snapshot.unit_price_base_xusd = params.price.unitPriceBaseXusd.toString()
      snapshot.unit_price_dynamic_xusd = params.price.unitPriceDynamicXusd.toString()
    }

    const costSnapshot: PricingSnapshot = {
      computed_at: computedAt,
      unit: params.unit,
      fingerprint: costPricingFingerprint,
      unit_price_xusd: params.price.unitCostXusd.toString(),
      unit_quantity_minor: params.price.costUnitQuantityMinor.toString(),
      rounding: params.price.costRounding,
      effective_at: params.price.effectiveAt.toISOString(),
      provenance: {
        source: 'live',
        inputs: {
          feature_code: params.featureCode,
          meter_code: params.meterCode,
        },
      },
    }

    return {
      snapshot,
      costSnapshot,
      unitPriceXusd: params.price.unitPriceXusd,
      unitQuantityMinor: params.price.unitQuantityMinor,
      rounding: params.price.rounding,
      unitCostXusd: params.price.unitCostXusd,
      costUnitQuantityMinor: params.price.costUnitQuantityMinor,
      costRounding: params.price.costRounding,
      featureCode: params.featureCode,
      amountXusd,
      costXusd: cost,
      pricingFingerprint,
      costPricingFingerprint,
      pricingIdentity: revenueIdentity,
      costPricingIdentity: costIdentity,
      effectiveAt: params.price.effectiveAt,
      blocksCharged: creditBlocks,
      costBlocksCharged: costBlocks,
      residualRemainder: newCreditsRemainder,
      costResidualRemainder: newCostRemainder,
    }
  }

  buildMissingPricingComputation(
    params: {
      featureCode: string
      meterCode: string
      unit: string
      quantityMinor: number
      now: Date
    },
  ): PricingComputation {
    const computedAt = nowIso()
    const revenueFingerprint = hashRequest({
      schema: 'gate/pricing-missing:v1',
      pricing_kind: 'revenue',
      feature_code: params.featureCode,
      meter_code: params.meterCode,
      unit: params.unit,
      quantity_minor: params.quantityMinor,
      computed_at: computedAt,
    })
    const costFingerprint = hashRequest({
      schema: 'gate/pricing-missing:v1',
      pricing_kind: 'cost',
      feature_code: params.featureCode,
      meter_code: params.meterCode,
      unit: params.unit,
      quantity_minor: params.quantityMinor,
      computed_at: computedAt,
    })

    const snapshot: PricingSnapshot = {
      computed_at: computedAt,
      unit: params.unit,
      fingerprint: revenueFingerprint,
      unit_price_xusd: '0',
      unit_quantity_minor: '1',
      rounding: 'floor',
      effective_at: params.now.toISOString(),
      provenance: {
        source: 'missing',
        inputs: {
          feature_code: params.featureCode,
          meter_code: params.meterCode,
        },
      },
    }

    return {
      snapshot,
      costSnapshot: {
        ...snapshot,
        fingerprint: costFingerprint,
      },
      unitPriceXusd: 0n,
      unitQuantityMinor: 1n,
      rounding: 'floor',
      unitCostXusd: 0n,
      costUnitQuantityMinor: 1n,
      costRounding: 'floor',
      featureCode: params.featureCode,
      amountXusd: 0n,
      costXusd: 0n,
      pricingFingerprint: revenueFingerprint,
      costPricingFingerprint: costFingerprint,
      pricingIdentity: revenueFingerprint,
      costPricingIdentity: costFingerprint,
      effectiveAt: params.now,
      blocksCharged: 0n,
      costBlocksCharged: 0n,
      residualRemainder: 0n,
      costResidualRemainder: 0n,
    }
  }

  buildAggregatePricing(
    featureCode: string,
    unit: string,
    quantityMinor: number,
    totalCredits: bigint,
    totalBlocks: bigint,
    totalCost: bigint,
    totalCostBlocks: bigint,
    effectiveAt: Date,
    pricingResults: PricingItemResult[],
  ): PricingComputation {
    const computedAt = nowIso()
    const pricingIdentity = hashRequest({
      schema: 'gate/aggregate-pricing:v1',
      items: pricingResults.map((r) => r.computation.pricingIdentity).sort(),
    })
    const pricingFingerprint = hashRequest({
      schema: 'gate/aggregate-fingerprint:v1',
      items: pricingResults.map((r) => r.computation.pricingFingerprint).sort(),
    })
    const costPricingIdentity = hashRequest({
      schema: 'gate/aggregate-cost-pricing:v1',
      items: pricingResults.map((r) => r.computation.costPricingIdentity).sort(),
    })
    const costPricingFingerprint = hashRequest({
      schema: 'gate/aggregate-cost-fingerprint:v1',
      items: pricingResults.map((r) => r.computation.costPricingFingerprint).sort(),
    })

    const unitPriceXusd = totalBlocks > 0n ? totalCredits / totalBlocks : 0n
    const unitQuantityMinor = 1n
    const unitCostXusd = totalCostBlocks > 0n ? totalCost / totalCostBlocks : 0n
    const costUnitQuantityMinor = 1n

    const snapshot: PricingSnapshot = {
      computed_at: computedAt,
      unit: unit,
      fingerprint: pricingFingerprint,
      unit_price_xusd: unitPriceXusd.toString(),
      unit_quantity_minor: unitQuantityMinor.toString(),
      rounding: 'floor',
      effective_at: effectiveAt.toISOString(),
      provenance: {
        source: 'aggregate',
        inputs: {
          feature_code: featureCode,
          items: pricingResults.map((r) => r.item.meter_code),
        },
      },
    }

    return {
      snapshot,
      costSnapshot: {
        ...snapshot,
        fingerprint: costPricingFingerprint,
        unit_price_xusd: unitCostXusd.toString(),
        unit_quantity_minor: costUnitQuantityMinor.toString(),
      },
      unitPriceXusd,
      unitQuantityMinor,
      rounding: 'floor',
      unitCostXusd,
      costUnitQuantityMinor,
      costRounding: 'floor',
      featureCode: featureCode,
      amountXusd: totalCredits,
      costXusd: totalCost,
      pricingFingerprint,
      costPricingFingerprint,
      pricingIdentity,
      costPricingIdentity,
      effectiveAt: effectiveAt,
      blocksCharged: totalBlocks,
      costBlocksCharged: totalCostBlocks,
      residualRemainder: 0n, // Aggregates don't have residuals
      costResidualRemainder: 0n,
    }
  }

  async loadResidualBucketRemainder(
    trx: Kysely<Database>,
    params: {
      billingUserId: string
      billingAccountId: string
      meterCode: string
      pricingIdentity: string
      expectedDenom: bigint
      expectedRounding: RoundingMode
    },
  ): Promise<bigint> {
    const row = await sql<ResidualBucketRow>`
      SELECT billing_user_id, billing_account_id, meter_code, pricing_fingerprint, denom, rounding, remainder_numer
      FROM gate_residual_buckets
      WHERE billing_user_id = ${params.billingUserId}
        AND billing_account_id = ${params.billingAccountId}
        AND meter_code = ${params.meterCode}
        AND pricing_fingerprint = ${params.pricingIdentity}
      FOR UPDATE
    `
      .execute(trx)
      .then((res) => res.rows[0])

    if (!row) {
      return 0n
    }

    const denom = bigintFromUnknown(row.denom) ?? params.expectedDenom
    const rounding = (row.rounding ?? params.expectedRounding) as RoundingMode
    if (denom !== params.expectedDenom || rounding !== params.expectedRounding) {
      return 0n
    }

    return bigintFromUnknown(row.remainder_numer) ?? 0n
  }

  async upsertResidualBucket(
    trx: Kysely<Database>,
    params: {
      billingUserId: string
      billingAccountId: string
      meterCode: string
      pricingIdentity: string
      denom: bigint
      rounding: RoundingMode
      remainder: bigint
      now: Date
    },
  ): Promise<void> {
    await trx
      .insertInto('gate_residual_buckets')
      .values({
        billing_user_id: params.billingUserId,
        billing_account_id: params.billingAccountId,
        meter_code: params.meterCode,
        pricing_fingerprint: params.pricingIdentity,
        denom: params.denom.toString(),
        rounding: params.rounding,
        remainder_numer: params.remainder.toString(),
        updated_at: params.now,
      })
      .onConflict((oc) =>
        oc
          .columns(['billing_user_id', 'meter_code', 'pricing_fingerprint'])
          .doUpdateSet({
            denom: params.denom.toString(),
            rounding: params.rounding,
            remainder_numer: params.remainder.toString(),
            updated_at: params.now,
          }),
      )
      .execute()
  }
}
