/**
 * Phase 2f-1: the comparison sheet for routes A, B and C on the same fictional
 * shop. A technical pass is not a design success: every score, the "not
 * generic" judgement and the adoption are the owner's, filled in by hand (they
 * start null), and the verdict below only applies the owner's existing policy.
 *
 * Criteria: the five of the design-image rubric (docs/operations/design-image-eval-template.md:
 * beauty, fit with the shop, originality, structure as a website, implementability; 1–5 each)
 * plus PC/SP completeness (1–5). Pass = no hard fail, rubric total ≥ 22/25, every rubric
 * criterion ≥ 4, PC/SP completeness ≥ 4, the owner says it is not generic, and the owner
 * confirmed the scores. Route A is a concept image: it is judged as a concept, never as an
 * implementation-ready page.
 *
 * Every stop and warning of a run is listed with `stop_was_correct: null`, so the owner can
 * mark unnecessary stops (false positives) and the rate can be measured.
 */
import type { IntakeRecord } from "../artifact/intake";
import type { RunResult } from "./runner";

/** The owner's policy (same numbers as comp-impl's evaluationVerdict; a test keeps them equal). */
export const PASS_TOTAL = 22;
export const MIN_CRITERION = 4;
export const RUBRIC = ["beauty", "shop_fit", "originality", "web_structure", "implementability"] as const;

type Scores = Record<(typeof RUBRIC)[number], number | null>;
export type SheetEntry = {
  route: "A_image" | "B_html_prototype" | "C_hybrid";
  delivered_route: string | null;
  kind: "concept_image" | "browser_render";
  verification_state: IntakeRecord["verification_state"] | "stopped";
  images: { desktop_1440: string | null; mobile_390: string | null };
  hard_fails: string[] | null;
  scores: Scores;
  pc_sp_completeness: number | null;
  owner: { not_generic: boolean | null; adopt: boolean | null; confirmed: boolean; notes: string };
  stops_and_warnings: { code: string; source: "run" | "intake_warning" | "intake_reason"; stop_was_correct: boolean | null }[];
  /** The real calls behind the entry (Phase 2f-2): each approval, its run, prompt SHA and how it ended, as the ledger says. */
  calls: SheetCall[];
};
export type SheetCall = { kind: string; approval_id: string; run_id: string; prompt_sha256: string; slot: string; status: string; code: string | null };

export function sheetEntry(route: SheetEntry["route"], result: RunResult, calls: SheetCall[] = []): SheetEntry {
  const done = result.status === "done" ? result : null;
  const list: SheetEntry["stops_and_warnings"] = [];
  if (result.status === "stopped") list.push({ code: result.code, source: "run", stop_was_correct: null });
  for (const s of result.log.stops) list.push({ code: s.code, source: "run", stop_was_correct: null });
  if (done) {
    for (const w of done.record.warnings) list.push({ code: w, source: "intake_warning", stop_was_correct: null });
    // a run stop already listed from the run log is not counted twice
    for (const r of done.record.reasons) if (!r.startsWith("run_stopped:")) list.push({ code: r, source: "intake_reason", stop_was_correct: null });
  }
  const original = (k: "desktop_1440" | "mobile_390") => done?.record.files.find((f) => f.role === "original" && f.path.includes(k === "desktop_1440" ? "desktop" : "mobile"))?.path ?? null;
  return {
    route,
    delivered_route: done ? done.record.route : null,
    kind: route === "A_image" ? "concept_image" : "browser_render",
    verification_state: done ? done.record.verification_state : "stopped",
    images: { desktop_1440: original("desktop_1440"), mobile_390: original("mobile_390") },
    hard_fails: null,
    scores: { beauty: null, shop_fit: null, originality: null, web_structure: null, implementability: null },
    pc_sp_completeness: null,
    owner: { not_generic: null, adopt: null, confirmed: false, notes: "" },
    stops_and_warnings: list,
    calls,
  };
}

export type SheetVerdict = "pending" | "pass" | "fail" | "concept_pass" | "concept_fail";

