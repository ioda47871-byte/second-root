// TESTS ONLY. A CodexSandbox that runs the (fake) Codex directly, so the
// fake CLI's behaviour tests can read their step files. It gives no
// isolation at all; production code always uses prepareCodexSandbox
// (lib/design-agent/sandbox.ts), and a guardrail test checks that nothing
// outside tests/ imports this file. The isolation itself is tested against
// real bubblewrap in tests/unit/design-agent/sandbox.test.ts.
import { runBounded } from "@/lib/design-agent/bounded-process";
import { codexEnvironment } from "@/lib/design-agent/codex";
import type { CodexSandbox } from "@/lib/design-agent/sandbox";

export function passthroughSandbox(codexBin: string, env: Record<string, string | undefined>): CodexSandbox {
  const childEnv = codexEnvironment(env);
  return {
    env: { HOME: env.HOME ?? "/nonexistent", ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}) },
    run: (args, o) => runBounded(codexBin, args, { cwd: o.workDir, env: childEnv, timeoutMs: o.timeoutMs, ...(o.input === undefined ? {} : { input: o.input }) }),
  };
}
