import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { entryFromInbox } from "@/lib/design-agent/research-log/intake";
import { reviewPage } from "@/lib/design-agent/research-log/review-page";
import { OwnerDecision, ResearchEntry, ResearchState } from "@/lib/design-agent/research-log/schema";
import { advanceToNextShop, currentDecision, listDecisions, listEntries, LogStop, readState, resumeSummary, writeDecision, writeEntry, writeState } from "@/lib/design-agent/research-log/store";

// Issue #302 P5: the design research log. Temporary directories and synthetic bytes only; no model, no network.
vi.setConfig({ testTimeout: 60_000 });

const REPO = resolve(__dirname, "../../../..");
const temps: string[] = [];
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  temps.push(d);
  return d;
};
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const NOW = "2026-11-21T15:00:00.000Z";
const ID = "fakeshop-imagefirst-d1-20261121-01";
const C40 = "a".repeat(40);

/** A fake review inbox: two "previews" (arbitrary bytes), INDEX.json and a matching audit.json. */
function fakeInbox(o: { auditBundleSha?: string } = {}) {
  const inbox = tmp("rl-inbox-");
  const pdir = join(inbox, "previews", ID);
  mkdirSync(pdir, { recursive: true });
  const files = { "pc-1.png": Buffer.from("pc preview bytes"), "sp-1.png": Buffer.from("sp preview bytes") };
  for (const [f, b] of Object.entries(files)) writeFileSync(join(pdir, f), b);
  const bundleSha = sha("bundle");
  const index = {
    schema: "imagefirst_review_previews_v1",
    bundle_id: ID,
    bundle_sha256: bundleSha,
    approval_id: ID,
    plan_id: "fakeshop-imagefirst-p1-20261121",
    commit: C40,
    limits: { max_side: 1568, max_bytes: 1 },
    previews: Object.entries(files).map(([f, b]) => ({ file: f, kind: "full", source: `parts/${f}`, source_sha256: sha(`src ${f}`), preview_sha256: sha(b), width: 10, height: 20, bytes: b.length })),
  };
  const indexBytes = `${JSON.stringify(index, null, 2)}\n`;
  writeFileSync(join(pdir, "INDEX.json"), indexBytes);
  const vp = (total: number) => ({ total, lowest: 3, low_criteria: ["structure"], low_checks: [], hard_fail_hits: [], verdict: "revise" });
  const audit = {
    schema: "imagefirst_claude_audit_v2",
    status: "completed",
    binding: { approval_id: ID, bundle_id: ID, bundle_sha256: o.auditBundleSha ?? bundleSha, plan_id: index.plan_id, commit: C40, previews_index_sha256: sha(indexBytes), rubric_version: "if-claude-audit-v2", rubric_sha256: sha("rubric") },
    derived: { desktop_1440: vp(18), mobile_390: vp(19), verdict: "revise" },
    advisory_only: true,
    human_confirmed: false,
  };
  mkdirSync(join(inbox, "audits", ID), { recursive: true });
  writeFileSync(join(inbox, "audits", ID, "audit.json"), JSON.stringify(audit));
  return { inbox, pdir };
}

const intakeArgs = (inbox: string) => ({ inbox, bundleId: ID, shop: "fakeshop", direction: "d1", iteration: 0, parentEntryId: null, now: NOW });

function freshLog(): string {
  const root = tmp("rl-log-");
  writeFileSync(
    join(root, "state.json"),
    JSON.stringify({ schema: "design_research_state_v1", current: null, shop_queue: [{ shop: "nextshop", note: "fictional test shop" }], next_action: "start", waiting_on_owner: [], updated_at: NOW }),
  );
  return root;
}

describe("intake from the review inbox", () => {
  it("records SHA-256s, IDs and audit numbers, and checks every preview against INDEX.json", async () => {
    const { inbox } = fakeInbox();
    const e = await entryFromInbox(intakeArgs(inbox));
    expect(ResearchEntry.parse(e)).toEqual(e);
    expect(e.provenance.previews.map((p) => [p.file, p.viewport])).toEqual([
      ["pc-1.png", "desktop_1440"],
      ["sp-1.png", "mobile_390"],
    ]);
    expect(e.audit?.viewports.desktop_1440.total).toBe(18);
    expect(JSON.stringify(e)).not.toMatch(/preview bytes/);
  });

  it("refuses a preview whose bytes changed after INDEX.json", async () => {
    const { inbox, pdir } = fakeInbox();
    writeFileSync(join(pdir, "sp-1.png"), "swapped");
    await expect(entryFromInbox(intakeArgs(inbox))).rejects.toThrow("INTAKE_PREVIEW_MISMATCH");
  });

  it("refuses an audit made for other bytes", async () => {
    const { inbox } = fakeInbox({ auditBundleSha: sha("another bundle") });
    await expect(entryFromInbox(intakeArgs(inbox))).rejects.toThrow("INTAKE_AUDIT_BINDING");
  });

  it("refuses an id that is not a slug (no path walking)", async () => {
    const { inbox } = fakeInbox();
    await expect(entryFromInbox({ ...intakeArgs(inbox), bundleId: "../x" })).rejects.toThrow("INTAKE_ID_INVALID");
  });
});

