import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'
import { applyBillingImportFromFile } from '../importer/index.js'
import { RealmConfigService } from '../security/realm-config.service.js'
import { newTraceId } from '../support/trace.util.js'
import { ensureBootstrapRealm } from '../services/realm.service.js'
import {
  db as appDb,
  DEFAULT_DB_SCHEMA,
  dropAllTables,
  extractPasswordFromDatabaseUri,
  runSqlFile,
  withDatabaseConnection,
} from './index.js'
import { createMigrator } from './migrations.js'

type SetupOptions = {
  migrationDirs: string[]
}

const DEV_RESET_FLAG = process.env.VLUNA_DEV_RESET_AND_DEMO === '1'
const ENABLE_PAYMENT_BOOTSTRAP = process.env.VLUNA_ENABLE_PAYMENT_BOOTSTRAP === '1'
const IMPORT_DEMO_SEEDS = process.env.VLUNA_IMPORT_DEMO_SEEDS === '1'
const IMPORT_OPTIONAL_SEEDS = process.env.VLUNA_IMPORT_OPTIONAL_SEEDS === '1'
const BOOTSTRAP_REALM_ID = process.env.BOOTSTRAP_REALM_ID?.trim() || ''
const BOOTSTRAP_REALM_NAME = process.env.BOOTSTRAP_REALM_NAME?.trim() || ''
const isProd = process.env.NODE_ENV?.toLowerCase() === 'production'

const isPgTrue = (value: boolean | 't' | 'f' | null | undefined): boolean =>
  value === 't' || String(value) === 'true'

const scriptDir = path.dirname(fileURLToPath(new URL(import.meta.url)))
const packageRoot = path.resolve(scriptDir, '../..')
const grantUserPath = path.resolve(packageRoot, 'migrations/base/sql/grant_user.sql')

const findDataFiles = async (migrationDirs: string[]): Promise<string[]> => {
  const files: string[] = []
  const groups = ['bootstrap', ...(IMPORT_DEMO_SEEDS ? ['demo'] : []), ...(IMPORT_OPTIONAL_SEEDS ? ['optional'] : [])]
  for (const dir of migrationDirs) {
    for (const group of groups) {
      const dataDir = path.resolve(dir, 'data', group)
      try {
        const entries = await fs.readdir(dataDir)
        for (const entry of entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
          if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
            files.push(path.join(dataDir, entry))
          }
        }
      } catch {
        // grouped data directory optional
      }
    }
  }
  return files
}

