import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

  it("keeps real shop data out of the repository (DEV-028 worker)", () => {
    // Known prospect names and addresses, as sha256 of the lowercased token
    // (so this test does not itself carry them). Jobs, facts and Instagram
    // URLs live only in ~/sr-design-jobs on the worker user.
    const DENY = new Set([
      "8e4002280dafe2856db1267e2cee2035abe3b0c961c0157982c7d4a7b69d3722",
      "7e25d772e6f67ed911aea9ce447c868709988ef2e68a3030306957649339f561",
      "06e09e58fb3e7372dc0dd89fbab5b12143c02bb55d16e074951f842d027561e3",
      "a6e7ab4d6c0a10b1f8f6f0a4fab77a8cb0c5e7a3c3565957af55cb73f32ae4ea",
    ]);
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    const textFiles = trackedFiles.filter((f) => /\.(ts|tsx|js|mjs|cjs|json|md|css|sh|yml|yaml|sql|html|txt)$/.test(f));
    const hits: string[] = [];
    for (const f of textFiles) {
      const text = readFileSync(f, "utf8");
      const tokens = [...(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []), ...(text.match(/[\u3040-\u9fff]+[0-9]+(?:-[0-9]+){1,2}/g) ?? [])];
      if (tokens.some((t) => DENY.has(sha(t)))) hits.push(f);
      // In the design agent / worker: Instagram profile URLs are placeholders or fictional test accounts only.
      if (!/^(lib\/design-agent|scripts\/sales-design|tests\/unit\/design-agent|docs\/operations\/design-)/.test(f)) continue;
      for (const m of text.matchAll(/(?<![\w.-])(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/g)) {
        if (!/^(example|example_shop|example\.shop|few_posts|iframe_shop|popup_shop|error_shop|short_grid|stripes_shop|hop_shop|wall_shop|login_redirect|redirect_shop|jsnav_shop|private_shop|rate_shop|empty_shop|x|exa|\.example|p|reel|explore|accounts)$/.test(m[1]!)) hits.push(`${f}: instagram.com/${m[1]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("lets the design worker open only public Instagram profile URLs (DEV-028 worker)", () => {
    // The production entry never injects a capture target; only tests do.
    const entry = readFileSync("scripts/sales-design-worker/worker.ts", "utf8");
    expect(entry).not.toMatch(/captureTargetFor|allowNavigation/);
    const run = readFileSync("lib/design-agent/worker/run.ts", "utf8");
    expect(run).toContain("options.captureTargetFor ? options.captureTargetFor(source) : instagramTarget(source)");
    expect(run).toMatch(/const source = parseInstagramProfileUrl\(job\.source\.instagram_url\);\n\s*if \(!source\) return fail\("SOURCE_URL_INVALID"\);/);
    // The web app never imports the worker.
    const webFiles = sourceFiles.filter((f) => f.startsWith("app/") || f.startsWith("components/") || f.startsWith("lib/sales/") || f.startsWith("lib/admin/"));
    expect(webFiles.filter((f) => /lib\/design-agent\/worker\//.test(readFileSync(f, "utf8")))).toEqual([]);
    // No git push / PR / commit from the worker.
    const workerCode = [entry, run, ...trackedFiles.filter((f) => f.startsWith("lib/design-agent/worker/")).map((f) => readFileSync(f, "utf8"))].join("\n");
    expect(workerCode).not.toMatch(/["']push["']|["']commit["']|api\.github\.com|createPull/);
  });

  it("does not track env files other than the example", () => {
    const envFiles = trackedFiles.filter((f) => /(^|\/)\.env/.test(f));
    expect(envFiles).toEqual([".env.local.example"]);
  });
});
