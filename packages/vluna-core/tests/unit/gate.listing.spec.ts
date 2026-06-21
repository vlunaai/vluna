import { describe, it, expect, vi } from 'vitest'
import type { AppRequest } from '../../src/types/app-request.js'

vi.mock('../../src/db/index.js', () => {
  return { setRlsSession: vi.fn(async () => undefined) }
})

const { GateService } = await import('../../src/features/gate/services/gate.service.js')

function makeGateService(opts: {
  entitledFeatures: string[]
  featureMeters: Map<string, string[]>
  policyWindows?: unknown[]
}) {
  const quotaService = {
    loadEntitledFeatures: vi.fn(async () => {
      const entitledFeatureCodes = new Set(opts.entitledFeatures)
      const entitledFeatureIdByCode = new Map(opts.entitledFeatures.map((code) => [code, `fid:${code}`]))
      const featureFamilyCodeByFeatureCode = new Map(opts.entitledFeatures.map((code) => [code, `${code}.cap`]))
      return { entitledFeatureCodes, entitledFeatureIdByCode, featureFamilyCodeByFeatureCode }
    }),
    loadFeatureMetersMapByFeatureIds: vi.fn(async () => opts.featureMeters),
    loadActivePolicyWindows: vi.fn(async () => opts.policyWindows ?? []),
    loadCounterLookup: vi.fn(async () => new Map<string, number>()),
    buildQuotaWindow: vi.fn(),
    buildRateWindow: vi.fn(),
  }

  return new GateService(
    {} as never,
    {} as never,
    quotaService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
}

function makeReq(query: Record<string, unknown> = {}): AppRequest {
  return {
    ctx: { db: {} as never, realmId: 'r1', billingAccountId: 'ba1', billingUserId: 'bu1' },
    query,
  } as unknown as AppRequest
}

describe('GateService listFeatureLimits/listMeters', () => {
  it('listFeatureLimits returns entitled features even when policyWindows is empty', async () => {
    const service = makeGateService({
      entitledFeatures: ['feat1'],
      featureMeters: new Map([['feat1', ['m1']]]),
      policyWindows: [],
    })

    const result = await service.listFeatureLimits(makeReq())
    expect(result).toHaveLength(1)
    expect(result[0]?.feature_code).toBe('feat1')
    expect(result[0]?.feature_family_code).toBe('feat1.cap')
    expect(result[0]?.meters).toEqual(['m1'])
    expect(result[0]?.quotas).toBeUndefined()
    expect(result[0]?.rates).toBeUndefined()
  })

  it('listFeatureLimits returns empty quotas/rates arrays when expanded and policyWindows is empty', async () => {
    const service = makeGateService({
      entitledFeatures: ['feat1'],
      featureMeters: new Map([['feat1', ['m1']]]),
      policyWindows: [],
    })

    const result = await service.listFeatureLimits(makeReq({ expand: ['quotas', 'rates'] }))
    expect(result).toHaveLength(1)
    expect(result[0]?.quotas).toEqual([])
    expect(result[0]?.rates).toEqual([])
  })

  it('listMeters returns meters for entitled features even when policyWindows is empty', async () => {
    const service = makeGateService({
      entitledFeatures: ['feat1'],
      featureMeters: new Map([['feat1', ['m2', 'm1']]]),
      policyWindows: [],
    })

    const result = await service.listMeters(makeReq())
    expect(result.map((row) => row.meter_code)).toEqual(['m1', 'm2'])
    expect(result[0]?.features).toEqual(['feat1'])
    expect(result[0]?.quotas).toBeUndefined()
    expect(result[0]?.rates).toBeUndefined()
  })

  it('listMeters returns empty limits arrays when expanded and policyWindows is empty', async () => {
    const service = makeGateService({
      entitledFeatures: ['feat1'],
      featureMeters: new Map([['feat1', ['m1']]]),
      policyWindows: [],
    })

    const result = await service.listMeters(makeReq({ expand: ['limits'] }))
    expect(result).toHaveLength(1)
    expect(result[0]?.quotas).toEqual([])
    expect(result[0]?.rates).toEqual([])
  })
})
