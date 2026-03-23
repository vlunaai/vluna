# Local Install & Run (Community Edition)

This guide helps you run the **Vluna Community Edition API** locally and then verify your setup using the
**`vlunaai` (Python SDK)** examples.

Assumptions:
- API base URL: `http://localhost:3002`
- Postgres (host): `localhost:5433` (container: `5432`)

Required configuration:
- `BILLING_MASTER_KEY` (required): root key used to derive Service Key secrets for S2S auth flows. Keep it private.
- Treat it as persistent state: if you change `BILLING_MASTER_KEY`, any derived Service Key secrets/signatures will change
  and previously issued credentials may stop working.
- The API also requires `BILLING_MASTER_KEY` at runtime (not just for admin tooling).

Set it before you run any Docker Compose / Docker / dev commands:

First, generate a random value:

```bash
openssl rand -hex 32
```

Option A: export in your shell (quickest)

```bash
export BILLING_MASTER_KEY='replace-me-with-generated'
```

Option B: create a `.env` file at the repo root (recommended for local dev)

```bash
cat > .env <<'EOF'
BILLING_MASTER_KEY=replace-me-with-generated
EOF
```

Option C: provide it via a secret manager (teams/CI)

You can also provide `BILLING_MASTER_KEY` via your team’s secret manager.

You can bring up the backend in three ways (recommended order):
1) Docker Compose (recommended: DB + API with one command)
2) Docker Build (run the production-like image locally)
3) Local Dev (source-based dev with hot reload)

---

## 1) Docker Compose (recommended)

Goal: start Postgres + the API (`vluna`) with `infra/docker/docker-compose.yml`.

Prerequisites:
- Docker Desktop (or equivalent Docker Engine) + Docker Compose v2

Start:

```bash
# Start DB + API (builds the image if needed)
docker compose -f infra/docker/docker-compose.yml --profile db --profile api up -d --build

# Health check
curl -fsS http://localhost:3002/health
```

Stop:

```bash
docker compose -f infra/docker/docker-compose.yml down
```

Reset the database (destructive: clears local data):

```bash
docker compose -f infra/docker/docker-compose.yml down -v
```

Notes:
- Port conflicts: ensure `3002` (API) and `5433` (Postgres) are free.
- Data directory: Postgres data is persisted under `infra/docker/dist/postgres/` by default.

---

## 2) Docker Build (image-based run)

Goal: build the Community Edition image and run it via `docker run`. This is useful to validate the container image
outside the dev workflow.

Prerequisites:
- Docker Desktop (or equivalent Docker Engine)
- A running Postgres instance you can connect to ("bring your own Postgres")

### 2.1 Bring your own Postgres (recommended)

You only need to provide:
- `DATABASE_MIGRATOR_URI`: superuser/owner connection string (used for migrations/setup/provisioning)
- `DATABASE_URI`: runtime application connection string (must be least-privilege: not owner, not superuser, no bypass RLS). If you use an owner/superuser/rls-bypass role here, RLS will be skipped and you risk severe data leaks and bugs.
- `VLUNA_PLANE`: plane id (`admin` reserved; for OSS/Enterprise use `vluna`)
- `VLUNA_DB_SCHEMA`: target DB schema (default `control_plane`)

Typical examples:
- Local Postgres:
  - `DATABASE_MIGRATOR_URI=postgresql://SUPERUSER:PASS@localhost:5432/DBNAME`
  - `DATABASE_URI=postgresql://APP_USER:PASS@localhost:5432/DBNAME`
- Managed Postgres:
  - `DATABASE_MIGRATOR_URI=postgresql://SUPERUSER:PASS@HOST:5432/DBNAME?sslmode=require`
  - `DATABASE_URI=postgresql://APP_USER:PASS@HOST:5432/DBNAME?sslmode=require`

### 2.2 Build and run the API image

Build from the repository root:

```bash
docker build \
  --build-arg EDITION=community \
  -f infra/docker/Dockerfile.community \
  -t vluna/community:local \
  .
```

Run:

