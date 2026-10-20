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

