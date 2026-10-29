# Phase 2f-2 接続準備（DEV-116）：設計の工程・承認台帳・中止の合図・共通入力

オーナーが 2026-10-29 に限定承認した範囲：
- 実機接続の共通基盤
- 設計 CLI
- 承認台帳と回数・時間の上限
- 中止処理
- 共通入力

テストは擬似プロセスと架空データだけで行う。次は含まない（DEV-117 または別承認）：
- 実際の Codex 実行・画像生成
- 画像の新しい入口と、事前描画のあとの画像の個別承認
- 比較シートの出力

## 1. 工程を分ける構成

| 工程 | 何をするか | 入口 | 状態 |
|---|---|---|---|
| ① 設計 | B/C の設計を Codex に1回だけ依頼する（承認1件につき1回） | `scripts/design-artifact/phase2f-design.ts` | DEV-116 |
| ② 事前描画 | 安全検査と、画像をプレースホルダーにした描画。画像が必要か、主役かを判定する | 2f-1 のオフライン CLI を拡張 | DEV-117 |
| ③ 画像 | 画像の指示文・SHA・設計の実行 ID・コミット・承認 ID をオーナーに示し、個別承認のあとに1回だけ生成する | 新しい入口（画像処理の共通部分だけを再利用） | DEV-117 |
| ④ Artifact 化 | Intake の検査と比較シート | 2f-1 のオフライン CLI（`--plan`） | 2f-1 済み、出力は DEV-117 |

- `lib/design-agent/phase2f/` はオフライン専用のままで、Codex も画像生成も呼ばない。
- 各工程は前の工程の**記録済みの成果物**を使う。
- ①の出力先は毎回新しいフォルダーでなければならず、承認 ID は二度使えない。だから同じ Codex 呼び出しを不用意に繰り返すことはない。

## 2. 設計 CLI（①）

```
# 承認する値を出す（オフライン。何も呼ばない）
npx tsx scripts/design-artifact/phase2f-design.ts --print-pin --route B|C --facts <pack> --brief <brief>

# 承認を受けた1回の実行
npx tsx scripts/design-artifact/phase2f-design.ts --route B|C --facts <pack> --brief <brief> --out <新しいフォルダー> \
  --plan-id <計画ID> --approval-id <承認ID> --expected-prompt-sha256 <SHA> --expected-prompt-chars <文字数> \
  --expected-commit <40桁> --human-approval-confirmed [--retry-of <失敗した呼び出しの承認ID>]
```

**承認を使う前に確かめること（どれかが違えば何も使わずに止まる。終了コード 2）:**
- オーナーの確認
- 指示文の SHA-256 と文字数が承認値と同じこと
- HEAD・origin/develop・承認したコミットが同じで、作業ツリーが空であること
- 出力先が新しく、リポジトリの外にあること
- 承認 ID の形式と未使用であること
- 回数と時間の上限

**通ったあとの流れ:**
1. 承認を台帳に予約する。
2. Codex を jail の中で1回呼ぶ。最大15分。
3. 結果を出力先に書く。
   - `answer.json`：Codex の答え。秘密情報の除去はいつもどおり行う。
   - `generation.json`：CLI の版・モデル・承認・SHA・コミット・実行 ID・時刻。
   - `call.json`：終わり方・警告・台帳の受け取り。
4. 止まった呼び出しは `call.json` だけを残す。答えは書かず、成功にもしない。

**Codex に見せないもの:** worker の作業フォルダー、承認台帳、出力先の親フォルダー（保護パスとして jail から隠す）。

**中止:**
- SIGTERM・SIGINT・SIGHUP を受けると、中止の合図を送る。Codex と、Codex が起動したすべてのプロセスに SIGTERM、5秒後に SIGKILL。
- 中止した呼び出しは `aborted` と記録する。
- 2度目の合図か20秒で、残りのプロセスをすべて止めて終了する。
- 自動で再実行はしない。

