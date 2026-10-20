// The comparison's metrics report (DEV-073): one JSON and one Markdown summary
// from the run directories of <compareDir>/runs, plus a contact sheet of the
// compared pages. Fixed codes and numbers only: never a Codex text (rationale,
// problem notes, summaries), a prompt or a path; shops are named by their key.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import type { DemoView } from "@/lib/sales/demo-content";
import { factsToDemoView } from "../preview";
import { checkProfile, type DesignProfile } from "../profile";
import { SHOT_VIEWPORTS } from "../shot-viewports";
import { RUN_ID } from "../run-id";
import { writeContactSheet } from "./contact-sheet";
import { pixelDifference, structureDistance, structureOf, type PixelDifference, type Structure, type StructureDistance } from "./metrics";
import type { Safety } from "./safety";
import { factStrings } from "./shops";

type Json = Record<string, unknown>;
type Kind = "design" | "baseline" | "hand_written";

const readJson = (path: string): Promise<unknown> => readFile(path, "utf8").then((t) => JSON.parse(t) as unknown, () => undefined);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const code = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9_:.\-]{1,80}$/.test(v) ? v : null);
const codes = (v: unknown): string[] => (Array.isArray(v) ? v.map(code).filter((c): c is string => c !== null) : []);

/** One run directory, read: its record, its page's profile and screenshots. */
type Run = {
  runId: string;
  dir: string;
  kind: Kind;
  shop: string;
  category: string | null;
  richness: string | null;
  record: Json;
  demo: DemoView | null;
  profile: DesignProfile | null;
};

async function readRuns(runsDir: string, compareId: string): Promise<Run[]> {
  const names = (await readdir(runsDir).catch(() => [] as string[])).filter((n) => RUN_ID.test(n)).sort();
  const runs: Run[] = [];
  for (const runId of names) {
    const dir = join(runsDir, runId);
    const record = (await readJson(join(dir, "report.json"))) as Json | undefined;
    const compare = (record?.compare ?? null) as Json | null;
    if (!record || !compare || compare.compare_id !== compareId) continue;
    const kind = compare.kind;
    if (kind !== "design" && kind !== "baseline" && kind !== "hand_written") continue;
    const candidate = code(record.page_candidate);
    const check = candidate && candidate !== "none" ? checkProfile(await readJson(join(dir, `${candidate}.json`))) : null;
    runs.push({
      runId,
      dir,
      kind,
      shop: code(compare.shop) ?? "unknown",
      category: code(compare.category),
      richness: code(compare.richness),
      record,
      demo: factsToDemoView(await readJson(join(dir, "facts.json"))),
      profile: check?.ok ? check.profile : null,
    });
  }
  return runs;
}

function finalRound(codex: Json | null): Json | null {
  const rounds = Array.isArray(codex?.rounds) ? (codex!.rounds as Json[]) : [];
  const final = str(codex?.final_candidate);
  for (let i = rounds.length - 1; i >= 0; i--) if (rounds[i]!.candidate === final) return rounds[i]!;
  return null;
}

function scoresOf(round: Json | null) {
  const s = (round?.scores ?? null) as Json | null;
  if (!s) return null;
  return {
    brand_fit: num(s.brand_fit),
    visual_quality: num(s.visual_quality),
    hierarchy: num(s.hierarchy),
    mobile_quality: num(s.mobile_quality),
    generic_template_feel: num(s.generic_template_feel),
    total: num(s.total),
  };
}

function safetyOf(v: unknown) {
  const s = v as Safety | null | undefined;
  if (!s || typeof s !== "object" || !s.desktop || !s.mobile) return null;
  const page = (p: Safety["desktop"]) => ({ missing_facts: codes(p.missing), notice: p.notice === true, footer: p.footer === true, overflow_px: num(p.overflow) });
  return { ok: s.ok === true, desktop: page(s.desktop), mobile: page(s.mobile) };
}

function layoutOf(run: Run) {
  if (!run.profile || !run.demo) return null;
  const st = structureOf(run.profile, run.demo);
  return {
    direction: st.direction,
    first_view: st.firstView,
    sections: st.sections.map((s) => `${s.kind}/${s.variant}/${s.ground}`),
    type: st.type,
    typography: st.typography,
    hero: st.hero,
  };
}

