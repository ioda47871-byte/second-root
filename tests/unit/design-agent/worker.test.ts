import { spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireLock, currentHolder, LOCK_STALE_MS } from "@/lib/design-agent/worker/state";
import { cleanStaleTemp } from "@/lib/design-agent/worker/temp";
import { AMERICAN_EDITORIAL, review } from "./fixtures";
import { allText, codexCalls, LEAK, makeLayout, PNG, runWorker, startMockSite, WORKER_SHA, writeJob, type Layout, type MockSite } from "./worker-support";

// The design worker end to end with a real headless Chromium against a local
// mock of a public profile page, the fake Codex CLI and a fake preview
// renderer. No network, no real shop, no real Codex.

vi.setConfig({ testTimeout: 90_000 });

let site: MockSite;
beforeAll(async () => {
  site = await startMockSite();
});
afterAll(() => {
  site.server.close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads of JSON records
const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const execCalls = (l: Layout) => codexCalls(l).filter((c) => c.args[0] === "exec");

describe("a normal run", () => {
  it("captures, designs, reviews, records, copies the allowlist to Windows and deletes the screenshots", async () => {
    const l = makeLayout();
    writeJob(l, "job-001");
    const { report, logs, preview } = await runWorker(l, site);

    expect(report, JSON.stringify({ report, logs })).toMatchObject({ status: "finished", workerSha: WORKER_SHA, jobs: [{ jobId: "job-001", status: "done", outcome: "done", windowsCopy: "success" }] });
    expect(ls(join(l.queue, "done"))).toEqual(["job-001.json", "job-001.result.json"]);
    expect(ls(join(l.queue, "processing"))).toEqual([]);
    expect(ls(join(l.queue, "inbox"))).toEqual([]);

    const runDir = join(l.out, "job-001");
    const rep = json(join(runDir, "report.json"));
    expect(rep).toMatchObject({
      job_id: "job-001",
      worker: { commit: WORKER_SHA },
      outcome: "done",
      instagram: { status: "captured", temp_deleted: true },
      codex: { status: "done", direction: "american_editorial", reviews: 1, fallback: false, blocked: false, renderer_change_needed: false },
      windows_copy: "success",
    });
    expect(rep.instagram.images).toBeGreaterThanOrEqual(2);
    // the screenshots existed while Codex worked, and are gone now
    expect(preview.refsSeen.every((n) => n >= 2)).toBe(true);
    expect(ls(l.tmp)).toEqual([]);
    expect(allText(runDir)).not.toContain("profile.png");
    // Windows gets only the allowlist
    expect(ls(join(l.exportDir, "job-001"))).toEqual([
      "after-desktop.png",
      "after-mobile.png",
      "before-desktop.png",
      "before-mobile.png",
      "final.json",
      "report.json",
      "review-candidate-0.json",
    ]);
    // Codex got the screenshots and the current demo, and no key of any kind
    const [brief] = execCalls(l);
    expect(brief!.args.filter((a) => a.startsWith("--image=")).length).toBe(rep.instagram.images + 2);
    for (const call of codexCalls(l)) {
      expect(call.secretVars).toEqual([]);
      expect(call.apiKeyVars).toEqual([]);
      expect(call.tmpdir).toMatch(/sr-design-worker-/);
    }
    // the source URL never appears in the log
    expect(logs.join("\n")).not.toMatch(/instagram\.com|example_shop|127\.0\.0\.1/);
    // the CLI's session log of these calls (it can hold the images) is gone; others stay
    const sessions = join(l.root, "codex-home", "sessions", "2026", "09", "29");
    expect(ls(sessions)).toEqual(["rollout-2026-09-29T09-00-00-11111111-1111-4111-8111-111111111111.jsonl"]);
    expect(rep.instagram.media_softened).toBeGreaterThan(0);
    // run directories are private
    expect(statSync(runDir).mode & 0o077).toBe(0);
    expect(statSync(join(runDir, "report.json")).mode & 0o077).toBe(0);
  });

  it("removes leftover design-agent Codex session logs from a stopped run, and no other sessions", async () => {
    const l = makeLayout();
    const day = join(l.root, "codex-home", "sessions", "2026", "09", "28");
    mkdirSync(day, { recursive: true });
    const meta = (cwd: string) => JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n{}\n";
    writeFileSync(join(day, "rollout-2026-09-28T01-00-00-22222222-2222-4222-8222-222222222222.jsonl"), meta("/tmp/sr-design-worker-abc123/sr-design-codex-def456"));
    writeFileSync(join(day, "rollout-2026-09-28T02-00-00-33333333-3333-4333-8333-333333333333.jsonl"), meta("/home/someone/project"));
    // a session elsewhere whose instructions merely mention a worker path stays
    writeFileSync(
      join(day, "rollout-2026-09-28T03-00-00-44444444-4444-4444-8444-444444444444.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { cwd: "/home/someone/project", instructions: "see /tmp/sr-design-worker-abc123/ for notes" } }) + "\n",
    );
    const { logs } = await runWorker(l, site);
    expect(ls(day)).toEqual([
      "rollout-2026-09-28T02-00-00-33333333-3333-4333-8333-333333333333.jsonl",
      "rollout-2026-09-28T03-00-00-44444444-4444-4444-8444-444444444444.jsonl",
    ]);
    expect(logs.join("\n")).toContain("removed 1 leftover Codex session log");
  });

  it("follows a redirect that stays on the allowed site", async () => {
    const l = makeLayout();
    writeJob(l, "job-hop", "https://www.instagram.com/hop_shop/");
    const { report } = await runWorker(l, site);
    expect(report, "report").toMatchObject({ status: "finished", jobs: [{ status: "done", outcome: "done" }] });
  });

  it("blocks an off-site frame inside the page without ending the capture", async () => {
    const l = makeLayout();
    writeJob(l, "job-iframe", "https://www.instagram.com/iframe_shop/");
    const before = site.requests.length;
    const { report } = await runWorker(l, site);
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "done" }] });
    expect(site.requests.slice(before).some((r) => r.includes("/elsewhere/"))).toBe(false);
  });

  it("blocks a popup without ending the capture or crashing", async () => {
    const l = makeLayout();
    writeJob(l, "job-popup", "https://www.instagram.com/popup_shop/");
    const before = site.requests.length;
    const { report } = await runWorker(l, site);
    expect(report, "report").toMatchObject({ status: "finished", jobs: [{ status: "done", outcome: "done" }] });
    expect(site.requests.slice(before).some((r) => r.includes("/elsewhere/"))).toBe(false);
  });

  it("keeps the first screens of a short grid", async () => {
    const l = makeLayout();
    writeJob(l, "job-short", "https://www.instagram.com/short_grid/");
    const { report } = await runWorker(l, site);
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "done" }] });
    expect(json(join(l.out, "job-short", "report.json")).instagram.images).toBeGreaterThanOrEqual(1);
  });

  it("uses a profile header with few posts (no second grid screen)", async () => {
    const l = makeLayout();
    writeJob(l, "job-few", "https://www.instagram.com/few_posts/");
    await runWorker(l, site);
    expect(json(join(l.out, "job-few", "report.json")).instagram.images).toBe(2);
  });
});

