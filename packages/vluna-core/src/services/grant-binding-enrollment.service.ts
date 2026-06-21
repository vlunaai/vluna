import { Injectable, Logger } from '@nestjs/common'
import type { Kysely, Transaction } from 'kysely'
import { db, setRlsSession } from '../db/index.js'
import type { Database } from '../types/database.js'
import type { GrantProgramRow } from './grant-issuance.service.js'
import { ensureGrantAssignment } from './grant-issuance.service.js'

type BillingAccountRow = {
  billing_account_id: string
  realm_id: string
}

type SubscriptionGroupRow = {
  subscription_id: string
  subscription_group_id: string
  group_key: string | null
  title: string | null
  status: string | null
  quantity: number | null
  current_period_start: Date | null
  current_period_end: Date | null
}

type EligibilityPlan = {
  sourceKind: Database['grant_assignments']['source_kind']
  sourceRef: string
  windowStart: Date
  windowEnd: Date | null
  metadata: Record<string, unknown>
}

type EnsureBindingsParams = {
  billingAccountIds: string[]
}

type EnsureBindingsResult = {
  processedAccounts: number
  processedProfiles: number
  createdOrUpdatedBindings: number
  skippedProfiles: number
}

type GrantProfileEligibility =
  | { kind: 'manual' }
  | { kind: 'all_accounts' }
  | { kind: 'subscription_group'; subscriptionGroupId?: string; groupKey?: string }

const AUTO_SOURCE_PREFIX = 'eligibility'
const SUPPORTED_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing'])

@Injectable()
export class GrantBindingEnrollmentService {
  private readonly logger = new Logger(GrantBindingEnrollmentService.name)

  async ensureBindings(params: EnsureBindingsParams): Promise<EnsureBindingsResult> {
    const billingAccountIds = Array.from(new Set(params.billingAccountIds)).filter((id) => typeof id === 'string' && id.trim().length > 0)
    if (billingAccountIds.length === 0) {
      return {
        processedAccounts: 0,
        processedProfiles: 0,
        createdOrUpdatedBindings: 0,
        skippedProfiles: 0,
      }
    }

    const handle = db()

    const accounts = await handle
      .selectFrom('billing_accounts')
      .select(['billing_account_id', 'realm_id'])
      .where('billing_account_id', 'in', billingAccountIds)
      .execute()

    if (accounts.length === 0) {
      return {
        processedAccounts: 0,
        processedProfiles: 0,
        createdOrUpdatedBindings: 0,
        skippedProfiles: 0,
      }
    }

    const accountsByRealm = new Map<string, BillingAccountRow[]>()
    for (const acct of accounts) {
      const realmId = String(acct.realm_id)
      if (!accountsByRealm.has(realmId)) {
        accountsByRealm.set(realmId, [])
      }
      accountsByRealm.get(realmId)?.push({
        billing_account_id: String(acct.billing_account_id),
        realm_id: realmId,
      })
    }

    let processedProfiles = 0
    let bindingsTouched = 0
    let skippedProfiles = 0

    const now = new Date()

    for (const [realmId, realmAccounts] of accountsByRealm.entries()) {
      const profiles = await this.loadEligibleProfiles(handle, realmId)
      if (profiles.length === 0) {
        continue
      }

      for (const account of realmAccounts) {
        const result = await handle.transaction().execute(async (trx: Transaction<Database>) => {
          await setRlsSession(trx, {
            realmId,
            billingAccountId: account.billing_account_id,
            isRealmAdmin: true,
          })

          const subs = await this.loadActiveSubscriptions(trx, account.billing_account_id)
          const billingUserIds = await this.loadActiveBillingUserIds(trx, account.billing_account_id)
          let localBindings = 0
          let localProcessed = 0
          let localSkipped = 0
          if (billingUserIds.length === 0) {
            return { localBindings, localProcessed, localSkipped: profiles.length }
          }

          for (const profile of profiles) {
            const eligibility = parseEligibility(profile)
            if (eligibility.kind === 'manual') {
              localSkipped += 1
              continue
            }

            const plan = await this.buildPlanForAccount(trx, {
              account,
              profile,
              eligibility,
              subscriptions: subs,
              now,
            })

            if (!plan) {
              localSkipped += 1
              continue
            }

            for (const billingUserId of billingUserIds) {
              await ensureGrantAssignment(trx, {
                billingUserId,
                billingAccountId: account.billing_account_id,
                programId: String(profile.program_id),
                sourceKind: plan.sourceKind,
                sourceRef: plan.sourceRef,
                windowStart: plan.windowStart,
                windowEnd: plan.windowEnd,
                metadata: plan.metadata,
                decidedAt: now,
              })
              localBindings += 1
            }

            localProcessed += 1
          }

          return { localBindings, localProcessed, localSkipped }
        })

        bindingsTouched += result.localBindings
        processedProfiles += result.localProcessed
        skippedProfiles += result.localSkipped
      }
    }

    return {
      processedAccounts: accounts.length,
      processedProfiles,
      createdOrUpdatedBindings: bindingsTouched,
      skippedProfiles,
    }
  }