function runSummary(run: Run) {
  const r = run.record;
  const codex = (r.codex ?? null) as Json | null;
  const timing = (r.timing ?? null) as Json | null;
  const started = Date.parse(String(r.started_at));
  const finished = Date.parse(String(r.finished_at));
  const calls = Array.isArray(timing?.call_list) ? (timing!.call_list as Json[]) : [];
  const prompts = Array.isArray(r.prompt_sizes) ? (r.prompt_sizes as Json[]) : [];
  const adjustments = Array.isArray(codex?.layout_adjustments ?? r.layout_adjustments) ? ((codex?.layout_adjustments ?? r.layout_adjustments) as Json[]) : [];
  const round = finalRound(codex);
  const overflow = codes(r.overflow);
  return {
    run_id: run.runId,
    kind: run.kind,
    outcome: code(r.outcome),
    ...(r.code !== undefined ? { code: code(r.code) } : {}),
    ...(run.kind === "hand_written" ? { source: "hand_written_spec" } : {}),
    wall_ms: Number.isFinite(finished - started) ? finished - started : null,
    codex: codex
      ? {
          verdict: code(round?.verdict),
          scores: scoresOf(round),
          final_candidate: code(codex.final_candidate),
          profile_source: code(codex.profile_source),
          rounds: Array.isArray(codex.rounds) ? codex.rounds.length : null,
          revisions: num(codex.revisions),
          quality_not_accepted: codex.quality_not_accepted === true,
          renderer_change_needed: codex.renderer_change_needed === true,
          schema_mode: code(codex.schema_mode),
          notes: codes(codex.notes),
          calls: calls.length,
          codex_ms: num(timing?.codex_ms),
          pipeline_ms: num(timing?.pipeline_ms),
          call_list: calls.map((c) => ({ stage: code(c.stage), duration_ms: num(c.duration_ms), schema: code(c.schema), result: code(c.result) })),
        }
      : null,
    prompt_sizes: prompts.map((p) => ({ kind: code(p.kind), prompt_chars: num(p.prompt_chars), approx_tokens: num(p.approx_tokens), images: num(p.images) })),
    prompt_chars_total: prompts.reduce((n, p) => n + (num(p.prompt_chars) ?? 0), 0),
    layout: layoutOf(run),
    layout_adjustments: adjustments.map((a) => ({ candidate: code(a.candidate), codes: codes(a.codes) })),
    overflow,
    safety: safetyOf(r.safety),
  };
}

type PairEntry = { a: string; b: string; structure: StructureDistance | null; pixels: { desktop_1440: PixelDifference | null; mobile_390: PixelDifference | null } };

async function shot(run: Run, device: "desktop" | "mobile"): Promise<Buffer | null> {
  return readFile(join(run.dir, `page-${device}.png`)).catch(() => null);
}

async function pair(a: Run, b: Run): Promise<PairEntry> {
  const structure = (x: Run): Structure | null => (x.profile && x.demo ? structureOf(x.profile, x.demo) : null);
  const sa = structure(a);
  const sb = structure(b);
  const px = async (device: "desktop" | "mobile") => {
    const [x, y] = [await shot(a, device), await shot(b, device)];
    if (!x || !y) return null;
    const v = device === "desktop" ? SHOT_VIEWPORTS.desktop : SHOT_VIEWPORTS.mobile;
    try {
      return pixelDifference(x, y, v.height * v.scale);
    } catch {
      return null;
    }
  };
  return { a: a.runId, b: b.runId, structure: sa && sb ? structureDistance(sa, sb) : null, pixels: { desktop_1440: await px("desktop"), mobile_390: await px("mobile") } };
}

async function pairsOf(list: Run[]): Promise<PairEntry[]> {
  const out: PairEntry[] = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push(await pair(list[i]!, list[j]!));
  return out;
}

function stats(values: Array<number | null | undefined>) {
  const xs = values.filter((v): v is number => typeof v === "number");
  if (xs.length === 0) return null;
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { min: r(Math.min(...xs)), mean: r(xs.reduce((a, b) => a + b, 0) / xs.length), max: r(Math.max(...xs)) };
}

