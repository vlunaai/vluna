# Quickstart: SDK Integration (Progressive Onboarding)

This quickstart is for **developers integrating Vluna into their product backend**: use the SDK to get the
`authorize → commit` flow working end-to-end, then progressively introduce pricing, balances, selling, and stricter
gating via "progressive disclosure".

For self-hosted installation and Service Key provisioning, see: `INSTALL.md`.

---

## 0) Prepare These Values (Cloud vs self-hosted)

Your backend service needs two kinds of inputs: **deployment-level configuration** (usually constants) and
**request-level context** (varies by customer).

### Deployment-level configuration (usually constants)

- `realm_id`: your business project / tenant domain.
- `service_key_id` / `service_key_secret`: credentials your backend uses to call S2S feature_families via Service Key auth
  (treat these like passwords).

### Request-level context (varies by your customers)

- `principal_id`: your system’s "customer principal identifier" (a stable org/team/tenant/user id).
- `billing_account_id`: Vluna’s billing account id (the account-level RLS anchor), in a 1:1 mapping with
  `principal_id`. After you obtain `billing_account_id` the first time via `principal_id`, it’s recommended to store and
  maintain the mapping in your own database.
- `user_id`: your system’s end-user id (commonly used for issuing Bearer tokens, auditing, and UX); not the same as
  `principal_id`.

### Vluna Cloud (hosted)

Get these values from the hosted Web Dashboard:

- `realm_id`
- `service_key_id`
- `service_key_secret`

Then point the SDK `base_url` to your cloud endpoint (provided by the dashboard), not local `http://localhost:3002`.

### Self-hosted (OSS in this repo)

Bring up the API + database and provision a Service Key via `INSTALL.md`:

- `INSTALL.md#1-docker-compose-recommended` (startup)
- `INSTALL.md#36-provision-a-service-key-for-sdk-integrations` (generate `realm_id` + `service_key_id/secret`)

---

## 2) Use Only Two SDK Clients: `ServiceClient` and `BearerClient`

Keep your integration split into two parts:

- `ServiceClient` (S2S, Service Key): your backend uses it for `gate_authorize`, `gate_commit`, wallet operations, and
  issuing Bearer tokens.
- `BearerClient` (end-user, Bearer token): after your frontend/mobile app receives a token issued by your backend (via
  token issuance), it uses this client to call end-user features such as checkout/portal/catalog.

Rule of thumb: **anything that results in charging/credits/authorization must be done on your backend using
`ServiceClient`.**

---

## 3) Stage 1 (Day 0): First get `authorize → commit` working

### 3.1 The two steps you add to your business code

In your business logic:

1) Before doing work: call `gate_authorize(...)` to obtain a `lease_token`
2) After doing work: call `gate_commit(...)` to report usage and receive the authoritative pricing snapshot (even if you
   haven’t configured pricing yet, you can still get observable `hints`)

### 3.2 Minimal SDK call example (Python)

This snippet focuses only on the SDK integration flow:

- `realm_id` and `service_key_id/secret` are deployment-level configuration (read from env here; in production, use a
  config service / secret manager)
- `principal_id` / `billing_account_id` / `user_id` are request-level variables (from your app requests / database)

```python
import asyncio
import os

from vlunaai import (
  VlunaAIConfig,
  RequestContext,
  ServiceClientOptions,
  ServiceKeyCredentials,
  create_service_client,
)


def env(name: str) -> str:
  v = os.environ.get(name)
  if not v:
    raise RuntimeError(f"Missing env: {name}")
  return v


async def main() -> None:
  client = create_service_client(
    ServiceClientOptions(
      config=VlunaAIConfig(
        base_url=os.environ.get("VLUNA_SERVICE_BASE_URL", "http://localhost:3002/mgt/v1"),
        realm_id=env("VLUNA_REALM_ID"),
      ),
      service_key=ServiceKeyCredentials(
        key_id=env("VLUNA_SERVICE_KEY_ID"),
        secret=env("VLUNA_SERVICE_KEY_SECRET"),  # base64-encoded secret
      ),
    )
  )
  try:
    principal_id = "customer_123"  # from your app (org/team/tenant id)
    ctx = RequestContext(principal_id=principal_id)
    feature_code = "openai.gpt5.2"

    authz = await client.gate_authorize(
      body={"feature_code": feature_code, "feature_family_code": "llm.premium"},
      context=ctx,
    )
    if not authz.ok or not authz.data:
      raise RuntimeError(f"authorize denied: {authz.model_dump()}")
    lease_token = authz.data.lease_token

    # ...perform the protected work...

    commit = await client.gate_commit(
      body={"lease_token": lease_token, "feature_code": feature_code, "quantity_minor": "1234"},
      context=ctx,
    )
    print(commit.model_dump())
  finally:
    await client.close()


asyncio.run(main())
```

