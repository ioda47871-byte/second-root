# 限定的自動修正の設計とオフライン試作 (DEV-146、Issue #177 D、MOCK のみ)

Issue #177 の D の段にあたる。**実運用では何も有効にしない。**修正ループ、worker、生成器を自動で起動することはない。
ここにあるのは、設計と、どこにも配線していないオフラインの試作だけである。

- 試作のコード: `lib/design-agent/autofix-mock/` (`patches.ts`、`locate.ts`、`run.ts`)
- テスト: `tests/unit/design-agent/autofix-mock/`

試作は lib・app・components・scripts のどこからも import されない (隔離テストで固定)。描画、SP の検査、Identity の判定は、
呼ぶ側が port として渡す。このレーン自身は、ブラウザ・プロセス・通信・ファイル・Codex・worker・Phase 2f のモジュールに触れない。

## 1. 範囲 (測れるものだけ)

| 原因 (cause) | 引き金になる所見 | 由来 |
| --- | --- | --- |
| `HORIZONTAL_OVERFLOW` | `PAGE_HORIZONTAL_OVERFLOW` (SP 390 の `scrollWidth > 390`) | Phase 2f の描画が記録する幅。このレーンが名前を付ける |
| `TEXT_CLIPPED` | `SP_TEXT_CLIPPED` | DEV-134 の SP 検査 |
| `TAP_TARGET` | `SP_TAP_TARGET_BELOW_44` / `SP_TAP_TARGET_TOO_SMALL` | 同。二つは同じ原因として扱う (24px 未満が 44px 未満に変わっただけなら、直っていない) |
| `TEXT_TOO_SMALL` | `SP_TEXT_TOO_SMALL` | 同 (12px 未満) |

**範囲に入れないもの:**

- 見た目の良し悪し (余白、配色、書体、構図、強弱)
- 意図した可能性がある重なり (`SP_TEXT_OVERLAP`・`SP_TEXT_COVERED`)。写真の上の文字や飾りの文字を機械的に禁止しない (DEV-140)
- 画面外の文字 (`SP_TEXT_OFFSCREEN`)。右へ押し出した引き出しと、誤って押し出された行を見分けられない (DEV-140 の既知の誤検知 `drawer_translated`)
- 薄い文字・押し込まれた文字・自分の箱の外の文字 (`SP_TEXT_FADED`・`SP_TEXT_SQUEEZED`・`SP_TEXT_OUT_OF_BOX`)
- 事実と文 (`SP_FACT_HIDDEN`、店名の位置 `SP_SHOP_NAME_NOT_IN_FIRST_SCREEN`)、構造やレイアウトの組み直し、Identity

## 2. 修正の形

- 直すのは**実装の CSS だけ**である。Codex の試作は直さない。入力は `source: "implementation"` に限る。ほかの値は `NOT_IMPLEMENTATION_CSS` で止める。
- 修正は小さく決まった CSS の上書きである。実装の CSS の**末尾に足す**だけで、元のバイト列はそのまま前に残る。
  `@media (max-width: 480px)` の中に、見つかった selector の規則を1つ置く。PC 1440 のページには掛からない。
- 宣言は固定の表から取る。自由な文は入らない。`!important` も使わない。

| 原因 | 1回目 (v1) | 2回目 (v2) |
| --- | --- | --- |
| `HORIZONTAL_OVERFLOW` | `max-width: 100%; box-sizing: border-box` | v1 + `flex-wrap: wrap; overflow-wrap: anywhere` |
| `TEXT_CLIPPED` | `height: auto; max-height: none` (固定の高さを外す) | v1 + `overflow: visible` |
| `TAP_TARGET` | `min-width: 44px; min-height: 44px; box-sizing: border-box` | v1 + `display: inline-block` |
| `TEXT_TOO_SMALL` | `font-size: 12px` | なし |

- 色、書体、表示・非表示、`content`、位置、変形には触れない。HTML と文と事実も変えない。port には、いつも元の HTML のバイト列を渡す (テストで1バイトずつ確かめる)。
- selector は位置を探す道具 (`LOCATE_SCRIPT`) が出す。形は、要素名・`#id`・`.class`・`:nth-of-type(n)` を ` > ` でつないだものに限る。規則を閉じる文字、注釈、文字列は通さない。ほかの形の答えは `PORT_ANSWER_INVALID` で止める。
- 位置を探す道具は検査ではない。原因があるかどうかは SP の検査が決める。道具は、その場所を言うだけである。意図した可能性のあるものは、わざと場所として出さない。
  - `position: absolute` や `fixed` で置いた文字、`aria-hidden` の文字、横だけの切り抜き
  - transform や fixed で画面の外に置いた引き出し
  - そのため DEV-140 の既知の誤検知 `deco_type_not_marked` (切れた飾りの文字) は、所見があっても直さない (`skip:TEXT_CLIPPED:not_located`)

