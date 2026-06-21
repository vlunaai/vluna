import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db, setRlsSession, withDatabaseConnection } from '../../src/db/index.js'
import { PricingService } from '../../src/features/gate/services/pricing.service.js'
import { prepareDbTestContext } from '../utils/db-setup.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/residual_buckets.sql')
const realmId = 'realm-test'
const billingAccountId = 'ba-test'
const billingUserId = 'bu-test'

describe('Residual bucket persistence (db)', { tags: ['db'] }, () => {
  let stop: () => Promise<void>
  let skipped = false

  beforeAll(async () => {
    try {
      const ctx = await prepareDbTestContext({ fixtures: [FIXTURE] })
      process.env.DATABASE_URI = ctx.connectionString
      stop = ctx.stop
    } catch (err) {
      skipped = true
      console.warn('[db test] skipping residual bucket:', (err as Error)?.message)
    }
  })

  afterAll(async () => {
    if (stop) await stop()
  })

  const svc = new PricingService()

  it('returns 0 when denom/rounding mismatch', async () => {
    if (skipped) return
    await withDatabaseConnection(process.env.DATABASE_URI!, async () =>
      db().transaction().execute(async (trx) => {
        await setRlsSession(trx, { realmId, billingUserId, billingAccountId })
        // seed a bucket with denom=5, rounding=nearest
        await trx
          .insertInto('gate_residual_buckets')
          .values({
            billing_user_id: billingUserId,
            billing_account_id: billingAccountId,
            meter_code: 'm1',
            pricing_fingerprint: 'pf1',
            denom: '5',
            rounding: 'nearest',
            remainder_numer: '2',
          })
          .execute()

        const remainder = await svc.loadResidualBucketRemainder(trx, {
          billingUserId,
          billingAccountId,
          meterCode: 'm1',
          pricingIdentity: 'pf1',
          expectedDenom: 3n,
          expectedRounding: 'floor',
        })
        expect(remainder).toBe(0n)
      }),
    )
  })

  it('upserts remainder and reloads', async () => {
    if (skipped) return
    await withDatabaseConnection(process.env.DATABASE_URI!, async () =>
      db().transaction().execute(async (trx) => {
        await setRlsSession(trx, { realmId, billingUserId, billingAccountId })

        await svc.upsertResidualBucket(trx, {
          billingUserId,
          billingAccountId,
          meterCode: 'm2',
          pricingIdentity: 'pf2',
          denom: 4n,
          rounding: 'nearest',
          remainder: 3n,
          now: new Date('2024-01-01T00:00:00Z'),
        })

        const remainder = await svc.loadResidualBucketRemainder(trx, {
          billingUserId,
          billingAccountId,
          meterCode: 'm2',
          pricingIdentity: 'pf2',
          expectedDenom: 4n,
          expectedRounding: 'nearest',
        })
        expect(remainder).toBe(3n)
      }),
    )
  })
})
