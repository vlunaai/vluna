import { Injectable, Logger } from '@nestjs/common'
import { type Kysely, type Transaction } from 'kysely'
import { db, setRlsSession } from '../db/index.js'
import type { Database } from '../types/database.js'
import {
  ensureGrantAssignment,
  issueGrantForAssignment,
  normalizeGrantBindingOverride,
  type GrantProgramRow,
  type GrantAssignmentRow,
  type GrantBindingOverride,
} from '../services/grant-issuance.service.js'
import {
  ensureBillingPlanAssignment,
  ensureBillingPlanGrantsEnrollmentSynced,
  issueGrantsForAccount,
} from '../services/billing-plan.service.js'
import type { PeriodicTaskDefinition } from '../scheduler/periodic-task.types.js'

type BillingAccountRow = {
  billing_account_id: string
  realm_id: string
}

type AssignmentWithProgramRow = {
  assignment_id: string
  billing_user_id: string
  billing_account_id: string
  program_id: string
  source_kind: string
  source_ref: string
  window_start: Date
  window_end: Date | null
  status: 'active' | 'paused' | 'canceled' | 'expired'
  metadata: Record<string, unknown>
  updated_at: Date
  program: GrantProgramRow
}

type CatalogPriceInfo = {
  catalogPriceId: string
  providerPriceId: string | null
  currency: string
  metadata: Record<string, unknown> | null
}

type SubscriptionInfo = {
  subscriptionId: string
  quantity: number | null
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  status: string | null
}

type GrantCampaignRow = {
  campaign_id: string
  realm_id: string
  name: string
  status: 'scheduled' | 'active' | 'paused' | 'ended'
  window_start: Date
  window_end: Date | null
  target_filter: Record<string, unknown>
  metadata: Record<string, unknown>
}

type CampaignBinding = {
  programCode: string
  override: GrantBindingOverride
  windowStart?: Date
  windowEnd?: Date | null
}

type BillingPlanCampaignSpec = {
  billing_plan_code?: string
  window_relative_seconds?: number
}

const DEFAULT_INTERVAL_MS = (() => {
  const raw = process.env.VLUNA_GRANT_SWEEP_INTERVAL_MS
  if (!raw) return 5 * 60 * 1000
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5 * 60 * 1000
})()

const MAX_PERIODS_PER_BINDING = (() => {
  const raw = process.env.VLUNA_GRANT_SWEEP_MAX_PERIODS
  if (!raw) return 120
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return 120
  return Math.min(Math.floor(parsed), 500)
})()

const MAX_BINDINGS_PER_ACCOUNT = (() => {
  const raw = process.env.VLUNA_GRANT_SWEEP_BINDINGS_LIMIT
  if (!raw) return 0
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.floor(parsed)
})()

@Injectable()
export class GrantBindingSweepTask implements PeriodicTaskDefinition {
  readonly name = 'grant-binding-sweep'
  readonly intervalMs = DEFAULT_INTERVAL_MS
  readonly runOnStart = true

  private readonly logger = new Logger(GrantBindingSweepTask.name)

  async run(): Promise<void> {
    const dbHandle = db()
    const now = new Date()

    const realms = await dbHandle
      .selectFrom('realms')
      .select(['realm_id'])
      .where('status', '=', 'active')
      .execute()

    if (realms.length === 0) {
      this.logger.debug('Grant sweep found no active realms to inspect')
      return
    }

    for (const realm of realms) {
      try {
        await this.processRealm(dbHandle, realm.realm_id, now)
      } catch (err) {
        this.logger.error(`Grant sweep failed for realm ${realm.realm_id}: ${(err as Error)?.message ?? err}`)
      }
    }
  }