## 3. 承認台帳と上限

台帳は `~/.local/state/sr-design-worker/phase2f-live/` にある（`SR_PHASE2F_STATE` で変更できる。リポジトリの中は不可）。

**承認 ID:**
- `approvals/<承認ID>/` を原子的な mkdir で予約するので、同じ ID は二度使えない。
- 結果（`result.json`）が成功・失敗・中止・不明のどれでも、再利用しない。

**回数:**
- 計画（`--plan-id`）ごとに、初回は最大4回、再試行は最大2回。`slots/first-N`・`slots/retry-N` を原子的な mkdir で取る。
- 再試行は、同じ計画・経路・種類の、**成功していない**呼び出しを `--retry-of` で指名する新しい承認でだけ通る。1つの呼び出しにつき再試行は1回まで。
- 上限を増やす処理も、自動の再試行もない。

**時間:**
- 1回は最大15分。計画全体は2時間で、各呼び出しが**実際にかかった時間**を工程をまたいで台帳から合計する。
- 結果の無い呼び出し（実行中・異常終了）は15分と数える。残りが1分未満なら始めない。
- オーナーの承認を待つ時間は数えない。
- 既存の画像 PoC と worker の時間制限は変えていない。

**既存の台帳:** 和菓子 v4 の画像 PoC の承認（承認 ID・SHA・文字数・コミット固定・使用済み記録）とその台帳には触れていない。

## 4. 共通部品の変更（後方互換）

- `runBounded`・`sandbox.run`・`runCodexJson` に、省略できる `signal` を足した。
  - 未指定なら、結果も含めて従来と同じ（テストで確認）。worker と画像 PoC は渡していない。
- 中止は、時間切れと同じ止め方をする（プロセスグループへ SIGTERM、猶予のあと SIGKILL）。
  - 起動前に中止されていれば、何も起動しない。
  - 中止は別のエラークラス（`CodexAbortedError`）にした。既存の呼び出し側が見るエラーの種類は増えない。
- `runCodexJsonWithMeta`：
  - jail の中で `codex --version` を1回足す。
  - セッションログを消す前に、モデル名だけを読む。
  - 取れなければ `null`（警告）にする。
- 秘密情報の除去は変えていない。除去が起きた JSON の場所と件数を `redactions` に記録し、`answer_redacted:<場所>` の警告にする。SVG・HTML・CSS が壊れていないかは、②の描画と④の検査で確かめられる。
- 中止が早すぎてスレッドが名乗られていない場合も、その呼び出しの作業フォルダーからセッションログを探して消す。

## 5. 共通入力（架空菓庵）

- **事実:** `design-library/phase2f/wagashi-facts-pack.json`
  - 既存 fixture `scripts/sales-design-worker/compare/shops/wagashi.json` の値をそのまま、キーの順に写したもの（商品名は1品ずつ）。
  - 出典は `wagashi-sources.json`（S1 = その fixture）。テストで fixture と一致することを確かめている。
- **brief:** `design-library/phase2f/wagashi-brief-v4.json`
  - Design DNA v4 と、その元の提案 morning_batch を8項目に移したもの。
  - **オーナーの確認を受けるまで、実際の生成には使わない。** 実際の呼び出しは、オーナーが承認した指示文の SHA でしか通らない。