async function listPendingMigrations(migrationDirs: string[]) {
  const migrator = createMigrator(appDb(), migrationDirs)
  const migrationInfos = await migrator.getMigrations()
  const available = migrationInfos.map((m) => m.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const escapedSchema = DEFAULT_DB_SCHEMA.replace(/"/g, '""')
  const migrationTableRegclass = `"${escapedSchema}"."kysely_migration"`

  const reg = await sql`select to_regclass(${migrationTableRegclass}) as reg`.execute(appDb())
  const regRow = reg.rows?.[0] as { reg?: string | null } | undefined
  const hasTable = Boolean(regRow?.reg)
  if (!hasTable) return available

  const executedRes = await sql.raw(`select name from "${escapedSchema}"."kysely_migration"`).execute(appDb())
  const executedRows = (executedRes.rows ?? []) as { name: string }[]
  const executed = new Set<string>(executedRows.map((r) => r.name))
  return available.filter((name) => !executed.has(name))
}

async function ensureAppRoleExistsWithMigrator(migratorUri: string, appUri: string) {
  const appUrl = new URL(appUri)
  const role = decodeURIComponent(appUrl.username || '')
  const password = extractPasswordFromDatabaseUri(appUri)
  if (!role || !password) {
    throw new Error('[db] DATABASE_URI must include username and password to (re)create app role')
  }

  await withDatabaseConnection(migratorUri, async () => {
    const roleRes = await sql`select 1 from pg_roles where rolname = ${role}`.execute(appDb())
    // Always refresh grants to ensure new tables/sequences are accessible to the runtime role.
    await runSqlFile(grantUserPath, {
      settings: {
        'app.vluna_password': password,
        'app.vluna_role': role,
        'app.vluna_schema': DEFAULT_DB_SCHEMA,
      },
    })
    console.log(
      roleRes.rows?.length
        ? `[db] refreshed app role grants for ${role} via grant_user.sql`
        : `[db] created app role ${role} via grant_user.sql`,
    )

    const priv = await sql`select rolsuper, rolbypassrls from pg_roles where rolname = ${role}`.execute(appDb())
    const row = priv.rows?.[0] as { rolsuper?: boolean | 't' | 'f'; rolbypassrls?: boolean | 't' | 'f' } | undefined
    const isSuper = isPgTrue(row?.rolsuper)
    const bypass = isPgTrue(row?.rolbypassrls)
    if (isSuper || bypass) {
      throw new Error(
        `[db] DATABASE_URI role "${role}" has superuser/bypassrls privileges; use a least-privilege runtime role (not owner, not bypassrls)`,
      )
    }
  })
}

async function assertRuntimeRoleNotPrivileged(appUri: string) {
  const role = decodeURIComponent(new URL(appUri).username || '')
  if (!role) return
  const res = await sql`select rolsuper, rolbypassrls from pg_roles where rolname = ${role}`.execute(appDb())
  const row = res.rows?.[0] as { rolsuper?: boolean | 't' | 'f'; rolbypassrls?: boolean | 't' | 'f' } | undefined
  const isSuper = isPgTrue(row?.rolsuper)
  const bypass = isPgTrue(row?.rolbypassrls)
  if (isSuper || bypass) {
    throw new Error(
      `[db] DATABASE_URI role "${role}" has superuser/bypassrls privileges; use a least-privilege runtime role (not owner, not bypassrls)`,
    )
  }
}

async function ensureBootstrapRealmIfConfigured(): Promise<void> {
  if (!BOOTSTRAP_REALM_ID) return

  const bootstrap = await appDb().transaction().execute((trx) =>
    ensureBootstrapRealm(trx, {
      realmId: BOOTSTRAP_REALM_ID,
      name: BOOTSTRAP_REALM_NAME || BOOTSTRAP_REALM_ID,
      status: 'active',
    }),
  )
  console.log(
    JSON.stringify({
      at: 'bootstrap.realm.ready',
      realm_id: bootstrap.realmId,
      realm_name: bootstrap.realmName,
      service_key_id: bootstrap.serviceKey.keyId,
      service_key_secret_base64: bootstrap.serviceKey.secretBase64,
      service_key_env_tag: bootstrap.serviceKey.envTag,
    }),
  )
}

export async function setupDatabaseWithGuards(opts: SetupOptions) {
  if (!opts.migrationDirs || opts.migrationDirs.length === 0) {
    throw new Error('[db] migrationDirs are required')
  }

  const migratorUri = process.env.DATABASE_MIGRATOR_URI?.trim()
  const appUri = process.env.DATABASE_URI?.trim()

  if (!appUri) {
    throw new Error('[db] DATABASE_URI is required for runtime')
  }

  if (!migratorUri) {
    const pending = await listPendingMigrations(opts.migrationDirs)
    if (pending.length > 0) {
      throw new Error(
        `[db] Pending migrations detected (${pending.join(', ')}). Provide DATABASE_MIGRATOR_URI or pre-run migrations before start.`,
      )
    }
    console.warn('[db] DATABASE_MIGRATOR_URI not provided; migrations/seeds skipped (none pending).')
    await assertRuntimeRoleNotPrivileged(appUri)
    await ensureBootstrapRealmIfConfigured()
  } else {
    if (false && isProd && DEV_RESET_FLAG) {
      throw new Error('[db] drop-all/dev-reset is blocked in production')
    }

    await withDatabaseConnection(migratorUri, async () => {
      if (DEV_RESET_FLAG) {
        console.warn('[db] DEV_RESET flag enabled: dropping all tables')
        await dropAllTables()
      }
      console.log(`[migration] ${opts.migrationDirs}`)

      const migrateResult = await createMigrator(appDb(), opts.migrationDirs).migrateToLatest()
      migrateResult.results?.forEach((r) => console.log(`[migrate] ${r.status?.padEnd(9)} ${r.migrationName}`))
      if (migrateResult.error) {
        throw migrateResult.error
      }

      await ensureBootstrapRealmIfConfigured()

      const dataFiles = await findDataFiles(opts.migrationDirs)
      for (const file of dataFiles) {
        await applyBillingImportFromFile(file, { mode: 'merge', strict: true })
        console.log(`[importer] applied ${path.basename(file)}`)
      }
    })

    await ensureAppRoleExistsWithMigrator(migratorUri, appUri)
  }

  if (!ENABLE_PAYMENT_BOOTSTRAP) {
    console.log('[payment-bootstrap] disabled during startup (set VLUNA_ENABLE_PAYMENT_BOOTSTRAP=1 to enable)')
    return
  }

  // Bootstrap payment providers (products/prices, webhooks) for all realms only when explicitly enabled.
  const realmConfig = new RealmConfigService()
  const realms = await appDb().selectFrom('realms').select('realm_id').execute()
  for (const { realm_id: realmId } of realms) {
    try {
      const provider = await realmConfig.getPaymentProvider(realmId)
      await provider.bootstrap?.({
        realmId,
        db: appDb(),
        traceId: newTraceId(),
      })
    } catch (err) {
      console.warn('[payment-bootstrap] skipped realm', realmId, (err as Error)?.message)
    }
  }
}