describe("PUBLIC_SOURCE_UNAVAILABLE is an expected outcome", () => {
  it.each([
    ["login wall", "wall_shop", "LOGIN_WALL"],
    ["redirect to the login page", "login_redirect", "LOGIN_WALL"],
    ["redirect off the site", "redirect_shop", "OFF_SITE_REDIRECT"],
    ["script navigation off the site", "jsnav_shop", "OFF_SITE_REDIRECT"],
    ["private or missing account", "private_shop", "PRIVATE_OR_MISSING"],
    ["rate limit", "rate_shop", "RATE_LIMITED"],
    ["empty page", "empty_shop", "EMPTY_PAGE"],
  ])("%s", async (_label, username, reason) => {
    const l = makeLayout();
    writeJob(l, `job-${username.replace(/_/g, "-")}`, `https://www.instagram.com/${username}/`);
    const before = site.requests.length;
    const { report, preview } = await runWorker(l, site);
    const jobId = `job-${username.replace(/_/g, "-")}`;
    expect(report, "report").toMatchObject({ status: "finished", jobs: [{ jobId, status: "done", outcome: "PUBLIC_SOURCE_UNAVAILABLE" }] });
    const rep = json(join(l.out, jobId, "report.json"));
    expect(rep).toMatchObject({ outcome: "PUBLIC_SOURCE_UNAVAILABLE", instagram: { status: "unavailable", reason, images: 0, temp_deleted: true }, codex: null });
    // Codex was never asked and nothing was rendered
    expect(execCalls(l)).toEqual([]);
    expect(preview.renders).toEqual([]);
    expect(ls(l.tmp)).toEqual([]);
    // an off-site page is never fetched
    expect(site.requests.slice(before).some((r) => r.includes("/elsewhere/"))).toBe(false);
    expect(ls(join(l.exportDir, jobId))).toEqual(["report.json"]);
  });
});

describe("transient capture failures are retried, not recorded as unavailable", () => {
  it.each([
    ["a 5xx page", "https://www.instagram.com/error_shop/", undefined],
    ["a network error", "https://www.instagram.com/example_shop/", "http://127.0.0.1:1"],
  ])("%s", async (_label, url, origin) => {
    const l = makeLayout();
    writeJob(l, "job-transient", url);
    const target = origin ? { captureTargetFor: () => ({ url: `${origin}/x/`, allowNavigation: (u: string) => u.startsWith(`${origin}/`) }) } : {};
    const first = await runWorker(l, site, target);
    expect(first.report, "report").toMatchObject({ jobs: [{ status: "retry", code: "SOURCE_CAPTURE_FAILED" }] });
    expect(ls(join(l.queue, "inbox"))).toEqual(["job-transient.json"]);
    expect(existsSync(join(l.out, "job-transient"))).toBe(false);
    expect(execCalls(l)).toEqual([]);
    const second = await runWorker(l, site, target);
    expect(second.report, "report").toMatchObject({ jobs: [{ status: "failed", code: "WORKER_JOB_FAILED" }] });
    expect(ls(l.tmp)).toEqual([]);
  });
});

describe("invalid jobs", () => {
  it.each([
    ["an arbitrary URL", "https://example.com/example_shop/"],
    ["localhost", "https://localhost/example_shop/"],
    ["an IP address", "https://127.0.0.1/example_shop/"],
    ["http", "http://www.instagram.com/example_shop/"],
    ["credentials", "https://a:b@www.instagram.com/example_shop/"],
    ["a post URL", "https://www.instagram.com/p/ABC/"],
  ])("refuses %s before any browser starts", async (_label, url) => {
    const l = makeLayout();
    writeJob(l, "job-bad-url", url);
    const before = site.requests.length;
    const { report } = await runWorker(l, site);
    expect(report, "report").toMatchObject({ status: "finished", jobs: [{ status: "failed", code: "SOURCE_URL_INVALID" }] });
    expect(site.requests.length).toBe(before);
    expect(ls(join(l.queue, "failed"))).toEqual(["job-bad-url.json", "job-bad-url.result.json"]);
    expect(existsSync(join(l.out, "job-bad-url"))).toBe(false);
  });

  it("refuses a job file that is not a design job, and files that are not jobs", async () => {
    const l = makeLayout();
    writeFileSync(join(l.queue, "inbox", "job-broken.json"), "{not json", { mode: 0o600 });
    writeFileSync(join(l.queue, "inbox", "Weird Name.json"), "{}", { mode: 0o600 });
    const { report } = await runWorker(l, site, { maxJobs: 3 });
    expect(report, "report").toMatchObject({ status: "finished", jobs: [{ jobId: "job-broken", status: "failed", code: "JOB_INVALID" }] });
    expect(ls(join(l.queue, "failed")).some((n) => n.startsWith("invalid-"))).toBe(true);
  });

  it("refuses facts that do not pass the fact filter", async () => {
    const l = makeLayout();
    writeJob(l, "job-facts", undefined, { name: "EXAMPLE TEST", category: "not_a_category" });
    const { report } = await runWorker(l, site);
    expect(report, "report").toMatchObject({ jobs: [{ status: "failed", code: "FACTS_INVALID" }] });
  });
});

