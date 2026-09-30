// Test support for the design worker: a local mock of a public profile page,
// a fake Codex wrapper, a fake preview renderer and a throwaway layout.
// Fictional data only.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { RunDeadline } from "@/lib/design-agent/bounded-process";
import type { CaptureTarget } from "@/lib/design-agent/worker/capture";
import { runDesignWorker, type PreviewSession, type WorkerOptions } from "@/lib/design-agent/worker/run";
import { AMERICAN_EDITORIAL, review } from "./fixtures";

export const FAKE_CODEX = resolve(__dirname, "../../support/fake-codex.mjs");
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
export const WORKER_SHA = "0123456789abcdef0123456789abcdef01234567";
export const LEAK = { stderr: "LEAK-STDERR-7f3a", rationale: "LEAK-RATIONALE-91c2", note: "LEAK-NOTE-5d10" };

export const FACTS = { name: "EXAMPLE TEST", category: "baked_goods", ward: "北区", address: "名古屋市北区テスト町1-2-3", description: "テスト用の架空の紹介文です。" };

// ------------------------------------------------------------------ mock profile site

const tile = (i: number) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="hsl(${(i * 37) % 360},55%,70%)"/><circle cx="150" cy="150" r="60" fill="#fff"/></svg>`)}`;

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;font-family:sans-serif">${body}</body></html>`;

const profileBody = (posts: number) =>
  `<header style="height:260px;background:#f4e8d2;padding:40px"><h2>example_shop</h2><p>Fictional bakery bio for tests.</p><p class="followed"><span>Followed by</span> <a href="/example_shop/followers/mutualOnly">LEAK-FRIEND-NAME</a> + 3 more</p></header>` +
  `<div class="suggested"><div><span>Suggested for you</span><img width="60" height="60" src="${tile(99)}"><span>LEAK-SUGGESTED-NAME</span></div></div>` +
  `<div style="display:grid;grid-template-columns:repeat(3,300px);gap:4px;padding:20px">${Array.from({ length: posts }, (_, i) => `<a href="/p/${i}/"><img width="300" height="300" src="${tile(i)}"></a>`).join("")}</div>`;

/** A page as a signed-in account sees it: own navigation, a messages dock, a notification dialog. */
const signedIn = (mainBody: string) =>
  page(
    `<nav style="position:fixed;left:0;top:0;width:240px;height:100%;background:#fff"><a href="/">Instagram</a><a href="/explore/">Explore</a><a href="/direct/inbox/">Messages</a><span>LEAK-OWN-ACCOUNT</span><span>Notifications 3</span></nav>` +
      `<div class="dock" style="position:fixed;right:10px;bottom:10px;width:200px;height:60px;background:#eee">LEAK-DM-PEER</div>` +
      `<div role="dialog" style="position:absolute;top:100px;left:400px;background:#fff">Turn on notifications LEAK-DIALOG</div>` +
      `<main style="margin-left:260px;width:1000px">${mainBody}</main>`,
  );

const profile = (posts: number) =>
  page(
    `<header style="height:260px;background:#f4e8d2;padding:40px"><h2>example_shop</h2><p>Fictional bakery bio for tests.</p></header>` +
      `<main><div style="display:grid;grid-template-columns:repeat(3,300px);gap:4px;padding:20px">${Array.from({ length: posts }, (_, i) => `<a href="/p/${i}/"><img width="300" height="300" src="${tile(i)}"></a>`).join("")}</div></main>`,
  );

export type MockSite = {
  origin: string;
  requests: string[];
  /** Request headers of the last /li_headers/ visit. */
  lastHeaders: Record<string, string | string[] | undefined>;
  server: Server;
  target(username: string): CaptureTarget;
};