/** Applies the owner's policy to a filled-in entry. Anything not filled in is pending, never a pass. */
export function sheetVerdict(e: SheetEntry): SheetVerdict {
  const scores = RUBRIC.map((k) => e.scores[k]);
  if (!e.owner.confirmed || e.hard_fails === null || scores.some((s) => s === null) || e.owner.not_generic === null) return "pending";
  const total = (scores as number[]).reduce((a, b) => a + b, 0);
  const rubricOk = e.hard_fails.length === 0 && total >= PASS_TOTAL && (scores as number[]).every((s) => s >= MIN_CRITERION) && e.owner.not_generic === true;
  // a concept image is judged as a concept: it never passes as an implementation-ready page
  if (e.kind === "concept_image") return rubricOk ? "concept_pass" : "concept_fail";
  if (e.pc_sp_completeness === null) return "pending";
  // a browser render that is technically complete is still not a success unless the design itself passes;
  // a run that fell back (C delivered as B) never passes as the route it did not deliver
  if (e.delivered_route !== e.route) return "fail";
  return rubricOk && e.pc_sp_completeness >= MIN_CRITERION && e.verification_state === "render_pair_complete" ? "pass" : "fail";
}

/** Share of stops / warnings the owner marked unnecessary, over those already judged. */
export function unnecessaryStopRate(entries: readonly SheetEntry[]): { judged: number; unnecessary: number; rate: number | null } {
  const judged = entries.flatMap((e) => e.stops_and_warnings).filter((s) => s.stop_was_correct !== null);
  const unnecessary = judged.filter((s) => s.stop_was_correct === false).length;
  return { judged: judged.length, unnecessary, rate: judged.length ? unnecessary / judged.length : null };
}

const cell = (v: unknown) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * The sheet as Markdown for the owner: per route what it is (a concept image, or a real browser render at 1440 and
 * 390), how far it got, every stop and warning (to be marked necessary or not), the real calls behind it, and the
 * blank score lines the owner fills in. Nothing here scores or judges a design.
 */
export function sheetMarkdown(entries: readonly SheetEntry[]): string {
  const lines: string[] = ["# A/B/C 比較シート（架空菓庵）", "", "点数・凡庸でないかの判断・採用はオーナーが記入する。技術的に通ったことは、デザインの合格ではない。", ""];
  const label = { concept_image: "構想画像（実装へは渡さない）", browser_render: "ブラウザ描画（PC1440・SP390）" } as const;
  for (const e of entries) {
    lines.push(`## ${e.route}`, "");
    lines.push(`- 種類: ${label[e.kind]}`);
    lines.push(`- 届いた経路: ${cell(e.delivered_route)}${e.delivered_route && e.delivered_route !== e.route ? "（依頼と違う: 切り替えあり）" : ""}`);
    lines.push(`- 検証の状態: ${e.verification_state}`);
    lines.push(`- 画像: PC ${cell(e.images.desktop_1440)} ／ SP ${cell(e.images.mobile_390)}`);
    lines.push("", "### 停止と警告（オーナーが正誤を記入）", "");
    if (e.stops_and_warnings.length === 0) lines.push("なし");
    else {
      lines.push("| コード | 出どころ | 止めたのは正しかったか |", "|---|---|---|");
      for (const s of e.stops_and_warnings) lines.push(`| ${cell(s.code)} | ${s.source} | ${s.stop_was_correct === null ? "（未記入）" : s.stop_was_correct ? "正しい" : "不要だった"} |`);
    }
    lines.push("", "### 実際の呼び出し", "");
    if (e.calls.length === 0) lines.push("なし");
    else {
      lines.push("| 種類 | 承認ID | 実行ID | 指示文SHA | 枠 | 結果 |", "|---|---|---|---|---|---|");
      for (const c of e.calls) lines.push(`| ${cell(c.kind)} | ${cell(c.approval_id)} | ${cell(c.run_id)} | ${cell(c.prompt_sha256.slice(0, 12))}… | ${cell(c.slot)} | ${cell(c.status)}${c.code ? ` (${cell(c.code)})` : ""} |`);
    }
    lines.push("", "### 採点（オーナーが記入、各1〜5）", "");
    for (const k of RUBRIC) lines.push(`- ${k}: ${e.scores[k] ?? "（未記入）"}`);
    lines.push(`- pc_sp_completeness: ${e.kind === "concept_image" ? "（構想画像のため対象外）" : (e.pc_sp_completeness ?? "（未記入）")}`);
    lines.push(`- 凡庸ではない: ${e.owner.not_generic === null ? "（未記入）" : e.owner.not_generic ? "はい" : "いいえ"}`);
    lines.push(`- 判定: ${sheetVerdict(e)}`, "");
  }
  return `${lines.join("\n")}\n`;
}