const summaryOf = (pairs: PairEntry[]) => ({
  pairs: pairs.length,
  structure_total: stats(pairs.map((p) => p.structure?.total)),
  pixels_desktop_full: stats(pairs.map((p) => p.pixels.desktop_1440?.full)),
  pixels_desktop_first_screen: stats(pairs.map((p) => p.pixels.desktop_1440?.first_screen)),
  pixels_mobile_full: stats(pairs.map((p) => p.pixels.mobile_390?.full)),
  pixels_mobile_first_screen: stats(pairs.map((p) => p.pixels.mobile_390?.first_screen)),
});

export async function buildCompareReport(compareDir: string) {
  const compareId = compareDir.replace(/\/+$/, "").split("/").pop() ?? "";
  const runs = await readRuns(join(compareDir, "runs"), compareId);
  const shops = [...new Set(runs.map((r) => r.shop))].sort();
  const subjectOf = (shop: string) => runs.find((r) => r.shop === shop && r.kind === "design") ?? runs.find((r) => r.shop === shop && r.kind === "hand_written") ?? null;
  const baselineOf = (shop: string) => runs.find((r) => r.shop === shop && r.kind === "baseline") ?? null;
  const subjects = shops.map(subjectOf).filter((r): r is Run => r !== null);
  const baselines = shops.map(baselineOf).filter((r): r is Run => r !== null);
  const subjectKinds = [...new Set(subjects.map((s) => s.kind))];
  const mode = subjects.length === 0 ? "baseline" : subjectKinds.length === 1 ? subjectKinds[0]! : "mixed";

  const vsBaseline: PairEntry[] = [];
  for (const shop of shops) {
    const s = subjectOf(shop);
    const b = baselineOf(shop);
    if (s && b) vsBaseline.push(await pair(s, b));
  }
  const subjectPairs = await pairsOf(subjects);
  const baselinePairs = await pairsOf(baselines);
  const designRuns = subjects.filter((s) => s.kind === "design").map(runSummary);

  return {
    version: 1,
    compare_id: compareId,
    mode,
    /** hand_written: a person wrote the specs (a renderer demo); Codex generated nothing. */
    hand_written_specs: mode === "hand_written",
    references: 0,
    worker_commit: code(((subjects[0] ?? baselines[0])?.record.worker as Json | undefined)?.commit),
    shops: shops.map((shop) => {
      const s = subjectOf(shop);
      const b = baselineOf(shop);
      const any = s ?? b;
      return {
        shop,
        category: any?.category ?? null,
        richness: any?.richness ?? null,
        facts: any?.demo ? factStrings(any.demo).length : null,
        subject: s ? runSummary(s) : null,
        baseline: b ? runSummary(b) : null,
      };
    }),
    differences: {
      /** The compared pages of the shops, pairwise (design or hand-written). */
      between_shops: { pairs: subjectPairs, summary: summaryOf(subjectPairs) },
      /** Each shop's page against its baseline (the category default without layout: today's page). */
      against_baseline: { pairs: vsBaseline, summary: summaryOf(vsBaseline) },
      /** The baselines of the shops, pairwise (how far apart today's pages are). */
      between_baselines: { pairs: baselinePairs, summary: summaryOf(baselinePairs) },
    },
    totals: {
      codex_calls: designRuns.reduce((n, r) => n + (r.codex?.calls ?? 0), 0),
      codex_ms: designRuns.reduce((n, r) => n + (r.codex?.codex_ms ?? 0), 0),
      prompt_chars: designRuns.reduce((n, r) => n + r.prompt_chars_total, 0),
      approx_prompt_tokens: Math.round(designRuns.reduce((n, r) => n + r.prompt_chars_total, 0) / 4),
      accepted: designRuns.filter((r) => r.codex?.verdict === "accept" && !r.codex.quality_not_accepted).length,
      safety_ok: [...subjects, ...baselines].filter((r) => safetyOf(r.record.safety)?.ok).length,
      pages: subjects.length + baselines.length,
    },
  };
}

export type CompareReport = Awaited<ReturnType<typeof buildCompareReport>>;

