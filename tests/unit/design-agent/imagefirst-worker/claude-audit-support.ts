// Issue #302: shared by the Claude CLI audit tests. A delivered IMAGE_FIRST bundle in a scratch place (harmless synthetic
// pictures, the real pack → local inbox → previews path), and a FAKE `claude` CLI (a node script written to a temporary
// directory, modelled on curiosity-media's FAKE_CLAUDE in tests/unit/entry-image-worker.test.ts). No real claude, no
// Codex, no model, no network. The fake reads its settings from $HOME/fake-claude.json (the child only gets the
// allowlisted environment, so FAKE_* variables would never reach it) and logs one JSON line per invocation.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { CHECK_IDS, CRITERION_IDS, HARD_FAIL_IDS } from "../../../../lib/design-agent/imagefirst-worker/audit-rubric";
import { packBundle } from "../../../../lib/design-agent/imagefirst-worker/bundle";
import { handOffToLocalInbox } from "../../../../lib/design-agent/imagefirst-worker/local-inbox";
import { dummyPng } from "../../../../lib/design-agent/imagefirst-worker/review-poc";

export const REPO = resolve(__dirname, "../../../..");
export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const ID = "hoshigama-imagefirst-d3-20261120-01";
export const PLAN_ID = "hoshigama-imagefirst-p3-20261120";
export const COMMIT = "a".repeat(40);
export const NOW = Date.parse("2026-11-20T01:00:00Z");

const temps: string[] = [];
export const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(d, 0o700);
  temps.push(d);
  return d;
};
export const cleanupTemps = () => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
};

async function write0600(path: string, bytes: Buffer | string) {
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
}

/** One 1440 × height picture: `n` coloured dummy bands stacked (no font needed beyond the dummy's own). */
async function tall(width: number, height: number, n: number): Promise<Buffer> {
  const band = Math.floor(height / n);
  const hexes = ["#d62828", "#1d4ed8", "#2b9348", "#7b2cbf", "#f77f00", "#ffd60a"];
  const layers = [];
  for (let i = 0; i < n; i++) {
    const h = i === n - 1 ? height - band * (n - 1) : band;
    layers.push({ input: await dummyPng(width, h, { part: `band-${i + 1}`, colour: "x", shape: "circle", number: String(1000 + i) }, hexes[i % hexes.length]!), top: i * band, left: 0 });
  }
  return sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).composite(layers).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
}

/**
 * PR #311 review M2: a photo-like tall PC page (1440 × height): in every 1504 rows (the tile step), 600 rows of grainy, photographic
 * texture (incompressible for PNG) then a flat colour, so every 1568-row preview tile stays LOSSLESS at about 2.5 MiB
 * (just under preview.ts's 3.5 MiB) — the realistic worst case for the PNG previews' total.
 */
export async function photoLikeComposite(width: number, height: number): Promise<Buffer> {
  const lo = await sharp({ create: { width: 180, height: Math.round((height * 180) / width), channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 60 } } }).png().toBuffer();
  const raw = await sharp(lo).resize(width, height, { kernel: "cubic" }).raw().toBuffer();
  const row = width * 3;
  for (let y = 0; y < height; y++) {
    if (y % 1504 >= 600) raw.fill(0xd8, y * row, (y + 1) * row);
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
}

export type Delivered = { work: string; runs: string; state: string; inbox: string; bundleSha: string; id: string };

/**
 * A finished "run" (6 dummy parts, a tall 1440 × 9000 PC composite, a 390-wide SP composite, a receipt in the worker's
 * shape) → packBundle → handOffToLocalInbox (the real delivery job in <state>/deliveries, the receiver's record, previews).
 */
