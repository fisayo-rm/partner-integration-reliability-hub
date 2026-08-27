# Partner Integration Reliability Hub

The Partner Integration Reliability Hub is a TypeScript monorepo for a reliable,
multi-tenant partner delivery platform. M00 establishes its engineering baseline;
business behavior, API contracts, Docker Compose, and local services begin in M01.

## Prerequisites

- Node.js 24.x (`node --version` must satisfy `>=24 <25`)
- Corepack enabled (`corepack enable`)
- Docker with the Compose plugin; M01 is verified with Colima on macOS

## Clean-clone setup and verification

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs formatting, linting, strict TypeScript compilation for source
and tests, dependency architecture checks, unit tests, every workspace build,
secret scanning, and the high-severity dependency audit.

## Individual developer commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:typecheck
pnpm architecture
pnpm test
pnpm build
pnpm secret:scan
pnpm audit
```

## Local platform and operations console (M08)

Start Colima before using Docker on macOS:

```bash
colima start
cp .env.example .env.local
# Replace the two local secret placeholders with random local-only values.
pnpm local:up
# or include local telemetry services
pnpm local:up:observability
```

The local environment uses disposable Docker volumes, DynamoDB Local, ElasticMQ,
Keycloak, two mock partners, and a Vite-built React operations console served on
`http://localhost:5173`. The public API is at `http://localhost:3000` and its CORS
allowlist is controlled by `CONSOLE_ORIGIN`. The console uses Authorization Code with
PKCE and keeps its browser session in session storage.

It seeds one operational tenant with admin, operator, and viewer mappings, plus a
second-tenant viewer used solely to verify API tenant isolation. A local producer
client and partner credentials are encrypted in DynamoDB Local and are never exposed
by the API or console. The smoke suite checks both Compose profiles, integration
behavior, M04–M07 demonstrations, and the M08 browser workflow, then removes its
isolated containers and volumes:

```bash
pnpm local:verify
pnpm local:down
```

`pnpm local:down` includes the observability profile, so it also removes local
Grafana, Jaeger, Loki, Prometheus, and OpenTelemetry containers when they were
started with `pnpm local:up:observability`.

The Keycloak users in `.env.example` are local-demo-only identities:

- `admin@example.test` / `admin-demo-only` can manage partners, destinations,
  transformations, and subscriptions.
- `operator@example.test` / `operator-demo-only` can investigate and replay eligible
  deliveries with an audited reason.
- `viewer@example.test` / `viewer-demo-only` can view redacted operational data only.
- `other-tenant-viewer@example.test` / `other-viewer-demo-only` exists only to prove
  direct cross-tenant resource access is denied.

The initial local seed intentionally contains configuration and identities, but no
sample events or deliveries. To create a controlled operational story for the
console, keep `pnpm local:up` running and use a separate terminal:

```bash
set -a
source .env.local
set +a
pnpm demo:m06
```

Then sign in as the operator, open Overview, search the generated delivery in
Deliveries or Dead letters, review its redacted attempt/history evidence, and replay
an eligible terminal delivery with a 10–1000 character reason. The original delivery
remains immutable. `pnpm local:verify` supplies its own isolated environment values
when it runs the same demonstration.

## Controlled configuration portability (M09)

Configuration bundles promote only approved control-plane intent. They are versioned,
deterministic YAML documents (JSON is accepted on import) and never carry secret
values, events, attempts, audit history, queue work, leases, or circuit/rate runtime
state. Target environments must provision the logical secret aliases before enabling
their destinations.

Set `PIRH_ACCESS_TOKEN` to a tenant-scoped admin access token and, when needed,
`PIRH_API_BASE_URL`. The plan key in `.env.local` must be a distinct base64-encoded
32-byte value.

```bash
pnpm config export --tenant tenant-demo --output ./config/demo.yaml
pnpm config import ./config/demo.yaml --validate
pnpm config import ./config/demo.yaml --plan
pnpm config import ./config/demo.yaml --apply
```

Planning writes the short-lived signed receipt to `demo.yaml.pirh-plan.json`, which
is intentionally ignored by Git. Apply verifies that receipt and target state before
mutating anything, then refreshes it with the resulting plan. Omitted resources are
not deleted or disabled; unresolved aliases and immutable-version changes are
reported rather than forced.

## Recovery, load, and final acceptance (M12)

Recovery snapshots are distinct from configuration portability bundles: they retain
one tenant's durable operational state for restoration only into fresh isolated
tables. They never read local secret values and reject secret-shaped content.

