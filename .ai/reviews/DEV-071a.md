# DEV-071a Fresh Review

Reviewer: 別 context の Claude agent（2026-10-20）。`feature/dev-071-design-spec` の fdf6b37（PR #83）。対象は `git diff origin/develop...HEAD`（merge-base 3b1c2fb）。
Verdict: **FAIL**（安全性・正しさは合格。実画面の品質と、develop との統合で直す点がある）
Counts: Critical 0 / High 2 / Medium 5 / Low 5 / Nit 2

人の hard constraint のうち、安全側は守られている:
- 頁の文字は事実（DemoView）か固定の見出し語だけ。主張の語（おすすめ・人気・看板 など）は足されない。`feature_first` も語を足さず、店の掲載順のまま。
- `normalizeLayout` は根拠の無い節を残さず、全事実を節か first view に置き、説明文を二度出さない（下の edge case をすべて確認）。
- `layout` の無い profile は、3b1c2fb の renderer と byte 単位で同じ markup（baseline は変更前の code から取られている。下記）。
- お知らせ帯・footer の注記・contrast の規則・品質ゲートは変わっていない。Codex への JSON Schema も不変。

ただし人は「品質基準を下げない・実画面で確かめる」と決めている（direction §8）。実画面（`next build` + `start`、10 direction × 3 店 × 360/390/1440）で、
orchestrator の指摘 4 点はすべて再現し、ほかにも節の組み方の崩れが見つかった。Stage 1 の目的は「店ごとに良いデザインを設計できる」ことなので、
variant や first view の表現が崩れたまま develop に入れると、DEV-071b で Codex がそれを選んだ時点で公開 demo の品質が下がる。
また、PR は develop（DEV-068 merge 済み）と conflict し、解消すると baseline test が落ちる（High 1）。このため FAIL とする。

## 実行したこと

- `npx vitest run tests/unit/design-agent`（PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定）: 46 files pass / 2 skipped、600 pass / 16 skipped、335 s。新しい test の所要: renderer-sections-browser 7 s、renderer-sections 3 s、layout 0.4 s、baseline 0.9 s（CI に問題ない）。
- `npx tsc --noEmit` → error なし。`npx eslint`（変更した ts/tsx 全部）→ 0。
- baseline の意味の確認: f339c48（renderer 変更の前の commit）を一時 worktree に checkout し、`renderer-baseline.test.tsx` を実行 → pass。hash は変更前の renderer から取られている。
- 一時 worktree で HEAD に `origin/feature/dev-067-direction-presets`（develop の DEV-068 を含む）を merge（ProfileRenderer の import の conflict を手で解消）し、次を実行した。どれも commit・push していない。worktree は削除済み。
  - 一時 test（Chromium、IPA 書体）: 10 direction × 5 palette（checkProfile を通る adversarial: 灰の surface・暗い地・明るい primary・surface = background・黄の accent）× coverageLayouts 15 種 × 360/390/1440、および edge の店 7 種。文字の contrast は **alpha と祖先の opacity を合成**して測った（PR の test は alpha を無視する。Low 3）。結果: overflow・切れ・事実の欠け・4.5 未満の文字は **0 件**。
  - `npm run build` + `next start -p 3996`（SR_DESIGN_PREVIEW_ROOT に 3 店 × 10 direction と edge の run）を Playwright で撮影（360 / 390 / 1440）。画像: `/tmp/claude-0/-home-user-second-root/0fe1c26c-c40d-5220-911a-3f28258de597/scratchpad/rv-real/`（`sheet-*.png` は一覧、`metrics.txt` は見出しの px・band と footer の間隔）。server は PID で停止済み。
  - `renderer-baseline.test.tsx` を merge 後の tree で実行 → **fail**（High 1）。
- 実装者の screenshot（`.../scratchpad/stage1/real/*.png`）も確認した。
- Vercel・Supabase・WSL・`/home/user/second-root`・`/home/user/sr-dev070` には触れていない。

## 確認項目

| 項目 | 判定 |
|---|---|
| 文字は事実か固定語だけ・主張の語なし | OK（renderer-sections の leftover / CLAIMS test と code を読んで確認） |
| normalizeLayout: 名前だけの店 | sections = []、firstView は name_only（vertical_name は和文名なら残る）。今の頁と同じく節なし。OK（ただし Low 4） |
| 電話だけの店 | visit だけ残る。OK |
| hours あり・closedDays なし | hours 節 / visit に出る。name_hours も可。OK |
| name_lead + about 無し | about は足されない（leadInHero）。説明文は hero に 1 回。OK |
| 重複 kind | 最初だけ、`duplicate:<kind>`。OK |
| name_menu で 1 品 | hero に 1 品、menu 節にも同じ 1 品（Low 1） |
| vertical_name の名前 | 和文だけ・空白なし・12 字以下。`ー々〆ヶ・` を許し、全角英数・記号・空白を拒否。1 字・12 字で表示は崩れない（ただし High 2） |
| layout 無しの互換 | 3b1c2fb と byte 同一。baseline は変更前の code から（f339c48 で pass を確認）。OK |
| DB 互換 | version 1 のまま、layout は最大約 400 byte（DB は 8192 byte・`version='1'` だけを検査）。OK |
| 読込の経路 | `checkProfile`（design.ts の renderableProfile・bridge・worker-side・client・preview・defaults）と spool / bridge の `DesignProfileSchema` は任意の layout を受ける。strip する consumer は無い。defaults.ts の `briefStructureOnDefault` は layout を持ち越さない（071a では Codex が layout を出さないので問題なし）。OK |
| Codex の JSON Schema | Core から作るので不変。review の `revised_profile` も Core。snapshot 不変。OK |
| band の contrast | surface: text on surface、inverted: background on primary だけ。10 direction × adversarial palette で 0 件。OK |
| DemoFrame の注記 | 変更なし。全 layout で帯と footer の注記が見える（PR の test）。OK |
| develop との統合 | **NG（High 1）** |
| 実画面の品質 | **NG（High 2、Medium 1〜4）** |