  private async processRealm(dbHandle: Kysely<Database>, realmId: string, now: Date): Promise<void> {
    const priceCache = new Map<string, CatalogPriceInfo>()
    const subscriptionCache = new Map<string, SubscriptionInfo>()

    await this.runCampaignPhase(dbHandle, realmId, now)

    const accounts = (await dbHandle
      .selectFrom('billing_accounts')
      .select(['billing_account_id', 'realm_id'])
      .where('realm_id', '=', realmId)
      .execute()) as BillingAccountRow[]

    if (accounts.length === 0) {
      this.logger.debug(`Grant sweep realm ${realmId} has no billing accounts to inspect`)
      return
    }

    let processedBindings = 0
    let issuedGrants = 0

    for (const account of accounts) {
      const bindings = await this.fetchBindingsForAccount(dbHandle, account, now)
      if (bindings.length === 0) continue

      for (const binding of bindings) {
        try {
          const result = await this.processBinding(dbHandle, {
            account,
            binding,
            now,
            priceCache,
            subscriptionCache,
          })
          processedBindings += 1
          issuedGrants += result.issued
        } catch (err) {
          this.logger.error(
            `Grant sweep skipped binding ${binding.assignment_id} in realm ${realmId}: ${(err as Error)?.message ?? err}`,
          )
        }
      }
    }

    if (processedBindings > 0 || issuedGrants > 0) {
      this.logger.log(
        `Grant sweep realm ${realmId} processed ${processedBindings} bindings; issued ${issuedGrants} grants (${now.toISOString()})`,
      )
    }
  }

  private async runCampaignPhase(dbHandle: Kysely<Database>, realmId: string, now: Date): Promise<void> {
    const campaigns = await dbHandle.transaction().execute(async (trx) => {
      await setRlsSession(trx, { realmId, isRealmAdmin: true })
      return this.loadRunnableCampaigns(trx, realmId, now)
    })
    if (campaigns.length === 0) return

    for (const campaign of campaigns) {
      await dbHandle.transaction().execute(async (trx) => {
        await setRlsSession(trx, { realmId, isRealmAdmin: true })

        // Transition status based on window
        if (campaign.window_end && campaign.window_end <= now && campaign.status === 'active') {
          await trx
            .updateTable('grant_campaigns')
            .set({ status: 'ended', updated_at: now })
            .where('campaign_id', '=', campaign.campaign_id)
            .execute()
          return
        }

        if (campaign.status === 'scheduled') {
          await trx
            .updateTable('grant_campaigns')
            .set({ status: 'active', updated_at: now })
            .where('campaign_id', '=', campaign.campaign_id)
            .execute()
        }

        if (campaign.status === 'paused') {
          return
        }

        const bindings = extractCampaignBindings(campaign.metadata)
        if (bindings.length === 0) {
          this.logger.debug(`Campaign ${campaign.campaign_id} has no grants`)
          return
        }

        const programCodes = Array.from(new Set(bindings.map((b) => b.programCode).filter((code) => code.length > 0)))
        if (programCodes.length === 0) {
          this.logger.debug(`Campaign ${campaign.campaign_id} has no valid program codes`)
          return
        }

        const programs = await trx
          .selectFrom('grant_programs')
          .selectAll()
          .where('realm_id', '=', realmId)
          .where('program_code', 'in', programCodes)
          .execute()

        const programByCode = new Map<string, GrantProgramRow>()
        for (const program of programs) {
          programByCode.set(String(program.program_code), program as GrantProgramRow)
        }

        const targets = await this.resolveCampaignTargets(trx, realmId, campaign)
        if (targets.length === 0) {
          return
        }

        const baseMetadata = stripGrantBindings(campaign.metadata)

        for (const ba of targets) {
          await setRlsSession(trx, { realmId, billingAccountId: ba, isRealmAdmin: true })
          const billingUserIds = await this.loadActiveBillingUserIds(trx, ba)
          for (const billingUserId of billingUserIds) {
            for (const binding of bindings) {
              const program = programByCode.get(binding.programCode)
              if (!program) {
                this.logger.warn(`Campaign ${campaign.campaign_id} references missing program ${binding.programCode}`)
                continue
              }
              await ensureGrantAssignment(trx, {
                billingUserId,
                billingAccountId: ba,
                programId: String(program.program_id),
                campaignId: campaign.campaign_id,
                sourceKind: 'ops.campaign',
                sourceRef: String(campaign.campaign_id),
                windowStart: binding.windowStart ?? campaign.window_start,
                windowEnd: binding.windowEnd ?? campaign.window_end,
                status: 'active',
                metadata: {
                  ...baseMetadata,
                  grant_campaign_id: campaign.campaign_id,
                  grant_override: binding.override,
                },
              })
            }
          }

          const bpSpec = this.extractBillingPlanSpec(campaign.metadata)
          if (bpSpec?.billing_plan_code) {
            await this.applyBillingPlanCampaign(trx, {
              realmId,
              billingAccountId: ba,
              planCode: bpSpec.billing_plan_code,
              windowStart: campaign.window_start,
              windowEnd: bpSpec.window_relative_seconds
                ? new Date(campaign.window_start.getTime() + bpSpec.window_relative_seconds * 1000)
                : campaign.window_end,
              sourceRef: String(campaign.campaign_id),
              now,
            })
          }
        }
      })
    }
  }

