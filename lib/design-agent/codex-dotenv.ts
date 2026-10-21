/**
 * Whether $CODEX_HOME/.env exists (DEV-078 PoC, DEV-079 every Codex process).
 *
 * Every `codex` invocation (`--version` and `login status` too) first runs the
 * CLI's arg0 dispatch, before argument parsing: load_dotenv reads
 * $CODEX_HOME/.env into the CLI's own environment and filters only CODEX_*
 * keys (codex-rs arg0/src/lib.rs). An API key or a base URL in that file
 * would bypass the cleared environment of sandbox.ts and CODEX_BLOCKED_ENV of
 * codex.ts. So no Codex process is started while the file exists in any form.
 *
 * lstat only: the file is never opened, read or followed, and nothing about
 * it (its contents, its path) is returned, logged or printed. A link (even a
 * dangling one) counts as present; so does any lstat failure other than "not
 * there" (EACCES, ELOOP ...): fail closed.
 */
import { lstat } from "node:fs/promises";
import { join } from "node:path";

/** Whether $CODEX_HOME/.env exists in any form (never opened, never followed). */
export async function codexDotenvPresent(codexHome: string): Promise<boolean> {
  const info = await lstat(join(codexHome, ".env")).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" || error.code === "ENOTDIR" ? null : error));
  // unreadable (EACCES …): treated as present, fail closed
  return info !== null;
}
