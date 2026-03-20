vluna — NestJS + Fastify service

Overview
- Follows docs/billing/SYSTEM_DECISIONS.md: NestJS + Fastify as the primary runtime and API framework.
- Provides a thin HTTP layer (controllers/guards/interceptors) to align with envelope, idempotency and RLS session context requirements.

Quick start
```bash
pnpm i
pnpm --filter @app/vluna dev
# open http://localhost:3001/health
```

OpenAPI consistency
Use the lint/validate commands at the workspace root to keep the spec healthy:
```bash
pnpm openapi:lint:billing
pnpm openapi:validate:billing
```

Types-only from OpenAPI (for implementation)
```bash
# Generate types for vluna (billing + business project/IAM)
pnpm openapi:gen:vluna

# Outputs
# - apps/vluna/src/contracts/billing.ts
# - apps/vluna/src/contracts/iam.ts
```

Use helpers to extract inputs/outputs by operationId:
```ts
import type { operations as BillingOps } from './src/contracts/billing'
import { JsonRequestBody, JsonResponse, QueryParams, HeaderParams } from './src/contracts/openapi-helpers'

type ListProductsQuery = QueryParams<BillingOps, 'listCatalogProducts'>
type ListProductsResp  = JsonResponse<BillingOps, 'listCatalogProducts', 200>

// In a controller method, you can assert your return type
// function listProducts(...): Envelope & ListProductsResp { ... }
```

Background sweepers
- Periodic tasks are registered in `SchedulerModule`, but **disabled by default** unless selected via process args.
- Use process args:
  - `--tasks-include a,b,c` (run only these tasks)
  - `--tasks-exclude x,y` (run all tasks except these)
  - If neither flag is provided, the process runs **no** periodic tasks.
- Example (run only settlement sweeps):
  - `pnpm --filter @vluna/vluna-core dev -- --tasks-include settlement-sweep`

Project layout
- src/main.ts: bootstrap with Fastify adapter and global prefix /api
- src/modules/app.module.ts: root module
- src/presentation/health.controller.ts: basic readiness endpoint

Testing
- Community (default): `pnpm --filter @vluna/vluna-core run test:community`
- Enterprise: `pnpm --filter @vluna/vluna-core run test:enterprise`
- Postgres 17 integration: `pnpm --filter @vluna/vluna-core run test:db` (uses `TEST_DB_URL` or spins `postgres:17-alpine`)
- All suites: `pnpm --filter @vluna/vluna-core run test:all`

vlunactl (admin script)

`vlunactl` is a small CLI helper for administrative workflows (provisioning realms and service API keys).

Important: provisioning commands run **with a superuser/owner DB connection** to bypass RLS.

Environment:
- `DATABASE_MIGRATOR_URI` (required): superuser/owner connection string used by the script
- `BILLING_MASTER_KEY` (required for service-key commands): used to derive service API key secrets
- `DATABASE_URI` (required for tasks commands): runtime connection string used by `vlunactl tasks ...`
- `VLUNA_PLANE` (required): plane id (`admin` reserved; OSS/Enterprise default `vluna`)
- `VLUNA_DB_SCHEMA` (optional): DB schema for app tables/migrations; defaults to `control_plane`

Run:
```bash
pnpm --filter @vluna/vluna-core vlunactl --help
```

Commands:
- Create a realm (baseline provisioning):
  ```bash
  pnpm --filter @vluna/vluna-core vlunactl realm create --realm-id realm-default --name "Default Realm"
  ```
  If `--realm-id` is omitted, `vlunactl` generates `realm-<10-char random>`.
  Optional: attach realm metadata:
  ```bash
  pnpm --filter @vluna/vluna-core vlunactl realm create \
    --realm-id realm-default \
    --name "Default Realm" \
    --metadata-json '{
      "auth": {
        "issuers": [
          {
            "issuer": "https://issuer.example",
            "audiences": ["your-audience"],
            "jwks_uri": "https://issuer.example/.well-known/jwks.json"
          }
        ]
      },
      "payments": {
        "stripe": {
          "mode": "test",
          "api_keys": { "test": "sk_test_xxx" },
          "webhooks": [{ "name": "payment", "test": "whsec_xxx" }],
          "public_webhook_base_url": "https://example.com"
        }
      }
    }'
  ```
- List realms:
  ```bash
  pnpm --filter @vluna/vluna-core vlunactl realm list
  ```
- Create a service API key for a realm (prints `keyId` + base64 secret):
  ```bash
  pnpm --filter @vluna/vluna-core vlunactl service-key create --realm-id realm-default
  ```
  Optional expiration (ISO 8601):
  ```bash
  pnpm --filter @vluna/vluna-core vlunactl service-key create --realm-id realm-default --expires-at 2026-06-30T00:00:00Z
  ```
- Get the derived secret for an existing key (validates realm authorization):
  ```bash
  pnpm --filter @vluna/vluna-core vlunactl service-key secret --realm-id realm-default --key-id pk-aB3dE4fG5hJ6kLmN
  ```
- Run periodic tasks without the web server:
  - List tasks:
    ```bash
    pnpm --filter @vluna/vluna-core vlunactl tasks list
    ```
  - Run one task once:
    ```bash
    pnpm --filter @vluna/vluna-core vlunactl tasks run --task settlement-sweep
    ```
  - Start a worker process that runs a selected set:
    ```bash
    pnpm --filter @vluna/vluna-core vlunactl tasks worker --tasks-include settlement-sweep,outcome-billing-sweep
    ```
- Run a reconciliation scan (writes findings into `reconciliations` table):
  ```bash
  pnpm --filter @vluna/vluna-core vlunactl reconciliation run \
    --realm-id realm-default \
    --billing-account-id 00000000-0000-0000-0000-000000000000 \
    --limit 500
  ```
  Notes:
  - Uses `DATABASE_MIGRATOR_URI` (superuser/owner) since this scan reads/writes account-scoped tables under RLS.
  - Prefer scoping by `--billing-account-id` to avoid scanning the whole realm.
  - Use `--dry-run` to compute findings without writing.

Next steps (from SYSTEM_DECISIONS)
- Add global interceptors/guards for envelope, X-Realm-Id, Idempotency-Key
- Add persistence layer (Kysely + node-postgres) and RLS session context
- Add webhook endpoints and background workers (BullMQ)