describe("design outcomes", () => {
  it("BLOCKED when the reviewer needs a renderer change (no code is changed)", async () => {
    const l = makeLayout();
    writeJob(l, "job-blocked");
    const { report } = await runWorker(l, site, { steps: [{ answer: AMERICAN_EDITORIAL }, { answer: review({ verdict: "revise", needs_renderer_change: true, renderer_change_note: LEAK.note }) }] });
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "blocked" }] });
    const rep = json(join(l.out, "job-blocked", "report.json"));
    expect(rep.codex).toMatchObject({ blocked: true, renderer_change_needed: true });
    expect(JSON.stringify(rep)).not.toContain(LEAK.note);
  });

  it("reports Codex's own low confidence when the category default is used", async () => {
    const l = makeLayout();
    writeJob(l, "job-low");
    const { report } = await runWorker(l, site, { steps: [{ answer: { ...AMERICAN_EDITORIAL, confidence: 0.3 } }, { answer: review() }] });
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "done" }] });
    expect(json(join(l.out, "job-low", "report.json")).codex).toMatchObject({ profile_source: "category_default", brief_confidence: 0.3, revisions: 0 });
  });

  it("revises the profile at most twice", async () => {
    const l = makeLayout();
    writeJob(l, "job-revise");
    const revise = review({ verdict: "revise", recommended_profile_changes: { summary: [], revised_profile: AMERICAN_EDITORIAL } });
    const { report, preview } = await runWorker(l, site, { steps: [{ answer: AMERICAN_EDITORIAL }, { answer: revise }, { answer: revise }, { answer: revise }, { answer: revise }] });
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "done" }] });
    const rep = json(join(l.out, "job-revise", "report.json"));
    expect(rep.codex).toMatchObject({ reviews: 3, revisions: 2 });
    expect(preview.renders).toEqual(["none", "candidate-0", "candidate-1", "candidate-2", "final"]);
    expect(execCalls(l)).toHaveLength(4);
  });

  it("falls back to the template when the brief is not a valid profile", async () => {
    const l = makeLayout();
    writeJob(l, "job-fallback");
    const { report } = await runWorker(l, site, { steps: [{ answer: { direction: "free_html", html: "<div>" } }] });
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "fallback_template" }] });
    const rep = json(join(l.out, "job-fallback", "report.json"));
    expect(rep.codex).toMatchObject({ fallback: true, final_candidate: null });
    expect(ls(join(l.out, "job-fallback"))).not.toContain("final.json");
    expect(ls(join(l.exportDir, "job-fallback"))).toEqual(["before-desktop.png", "before-mobile.png", "report.json"]);
  });

  it("strict brief refused → loose brief → loose review: done, the fallback is recorded as a code", async () => {
    const l = makeLayout();
    writeJob(l, "job-loose-brief");
    const { report, logs } = await runWorker(l, site, { steps: [{ exit: 1, stderr: LEAK.stderr }, { answer: AMERICAN_EDITORIAL }, { answer: review() }] });
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "done" }] });
    const rep = json(join(l.out, "job-loose-brief", "report.json"));
    expect(rep.codex).toMatchObject({ status: "done", schema_mode: "loose", notes: ["SCHEMA_LOOSE_AFTER_BRIEF_CODEX_EXEC_FAILED"] });
    expect(execCalls(l).map((c) => c.strictSchema)).toEqual([true, false, false]);
    expect(logs.join("\n")).not.toContain(LEAK.stderr);
    expect(JSON.stringify(rep)).not.toContain(LEAK.stderr);
  });

  it("strict brief → strict review refused → loose review, and every later review starts loose", async () => {
    const l = makeLayout();
    writeJob(l, "job-loose-review");
    const revise = review({ verdict: "revise", recommended_profile_changes: { summary: [], revised_profile: AMERICAN_EDITORIAL } });
    const { report } = await runWorker(l, site, { steps: [{ answer: AMERICAN_EDITORIAL }, { text: "no json here" }, { answer: revise }, { answer: review() }] });
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "done" }] });
    const rep = json(join(l.out, "job-loose-review", "report.json"));
    expect(rep.codex).toMatchObject({ schema_mode: "loose", reviews: 2, revisions: 1, notes: ["SCHEMA_LOOSE_AFTER_REVIEW_CODEX_NO_JSON"] });
    expect(execCalls(l).map((c) => c.strictSchema)).toEqual([true, true, false, false]);
  });

  it("keeps strict all the way when Codex accepts it", async () => {
    const l = makeLayout();
    writeJob(l, "job-strict");
    await runWorker(l, site);
    expect(json(join(l.out, "job-strict", "report.json")).codex).toMatchObject({ schema_mode: "strict", notes: [] });
    expect(execCalls(l).map((c) => c.strictSchema)).toEqual([true, true]);
  });

  it("falls back to the template as before when the loose brief also fails (one retry, no more)", async () => {
    const l = makeLayout();
    writeJob(l, "job-codex-fail");
    const { report, logs } = await runWorker(l, site, { steps: [{ exit: 1, stderr: LEAK.stderr }, { exit: 1, stderr: LEAK.stderr }, { answer: AMERICAN_EDITORIAL }] });
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "fallback_template" }] });
    const rep = json(join(l.out, "job-codex-fail", "report.json"));
    expect(rep.codex.notes).toEqual(["SCHEMA_LOOSE_AFTER_BRIEF_CODEX_EXEC_FAILED", "CODEX_EXEC_FAILED"]);
    expect(execCalls(l)).toHaveLength(2);
    expect(logs.join("\n")).not.toContain(LEAK.stderr);
  });

  it("falls back to the template when the loose review also fails", async () => {
    const l = makeLayout();
    writeJob(l, "job-review-fail");
    const { report } = await runWorker(l, site, { steps: [{ answer: AMERICAN_EDITORIAL }, { exit: 1 }, { exit: 1 }, { answer: review() }] });
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "fallback_template" }] });
    const rep = json(join(l.out, "job-review-fail", "report.json"));
    expect(rep.codex.notes).toEqual(["SCHEMA_LOOSE_AFTER_REVIEW_CODEX_EXEC_FAILED", "REVIEW_CODEX_EXEC_FAILED", "NO_REVIEWED_CANDIDATE"]);
    expect(execCalls(l)).toHaveLength(3);
  });

  it("still checks a loose answer against the full schema and the palette contrast", async () => {
    const l = makeLayout();
    writeJob(l, "job-loose-invalid");
    const lowContrast = { ...AMERICAN_EDITORIAL, palette: { ...AMERICAN_EDITORIAL.palette, text: "#EEE4D0" } };
    const { report } = await runWorker(l, site, { steps: [{ exit: 1 }, { answer: lowContrast }] });
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "fallback_template" }] });
    expect(json(join(l.out, "job-loose-invalid", "report.json")).codex.notes).toEqual(["SCHEMA_LOOSE_AFTER_BRIEF_CODEX_EXEC_FAILED", "BRIEF_PROFILE_INVALID"]);
    const l2 = makeLayout();
    writeJob(l2, "job-loose-extra");
    await runWorker(l2, site, { steps: [{ exit: 1 }, { answer: { ...AMERICAN_EDITORIAL, html: "<div>" } }] });
    expect(json(join(l2.out, "job-loose-extra", "report.json")).codex.notes).toContain("BRIEF_PROFILE_INVALID");
  });

  it("does not retry with the loose schema for other Codex failures", async () => {
    const l = makeLayout();
    writeJob(l, "job-no-loose");
    await runWorker(l, site, { steps: [{ exit: 1, stderr: "usage limit reached" }, { answer: AMERICAN_EDITORIAL }] });
    expect(execCalls(l)).toHaveLength(1);
  });

  it("stops the run without counting the job when Codex is not signed in with ChatGPT", async () => {
    for (const login of ["none", "apikey"] as const) {
      const l = makeLayout();
      writeJob(l, "job-env");
      const { report } = await runWorker(l, site, { login });
      expect(report, "report").toMatchObject({ status: "stopped", code: login === "none" ? "CODEX_NOT_SIGNED_IN" : "CODEX_API_KEY_AUTH" });
      expect(ls(join(l.queue, "inbox"))).toEqual(["job-env.json"]);
      expect(existsSync(join(l.state, "ledger.json")) ? json(join(l.state, "ledger.json")).jobs : {}).toEqual({});
      expect(ls(l.tmp)).toEqual([]);
    }
  });

  it("stops on a Codex quota error mid-job, puts the job back and leaves no partial result", async () => {
    const l = makeLayout();
    writeJob(l, "job-quota");
    const { report } = await runWorker(l, site, { steps: [{ exit: 1, stderr: "usage limit reached" }] });
    expect(report, "report").toMatchObject({ status: "stopped", code: "CODEX_QUOTA" });
    expect(ls(join(l.queue, "inbox"))).toEqual(["job-quota.json"]);
    expect(existsSync(join(l.out, "job-quota"))).toBe(false);
    expect(ls(l.tmp)).toEqual([]);
  });

  it("retries a render failure once in a later run, then gives up", async () => {
    const l = makeLayout();
    writeJob(l, "job-render");
    const first = await runWorker(l, site, { failRender: true });
    expect(first.report, "report").toMatchObject({ jobs: [{ status: "retry", code: "PREVIEW_RENDER_FAILED" }] });
    expect(ls(join(l.queue, "inbox"))).toEqual(["job-render.json"]);
    expect(existsSync(join(l.out, "job-render"))).toBe(false);
    const second = await runWorker(l, site, { failRender: true });
    expect(second.report, "report").toMatchObject({ jobs: [{ status: "failed", code: "WORKER_JOB_FAILED" }] });
    expect(ls(join(l.queue, "failed"))).toContain("job-render.json");
  });
});

