import { isAbsolute, join } from "node:path";

// Where the design asset store lives (DEV-029). Pure and import-free on
// purpose: intake, the preview asset route and the list of paths Codex must
// never see (protected-paths.ts) all use it, without importing each other.

/** SR_DESIGN_ASSETS_ROOT when absolute, else a fixed place in the user's home. */
export function assetStoreRoot(env: Record<string, string | undefined>): string {
  const root = env.SR_DESIGN_ASSETS_ROOT;
  if (root && isAbsolute(root)) return root;
  return join(env.HOME ?? "/nonexistent", ".local", "share", "second-root-design-assets");
}
