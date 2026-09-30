import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated test output.
    "playwright-report/**",
    "test-results/**",
    "blob-report/**",
    // Concept Works: static exports built in their own repositories (docs/WORKS.md).
    "public/works/**",
  ]),
]);

export default eslintConfig;