  private async loadRunnableCampaigns(
    trx: Transaction<Database>,
    realmId: string,
    now: Date,
  ): Promise<GrantCampaignRow[]> {
    const rows = await trx
      .selectFrom('grant_campaigns')
      .selectAll()
      .where('realm_id', '=', realmId)
      .where('status', 'in', ['scheduled', 'active'])
      .where((eb) =>
        eb.and([
          eb('window_start', '<=', now),
          eb.or([eb('window_end', 'is', null), eb('window_end', '>', now)]),
        ]),
      )
      .orderBy('window_start')
      .execute()

    return rows.map((row) => ({
      campaign_id: String(row.campaign_id),
      realm_id: String(row.realm_id),
      name: String(row.name),
      status: row.status as GrantCampaignRow['status'],
      window_start: new Date(row.window_start),
      window_end: row.window_end ? new Date(row.window_end) : null,
      target_filter: (row.target_filter as Record<string, unknown>) ?? {},
      metadata: (row.metadata as Record<string, unknown>) ?? {},
    }))
  }

  private extractBillingPlanSpec(meta: Record<string, unknown> | null | undefined): BillingPlanCampaignSpec | null {
    if (!meta || typeof meta !== 'object') return null
    const planCode = (meta as Record<string, unknown>).billing_plan_code
    const windowSeconds = (meta as Record<string, unknown>).billing_plan_window_seconds
    const spec: BillingPlanCampaignSpec = {}
    if (typeof planCode === 'string' && planCode.trim()) spec.billing_plan_code = planCode.trim()
    if (typeof windowSeconds === 'number' && Number.isFinite(windowSeconds) && windowSeconds > 0) {
      spec.window_relative_seconds = Math.floor(windowSeconds)
    }
    return Object.keys(spec).length ? spec : null
  }

  private async applyBillingPlanCampaign(
    trx: Transaction<Database>,
    params: {
      realmId: string
      billingAccountId: string
      planCode: string
      windowStart: Date
      windowEnd: Date | null | undefined
      sourceRef: string
      now: Date
    },
  ): Promise<void> {
    const plan = await trx
      .selectFrom('billing_plans')
      .select(['plan_id'])
      .where('realm_id', '=', params.realmId)
      .where('plan_code', '=', params.planCode)
      .where('active', '=', true)
      .executeTakeFirst()
    if (!plan?.plan_id) return

    const billingUserIds = await this.loadActiveBillingUserIds(trx, params.billingAccountId)
    for (const billingUserId of billingUserIds) {
      await ensureBillingPlanAssignment(trx, {
        billingAccountId: params.billingAccountId,
        assignmentScope: 'user',
        billingUserId,
        planId: String(plan.plan_id),
        sourceKind: 'ops.campaign',
        sourceRef: params.sourceRef,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd ?? null,
        metadata: {
          campaign_id: params.sourceRef,
          billing_plan_code: params.planCode,
        },
      })
    }

    await ensureBillingPlanGrantsEnrollmentSynced(trx, params.billingAccountId)
    await issueGrantsForAccount(trx, params.billingAccountId)
  }

  private async resolveCampaignTargets(
    trx: Transaction<Database>,
    realmId: string,
    campaign: GrantCampaignRow,
  ): Promise<string[]> {
    const filter = campaign.target_filter ?? {}
    const explicitList = Array.isArray((filter as { billing_account_ids?: unknown }).billing_account_ids)
      ? ((filter as { billing_account_ids?: unknown }).billing_account_ids as unknown[])
      : []
    const parsedExplicit = explicitList
      .map((v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null))
      .filter((v): v is string => Boolean(v))

    if (parsedExplicit.length > 0) {
      return parsedExplicit
    }

    // Fallback: all accounts in realm
    const accounts = await trx
      .selectFrom('billing_accounts')
      .select(['billing_account_id'])
      .where('realm_id', '=', realmId)
      .execute()

    return accounts.map((a) => String(a.billing_account_id))
  }

