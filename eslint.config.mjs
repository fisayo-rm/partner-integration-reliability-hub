import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "baselines/**",
      "implementation/**",
      "decisions/**",
      "planning/**",
      ".github/**",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
      },
    },
  },
  prettier,
);
