import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireLock, currentHolder, LOCK_STALE_MS } from "@/lib/design-agent/worker/state";
import { cleanStaleTemp } from "@/lib/design-agent/worker/temp";
import { AMERICAN_EDITORIAL, review } from "./fixtures";
import { allText, codexCalls, LEAK, makeLayout, runWorker, startMockSite, WORKER_SHA, writeJob, type Layout, type MockSite } from "./worker-support";

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
    const { logs } = await runWorker(l, site);
    expect(ls(day)).toEqual(["rollout-2026-09-28T02-00-00-33333333-3333-4333-8333-333333333333.jsonl"]);
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

  it("retries the brief once with the loose schema after a Codex failure, then falls back", async () => {
    const l = makeLayout();
    writeJob(l, "job-codex-fail");
    const { report, logs } = await runWorker(l, site, { steps: [{ exit: 1, stderr: LEAK.stderr }, { exit: 1, stderr: LEAK.stderr }] });
    expect(report, "report").toMatchObject({ jobs: [{ status: "done", outcome: "fallback_template" }] });
    const rep = json(join(l.out, "job-codex-fail", "report.json"));
    expect(rep.codex.notes).toEqual(["BRIEF_LOOSE_RETRY_AFTER_CODEX_EXEC_FAILED", "CODEX_EXEC_FAILED"]);
    expect(execCalls(l)).toHaveLength(2);
    expect(logs.join("\n")).not.toContain(LEAK.stderr);
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
