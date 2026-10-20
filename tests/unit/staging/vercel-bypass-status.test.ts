import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BRIDGE_NOTE, bypassStatus, getOnly, redactLine } from "../../../scripts/staging/vercel-bypass-status.mjs";

// The read-only Vercel status for the design bridge (DEV-063). No network: fetch is mocked.
// Vercel returns the bypass secrets as the KEYS of protectionBypass; they must never be printed.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const secret = () => randomBytes(16).toString("hex");

function project(opts: { sso?: unknown; bypass?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  return {
    id: "prj_EdI3HMmSZ6NmtTFSqp1nscyYnHGS",
    name: "second-root",
    ssoProtection: opts.sso === undefined ? { deploymentType: "all_except_custom_domains" } : opts.sso,
    passwordProtection: null,
    trustedIps: null,
    optionsAllowlist: null,
    protectionBypass: opts.bypass ?? {},
    ...opts.extra,
  };
}

function api(responses: { project: unknown; envs?: unknown[]; deployment?: unknown; status?: number }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    let body: unknown;
    if (/^\/v9\/projects\/[^/]+$/.test(path)) body = responses.project;
    else if (/^\/v9\/projects\/[^/]+\/env$/.test(path)) body = { envs: responses.envs ?? [] };
    else if (path.startsWith("/v13/deployments/")) body = responses.deployment ?? { id: "dpl_x", readyState: "READY", meta: { githubCommitSha: SHA, githubCommitRef: "develop" } };
    else return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: responses.status ?? 200 });
  });
  return { fetchImpl, calls };
}

async function status(responses: Parameters<typeof api>[0], argv: string[] = [], env: Record<string, string> = { HTTPS_PROXY: "http://proxy.invalid" }) {
  const { fetchImpl, calls } = api(responses);
  const lines: string[] = [];
  const code = await bypassStatus({ argv, env, fetchImpl: fetchImpl as unknown as typeof fetch, log: (l: string) => lines.push(l) });
  return { code, out: lines.join("\n"), last: lines[lines.length - 1], calls };
}