export async function makeDelivered(o: { id?: string; pcHeight?: number; pc?: Buffer } = {}): Promise<Delivered> {
  const id = o.id ?? ID;
  const work = tmp("sr-audit-work-");
  const runs = join(work, "sr-runs");
  const state = join(work, "state");
  mkdirSync(runs, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  const runDir = join(runs, `${id}-20261120T010000Z`);
  mkdirSync(join(runDir, "parts"), { recursive: true, mode: 0o700 });
  mkdirSync(join(runDir, "composites"), { mode: 0o700 });
  const parts = [["pc-1", 1440, 2400], ["pc-2", 1440, 2400], ["sp-1", 780, 1560], ["sp-2", 780, 1560], ["sp-3", 780, 1560], ["sp-4", 780, 1560]] as const;
  const images: { file: string; sha256: string; bytes: number }[] = [];
  const sp: Buffer[] = [];
  for (const [i, [name, w, h]] of parts.entries()) {
    const png = await dummyPng(w, h, { part: name, colour: "x", shape: "square", number: String(2000 + i) }, "#8b5a2b");
    await write0600(join(runDir, "parts", `${name}.png`), png);
    images.push({ file: `parts/${name}.png`, sha256: sha(png), bytes: png.length });
    if (name.startsWith("sp-")) sp.push(png);
  }
  const pc = o.pc ?? (await tall(1440, o.pcHeight ?? 9000, 4));
  const spScaled = await Promise.all(sp.map((p) => sharp(p).resize({ width: 390 }).png().toBuffer()));
  const spComp = await sharp({ create: { width: 390, height: 780 * 4, channels: 3, background: "#ffffff" } }).composite(spScaled.map((b, i) => ({ input: b, top: i * 780, left: 0 }))).removeAlpha().png().toBuffer();
  await write0600(join(runDir, "composites", "pc.png"), pc);
  await write0600(join(runDir, "composites", "sp.png"), spComp);
  const t = new Date(NOW).toISOString();
  const receipt = {
    schema: "imagefirst_worker_receipt_v1", status: "succeeded", stop_code: null, stage: null, interrupted: false, cli_exit: 0, cli_timed_out: false,
    shop: "hoshigama", direction: "d3", approval_id: id, plan_id: PLAN_ID, commit: COMMIT,
    packet_sha256: sha("packet"), plan_sha256: sha("plan"), prompt_sha256: sha("prompt"), prompt_chars: 0, run_dir: runDir,
    images, stopped_images: [], counts: { pc: 2, sp: 4, total: 6, stopped: 0 }, verified: true, timings: { started_at: t, finished_at: t, elapsed_ms: 0 },
  };
  const receiptPath = `${runDir}.receipt.json`;
  await write0600(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(runs, "bundles"), composites: { pc: sha(pc), sp: sha(spComp) }, now: () => NOW });
  const inbox = join(runs, "review-inbox");
  const h = await handOffToLocalInbox({ sealed, stateDir: state, inboxDir: inbox, expected: { approval_id: id, plan_id: PLAN_ID, commit: COMMIT }, now: () => NOW });
  if (h.delivery.state !== "delivered" || !h.previews) throw new Error("fixture not delivered");
  return { work, runs, state, inbox, bundleSha: sealed.bundle_sha256, id };
}

