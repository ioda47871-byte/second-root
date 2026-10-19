import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runBridgeOnce, type BridgeOptions } from "@/lib/design-agent/bridge/client";
import { bridgeSpool, writeHeartbeat, type BridgeSpool } from "@/lib/design-agent/bridge/spool";
import { bypassHeaders, bypassOrigin, BypassError, loadVercelBypass, readBypassFile, VERCEL_BYPASS_HEADER, type VercelBypass } from "@/lib/design-agent/bridge/vercel-bypass";

// DEV-059: the optional Vercel Protection Bypass of the local design bridge
// (docs/operations/design-bridge-access.md). Off by default, read from a
// private file only, sent only to the one configured *.vercel.app origin,
// never followed through a redirect, never printed.

const ALIAS = "https://second-root-git-develop-brot-yanagi.vercel.app";
const TOKEN = "bridge-token-0123456789abcdef-0123456789";

let base: string;
let spool: BridgeSpool;
let stateDir: string;
let secret: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "sr-bypass-test-"));
  spool = bridgeSpool(join(base, "spool"));
  await mkdir(spool.toWorker, { recursive: true });
  await mkdir(spool.fromWorker, { recursive: true });
  stateDir = join(base, "state");
  // shaped like a Vercel secret (32 characters), random per test so a leak is unambiguous
  secret = `Vb${randomBytes(15).toString("hex")}`;
});

async function bypassFile(mode = 0o600, content = `${secret}\n`) {
  const path = join(base, "design-bridge.vercel-bypass");
  await writeFile(path, content, { mode });
  await chmod(path, mode); // whatever the umask
  return path;
}

/** Everything a caller could print about an error. */
const shown = (error: unknown) => [String(error), (error as Error).message, (error as Error).stack ?? "", JSON.stringify(error)].join("\n");

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("the origin the header may go to", () => {
  it("is exactly one https://<name>.vercel.app origin, equal to the bridge API URL's", () => {
    expect(bypassOrigin(ALIAS, ALIAS)).toBe(ALIAS);
    expect(bypassOrigin(ALIAS, `${ALIAS}/api/internal/sales-design/jobs`)).toBe(ALIAS);
    const bad: [string, string][] = [
      ["http://second-root-git-develop-brot-yanagi.vercel.app", ALIAS],
      [`${ALIAS}/`, ALIAS], // a trailing slash is not the exact origin
      [`${ALIAS}:8443`, ALIAS],
      [`${ALIAS}/api`, ALIAS],
      [`${ALIAS}?x=1`, ALIAS],
      ["https://user:pw@second-root-git-develop-brot-yanagi.vercel.app", ALIAS],
      ["https://Second-Root-Git-Develop-Brot-Yanagi.vercel.app", ALIAS],
      ["https://secondroot.jp", "https://secondroot.jp"], // the Production custom domain: never
      ["https://vercel.app", "https://vercel.app"],
      ["https://a.b.vercel.app", "https://a.b.vercel.app"],
      ["https://second-root-git-develop-brot-yanagi.vercel.app.evil.example", "https://second-root-git-develop-brot-yanagi.vercel.app.evil.example"],
      ["https://second-root-75vcnoz75-brot-yanagi.vercel.app", ALIAS], // another deployment than the API URL
      [ALIAS, "https://secondroot.jp"],
      [ALIAS, "not a url"],
      ["not a url", ALIAS],
    ];
    for (const [origin, api] of bad) expect(() => bypassOrigin(origin, api), `${origin} for ${api}`).toThrow(BypassError);
  });

  it("the header is attached to a request for exactly that origin and to nothing else", () => {
    const bypass: VercelBypass = { origin: ALIAS, value: secret };
    expect(bypassHeaders(bypass, `${ALIAS}/api/internal/sales-design/jobs`)).toEqual({ [VERCEL_BYPASS_HEADER]: secret });
    for (const other of ["https://secondroot.jp/api/internal/sales-design/jobs", "http://second-root-git-develop-brot-yanagi.vercel.app/x", `${ALIAS}.evil.example/x`, "https://second-root-75vcnoz75-brot-yanagi.vercel.app/x", "nonsense"]) {
      expect(bypassHeaders(bypass, other)).toEqual({});
    }
    expect(bypassHeaders(null, `${ALIAS}/x`)).toEqual({});
  });
});