| 項目 | brief の全文 | 元データ |
|---|---|---|
| hero | The morning batch. The first screen belongs to one sweet, the dorayaki with tsubu-an, and to the shop's own words 毎朝炊く粒あん beside the name 架空菓庵. Quiet and close, like one sweet wrapped on a small counter (小さな店頭). The name and the sweet may overlap, stand vertically or sit off-centre if that makes the screen feel like this shop rather than a template. | v4 `concept`（the morning batch）、提案 morning_batch の `hero`（どら焼きと名前、毎朝炊く粒あん）、事実の「小さな店頭」 |
| typography | A refined Mincho for the name and for the two acts the shop states itself, 毎朝炊く粒あん and 一つずつお包みしています, shown as its reasons 1 and 2 with large numerals in azuki. A calm Gothic at reading size for hours, days off, address and phone. Vertical or horizontal setting, mixed directions and strong size contrast are all open. | 提案の `typography`（明朝で名前と二つの理由、数字1・2を小豆色で大きく、店舗情報はゴシック）。v4 の「横組みのみ」は引き継がない |
| palette | Kinari #F4EFE4 ground, sumi #2B2622 text, a slightly darker kinari band #E2D6C0 behind the two reasons, and azuki #6B2E2E kept scarce: the numerals 1 and 2, one hairline, the colour of the tsubu-an. The warmth comes from the sweet itself, not from added colour. | v4 `palette` の4色（生成り・墨・生成りの帯・小豆）と用途。小豆は控えめに使う |
| product_visual | The dorayaki, cut to show the tsubu-an cooked that morning, is the one lead; 季節の上生菓子 is named in text, not pictured. If a generated image is allowed, use one image of that dorayaki, labelled as a concept image, never presented as a photograph of the shop. Without images, evoke the sweet with colour, layered shapes or inline SVG, never a photo imitation. | 提案の `product_visual`（画像はどら焼き1枚、構想画像と明示、上生菓子は文字で示す）。画像を使えない B のための代わりの表現を追加 |
| section_rhythm | Follow the shop's own story: what is made (the dorayaki), how it is made (1 毎朝炊く粒あん, 2 一つずつお包みしています), what else is offered (季節の上生菓子), then when and where to buy it (hours with 売り切れ次第終了, days off 水曜・第2火曜, 名古屋市東区, phone). Slow and generous; sections may overlap, shift off-axis or break the grid. | 提案の `section_rhythm`（作るもの→作り方→品書き→いつ・どこで）と、v4 `facts` の引用（売り切れ次第終了、水曜・第2火曜、名古屋市東区） |
| navigation | Minimal text navigation to the reasons and to the shop information; no order, booking or cart wording, since the facts give none. The shop name stays readable at all times. | v4 `web_ui.nav` と提案の `navigation`（理由と店舗情報への文字のリンク、注文・予約の文言なし） |
| mobile | Designed for the phone, not a shrunken desktop: the name and 毎朝炊く粒あん come before anything else, then the sweet, then reasons 1 and 2 stacked, then the shop information as label-above-value rows. Phone-specific layouts, vertical text and overlaps are welcome where they stay readable. | v4 `mobile_390.order`（名前と毎朝炊く粒あん → どら焼き → 理由1・2 → 見出しの下に値を置く店舗情報） |
| implementation | One static page: semantic HTML and one stylesheet, rendered with no script and no external resource. Any CSS is welcome, including grid, absolute layering, writing-mode, clip-path, transforms, blend modes and inline SVG; nothing is limited to an implementation allowlist at this stage. | v4 `css_notes`・提案の `implementation` の CSS 許可範囲の制約は**引き継がない**。どんな CSS でもよく、条件はスクリプトなし・外部資源なしだけ |

避けること（`avoid`）。v4 の `left_out` と、汎用的なページを避ける方針から：
- a generic hero with a centred headline and a button
- an interchangeable card grid of products
- prices, reviews, history, awards, people or any claim not in the facts
- the placeholder menu names containing テスト, the placeholder station name and the full test address shown as real content
- text, letters or logos inside a generated image
- order, booking or cart buttons

## 6. 実際の生成を始めるまでに必要な承認

1. DEV-116 のマージ
2. brief の確認（必要なら修正）
3. 各呼び出しの承認 ID。指示文の SHA・文字数（`--print-pin` で出す）、コミット、計画 ID と組にする。
4. 実行環境の再確認（WSL の jail、Codex のサインイン、ネットワーク）
5. C と A の画像は DEV-117 の入口で、1回ごとに個別承認する。
