import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests run against the local Supabase stack
// (`npx supabase start`, then `npm run test:integration`). They share one
// database, so files run one at a time.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/support/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // DEV-263g: the database owner's local test-recipient switch on for each file
    setupFiles: ["tests/integration/setup-local-test-recipients.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
