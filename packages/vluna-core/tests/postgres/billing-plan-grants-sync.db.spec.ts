import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { db, withDatabaseConnection } from '../../src/db/index.js'
import { ensureBillingPlanGrantsEnrollmentSynced } from '../../src/services/billing-plan.service.js'
import { prepareDbTestContext } from '../utils/db-setup.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/billing_plan_grants_sync.sql')
const realmId = 'realm-test'
const billingAccountId = '11111111-1111-1111-1111-111111111111'
const billingUserId = '22222222-2222-2222-2222-222222222222'

describe('billing plan grants reconcile (db)', { tags: ['db'] }, () => {
  let stop: () => Promise<void>
  let skipped = false
  let seedClient: Client | null = null
  let appClient: Client | null = null
  let superConn: string | undefined

  function jsonObject(value: unknown): Record<string, unknown> {
    if (!value) return {}
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
      } catch {
        return {}
      }
    }
    if (Buffer.isBuffer(value)) {
      return jsonObject(value.toString('utf8'))
    }
    return typeof value === 'object' ? (value as Record<string, unknown>) : {}
  }

  async function seedBaseState(params: {
    now: Date
    billingPlanGrants: unknown
  }): Promise<{ billingPlanId: string; planAssignmentId: string }> {
    if (!seedClient) {
      throw new Error('seedClient unavailable')
    }
    if (!appClient) {
      throw new Error('appClient unavailable')
    }

    await seedClient.query(`truncate table grant_assignments cascade`)
    await seedClient.query(`truncate table billing_plan_assignments cascade`)
    await seedClient.query(`truncate table billing_plans cascade`)
    await seedClient.query(`truncate table grant_programs cascade`)
    await seedClient.query(`truncate table billing_users cascade`)
    await seedClient.query(`truncate table billing_accounts cascade`)
    await seedClient.query(`truncate table realms cascade`)

    await seedClient.query(`insert into realms (realm_id, name) values ($1, $2)`, [realmId, 'Realm Test'])
    await seedClient.query(
      `insert into billing_accounts (billing_account_id, realm_id, billing_principal_id) values ($1, $2, $3)`,
      [billingAccountId, realmId, 'principal-1'],
    )
    await seedClient.query(
      `insert into billing_users (billing_user_id, realm_id, billing_account_id, business_user_id) values ($1, $2, $3, $4)`,
      [billingUserId, realmId, billingAccountId, 'user-1'],
    )

    await seedClient.query(
      `
      insert into grant_programs (
        realm_id, program_code, name,
        cadence, issue_anchor, amount_xusd,
        window_kind, issuance_mode
      ) values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [realmId, 'gp-one', 'Grant Profile One', 'once', 'binding_start', 100n, 'forever', 'eager'],
    )

    const bpRes = await seedClient.query<{ plan_id: string }>(
      `
      insert into billing_plans (realm_id, plan_code, name, kind, priority, active, metadata)
      values ($1, $2, $3, $4, $5, $6, $7)
      returning plan_id
      `,
      [
        realmId,
        'default_billing_plan',
        'Default Billing Plan',
        'base',
        0,
        true,
        JSON.stringify({ grants: params.billingPlanGrants }),
      ],
    )
    const billingPlanId = bpRes.rows[0].plan_id

    // Insert via the app role so the trigger behavior matches runtime (some environments
    // can run superuser sessions with triggers suppressed).
    const bpaRes = await appClient.query<{ assignment_id: string }>(
      `
      insert into billing_plan_assignments (
        billing_account_id, billing_user_id, plan_id, source_kind, source_ref, window_start, window_end, status, metadata
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      returning assignment_id
      `,
      [
        billingAccountId,
        billingUserId,
        billingPlanId,
        'signup.default',
        'signup:1',
        params.now.toISOString(),
        null,
        'active',
        JSON.stringify({}),
      ],
    )
    const planAssignmentId = bpaRes.rows[0].assignment_id

    return { billingPlanId, planAssignmentId }
  }

  beforeAll(async () => {
    try {
      const ctx = await prepareDbTestContext({ fixtures: [FIXTURE] })
      process.env.DATABASE_URI = ctx.connectionString
      stop = ctx.stop
      superConn = ctx.superuserConnectionString
      seedClient = new Client({ connectionString: superConn })
      await seedClient.connect()
      appClient = new Client({ connectionString: ctx.connectionString })
      await appClient.connect()
    } catch (err) {
      skipped = true
      console.warn('[db test] skipping billing profile grants reconcile:', (err as Error)?.message)
    }
  })

  afterAll(async () => {
    await seedClient?.end().catch(() => {})
    await appClient?.end().catch(() => {})
    if (stop) await stop()
  })

  it('creates profile-derived gpb, clears dirty, and is idempotent', async () => {
    if (skipped) return
    if (!seedClient) return
    if (!appClient) return

    const now = new Date('2025-01-01T00:00:00Z')
    const { planAssignmentId } = await seedBaseState({
      now,
      billingPlanGrants: [{ template_key: 'test.gp-one', grant_program_code: 'gp-one', effect: 'allow' }],
    })

    const dirtyRes = await seedClient.query<{ metadata: unknown }>(
      `select metadata from billing_users where billing_user_id = $1`,
      [billingUserId],
    )
    const dirtyMeta = jsonObject(dirtyRes.rows[0].metadata)
    const dirtySwitch = jsonObject(dirtyMeta.grants_switch)
    expect(dirtySwitch.dirty).toBe(true)
    expect(dirtySwitch.dirty_at).toBeTruthy()

    await withDatabaseConnection(process.env.DATABASE_URI!, async () => {
      await ensureBillingPlanGrantsEnrollmentSynced(db(), billingAccountId, now)
    })

    const gpaRows1 = await appClient.query<{
      source_ref: string
      status: string
      billing_plan_assignment_id: string | null
    }>(
      `
      select source_ref, status, billing_plan_assignment_id
      from grant_assignments
      where billing_account_id = $1 and source_kind = 'billing_plan_assignment'
        and billing_user_id = $2
      order by assignment_id
      `,
      [billingAccountId, billingUserId],
    )
    expect(gpaRows1.rows.length).toBe(1)
    expect(gpaRows1.rows[0].source_ref).toBe(`bpa:${planAssignmentId}:tpl:key:test.gp-one`)
    expect(gpaRows1.rows[0].status).toBe('active')
    expect(gpaRows1.rows[0].billing_plan_assignment_id).toBe(String(planAssignmentId))

    await withDatabaseConnection(process.env.DATABASE_URI!, async () => {
      await ensureBillingPlanGrantsEnrollmentSynced(db(), billingAccountId, now)
    })

    const gpbRows2 = await appClient.query<{ cnt: string }>(
      `
      select count(*)::text as cnt
      from grant_assignments
      where billing_account_id = $1 and billing_user_id = $2 and source_kind = 'billing_plan_assignment'
      `,
      [billingAccountId, billingUserId],
    )
    expect(Number(gpbRows2.rows[0].cnt)).toBe(1)

    const appliedRes = await appClient.query<{ metadata: unknown }>(
      `select metadata from billing_users where billing_user_id = $1`,
      [billingUserId],
    )
    const appliedMeta = jsonObject(appliedRes.rows[0].metadata)
    const grantsSwitch = jsonObject(appliedMeta.grants_switch)
    expect(grantsSwitch?.dirty).toBe(false)
    expect(typeof grantsSwitch?.applied_fingerprint).toBe('string')
    expect((grantsSwitch?.applied_fingerprint as string).length).toBeGreaterThan(10)
    expect(grantsSwitch?.dirty_at).toBeTruthy()
  })

  it('cancels obsolete profile-derived gpb when grants template changes', async () => {
    if (skipped) return
    if (!seedClient) return
    if (!appClient) return

    const now1 = new Date('2025-01-01T00:00:00Z')
    const now2 = new Date('2025-01-02T00:00:00Z')

    const { billingPlanId } = await seedBaseState({
      now: now1,
      billingPlanGrants: [{ template_key: 'test.gp-one', grant_program_code: 'gp-one', effect: 'allow' }],
    })

    await withDatabaseConnection(process.env.DATABASE_URI!, async () => {
      await ensureBillingPlanGrantsEnrollmentSynced(db(), billingAccountId, now1)
    })

    await seedClient.query(
      `
      update billing_plans
      set metadata = $1::jsonb
      where plan_id = $2
      `,
      [JSON.stringify({ grants: [] }), billingPlanId],
    )

    await withDatabaseConnection(process.env.DATABASE_URI!, async () => {
      await ensureBillingPlanGrantsEnrollmentSynced(db(), billingAccountId, now2)
    })

    const canceled = await appClient.query<{
      status: string
      window_end: string | Date | null
    }>(
      `
      select status, window_end
      from grant_assignments
      where billing_account_id = $1 and billing_user_id = $2 and source_kind = 'billing_plan_assignment'
      `,
      [billingAccountId, billingUserId],
    )

    expect(canceled.rows.length).toBe(1)
    expect(canceled.rows[0].status).toBe('canceled')
    const windowEnd = canceled.rows[0].window_end
    const normalized = windowEnd instanceof Date ? windowEnd.toISOString() : windowEnd
    expect(normalized).toBe(now2.toISOString())
  })
})
