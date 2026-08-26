import { access, readFile } from "node:fs/promises";

const file = new URL("../docs/m12-acceptance-matrix.json", import.meta.url);
const matrix = JSON.parse(await readFile(file, "utf8"));
if (
  matrix.version !== 1 ||
  matrix.milestone !== "M12" ||
  !Array.isArray(matrix.rows)
)
  throw new Error("M12 acceptance matrix has an invalid version or shape.");
if (matrix.rows.length < 7)
  throw new Error("M12 acceptance matrix is incomplete.");
for (const row of matrix.rows) {
  if (typeof row.criterion !== "string" || typeof row.verification !== "string")
    throw new Error(
      "Every acceptance row requires criterion and verification text.",
    );
  for (const reference of row.verification.match(
    /(?:tests|scripts|\.github)\/[\w./-]+/g,
  ) ?? [])
    await access(new URL(`../${reference}`, import.meta.url));
}
process.stdout.write(
  `${JSON.stringify({ matrix: "M12", rows: matrix.rows.length })}\n`,
);
