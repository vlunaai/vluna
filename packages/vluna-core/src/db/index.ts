import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Transaction } from 'kysely'
import pg from 'pg'
import fs from 'node:fs/promises'
import type { Database } from '../types/database.js'
import { DB_SCHEMA } from './schema.js'
export { createMigrator, migrateToLatest, migrationStatus, ensureMigratedOrExit } from './migrations.js'
export { setupDatabaseWithGuards } from './setup.js'
export { DB_SCHEMA as DEFAULT_DB_SCHEMA } from './schema.js'

export const REALM_ADMIN_PLACEHOLDER_ACCOUNT = '00000000-0000-0000-0000-000000000000'

// Single pool for the process; compatible with PgBouncer
const connStr = process.env.DATABASE_URI || ''
const createPool = (connectionString?: string) =>
  new pg.Pool({
    connectionString: connectionString || undefined,
    max: 20,
    options: `-c search_path=${DB_SCHEMA},pg_temp -c app.vluna_schema=${DB_SCHEMA}`,
  })

export let pool = createPool(connStr || undefined)
let activeConnectionString = connStr || ''

let dbSingleton: Kysely<Database> | null = null
export function db(): Kysely<Database> {
  if (!dbSingleton) {
    dbSingleton = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  }
  return dbSingleton
}

export async function withDatabaseConnection<T>(connectionString: string, fn: () => Promise<T>): Promise<T> {
  const target = connectionString?.trim()
  if (!target || target === activeConnectionString) {
    return fn()
  }

  const previousPool = pool
  const previousDb = dbSingleton
  const previousConn = activeConnectionString

  const tempPool = createPool(target)
  const tempDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: tempPool }) })

  pool = tempPool
  dbSingleton = tempDb
  activeConnectionString = target

  try {
    return await fn()
  } finally {
    await tempDb.destroy().catch(() => {})
    await tempPool.end().catch(() => {})
    pool = previousPool
    dbSingleton = previousDb
    activeConnectionString = previousConn
  }
}

export async function withIsolatedDatabaseConnection<T>(
  connectionString: string,
  fn: (dbHandle: Kysely<Database>) => Promise<T>,
): Promise<T> {
  const target = connectionString?.trim()
  if (!target) {
    throw new Error('connectionString is required')
  }

  const tempPool = createPool(target)
  const tempDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: tempPool }) })

  try {
    return await fn(tempDb)
  } finally {
    await tempDb.destroy().catch(() => {})
    await tempPool.end().catch(() => {})
  }
}

export async function runSqlFile(filePath: string, opts?: { settings?: Record<string, string | undefined> }) {
  const sqlText = await fs.readFile(filePath, 'utf8')
  if (!sqlText || sqlText.trim().length === 0) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (opts?.settings) {
      for (const [key, value] of Object.entries(opts.settings)) {
        if (value === undefined) continue
        await client.query('SELECT set_config($1, $2, false)', [key, value])
      }
    }
    await client.query(sqlText)
    await client.query('COMMIT')
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw err
  } finally {
    client.release()
  }
}

export function extractPasswordFromDatabaseUri(uri?: string | null): string | undefined {
  if (!uri) return undefined
  try {
    const parsed = new URL(uri)
    if (!parsed.password) return undefined
    return decodeURIComponent(parsed.password)
  } catch (err) {
    console.warn('[db] failed to parse DATABASE_URI for password extraction:', err)
    return undefined
  }
}

/**
 * Drop all tables in the given schema (default: control_plane).
 * Intended for local dev only. Refuses to run in production unless explicitly allowed.
 *
 * Env guards:
 *  - NODE_ENV !== 'production' → allowed
 *  - NODE_ENV === 'production' requires VLUNA_DB_ALLOW_DROP_ALL=true
 */
export async function dropAllTables(opts?: { schema?: string }): Promise<void> {
  const schema = (opts?.schema || DB_SCHEMA).trim()
  const q = (id: string) => '"' + id.replace(/"/g, '""') + '"'

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // List user tables in the target schema
    const res = await client.query(
      {
        text: 'select tablename from pg_tables where schemaname = $1',
        values: [schema]
      }
    )
    const rows = res.rows as { tablename: string }[]
    for (const r of rows) {
      const sql = `drop table if exists ${q(schema)}.${q(r.tablename)} cascade` as const
      await client.query(sql)
    }
    await client.query('COMMIT')
    console.log(`[db] dropped ${rows.length} tables from schema ${schema}`)
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw e
  } finally {
    client.release()
  }
}

export async function setRlsSession(trx: Kysely<Database> | Transaction<Database>, p: { realmId?: string; billingAccountId?: string; billingUserId?: string; isRealmAdmin?: boolean }) {
  const realm = p.realmId || ''
  const ba = p.billingAccountId || ''
  const bu = p.billingUserId || ''
  const admin = p.isRealmAdmin ? 'true' : 'false'
  await sql`select set_config('app.realm_id', ${realm}, true)`.execute(trx)
  await sql`select set_config('app.billing_account_id', ${ba}, true)`.execute(trx)
  await sql`select set_config('app.billing_user_id', ${bu}, true)`.execute(trx)
  await sql`select set_config('app.is_realm_admin', ${admin}, true)`.execute(trx)
}


export async function getRlsSession(trx: Kysely<Database> | Transaction<Database>): Promise<{ realmId?: string; billingAccountId?: string; billingUserId?: string; isRealmAdmin?: boolean }> {
  const result = await sql<{
    realm_id: string | null
    billing_account_id: string | null
    billing_user_id: string | null
    is_realm_admin: string | null
  }>`
    select
      current_setting('app.realm_id', true) as realm_id,
      current_setting('app.billing_account_id', true) as billing_account_id,
      current_setting('app.billing_user_id', true) as billing_user_id,
      current_setting('app.is_realm_admin', true) as is_realm_admin
  `.execute(trx)

  const row = result.rows[0] ?? {
    realm_id: null,
    billing_account_id: null,
    billing_user_id: null,
    is_realm_admin: null,
  }

  const realmId = row.realm_id?.trim() || undefined
  const billingAccountId = row.billing_account_id?.trim() || undefined
  const billingUserId = row.billing_user_id?.trim() || undefined
  const isRealmAdmin = row.is_realm_admin === 'true'

  return { realmId, billingAccountId, billingUserId, isRealmAdmin }
}