## 3. 適用 → 再描画 → 再検査

1. Identity を見る。`PASS_IDENTITY_ONLY` 以外なら、その場で止める。修正はしない。
2. 元の CSS を描画し、検査する (所見の基準)。
3. 範囲内で、場所の分かった原因を1つ選ぶ。順序は決まっている (原因名の順)。その原因の n 回目の修正を作り、**diff** (unified diff、文脈3行) を記録する。
4. 修正した CSS で Identity を見てから、描画と検査をやり直す。次の三つをすべて満たすときだけ、修正を残す。
   - 狙った原因の所見が消えた (同じ原因の別のコードに変わっただけなら、消えていない)
   - 何も悪くなっていない (回帰の確認)。コードだけでなく、**1件ずつ**比べる。次のどれかがあれば戻す。
     - 前に無かったコード
     - 前に無かった (コード、文) の組。SP の検査の `examples` (コードと文の先頭40字) で比べる。そのため、すでにあるコード (DEV-140 の誤検知や範囲外の所見) が、同じコードの新しい1件を隠すことはない。事実が隠れる (`SP_FACT_HIDDEN`) のも、ここで分かる
     - 問題のある文の数 (`counts.text_nodes_with_problems`) が増えた
     - 狙った原因が押す所でないのに、小さな押す所の数が増えた
   - PC 1440 の描画が、元からほとんど変わっていない (`PC_CHANGE_MAX` = 画素の 0.1%。テストでは既存の `compare/metrics.ts` の `pixelDifference` を使う。media query のおかげで普通は 0)。**この値は模擬の値で、採用した閾値ではない** (§6)

   検査の `examples` は10件で打ち切られる。10件に達したときは、全部を比べられないので、その場で止める (`INSTANCES_TRUNCATED`)。

   ほかは戻す。直す前の CSS を使い続け、戻した理由 (`NOT_RESOLVED` / `NEW_FINDING` / `PC_CHANGED`) を記録する。
5. 範囲内の原因が残っていなければ終わる。1つでも残した修正があれば `owner_review` で終わる。**提案の CSS (`proposed_css`) と diff を返すだけで、適用はしない** (`applied: false`)。合格扱いにもデザインの承認にもしない。何も無ければ `no_change`。

## 4. 上限と停止

- 上限は DEV-129 の模擬の制御 (`runLoop` の `LIMITS`) と同じ値にする。1回の実行で試す修正は3つまで、1つの原因には2つまで。
  - 制御のファイルは隔離テストで「どのコードからも import されない」と固定されているので、値を写し、テストで一致を固定した。
- 次のときは、その実行を止めてオーナーに返す (`stopped`、`owner_check: true`)。**元の CSS を残し**、提案は出さない。
  - 試す数を使い切ったとき (`RETRY_BUDGET_EXHAUSTED`)
  - 同じ原因の上限を越えたとき (`SAME_CAUSE_FIX_LIMIT`)
  - 次の修正の案が無いとき (`NO_FURTHER_PATCH`)
- 次のときは、その場で止める。
  - Identity が `HOLD` か `REJECT` (`IDENTITY_*`)。最初でも、修正した CSS でも同じ
  - 自分のファイル以外への通信を試みた (`RENDER_BLOCKED_REQUEST`)
  - 検査ができなかった (`SP_CHECK_UNAVAILABLE`)
  - 答えの形がおかしい (`PORT_ANSWER_INVALID`)
  - 検査の `examples` が上限の10件に達した (`INSTANCES_TRUNCATED`)
  - port が例外を投げた (`PORT_THREW`)
- やり直しはしない。

## 5. 試作の結果 (MOCK、架空のページ)

DEV-140 のコーパスのページと、架空のページを使った。Chromium で Phase 2f の描画 (`renderPrototype`、JS 無効・通信遮断) と SP の検査を通している。