## Findings

1. **High — PR は develop と conflict し、解消すると baseline test が落ちる。baseline の取り直しの手順が要る。**
   - develop は merge-base 3b1c2fb の後に DEV-068（46e50a4）を取り込んだ。`ProfileRenderer.tsx` の import と root の className（`editorial.variable grotesk.variable` → `displayFaceVariables`）が変わったため、`git merge-tree` で `ProfileRenderer.tsx` と `.ai/tasks.json` が conflict する。
   - conflict を解消した tree では `renderer-baseline.test.tsx` が fail する（3b1c2fb の markup の hash なので、className が違う）。DEV-067 も develop に入る直前なので、同じことがもう一度起きる。
   - 修正案:
     - develop（DEV-067 の merge 後）に rebase または merge する。
     - baseline は **新しい code から書き直さない**。base の renderer（merge 先の develop の commit、DEV-071a の renderer 変更を含まない tree）で `SR_WRITE_RENDERER_BASELINE=1` を実行して取り直し、その commit を test の comment に書く（今の「3b1c2fb から」の comment も直す）。
     - 取り直した後、DEV-071a の renderer で pass することを確かめる。手順を test の comment か `.ai` に残す（今は env の flag だけで、誰がどの tree で書いたかが残らない）。

2. **High — `vertical_name` の first view が desktop で頁の品質を下げる。hero の大半が空き、長い名前では店名が節の見出しより小さくなる。**（`sections.module.css` の `h1.vname…` / `ProfileRenderer.tsx`）
   - 3 字（麦と灯、1440）: 店名は幅 151px、高さ 458px の縦の列。hero（1440 × 約 670）の残り約 2/3 は何も無い（orchestrator の指摘を再現。全 10 direction で同じ）。
   - 12 字（`rv-edge-v12-vertical_name-1440.png`）: `font-size: min(9rem, 62svh / (12 × 1.06))` で店名は約 44px（幅 44px × 高さ 528px）。同じ頁の節の見出し（quiet の 41px）とほぼ同じ大きさになる。hero の主役が見出しと同格になり、横幅 1440 の hero の 95% 以上が空く。
   - phone は横書きに戻るので問題ない。
   - 修正案（どれか、または組み合わせ）:
     - 縦の店名を hero の右に置く（縦組の読み始め）。左側に dek（地域と業種）・first view の要素・motif を置き、2 列の構図にする。
     - 最小の大きさに下限を設ける（例: 見出しの 2 倍以上）。満たせない字数（例: 8 字超）は `firstViewHasEvidence` で外して name_only に戻す。
     - 実画面の test に「hero の名前の文字の大きさ ≥ 節の見出し × k」と「hero の空き率」の検査を足す。

3. **Medium — 同じ頁の中で見出しの大きさがそろわない（side_heading の見出しだけ小さい）。**（`sections.module.css` の `.sec.sec[data-variant="side_heading"] .h.h { font-size: max(1.2rem, calc(1.4rem * var(--k))) }`）
   - bakery（quiet・vertical_ja）: 店について 19px、メニュー / 営業時間 / 店舗のご案内 41px（1440）。phone でも 19px 対 25px。全 10 direction で同じ（`metrics.txt`）。
   - 縦書きでは特に目立つ（店について だけ細い列になる）。phone では「横に置く小見出し」という variant の意味が無いのに、小さいまま残る。
   - 修正案: side_heading の縮小は desktop で横に置くときだけにする。`vertical_ja` のときは縮小しない（または頁の全見出しをそろえる）。

4. **Medium — 最後の節が band（surface / inverted）のとき、band と footer の間に地の色の帯が残る。inverted の band と footer はどちらも primary なので、二つの濃い塊が細い帯で切れて見える。**
   - 原因: `.main { padding: 0 var(--pad) var(--gap) }` の下の余白。間隔は bakery 104px、cafe（最後が surface）72px（`metrics.txt` の gap）。boutique_minimal では inverted の地が text の色（黒に近い）になり、緑の footer と二色の濃い帯が並ぶ。
   - 修正案:
     - 最後の節が band なら main の下の余白を 0 にする（例: `.main:has(> .sec:last-child:is([data-ground="surface"],[data-ground="inverted"])) { padding-bottom: 0 }`）。
     - inverted と footer の境目は、意図した区切り（細い罫か、地の色の決まった幅）にする。または「最後の節を inverted にしない」を normalize か語彙（071b）で決める。