```bash
docker run --rm -p 3002:3002 \
  -e NODE_ENV=production \
  -e DATABASE_MIGRATOR_URI='postgresql://SUPERUSER:PASS@HOST:5432/DBNAME' \
  -e DATABASE_URI='postgresql://APP_USER:PASS@HOST:5432/DBNAME' \
  -e VLUNA_PLANE='vluna' \
  -e VLUNA_DB_SCHEMA='control_plane' \
  -e BILLING_MASTER_KEY="${BILLING_MASTER_KEY}" \
  vluna/community:local
```

Verify:

```bash
curl -fsS http://localhost:3002/health
```

### 2.3 Postgres via Docker Compose (fallback)

If you do not have Postgres running already, you can start one via Compose:

```bash
docker compose -f infra/docker/docker-compose.yml --profile db up -d
```

In that case, use these defaults (unless you changed them):

```bash
export DATABASE_MIGRATOR_URI='postgresql://vluna_superuser:vluna_superuser@localhost:5433/vluna'
export DATABASE_URI='postgresql://vluna:vluna@localhost:5433/vluna'
export VLUNA_PLANE='vluna'
export VLUNA_DB_SCHEMA='control_plane'
export BILLING_MASTER_KEY="${BILLING_MASTER_KEY}"
```

Cleanup (if you used Compose for Postgres):

```bash
docker compose -f infra/docker/docker-compose.yml down -v
```

---

## 3) Local Dev (source-based)

Goal: run the Community Edition API in dev mode (best for debugging and iteration).

Prerequisites:
- Node.js 22 + pnpm 9
- A running Postgres instance you can connect to ("bring your own Postgres")

### 3.1 Install dependencies

```bash
pnpm i
```

### 3.2 Configure database connection (required)

Local Dev uses:
- `DATABASE_URI` (from `packages/vluna-core/.env`): runtime connection (must be least-privilege; not owner, not superuser, no bypass RLS). Using an owner/superuser/rls-bypass role here can skip RLS and cause severe data leaks and bugs.
- `DATABASE_MIGRATOR_URI` (env var): superuser/owner connection for migrations/setup and provisioning workflows
- `VLUNA_PLANE` (env var): plane id (`admin` reserved; for OSS/Enterprise use `vluna`)
- `VLUNA_DB_SCHEMA` (env var): target DB schema (default `control_plane`)
- `BILLING_MASTER_KEY` (env var): required at runtime and for `vlunactl service-key ...` commands

### 3.3 Configure and initialize the database

`community:setup` runs migrations/bootstrapping. It requires `DATABASE_URI` and will use `DATABASE_MIGRATOR_URI` if
migrations are pending.

```bash
cd packages/vluna-core
cp .env.example .env
```

Set `DATABASE_URI` to your Postgres instance:

```bash
# packages/vluna-core/.env
DATABASE_URI=postgresql://USER:PASS@HOST:5432/DBNAME
```

If you expect `community:setup` to run migrations, also export a superuser/owner connection:

```bash
export DATABASE_MIGRATOR_URI='postgresql://SUPERUSER:PASS@HOST:5432/DBNAME'
export VLUNA_PLANE='vluna'
export VLUNA_DB_SCHEMA='control_plane'
```

Run setup:

```bash
cd ../..
pnpm community:setup
```

### 3.4 Postgres via Docker Compose (fallback)

If you do not have Postgres running already, you can start one via Compose:

```bash
docker compose -f infra/docker/docker-compose.yml --profile db up -d
```

Then set:

```bash
# packages/vluna-core/.env
DATABASE_URI=postgresql://vluna:vluna@localhost:5433/vluna
```

And export the migrator connection for setup/migrations:

```bash
export DATABASE_MIGRATOR_URI='postgresql://vluna_superuser:vluna_superuser@localhost:5433/vluna'
export VLUNA_PLANE='vluna'
export VLUNA_DB_SCHEMA='control_plane'
```

### 3.5 Start the API (hot reload)

```bash
pnpm community:dev

# In another terminal
curl -fsS http://localhost:3002/health
```

---

### 3.6 Provision a Service Key (for SDK integrations)

