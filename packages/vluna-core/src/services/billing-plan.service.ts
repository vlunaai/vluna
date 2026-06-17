import crypto from 'node:crypto'
import { sql, type Insertable, type Kysely, type Transaction } from 'kysely'
import { setRlsSession } from '../db/index.js'
import type { Database } from '../types/database.js'
import {
  ensureGrantAssignment,
  issueGrantForAssignment,
  normalizeGrantBindingOverride,
  type GrantBindingOverride,
  type GrantAssignmentRow,
  type GrantProgramRow,
} from './grant-issuance.service.js'
import { runInTransaction } from '../features/gate/services/gate.utils.js'

type DbOrTrx = Kysely<Database> | Transaction<Database>

type GrantsSwitchMetadata = {
  applied_fingerprint?: string
  applied_at?: string
  target_fingerprint?: string
  dirty?: boolean
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b))
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(String(value))
}

function sha256Base64Url(input: string): string {
  return crypto.createHash('sha256').update(input).digest('base64url')
}

async function acquireBillingPlanProfileLock(trx: Transaction<Database>, billingAccountId: string): Promise<void> {
  // Serialize plan/grant profile sync per billing account to avoid lock-order deadlocks across concurrent workers.
  await sql`select pg_advisory_xact_lock(hashtext(${billingAccountId}), hashtext('billing.plan.profile'))`.execute(trx)
}

function readGrantsSwitchMetadata(metadata: Record<string, unknown> | null | undefined): GrantsSwitchMetadata {
  if (!metadata || typeof metadata !== 'object') return {}
  const raw = (metadata as Record<string, unknown>).grants_switch
  if (!raw || typeof raw !== 'object') return {}
  const obj = raw as Record<string, unknown>
  return {
    applied_fingerprint: typeof obj.applied_fingerprint === 'string' ? obj.applied_fingerprint : undefined,
    applied_at: typeof obj.applied_at === 'string' ? obj.applied_at : undefined,
    target_fingerprint: typeof obj.target_fingerprint === 'string' ? obj.target_fingerprint : undefined,
    dirty: typeof obj.dirty === 'boolean' ? obj.dirty : undefined,
  }
}

function writeGrantsSwitchMetadata(
  metadata: Record<string, unknown>,
  patch: GrantsSwitchMetadata,
): Record<string, unknown> {
  const currentRaw = (metadata.grants_switch && typeof metadata.grants_switch === 'object')
    ? (metadata.grants_switch as Record<string, unknown>)
    : {}
  const next: Record<string, unknown> = { ...currentRaw, ...patch }
  return {
    ...metadata,
    grants_switch: next,
  }
}

export type BillingPlanUpsertInput = {
  realmId: string
  planCode: string
  name: string
  kind: 'base' | 'addon' | 'promo'
  priority?: number
  active?: boolean
  metadata?: Record<string, unknown>
  featureCodes?: string[]
  featureFamilyCodes?: string[]
}

export type BillingPlanAssignmentRow = Insertable<Database['billing_plan_assignments']> & {
  assignment_id?: string
  valid_range?: unknown
}