5. **Medium — chips・columns が grid の行の高さに引き伸ばされ、項目の下に空きができる。**（`.chips` / `.columns`）
   - cafe（1440）の inverted の Menu chips: chip の枠が見出しの高さ（約 75px）まで伸び、文字は枠の上に寄る。全 direction で同じ。
   - bakery の columns: 段の罫（column-rule）が縦書きの見出しの高さまで伸び、項目の下が空く。
   - 原因: 節は grid で、`ol` は既定の `align-self: stretch`。chips は `flex-wrap: wrap` なので、1 行でも line が伸び、item も伸びる。
   - 修正案: `.chips, .columns, .feature { align-self: start; }`。chips には `align-items: flex-start; align-content: flex-start` も付ける。test で「chip の高さ ≈ 文字の行の高さ + padding」を確かめる。

6. **Medium — 縦書きの見出しの節は、見出しの高さで band が伸び、中身の少ない band に大きな空きができる。**
   - bakery の inverted の Visit（split）: 中身は住所とアクセスの 2 行。それでも「店舗のご案内」の縦の列（約 300px）が band の高さを決め、右の列の下が大きく空く（orchestrator の指摘を再現）。
   - 修正案（どれか）:
     - vertical_ja の見出しの大きさに上限を設ける（例: 中身の高さ程度）。
     - 中身の少ない節（data-single など）では見出しを横書きに戻す。
     - band の中では vertical_ja の見出しを中身の上端にそろえ、split の右列を下へ伸ばす。

7. **Medium — boutique_minimal（DEV-067）と band の組み合わせで、地の区別が崩れる。**
   - boutique_minimal は節そのものを幅の狭い surface の panel にする。そのため plain の節も surface の色の panel に見え、surface の band（全幅）との違いが「幅」だけになる。頁の輪郭が「狭い・全幅・狭い・全幅」と段になる（`rv-bakery-boutique_minimal-1440.png`）。
   - inverted は地が text の色になる（PR §10 に記載済み）。そのうえで footer の primary と二色になる（Medium 4 と重なる）。
   - 修正案: panel 型の direction では band も panel の幅に合わせる。または band の地を変える（surface → background に戻すなど）。どちらにするかを決め、DEV-067 の merge 後に 10 direction の実画面で確かめる。

8. **Low 1 — name_menu で、first view の抜粋と menu 節が first screen で重なる。**
   - cafe（390）: hero に 3 品、その直下の inverted の band に 4 品。同じ品名が続けて 2 度並ぶ。1 品の店では、hero の 1 品と節の 1 品が同じになる。
   - 事実の創作ではないが、品質の面で弱い。
   - 修正案: name_menu のときは menu 節を hero の直後に置かない（normalize で順を調整する）。または menu が 3 品以下なら name_menu を name_only に戻す。

9. **Low 2 — first view の小さい語（`.fvLead/.fvHours/.fvMenu`）に地の色の箱が付き、色の付いた hero では貼り付けた紙のように見える。**
   - gallery_mono の cafe: hero は赤（primary）で、MENU の抜粋だけが明るい箱になる（`crop-gm-cafe.png`）。
   - contrast は保証されるが、構図としては浮く。
   - 修正案: hero の地が primary の direction では、band と同じく「background on primary」の組で文字を置く（箱を付けない）。

10. **Low 3 — Chromium の band の contrast 検査が、1 つの direction と 1 つの palette だけで、alpha と opacity も無視している。**（`renderer-sections-browser.test.tsx` の `check`）
    - `rgb()` の 4 番目（alpha）を捨て、祖先の `opacity` も見ていない。半透明の文字があっても通る。
    - 実装者の「10 direction で確認」は commit されていない（一時 merge）。
    - 本 review の一時 test（alpha・opacity を合成、10 direction × 5 palette）では 0 件だった。今は実害は無い。
    - 修正案: DEV-067 の merge 後に、`renderer-direction.test.tsx` の adversarial palette の検査を layout 付き（coverageLayouts の一部）にも回す。文字色は地と alpha 合成して測る。

11. **Low 4 — 名前だけの店では、normalize 後の layout が `LayoutSchema`（sections の `min(1)`）を通らない。**
    - 071a では保存しないので実害は無い。DEV-071b で「normalize した layout を保存・比較・再 parse する」と、checkProfile が落ちて既存の表示に戻る。
    - 修正案: 071b で、normalize 後は schema を通さない（保存は Codex の原文）。または `min(0)` にする。test に「normalize の結果は schema を通る（あるいは通さない設計）」を明記する。

12. **Low 5 — band の上の区切り線が、内容の幅で band の上端に残る。**
    - plain の節の次に band が来ると、`.section + .section` の border-top（内容の幅）が全幅の band の上端に重なる。bakery の menu の上、cafe の ABOUT の上の 4px の罫がそう。
    - 修正案: band 自身の border-top は透明にする。前の節と band の間は band の地の境目で区切る。

13. **Nit 1 — 3 店の「画素の 25% 以上が違う」test は、palette の違いだけでも通る。** 構造の違いは signature（順・variant・first view）の test で見ているので実害は無い。画素の比較は同じ palette でやると、layout の効果だけを測れる。