const f = (n: number | null | undefined, digits = 3) => (typeof n === "number" ? n.toFixed(digits) : "–");
const pct = (n: number | null | undefined) => (typeof n === "number" ? `${(n * 100).toFixed(1)}%` : "–");
const sec = (ms: number | null | undefined) => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)} s` : "–");

export function reportMarkdown(r: CompareReport): string {
  const lines: string[] = [];
  lines.push(`# 3 店の比較 ${r.compare_id}`, "");
  if (r.mode === "hand_written")
    lines.push("> **手書きの spec（Codex の生成ではない）**: 人が書いた Stage 1 の layout で renderer の表現の幅を示す demo。品質審査・Codex の時間と費用は無い。", "");
  else if (r.mode === "design") lines.push("> Codex の実際の生成（worker と同じ pipeline・prompt・gate）。参照画像なし（架空の店）。", "");
  else lines.push("> baseline だけ（category default から layout を除いた今の頁）。", "");
  lines.push(`mode: ${r.mode} / worker commit: ${r.worker_commit ?? "–"} / 参照画像: ${r.references}`, "");

  lines.push("## 店ごと", "", "| 店 | 業種 | 事実 | 結果 | 判定 | brand | visual | hierarchy | mobile | generic | total | round | revision | Codex 呼び出し | Codex 時間 | prompt 字数（≈token） | 安全 |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of r.shops) {
    const x = s.subject;
    const c = x?.codex;
    lines.push(
      `| ${s.shop} | ${s.category ?? "–"} | ${s.richness ?? "–"} (${s.facts ?? "–"}) | ${x?.outcome ?? "–"} | ${c?.verdict ?? "–"} | ${c?.scores?.brand_fit ?? "–"} | ${c?.scores?.visual_quality ?? "–"} | ${c?.scores?.hierarchy ?? "–"} | ${c?.scores?.mobile_quality ?? "–"} | ${c?.scores?.generic_template_feel ?? "–"} | ${c?.scores?.total ?? "–"} | ${c?.rounds ?? "–"} | ${c?.revisions ?? "–"} | ${c?.calls ?? "–"} | ${sec(c?.codex_ms)} | ${x?.prompt_chars_total ? `${x.prompt_chars_total}（≈${Math.round(x.prompt_chars_total / 4)}）` : "–"} | ${x?.safety ? (x.safety.ok ? "OK" : "NG") : "–"} / base ${s.baseline?.safety ? (s.baseline.safety.ok ? "OK" : "NG") : "–"} |`,
    );
  }
  lines.push("");

  lines.push("## 選ばれた layout", "", "| 店 | direction | first view | 節（kind/variant/地） | type | 書体 | adjustments |", "|---|---|---|---|---|---|---|");
  for (const s of r.shops) {
    for (const x of [s.subject, s.baseline]) {
      if (!x) continue;
      const l = x.layout;
      lines.push(
        `| ${s.shop}${x.kind === "baseline" ? "（baseline）" : ""} | ${l?.direction ?? "（既存の template）"} | ${l?.first_view ?? "–"} | ${l ? l.sections.join(", ") || "（節なし）" : "–"} | ${l ? `${l.type.scale} / ${l.type.headings}` : "–"} | ${l ? `${l.typography.display} ${l.typography.displayWeight} / ${l.typography.body}` : "–"} | ${x.layout_adjustments.flatMap((a) => a.codes.map((c) => `${a.candidate}:${c}`)).join(", ") || "–"} |`,
      );
    }
  }
  lines.push("");

  const pairTable = (title: string, pairs: PairEntry[]) => {
    lines.push(`## ${title}`, "", "| A | B | 構造の距離 | first view | 節の順 | variant | 地 | direction | 文字組 | hero | 画素 1440（全体 / 最初の画面） | 画素 390（全体 / 最初の画面） |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const p of pairs) {
      const s = p.structure;
      lines.push(
        `| ${p.a} | ${p.b} | ${f(s?.total)} | ${f(s?.first_view, 0)} | ${f(s?.section_order)} | ${f(s?.variants)} | ${f(s?.grounds)} | ${f(s?.direction, 0)} | ${f(s?.typography)} | ${f(s?.hero)} | ${pct(p.pixels.desktop_1440?.full)} / ${pct(p.pixels.desktop_1440?.first_screen)} | ${pct(p.pixels.mobile_390?.full)} / ${pct(p.pixels.mobile_390?.first_screen)} |`,
      );
    }
    lines.push("");
  };
  pairTable("店の間の違い", r.differences.between_shops.pairs);
  pairTable("baseline（今の頁）との違い", r.differences.against_baseline.pairs);
  pairTable("baseline どうしの違い（参考）", r.differences.between_baselines.pairs);

  lines.push("## Codex の呼び出し", "");
  for (const s of r.shops) {
    const c = s.subject?.codex;
    if (!c) continue;
    lines.push(`- ${s.shop}: ${c.call_list.map((x) => `${x.stage} ${sec(x.duration_ms)} ${x.schema} ${x.result}`).join(" → ") || "なし"}${c.notes.length ? `（notes: ${c.notes.join(", ")}）` : ""}`);
  }
  lines.push("", `合計: Codex 呼び出し ${r.totals.codex_calls} 回 / ${sec(r.totals.codex_ms)} / prompt ${r.totals.prompt_chars} 字（≈${r.totals.approx_prompt_tokens} token、画像の token は別）/ accept ${r.totals.accepted} 店 / 安全の検査 OK ${r.totals.safety_ok}/${r.totals.pages} 頁`, "");

  lines.push("## 安全の検査", "", "| run | 1440: 欠けた事実 / 注記 / footer / 横はみ出し | 390: 同じ |", "|---|---|---|");
  for (const s of r.shops) {
    for (const x of [s.subject, s.baseline]) {
      if (!x?.safety) continue;
      const p = (q: NonNullable<typeof x.safety>["desktop"]) => `${q.missing_facts.join(", ") || "なし"} / ${q.notice ? "あり" : "なし"} / ${q.footer ? "あり" : "なし"} / ${q.overflow_px ?? "–"}px`;
      lines.push(`| ${x.run_id} | ${p(x.safety.desktop)} | ${p(x.safety.mobile)} |`);
    }
  }
  lines.push("", "数字の読み方は docs/operations/design-compare-local.md。構造の距離は 0（同じ）〜1（全部違う）、画素は差のある画素の割合。", "");
  return lines.join("\n");
}