describe("the bypass file", () => {
  it("is read only as a regular, single-link file of this user with mode exactly 0600 (the cycle's rule)", async () => {
    const path = await bypassFile();
    expect(await readBypassFile(path)).toBe(secret);
    for (const mode of [0o640, 0o604, 0o644, 0o660, 0o606, 0o620, 0o602, 0o610, 0o400, 0o700, 0o4600]) {
      await chmod(path, mode);
      expect(await caught(readBypassFile(path))).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" });
    }
    await chmod(path, 0o600);
    expect(await caught(readBypassFile(path, 12345))).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" }); // another owner
    const linked = join(base, "linked");
    await symlink(path, linked);
    expect(await caught(readBypassFile(linked))).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" });
    const hard = join(base, "hard");
    await link(path, hard);
    expect(await caught(readBypassFile(hard))).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" });
    expect(await caught(readBypassFile(join(base, "missing")))).toMatchObject({ code: "BRIDGE_BYPASS_NOT_CONFIGURED" });
    expect(await caught(readBypassFile("relative/path"))).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" });
    await mkdir(join(base, "dir"), { mode: 0o700 });
    expect(await caught(readBypassFile(join(base, "dir")))).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" });
    // a FIFO is refused at once (opened non-blocking, then not a regular file), never waited on
    const fifo = join(base, "fifo");
    expect(spawnSync("mkfifo", ["-m", "600", fifo]).status).toBe(0);
    expect(await caught(readBypassFile(fifo))).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" });
  });

  it("holds one visible value of 16–256 characters, at most 512 bytes", async () => {
    for (const content of ["short", `${secret} ${secret}`, `${secret}\n${secret}`, "x".repeat(300), "", `${secret}\u0000`]) {
      const path = await bypassFile(0o600, content);
      expect(await caught(readBypassFile(path)), JSON.stringify(content.slice(0, 20))).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" });
    }
    const big = await bypassFile(0o600, `${secret}${" ".repeat(600)}`);
    expect(await caught(readBypassFile(big))).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" });
  });

  it("never puts the value in an error", async () => {
    // a value of the right shape but refused (equal to the bridge token), and a malformed one
    const path = await bypassFile(0o600, `${TOKEN}\n`);
    const equal = await caught(loadVercelBypass({ file: path, origin: ALIAS, apiUrl: ALIAS, token: TOKEN }));
    expect(equal).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" });
    expect(shown(equal)).not.toContain(TOKEN);
    const malformed = await bypassFile(0o600, `${secret} trailing-word`);
    const error = await caught(readBypassFile(malformed));
    expect(shown(error)).not.toContain(secret);
    expect(shown(error)).not.toContain(malformed);
    const unsafe = await bypassFile(0o644);
    expect(shown(await caught(readBypassFile(unsafe)))).not.toContain(secret);
  });
});

describe("the settings", () => {
  it("is off with neither setting, and refuses one without the other", async () => {
    expect(await loadVercelBypass({ apiUrl: ALIAS, token: TOKEN })).toBeNull();
    expect(await loadVercelBypass({ file: "", origin: "", apiUrl: ALIAS, token: TOKEN })).toBeNull();
    const path = await bypassFile();
    expect(await caught(loadVercelBypass({ file: path, apiUrl: ALIAS, token: TOKEN }))).toMatchObject({ code: "BRIDGE_BYPASS_NOT_CONFIGURED" });
    expect(await caught(loadVercelBypass({ origin: ALIAS, apiUrl: ALIAS, token: TOKEN }))).toMatchObject({ code: "BRIDGE_BYPASS_NOT_CONFIGURED" });
    expect(await caught(loadVercelBypass({ file: path, origin: ALIAS, apiUrl: "https://secondroot.jp", token: TOKEN }))).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" });
    expect(await loadVercelBypass({ file: path, origin: ALIAS, apiUrl: ALIAS, token: TOKEN })).toEqual({ origin: ALIAS, value: secret });
  });
});