describe("the log store", () => {
  it("writes entries once, appends decisions with increasing seq, and the latest decision stands", async () => {
    const root = freshLog();
    const e = await entryFromInbox(intakeArgs(fakeInbox().inbox));
    await writeEntry(root, e);
    await expect(writeEntry(root, e)).rejects.toThrow("LOG_ALREADY_WRITTEN");
    const base = { entry_id: ID, owner_words: "改善して", keep: ["hero"], improve: ["info"], reasons: ["no labels"], decided_at: NOW };
    expect((await writeDecision(root, { ...base, decision: "revise" })).seq).toBe(1);
    expect((await writeDecision(root, { ...base, decision: "adopt" })).seq).toBe(2);
    expect((await currentDecision(root, ID))?.decision).toBe("adopt");
    expect((await listDecisions(root)).length).toBe(2);
    expect((await listEntries(root)).map((x) => x.entry_id)).toEqual([ID]);
    expect(await resumeSummary(root)).toContain("owner: adopt");
  });

  it("refuses a decision for an unknown entry, and a real shop", async () => {
    const root = freshLog();
    await expect(writeDecision(root, { entry_id: "nope-1", decision: "revise", owner_words: "x", keep: [], improve: [], reasons: ["r"], decided_at: NOW })).rejects.toThrow("ENTRY_UNREADABLE");
    const e = await entryFromInbox(intakeArgs(fakeInbox().inbox));
    await expect(writeEntry(root, { ...e, fictional: false })).rejects.toThrow("ENTRY_INVALID");
  });

  it("stops on a hand-edited state instead of trusting it", async () => {
    const root = freshLog();
    writeFileSync(join(root, "state.json"), '{"schema":"design_research_state_v1"}');
    await expect(readState(root)).rejects.toThrow("STATE_UNREADABLE");
    await expect(writeState(root, { schema: "design_research_state_v1" })).rejects.toThrow("STATE_INVALID");
  });

  it("次の店へ takes the first queued shop, and refuses an empty queue", async () => {
    const s = await readState(freshLog());
    const moved = advanceToNextShop(s, NOW);
    expect(moved.current?.shop).toBe("nextshop");
    expect(moved.shop_queue).toEqual([]);
    expect(() => advanceToNextShop(moved, NOW)).toThrow(LogStop);
  });
});

describe("the review page", () => {
  it("escapes text and lists only the recorded previews", async () => {
    const e = await entryFromInbox(intakeArgs(fakeInbox().inbox));
    const { html, files } = reviewPage(e, { keep: ["<b>bold</b>"], weak: [], next: [] }, null);
    expect(files).toEqual(["pc-1.png", "sp-1.png"]);
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<script");
    expect(html).toContain('src="img/sp-1.png"');
  });
});

describe("the CLI", () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", join(REPO, "scripts/design-research/research.ts"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

  it("intake → decide → status → review-page → next-shop, and refuses a review page inside the repository", () => {
    const { inbox } = fakeInbox();
    const root = freshLog();
    const env = { SR_RESEARCH_LOG_ROOT: root, SR_REVIEW_INBOX: inbox };
    expect(run(["intake", ID, "--shop", "fakeshop", "--direction", "d1", "--iteration", "0"], env).status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "state.json"), "utf8")).current.phase).toBe("awaiting_owner_review");
    const d = run(["decide", ID, "--decision", "revise", "--words", "改善して", "--reason", "情報に見出しが無い", "--keep", "Hero"], env);
    expect(d.status, d.stderr).toBe(0);
    expect(ResearchState.parse(JSON.parse(readFileSync(join(root, "state.json"), "utf8"))).current?.phase).toBe("improving");
    expect(run(["status"], env).stdout).toContain("owner: revise");
    const out = tmp("rl-page-");
    expect(run(["review-page", ID, "--out", out], env).status).toBe(0);
    expect(readdirSync(join(out, "img")).sort()).toEqual(["pc-1.png", "sp-1.png"]);
    const bad = run(["review-page", ID, "--out", join(REPO, "tmp-review")], env);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("OUT_IN_REPO");
    expect(run(["next-shop"], env).status).toBe(0);
    expect(run(["next-shop"], env).stderr).toContain("QUEUE_EMPTY");
    expect(run(["decide", ID, "--decision", "maybe", "--words", "x", "--reason", "y"], env).status).toBe(2);
  });
});

describe("status is read-only (it is allowed without a prompt)", () => {
  const snapshot = (dir: string) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const p = join(d.parentPath, d.name);
        return `${p} ${sha(readFileSync(p))}`;
      })
      .sort();

  it("changes no file in the log or the inbox, and prints only the summary", async () => {
    const { inbox } = fakeInbox();
    const root = freshLog();
    await writeEntry(root, await entryFromInbox(intakeArgs(inbox)));
    const before = [...snapshot(root), ...snapshot(inbox)];
    const r = spawnSync(process.execPath, ["--import", "tsx", join(REPO, "scripts/design-research/research.ts"), "status"], {
      encoding: "utf8",
      env: { ...process.env, SR_RESEARCH_LOG_ROOT: root, SR_REVIEW_INBOX: inbox },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^# Design research — resume/);
    expect([...snapshot(root), ...snapshot(inbox)]).toEqual(before);
  });

  it("the status path imports no writer: resumeSummary only reads", () => {
    const src = readFileSync(join(REPO, "lib/design-agent/research-log/store.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function resumeSummary"));
    expect(body).not.toMatch(/writeFile|writeOnce|rename|mkdir|open\(/);
  });
});

describe("the committed log (design-library/research-log)", () => {
  const LOG = join(REPO, "design-library/research-log");
  it("parses, holds no pictures, and every decision belongs to an entry", async () => {
    const all = readdirSync(LOG, { recursive: true }).map(String);
    expect(all.filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))).toEqual([]);
    const entries = await listEntries(LOG);
    const ids = new Set(entries.map((e) => e.entry_id));
    for (const d of await listDecisions(LOG)) {
      expect(OwnerDecision.parse(d)).toEqual(d);
      expect(ids.has(d.entry_id)).toBe(true);
    }
    const s = await readState(LOG);
    if (s.current?.entry_id) expect(ids.has(s.current.entry_id)).toBe(true);
    if (s.current?.brief) expect(all).toContain(s.current.brief);
  });
});
