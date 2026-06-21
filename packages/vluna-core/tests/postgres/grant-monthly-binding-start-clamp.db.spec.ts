import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { db, withDatabaseConnection } from '../../src/db/index.js'
import { issueGrantForAssignment } from '../../src/services/grant-issuance.service.js'
import { prepareDbTestContext } from '../utils/db-setup.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/grant_monthly_binding_start_clamp.sql')
const realmId = 'realm-test'
const billingAccountId = '11111111-1111-1111-1111-111111111111'
const billingUserId = '22222222-2222-2222-2222-222222222222'

describe('grant monthly cadence binding_start month clamp (db)', { tags: ['db'] }, () => {
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
      console.warn('[db test] skipping grant month clamp regression:', (err as Error)?.message)
    }
  })

  afterAll(async () => {
    await seedClient?.end().catch(() => {})
    if (stop) await stop()
  })

  async function seedBaseState(bindingStart: Date): Promise<void> {
    if (!seedClient) throw new Error('seedClient unavailable')

    await seedClient.query('truncate table ledger_grants cascade')
    await seedClient.query('truncate table grant_assignments cascade')
    await seedClient.query('truncate table grant_programs cascade')
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
      [realmId, 'gp-monthly', 'Grant Monthly', 'monthly', 'binding_start', 100n, 'period', 'eager', false],
    )

    const programRes = await seedClient.query<{ program_id: string }>(
      `select program_id from grant_programs where realm_id = $1 and program_code = $2`,
      [realmId, 'gp-monthly'],
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
        bindingStart.toISOString(),
        new Date('2026-12-31T00:00:00Z').toISOString(),
        'active',
        JSON.stringify({}),
      ],
    )
  }

  it('does not overflow (Jan 31 -> Feb 28) and remains monotonic', async () => {
    if (skipped) return
    if (!seedClient) return

    const bindingStart = new Date('2025-01-31T00:00:00Z')
    await seedBaseState(bindingStart)

    const now1 = new Date('2025-02-15T00:00:00Z')
    const now2 = new Date('2025-03-15T00:00:00Z')

    await withDatabaseConnection(process.env.DATABASE_URI!, async () => {
      await db().transaction().execute(async (trx) => {
        const program = await trx
          .selectFrom('grant_programs')
          .selectAll()
          .where('realm_id', '=', realmId)
          .where('program_code', '=', 'gp-monthly')
          .executeTakeFirstOrThrow()

        const assignment = await trx
          .selectFrom('grant_assignments')
          .selectAll()
          .where('billing_account_id', '=', billingAccountId)
          .where('program_id', '=', program.program_id)
          .executeTakeFirstOrThrow()

        await issueGrantForAssignment(trx, { realmId, billingUserId, billingAccountId, program, assignment, quantity: 1, now: now1, isRealmAdmin: true })
        await issueGrantForAssignment(trx, { realmId, billingUserId, billingAccountId, program, assignment, quantity: 1, now: now2, isRealmAdmin: true })
      })
    })

    const rows = await seedClient.query<{ period_start: Date; period_end: Date }>(
      `
      select period_start, period_end
      from ledger_grants
      where billing_account_id = $1
      order by period_start asc
      `,
      [billingAccountId],
    )

    expect(rows.rows.map((r) => [r.period_start.toISOString(), r.period_end.toISOString()])).toEqual([
      ['2025-01-31T00:00:00.000Z', '2025-02-28T00:00:00.000Z'],
      ['2025-02-28T00:00:00.000Z', '2025-03-31T00:00:00.000Z'],
    ])
  })
})
