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

For the primary operational story, run `pnpm local:up`, sign in as the operator,
open Overview, search a delivery in Deliveries or Dead letters, review its redacted
attempt/history evidence, and replay an eligible terminal delivery with a 10–1000
character reason. The original delivery remains immutable. Use `pnpm demo:m06` in a
separate terminal to produce a controlled dead-letter/replay story; its required
environment values are supplied automatically by `pnpm local:verify`.

## Repository boundaries

- `apps/` contains runtime composition points only.
- `packages/domain` remains free of infrastructure, framework, and persistence imports.
- `packages/application` depends on domain contracts and ports, not adapters.
- Infrastructure adapters remain in their own packages; applications compose them.
- The React console consumes API contracts, never server implementation modules.

The complete local Docker topology, service health checks, and all domain/API
contracts are deliberately deferred to M01. See the frozen architecture baseline
and accepted ADRs in the repository's agent-facing materials for the governing design.
