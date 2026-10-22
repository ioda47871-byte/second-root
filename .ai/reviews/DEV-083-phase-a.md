# DEV-083 段階 A Fresh Review（PR #101、検査の強化だけ）

- 対象: `feature/dev-083-phase-a` @ 64d41cd → develop へ merge（d4ee42c）。CI green on 64d41cd（unit (1/2) と shop-css (2/2) は playwright install の apt mirror 停止で 8 分の timeout → 失敗した job だけ 1 回再実行して green。test 前の失敗）。
- 人の承認（2026-10-22）: 「現段階では検査の強化のみを行い、CSS許可リストの緩和や運用への接続はしないでください。」。加えて自分たちの条件: どの頁でも既存の結果（pass / fail・`mechanical_ok`）を変えない。
- Review: 1 回目 FAIL（53228e6 の前の 64ac182）→ 対応 → 2 回目 PASS-with-nits → nit（docs）対応。

## 1 回目の FAIL と対応
1. CI で `paintCrossCheck` が 'unclear'（glyph の縁の anti-aliasing）→ glyph 内部の画素だけを読む・fixture を大きく・font を確認。assertion は緩めていない。
2. `data-comp-role` を HTML 属性の allowlist に足していた（緩和）→ 外した。属性を持つ頁は従来どおり `DOM_ATTRIBUTE_NOT_ALLOWED`。受け入れは段階 B（承認が要る）。
3. `capabilities: []` を受け入れていた（従来は `SPEC_SHAPE`）→ schema を戻した。
4. `GROUND_NOT_FLAT`（閾値 6）が今通る allowlist 内の頁を拒否（強調 span・余白 0 の border-left・余白 0 の濃い badge）→ advisory（`report.advisory`、`failed` に入らない）。+1px を四辺に、`GROUND_UNMEASURED` を追加。
5. paint model が inset box-shadow を見落とし、stacking の trigger を列挙（fail-open）→ shadow はすべて paint、未知の trigger は stacking context 扱い（fail-closed）。
6. docs の言い過ぎを修正。

## 新しい符号の扱い
- blocking（今の allowlist と既存の検査がすでに拒否する頁だけを拒否する、と符号ごとに論証）: `PSEUDO_GEOMETRY_UNKNOWN`、`STACKING_CONTEXT`、`PROTECTED_VERTICAL`、`FACT_VISIBILITY_CHANGES`（`TEXT_FACT_HIDDEN` の再報告）、`ROLE_*` / `CAPABILITY_NOT_APPROVED`（run では出ない）。
- advisory: `PAINT_ORDER_COVER`、`DISCLOSURE_NONCONTENT_OVERLAP` / `FACT_NONCONTENT_OVERLAP`、`GROUND_NOT_FLAT`、`GROUND_UNMEASURED`。
- 2 回目の reviewer は、develop で通り PR で落ちる allowlist 内の頁を作れなかった（すべての許可要素と許可 CSS で probe）。

## 2 回目の nit（対応済み）
- 「`failed` はどの頁でも同じ」は強すぎ → 「`mechanical_ok` と pass / fail は同じ。すでに落ちる頁は `visibility_matrix` を追加で列挙しうる（再報告）」。
- fixture の数 5 / 18。tasks.json の scope から page-scripts.ts を外す。

## 人の判断待ち
- `GROUND_NOT_FLAT` などの advisory を blocking にするか、閾値 6 と意味。
- 段階 B 以降（表現の緩和）はすべて人の承認。
