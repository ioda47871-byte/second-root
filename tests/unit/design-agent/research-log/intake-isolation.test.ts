import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// PR #366 review Low 3: the research-log intake reads the review inbox and verifies the sealed bundle; it starts no
// process, opens no connection and reaches no model. A restricting check only (no exact import list is pinned here).

const REPO = resolve(__dirname, "../../../..");
const FILE = "lib/design-agent/research-log/intake.ts";

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|(?<!@)\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}

describe("research-log intake: no process, network or model", () => {
  const source = readFileSync(resolve(REPO, FILE), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports no process, network or model module", () => {
    const banned = /^(?:node:)?(?:child_process|net|http|https|http2|dns|tls|dgram|worker_threads|cluster)$|bounded-process|\/codex$|claude-cli|claude-audit|image-once|\/sandbox$|phase2f-live|anthropic|openai|playwright/;
    expect(specifiers(source).filter((s) => banned.test(s))).toEqual([]);
  });

  it("calls no process, connection or model", () => {
    expect(code).not.toMatch(/\bfetch\(|spawn|execFile|exec\(|runBounded|runCodex|generateImage|runClaudeAudit|new WebSocket|XMLHttpRequest/);
  });
});
