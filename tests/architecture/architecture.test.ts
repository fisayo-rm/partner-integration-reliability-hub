import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { inspectSources } from "../../scripts/check-architecture.mjs";

test("the negative domain fixture is rejected", async () => {
  const source = await readFile(
    new URL("./fixtures/domain-fastify.fixture.ts", import.meta.url),
    "utf8",
  );
  expect(
    inspectSources({ "packages/domain/src/fixture.ts": source }),
  ).toContain("packages/domain may not import infrastructure module fastify");
});

test("a permitted domain import has no violations", () => {
  expect(
    inspectSources({
      "packages/domain/src/index.ts": "export type Identifier = string;",
    }),
  ).toEqual([]);
});

test("workspace cycles are rejected", () => {
  expect(
    inspectSources({
      "packages/domain/src/index.ts": 'import "@pirh/application";',
      "packages/application/src/index.ts": 'import "@pirh/domain";',
    }),
  ).toContain(
    "workspace dependency cycle: packages/domain -> packages/application -> packages/domain",
  );
});

test("relative source cycles are rejected", () => {
  expect(
    inspectSources({
      "packages/domain/src/a.ts": 'import "./b.js";',
      "packages/domain/src/b.ts": 'import "./a.js";',
    }),
  ).toContain(
    "source dependency cycle: packages/domain/src/a.ts -> packages/domain/src/b.ts -> packages/domain/src/a.ts",
  );
});
