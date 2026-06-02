# Vluna: Open-Source Billing & Usage Gating

[![CI](https://github.com/tapsvc/vluna/actions/workflows/ci.yml/badge.svg)](https://github.com/tapsvc/vluna/actions/workflows/ci.yml)
[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-blue.svg)](./LICENSE)

## Managed and self-hosted options

For a fully managed production deployment, use [Vluna Cloud](https://vluna.ai).

This repository is the open-source self-hosted/community edition.

## What is Vluna?

Vluna is cost tracking, billing and runtime usage control for AI agents.

It helps you ship agentic features that are safe to run, easy to monetize, and easy to explain when something goes wrong.

## When you need Vluna

Use Vluna if you are building AI agents that run multi-step tasks and call tools, and any of the following apply:

- You need to know the real cost of each task, broken down by customer, plan, agent, or model. Aggregate monthly bills are not enough.
- You need to stop or degrade work when a customer runs out of budget, without crashing the agent or double-charging on retry.
- You change prices or run pricing experiments and do not want every change gated on an engineering deployment.
- You need to bill by outcomes and business results, not only raw usage.
- You need reliable retries without double-charging (idempotency).
- You need an auditable trail for every charge so support, finance, and customers see the same story.

## What Vluna does

Vluna provides:

- Runtime authorization and limits (authorize before work, commit after work).
- Per-task cost tracking. Every authorize and commit cycle records what the run actually cost. Attribute spend by customer, plan, agent, or model without instrumenting it yourself.
- Usage-based metering and settlement for agent workloads (tokens, requests, time, bytes).
- Outcome-based billing when value is measured by results (events to ratings).
- Plans, entitlements, and wallet mechanics (credits and grants).
- Flexible pricing changes. Rates, plans, and entitlements live in Vluna config, so you can adjust pricing or roll out a new plan to a cohort without shipping code.
- An auditable ledger and reporting surfaces for reconciliation.

## How money works (XUSD)

AI costs change fast and are hard to explain to customers in raw units. Vluna solves this by settling all monetary amounts in a single internal currency called XUSD. XUSD is stored as an integer to keep accounting precise and audit-friendly.

XUSD is not a customer-facing unit. In your product, you can present any credit system you want, while Vluna keeps the internal settlement and ledger consistent.

Online docs: https://docs.vluna.ai/docs

## Core Features

- **Identity**: `principal_id` and `billing_account_id`.
- **Billable resources model**: feature_families, features, and meters.
- **Packaging and enforcement**: entitlements and gate policies.
- **Commercial terms**: billing plans, plan assignments, and contract terms.
- **Money**: XUSD, funding, and the ledger.
- **Runtime**: authorization, metering, and rating.
- **Outcome-based billing**: events and rating policies that turn business results into billable records.

## Core Concepts

Vluna's design philosophy is to "get out of your way" initially and provide value from the first API call, then allow for progressive enhancement.

Key objects to know:

1.  **Realm and service key**: Set a realm per project and use service keys for `/mgt/v1`.
2.  **Identity**: `principal_id` identifies who pays; `billing_account_id` is the account-scoped anchor.
3.  **Catalog model**: feature_families group features; meters measure usage.
4.  **Commercial terms**: billing plans and plan assignments define what is sold and which account it applies to.
5.  **Entitlements and gate policies**: define what is allowed and how limits are enforced.
6.  **Runtime flow**: authorize before work, commit after work using a lease token.
7.  **Outcomes and ratings**: ingest events and apply event rating policies when billing by results.
8.  **Ratings**: ratings are the authoritative billable records for usage or outcomes.
9.  **Settlement and ledger**: ratings post to the ledger and drive balances and reporting.

You can start with just `authorize` and `commit`, and the system will work. Later, you can layer in pricing, create grants, and build out a full subscription-driven catalog.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v22+)
- [pnpm](https://pnpm.io/) (v9+)
- [Docker](https://www.docker.com/) & Docker Compose (optional for local Postgres or container runs)

### 1. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/lapbay/vluna.git
pnpm install
```

### 2. Database Setup

Vluna requires a PostgreSQL 16+ database. You can run one easily with Docker Compose.

```bash
# Start Postgres in the background
docker compose -f infra/docker/docker-compose.yml --profile db up -d
```

Once the database is running, set up the schema and run initial migrations. Create a `.env` file in `packages/vluna-core` from the example and ensure `DATABASE_URI` is set correctly (`VLUNA_PLANE` defaults to `vluna`, `VLUNA_DB_SCHEMA` defaults to `control_plane`).

Before running any commands, set a required `BILLING_MASTER_KEY` (used to derive Service Key secrets and required at runtime):

```bash
export BILLING_MASTER_KEY='replace-me-with-generated'
```

If migrations are needed, also export `DATABASE_MIGRATOR_URI` with a superuser/owner connection string.

```bash
# In packages/vluna-core
cp .env.example .env

# This command runs DB migrations and seeds required data.
pnpm community:setup
```

### 3. Running the Application

Run the community edition in development mode with hot-reloading:

```bash
pnpm community:dev
```

The API server will be available at `http://localhost:3002`. You can check its health at `http://localhost:3002/health`.

### 4. Running with Docker

You can also build and run the community edition as a Docker container.

```bash
# From the repo root

# 1. Build the Docker image
docker build --build-arg EDITION=community -f infra/docker/Dockerfile.community -t vluna/community:latest .

# 2. Run the API container
# This assumes you have an external Postgres DB.
docker run -p 3002:3002 \
  --add-host db.vluna.internal:host-gateway \
  --env-file apps/app-community/.env.example \
  -e BILLING_MASTER_KEY="${BILLING_MASTER_KEY}" \
  --rm -it vluna/community:latest

# 3. (Alternative) Run with Docker Compose (API + bundled Postgres)
docker compose -f infra/docker/docker-compose.yml --profile db up -d
```

## Project Structure

This directory is a PNPM workspace containing the community edition of Vluna.

-   `packages/vluna-core`: The core runtime, database layer, migrations, and shared business logic for billing and gating.
-   `packages/vluna-platform`: Edition-specific feature matrix and helpers. For OSS, this enables community-only features.
-   `apps/app-community`: The NestJS application shell that wires together `vluna-core` and the community `vluna-platform` profile.
-   `infra/docker`: Contains Dockerfiles and `docker-compose.yml` for running the service.

## License

Vluna is licensed under the **Business Source License 1.1**.

Under the BSL, you can use, copy, modify, and run Vluna for **non-production** purposes freely. You may also use it in **production** for your own internal products. You may **not** use it to offer a commercial hosted, SaaS, or cloud service that competes with Vluna.

On the **Change Date** (4 years after the License Grant Date), the code automatically becomes available under the **MIT License**.

See [LICENSE](./LICENSE) for the full terms.
