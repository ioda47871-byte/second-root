import { describe, expect, it, vi } from "vitest";
import { ALIAS, designFlag, guardedFetch, parseUntil, PROJECT, VERCEL_API } from "../../../scripts/staging/design-flag.mjs";

// DEV-064: the Staging design flag window. No network: a stateful mock of the
// Vercel API. Only Preview develop records may change, the time box is written
// before the flag, and Production is never in reach.

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const UNTIL_OK = iso(NOW + 2 * 60 * 60 * 1000);

type Env = { id: string; key: string; value?: string; type: string; target: string[]; gitBranch?: string | null; updatedAt?: number };

function vercel(opts: { envs?: Env[]; productionBranch?: string; deployment?: Record<string, unknown> | null; failWrites?: number; failStatus?: number; hiddenProd?: number } = {}) {
  let clock = NOW - 60_000;
  const envs: Env[] = (
    opts.envs ?? [{ id: "rMGvxH8aHWZZC5Z5", key: "SALES_AI_DESIGN_ENABLED", value: "false", type: "plain", target: ["preview"], gitBranch: "develop" }]
  ).map((e) => ({ updatedAt: NOW - 3_600_000, ...e }));
  envs.push({ id: "otherSecretVar01", key: "SUPABASE_SERVICE_ROLE_KEY", value: "do-not-print-me", type: "plain", target: ["production", "preview"] });
  const writes: { method: string; path: string; body: unknown }[] = [];
  const state = { deployment: opts.deployment === undefined ? { id: "dpl_x", readyState: "READY", createdAt: NOW, meta: { githubCommitSha: SHA } } : opts.deployment };
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = String(init.method);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") {
      writes.push({ method, path, body });
      if (opts.failWrites) return new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: opts.failStatus ?? 403 });
    }
    clock += 1000;
    if (method === "GET" && path === `/v9/projects/${PROJECT}`) return Response.json({ name: "second-root", link: { productionBranch: opts.productionBranch ?? "main" } });
    if (method === "GET" && path === `/v9/projects/${PROJECT}/env`) return Response.json({ envs, hiddenProductionEnvCount: opts.hiddenProd ?? 0 });
    if (method === "GET" && path === `/v13/deployments/${ALIAS}`) return state.deployment ? Response.json(state.deployment) : new Response("{}", { status: 404 });
    if (method === "PATCH") {
      const e = envs.find((x) => path.endsWith(`/env/${x.id}`));
      if (!e) return new Response("{}", { status: 404 });
      e.value = body.value;
      e.updatedAt = clock;
      return Response.json(e);
    }
    if (method === "POST" && path === `/v10/projects/${PROJECT}/env`) {
      const e = { id: "untilVarId000001", ...body, updatedAt: clock };
      envs.push(e);
      return Response.json({ created: e });
    }
    return new Response("{}", { status: 404 });
  });
  return { fetchImpl, envs, writes, state };
}

async function run(api: ReturnType<typeof vercel>, argv: string[], now = NOW) {
  const lines: string[] = [];
  const code = await designFlag({
    argv,
    env: { HTTPS_PROXY: "http://proxy.invalid" },
    fetchImpl: api.fetchImpl as unknown as typeof fetch,
    log: (l: string) => lines.push(l),
    now: () => now,
  });
  return { code, out: lines.join("\n"), last: lines[lines.length - 1] };
}

const flagOf = (api: ReturnType<typeof vercel>) => api.envs.find((e) => e.key === "SALES_AI_DESIGN_ENABLED")!.value;
const untilOfApi = (api: ReturnType<typeof vercel>) => api.envs.find((e) => e.key === "SALES_AI_DESIGN_ENABLED_UNTIL")?.value;

describe("design-flag: status", () => {
  it("reads only, shows the flag, the time box, the production branch and the alias; never other values", async () => {
    const api = vercel();
    const r = await run(api, ["status"]);
    expect(r.code).toBe(0);
    expect(api.writes).toEqual([]);
    expect(r.out).toContain('production branch "main"');
    expect(r.out).toContain("SALES_AI_DESIGN_ENABLED (Preview, develop): false (record rMGvxH8aHWZZC5Z5)");
    expect(r.out).toContain("SALES_AI_DESIGN_ENABLED_UNTIL (Preview, develop): none");
    expect(r.out).not.toContain("do-not-print-me");
    expect(r.last).toBe("DESIGN_FLAG STATUS flag=false until=none");
  });
});

