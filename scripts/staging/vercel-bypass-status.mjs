#!/usr/bin/env node
// Read-only status of Vercel Deployment Protection for the design bridge (DEV-063,
// docs/operations/design-bridge-access.md §7). GET requests to api.vercel.com only:
// anything else is refused before it is sent. Nothing is changed.
//
//   npm run staging:bypass-status [-- --project <id or name>] [--team <teamId or slug>] [--alias <host>] [--branch <name>]
//
// The Vercel token is VERCEL_TOKEN, or an API credential for api.vercel.com that the
// session proxy adds (then it never enters this process), as in vercel-preview.mjs.
//
// Prints: Vercel Authentication (ssoProtection.deploymentType), password / trusted IPs /
// OPTIONS allowlist on or off, the Protection Bypass for Automation secrets (count; for each
// the creation date, the note and isEnvVar), whether the design bridge's own secret (note
// "Second Root design bridge (WSL)", not an env var) exists, SALES_AI_DESIGN_ENABLED for
// Preview on the branch (a plain flag; any other value is not shown), and the commit of the
// deployment behind the branch alias.
//
// Vercel's API returns the bypass secrets as the KEYS of `protectionBypass`. They are never
// printed: only the entries are read, and every line printed is redacted of every key.
// Exit: 0 Authentication on; 3 VERCEL_AUTH_NOT_ON; 1 STATUS_FAILED. Last line:
//   VERCEL_BYPASS_STATUS <CODE> auth=<on|off|unknown> bridge_secret=<present|env_var|absent|unknown>

import { pathToFileURL } from "node:url";
import { parseArgs } from "./lib.mjs";

export const VERCEL_API = "https://api.vercel.com";
export const BRIDGE_NOTE = "Second Root design bridge (WSL)";
const DEFAULTS = {
  project: "prj_EdI3HMmSZ6NmtTFSqp1nscyYnHGS",
  alias: "second-root-git-develop-brot-yanagi.vercel.app",
  branch: "develop",
};
const FLAG = "SALES_AI_DESIGN_ENABLED";
const PLAIN_FLAG_VALUES = new Set(["true", "false", "1", "0", "on", "off", ""]);

/** A fetch that refuses anything but GET to api.vercel.com, before anything is sent. */
export function getOnly(fetchImpl) {
  return (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    if (method !== "GET") throw new Error(`refused: ${method} (this script only reads)`);
    if (init.body !== undefined) throw new Error("refused: a request body (this script only reads)");
    if (!String(url).startsWith(`${VERCEL_API}/`)) throw new Error("refused: not api.vercel.com");
    return fetchImpl(url, { ...init, method: "GET", redirect: "error" });
  };
}

/** Replaces every secret (the bypass keys) in a line; drops control characters. */
export function redactLine(text, secrets) {
  let out = String(text).replace(/[\x00-\x1f\x7f]/g, " ");
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}

const day = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "unknown");
const onOff = (v) => (v ? "on" : "off");
/** A note as data: one line, at most 80 characters. */
const noteText = (n) => (typeof n === "string" && n !== "" ? JSON.stringify(n.slice(0, 80)) : "(none)");

/**
 * @param {{ argv: string[], env: Record<string, string | undefined>, fetchImpl: typeof fetch, log: (line: string) => void }} io
 * @returns {Promise<number>} the exit code
 */