/** Writes compare-report.json / .md and (with a browser) contact-sheet.png into the comparison directory. */
export async function writeCompareReport(compareDir: string, o: { browser?: Browser } = {}): Promise<{ json: string; markdown: string; contactSheet: string | null }> {
  const report = await buildCompareReport(compareDir);
  const json = join(compareDir, "compare-report.json");
  const markdown = join(compareDir, "compare-report.md");
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(markdown, reportMarkdown(report), { mode: 0o600 });
  let contactSheet: string | null = null;
  if (o.browser) {
    const rows = report.shops.map((s) => ({
      label: `${s.shop} · ${s.category ?? ""} · ${s.richness ?? ""}`,
      cells: [
        ...(s.subject ? [{ label: `${s.subject.kind === "hand_written" ? "hand-written spec" : `design ${s.subject.codex?.verdict ?? s.subject.outcome ?? ""}`} 1440`, path: join(compareDir, "runs", s.subject.run_id, "page-desktop.png") }] : []),
        ...(s.subject ? [{ label: "390", path: join(compareDir, "runs", s.subject.run_id, "page-mobile.png"), mobile: true }] : []),
        ...(s.baseline ? [{ label: "baseline 1440", path: join(compareDir, "runs", s.baseline.run_id, "page-desktop.png") }] : []),
        ...(s.baseline ? [{ label: "baseline 390", path: join(compareDir, "runs", s.baseline.run_id, "page-mobile.png"), mobile: true }] : []),
      ],
    }));
    contactSheet = join(compareDir, "contact-sheet.png");
    const title = `${report.compare_id} · ${report.mode === "hand_written" ? "HAND-WRITTEN SPECS (not Codex)" : report.mode === "design" ? "Codex design (no references)" : "baseline only"}`;
    await writeContactSheet(o.browser, { title, rows, out: contactSheet });
  }
  return { json, markdown, contactSheet };
}