14. **Nit 2 — `alignment: center`（DEV-067）が新しい variant に効かない。** PR §10 に後続として記載済み。DEV-067 の merge 後に、chips・cards・split・strip の中央揃えを決める。

## 再 review の条件

- High 1・2 と Medium 3〜7 を直す。
- develop（DEV-067 merge 後）の上で、`next build` + `start` の実画面を撮り直す。対象は 10 direction × 3 店 × 360/390/1440 と、edge（12 字の縦の名前・1 品の name_menu・名前だけ）。
- 上で挙げた空き・見出しの大きさ・band と footer の間隔を、数値でも確かめる（例: `metrics.txt` と同じ測り方）。

## 対応（実装者、2026-10-20）

develop（DEV-067 4ac0ae1・DEV-068・DEV-070 7c04478）を 2 回 merge し、その上で直した。commit: af2f172（merge 1）・20cbcd1（指摘の修正）・9973272（merge 2、DEV-070）・本 commit（縦組の構図の微修正・頁ごとの見出しの向き・文書）。

1. **High 1 統合**: develop を merge（ProfileRenderer の import は `displayFaceVariables`、PhotoFigure は parts.tsx に移した上で DEV-070 の「イメージ画像」の label を削除）。baseline は **新しい code から取らず**、origin/develop 7c04478 の一時 worktree（Stage 1 の renderer を含まない tree）に test と fixture だけを写して `SR_WRITE_RENDERER_BASELINE=<commit>` で取り直した。fixture は `{ source: "7c04478", hashes }` で取った commit を記録し、test の comment に手順（worktree → copy → 書き込み → 戻す）を書いた。写真の case は generated_concept を使わない形に変えた（DEV-070 で無い kind）。DEV-071a の renderer で pass。
2. **High 2 vertical_name**: desktop は「folio が上に全幅、その下に 2 列」。右に縦の店名の列（hero の高さの 8 割以上、`72svh / 字数` で最大 15rem）、左の列に motif・枠の写真・dek。縦にする店名は **6 字以下**（`VERTICAL_NAME_MAX = 6`、超えると `first_view:vertical_name` で name_only）。6 字でも 1440×900 で 96px（見出し 41px の 2.3 倍）。Chromium の test で「店名の大きさ ≥ 見出しの 2 倍」「店名の列の高さ > hero の 5 割」を 10 direction で確認。
3. **Medium 3**: side_heading の見出しの縮小をやめた（頁の見出しは 1 つの大きさ）。test: 頁の h2 の font-size がすべて同じ（10 direction × 3 店 + 縦の店、phone / desktop）。
4. **Medium 4**: 最後の節が band なら main の下の余白を 0（band が footer に接する）。inverted の band のあとは footer に footer の文字色 40% の hairline（意図した区切り）。boutique_minimal は panel の間隔を保つ。test: band と footer の間 < 1px。
5. **Medium 5**: chips・columns・feature は `align-self: start`、chips は `align-items / align-content: flex-start`。test: list と各項目が、伸びない条件の高さと同じ（mutation で 94px の伸びを検出することを確認）。
6. **Medium 6**: 縦書きの見出しは **頁のすべての節に十分な中身があるときだけ**（`data-short`: about 60 字以下・menu 2 品以下・hours の strip・visit 2 行以下）。一つでも短ければ頁の見出しはすべて横書き（縦と横を混ぜない）。縦の語は 2.2rem で上限。test: 短い節があれば縦の見出しは 0。
7. **Medium 7**: band の地は main で取った palette から作る（direction が節の token を変えても band の地は本来の surface / primary）。boutique_minimal では band を panel の列の中に置き（全幅にしない）、panel の間隔を保つ。実画面 10 direction で確認。
8. **Low 1 name_menu**: 抜粋は「メニューが抜粋（3 品）より多い」かつ「menu 節が hero の直後でない」ときだけ。満たさなければ `first_view:name_menu` で name_only（品は menu 節にすべて残る。1 品の店は name_only）。順序を動かすより first view を戻すほうが Codex の決めた節の順を保てるのでこちらにした。
9. **Low 2**: first view の語の箱をやめた。gallery_mono（primary の hero）では語を background の色（primary の上の保証された組）で置く。pop_bakeshop（点の模様）だけ角丸の地の札を残す。
10. **Low 3**: 10 direction × 3 つの adversarial palette（DEV-067 の褐色 surface・暗い地と明るい primary・surface = background の灰）× layout 8 種 × phone / desktop の色の組の test を commit。文字色・地の alpha と祖先の opacity があれば失敗にする。組は順不同（contrast は対称。band の中の badge は組が逆向きになる）。
11. **Low 4**: normalize の結果は `NormalizedLayout`（節 0 個を許す描画の計画、再 parse も保存もしない）。保存の `LayoutSchema` は 1 個以上のまま。test で両方を確認。
12. **Low 5**: band 自身の border-top は透明（内容幅の罫が全幅の band の上端に残らない）。
13. **Nit 1**: 3 店の test に DOM の節の順・variant・地の比較を追加（画素の比較は残す）。
14. **Nit 2**: alignment=center を新しい variant（chips・columns・feature・strip・block・cards・statement・first view の抜粋）に適用。

