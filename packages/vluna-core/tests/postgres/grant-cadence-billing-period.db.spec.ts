import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { db, withDatabaseConnection } from '../../src/db/index.js'
import { issueGrantForAssignment } from '../../src/services/grant-issuance.service.js'
import { prepareDbTestContext } from '../utils/db-setup.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/grant_cadence_billing_period.sql')
const realmId = 'realm-test'
const billingAccountId = '11111111-1111-1111-1111-111111111111'
const billingUserId = '22222222-2222-2222-2222-222222222222'

describe('grant cadence=billing_period issuance (db)', { tags: ['db'] }, () => {
  let stop: () => Promise<void>
  let skipped = false
  let seedClient: Client | null = null
  let superConn: string | undefined

  beforeAll(async () => {
    try {
      const ctx = await prepareDbTestContext({ fixtures: [FIXTURE] })
      process.env.DATABASE_URI = ctx.connectionString
      stop = ctx.stop
      superConn = ctx.superuserConnectionString
      seedClient = new Client({ connectionString: superConn })
      await seedClient.connect()
    } catch (err) {
      skipped = true
      console.warn('[db test] skipping grant cadence=billing_period issuance:', (err as Error)?.message)
    }
  })

  afterAll(async () => {
    await seedClient?.end().catch(() => {})
    if (stop) await stop()
  })

  async function seedBaseState(now: Date): Promise<void> {
    if (!seedClient) throw new Error('seedClient unavailable')

    await seedClient.query('truncate table ledger_grants cascade')
    await seedClient.query('truncate table grant_assignments cascade')
    await seedClient.query('truncate table grant_programs cascade')
    await seedClient.query('truncate table billing_periods cascade')
    await seedClient.query('truncate table subscriptions cascade')
    await seedClient.query('truncate table billing_plan_assignments cascade')
    await seedClient.query('truncate table billing_plans cascade')
    await seedClient.query('truncate table billing_accounts cascade')
    await seedClient.query('truncate table realms cascade')

    await seedClient.query(`insert into realms (realm_id, name, metadata) values ($1, $2, $3::jsonb)`, [
      realmId,
      'Realm Test',
      JSON.stringify({}),
    ])
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
        window_kind, issuance_mode, on_ledger
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [realmId, 'gp-period', 'Grant Period', 'billing_period', 'binding_start', 100n, 'period', 'eager', false],
    )

    const programRes = await seedClient.query<{ program_id: string }>(
      `select program_id from grant_programs where realm_id = $1 and program_code = $2`,
      [realmId, 'gp-period'],
    )
    const programId = programRes.rows[0].program_id

    await seedClient.query(
      `
      insert into grant_assignments (
        billing_user_id, billing_account_id, program_id, source_kind, source_ref, window_start, window_end, status, metadata
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      `,
      [
        billingUserId,
        billingAccountId,
        programId,
        'ops.manual',
        'seed:1',
        now.toISOString(),
        null,
        'active',
        JSON.stringify({}),
      ],
    )
  }

  it('issues a grant whose period/window match the resolved billing period', async () => {
    if (skipped) return
    if (!seedClient) return

    const now = new Date('2025-01-15T12:00:00Z')
    await seedBaseState(now)

    await withDatabaseConnection(process.env.DATABASE_URI!, async () => {
      await db().transaction().execute(async (trx) => {
        const program = await trx
          .selectFrom('grant_programs')
          .selectAll()
          .where('realm_id', '=', realmId)
          .where('program_code', '=', 'gp-period')
          .executeTakeFirstOrThrow()

        const assignment = await trx
          .selectFrom('grant_assignments')
          .selectAll()
          .where('billing_account_id', '=', billingAccountId)
          .where('program_id', '=', program.program_id)
          .executeTakeFirstOrThrow()

        await issueGrantForAssignment(trx, {
          realmId,
          billingUserId,
          billingAccountId,
          program,
          assignment,
          quantity: 1,
          now,
          isRealmAdmin: true,
        })
      })
    })

    const grants = await seedClient.query<{ period_start: Date; period_end: Date; window_start: Date; window_end: Date | null }>(
      `
      select period_start, period_end, window_start, window_end
      from ledger_grants
      where billing_account_id = $1
      order by grant_id desc
      limit 1
      `,
      [billingAccountId],
    )
    expect(grants.rows.length).toBe(1)
    expect(grants.rows[0].period_start.toISOString()).toBe('2025-01-01T00:00:00.000Z')
    expect(grants.rows[0].period_end.toISOString()).toBe('2025-02-01T00:00:00.000Z')
    expect(grants.rows[0].window_start.toISOString()).toBe('2025-01-01T00:00:00.000Z')
    expect(grants.rows[0].window_end?.toISOString()).toBe('2025-02-01T00:00:00.000Z')

    const periods = await seedClient.query<{ period_start: Date; period_end: Date }>(
      `
      select period_start, period_end
      from billing_periods
      where billing_account_id = $1
      `,
      [billingAccountId],
    )
    expect(periods.rows.length).toBe(1)
    expect(periods.rows[0].period_start.toISOString()).toBe('2025-01-01T00:00:00.000Z')
    expect(periods.rows[0].period_end.toISOString()).toBe('2025-02-01T00:00:00.000Z')
  })

  it('rejects non-period window kinds for cadence=billing_period', async () => {
    if (skipped) return

    const now = new Date('2025-01-15T12:00:00Z')
    await seedBaseState(now)

    await expect(async () => {
      await withDatabaseConnection(process.env.DATABASE_URI!, async () => {
        await db().transaction().execute(async (trx) => {
          const program = await trx
            .selectFrom('grant_programs')
            .selectAll()
            .where('realm_id', '=', realmId)
            .where('program_code', '=', 'gp-period')
            .executeTakeFirstOrThrow()

          const assignment = await trx
            .selectFrom('grant_assignments')
            .selectAll()
            .where('billing_account_id', '=', billingAccountId)
            .where('program_id', '=', program.program_id)
            .executeTakeFirstOrThrow()

          await issueGrantForAssignment(trx, {
            realmId,
            billingUserId,
            billingAccountId,
            program,
            assignment,
            quantity: 1,
            now,
            isRealmAdmin: true,
            override: {
              programCode: 'gp-period',
              windowKindOverride: 'forever',
            },
          })
        })
      })
    }).rejects.toThrow(/cadence=billing_period requires window_kind=period/)
  })

  it('treats repeated open-ended once issuance as idempotent', async () => {
    if (skipped) return
    if (!seedClient) return

    const now = new Date('2025-01-15T12:00:00Z')
    await seedBaseState(now)

    await seedClient.query(
      `
      update grant_programs
      set cadence = 'once', window_kind = 'fixed', issue_anchor = 'binding_start', amount_xusd = $1, on_ledger = false
      where realm_id = $2 and program_code = $3
      `,
      [250n, realmId, 'gp-period'],
    )

    await withDatabaseConnection(process.env.DATABASE_URI!, async () => {
      await db().transaction().execute(async (trx) => {
        const program = await trx
          .selectFrom('grant_programs')
          .selectAll()
          .where('realm_id', '=', realmId)
          .where('program_code', '=', 'gp-period')
          .executeTakeFirstOrThrow()

        const assignment = await trx
          .selectFrom('grant_assignments')
          .selectAll()
          .where('billing_account_id', '=', billingAccountId)
          .where('program_id', '=', program.program_id)
          .executeTakeFirstOrThrow()

        await issueGrantForAssignment(trx, {
          realmId,
          billingUserId,
          billingAccountId,
          program,
          assignment,
          quantity: 1,
          now,
          isRealmAdmin: true,
        })

        await issueGrantForAssignment(trx, {
          realmId,
          billingUserId,
          billingAccountId,
          program,
          assignment,
          quantity: 1,
          now,
          isRealmAdmin: true,
        })
      })
    })

    const grants = await seedClient.query<{ cnt: string; amount_xusd: string; period_end: Date | null }>(
      `
      select count(*)::text as cnt, min(amount_xusd)::text as amount_xusd, min(period_end) as period_end
      from ledger_grants
      where billing_account_id = $1
      `,
      [billingAccountId],
    )
    expect(Number(grants.rows[0].cnt)).toBe(1)
    expect(grants.rows[0].amount_xusd).toBe('250')
    expect(grants.rows[0].period_end).toBeNull()
  })
})
