-- Minimal schema fixture for billing_plan -> grant_assignments sync tests.
-- Intentionally does not enable RLS to keep the test focused on reconcile correctness.

-- Make this fixture robust even if the DB isn't fully clean (e.g., shared external DB).
drop table if exists grant_assignments cascade;
drop table if exists grant_campaigns cascade;
drop table if exists grant_programs cascade;
drop table if exists billing_plan_assignments cascade;
drop table if exists billing_plans cascade;
drop table if exists billing_users cascade;
drop table if exists billing_accounts cascade;
drop table if exists realms cascade;
drop function if exists mark_grants_switch_dirty() cascade;

create extension if not exists pgcrypto;

create table if not exists realms (
  realm_id text primary key,
  name text not null,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists billing_accounts (
  billing_account_id uuid primary key default gen_random_uuid(),
  realm_id text not null references realms(realm_id) on delete restrict,
  billing_principal_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (realm_id, billing_principal_id)
);

create table if not exists billing_users (
  billing_user_id uuid primary key default gen_random_uuid(),
  realm_id text not null references realms(realm_id) on delete restrict,
  billing_account_id uuid not null references billing_accounts(billing_account_id) on delete cascade,
  business_user_id text not null,
  status text not null default 'active' check (status in ('active','disabled','deleted')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (realm_id, billing_account_id, business_user_id)
);

-- Mark billing_users.metadata.grants_switch.dirty=true when billing_plan_assignments change.
create or replace function mark_grants_switch_dirty()
returns trigger
language plpgsql
as $$
declare
  bu uuid;
  ba uuid;
  scope text;
begin
  bu := coalesce(new.billing_user_id, old.billing_user_id);
  ba := coalesce(new.billing_account_id, old.billing_account_id);
  scope := coalesce(new.assignment_scope, old.assignment_scope, 'user');
  if scope = 'user' and bu is null then
    return null;
  end if;
  if scope = 'account' and ba is null then
    return null;
  end if;

  update billing_users
  set
    metadata =
      coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object(
        'grants_switch',
        coalesce(metadata->'grants_switch', '{}'::jsonb)
        || jsonb_build_object(
          'dirty', true,
          'dirty_at', now()::text
        )
      ),
    updated_at = now()
  where
    (scope = 'user' and billing_user_id = bu)
    or (scope = 'account' and billing_account_id = ba and status = 'active');

  return null;
end;
$$;

create table if not exists billing_plans (
  plan_id bigserial primary key,
  realm_id text not null references realms(realm_id) on delete restrict,
  plan_code text not null,
  name text not null,
	kind text not null check (kind in ('base','addon','promo')),
	priority integer not null default 0,
	active boolean not null default true,
	metadata jsonb not null default '{}'::jsonb,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint ux_billing_plans_plan_code unique (realm_id, plan_code)
);

create table if not exists billing_plan_assignments (
  assignment_id bigserial primary key,
  billing_account_id uuid not null references billing_accounts(billing_account_id) on delete cascade,
  assignment_scope text not null default 'user' check (assignment_scope in ('account','user')),
  billing_user_id uuid null references billing_users(billing_user_id) on delete cascade,
  plan_id bigint not null references billing_plans(plan_id) on delete restrict,
  subscription_item_id bigint null,
  source_kind text not null check (source_kind in (
    'signup.default','provider.subscription_item','provider.subscription','ops.manual','ops.campaign'
  )),
  source_ref text not null,
  window_start timestamptz not null default now(),
  window_end timestamptz null,
  valid_range tstzrange generated always as (tstzrange(window_start, coalesce(window_end, 'infinity'::timestamptz))) stored,
  status text not null default 'active' check (status in ('active','paused','canceled','expired')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_bpa_assignment_scope_user check (
    (assignment_scope = 'account' and billing_user_id is null)
    or (assignment_scope = 'user' and billing_user_id is not null)
  )
);

create unique index if not exists ux_bpa_user_plan_source
  on billing_plan_assignments (billing_user_id, plan_id, source_kind, source_ref)
  where assignment_scope = 'user' and billing_user_id is not null;

create unique index if not exists ux_bpa_account_plan_source
  on billing_plan_assignments (billing_account_id, plan_id, source_kind, source_ref)
  where assignment_scope = 'account';

drop trigger if exists trg_bpa_mark_grants_switch_dirty on billing_plan_assignments;
create trigger trg_bpa_mark_grants_switch_dirty
after insert or update or delete on billing_plan_assignments
for each row execute function mark_grants_switch_dirty();

create table if not exists grant_programs (
  program_id bigserial primary key,
  realm_id text not null references realms(realm_id) on delete restrict,
  program_code text not null,
  name text,
  active boolean not null default true,
  cadence text not null check (cadence in ('once','daily','weekly','monthly','quarterly','yearly','billing_period')),
  issue_anchor text not null check (issue_anchor in ('calendar_start','binding_start','first_use')),
  amount_xusd bigint not null check (amount_xusd >= 0),
  window_kind text not null check (window_kind in ('period','fixed','forever','relative_duration')),
  window_default_seconds integer null check (window_default_seconds is null or window_default_seconds > 0),
  priority integer not null default 0,
  on_ledger boolean not null default false,
  issuance_mode text not null check (issuance_mode in ('eager','lazy','hybrid')),
  periodic_accounting boolean not null default false,
  accrual_mode text null,
  eligibility_kind text not null default 'manual',
  eligibility_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ux_grant_programs_program_code unique (realm_id, program_code)
);

create table if not exists grant_campaigns (
  campaign_id bigserial primary key,
  realm_id text not null references realms(realm_id) on delete restrict,
  name text not null,
  status text not null default 'scheduled' check (status in ('scheduled','active','paused','ended')),
  window_start timestamptz not null default now(),
  window_end timestamptz null,
  target_filter jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists grant_assignments (
  assignment_id bigserial primary key,
  billing_account_id uuid not null references billing_accounts(billing_account_id) on delete cascade,
  billing_user_id uuid not null references billing_users(billing_user_id) on delete cascade,
  program_id bigint not null references grant_programs(program_id) on delete restrict,
  billing_plan_assignment_id bigint null references billing_plan_assignments(assignment_id) on delete set null,
  campaign_id bigint null references grant_campaigns(campaign_id) on delete set null,
  source_kind text not null check (source_kind in (
    'provider.subscription','provider.subscription_item','provider.one_time',
    'wallet.cash','ops.campaign','ops.manual','internal.catalog','billing_plan_assignment'
  )),
  source_ref text not null,
  window_start timestamptz not null,
  window_end timestamptz null,
  valid_range tstzrange generated always as (tstzrange(window_start, coalesce(window_end, 'infinity'::timestamptz))) stored,
  status text not null default 'active' check (status in ('active','paused','canceled','expired')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (billing_user_id, source_kind, source_ref, program_id),
  constraint chk_ga_bpa_id_required check (source_kind <> 'billing_plan_assignment' or billing_plan_assignment_id is not null),
  constraint chk_ga_campaign_id_required check (source_kind <> 'ops.campaign' or campaign_id is not null)
);