| 場面 | 元の所見 | 結果 |
| --- | --- | --- |
| 押す所 30×30 (`small_buttons`) | `SP_TAP_TARGET_BELOW_44` | v1 を残す → 所見なし・新しい所見なし・PC の変化 0、`owner_review` |
| 押す所 16×16 (`tiny_buttons`) | `SP_TAP_TARGET_TOO_SMALL` | v1 を残す → 所見なし、`owner_review` |
| 固定の高さで切れた文 (`clipped_copy`) | `SP_TEXT_CLIPPED` | v1 (高さを外す) を残す → 所見なし、`owner_review` |
| 900px の行 | `PAGE_HORIZONTAL_OVERFLOW`、`SP_TEXT_OFFSCREEN` | v1 (`max-width`) を残す → どちらも消える、`owner_review` |
| `!important` で小さく固めた押す所 | `SP_TAP_TARGET_BELOW_44` | v1・v2 とも `NOT_RESOLVED` で戻す → `SAME_CAUSE_FIX_LIMIT` で停止、元の CSS |
| 高さを外すと文がラベルの下に入る | `SP_TEXT_CLIPPED` | v1・v2 とも `NEW_FINDING` (`SP_TEXT_OVERLAP`) で戻す → `SAME_CAUSE_FIX_LIMIT` で停止 |
| 意図した作り6件 (写真の上の文字・aria-hidden の飾り・縦組み・固定ヘッダー・印の無い飾りの文字・右の引き出し) | なし、または範囲外・場所を出さないもの | `no_change`。修正なし |
| Identity の食い違い | — | 描画の前に `IDENTITY_REJECT` で停止。修正なし |

偽の port によるテストでは、次のことも確かめた。

- 4つの原因を持つページは、3回で上限 (`RETRY_BUDGET_EXHAUSTED`) に達する
- v2 だけが効く原因では、v2 を残し、戻した v1 は提案に入らない
- PC の変化が大きい修正は `PC_CHANGED` で戻す
- 修正した CSS で Identity が `HOLD` になったら、描画の前に止める
- 通信を試みたとき、検査ができなかったとき、形のおかしい答え、例外は、どれも停止になる
- すでにあるコードの新しい1件 (同じ `SP_TEXT_CLIPPED` で別の文が切れる)、事実が隠れること、問題のある文の数が増えること、ほかの原因の修正で押す所が小さくなることは、どれも `NEW_FINDING` で戻す。`examples` が10件なら止める

Review round 1 (H1) の再現も、描画のテストに入れた。誤検知の `SP_TEXT_CLIPPED` がある `deco_type_not_marked` のページに、営業時間を持つ 900px の行を足す。v1 (`max-width`) は行を `overflow: hidden` のまま縮め、営業時間を切る。コードは前と同じ `SP_TEXT_CLIPPED` だが、1件ずつ比べるので v1 は戻され、提案には入らない。

## 6. 実際に使う前の条件 (信頼性の門)

- SP の検査には既知の誤検知がある。DEV-140 では、意図した作り11件のうち2件が誤検知だった。限界も `phase2f-mobile-quality.md` に書いてある。その文書と DEV-140 は、信頼性を確かめるまで所見を停止や自動修正に使わないと決めている。
- 実際に使う (Phase 2f の runner、実装レーン、worker、修正ループに配線する) には、次の二つが要る。
  - 信頼性の証拠。より多くの実際の試作で、誤検知・見逃しと、修正の成否と、回帰を数えたもの
  - オーナーの別の承認
- `PC_CHANGE_MAX` (0.1%) と、修正を掛ける幅 (`max-width: 480px`) は、模擬の値である。採用した閾値ではなく、実際に使うときはオーナーが決める。
- **この PR は、そのどちらも有効にしない。**既存の閾値・停止条件・承認の流れ・Identity Lock・生成 prompt・モデルや画像の実行・worker/bridge/jail/timer・Production/Staging は変えていない。

## 7. 限界

- 架空の小さなページでの模擬である。実際の実装の CSS (セクションの多いページ、詳細度の高い規則) では試していない。
- 位置を探す道具は、SP の検査とは別の、もっと単純な測り方である。両者が食い違えば、場所が見つからない (`not_located`) か、直しても所見が消えない (`NOT_RESOLVED`) になる。どちらも安全な側に倒れる。
- 「ラベルの下に入る」場面の重なりは、ラベルの位置が 29〜33px のときに出る (この環境で確かめた)。書体の差で揺れうる。
- 修正は `@media (max-width: 480px)` の中に置くので、描画も検査もしていない 391〜480px の幅にも掛かる。
- 場所は原因ごとに探し、SP の検査が名指しした文そのものとは結び付けていない。そのため、同じ原因の場所にある、意図したスクロールの箱 (固定の高さと `overflow: auto`) や、隣の問題の無い要素にも、同じ修正が掛かりうる。名指しされた所見が消えれば残る。提案だけで適用はしないので、オーナーが diff で見る。
- 押す所の v2 (`display: inline-block`) は、ブロックや flex のリンクを中身の幅に縮め、`<summary>` の印を消す。何も隠さないが、レイアウトは変わる。
- 1件ずつの比較は、検査の `examples` (文の先頭40字) に頼る。先頭40字が同じ別の文の取り違えは見分けられない (問題のある文の数で補う。事実が隠れることは数に入らない)。
- 1つの原因の修正は、場所の分かった selector すべてに同じ規則を掛ける。同じ class でも問題の無い要素が混じるときは、`:nth-of-type` の道に落とす。