export async function upsertBillingPlan(
  dbOrTrx: DbOrTrx,
  input: BillingPlanUpsertInput,
): Promise<string> {
  const row = await dbOrTrx
    .insertInto('billing_plans')
    .values({
      realm_id: input.realmId,
      plan_code: input.planCode,
      name: input.name,
      kind: input.kind,
      priority: input.priority ?? 0,
      active: input.active ?? true,
      metadata: input.metadata ?? {},
    })
    .onConflict((oc) =>
      oc.columns(['realm_id', 'plan_code']).where('realm_id', '=', input.realmId).doUpdateSet({
        name: input.name,
        kind: input.kind,
        priority: input.priority ?? 0,
        active: input.active ?? true,
        metadata: input.metadata ?? {},
        updated_at: sql`now()`,
      }),
    )
    .returning('plan_id')
    .executeTakeFirst()

  if (!row) throw new Error('failed to upsert billing_plan')

  if (input.featureFamilyCodes && input.featureFamilyCodes.length > 0) {
    const featureFamilyCodes = Array.from(new Set(input.featureFamilyCodes))
    const caps = await dbOrTrx
      .selectFrom('feature_families')
      .select(['feature_family_id', 'feature_family_code'])
      .where('realm_id', '=', input.realmId)
      .where('feature_family_code', 'in', featureFamilyCodes)
      .execute()

    // upsert missing feature_families with name=code, empty description
    const missingCodes = featureFamilyCodes.filter((code) => !caps.some((c) => c.feature_family_code === code))
    for (const code of missingCodes) {
      await dbOrTrx
        .insertInto('feature_families')
        .values({
          realm_id: input.realmId,
          feature_family_code: code,
          name: code,
          description: '',
          active: true,
          metadata: {},
        })
        .onConflict((oc) =>
          oc.columns(['realm_id', 'feature_family_code']).doUpdateSet({
            name: sql`excluded.name`,
            description: sql`excluded.description`,
            active: sql`excluded.active`,
            updated_at: sql`now()`,
          }),
        )
        .execute()
    }

    const allCaps = await dbOrTrx
      .selectFrom('feature_families')
      .select(['feature_family_id', 'feature_family_code'])
      .where('realm_id', '=', input.realmId)
      .where('feature_family_code', 'in', featureFamilyCodes)
      .execute()
    for (const cap of allCaps) {
      await dbOrTrx
        .insertInto('billing_plan_entitlements')
        .values({
          plan_id: row.plan_id,
          feature_family_id: cap.feature_family_id,
          effect: 'allow',
        })
        .onConflict((oc) =>
          oc.columns(['plan_id', 'feature_family_id']).doUpdateSet({
            effect: sql`excluded.effect`,
            updated_at: sql`now()`,
          }),
        )
        .execute()
    }
  }

  if (input.featureCodes && input.featureCodes.length > 0) {
    const featureRows = await dbOrTrx
      .selectFrom('features')
      .select(['feature_id'])
      .where('realm_id', '=', input.realmId)
      .where('feature_code', 'in', input.featureCodes)
      .execute()
    for (const f of featureRows) {
      await dbOrTrx
        .insertInto('billing_plan_entitlements')
        .values({
          plan_id: row.plan_id,
          feature_id: f.feature_id,
          effect: 'allow',
        })
        .onConflict((oc) =>
          oc.columns(['plan_id', 'feature_id']).doUpdateSet({
            effect: sql`excluded.effect`,
            updated_at: sql`now()`,
          }),
        )
        .execute()
    }
  }

  return String(row.plan_id)
}

export async function ensureBillingPlanAssignment(
  dbOrTrx: DbOrTrx,
  params: {
    billingAccountId: string
    planId: string
    subscriptionItemId?: string | null
    sourceKind: Database['billing_plan_assignments']['source_kind']
    sourceRef: string
    windowStart: Date
    windowEnd?: Date | null
    status?: Database['billing_plan_assignments']['status']
    metadata?: Record<string, unknown>
  },
): Promise<Database['billing_plan_assignments']> {
  const metadata = params.metadata ?? {}

  const insert: Insertable<Database['billing_plan_assignments']> = {
    billing_account_id: params.billingAccountId,
    plan_id: params.planId,
    subscription_item_id: params.subscriptionItemId ?? null,
    source_kind: params.sourceKind,
    source_ref: params.sourceRef,
    window_start: params.windowStart,
    window_end: params.windowEnd ?? null,
    status: params.status ?? 'active',
    metadata,
  }

  const row = await dbOrTrx
    .insertInto('billing_plan_assignments')
    .values(insert)
    .onConflict((oc) =>
      oc
        .columns(['billing_account_id', 'plan_id', 'source_kind', 'source_ref'])
        .doUpdateSet({
          window_start: sql`least(billing_plan_assignments.window_start, excluded.window_start)`,
          window_end: sql`case
            when excluded.window_end is null then billing_plan_assignments.window_end
            when billing_plan_assignments.window_end is null then excluded.window_end
            else greatest(billing_plan_assignments.window_end, excluded.window_end)
          end`,
          subscription_item_id: sql`excluded.subscription_item_id`,
          status: sql`excluded.status`,
          metadata: sql`excluded.metadata`,
          updated_at: sql`now()`,
        }),
    )
    .returningAll()
    .executeTakeFirst()

  if (!row) {
    throw new Error('failed to ensure billing_plan_assignment')
  }
  return row as unknown as Database['billing_plan_assignments']
}

