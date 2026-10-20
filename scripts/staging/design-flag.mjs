#!/usr/bin/env node
// The Staging design flag window for a controlled run (DEV-064,
// docs/operations/design-flag-window.md). Changes only the two Preview env vars of
// the develop branch, and only through the requests listed in `guardedFetch`:
//
//   npm run staging:design-flag -- status
//   npm run staging:design-flag -- on --until 2026-10-21T03:00:00Z
//   npm run staging:design-flag -- off
//   npm run staging:design-flag -- verify --expect on|off --sha <40 hex>
//
// - status: reads the two env vars, the project's production branch and the deployment
//   behind the develop alias. Changes nothing.
// - on: writes SALES_AI_DESIGN_ENABLED_UNTIL (the time box, see lib/sales/design.ts)
//   FIRST, then SALES_AI_DESIGN_ENABLED=true. The flag is never true without a time box.
//   --until must be 30 minutes to 4 hours ahead.
// - off: SALES_AI_DESIGN_ENABLED=false. Idempotent (already false: nothing is written).
// - verify: read only. The env vars give the expected state and the develop alias serves a
//   READY deployment of <sha> created after the env vars last changed (Vercel reads env vars
//   at build time, so only such a deployment carries the value). "off" needs the flag to be
//   false itself: a passed time box alone is not off.
//
// Env vars only take effect in a new deployment. This script never deploys: a push to
// develop does (Vercel's git integration builds Preview for develop; Production is built
// from main only, which `status` checks).
//
// Refuses (before writing anything) when: the production branch is not main; the flag is
// not exactly one plain record with target ["preview"] and gitBranch "develop"; any other
// record of either key exists (another target, branch or type); a request is not one of
// the allowed ones. Values of other env vars are never read into output.
//
// Exit: 0 ok; 1 failed / refused; 2 verify not (yet) as expected. Last line:
//   DESIGN_FLAG <CODE> flag=<true|false|unknown> until=<iso|none|invalid|unknown>

import { pathToFileURL } from "node:url";

export const VERCEL_API = "https://api.vercel.com";
export const PROJECT = "prj_EdI3HMmSZ6NmtTFSqp1nscyYnHGS";
export const BRANCH = "develop";
export const PRODUCTION_BRANCH = "main";
export const ALIAS = "second-root-git-develop-brot-yanagi.vercel.app";
export const FLAG = "SALES_AI_DESIGN_ENABLED";
export const UNTIL = "SALES_AI_DESIGN_ENABLED_UNTIL";
export const MIN_WINDOW_MS = 30 * 60 * 1000;
export const MAX_WINDOW_MS = 4 * 60 * 60 * 1000;
const UNTIL_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ENV_ID = /^[A-Za-z0-9]{8,64}$/;

/** The only requests this script may send; anything else throws before it is sent. */
export function guardedFetch(fetchImpl) {
  const base = `${VERCEL_API}/v9/projects/${PROJECT}`;
  return (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const u = String(url);
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    const ok =
      (method === "GET" && body === undefined && (u === base || u === `${base}/env` || u === `${VERCEL_API}/v13/deployments/${ALIAS}`)) ||
      (method === "PATCH" &&
        u.startsWith(`${base}/env/`) &&
        ENV_ID.test(u.slice(`${base}/env/`.length)) &&
        body !== undefined &&
        Object.keys(body).join(",") === "value" &&
        typeof body.value === "string") ||
      (method === "POST" &&
        u === `${VERCEL_API}/v10/projects/${PROJECT}/env` &&
        body !== undefined &&
        Object.keys(body).sort().join(",") === "gitBranch,key,target,type,value" &&
        body.key === UNTIL &&
        body.type === "plain" &&
        JSON.stringify(body.target) === JSON.stringify(["preview"]) &&
        body.gitBranch === BRANCH &&
        UNTIL_FORMAT.test(body.value));
    if (!ok) throw new Error(`refused: ${method} ${u.split("?")[0]} is not an allowed request`);
    return fetchImpl(u, { ...init, method, redirect: "error" });
  };
}

/** epoch ms of a strict YYYY-MM-DDTHH:MM:SSZ, or NaN. */
export function parseUntil(raw) {
  if (typeof raw !== "string" || !UNTIL_FORMAT.test(raw)) return Number.NaN;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && new Date(ms).toISOString() === `${raw.slice(0, 19)}.000Z` ? ms : Number.NaN;
}

const isOurs = (e) => JSON.stringify(e.target ?? null) === JSON.stringify(["preview"]) && e.gitBranch === BRANCH && e.type === "plain";