describe("vercel-bypass-status: what it shows", () => {
  it("Authentication on, three secrets, the bridge's present: counts and notes, never a key", async () => {
    const keys = [secret(), secret(), secret()];
    const r = await status({
      project: project({
        bypass: {
          [keys[0]]: { createdAt: Date.UTC(2026, 7, 22), createdBy: "u", scope: "automation-bypass", isEnvVar: true },
          [keys[1]]: { createdAt: Date.UTC(2026, 8, 28), createdBy: "u", scope: "automation-bypass", note: "Second Root Staging Claude", isEnvVar: false },
          [keys[2]]: { createdAt: Date.UTC(2026, 9, 19), createdBy: "u", scope: "automation-bypass", note: BRIDGE_NOTE, isEnvVar: false },
        },
      }),
      envs: [
        { key: "SALES_AI_DESIGN_ENABLED", type: "plain", value: "false", target: ["preview"], gitBranch: "develop" },
        { key: "SALES_AI_DESIGN_ENABLED", type: "plain", value: "true", target: ["production"] },
      ],
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Vercel Authentication: on (all_except_custom_domains)");
    expect(r.out).toContain("Password Protection: off");
    expect(r.out).toContain("Trusted IPs: off");
    expect(r.out).toContain("OPTIONS Allowlist: off");
    expect(r.out).toContain("Protection Bypass for Automation: 3 secret(s)");
    expect(r.out).toContain("#1 created 2026-08-22, note (none), isEnvVar true");
    expect(r.out).toContain('#2 created 2026-09-28, note "Second Root Staging Claude", isEnvVar false');
    expect(r.out).toContain(`#3 created 2026-10-19, note ${JSON.stringify(BRIDGE_NOTE)}, isEnvVar false`);
    expect(r.out).toContain(": present");
    expect(r.out).toContain('SALES_AI_DESIGN_ENABLED (Preview, develop): "false"');
    expect(r.out).not.toContain('"true"'); // the Production value is not this one
    expect(r.out).toContain(`second-root-git-develop-brot-yanagi.vercel.app: deployment dpl_x, READY, commit ${SHA} (develop)`);
    expect(r.last).toBe("VERCEL_BYPASS_STATUS OK auth=on bridge_secret=present");
    for (const k of keys) expect(r.out).not.toContain(k);
  });

  it("a key that leaks into a note, a field or the deployment is still redacted", async () => {
    const key = secret();
    const r = await status({
      project: project({ bypass: { [key]: { createdAt: 1, scope: "automation-bypass", note: `copy of ${key}`, isEnvVar: false } }, extra: { name: `second-root ${key}` } }),
      deployment: { id: key, readyState: "READY", meta: { githubCommitRef: key } },
    });
    expect(r.out).not.toContain(key);
    expect(r.out).toContain("[redacted]");
  });

  it("the bridge's secret absent, or only as an env var", async () => {
    const absent = await status({ project: project({ bypass: { [secret()]: { createdAt: 1, scope: "automation-bypass", note: "other" } } }) });
    expect(absent.code).toBe(0);
    expect(absent.last).toBe("VERCEL_BYPASS_STATUS OK auth=on bridge_secret=absent");
    const asEnv = await status({ project: project({ bypass: { [secret()]: { createdAt: 1, scope: "automation-bypass", note: BRIDGE_NOTE, isEnvVar: true } } }) });
    expect(asEnv.last).toBe("VERCEL_BYPASS_STATUS OK auth=on bridge_secret=env_var");
    expect(asEnv.out).toContain("only as an env var");
  });

  it("counts shareable links apart from the automation secrets", async () => {
    const r = await status({ project: project({ bypass: { [secret()]: { createdAt: 1, scope: "automation-bypass" }, [secret()]: { createdAt: 2, scope: "shareable-link" } } }) });
    expect(r.out).toContain("Protection Bypass for Automation: 1 secret(s) (+1 of another kind)");
  });

  it("a flag value that is not a plain on/off value is not shown", async () => {
    const value = secret();
    const r = await status({ project: project(), envs: [{ key: "SALES_AI_DESIGN_ENABLED", type: "encrypted", value, target: ["preview", "development"] }] });
    expect(r.out).toContain("SALES_AI_DESIGN_ENABLED (Preview, all Preview branches): set (encrypted, not shown)");
    expect(r.out).not.toContain(value);
    const plainOdd = await status({ project: project(), envs: [{ key: "SALES_AI_DESIGN_ENABLED", type: "plain", value, target: ["preview"], gitBranch: "develop" }] });
    expect(plainOdd.out).not.toContain(value);
    const none = await status({ project: project(), envs: [{ key: "SALES_AI_DESIGN_ENABLED", type: "plain", value: "true", target: ["preview"], gitBranch: "feature/x" }] });
    expect(none.out).toContain("SALES_AI_DESIGN_ENABLED (Preview, develop): not set");
  });

  it("the deployment that cannot be read is reported, not fatal", async () => {
    const { fetchImpl } = api({ project: project() });
    const wrapped = vi.fn(async (url: string, init: RequestInit) => (url.includes("/v13/") ? new Response("{}", { status: 404 }) : fetchImpl(url, init)));
    const lines: string[] = [];
    const code = await bypassStatus({ argv: [], env: { HTTPS_PROXY: "http://p.invalid" }, fetchImpl: wrapped as unknown as typeof fetch, log: (l: string) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("deployment not read (Vercel GET /v13/deployments/second-root-git-develop-brot-yanagi.vercel.app 404)");
  });
});

describe("vercel-bypass-status: fail closed", () => {
  it("Authentication off → VERCEL_AUTH_NOT_ON, exit 3", async () => {
    const r = await status({ project: project({ sso: null }) });
    expect(r.code).toBe(3);
    expect(r.out).toContain("Vercel Authentication: OFF");
    expect(r.out).toContain("WARNING: Vercel Authentication is OFF");
    expect(r.last).toBe("VERCEL_BYPASS_STATUS VERCEL_AUTH_NOT_ON auth=off bridge_secret=absent");
  });

  it("an API error → STATUS_FAILED, exit 1, the body never quoted", async () => {
    const key = secret();
    const { fetchImpl } = api({ project: project() });
    const failing = vi.fn(async () => new Response(JSON.stringify({ error: { message: key } }), { status: 403 }));
    const lines: string[] = [];
    const code = await bypassStatus({ argv: [], env: { HTTPS_PROXY: "http://p.invalid" }, fetchImpl: failing as unknown as typeof fetch, log: (l: string) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).not.toContain(key);
    expect(lines.at(-1)).toBe("VERCEL_BYPASS_STATUS STATUS_FAILED auth=unknown bridge_secret=unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("no credential, a short token, or unknown options → STATUS_FAILED without a request", async () => {
    for (const [argv, env] of [
      [[], {}],
      [[], { VERCEL_TOKEN: "short" }],
      [["--apply"], { HTTPS_PROXY: "http://p.invalid" }],
      [["--alias", "secondroot.jp"], { HTTPS_PROXY: "http://p.invalid" }],
    ] as [string[], Record<string, string>][]) {
      const r = await status({ project: project() }, argv, env);
      expect(r.code).toBe(1);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("only GET: every request is a GET without a body, to api.vercel.com, redirects refused", async () => {
    const token = `vercel_${secret()}`;
    const r = await status({ project: project() }, ["--team", "team_abc"], { VERCEL_TOKEN: token });
    expect(r.code).toBe(0);
    expect(r.calls.length).toBe(3);
    for (const c of r.calls) {
      expect(c.init.method).toBe("GET");
      expect(c.init.body).toBeUndefined();
      expect(c.init.redirect).toBe("error");
      expect(c.url.startsWith("https://api.vercel.com/")).toBe(true);
      expect(c.url).toContain("teamId=team_abc");
    }
    expect(r.out).not.toContain(token);
  });

  it("getOnly refuses any other method, a body, or another host before sending", () => {
    const inner = vi.fn();
    const get = getOnly(inner as unknown as typeof fetch);
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "post"]) expect(() => get("https://api.vercel.com/v9/projects/x", { method })).toThrow(/refused/);
    expect(() => get("https://api.vercel.com/v9/projects/x", { body: "{}" })).toThrow(/refused/);
    expect(() => get("https://example.com/v9/projects/x", {})).toThrow(/refused/);
    expect(inner).not.toHaveBeenCalled();
  });

  it("redactLine removes every secret and control character", () => {
    expect(redactLine("a\u001b[31mb SECRET c", ["SECRET"])).toBe("a [31mb [redacted] c");
  });
});
