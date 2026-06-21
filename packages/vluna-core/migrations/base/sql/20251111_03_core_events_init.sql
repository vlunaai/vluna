-- Contracts & contract terms (for Event->Ratings DSL params + contract pricing)
--
-- Notes:
-- - effective_at expresses "contract effective time" (business-effective)
-- - contract_terms are append-only versions per (contract_id, kind, term_key, effective_at)
-- - RLS: account-scoped read; realm-admin write

CREATE TABLE IF NOT EXISTS billing_contracts (
  contract_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id           text NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_account_id uuid NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  status             text NOT NULL CHECK (status IN ('active','disabled')),
  effective_at       timestamptz NOT NULL,
  name               text NULL,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm_id, billing_account_id, effective_at)
);

CREATE INDEX IF NOT EXISTS ix_billing_contracts_lookup
  ON billing_contracts (realm_id, billing_account_id, effective_at DESC);

CREATE TRIGGER trg_billing_contracts_updated_at
  BEFORE UPDATE ON billing_contracts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS contract_terms (
  contract_id   uuid        NOT NULL REFERENCES billing_contracts(contract_id) ON DELETE CASCADE,
  kind          text        NOT NULL DEFAULT 'e2r_param' CHECK (kind IN ('pricing','e2r_param')),
  term_key      text        NOT NULL,
  value_json    jsonb       NOT NULL,
  effective_at  timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, kind, term_key, effective_at)
);

CREATE INDEX IF NOT EXISTS ix_contract_terms_lookup
  ON contract_terms (contract_id, kind, term_key, effective_at DESC);

-- RLS for contracts: account-scoped read; realm-admin write.
DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE billing_contracts ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_contracts' AND policyname='bc_read') THEN
    CREATE POLICY bc_read ON billing_contracts FOR SELECT USING (
      billing_contracts.realm_id = current_setting('app.realm_id', true)
      AND (
        current_setting('app.is_realm_admin', true) = 'true'
        OR billing_contracts.billing_account_id = get_current_billing_account_id()
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_contracts' AND policyname='bc_realm_admin_rw') THEN
    CREATE POLICY bc_realm_admin_rw ON billing_contracts FOR ALL
      USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND billing_contracts.realm_id = current_setting('app.realm_id', true)
      )
      WITH CHECK (
        current_setting('app.is_realm_admin', true) = 'true'
        AND billing_contracts.realm_id = current_setting('app.realm_id', true)
      );
  END IF;
END$$;

DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE contract_terms ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='contract_terms' AND policyname='ct_read') THEN
    CREATE POLICY ct_read ON contract_terms FOR SELECT USING (
      EXISTS (
        SELECT 1
        FROM billing_contracts bc
        WHERE bc.contract_id = contract_terms.contract_id
          AND bc.realm_id = current_setting('app.realm_id', true)
          AND (
            current_setting('app.is_realm_admin', true) = 'true'
            OR bc.billing_account_id = get_current_billing_account_id()
          )
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='contract_terms' AND policyname='ct_realm_admin_rw') THEN
    CREATE POLICY ct_realm_admin_rw ON contract_terms FOR ALL
      USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND EXISTS (
          SELECT 1
          FROM billing_contracts bc
          WHERE bc.contract_id = contract_terms.contract_id
            AND bc.realm_id = current_setting('app.realm_id', true)
        )
      )
      WITH CHECK (
        current_setting('app.is_realm_admin', true) = 'true'
        AND EXISTS (
          SELECT 1
          FROM billing_contracts bc
          WHERE bc.contract_id = contract_terms.contract_id
            AND bc.realm_id = current_setting('app.realm_id', true)
        )
      );
  END IF;
END$$;