/**
 * @param {{ argv: string[], env: Record<string, string | undefined>, fetchImpl: typeof fetch, log: (line: string) => void, now?: () => number }} io
 * @returns {Promise<number>}
 */
export async function designFlag({ argv, env, fetchImpl, log, now = Date.now }) {
  let flag = "unknown";
  let until = "unknown";
  const done = (code, exit) => {
    log(`DESIGN_FLAG ${code} flag=${flag} until=${until}`);
    return exit;
  };
  try {
    const [cmd, ...rest] = argv;
    const opts = {};
    for (let i = 0; i < rest.length; i += 2) {
      const k = rest[i];
      if (!/^--(until|expect|sha)$/.test(k ?? "") || rest[i + 1] === undefined) throw new Error(`unknown or incomplete option ${String(k)}`);
      opts[k.slice(2)] = rest[i + 1];
    }
    const allowed = { status: [], on: ["until"], off: [], verify: ["expect", "sha"] }[cmd];
    if (!allowed) throw new Error("usage: status | on --until <YYYY-MM-DDTHH:MM:SSZ> | off | verify --expect on|off --sha <40 hex>");
    for (const k of Object.keys(opts)) if (!allowed.includes(k)) throw new Error(`--${k} is not an option of ${cmd}`);
    for (const k of allowed) if (opts[k] === undefined) throw new Error(`${cmd} needs --${k}`);

    const token = env.VERCEL_TOKEN;
    if (token !== undefined && token.length < 20) throw new Error("VERCEL_TOKEN looks invalid");
    if (!token && !env.HTTPS_PROXY) throw new Error("no Vercel credential: set VERCEL_TOKEN or register an API credential for api.vercel.com");
    const send = guardedFetch(fetchImpl);
    const call = async (method, url, body) => {
      const res = await send(url, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      // The body is never quoted: env listings may hold other values.
      if (!res.ok) throw new Error(`Vercel ${method} ${new URL(url).pathname} ${res.status}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Vercel ${method} ${new URL(url).pathname}: non-JSON response`);
      }
    };
    const projectUrl = `${VERCEL_API}/v9/projects/${PROJECT}`;

    const read = async () => {
      const envs = ((await call("GET", `${projectUrl}/env`))?.envs ?? []).filter((e) => e && (e.key === FLAG || e.key === UNTIL));
      const flags = envs.filter((e) => e.key === FLAG);
      const untils = envs.filter((e) => e.key === UNTIL);
      const strays = envs.filter((e) => !isOurs(e));
      if (strays.length)
        throw new Error(
          `refused: ${strays.length} other record(s) of ${FLAG} / ${UNTIL} (${strays.map((e) => `${e.key} ${JSON.stringify(e.target)} ${e.gitBranch ?? "all branches"} ${e.type}`).join("; ")}); only Preview ${BRANCH} plain records are expected`,
        );
      if (flags.length !== 1) throw new Error(`refused: expected exactly one ${FLAG} record for Preview ${BRANCH}, found ${flags.length}`);
      if (untils.length > 1) throw new Error(`refused: ${untils.length} ${UNTIL} records for Preview ${BRANCH}`);
      const f = flags[0];
      const u = untils[0] ?? null;
      if (!ENV_ID.test(String(f.id)) || (u && !ENV_ID.test(String(u.id)))) throw new Error("refused: unexpected env var id");
      flag = f.value === "true" || f.value === "false" ? f.value : "unknown";
      until = u === null ? "none" : Number.isFinite(parseUntil(u.value)) ? u.value : "invalid";
      return { f, u };
    };

    const info = await call("GET", projectUrl);
    const prod = info?.link?.productionBranch;
    log(`project ${String(info?.name ?? "?")} (${PROJECT}), production branch ${JSON.stringify(prod ?? null)}`);
    if (prod !== PRODUCTION_BRANCH) throw new Error(`refused: the production branch is ${JSON.stringify(prod ?? null)}, not ${PRODUCTION_BRANCH}`);
    let { f, u } = await read();
    const changedAt = () => Math.max(Number(f.updatedAt ?? f.createdAt ?? 0), Number(u?.updatedAt ?? u?.createdAt ?? 0));
    const show = () => {
      const ms = parseUntil(until);
      const left = Number.isFinite(ms) ? Math.round((ms - now()) / 60000) : null;
      log(`  ${FLAG} (Preview, ${BRANCH}): ${flag}`);
      log(`  ${UNTIL} (Preview, ${BRANCH}): ${until}${left === null ? "" : left > 0 ? ` (${left} min left)` : " (passed: the app treats the flag as off)"}`);
    };
    show();

    if (cmd === "status" || cmd === "verify") {
      let dep = null;
      try {
        dep = await call("GET", `${VERCEL_API}/v13/deployments/${ALIAS}`);
      } catch (err) {
        log(`  ${ALIAS}: deployment not read (${err.message})`);
      }
      const sha = typeof dep?.meta?.githubCommitSha === "string" && /^[0-9a-f]{40}$/.test(dep.meta.githubCommitSha) ? dep.meta.githubCommitSha : "unknown";
      const created = Number(dep?.createdAt ?? dep?.created ?? 0);
      const after = created > changedAt();
      if (dep) log(`  ${ALIAS}: ${String(dep.id ?? "?")}, ${String(dep.readyState ?? "?")}, commit ${sha}, built ${after ? "after" : "BEFORE"} the env vars last changed`);
      if (cmd === "status") return done("STATUS", 0);

      if (!/^(on|off)$/.test(opts.expect)) throw new Error("--expect must be on or off");
      if (!/^[0-9a-f]{40}$/.test(opts.sha)) throw new Error("--sha must be a 40-hex commit");
      const ms = parseUntil(until);
      const effective = flag === "true" && (until === "none" || (Number.isFinite(ms) && now() < ms));
      const want = opts.expect === "on";
      const problems = [];
      if (effective !== want) problems.push(`the env vars give ${effective ? "on" : "off"}`);
      // Off means the flag itself is false, not only a time box that has passed.
      if (!want && flag !== "false") problems.push(`${FLAG} is ${flag}, not false`);
      if (want && until === "none") problems.push(`${UNTIL} is not set`);
      if (!dep || dep.readyState !== "READY") problems.push("the alias deployment is not READY");
      if (sha !== opts.sha) problems.push(`the alias serves ${sha.slice(0, 7)}, not ${opts.sha.slice(0, 7)}`);
      if (dep && !after) problems.push("the alias deployment was built before the env vars changed");
      if (problems.length) {
        log(`  not yet: ${problems.join("; ")}`);
        return done("VERIFY_NOT_YET", 2);
      }
      return done(want ? "VERIFIED_ON" : "VERIFIED_OFF", 0);
    }

    if (cmd === "on") {
      const ms = parseUntil(opts.until);
      if (!Number.isFinite(ms)) throw new Error("--until must be YYYY-MM-DDTHH:MM:SSZ (UTC)");
      const ahead = ms - now();
      if (ahead < MIN_WINDOW_MS || ahead > MAX_WINDOW_MS) throw new Error("--until must be 30 minutes to 4 hours from now");
      // The time box first: the flag is never true without one.
      if (u) await call("PATCH", `${projectUrl}/env/${u.id}`, { value: opts.until });
      else await call("POST", `${VERCEL_API}/v10/projects/${PROJECT}/env`, { key: UNTIL, value: opts.until, type: "plain", target: ["preview"], gitBranch: BRANCH });
      ({ f, u } = await read());
      if (until !== opts.until) throw new Error(`${UNTIL} did not read back as written`);
      if (flag !== "true") await call("PATCH", `${projectUrl}/env/${f.id}`, { value: "true" });
      ({ f, u } = await read());
      if (flag !== "true") throw new Error(`${FLAG} did not read back as true`);
      log("  written. Takes effect in the next develop deployment (push to develop), then: verify --expect on --sha <that commit>");
      show();
      return done("ON_WRITTEN", 0);
    }

    // off
    if (flag === "false") {
      log("  already false: nothing written");
      return done("ALREADY_OFF", 0);
    }
    await call("PATCH", `${projectUrl}/env/${f.id}`, { value: "false" });
    ({ f, u } = await read());
    if (flag !== "false") throw new Error(`${FLAG} did not read back as false`);
    log("  written. Takes effect in the next develop deployment (push to develop), then: verify --expect off --sha <that commit>");
    show();
    return done("OFF_WRITTEN", 0);
  } catch (err) {
    log(`FAILED: ${err.message}`);
    return done("FAILED", 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== "1") {
    console.error("run through npm run staging:design-flag (needs NODE_USE_ENV_PROXY=1 behind HTTPS_PROXY)");
    process.exit(1);
  }
  designFlag({ argv: process.argv.slice(2), env: process.env, fetchImpl: fetch, log: (line) => console.log(line) }).then((code) => process.exit(code));
}
