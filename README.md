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

`pnpm verify` runs formatting, linting, strict TypeScript compilation, dependency
architecture checks, unit tests, every workspace build, secret scanning, and the
high-severity dependency audit.

## Individual developer commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm architecture
pnpm test
pnpm build
pnpm secret:scan
pnpm audit
```

## Local platform (M02)

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
Keycloak, health-only mock partners, and service placeholders. It seeds one tenant,
admin/operator/viewer mappings, and a producer client whose secret is AES-256-GCM
encrypted in DynamoDB Local. The smoke suite checks both profiles and M02 DynamoDB/
Keycloak integration behavior, then removes its isolated containers and volumes:

```bash
pnpm local:verify
pnpm local:down
```

The Keycloak users in `.env.example` are local-demo-only identities. M02 provides
authentication hooks and persistence primitives, but no public business endpoint,
event processing, partner delivery, or transformation execution; those begin in
later milestones.

## Repository boundaries

- `apps/` contains runtime composition points only.
- `packages/domain` remains free of infrastructure, framework, and persistence imports.
- `packages/application` depends on domain contracts and ports, not adapters.
- Infrastructure adapters remain in their own packages; applications compose them.
- The React console consumes API contracts, never server implementation modules.

The complete local Docker topology, service health checks, and all domain/API
contracts are deliberately deferred to M01. See the frozen architecture baseline
and accepted ADRs in the repository's agent-facing materials for the governing design.
