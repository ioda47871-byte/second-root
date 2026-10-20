# DEV-071b Fresh Review

Reviewer: 別 context の Claude agent（2026-10-20）。`feature/dev-071b-design-spec-codex` の 9e28d88（PR、base develop afd3d9b）。対象は `git diff origin/develop...HEAD`。
Verdict: **FAIL**（安全性・品質ゲートは合格。直す点は小さい: prompt の 1 文と、幅の検査の範囲＋boutique_minimal の CSS 1 行）
Counts: Critical 0 / High 1 / Medium 1 / Low 5 / Nit 4

人の hard constraint は守られている:
- 頁の文字は事実か固定の見出し語だけ。RULES の「Do not invent anything about the shop … you write no copy」は残り、語彙にも「a section shows only facts, never added words」「it is not called a speciality」がある。
- 根拠の無い節は描かれない（全経路で `normalizeLayout` を通る。下の表）。`layoutOptionsLine` は固定の語（節の kind・first view の名前）だけで、事実の文字は入らない（test あり、code でも確認）。
- 品質の基準は変わっていない: `reviewScore`・verdict・`qualityGate`・`MAX_REVISIONS`・final の選び方は diff に無い。review の parse は `DesignProfileSchema`（layout 任意）になっただけで、他の strict さは同じ。
- Codex の言葉は report に入らない（`layout_adjustments` は固定の符号と固定の candidate 名だけ。`layout` は final.json の enum の値だけ）。

FAIL の理由は 2 つ:
- **High 1:** この PR は「幅の検査」を範囲に入れている。ところが 1440px を超える幅では、boutique_minimal の節の列が細くなり、2560px で幅 80px になって本文が 1 字ずつ縦に並ぶ。原因は既存の CSS（DEV-067）で、本 PR の diff が作ったものではない。ただ、修正は CSS 1 行で、本 PR の `allowed_scope` 内にある。
- **Medium 1:** review の prompt に「renderer にできないこと（a new layout, …）なら needs_renderer_change = true」という古い文が残っている。これが、今回 Codex が選ぶようになった `layout` と衝突する。

## 実行したこと

- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=… npx vitest run tests/unit/design-agent` → **49 files pass / 2 skipped、661 pass / 16 skipped、fail 0**（485 s）。
  - container の load average は 11〜17（他の作業による）。
  - 新しい検査の所要は次のとおり（CI に問題ない大きさ）:
    - renderer-sections-browser 全体 197 s（13 幅 × 10 direction の test を含む）
    - pipeline-layout 0.25 s
    - layout 0.5 s
- `npx vitest run tests/unit/ai-tasks*` → 83 pass。
- `npx eslint`（変更した ts/tsx 全部）→ 0。
- `npm run build` → 成功。その後の `npx tsc --noEmit` → 0。
- `design-bridge-bypass-setup.test.ts` の「no execve …」を単独で 3 回 → 5119 ms（fail）、4915 ms、4953 ms（pass）。詳しくは Nit 4。
- schema の機械検査（一時 script、scratchpad）: brief・review・photo review の JSON Schema を strict / loose で走査した（下の表）。
- 一時の Chromium probe（`tests/unit/design-agent/zz-reviewer-probe-071b.test.tsx`。実行後に削除済みで、tree は無変更）:
  - 10 direction × coverageLayouts 15 種 + 3 店の layout × 2 店 × 8 サイズ。サイズは 800×900、900、1000、1200、1280×600、1366×768、1920×1080、2560×1080。
  - boutique_minimal の plain と surface の screenshot の比較。
  - layout 無しと `DEFAULT_LAYOUT` の画素の比較（10 direction × 1440 / 390）。
  - 画像: `/tmp/claude-0/-home-user-second-root/0fe1c26c-c40d-5220-911a-3f28258de597/scratchpad/r71b/`（`boutique-*-1440|1920|2560.png`・`boutique-nolayout-2560.png`）。
- Vercel・Supabase・WSL・`/home/user/second-root`・`sr-css`・`sr-css2` には触れていない。commit・push もしていない。

## 確認項目

| 項目 | 判定 |
|---|---|
| Codex の JSON Schema（brief / review / photo review、strict と loose） | OK。13〜18 個の object がすべて `additionalProperties: false`、全 property が required。`oneOf`・`allOf`・`if`・`not`・`$ref` は無い。使う keyword は `const`（version は既存、section の kind は新規）、`pattern`（既存）、`minItems`/`maxItems`（loose では外れる）。`anyOf` は 2 か所: revised_profile の profile か null（既存の形）と、section の 4 枝。4 枝は `kind` の `const` で区別できる（一致する枝は常に 1 つ）。enum の値は brief 94・review 109・photo 125 で、増分は約 30。schema の大きさは 4.5〜7.0 KB で問題ない |
| 答えの parse | `DesignProfileSchema`（layout 任意）。layout の無い答えは今の頁を描き、`layout:missing` と記録する（DEV-028 の loop だけ。Low 3） |
| profileAsDrawn の適用 | brief、low confidence の 3 経路（brief・brief_structure・category_default）、DEV-028 の改訂（通常と DEV-066 の再質問の後のどちらも `current` の作成時）、photo loop の改訂。second look と再質問は leader / base の profile（描いた形）を使う。`visibleChanges` は両側を normalize して比べる。OK |
| 保存する profile = 描いた profile | `writeProfile(candidate / final)` は描いた形。renderer の normalize は冪等（layout.test の「normalizing again changes nothing」）。OK。名前だけの店は例外（Low 2） |
| bridge / spool / design.ts / demo-data | `DesignProfileSchema`・`checkProfile` は任意の layout を受ける。`uploadableProfile` → `designBridgeRequest` → `renderableProfile` を最大の layout で通す test あり。OK |
| DB の制約 | version 1 のまま。最悪の profile で 2 KB 未満、rationale 160 字 × 4 を足しても 4 KB 未満（test）。OK |
| report | `codex.layout`（final の enum）と `codex.layout_adjustments`（固定の符号と candidate 名）。report.json は local で、review-summary は非 strict。OK |
| gate・品質基準 | review.ts の変更は schema の組み立てだけ。pipeline の verdict・leader・final・gate の論理は不変。OK |
| visibleChanges | 描く形で比べる設計は正しい。layout 無しと `DEFAULT_LAYOUT` は 10 direction × 2 幅で **画素も 0 差**（「見えない」の扱いは正しい）。boutique の surface ≡ plain は不正確（Low 1） |
| 写真の slot | `sectionsPresent(demo, layout)` を image direction・resolvePhotos・images artifact・preview check で共通に使う。layout 無しでは以前と同じ結果（`infoRows` と同じ規則）。OK |
| 短い節の判断（071a Low 1） | `sectionIsShort` は renderer の data-short と同じ規則（事実と variant だけ）。CSS の `:has()` は削除され、normalize の `headings:vertical_ja` に移った。OK |
| low confidence の方針 | 下の「判断について」 |
| 幅の検査 | 320〜1440 の 13 幅で、HARD（横の scroll・頁の外の文字）は **0**。800〜1366 と 1280×600 も 0。**1440 を超える幅で boutique が崩れる**（High 1） |

### 判断について（low confidence: 構造は残し、地と type は default に）

妥当と判断する。
- DEV-044 の「hero・grid は中身の形に従う構造なので残す」と同じ線引き。RULES も「材料が乏しいときは styling（地と type を含む）を落ち着かせる。構造には適用しない」と同じことを言っている。prompt と pipeline は矛盾しない。
- 地（primary・surface の帯）と文字組の階層を default に戻すのは、根拠の弱い brand 表現を出さない方向で、品質の基準は下げていない。
- 残る点もある。`vertical_name`・`statement`・`feature_first` は構造でありつつ表現も強い。それでも事実の形（和文の 6 字以下の名前、説明文の有無）が条件なので、構造として残すのは筋が通る。

## Findings

1. **High — 1440px を超える desktop で boutique_minimal の節の列が細くなり、2560px では本文が 1 字ずつ縦に並ぶ。**（`components/demo/profile/profile.module.css`）
   - 関係する rule は 2 つ:
     - l.732: `.canvas { --pad: max(56px, calc((100% - 1320px) / 2)); }`（1100px 以上）
     - l.930: `.canvas[data-direction="boutique_minimal"] .main { max-width: 1080px; margin-inline: auto; }`
   - main は border-box で `padding: 0 var(--pad)` なので、中身の幅は 1080 − 2 × pad になる。
   - **実測（Chromium、FULL_SHOP）:**

     | 幅 | 節の幅 |
     |---|---|
     | 1440 | 960 |
     | 1600 | 800 |
     | 1920 | 480 |
     | 2560 | 80 |

     - 2560 では `scrollWidth` が 165〜416 で、節の外へ文字がはみ出す。
     - 本文・メニュー・住所が 1〜2 字ずつ縦に並び、頁の高さは約 10,000px になる（`r71b/boutique-plain-1-2560.png`）。
   - **既存の不具合**である。layout の無い profile でも同じことが起きる（`boutique-nolayout-2560.png`、1920 で 480px）。DEV-067 の direction と DEV-068 の `--pad` の組み合わせから来ている。
   - **本 PR の検査をすり抜ける理由:**
     - review の screenshot は 1440 で撮るので、品質ゲートには見えない。
     - 本 PR の幅の検査（`SWEEP_WIDTHS`）は 1440 で止まる。`--pad` が変わり始める約 1432px より上の幅を検査していない。
   - **失敗シナリオ:** Codex が boutique_minimal を選んだ店の公開 demo を、27 インチ（2560）の画面で店主が開く。メニューと住所が細い帯の中で 1 字ずつ縦に並ぶ。1920 の画面でも、本文の列は 480px に縮む（意図した 1080px の列の半分以下）。
   - **提案:**
     - boutique の main の padding を列の中で打ち消す。例: `.canvas[data-direction="boutique_minimal"] .main { max-width: calc(1080px + 2 * var(--pad)); }`、または boutique の main だけ `padding-inline: 0` と `width: min(100% - 2 * var(--pad), 1080px)` にする。
     - `SWEEP_WIDTHS` に 1600・1920・2560 を足す（--pad の切り替わりの 1432 前後も）。
     - 節の中の要素が節の箱からはみ出さない検査（`scrollWidth ≤ clientWidth`）を足す。今の検査は、頁の横 scroll と viewport の外の文字だけを見ている。
     - 既存の不具合なので、別の task に分けてもよい。その場合も、本 PR の §11 の「320〜1440 で全 variant・全 direction を検査」という記述には、1440 より上を検査していないことを明記する。

2. **Medium — review の prompt の「needs_renderer_change は renderer にできないとき（a new layout, a new motif）」が、新しい `layout` の field と衝突する。**（`lib/design-agent/prompts.ts` l.249、`photo-prompts.ts` l.149）
   - 今は語彙に「- layout: the page's structure, designed by you」があり、同じ prompt の数行後に「a new layout は renderer にできない」とある。
   - **失敗シナリオ:** review が「メニューを先に、about を statement に」と考える。それを「a new layout」と読み、`needs_renderer_change = true` を返す。pipeline は `RENDERER_CHANGE_NEEDED` → `blocked` で止まり、選べた改訂 2 回を失う。
     - Stage 1 は「Codex が構造を設計する」ことが目的なので、この誤読が起きやすい場面そのものである。
     - gate を緩める方向には働かない（BLOCK 側）。ただし Stage 1 の比較の実走で、構造の改訂が起きない原因になる。
   - **提案:**
     - 例を「a section kind, variant, ground or first view that is not in the vocabulary, a new motif」に変える。
     - 「layout の設定（節・順・variant・地・first view・type）の変更は profile で直せる。renderer の変更ではない」と 1 文足す。
     - snapshot と、文言の test を更新する。

3. **Low 1 — boutique_minimal の surface の地は plain と「同じ見た目」ではない。それなのに見えない変更として扱っている。**（`visible-profile.ts` の `PANEL_DIRECTIONS`、語彙の「so there surface looks like plain」）
   - 実測: 最初の節を plain → surface にすると、頁の高さが **1440 で +65px、390 で +66px**（2128 → 2193、2336 → 2402）。下の要素がすべて動く。最後の節で試しても同じ。
   - 理由は 3 つ:
     - 帯の padding（`calc(var(--gap) * 0.75)` 上下）が panel の padding（0.6 gap / 28px）に勝つ。
     - 帯の上の区切り線と、次の panel の区切り線が透明になる。
     - 帯の中では `--panel-line` が text の色になる。
   - **失敗シナリオ:** review が boutique の頁で「about を帯で区切って」と plain → surface だけを返す。`REVISION_NOT_VISIBLE_n` → 再質問になる。同じ答えが続けば `NO_VISIBLE_REVISION` で loop が終わり、改訂 1 回分を失う。品質基準は下げない（止まる側）。
   - **提案（どちらか）:**
     - boutique の surface を plain と完全に同じに描く（band の padding・線の上書きを boutique では外す）。
     - または `PANEL_DIRECTIONS` の扱いをやめ、surface を見える変更と数える。語彙の文も「there a surface band is a panel with more space and no rule」などに直す。
     - いずれにしても、画素か DOM の大きさで「同じ」を固定する test を足す。

4. **Low 2 — 名前だけの店では Codex の layout をそのまま保存する。review に見せる profile が描いた頁と一致しない。**（`layout.ts` の `profileAsDrawn`）
   - 例: `firstView: "name_lead"`、`sections: [about/statement/inverted, …]` を返すと、そのまま candidate・final・DB に入る（pipeline-layout の test がそう固定している）。頁は名前だけである。
   - review の「Profile that produced these screenshots」に name_lead・inverted の帯が出る。§11 の理由 (1)（review の profile は実際の頁と一致する）が、この店では成り立たない。
   - **提案:**
     - sections が 0 個になる場合でも、`firstView` と `type` は normalize した値に置き換える。
     - sections は保存できる最小の形にする（Codex のものを残すなら、prompt の側で「この店では sections は描かれない」と review にも明示する。`layoutOptionsLine` は既に brief・review の両方に入るので、firstView の置き換えだけでも効く）。

5. **Low 3 — photo loop では `layout:missing` を記録しない。また、まだ作られていない candidate の adjustments を記録する。**（`photo-pipeline.ts` l.309）
   - `profileAsDrawn` は layout が無いとき adjustments を返さない。DEV-028 の loop の `asDrawn` だけが `layout:missing` を足す。写真のある run では、layout の無い改訂が report に残らない。
   - また、`direct()` が失敗して `candidate-n` が作られない場合でも、`candidate-n` の adjustments が report に残る。
   - **提案:** pipeline の `asDrawn` を Ctx で渡して共用する。記録は `revisions += 1` の後に置く。

6. **Low 4 — 描かれない設定を「見える」と数える場面が増えた（保守的な側。round を空費する）。**（`visible-profile.ts`）
   - `composition.grid`: 次の場合は効かない。
     - 節が `vertical_ja` のとき（`grid-template-columns: auto 1fr`）
     - `statement` / `stacked` のとき（1 列）
     - `side_heading` のとき（固定の 1 : 2.6）
     - 頁のすべての節がこれらなら、grid の変更は screenshot に出ない。
   - `composition.infoStyle`: visit が `ledger` のときだけ効く（語彙もそう書いている）。cards・split・stacked、または visit 節が無い頁では出ない。
   - DEV-066 の Low と同じ種類で、品質基準には影響しない。
   - **提案:** drawn layout から「grid が効く節があるか」「ledger の visit があるか」を見て数える。少なくとも blockers に記録する。

7. **Low 5 — kind の重複は答え全体を拒否する（brief なら既存の template に戻る）。**（`LayoutSchema` の refine）
   - JSON Schema では kind の一意を表せない（`uniqueItems` は variant の違う同じ kind を止めない）。そのため Codex が `menu` を 2 回入れると、次のようになる:
     - brief なら `BRIEF_PROFILE_INVALID` → `fallback_template`
     - 改訂なら `REVISION_INVALID_n`
   - 一方、`normalizeLayout` には `duplicate:<kind>` の処理がある。motifs の重複と同じ既存の慣習ではある。
   - loose mode では `maxItems` も外れるので、5 節の答えも同じく拒否される。
   - **提案:** Codex の答えに限り、parse の前に重複を最初の 1 つに畳み、`duplicate:<kind>` を記録する。拒否のままにするなら、実走の report でこの note の頻度を見る、と decision に残す。

### Nits

- N1 — 語彙の ground の説明で、boutique_minimal の inverted は「primary の全幅の帯」ではない。実際は panel の列の中の、text の色の面（071a の記録どおり）。「boutique_minimal: a band is a panel of its own, the inverted one in the text colour」と書くと事実に合う。
- N2 — review の固定文「Revise with settings the screenshots show: … only motion, confidence or rationale renders the same page.」が古い。`notVisibleLine` は更新済みだが、こちらには layout の描かれない設定（事実の無い first view・節、短い節の縦の見出し）が無い。
- N3 — `components/demo/profile/sections/common.tsx` で、`chars` を消した跡に空行が 2 行残っている。
- N4 — `design-bridge-bypass-setup.test.ts` の「no execve …」は、単独でも 4.9〜5.1 s で、既定の 5 s の timeout の境目にある（container の load average 11 前後）。
  - 本 branch は、この test・`scripts/`・package.json・vitest の設定に触れていない。test は lib を import せず、strace で bash script を 2 回走らせるだけである。
  - よって本 PR が遅くしたものではない。load と strace の重さによる。
  - 別の task で、この test に明示の timeout（例 30 s）を付けるとよい。

## 確かめて問題なかったこと（reviewer）

- `normalizeLayout` の冪等性は、全事実の組み合わせ × first view の全値で test されている。新しい `headings:vertical_ja` も、2 回目には何も変えない（ja_only になるため）。
- renderer の data-short と `sectionIsShort` の規則は同じ:
  - visit の行は `infoRows` と同じ 5 項目で、hours 節があれば hours・closedDays を除く。
  - hours 節の有無は、描く節の一覧から決める。
- `data-scale` は `.sec` にだけ効く。節の無い頁で type を見えない扱いにするのは正しい。`data-headings` も節の見出しだけに効く。
- 語彙の数値は CSS と一致する:
  - quiet 0.72 / 0.94、dramatic 1.38 / 1.1
  - statement の上の 56px の bar
  - columns の 3 列と点線
  - stacked の中央 1 列
  - strip は 720px 以上で横並び
  - alignment=center は新しい variant（chips・cards・statement など）にも効く（sections.module.css l.409–417）
- `surfaceShown` は、boutique を plain に写した後で判定する。boutique は `SURFACE_DIRECTIONS` に入っているので、surface の色の変更は常に見える扱い（正しい）。
- low confidence で brief に layout が無いときは、`DEFAULT_LAYOUT` を使う（test あり）。category default の 3 つは、どれも `DEFAULT_LAYOUT`。
- prompt の長さの増分（brief 約 +980 token、review 約 +970 token）は §11 の表どおり。Codex の呼び出し回数は変わらない。
- 新しい browser test の 13 幅 × 10 direction は、`expect.soft` で全組み合わせの失敗を集める。主張の強さは十分（幅の上限を除く。High 1）。

## 対応（実装者、merge 前）

commit: 044159d（High）・7f8f48d（Medium・N1・N2）・d62e6ee（Low 1〜5・N3）・431a617（N4、別 commit）・本 commit（文書）。

1. **High（boutique_minimal の 1440px 超）**: `profile.module.css` の boutique の main を `max-width: calc(1080px + 2 * var(--pad))` に
   （main 自身の左右の padding を列の外に足す）。layout の有無にかかわらず直る。実画面（`next build` + `start`、bakery）:
   直す前 1920 で節の幅 480・2560 で 80（頁の高さ 6,457px）→ 直した後 1920・2560 とも 1080（`scratchpad/stage1/wide/`）。
   - 幅の検査を 320〜2560 の 17 幅に（1432・1440・1600・1920・2560 を追加）、「節の中の語が節の箱の中にある・節が横に scroll しない」検査を追加。
     全 direction × 全 variant で走らせ、次の 2 件が新たに見つかったので直した:
     - split の visit 行: 1100px でも列が狭く電話番号が節の外へ。viewport の幅ではなく、行の列自身の幅（container query、26em 以上）で
       label と値を横に並べる
     - pop_bakeshop の和文の見出し語（傾いた pill）が 320px で節から 2px 出る: 見出し語に `max-width` を付けて pill の中で折り返す
       （縦書きの見出しは対象外）
2. **Medium（needs_renderer_change の例）**: review と photo review の文を「語彙に無い節の種類・variant・地・first view・type の設定・motif」に変え、
   「layout（節・順・variant・地・first view・type）の変更は profile の変更、revised_profile で」と明記。test で「a new layout」が無いことを固定。
3. **Low 1（boutique の surface）**: 描かれ方が違う（Chromium で高さが増えることを test）ので、見える変更として数える（`PANEL_DIRECTIONS` を削除）。
   語彙も「boutique では帯は panel の列の中: surface は余白が多く上の罫の無い panel、inverted は primary の panel」に（N1 も同時に）。
4. **Low 2（名前だけの店）**: 節 0 の頁でも first view と type は normalize した値を保存し、sections だけ Codex のもの（保存の形を保つため。
   描かれないことは layoutOptionsLine が brief と review に書く）。
5. **Low 3（photo loop）**: `profileAsDrawn` が layout の無い答えに `layout:missing` を返し、両方の loop で記録。photo loop の改訂の符号は
   candidate ができた後（`revisions += 1` の後）に記録。test あり。
6. **Low 4（描かれない設定）**: `composition.grid` は節の無い頁、または editorial_12 ↔ asymmetric_7_5 で全節が自分の列を決める
   （statement・stacked・side_heading、縦書きの見出し）ときは見えない扱い。`infoStyle` は ledger か split の visit があるときだけ、
   `divider` は節が 2 つ以上のときだけ見える。single_column との変更は見出しの大きさが変わるので見える（test あり）。
7. **Low 5（kind の重複）**: Codex の答え（brief、両 loop の改訂）を check の前に `collapseRepeatedSections` で最初の 1 つに畳み
   `duplicate:<kind>` を記録。review の答えの parse は `DesignProfileAnswerSchema`（重複を許す）にして、重複で review が無効にならない。
8. **Nits**: N1 は 3 と同時、N2 は「Revise with settings…」に描かれない layout の設定を追加、N3 は空行を削除、N4 は strace の test に 20 秒の
   timeout（別 commit 431a617、検査の中身は不変）。


## 再レビュー（83838bf）

Reviewer: 同じ Fresh Reviewer（2026-10-20）。対象は `git diff 9e28d88 83838bf`。
Verdict: **FAIL**（直すのは `visibleChanges` の隠す規則の 2 か所だけ。他の対応はすべて確認済み）
Counts: Critical 0 / High 0 / Medium 1（新規）/ Low 1（新規）/ Nit 1

### 実行したこと

- **`npx vitest run tests/unit/design-agent` の全体**（Chromium あり）を実行した。
  - 結果は 47 files pass / 2 failed / 2 skipped、662 pass / 2 fail、822 s。
  - 落ちたのは次の 2 件で、どちらも本 branch が触れていない file:
    - `browser.test.ts`「in C, stops at once … during sampling」（off-site の要求 15 > 3）
    - `renderer-jp-name.test.tsx`「never breaks inside a piece …」（180 s の timeout）
  - 実行中の load average は 23〜26。私の probe を同時に走らせたことも load の一因。
  - 2 file を単独で再実行すると **84 / 84 pass**（jp-name は 148 s）。load による flake と判断する。
  - jp-name は 180 s の上限に近いので、Nit 1 に記録した。
- `tests/unit/ai-tasks*` → 83 pass。
- `npx eslint`（変更した ts/tsx 全部）→ 0。
- `npm run build` → 成功。その後の `npx tsc --noEmit` → 0。
- 一時の Chromium probe（実行後に削除。tree は本ファイル以外は無変更）。中身は次の 2 つ:
  - **隠す規則の画素比較:** `visibleChanges` が `[]` を返す組を、10 direction × 1440 / 390 で描いて比べた。対象は grid・infoStyle・divider の 7 種の場面。
  - **split の container query:** 10 direction × alignment left / center × infoStyle 3 種 × 320 / 390 / 760 / 1024 / 1440 / 1920 で、次を検査した。
    - 行の幅
    - dt / dd のはみ出し
    - 横 scroll
- Vercel・Supabase・WSL・他の worktree には触れていない。commit・push もしていない。

### 前回の指摘の確認

- **High（boutique の 1440 超）— 解消。**
  - `max-width: calc(1080px + 2 * var(--pad))` なので、中身は常に 1080px になる。
  - 17 幅の sweep と「節の箱の中の語」の検査は全体の実行で pass した。
- **container query — 問題なし。**
  - `next build` の CSS に `container-type:inline-size` と `@container (min-width: 26em){…splitRow{…}}` がそのまま残る。review の screenshot は同じ Chromium（Playwright）で preview の頁を撮るので、描き方は test と同じになる。
  - `.splitRows` の inline-size の封じ込めは、縮む文脈で幅 0 に潰れるおそれがある。そこで alignment=center・colophon の中央揃えでも確かめたが、全組み合わせで行の幅は 120px 以上、はみ出し 0、横 scroll 0 だった。
- **Medium（needs_renderer_change の文）— 解消。**
  - review と photo review のどちらも、例は「語彙に無いもの」だけになった。「layout の変更は profile の変更」も明記された。
- **Low 1（boutique の surface）— 解消。**
  - `PANEL_DIRECTIONS` は削除され、surface は見える変更として数える。
  - 語彙も事実どおりになった（panel の列の中。inverted は primary の panel）。
- **Low 2（名前だけの店）— 解消。**
  - first view と type は normalize した値で保存し、sections だけ Codex のもの（1 節以上の形を保つため）。
  - `LayoutSchema.safeParse` に通すので、保存できない形にはならない。
- **Low 3（photo loop の記録）— 解消。**
  - `profileAsDrawn` が `layout:missing` を返し、両方の loop で記録する。
  - photo loop の符号は `revisions += 1` の後で記録する。
- **Low 5 / DesignProfileAnswerSchema — 安全。**
  - review の答えの parse は、重複と 5 節以上を許す。ただし profile として使うのは、`collapseRepeatedSections` → `checkProfile`（`DesignProfileSchema`、1〜4 節・kind 一意）→ `profileAsDrawn` の後だけ。
  - brief、DEV-028 の通常の改訂、再質問の改訂、photo loop の改訂の 4 か所すべてで、この順を確かめた。
  - `writeProfile`・`visibleChanges`・leader・final に入るのは、check 済みで描いた形だけ。
  - 畳む前の生の答えが残るのは `review-<c>.json` などの記録だけで、以前と同じく local。
  - 畳むときは最初の 1 つを残す。`normalizeLayout` の duplicate と同じ規則。
- **N1〜N4 — 解消。**

### 新規

1. **Medium — Low 4 の対応で、見える変更を「見えない」と数える場面ができた: 1 行だけの visit を cards / stacked で描く頁の `composition.infoStyle`。**（`visible-profile.ts` の `ledgerShown`）
   - `profile.module.css` l.726–727 の 2 つの rule は、visit の variant に関係なく `data-single`（visit の行が 1 つ）の節に効く:
     - `.canvas[data-info="colophon"] .section[data-single] { grid-template-columns: minmax(0,1fr); justify-items: center; text-align: center; }`
     - 同じく `.heading { flex-direction: row; justify-content: center }`
   - colophon にすると、節は 1 列で中央揃えになり、見出しは横並びになる。
   - **実測（1440、10 direction とも）:**
     - cards: ruled_list → colophon で頁の高さが +38〜+101px。節の組みも、見出しの左列 → 中央の 1 列に変わる。
     - stacked: −19〜−51px。
     - ところが `visibleChanges` は `[]` を返す。
   - **失敗シナリオ:** 住所しか無い店で、Codex が visit を cards にした頁。review が「店舗情報を中央に」と infoStyle だけを colophon に変える。`REVISION_NOT_VISIBLE_n` → 再質問になり、同じ答えなら `NO_VISIBLE_REVISION` で loop が終わる。頁は実際に変わる改訂なのに、1 回分を失う。品質基準は下げない（止まる側）。
   - 見える変更を見えないと数える誤りは、逆の誤り（round の空費）より悪い。実装者の方針（DEV-066）でも、判定は「見える」側に倒すことになっている。
   - **提案:**
     - `ledgerShown` に「visit の行が 1 つの頁（`data-single` になる頁）」を足す。行の数は `infoRows` と hours 節の有無から決まり、`sectionIsShort` と同じ計算でよい。
     - または、infoStyle を隠すのは「visit 節が無い頁」だけにする。
     - この組を画素で固定する test を足す。

2. **Low — `composition.grid` の editorial_12 ↔ asymmetric_7_5 を、全節が statement / stacked / side_heading の頁で見えない扱いにしているが、実際は節の行の間隔が変わる。**
   - `profile.module.css` l.714–715 の grid の rule は、列と同時に `gap: 40px` / `48px` を決める。statement・stacked は 1 列で、見出しと本文の 2 行なので、row-gap の 8px が節ごとに効く。side_heading でも、写真が無ければ 1 行のはずが差が出た。
   - **実測（1440、10 direction とも）:**
     - statement + stacked の頁で +16px
     - side_heading + stacked の頁で +8px
   - 縦書きの見出し（vertical_ja）の頁は 0 差で、正しい。
   - 見た目の差は小さい（列は同じで、間隔が 8px ずつ）。review が狙う「列の比」は確かに描かれないので、実害は小さい。
   - ただし「同じ頁」ではない。
   - **提案（どちらか）:**
     - この組では grid を隠さない（保守的な側）。
     - sections.module.css で statement / stacked / side_heading の `row-gap` を固定し、grid に依存しないようにしてから隠す。

### Nit

- N1 — `renderer-jp-name.test.tsx` の「never breaks inside a piece …」は、load 23 前後で 180 s の上限を超え、単独では 148 s かかった。本 branch は触れていない。DEV-071a の Low 4（phone の枠の test）と同じく、browser context を使い回して分割すると安定する（別 task）。

### 結論

- 安全側（事実と固定語だけ・根拠の無い節を描かない・保存する profile = 描いた形・注記・contrast・品質ゲート）に退行は無い。
- 前回の High・Medium・Low 1〜3・Low 5・Nits はすべて解消した。
- Low 4 の対応で入った隠す規則のうち、infoStyle の 1 行の visit（Medium）は、見える変更を見えないと数える。品質基準は下げない。ただ、DEV-066 の判定の原則（迷ったら見える側）に反するので、merge の前に直すことを求める。
- 直した後は、`visible-profile.ts` と test の差分だけを確認すれば PASS にできる見込み。

## 対応 (2)（実装者、再レビューへ）

1. **Medium（1 行の visit と infoStyle）**: `composition.infoStyle` は visit 節があれば（variant を問わず）見える変更にした（colophon は 1 行の visit を
   variant に関係なく中央に組むため）。visit 節の無い頁だけが見えない扱い。
2. **Low（grid の gap）**: editorial_12 ↔ asymmetric_7_5 を見えない扱いにするのは、両方の頁の見出しが縦書き（vertical_ja、列も間隔も見出しの規則が決める）
   のときだけにした。statement・stacked・side_heading だけの頁でも見える変更（gap 40 / 48px）。節の無い頁では grid は見えないまま。
   迷うときは見える側（誤って見える＝もう一度の質問だけ、誤って見えない＝本物の改訂を捨てる）。
3. **安全網の test**（`tests/unit/design-agent/renderer-visibility.test.tsx`、Chromium）: direction ごとに、5 店（visit 多行・visit 1 行・事実の少ない和文の店・
   縦書きの店名の店・名前だけ）× 6 layout（無し・DEFAULT・自分で列を決める variant・cards と inverted・縦書き・coverage）の profile から、
   grid・infoStyle・divider・surface・accent・motif の順・motion・first view・見出しの型・type の scale・地を 1 つずつ変えた組を作り、
   `visibleChanges` が `[]` を返す組をすべて 1440 と 390 で full page に描いて、画素（PNG の byte）が一致することを確かめる。
   markup が同じ組は同じ頁なので描かない（描く組は direction ごとに 40 以上を下限で確認、見えない組は 60 以上、grid・info・divider・
   first view・見出し・scale・motion の各種類を含む）。所要は direction ごと 34〜46 秒（10 test、計約 7 分）。
   - 検出力の確認: infoStyle の規則を直す前（ledger だけ）に戻すと、1 行の visit の組（cards・stacked・縦書き・coverage）で失敗する。
4. **Nit（jp-name の test の所要）**: 指示どおり触れない。

## 再レビュー (2)（879b7f8）

Reviewer: 同じ Fresh Reviewer（2026-10-20）。対象は `git diff 83838bf 879b7f8`（`visible-profile.ts`・`renderer-visibility.test.tsx`・`pipeline-visible-revision.test.ts`・文書）。
Verdict: **PASS**
Counts: Critical 0 / High 0 / Medium 0 / Low 2（新規、merge を止めない）/ Nit 1

### 実行したこと

- **`npx vitest run tests/unit/design-agent` の全体**（Chromium あり）を実行した。
  - 結果は 49 files pass / 1 failed / 2 skipped、673 pass / 1 fail、959 s（load average 12〜17）。
  - 落ちたのは `browser.test.ts`「in C, a page that left the site is closed at once even when page.close() never settles」（5027 ms、既定の 5 s の timeout）。
  - load の無い状態で `browser.test.ts` を単独で実行すると **76 / 76 pass**（同じ test は 2017 ms）。本 branch はこの file に触れていない（前回の 2 件と同じ種類の load の flake）。
  - 新しい `renderer-visibility.test.tsx` は 10 / 10 pass（suite の中では 765 s）。
- `renderer-visibility.test.tsx` を **単独で、load の無い状態で** 実行: 373 s（4 CPU）。
- `tests/unit/ai-tasks*` → 83 pass。
- `npx eslint`（変更した ts/tsx 全部）→ 0。
- `npm run build` → 成功。その後の `npx tsc --noEmit` → 0。
- 一時の vitest（browser なし、実行後に削除）で、safety net の「縦書きの見出しの頁の grid」が実際に隠す側の組として描かれることを確かめた。
  - vertical の layout を full・one_visit_row・sparse_jp の店に当てると、短い節があるので ja_only に落ちる。この場合 grid は「見える」になる。
  - vertical_jp（THREE_SHOPS.bakery）の店では vertical_ja のまま残り、grid は `[]` になる。data-grid が違うので HTML も違い、画素で比べられる。
- tree は本ファイル以外は無変更。commit・push はしていない。

### 前回の指摘の確認

- **Medium（1 行の visit の infoStyle）— 解消。**
  - `ledgerShown` は「visit 節がある頁」になった。variant を問わない。
  - colophon の `.section[data-single]` の rule（variant に依存しない）を含めて、visit のある頁の infoStyle は常に見える扱いになる。
  - 隠すのは visit 節の無い頁だけで、そこでは `.visit`・`.rows`・`.row`・`.address`・`data-single` が DOM に無いので、何も描かれない。
- **Low（grid の 12 ↔ 7_5）— 解消。**
  - 隠すのは「両方の頁が縦書きの見出し」のときだけになった。statement・stacked・side_heading の頁は見える扱いになる（前回の +8 / +16px の差）。
  - 縦書きの見出しでは、`[data-headings="vertical_ja"] .sec.sec.sec`（0,4,0）が列と column-gap を決める。節は見出しと本文の 1 行なので、grid の row-gap（40 / 48）は効かない。
    - 前回の probe で 10 direction × 1440 / 390 とも 0 差だった。
    - 今回の net でも、vertical_jp の店で画素の一致を確認している。
  - 頁の無い節（名前だけの店）では grid も隠す。`.heading`・`.section` が無いので正しい。
- **退行なし。**
  - 判定を「見える」側へ戻しただけなので、前回までの規則（surface・accent・divider・layout の正規化）は不変。
  - `pipeline-visible-revision.test.ts` の変更は期待値の更新（infoStyle・grid が見える組）で、緩めたものは無い。

### safety net（`renderer-visibility.test.tsx`）の評価

**意味のある検査になっている。**
- **検査の向き:** `visibleChanges` が `[]` を返す組だけを集め、2 つの頁を 1440 と 390 で描き、full page の PNG の byte 一致を求める。誤りの悪い側（見える変更を見えないと数える）を直接検査する向きである。
- **組の数の下限:** direction ごとに、隠す組 60 超・描く組 40 超を要求する。主な設定（grid・info・divider・first_view・headings・scale・motion）の組が 1 つ以上あることも要求する。
- **HTML が同じ組を飛ばすこと:** 安全。同じ markup・同じ CSS・同じ Chromium は同じ画素になる。飛ばされるのは、正規化で同じ描画計画になる組（事実の無い first view、短い節の縦の見出しなど）だけで、どちらも renderer と `visibleChanges` が同じ `normalizeLayout` を通る（構造上の一致）。data 属性が変わる組（grid・info・divider・motion の attribute など）は必ず描かれて比べられる。
- **比べ方:** 比較は厳密な byte 一致で、許容の幅は無い。前回の Medium を戻すと、one_visit_row の店で落ちる（実装者の確認どおり。colophon の `data-single` で頁の高さが変わるため）。
- **設定の範囲:**
  - 節の順と variant の変更は含まれない。ただし、それらは描かれる節が変わる限り常に「見える」で、隠れるのは正規化で消える節だけ。そちらは name_only の店で検査されている。十分と判断する。
  - surface:
    - surface の帯がある layout（fixed_columns）と無い layout がある。
    - surface を描く direction（kissaten・boutique・pop）と描かない direction の両方を回す。
    - 隠す側の組が描かれる。
  - accent:
    - 隠す側の組は、accent の motif が無い頁・accent の direction 以外で描かれる。
    - 不足は Low 2 の 1 点。

### 新規

1. **Low — CI の unit の時間の余裕が小さい。**
   - `renderer-visibility.test.tsx` は、1 file の中で 10 direction を順に回す。load の無い 4 CPU でも 373 s、load があると 765 s かかり、suite で最も長い file になる。
   - vitest は file 単位で並列に動く（config で worker 数の指定は無いので、既定の CPU 数に応じた数）。そのため、この 1 file が job の長さの下限を決める。
   - CI の unit は約 7 → 約 11 分になった。job の `timeout-minutes: 15` には npm ci・playwright install・bwrap の準備・cross-user の段も含まれるので、残りは約 4 分。runner が遅い日や、今後の Chromium の test の追加で超えうる。
   - 今は green なので、merge は止めない。ただし保証を保ったまま軽くすることを勧める。案:
     - **(a) file を分ける:** 10 direction を 2〜3 個の file（例: direction の配列を半分ずつ）に分ける。vitest の worker に並列で載るので、wall time は約半分になる。組と比較の中身は同じなので、保証は変わらない。最も簡単。
     - **(b) 390 の比較を絞る:** 390 で描く組は「390 でも差が出うる設定」だけにする。phone でも効く設定（infoStyle・divider・surface・accent・motifs・地・type）は残し、grid（720px 以上だけで効く）と縦書きの見出し（desktop だけ）は 1440 だけにする。CSS の media の条件に沿うので、保証は保てる。
     - **(c) 一致の確認を早く打ち切る:** 同じ (shop, layout) の基準の画像の cache は既にある。full page の PNG を base64 にして比べる代わりに、Buffer の比較か `page.screenshot` の viewport の clip を順に比べれば、byte の生成と比較の費用が少し減る（効果は小さい）。
   - 合わせて、unit の job の `timeout-minutes` を 20 に上げることも検討してよい（人の判断）。

2. **Low — safety net の小さな穴（前の規則のうち、net に掛からないもの）。**
   - 基準の profile の motifs は `["monogram","corner_marks"]` に固定されている。そのため「accent の motif があるが gallery_mono（NO_ACCENT_DIRECTIONS）なので accent が見えない」組は作られない（DEV-067 の規則で、本 PR の新規ではない）。
   - divider の「節が 1 つの頁」は、net では作られない（店は 0 節の name_only か 2 節以上だけ）。前回の私の probe では、1 節の頁の divider は 10 direction × 1440 / 390 で 0 差だった。
   - **提案:** motifs に `dot_grid` を持つ基準を 1 つと、visit だけの店（説明・メニューなし）を SHOPS に足す。組が数十増えるだけなので、Low 1 の (a) と一緒に入れるとよい。

### Nit

- N1 — `browser.test.ts`（DEV-0xx の browser の close の test 群）は、load の下で既定の 5 s の timeout を超えることが、前回と今回で計 2 件あった（単独では 2〜3 s）。本 branch の範囲外。DEV-071b の N4 と同じく、明示の timeout を付ける別 task を勧める。

### 結論

- 前回の Medium と Low は解消した。新しい safety net は、`visibleChanges` の誤りの悪い側（見える変更を見えないと数える）を画素で検査する、意味のある検査である。
- 安全側（事実と固定語だけ・根拠の無い節を描かない・保存する profile = 描いた形・注記・contrast・品質ゲート）に退行は無い。
- 残りは CI の時間の余裕と net の小さな穴（Low 2 件）で、merge を止めない。
- **PASS。**

## merge 前の対応（再々レビュー PASS の Low・Nit）

1. **Low 1（CI の余裕）**: `renderer-visibility.test.tsx` を `renderer-visibility-support.tsx`（`defineVisibilityTests(part)`・`VISIBILITY_PARTS`）と
   `renderer-visibility-{1,2,3}.test.tsx` に分けた（vitest が並列に走らせる）。part 1 に「3 つの part が全 direction をちょうど 1 回ずつ持つ」test。
   検査の中身と direction ごとの下限（見えない組 60 以上・描く組 40 以上・各種類）は同じ。加えて、同じ 2 つの頁になる組は 1 回だけ描き
   （名前だけ・visit だけの店では多くの layout が同じ頁になる）、比べる画像は JPEG（品質 100: 同じ画素は同じ byte、PNG より速く符号化）にした。
   - wall time（この container、load average 4〜11）: 3 file 並列で **約 3 分 6 秒**（file ごと 149 / 151 / 約 180 s）。分割前の 1 file は約 6 分（reviewer 373 s）。
   - 検出力: infoStyle の規則を直す前に戻すと、引き続き 1 行の visit の組で失敗する（JPEG の比較でも確認）。
2. **Low 2（網の穴）**: base の motif に accent の motif を含む組（`dot_grid`、DEFAULT と layout なしの 2 つ）と、visit だけの 1 節の店を追加。
   gallery_mono では accent の変更が見えない組が描かれること、どの direction でも 1 節の頁の divider の組が描かれることを test で確認。
3. **Nit（browser.test.ts）**: 該当する 2 つの test（「in C, stops at once on a move off the site during sampling」「in C, a page that left the site is
   closed at once even when page.close() never settles」）は、既に file の `testTimeout: 60_000` と明示の `{ timeout: 60_000 }` を持つ。
   load の下での失敗は timeout ではなく「off-site requests after the move ≤ 3」の assertion（12・16 件）なので、timeout を足しても変わらない。
   assertion は変えない指示のため、この commit では触れていない（必要なら別の task で load への強さを見直す）。
4. **.ai**: tasks.json の DEV-071 を done（残りの follow-up を decision に記録）、progress.md に 1 行。