type GateBundleCandidate = {
  bundle_key: string
  priority: number
  plan_id?: string | null
  plan_code?: string | null
  plan_kind?: string | null
  assignment_id?: string | null
}

type GateBundleSelection = {
  bundleId: string
  planId: string | null
  planCode: string | null
  planKind: string | null
  assignmentId: string | null
}

function compareGateBundleCandidates(a: GateBundleCandidate, b: GateBundleCandidate): number {
  const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0)
  if (priorityDiff !== 0) return priorityDiff
  return String(b.assignment_id ?? '').localeCompare(String(a.assignment_id ?? ''))
}

async function selectBestGateBundle(
  trx: Transaction<Database>,
  params: { realmId: string; billingAccountId: string; now?: Date; extraCandidates?: GateBundleCandidate[] },
): Promise<GateBundleSelection | null> {
  const now = params.now ?? new Date()

  const activeBindings = await trx
    .selectFrom('billing_plan_assignments as bpa')
    .innerJoin('billing_plans as bpl', 'bpl.plan_id', 'bpa.plan_id')
    .select([
      'bpa.assignment_id',
      'bpl.plan_id',
      'bpl.plan_code',
      'bpl.kind',
      'bpa.metadata',
      'bpl.priority',
      sql`bpl.metadata`.as('plan_metadata'),
    ])
    .where('bpa.billing_account_id', '=', params.billingAccountId)
    .where('bpa.status', '=', 'active')
    .where((eb) =>
      eb.and([
        eb('bpa.window_start', '<=', now),
        eb.or([eb('bpa.window_end', '>', now), eb('bpa.window_end', 'is', null)]),
      ]),
    )
    .where('bpl.active', '=', true)
    .where('bpl.kind', 'in', ['base', 'addon'])
    .execute()

  const candidates: GateBundleCandidate[] = []

  for (const b of activeBindings) {
    const meta = (b.metadata as Record<string, unknown> | null) ?? {}
    const planMeta = (b.plan_metadata as Record<string, unknown> | null) ?? {}
    const key =
      typeof meta.gate_bundle_key === 'string'
        ? meta.gate_bundle_key
        : typeof planMeta.gate_bundle_key === 'string'
          ? planMeta.gate_bundle_key
          : null
    if (key) {
      candidates.push({
        bundle_key: key,
        priority: b.priority ?? 0,
        plan_id: b.plan_id ? String(b.plan_id) : null,
        plan_code: b.plan_code ? String(b.plan_code) : null,
        plan_kind: b.kind ? String(b.kind) : null,
        assignment_id: b.assignment_id ? String(b.assignment_id) : null,
      })
    }
  }

  if (params.extraCandidates && params.extraCandidates.length > 0) {
    candidates.push(...params.extraCandidates.filter((c) => c.bundle_key))
  }

  if (candidates.length === 0) return null

  const byKey = new Map<string, GateBundleCandidate>()
  for (const c of candidates) {
    const existing = byKey.get(c.bundle_key)
    if (!existing || compareGateBundleCandidates(c, existing) < 0) {
      byKey.set(c.bundle_key, c)
    }
  }

  const keys = Array.from(byKey.keys())
  if (keys.length === 0) return null

  const bundleRows = await trx
    .selectFrom('gate_policy_bundles')
    .select(['bundle_id', 'bundle_key'])
    .where('realm_id', '=', params.realmId)
    .where('status', '=', 'active')
    .where('bundle_key', 'in', keys)
    .execute()

  if (bundleRows.length === 0) return null
  const bundleMap = new Map(bundleRows.map((row) => [String(row.bundle_key), String(row.bundle_id)]))

  const sorted = Array.from(byKey.values()).sort(compareGateBundleCandidates)
  for (const candidate of sorted) {
    const id = bundleMap.get(candidate.bundle_key)
    if (id) {
      return {
        bundleId: id,
        planId: candidate.plan_id ?? null,
        planCode: candidate.plan_code ?? null,
        planKind: candidate.plan_kind ?? null,
        assignmentId: candidate.assignment_id ?? null,
      }
    }
  }
  return null
}

