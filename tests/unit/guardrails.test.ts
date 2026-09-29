import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Static guardrails from docs/SECURITY.md that can be enforced before the
// Sales Agent code exists, so later tasks cannot quietly regress them.

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const sourceFiles = trackedFiles.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && !f.startsWith("tests/"));

// Directories where Claude-collected text will be rendered or handled.
const SALES_AGENT_DIRS = ["app/admin/", "app/demo/", "app/api/internal/", "app/api/webhooks/", "lib/sales/", "lib/supabase/", "lib/instagram/", "components/admin/"];

describe("guardrails", () => {
  it("only imports Resend from the contact form route (no cold sales email via Resend)", () => {
    const importers = sourceFiles.filter((f) => /from\s+["']resend["']|(require|import)\(\s*["']resend["']\s*\)/.test(readFileSync(f, "utf8")));
    expect(importers).toEqual(["app/api/contact/route.ts"]);
  });

  it("never uses dangerouslySetInnerHTML in Sales Agent code", () => {
    const offenders = sourceFiles
      .filter((f) => SALES_AGENT_DIRS.some((d) => f.startsWith(d)))
      .filter((f) => readFileSync(f, "utf8").includes("dangerouslySetInnerHTML"));
    expect(offenders).toEqual([]);
  });

  it("keeps the service-role client and ingest logic out of client components", () => {
    const offenders = sourceFiles
      .filter((f) => /^\s*["']use client["']/m.test(readFileSync(f, "utf8")))
      .filter((f) => /lib\/supabase\/service|lib\/sales\/ingest|lib\/instagram\/signature|SUPABASE_SERVICE_ROLE_KEY|SALES_AGENT_INGEST_TOKEN|lib\/instagram\/graph|lib\/instagram\/reply|INSTAGRAM_APP_SECRET|INSTAGRAM_WEBHOOK_VERIFY_TOKEN|INSTAGRAM_ACCESS_TOKEN/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    for (const f of ["lib/supabase/service.ts", "lib/sales/ingest.ts", "lib/instagram/signature.ts", "lib/instagram/graph.ts", "lib/instagram/reply.ts"]) {
      if (trackedFiles.includes(f)) expect(readFileSync(f, "utf8")).toMatch(/^import "server-only";/m);
    }
  });

  it("never fetches URLs from ingest or webhook code (no SSRF path)", () => {
    const ingestFiles = sourceFiles.filter((f) => ["app/api/internal/", "app/api/webhooks/", "lib/sales/", "lib/instagram/"].some((d) => f.startsWith(d)));
    // The one exception: lib/instagram/graph.ts calls the fixed official Graph API host.
    const offenders = ingestFiles
      .filter((f) => f !== "lib/instagram/graph.ts")
      .filter((f) => /\bfetch\s*\(|axios|node:https?|from ["']https?["']|undici/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    const graph = readFileSync("lib/instagram/graph.ts", "utf8");
    expect(graph).toMatch(/export const GRAPH_BASE = "https:\/\/graph\.instagram\.com\/v\d+\.0";/);
    for (const call of graph.match(/fetch\s*\(([^,]+),/g) ?? []) expect(call).toMatch(/fetch\(`\$\{GRAPH_BASE\}\//);
  });

  it("keeps the Codex CLI out of the web app and never uses an OpenAI API key (DEV-028)", () => {
    // The design agent runs only as a local CLI on the WSL design user.
    const webFiles = sourceFiles.filter((f) => f.startsWith("app/") || f.startsWith("components/") || f.startsWith("lib/sales/") || f.startsWith("lib/admin/"));
    const importers = webFiles.filter((f) => /lib\/design-agent\/(codex|pipeline|bounded-process)/.test(readFileSync(f, "utf8")));
    expect(importers).toEqual([]);
    // OpenAI key variables appear only in the lists that strip them from Codex's environment.
    const KEY = /\b(OPENAI_API_KEY|CODEX_API_KEY)\b/;
    const mentions = sourceFiles.filter((f) => KEY.test(readFileSync(f, "utf8")));
    expect(mentions).toEqual(["lib/design-agent/codex.ts"]);
    for (const f of mentions) {
      for (const line of readFileSync(f, "utf8").split("\n").filter((l) => KEY.test(l))) {
        expect(line, f).toMatch(/CODEX_BLOCKED_ENV = \[|^\s*\*/);
      }
    }
  });

  it("does not track env files other than the example", () => {
    const envFiles = trackedFiles.filter((f) => /(^|\/)\.env/.test(f));
    expect(envFiles).toEqual([".env.local.example"]);
  });
});