  private async loadActiveBillingUserIds(trx: Transaction<Database>, billingAccountId: string): Promise<string[]> {
    const rows = await trx
      .selectFrom('billing_users')
      .select(['billing_user_id'])
      .where('billing_account_id', '=', billingAccountId)
      .where('status', '=', 'active')
      .execute()
    return rows.map((row) => String(row.billing_user_id)).filter(Boolean)
  }

  private async fetchBindingsForAccount(
    dbHandle: Kysely<Database>,
    account: BillingAccountRow,
    now: Date,
  ): Promise<AssignmentWithProgramRow[]> {
    return await dbHandle.transaction().execute(async (trx) => {
      await setRlsSession(trx, {
        realmId: account.realm_id,
        billingAccountId: account.billing_account_id,
        isRealmAdmin: true,
      })

      let query = trx
        .selectFrom('grant_assignments as ga')
        .select([
          'ga.assignment_id',
          'ga.billing_user_id',
          'ga.billing_account_id',
          'ga.program_id',
          'ga.source_kind',
          'ga.source_ref',
          'ga.window_start',
          'ga.window_end',
          'ga.status',
          'ga.metadata',
          'ga.updated_at',
        ])
        .where('ga.billing_account_id', '=', account.billing_account_id)
        .where('ga.status', '=', 'active')
        .where('ga.window_start', '<=', now)
        .where((eb) => eb.or([eb('ga.window_end', 'is', null), eb('ga.window_end', '>', now)]))
        .orderBy('ga.assignment_id')

      if (MAX_BINDINGS_PER_ACCOUNT > 0) {
        query = query.limit(MAX_BINDINGS_PER_ACCOUNT)
      }

      const rows = await query.execute()
      if (rows.length === 0) return []

      const programIds = Array.from(new Set(rows.map((row) => String(row.program_id)))).filter((id) => id.length > 0)
      const programs = programIds.length > 0
        ? await trx
            .selectFrom('grant_programs')
            .selectAll()
            .where('program_id', 'in', programIds)
            .execute()
        : []

      const programMap = new Map<string, GrantProgramRow>()
      for (const program of programs) {
        programMap.set(String(program.program_id), program as GrantProgramRow)
      }

      return rows
        .map((row) => {
          const program = programMap.get(String(row.program_id))
          if (!program) return null
          return {
            assignment_id: String(row.assignment_id),
            billing_user_id: String(row.billing_user_id),
            billing_account_id: String(row.billing_account_id),
            program_id: String(row.program_id),
            source_kind: String(row.source_kind),
            source_ref: String(row.source_ref),
            window_start: new Date(row.window_start),
            window_end: row.window_end ? new Date(row.window_end) : null,
            status: row.status ?? 'active',
            metadata: (row.metadata as Record<string, unknown>) ?? {},
            updated_at: new Date(row.updated_at),
            program,
          } as AssignmentWithProgramRow
        })
        .filter((row): row is AssignmentWithProgramRow => Boolean(row))
    })
  }

