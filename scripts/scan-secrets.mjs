import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
  ".github",
  "apps",
  "docs",
  "infrastructure",
  "packages",
  "scripts",
  "tests",
];
const ignoredDirectories = new Set([
  "dist",
  "node_modules",
  "coverage",
  ".git",
]);
const patterns = [
  { name: "AWS access key", expression: /AKIA[0-9A-Z]{16}/ },
  {
    name: "private key",
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  { name: "GitHub token", expression: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
  { name: "Slack token", expression: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(candidate)));
    if (entry.isFile()) files.push(candidate);
  }
  return files;
}

const candidates = [
  path.join(root, "README.md"),
  path.join(root, ".env.example"),
];
for (const directory of roots) {
  try {
    candidates.push(...(await filesBelow(path.join(root, directory))));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const findings = [];
for (const candidate of candidates) {
  const contents = await readFile(candidate, "utf8");
  for (const pattern of patterns) {
    if (pattern.expression.test(contents))
      findings.push(`${path.relative(root, candidate)}: ${pattern.name}`);
  }
}
if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Secret scan passed.");
}