export async function refreshBillingAccountState(
  dbOrTrx: DbOrTrx,
  billingAccountId: string,
  extraCandidates?: GateBundleCandidate[],
): Promise<void> {
  const run = async (trx: Transaction<Database>) => {
    const account = await trx
      .selectFrom('billing_accounts')
      .select(['billing_account_id', 'realm_id'])
      .where('billing_account_id', '=', billingAccountId)
      .executeTakeFirst()
    if (!account) return

    await setRlsSession(trx, {
      realmId: account.realm_id,
      billingAccountId,
      isRealmAdmin: true,
    })

    const chosen = await selectBestGateBundle(trx, {
      realmId: account.realm_id,
      billingAccountId,
      extraCandidates,
    })

    await trx
      .updateTable('billing_accounts')
      .set({ current_bundle_id: chosen?.bundleId ?? null })
      .where('billing_account_id', '=', billingAccountId)
      .execute()
  }

  await runInTransaction(dbOrTrx, run)
}

export async function ensureBillingPlanGrantsEnrollmentSynced(
  dbOrTrx: DbOrTrx,
  billingAccountId: string,
  now: Date = new Date(),
): Promise<void> {
  const run = async (trx: Transaction<Database>) => {
    await acquireBillingPlanProfileLock(trx, billingAccountId)

    const account = await trx
      .selectFrom('billing_accounts')
      .select(['billing_account_id', 'realm_id', 'metadata'])
      .where('billing_account_id', '=', billingAccountId)
      .forUpdate()
      .executeTakeFirst()
    if (!account) return

    await setRlsSession(trx, {
      realmId: account.realm_id,
      billingAccountId,
      isRealmAdmin: true,
    })

    const activeBindings = await trx
      .selectFrom('billing_plan_assignments as bpa')
      .innerJoin('billing_plans as bpl', 'bpl.plan_id', 'bpa.plan_id')
      .select([
        'bpa.assignment_id',
        'bpa.window_start',
        'bpa.window_end',
        'bpl.plan_code',
        sql`bpl.metadata`.as('plan_metadata'),
      ])
      .where('bpa.billing_account_id', '=', billingAccountId)
      .where('bpa.status', '=', 'active')
      .where((eb) =>
        eb.and([
          eb('bpa.window_start', '<=', now),
          eb.or([eb('bpa.window_end', '>', now), eb('bpa.window_end', 'is', null)]),
        ]),
      )
      .where('bpl.active', '=', true)
      .execute()

    const desiredTemplates: Array<{
      billingPlanAssignmentId: string
      billingPlanCode: string
      templateKey: string | null
      templateHash: string
      templateMeta: unknown | null
      grantProgramCode: string
      windowStart: Date
      windowEnd: Date | null
      override: GrantBindingOverride | null
      effect: 'allow' | 'deny'
    }> = []

    for (const b of activeBindings) {
      const planMeta = (b.plan_metadata as Record<string, unknown> | null) ?? {}
      const grantsRaw = (planMeta as Record<string, unknown>).grants
      const grants = Array.isArray(grantsRaw)
        ? (grantsRaw as unknown[])
        : grantsRaw
            ? [grantsRaw]
            : []
      for (const raw of grants) {
        if (!raw || typeof raw !== 'object') continue
        const override = normalizeGrantBindingOverride(raw)
        const grantProgramCode =
          override?.programCode ||
          String(
            (raw as Record<string, unknown>).grant_program_code ??
              (raw as Record<string, unknown>).program_code ??
              (raw as Record<string, unknown>).programCode ??
              '',
          ).trim()
        if (!grantProgramCode) continue
        const effect = ((raw as Record<string, unknown>).effect ?? 'allow') as 'allow' | 'deny'
        const bindingWindowEnd = (b.window_end as Date | null) ?? null
        const windowOverrideEnd =
          override?.windowRelativeSecondsOverride && override.windowRelativeSecondsOverride > 0
            ? new Date((b.window_start as Date).getTime() + override.windowRelativeSecondsOverride * 1000)
            : bindingWindowEnd

        const templateKeyRaw = (raw as Record<string, unknown>).template_key ?? (raw as Record<string, unknown>).templateKey
        const templateKey = typeof templateKeyRaw === 'string' && templateKeyRaw.trim().length > 0 ? templateKeyRaw.trim() : null

        const normalizedOverrideForTemplate: GrantBindingOverride =
          override ?? ({ programCode: grantProgramCode } as GrantBindingOverride)
        const templateHash = sha256Base64Url(stableStringify({
          grant_program_code: grantProgramCode,
          effect,
          override: normalizedOverrideForTemplate,
        }))

        const templateMeta = ((raw as Record<string, unknown>).template_meta ?? (raw as Record<string, unknown>).templateMeta ?? null) as unknown

        desiredTemplates.push({
          billingPlanAssignmentId: String(b.assignment_id),
          billingPlanCode: String(b.plan_code),
          templateKey,
          templateHash,
          templateMeta,
          grantProgramCode,
          windowStart: b.window_start as Date,
          windowEnd: windowOverrideEnd,
          override,
          effect,
        })
      }
    }

    const desiredForFingerprint = desiredTemplates
      .slice()
      .sort((a, b) => {
        const aId = a.templateKey ? `key:${a.templateKey}` : `hash:${a.templateHash}`
        const bId = b.templateKey ? `key:${b.templateKey}` : `hash:${b.templateHash}`
        return a.billingPlanAssignmentId.localeCompare(b.billingPlanAssignmentId)
          || aId.localeCompare(bId)
          || a.grantProgramCode.localeCompare(b.grantProgramCode)
      })
      .map((d) => ({
        billing_plan_assignment_id: d.billingPlanAssignmentId,
        billing_plan_code: d.billingPlanCode,
        template_key: d.templateKey,
        template_hash: d.templateHash,
        grant_program_code: d.grantProgramCode,
        effect: d.effect,
        window_start: d.windowStart.toISOString(),
        window_end: d.windowEnd ? d.windowEnd.toISOString() : null,
        override: d.override,
      }))

    const targetFingerprint = sha256Base64Url(stableStringify(desiredForFingerprint))

    const accountMetadata = ((account.metadata ?? {}) as Record<string, unknown>) ?? {}
    const grantsSwitch = readGrantsSwitchMetadata(accountMetadata)
    const appliedFingerprint = grantsSwitch.applied_fingerprint ?? ''

    if (appliedFingerprint === targetFingerprint && grantsSwitch.dirty !== true) {
      return
    }

    const programCodes = Array.from(new Set(desiredTemplates.map((d) => d.grantProgramCode)))
    const grantPrograms = programCodes.length > 0
      ? await trx
          .selectFrom('grant_programs')
          .select(['program_id', 'program_code'])
          .where('realm_id', '=', account.realm_id)
          .where('active', '=', true)
          .where('program_code', 'in', programCodes)
          .execute()
      : []
    const programIdByCode = new Map(grantPrograms.map((gp) => [String(gp.program_code), String(gp.program_id)]))

    const desiredRefs = new Set<string>()
    const desiredEnsures: Array<{
      programId: string
      sourceRef: string
      billingPlanAssignmentId: string
      billingPlanCode: string
      templateId: string
      templateKey: string | null
      templateHash: string
      templateMeta: unknown | null
      grantProgramCode: string
      windowStart: Date
      windowEnd: Date | null
      override: GrantBindingOverride | null
    }> = []

    for (const t of desiredTemplates) {
      if (t.effect === 'deny') continue
      const programId = programIdByCode.get(t.grantProgramCode)
      if (!programId) continue
      const templateId = t.templateKey ? `key:${t.templateKey}` : `hash:${t.templateHash}`
      const sourceRef = `bpa:${t.billingPlanAssignmentId}:tpl:${templateId}`
      desiredRefs.add(sourceRef)
      desiredEnsures.push({
        programId,
        sourceRef,
        billingPlanAssignmentId: t.billingPlanAssignmentId,
        billingPlanCode: t.billingPlanCode,
        templateId,
        templateKey: t.templateKey,
        templateHash: t.templateHash,
        templateMeta: t.templateMeta,
        grantProgramCode: t.grantProgramCode,
        windowStart: t.windowStart,
        windowEnd: t.windowEnd,
        override: t.override,
      })
    }

    const existing = await trx
      .selectFrom('grant_assignments')
      .select(['assignment_id', 'source_ref'])
      .where('billing_account_id', '=', billingAccountId)
      .where('source_kind', '=', 'billing_plan_assignment')
      .execute()

    const cancelIds = existing
      .filter((row) => !desiredRefs.has(String(row.source_ref)))
      .map((row) => String(row.assignment_id))

    if (cancelIds.length > 0) {
      await trx
        .updateTable('grant_assignments')
        .set({
          status: 'canceled',
          window_end: sql`case
            when grant_assignments.window_end is null then ${now}
            when grant_assignments.window_end > ${now} then ${now}
            else grant_assignments.window_end
          end`,
          updated_at: now,
        })
        .where('billing_account_id', '=', billingAccountId)
        .where('source_kind', '=', 'billing_plan_assignment')
        .where('assignment_id', 'in', cancelIds)
        .execute()
    }

    for (const d of desiredEnsures) {
      const normalizedOverride: GrantBindingOverride | null =
        d.override ??
        ({
          programCode: d.grantProgramCode,
        } as GrantBindingOverride)

      await ensureGrantAssignment(trx, {
        billingAccountId,
        programId: d.programId,
        billingPlanAssignmentId: d.billingPlanAssignmentId,
        sourceKind: 'billing_plan_assignment',
        sourceRef: d.sourceRef,
        windowStart: d.windowStart,
        windowEnd: d.windowEnd,
        metadata: {
          billing_plan_assignment_id: d.billingPlanAssignmentId,
          billing_plan_code: d.billingPlanCode,
          grant_template: {
            id: d.templateId,
            ...(d.templateKey ? { key: d.templateKey } : {}),
            hash: d.templateHash,
            ...(d.templateMeta !== null && d.templateMeta !== undefined ? { meta: d.templateMeta } : {}),
          },
          ...(normalizedOverride?.metadata ?? {}),
          ...(normalizedOverride ? { grants: [normalizedOverride] } : {}),
        },
        decidedAt: now,
      })
    }

    const finalMeta = writeGrantsSwitchMetadata(accountMetadata, {
      applied_fingerprint: targetFingerprint,
      applied_at: now.toISOString(),
      target_fingerprint: targetFingerprint,
      dirty: false,
    })

    await trx
      .updateTable('billing_accounts')
      .set({ metadata: finalMeta })
      .where('billing_account_id', '=', billingAccountId)
      .execute()
  }

  await runInTransaction(dbOrTrx, run)
}