describe("model output and secrets never leave the worker (H1)", () => {
  it("keeps Codex's words and stderr out of logs, the ledger, job records and report.json", async () => {
    const l = makeLayout();
    writeJob(l, "job-leak");
    const { logs } = await runWorker(l, site, {
      steps: [
        { answer: { ...AMERICAN_EDITORIAL, rationale: [LEAK.rationale] } },
        { answer: review({ problems: [{ area: "hero", severity: "low", note: LEAK.note }], recommended_profile_changes: { summary: [LEAK.note], revised_profile: null } }) },
      ],
    });
    const log = logs.join("\n");
    for (const marker of Object.values(LEAK)) expect(log).not.toContain(marker);
    expect(readFileSync(join(l.out, "job-leak", "report.json"), "utf8")).not.toMatch(/LEAK-/);
    expect(allText(l.queue)).not.toMatch(/LEAK-/);
    expect(allText(l.state)).not.toMatch(/LEAK-/);
  });
});

describe("queue safety", () => {
  it("recovers a job left in processing by a dead worker and leaves a live worker's job alone", async () => {
    const l = makeLayout();
    writeJob(l, "job-dead", undefined, undefined, "processing");
    writeFileSync(join(l.queue, "processing", "job-dead.claim.json"), JSON.stringify({ pid: 2 ** 22 - 3, token: "t", at: new Date().toISOString(), bootId: "another-boot", startTime: "1" }));
    writeJob(l, "job-live", undefined, undefined, "processing");
    writeFileSync(join(l.queue, "processing", "job-live.claim.json"), JSON.stringify(await currentHolder("live-token")));
    const { report, logs } = await runWorker(l, site);
    expect(report, "report").toMatchObject({ status: "finished", recovered: ["job-dead"], jobs: [{ jobId: "job-dead", status: "done", outcome: "done" }] });
    expect(ls(join(l.queue, "processing"))).toEqual(["job-live.claim.json", "job-live.json"]);
    expect(logs.join("\n")).toContain("job job-live: held by a live worker");
    expect(json(join(l.out, "job-dead", "report.json")).outcome).toBe("done");
  });

  it("does not crash on a corrupt claim file, and leaves a fresh unclaimed job alone", async () => {
    const l = makeLayout();
    writeJob(l, "job-corrupt", undefined, undefined, "processing");
    writeFileSync(join(l.queue, "processing", "job-corrupt.claim.json"), "{broken");
    const { report } = await runWorker(l, site);
    expect(report, "report").toMatchObject({ status: "idle", recovered: [] });
    expect(ls(join(l.queue, "processing"))).toEqual(["job-corrupt.claim.json", "job-corrupt.json"]);
  });

  it("treats a live claim older than the stale limit as stale", async () => {
    const l = makeLayout();
    writeJob(l, "job-old", undefined, undefined, "processing");
    const old = { ...(await currentHolder("old")), at: new Date(Date.now() - LOCK_STALE_MS - 60_000).toISOString() };
    writeFileSync(join(l.queue, "processing", "job-old.claim.json"), JSON.stringify(old));
    const { report } = await runWorker(l, site);
    expect(report, "report").toMatchObject({ recovered: ["job-old"], jobs: [{ jobId: "job-old", status: "done" }] });
  });

  it("gives up on a job that went stale twice", async () => {
    const l = makeLayout();
    mkdirSync(l.state, { recursive: true });
    writeFileSync(join(l.state, "ledger.json"), JSON.stringify({ schemaVersion: 1, jobs: { "job-twice": { attempts: 1, lastCode: "WORKER_JOB_STALE", lastAt: new Date().toISOString() } } }));
    writeJob(l, "job-twice", undefined, undefined, "processing");
    writeFileSync(join(l.queue, "processing", "job-twice.claim.json"), JSON.stringify({ pid: 2 ** 22 - 3, token: "t", at: new Date().toISOString(), bootId: "another-boot", startTime: "1" }));
    const { report } = await runWorker(l, site);
    expect(report, "report").toMatchObject({ status: "idle" });
    expect(ls(join(l.queue, "failed"))).toEqual(["job-twice.json", "job-twice.result.json"]);
    expect(json(join(l.queue, "failed", "job-twice.result.json")).code).toBe("WORKER_JOB_STALE");
  });

  it("makes one result per job id: a finished result is reused, a done id is refused", async () => {
    const l = makeLayout();
    writeJob(l, "job-once");
    await runWorker(l, site);
    const first = readFileSync(join(l.out, "job-once", "report.json"), "utf8");
    // the same id again
    writeJob(l, "job-once");
    const again = await runWorker(l, site);
    expect(again.report, "report").toMatchObject({ jobs: [{ jobId: "job-once", status: "failed", code: "DUPLICATE_JOB_ID" }] });
    expect(readFileSync(join(l.out, "job-once", "report.json"), "utf8")).toBe(first);
    // a crash after the result was written but before the job moved to done
    const l2 = makeLayout();
    writeJob(l2, "job-crash");
    await runWorker(l2, site);
    const report = readFileSync(join(l2.out, "job-crash", "report.json"), "utf8");
    // put it back as if the move to done never happened
    writeJob(l2, "job-crash", undefined, undefined, "processing");
    writeFileSync(join(l2.queue, "processing", "job-crash.claim.json"), JSON.stringify({ pid: 2 ** 22 - 3, token: "t", at: new Date().toISOString(), bootId: "another-boot", startTime: "1" }));
    const doneDir = join(l2.queue, "done");
    for (const n of ls(doneDir)) writeFileSync(join(doneDir, n), "");
    const { rmSync } = await import("node:fs");
    rmSync(join(doneDir, "job-crash.json"));
    const before = execCalls(l2).length;
    const recovered = await runWorker(l2, site);
    expect(recovered.report, "report").toMatchObject({ status: "idle", recovered: ["job-crash"] });
    expect(execCalls(l2).length).toBe(before);
    expect(readFileSync(join(l2.out, "job-crash", "report.json"), "utf8")).toBe(report);
    expect(ls(doneDir)).toContain("job-crash.json");
  });

  it("allows one worker at a time", async () => {
    const l = makeLayout();
    writeJob(l, "job-a");
    const [a, b] = await Promise.all([runWorker(l, site), runWorker(l, site)]);
    const statuses = [a.report.status, b.report.status].sort();
    expect(statuses).toEqual(["finished", "locked"]);
  });

  it("takes over an unreadable lock after a minute", async () => {
    const l = makeLayout();
    mkdirSync(l.state, { recursive: true });
    const lock = join(l.state, "worker.lock");
    writeFileSync(lock, "");
    expect(await acquireLock(l.state, new Date())).toBeUndefined();
    const old = new Date(Date.now() - 2 * 60 * 1000);
    utimesSync(lock, old, old);
    const taken = await acquireLock(l.state, new Date());
    expect(taken).toBeDefined();
    await taken!.release();
  });

  it("takes over a lock whose holder is gone, never a live one", async () => {
    const l = makeLayout();
    const live = await acquireLock(l.state, new Date());
    expect(live).toBeDefined();
    expect(await acquireLock(l.state, new Date())).toBeUndefined();
    await live!.release();
    writeFileSync(join(l.state, "worker.lock"), JSON.stringify({ pid: 2 ** 22 - 3, token: "dead", at: new Date().toISOString(), bootId: "another-boot", startTime: "1" }));
    const taken = await acquireLock(l.state, new Date());
    expect(taken).toBeDefined();
    await taken!.release();
    expect(existsSync(join(l.state, "worker.lock"))).toBe(false);
  });
});

