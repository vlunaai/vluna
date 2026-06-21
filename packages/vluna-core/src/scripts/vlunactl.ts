import 'reflect-metadata'
import 'dotenv/config'
import { db, pool, withDatabaseConnection } from '../db/index.js'
import { createRealm, createRealmId } from '../services/realm.service.js'
import { ServiceApiKeyService } from '../security/service-api-key.service.js'
import { ServiceApiKeyManagementService } from '../security/service-api-key-management.service.js'
import type { Database } from '../types/database.js'
import type { Kysely, Transaction } from 'kysely'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { NestFactory } from '@nestjs/core'
import { SchedulerModule } from '../modules/scheduler.module.js'
import { PERIODIC_TASKS_ALL, type PeriodicTaskDefinition } from '../scheduler/periodic-task.types.js'
import { parseRuntimeArgsFromArgv } from '../platform/runtime-args.js'
import { scanAndUpsertReconciliations } from '../features/billing/services/reconciliations.service.js'
import { AuditWriter } from '../support/audit/audit.writer.js'
import { redactAuditValue } from '../support/audit/audit.redaction.js'

type CommandContext = {
  argv: string[]
  invocationId: string
}

type Command = {
  name: string
  summary: string
  requiresMigrator?: boolean
  run: (ctx: CommandContext) => Promise<void>
}

type ParsedArgs = {
  _: string[]
  flags: Record<string, string | boolean>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq > 2) {
      const key = token.slice(2, eq)
      const value = token.slice(eq + 1)
      flags[key] = value
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      i += 1
      continue
    }
    flags[key] = true
  }
  return { _: positional, flags }
}

function getStringFlag(args: ParsedArgs, name: string): string | undefined {
  const raw = args.flags[name]
  if (raw === undefined || raw === false) return undefined
  if (raw === true) return ''
  return String(raw)
}

function requireStringFlag(args: ParsedArgs, name: string): string {
  const value = getStringFlag(args, name)
  if (!value) {
    throw new Error(`Missing required flag --${name}`)
  }
  return value
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

function parseMetadataJson(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input)
    if (!isRecord(parsed)) {
      throw new Error('metadata must be a JSON object')
    }
    validateRealmMetadata(parsed)
    return parsed
  } catch (err) {
    const message = (err as Error).message || String(err)
    throw new Error(`Invalid --metadata-json: ${message}`)
  }
}

