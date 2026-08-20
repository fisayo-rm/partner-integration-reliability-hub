import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["apps", "packages"];
const applicationNames = new Set([
  "api",
  "console",
  "outbox-worker",
  "router-worker",
  "delivery-worker",
  "outbox-reconciler",
  "mock-partner-alpha",
  "mock-partner-beta",
  "config-cli",
]);

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...(await listTypeScriptFiles(candidate)));
    if (entry.isFile() && /\.tsx?$/.test(candidate)) files.push(candidate);
  }
  return files;
}

function importsFrom(source) {
  const matcher =
    /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  return [...source.matchAll(matcher)].map((match) => match[1] ?? match[2]);
}

function workspaceUnit(relativePath) {
  const [kind, name] = relativePath.split(path.sep);
  return `${kind}/${name}`;
}

function packageName(relativePath) {
  return relativePath.split(path.sep)[1];
}

function violationsFor(relativePath, moduleName) {
  const violations = [];
  const unit = workspaceUnit(relativePath);
  const name = packageName(relativePath);
  const isApp = relativePath.startsWith(`apps${path.sep}`);
  const isPackage = relativePath.startsWith(`packages${path.sep}`);
  const importedApp = moduleName.match(/^@pirh\/([^/]+)/)?.[1];
  const normalizedRelativeImport = moduleName.startsWith(".")
    ? path.posix.normalize(
        path.posix.join(
          path.posix.dirname(relativePath.split(path.sep).join("/")),
          moduleName,
        ),
      )
    : undefined;

  if (isPackage && importedApp && applicationNames.has(importedApp)) {
    violations.push(`${unit} may not import application package ${moduleName}`);
  }
  if (isPackage && normalizedRelativeImport?.startsWith("apps/")) {
    violations.push(`${unit} may not import application source ${moduleName}`);
  }
  if (name === "domain") {
    const prohibited = [
      /^@pirh\/(?:persistence|queue|auth|secrets|partner-http|observability|config)/,
      /^@aws-sdk\//,
      /^(?:node:)?https?$/,
      /^fastify$/,
      /^react(?:\/|$)/,
      /^undici$/,
    ];
    if (prohibited.some((pattern) => pattern.test(moduleName))) {
      violations.push(
        `packages/domain may not import infrastructure module ${moduleName}`,
      );
    }
    if (normalizedRelativeImport?.startsWith("packages/persistence/")) {
      violations.push(
        `packages/domain may not import persistence source ${moduleName}`,
      );
    }
  }
  if (name === "application") {
    const prohibited =
      /^@pirh\/(?:persistence|queue|auth|secrets|transformation|partner-http|observability|config|config-portability|test-support)/;
    if (
      prohibited.test(moduleName) ||
      (importedApp && applicationNames.has(importedApp))
    ) {
      violations.push(
        `packages/application may not import adapter or application module ${moduleName}`,
      );
    }
  }
  if (
    isApp &&
    name === "console" &&
    (moduleName === "@pirh/api" ||
      moduleName.includes("apps/api") ||
      normalizedRelativeImport?.startsWith("apps/api/"))
  ) {
    violations.push(
      `apps/console may not import server implementation ${moduleName}`,
    );
  }
  if (
    isApp &&
    ["mock-partner-alpha", "mock-partner-beta"].includes(name) &&
    moduleName === "@pirh/partner-http"
  ) {
    violations.push(
      `${unit} may not import production partner logic ${moduleName}`,
    );
  }
  if (
    isApp &&
    ["mock-partner-alpha", "mock-partner-beta"].includes(name) &&
    normalizedRelativeImport?.startsWith("packages/partner-http/")
  ) {
    violations.push(
      `${unit} may not import production partner source ${moduleName}`,
    );
  }
  return violations;
}

export function inspectSources(sources) {
  const violations = [];
  const dependencies = new Map();
  const sourceDependencies = new Map();
  for (const [relativePath, source] of Object.entries(sources)) {
    const unit = workspaceUnit(relativePath);
    const imports = importsFrom(source);
    dependencies.set(unit, dependencies.get(unit) ?? new Set());
    sourceDependencies.set(
      relativePath,
      sourceDependencies.get(relativePath) ?? new Set(),
    );
    for (const moduleName of imports) {
      violations.push(...violationsFor(relativePath, moduleName));
      const imported = moduleName.match(/^@pirh\/([^/]+)/)?.[1];
      if (imported) dependencies.get(unit).add(`packages/${imported}`);
      if (moduleName.startsWith(".")) {
        const sourcePath = relativePath.split(path.sep).join("/");
        const basePath = path.posix.normalize(
          path.posix.join(path.posix.dirname(sourcePath), moduleName),
        );
        const candidates = [
          basePath.endsWith(".js") || basePath.endsWith(".jsx")
            ? `${basePath.replace(/\.jsx?$/, "")}.ts`
            : `${basePath}.ts`,
          basePath.endsWith(".js") || basePath.endsWith(".jsx")
            ? `${basePath.replace(/\.jsx?$/, "")}.tsx`
            : `${basePath}.tsx`,
          `${basePath}/index.ts`,
          `${basePath}/index.tsx`,
        ];
        const dependency = candidates.find((candidate) => candidate in sources);
        if (dependency) sourceDependencies.get(relativePath).add(dependency);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(unit, trail) {
    if (visiting.has(unit)) {
      violations.push(
        `workspace dependency cycle: ${[...trail, unit].join(" -> ")}`,
      );
      return;
    }
    if (visited.has(unit)) return;
    visiting.add(unit);
    for (const dependency of dependencies.get(unit) ?? [])
      visit(dependency, [...trail, unit]);
    visiting.delete(unit);
    visited.add(unit);
  }
  for (const unit of dependencies.keys()) visit(unit, []);
  const sourceVisiting = new Set();
  const sourceVisited = new Set();
  function visitSource(file, trail) {
    if (sourceVisiting.has(file)) {
      violations.push(
        `source dependency cycle: ${[...trail, file].join(" -> ")}`,
      );
      return;
    }
    if (sourceVisited.has(file)) return;
    sourceVisiting.add(file);
    for (const dependency of sourceDependencies.get(file) ?? []) {
      visitSource(dependency, [...trail, file]);
    }
    sourceVisiting.delete(file);
    sourceVisited.add(file);
  }
  for (const file of sourceDependencies.keys()) visitSource(file, []);
  return violations;
}

async function inspectRepository() {
  const sources = {};
  for (const sourceRoot of sourceRoots) {
    const absoluteRoot = path.join(root, sourceRoot);
    for (const file of await listTypeScriptFiles(absoluteRoot)) {
      sources[path.relative(root, file)] = await readFile(file, "utf8");
    }
  }
  return inspectSources(sources);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = await inspectRepository();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Architecture dependency rules passed.");
  }
}