describe("one bridge pass with the bypass", () => {
  type Call = { url: string; init: RequestInit };
  let calls: Call[];
  const answers: { status: number; body: unknown }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = answers.shift() ?? { status: 200, body: { job: null } };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  };
  const lines: string[] = [];
  const options = (extra: Partial<BridgeOptions> = {}): BridgeOptions => ({ spool, stateDir, apiUrl: ALIAS, token: TOKEN, fetch: fakeFetch, log: (l) => lines.push(l), ...extra });
  const headersOf = (c: Call) => new Headers(c.init.headers);

  beforeEach(async () => {
    calls = [];
    answers.length = 0;
    lines.length = 0;
    await writeHeartbeat(spool.fromWorker, new Date());
  });

  it("sends the header (with the bridge token, never instead of it) and never follows a redirect", async () => {
    const bypass = await loadVercelBypass({ file: await bypassFile(), origin: ALIAS, apiUrl: ALIAS, token: TOKEN });
    expect(await runBridgeOnce(options({ vercelBypass: bypass }))).toMatchObject({ stopped: null, claimed: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${ALIAS}/api/internal/sales-design/jobs`);
    expect(headersOf(calls[0]!).get(VERCEL_BYPASS_HEADER)).toBe(secret);
    expect(headersOf(calls[0]!).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.init.redirect).toBe("error");
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("sends no bypass header when it is off", async () => {
    await runBridgeOnce(options());
    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0]!).has(VERCEL_BYPASS_HEADER)).toBe(false);
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("refuses a bypass for another origin than the API URL's without sending anything", async () => {
    const elsewhere: VercelBypass = { origin: "https://second-root-75vcnoz75-brot-yanagi.vercel.app", value: secret };
    expect(await caught(runBridgeOnce(options({ vercelBypass: elsewhere })))).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" });
    expect(await caught(runBridgeOnce(options({ apiUrl: "https://secondroot.jp", vercelBypass: { origin: ALIAS, value: secret } })))).toMatchObject({ code: "BRIDGE_BYPASS_UNSAFE" });
    expect(calls).toHaveLength(0);
  });

  it("a failed request never shows the value, even when the error text carries it", async () => {
    const bypass = await loadVercelBypass({ file: await bypassFile(), origin: ALIAS, apiUrl: ALIAS, token: TOKEN });
    const leaky: typeof fetch = async (_input, init) => {
      throw new TypeError(`fetch failed: ${JSON.stringify(init?.headers)}`);
    };
    const report = await runBridgeOnce(options({ vercelBypass: bypass, fetch: leaky }));
    expect(report.stopped).toBe("BRIDGE_API_UNAVAILABLE");
    for (const text of [JSON.stringify(report), lines.join("\n")]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(TOKEN);
    }
  });

  it("tells Vercel's own 401 (blocked before the API) from the bridge API's 401", async () => {
    const vercel401 = { protection: { password_enabled: false, vercel_auth_enabled: true }, message: "Protected by Vercel Authentication", error: { code: "401", message: "Protected by Vercel Authentication" } };
    answers.push({ status: 401, body: vercel401 });
    expect(await runBridgeOnce(options())).toMatchObject({ stopped: "BRIDGE_PROTECTION_BLOCKED", claimed: null });
    answers.push({ status: 401, body: null }); // not JSON at all
    expect(await runBridgeOnce(options())).toMatchObject({ stopped: "BRIDGE_PROTECTION_BLOCKED" });
    answers.push({ status: 401, body: { error: "unauthorized" } });
    expect(await runBridgeOnce(options())).toMatchObject({ stopped: "BRIDGE_UNAUTHORIZED" });
  });

  it("real fetch: a redirect is not followed, so neither the token nor any header reaches the redirect target", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const target = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" }).end('{"job":null}');
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as { port: number }).port;
    const redirector = createServer((_req, res) => res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/api/internal/sales-design/jobs` }).end());
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const port = (redirector.address() as { port: number }).port;
    try {
      const report = await runBridgeOnce({ spool, stateDir, apiUrl: `http://127.0.0.1:${port}`, token: TOKEN, allowLocalHttp: true, log: (l) => lines.push(l) });
      expect(report.stopped).toBe("BRIDGE_API_UNAVAILABLE");
    } finally {
      redirector.close();
      target.close();
    }
    expect(seen).toEqual([]);
  });
});

