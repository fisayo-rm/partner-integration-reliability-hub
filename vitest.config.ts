import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@pirh/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url),
      ),
      "@pirh/domain": fileURLToPath(
        new URL("./packages/domain/src/index.ts", import.meta.url),
      ),
      "@pirh/application": fileURLToPath(
        new URL("./packages/application/src/index.ts", import.meta.url),
      ),
      "@pirh/auth": fileURLToPath(
        new URL("./packages/auth/src/index.ts", import.meta.url),
      ),
      "@pirh/persistence": fileURLToPath(
        new URL("./packages/persistence/src/index.ts", import.meta.url),
      ),
      "@pirh/secrets": fileURLToPath(
        new URL("./packages/secrets/src/index.ts", import.meta.url),
      ),
      "@pirh/config-portability": fileURLToPath(
        new URL("./packages/config-portability/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**/*.test.ts"],
    passWithNoTests: false,
  },
});