  private async processBinding(
    dbHandle: Kysely<Database>,
    ctx: {
      account: BillingAccountRow
      binding: AssignmentWithProgramRow
      now: Date
      priceCache: Map<string, CatalogPriceInfo>
      subscriptionCache: Map<string, SubscriptionInfo>
    },
  ): Promise<{ issued: number }> {
    const { account, binding, now, priceCache, subscriptionCache } = ctx
    const bindingMetadata = toRecord(binding.metadata)

    return await dbHandle.transaction().execute(async (trx) => {
      await setRlsSession(trx, {
        realmId: account.realm_id,
        billingUserId: binding.billing_user_id,
        billingAccountId: account.billing_account_id,
        isRealmAdmin: false,
      })

      let effectiveAssignment: GrantAssignmentRow = {
        assignment_id: binding.assignment_id,
        billing_user_id: binding.billing_user_id,
        billing_account_id: binding.billing_account_id,
        program_id: binding.program_id,
        billing_plan_assignment_id: null,
        campaign_id: null,
        source_kind: binding.source_kind as GrantAssignmentRow['source_kind'],
        source_ref: binding.source_ref,
        window_start: binding.window_start,
        window_end: binding.window_end,
        valid_range: null,
        status: binding.status,
        metadata: bindingMetadata,
        created_at: binding.updated_at,
        updated_at: binding.updated_at,
      }

      const program: GrantProgramRow = binding.program
      if (program.issuance_mode === 'lazy') {
        this.logger.debug(`Skipping lazy issuance program ${program.program_code} for assignment ${binding.assignment_id}`)
        return { issued: 0 }
      }
      const catalogPriceId = readCatalogPriceId(bindingMetadata)

      let priceInfo: CatalogPriceInfo | null = null
      if (catalogPriceId) {
        priceInfo = await this.loadCatalogPrice(trx, catalogPriceId, priceCache)
      }

      const priceOverride = priceInfo ? this.pickOverride(program.program_code, priceInfo.metadata) : null
      const metadataOverride = this.pickOverride(program.program_code, bindingMetadata)
      const override = priceOverride ?? metadataOverride
      const quantity = await this.resolveQuantity(trx, binding, bindingMetadata, priceInfo, subscriptionCache)
      const targetWindowEnd = await this.deriveTargetWindowEnd(trx, binding, priceInfo, subscriptionCache)

      if (targetWindowEnd && (!effectiveAssignment.window_end || effectiveAssignment.window_end < targetWindowEnd)) {
        effectiveAssignment = await ensureGrantAssignment(trx, {
          billingUserId: binding.billing_user_id,
          billingAccountId: account.billing_account_id,
          programId: String(effectiveAssignment.program_id),
          sourceKind: effectiveAssignment.source_kind,
          sourceRef: effectiveAssignment.source_ref,
          windowStart: effectiveAssignment.window_start,
          windowEnd: targetWindowEnd,
          status: effectiveAssignment.status,
          metadata: effectiveAssignment.metadata,
        })
      }

      const periodReferences = computePeriodReferences({
        program,
        assignment: effectiveAssignment,
        now,
        maxPeriods: MAX_PERIODS_PER_BINDING,
      })

      let issued = 0
      for (const reference of periodReferences) {
        const metadata: Record<string, unknown> = {
          sweep_source: this.name,
          sweep_run_started_at: now.toISOString(),
        }
        if (quantity !== null) {
          metadata.quantity = quantity
        }

        const result = await issueGrantForAssignment(trx, {
          realmId: account.realm_id,
          billingUserId: binding.billing_user_id,
          billingAccountId: account.billing_account_id,
          program,
          assignment: effectiveAssignment,
          override: override ?? undefined,
          quantity: quantity ?? 1,
          sourceKind: effectiveAssignment.source_kind,
          sourceRef: effectiveAssignment.source_ref,
          metadata,
          now: reference,
          allocSeq: override?.allocSeqOverride,
          isRealmAdmin: false,
        })

        if (result) {
          issued += 1
        }
      }

      return { issued }
    })
  }

  private async loadCatalogPrice(
    trx: Transaction<Database>,
    catalogPriceId: string,
    cache: Map<string, CatalogPriceInfo>,
  ): Promise<CatalogPriceInfo | null> {
    if (cache.has(catalogPriceId)) {
      return cache.get(catalogPriceId) ?? null
    }

    const row = await trx
      .selectFrom('catalog_prices')
      .select(['catalog_price_id', 'provider_price_id', 'currency', 'metadata'])
      .where('catalog_price_id', '=', catalogPriceId)
      .executeTakeFirst()

    if (!row) {
      cache.set(catalogPriceId, null as unknown as CatalogPriceInfo)
      return null
    }

    const info: CatalogPriceInfo = {
      catalogPriceId: String(row.catalog_price_id),
      providerPriceId: row.provider_price_id ?? null,
      currency: row.currency,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    }
    cache.set(catalogPriceId, info)
    return info
  }

  private pickOverride(programCode: string, metadata: Record<string, unknown> | null): GrantBindingOverride | null {
    if (!metadata) return null
    const direct = normalizeGrantBindingOverride((metadata as Record<string, unknown>).grant_override)
    if (direct) return direct
    const overrides = extractOverrides(metadata)
    return overrides.find((override) => override.programCode === programCode) ?? null
  }

  private async resolveQuantity(
    trx: Transaction<Database>,
    binding: AssignmentWithProgramRow,
    bindingMetadata: Record<string, unknown>,
    priceInfo: CatalogPriceInfo | null,
    cache: Map<string, SubscriptionInfo>,
  ): Promise<number | null> {
    const quantityFromMetadata = parsePositiveInteger(bindingMetadata.quantity)
    if (quantityFromMetadata !== null) {
      return quantityFromMetadata
    }

    if (!binding.source_kind.startsWith('provider.subscription')) {
      return quantityFromMetadata
    }

    const subscriptionId = extractStripeSubscriptionId(binding.source_ref)
    if (!subscriptionId) {
      return quantityFromMetadata
    }

    const subscriptionInfo = await this.loadSubscriptionInfo(trx, subscriptionId, priceInfo, cache)
    return subscriptionInfo?.quantity ?? quantityFromMetadata
  }

