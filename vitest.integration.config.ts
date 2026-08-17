import base from "./vitest.config.js";

export default {
  ...base,
  test: {
    ...base.test,
    include: ["tests/integration/**/*.test.ts"],
    exclude: [],
  },
};
