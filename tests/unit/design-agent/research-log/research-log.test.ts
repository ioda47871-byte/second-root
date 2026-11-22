import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const intakeArgs = (inbox: string) => ({ repo: REPO, inbox, bundleId: ID, shop: "hoshigama", direction: "d1", iteration: 0, parentEntryId: null, now: NOW });

function freshLog(): string {
  const root = tmp("rl-log-");
  writeFileSync(
    join(root, "state.json"),
    JSON.stringify({ schema: "design_research_state_v1", current: null, shop_queue: [{ shop: "bicycle", note: "fictional test shop" }], next_action: "start", waiting_on_owner: [], updated_at: NOW }),
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
    expect(moved.current?.shop).toBe("bicycle");
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
    expect(run(["intake", ID, "--shop", "hoshigama", "--direction", "d1", "--iteration", "0"], env).status).toBe(0);
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
    expect(bad.stderr).toContain("OUT_UNSAFE");
    expect(run(["next-shop"], env).status).toBe(0);
    expect(run(["next-shop"], env).stderr).toContain("QUEUE_EMPTY");
    expect(run(["decide", ID, "--decision", "maybe", "--words", "x", "--reason", "y"], env).status).toBe(2);
  });
});

describe("the review's guards (Fresh Review 1: H1, M1-M5, L3)", () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", join(REPO, "scripts/design-research/research.ts"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const setup = () => {
    const { inbox } = fakeInbox();
    const root = freshLog();
    const env = { SR_RESEARCH_LOG_ROOT: root, SR_REVIEW_INBOX: inbox };
    expect(run(["intake", ID, "--shop", "hoshigama", "--direction", "d1", "--iteration", "0"], env).status).toBe(0);
    return { inbox, root, env };
  };
  const decide = (env: Record<string, string>, decision: string, extra: string[] = []) => run(["decide", ID, "--decision", decision, "--words", "w", "--reason", "r", ...extra], env);
  const state = (root: string) => ResearchState.parse(JSON.parse(readFileSync(join(root, "state.json"), "utf8")));

  it("H1: only listed fictional shops — intake and queue-add refuse anything else", async () => {
    const { inbox } = fakeInbox();
    await expect(entryFromInbox({ ...intakeArgs(inbox), shop: "real-bakery" })).rejects.toThrow("SHOP_NOT_FICTIONAL");
    await expect(entryFromInbox({ ...intakeArgs(inbox), shop: "constructor" })).rejects.toThrow("SHOP_NOT_FICTIONAL");
    const root = freshLog();
    const env = { SR_RESEARCH_LOG_ROOT: root, SR_REVIEW_INBOX: inbox };
    const r = run(["intake", ID, "--shop", "some-real-shop", "--direction", "d1", "--iteration", "0"], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("SHOP_NOT_FICTIONAL");
    expect(readdirSync(root)).toEqual(["state.json"]);
    expect(run(["queue-add", "some-real-shop", "--note", "x"], env).stderr).toContain("SHOP_NOT_FICTIONAL");
  });

  it("M1 + L3: decide only on the current entry; intake needs a consistent parent", () => {
    const { env, root } = setup();
    writeFileSync(join(root, "state.json"), JSON.stringify({ ...state(root), current: { ...state(root).current, shop: "bicycle" } }));
    expect(decide(env, "revise").stderr).toContain("SHOP_NOT_CURRENT");
    expect(readdirSync(root)).not.toContain("decisions");
    const r = run(["intake", "other-run-01", "--shop", "hoshigama", "--direction", "d2", "--iteration", "1"], env);
    expect(r.stderr).toMatch(/SHOP_NOT_CURRENT|PARENT_MISMATCH|INTAKE_NO_PREVIEWS/);
  });

  it("M2: a brief that does not exist is refused; M3: reject closes the shop", () => {
    const { env, root } = setup();
    expect(decide(env, "revise", ["--brief", "briefs/missing.md"]).stderr).toContain("BRIEF_MISSING");
    expect(decide(env, "reject").status).toBe(0);
    expect(state(root).current?.phase).toBe("closed");
    expect(state(root).next_action).toMatch(/rejected/);
  });

  it("M4: 次の店へ refuses an undecided shop unless forced, and keeps a trail", () => {
    const { env, root } = setup();
    expect(run(["next-shop"], env).stderr).toContain("CURRENT_UNDECIDED");
    expect(run(["next-shop", "--force-close"], env).status).toBe(0);
    const s = state(root);
    expect(s.current?.shop).toBe("bicycle");
    expect(s.closed_shops).toEqual([expect.objectContaining({ shop: "hoshigama", entry_id: ID, phase: "awaiting_owner_review" })]);
  });

  it("M5: the review page goes only under the temp directory, never through a symlink", () => {
    const { env } = setup();
    const t = tmp("rl-link-");
    symlinkSync(REPO, join(t, "repo-link"));
    const viaLink = run(["review-page", ID, "--out", join(t, "repo-link", "tmp-review-page")], env);
    expect(viaLink.status).toBe(2);
    expect(viaLink.stderr).toContain("OUT_UNSAFE");
    expect(existsSync(join(REPO, "tmp-review-page"))).toBe(false);
    const out = join(tmp("rl-imglink-"), "page");
    mkdirSync(out);
    symlinkSync(tmp("rl-elsewhere-"), join(out, "img"));
    expect(run(["review-page", ID, "--out", out], env).stderr).toContain("OUT_UNSAFE");
    expect(run(["review-page", ID, "--out", "/home"], env).stderr).toContain("OUT_UNSAFE");
  });

  it("final-head Lows: a symlink at img/<file> or index.html is refused; a bad state is a coded refusal", () => {
    const { env, root } = setup();
    const out = join(tmp("rl-files-"), "p");
    mkdirSync(join(out, "img"), { recursive: true });
    symlinkSync(join(tmp("rl-target-"), "x.png"), join(out, "img", "pc-1.png"));
    expect(run(["review-page", ID, "--out", out], env).stderr).toContain("OUT_UNSAFE");
    const out2 = join(tmp("rl-files2-"), "p");
    mkdirSync(out2);
    symlinkSync(join(tmp("rl-target2-"), "i.html"), join(out2, "index.html"));
    expect(run(["review-page", ID, "--out", out2], env).stderr).toContain("OUT_UNSAFE");
    const r = run(["decide", ID, "--decision", "revise", "--words", "w", "--reason", "r", "--next", "x".repeat(401)], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("STATE_INVALID");
    expect(readdirSync(root)).not.toContain("decisions");
  });

  it("L2: bad notes are a refusal with a code, not a stack trace", () => {
    const { env } = setup();
    const notes = join(tmp("rl-notes-"), "n.json");
    writeFileSync(notes, "{not json");
    const r = run(["review-page", ID, "--out", join(tmp("rl-p-"), "p"), "--notes", notes], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("NOTES_INVALID");
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

describe("inbox-scan (read-only): delivered runs the log has not recorded yet", () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", join(REPO, "scripts/design-research/research.ts"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

  it("lists an unrecorded run with the suggested intake (an improved version continues the current entry), and changes nothing", () => {
    const { inbox } = fakeInbox();
    const root = freshLog();
    const env = { SR_RESEARCH_LOG_ROOT: root, SR_REVIEW_INBOX: inbox };
    // nothing recorded yet: the fake run is listed as a first version
    const first = run(["inbox-scan"], env);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout.trim())).toEqual({ bundle_id: ID, previews: true, audit: true, share: false, suggest: { shop: "fakeshop", direction: "d1", iteration: 0, parent: null } });
    // once recorded it is not listed again
    expect(run(["intake", ID, "--shop", "hoshigama", "--direction", "d1", "--iteration", "0"], env).status).toBe(0);
    expect(run(["inbox-scan"], env).stdout).toBe("");
    // an improved version (another direction, same shop as the current entry) is suggested with its parent
    const d2 = "hoshigama-imagefirst-d4-20261122-01";
    mkdirSync(join(inbox, "previews", d2), { recursive: true });
    writeFileSync(join(inbox, "previews", d2, "INDEX.json"), "{}");
    mkdirSync(join(inbox, "runs"), { recursive: true });
    writeFileSync(join(inbox, "runs", `${d2}.share.txt`), "share: approval=x\n");
    const before = readdirSync(root, { recursive: true }).map(String).sort();
    const next = run(["inbox-scan"], env);
    expect(JSON.parse(next.stdout.trim())).toEqual({ bundle_id: d2, previews: true, audit: false, share: true, suggest: { shop: "hoshigama", direction: "d4", iteration: 1, parent: ID } });
    expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before);
  });

  it("ignores names that are not run ids", () => {
    const { inbox } = fakeInbox();
    mkdirSync(join(inbox, "previews", "not-a-run"), { recursive: true });
    mkdirSync(join(inbox, "previews", "../x"), { recursive: true });
    const r = run(["inbox-scan"], { SR_RESEARCH_LOG_ROOT: freshLog(), SR_REVIEW_INBOX: inbox });
    expect(r.stdout.trim().split("\n").map((l) => JSON.parse(l).bundle_id)).toEqual([ID]);
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