Service Keys are credentials used by **your own backend services** (or local dev tools) to authenticate to Vluna’s
service-to-service (S2S) endpoints. You create them in Vluna, then store and use them in the system that calls
Vluna (for example via your secret manager or dev environment variables). The Vluna API process itself does not
read `VLUNA_SERVICE_KEY_ID` / `VLUNA_SERVICE_KEY_SECRET` from its own environment.

The SDK integrations use Service Key auth for server-to-server calls. To get a `keyId` + derived `secret`, use
`vlunactl`.

Prerequisites (for `vlunactl`):
- `DATABASE_MIGRATOR_URI` (superuser/owner connection)
- `VLUNA_PLANE` (`admin` reserved; for OSS/Enterprise use `vluna`)
- `VLUNA_DB_SCHEMA` (default `control_plane`)
- `BILLING_MASTER_KEY`

Recommended flow:

1) List realms and see which Service Key IDs already exist:

```bash
pnpm vlunactl realm list
```

2) If the realm already exists and has a key ID, fetch the derived secret:

```bash
pnpm vlunactl service-key secret \
  --realm-id realm-... \
  --key-id pk-...
```

3) Only if needed:
- Create the realm (also does baseline provisioning):
  ```bash
  pnpm vlunactl realm create \
    --realm-id realm-default \
    --name 'Demo Realm'
  ```
  Optional: pass realm metadata as JSON:
  ```bash
  pnpm vlunactl realm create \
    --realm-id realm-default \
    --name 'Demo Realm' \
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
- Create a new Service Key for an existing realm:
  ```bash
  pnpm vlunactl service-key create --realm-id realm-default
  ```
  Optional expiration (ISO 8601):
  ```bash
  pnpm vlunactl service-key create --realm-id realm-default --expires-at 2026-06-30T00:00:00Z
  ```

## 4) Install and run the Python SDK

After the backend is up (`/health` returns 200), install and run the SDK.

Prerequisites:
- Python >= 3.10
- Recommended: `uv` (fast venv + pip). `pip`/`venv` also works.

### 4.1 Configure Service Key auth (S2S)

If your integration uses Service Key auth (including the SDK examples), configure these in the environment where you run
your app/SDK. Obtain the `keyId` and derived `secret` from §3.6.

```bash
export VLUNA_REALM_ID='realm-default'
export VLUNA_SERVICE_KEY_ID='pk-...'
export VLUNA_SERVICE_KEY_SECRET='...'
```

### 4.2 Use as a dependency (install only)

```bash
pip install vlunaai
```

### 4.3 Develop the SDK from this repo (editable + tests)

Assuming the SDK lives at `sdks/python/vlunaai`:

```bash
cd sdks/python/vlunaai

uv venv
uv pip install -e '.[dev]'
uv run python -m pytest
```

---

## 5) Run the SDK examples (local API)

Examples live under `sdks/python/vlunaai/examples/`:
- `service_key_quickstart.py` (S2S: Service Key)
- `bearer_quickstart.py` (issue a token via Service Key, then call via Bearer)

Optional: if you need a `billing_account_id`, query one (seed data may differ across versions, so query it locally):

```sql
SELECT billing_account_id
FROM billing_accounts
WHERE realm_id = 'realm-default'
LIMIT 1;
```

If you started Postgres via Docker Compose, you can run the query inside the container:

```bash
docker compose -f infra/docker/docker-compose.yml exec -T db \
  psql -U vluna_superuser -d vluna \
  -c \"SELECT billing_account_id FROM billing_accounts WHERE realm_id = 'realm-default' LIMIT 1;\"
```

Then export it:

```bash
export VLUNA_BILLING_ACCOUNT_ID='...'
```

### 5.2 Run the examples

```bash
cd sdks/python/vlunaai

# S2S example (defaults to http://localhost:3002/mgt/v1)
uv run python examples/service_key_quickstart.py
```

The bearer example also needs two business identifiers (used in the token issuance request body):

```bash
export VLUNA_PRINCIPAL_ID='principal_123'
export VLUNA_USER_ID='user_123'

uv run python examples/bearer_quickstart.py
```

If your API is not on the default URLs, override:
- `VLUNA_BASE_URL` (service example)
- `VLUNA_SERVICE_BASE_URL` / `VLUNA_BEARER_BASE_URL` (bearer example)