describe("design-flag: on", () => {
  it("writes the time box first, then the flag; both Preview develop only", async () => {
    const api = vercel();
    const r = await run(api, ["on", "--until", UNTIL_OK]);
    expect(r.code).toBe(0);
    expect(r.last).toBe(`DESIGN_FLAG ON_WRITTEN flag=true until=${UNTIL_OK}`);
    expect(api.writes.map((w) => `${w.method} ${w.path}`)).toEqual([`POST /v10/projects/${PROJECT}/env`, `PATCH /v9/projects/${PROJECT}/env/rMGvxH8aHWZZC5Z5`]);
    expect(api.writes[0]!.body).toEqual({ key: "SALES_AI_DESIGN_ENABLED_UNTIL", value: UNTIL_OK, type: "plain", target: ["preview"], gitBranch: "develop" });
    expect(api.writes[1]!.body).toEqual({ value: "true" });
    expect(flagOf(api)).toBe("true");
  });

  it("an existing time box is updated in place, not duplicated", async () => {
    const api = vercel({
      envs: [
        { id: "rMGvxH8aHWZZC5Z5", key: "SALES_AI_DESIGN_ENABLED", value: "false", type: "plain", target: ["preview"], gitBranch: "develop" },
        { id: "untilVarId000009", key: "SALES_AI_DESIGN_ENABLED_UNTIL", value: "2026-10-01T00:00:00Z", type: "plain", target: ["preview"], gitBranch: "develop" },
      ],
    });
    const r = await run(api, ["on", "--until", UNTIL_OK]);
    expect(r.code).toBe(0);
    expect(api.writes[0]).toEqual({ method: "PATCH", path: `/v9/projects/${PROJECT}/env/untilVarId000009`, body: { value: UNTIL_OK } });
    expect(api.envs.filter((e) => e.key === "SALES_AI_DESIGN_ENABLED_UNTIL")).toHaveLength(1);
  });

  it.each([
    ["29 minutes ahead", iso(NOW + 29 * 60 * 1000)],
    ["more than 4 hours ahead", iso(NOW + 4 * 60 * 60 * 1000 + 1000)],
    ["in the past", iso(NOW - 1000)],
    ["not UTC Z", "2026-10-20T23:00:00+09:00"],
    ["with milliseconds", "2026-10-20T14:00:00.000Z"],
    ["not a real date", "2026-02-31T14:00:00Z"],
  ])("--until %s: refused, nothing written", async (_name, until) => {
    const api = vercel();
    const r = await run(api, ["on", "--until", until]);
    expect(r.code).toBe(1);
    expect(api.writes).toEqual([]);
    expect(r.last).toMatch(/^DESIGN_FLAG FAILED /);
  });

  it("refuses when the production branch is not main", async () => {
    const api = vercel({ productionBranch: "develop" });
    const r = await run(api, ["on", "--until", UNTIL_OK]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("not main");
    expect(api.writes).toEqual([]);
  });

  it.each([
    ["a Production record of the flag", { id: "prodFlagVar00001", key: "SALES_AI_DESIGN_ENABLED", value: "false", type: "plain", target: ["production"] }],
    ["a record for all Preview branches", { id: "allPreviewVar001", key: "SALES_AI_DESIGN_ENABLED", value: "false", type: "plain", target: ["preview"], gitBranch: null }],
    ["a record shared by Preview and Production", { id: "sharedUntilVar01", key: "SALES_AI_DESIGN_ENABLED_UNTIL", value: "2026-10-20T13:00:00Z", type: "plain", target: ["preview", "production"], gitBranch: null }],
    ["an encrypted record", { id: "encUntilVar00001", key: "SALES_AI_DESIGN_ENABLED_UNTIL", type: "encrypted", target: ["preview"], gitBranch: "develop" }],
  ])("refuses with %s present (nothing written)", async (_name, extra) => {
    const api = vercel({
      envs: [{ id: "rMGvxH8aHWZZC5Z5", key: "SALES_AI_DESIGN_ENABLED", value: "false", type: "plain", target: ["preview"], gitBranch: "develop" }, extra as Env],
    });
    for (const argv of [["on", "--until", UNTIL_OK], ["off"]]) {
      const r = await run(api, argv);
      expect(r.code).toBe(1);
      expect(r.out).toContain("refused");
    }
    expect(api.writes).toEqual([]);
  });

  it("refuses without exactly one flag record", async () => {
    const api = vercel({ envs: [] });
    const r = await run(api, ["on", "--until", UNTIL_OK]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("found 0");
    expect(api.writes).toEqual([]);
  });

  it("a write Vercel refuses (403): stops at the first write, the flag stays false", async () => {
    const api = vercel({ failWrites: 1 });
    const r = await run(api, ["on", "--until", UNTIL_OK]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("403");
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]!.method).toBe("POST");
    expect(flagOf(api)).toBe("false");
  });
});

describe("design-flag: off", () => {
  it("sets false; the time box stays (harmless with the flag false)", async () => {
    const api = vercel();
    await run(api, ["on", "--until", UNTIL_OK]);
    const r = await run(api, ["off"]);
    expect(r.code).toBe(0);
    expect(r.last).toBe(`DESIGN_FLAG OFF_WRITTEN flag=false until=${UNTIL_OK}`);
    expect(api.writes.at(-1)).toEqual({ method: "PATCH", path: `/v9/projects/${PROJECT}/env/rMGvxH8aHWZZC5Z5`, body: { value: "false" } });
    expect(flagOf(api)).toBe("false");
  });

  it("already false: writes nothing (safe to run twice, e.g. by the recovery session)", async () => {
    const api = vercel();
    const r = await run(api, ["off"]);
    expect(r.code).toBe(0);
    expect(r.last).toBe("DESIGN_FLAG ALREADY_OFF flag=false until=none");
    expect(api.writes).toEqual([]);
  });
});

describe("design-flag: verify", () => {
  it("on: VERIFIED_ON only with a READY deployment of the commit built after the change", async () => {
    const api = vercel({ deployment: { id: "dpl_old", readyState: "READY", createdAt: NOW - 120_000, meta: { githubCommitSha: OTHER } } });
    await run(api, ["on", "--until", UNTIL_OK]);
    let r = await run(api, ["verify", "--expect", "on", "--sha", SHA]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("not ");
    expect(r.out).toContain("built before");
    api.state.deployment = { id: "dpl_new", readyState: "BUILDING", createdAt: NOW + 60_000, meta: { githubCommitSha: SHA } };
    r = await run(api, ["verify", "--expect", "on", "--sha", SHA]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("not READY");
    api.state.deployment = { id: "dpl_new", readyState: "READY", createdAt: NOW + 60_000, meta: { githubCommitSha: SHA } };
    r = await run(api, ["verify", "--expect", "on", "--sha", SHA]);
    expect(r.code).toBe(0);
    expect(r.last).toBe(`DESIGN_FLAG VERIFIED_ON flag=true until=${UNTIL_OK}`);
    expect(api.writes).toHaveLength(2);
  });

  it("on: a time box that has passed reads as off", async () => {
    const api = vercel();
    await run(api, ["on", "--until", UNTIL_OK]);
    api.state.deployment = { id: "dpl_new", readyState: "READY", createdAt: NOW + 60_000, meta: { githubCommitSha: SHA } };
    const r = await run(api, ["verify", "--expect", "on", "--sha", SHA], parseUntil(UNTIL_OK));
    expect(r.code).toBe(2);
    expect(r.out).toContain("passed");
    const off = await run(api, ["verify", "--expect", "off", "--sha", SHA], parseUntil(UNTIL_OK));
    // a passed time box is not "off": the flag itself must be false
    expect(off.code).toBe(2);
    expect(off.out).toContain("SALES_AI_DESIGN_ENABLED is true, not false");
  });

  it("off: VERIFIED_OFF after the flag is false and redeployed", async () => {
    const api = vercel();
    await run(api, ["on", "--until", UNTIL_OK]);
    await run(api, ["off"]);
    api.state.deployment = { id: "dpl_off", readyState: "READY", createdAt: NOW + 600_000, meta: { githubCommitSha: OTHER } };
    const r = await run(api, ["verify", "--expect", "off", "--sha", OTHER]);
    expect(r.code).toBe(0);
    expect(r.last).toBe(`DESIGN_FLAG VERIFIED_OFF flag=false until=${UNTIL_OK}`);
  });

  it("bad arguments are refused before any request", async () => {
    const api = vercel();
    for (const argv of [["verify", "--expect", "maybe", "--sha", SHA], ["verify", "--expect", "on"], ["on"], ["off", "--until", UNTIL_OK], ["promote"], []]) {
      const r = await run(api, argv);
      expect(r.code).toBe(1);
    }
    expect(api.writes).toEqual([]);
  });
});

describe("guardedFetch: only the listed requests leave", () => {
  const ok = vi.fn(async () => Response.json({}));
  const g = guardedFetch(ok as unknown as typeof fetch);
  const P = `${VERCEL_API}/v9/projects/${PROJECT}`;

  it.each([
    ["DELETE an env var", `${P}/env/rMGvxH8aHWZZC5Z5`, { method: "DELETE" }],
    ["PATCH an env var's target", `${P}/env/rMGvxH8aHWZZC5Z5`, { method: "PATCH", body: JSON.stringify({ value: "true", target: ["production"] }) }],
    ["POST the flag itself", `${VERCEL_API}/v10/projects/${PROJECT}/env`, { method: "POST", body: JSON.stringify({ key: "SALES_AI_DESIGN_ENABLED", value: "true", type: "plain", target: ["preview"], gitBranch: "develop" }) }],
    ["POST the time box for production", `${VERCEL_API}/v10/projects/${PROJECT}/env`, { method: "POST", body: JSON.stringify({ key: "SALES_AI_DESIGN_ENABLED_UNTIL", value: "2026-10-20T13:00:00Z", type: "plain", target: ["preview", "production"], gitBranch: "develop" }) }],
    ["POST the time box for all branches", `${VERCEL_API}/v10/projects/${PROJECT}/env`, { method: "POST", body: JSON.stringify({ key: "SALES_AI_DESIGN_ENABLED_UNTIL", value: "2026-10-20T13:00:00Z", type: "plain", target: ["preview"] }) }],
    ["a deployment", `${VERCEL_API}/v13/deployments`, { method: "POST", body: JSON.stringify({ name: "second-root", target: "production" }) }],
    ["another project", `${VERCEL_API}/v9/projects/prj_other/env`, { method: "GET" }],
    ["project settings", P, { method: "PATCH", body: JSON.stringify({ value: "x" }) }],
    ["another host", "https://example.com/v9/projects", { method: "GET" }],
  ])("refuses %s", (_name, url, init) => {
    expect(() => g(url, init as RequestInit)).toThrow(/refused/);
    expect(ok).not.toHaveBeenCalled();
  });
});

describe("design-flag: review fixes (DEV-064 Fresh Review)", () => {
  it("refuses when the listing hides Production records from the token", async () => {
    const api = vercel({ hiddenProd: 1 });
    for (const argv of [["status"], ["on", "--until", UNTIL_OK], ["off"]]) {
      const r = await run(api, argv);
      expect(r.code).toBe(1);
      expect(r.out).toContain("hides Production records");
    }
    expect(api.writes).toEqual([]);
  });

  it("on refuses while a window is open (no extending); off first", async () => {
    const api = vercel();
    await run(api, ["on", "--until", UNTIL_OK]);
    const later = iso(NOW + 3 * 60 * 60 * 1000);
    const r = await run(api, ["on", "--until", later]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("run off first");
    expect(untilOfApi(api)).toBe(UNTIL_OK);
    expect(api.writes).toHaveLength(2);
  });

  it("off --if-until: closes only the window it belongs to", async () => {
    const api = vercel();
    await run(api, ["on", "--until", UNTIL_OK]);
    const skip = await run(api, ["off", "--if-until", "2026-10-20T13:00:00Z"]);
    expect(skip.code).toBe(0);
    expect(skip.last).toBe(`DESIGN_FLAG OFF_SKIPPED_OTHER_WINDOW flag=true until=${UNTIL_OK}`);
    expect(flagOf(api)).toBe("true");
    const r = await run(api, ["off", "--if-until", UNTIL_OK]);
    expect(r.last).toBe(`DESIGN_FLAG OFF_WRITTEN flag=false until=${UNTIL_OK}`);
    const again = await run(api, ["off", "--if-until", UNTIL_OK]);
    expect(again.last).toBe(`DESIGN_FLAG ALREADY_OFF flag=false until=${UNTIL_OK}`);
    expect((await run(api, ["off", "--if-until", "soon"])).code).toBe(1);
  });

  it("off --if-until: a missing or invalid time box is not another window (turns the flag off)", async () => {
    for (const envs of [
      [{ id: "rMGvxH8aHWZZC5Z5", key: "SALES_AI_DESIGN_ENABLED", value: "true", type: "plain", target: ["preview"], gitBranch: "develop" }],
      [
        { id: "rMGvxH8aHWZZC5Z5", key: "SALES_AI_DESIGN_ENABLED", value: "true", type: "plain", target: ["preview"], gitBranch: "develop" },
        { id: "untilVarId000009", key: "SALES_AI_DESIGN_ENABLED_UNTIL", value: "", type: "plain", target: ["preview"], gitBranch: "develop" },
      ],
    ]) {
      const api = vercel({ envs });
      const r = await run(api, ["off", "--if-until", UNTIL_OK]);
      expect(r.code).toBe(0);
      expect(r.last).toMatch(/^DESIGN_FLAG OFF_WRITTEN flag=false /);
      expect(flagOf(api)).toBe("false");
    }
  });

  it("verify refuses a Production deployment behind the alias", async () => {
    const api = vercel();
    await run(api, ["on", "--until", UNTIL_OK]);
    api.state.deployment = { id: "dpl_p", readyState: "READY", target: "production", createdAt: NOW + 60_000, meta: { githubCommitSha: SHA } };
    const r = await run(api, ["verify", "--expect", "on", "--sha", SHA]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("Production deployment");
  });
});

describe("guardedFetch: PATCH only the checked records, only with their values", () => {
  const P = `${VERCEL_API}/v9/projects/${PROJECT}`;
  const ids = new Map([
    ["rMGvxH8aHWZZC5Z5", "SALES_AI_DESIGN_ENABLED"],
    ["untilVarId000001", "SALES_AI_DESIGN_ENABLED_UNTIL"],
  ]);
  const patch = (id: string, value: string) => ({ url: `${P}/env/${id}`, init: { method: "PATCH", body: JSON.stringify({ value }) } });

  it.each([
    ["another record (not checked)", patch("otherSecretVar01", "false")],
    ["the flag with a value other than true / false", patch("rMGvxH8aHWZZC5Z5", "1")],
    ["the time box with a value that is not a time box", patch("untilVarId000001", "")],
    ["the time box with a flag value", patch("untilVarId000001", "true")],
  ])("refuses %s", (_name, { url, init }) => {
    const ok = vi.fn(async () => Response.json({}));
    expect(() => guardedFetch(ok as unknown as typeof fetch, ids)(url, init as RequestInit)).toThrow(/refused/);
    expect(ok).not.toHaveBeenCalled();
  });

  it("allows the flag true/false and a time box on their own records", async () => {
    const ok = vi.fn(async () => Response.json({}));
    const g = guardedFetch(ok as unknown as typeof fetch, ids);
    for (const { url, init } of [patch("rMGvxH8aHWZZC5Z5", "true"), patch("rMGvxH8aHWZZC5Z5", "false"), patch("untilVarId000001", "2026-10-20T14:00:00Z")]) await g(url, init as RequestInit);
    expect(ok).toHaveBeenCalledTimes(3);
  });

  it("with no checked ids, no PATCH leaves", () => {
    const ok = vi.fn(async () => Response.json({}));
    expect(() => guardedFetch(ok as unknown as typeof fetch)(patch("rMGvxH8aHWZZC5Z5", "false").url, patch("rMGvxH8aHWZZC5Z5", "false").init as RequestInit)).toThrow(/refused/);
  });

  it("a body that is not JSON is refused without echoing it", () => {
    const ok = vi.fn(async () => Response.json({}));
    expect(() => guardedFetch(ok as unknown as typeof fetch, ids)(`${P}/env/rMGvxH8aHWZZC5Z5`, { method: "PATCH", body: "secret-ish{" })).toThrow(/^refused: PATCH .* not JSON$/);
  });
});

describe("design-flag: write-check (DEV-065, false over false, once)", () => {
  const ID = "rMGvxH8aHWZZC5Z5";

  it("flag false and the right id: exactly one PATCH of false to that record", async () => {
    const api = vercel();
    const r = await run(api, ["write-check", "--id", ID]);
    expect(r.code).toBe(0);
    expect(r.last).toBe("DESIGN_FLAG WRITE_CHECK_OK flag=false until=none");
    expect(api.writes).toEqual([{ method: "PATCH", path: `/v9/projects/${PROJECT}/env/${ID}`, body: { value: "false" } }]);
    expect(flagOf(api)).toBe("false");
    expect(r.out).not.toContain("do-not-print-me");
  });

  it("Vercel refuses (403): WRITE_DENIED, nothing changed", async () => {
    const api = vercel({ failWrites: 1 });
    const r = await run(api, ["write-check", "--id", ID]);
    expect(r.code).toBe(1);
    expect(r.last).toBe("DESIGN_FLAG WRITE_DENIED flag=false until=none");
    expect(api.writes).toHaveLength(1);
    expect(flagOf(api)).toBe("false");
  });

  it("refuses (nothing written) when the flag is not false", async () => {
    const api = vercel({ envs: [{ id: ID, key: "SALES_AI_DESIGN_ENABLED", value: "true", type: "plain", target: ["preview"], gitBranch: "develop" }] });
    const r = await run(api, ["write-check", "--id", ID]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("not false");
    expect(api.writes).toEqual([]);
  });

  it.each([
    ["another record's id", "otherSecretVar01"],
    ["an unknown id", "zzzzzzzzzzzzzzzz"],
    ["a malformed id", "../env"],
  ])("refuses %s (nothing written)", async (_name, id) => {
    const api = vercel();
    const r = await run(api, ["write-check", "--id", id]);
    expect(r.code).toBe(1);
    expect(api.writes).toEqual([]);
  });

  it("needs --id; refuses with Production records or a hidden Production listing", async () => {
    expect((await run(vercel(), ["write-check"])).code).toBe(1);
    const prod = vercel({
      envs: [
        { id: ID, key: "SALES_AI_DESIGN_ENABLED", value: "false", type: "plain", target: ["preview"], gitBranch: "develop" },
        { id: "prodFlagVar00001", key: "SALES_AI_DESIGN_ENABLED", value: "false", type: "plain", target: ["production"] },
      ],
    });
    expect((await run(prod, ["write-check", "--id", ID])).code).toBe(1);
    expect(prod.writes).toEqual([]);
    const hidden = vercel({ hiddenProd: 2 });
    expect((await run(hidden, ["write-check", "--id", ID])).code).toBe(1);
    expect(hidden.writes).toEqual([]);
  });

  it("401 is WRITE_DENIED too; a 500 is FAILED; each after exactly one PATCH", async () => {
    const denied = vercel({ failWrites: 1, failStatus: 401 });
    const r1 = await run(denied, ["write-check", "--id", ID]);
    expect(r1.last).toBe("DESIGN_FLAG WRITE_DENIED flag=false until=none");
    expect(denied.writes).toHaveLength(1);
    const broken = vercel({ failWrites: 1, failStatus: 500 });
    const r2 = await run(broken, ["write-check", "--id", ID]);
    expect(r2.code).toBe(1);
    expect(r2.last).toBe("DESIGN_FLAG FAILED flag=false until=none");
    expect(broken.writes).toHaveLength(1);
  });
});