describe("Windows copy is best effort", () => {
  it("keeps the job done when the Windows folder is unavailable", async () => {
    const l = makeLayout();
    writeJob(l, "job-nowin");
    const { report } = await runWorker(l, site, { exportDir: join(l.root, "no-such-mount", "Desktop", "result") });
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "done", windowsCopy: "unavailable" }] });
    expect(json(join(l.out, "job-nowin", "report.json")).windows_copy).toBe("unavailable");
    expect(ls(join(l.queue, "done"))).toContain("job-nowin.json");
  });

  it("refuses to write through a link on the Windows side", async () => {
    const l = makeLayout();
    writeJob(l, "job-winlink");
    const elsewhere = join(l.root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(l.exportDir);
    symlinkSync(elsewhere, join(l.exportDir, "job-winlink"));
    const { report } = await runWorker(l, site);
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", windowsCopy: "failed" }] });
    expect(ls(elsewhere)).toEqual([]);
  });

  it("records a failed copy and still keeps the job done", async () => {
    const l = makeLayout();
    writeJob(l, "job-winfail");
    // the target folder is a file, so the copy fails
    writeFileSync(l.exportDir, "x");
    const { report } = await runWorker(l, site);
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", windowsCopy: "failed" }] });
    expect(json(join(l.out, "job-winfail", "report.json")).windows_copy).toBe("failed");
  });

  it("works without a Windows folder configured", async () => {
    const l = makeLayout();
    writeJob(l, "job-nocfg");
    const { report } = await runWorker(l, site, { exportDir: undefined });
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", windowsCopy: "unavailable" }] });
  });
});