再確認: `npx vitest run tests/unit/design-agent tests/unit/ai-tasks.test.ts` 712 pass / 16 skipped（Chromium あり）、eslint 0、tsc 0、`npm run build` 成功。実画面（`next build` + `start`）: 3 店 × 10 direction + layout なし × 390 / 1440 と edge（6 字・7 字の和文名、名前だけ、1 品の name_menu、中身の短いパン屋）。overflow 0。contact sheet と数値: `scratchpad/stage1/sheet-*.png`・`scratchpad/stage1/real2/metrics.txt`。

## 再レビュー（2026-10-20、17b3edc）

Reviewer: 別 context の Claude agent（初回と同じ）。対象は `feature/dev-071-design-spec` の 17b3edc（develop 7c04478 = DEV-067・068・070 を merge 済み）。
Verdict: **FAIL**（残りは Medium 1 つ。直しは CSS だけで小さい）
Counts: Critical 0 / High 0 / Medium 1 / Low 4 / Nit 1

初回の High 2・Medium 5・Low 5・Nit 2 は、下の 1 点を除いて直っている。安全側（事実と固定語だけ・根拠の無い節なし・全事実・注記・contrast・品質ゲート）に退行は無い。
残る 1 点は vertical_name の hero の構図。名前は右の大きな列になり、見出しとの大小も正しくなった。ただ、hero の左の約 55% は空いたままで、全 10 direction で同じ。
その余白に置かれているのは、下端の dek（多くの direction で枠付きの全幅の箱）だけで、名前の列と組み合わさっていない。そのため意図した「間」には見えず、
未完成の hero に見える。人の「品質基準を下げない」に照らして finding として残す。

### 実行したこと

- `npx vitest run tests/unit/design-agent`（Chromium あり）: 626 pass / 3 fail / 16 skipped、613 s。fail は次の 2 file で、どちらも単独の再実行で pass した。
  - `browser.test.ts` の時間の test 2 件: 負荷による flake。単独で 2 回とも 76/76。本 PR はこの file に触れていない。
  - `renderer-direction.test.tsx` の「phones: the name keeps clear of its frame」: 全体の実行では 180 s の timeout。単独では 139 s で pass（Low 4）。
- 新しい test の所要: renderer-sections-browser 47 s（4 test）、layout 0.2 s、baseline 0.4 s。
- `npx tsc --noEmit` → 0。`npx eslint`（変更した ts/tsx 全部）→ 0。
- **baseline の出所を独自に確認した**:
  - origin/develop 7c04478 を一時 worktree に checkout した。`ProfileRenderer.tsx` に sections.module.css の参照は無く、`lib/design-agent/layout.ts` も無い（Stage 1 の code を含まない tree）。
  - 17b3edc の `renderer-baseline.test.tsx`・`renderer-baseline-cases.tsx`・fixture だけを写し、env なし（書き込みなし）で実行した → pass。`tests/unit/design-agent/fixtures.ts` は 7c04478 と 17b3edc で同一。
  - 結論: hash は Stage 1 を含まない develop の renderer の出力と一致する。主張どおり。worktree は削除済み。
- **新しい色の組の test の強さを mutation で確認した**: surface / inverted の band の中で `--p-secondary` を `--g-primary` にすると、`"営業時間" is primary on primary` で fail する（`sections.module.css` は元に戻した）。
  - 最初に試した `--p-secondary: var(--p-secondary)`（循環参照）は無効値として継承に落ちるため、色が変わらず pass した。これは mutation 側の誤りで、test の弱さではない。
- 実装者の実画面（`scratchpad/stage1/real2/`、3 店 × 10 direction + layout なし × 390/1440、edge 6 種、`metrics.txt`）と contact sheet を全部見た。次の数値を確かめた:
  - band と footer の間隔 = 0（boutique_minimal 以外）。
  - 頁の見出しの大きさは 1 種類。
  - 縦の名前は 193px（6 字の名前は 96px）、見出しは 41px。
  - overflow 0。

### 初回の findings の確認

| # | 判定 | 確認 |
|---|---|---|
| High 1 統合 | 解決 | develop を merge。baseline は 7c04478 から取り直され、出所を独自に再現した。fixture に `source` が残り、手順は test の comment にある |
| High 2 vertical_name | **一部（Medium 1 として残す）** | 6 字以下に限定。名前は見出しの 2 倍以上で、hero の高さの 8 割を占める。ただし左の列の構図が残る（下記） |
| Medium 3 見出しの大きさ | 解決 | side_heading の縮小を削除。test で頁の h2 が 1 種類 |
| Medium 4 band と footer | 解決 | 0px。inverted の後は footer に 40% の hairline。boutique_minimal は panel の間隔を保つ（意図どおり） |
| Medium 5 引き伸ばし | 解決 | `align-self: start`・flex-start。test は伸びを実測する（実装者の mutation で 94px を検出） |
| Medium 6 縦の見出しと短い節 | 解決（Low 1 に注記） | `data-short` が 1 つでもあれば頁の見出しをすべて横書きにする。縦の語は 2.2rem で上限 |
| Medium 7 boutique_minimal | 解決（Low 2 に注記） | band の地は main で取った本来の palette。band は panel の列の中に置く |
| Low 1 name_menu | 解決 | 抜粋は「メニューが 3 品より多い」かつ「menu 節が hero の直後でない」ときだけ。それ以外は `first_view:name_menu` で name_only。1 品の店は name_only（edge-oneitem で確認） |
| Low 2 first view の箱 | 解決 | gallery_mono は primary の上に background の色（保証された組）。pop_bakeshop だけ角丸の札 |
| Low 3 contrast の test | 解決 | 10 direction × 3 palette × layout × phone/desktop で、全文字が保証された色の組であること・alpha と opacity が無いことを検査。上の mutation で検出を確認 |
| Low 4 0 節の layout | 解決 | `NormalizedLayout`（保存しない描画の計画）。`LayoutSchema` は 1 節以上のまま |
| Low 5 band の上の罫 | 解決 | band の border-top は透明 |
| Nit 1・2 | 解決 | DOM の節の比較を追加。alignment=center を新しい variant に適用 |