Note:

- The SDK auto-generates idempotency keys for write requests. If you want to "safely retry the same request" after a
  timeout, explicitly set and reuse `RequestContext(idempotency_key=...)`.

### 3.3 How to choose `feature_code` vs `feature_family_code`

- `feature_code`: the business-side entry key you want to gate and meter (new ones will be added and it will evolve).
- `feature_family_code`: a more stable abstraction suitable for selling/entitlements (optional).

Recommended path:

- Day 0: stabilize your `feature_code` naming scheme first
- When you start selling tiers: gradually map many `feature_code`s into a smaller set of stable `feature_family_code`s

---

## 4) The key contract in Stage 1: use `hints` for "allow, but observable"

`hints` are machine-readable signals that may appear on both success and failure responses:

- `ok=false`: usually means you should deny execution (hard gating).
- `ok=true` with non-empty `hints`: means the call is allowed, but you should log/emit metrics and decide whether to
  degrade behavior.

At minimum, you should recognize and report these common hints (names per SDK response):

- `pricing.not_configured`: pricing not configured yet (common on Day 0)
- `quota.remaining` / `rate.limit`: quota/rate nearing limits (backoff/queue/degrade recommended)
- `funding.xusd_shortfall` / `budget.shortfall`: balance/budget is insufficient or near the edge (decide soft vs hard deny)
- `pricing.changed`: client-expected price differs from commit-time authoritative price (decide retry/notify)
- `lease.*`: lease expiration related (typically requires re-authorize)

---

## 5) Stage 2: "real money" loop (pricing + balances)

When you want to move from "observable" to "chargeable/enforceable", you only need two additional feature_families:

1) **Pricing**: the `pricing_snapshot` returned by commit is authoritative (fingerprint changes mean pricing inputs
   changed).
2) **Balance/coverage sources**: wallet/grants/budgets determine whether a commit can be covered.

If you want to cache `billing_account_id` (e.g. Bearer APIs need account context, or you want to reduce resolution work),
you can first read the wallet balance while you already have `principal_id`:

```python
balance = await client.get_credit_balance(context=RequestContext(principal_id=principal_id))
billing_account_id = (balance.data.billing_account_id if balance.data else None)
```

Then persist `principal_id → billing_account_id` in your own database.

---

## 6) Stage 3: Selling (issue a Bearer token for the frontend)

When your frontend/mobile app needs checkout/portal/catalog:

1) Your backend uses `ServiceClient.issue_platform_token(...)` to issue a short-lived token for a given
   `principal_id` / `user_id`
2) The frontend uses `BearerClient` with that token to call the desired end-user APIs

Example (token issuance):

```python
token_envelope = await client.issue_platform_token(
  body={
    "principal_id": principal_id,
    "user_id": user_id,
    "scopes": ["checkout", "portal"],
    "session_ttl_sec": 900,
  },
  context=RequestContext(principal_id=principal_id),
)
access_token = token_envelope.data.access_token  # type: ignore[union-attr]
```

For frontend calls you typically also need an account context (`billing_account_id`). Fetch it from your own mapping table
and pass it via context:

```python
from vlunaai import (
  VlunaAIConfig,
  BearerClientOptions,
  RequestContext,
  create_bearer_client,
)

bearer_client = create_bearer_client(
  BearerClientOptions(
    config=VlunaAIConfig(
      base_url=os.environ.get("VLUNA_BEARER_BASE_URL", "http://localhost:3002/api/v1"),
      realm_id=env("VLUNA_REALM_ID"),
    )
  )
)
ctx = RequestContext(access_token=access_token, billing_account_id=billing_account_id)
products = await bearer_client.list_catalog_products(context=ctx)
```

---

## 7) Stage 4: finer-grained entitlements and limits (Billing Plan as the unified carrier)

When you want to package "permissions + quotas/rates + included credits" as a sellable plan, introduce Billing Plans:

- A Billing Plan acts as a unified carrier that bundles feature_family entitlements (permissions), gate policies (quotas/rates),
  and grants (funds).

Your integration does not need to change the `authorize → commit` calling pattern; you’ll simply receive richer
allow/deny decisions, `hints`, and settlement outputs.

---

## 8) Common integration issues

- Wrong `realm_id`: requests land in the wrong realm and show up as "not found / unauthorized / inconsistent data".
- Unstable `principal_id`: the same customer using multiple ids in your system will create multiple billing accounts in
  Vluna.
- Unsafe retries: on timeouts/network jitter, explicitly set and reuse `RequestContext(idempotency_key=...)` to avoid
  double settlement.
