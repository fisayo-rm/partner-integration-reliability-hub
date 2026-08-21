import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("local teardown includes observability-profile services", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  expect(manifest.scripts["local:down"]).toBe(
    "docker compose --profile observability down --volumes --remove-orphans",
  );
});