export async function issueGrantsForAccount(dbOrTrx: DbOrTrx, billingAccountId: string): Promise<void> {
  const now = new Date()
  const assignments = await dbOrTrx
    .selectFrom('grant_assignments as ga')
    .innerJoin('grant_programs as gp', 'gp.program_id', 'ga.program_id')
    .select([
      'ga.assignment_id',
      'ga.billing_account_id',
      'ga.program_id',
      'ga.billing_plan_assignment_id',
      'ga.campaign_id',
      'ga.source_kind',
      'ga.source_ref',
      'ga.window_start',
      'ga.window_end',
      'ga.valid_range',
      'ga.status',
      'ga.metadata',
      'ga.created_at',
      'ga.updated_at',
      'gp.program_id as gp_program_id',
      'gp.program_code as gp_program_code',
      'gp.realm_id as gp_realm_id',
      'gp.name as gp_name',
      'gp.active as gp_active',
      'gp.cadence as gp_cadence',
      'gp.issue_anchor as gp_issue_anchor',
      'gp.amount_xusd as gp_amount_xusd',
      'gp.window_kind as gp_window_kind',
      'gp.window_default_seconds as gp_window_default_seconds',
      'gp.priority as gp_priority',
      'gp.on_ledger as gp_on_ledger',
      'gp.issuance_mode as gp_issuance_mode',
      'gp.periodic_accounting as gp_periodic_accounting',
      'gp.accrual_mode as gp_accrual_mode',
      'gp.metadata as gp_metadata',
      'gp.created_at as gp_created_at',
      'gp.updated_at as gp_updated_at',
      'gp.eligibility_kind as gp_eligibility_kind',
      'gp.eligibility_payload as gp_eligibility_payload',
    ])
    .where('ga.billing_account_id', '=', billingAccountId)
    .where('ga.status', '=', 'active')
    .where('ga.source_kind', '=', 'billing_plan_assignment')
    .where('ga.window_start', '<=', now)
    .where((eb) => eb.or([eb('ga.window_end', 'is', null), eb('ga.window_end', '>', now)]))
    .execute()
  if (assignments.length === 0) return

  const extractOverride = (metadata: Record<string, unknown> | null | undefined, programCode: string): GrantBindingOverride | null => {
    if (!metadata || typeof metadata !== 'object') return null
    const direct = normalizeGrantBindingOverride((metadata as Record<string, unknown>).grant_override)
    if (direct) return direct
    const raw = (metadata as Record<string, unknown>).grants
    if (!raw) return null
    const list = Array.isArray(raw) ? raw : [raw]
    for (const candidate of list) {
      const parsed = normalizeGrantBindingOverride(candidate)
      if (parsed && parsed.programCode === programCode) {
        return parsed
      }
    }
    return null
  }

  for (const row of assignments) {
    const program: GrantProgramRow = {
      program_id: String(row.gp_program_id),
      realm_id: String(row.gp_realm_id),
      program_code: String(row.gp_program_code),
      name: String(row.gp_name),
      active: Boolean(row.gp_active),
      cadence: row.gp_cadence as GrantProgramRow['cadence'],
      issue_anchor: row.gp_issue_anchor as GrantProgramRow['issue_anchor'],
      amount_xusd: row.gp_amount_xusd as GrantProgramRow['amount_xusd'],
      window_kind: row.gp_window_kind as GrantProgramRow['window_kind'],
      window_default_seconds: row.gp_window_default_seconds as GrantProgramRow['window_default_seconds'],
      priority: row.gp_priority as GrantProgramRow['priority'],
      on_ledger: row.gp_on_ledger as GrantProgramRow['on_ledger'],
      issuance_mode: row.gp_issuance_mode as GrantProgramRow['issuance_mode'],
      periodic_accounting: row.gp_periodic_accounting as GrantProgramRow['periodic_accounting'],
      accrual_mode: row.gp_accrual_mode as GrantProgramRow['accrual_mode'],
      metadata: (row.gp_metadata as Record<string, unknown>) ?? {},
      created_at: row.gp_created_at as Date,
      updated_at: row.gp_updated_at as Date,
      eligibility_kind: row.gp_eligibility_kind as GrantProgramRow['eligibility_kind'],
      eligibility_payload: row.gp_eligibility_payload as GrantProgramRow['eligibility_payload'],
    }

    const assignment: GrantAssignmentRow = {
      assignment_id: String(row.assignment_id),
      billing_account_id: String(row.billing_account_id),
      program_id: String(row.program_id),
      billing_plan_assignment_id: row.billing_plan_assignment_id ? String(row.billing_plan_assignment_id) : null,
      campaign_id: row.campaign_id ? String(row.campaign_id) : null,
      source_kind: row.source_kind as GrantAssignmentRow['source_kind'],
      source_ref: String(row.source_ref),
      window_start: row.window_start as Date,
      window_end: (row.window_end as Date | null) ?? null,
      valid_range: row.valid_range as GrantAssignmentRow['valid_range'],
      status: row.status as GrantAssignmentRow['status'],
      metadata: (row.metadata as Record<string, unknown> | null) ?? {},
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    }

    const override = extractOverride(assignment.metadata as Record<string, unknown> | null, program.program_code)

    await issueGrantForAssignment(dbOrTrx, {
      realmId: String((program as unknown as { realm_id: string }).realm_id),
      billingAccountId,
      program,
      assignment,
      override: override ?? undefined,
      quantity: 1,
      sourceKind: assignment.source_kind,
      sourceRef: assignment.source_ref,
      metadata: { origin: 'billing_plan' },
      now,
      allocSeq: undefined,
      isRealmAdmin: true,
    })
  }
}