export async function startMockSite(): Promise<MockSite> {
  const requests: string[] = [];
  const site = { lastHeaders: {} as MockSite["lastHeaders"] };
  let origin = "";
  const server = createServer((req, res) => {
    requests.push(`${req.headers.host ?? ""}${req.url ?? ""}`);
    const port = new URL(origin).port;
    const send = (status: number, html: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    switch (req.url) {
      case "/example_shop/":
        return send(200, profile(12));
      case "/home_signed_in/":
        return send(200, signedIn(`<h1>home</h1>`));
      case "/li_shop/":
        return send(200, signedIn(profileBody(12)));
      case "/li_captcha/":
        return send(200, signedIn(`<header style="height:200px">x</header><iframe title="captcha" src="about:blank"></iframe>`));
      case "/li_challenge/":
        res.writeHead(302, { location: "/challenge/abc/" });
        return res.end();
      case "/login_page/":
        return send(200, page(`<form><input name="username"><input name="password" type="password"><button>Log in</button></form>`));
      case "/li_jp/":
        return send(
          200,
          page(
            `<nav style="position:fixed;left:0;top:0;width:240px"><a href="/direct/inbox/">Messages</a></nav>` +
              `<div style="position:sticky;top:0"><main style="margin-left:260px;width:1000px">` +
              `<header style="height:260px"><h2>example_shop</h2><p>季節のおすすめマフィンを焼いています</p><p>今日の<b>おすすめ</b>はブルーベリー</p></header>` +
              `<div><div><span>おすすめ</span><span>LEAK-JP-SUGGESTED</span></div></div>` +
              `<div style="display:grid;grid-template-columns:repeat(3,300px)">${Array.from({ length: 3 }, (_, i) => `<a href="/p/${i}/"><img width="300" height="300" src="${tile(i)}"></a>`).join("")}</div>` +
              `</main></div>`,
          ),
        );
      case "/li_fetch_sensitive/":
        // Like a site that answers a request without the browser's sec-fetch-* headers differently.
        return req.headers["sec-fetch-mode"] === "navigate"
          ? send(200, signedIn(profileBody(12)))
          : send(200, signedIn(`<h2>Sorry, this page isn't available.</h2>`));
      case "/li_hydrate/":
        // The shell says "unavailable" until the script has rendered the profile.
        return send(
          200,
          signedIn(`<div id="app"><h2>Sorry, this page isn't available.</h2></div>`).replace(
            "</body>",
            `<script>setTimeout(()=>{document.getElementById("app").innerHTML=${JSON.stringify(profileBody(12))};},1500);</script></body>`,
          ),
        );
      case "/li_headers/":
        site.lastHeaders = { ...req.headers };
        return send(200, signedIn(profileBody(3)));
      case "/li_unavailable/":
        return send(200, signedIn(`<h2>Sorry, this page isn't available.</h2>`));
      case "/li_iframe/":
        return send(200, signedIn(profileBody(3).replace("<header", `<iframe src="http://localhost:${port}/frame_target/" width="10" height="10"></iframe><header`)));
      case "/li_js_offsite/":
        return send(200, signedIn(profileBody(3)).replace("</body>", `<script>setTimeout(()=>{location.href="http://localhost:${port}/js_target/";},100);</script></body>`));
      case "/li_gone/":
        return send(410, page("gone"));
      case "/li_private/":
        return send(200, signedIn(`<header style="height:200px"><h2>x</h2></header><h2>This account is private</h2>`));
      case "/li_offsite/":
        res.writeHead(302, { location: `http://localhost:${port}/elsewhere/` });
        return res.end();
      case "/hop_li_shop/":
        res.writeHead(302, { location: "/li_shop/" });
        return res.end();
      case "/li_offsite_hop/":
        // off the site and straight back: only the middle hop leaves
        res.writeHead(302, { location: `http://localhost:${port}/bounce/` });
        return res.end();
      case "/bounce/":
        res.writeHead(302, { location: `http://127.0.0.1:${port}/li_shop/` });
        return res.end();
      case "/li_popup/":
        return send(200, signedIn(profileBody(3)).replace("</body>", `<script>window.open("http://localhost:${port}/popup_target/", "_blank", "noopener");</script></body>`));
      case "/li_nomain/":
        return send(200, page(`<nav><a href="/direct/inbox/">Messages</a></nav><header style="height:200px"><h2>x</h2></header>${Array.from({ length: 3 }, (_, i) => `<a href="/p/${i}/"><img width="300" height="300" src="${tile(i)}"></a>`).join("")}`));
      case "/set_session/":
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "fake_session=FICTIONAL; Path=/; Max-Age=3600; HttpOnly" });
        return res.end(page("set"));
      case "/echo_session/":
        return send(200, page(`<p id="has">${(req.headers.cookie ?? "").includes("fake_session=FICTIONAL") ? "yes" : "no"}</p>`));
      case "/popup_shop/":
        return send(200, profile(3).replace("<main>", `<script>window.open("http://localhost:${port}/elsewhere/");</script><main>`));
      case "/error_shop/":
        return send(503, page("unavailable"));
      case "/short_grid/":
        return send(200, profile(12).replace(/width="300" height="300"/g, 'width="40" height="40"').replace("repeat(3,300px)", "repeat(12,40px)"));
      case "/stripes_shop/": {
        const stripes = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="4" fill="#000"/><rect x="2" width="2" height="4" fill="#fff"/></pattern></defs><rect width="300" height="300" fill="url(#p)"/></svg>')}`;
        return send(
          200,
          page(
            `<style>.bg{background-image:url("${stripes}");width:300px;height:300px}</style><header style="height:200px"><h2>stripes</h2></header>` +
              `<main><div style="display:grid;grid-template-columns:repeat(3,300px);gap:4px">` +
              `<a href="/p/1/"><img width="300" height="300" src="${stripes}"></a>` +
              `<a href="/p/2/"><div class="bg"></div></a>` +
              `<a href="/p/3/"><span id="host"></span></a></div></main>` +
              `<script>const r=document.getElementById("host").attachShadow({mode:"open"});r.innerHTML='<img width="300" height="300" src="${stripes}">';</script>`,
          ),
        );
      }
      case "/iframe_shop/":
        return send(200, profile(3).replace("<main>", `<iframe src="http://localhost:${port}/elsewhere/" width="10" height="10"></iframe><main>`));
      case "/few_posts/":
        return send(200, profile(3));
      case "/hop_shop/":
        res.writeHead(302, { location: "/example_shop/" });
        return res.end();
      case "/wall_shop/":
        return send(200, page(`<form><input name="username"><input name="password" type="password"><button>Log in</button></form>`));
      case "/login_redirect/":
        res.writeHead(302, { location: "/accounts/login/?next=%2Flogin_redirect%2F" });
        return res.end();
      case "/redirect_shop/":
        res.writeHead(302, { location: `http://localhost:${port}/elsewhere/` });
        return res.end();
      case "/jsnav_shop/":
        return send(200, page(`<header style="height:200px">x</header><script>location.href = "http://localhost:${port}/elsewhere/";</script>`));
      case "/private_shop/":
        return send(200, page(`<header style="height:200px"><h2>private</h2></header><h2>This account is private</h2>`));
      case "/rate_shop/":
        return send(429, page("Please wait a few minutes before you try again."));
      case "/empty_shop/":
        return send(200, page(""));
      default:
        return send(404, page("not found"));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    origin,
    requests,
    get lastHeaders() {
      return site.lastHeaders;
    },
    server,
    target: (username) => ({ url: `${origin}/${username}/`, allowNavigation: (u) => u.startsWith(`${origin}/`) }),
  };
}

// ------------------------------------------------------------------ layout

export type Layout = {
  root: string;
  state: string;
  queue: string;
  out: string;
  tmp: string;
  exportParent: string;
  exportDir: string;
  bin: string;
  record: string;
};

export function makeLayout(): Layout {
  const root = mkdtempSync(join(tmpdir(), "srdw-test-"));
  const l: Layout = {
    root,
    state: join(root, "state"),
    queue: join(root, "jobs"),
    out: join(root, "results"),
    tmp: join(root, "tmp"),
    exportParent: join(root, "Desktop"),
    exportDir: join(root, "Desktop", "second-root-codex-result"),
    bin: join(root, "bin"),
    record: join(root, "codex-record.jsonl"),
  };
  for (const d of [l.tmp, l.exportParent, l.bin, join(l.queue, "inbox")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return l;
}

export function writeJob(l: Layout, jobId: string, instagramUrl = "https://www.instagram.com/example_shop/", facts: Record<string, unknown> = FACTS, dir = "inbox"): string {
  mkdirSync(join(l.queue, dir), { recursive: true, mode: 0o700 });
  const path = join(l.queue, dir, `${jobId}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, job_id: jobId, facts, source: { instagram_url: instagramUrl } }), { mode: 0o600 });
  return path;
}

export type Step = { answer?: unknown; text?: string; exit?: number; stderr?: string; sleepMs?: number };

export const OK_STEPS: Step[] = [{ answer: { ...AMERICAN_EDITORIAL, rationale: [LEAK.rationale] } }, { answer: review() }];

/** A codex wrapper with the fake's settings baked in (the worker passes children an allowlisted environment). */
export function fakeCodex(l: Layout, steps: Step[], login: "chatgpt" | "apikey" | "none" = "chatgpt"): string {
  const stepsFile = join(l.root, `steps-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(stepsFile, JSON.stringify(steps));
  const path = join(l.bin, "codex");
  writeFileSync(
    path,
    `#!/bin/sh\nexport FAKE_CODEX_STEPS='${stepsFile}' FAKE_CODEX_STATE='${stepsFile}.state' FAKE_CODEX_RECORD='${l.record}' FAKE_CODEX_LOGIN='${login}'\nexec node '${FAKE_CODEX}' "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

export function codexCalls(l: Layout): Array<{ args: string[]; secretVars: string[]; apiKeyVars: string[]; tmpdir: string | null; strictSchema?: boolean }> {
  if (!existsSync(l.record)) return [];
  return readFileSync(l.record, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; secretVars: string[]; apiKeyVars: string[]; tmpdir: string | null; strictSchema?: boolean });
}

// ------------------------------------------------------------------ fake preview

export type PreviewLog = { renders: string[]; refsSeen: number[]; started: number };

export function fakePreview(l: Layout, log: PreviewLog, opts: { failRender?: boolean } = {}): WorkerOptions["startPreview"] {
  return async ({ previewRoot }) => {
    log.started += 1;
    const session: PreviewSession = {
      renderer: {
        async render(runId, candidate, shotsDir) {
          if (opts.failRender) throw Object.assign(new Error("boom"), { code: "PREVIEW_RENDER_FAILED" });
          if (!existsSync(join(previewRoot, runId, "facts.json"))) throw new Error("facts.json missing");
          if (candidate !== "none" && !existsSync(join(previewRoot, runId, `${candidate}.json`))) throw new Error("profile missing");
          log.renders.push(candidate);
          // the screenshots of the shop exist while the job runs
          const tmp = process.env.TMPDIR ?? "";
          const jobDir = readdirSync(tmp).find((n) => n.startsWith("job-"));
          log.refsSeen.push(jobDir ? readdirSync(join(tmp, jobDir, "refs")).length : -1);
          const shots = { desktop: join(shotsDir, `${candidate}-desktop.png`), mobile: join(shotsDir, `${candidate}-mobile.png`) };
          writeFileSync(shots.desktop, PNG);
          writeFileSync(shots.mobile, PNG);
          return { shots, overflow: [] };
        },
      },
      stop: async () => undefined,
    };
    return session;
  };
}

// ------------------------------------------------------------------ run

export const SECRET_ENV = {
  OPENAI_API_KEY: "sk-test-openai",
  CODEX_API_KEY: "sk-test-codex",
  ANTHROPIC_API_KEY: "sk-ant-test",
  GITHUB_TOKEN: "ghp_test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
};

export async function runWorker(l: Layout, site: MockSite, over: Partial<WorkerOptions> & { steps?: Step[]; login?: "chatgpt" | "apikey" | "none"; preview?: PreviewLog; failRender?: boolean } = {}) {
  const logs: string[] = [];
  const preview = over.preview ?? { renders: [], refsSeen: [], started: 0 };
  const codexBin = fakeCodex(l, over.steps ?? OK_STEPS, over.login);
  const report = await runDesignWorker({
    stateDir: l.state,
    queueRoot: l.queue,
    outRoot: l.out,
    tmpBase: l.tmp,
    exportDir: l.exportDir,
    workerSha: WORKER_SHA,
    maxJobs: 1,
    deadline: new RunDeadline(Date.now() + 30 * 60_000),
    env: { PATH: process.env.PATH, HOME: l.root, LANG: "C.UTF-8", CODEX_HOME: join(l.root, "codex-home"), ...SECRET_ENV },
    codexBin,
    log: (line) => logs.push(line),
    launchBrowser: (env) =>
      chromium.launch({ headless: true, env, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) }),
    startPreview: fakePreview(l, preview, { failRender: over.failRender }),
    captureTargetFor: (source) => site.target(source.username),
    captureSettleMs: 300,
    ...over,
  });
  return { report, logs, preview };
}

/** Every file under a directory, as text (for leak checks). */
export function allText(dir: string): string {
  if (!existsSync(dir)) return "";
  let out = "";
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (/\.(json|txt|log)$/.test(entry.name)) out += readFileSync(path, "utf8");
  }
  return out;
}
