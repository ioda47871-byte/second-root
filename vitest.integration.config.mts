import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests run against the local Supabase stack
// (`npx supabase start`, then `npm run test:integration`). They share one
// database, so files run one at a time.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
