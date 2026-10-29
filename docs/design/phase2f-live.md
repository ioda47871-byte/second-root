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
- 出力先が新しく、リポジトリの外にあり、その親フォルダーが実在すること
- 出力先の親フォルダーが、Codex のホーム・一時フォルダー・ホームフォルダー・リポジトリを含まないこと（親フォルダーは jail から隠すので、含むと jail を作れない）
- Codex のホームに .env が無く、jail の設定を準備できること（Codex も bubblewrap も起動しない。bubblewrap の動作確認は、従来どおり呼び出しの直前に行う）
- 出力先の親フォルダーがリンクなら、リンク先の実際の場所で判定し、実際の場所に書く（例: `~/runs -> /mnt/d/runs`）
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
5. `call.json` は最後に書き、台帳の結果はその後に書く。後の工程は、`call.json` と台帳の**両方**が成功と言うときだけ答えを使う（DEV-117）。

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
- 再試行は、同じ計画・経路・種類の、**成功していない**呼び出しを `--retry-of` で指名する新しい承認でだけ通る。1つの呼び出しにつき再試行は1回まで（`retried/<承認ID>` の原子的な mkdir。同時に始めても1回）。
- 枠が無くて断られた承認も使用済みになる（`refused` と記録）。呼び出しは無く、回数にも時間にも数えない。
- 上限を増やす処理も、自動の再試行もない。

**時間:**
- 1回は最大15分。計画全体は2時間で、各呼び出しが**実際にかかった時間**を工程をまたいで台帳から合計する。
- 結果の無い呼び出し（実行中・異常終了）は、1つの工程が走れる最長の時間（見張りの20分＋強制終了の30秒）と数える。残りが1分未満なら始めない。
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
| palette | Kinari #F4EFE4 ground, sumi #2B2622 for all text, a slightly darker kinari band #E2D6C0 behind the two reasons, and azuki #6B2E2E used only for the numerals 1 and 2 and one hairline above the shop information. Azuki is the one colour taken from the shop, from the tsubu-an it cooks; the warmth comes from the sweet itself, not from added colour. | v4 `palette` の4色と用途（小豆は数字1・2と店舗情報の上の細線1本だけ）。小豆は店が炊く粒あんから取った唯一の色 |
| product_visual | The dorayaki, cut to show the tsubu-an cooked that morning, is the one lead; 季節の上生菓子 is named in text, not pictured. If a generated image is allowed, use one image of that dorayaki, labelled as a concept image, never presented as a photograph of the shop. Without images, evoke the sweet with colour, layered shapes or inline SVG, never a photo imitation. | 提案の `product_visual`（画像はどら焼き1枚、構想画像と明示、上生菓子は文字で示す）。画像を使えない B のための代わりの表現を追加 |
| section_rhythm | Follow the shop's own story: what is made (the dorayaki), how it is made (1 毎朝炊く粒あん, 2 一つずつお包みしています), what else is offered (季節の上生菓子), then when and where to buy it (hours with 売り切れ次第終了, days off 水曜・第2火曜, 名古屋市東区, phone), and a footer with the name and a short disclosure that this is a fictional shop (実在の店舗ではありません) and, where one is shown, that the image is a concept. Slow and generous; sections may overlap, shift off-axis or break the grid. | 提案の `section_rhythm`（作るもの→作り方→品書き→いつ・どこで→フッター）、v4 `facts` の引用、v4 と提案の、架空の店であること・構想画像であることを示すフッター |
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

## 6. 事前描画・画像・Artifact 化・比較シート（DEV-117）

オーナーは 2026-10-29 に、DEV-116 のマージと、架空菓庵の v4 brief を A/B/C 比較実証の入力として承認した。この brief は架空菓庵専用で、Second Root 全体の固定テンプレートにはしない。実店舗では、店舗の分析とデザイン研究を踏まえて、構造・視覚表現・配色・タイポグラフィを店舗ごとに考える。

### 6.1 入口（すべて新規。既存の画像 PoC の入口と、その v4 の承認・SHA・使用済み記録は変えていない）

| 工程 | 入口 | Codex / 画像 |
|---|---|---|
| ① 設計 | `scripts/design-artifact/phase2f-design.ts`（DEV-116） | Codex 1回 |
| ② 事前描画 | `scripts/design-artifact/phase2f-steps.ts --prerender` | 呼ばない |
| ③ 画像 | `scripts/design-artifact/phase2f-image.ts`（C は `--request`、A は `--concept-v4`） | 画像ツール 1回 |
| ④ Artifact 化 | `scripts/design-artifact/phase2f-steps.ts --package` | 呼ばない |
| ⑤ 比較シート | `scripts/design-artifact/phase2f-steps.ts --sheet` | 呼ばない |