### Findings

1. **Medium 1 — vertical_name の desktop の hero は、左の約 55% が意図の見えない空白のまま。**（`sections.module.css` の `.vhero` 以下）
   - **現状**（1440×900、`real2/bakery-*-1440.png`）:
     - hero は 1440 × 約 740。右に名前の列（193 × 613）。左の列（約 900 × 520）には、下端の dek だけが置かれている。
     - japanese_modern・american_editorial など多くの direction では、dek は全幅の枠付きの箱で、名前の列と下端も揃わない。
     - boutique_minimal では dek が左の列の中ほどに浮く。6 字の名前（edge-v6）は列の幅が 96px で、空白はさらに広い。
   - **判断:** 名前と見出しの階層は直った。しかし左の列に名前と関係を持つ要素が無いため、この空白は構図として働いていない（右寄せの看板の「間」なら、名前の脇に添え書きか縦の罫など、空白の基準になる線が要る）。
     layout の無い同じ店の頁（`bakery-nolayout-1440.png`）は横幅いっぱいの店名なので、vertical_name を選ぶと first screen の密度が明らかに下がる。
   - **修正案**（CSS のみ。具体的には次の組み合わせ）:
     1. **縦組の一塊にする:** desktop では dek（`areaLabel`、和文だけの事実。`japaneseOnly` で確かめ、英字が混じれば今の位置）を `writing-mode: vertical-rl` にし、名前の列のすぐ左に上端を揃えて置く（名前 → 添え書きの順）。
        `.vhero` の列は `minmax(0,1fr) auto auto` にする。dek の枠と全幅の箱は vertical_name では外す。
     2. **余白の量を名前に合わせる:** 名前と添え書きの塊を hero の中央寄り（例: 右の端から 1/3 の位置。`justify-self: end` + 右の padding を `clamp(48px, 10vw, 180px)`）に置く。
        hero の `min-height` は名前の列の高さに合わせて詰め、塊の左右の空白を対称に近づける。
     3. **motif・枠の写真がある direction:** 今のまま左の列に置く（そこに中身がある）。
     4. **test を足す:** desktop で「dek と名前の列の水平の距離 ≤ 名前の列の幅」と「hero の中で文字も motif も無い最大の矩形 ≤ hero の 35%」を 10 direction で確かめる。
   - 本 review では実装していない。直した後は、実画面（10 direction × 1440 と、6 字の名前）で目視する。

2. **Low 1 — `data-short` の規則は筋が通っているが、2 つ注意がある。**
   - **筋が通っている点:** 頁の中で縦と横を混ぜない。中身の少ない節の高さを縦の見出しが決めない。
   - **注意 1 — 当たる店が少ない:** 小さな店の典型（visit が住所とアクセスの 2 行、hours が strip）では、vertical_ja が実質 ja_only になる。
     3 店の bakery の fixture も、説明を 60 字超に延ばし電話を足して、縦の見出しが出る形に変えてある（初回の facts では横になる）。
   - **注意 2 — 判断の場所:** 判断は CSS（`:has(.sec[data-short])`）にあり、`normalizeLayout` と adjustments は知らない。DEV-071b の `visibleChanges` は「vertical_ja → ja_only」を見える変更と数えるが、描かれる頁は同じになりうる（DEV-066 が防いだ「同じ頁で round を使う」）。
   - **修正案（071b）:** 短さは事実（字数・品数・行数）と variant だけで決まる。だから `normalizeLayout` に移し、`headings:vertical_ja` のような固定の符号の adjustment にして、headings を ja_only に落とす。
     そうすれば prompt の「使える設定」、report、visibleChanges が描かれる頁と一致する。CSS の `data-short` はその結果を描くだけにする。

3. **Low 2 — boutique_minimal では、plain の節と surface の band が同じ見た目になる。**
   - plain の節も surface の panel なので、Codex が surface を選んでも何も変わらない（`real2/bakery-boutique_minimal-1440.png`。店について（plain）とメニュー（surface）が同じ地）。
   - inverted は区別できる。
   - DEV-071b の visibleChanges で、boutique_minimal の plain ↔ surface を「見えない変更」と扱うか、語彙で説明する。

4. **Low 3 — name_menu の利用可否が、prompt 用の一覧と normalize で食い違う。**
   - `availableFirstViews` は品数（> 3）だけを見る。normalize は節の順（menu が先頭か）でも name_menu を外す。
   - 071b で brief に「使える first view」を渡すときは、「menu 節を最初にしない場合に限る」を一覧の側にも書く。そうしないと Codex が組み合わせを外し続ける。