function parseTimestampFlag(value: string, name: string): Date {
  const raw = value.trim()
  if (!raw) {
    throw new Error(`Invalid --${name}: value is required`)
  }
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid --${name}: expected ISO timestamp`)
  }
  return parsed
}

function parseCsvFlag(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function validateRealmMetadata(metadata: Record<string, unknown>): void {
  if (metadata.auth !== undefined) {
    validateAuthMetadata(metadata.auth)
  }
  const payments = metadata.payments
  if (payments !== undefined) {
    if (!isRecord(payments)) {
      throw new Error('metadata.payments must be an object when provided')
    }
    if (payments.stripe !== undefined) {
      validateStripeMetadata(payments.stripe)
    }
  }
  const currencies = metadata.currencies
  if (currencies !== undefined) {
    if (!Array.isArray(currencies)) {
      throw new Error('metadata.currencies must be an array when provided')
    }
    for (const [index, entry] of currencies.entries()) {
      if (!isRecord(entry)) {
        throw new Error(`metadata.currencies[${index}] must be an object`)
      }
      const currency = typeof entry.currency === 'string' ? entry.currency.trim() : ''
      if (!currency) {
        throw new Error(`metadata.currencies[${index}].currency must be a non-empty string`)
      }
      const rateRaw = entry.xusd_rate ?? entry.xusdRate
      const rate = typeof rateRaw === 'number' ? rateRaw : Number(rateRaw)
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`metadata.currencies[${index}].xusd_rate must be a positive number`)
      }
    }
  }
}

function validateAuthMetadata(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error('metadata.auth must be an object')
  }
  const issuers = value.issuers
  if (!Array.isArray(issuers) || issuers.length === 0) {
    throw new Error('metadata.auth.issuers must be a non-empty array')
  }
  for (const [index, entry] of issuers.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`metadata.auth.issuers[${index}] must be an object`)
    }
    const issuer = typeof entry.issuer === 'string' ? entry.issuer.trim() : ''
    if (!issuer) {
      throw new Error(`metadata.auth.issuers[${index}].issuer must be a non-empty string`)
    }
    const audiences = entry.audiences
    if (!Array.isArray(audiences) || audiences.length === 0) {
      throw new Error(`metadata.auth.issuers[${index}].audiences must be a non-empty array`)
    }
    for (const [audIndex, aud] of audiences.entries()) {
      const value = typeof aud === 'string' ? aud.trim() : ''
      if (!value) {
        throw new Error(`metadata.auth.issuers[${index}].audiences[${audIndex}] must be a non-empty string`)
      }
    }
    if (entry.jwks_uri !== undefined && typeof entry.jwks_uri !== 'string') {
      throw new Error(`metadata.auth.issuers[${index}].jwks_uri must be a string when provided`)
    }
  }

  // scope_claim is optional; default is "scope" in TokenClaimsGuard.
  // metadata.auth.clients / issuer_root / webhook are provider-specific and not required for token verification.
}

function validateStripeMetadata(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error('metadata.payments.stripe must be an object')
  }
  const modeRaw = value.mode ?? value.env
  if (modeRaw !== undefined) {
    const mode = typeof modeRaw === 'string' ? modeRaw.trim().toLowerCase() : ''
    if (!mode || (mode !== 'test' && mode !== 'live')) {
      throw new Error('metadata.payments.stripe.mode must be "test" or "live" when provided')
    }
  }

  const apiKey = value.api_key ?? value.apiKey
  const apiKeys = value.api_keys ?? value.apiKeys
  const testKey = value.test_api_key
  const liveKey = value.live_api_key
  let hasKey = false
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new Error('metadata.payments.stripe.api_key must be a non-empty string when provided')
    }
    hasKey = true
  }
  if (testKey !== undefined) {
    if (typeof testKey !== 'string' || !testKey.trim()) {
      throw new Error('metadata.payments.stripe.test_api_key must be a non-empty string when provided')
    }
    hasKey = true
  }
  if (liveKey !== undefined) {
    if (typeof liveKey !== 'string' || !liveKey.trim()) {
      throw new Error('metadata.payments.stripe.live_api_key must be a non-empty string when provided')
    }
    hasKey = true
  }
  if (apiKeys !== undefined) {
    if (!isRecord(apiKeys)) {
      throw new Error('metadata.payments.stripe.api_keys must be an object when provided')
    }
    const test = apiKeys.test
    const live = apiKeys.live
    if (test !== undefined) {
      if (typeof test !== 'string' || !test.trim()) {
        throw new Error('metadata.payments.stripe.api_keys.test must be a non-empty string when provided')
      }
      hasKey = true
    }
    if (live !== undefined) {
      if (typeof live !== 'string' || !live.trim()) {
        throw new Error('metadata.payments.stripe.api_keys.live must be a non-empty string when provided')
      }
      hasKey = true
    }
  }
  if (!hasKey) {
    throw new Error('metadata.payments.stripe must include an API key (api_key, api_keys.test, or api_keys.live)')
  }

  const publicWebhookBaseUrl = value.public_webhook_base_url ?? value.publicWebhookBaseUrl
  if (publicWebhookBaseUrl !== undefined && typeof publicWebhookBaseUrl !== 'string') {
    throw new Error('metadata.payments.stripe.public_webhook_base_url must be a string when provided')
  }

  const webhooks = value.webhooks
  if (webhooks !== undefined) {
    if (!Array.isArray(webhooks)) {
      throw new Error('metadata.payments.stripe.webhooks must be an array when provided')
    }
    for (const [index, entry] of webhooks.entries()) {
      if (!isRecord(entry)) {
        throw new Error(`metadata.payments.stripe.webhooks[${index}] must be an object`)
      }
      if (entry.name !== undefined) {
        const name = typeof entry.name === 'string' ? entry.name.trim() : ''
        if (!name) {
          throw new Error(`metadata.payments.stripe.webhooks[${index}].name must be a non-empty string`)
        }
      }
      for (const key of ['secret', 'test', 'live', 'url'] as const) {
        const raw = entry[key]
        if (raw !== undefined && (typeof raw !== 'string' || !raw.trim())) {
          throw new Error(`metadata.payments.stripe.webhooks[${index}].${key} must be a non-empty string when provided`)
        }
      }
    }
  }

  const webhook = value.webhook
  if (webhook !== undefined) {
    if (!isRecord(webhook)) {
      throw new Error('metadata.payments.stripe.webhook must be an object when provided')
    }
    const catalog = webhook.catalog
    if (catalog !== undefined) {
      if (typeof catalog === 'string') {
        if (!catalog.trim()) {
          throw new Error('metadata.payments.stripe.webhook.catalog must be a non-empty string when provided')
        }
      } else if (isRecord(catalog)) {
        for (const key of ['secret', 'test', 'live'] as const) {
          const raw = catalog[key]
          if (raw !== undefined && (typeof raw !== 'string' || !raw.trim())) {
            throw new Error(`metadata.payments.stripe.webhook.catalog.${key} must be a non-empty string when provided`)
          }
        }
      } else {
        throw new Error('metadata.payments.stripe.webhook.catalog must be a string or object when provided')
      }
    }
  }
}

function usage(): string {
  return [
    'Usage:',
    '  tsx src/scripts/vlunactl.ts <group> <command> [--flags]',
    '',
    'Groups:',
    '  realm',
    '    create [--realm-id <id>] [--name <name>] [--status <active|suspended|deleted>] [--metadata-json <json>]',
    '    list',
    '',
    '  service-key',
    '    create --realm-id <id>',
    '    secret --realm-id <id> --key-id <keyId>',
    '',
    '  dat-bootstrap',
    '    create --allowed-realms <r1,r2> [--subject-id <id>] [--organization-id <id>] [--scopes <mcp:read,mcp:write>] [--expires-at <iso>] [--issued-by <label>]',
    '    revoke [--token-id <id> | --token <fullToken>]',
    '',
    '  reconciliation',
    '    run [--realm-id <id>] [--billing-account-id <uuid>] [--limit <n>] [--dry-run]',
    '',
    '  reconciliations (alias)',
    '    run [--realm-id <id>] [--billing-account-id <uuid>] [--limit <n>] [--dry-run]',
    '',
  '  runtime',
    '    reconcile --feature-code <code> [--realm-id <id>] [--org-id <id>] [--limit <n>] [--dry-run]',
    '',
    '  tasks',
    '    list',
    '    run --task <taskName>',
    '    worker [--tasks-include <a,b,c>] [--tasks-exclude <x,y>]',
    '',
    'Env:',
    '  DATABASE_URI           Runtime connection (not used by this script)',
    '  DATABASE_MIGRATOR_URI  Superuser/owner connection (required)',
    '  BILLING_MASTER_KEY     Required to derive service key secrets (service-key commands)',
  ].join('\n')
}


async function findDefaultServiceApiKeyIdForRealm(
  trx: Kysely<Database> | Transaction<Database>,
  realmId: string,
): Promise<string | undefined> {
  const normalizedRealm = realmId.trim()
  if (!normalizedRealm) return undefined
  const rows = await trx.selectFrom('service_api_keys').select(['key_id', 'allowed_realms']).execute()
  const found = rows.find((row) => row.key_id.startsWith('pk-') && row.allowed_realms.includes(normalizedRealm))
  return found?.key_id
}

async function getServiceApiKeySecret(
  trx: Kysely<Database> | Transaction<Database>,
  realmId: string,
  keyId: string,
): Promise<{ keyId: string; secretBase64: string; envTag: string }> {
  const manager = new ServiceApiKeyManagementService(new ServiceApiKeyService())
  const result = await manager.getServiceApiKeySecret(trx, realmId, keyId)
  return { keyId: result.keyId, secretBase64: result.secretBase64, envTag: result.envTag }
}

async function ensureDefaultServiceApiKeySecretForRealm(
  trx: Kysely<Database> | Transaction<Database>,
  realmId: string,
): Promise<{ keyId: string; secretBase64: string; envTag: string }> {
  const normalizedRealm = realmId.trim()
  if (!normalizedRealm) throw new Error('realm_id is required')
  const existingKeyId = await findDefaultServiceApiKeyIdForRealm(trx, normalizedRealm)
  const keyId = existingKeyId || (await ServiceApiKeyService.createServiceApiKey(trx, normalizedRealm))
  return getServiceApiKeySecret(trx, normalizedRealm, keyId)
}

const realmCreateCommand: Command = {
  name: 'realm.create',
  summary: 'Create or update a realm and baseline provisioning.',
  async run(ctx) {
    const args = parseArgs(ctx.argv)
    const realmId = getStringFlag(args, 'realm-id') || createRealmId()
    const name = getStringFlag(args, 'name') || undefined
    const status = getStringFlag(args, 'status') || undefined
    const metadataJson = getStringFlag(args, 'metadata-json') || undefined
    const metadata = metadataJson ? parseMetadataJson(metadataJson) : undefined

    try {
      const result = await db().transaction().execute(async (trx) => {
        await createRealm(trx, { realmId, name, status, metadata })
        const created = await ensureDefaultServiceApiKeySecretForRealm(trx, realmId)
        await writeCliAudit({
          trx,
          invocationId: ctx.invocationId,
          command: 'realm.create',
          status: 'success',
          realmId,
          action: 'realm.create',
          targetType: 'realm',
          targetId: realmId,
          body: { realm_id: realmId, name, status, metadata },
        })
        return created
      })

      printJson({ ok: true, realmId, keyId: result.keyId, secret: result.secretBase64, envTag: result.envTag })
    } catch (error) {
      await writeCliAudit({
        invocationId: ctx.invocationId,
        command: 'realm.create',
        status: 'failure',
        realmId,
        action: 'realm.create',
        targetType: 'realm',
        targetId: realmId,
        errorCode: 'CLI.COMMAND_FAILED',
        body: { realm_id: realmId, name, status, metadata },
        metadata: { error_message: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }
  },
}

const realmListCommand: Command = {
  name: 'realm.list',
  summary: 'List all realms with their realm-scoped service API key ids.',
  async run() {
    const realms = await db()
      .selectFrom('realms')
      .select(['realm_id', 'name', 'status', 'created_at', 'updated_at'])
      .orderBy('realm_id', 'asc')
      .execute()

    const keys = await db().selectFrom('service_api_keys').select(['key_id', 'allowed_realms']).execute()
    const keyIdsByRealm = new Map<string, string[]>()
    for (const row of keys) {
      const allowedRealms = row.allowed_realms ?? []
      for (const realmId of allowedRealms) {
        const existing = keyIdsByRealm.get(realmId) || []
        existing.push(row.key_id)
        keyIdsByRealm.set(realmId, existing)
      }
    }

    const out = realms.map((realm) => {
      const serviceKeyIds = [...new Set(keyIdsByRealm.get(realm.realm_id) || [])].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      )
      return { ...realm, serviceKeyIds }
    })

    printJson({ ok: true, realms: out })
  },
}

const serviceKeyCreateCommand: Command = {
  name: 'service-key.create',
  summary: 'Create a realm-scoped service API key and print its derived secret.',
  async run(ctx) {
    const args = parseArgs(ctx.argv)
    const realmId = requireStringFlag(args, 'realm-id')
    const expiresAtFlag = getStringFlag(args, 'expires-at')
    const expiresAt = expiresAtFlag ? parseTimestampFlag(expiresAtFlag, 'expires-at') : null

    try {
      const result = await db().transaction().execute(async (trx) => {
        const manager = new ServiceApiKeyManagementService(new ServiceApiKeyService())
        const created = await manager.createServiceApiKey(trx, realmId, { expires_at: expiresAt })
        await writeCliAudit({
          trx,
          invocationId: ctx.invocationId,
          command: 'service-key.create',
          status: 'success',
          realmId,
          action: 'service_key.create',
          targetType: 'service_key',
          targetId: created.key_id,
          body: {
            realm_id: realmId,
            expires_at: expiresAt ? expiresAt.toISOString() : null,
            secret: created.secret,
          },
          maskPaths: ['secret'],
          metadata: { env_tag: created.env_tag },
        })
        return created
      })

      printJson({ ok: true, realmId, keyId: result.key_id, secret: result.secret, envTag: result.env_tag })
    } catch (error) {
      await writeCliAudit({
        invocationId: ctx.invocationId,
        command: 'service-key.create',
        status: 'failure',
        realmId,
        action: 'service_key.create',
        targetType: 'service_key',
        errorCode: 'CLI.COMMAND_FAILED',
        body: { realm_id: realmId, expires_at: expiresAt ? expiresAt.toISOString() : null },
        metadata: { error_message: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }
  },
}

const serviceKeySecretCommand: Command = {
  name: 'service-key.secret',
  summary: 'Get the derived secret for a realm + key id.',
  async run(ctx) {
    const args = parseArgs(ctx.argv)
    const realmId = requireStringFlag(args, 'realm-id')
    const keyId = requireStringFlag(args, 'key-id')

    try {
      const result = await db().transaction().execute(async (trx) => {
        const { secretBase64, envTag } = await getServiceApiKeySecret(trx, realmId, keyId)
        await writeCliAudit({
          trx,
          invocationId: ctx.invocationId,
          command: 'service-key.secret',
          status: 'success',
          realmId,
          action: 'service_key.reveal',
          targetType: 'service_key',
          targetId: keyId,
          body: { realm_id: realmId, key_id: keyId, secret: secretBase64 },
          maskPaths: ['secret'],
          metadata: { env_tag: envTag },
        })
        return { secretBase64, envTag }
      })

      printJson({ ok: true, realmId, keyId, secret: result.secretBase64, envTag: result.envTag })
    } catch (error) {
      await writeCliAudit({
        invocationId: ctx.invocationId,
        command: 'service-key.secret',
        status: 'failure',
        realmId,
        action: 'service_key.reveal',
        targetType: 'service_key',
        targetId: keyId,
        errorCode: 'CLI.COMMAND_FAILED',
        body: { realm_id: realmId, key_id: keyId },
        metadata: { error_message: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }
  },
}

const datBootstrapCreateCommand: Command = {
  name: 'dat-bootstrap.create',
  summary: 'Create a DAT bootstrap token for operator access (token printed once).',
  async run(ctx) {
    const args = parseArgs(ctx.argv)
    const allowedRealms = parseCsvFlag(getStringFlag(args, 'allowed-realms'))
    if (allowedRealms.length === 0) {
      throw new Error('Missing required flag --allowed-realms (comma-separated realm ids)')
    }

    const scopeInput = parseCsvFlag(getStringFlag(args, 'scopes'))
    const scopes = Array.from(new Set(scopeInput.filter((value) => value === 'mcp:read' || value === 'mcp:write')))
    if (scopes.length === 0) scopes.push('mcp:read')

    const subjectId = (getStringFlag(args, 'subject-id') || '').trim() || `operator:${randomUUID()}`
    const organizationId = (getStringFlag(args, 'organization-id') || '').trim() || null
    const issuedBy = (getStringFlag(args, 'issued-by') || '').trim() || 'vlunactl'
    const expiresAtFlag = getStringFlag(args, 'expires-at')
    const expiresAt = expiresAtFlag ? parseTimestampFlag(expiresAtFlag, 'expires-at') : null

    const tokenId = `dbt_${randomUUID().replace(/-/g, '')}`
    const secret = randomBytes(24).toString('base64url')
    const token = `datb_${tokenId}_${secret}`
    const tokenHash = createHash('sha256').update(token).digest('hex')

    try {
      await db().transaction().execute(async (trx) => {
        await trx
          .insertInto('dat_bootstrap_tokens')
          .values({
            token_id: tokenId,
            token_hash: tokenHash,
            token_value: token,
            subject_type: 'operator',
            subject_id: subjectId,
            organization_id: organizationId,
            allowed_realms: allowedRealms,
            granted_scopes: scopes,
            issued_by: issuedBy,
            status: 'active',
            expires_at: expiresAt,
          })
          .execute()

        await writeCliAudit({
          trx,
          invocationId: ctx.invocationId,
          command: 'dat-bootstrap.create',
          status: 'success',
          realmId: allowedRealms[0],
          action: 'dat_bootstrap_token.create',
          targetType: 'dat_bootstrap_token',
          targetId: tokenId,
          body: {
            token_id: tokenId,
            subject_id: subjectId,
            organization_id: organizationId,
            allowed_realms: allowedRealms,
            granted_scopes: scopes,
            expires_at: expiresAt ? expiresAt.toISOString() : null,
            token,
          },
          maskPaths: ['token'],
        })
      })

      printJson({
        ok: true,
        token_id: tokenId,
        subject_type: 'operator',
        subject_id: subjectId,
        organization_id: organizationId,
        allowed_realms: allowedRealms,
        granted_scopes: scopes,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        token,
        note: 'Store this token securely; it is only shown once.',
      })
    } catch (error) {
      await writeCliAudit({
        invocationId: ctx.invocationId,
        command: 'dat-bootstrap.create',
        status: 'failure',
        realmId: allowedRealms[0],
        action: 'dat_bootstrap_token.create',
        targetType: 'dat_bootstrap_token',
        targetId: tokenId,
        errorCode: 'CLI.COMMAND_FAILED',
        body: {
          token_id: tokenId,
          subject_id: subjectId,
          organization_id: organizationId,
          allowed_realms: allowedRealms,
          granted_scopes: scopes,
          expires_at: expiresAt ? expiresAt.toISOString() : null,
        },
        metadata: { error_message: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }
  },
}

const datBootstrapRevokeCommand: Command = {
  name: 'dat-bootstrap.revoke',
  summary: 'Revoke a DAT bootstrap token by token id or full token.',
  async run(ctx) {
    const args = parseArgs(ctx.argv)
    let tokenId = (getStringFlag(args, 'token-id') || '').trim()
    const fullToken = (getStringFlag(args, 'token') || '').trim()
    if (!tokenId && fullToken) {
      tokenId = parseDatBootstrapTokenId(fullToken) || ''
    }
    if (!tokenId) {
      throw new Error('Provide --token-id or --token')
    }

    try {
      const result = await db().transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable('dat_bootstrap_tokens')
          .set({ status: 'revoked', updated_at: new Date() })
          .where('token_id', '=', tokenId)
          .where('status', '=', 'active')
          .executeTakeFirst()

        await writeCliAudit({
          trx,
          invocationId: ctx.invocationId,
          command: 'dat-bootstrap.revoke',
          status: 'success',
          action: 'dat_bootstrap_token.revoke',
          targetType: 'dat_bootstrap_token',
          targetId: tokenId,
          body: { token_id: tokenId },
          metadata: { revoked: Number(updated.numUpdatedRows || 0) > 0 },
        })
        return updated
      })

      printJson({ ok: true, token_id: tokenId, revoked: Number(result.numUpdatedRows || 0) > 0 })
    } catch (error) {
      await writeCliAudit({
        invocationId: ctx.invocationId,
        command: 'dat-bootstrap.revoke',
        status: 'failure',
        action: 'dat_bootstrap_token.revoke',
        targetType: 'dat_bootstrap_token',
        targetId: tokenId,
        errorCode: 'CLI.COMMAND_FAILED',
        body: { token_id: tokenId },
        metadata: { error_message: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }
  },
}

const tasksListCommand: Command = {
  name: 'tasks.list',
  summary: 'List all registered periodic tasks.',
  requiresMigrator: false,
  async run() {
    const app = await NestFactory.createApplicationContext(SchedulerModule.forRoot({}), { logger: false })
    try {
      const tasks = app.get(PERIODIC_TASKS_ALL) as PeriodicTaskDefinition[]
      printJson({
        ok: true,
        tasks: tasks.map((t) => ({ name: t.name, interval_ms: t.intervalMs, run_on_start: t.runOnStart !== false })),
      })
    } finally {
      await app.close().catch(() => {})
    }
  },
}

const tasksRunCommand: Command = {
  name: 'tasks.run',
  summary: 'Run a periodic task once and exit.',
  requiresMigrator: false,
  async run(ctx) {
    const args = parseArgs(ctx.argv)
    const taskName = requireStringFlag(args, 'task')

    const app = await NestFactory.createApplicationContext(SchedulerModule.forRoot({}), { logger: ['log', 'warn', 'error'] })
    try {
      const tasks = app.get(PERIODIC_TASKS_ALL) as PeriodicTaskDefinition[]
      const task = tasks.find((t) => t.name === taskName)
      if (!task) {
        throw new Error(`Unknown task name: ${taskName}`)
      }
      await Promise.resolve(task.run())
      printJson({ ok: true, task: taskName })
    } finally {
      await app.close().catch(() => {})
    }
  },
}

const tasksWorkerCommand: Command = {
  name: 'tasks.worker',
  summary: 'Run a filtered set of periodic tasks in a worker process (no HTTP listener).',
  requiresMigrator: false,
  async run(ctx) {
    const runtimeArgs = parseRuntimeArgsFromArgv(ctx.argv)
    const app = await NestFactory.createApplicationContext(SchedulerModule.forRoot(runtimeArgs), { logger: ['log', 'warn', 'error'] })
    await new Promise<void>((resolve) => {
      const onSignal = async () => {
        try {
          await app.close()
        } catch {}
        resolve()
      }
      process.once('SIGINT', () => void onSignal())
      process.once('SIGTERM', () => void onSignal())
    })
  },
}

const reconciliationsRunCommand: Command = {
  name: 'reconciliation.run',
  summary: 'Run a reconciliation scan once and upsert findings into reconciliations table.',
  async run(ctx) {
    const args = parseArgs(ctx.argv)
    const realmId = getStringFlag(args, 'realm-id') || undefined
    const billingAccountId = getStringFlag(args, 'billing-account-id') || undefined
    const limit = getStringFlag(args, 'limit')
    const dryRun = Boolean(args.flags['dry-run'])

    const result = await db().transaction().execute(async (trx) =>
      scanAndUpsertReconciliations(trx, {
        realmId,
        billingAccountId,
        limit: limit ? Number(limit) : undefined,
        dryRun,
      }),
    )

    printJson(result)
  },
}

const commands: Record<string, Command> = {
  'realm.create': realmCreateCommand,
  'realm.list': realmListCommand,
  'service-key.create': serviceKeyCreateCommand,
  'service-key.secret': serviceKeySecretCommand,
  'dat-bootstrap.create': datBootstrapCreateCommand,
  'dat-bootstrap.revoke': datBootstrapRevokeCommand,
  'reconciliation.run': reconciliationsRunCommand,
  'reconciliations.run': reconciliationsRunCommand,
  'tasks.list': tasksListCommand,
  'tasks.run': tasksRunCommand,
  'tasks.worker': tasksWorkerCommand,
}

const cliAuditWriter = new AuditWriter()

async function writeCliAudit(input: {
  trx?: Kysely<Database> | Transaction<Database>
  invocationId: string
  command: string
  status: 'success' | 'failure'
  realmId?: string
  action: string
  targetType?: string
  targetId?: string
  errorCode?: string
  body?: unknown
  maskPaths?: string[]
  metadata?: Record<string, unknown>
}) {
  await cliAuditWriter.write(
    {
      scopeType: input.realmId ? 'realm' : 'platform',
      realmId: input.realmId,
      actorType: 'cli',
      actorDisplay: 'vlunactl',
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      operationId: input.command,
      method: 'CLI',
      path: input.command,
      routeTemplate: 'vlunactl',
      status: input.status,
      httpStatus: 0,
      errorCode: input.errorCode,
      bodyJsonRedacted: redactAuditValue(input.body, { maskPaths: input.maskPaths }),
      metadata: {
        source: 'vlunactl',
        command: input.command,
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        hostname: hostname(),
        pid: process.pid,
        invocation_id: input.invocationId,
        ...(input.metadata ?? {}),
      },
    },
    input.trx,
  )
}

function parseDatBootstrapTokenId(token: string): string | undefined {
  const normalized = token.trim()
  const match = normalized.match(/^datb_(dbt_[A-Za-z0-9]+)_[A-Za-z0-9_-]+$/)
  if (!match) return undefined
  return match[1]
}

function resolveCommand(argv: string[]): { command: Command; rest: string[] } | null {
  const args = [...argv]
  const group = (args.shift() || '').trim()
  const action = (args.shift() || '').trim()
  if (!group || !action) return null
  const key = `${group}.${action}`
  const command = commands[key]
  if (!command) return null
  return { command, rest: args }
}

export async function runvlunactl(argv: string[]): Promise<void> {
  const resolved = resolveCommand(argv)
  if (!resolved) {
    process.stderr.write(usage() + '\n')
    process.exitCode = 2
    return
  }
  const invocationId = randomUUID()

  const requiresMigrator = resolved.command.requiresMigrator !== false
  if (requiresMigrator) {
    const superuserUri = process.env.DATABASE_MIGRATOR_URI?.trim()
    if (!superuserUri) {
      throw new Error('DATABASE_MIGRATOR_URI is required (use a superuser/owner connection for vlunactl)')
    }
    await withDatabaseConnection(superuserUri, async () => resolved.command.run({ argv: resolved.rest, invocationId }))
    return
  }

  const runtimeUri = process.env.DATABASE_URI?.trim()
  if (!runtimeUri) {
    throw new Error('DATABASE_URI is required for tasks commands')
  }
  await withDatabaseConnection(runtimeUri, async () => resolved.command.run({ argv: resolved.rest, invocationId }))
}

async function main(): Promise<void> {
  await runvlunactl(process.argv.slice(2))
}

main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[vlunactl] failed: ${message}\n`)
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n')
    }
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await db().destroy()
    } catch {}
    try {
      await pool.end()
    } catch {}
  })
