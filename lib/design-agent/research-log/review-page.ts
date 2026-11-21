/**
 * Issue #302 P5: the owner's review page for one entry — the previews, the advisory audit's numbers, Claude's notes and
 * the standing decision — as one HTML file plus the preview files beside it. Claude publishes the folder as a private
 * claude.ai artifact so the owner can look and decide from the Claude app, without copying files.
 *
 * Pure: returns the HTML and the list of preview files to copy (`img/<file>`). Every text is escaped. No script, no
 * network beyond Google Fonts.
 */
import { z } from "zod";
import type { OwnerDecision, ResearchEntry } from "./schema";

export const ReviewNotes = z.strictObject({
  keep: z.array(z.string().min(1).max(400)).max(12),
  weak: z.array(z.string().min(1).max(400)).max(12),
  next: z.array(z.string().min(1).max(400)).max(12),
});
export type ReviewNotes = z.infer<typeof ReviewNotes>;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const list = (xs: string[]) => (xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">なし</p>`);
const DECISION_JA = { adopt: "成功例として採用", revise: "改善する", reject: "不採用" } as const;

export function reviewPage(e: ResearchEntry, notes: ReviewNotes | null, decision: OwnerDecision | null): { html: string; files: string[] } {
  const figs = (vp: "desktop_1440" | "mobile_390") =>
    e.provenance.previews
      .filter((p) => p.viewport === vp)
      .map((p) => `<figure><a href="img/${esc(p.file)}" target="_blank" rel="noopener"><img src="img/${esc(p.file)}" alt="${esc(`${e.shop} ${e.direction} ${p.file}`)}" width="${p.width}" height="${p.height}" loading="lazy"></a><figcaption><b>${esc(p.file)}</b><span class="sha">${p.preview_sha256.slice(0, 16)}</span></figcaption></figure>`)
      .join("");
  const a = e.audit;
  const auditRows = a
    ? (["desktop_1440", "mobile_390"] as const)
        .map((v) => `<tr><td>${v === "desktop_1440" ? "PC 1440" : "SP 390"}</td><td class="n">${a.viewports[v].total}/25</td><td class="n">${a.viewports[v].lowest}</td><td>${esc(a.viewports[v].verdict)}</td><td>${esc(a.viewports[v].low_criteria.join(", ") || "—")}</td></tr>`)
        .join("")
    : "";
  const status = decision ? DECISION_JA[decision.decision] : "オーナー未判定";
  const html = `<title>${esc(`${e.shop} ${e.direction} r${e.iteration} レビュー`)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Shippori+Mincho+B1:wght@600;700&family=Zen+Kaku+Gothic+New:wght@400;700&display=swap">
<style>
/* Layout: review sheet — previews first, then audit numbers, notes and the owner's decision. */
:root{--bg:#f7f3ec;--panel:#fffdf9;--fg:#2b1d14;--muted:#6e5b4c;--line:#e3d8c9;--accent:#9a4a1f;--ok:#2f6b3a;--bad:#a1321f;
--f-display:"Shippori Mincho B1","Hiragino Mincho ProN","Yu Mincho",serif;--f-body:"Zen Kaku Gothic New","Hiragino Sans","Yu Gothic",system-ui,sans-serif;--f-mono:ui-monospace,Menlo,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#1c1511;--panel:#251c17;--fg:#f1e7dc;--muted:#b8a593;--line:#3d3029;--accent:#e08a55;--ok:#7cc48a;--bad:#ef8a74;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#1c1511;--panel:#251c17;--fg:#f1e7dc;--muted:#b8a593;--line:#3d3029;--accent:#e08a55;--ok:#7cc48a;--bad:#ef8a74;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font-family:var(--f-body);font-size:15px;line-height:1.75}
.wrap{max-width:1180px;margin:0 auto;padding-inline:16px;padding-block:32px 64px;display:grid;gap:36px}
h1,h2,h3{font-family:var(--f-display);text-wrap:balance;line-height:1.3;margin:0}h1{font-size:clamp(26px,4vw,38px)}h2{font-size:21px;border-bottom:2px solid var(--accent);padding-bottom:6px}
section{display:grid;gap:14px}p{margin:0}.muted{color:var(--muted)}.meta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:4px 16px}code,.sha{font-family:var(--f-mono);font-size:12px}
.status{justify-self:start;background:var(--accent);color:var(--panel);font-size:12px;letter-spacing:.06em;padding:2px 10px;border-radius:2px}
.g{display:grid;gap:14px}.pc{grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr))}.sp{grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))}
figure{margin:0;background:var(--panel);border:1px solid var(--line);display:grid}figure a{display:block;line-height:0}figure img{width:100%;height:auto;display:block}
figcaption{padding:8px 12px;font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}figcaption b{color:var(--fg)}
.t{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:480px;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{color:var(--muted);font-size:12px}td.n{font-variant-numeric:tabular-nums}
.cols{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}.card{background:var(--panel);border:1px solid var(--line);padding:14px 16px;display:grid;gap:8px;min-width:0}
.card ul{margin:0;padding-left:1.2em;display:grid;gap:6px}.keep h3{color:var(--ok)}.weak h3{color:var(--bad)}.next h3{color:var(--accent)}
.note{font-size:13px;color:var(--muted);border-left:3px solid var(--line);padding-left:12px}a{color:var(--accent)}a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
<div class="wrap">
<header style="display:grid;gap:10px"><span class="status">${esc(status)}</span><h1>${esc(`${e.shop} — ${e.direction} r${e.iteration}`)}</h1>
<p class="meta"><span>承認 <code>${esc(e.provenance.approval_id)}</code></span><span>plan <code>${esc(e.provenance.plan_id)}</code></span><span>commit <code>${e.provenance.commit.slice(0, 8)}</code></span><span>bundle <code>${e.provenance.bundle_sha256.slice(0, 12)}…</code></span>${e.parent_entry_id ? `<span>改善元 <code>${esc(e.parent_entry_id)}</code></span>` : ""}</p>
<p class="note">検証済み bundle から作った縮小プレビューです（元画像ではありません）。各画像の下は preview SHA-256 の先頭16桁。画像を押すと原寸で開きます。評価はチャットで「改善して」「成功例として保存」「不採用」と伝えてください。</p></header>
<section><h2>PC 1440</h2><div class="g pc">${figs("desktop_1440")}</div></section>
<section><h2>SP 390</h2><div class="g sp">${figs("mobile_390")}</div></section>
${a ? `<section><h2>自動監査（助言のみ・オーナー評価ではない）</h2><div class="t"><table><thead><tr><th>画面</th><th>合計</th><th>最低点</th><th>判定</th><th>4未満の項目</th></tr></thead><tbody>${auditRows}</tbody></table></div><p class="note">rubric <code>${esc(a.rubric_version)}</code> · 総合 ${esc(a.verdict)}</p></section>` : ""}
${notes ? `<section><h2>Claude の所見</h2><div class="cols"><div class="card keep"><h3>残す</h3>${list(notes.keep)}</div><div class="card weak"><h3>弱点</h3>${list(notes.weak)}</div><div class="card next"><h3>次の改善</h3>${list(notes.next)}</div></div></section>` : ""}
${decision ? `<section><h2>オーナーの判断（${esc(decision.decided_at.slice(0, 10))}）</h2><p>「${esc(decision.owner_words)}」</p><div class="cols"><div class="card"><h3>理由</h3>${list(decision.reasons)}</div><div class="card keep"><h3>残す</h3>${list(decision.keep)}</div><div class="card next"><h3>改善する</h3>${list(decision.improve)}</div></div></section>` : ""}
</div>
`;
  return { html, files: e.provenance.previews.map((p) => p.file) };
}