5. **Low 4 — DEV-067 の `renderer-direction.test.tsx`（phones の枠の test）が、単独でも 139 s かかる。** 全体の実行（4 core）では 180 s の timeout に当たった。
   - 本 PR の差分ではない（layout の無い頁の test）。しかし sections.module.css が頁の CSS に加わった後の実行なので、CI で flake の元になる。
   - 修正案: test の timeout を延ばす、または case を分割する（DEV-067 の後続で可）。

6. **Nit 1 — ruled_frame のある頁で、full-bleed の band が頁の枠の線を覆う**（editorial_luxury・french_classic の patisserie / bakery）。
   - 枠が band の所で途切れる。読みには影響しない。
   - band を枠の内側までにするかは、DEV-067 の枠の扱いと一緒に決めればよい。

### 再々 review の条件

- Medium 1 を直す。
- 実画面（`next build` + `start`）で、10 direction × bakery × 1440 と、6 字の名前・motif のある direction を撮り直して目視する。追加した test の数値も示す。
- Low 1〜3 は DEV-071b の作業に含めればよい（071a の merge を止めない）。

## 対応 (2)（実装者、2026-10-20、再レビューへ）

1. **Medium 1 vertical_name の hero**: 「掛け軸」の構図にした（CSS と、添え書きに class を付けるだけ）。
   - desktop: folio は上に全幅。その下で縦の店名と、そのすぐ左に上端を揃えた縦の添え書き（`areaLabel`、和文だけのとき。英数が混じれば横書きで名前の塊の下）を **hero の中央** に置く（列は `minmax(0,1fr) auto auto minmax(0,1fr)`）。添え書きの全幅の箱・上の罫は外し、各 direction の地や枠は細い縦の札として残る。hero の min-height は外し、高さは店名の列に合わせる。
   - motif・枠の写真がある profile は、それを右の余白に置き、列を `0.7fr auto auto 1fr` にして名前の塊を左へ寄せて釣り合わせる。
   - 提案の「右から 1/3」ではなく中央にした理由: 1440 幅で縦の 1 列（3 字 203px・6 字 101px）を右寄せにすると、左の空きが 900px 前後で一つの大きな空白になる。中央に置けば空きが左右に分かれ、各 590px 前後で対称になり、意図した余白として読める（実画面 real3 で 10 direction とも確認）。
   - **test**（Chromium、desktop、10 direction × 3 字の店・6 字の店・motif の店 + 3 店）: 添え書きと名前の列の水平距離 ≤ 名前の列の幅（実測 35〜74px、列の幅 203 / 101px）。hero の中で文字・motif・写真の無い最大の矩形（8px の格子）は **0.43 以下、かつ同じ店・同じ direction の layout なしの頁以下（+0.01）**。
   - 35% にしなかった理由: 縦の名前は 1 列なので、1440 幅では左右どちらかの余白が hero の 37〜42% になる（3 字 0.378〜0.389、6 字 0.410〜0.422、motif あり 0.30 台）。これを 35% 未満にするには事実を hero に足す（説明文を二度出すなど）か、無意味な飾りで埋めるしかなく、どちらも規則に反する。一方、同じ店の layout なしの hero は 0.444〜0.478（3 字の横の店名の上の空き）で、**vertical_name の方が first screen の空きは少ない**。この比較（layout なしの頁以下）を test の基準にした。
   - 実画面（`next build` + `start`、`scratchpad/stage1/real3/`）: bakery × 10 direction × 390/1440、6 字の店 × 10 direction、motif の店 × 3 direction。overflow 0。1440 の数値は `real3/metrics.txt`（captionGap・leftFree / rightFree は左右 559〜641px でほぼ対称）。contact sheet: `scratchpad/stage1/real3-sheet-*.png`。
2. **Low 4**: DEV-067 の「phones: the name keeps clear of its frame」を direction ごとの 10 個の test に分け、phone の大きさごとに 1 つの page を使い回す（頁ごとに browser context を作っていたのが遅さの原因）。組み合わせは同じ（2 大きさ × spacing 2 × 高さ 2 × motif 2 組 × layout 3 × direction 10）。所要は全体の実行の中で 1 direction 1.5〜1.9 秒（以前は 1 test で 139 秒）。
3. **Low 1〜3**: DEV-071b への申し送りとして design-spec-stage1.md と tasks.json の DEV-071 に記録（data-short の判断を normalize の adjustment に・boutique_minimal の plain / surface は見えない変更・availableFirstViews に name_menu の節順の条件）。今回は実装しない。
4. **Nit 1**（ruled_frame と full-bleed band）: DEV-067 の枠の扱いと一緒に決める（未対応のまま）。

再確認: design-agent と ai-tasks の suite（Chromium あり）720 pass / 16 skipped（1 件は縦の添え書きを見出しと数えた test 側の誤りで、直して単独で 4/4 pass）。eslint 0、tsc 0、`npm run build` 成功。

## 再レビュー (2)（2026-10-20、82b7646）