describe("stale temporary directories", () => {
  it("removes only the worker's own old, unheld directories", async () => {
    const l = makeLayout();
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    const mk = (name: string, age: Date | null) => {
      const p = join(l.tmp, name);
      mkdirSync(p);
      writeFileSync(join(p, "profile.png"), "x");
      if (age) utimesSync(p, age, age);
      return p;
    };
    mk("sr-design-worker-abc123", old);
    mk("sr-design-codex-def456", old);
    mk("sr-design-worker-young1", null);
    mk("sr-design-other-abc123", old);
    mk("unrelated", old);
    mk("sr-design-worker-longername", old);
    const deadDir = mk("sr-design-worker-dead12", null);
    writeFileSync(join(deadDir, ".sr-design-worker.json"), JSON.stringify({ pid: 2 ** 22 - 3, token: "t", at: new Date().toISOString(), bootId: "another-boot", startTime: "1" }));
    const heldDir = mk("sr-design-worker-held12", null);
    writeFileSync(join(heldDir, ".sr-design-worker.json"), JSON.stringify(await currentHolder("held")));
    utimesSync(heldDir, old, old);
    const outside = join(l.root, "outside");
    mkdirSync(outside);
    utimesSync(outside, old, old);
    symlinkSync(outside, join(l.tmp, "sr-design-worker-link12"));
    const removed = await cleanStaleTemp(l.tmp, new Date());
    // a dead worker's root goes at once, whatever its age
    expect(removed.sort()).toEqual(["sr-design-codex-def456", "sr-design-worker-abc123", "sr-design-worker-dead12"]);
    expect(ls(l.tmp)).toEqual(["sr-design-other-abc123", "sr-design-worker-held12", "sr-design-worker-link12", "sr-design-worker-longername", "sr-design-worker-young1", "unrelated"]);
    expect(existsSync(outside)).toBe(true);
  });

  it("runs the cleanup at the start of every run", async () => {
    const l = makeLayout();
    const stale = join(l.tmp, "sr-design-worker-zzz999");
    mkdirSync(join(stale, "job-x", "refs"), { recursive: true });
    writeFileSync(join(stale, "job-x", "refs", "grid-top.png"), "x");
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    const { report, logs } = await runWorker(l, site);
    expect(report.status).toBe("idle");
    expect(existsSync(stale)).toBe(false);
    expect(logs.join("\n")).toContain("removed 1 stale temporary directory");
  });
});

