import { access, readFile } from "node:fs/promises";

const file = new URL("../docs/m12-acceptance-matrix.json", import.meta.url);
const matrix = JSON.parse(await readFile(file, "utf8"));
const requiredIds = new Set(
  `
race-duplicate-ingestion
race-duplicate-delivery-worker
race-duplicate-outbox-publication
race-half-open-probe
race-rate-boundary
race-duplicate-replay
race-lease-expiry-inflight
fault-partner-before-commit
fault-outbox-after-sqs-send
fault-transient-dynamodb
fault-sqs-send
fault-oauth-timeout
fault-partner-timeout
fault-malformed-message
fault-stale-message
fault-missing-secret
fault-destination-disabled
fault-circuit-finalization-conflict
load-ingestion-only
load-one-destination
load-two-destinations
load-slow-partner
load-high-retry
load-rate-limited-hot
load-concurrent-search
restore-drill
runbook-partner-outage
runbook-invalid-credentials
runbook-growing-delivery-queue
runbook-infrastructure-dlq
runbook-stuck-outbox
runbook-restore
accept-authenticated-event-submission
accept-duplicate-key
accept-two-destinations
accept-correct-transformations
accept-api-key-and-oauth
accept-asynchronous-processing
accept-retry-with-jitter
accept-no-infinite-retry
accept-rate-limit
accept-circuit-behavior
accept-product-dead-letter
accept-authorized-replay
accept-unauthorized-replay
accept-original-history-immutable
accept-search-by-correlation
accept-secrets-redacted
accept-cross-tenant-denial
accept-logs-metrics-traces
accept-ci-test-suites
accept-local-documented-startup
accept-automated-deployment
accept-no-manual-db-edits
accept-configuration-portability
accept-hybrid-development
m12-adr-reconciliation
m12-handoff
`
    .trim()
    .split("\n"),
);
const expectedCategories = {
  concurrency: 7,
  fault: 11,
  load: 7,
  recovery: 1,
  runbook: 6,
  "tadd-acceptance": 24,
  governance: 2,
};
const permittedStates = new Set([
  "verified-local",
  "verified-hosted",
  "pending-ci",
  "pending-deployment",
]);
// ADRs and milestone handoffs are intentionally local records and are not
// versioned with the implementation repository. Their evidence remains declared
// in the matrix, but CI can only require material that is present in its checkout.
const localGovernanceEvidenceKinds = new Set(["adr-index", "adr", "handoff"]);

if (
  matrix.version !== 2 ||
  matrix.milestone !== "M12" ||
  matrix.baseline !== "TADD v0.5 section 51" ||
  !Array.isArray(matrix.rows)
)
  throw new Error("M12 acceptance matrix has an invalid version or shape.");
if (matrix.rows.length !== requiredIds.size)
  throw new Error(
    `M12 acceptance matrix must contain exactly ${requiredIds.size} rows.`,
  );

const ids = new Set();
const categories = new Map();
const states = new Map();
for (const row of matrix.rows) {
  if (
    typeof row.id !== "string" ||
    typeof row.category !== "string" ||
    typeof row.criterion !== "string" ||
    !permittedStates.has(row.state) ||
    !Array.isArray(row.evidence) ||
    row.evidence.length === 0
  )
    throw new Error(
      "Every acceptance row requires id, category, criterion, state, and evidence.",
    );
  if (ids.has(row.id))
    throw new Error(`M12 acceptance row ${row.id} is duplicated.`);
  if (!requiredIds.has(row.id))
    throw new Error(`M12 acceptance row ${row.id} is not an approved M12 row.`);
  ids.add(row.id);
  categories.set(row.category, (categories.get(row.category) ?? 0) + 1);
  states.set(row.state, (states.get(row.state) ?? 0) + 1);
  for (const evidence of row.evidence) {
    if (
      typeof evidence?.kind !== "string" ||
      typeof evidence?.path !== "string" ||
      evidence.path.startsWith("/") ||
      evidence.path.includes("..")
    )
      throw new Error(`M12 acceptance row ${row.id} has invalid evidence.`);
    if (!localGovernanceEvidenceKinds.has(evidence.kind))
      await access(new URL(`../${evidence.path}`, import.meta.url));
  }
}
for (const id of requiredIds)
  if (!ids.has(id)) throw new Error(`M12 acceptance row ${id} is missing.`);
for (const [category, expected] of Object.entries(expectedCategories))
  if (categories.get(category) !== expected)
    throw new Error(
      `M12 acceptance category ${category} must contain ${expected} rows.`,
    );
if (categories.size !== Object.keys(expectedCategories).length)
  throw new Error("M12 acceptance matrix contains an unknown category.");

process.stdout.write(
  `${JSON.stringify({ matrix: "M12", rows: matrix.rows.length, states: Object.fromEntries(states) })}\n`,
);
