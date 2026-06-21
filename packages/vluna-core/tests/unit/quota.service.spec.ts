import { describe, it, expect } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/types/database.js'
import { QuotaService } from '../../src/features/gate/services/quota.service.js'
import { DEFAULT_BUNDLE_KEY } from '../../src/services/realm.service.js'

type BundleRow = {
  bundle_id: string
  realm_id: string
  bundle_key: string
  status: 'active' | 'disabled'
}

type PolicyRow = {
  policy_id: string
  realm_id: string
  bundle_id: string
  name: string
  policy_name?: string
  feature_code: string
  kind: 'quota' | 'rate'
  unit: string
  window_sec: number
  limit_count: number | null
  limit_minor: number | null
  status: 'default' | 'assignable' | 'ceiling' | 'disabled'
  enforcement_mode: 'optimistic' | 'reserve'
  metadata: Record<string, unknown> | null
}

type FeatureRow = { realm_id: string; feature_code: string }
type BillingAccountRow = { billing_account_id: string; realm_id: string }

type SelectState = {
  table: string
  rows: Array<Record<string, unknown>>
  filters: Array<(row: Record<string, unknown>) => boolean>
}

function makeSelect(
  table: string,
  rows: Array<Record<string, unknown>>,
  bundleRows: BundleRow[],
  joins: Array<{ rows: Array<Record<string, unknown>>; leftCol: string; rightCol: string }> = [],
): {
  select: (_cols?: unknown) => unknown
  where: (col: string, op: string, val: unknown) => unknown
  innerJoin: (table: string, left: string, right: string) => unknown
  execute: () => unknown[]
  executeTakeFirst: () => unknown
} {
  const state: SelectState = { table, rows, filters: [] }
  const joinDefs = [...joins]
  const getColumnValue = (row: Record<string, unknown>, column: string): unknown => {
    const key = column.includes('.') ? column.split('.')[1] : column
    return row[key]
  }
  const buildRows = () =>
    joinDefs.reduce<Array<Record<string, unknown>>>((acc, join) => {
      return acc.flatMap((row) => {
        const rightMatches = join.rows.filter(
          (jr) => getColumnValue(jr, join.leftCol) === getColumnValue(row, join.rightCol),
        )
        return rightMatches.map((jr) => ({ ...row, ...jr }))
      })
    }, state.rows.slice())
  const applyFilters = () =>
    buildRows().filter((row) =>
      state.filters.every((fn) => fn(row)),
    )
  const where = (column: string, op: string, value: unknown) => {
    state.filters.push((row) => {
      const val = getColumnValue(row, column)
      if (op === 'in') {
        return Array.isArray(value) && value.includes(val)
      }
      if (op === '<>') {
        return val !== value
      }
      return val === value
    })
    return builder
  }
  const builder = {
    select() {
      return this
    },
    where,
    innerJoin(joinTable: string, leftCol: string, rightCol: string) {
      const targetRows = joinTable.startsWith('gate_policy_bundles') ? bundleRows : []
      joinDefs.push({ rows: targetRows, leftCol, rightCol })
      return this
    },
    execute() {
      return applyFilters()
    },
    executeTakeFirst() {
      const result = applyFilters()
      return result[0]
    },
  }
  return builder
}

function makeFakeDb(): Kysely<Database> {
  const bundles: BundleRow[] = [
    { bundle_id: 'b1', realm_id: 'r1', bundle_key: DEFAULT_BUNDLE_KEY, status: 'active' },
  ]
  const policies: PolicyRow[] = [
    {
      policy_id: 'p1',
      realm_id: 'r1',
      bundle_id: 'b1',
      name: 'quota-1h',
      feature_code: 'feat1',
      kind: 'quota',
      unit: 'unit',
      window_sec: 3600,
      limit_count: null,
      limit_minor: 100,
      status: 'default',
      enforcement_mode: 'optimistic',
      metadata: {},
      // convenience copy for the alias used in the service select
      policy_name: 'quota-1h',
    },
  ]
  const features: FeatureRow[] = [{ realm_id: 'r1', feature_code: 'feat1' }]
  const accounts: BillingAccountRow[] = [{ billing_account_id: 'ba1', realm_id: 'r1' }]

  return {
    selectFrom(table: string) {
      if (table === 'gate_policy_bundles') return makeSelect(table, bundles, bundles)
      if (table === 'gate_policies as p' || table === 'gate_policies') return makeSelect(table, policies, bundles)
      if (table === 'features') return makeSelect(table, features, bundles)
      if (table === 'billing_accounts') return makeSelect(table, accounts, bundles)
      return makeSelect(table, [], bundles)
    },
  } as unknown as Kysely<Database>
}

describe('QuotaService.loadActivePolicyWindows bundle fallback', { tags: ['unit'] }, () => {
  it('falls back to default bundle when no user bundle is provided', async () => {
    const svc = new QuotaService()
    const db = makeFakeDb()
    const windows = await svc.loadActivePolicyWindows(db, 'r1', 'ba1', 'bu1', new Date())
    expect(windows).toHaveLength(1)
    const win = windows[0]
    expect(win.featureCode).toBe('feat1')
    expect(win.policyName).toBe('quota-1h')
    expect(win.windowMs).toBe(3600 * 1000)
  })
})