  private async deriveTargetWindowEnd(
    trx: Transaction<Database>,
    binding: AssignmentWithProgramRow,
    priceInfo: CatalogPriceInfo | null,
    cache: Map<string, SubscriptionInfo>,
  ): Promise<Date | null> {
    if (!binding.source_kind.startsWith('provider.subscription')) {
      return binding.window_end ?? null
    }

    const subscriptionId = extractStripeSubscriptionId(binding.source_ref)
    if (!subscriptionId) {
      return binding.window_end ?? null
    }

    const subscriptionInfo = await this.loadSubscriptionInfo(trx, subscriptionId, priceInfo, cache)
    const candidate = subscriptionInfo?.currentPeriodEnd
    const baseline = binding.window_end ?? null
    if (candidate && (!baseline || candidate > baseline)) {
      return candidate
    }
    return baseline
  }

  private async loadSubscriptionInfo(
    trx: Transaction<Database>,
    externalSubscriptionId: string,
    priceInfo: CatalogPriceInfo | null,
    cache: Map<string, SubscriptionInfo>,
  ): Promise<SubscriptionInfo | null> {
    if (cache.has(externalSubscriptionId)) {
      return cache.get(externalSubscriptionId) ?? null
    }

    const link = await trx
      .selectFrom('provider_subscription_links')
      .select(['subscription_id'])
      .where('provider', '=', 'stripe')
      .where('external_subscription_id', '=', externalSubscriptionId)
      .executeTakeFirst()

    if (!link) {
      cache.set(externalSubscriptionId, null as unknown as SubscriptionInfo)
      return null
    }

    const subscriptionRow = await trx
      .selectFrom('subscriptions')
      .select(['subscription_id', 'quantity', 'current_period_start', 'current_period_end', 'status'])
      .where('subscription_id', '=', link.subscription_id)
      .executeTakeFirst()

    const result: SubscriptionInfo = {
      subscriptionId: String(link.subscription_id),
      quantity: subscriptionRow?.quantity ?? null,
      currentPeriodStart: subscriptionRow?.current_period_start ?? null,
      currentPeriodEnd: subscriptionRow?.current_period_end ?? null,
      status: subscriptionRow?.status ?? null,
    }

    if (priceInfo?.catalogPriceId) {
      const catalogPriceKey = priceInfo.catalogPriceId
      const itemRow = await trx
        .selectFrom('subscription_items')
        .select(['quantity'])
        .where('subscription_id', '=', link.subscription_id)
        .where('catalog_price_id', '=', catalogPriceKey)
        .executeTakeFirst()

      if (itemRow && Number.isFinite(itemRow.quantity)) {
        result.quantity = Number(itemRow.quantity)
      }
    }

    cache.set(externalSubscriptionId, result)
    return result
  }
}

function readCatalogPriceId(metadata: Record<string, unknown>): string | null {
  if (!metadata) return null
  const raw = metadata.catalog_price_id ?? metadata.catalogPriceId
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(Math.floor(raw))
  if (typeof raw === 'bigint') return raw.toString()
  return null
}

function extractOverrides(metadata: Record<string, unknown> | null): GrantBindingOverride[] {
  if (!metadata) return []
  const raw = metadata.grants
  if (!raw) return []
  if (Array.isArray(raw)) {
    const overrides: GrantBindingOverride[] = []
    for (const candidate of raw) {
      const override = normalizeGrantBindingOverride(candidate)
      if (override) overrides.push(override)
    }
    return overrides
  }
  if (typeof raw === 'object') {
    const override = normalizeGrantBindingOverride(raw)
    return override ? [override] : []
  }
  return []
}

