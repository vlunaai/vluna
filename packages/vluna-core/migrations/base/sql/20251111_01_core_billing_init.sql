-- =====================================================================
-- Billing DB Schema (from zero)
-- One-shot, self-contained DDL for a fresh database.
-- PostgreSQL 16+
-- NOTE (amount representation):
-- * Monetary amounts use INTEGER XUSD units (internal settlement precision).
-- * Usage quantities also use INTEGER minor-units with a per-meter scale.
--   - meters.scale = decimal exponent (0..18). Stored value = round(q * 10^scale).
--   - Column names: quantity_minor / total_quantity_minor (BIGINT).
-- =====================================================================

-- Table of Contents (generated)
--   =====================================================================
--   =====================================================================
--   0a) Realms dictionary (authority for realm scope)
--   0) Housekeeping (optional) -
--   1) Core: Accounts
--   2) Catalog (Products & Prices) -
--   3) Wallet (Wallet: Currencies, Ledgers & Transactions)
--   Global Label Keys (optional dictionary for label typing)
--   Credit Transaction-level Labels (multi-dimensional attribution)
--   4) Usage: meters/bindings/events/reports -
--   Event-level Labels (multi-dimensional attribution)
--   5) Provider mappings (Stripe customers etc.) -
--   5) Provider snapshots & reconciliation -
--   3b) Features & Entitlements
--   -
--   -
--   =====================================================================
--   =====================================================================
--   6) Customer Subscriptions (authoritative, account-level) -
--   =====================================================================
--   =====================================================================

BEGIN;

DO $set_target_schema$
DECLARE
  schema_name text := nullif(current_setting('app.vluna_schema', true), '');
BEGIN
  IF schema_name IS NULL THEN
    RAISE EXCEPTION
      'app.vluna_schema is not set. Set it via set_config or connection options before running init DDL.';
  END IF;
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', schema_name);
  EXECUTE format('SET search_path TO %I, pg_temp', schema_name);
END;
$set_target_schema$;

-- Extensions required for UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Auto-update updated_at columns via trigger
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$;

-- Mark billing_users.metadata.grants_switch.dirty=true when billing_plan_assignments change.
-- This provides an explicit "needs sync" marker for the grants switch reconciler.
CREATE OR REPLACE FUNCTION mark_grants_switch_dirty()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bu uuid;
  ba uuid;
  scope text;
BEGIN
  bu := COALESCE(NEW.billing_user_id, OLD.billing_user_id);
  ba := COALESCE(NEW.billing_account_id, OLD.billing_account_id);
  scope := COALESCE(NEW.assignment_scope, OLD.assignment_scope, 'user');
  IF scope = 'user' AND bu IS NULL THEN
    RETURN NULL;
  END IF;
  IF scope = 'account' AND ba IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE billing_users
  SET
    metadata =
      COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object(
        'grants_switch',
        COALESCE(metadata->'grants_switch', '{}'::jsonb)
        || jsonb_build_object(
          'dirty', true,
          'dirty_at', now()::text
        )
      ),
    updated_at = now()
  WHERE
    (scope = 'user' AND billing_user_id = bu)
    OR (scope = 'account' AND billing_account_id = ba AND status = 'active');

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION is_valid_uuid(str text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF str IS NULL THEN
    RETURN false;
  END IF;
  RETURN str ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
END;
$$;

CREATE OR REPLACE FUNCTION get_current_billing_account_id()
RETURNS uuid LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  billing_account_id_str text := current_setting('app.billing_account_id', true);
BEGIN
  IF is_valid_uuid(billing_account_id_str) THEN
    RETURN billing_account_id_str::uuid;
  ELSE
    RETURN NULL;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION get_current_billing_user_id()
RETURNS uuid LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  billing_user_id_str text := current_setting('app.billing_user_id', true);
BEGIN
  IF is_valid_uuid(billing_user_id_str) THEN
    RETURN billing_user_id_str::uuid;
  ELSE
    RETURN NULL;
  END IF;
END;
$$;

-- ---------- 0a) Realms dictionary (authority for realm scope) ----------
-- Reason: Normalize realm identifiers and enforce referential integrity across tables.
CREATE TABLE IF NOT EXISTS realms (
  realm_id   text PRIMARY KEY,
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_api_keys (
  key_id            text PRIMARY KEY,
  status            text NOT NULL DEFAULT 'active',
  allowed_realms    text[] NOT NULL,
  allowed_accounts  text[] DEFAULT '{}',
  scopes            text[] DEFAULT '{}',
  kdf_alg           text NOT NULL DEFAULT 'HKDF-SHA256',  -- 'HMAC-SHA256','HKDF-SHA256'
  kdf_salt          bytea NOT NULL,         -- 16~32 随机字节
  kdf_version       integer NOT NULL DEFAULT 1,
  env_tag           text NOT NULL,          -- 如 'prod' | 'stage'
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz,
  last_used_at      timestamptz
);

-- ---------- 0) Housekeeping (optional) ---------------------------------
-- SET ROLE billing_owner;  -- if applicable
-- -- app.vluna_schema must be set before executing this file.
-- -- CREATE SCHEMA IF NOT EXISTS <app.vluna_schema>;
-- -- SET search_path TO <app.vluna_schema>, pg_temp;

-- ---------- 1) Core: Accounts ------------------------------------------

CREATE TABLE IF NOT EXISTS gate_policy_bundles (
  bundle_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id      text        NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  bundle_key    text        NOT NULL,
  name          text        NULL,
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm_id, bundle_key)
);

CREATE TABLE IF NOT EXISTS billing_accounts (
  billing_account_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id                 text NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,  -- normalized FK to realms
  billing_principal_id     text NOT NULL,
  seat_limit               integer NULL CHECK (seat_limit IS NULL OR seat_limit >= 0),
  seat_limit_source        text NULL,
  seat_limit_updated_at    timestamptz NULL,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm_id, billing_principal_id)
);

CREATE INDEX IF NOT EXISTS ix_billing_accounts_realm ON billing_accounts(realm_id);

CREATE TABLE IF NOT EXISTS billing_users (
  billing_user_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id                text NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_account_id      uuid NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  business_user_id        text NOT NULL,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm_id, billing_account_id, business_user_id),
  CONSTRAINT ux_billing_users_id_account UNIQUE (billing_user_id, billing_account_id)
);

CREATE INDEX IF NOT EXISTS ix_billing_users_realm_account ON billing_users(realm_id, billing_account_id);
CREATE INDEX IF NOT EXISTS ix_billing_users_business_user ON billing_users(billing_account_id, business_user_id);