  private async loadEligibleProfiles(trxOrDb: Kysely<Database>, realmId: string): Promise<GrantProgramRow[]> {
    const rows = await trxOrDb
      .selectFrom('grant_programs')
      .selectAll()
      .where('realm_id', '=', realmId)
      .where('active', '=', true)
      .execute()

    return rows.filter((row) => parseEligibility(row).kind !== 'manual')
  }

  private async loadActiveSubscriptions(trx: Transaction<Database>, billingAccountId: string): Promise<SubscriptionGroupRow[]> {
    const rows = await trx
      .selectFrom('subscriptions as cs')
      .innerJoin('subscription_groups as csg', 'csg.subscription_group_id', 'cs.subscription_group_id')
      .select([
        'cs.subscription_id as subscription_id',
        'cs.subscription_group_id',
        'csg.group_key',
        'csg.title',
        'cs.status',
        'cs.quantity',
        'cs.current_period_start',
        'cs.current_period_end',
      ])
      .where('cs.billing_account_id', '=', billingAccountId)
      .execute()

    return rows
      .filter((row) => SUPPORTED_SUBSCRIPTION_STATUSES.has(String(row.status ?? '').trim()))
      .map((row) => ({
        subscription_id: String(row.subscription_id),
        subscription_group_id: String(row.subscription_group_id),
        group_key: row.group_key ? String(row.group_key) : null,
        title: row.title ? String(row.title) : null,
        status: row.status ? String(row.status) : null,
        quantity: row.quantity ?? null,
        current_period_start: row.current_period_start ?? null,
        current_period_end: row.current_period_end ?? null,
      }))
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

  private async buildPlanForAccount(
    trx: Transaction<Database>,
    params: {
      account: BillingAccountRow
      profile: GrantProgramRow
      eligibility: GrantProfileEligibility
      subscriptions: SubscriptionGroupRow[]
      now: Date
    },
  ): Promise<EligibilityPlan | null> {
    const { profile, eligibility, subscriptions, now } = params

    if (eligibility.kind === 'all_accounts') {
      return {
        sourceKind: 'internal.catalog',
        sourceRef: this.buildSourceRef(profile, eligibility.kind),
        windowStart: now,
        windowEnd: null,
        metadata: this.buildMetadata(profile, eligibility, {
          reason: 'all_accounts',
        }),
      }
    }

    if (eligibility.kind === 'subscription_group') {
      const match = matchSubscription(subscriptions, eligibility)
      if (!match) {
        return null
      }

      const windowStart = match.current_period_start ?? now
      const windowEnd = match.current_period_end ?? null

      return {
        sourceKind: 'internal.catalog',
        sourceRef: this.buildSourceRef(profile, eligibility.kind, match.subscription_group_id),
        windowStart,
        windowEnd,
        metadata: this.buildMetadata(profile, eligibility, {
          reason: 'subscription_group',
          subscription_group_id: match.subscription_group_id,
          subscription_id: match.subscription_id,
          subscription_group_key: match.group_key,
        }),
      }
    }

    return null
  }

  private buildSourceRef(profile: GrantProgramRow, kind: string, suffix?: string | null): string {
    const cleanCode = String(profile.program_code || profile.program_id)
    const parts = [AUTO_SOURCE_PREFIX, kind, cleanCode]
    if (suffix) parts.push(String(suffix))
    return parts.join(':')
  }

  private buildMetadata(
    profile: GrantProgramRow,
    eligibility: GrantProfileEligibility,
    extras: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      grant_program_code: profile.program_code,
      eligibility_kind: eligibility.kind,
      eligibility_payload: (profile.eligibility_payload as Record<string, unknown> | null) ?? {},
      ...extras,
    }
  }
}

function parseEligibility(profile: GrantProgramRow): GrantProfileEligibility {
  const rawKind = String(profile.eligibility_kind ?? 'manual').trim()
  const payload = (profile.eligibility_payload as Record<string, unknown> | null) ?? {}

  switch (rawKind) {
    case 'all_accounts':
      return { kind: 'all_accounts' }
    case 'subscription_group':
      return {
        kind: 'subscription_group',
        subscriptionGroupId: valueToString(payload.subscription_group_id),
        groupKey: valueToString(payload.group_key),
      }
    case 'manual':
    default:
      return { kind: 'manual' }
  }
}

function matchSubscription(
  subscriptions: SubscriptionGroupRow[],
  eligibility: Extract<GrantProfileEligibility, { kind: 'subscription_group' }>,
): SubscriptionGroupRow | null {
  if (subscriptions.length === 0) return null

  return subscriptions.find((sub) => {
    if (eligibility.subscriptionGroupId && sub.subscription_group_id === eligibility.subscriptionGroupId) {
      return true
    }
    if (eligibility.groupKey && sub.group_key === eligibility.groupKey) {
      return true
    }
    return false
  }) ?? null
}

function valueToString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Math.floor(value)) : undefined
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return undefined
}