/** A fresh copy of a delivered fixture (modes kept), so a test can change it. */
export function copyDelivered(d: Delivered): Delivered {
  const work = tmp("sr-audit-copy-");
  const r = spawnSync("cp", ["-a", `${d.work}/.`, work], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cp failed: ${r.stderr}`);
  return { ...d, work, runs: join(work, "sr-runs"), state: join(work, "state"), inbox: join(work, "sr-runs", "review-inbox") };
}

/** Every regular file under `root` (relative path → SHA-256), links and all; for "untouched" checks. */
export function treeHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(join(root, r), { throwIfNoEntry: false });
      if (st?.isDirectory()) walk(r);
      else out[r] = st ? `${sha(readFileSync(join(root, r)))}:${(st.mode & 0o777).toString(8)}` : "dangling";
    }
  };
  walk("");
  return out;
}

/** A valid answer template (the fake fills in viewport and the first label it was sent). */
export function answerTemplate(o: { score?: number; hit?: string } = {}) {
  const s = o.score ?? 5;
  const findings = s <= 3 ? [...CRITERION_IDS, ...CHECK_IDS].map((k) => ({ target: k, severity: "major", where: { image: "@LABEL", area: "hero", y0: null, y1: null }, problem: "weak", suggestion: "fix", protect: "the two colours" })) : [];
  return {
    viewport: "@VIEWPORT",
    hard_fails: Object.fromEntries(HARD_FAIL_IDS.map((k) => [k, k === o.hit ? { hit: true, where: { image: "@LABEL", area: "top", y0: null, y1: null }, note: "seen" } : { hit: false, where: null, note: "" }])),
    scores: Object.fromEntries(CRITERION_IDS.map((k) => [k, { score: s, reason: "ok, see /login sign in the picture" }])),
    checks: Object.fromEntries(CHECK_IDS.map((k) => [k, { score: s, reason: "ok" }])),
    structure_seen: { hero: "type_led", flow: "alternating_spreads", section_layouts: ["full_bleed_media", "grid_cards"] },
    findings,
  };
}

export const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, "fake-claude.json"), "utf8"));
const args = process.argv.slice(2);
const forbidden = Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_)/.test(k) || /CANARY/.test(k));
const log = (o) => fs.appendFileSync(cfg.log, JSON.stringify({ ...o, argv: args, cwd: process.cwd(), forbidden, envKeys: Object.keys(process.env).sort() }) + "\\n");
if (args[0] === "auth" && args[1] === "status") {
  log({ bin: "auth" });
  /* like the real subcommand (commander): only --json / --text; anything else is "unknown option", exit 1, no stdout */
  const extra = args.slice(2).filter((a) => a !== "--json" && a !== "--text");
  if (extra.length > 0) { process.stderr.write("error: unknown option '" + extra[0] + "'\\n"); process.exit(1); }
  const mode = cfg.auth || "ok";
  if (mode === "signedout") { console.log(JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" })); process.exit(1); }
  if (mode === "garbled") { console.log("???"); process.exit(0); }
  /* the real shapes: a subscription login; a Console login (a managed API key) is ALSO "claude.ai", plus apiKeySource */
  if (mode === "ok") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); process.exit(0); }
  if (mode === "console") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", apiKeySource: "/login managed key" })); process.exit(0); }
  console.log(JSON.stringify({ loggedIn: true, authMethod: mode === "apikey" ? "api_key" : mode === "missing" ? undefined : mode, apiProvider: "firstParty" }));
  process.exit(0);
}
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const content = JSON.parse(input.trim()).message.content;
  const images = content.filter((p) => p.type === "image");
  const labels = content.filter((p) => p.type === "text" && p.text.startsWith("[image] ")).map((p) => p.text.slice(8));
  const text = content[content.length - 1].text;
  const viewport = /"viewport": "(desktop_1440|mobile_390)"/.exec(text)[1];
  const n = fs.existsSync(cfg.log) ? fs.readFileSync(cfg.log, "utf8").split("\\n").filter((l) => l.includes('"bin":"claude"')).length : 0;
  log({ bin: "claude", call: n + 1, viewport, labels, shas: images.map((i) => crypto.createHash("sha256").update(Buffer.from(i.source.data, "base64")).digest("hex")), media: images.map((i) => i.source.media_type), reask: text.includes("前回の答えは"), textSha: crypto.createHash("sha256").update(text).digest("hex") });
  const mode = (cfg.modes && cfg.modes[n]) || cfg.mode || "ok";
  const out = (o) => console.log(JSON.stringify(o));
  out({ type: "system", subtype: "init", model: "fake-test-model", claude_code_version: "0.0.0-test" });
  if (mode === "sleep") { setTimeout(() => process.exit(0), 60000); return; }
  if (mode === "expired") { out({ type: "result", result: "Invalid API key · Please run /login", is_error: true }); process.exit(1); }
  if (mode === "quota") { process.stderr.write("Claude AI usage limit reached\\n"); process.exit(1); }
  if (mode === "broken") { process.stderr.write("unexpected internal error\\n"); process.exit(1); }
  if (mode === "line401") { process.stderr.write("TypeError: x\\n    at render (/opt/claude/cli.js:401:12)\\n"); process.exit(1); }
  if (mode === "nojson") { out({ type: "result", result: "I could not decide.", is_error: false }); return; }
  const answer = JSON.parse(JSON.stringify(cfg.answer).split("@VIEWPORT").join(viewport).split("@LABEL").join(labels[0]));
  if (mode === "verdict") answer.verdict = "show_owner";
  if (mode === "badlabel") answer.findings = [{ target: "beauty", severity: "minor", where: { image: "not-sent.png", area: "x", y0: null, y1: null }, problem: "p", suggestion: "s", protect: "q" }];
  if (mode === "incoherent") { answer.scores.beauty.score = 2; answer.findings = []; }
  out({ type: "result", result: "Here it is:\\n\`\`\`json\\n" + JSON.stringify(answer) + "\\n\`\`\`", is_error: false });
});
`;

/** Writes the fake claude (0755) into its own directory, and its settings into `home`. Returns the binary and the log path. */
export function fakeClaude(home: string, cfg: Record<string, unknown>): { bin: string; log: string } {
  const dir = tmp("sr-fake-claude-");
  const bin = join(dir, "claude");
  writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });
  const log = join(home, "fake-claude.log");
  writeFileSync(join(home, "fake-claude.json"), JSON.stringify({ log, answer: answerTemplate(), ...cfg }));
  return { bin, log };
}
export const readLog = (log: string): Record<string, unknown>[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
