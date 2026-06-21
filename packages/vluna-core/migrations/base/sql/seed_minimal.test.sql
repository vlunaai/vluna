-- ============================================================================
-- DEMO DATASET (aligned with sql_migrations_v1.sql · ARCH/TECH v9.1)
-- 
-- Revised requirements (clarified for this seed file):
-- 1) Tenancy: Use a single demo realm 'realm-demo'. Realm:Account = 1:N.
-- 2) Accounts: Must include one account mapped from a remote billing principal:
--      billing_principal_id = 'r20ow9li7r5b'
--    Additional accounts are allowed for realism.
-- 3) Catalog (provider='stripe'):
--      - subscription (active) 2 products
--      - subscription (archived)    1 product
--      - credit (active)       1 product
--      - credit (draft)           1 product
--    Each product has plausible prices. Credit prices carry metadata for credit_amount/unit.
--    NOTE: Catalog IDs are reused from prior seed (product/price IDs >= 10000).
-- 4) Wallet: Create ledgers and transactions that reconcile to ledger.balance.
--      Reasons in {'purchase','consumption','adjustment',...}; include idempotency_key samples.
-- 5) Usage: Create meters, bindings (unique active per subscription_item_id),
--      events (with canonical-looking request_hash), and hourly reports (provider_status='success').
-- 6) Provider snapshots & reconciliation: Add small, realistic samples tied to the account.
-- 7) Timestamps: Use recent, UTC ISO-8601 with hour-bucket alignment where relevant.
-- 8) Idempotence & constraints: Respect unique keys and checks from the DDL.
-- 9) Style: Two-space indentation; single quotes; English comments only.
-- ============================================================================

SET TIME ZONE 'UTC';
SELECT set_config('app.realm_id', 'realm-demo', true);

-- ---- Accounts -------------------------------------------------------
-- INSERT INTO billing_accounts (realm_id, billing_principal_id, billing_account_id) VALUES
--   ('realm-demo','r20ow9li7r5b','00000000-0000-0000-0000-000000000001')
-- ON CONFLICT DO NOTHING;
INSERT INTO billing_accounts (realm_id, billing_principal_id) VALUES
  ('realm-demo','demo-internal')
ON CONFLICT DO NOTHING;