```bash
# Local controlled recovery snapshot; output is intentionally gitignored.
pnpm ops:backup --environment local --tenant tenant_01J0A1B2C3D4E5F6G7H8J9K0MN --output backups/demo
pnpm ops:restore --source backups/demo/manifest.v1.json --target-environment restore-test \
  --core-table pirh-restore-core --audit-table pirh-restore-audit --allow-restore
# Full isolated backup, restore, alias-rebind, and signed-event drill.
pnpm restore:drill

# From an already-running, isolated local Compose environment.
PIRH_LOAD_SCENARIO=one-destination PIRH_K6_RATE=100 PIRH_K6_DURATION=60s pnpm load:run
# Fresh all-scenario resilience gate (it provisions and removes its own stack).
pnpm local:verify:deep
pnpm acceptance:validate
```

The k6 profile uses an open constant-arrival-rate executor and writes only ignored
machine-readable artifacts to `load-artifacts/`. Run all named scenarios with
`pnpm local:verify:deep` or the scheduled/manual **Deep verification** workflow.
The checked-in [M12 local load report](docs/m12-local-load-report.md) records the
environment, payload size, warm-up and duration, accepted rate, queue depth,
latencies, retries, versions, resource limits, and emulator limitations. Hosted
performance remains optional under ADR-021.

Runbooks for partner outage, invalid credentials, growing delivery queue,
infrastructure DLQ, stuck outbox, and restore are in `docs/runbooks/`. They are
designed for evidence-first operation: never purge queues, mutate history, or copy
secret values as a recovery shortcut.

## Repository boundaries

- `apps/` contains runtime composition points only.
- `packages/domain` remains free of infrastructure, framework, and persistence imports.
- `packages/application` depends on domain contracts and ports, not adapters.
- Infrastructure adapters remain in their own packages; applications compose them.
- The React console consumes API contracts, never server implementation modules.

## Hosted demo bootstrap (M10)

The demo targets `us-east-1` and uses GitHub OIDC rather than long-lived AWS keys.
Before the first deployment, bootstrap the account, create the GitHub `demo`
environment with required branch protection, and configure only the documented
environment-scoped variables and secrets: account ID, deploy-role ARN, Pages project
name, Cloudflare account/token, and three demo-user bootstrap passwords. Then run
`pnpm --filter @pirh/cdk synth`, inspect `cdk diff`, and deploy through the protected
main workflow. The workflow creates the Cloudflare Pages project if it does not exist,
seeds non-source SSM values, deploys static console assets, and records rollback inputs.

Hosted rollback changes Lambda aliases and redeploys a recorded Pages artifact only;
it never rewrites DynamoDB event, attempt, audit, or configuration history.

## Guarded hybrid AWS development (M11)

`local` remains the default and does not require AWS credentials. The optional
`hybrid` profile runs local application processes against the dedicated
`PirhHybridFisayoRm` development stack only. It never targets the demo stack.

Deploy with an authorized provisioning identity. To run a local hybrid process or
smoke, log in as a non-root IAM, IAM Identity Center, or federated identity that can
read this stack and assume `PirhHybridFisayoRmDeveloperRole`; AWS does not permit a
root identity to assume that role. After short-lived AWS CLI login, synthesize and
inspect the isolated stack before deploying it:

```bash
pnpm hybrid:synth
pnpm hybrid:diff
pnpm hybrid:deploy
```

Copy `.env.hybrid.example` only for its non-secret account/stack inputs. Use the
wrapper to resolve CloudFormation outputs and assume the dedicated developer role;
it does not print temporary credentials:

```bash
pnpm hybrid:run -- api
pnpm hybrid:run -- outbox-worker
pnpm hybrid:run -- router-worker
pnpm hybrid:run -- delivery-worker
```

Every local hybrid entrypoint requires `ALLOW_REMOTE_AWS=true`, validates the AWS
account, stack tags, expected role, and all configured resource identifiers before
performing remote work. A local process configured as `demo`, `performance`, or
`production-reference` exits immediately. The developer role has no access to the
shared PIRH table, queue, or SSM namespaces.

Run the live hybrid smoke only after the stack is deployed and an authenticated
AWS CLI session is available:

```bash
pnpm hybrid:smoke
```

The stack is intentionally low-cost and per-developer. It remains available for
managed-service debugging until explicitly torn down; destruction deletes its
development tables, queues, Cognito pool, and mock functions:

```bash
pnpm hybrid:destroy
```

The complete local Docker topology, service health checks, and all domain/API
contracts are deliberately deferred to M01. See the frozen architecture baseline
and accepted ADRs in the repository's agent-facing materials for the governing design.