function extractCampaignBindings(metadata: Record<string, unknown> | null | undefined): CampaignBinding[] {
  if (!metadata || typeof metadata !== 'object') return []
  const raw = (metadata as Record<string, unknown>).grants
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  const bindings: CampaignBinding[] = []
  for (const candidate of list) {
    const override = normalizeGrantBindingOverride(candidate)
    if (!override) continue
    const record = candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : {}
    const windowStart = parseDateMaybe(
      record.binding_window_start ??
        record.bindingWindowStart ??
        record.window_start ??
        record.windowStart,
    )
    const windowEnd = parseDateMaybe(
      record.binding_window_end ??
        record.bindingWindowEnd ??
        record.window_end ??
        record.windowEnd,
    )
    bindings.push({
      programCode: override.programCode,
      override,
      windowStart: windowStart ?? undefined,
      windowEnd,
    })
  }
  return bindings
}

function stripGrantBindings(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const base = toRecord(metadata)
  const next = { ...base }
  delete (next as Record<string, unknown>).grants
  return next
}

function toRecord(raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw
  return {}
}

function parseDateMaybe(raw: unknown): Date | null {
  if (!raw) return null
  if (raw instanceof Date && !Number.isNaN(raw.valueOf())) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const d = new Date(raw)
    return Number.isNaN(d.valueOf()) ? null : d
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const d = new Date(trimmed)
    return Number.isNaN(d.valueOf()) ? null : d
  }
  return null
}

function parsePositiveInteger(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw)
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const parsed = Number.parseInt(trimmed, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

function extractStripeSubscriptionId(sourceRef: string): string | null {
  if (!sourceRef || typeof sourceRef !== 'string') return null
  if (!sourceRef.startsWith('stripe.subscription:')) return null
  const parts = sourceRef.split(':')
  return parts.length >= 2 ? parts[1] : null
}

type PeriodComputationInput = {
  program: GrantProgramRow
  assignment: GrantAssignmentRow
  now: Date
  maxPeriods: number
}

function computePeriodReferences(input: PeriodComputationInput): Date[] {
  const { program, assignment, now, maxPeriods } = input
  const periods: Date[] = []
  const maxCount = Math.max(1, maxPeriods)
  const bindingStart = new Date(assignment.window_start)
  if (bindingStart > now) {
    return periods
  }
  const cadence = program.cadence ?? 'monthly'
  const issueAnchor = program.issue_anchor ?? 'calendar_start'

  let cursor: Date | null
  switch (cadence) {
    case 'daily':
      cursor = startOfUtcDay(bindingStart)
      break
    case 'weekly': {
      cursor = startOfUtcWeek(bindingStart)
      break
    }
    case 'quarterly': {
      const m = bindingStart.getUTCMonth()
      const qStart = Math.floor(m / 3) * 3
      cursor = new Date(Date.UTC(bindingStart.getUTCFullYear(), qStart, 1, 0, 0, 0, 0))
      break
    }
    case 'once':
      cursor = bindingStart
      break
    case 'yearly': {
      const anchor = issueAnchor === 'binding_start' ? bindingStart : startOfUtcYear(bindingStart)
      cursor = anchor
      break
    }
    case 'monthly':
    default:
      if (issueAnchor === 'binding_start') {
        cursor = new Date(bindingStart)
      } else {
        const anchor = bindingStart <= now ? bindingStart : now
        cursor = startOfUtcMonth(anchor)
      }
      break
  }

  if (!cursor) return periods

  let count = 0
  const limit = now

  while (cursor <= limit && count < maxCount) {
    periods.push(new Date(cursor))
    count += 1
    if (cadence === 'daily') {
      cursor = addDays(cursor, 1)
    } else if (cadence === 'weekly') {
      cursor = addWeeks(cursor, 1)
    } else if (cadence === 'quarterly') {
      cursor = addMonths(cursor, 3)
    } else if (cadence === 'once') {
      break
    } else if (cadence === 'yearly') {
      cursor = addYears(cursor, 1)
    } else {
      cursor = addMonths(cursor, 1)
    }
  }

  if (cadence !== 'once' && periods.length === 0) {
    periods.push(new Date(cursor))
  }

  return periods
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0))
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + months,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ))
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0))
}

function addDays(date: Date, days: number): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + days,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ))
}

function startOfUtcWeek(date: Date): Date {
  const day = date.getUTCDay() || 7
  const diff = day - 1
  const startDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0))
  startDate.setUTCDate(startDate.getUTCDate() - diff)
  return startDate
}

function addWeeks(date: Date, weeks: number): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + weeks * 7,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ))
}

function startOfUtcYear(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0))
}

function addYears(date: Date, years: number): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear() + years,
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ))
}