Reviewer: 別 context の Claude agent（初回・再レビューと同じ）。対象は 82b7646（17b3edc からの差分: vertical_name の hero の CSS、添え書きの class、test 2 file、文書）。
Verdict: **PASS**
Counts: Critical 0 / High 0 / Medium 0 / Low 0（新規）/ Nit 2

再レビューの Medium 1 は解消した。Low 1〜3 は DEV-071b への申し送りとして記録されている（`design-spec-stage1.md`・tasks.json）。071a の merge を止めるものではない。
安全側（事実と固定語だけ・根拠の無い節なし・全事実・注記・contrast・品質ゲート・layout 無しの byte 互換）に退行は無い。

### 実行したこと

- **`npx vitest run tests/unit/design-agent` の全体**（Chromium あり、PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定）: **48 files pass / 2 skipped、638 pass / 16 skipped、fail 0**、465 s。
  - 実装者は最後の test の修正の後に全体を回していなかったので、ここで確かめた。
  - 分割した DEV-067 の phone の枠の test は、10 個とも 1.5〜2.4 s で pass。
- `npx tsc --noEmit` → 0。`npx eslint`（変更した ts/tsx）→ 0。`npm run build` → 成功。tree は無変更。
- 実画面（`scratchpad/stage1/real3/`、`real3-sheet-*.png`、`metrics.txt`）で次を見た:
  - bakery × 10 direction × 390/1440
  - 6 字の店 × 10 direction × 390/1440
  - motif の店 × 3 direction × 390/1440

### Medium 1（vertical_name の hero）の確認 — 解消

- **desktop:** 名前の列と、そのすぐ左に上端を揃えた縦の添え書きが、hero の中央に一つの塊として立つ（掛け軸の構図）。hero の高さは名前の列に合わせて詰まった（約 760px）。左右の余白は 559〜641px でほぼ対称（`metrics.txt` の leftFree / rightFree）。
  - 各 direction の地・枠（editorial_luxury の二重枠・french_classic のアーチ・kissaten_retro の札・pop_bakeshop の丸い札・gallery_mono の塗りの hero）は、名前の列の札や塊の地として効いている。
  - 10 direction とも、余白が名前の塊を基準にした意図した「間」として読める。orchestrator の判断と同じ。
  - 添え書きと名前の距離は 35〜74px で、名前の列の幅（203px）以下。
- **6 字（架空焼菓子店）:** 列は 101px、名前は 96px（見出し 41px の 2.3 倍）。塊は細いが、中央の掛け軸として成立している。phone では横書きの 1 行（52px）で、overflow は無い。
- **motif:** stamp_ring・muffin_paper_svg が右の余白の中央に置かれ、名前の塊は左に寄る（0.7fr : 1fr）。釣り合いは取れている。
- **390:** layout の無い頁と同じ横書きの hero（変更なし）。見出しは 1 種類、overflow 0、10 direction とも崩れは無い。
- **「35% は事実を足さずには届かない」という主張について:** 妥当と判断する。
  - 縦の 1 列を 1440 幅に置けば、中央でも左右どちらかの余白が hero の 4 割前後になる。それより小さくするには、hero に事実を重ねて出す（説明文の重複など）か、意味の無い飾りで埋めるしかない。どちらも規則に反する。
  - 初回に私が出した 35% は目安で、根拠のある値ではなかった。「同じ店・同じ direction の layout 無しの頁以下（+0.01）、かつ 0.43 以下」という基準の方が、「vertical_name を選んで first screen が悪くならない」という本来の要件をそのまま測っている。
- **test の強さ:** 前回の構図（右の名前・左下の全幅の箱）は `captionGap`（添え書きが縦で、名前の脇にあること）で fail する。空きの率の基準は緩めだが、構図の退行は captionGap が止める（Nit 1）。

### Low 4（DEV-067 の phone の枠の test の分割）の確認 — 解消

- 分割前と分割後のループを比べた。direction ごとの test の中で、2 大きさ × spacing 2 × 高さ 2 × motif 2 組 × layout 3 = 48 頁を回し、10 direction で計 480 頁。分割前と同じ組み合わせ・同じ検査（`g.problems` が空、名前と枠の距離 ≥ 6）。
- 違いは、頁を大きさごとに 1 つ作って使い回すこと（`setContent` で毎回中身を置き換える）だけ。検査は各頁の layout から測るので、使い回しの影響は無い。所要は 139 s → 約 20 s。

### Nit

1. hero の「最大の空き矩形 ≤ 0.43」は、前回の右寄せの構図（左の空き約 0.44）でもほぼ境目にあり、単独では構図の退行を見分けにくい。今は captionGap の検査が実際の歯止め。将来、添え書きを横書きに戻す変更（`vdekH` の経路）が入ったときに備え、「左右の余白の差 ≤ hero の幅の 10%」も足すとよい（任意）。
2. ruled_frame と full-bleed の band（前回の Nit 1）は未対応のまま。DEV-067 の枠の扱いと一緒に決める、という記録で良い。

### DEV-071b への申し送り（前回の Low 1〜3、記録済み）

- `data-short` の判断を `normalizeLayout` の adjustment にする（visibleChanges・report・prompt と描かれる頁を一致させる）。
- boutique_minimal の plain ↔ surface は見えない変更として扱う。
- `availableFirstViews` に name_menu の節の順の条件を加える。