describe("bridge.ts with the bypass settings", () => {
  const tsx = join(process.cwd(), "node_modules/.bin/tsx");
  const script = join(process.cwd(), "scripts/sales-design-bridge/bridge.ts");
  const run = (env: Record<string, string>) =>
    new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn(tsx, [script, "--deliver-only"], { env: { PATH: process.env.PATH ?? "", HOME: base, XDG_STATE_HOME: join(base, "xdg"), ...env } as unknown as NodeJS.ProcessEnv, timeout: 20_000 });
      let out = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (out += String(d)));
      child.on("close", (status) => resolve({ status, out }));
    });

  it("stops with a fixed code before any request when the file or origin is unsafe, and never prints the value, path or origin", async () => {
    const tokenFile = join(base, "bridge.token");
    await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    const file = await bypassFile(0o644);
    const common = { SR_DESIGN_BRIDGE_API_URL: ALIAS, SR_DESIGN_BRIDGE_TOKEN_FILE: tokenFile, SR_DESIGN_BRIDGE_SPOOL: join(base, "spool") };
    const unsafe = await run({ ...common, SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE: file, SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN: ALIAS });
    expect(unsafe).toEqual({ status: 3, out: "stopped: BRIDGE_BYPASS_UNSAFE\n" });
    await chmod(file, 0o600);
    const mismatch = await run({ ...common, SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE: file, SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN: "https://second-root-75vcnoz75-brot-yanagi.vercel.app" });
    expect(mismatch).toEqual({ status: 3, out: "stopped: BRIDGE_BYPASS_UNSAFE\n" });
    const half = await run({ ...common, SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE: file });
    expect(half).toEqual({ status: 3, out: "stopped: BRIDGE_BYPASS_NOT_CONFIGURED\n" });
    for (const r of [unsafe, mismatch, half]) {
      expect(r.out).not.toContain(secret);
      expect(r.out).not.toContain(file);
      expect(r.out).not.toContain("vercel.app");
    }
  }, 60_000);

  it("with a valid bypass: one fixed line that it is in use, the run and its summary unchanged, the value never shown", async () => {
    const tokenFile = join(base, "bridge.token");
    await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    const file = await bypassFile();
    // --deliver-only with nothing to deliver sends no request, so this needs no network
    const r = await run({
      SR_DESIGN_BRIDGE_API_URL: ALIAS,
      SR_DESIGN_BRIDGE_TOKEN_FILE: tokenFile,
      SR_DESIGN_BRIDGE_SPOOL: join(base, "spool"),
      SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE: file,
      SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN: ALIAS,
    });
    expect(r).toEqual({
      status: 0,
      out: "vercel protection bypass in use (configured origin only)\nbridge: delivered 0, superseded 0, refused 0, expired 0, claimed none (BRIDGE_DELIVER_ONLY)\n",
    });
    expect(r.out).not.toContain(secret);
  }, 60_000);

  it("the bridge's run.sh passes only the bypass file path and origin, never a value", async () => {
    const runSh = await readFile(join(process.cwd(), "scripts/sales-design-bridge/run.sh"), "utf8");
    const keep = /for name in ([\s\S]*?); do/.exec(runSh)![1]!.split(/[\s\\]+/).filter(Boolean);
    expect(keep.filter((n) => /BYPASS/.test(n)).sort()).toEqual(["SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE", "SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN"]);
  });
});