-- =====================================================================
-- Billing events (facts only; outcome/telemetry) + typed labels
-- Note: pricing/cost/settlement semantics live in billing_ratings/*.
-- =====================================================================
CREATE TABLE IF NOT EXISTS billing_events (
  event_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id            text        NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_user_id     uuid        NOT NULL REFERENCES billing_users(billing_user_id) ON DELETE CASCADE,
  billing_account_id  uuid        NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  semantic_kind       text        NOT NULL CHECK (semantic_kind IN ('activity','outcome')),
  occurred_at         timestamptz NOT NULL,
  event_type          text        NOT NULL,
  subject_ref         text        NULL,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  request_hash        text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_be_user_account
    FOREIGN KEY (billing_user_id, billing_account_id)
    REFERENCES billing_users(billing_user_id, billing_account_id)
    ON DELETE CASCADE
);

-- Idempotency: per-user uniqueness
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename='billing_events' AND indexname='ux_billing_events_bu_hash'
  ) THEN
    CREATE UNIQUE INDEX ux_billing_events_bu_hash ON billing_events(billing_user_id, request_hash);
  END IF;
END$$;

-- High-frequency query path
CREATE INDEX IF NOT EXISTS idx_billing_events_user_time
  ON billing_events (billing_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_billing_events_user_kind_time
  ON billing_events (billing_user_id, semantic_kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_billing_events_account_time
  ON billing_events (billing_account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_billing_events_account_kind_time
  ON billing_events (billing_account_id, semantic_kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_billing_events_realm_kind_time
  ON billing_events (realm_id, semantic_kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_billing_events_type_time
  ON billing_events (event_type, occurred_at);

DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;

  BEGIN
    CREATE POLICY billing_events_user_read ON billing_events FOR SELECT USING (
      billing_events.billing_user_id = get_current_billing_user_id()
      AND billing_events.billing_account_id = get_current_billing_account_id()
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE POLICY billing_events_user_write ON billing_events FOR INSERT WITH CHECK (
      billing_events.billing_user_id = get_current_billing_user_id()
      AND billing_events.billing_account_id = get_current_billing_account_id()
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE POLICY billing_events_realm_admin_read ON billing_events FOR SELECT USING (
      current_setting('app.is_realm_admin', true) = 'true' AND
      EXISTS (SELECT 1 FROM billing_accounts ba
               WHERE ba.billing_account_id = billing_events.billing_account_id
                 AND ba.realm_id = current_setting('app.realm_id', true))
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

-- ---------- Event-level Labels (typed; multi-dimensional attribution) ----------
CREATE TABLE IF NOT EXISTS billing_event_labels (
  event_id     uuid NOT NULL REFERENCES billing_events(event_id) ON DELETE CASCADE,
  label_key    text   NOT NULL,
  value_text   text,
  value_uuid   uuid,
  value_bool   boolean,
  value_number numeric,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_event_labels_pk PRIMARY KEY (event_id, label_key),
  CONSTRAINT billing_event_labels_one_value_chk
  CHECK (
    ((value_text   IS NOT NULL)::int +
     (value_uuid   IS NOT NULL)::int +
     (value_bool   IS NOT NULL)::int +
     (value_number IS NOT NULL)::int) = 1
  ),
  CONSTRAINT billing_event_labels_key_chk
  CHECK (
    label_key = lower(label_key)
    AND label_key ~ '^[a-z][a-z0-9_]{1,63}$'
  )
);

CREATE INDEX IF NOT EXISTS idx_bel_key   ON billing_event_labels (label_key);
CREATE INDEX IF NOT EXISTS idx_bel_text  ON billing_event_labels (label_key, value_text);
CREATE INDEX IF NOT EXISTS idx_bel_uuid  ON billing_event_labels (label_key, value_uuid);

-- RLS for labels based on parent event's runtime user scope
DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE billing_event_labels ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_event_labels' AND policyname='bel_user_read') THEN
    CREATE POLICY bel_user_read ON billing_event_labels
      USING (
        EXISTS (
          SELECT 1 FROM billing_events e
          WHERE e.event_id = billing_event_labels.event_id
            AND e.billing_user_id = get_current_billing_user_id()
            AND e.billing_account_id = get_current_billing_account_id()
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_event_labels' AND policyname='bel_user_insert') THEN
    CREATE POLICY bel_user_insert ON billing_event_labels FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM billing_events e
            WHERE e.event_id = billing_event_labels.event_id
            AND e.billing_user_id = get_current_billing_user_id()
            AND e.billing_account_id = get_current_billing_account_id()
        )
      );
  END IF;
END$$;

-- =====================================================================
-- Events -> Ratings bridge tables (Outcome-based billing)
-- =====================================================================

CREATE TABLE IF NOT EXISTS billing_event_processing (
  billing_event_id     uuid NOT NULL REFERENCES billing_events(event_id) ON DELETE CASCADE,
  realm_id             text   NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_user_id      uuid   NOT NULL REFERENCES billing_users(billing_user_id) ON DELETE CASCADE,
  billing_account_id   uuid   NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  policy_id            text   NOT NULL,
  policy_version       text   NOT NULL,
  status               text   NOT NULL CHECK (status IN ('pending','processing','processed','skipped','skipped_no_policy','failed','quarantined')),
  attempts             integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code      text   NULL,
  last_error_message   text   NULL,
  next_retry_at        timestamptz NULL,
  locked_by            text   NULL,
  locked_at            timestamptz NULL,
  processed_at         timestamptz NULL,
  result_json          jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_event_id, policy_id, policy_version),
  CONSTRAINT fk_bep_user_account
    FOREIGN KEY (billing_user_id, billing_account_id)
    REFERENCES billing_users(billing_user_id, billing_account_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_bep_pending
  ON billing_event_processing (status, next_retry_at, billing_event_id)
  WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS ix_bep_realm_pending
  ON billing_event_processing (realm_id, status, next_retry_at, billing_event_id)
  WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS ix_bep_ba ON billing_event_processing (billing_account_id);
CREATE INDEX IF NOT EXISTS ix_bep_bu ON billing_event_processing (billing_user_id);

-- RLS for billing_event_processing (runtime user-scoped + realm-admin).
DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE billing_event_processing ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_event_processing' AND policyname='bep_user_read') THEN
    CREATE POLICY bep_user_read ON billing_event_processing
      USING (
        billing_event_processing.billing_user_id = get_current_billing_user_id()
        AND billing_event_processing.billing_account_id = get_current_billing_account_id()
        AND billing_event_processing.realm_id = current_setting('app.realm_id', true)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_event_processing' AND policyname='bep_user_insert') THEN
    CREATE POLICY bep_user_insert ON billing_event_processing FOR INSERT
      WITH CHECK (
        billing_event_processing.billing_user_id = get_current_billing_user_id()
        AND billing_event_processing.billing_account_id = get_current_billing_account_id()
        AND billing_event_processing.realm_id = current_setting('app.realm_id', true)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_event_processing' AND policyname='bep_user_update') THEN
    CREATE POLICY bep_user_update ON billing_event_processing FOR UPDATE
      USING (
        billing_event_processing.billing_user_id = get_current_billing_user_id()
        AND billing_event_processing.billing_account_id = get_current_billing_account_id()
        AND billing_event_processing.realm_id = current_setting('app.realm_id', true)
      )
      WITH CHECK (
        billing_event_processing.billing_user_id = get_current_billing_user_id()
        AND billing_event_processing.billing_account_id = get_current_billing_account_id()
        AND billing_event_processing.realm_id = current_setting('app.realm_id', true)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='billing_event_processing' AND policyname='bep_realm_admin_rw') THEN
    CREATE POLICY bep_realm_admin_rw ON billing_event_processing FOR ALL
      USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND billing_event_processing.realm_id = current_setting('app.realm_id', true)
      )
      WITH CHECK (
        current_setting('app.is_realm_admin', true) = 'true'
        AND billing_event_processing.realm_id = current_setting('app.realm_id', true)
      );
  END IF;
END$$;

-- =====================================================================
-- Phase 3: Event -> Rating policies (DSL; no management API required)
-- Realm-scoped. Writes require realm-admin.
-- =====================================================================

CREATE TABLE IF NOT EXISTS event_rating_policies (
  realm_id            text NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  policy_id           text NOT NULL,
  name                text NOT NULL,
  status              text NOT NULL CHECK (status IN ('active','disabled')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (realm_id, policy_id)
);

CREATE TABLE IF NOT EXISTS event_rating_policy_versions (
  realm_id            text NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  policy_id           text NOT NULL,
  policy_version      text NOT NULL,
  status              text NOT NULL CHECK (status IN ('draft','active','deprecated')),
  effective_at        timestamptz NOT NULL,
  dsl_json            jsonb NOT NULL,
  dsl_hash            text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (realm_id, policy_id, policy_version),
  CONSTRAINT fk_event_rating_policy_versions_policy
    FOREIGN KEY (realm_id, policy_id)
    REFERENCES event_rating_policies(realm_id, policy_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_erpv_realm_policy_effective
  ON event_rating_policy_versions (realm_id, policy_id, effective_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_erpv_realm_policy_effective
  ON event_rating_policy_versions (realm_id, policy_id, effective_at);

-- RLS for policies: realm-scoped read; realm-admin write.
DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE event_rating_policies ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='event_rating_policies' AND policyname='erp_read') THEN
    CREATE POLICY erp_read ON event_rating_policies FOR SELECT USING (
      event_rating_policies.realm_id = current_setting('app.realm_id', true)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='event_rating_policies' AND policyname='erp_realm_admin_rw') THEN
    CREATE POLICY erp_realm_admin_rw ON event_rating_policies FOR ALL
      USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND event_rating_policies.realm_id = current_setting('app.realm_id', true)
      )
      WITH CHECK (
        current_setting('app.is_realm_admin', true) = 'true'
        AND event_rating_policies.realm_id = current_setting('app.realm_id', true)
      );
  END IF;
END$$;

DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE event_rating_policy_versions ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='event_rating_policy_versions' AND policyname='erpv_read') THEN
    CREATE POLICY erpv_read ON event_rating_policy_versions FOR SELECT USING (
      event_rating_policy_versions.realm_id = current_setting('app.realm_id', true)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename='event_rating_policy_versions' AND policyname='erpv_realm_admin_rw') THEN
    CREATE POLICY erpv_realm_admin_rw ON event_rating_policy_versions FOR ALL
      USING (
        current_setting('app.is_realm_admin', true) = 'true'
        AND event_rating_policy_versions.realm_id = current_setting('app.realm_id', true)
      )
      WITH CHECK (
        current_setting('app.is_realm_admin', true) = 'true'
        AND event_rating_policy_versions.realm_id = current_setting('app.realm_id', true)
      );
  END IF;
END$$;

-- =====================================================================
-- Events -> Ratings link table (requires billing_ratings to exist)
-- =====================================================================

CREATE TABLE IF NOT EXISTS billing_event_ratings (
  realm_id             text   NOT NULL REFERENCES realms(realm_id) ON DELETE RESTRICT,
  billing_user_id      uuid   NOT NULL REFERENCES billing_users(billing_user_id) ON DELETE CASCADE,
  billing_account_id   uuid   NOT NULL REFERENCES billing_accounts(billing_account_id) ON DELETE CASCADE,
  billing_event_id     uuid NOT NULL REFERENCES billing_events(event_id) ON DELETE CASCADE,
  rating_id            uuid NOT NULL REFERENCES billing_ratings(rating_id) ON DELETE RESTRICT,
  link_kind            text   NOT NULL CHECK (link_kind IN ('billed','adjustment','reversal','shadow')),
  policy_id            text   NOT NULL,
  policy_version       text   NOT NULL,
  output_index         integer NOT NULL DEFAULT 0 CHECK (output_index >= 0),
  engine_run_id        text   NULL,
  idempotency_key      text   NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (billing_event_id, rating_id, link_kind),
  CONSTRAINT fk_ber_user_account
    FOREIGN KEY (billing_user_id, billing_account_id)
    REFERENCES billing_users(billing_user_id, billing_account_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_ber_event ON billing_event_ratings (billing_event_id);
CREATE INDEX IF NOT EXISTS ix_ber_rating ON billing_event_ratings (rating_id);
CREATE INDEX IF NOT EXISTS ix_ber_policy ON billing_event_ratings (policy_id, policy_version);
CREATE INDEX IF NOT EXISTS ix_ber_ba ON billing_event_ratings (billing_account_id);
CREATE INDEX IF NOT EXISTS ix_ber_bu ON billing_event_ratings (billing_user_id);
CREATE INDEX IF NOT EXISTS ix_ber_realm ON billing_event_ratings (realm_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ber_intent
  ON billing_event_ratings (billing_event_id, policy_id, policy_version, output_index, link_kind);
CREATE INDEX IF NOT EXISTS ix_ber_idem
  ON billing_event_ratings (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- RLS for billing_event_ratings (runtime user-scoped).
DO $$
DECLARE
  expr text;
BEGIN
  BEGIN EXECUTE 'ALTER TABLE billing_event_ratings ENABLE ROW LEVEL SECURITY'; EXCEPTION WHEN others THEN NULL; END;
  expr := 'billing_event_ratings.billing_user_id = get_current_billing_user_id()
           AND billing_event_ratings.billing_account_id = get_current_billing_account_id()
           AND billing_event_ratings.realm_id = current_setting(''app.realm_id'', true)';
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', 'ber_read', 'billing_event_ratings', expr); EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', 'ber_insert', 'billing_event_ratings', expr); EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', 'ber_update', 'billing_event_ratings', expr, expr); EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', 'ber_delete', 'billing_event_ratings', expr); EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;

DO $$
BEGIN
  BEGIN
    CREATE TRIGGER trg_billing_event_processing_updated_at
    BEFORE UPDATE ON billing_event_processing
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE TRIGGER trg_event_rating_policies_updated_at
    BEFORE UPDATE ON event_rating_policies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    CREATE TRIGGER trg_event_rating_policy_versions_updated_at
    BEFORE UPDATE ON event_rating_policy_versions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;
