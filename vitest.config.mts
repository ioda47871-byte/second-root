import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests are pure and DB-free. Integration tests (tests/integration/,
// added from DEV-001) run against a local Supabase via their own config so
// `npm test` never needs Docker or network access.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