export async function bypassStatus({ argv, env, fetchImpl, log }) {
  const secrets = [];
  const print = (line) => log(redactLine(line, secrets));
  let auth = "unknown";
  let bridge = "unknown";
  try {
    const args = parseArgs(argv);
    for (const k of Object.keys(args)) if (!["project", "team", "alias", "branch"].includes(k)) throw new Error(`unknown option --${k}`);
    const project = String(args.project ?? DEFAULTS.project);
    const team = args.team === undefined ? null : String(args.team);
    const alias = String(args.alias ?? DEFAULTS.alias);
    const branch = String(args.branch ?? DEFAULTS.branch);
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(project)) throw new Error("--project must be a Vercel project id or name");
    if (team !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(team)) throw new Error("--team must be a Vercel team id or slug");
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.vercel\.app$/.test(alias)) throw new Error("--alias must be one <name>.vercel.app host");
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch)) throw new Error("--branch must be a git branch name");
    const token = env.VERCEL_TOKEN;
    if (token !== undefined && token.length < 20) throw new Error("VERCEL_TOKEN looks invalid");
    if (token) secrets.push(token);
    if (!token && !env.HTTPS_PROXY) throw new Error("no Vercel credential: set VERCEL_TOKEN or register an API credential for api.vercel.com");

    const get = getOnly(fetchImpl);
    const teamQuery = team === null ? "" : team.startsWith("team_") ? `teamId=${team}` : `slug=${team}`;
    const vercel = async (path) => {
      const sep = path.includes("?") ? "&" : "?";
      const res = await get(`${VERCEL_API}${path}${teamQuery ? `${sep}${teamQuery}` : ""}`, {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const text = await res.text();
      // The body is never quoted: it may hold the secrets.
      if (!res.ok) throw new Error(`Vercel GET ${path.split("?")[0]} ${res.status}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Vercel GET ${path.split("?")[0]}: non-JSON response`);
      }
    };

    const info = await vercel(`/v9/projects/${encodeURIComponent(project)}`);
    // Collect every key first, so that no line below can carry one.
    const bypass = info && typeof info.protectionBypass === "object" && info.protectionBypass !== null ? info.protectionBypass : {};
    for (const key of Object.keys(bypass)) secrets.push(key);
    const entries = Object.values(bypass).filter((e) => e && typeof e === "object");
    const automation = entries.filter((e) => e.scope === undefined || e.scope === "automation-bypass").sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

    const sso = info.ssoProtection && typeof info.ssoProtection === "object" ? info.ssoProtection : null;
    auth = sso ? "on" : "off";
    print(`Vercel project ${String(info.name ?? "?")} (${String(info.id ?? project)})`);
    print(`  Vercel Authentication: ${sso ? `on (${String(sso.deploymentType ?? "unknown")})` : "OFF"}`);
    print(`  Password Protection: ${onOff(info.passwordProtection)}`);
    print(`  Trusted IPs: ${onOff(info.trustedIps)}`);
    print(`  OPTIONS Allowlist: ${onOff(info.optionsAllowlist)}`);
    print(`  Protection Bypass for Automation: ${automation.length} secret(s)${entries.length > automation.length ? ` (+${entries.length - automation.length} of another kind)` : ""}`);
    automation.forEach((e, i) => print(`    #${i + 1} created ${day(e.createdAt)}, note ${noteText(e.note)}, isEnvVar ${e.isEnvVar === true}`));
    const mine = automation.filter((e) => e.note === BRIDGE_NOTE);
    bridge = mine.some((e) => e.isEnvVar !== true) ? "present" : mine.length ? "env_var" : "absent";
    print(
      `  design bridge secret (note ${JSON.stringify(BRIDGE_NOTE)}, not an env var): ${
        bridge === "present" ? `present${mine.length > 1 ? ` (${mine.length} with this note)` : ""}` : bridge === "env_var" ? "only as an env var (not to be used: design-bridge-access.md §4)" : "absent"
      }`,
    );

    const envs = (await vercel(`/v9/projects/${encodeURIComponent(project)}/env`))?.envs ?? [];
    const flags = envs.filter(
      (e) => e && e.key === FLAG && [].concat(e.target ?? []).includes("preview") && (e.gitBranch === undefined || e.gitBranch === null || e.gitBranch === branch),
    );
    if (!flags.length) print(`  ${FLAG} (Preview, ${branch}): not set`);
    for (const e of flags) {
      const scope = e.gitBranch ? branch : "all Preview branches";
      const value = e.type === "plain" && typeof e.value === "string" && PLAIN_FLAG_VALUES.has(e.value) ? JSON.stringify(e.value) : `set (${String(e.type ?? "?")}, not shown)`;
      print(`  ${FLAG} (Preview, ${scope}): ${value}`);
    }

    try {
      const dep = await vercel(`/v13/deployments/${encodeURIComponent(alias)}`);
      const sha = typeof dep?.meta?.githubCommitSha === "string" && /^[0-9a-f]{40}$/.test(dep.meta.githubCommitSha) ? dep.meta.githubCommitSha : "unknown";
      const ref = typeof dep?.meta?.githubCommitRef === "string" ? dep.meta.githubCommitRef.slice(0, 100) : "unknown";
      print(`  ${alias}: deployment ${String(dep?.id ?? "?")}, ${String(dep?.readyState ?? "?")}, commit ${sha} (${ref})`);
    } catch (err) {
      print(`  ${alias}: deployment not read (${err.message})`);
    }

    if (!sso) {
      print("WARNING: Vercel Authentication is OFF. The bridge's bypass is meant to work WITH it on (design-bridge-access.md §5).");
      print(`VERCEL_BYPASS_STATUS VERCEL_AUTH_NOT_ON auth=off bridge_secret=${bridge}`);
      return 3;
    }
    print(`VERCEL_BYPASS_STATUS OK auth=on bridge_secret=${bridge}`);
    return 0;
  } catch (err) {
    print(`FAILED: ${err.message}`);
    print(`VERCEL_BYPASS_STATUS STATUS_FAILED auth=${auth} bridge_secret=${bridge}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== "1") {
    console.error("run through npm run staging:bypass-status (needs NODE_USE_ENV_PROXY=1 behind HTTPS_PROXY)");
    process.exit(1);
  }
  bypassStatus({ argv: process.argv.slice(2), env: process.env, fetchImpl: fetch, log: (line) => console.log(line) }).then((code) => process.exit(code));
}
