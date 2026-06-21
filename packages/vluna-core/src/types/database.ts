// Minimal Database type to annotate Kysely handle used in RequestContext.
// Add tables/columns here as needed.
import type { ColumnType, Generated } from 'kysely'

export type LedgerComponentKind = 'charge' | 'cost' | 'tax' | 'rebate' | 'fee' | 'subsidy' | 'reserve' | 'transfer'

export interface Database {
  audit_logs: {
    audit_id: string
    occurred_at: ColumnType<Date, Date | undefined, never>
    scope_type: 'realm' | 'platform'
    realm_id: ColumnType<string | null, string | null | undefined, never>
    actor_type: 'user' | 'organization' | 'service_key' | 'dat_session' | 'cli' | 'platform' | 'system'
    actor_id: ColumnType<string | null, string | null | undefined, never>
    actor_display: ColumnType<string | null, string | null | undefined, never>
    auth_scheme: ColumnType<string | null, string | null | undefined, never>
    action: string
    target_type: ColumnType<string | null, string | null | undefined, never>
    target_id: ColumnType<string | null, string | null | undefined, never>
    operation_id: ColumnType<string | null, string | null | undefined, never>
    method: string
    path: string
    route_template: ColumnType<string | null, string | null | undefined, never>
    status: 'success' | 'failure'
    http_status: number
    error_code: ColumnType<string | null, string | null | undefined, never>
    trace_id: ColumnType<string | null, string | null | undefined, never>
    params_json: ColumnType<unknown | null, unknown | null | undefined, never>
    query_json: ColumnType<unknown | null, unknown | null | undefined, never>
    body_json_redacted: ColumnType<unknown | null, unknown | null | undefined, never>
    response_json_redacted: ColumnType<unknown | null, unknown | null | undefined, never>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, never>
    created_at: Generated<Date>
  }
  feature_families: {
    feature_family_id: Generated<string>
    realm_id: string
    feature_family_code: string
    is_fallback: ColumnType<boolean, boolean | undefined, boolean | undefined>
    name: string
    description: string
    entitlement_required: ColumnType<boolean, boolean | undefined, boolean | undefined>
    active: ColumnType<boolean, boolean | undefined, boolean | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  realms: {
    realm_id: string
    name: string
    status: 'active' | 'suspended' | 'deleted'
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  cloud_realm_members: {
    realm_id: string
    kind: 'organization' | 'user'
    subject_id: string
    role: 'owner' | 'admin' | 'member'
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  cloud_owner_accounts: {
    owner_account_id: string
    owner_kind: 'organization' | 'user'
    owner_subject_id: string
    admin_plane_principal_id: string
    billing_account_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    status: ColumnType<'active' | 'disabled', 'active' | 'disabled' | undefined, 'active' | 'disabled' | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  currencies: {
    code: string
    kind: 'fiat' | 'credit' | 'crypto' | 'token' | 'other'
    scale: number
  }
  billing_accounts: {
    billing_account_id: Generated<string>
    realm_id: string
    billing_principal_id: string
    seat_limit: ColumnType<number | null, number | null | undefined, number | null | undefined>
    seat_limit_source: ColumnType<string | null, string | null | undefined, string | null | undefined>
    seat_limit_updated_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  billing_users: {
    billing_user_id: Generated<string>
    realm_id: string
    billing_account_id: string
    business_user_id: string
    status: ColumnType<'active' | 'disabled' | 'deleted', 'active' | 'disabled' | 'deleted' | undefined, 'active' | 'disabled' | 'deleted' | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  billing_account_billing_details: {
    billing_account_id: string
    billing_email: ColumnType<string | null, string | null | undefined, string | null | undefined>
    billing_email_lc: Generated<string | null>
    legal_name: ColumnType<string | null, string | null | undefined, string | null | undefined>
    entity_type: ColumnType<'individual' | 'company' | 'unknown' | null, 'individual' | 'company' | 'unknown' | null | undefined, 'individual' | 'company' | 'unknown' | null | undefined>
    default_address: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null | undefined, Record<string, unknown> | null | undefined>
    tax_ids: ColumnType<Record<string, unknown>[] | null, Record<string, unknown>[] | null | undefined, Record<string, unknown>[] | null | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    last_updated_by: ColumnType<'user' | 'provider' | 'ops' | 'system', 'user' | 'provider' | 'ops' | 'system' | undefined, 'user' | 'provider' | 'ops' | 'system' | undefined>
    source_updated_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  billing_plans: {
    plan_id: Generated<string>
    realm_id: string
    plan_code: string
    name: string
    kind: 'base' | 'addon' | 'promo'
    priority: number
    active: ColumnType<boolean, boolean | undefined, boolean | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  billing_plan_assignments: {
    assignment_id: Generated<string>
    billing_account_id: string
    assignment_scope: ColumnType<'account' | 'user', 'account' | 'user', 'account' | 'user'>
    billing_user_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    plan_id: string
    subscription_item_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    source_kind: 'signup.default' | 'provider.subscription_item' | 'provider.subscription' | 'ops.manual' | 'ops.campaign'
    source_ref: string
    window_start: Date
    window_end: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    valid_range: ColumnType<unknown, unknown, unknown>
    status: 'active' | 'paused' | 'canceled' | 'expired'
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  billing_plan_entitlements: {
    bpe_id: Generated<string>
    plan_id: string
    feature_family_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    feature_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    effect: 'allow' | 'deny'
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  // Catalog (realm-scoped visibility)
  catalog_products: {
    catalog_product_id: Generated<string>
    realm_id: string
    product_code: string
    provider: string
    provider_product_id: string
    kind: 'subscription' | 'credit'
    status: 'active' | 'archived' | 'draft'
    display_priority: Generated<number>
    presentation_config: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    name: string
    default_currency: string
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
  }
  catalog_prices: {
    catalog_price_id: Generated<string>
    realm_id: string
    catalog_product_id: string
    price_code: string
    provider_price_id: string
    status: 'active' | 'archived'
    currency: string
    unit_amount: number
    recurring_interval: 'month' | 'year' | null
    recurring_count: number | null
    display_priority: Generated<number>
    // DEFAULT '{}'::jsonb, allow omitting on insert
    metadata: ColumnType<unknown | null, unknown | undefined, unknown | null | undefined>
    subscription_group_id: string | null
    subscription_group_key: string | null
    created_at: Generated<Date>
  }
  subscription_groups: {
    subscription_group_id: Generated<string>
    realm_id: string
    group_key: string
    title: string
    is_stackable: boolean
    is_exclusive: boolean
  }
  // Wallet
  ledger_accounts: {
    ledger_id: Generated<string>
    billing_user_id: string
    billing_account_id: string
    currency_code: string
    balance_xusd: string
    updated_at: Generated<Date>
  }
  ledger_entries: {
    entry_id: Generated<string>
    ledger_id: string
    billing_user_id: string
    billing_account_id: string
    amount_xusd: ColumnType<string, string | number, string | number>
    reason: 'adjustment' | 'purchase' | 'consumption' | 'transfer' | 'refund' | 'reversal'
    source_ref: string | null
    econ_component_kind: ColumnType<LedgerComponentKind, LedgerComponentKind | undefined, LedgerComponentKind | undefined>
    econ_component_code: ColumnType<string | null, string | null | undefined, string | null | undefined>
    component_version: ColumnType<number, number | undefined, number | undefined>
    entry_group_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    idempotency_key: string
    created_at: Generated<Date>
  }
  ledger_entry_labels: {
    entry_id: string
    label_key: string
    value_text: string | null
    value_uuid: string | null
    value_bool: boolean | null
    value_number: ColumnType<string | null, number | string | null | undefined, number | string | null | undefined>
    created_at: Generated<Date>
  }
  grant_programs: {
    program_id: Generated<string>
    realm_id: string
    program_code: string
    name: ColumnType<string | null, string | null | undefined, string | null | undefined>
    active: ColumnType<boolean, boolean | undefined, boolean | undefined>
    cadence: 'once' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'billing_period'
    issue_anchor: 'calendar_start' | 'binding_start' | 'first_use'
    amount_xusd: ColumnType<string, string | number, string | number>
    window_kind: 'period' | 'fixed' | 'forever' | 'relative_duration'
    window_default_seconds: ColumnType<number | null, number | null | undefined, number | null | undefined>
    priority: ColumnType<number, number | undefined, number | undefined>
    on_ledger: ColumnType<boolean, boolean | undefined, boolean | undefined>
    issuance_mode: 'eager' | 'lazy' | 'hybrid'
    periodic_accounting: ColumnType<boolean, boolean | undefined, boolean | undefined>
    accrual_mode: ColumnType<'full_at_period_start' | 'earn_daily' | null, 'full_at_period_start' | 'earn_daily' | null | undefined, 'full_at_period_start' | 'earn_daily' | null | undefined>
    eligibility_kind: ColumnType<'manual' | 'all_accounts' | 'subscription_group', 'manual' | 'all_accounts' | 'subscription_group' | undefined, 'manual' | 'all_accounts' | 'subscription_group' | undefined>
    eligibility_payload: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  grant_campaigns: {
    campaign_id: Generated<string>
    realm_id: string
    name: string
    status: 'scheduled' | 'active' | 'paused' | 'ended'
    window_start: ColumnType<Date, Date | undefined, Date | undefined>
    window_end: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    target_filter: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  grant_assignments: {
    assignment_id: Generated<string>
    billing_user_id: string
    billing_account_id: string
    program_id: string
    billing_plan_assignment_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    campaign_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    source_kind:
      | 'provider.subscription'
      | 'provider.subscription_item'
      | 'provider.one_time'
      | 'wallet.cash'
      | 'ops.manual'
      | 'internal.catalog'
      | 'ops.campaign'
      | 'billing_plan_assignment'
    source_ref: string
    window_start: Date
    window_end: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    valid_range: ColumnType<unknown, unknown, unknown>
    status: 'active' | 'paused' | 'canceled' | 'expired'
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  ledger_grants: {
    grant_id: Generated<string>
    billing_user_id: string
    billing_account_id: string
    ledger_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    assignment_id: string
    program_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    period_start: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    period_end: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    alloc_seq: ColumnType<number, number | undefined, number | undefined>
    idempotency_key: ColumnType<string | null, string | null | undefined, string | null | undefined>
    source_kind: ColumnType<string | null, string | null | undefined, string | null | undefined>
    source_ref: ColumnType<string | null, string | null | undefined, string | null | undefined>
    on_ledger: ColumnType<boolean, boolean | undefined, boolean | undefined>
    issuance_status: 'ready' | 'active' | 'suspended' | 'pending_close' | 'closed' | 'canceled'
    kind: 'grant' | 'sponsorship' | 'promo' | 'credit' | 'cash' | 'wallet' | 'rollover' | 'nonexpiring' | 'fallback' | 'other'
    window_start: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    window_end: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    priority: ColumnType<number, number | undefined, number | undefined>
    amount_xusd: ColumnType<string, string | number, string | number>
    cost_xusd: ColumnType<string, string | number, string | number>
    posted_consumed_xusd: ColumnType<string, string | number, string | number>
    pending_reserved_xusd: ColumnType<string, string | number, string | number>
    source_entry_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    closure_kind: ColumnType<'forfeit' | 'refund' | 'carryover' | 'none' | null, 'forfeit' | 'refund' | 'carryover' | 'none' | null | undefined, 'forfeit' | 'refund' | 'carryover' | 'none' | null | undefined>
    closure_entry_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    closed_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    closed_remaining_xusd: ColumnType<string | null, string | number | null | undefined, string | number | null | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  service_api_keys: {
    key_id: string
    status: string
    allowed_realms: ColumnType<string[], string[] | undefined, string[] | undefined>
    allowed_accounts: ColumnType<string[], string[] | undefined, string[] | undefined>
    scopes: ColumnType<string[], string[] | undefined, string[] | undefined>
    kdf_alg: 'HMAC-SHA256' | 'HKDF-SHA256'
    kdf_salt: Buffer
    kdf_version: number
    env_tag: string
    created_at: Generated<Date>
    expires_at: Date | null
    last_used_at: Date | null
  }
  // Usage catalog
  meters: {
    meter_id: Generated<string>
    realm_id: string
    meter_code: string
    semantic_kind: 'activity' | 'outcome'
    unit: string
    scale: number
    rounding: 'round' | 'floor' | 'ceil' | 'truncate'
    active: Generated<boolean>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  billing_events: {
    event_id: Generated<string>
    realm_id: string
    billing_user_id: string
    billing_account_id: string
    semantic_kind: 'activity' | 'outcome'
    occurred_at: Date
    event_type: string
    subject_ref: string | null
    request_hash: string
    payload: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
  }
  billing_contracts: {
    contract_id: Generated<string>
    realm_id: string
    billing_account_id: string
    status: 'active' | 'disabled'
    effective_at: Date
    name: string | null
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  contract_terms: {
    contract_id: string
    kind: string
    term_key: string
    value_json: ColumnType<unknown, unknown, unknown>
    effective_at: Date
    created_at: Generated<Date>
  }
  billing_event_labels: {
    event_id: string
    label_key: string
    value_text: string | null
    value_uuid: string | null
    value_bool: boolean | null
    value_number: ColumnType<string | null, number | string | null | undefined, number | string | null | undefined>
    created_at: Generated<Date>
  }
  billing_event_processing: {
    billing_event_id: string
    realm_id: string
    billing_user_id: string
    billing_account_id: string
    policy_id: string
    policy_version: string
    status: 'pending' | 'processing' | 'processed' | 'skipped' | 'skipped_no_policy' | 'failed' | 'quarantined'
    attempts: ColumnType<number, number | undefined, number | undefined>
    last_error_code: string | null
    last_error_message: string | null
    next_retry_at: Date | null
    locked_by: string | null
    locked_at: Date | null
    processed_at: Date | null
    result_json: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  billing_event_ratings: {
    realm_id: string
    billing_user_id: string
    billing_account_id: string
    billing_event_id: string
    rating_id: string
    link_kind: 'billed' | 'adjustment' | 'reversal' | 'shadow'
    policy_id: string
    policy_version: string
    output_index: ColumnType<number, number | undefined, number | undefined>
    engine_run_id: string | null
    idempotency_key: string | null
    created_at: Generated<Date>
  }
  billing_ratings_aggregation_runs: {
    run_id: Generated<string>
    realm_id: string
    billing_user_id: string
    billing_account_id: string
    contract_id: string | null
    policy_id: string
    policy_version: string
    window_kind: 'day'
    window_start: Date
    window_end: Date
    group_key: string
    aggregated_input_count: ColumnType<string | null, number | string | null | undefined, number | string | null | undefined>
    aggregated_quantity_minor: ColumnType<string | null, number | string | null | undefined, number | string | null | undefined>
    aggregated_metrics: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    rating_id: string
    idempotency_key: string
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  event_rating_policies: {
    realm_id: string
    policy_id: string
    name: string
    status: 'active' | 'disabled'
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  event_rating_policy_versions: {
    realm_id: string
    policy_id: string
    policy_version: string
    status: 'draft' | 'active' | 'deprecated'
    effective_at: Date
    dsl_json: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
    dsl_hash: string
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  features: {
    feature_id: Generated<string>
    realm_id: string
    feature_family_id: string
    feature_code: string
    name: string
    description: string
    active: Generated<boolean>
    entitlement_required: ColumnType<boolean | null, boolean | null | undefined, boolean | null | undefined>
    default_budget_strategy: 'auto' | 'hot' | 'cold'
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  feature_meters: {
    feature_id: string
    meter_id: string
    is_primary: ColumnType<boolean, boolean | undefined, boolean | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  provider_events: {
    provider_event_id: Generated<string>
    billing_account_id: string
    provider: string
    external_event_id: string
    event_type: string
    status: 'received' | 'processed' | 'skipped' | 'failed'
    received_at: Generated<Date>
    processed_at: Date | null
    payload: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  }
  // Provider snapshots & reconciliation
  provider_state_snapshots: {
    snapshot_id: Generated<string>
    billing_account_id: string
    provider: string
    entity_id: string
    entity_kind: string
    fetched_at: Generated<Date>
    json: unknown
  }
  reconciliations: {
    id: Generated<string>
    billing_account_id: string
    kind: 'usage_mismatch' | 'status_mismatch' | 'invoice_total_mismatch'
    status: 'pending' | 'failed' | 'resolved'
    fingerprint: string
    diff: unknown
    provider_state_snapshot_id: string | null
    created_at: Generated<Date>
    resolved_at: Date | null
  }
  subscriptions: {
    subscription_id: Generated<string>
    billing_account_id: string
    subscription_group_id: string
    status: string
    quantity: number
    current_period_start: Date
    current_period_end: Date
    cancel_at: Date | null
    cancel_at_period_end: boolean
    policy_snapshot: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    meta_snapshot: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  subscription_items: {
    subscription_item_id: Generated<string>
    subscription_id: string
    catalog_price_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    quantity: number
    created_at: Generated<Date>
  }
  provider_subscription_links: {
    provider: string
    external_subscription_id: string
    subscription_id: string
    created_at: Generated<Date>
  }
  billing_periods: {
    billing_period_id: Generated<string>
    realm_id: string
    billing_account_id: string
    period_start: Date
    period_end: Date
    grace_window_seconds: number
    source: 'provider.subscription' | 'binding' | 'plan' | 'realm_default' | 'manual'
    source_ref: string | null
    source_subscription_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    source_period_start: ColumnType<Date | null, Date | string | null | undefined, Date | string | null | undefined>
    source_period_end: ColumnType<Date | null, Date | string | null | undefined, Date | string | null | undefined>
    status: 'open' | 'frozen' | 'closed'
    frozen_at: Date | null
    closed_at: Date | null
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  billing_period_closeouts: {
    billing_period_closeout_id: Generated<string>
    realm_id: string
    billing_account_id: string
    billing_period_id: string
    mode: 'waive' | 'invoice' | 'manual'
    status: 'running' | 'completed' | 'failed'
    overage_grant_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    totals_xusd: ColumnType<string, string | number, string | number>
    allocation_count: number
    started_at: Date
    completed_at: Date | null
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  billing_payments: {
    billing_payment_id: Generated<string>
    realm_id: string
    billing_account_id: string
    billing_invoice_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    provider: ColumnType<string | null, string | null | undefined, string | null | undefined>
    provider_payment_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    provider_customer_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    provider_invoice_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    provider_subscription_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    method: ColumnType<
      'provider' | 'ach' | 'wire' | 'check' | 'manual' | 'other',
      'provider' | 'ach' | 'wire' | 'check' | 'manual' | 'other' | undefined,
      'provider' | 'ach' | 'wire' | 'check' | 'manual' | 'other' | undefined
    >
    reference: ColumnType<string | null, string | null | undefined, string | null | undefined>
    status:
      | 'requires_payment_method'
      | 'requires_confirmation'
      | 'requires_capture'
      | 'requires_action'
      | 'processing'
      | 'succeeded'
      | 'partially_refunded'
      | 'refunded'
      | 'canceled'
      | 'failed'
    amount_minor: ColumnType<string, string | number, string | number>
    currency: string
    occurred_at: Date
    created_at: Generated<Date>
    updated_at: Generated<Date>
    entry_group_id: string | null
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    raw_provider_payload: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  }
  billing_payment_refunds: {
    billing_payment_refund_id: Generated<string>
    realm_id: string
    billing_payment_id: string
    provider: string
    provider_refund_id: string
    provider_charge_id: string | null
    amount_minor: ColumnType<string, string | number, string | number>
    currency: string
    status: 'pending' | 'succeeded' | 'failed' | 'canceled'
    occurred_at: Date
    created_at: Generated<Date>
    updated_at: Generated<Date>
    raw_provider_payload: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  }
  billing_invoices: {
    billing_invoice_id: Generated<string>
    realm_id: string
    billing_account_id: string
    billing_period_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    subscription_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    invoice_number: string
    provider: ColumnType<string | null, string | null | undefined, string | null | undefined>
    provider_invoice_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    provider_subscription_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    provider_customer_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    currency: string
    subtotal_minor: ColumnType<string, string | number, string | number>
    tax_minor: ColumnType<string, string | number, string | number>
    total_minor: ColumnType<string, string | number, string | number>
    status: 'draft' | 'open' | 'void' | 'uncollectible' | 'paid'
    period_start: Date
    period_end: Date
    due_at: Date | null
    finalized_at: Date | null
    paid_at: Date | null
    canceled_at: Date | null
    hosted_invoice_url: ColumnType<string | null, string | null | undefined, string | null | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    raw_provider_payload: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  }
  billing_invoice_lines: {
    billing_invoice_line_id: Generated<string>
    billing_invoice_id: string
    line_kind: 'recurring' | 'usage' | 'one_time' | 'discount' | 'tax' | 'other'
    description: string | null
    quantity: ColumnType<string, string | number, string | number>
    unit_amount_minor: ColumnType<string, string | number, string | number>
    total_amount_minor: ColumnType<string, string | number, string | number>
    catalog_price_id: string | null
    meter_code: string | null
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
  }
  billing_invoice_allocations: {
    billing_invoice_id: string
    allocation_id: string
    amount_xusd: ColumnType<string, string | number, string | number>
    amount_minor: ColumnType<string, string | number, string | number>
    currency: string
    created_at: Generated<Date>
  }
  billing_invoice_adjustments: {
    billing_invoice_adjustment_id: Generated<string>
    realm_id: string
    billing_account_id: string
    billing_invoice_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    billing_period_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    kind: 'late_data' | 'manual' | 'reconciliation'
    direction: 'debit' | 'credit'
    amount_minor: ColumnType<string, string | number, string | number>
    currency: string
    reason: string | null
    status: 'pending' | 'applied' | 'canceled'
    applied_at: Date | null
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  // Provider customer mapping (per billing account, per provider)
  provider_customers: {
    billing_account_id: string
    provider: string
    provider_customer_id: string | null
    // DB default now() on insert → mark as Generated to avoid requiring it in inserts
    created_at: Generated<Date>
    // updated_at is nullable; app may set it on updates, but it's optional on insert
    updated_at: ColumnType<Date | null, Date | undefined, Date | null | undefined>
  }
  meter_prices: {
    price_id: Generated<string>
    realm_id: string
    meter_code: string
    unit_price_xusd: ColumnType<string, string | number, string | number>
    unit_price_base_xusd: ColumnType<string, string | number, string | number>
    unit_price_dynamic_xusd: ColumnType<string, string | number, string | number>
    unit_quantity_minor: ColumnType<string, string | number, string | number>
    rounding: 'floor' | 'nearest' | 'ceil'
    unit_cost_xusd: ColumnType<string, string | number, string | number>
    cost_unit_quantity_minor: ColumnType<string, string | number, string | number>
    cost_rounding: 'floor' | 'nearest' | 'ceil'
    effective_at: ColumnType<Date, Date | string | undefined, Date | string | undefined>
  }
  gate_policies: {
    policy_id: Generated<string>
    realm_id: string
    bundle_id: string
    name: string
    description: ColumnType<string | null, string | undefined, string | null | undefined>
    feature_code: string
    kind: 'rate' | 'quota'
    subject_scope: ColumnType<'account' | 'user', 'account' | 'user' | undefined, 'account' | 'user'>
    unit: string
    window_sec: number
    limit_count: ColumnType<string | null, string | number | null | undefined, string | number | null | undefined>
    limit_minor: ColumnType<string | null, string | number | null | undefined, string | number | null | undefined>
    status: 'default' | 'assignable' | 'ceiling' | 'disabled'
    enforcement_mode: 'optimistic' | 'reserve'
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  gate_policy_bundles: {
    bundle_id: Generated<string>
    realm_id: string
    bundle_key: string
    name: ColumnType<string | null, string | null | undefined, string | null | undefined>
    status: 'active' | 'disabled'
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  budgets: {
    budget_id: Generated<string>
    billing_user_id: string
    billing_account_id: string
    name: ColumnType<string | null, string | undefined, string | null | undefined>
    status: 'active' | 'closing' | 'closed' | 'expired' | 'canceled'
    scope_kind: ColumnType<'global' | 'feature' | 'feature_set' | null, 'global' | 'feature' | 'feature_set' | null | undefined, 'global' | 'feature' | 'feature_set' | null | undefined>
    scope_ref: ColumnType<string | null, string | null | undefined, string | null | undefined>
    scope_payload: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null | undefined, Record<string, unknown> | null | undefined>
    consumed_xusd: ColumnType<string, string | number, string | number>
    reserved_xusd: ColumnType<string, string | number, string | number>
    limit_xusd: ColumnType<string | null, string | number | null | undefined, string | number | null | undefined>
    lwm_xusd: ColumnType<string | null, string | number | null | undefined, string | number | null | undefined>
    hwm_xusd: ColumnType<string | null, string | number | null | undefined, string | number | null | undefined>
    window_start: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    window_end: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    closed_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  gate_leases: {
    lease_id: Generated<string>
    billing_user_id: string
    billing_account_id: string
    policy_id: string
    feature_code: string
    cap_minor: ColumnType<string, string | number, string | number>
    state: 'active' | 'closed' | 'expired' | 'canceled'
    expires_at: Date
    idempotency_key: string
    request_hash: ColumnType<string | null, string | undefined, string | null | undefined>
    budget_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    reservation_minor: ColumnType<string, string | number, string | number>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  billing_ratings: {
    rating_id: Generated<string>
    realm_id: string
    billing_user_id: string
    billing_account_id: string
    rating_kind: Generated<'gate' | 'ingest'>
    idempotency_id: string
    source_ref: ColumnType<string | null, string | null | undefined, string | null | undefined>
    budget_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    feature_code: string
    direction: Generated<'debit' | 'credit'>
    reversal_of_rating_id: ColumnType<string | null, string | number | null | undefined, string | number | null | undefined>
    canonical_quantity_minor: ColumnType<string, string | number, string | number>
    canonical_amount_xusd: ColumnType<string, string | number, string | number>
    canonical_cost_xusd: ColumnType<string, string | number, string | number>
    pricing_fingerprint: string
    pricing_cost_fingerprint: string
    cost_snapshot: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
    cost_fingerprint: string
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    rated_at: Generated<Date>
    created_at: Generated<Date>
  }
  billing_rated_records: {
    rated_record_id: Generated<string>
    rating_id: string
    meter_code: string
    quantity_minor: ColumnType<string, string | number, string | number>
    amount_xusd: ColumnType<string, string | number, string | number>
    cost_xusd: ColumnType<string, string | number, string | number>
    unit_price_xusd: ColumnType<string, string | number, string | number>
    unit_quantity_minor: ColumnType<string, string | number, string | number>
    rounding: 'floor' | 'nearest' | 'ceil'
    unit_cost_xusd: ColumnType<string, string | number, string | number>
    cost_unit_quantity_minor: ColumnType<string, string | number, string | number>
    cost_rounding: 'floor' | 'nearest' | 'ceil'
    pricing_snapshot: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
    pricing_fingerprint: string
    cost_snapshot: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
    cost_fingerprint: string
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
  }
  billing_rating_labels: {
    rating_id: string
    key: string
    value: string
    created_at: Generated<Date>
  }
  billing_rating_allocations: {
    allocation_id: Generated<string>
    realm_id: string
    rating_id: string
    direction: Generated<'debit' | 'credit'>
    billing_user_id: string
    billing_account_id: string
    budget_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    feature_code: string
    pricing_fingerprint: ColumnType<string | null, string | undefined, string | null | undefined>
    cost_fingerprint: ColumnType<string | null, string | undefined, string | null | undefined>
    amount_xusd: ColumnType<string, string | number, string | number>
    cost_xusd: ColumnType<string, string | number, string | number>
    grant_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    funding_kind: 'grant' | 'cash' | 'credit' | 'other'
    allocated_xusd: ColumnType<string, string | number, string | number>
    alloc_seq: ColumnType<number, number | undefined, number | undefined>
    reversal_of_allocation_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    applied_amount_xusd: ColumnType<string, string | number, string | number>
    applied_cost_xusd: ColumnType<string, string | number, string | number>
    applied_quantity_minor: ColumnType<string, string | number, string | number>
    rated_at: Date
    settlement_state: 'pending' | 'settling' | 'settled' | 'voided' | 'error'
    application_status: 'applied' | 'quarantined' | 'applied_clipped' | 'reversed' | 'error'
    reason_codes: ColumnType<string[], string[] | null | undefined, string[] | null | undefined>
    late_rating: ColumnType<boolean, boolean | undefined, boolean | undefined>
    decided_at: ColumnType<Date, Date | undefined, Date | undefined>
    usage_started_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    usage_finished_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    settlement_scope_kind: ColumnType<string | null, string | undefined, string | null | undefined>
    settlement_scope_key: ColumnType<string | null, string | undefined, string | null | undefined>
    settlement_batch_id: ColumnType<string | null, string | undefined, string | null | undefined>
    engine: ColumnType<string | null, string | undefined, string | null | undefined>
    engine_run_id: ColumnType<string | null, string | undefined, string | null | undefined>
    entry_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    entry_ref: ColumnType<string | null, string | undefined, string | null | undefined>
    entry_amount_xusd: ColumnType<string | null, string | number | null | undefined, string | number | null | undefined>
    entry_reason: ColumnType<string | null, string | undefined, string | null | undefined>
    settled_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    error_code: ColumnType<string | null, string | undefined, string | null | undefined>
    error_message: ColumnType<string | null, string | undefined, string | null | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  idempotency_envelopes: {
    idempotency_id: Generated<string>
    realm_id: string
    service: string
    operation: string
    scope_type: string
    scope_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    billing_user_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    billing_account_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    key: string
    request_hash: string
    status: 'pending' | 'completed' | 'failed'
    request_snapshot: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null | undefined, Record<string, unknown> | null | undefined>
    response_snapshot: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null | undefined, Record<string, unknown> | null | undefined>
    result_ref: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null | undefined, Record<string, unknown> | null | undefined>
    metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>
    created_at: Generated<Date>
    finalized_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
  }
  gate_quota_counters: {
    counter_id: Generated<string>
    subject_scope: 'account' | 'user'
    subject_id: string
    billing_user_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    billing_account_id: string
    feature_code: string
    key: string
    window_start: Date
    window_end: Date
    limit_minor: ColumnType<string, string | number, string | number>
    used_minor: ColumnType<string, string | number, string | number>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  gate_residual_buckets: {
    billing_user_id: string
    billing_account_id: string
    meter_code: string
    pricing_fingerprint: string
    denom: ColumnType<string, string | number, string | number>
    rounding: 'floor' | 'nearest' | 'ceil'
    remainder_numer: ColumnType<string, string | number, string | number>
    updated_at: Generated<Date>
  }
  dat_bootstrap_tokens: {
    token_id: string
    token_hash: string
    token_value: string
    subject_type: 'operator'
    subject_id: string
    organization_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    allowed_realms: ColumnType<string[] | null, string[] | null | undefined, string[] | null | undefined>
    granted_scopes: ColumnType<string[], string[] | undefined, string[] | undefined>
    issued_by: ColumnType<string | null, string | null | undefined, string | null | undefined>
    status: 'active' | 'revoked' | 'expired'
    expires_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    last_used_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  dat_revoked_jtis: {
    jti: string
    token_use: string
    subject_type: ColumnType<string | null, string | null | undefined, string | null | undefined>
    subject_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    organization_id: ColumnType<string | null, string | null | undefined, string | null | undefined>
    reason: ColumnType<string | null, string | null | undefined, string | null | undefined>
    revoked_at: Generated<Date>
    expires_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>
  }
}