CREATE TABLE IF NOT EXISTS billing_account_billing_details (
  billing_account_id uuid PRIMARY KEY
    REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,

  billing_email text,
  billing_email_lc text GENERATED ALWAYS AS (lower(billing_email)) STORED,

  legal_name text,
  entity_type text CHECK (entity_type IN ('individual', 'company', 'unknown')),

  default_address jsonb,
  tax_ids jsonb,

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  last_updated_by text NOT NULL DEFAULT 'system'
    CHECK (last_updated_by IN ('user', 'provider', 'ops', 'system')),
  source_updated_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT billing_details_default_address_is_object
    CHECK (default_address is null or jsonb_typeof(default_address) = 'object'),

  CONSTRAINT billing_details_tax_ids_is_array
    CHECK (tax_ids is null or jsonb_typeof(tax_ids) = 'array'),

  CONSTRAINT billing_details_country_code_len
    CHECK (
      default_address is null
      or default_address ? 'country_code' is false
      or (
        jsonb_typeof(default_address->'country_code') = 'string'
        and length(default_address->>'country_code') = 2
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_billing_details_email_lc
  ON billing_account_billing_details (billing_email_lc);

CREATE INDEX IF NOT EXISTS idx_billing_details_legal_name
  ON billing_account_billing_details (legal_name);

CREATE INDEX IF NOT EXISTS idx_billing_details_country_code
  ON billing_account_billing_details ((default_address->>'country_code'));

DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE billing_account_billing_details ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_account_billing_details' AND policyname='bbd_rw') THEN
    CREATE POLICY bbd_rw ON billing_account_billing_details FOR ALL USING (
      EXISTS (
        SELECT 1
        FROM billing_accounts ba
        WHERE ba.billing_account_id = billing_account_billing_details.billing_account_id
          AND ba.realm_id = current_setting('app.realm_id', true)
          AND (
            current_setting('app.is_realm_admin', true) = 'true'
            OR ba.billing_account_id = get_current_billing_account_id()
          )
      )
    ) WITH CHECK (
      EXISTS (
        SELECT 1
        FROM billing_accounts ba
        WHERE ba.billing_account_id = billing_account_billing_details.billing_account_id
          AND ba.realm_id = current_setting('app.realm_id', true)
          AND (
            current_setting('app.is_realm_admin', true) = 'true'
            OR ba.billing_account_id = get_current_billing_account_id()
          )
      )
    );
  END IF;
END$$;

-- ---------- billing_plans ----------
CREATE TABLE IF NOT EXISTS billing_plans (
  plan_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id       text      NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  plan_code      text      NOT NULL,
  name           text      NOT NULL,
  kind           text      NOT NULL CHECK (kind IN ('base','addon','promo')),
  priority       integer   NOT NULL DEFAULT 0,
  active         boolean   NOT NULL DEFAULT true,
  metadata       jsonb     NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_billing_plans_plan_code UNIQUE (realm_id, plan_code)
);

-- ---------- billing_plan_assignments ----------
CREATE TABLE IF NOT EXISTS billing_plan_assignments (
  assignment_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id uuid      NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  assignment_scope   text      NOT NULL CHECK (assignment_scope IN ('account','user')),
  billing_user_id    uuid      NULL REFERENCES billing_users(billing_user_id) ON DELETE CASCADE,
  plan_id            uuid      NOT NULL REFERENCES billing_plans(plan_id) ON DELETE RESTRICT,
  subscription_item_id uuid    NULL,
  source_kind        text      NOT NULL CHECK (source_kind IN (
                        'signup.default','provider.subscription_item','provider.subscription','ops.manual','ops.campaign'
                      )),
  source_ref         text      NOT NULL,
  window_start       timestamptz NOT NULL DEFAULT now(),
  window_end         timestamptz NULL,
  valid_range        tstzrange   GENERATED ALWAYS AS (tstzrange(window_start, COALESCE(window_end, 'infinity'::timestamptz))) STORED,
  status             text      NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','canceled','expired')),
  metadata           jsonb     NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_bpa_assignment_scope_user CHECK (
    (assignment_scope = 'account' AND billing_user_id IS NULL)
    OR
    (assignment_scope = 'user' AND billing_user_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_bpa_user_plan_source
  ON billing_plan_assignments (billing_user_id, plan_id, source_kind, source_ref)
  WHERE assignment_scope = 'user' AND billing_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_bpa_account_plan_source
  ON billing_plan_assignments (billing_account_id, plan_id, source_kind, source_ref)
  WHERE assignment_scope = 'account';
CREATE INDEX IF NOT EXISTS ix_bpa_account ON billing_plan_assignments (billing_account_id, assignment_scope, billing_user_id, status);
CREATE INDEX IF NOT EXISTS ix_bpa_user ON billing_plan_assignments (billing_user_id, status) WHERE billing_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_bpa_plan ON billing_plan_assignments (plan_id, status);
CREATE INDEX IF NOT EXISTS ix_bpa_valid_range ON billing_plan_assignments USING gist (valid_range);


CREATE TABLE IF NOT EXISTS subscription_groups (
  subscription_group_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id              text NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  group_key             text NOT NULL,
  title                 text NOT NULL,
  is_stackable          boolean NOT NULL DEFAULT false,
  is_exclusive          boolean NOT NULL DEFAULT true,
  CONSTRAINT ux_subscription_groups_realm_key UNIQUE (realm_id, group_key)
);

-- ---------- 2) Catalog (Products & Prices) -----------------------------
CREATE TABLE IF NOT EXISTS catalog_products (
  catalog_product_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id            text NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  product_code        text NOT NULL COLLATE "C",
  provider            text NOT NULL,                -- e.g., 'stripe'
  provider_product_id text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('subscription','credit')),
  status              text NOT NULL CHECK (status IN ('active','archived','draft')),
  display_priority    integer NOT NULL DEFAULT 100,
  presentation_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  name                text NOT NULL,
  default_currency    text NOT NULL,
  metadata            jsonb     NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_catalog_products_code UNIQUE (product_code),
  CONSTRAINT ck_catalog_products_presentation_config_object
    CHECK (jsonb_typeof(presentation_config) = 'object')
);

-- Enforce default_currency to be 3-letter uppercase
DO $$
BEGIN
  BEGIN
    ALTER TABLE catalog_products
      ADD CONSTRAINT ck_catalog_products_default_currency
      CHECK (char_length(default_currency) = 3 AND default_currency = upper(default_currency));
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_catalog_products_provider_product
  ON catalog_products(provider, provider_product_id);
CREATE INDEX IF NOT EXISTS ix_catalog_products_realm ON catalog_products(realm_id);

CREATE TABLE IF NOT EXISTS catalog_prices (
  catalog_price_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id            text NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  catalog_product_id  uuid    NOT NULL REFERENCES catalog_products(catalog_product_id) ON DELETE CASCADE,
  price_code          text NOT NULL COLLATE "C",
  provider_price_id   text    NOT NULL,
  status              text    NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  currency            text    NOT NULL,
  unit_amount         integer NOT NULL,         -- minor units (e.g., cents)
  recurring_interval  text,                     -- 'month' | 'year' | NULL (one-time)
  recurring_count     integer,
  display_priority    integer NOT NULL DEFAULT 100,
  metadata            jsonb DEFAULT '{}'::jsonb,
  -- Subscription grouping (replaces catalog_price_groups)
  subscription_group_id  uuid,
  subscription_group_key text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_catalog_prices_code UNIQUE (price_code)
);
CREATE INDEX IF NOT EXISTS ix_catalog_prices_product ON catalog_prices(catalog_product_id);
CREATE INDEX IF NOT EXISTS ix_catalog_prices_realm ON catalog_prices(realm_id);
-- Keep provider_price_id globally unique for now to avoid schema churn; see TECH notes.
CREATE UNIQUE INDEX IF NOT EXISTS ux_catalog_prices_provider_price
  ON catalog_prices(provider_price_id);

-- Strengthen data checks on catalog_prices
DO $$
BEGIN
  BEGIN
    ALTER TABLE catalog_prices
      ADD CONSTRAINT ck_catalog_prices_currency
      CHECK (char_length(currency) = 3 AND currency = upper(currency));
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    ALTER TABLE catalog_prices
      ADD CONSTRAINT ck_catalog_prices_recurring_interval
      CHECK (recurring_interval IN ('month','year') OR recurring_interval IS NULL);
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    ALTER TABLE catalog_prices
      ADD CONSTRAINT ck_catalog_prices_recurring_pair
      CHECK ((recurring_interval IS NULL) = (recurring_count IS NULL));
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- Unit amount must be non-negative
  BEGIN
    ALTER TABLE catalog_prices
      ADD CONSTRAINT ck_catalog_prices_unit_amount_nonneg
      CHECK (unit_amount >= 0);
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- If recurring, count must be positive
  BEGIN
    ALTER TABLE catalog_prices
      ADD CONSTRAINT ck_catalog_prices_recurring_positive
      CHECK (recurring_interval IS NULL OR recurring_count > 0);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;


-- Backfill and constrain subscription grouping on catalog_prices
DO $$
BEGIN
  BEGIN
    ALTER TABLE catalog_prices
      ADD CONSTRAINT fk_catalog_prices_subscription_group
      FOREIGN KEY (subscription_group_id) REFERENCES subscription_groups(subscription_group_id) ON DELETE RESTRICT;
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    ALTER TABLE catalog_prices
      ADD CONSTRAINT ck_catalog_prices_group_key_pair
      CHECK (
        -- either both null (e.g., credits/one-time) or both set and key not empty
        (subscription_group_id IS NULL AND subscription_group_key IS NULL) OR
        (subscription_group_id IS NOT NULL AND subscription_group_key IS NOT NULL AND char_length(subscription_group_key) > 0)
      );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    ALTER TABLE catalog_prices
      ADD CONSTRAINT ck_catalog_prices_group_required_for_recurring
      CHECK (recurring_interval IS NULL OR subscription_group_id IS NOT NULL);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

CREATE INDEX IF NOT EXISTS ix_catalog_prices_group ON catalog_prices(subscription_group_id);


-- ---------- 3) Wallet (Wallet: Currencies, Ledgers & Transactions) ----

-- 3.0 Currencies dictionary (wallet denominations)
CREATE TABLE IF NOT EXISTS currencies (
  code   text PRIMARY KEY,                       -- 'XUSD','USD','POINTS','USDC','TOKENS', 'CREDIT', ...
  kind   text NOT NULL CHECK (kind IN ('xusd','fiat','credit','crypto','token','other')),
  scale  smallint NOT NULL CHECK (scale BETWEEN 0 AND 18)
);
DO $$
BEGIN
  BEGIN
    ALTER TABLE currencies
      ADD CONSTRAINT ck_currencies_code_upper CHECK (code = upper(code));
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

-- ============================================================
-- Ledgers: ledger_accounts / ledger_entries / ledger_entry_labels
-- Amount unit: XUSD (integer). One billing user × one currency = one wallet.
-- ============================================================

-- ---------- ledger_accounts ----------
CREATE TABLE IF NOT EXISTS ledger_accounts (
  ledger_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_user_id    uuid NOT NULL REFERENCES billing_users(billing_user_id) ON DELETE CASCADE,
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  currency_code      text NOT NULL REFERENCES currencies(code),
  balance_xusd       bigint NOT NULL DEFAULT 0,   -- authoritative balance in XUSD
  updated_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (billing_user_id, currency_code),
  CONSTRAINT uq_la_lid_buid UNIQUE (ledger_id, billing_user_id),
  CONSTRAINT fk_la_user_account
    FOREIGN KEY (billing_user_id, billing_account_id)
    REFERENCES billing_users(billing_user_id, billing_account_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_ledger_accounts_buid ON ledger_accounts(billing_user_id);
CREATE INDEX IF NOT EXISTS ix_ledger_accounts_baid ON ledger_accounts(billing_account_id);
CREATE INDEX IF NOT EXISTS ix_ledger_accounts_curr ON ledger_accounts(currency_code);

-- ---------- ledger_entries ----------
-- One row = one posting (single economic component).
CREATE TABLE IF NOT EXISTS ledger_entries (
  entry_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id           uuid NOT NULL REFERENCES ledger_accounts(ledger_id),
  billing_user_id     uuid   NOT NULL,
  billing_account_id  uuid   NOT NULL,
  -- money
  amount_xusd     bigint NOT NULL,  -- sign indicates effect (+ increase, - decrease)

  -- posting semantics
  reason          text  NOT NULL CHECK (reason IN ('adjustment','purchase','consumption','transfer','refund','reversal')),
  source_ref      text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- future-proof economic components (text + CHECK; default locked to 'charge' for now)
  econ_component_kind  text NOT NULL DEFAULT 'charge'
    CHECK (econ_component_kind IN ('charge','cost','tax','rebate','fee','subsidy','reserve','transfer')),
  econ_component_code  text NULL,          -- e.g. 'charge.usage', 'cost.meter.cogs'
  component_version    smallint NOT NULL DEFAULT 1 CHECK (component_version >= 1),

  -- grouping & optional settlement linkage
  entry_group_id  uuid   NULL,            -- group entries of one business event
  idempotency_key text  NOT NULL,         -- unique per ledger

  CONSTRAINT fk_le_parent
    FOREIGN KEY (ledger_id, billing_user_id)
    REFERENCES ledger_accounts(ledger_id, billing_user_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_le_user_account
    FOREIGN KEY (billing_user_id, billing_account_id)
    REFERENCES billing_users(billing_user_id, billing_account_id)
    ON DELETE CASCADE,
  UNIQUE (ledger_id, idempotency_key)
);

-- indexes
CREATE INDEX IF NOT EXISTS ix_le_bu_created ON ledger_entries (billing_user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_le_ba_created ON ledger_entries (billing_account_id, created_at);
CREATE INDEX IF NOT EXISTS ix_le_ledger_time ON ledger_entries (ledger_id, created_at);
CREATE INDEX IF NOT EXISTS ix_le_component ON ledger_entries (ledger_id, econ_component_kind, created_at);
CREATE INDEX IF NOT EXISTS ix_le_ccode ON ledger_entries (ledger_id, econ_component_code, created_at) WHERE econ_component_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_le_group ON ledger_entries (entry_group_id) WHERE entry_group_id IS NOT NULL;

-- ---------- ledger_entry_labels ----------
-- 0..N labels per entry for multi-dimensional attribution.
CREATE TABLE IF NOT EXISTS ledger_entry_labels (
  entry_id     uuid NOT NULL REFERENCES ledger_entries(entry_id) ON DELETE CASCADE,
  label_key    text   NOT NULL,
  value_text   text,
  value_uuid   uuid,
  value_bool   boolean,
  value_number numeric,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ledger_entry_labels_pk PRIMARY KEY (entry_id, label_key),
  CONSTRAINT ledger_entry_labels_one_value_chk CHECK (
    ((value_text   IS NOT NULL)::int +
     (value_uuid   IS NOT NULL)::int +
     (value_bool   IS NOT NULL)::int +
     (value_number IS NOT NULL)::int) = 1
  ),
  CONSTRAINT ledger_entry_labels_key_chk CHECK (
    label_key = lower(label_key)
    AND label_key ~ '^[a-z][a-z0-9_]{1,63}$'
  )
);

CREATE INDEX IF NOT EXISTS ix_le_labels_key ON ledger_entry_labels (label_key);


-- ---------- 4) Usage: meters/bindings/events/reports -------------------
CREATE TABLE IF NOT EXISTS meters (
  meter_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id   text    NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,  -- normalized FK to realms
  meter_code text      NOT NULL,
  semantic_kind text   NOT NULL CHECK (semantic_kind IN ('activity','outcome')),
  unit       text      NOT NULL,
  scale      smallint  NOT NULL DEFAULT 0 CHECK (scale BETWEEN 0 AND 18),
  rounding   text      NOT NULL DEFAULT 'round' CHECK (rounding IN ('round','floor','ceil','truncate')),
  active     boolean NOT NULL DEFAULT true,
  metadata   jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_meters_code UNIQUE (realm_id, meter_code),
  CONSTRAINT chk_meter_code_slug CHECK (meter_code ~ '^[a-z0-9]+([._-][a-z0-9]+)*$')
);

-- =====================================================================
-- Internal meter pricing table (XUSD, integer-only)
-- Authoritative inputs for pricing_snapshot at commit-time.
-- Not account-scoped.
-- =====================================================================
CREATE TABLE IF NOT EXISTS meter_prices (
  price_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id                text NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  meter_code              text        NOT NULL,                              -- pricing input 2 (fine-grained meter)
  unit_price_base_xusd    bigint NOT NULL DEFAULT 0 CHECK (unit_price_base_xusd >= 0), -- admin baseline
  unit_price_dynamic_xusd bigint NOT NULL DEFAULT 0, -- signed adjustment applied on top of baseline
  unit_price_xusd         bigint      NOT NULL CHECK (unit_price_xusd >= 0),  -- effective price PER BLOCK in XUSD
  unit_quantity_minor     bigint      NOT NULL DEFAULT 1 CHECK (unit_quantity_minor >= 1), -- minor units per block (≥1)
  rounding                text        NOT NULL DEFAULT 'nearest' CHECK (rounding IN ('floor','nearest','ceil')),

  unit_cost_xusd          bigint      NOT NULL CHECK (unit_cost_xusd >= 0),
  cost_unit_quantity_minor bigint   NOT NULL DEFAULT 1 CHECK (cost_unit_quantity_minor >= 1),
  cost_rounding           text      NOT NULL DEFAULT 'nearest' CHECK (cost_rounding IN ('floor','nearest','ceil')),

  effective_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm_id, meter_code)
);
CREATE INDEX IF NOT EXISTS idx_rcp_meter_code ON meter_prices(realm_id, meter_code);

-- ---------- 5) Provider mappings (Stripe customers etc.) ---------------
CREATE TABLE IF NOT EXISTS provider_customers (
  billing_account_id   uuid NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  provider             text NOT NULL,
  provider_customer_id text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (billing_account_id, provider)
);
CREATE INDEX IF NOT EXISTS ix_provider_customers_provider_customer
  ON provider_customers(provider, provider_customer_id);
-- ---------- 5) Provider snapshots & reconciliation ---------------------
CREATE TABLE IF NOT EXISTS provider_state_snapshots (
  snapshot_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id  uuid NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  provider            text NOT NULL,
  entity_id           text NOT NULL,
  entity_kind         text NOT NULL,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  json                jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_pstate_provider_entity_fetched
ON provider_state_snapshots (provider, entity_id, fetched_at DESC);

CREATE INDEX IF NOT EXISTS ix_pstate_ba_kind_fetched
ON provider_state_snapshots (billing_account_id, entity_kind, fetched_at DESC);


CREATE TABLE IF NOT EXISTS reconciliations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id  uuid NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  kind                text NOT NULL,   -- 'usage_mismatch' | 'status_mismatch' | 'invoice_total_mismatch'
  status              text NOT NULL,   -- 'pending' | 'failed' | 'resolved'
  fingerprint         text NOT NULL,   -- stable dedupe key (see docs/instructions/reconciliations.md)
  diff                jsonb NOT NULL,  -- structured diff per TECH
  provider_state_snapshot_id uuid REFERENCES provider_state_snapshots(snapshot_id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  UNIQUE (billing_account_id, kind, fingerprint)
);
CREATE INDEX IF NOT EXISTS ix_reconciliations_status_created ON reconciliations(status, created_at);

DO $$
BEGIN
  BEGIN
    ALTER TABLE reconciliations
      ADD CONSTRAINT ck_reconciliations_kind CHECK (kind IN ('usage_mismatch','status_mismatch','invoice_total_mismatch'));
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    ALTER TABLE reconciliations
      ADD CONSTRAINT ck_reconciliations_status CHECK (status IN ('pending','failed','resolved'));
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

-- Helper: enable RLS safely (idempotent)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'ledger_accounts',
      'ledger_entries',
      'provider_state_snapshots',
      'reconciliations',
      'provider_customers'
    ]) AS tbl
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.tbl);
  END LOOP;
END$$;

-- Wallet: ledgers
DO $$
BEGIN
  -- SELECT by runtime user
  BEGIN
    CREATE POLICY cl_account_read ON ledger_accounts FOR SELECT USING (
      EXISTS (SELECT 1 FROM billing_accounts ba
                WHERE ba.billing_account_id = ledger_accounts.billing_account_id
                  AND ba.billing_account_id = get_current_billing_account_id()
                  AND ba.realm_id = current_setting('app.realm_id', true))
      AND ledger_accounts.billing_user_id = get_current_billing_user_id()
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- INSERT by runtime user
  BEGIN
    CREATE POLICY cl_account_insert ON ledger_accounts FOR INSERT WITH CHECK (
      ledger_accounts.billing_account_id = get_current_billing_account_id()
      AND ledger_accounts.billing_user_id = get_current_billing_user_id()
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- UPDATE by runtime user
  BEGIN
    CREATE POLICY cl_account_write ON ledger_accounts FOR UPDATE USING (
      ledger_accounts.billing_account_id = get_current_billing_account_id()
      AND ledger_accounts.billing_user_id = get_current_billing_user_id()
    ) WITH CHECK (
      ledger_accounts.billing_account_id = get_current_billing_account_id()
      AND ledger_accounts.billing_user_id = get_current_billing_user_id()
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- Realm admin read
  BEGIN
    CREATE POLICY cl_realm_admin_read ON ledger_accounts FOR SELECT USING (
      current_setting('app.is_realm_admin', true) = 'true' AND
      EXISTS (SELECT 1
                FROM billing_accounts ba
               WHERE ba.billing_account_id = ledger_accounts.billing_account_id
                 AND ba.realm_id = current_setting('app.realm_id', true))
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

-- Wallet: transactions
DO $$
BEGIN
  -- SELECT by runtime user
  BEGIN
    CREATE POLICY ct_account_read ON ledger_entries FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM ledger_accounts cl
        WHERE cl.ledger_id = ledger_entries.ledger_id
          AND cl.billing_account_id = get_current_billing_account_id()
          AND cl.billing_user_id = get_current_billing_user_id()
      )
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- INSERT by runtime user (via ledger join)
  BEGIN
    CREATE POLICY ct_account_write ON ledger_entries FOR INSERT WITH CHECK (
      EXISTS (
        SELECT 1 FROM ledger_accounts cl
        WHERE cl.ledger_id = ledger_entries.ledger_id
          AND cl.billing_account_id = get_current_billing_account_id()
          AND cl.billing_user_id = get_current_billing_user_id()
      )
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- Realm admin read
  BEGIN
    CREATE POLICY ct_realm_admin_read ON ledger_entries FOR SELECT USING (
      current_setting('app.is_realm_admin', true) = 'true' AND
      EXISTS (
        SELECT 1
          FROM ledger_accounts cl
          JOIN billing_accounts ba ON ba.billing_account_id = cl.billing_account_id
         WHERE cl.ledger_id = ledger_entries.ledger_id
           AND ba.realm_id = current_setting('app.realm_id', true)
      )
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

-- Account-scoped tables: uniform policies
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['provider_state_snapshots','reconciliations','provider_customers']
  LOOP
    BEGIN
      EXECUTE format($SQL$
        CREATE POLICY %I_account_read ON %I FOR SELECT USING (
          %I.billing_account_id = get_current_billing_account_id()
        )$SQL$, t, t, t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;

    BEGIN
      EXECUTE format($SQL$
        CREATE POLICY %I_account_write ON %I FOR INSERT WITH CHECK (
          %I.billing_account_id = get_current_billing_account_id()
        )$SQL$, t, t, t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;

    IF t <> 'billing_events' THEN
      BEGIN
        EXECUTE format($SQL$
          CREATE POLICY %I_account_update ON %I FOR UPDATE USING (
            %I.billing_account_id = get_current_billing_account_id()
          ) WITH CHECK (
            %I.billing_account_id = get_current_billing_account_id()
          )$SQL$, t, t, t, t);
      EXCEPTION WHEN duplicate_object THEN NULL; END;
    END IF;

    BEGIN
      EXECUTE format($SQL$
        CREATE POLICY %I_realm_admin_read ON %I FOR SELECT USING (
          current_setting('app.is_realm_admin', true) = 'true' AND
          EXISTS (SELECT 1 FROM billing_accounts ba
                   WHERE ba.billing_account_id = %I.billing_account_id
                     AND ba.realm_id = current_setting('app.realm_id', true))
        )$SQL$, t, t, t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END$$;

-- Provider webhook events (e.g., Stripe)
CREATE TABLE IF NOT EXISTS provider_events (
  provider_event_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id  uuid    NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  provider            text    NOT NULL,                               -- e.g., 'stripe'
  external_event_id   text    NOT NULL,                               -- Stripe evt_*
  event_type          text    NOT NULL,                               -- Stripe: 'checkout.session.completed', etc.
  status              text    NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','skipped','failed')),
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz NULL,
  payload             jsonb   NOT NULL,                               -- full provider event JSON
  UNIQUE (provider, external_event_id)
);

CREATE INDEX IF NOT EXISTS ix_provider_events_ba
  ON provider_events (billing_account_id);

CREATE INDEX IF NOT EXISTS ix_provider_events_provider_type
  ON provider_events (provider, event_type);

CREATE INDEX IF NOT EXISTS ix_provider_events_status_received
  ON provider_events (status, received_at);


-- ---------- 3b) Features & Entitlements --------------------------------

-- FeatureFamily dictionary: realm-local feature_family families
CREATE TABLE IF NOT EXISTS feature_families (
  feature_family_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id        text    NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  feature_family_code text    NOT NULL,
  is_fallback     boolean NOT NULL DEFAULT false,
  name            text    NOT NULL,
  description     text    NOT NULL DEFAULT '',
  active          boolean NOT NULL DEFAULT true,
  entitlement_required boolean NOT NULL DEFAULT true,
  metadata        jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_feature_families_realm_code UNIQUE (realm_id, feature_family_code),
  CONSTRAINT chk_feature_family_code_slug CHECK (feature_family_code ~ '^[a-z0-9]+([._-][a-z0-9]+)*$')
);

-- Feature dictionary: realm-scoped boolean-ish feature_families
CREATE TABLE IF NOT EXISTS features (
  feature_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id     text    NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  feature_family_id uuid   NOT NULL REFERENCES feature_families(feature_family_id) ON DELETE RESTRICT,
  feature_code text    NOT NULL,          -- e.g., 'priority.support', 'chat.beta'
  name         text    NOT NULL,
  description  text    NOT NULL DEFAULT '',
  active       boolean NOT NULL DEFAULT true,
  entitlement_required boolean NULL, -- NULL => inherit feature_family.entitlement_required
  default_budget_strategy text NOT NULL DEFAULT 'auto' CHECK (default_budget_strategy IN ('auto','hot','cold')),
  metadata     jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_features_realm_code UNIQUE (realm_id, feature_code),
  CONSTRAINT chk_feature_code_slug CHECK (feature_code ~ '^[a-z0-9]+([._-][a-z0-9]+)*$')
);

-- Plan-level entitlements (authoritative mapping per billing plan)
CREATE TABLE IF NOT EXISTS billing_plan_entitlements (
  bpe_id     uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id    uuid    NOT NULL REFERENCES billing_plans(plan_id) ON DELETE CASCADE,
  feature_family_id uuid NULL REFERENCES feature_families(feature_family_id) ON DELETE RESTRICT,
  feature_id  uuid   NULL REFERENCES features(feature_id) ON DELETE CASCADE,
  effect      text    NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_bpe_key_at_most_one CHECK (feature_family_id IS NULL OR feature_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bpte_feature
  ON billing_plan_entitlements(plan_id, feature_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bpte_feature_family
  ON billing_plan_entitlements(plan_id, feature_family_id);
CREATE INDEX IF NOT EXISTS idx_bpte_feature_family ON billing_plan_entitlements(feature_family_id);

-- Each realm may have at most one fallback feature_family used for auto-registration.
CREATE UNIQUE INDEX IF NOT EXISTS ux_feature_families_realm_fallback
  ON feature_families(realm_id)
  WHERE is_fallback;

CREATE TABLE IF NOT EXISTS feature_meters (
  feature_id   uuid    NOT NULL REFERENCES features(feature_id) ON DELETE CASCADE,
  meter_id     uuid    NOT NULL REFERENCES meters(meter_id) ON DELETE RESTRICT,
  is_primary   boolean NOT NULL DEFAULT false,  -- 该 feature 的“粗 meter”唯一
  metadata     jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feature_id, meter_id)
);

-- 每个 feature 仅允许一个主绑定
CREATE UNIQUE INDEX ux_feature_meters_primary
ON feature_meters(feature_id)
WHERE is_primary;

DO $$
BEGIN
  BEGIN
    CREATE TRIGGER trg_ledger_accounts_updated_at
    BEFORE UPDATE ON ledger_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE TRIGGER trg_meters_updated_at
    BEFORE UPDATE ON meters
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE TRIGGER trg_feature_families_updated_at
    BEFORE UPDATE ON feature_families
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE TRIGGER trg_features_updated_at
    BEFORE UPDATE ON features
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE TRIGGER trg_billing_plans_updated BEFORE UPDATE ON billing_plans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE TRIGGER trg_billing_plan_assignments_updated BEFORE UPDATE ON billing_plan_assignments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE TRIGGER trg_bpa_mark_grants_switch_dirty
    AFTER INSERT OR UPDATE OR DELETE ON billing_plan_assignments
    FOR EACH ROW EXECUTE FUNCTION mark_grants_switch_dirty();
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE TRIGGER trg_billing_plan_entitlements_updated BEFORE UPDATE ON billing_plan_entitlements
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  EXCEPTION WHEN duplicate_object THEN NULL; END;

END$$;

-- RLS for features: realm-scoped
DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE feature_families ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='feature_families' AND policyname='feature_families_realm_rw') THEN
    CREATE POLICY feature_families_realm_rw ON feature_families FOR ALL USING (
      feature_families.realm_id = current_setting('app.realm_id', true)
    ) WITH CHECK (
      feature_families.realm_id = current_setting('app.realm_id', true)
    );
  END IF;

  BEGIN EXECUTE 'ALTER TABLE features ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='features' AND policyname='features_realm_read') THEN
    CREATE POLICY features_realm_read ON features FOR SELECT USING (
      features.realm_id = current_setting('app.realm_id', true)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='features' AND policyname='features_realm_write') THEN
    CREATE POLICY features_realm_write ON features FOR UPDATE USING (
      features.realm_id = current_setting('app.realm_id', true)
    ) WITH CHECK (
      features.realm_id = current_setting('app.realm_id', true)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='features' AND policyname='features_realm_insert') THEN
    CREATE POLICY features_realm_insert ON features FOR INSERT WITH CHECK (
      features.realm_id = current_setting('app.realm_id', true)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='features' AND policyname='features_realm_delete') THEN
    CREATE POLICY features_realm_delete ON features FOR DELETE USING (
      features.realm_id = current_setting('app.realm_id', true)
    );
  END IF;
END$$;

-- RLS for billing_plans: realm-scoped
DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_plans' AND policyname='bpl_realm_rw') THEN
    CREATE POLICY bpl_realm_rw ON billing_plans FOR ALL USING (
      billing_plans.realm_id = current_setting('app.realm_id', true)
    ) WITH CHECK (
      billing_plans.realm_id = current_setting('app.realm_id', true)
    );
  END IF;
END$$;

-- RLS for billing_plan_assignments: scoped by billing_account_id
DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE billing_plan_assignments ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_plan_assignments' AND policyname='bpa_rw') THEN
    CREATE POLICY bpa_rw ON billing_plan_assignments FOR ALL USING (
      billing_plan_assignments.billing_account_id = get_current_billing_account_id()
      AND (
        get_current_billing_user_id() IS NULL
        OR billing_plan_assignments.assignment_scope = 'account'
        OR billing_plan_assignments.billing_user_id = get_current_billing_user_id()
      )
    ) WITH CHECK (
      billing_plan_assignments.billing_account_id = get_current_billing_account_id()
      AND (
        get_current_billing_user_id() IS NULL
        OR billing_plan_assignments.assignment_scope = 'account'
        OR billing_plan_assignments.billing_user_id = get_current_billing_user_id()
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_plan_assignments' AND policyname='bpa_realm_admin_rw') THEN
    CREATE POLICY bpa_realm_admin_rw ON billing_plan_assignments FOR ALL USING (
      current_setting('app.is_realm_admin', true) = 'true'
      AND EXISTS (
        SELECT 1
        FROM billing_accounts ba
        JOIN billing_plans bp ON bp.plan_id = billing_plan_assignments.plan_id
        WHERE ba.billing_account_id = billing_plan_assignments.billing_account_id
          AND ba.realm_id = current_setting('app.realm_id', true)
          AND bp.realm_id = current_setting('app.realm_id', true)
      )
    ) WITH CHECK (
      current_setting('app.is_realm_admin', true) = 'true'
      AND EXISTS (
        SELECT 1
        FROM billing_accounts ba
        JOIN billing_plans bp ON bp.plan_id = billing_plan_assignments.plan_id
        WHERE ba.billing_account_id = billing_plan_assignments.billing_account_id
          AND ba.realm_id = current_setting('app.realm_id', true)
          AND bp.realm_id = current_setting('app.realm_id', true)
      )
    );
  END IF;
END$$;

-- RLS for billing_plan_entitlements: realm-scoped via billing_plans
DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE billing_plan_entitlements ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_plan_entitlements' AND policyname='bpte_realm_rw') THEN
    CREATE POLICY bpte_realm_rw ON billing_plan_entitlements FOR ALL USING (
      EXISTS (
        SELECT 1 FROM billing_plans bp
        WHERE bp.plan_id = billing_plan_entitlements.plan_id
          AND bp.realm_id = current_setting('app.realm_id', true)
      )
    ) WITH CHECK (
      EXISTS (
        SELECT 1 FROM billing_plans bp
        WHERE bp.plan_id = billing_plan_entitlements.plan_id
          AND bp.realm_id = current_setting('app.realm_id', true)
      )
    );
  END IF;
END$$;

COMMIT;


-- ---------------------------------------------------------------------
-- Ensure all IDENTITY/serial sequences start from >=10000 before seeding (robust for IDENTITY + SERIAL)
DO $$
DECLARE
  r RECORD;
BEGIN
  -- 1) IDENTITY columns: restart to 10000
  FOR r IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE identity_generation IS NOT NULL
      AND table_schema NOT IN ('pg_catalog','information_schema')
      AND table_schema NOT LIKE 'pg_toast%'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I RESTART WITH %s',
                   r.table_schema, r.table_name, r.column_name, 10000);
  END LOOP;

  -- 2) SERIAL sequences owned by columns: set next to 10000
  FOR r IN
    SELECT ns.nspname AS schema_name,
           seq.relname AS seq_name
    FROM pg_class seq
    JOIN pg_namespace ns ON ns.oid = seq.relnamespace
    JOIN pg_depend d ON d.objid = seq.oid AND d.deptype IN ('a','i')
    WHERE seq.relkind = 'S'
      AND ns.nspname NOT IN ('pg_catalog','information_schema')
      AND ns.nspname NOT LIKE 'pg_toast%'
  LOOP
    EXECUTE format('SELECT setval(%L::regclass, 9999, true)', r.schema_name || '.' || r.seq_name);
  END LOOP;
END
$$;

-- Provider customers (mapping BA -> PSP customer)
-- (policies covered by uniform RLS loop above)

-- ---------------------------------------------------------------------


-- =====================================================================
-- Notes:
-- * Application must set:
--     SELECT set_config('app.realm_id',      '<realm>', true);
--     SELECT set_config('app.billing_account_id', '<ba>', true);
--     SELECT set_config('app.is_realm_admin','true|false', true);
-- * Wallet consume should use a single-statement CTE or explicit transaction, e.g.:
--     1) INSERT INTO ledger_entries(ledger_id, amount_xusd, reason, idempotency_key, source_ref)
--        VALUES (...)
--     2) UPDATE ledger_accounts
--          SET balance_xusd = balance_xusd + (SELECT amount_xusd FROM ledger_entries WHERE entry_id = LASTVAL())
--        WHERE ledger_id = ...;
--     Ensure balance checks (hard cap) are enforced atomically in application SQL.
-- * Usage events:
--     - API payloads may use decimal quantities; the server MUST convert to minor units
--       using meters.scale and store in quantity_minor; reports store total_quantity_minor.
-- =====================================================================
-- ---------- 6) Customer Subscriptions (authoritative, account-level) ---
CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id        uuid    NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  subscription_group_id     uuid    NOT NULL REFERENCES subscription_groups(subscription_group_id) ON DELETE RESTRICT,
  status                    text    NOT NULL,  -- 'trialing'|'active'|'past_due'|'canceled'|'incomplete'...
  quantity                  integer NOT NULL DEFAULT 1,
  current_period_start      timestamptz NOT NULL,
  current_period_end        timestamptz NOT NULL,
  cancel_at                 timestamptz NULL,
  cancel_at_period_end      boolean NOT NULL DEFAULT false,
  policy_snapshot           jsonb   NOT NULL DEFAULT '{}'::jsonb,   -- is_stackable/is_exclusive etc.
  meta_snapshot             jsonb   NOT NULL DEFAULT '{}'::jsonb,   -- price/amount snapshots (optional)
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- One active/trialing per account×group when not stackable (policy-driven)
CREATE UNIQUE INDEX IF NOT EXISTS ux_cs_one_active_per_group
ON subscriptions (billing_account_id, subscription_group_id)
WHERE (status IN ('trialing','active')
       AND COALESCE((policy_snapshot->>'is_stackable')::boolean, false) = false);

CREATE INDEX IF NOT EXISTS ix_cs_ba_status
  ON subscriptions (billing_account_id, status);

CREATE INDEX IF NOT EXISTS ix_cs_group_status
  ON subscriptions (subscription_group_id, status);

-- Subscription items (support multiple prices aggregated into one subscription)
CREATE TABLE IF NOT EXISTS subscription_items (
  subscription_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id      uuid NOT NULL REFERENCES subscriptions(subscription_id) ON DELETE CASCADE,
  catalog_price_id     uuid   NULL REFERENCES catalog_prices(catalog_price_id) ON DELETE RESTRICT,
  quantity             integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, catalog_price_id)
);

-- External provider links (non-authoritative; for reconciliation/idempotency)
CREATE TABLE IF NOT EXISTS provider_subscription_links (
  provider                  text   NOT NULL,                 -- 'stripe'
  external_subscription_id  text   NOT NULL,                 -- sub_*
  subscription_id  uuid NOT NULL REFERENCES subscriptions(subscription_id) ON DELETE CASCADE,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_subscription_id),
  UNIQUE (subscription_id, provider)
);

-- Enable RLS on new tables (consistent with project style)
DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'ALTER TABLE subscription_items ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
END$$;

-- RLS policies for subscriptions (account-scoped + realm-admin read)
DO $$
BEGIN
  -- SELECT by same billing account
  BEGIN
    CREATE POLICY cs_account_read ON subscriptions FOR SELECT USING (
      subscriptions.billing_account_id = get_current_billing_account_id()
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- INSERT by same billing account
  BEGIN
    CREATE POLICY cs_account_write ON subscriptions FOR INSERT WITH CHECK (
      subscriptions.billing_account_id = get_current_billing_account_id()
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- UPDATE by same billing account
  BEGIN
    CREATE POLICY cs_account_update ON subscriptions FOR UPDATE USING (
      subscriptions.billing_account_id = get_current_billing_account_id()
    ) WITH CHECK (
      subscriptions.billing_account_id = get_current_billing_account_id()
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- Realm admin read-through
  BEGIN
    CREATE POLICY cs_realm_admin_read ON subscriptions FOR SELECT USING (
      current_setting('app.is_realm_admin', true) = 'true' AND
      EXISTS (SELECT 1 FROM billing_accounts ba
                WHERE ba.billing_account_id = subscriptions.billing_account_id
                  AND ba.realm_id = current_setting('app.realm_id', true))
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

-- RLS policies for subscription_items (delegated to parent)
DO $$
BEGIN
  -- SELECT
  BEGIN
    CREATE POLICY csi_account_read ON subscription_items FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM subscriptions cs
        WHERE cs.subscription_id = subscription_items.subscription_id
          AND cs.billing_account_id = get_current_billing_account_id()
      )
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- INSERT
  BEGIN
    CREATE POLICY csi_account_write ON subscription_items FOR INSERT WITH CHECK (
      EXISTS (
        SELECT 1 FROM subscriptions cs
        WHERE cs.subscription_id = subscription_items.subscription_id
          AND cs.billing_account_id = get_current_billing_account_id()
      )
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- UPDATE
  BEGIN
    CREATE POLICY csi_account_update ON subscription_items FOR UPDATE USING (
      EXISTS (
        SELECT 1 FROM subscriptions cs
        WHERE cs.subscription_id = subscription_items.subscription_id
          AND cs.billing_account_id = get_current_billing_account_id()
      )
    ) WITH CHECK (
      EXISTS (
        SELECT 1 FROM subscriptions cs
        WHERE cs.subscription_id = subscription_items.subscription_id
          AND cs.billing_account_id = get_current_billing_account_id()
      )
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- Realm admin read-through
  BEGIN
    CREATE POLICY csi_realm_admin_read ON subscription_items FOR SELECT USING (
      current_setting('app.is_realm_admin', true) = 'true' AND
      EXISTS (
        SELECT 1 FROM subscriptions cs
        JOIN billing_accounts ba ON ba.billing_account_id = cs.billing_account_id
        WHERE cs.subscription_id = subscription_items.subscription_id
          AND ba.realm_id = current_setting('app.realm_id', true)
      )
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

-- --------------------------------------------------------------------------
-- 1) budgets (budget anchor)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budgets (
  budget_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_user_id     UUID NOT NULL REFERENCES billing_users(billing_user_id) ON DELETE CASCADE,
  billing_account_id  UUID NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  name                TEXT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closing','closed','expired','canceled')),

  -- optional scoping
  scope_kind          TEXT NULL CHECK (scope_kind IN ('global','feature','feature_set')),
  scope_ref           TEXT  NULL,    -- stable ref for the scope (e.g. feature_code)
  scope_payload       JSONB NULL,

  -- counters (integers in XUSD)
  consumed_xusd       BIGINT NOT NULL DEFAULT 0 CHECK (consumed_xusd >= 0),
  reserved_xusd       BIGINT NOT NULL DEFAULT 0 CHECK (reserved_xusd >= 0),

  -- optional absolute cap (NULL = no cap)
  limit_xusd          BIGINT NULL CHECK (limit_xusd >= 0),

  -- optional low/high water marks & lifecycle window
  lwm_xusd            BIGINT NULL,
  hwm_xusd            BIGINT NULL,
  window_start        TIMESTAMPTZ NULL,
  window_end          TIMESTAMPTZ NULL CHECK (window_end IS NULL OR window_start IS NULL OR window_end > window_start),
  closed_at           TIMESTAMPTZ NULL,

  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_budgets_scope_ref_presence CHECK (
    (scope_kind IS NULL AND scope_ref IS NULL)
    OR (scope_kind = 'global'      AND scope_ref IS NULL)
    OR (scope_kind IN ('feature','feature_set') AND scope_ref IS NOT NULL)
  ),
  CONSTRAINT fk_budgets_user_account
    FOREIGN KEY (billing_user_id, billing_account_id)
    REFERENCES billing_users(billing_user_id, billing_account_id)
    ON DELETE CASCADE

);


-- High-frequency lookups
CREATE INDEX IF NOT EXISTS ix_budgets_close_status ON budgets (budget_id, status, closed_at);
CREATE INDEX IF NOT EXISTS ix_budgets_user_status ON budgets (billing_user_id, status);
CREATE INDEX IF NOT EXISTS ix_budgets_acct_status ON budgets (billing_account_id, status);
CREATE INDEX IF NOT EXISTS ix_budgets_scope_kind   ON budgets (scope_kind);
-- Optional: scope payload search
CREATE INDEX IF NOT EXISTS ix_budgets_scope_payload_gin ON budgets USING GIN (scope_payload jsonb_path_ops);

-- --------------------------------------------------------------------------
-- 5) Row Level Security
-- --------------------------------------------------------------------------
-- budgets — enable RLS
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- budgets_is_owner
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename  = 'budgets'
      AND policyname = 'budgets_is_owner'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY budgets_is_owner
      ON budgets
      USING (
        billing_account_id = get_current_billing_account_id()
        AND billing_user_id = get_current_billing_user_id()
      )
      WITH CHECK (
        billing_account_id = get_current_billing_account_id()
        AND billing_user_id = get_current_billing_user_id()
      )
    $pol$;
  END IF;

  -- budgets_realm_admin_read（保守写法：同 realm 可读；如需只给 admin 角色，把这一行改成 `FOR SELECT TO your_admin_role`）
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename  = 'budgets'
      AND policyname = 'budgets_realm_admin_read'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY budgets_realm_admin_read
      ON budgets
      FOR SELECT
      USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND
        EXISTS (
          SELECT 1
          FROM billing_accounts ba
          WHERE ba.billing_account_id = budgets.billing_account_id
            AND ba.realm_id = current_setting('app.realm_id', true)
        )
      )
    $pol$;
  END IF;
END
$$ LANGUAGE plpgsql;


-- =====================================================================
-- idempotency_envelopes
-- Global idempotency envelopes: request dedupe anchor + optional req/resp replay
-- =====================================================================

CREATE TABLE IF NOT EXISTS idempotency_envelopes (
  idempotency_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- tenancy & classification
  realm_id             TEXT        NOT NULL,
  service              TEXT        NOT NULL,      -- e.g. 'gate' | 'billing' | 'iam'
  operation            TEXT        NOT NULL,      -- e.g. 'commit' | 'authorize' | 'cancel'

  -- generic scope (free-form; avoid hard coupling to domain tables)
  scope_type           TEXT        NOT NULL DEFAULT 'none',  -- 'none' | 'lease' | 'user' | 'account' | others
  scope_id             TEXT        NULL,                     -- free-form scope identifier

  -- runtime user/account dimensions (user is the runtime idempotency anchor)
  billing_user_id      UUID        NULL REFERENCES billing_users(billing_user_id) ON DELETE SET NULL,
  billing_account_id   UUID        NULL REFERENCES billing_accounts(billing_account_id) ON DELETE SET NULL,

  -- idempotency key & request fingerprint
  key                  TEXT        NOT NULL,      -- from Idempotency-Key header
  request_hash         TEXT        NOT NULL,      -- sha256 (hex/base64) of canonicalized request body

  -- lifecycle & replay
  status               TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending','completed','failed')),
  request_snapshot     JSONB       NULL,          -- optional: raw request for audit
  response_snapshot    JSONB       NULL,          -- optional: exact response for replay
  result_ref           JSONB       NULL,          -- optional: { commit_ids:[...]} etc.

  metadata             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at         TIMESTAMPTZ NULL,

  -- structural sanity (do NOT enumerate all scope types; only constrain known ones)
  CHECK (scope_type <> 'account' OR billing_account_id IS NOT NULL),
  CHECK (scope_type <> 'user' OR billing_user_id IS NOT NULL),
  CHECK (scope_type <> 'lease'   OR scope_id IS NOT NULL),
  CHECK (scope_type <> 'none'    OR (scope_id IS NULL AND billing_account_id IS NULL AND billing_user_id IS NULL))
);

-- -----------------------------
-- Uniqueness per scope (partial)
-- -----------------------------
-- lease-scoped: uniqueness by scope_id
CREATE UNIQUE INDEX IF NOT EXISTS ux_ie_lease
  ON idempotency_envelopes (realm_id, service, operation, scope_type, scope_id, key)
  WHERE scope_type = 'lease' AND scope_id IS NOT NULL;

-- user-scoped: uniqueness by billing_user_id
CREATE UNIQUE INDEX IF NOT EXISTS ux_ie_user
  ON idempotency_envelopes (realm_id, service, operation, scope_type, billing_user_id, key)
  WHERE scope_type = 'user' AND billing_user_id IS NOT NULL;

-- account-scoped: uniqueness by billing_account_id (account/payor APIs only)
CREATE UNIQUE INDEX IF NOT EXISTS ux_ie_account
  ON idempotency_envelopes (realm_id, service, operation, scope_type, billing_account_id, key)
  WHERE scope_type = 'account' AND billing_account_id IS NOT NULL;

-- none-scoped: truly global under (realm, svc, op)
CREATE UNIQUE INDEX IF NOT EXISTS ux_ie_none
  ON idempotency_envelopes (realm_id, service, operation, key)
  WHERE scope_type = 'none';

-- other/unknown scopes: default uniqueness by (scope_type, scope_id)
CREATE UNIQUE INDEX IF NOT EXISTS ux_ie_other
  ON idempotency_envelopes (realm_id, service, operation, scope_type, COALESCE(scope_id, ''), key)
  WHERE scope_type NOT IN ('lease','user','account','none');

-- Helpful secondary indexes
CREATE INDEX IF NOT EXISTS ix_ie_created    ON idempotency_envelopes (created_at);
CREATE INDEX IF NOT EXISTS ix_ie_status     ON idempotency_envelopes (status);
CREATE INDEX IF NOT EXISTS ix_ie_svc_op     ON idempotency_envelopes (service, operation);
CREATE INDEX IF NOT EXISTS ix_ie_user       ON idempotency_envelopes (billing_user_id);
CREATE INDEX IF NOT EXISTS ix_ie_account    ON idempotency_envelopes (billing_account_id);
CREATE INDEX IF NOT EXISTS ix_ie_lookup     ON idempotency_envelopes (realm_id, service, operation, key);

-- 若存在 billing_user_id，则须匹配当前 runtime user；account-only envelopes are for account/payor APIs.
ALTER TABLE idempotency_envelopes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  BEGIN
    CREATE POLICY ie_rw ON idempotency_envelopes
      FOR ALL
      USING (
        realm_id = current_setting('app.realm_id', true)
        AND (
          (billing_user_id IS NULL OR billing_user_id = get_current_billing_user_id())
          AND (billing_account_id IS NULL OR billing_account_id = get_current_billing_account_id())
        )
      )
      WITH CHECK (
        realm_id = current_setting('app.realm_id', true)
        AND (
          (billing_user_id IS NULL OR billing_user_id = get_current_billing_user_id())
          AND (billing_account_id IS NULL OR billing_account_id = get_current_billing_account_id())
        )
      );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

-- =====================================================================
CREATE OR REPLACE FUNCTION idempotency_envelopes_guard_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.billing_account_id IS DISTINCT FROM OLD.billing_account_id) THEN
      RAISE EXCEPTION 'billing_account_id is immutable once inserted'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END$$;

DO $$
BEGIN
  -- 避免重复创建
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_ie_forbid_bacct_change'
  ) THEN
    CREATE TRIGGER trg_ie_forbid_bacct_change
      BEFORE UPDATE ON idempotency_envelopes
      FOR EACH ROW
      EXECUTE FUNCTION idempotency_envelopes_guard_account();
  END IF;
END$$;


-- ---------- grant_programs ----------
-- Issuance semantics: cadence/amount/window/on-ledger/accounting/mode (scoped by realm)
CREATE TABLE IF NOT EXISTS grant_programs (
  program_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id                text      NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  program_code            text      NOT NULL,                         -- unique business key per realm
  name                    text,
  active                  boolean   NOT NULL DEFAULT true,

  -- Profile parameters
  cadence                 text      NOT NULL CHECK (cadence IN ('once','daily','weekly','monthly','quarterly','yearly','billing_period')),
  issue_anchor            text      NOT NULL CHECK (issue_anchor IN ('calendar_start','binding_start','first_use')),
  amount_xusd             bigint    NOT NULL CHECK (amount_xusd >= 0),

  -- Default window strategy (can be overridden at binding/catalog layer)
  window_kind             text      NOT NULL CHECK (window_kind IN ('period','fixed','forever','relative_duration')),
  window_default_seconds  integer   NULL CHECK (window_default_seconds IS NULL OR window_default_seconds > 0),

  priority                integer   NOT NULL DEFAULT 0,
  on_ledger               boolean   NOT NULL DEFAULT false,           -- true = asset-like; GL entry on issuance

  -- Issuance/accounting
  issuance_mode           text      NOT NULL CHECK (issuance_mode IN ('eager','lazy','hybrid')),
  periodic_accounting     boolean   NOT NULL DEFAULT false,           -- month-end forfeit/refund/rollover etc.
  accrual_mode            text      NULL     CHECK (accrual_mode IN ('full_at_period_start','earn_daily')),

  eligibility_kind        text NOT NULL DEFAULT 'manual',
  eligibility_payload     jsonb NOT NULL DEFAULT '{}'::jsonb,

  metadata                jsonb     NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_grant_programs_program_code UNIQUE (realm_id, program_code)
);

-- ---------- grant_campaigns ----------
-- Scheduled/segment-based activations that bind a program during a validity window
CREATE TABLE IF NOT EXISTS grant_campaigns (
  campaign_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id              text        NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  name                  text        NOT NULL,
  status                text        NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','paused','ended')),
  window_start          timestamptz NOT NULL DEFAULT now(),
  window_end            timestamptz NULL,
  target_filter         jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- optional audience/segment definition
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_gc_realm_name UNIQUE (realm_id, name)
);

CREATE INDEX IF NOT EXISTS ix_gc_realm_status_start ON grant_campaigns (realm_id, status, window_start);
CREATE INDEX IF NOT EXISTS ix_gc_realm_window ON grant_campaigns (realm_id, window_start, window_end);

-- ---------- grant_assignments ----------
-- Assign a program to a billing user (webhook/subscription/ops); drives grant creation
CREATE TABLE IF NOT EXISTS grant_assignments (
  assignment_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_user_id       uuid      NOT NULL REFERENCES billing_users(billing_user_id) ON DELETE CASCADE,
  billing_account_id    uuid      NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  program_id            uuid      NOT NULL REFERENCES grant_programs(program_id) ON DELETE RESTRICT,
  billing_plan_assignment_id uuid NULL REFERENCES billing_plan_assignments(assignment_id) ON DELETE SET NULL,
  campaign_id           uuid      NULL REFERENCES grant_campaigns(campaign_id) ON DELETE SET NULL,

  -- Provenance (for idempotency/traceability)
  source_kind           text      NOT NULL CHECK (source_kind IN (
                           'provider.subscription','provider.subscription_item','provider.one_time',
                           'wallet.cash','ops.campaign','ops.manual','internal.catalog','billing_plan_assignment'
                         )),
  source_ref            text      NOT NULL,

  -- Binding effective window (often aligned with subscription period)
  window_start          timestamptz NOT NULL,
  window_end            timestamptz NULL,
  valid_range           tstzrange   GENERATED ALWAYS AS (tstzrange(window_start, COALESCE(window_end, 'infinity'::timestamptz))) STORED,

  status                text      NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','canceled','expired')),
  metadata              jsonb     NOT NULL DEFAULT '{}'::jsonb,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (billing_user_id, source_kind, source_ref, program_id),
  CONSTRAINT fk_ga_user_account
    FOREIGN KEY (billing_user_id, billing_account_id)
    REFERENCES billing_users(billing_user_id, billing_account_id)
    ON DELETE CASCADE,
  CONSTRAINT chk_ga_bpa_id_required CHECK (source_kind <> 'billing_plan_assignment' OR billing_plan_assignment_id IS NOT NULL),
  CONSTRAINT chk_ga_campaign_id_required CHECK (source_kind <> 'ops.campaign' OR campaign_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_ga_bu_program    ON grant_assignments (billing_user_id, program_id, status);
CREATE INDEX IF NOT EXISTS ix_ga_ba_program    ON grant_assignments (billing_account_id, program_id, status);
CREATE INDEX IF NOT EXISTS ix_ga_ba_bpa        ON grant_assignments (billing_account_id, billing_plan_assignment_id);
CREATE INDEX IF NOT EXISTS ix_ga_ba_campaign   ON grant_assignments (billing_account_id, campaign_id);
CREATE INDEX IF NOT EXISTS ix_ga_source        ON grant_assignments (source_kind, source_ref);
CREATE INDEX IF NOT EXISTS ix_ga_range_gist    ON grant_assignments USING gist (valid_range);

-- ---------- ledger_grants ----------
-- Merged model: one row = one issuance decision (from a binding) + one consumable lot (strict 1:1)
CREATE TABLE IF NOT EXISTS ledger_grants (
  grant_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_user_id        uuid     NOT NULL REFERENCES billing_users(billing_user_id) ON DELETE CASCADE,
  billing_account_id     uuid     NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  ledger_id              uuid     NULL     REFERENCES ledger_accounts(ledger_id) ON DELETE SET NULL,

  -- Issuance-side metadata (merged from the former grant_issuances)
  assignment_id          uuid     NOT NULL REFERENCES grant_assignments(assignment_id) ON DELETE RESTRICT,
  program_id             uuid     NULL REFERENCES grant_programs(program_id) ON DELETE SET NULL,
  -- period_*: issuance/accounting period (for closing & idempotency), NOT used for runtime availability
  period_start           timestamptz NULL,
  period_end             timestamptz NULL CHECK (period_end IS NULL OR period_start IS NULL OR period_end > period_start),
  alloc_seq              integer  NOT NULL DEFAULT 0,                 -- multiple issuances in same period → multiple rows
  idempotency_key        text     NULL,                               -- optional cross-system idempotency
  source_kind            text     NULL,
  source_ref             text     NULL,
  on_ledger              boolean  NOT NULL DEFAULT false,             -- final decision for this lot
  issuance_status        text     NOT NULL DEFAULT 'ready' CHECK (issuance_status IN ('ready','active','suspended','pending_close','closed','canceled')),

  -- Lot truth (amount/window/consumption)
  kind                   text     NOT NULL DEFAULT 'grant' CHECK (kind IN ('grant','sponsorship','promo','credit','cash','wallet','rollover','nonexpiring','fallback','other')),
-- window_*: consumption window (for runtime availability & expiry), used by selection (earliest-expiring-first)
  window_start           timestamptz NULL,
  window_end             timestamptz NULL CHECK (window_end IS NULL OR window_start IS NULL OR window_end > window_start),
  priority               integer  NOT NULL DEFAULT 0,
  amount_xusd            bigint   NOT NULL CHECK (amount_xusd >= 0),
  cost_xusd              bigint   NOT NULL DEFAULT 0 CHECK (cost_xusd >= 0),
  posted_consumed_xusd   bigint   NOT NULL DEFAULT 0 CHECK (posted_consumed_xusd >= 0),
  pending_reserved_xusd  bigint   NOT NULL DEFAULT 0 CHECK (pending_reserved_xusd >= 0),

  -- Provenance (optional GL linkage for on-ledger issuances)
  source_entry_id        uuid     NULL REFERENCES ledger_entries(entry_id) ON DELETE SET NULL,
  metadata               jsonb    NOT NULL DEFAULT '{}'::jsonb,
  closure_kind           text     NULL CHECK (closure_kind IN ('forfeit','refund','carryover','none')),
  closure_entry_id       uuid     NULL REFERENCES ledger_entries(entry_id) ON DELETE SET NULL,
  closed_at              timestamptz NULL,
  closed_remaining_xusd  bigint   NULL CHECK (closed_remaining_xusd >= 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- Idempotent upsert key: one binding + one period + one seq → one row.
  -- Use NULLS NOT DISTINCT so open-ended one-time grants (period_end IS NULL) still collide.
  CONSTRAINT ux_ledger_grants_assignment_period_seq UNIQUE NULLS NOT DISTINCT (assignment_id, period_start, period_end, alloc_seq),
  CONSTRAINT fk_lg_user_account
    FOREIGN KEY (billing_user_id, billing_account_id)
    REFERENCES billing_users(billing_user_id, billing_account_id)
    ON DELETE CASCADE
);

-- Partial uniqueness for non-null idempotency keys, scoped to the runtime billing user.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_grants_idem
  ON ledger_grants(billing_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Fallback grants are period-scoped overage buckets (one per user × period).
CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_fallback_one_per_user_period
  ON ledger_grants (billing_user_id, kind, period_start, period_end)
  WHERE kind = 'fallback' AND period_start IS NOT NULL AND period_end IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_grants_fallback_bu_period_end
  ON ledger_grants (billing_user_id, kind, period_end DESC)
  WHERE kind = 'fallback' AND period_end IS NOT NULL;

-- Hot-path indexes: selection and audit
CREATE INDEX IF NOT EXISTS ix_ledger_grants_bu_window_pri
  ON ledger_grants(billing_user_id, window_end, priority);
CREATE INDEX IF NOT EXISTS ix_ledger_grants_ba_window_pri
  ON ledger_grants(billing_account_id, window_end, priority);
CREATE INDEX IF NOT EXISTS ix_ledger_grants_assignment_period
  ON ledger_grants(assignment_id, period_start, period_end);

-- =====================================================================
-- Billing ratings (authoritative priced facts) + rated records + allocations
-- Formerly gate_commits/gate_commit_lines/gate_commit_settlements.
-- These tables are internal and back the pricing/cost/settlement audit trail.
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'billing_direction'
      AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE billing_direction AS ENUM ('debit', 'credit');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS billing_ratings (
  rating_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id                   text        NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_user_id            uuid        NOT NULL REFERENCES billing_users(billing_user_id) ON DELETE CASCADE,
  billing_account_id         uuid        NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,

  -- rating variant
  rating_kind                text        NOT NULL DEFAULT 'gate'
                                       CHECK (rating_kind IN ('gate','ingest')),
  source_ref                 text        NULL,
  feature_code               text        NOT NULL,
  budget_id                  uuid        NULL,
  direction                  billing_direction NOT NULL DEFAULT 'debit',
  reversal_of_rating_id      uuid        NULL REFERENCES billing_ratings(rating_id) ON DELETE SET NULL,
  -- idempotency & context (immutable)
  idempotency_id             uuid        NOT NULL,   -- logical ref (e.g., idempotency_envelopes.id)

  -- canonical feature-level usage & amount (authoritative)
  canonical_quantity_minor   bigint      NOT NULL CHECK (canonical_quantity_minor >= 0),
  canonical_amount_xusd     bigint      NOT NULL CHECK (canonical_amount_xusd  >= 0),
  canonical_cost_xusd       bigint      NOT NULL CHECK (canonical_cost_xusd  >= 0),

  -- aggregated from records; immutable for the rating
  pricing_fingerprint        text        NOT NULL,
  pricing_cost_fingerprint  text        NOT NULL,

  -- rating-time cost snapshot (immutable; mirrors pricing_snapshot)
  cost_snapshot             jsonb       NOT NULL,
  cost_fingerprint          text        NOT NULL,

  metadata                   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  rated_at                   timestamptz NOT NULL DEFAULT now(),
  created_at                 timestamptz NOT NULL DEFAULT now(),

  UNIQUE (realm_id, idempotency_id),
  CONSTRAINT fk_br_user_account
    FOREIGN KEY (billing_user_id, billing_account_id)
    REFERENCES billing_users(billing_user_id, billing_account_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_br_buser_rated   ON billing_ratings (billing_user_id, rated_at);
CREATE INDEX IF NOT EXISTS ix_br_bacct_rated   ON billing_ratings (billing_account_id, rated_at);
CREATE INDEX IF NOT EXISTS ix_br_feature_rated ON billing_ratings (feature_code, rated_at);
CREATE INDEX IF NOT EXISTS ix_br_fp            ON billing_ratings (pricing_fingerprint);
CREATE UNIQUE INDEX IF NOT EXISTS ux_br_reversal_of_rating
  ON billing_ratings (reversal_of_rating_id)
  WHERE reversal_of_rating_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_br_realm_rated_feature
  ON billing_ratings (realm_id, rated_at, feature_code);

CREATE INDEX IF NOT EXISTS ix_br_realm_rated_pricing_fp
  ON billing_ratings (realm_id, rated_at, pricing_fingerprint);

CREATE INDEX IF NOT EXISTS ix_br_realm_bacct_rated
  ON billing_ratings (realm_id, billing_account_id, rated_at);

CREATE INDEX IF NOT EXISTS ix_br_realm_buser_rated
  ON billing_ratings (realm_id, billing_user_id, rated_at);

-- =====================================================================
-- Phase 2: Ratings aggregation runs (windowed, N inputs -> 1 rating)
-- User-scoped rating aggregation (billing_user_id is required); account id is denormalized for reports.
-- Requires billing_ratings to exist.
-- =====================================================================

CREATE TABLE IF NOT EXISTS billing_ratings_aggregation_runs (
  run_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id             text   NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_user_id      uuid   NOT NULL REFERENCES billing_users(billing_user_id) ON DELETE CASCADE,
  billing_account_id   uuid   NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  contract_id          uuid   NULL, -- resolved by caller; may be null when no active contract
  policy_id            text   NOT NULL,
  policy_version       text   NOT NULL,
  window_kind          text   NOT NULL CHECK (window_kind IN ('day')),
  window_start         timestamptz NOT NULL,
  window_end           timestamptz NOT NULL,
  group_key            text   NOT NULL, -- stable group identifier (caller-defined; may encode multiple dimensions)
  aggregated_input_count bigint NULL CHECK (aggregated_input_count IS NULL OR aggregated_input_count >= 0),
  aggregated_quantity_minor bigint NULL CHECK (aggregated_quantity_minor IS NULL OR aggregated_quantity_minor >= 0),
  aggregated_metrics    jsonb  NOT NULL DEFAULT '{}'::jsonb,
  rating_id            uuid NOT NULL REFERENCES billing_ratings(rating_id) ON DELETE RESTRICT,
  idempotency_key      text   NOT NULL,
  metadata             jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm_id, billing_user_id, contract_id, policy_id, policy_version, window_start, group_key),
  UNIQUE (idempotency_key),
  CONSTRAINT fk_brar_user_account
    FOREIGN KEY (billing_user_id, billing_account_id)
    REFERENCES billing_users(billing_user_id, billing_account_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_brar_realm_window
  ON billing_ratings_aggregation_runs (realm_id, window_start);
CREATE INDEX IF NOT EXISTS ix_brar_ba_window
  ON billing_ratings_aggregation_runs (billing_account_id, window_start);
CREATE INDEX IF NOT EXISTS ix_brar_bu_window
  ON billing_ratings_aggregation_runs (billing_user_id, window_start);
CREATE INDEX IF NOT EXISTS ix_brar_rating
  ON billing_ratings_aggregation_runs (rating_id);

DO $$
BEGIN
  BEGIN
    CREATE TRIGGER trg_billing_ratings_aggregation_runs_updated_at
    BEFORE UPDATE ON billing_ratings_aggregation_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

DO $$
DECLARE
  expr text;
BEGIN
  BEGIN EXECUTE 'ALTER TABLE billing_ratings_aggregation_runs ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  expr := 'billing_ratings_aggregation_runs.billing_user_id = get_current_billing_user_id()
           AND billing_ratings_aggregation_runs.billing_account_id = get_current_billing_account_id()
           AND billing_ratings_aggregation_runs.realm_id = current_setting(''app.realm_id'', true)';
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', 'brar_read', 'billing_ratings_aggregation_runs', expr); EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', 'brar_insert', 'billing_ratings_aggregation_runs', expr); EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', 'brar_update', 'billing_ratings_aggregation_runs', expr, expr); EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', 'brar_delete', 'billing_ratings_aggregation_runs', expr); EXCEPTION WHEN duplicate_object THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_ratings_aggregation_runs' AND policyname='brar_realm_admin_rw') THEN
    CREATE POLICY brar_realm_admin_rw ON billing_ratings_aggregation_runs FOR ALL
      USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND billing_ratings_aggregation_runs.realm_id = current_setting('app.realm_id', true)
      )
      WITH CHECK (
        current_setting('app.is_realm_admin', true) = 'true'
        AND billing_ratings_aggregation_runs.realm_id = current_setting('app.realm_id', true)
      );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS billing_rated_records (
  rated_record_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rating_id                  uuid        NOT NULL REFERENCES billing_ratings(rating_id) ON DELETE RESTRICT,

  meter_code                 text        NOT NULL,
  quantity_minor             bigint      NOT NULL CHECK (quantity_minor >= 0),

  -- priced result at rating time (authoritative per record)
  amount_xusd               bigint      NOT NULL CHECK (amount_xusd >= 0),
  -- cost at rating time (authoritative per record; mirrors revenue)
  cost_xusd                 bigint      NOT NULL CHECK (cost_xusd >= 0),

  -- extracted from snapshot for fast filters/diagnostics
  unit_price_xusd            bigint      NOT NULL CHECK (unit_price_xusd >= 0),
  unit_quantity_minor        bigint      NOT NULL DEFAULT 1 CHECK (unit_quantity_minor >= 1),
  rounding                   text        NOT NULL DEFAULT 'nearest'
                                       CHECK (rounding IN ('floor','nearest','ceil')),
  -- cost unit/sizing & rounding (mirrors revenue unit config)
  unit_cost_xusd             bigint      NOT NULL CHECK (unit_cost_xusd >= 0),
  cost_unit_quantity_minor  bigint      NOT NULL DEFAULT 1 CHECK (cost_unit_quantity_minor >= 1),
  cost_rounding             text        NOT NULL DEFAULT 'nearest'
                                       CHECK (cost_rounding IN ('floor','nearest','ceil')),

  -- full rating-time pricing snapshot (immutable)
  pricing_snapshot           jsonb       NOT NULL,
  pricing_fingerprint        text        NOT NULL,
  -- rating-time cost snapshot (immutable; mirrors pricing_snapshot)
  cost_snapshot             jsonb       NOT NULL,
  cost_fingerprint          text        NOT NULL,

  metadata                   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_brr_rating_meter
  ON billing_rated_records (rating_id, meter_code);

CREATE INDEX IF NOT EXISTS ix_brr_rating_costfp
  ON billing_rated_records (rating_id, cost_fingerprint);

-- ------------------------------------------------------------
-- Rating labels (row-specific; stored separately from idempotency envelopes)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_rating_labels (
  rating_id   uuid        NOT NULL REFERENCES billing_ratings(rating_id) ON DELETE CASCADE,
  key         text        NOT NULL,
  value       text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rating_id, key)
);

CREATE INDEX IF NOT EXISTS ix_brl_value ON billing_rating_labels (value);

-- ---------- billing_rating_allocations (per-grant allocation rows) ----------
CREATE TABLE IF NOT EXISTS billing_rating_allocations (
  allocation_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id                   text        NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,

  -- anchor to immutable rating facts (now N rows per rating: one per funding source)
  rating_id              uuid        NOT NULL REFERENCES billing_ratings(rating_id) ON DELETE RESTRICT,
  direction              billing_direction NOT NULL DEFAULT 'debit',

  -- denormalized fields for fast scanning/grouping
  billing_user_id         uuid        NOT NULL,
  billing_account_id      uuid        NOT NULL,
  budget_id               uuid        NULL,
  feature_code            text        NOT NULL,
  pricing_fingerprint     text        NULL,
  cost_fingerprint        text        NULL,

  -- per-allocation attributes
  grant_id                uuid        NULL REFERENCES ledger_grants(grant_id) ON DELETE SET NULL,
  funding_kind            text        NOT NULL
                                 CHECK (funding_kind IN ('grant','cash','credit','other')),
  allocated_xusd         bigint      NOT NULL CHECK (allocated_xusd >= 0),   -- locked at rating
  alloc_seq               smallint    NOT NULL DEFAULT 1 CHECK (alloc_seq >= 1), -- support splits
  reversal_of_allocation_id uuid      NULL REFERENCES billing_rating_allocations(allocation_id) ON DELETE SET NULL,

  -- application decision (expanded)
  application_status      text        NOT NULL DEFAULT 'applied'
                                 CHECK (application_status IN ('applied','quarantined','applied_clipped','reversed','error')),
  reason_codes            text[]      NOT NULL DEFAULT '{}'::text[],
  late_rating             boolean     NOT NULL DEFAULT false,

  -- canonical totals copied from rating (for reference/audit; repeated across rows)
  amount_xusd             bigint      NOT NULL,
  cost_xusd               bigint      NOT NULL,
  rated_at                timestamptz NOT NULL,

  -- actually applied values (quarantine => 0; clipped < canonical; applied == allocated or <= canonical)
  applied_quantity_minor  bigint      NOT NULL DEFAULT 0 CHECK (applied_quantity_minor >= 0),
  applied_amount_xusd     bigint      NOT NULL DEFAULT 0 CHECK (applied_amount_xusd  >= 0),
  applied_cost_xusd       bigint      NOT NULL DEFAULT 0 CHECK (applied_cost_xusd   >= 0),

  -- optional usage window snapshot for clipping decisions
  usage_started_at        timestamptz NULL,
  usage_finished_at       timestamptz NULL,

  -- decision timestamp
  decided_at              timestamptz NOT NULL DEFAULT now(),

  -- settlement runner scope/batching (unchanged semantics)
  settlement_scope_kind   text        NULL,
  settlement_scope_key    text        NULL,
  settlement_batch_id     uuid        NULL,
  engine                  text        NULL,
  engine_run_id           text        NULL,

  settlement_state        text        NOT NULL DEFAULT 'pending'
                                 CHECK (settlement_state IN ('pending','settling','settled','voided','error')),
  entry_id                uuid        NULL REFERENCES ledger_entries(entry_id) ON DELETE SET NULL,
  entry_ref                 text        NULL,          -- optional external reference or aggregation key
  entry_amount_xusd         bigint      NULL,
  entry_reason              text        NULL,
  settled_at              timestamptz NULL,

  -- diagnostics
  error_code              text        NULL,
  error_message           text        NULL,

  metadata                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- idempotency/uniqueness: one row per (rating x funding source x split)
  UNIQUE (rating_id, grant_id, funding_kind, alloc_seq),
  CONSTRAINT fk_bra_user_account
    FOREIGN KEY (billing_user_id, billing_account_id)
    REFERENCES billing_users(billing_user_id, billing_account_id)
    ON DELETE CASCADE
);

-- task-queue / scanning indexes (retain originals and add grant-focused ones)
CREATE INDEX IF NOT EXISTS idx_bra_unsettled_by_scope
  ON billing_rating_allocations (settlement_scope_kind, settlement_scope_key, settlement_state, rated_at)
  WHERE settlement_state <> 'settled';

CREATE INDEX IF NOT EXISTS idx_bra_unsettled_bacct
  ON billing_rating_allocations (billing_account_id, settlement_state, rated_at)
  WHERE settlement_state <> 'settled';

CREATE INDEX IF NOT EXISTS idx_bra_unsettled_buser
  ON billing_rating_allocations (billing_user_id, settlement_state, rated_at)
  WHERE settlement_state <> 'settled';

CREATE INDEX IF NOT EXISTS idx_bra_unsettled_budget
  ON billing_rating_allocations (budget_id, settlement_state, rated_at)
  WHERE settlement_state <> 'settled';

CREATE INDEX IF NOT EXISTS idx_bra_engine_state
  ON billing_rating_allocations (engine, settlement_state, allocation_id)
  WHERE settlement_state <> 'settled';

CREATE INDEX IF NOT EXISTS idx_bra_app_status_decided
  ON billing_rating_allocations (application_status, decided_at);

CREATE INDEX IF NOT EXISTS idx_bra_late_rating
  ON billing_rating_allocations (late_rating, decided_at);

-- new for per-grant audit/selection
CREATE INDEX IF NOT EXISTS idx_bra_grant_state
  ON billing_rating_allocations (grant_id, settlement_state, decided_at);

CREATE INDEX IF NOT EXISTS idx_bra_entry_id
  ON billing_rating_allocations (entry_id);

CREATE INDEX IF NOT EXISTS idx_bra_rating
  ON billing_rating_allocations (rating_id);

CREATE INDEX IF NOT EXISTS idx_bra_reversal
  ON billing_rating_allocations (reversal_of_allocation_id);

-- realm/time-oriented reporting indexes
CREATE INDEX IF NOT EXISTS ix_bra_realm_time
  ON billing_rating_allocations (realm_id, rated_at);

CREATE INDEX IF NOT EXISTS ix_bra_realm_time_funding
  ON billing_rating_allocations (realm_id, rated_at, funding_kind);

CREATE INDEX IF NOT EXISTS ix_bra_realm_time_feature
  ON billing_rating_allocations (realm_id, rated_at, feature_code);

CREATE INDEX IF NOT EXISTS ix_bra_grant_rated_at
  ON billing_rating_allocations (grant_id, rated_at);

CREATE INDEX IF NOT EXISTS ix_bra_budget_rated_at
  ON billing_rating_allocations (budget_id, rated_at);

-- ========== Row Level Security ==========

-- Billing ratings: table-specific RLS policies (rating header + records + allocations)
DO $$
DECLARE
  expr text;
BEGIN
  -- Runtime rating tables are scoped by billing_user_id; billing_account_id is retained for payor reports.
  BEGIN EXECUTE 'ALTER TABLE billing_ratings ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  expr := $policy$
    billing_user_id = get_current_billing_user_id()
    AND billing_account_id = get_current_billing_account_id()
    AND EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = billing_ratings.billing_account_id
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  $policy$;

  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', 'billing_ratings_acct_read', 'billing_ratings', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', 'billing_ratings_acct_insert', 'billing_ratings', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', 'billing_ratings_acct_update', 'billing_ratings', expr, expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', 'billing_ratings_acct_delete', 'billing_ratings', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN EXECUTE 'ALTER TABLE billing_rating_allocations ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  expr := $policy$
    billing_user_id = get_current_billing_user_id()
    AND billing_account_id = get_current_billing_account_id()
    AND EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = billing_rating_allocations.billing_account_id
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  $policy$;

  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', 'billing_rating_allocations_acct_read', 'billing_rating_allocations', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', 'billing_rating_allocations_acct_insert', 'billing_rating_allocations', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', 'billing_rating_allocations_acct_update', 'billing_rating_allocations', expr, expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', 'billing_rating_allocations_acct_delete', 'billing_rating_allocations', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- billing_ratings (header)
  BEGIN EXECUTE 'ALTER TABLE billing_ratings ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  expr := 'billing_ratings.billing_user_id = get_current_billing_user_id()
           AND billing_ratings.billing_account_id = get_current_billing_account_id()
           AND billing_ratings.realm_id = current_setting(''app.realm_id'', true)';

  BEGIN EXECUTE format('CREATE POLICY br_read ON billing_ratings FOR SELECT USING (%s)', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY br_insert ON billing_ratings FOR INSERT WITH CHECK (%s)', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY br_update ON billing_ratings FOR UPDATE USING (%s) WITH CHECK (%s)', expr, expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY br_delete ON billing_ratings FOR DELETE USING (%s)', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE POLICY br_realm_admin_read
      ON billing_ratings
      FOR SELECT USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND realm_id = current_setting('app.realm_id', true)
      );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- billing_rated_records (details) -> billing_ratings scope
  BEGIN EXECUTE 'ALTER TABLE billing_rated_records ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  expr := $policy$
    EXISTS (
      SELECT 1
      FROM billing_ratings r
      WHERE r.rating_id = billing_rated_records.rating_id
        AND r.billing_user_id = get_current_billing_user_id()
        AND r.billing_account_id = get_current_billing_account_id()
        AND r.realm_id = current_setting('app.realm_id', true)
    )
  $policy$;

  BEGIN EXECUTE format('CREATE POLICY brr_read ON billing_rated_records FOR SELECT USING (%s)', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY brr_insert ON billing_rated_records FOR INSERT WITH CHECK (%s)', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY brr_update ON billing_rated_records FOR UPDATE USING (%s) WITH CHECK (%s)', expr, expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY brr_delete ON billing_rated_records FOR DELETE USING (%s)', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE POLICY brr_realm_admin_read
      ON billing_rated_records
      FOR SELECT USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND EXISTS (
          SELECT 1
          FROM billing_ratings r
          JOIN billing_accounts ba
            ON ba.billing_account_id = r.billing_account_id
          WHERE r.rating_id = billing_rated_records.rating_id
            AND ba.realm_id = current_setting('app.realm_id', true)
        )
      );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- billing_rating_labels -> billing_ratings scope
  BEGIN EXECUTE 'ALTER TABLE billing_rating_labels ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  expr := $policy$
    EXISTS (
      SELECT 1
      FROM billing_ratings r
      WHERE r.rating_id = billing_rating_labels.rating_id
        AND r.billing_user_id = get_current_billing_user_id()
        AND r.billing_account_id = get_current_billing_account_id()
        AND r.realm_id = current_setting('app.realm_id', true)
    )
  $policy$;

  BEGIN EXECUTE format('CREATE POLICY brl_read ON billing_rating_labels FOR SELECT USING (%s)', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY brl_insert ON billing_rating_labels FOR INSERT WITH CHECK (%s)', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY brl_update ON billing_rating_labels FOR UPDATE USING (%s) WITH CHECK (%s)', expr, expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY brl_delete ON billing_rating_labels FOR DELETE USING (%s)', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- billing_rating_allocations (per-grant allocations)
  BEGIN EXECUTE 'ALTER TABLE billing_rating_allocations ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  expr := 'billing_rating_allocations.billing_user_id = get_current_billing_user_id()
           AND billing_rating_allocations.billing_account_id = get_current_billing_account_id()
           AND billing_rating_allocations.realm_id = current_setting(''app.realm_id'', true)';

  BEGIN EXECUTE format('CREATE POLICY bra_read ON billing_rating_allocations FOR SELECT USING (%s)', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY bra_insert ON billing_rating_allocations FOR INSERT WITH CHECK (%s)', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY bra_update ON billing_rating_allocations FOR UPDATE USING (%s) WITH CHECK (%s)', expr, expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY bra_delete ON billing_rating_allocations FOR DELETE USING (%s)', expr);
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE POLICY bra_realm_admin_read
      ON billing_rating_allocations
      FOR SELECT USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND realm_id = current_setting('app.realm_id', true)
      );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

-- grant_programs — realm-scoped
ALTER TABLE grant_programs ENABLE ROW LEVEL SECURITY;

CREATE POLICY gp_read ON grant_programs
  FOR SELECT
  USING (realm_id = current_setting('app.realm_id', true));

CREATE POLICY gp_ins ON grant_programs
  FOR INSERT
  WITH CHECK (realm_id = current_setting('app.realm_id', true));

CREATE POLICY gp_upd ON grant_programs
  FOR UPDATE
  USING (realm_id = current_setting('app.realm_id', true))
  WITH CHECK (realm_id = current_setting('app.realm_id', true));

CREATE POLICY gp_del ON grant_programs
  FOR DELETE
  USING (realm_id = current_setting('app.realm_id', true));

-- grant_campaigns — realm-scoped
ALTER TABLE grant_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY gc_read ON grant_campaigns
  FOR SELECT
  USING (realm_id = current_setting('app.realm_id', true));

CREATE POLICY gc_ins ON grant_campaigns
  FOR INSERT
  WITH CHECK (realm_id = current_setting('app.realm_id', true));

CREATE POLICY gc_upd ON grant_campaigns
  FOR UPDATE
  USING (realm_id = current_setting('app.realm_id', true))
  WITH CHECK (realm_id = current_setting('app.realm_id', true));

CREATE POLICY gc_del ON grant_campaigns
  FOR DELETE
  USING (realm_id = current_setting('app.realm_id', true));

-- grant_assignments — runtime user scoped with realm guard
ALTER TABLE grant_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY ga_read ON grant_assignments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = grant_assignments.billing_account_id
        AND ba.billing_account_id = get_current_billing_account_id()
        AND grant_assignments.billing_user_id = get_current_billing_user_id()
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY ga_realm_admin_read ON grant_assignments
  FOR SELECT
  USING (
    current_setting('app.is_realm_admin', true) = 'true'
    AND EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = grant_assignments.billing_account_id
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY ga_ins ON grant_assignments
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = grant_assignments.billing_account_id
        AND ba.billing_account_id = get_current_billing_account_id()
        AND grant_assignments.billing_user_id = get_current_billing_user_id()
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY ga_realm_admin_ins ON grant_assignments
  FOR INSERT
  WITH CHECK (
    current_setting('app.is_realm_admin', true) = 'true'
    AND EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = grant_assignments.billing_account_id
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY ga_upd ON grant_assignments
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = grant_assignments.billing_account_id
        AND ba.billing_account_id = get_current_billing_account_id()
        AND grant_assignments.billing_user_id = get_current_billing_user_id()
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = grant_assignments.billing_account_id
        AND ba.billing_account_id = get_current_billing_account_id()
        AND grant_assignments.billing_user_id = get_current_billing_user_id()
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY ga_realm_admin_upd ON grant_assignments
  FOR UPDATE
  USING (
    current_setting('app.is_realm_admin', true) = 'true'
    AND EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = grant_assignments.billing_account_id
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.is_realm_admin', true) = 'true'
    AND EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = grant_assignments.billing_account_id
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY ga_del ON grant_assignments
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = grant_assignments.billing_account_id
        AND ba.billing_account_id = get_current_billing_account_id()
        AND grant_assignments.billing_user_id = get_current_billing_user_id()
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY ga_realm_admin_del ON grant_assignments
  FOR DELETE
  USING (
    current_setting('app.is_realm_admin', true) = 'true'
    AND EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = grant_assignments.billing_account_id
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

-- ledger_grants — runtime user scoped with realm guard
ALTER TABLE ledger_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY lg_read ON ledger_grants
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = ledger_grants.billing_account_id
        AND ba.billing_account_id = get_current_billing_account_id()
        AND ledger_grants.billing_user_id = get_current_billing_user_id()
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY lg_realm_admin_read ON ledger_grants
  FOR SELECT
  USING (
    current_setting('app.is_realm_admin', true) = 'true'
    AND EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = ledger_grants.billing_account_id
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY lg_ins ON ledger_grants
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = ledger_grants.billing_account_id
        AND ba.billing_account_id = get_current_billing_account_id()
        AND ledger_grants.billing_user_id = get_current_billing_user_id()
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY lg_upd ON ledger_grants
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = ledger_grants.billing_account_id
        AND ba.billing_account_id = get_current_billing_account_id()
        AND ledger_grants.billing_user_id = get_current_billing_user_id()
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = ledger_grants.billing_account_id
        AND ba.billing_account_id = get_current_billing_account_id()
        AND ledger_grants.billing_user_id = get_current_billing_user_id()
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY lg_realm_admin_upd ON ledger_grants
  FOR UPDATE
  USING (
    current_setting('app.is_realm_admin', true) = 'true'
    AND EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = ledger_grants.billing_account_id
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.is_realm_admin', true) = 'true'
    AND EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = ledger_grants.billing_account_id
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY lg_del ON ledger_grants
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = ledger_grants.billing_account_id
        AND ba.billing_account_id = get_current_billing_account_id()
        AND ledger_grants.billing_user_id = get_current_billing_user_id()
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );

CREATE POLICY lg_realm_admin_del ON ledger_grants
  FOR DELETE
  USING (
    current_setting('app.is_realm_admin', true) = 'true'
    AND EXISTS (
      SELECT 1
      FROM billing_accounts ba
      WHERE ba.billing_account_id = ledger_grants.billing_account_id
        AND ba.realm_id = current_setting('app.realm_id', true)
    )
  );


-- ============================================================
-- Billing periods (canonical instances)
-- ============================================================

CREATE TABLE IF NOT EXISTS billing_periods (
  billing_period_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id               text      NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_account_id     uuid      NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,

  period_start           timestamptz NOT NULL,
  period_end             timestamptz NOT NULL,
  grace_window_seconds   integer     NOT NULL DEFAULT 86400 CHECK (grace_window_seconds >= 0),

  source                 text        NOT NULL CHECK (source IN ('provider.subscription','binding','plan','realm_default','manual')),
  source_ref             text        NULL,

  -- Provider subscription provenance (optional, redundant for audit/debug)
  source_subscription_id uuid        NULL REFERENCES subscriptions(subscription_id) ON DELETE SET NULL,
  source_period_start    timestamptz NULL,
  source_period_end      timestamptz NULL,

  status                 text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','frozen','closed')),
  frozen_at              timestamptz NULL,
  closed_at              timestamptz NULL,

  metadata               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  UNIQUE (billing_account_id, period_start, period_end),
  CHECK (period_end > period_start),
  CHECK (status <> 'frozen' OR frozen_at IS NOT NULL),
  CHECK (status <> 'closed' OR closed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_billing_periods_ba_end
  ON billing_periods (billing_account_id, period_end DESC);
CREATE INDEX IF NOT EXISTS ix_billing_periods_realm_end
  ON billing_periods (realm_id, period_end DESC);
CREATE INDEX IF NOT EXISTS ix_billing_periods_status_end
  ON billing_periods (status, period_end DESC);

-- ============================================================
-- Overage closeout runs (per period)
-- ============================================================

CREATE TABLE IF NOT EXISTS billing_period_closeouts (
  billing_period_closeout_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id               text NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_account_id     uuid NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  billing_period_id      uuid NOT NULL REFERENCES billing_periods(billing_period_id) ON DELETE CASCADE,

  mode                   text NOT NULL CHECK (mode IN ('waive','invoice','manual')),
  status                 text NOT NULL DEFAULT 'completed' CHECK (status IN ('running','completed','failed')),

  overage_grant_id        uuid   NULL REFERENCES ledger_grants(grant_id) ON DELETE SET NULL,

  totals_xusd             bigint NOT NULL DEFAULT 0 CHECK (totals_xusd >= 0),
  allocation_count        integer NOT NULL DEFAULT 0 CHECK (allocation_count >= 0),

  started_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz NULL,

  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  UNIQUE (billing_period_id, mode)
);

CREATE INDEX IF NOT EXISTS ix_billing_period_closeouts_ba_period
  ON billing_period_closeouts (billing_account_id, billing_period_id);

-- ============================================================
-- Invoices & payments (canonical, PSP-agnostic)
-- ============================================================

CREATE TABLE IF NOT EXISTS billing_invoices (
  billing_invoice_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  realm_id                text      NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_account_id      uuid      NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  billing_period_id       uuid      NULL REFERENCES billing_periods(billing_period_id) ON DELETE SET NULL,
  subscription_id         uuid      NULL REFERENCES subscriptions(subscription_id) ON DELETE SET NULL,

  invoice_number          text      NOT NULL,

  provider                text      NULL,
  provider_invoice_id     text      NULL,
  provider_subscription_id text     NULL,
  provider_customer_id    text      NULL,

  currency                text      NOT NULL CHECK (char_length(currency) = 3 AND currency = upper(currency)),
  subtotal_minor          bigint    NOT NULL,
  tax_minor               bigint    NOT NULL DEFAULT 0,
  total_minor             bigint    NOT NULL,

  status                  text      NOT NULL CHECK (status IN ('draft','open','void','uncollectible','paid')),
  period_start            timestamptz NOT NULL,
  period_end              timestamptz NOT NULL,
  due_at                  timestamptz NULL,
  finalized_at            timestamptz NULL,
  paid_at                 timestamptz NULL,
  canceled_at             timestamptz NULL,

  hosted_invoice_url      text      NULL,

  metadata                jsonb     NOT NULL DEFAULT '{}'::jsonb,
  raw_provider_payload    jsonb     NOT NULL DEFAULT '{}'::jsonb,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CHECK (period_end > period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_invoices_number
  ON billing_invoices(realm_id, invoice_number);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_invoices_provider_invoice
  ON billing_invoices(provider, provider_invoice_id)
  WHERE provider IS NOT NULL AND provider_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_billing_invoices_ba_period
  ON billing_invoices(billing_account_id, billing_period_id);
CREATE INDEX IF NOT EXISTS ix_billing_invoices_subscription_period
  ON billing_invoices(subscription_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS ix_billing_invoices_account_period
  ON billing_invoices(billing_account_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS ix_billing_invoices_realm_period
  ON billing_invoices(realm_id, period_start, period_end);

CREATE TABLE IF NOT EXISTS billing_invoice_lines (
  billing_invoice_line_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  billing_invoice_id       uuid NOT NULL REFERENCES billing_invoices(billing_invoice_id) ON DELETE CASCADE,

  line_kind                text NOT NULL CHECK (line_kind IN ('recurring','usage','one_time','discount','tax','other')),

  description              text,
  quantity                 bigint NOT NULL DEFAULT 1,
  unit_amount_minor        bigint NOT NULL DEFAULT 0,
  total_amount_minor       bigint NOT NULL,

  catalog_price_id         uuid,
  meter_code               text,

  metadata                 jsonb  NOT NULL DEFAULT '{}'::jsonb,

  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_billing_invoice_lines_invoice
  ON billing_invoice_lines(billing_invoice_id);

CREATE TABLE IF NOT EXISTS billing_invoice_allocations (
  billing_invoice_id  uuid NOT NULL REFERENCES billing_invoices(billing_invoice_id) ON DELETE CASCADE,
  allocation_id       uuid NOT NULL REFERENCES billing_rating_allocations(allocation_id) ON DELETE RESTRICT,

  amount_xusd         bigint NOT NULL CHECK (amount_xusd >= 0),
  amount_minor        bigint NOT NULL CHECK (amount_minor >= 0),
  currency            text   NOT NULL CHECK (char_length(currency) = 3 AND currency = upper(currency)),

  created_at          timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (billing_invoice_id, allocation_id),
  UNIQUE (allocation_id)
);

CREATE INDEX IF NOT EXISTS ix_billing_invoice_allocations_invoice
  ON billing_invoice_allocations(billing_invoice_id);

CREATE TABLE IF NOT EXISTS billing_invoice_adjustments (
  billing_invoice_adjustment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id            text NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_account_id  uuid NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,

  billing_invoice_id  uuid   NULL REFERENCES billing_invoices(billing_invoice_id) ON DELETE SET NULL,
  billing_period_id   uuid   NULL REFERENCES billing_periods(billing_period_id) ON DELETE SET NULL,

  kind                text NOT NULL CHECK (kind IN ('late_data','manual','reconciliation')),
  direction           text NOT NULL CHECK (direction IN ('debit','credit')),

  amount_minor        bigint NOT NULL CHECK (amount_minor >= 0),
  currency            text   NOT NULL CHECK (char_length(currency) = 3 AND currency = upper(currency)),
  reason              text   NULL,

  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','canceled')),
  applied_at          timestamptz NULL,

  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CHECK (billing_invoice_id IS NOT NULL OR billing_period_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_billing_invoice_adjustments_ba_created
  ON billing_invoice_adjustments(billing_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_payments (
  billing_payment_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  realm_id                  text      NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_account_id        uuid      NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  billing_invoice_id        uuid      NULL REFERENCES billing_invoices(billing_invoice_id) ON DELETE SET NULL,

  provider                  text      NULL,
  provider_payment_id       text      NULL,
  provider_customer_id      text      NULL,
  provider_invoice_id       text      NULL,
  provider_subscription_id  text      NULL,

  method                    text      NOT NULL DEFAULT 'provider'
                               CHECK (method IN ('provider','ach','wire','check','manual','other')),
  reference                 text      NULL,

  status                    text      NOT NULL
                               CHECK (status IN (
                                 'requires_payment_method',
                                 'requires_confirmation',
                                 'requires_capture',
                                 'requires_action',
                                 'processing',
                                 'succeeded',
                                 'partially_refunded',
                                 'refunded',
                                 'canceled',
                                 'failed'
                               )),

  amount_minor              bigint    NOT NULL,
  currency                  text      NOT NULL CHECK (char_length(currency) = 3 AND currency = upper(currency)),

  occurred_at               timestamptz NOT NULL,

  entry_group_id            uuid      NULL,

  metadata                  jsonb     NOT NULL DEFAULT '{}'::jsonb,
  raw_provider_payload      jsonb     NOT NULL DEFAULT '{}'::jsonb,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_payments_provider_payment
  ON billing_payments(provider, provider_payment_id)
  WHERE provider IS NOT NULL AND provider_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_billing_payments_account_occurred
  ON billing_payments(billing_account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_billing_payments_realm_occurred
  ON billing_payments(realm_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_billing_payments_invoice_occurred
  ON billing_payments(billing_invoice_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS billing_payment_refunds (
  billing_payment_refund_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  realm_id                  text      NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_payment_id        uuid NOT NULL REFERENCES billing_payments(billing_payment_id) ON DELETE CASCADE,

  provider                  text   NOT NULL,
  provider_refund_id        text   NOT NULL,
  provider_charge_id        text   NULL,

  amount_minor              bigint NOT NULL,
  currency                  text   NOT NULL CHECK (char_length(currency) = 3 AND currency = upper(currency)),

  status                    text   NOT NULL CHECK (status IN ('pending','succeeded','failed','canceled')),

  occurred_at               timestamptz NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  raw_provider_payload      jsonb  NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (provider, provider_refund_id)
);

CREATE INDEX IF NOT EXISTS ix_billing_payment_refunds_payment
  ON billing_payment_refunds(billing_payment_id);
CREATE INDEX IF NOT EXISTS ix_billing_payment_refunds_realm
  ON billing_payment_refunds(realm_id);

-- --------------------------------------------------------------------------
-- RLS for billing periods / invoices / payments (account-scoped + realm-admin read)
-- --------------------------------------------------------------------------

DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE billing_periods ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'ALTER TABLE billing_period_closeouts ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'ALTER TABLE billing_invoice_lines ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'ALTER TABLE billing_invoice_allocations ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'ALTER TABLE billing_invoice_adjustments ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'ALTER TABLE billing_payment_refunds ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
END$$;

DO $$
BEGIN
  -- billing_periods
  BEGIN
    CREATE POLICY bp_account_rw ON billing_periods FOR ALL
      USING (billing_account_id = get_current_billing_account_id())
      WITH CHECK (billing_account_id = get_current_billing_account_id());
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY bp_realm_admin_read ON billing_periods FOR SELECT
      USING (current_setting('app.is_realm_admin', true) = 'true' AND realm_id = current_setting('app.realm_id', true));
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- billing_period_closeouts
  BEGIN
    CREATE POLICY bpc_account_rw ON billing_period_closeouts FOR ALL
      USING (billing_account_id = get_current_billing_account_id())
      WITH CHECK (billing_account_id = get_current_billing_account_id());
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY bpc_realm_admin_read ON billing_period_closeouts FOR SELECT
      USING (current_setting('app.is_realm_admin', true) = 'true' AND realm_id = current_setting('app.realm_id', true));
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- billing_invoices
  BEGIN
    CREATE POLICY bi_account_rw ON billing_invoices FOR ALL
      USING (billing_account_id = get_current_billing_account_id())
      WITH CHECK (billing_account_id = get_current_billing_account_id());
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY bi_realm_admin_read ON billing_invoices FOR SELECT
      USING (current_setting('app.is_realm_admin', true) = 'true' AND realm_id = current_setting('app.realm_id', true));
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- billing_invoice_lines (delegate to parent invoice)
  BEGIN
    CREATE POLICY bil_account_rw ON billing_invoice_lines FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM billing_invoices bi
          WHERE bi.billing_invoice_id = billing_invoice_lines.billing_invoice_id
            AND bi.billing_account_id = get_current_billing_account_id()
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM billing_invoices bi
          WHERE bi.billing_invoice_id = billing_invoice_lines.billing_invoice_id
            AND bi.billing_account_id = get_current_billing_account_id()
        )
      );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY bil_realm_admin_read ON billing_invoice_lines FOR SELECT
      USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND EXISTS (
          SELECT 1 FROM billing_invoices bi
          JOIN billing_accounts ba ON ba.billing_account_id = bi.billing_account_id
          WHERE bi.billing_invoice_id = billing_invoice_lines.billing_invoice_id
            AND ba.realm_id = current_setting('app.realm_id', true)
        )
      );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- billing_invoice_allocations (delegate to parent invoice)
  BEGIN
    CREATE POLICY bia_account_rw ON billing_invoice_allocations FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM billing_invoices bi
          WHERE bi.billing_invoice_id = billing_invoice_allocations.billing_invoice_id
            AND bi.billing_account_id = get_current_billing_account_id()
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM billing_invoices bi
          WHERE bi.billing_invoice_id = billing_invoice_allocations.billing_invoice_id
            AND bi.billing_account_id = get_current_billing_account_id()
        )
      );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY bia_realm_admin_read ON billing_invoice_allocations FOR SELECT
      USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND EXISTS (
          SELECT 1 FROM billing_invoices bi
          JOIN billing_accounts ba ON ba.billing_account_id = bi.billing_account_id
          WHERE bi.billing_invoice_id = billing_invoice_allocations.billing_invoice_id
            AND ba.realm_id = current_setting('app.realm_id', true)
        )
      );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- billing_invoice_adjustments
  BEGIN
    CREATE POLICY bia_adj_account_rw ON billing_invoice_adjustments FOR ALL
      USING (billing_account_id = get_current_billing_account_id())
      WITH CHECK (billing_account_id = get_current_billing_account_id());
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY bia_adj_realm_admin_read ON billing_invoice_adjustments FOR SELECT
      USING (current_setting('app.is_realm_admin', true) = 'true' AND realm_id = current_setting('app.realm_id', true));
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- billing_payments
  BEGIN
    CREATE POLICY bpay_account_rw ON billing_payments FOR ALL
      USING (billing_account_id = get_current_billing_account_id())
      WITH CHECK (billing_account_id = get_current_billing_account_id());
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY bpay_realm_admin_read ON billing_payments FOR SELECT
      USING (current_setting('app.is_realm_admin', true) = 'true' AND realm_id = current_setting('app.realm_id', true));
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  -- billing_payment_refunds (delegate to parent payment)
  BEGIN
    CREATE POLICY bpr_account_rw ON billing_payment_refunds FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM billing_payments bp
          WHERE bp.billing_payment_id = billing_payment_refunds.billing_payment_id
            AND bp.billing_account_id = get_current_billing_account_id()
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM billing_payments bp
          WHERE bp.billing_payment_id = billing_payment_refunds.billing_payment_id
            AND bp.billing_account_id = get_current_billing_account_id()
        )
      );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY bpr_realm_admin_read ON billing_payment_refunds FOR SELECT
      USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND EXISTS (
          SELECT 1 FROM billing_payments bp
          JOIN billing_accounts ba ON ba.billing_account_id = bp.billing_account_id
          WHERE bp.billing_payment_id = billing_payment_refunds.billing_payment_id
            AND ba.realm_id = current_setting('app.realm_id', true)
        )
      );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;




-- ---- Currencies (fiat + crypto) ------------------------------------
INSERT INTO currencies (code, kind, scale) VALUES
  ('XUSD','xusd',0), ('CREDIT','credit',6), ('USD','fiat',2),
  ('EUR','fiat',2), ('GBP','fiat',2), ('CNY','fiat',2), ('JPY','fiat',0),
  ('USDC','crypto',6), ('USDT','crypto',6), ('BTC','crypto',8), ('ETH','crypto',18)
ON CONFLICT DO NOTHING;
