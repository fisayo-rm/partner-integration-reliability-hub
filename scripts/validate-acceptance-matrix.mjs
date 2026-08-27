import { access, readFile } from "node:fs/promises";

const file = new URL("../docs/m12-acceptance-matrix.json", import.meta.url);
const matrix = JSON.parse(await readFile(file, "utf8"));
if (
  matrix.version !== 1 ||
  matrix.milestone !== "M12" ||
  !Array.isArray(matrix.rows)
)
  throw new Error("M12 acceptance matrix has an invalid version or shape.");
const requiredIds = new Set([
  "lease-recovery",
  "concurrency-races",
  "fault-isolation",
  "recovery-contract",
  "isolated-restore",
  "observability-runtime",
  "hosted-observability",
  "local-profiles",
  "ui-replay",
  "acceptance-before-call",
  "load-scenarios",
  "load-artifacts",
  "runbooks",
  "ci-gates",
  "infrastructure-synthesis",
  "hosted-functional",
  "hybrid-safety",
  "adr-reconciliation",
  "operator-documentation",
  "handoff",
]);
if (matrix.rows.length < requiredIds.size)
  throw new Error("M12 acceptance matrix is incomplete.");
const ids = new Set();
for (const row of matrix.rows) {
  if (
    typeof row.id !== "string" ||
    typeof row.criterion !== "string" ||
    typeof row.verification !== "string"
  )
    throw new Error(
      "Every acceptance row requires id, criterion, and verification text.",
    );
  if (ids.has(row.id))
    throw new Error(`M12 acceptance row ${row.id} is duplicated.`);
  ids.add(row.id);
  for (const reference of row.verification.match(
    /(?:tests|scripts|\.github)\/[\w./-]+/g,
  ) ?? [])
    await access(new URL(`../${reference}`, import.meta.url));
}
for (const id of requiredIds)
  if (!ids.has(id)) throw new Error(`M12 acceptance row ${id} is missing.`);
process.stdout.write(
  `${JSON.stringify({ matrix: "M12", rows: matrix.rows.length })}\n`,
);