describe("visual sources: website → signed-in helper → public Instagram → unavailable", () => {
  const siteTarget = (path: string) => () => ({ url: `${site.origin}${path}`, allowNavigation: (u: string) => u.startsWith(`${site.origin}/`) });
  const WEBSITE = "https://www.example-bakery.jp/";
  // Tests only: the egress proxy may reach exactly the mock (127.0.0.1:<its port>), nothing else.
  const mockEgress = async (host: string, port: number) => (host === "127.0.0.1" && String(port) === new URL(site.origin).port ? ["127.0.0.1"] : null);

  it("uses the verified official website first: home + about/menu pages, privacy-processed, nothing else opened", async () => {
    const l = makeLayout();
    writeJob(l, "job-site", "https://www.instagram.com/example_shop/", undefined, "inbox", WEBSITE);
    const before = site.requests.length;
    const helperCalls: string[] = [];
    const { report, logs, preview } = await runWorker(l, site, {
      websiteTargetFor: siteTarget("/site_home/"),
      websiteEgress: mockEgress,
      captureHelper: async (i) => (helperCalls.push(i.requestId), { code: "CAPTURED", files: [], softened: 0 }),
    });
    expect(report, JSON.stringify({ report, logs })).toMatchObject({ status: "finished", jobs: [{ status: "done", outcome: "done" }] });
    const rep = json(join(l.out, "job-site", "report.json"));
    expect(rep).toMatchObject({ visual_source: "website", sources: { website: { status: "captured", images: 3 } }, instagram: null, references: { images: 3, temp_deleted: true } });
    expect(rep.references.media_softened).toBeGreaterThan(0);
    expect(preview.refsSeen.every((n) => n === 3)).toBe(true);
    // the helper and Instagram were not needed
    expect(helperCalls).toEqual([]);
    const opened = site.requests.slice(before).filter((r) => !r.includes("/p/"));
    expect(opened.some((r) => r.includes("example_shop"))).toBe(false);
    expect(opened.some((r) => r.includes("/site_home/contact/"))).toBe(false); // not an about/menu/access page
    expect(opened.some((r) => r.startsWith("localhost:"))).toBe(false); // the off-site link was never followed
    // the prompt says what the references are, and Codex got them
    const brief = execCalls(l)[0]!;
    expect(brief.args.filter((a: string) => a.startsWith("--image=")).length).toBe(5);
    expect(ls(l.tmp)).toEqual([]);
  });

  it("falls to the signed-in capture (helper) when there is no website, then to the public capture when the helper cannot", async () => {
    const l = makeLayout();
    writeJob(l, "job-helper");
    const { report } = await runWorker(l, site, {
      captureHelper: async (i) => {
        mkdirSync(i.destDir, { recursive: true, mode: 0o700 });
        const files = ["profile.png", "grid-top.png"].map((n) => join(i.destDir, n));
        for (const f of files) writeFileSync(f, PNG, { mode: 0o600 });
        return { code: "CAPTURED", files, softened: 7 };
      },
    });
    expect(report).toMatchObject({ status: "finished", jobs: [{ status: "done", outcome: "done" }] });
    expect(json(join(l.out, "job-helper", "report.json"))).toMatchObject({ visual_source: "instagram_signed_in", sources: { instagram_signed_in: { status: "CAPTURED" } }, references: { images: 2, media_softened: 7 } });

    const l2 = makeLayout();
    writeJob(l2, "job-expired");
    const second = await runWorker(l2, site, { captureHelper: async () => ({ code: "LOGIN_REQUIRED", reason: "NO_PROFILE", files: [], softened: 0 }) });
    expect(second.report).toMatchObject({ status: "finished", jobs: [{ status: "done", outcome: "done" }] });
    expect(json(join(l2.out, "job-expired", "report.json"))).toMatchObject({
      visual_source: "instagram_public",
      sources: { instagram_signed_in: { status: "LOGIN_REQUIRED", reason: "NO_PROFILE" } },
      instagram: { status: "captured" },
    });
  });

  it("a website that tries to leave is not used; with nothing else it is PUBLIC_SOURCE_UNAVAILABLE", async () => {
    const l = makeLayout();
    writeJob(l, "job-leaves", null, undefined, "inbox", WEBSITE);
    const before = site.requests.length;
    const { report } = await runWorker(l, site, { websiteTargetFor: siteTarget("/site_leaves/"), websiteEgress: mockEgress });
    expect(report).toMatchObject({ status: "finished", jobs: [{ status: "done", outcome: "PUBLIC_SOURCE_UNAVAILABLE" }] });
    expect(json(join(l.out, "job-leaves", "report.json"))).toMatchObject({ visual_source: null, sources: { website: { status: "unavailable", reason: "OFF_SITE_REDIRECT" } }, instagram: null, codex: null });
    expect(site.requests.slice(before).some((r) => r.startsWith("localhost:"))).toBe(false);
    expect(execCalls(l)).toEqual([]);
  });

  it("never lets a shop's site reach local or internal addresses (SSRF), whatever its name", async () => {
    const { publicHostCheck, isPrivateAddress } = await import("@/lib/design-agent/worker/website");
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "::7f00:1", "not-an-ip"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "203.0.113.5", "2001:db8::1"]) expect(isPrivateAddress(ip), ip).toBe(false);
    const check = publicHostCheck();
    expect(await check("http://127.0.0.1/")).toBe(false);
    expect(await check("http://[::1]/")).toBe(false);
    expect(await check("http://[::ffff:127.0.0.1]:8766/x")).toBe(false);
    expect(await check("http://localhost/")).toBe(false);
    expect(await check("data:image/png;base64,xx")).toBe(true);
    // the real default: the production capture refuses the local mock outright
    const l = makeLayout();
    writeJob(l, "job-ssrf", null, undefined, "inbox", WEBSITE);
    const before = site.requests.length;
    const { report } = await runWorker(l, site, { websiteTargetFor: siteTarget("/site_home/") });
    expect(report).toMatchObject({ status: "finished", jobs: [{ status: "done", outcome: "PUBLIC_SOURCE_UNAVAILABLE" }] });
    expect(site.requests.length).toBe(before); // not one request reached the local service
  });

  it("a website-only job is tried again after a passing failure (5xx), not closed as unavailable", async () => {
    const l = makeLayout();
    writeJob(l, "job-503", null, undefined, "inbox", WEBSITE);
    const { report } = await runWorker(l, site, { websiteTargetFor: siteTarget("/error_shop/"), websiteEgress: mockEgress });
    expect(report).toMatchObject({ status: "finished", jobs: [{ jobId: "job-503", status: "retry", code: "SOURCE_CAPTURE_FAILED" }] });
    expect(ls(join(l.queue, "inbox"))).toEqual(["job-503.json"]);
  });

  it("a shop page cannot open WebSockets (they bypass request routing and the host check)", async () => {
    const l = makeLayout();
    writeJob(l, "job-ws", null, undefined, "inbox", WEBSITE);
    const before = site.requests.length;
    await runWorker(l, site, { websiteTargetFor: siteTarget("/site_ws/"), websiteEgress: mockEgress });
    expect(site.requests.slice(before).filter((r) => r.includes("[websocket]"))).toEqual([]);
    expect(site.requests.slice(before).some((r) => r.includes("/site_ws/"))).toBe(true);
  });

  it("a Web Worker's WebSocket / fetch and WebRTC STUN cannot reach local services either (all traffic goes through the egress proxy)", async () => {
    const udp = createSocket("udp4");
    const packets: string[] = [];
    udp.on("message", (_m, r) => packets.push(`${r.address}:${r.port}`));
    await new Promise<void>((r) => udp.bind(0, "127.0.0.1", () => r()));
    try {
      const l = makeLayout();
      writeJob(l, "job-wsw", null, undefined, "inbox", WEBSITE);
      const before = site.requests.length;
      const { report } = await runWorker(l, site, { websiteTargetFor: () => ({ url: `${site.origin}/site_ws_worker/?stun=${udp.address().port}`, allowNavigation: (u: string) => u.startsWith(`${site.origin}/`) }), websiteEgress: mockEgress, captureSettleMs: 1500 });
      expect(report).toMatchObject({ status: "finished" });
      const seen = site.requests.slice(before);
      expect(seen.some((r) => r.includes("/site_ws_worker/stun/"))).toBe(true); // the page ran its WebRTC code
      // without the proxy and the flags this page reaches localhost:<mock>/ws-worker and sends STUN packets (checked by hand)
      expect(seen.filter((r) => r.startsWith("localhost:") || r.includes("ws-worker") || r.includes("worker-fetch"))).toEqual([]);
      expect(packets).toEqual([]);
    } finally {
      udp.close();
    }
  });

  it("the egress proxy refuses private addresses, other ports and odd names; it connects to the address it checked", async () => {
    const { publicWebsiteEgress } = await import("@/lib/design-agent/worker/website");
    const egress = publicWebsiteEgress();
    for (const [h, p] of [["127.0.0.1", 443], ["[::1]", 443], ["10.0.0.1", 80], ["169.254.169.254", 80], ["localhost", 443], ["8.8.8.8", 22], ["8.8.8.8", 8080], ["bad_name!", 443], ["x", 443]] as const) expect(await egress(h, p), `${h}:${p}`).toBeNull();
    expect(await egress("8.8.8.8", 443)).toEqual(["8.8.8.8"]);
    const { startEgressProxy } = await import("@/lib/design-agent/worker/egress-proxy");
    // the proxy dials the policy's answer, not what the client named
    // (the first checked address does not answer: the next one is used)
    const proxy = await startEgressProxy(async (host) => (host === "rebind.example" ? ["127.0.0.2", "127.0.0.1"] : null));
    try {
      const port = Number(new URL(site.origin).port);
      const viaProxy = (path: string, host: string) =>
        new Promise<number>((resolve) => {
          const req = httpRequest({ host: "127.0.0.1", port: Number(new URL(proxy.proxy.server).port), method: "GET", path: `http://${host}:${port}${path}` }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", () => resolve(-1));
          req.end();
        });
      expect(await viaProxy("/site_home/about/", "rebind.example")).toBe(200);
      expect(await viaProxy("/site_home/about/", "other.example")).toBe(403);
      // a CONNECT tunnel (https / wss) goes to the checked address too
      const tunnel = (host: string) =>
        new Promise<string>((resolve) => {
          const sock = connect(Number(new URL(proxy.proxy.server).port), "127.0.0.1", () => sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
          let buf = "";
          sock.on("data", (d) => {
            buf += d.toString();
            if (buf.startsWith("HTTP/1.1 200") && !buf.includes("GET-SENT")) {
              buf += "GET-SENT";
              sock.write(`GET /site_home/menu/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
            }
          });
          sock.on("close", () => resolve(buf));
          sock.on("error", () => resolve(buf));
        });
      expect(await tunnel("rebind.example")).toMatch(/GET-SENTHTTP\/1\.1 200[\s\S]*\/site_home\/menu\//);
      expect(await tunnel("other.example")).toMatch(/^HTTP\/1\.1 403/);
      expect(proxy.refused()).toBe(2);
    } finally {
      await proxy.close();
    }
  });

  it("on a shared hosting platform, other tenants' subdomains are not the shop's site", async () => {
    const { websiteTarget } = await import("@/lib/design-agent/worker/website");
    const own = websiteTarget({ url: "https://www.example-bakery.jp/", host: "www.example-bakery.jp" });
    expect(own.allowNavigation("https://shop.example-bakery.jp/x")).toBe(true);
    const tenant = websiteTarget({ url: "https://example-bakery.wixsite.com/home", host: "example-bakery.wixsite.com" });
    expect(tenant.allowNavigation("https://example-bakery.wixsite.com/menu")).toBe(true);
    expect(tenant.allowNavigation("https://other-shop.wixsite.com/")).toBe(false);
  });

  it("refuses website URLs that are not a shop's own site", async () => {
    const { parseWebsiteUrl } = await import("@/lib/design-agent/worker/website");
    for (const bad of ["http://127.0.0.1/", "https://localhost/", "http://127.0.0.1.nip.io/", "http://localtest.me/", "https://linktr.ee/x", "https://lit.link/x", "https://user:pw@shop.jp/", "https://shop.jp:8443/", "https://www.instagram.com/x/", "https://facebook.com/x", "file:///etc/passwd", "javascript:alert(1)", "https://shop.local/", "ftp://shop.jp/"]) {
      expect(parseWebsiteUrl(bad), bad).toBeNull();
    }
    expect(parseWebsiteUrl("https://www.example-bakery.jp/about#x")).toEqual({ url: "https://www.example-bakery.jp/about", host: "www.example-bakery.jp" });
  });
});

describe.skipIf(spawnSync("bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--unshare-pid", "/bin/true"]).status !== 0)(
  "a whole run with Codex inside the REAL sandbox (no passthrough)",
  () => {
    it("brief → DesignProfile → render → review → final, with Codex seeing only the copied references", async () => {
      const l = makeLayout();
      // the worker's temp root outside the (fake) home, as /tmp is in production
      const tmpBase = mkdtempSync(join(tmpdir(), "srdw-real-tmp-"));
      writeJob(l, "job-real");
      const install = join(l.root, "codex-install", "bin");
      mkdirSync(install, { recursive: true });
      const codexBin = join(install, "codex");
      const profileAnswer = JSON.stringify(AMERICAN_EDITORIAL);
      const reviewAnswer = JSON.stringify(review());
      writeFileSync(
        codexBin,
        `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
if (a[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
const schema = fs.readFileSync(a[a.indexOf("--output-schema") + 1], "utf8");
const images = a.filter((x) => x.startsWith("--image=")).map((x) => x.slice(8));
const probe = {
  images: images.length,
  imagesReadable: images.every((p) => { try { return fs.readFileSync(p).subarray(1, 4).toString() === "PNG"; } catch { return false; } }),
  imagesInWorkDir: images.every((p) => p.startsWith(path.join(process.cwd(), "inputs") + "/")),
  queueVisible: fs.existsSync(${JSON.stringify(l.queue)}),
  resultsVisible: fs.existsSync(${JSON.stringify(l.out)}),
  stateVisible: fs.existsSync(${JSON.stringify(l.state)}),
};
const out = path.join(process.env.CODEX_HOME, "probes.jsonl");
fs.appendFileSync(out, JSON.stringify(probe) + "\\n");
fs.writeFileSync(a[a.indexOf("--output-last-message") + 1], schema.includes("verdict") ? ${JSON.stringify(reviewAnswer)} : ${JSON.stringify(profileAnswer)});
console.log(JSON.stringify({ type: "thread.started", thread_id: "11111111-1111-4111-8111-111111111111" }));
`,
        { mode: 0o755 },
      );
      const { report, logs } = await runWorker(l, site, {
        tmpBase,
        codexBin,
        prepareSandbox: undefined, // the production path: prepareCodexSandbox with workerProtectedPaths
        env: { PATH: `${process.execPath.replace(/\/node$/, "")}:/usr/local/bin:/usr/bin:/bin`, HOME: l.root, LANG: "C.UTF-8", CODEX_HOME: join(l.root, "codex-home") },
      });
      expect(report, JSON.stringify({ report, logs })).toMatchObject({ status: "finished", jobs: [{ status: "done", outcome: "done" }] });
      const rep = json(join(l.out, "job-real", "report.json"));
      expect(rep).toMatchObject({ visual_source: "instagram_public", codex: { status: "done", direction: "american_editorial", reviews: 1 } });
      const probes = readFileSync(join(l.root, "codex-home", "probes.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
      expect(probes.length).toBe(2); // brief and review
      for (const p of probes) {
        expect(p).toMatchObject({ imagesReadable: true, imagesInWorkDir: true, queueVisible: false, resultsVisible: false, stateVisible: false });
        expect(p.images).toBeGreaterThanOrEqual(4);
      }
      expect(existsSync(join(l.out, "job-real", "final.json"))).toBe(true);
    });
  },
);