- ③の画像処理は、画像 PoC の共通部分（同じ jail とコマンド、セッションログの読み取りと結果の分類、PNG の検査）だけを `lib/design-agent/design-image/image-once.ts` で再利用する。PoC の `run.ts` には触れていない。
- A の指示文は、画像 PoC の v4 の指示文をそのコードで組み立てたもの（SHA `4e34f760…157d9`、4714文字）。新しい承認 ID で、この実証の台帳を使って1回だけ実行する。

### 6.2 C の流れ（画像1回ごとの個別承認）

1. ①で Codex の HTML/CSS を生成する。
2. ②で、記録済みの答えを検査し、安全検査とプレースホルダーでの描画を行う。画像ごとに次を確定して `image-request-<素材>.json` に書き、`prerender.md` にまとめる。
   - 使用位置（PC・SP の区画、最初の画面に入るか）
   - 主役画像か（hero にある、どちらかの画面で半分以上が最初の画面に入る、どの区画にも属さない）
   - 画像の指示文の全文、SHA-256、文字数
   - 設計の実行 ID・承認 ID・指示文の SHA・コミット・計画
   - この計画の呼び出し回数と使った時間
3. オーナーが `prerender.md` を見て、その画像1回の承認 ID を決める。
4. ③は、依頼ファイルが②のときのまま（指示文の SHA）で、設計の実行が出力フォルダーと台帳の両方で成功していることを確かめてから、承認を使って画像を1回だけ生成する。承認は成功・失敗・結果不明のどれでも再利用しない。
5. ④は、設計と画像の記録を照合してから Artifact にする。
   - 設計: 事実と brief から組み立て直した指示文の SHA が、記録と同じであること
   - 画像: 描画前の検査で組み立て直した画像の指示文の SHA、設計の実行 ID、素材 ID、画像ファイルの SHA が、記録と同じであること
   - 違えば止まる（`RECORD_MISMATCH`）。

### 6.3 記録の照合（後の工程は、両方が成功のときだけ使う）

`lib/design-agent/phase2f-live/steps.ts` の `readStep` だけを通して、前の工程の出力を読む。

- 出力フォルダーの `call.json` にある受け取りが、台帳の受け取りと項目ごとに同じ（承認・計画・経路・種類・枠・再試行・指示文の SHA と文字数・コミット・実行 ID）
- 台帳に結果がある。無ければ使わない（`RECORD_UNFINISHED`。異常終了・実行中）
- 終わり方（状態とコード）が両方で同じ
- 成功なら、`generation.json` の承認・実行・SHA・コミットが受け取りと同じ

### 6.4 画像が無い・失敗したとき（2f-1 の規則のまま）

- 主役でない画像が、承認されなかった（`IMAGE_NOT_RUN`）か失敗した場合は、失敗を記録したまま明示的に B へ切り替える。
- 主役の画像の失敗は、オーナー確認で止まる。勝手に削除しない。
- ポリシーによる拒否は止まり、自動では回避しない。
- 中止した画像は止まる。
- 「保存した」と言いながらファイルが無い結果は、ツールの不具合として止まる。成功にはしない。

### 6.5 Intake の変更（オーナー決定）

CLI の版が取れないことは、モデル名と同じく警告（`generation_tool_version_unknown`）にした。正常なデザインは `render_pair_complete` になれる。承認 ID・指示文の SHA・実行コミット・実行 ID・時刻は、引き続き必須。モデル名と版が必要な工程は `generationFactsReported(record)` で確かめる。

### 6.6 比較シート

`--sheet` は、④の結果から `sheet.json` と `sheet.md` を書く。各経路について次を示す。

- 種類（A は構想画像、B/C はブラウザ描画）
- 届いた経路（切り替えの有無）
- 検証の状態
- 停止と警告（オーナーが「正しかったか」を記入）
- 実際の呼び出し（承認 ID・実行 ID・SHA・枠・結果）
- 空の採点欄

22/25 はデザイン採用の判断にだけ使い、生成の前の制限には使わない。

### 6.7 実行前に止めるもの（承認を使う前）

- オーナーの確認、指示文の SHA と文字数、コミット
- 出力先（リポジトリの外、親フォルダーが実在し、jail に必要な場所を含まない）
- Codex のホームの `.env`
- jail の準備（bubblewrap や Codex が無いと準備の時点で止まる。Codex も bubblewrap も起動しない）
- 承認 ID・回数・時間

承認を使った後の失敗は、成功に書き換えず、原因のコードを記録する。

## 7. 実際の生成を始めるまでに必要な承認

1. DEV-117 のマージ
2. 実行環境の再確認（WSL の jail、Codex のサインイン、ネットワーク、画像ツール）
3. 呼び出しごとの承認 ID（計画 ID、指示文の SHA と文字数、コミットと組にする）
   - A: `phase2f-image.ts --print-pin --concept-v4`
   - B/C の設計: `phase2f-design.ts --print-pin`
   - C の画像: ②の `prerender.md` を見て、1枚ずつ承認する
