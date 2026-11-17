# DEV-139 Stage 0 A-3 — route B の生成1回を既存の B-route の鎖へつなぐ（Issue #139）

更新日：2026-11-17。基準：`develop` の `88597749`。**成功例ではない。営業送信できる状態でもない。本物の新規生成もしていない。**
出力はすべて `owner_approval: required`・`sendable: false`・`generated_design_quality: not_assessed` のまま。

## 何を足したか

`scripts/sales/demo-version/from-generation.mjs`（接着だけ）。新しい pipeline・service・worker・テンプレート DB は作っていない。

```
prepare-design-input → phase2f-design --print-pin → [phase2f-design 実呼び出し：オーナー承認後・未実施]
  → phase2f-steps --package --route B --prompt-version v2   （既存。台帳と出力の一致、指示文の再構築と SHA 照合、試作の安全検査、PC/SP 描画、intake）
  → from-generation.mjs                                      （新規。下の照合だけをして、既存の2段へ渡す）
      → from-prototype.ts （方向案の門、ページと facts から文章台帳を導く）
      → prepare-offline.mjs（文章監査 → comp-lane PC1440/SP390 描画 → --check-review → package-local --copy）
```

接着が確かめること（どれか1つでも違えば、何も書かずに exit 2 で止まる）：

| 照合 | 止まるコード |
| --- | --- |
| design-input の `pin.json` が同じ facts バイト・同じ方向案・同じ方向 ID | `DESIGN_INPUT_MISMATCH` |
| 設計呼び出しの `call.json` が succeeded・route B・kind design、`slot` が実在 | `GENERATION_NOT_SUCCEEDED` / `GENERATION_NOT_ROUTE_B` / `GENERATION_RECORD_INVALID` |
| 受領（receipt）の指示文 SHA が、オーナーが承認した `--expected-prompt-sha256` | `GENERATION_PROMPT_NOT_PINNED` |
| `generation.json` の承認 ID・run ID・指示文 SHA が受領と同じ | `GENERATION_RECEIPT_MISMATCH` |
| 包みの結果ファイルが done・route B で、使った呼び出しが受領と同じ（承認 ID・run ID・slot・指示文 SHA） | `DESIGN_PACKAGE_NOT_DONE` / `PACKAGE_RESULT_MISMATCH` |
| Design Artifact の生成記録が受領と同じ、`facts_pack_sha256` が facts バイトの SHA、店 ID と店名が facts と同じ | `DESIGN_ARTIFACT_GENERATION_MISMATCH` / `FACTS_SHA_MISMATCH` / `SITE_IDENTITY_MISMATCH` |
| `quarantine/index.html`・`style.css` が artifact の記録の SHA どおりで、かつ設計の答え（`answer.json`）の HTML/CSS とバイト単位で同じ | `DESIGN_ARTIFACT_FILES_MISMATCH` / `PROTOTYPE_NOT_FROM_GENERATION` |

そのあとは既存の段をそのまま走らせる。どこかの段が止まれば、接着もその段のコードで止まる（exit 1）。
たとえば目視レビューがまだ無ければ `VISUAL_REVIEW_MISSING`。**接着はレビューを書かない。門も変えない。再試行もしない。**
`--review` は人が描画を見て書いた `comp_review_v1` を渡すときだけ使い、その中身の判定は `comp-lane.ts --check-review` に任せる。

`<out>/status.json`（`sales_generation_glue_v1`）に残るもの：生成の pin（承認 ID・plan ID・run ID・slot・retry_of・指示文 SHA と文字数・
指示文の版・コミット・`call.json` と `answer.json` の SHA）、facts SHA、店 ID と店名、方向 ID と方向案 SHA、試作の SHA、
Design Artifact の ID と SHA、導いた文章台帳の SHA と行数、レビューを渡したかとその SHA、オフラインの各段の結果、v2 包みの bundle SHA。
包みそのものの形式（`sales_demo_version_package_v2`）は変えていない。**どの生成から作った包みかは、status.json の pin と
`package_sha256` の組で記録する。**

### phase2f の入口を接着から起動しない理由

`tests/unit/design-agent/phase2f-live/isolation.test.ts` は、`lib`・`app`・`components`・`scripts` のどのファイルも
`phase2f-design`・`phase2f-steps` などの入口の名前を持たないこと（入口は人が手で起動するもの）を固定している。
接着がそれらをサブプロセスで起動すればこの許可一覧を広げることになるので、接着は**手で走らせたそれらの出力を読むだけ**にした。
台帳の照合・指示文の再構築・試作の安全検査は既存の `phase2f-steps --package` が行い、接着はそれを繰り返さず、結果が同じ生成を指すことだけを見る。
`phase2f/isolation.test.ts`・`artifact/isolation.test.ts`・`phase2f-live/isolation.test.ts` の許可一覧は変えていない。

## コマンドの順番（リポジトリの外、`$RUN` は新しい空のディレクトリ）

```bash
export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium   # 実機ではその環境の Chromium
export SR_PHASE2F_STATE="$HOME/.local/state/sr-design-worker/phase2f-live"   # 実呼び出しと包みの段が同じ台帳を読む（既定値と同じ）
mkdir -p "$RUN/shop" "$RUN/runs"
# facts と方向案（3方向、C1〜C7 を通るもの）を $RUN/shop/ に置く

# 1. デザイン入力（モデル呼び出し・指示文の生成なし）
npx tsx scripts/sales/demo-version/prepare-design-input.ts --facts "$RUN/shop/facts-pack.json" \
  --directions "$RUN/shop/direction-set.json" --direction-id <direction-id> --out "$RUN/runs/design-input"

# 2. 指示文 pin（--print-pin だけ。Codex は呼ばない、承認も使わない）→ prompt_sha256 と prompt_chars をオーナーへ
npx tsx scripts/design-artifact/phase2f-design.ts --print-pin --route B --prompt-version v2 \
  --facts "$RUN/shop/facts-pack.json" --direction "$RUN/runs/design-input/direction.json" \
  --references "$RUN/runs/design-input/references.json"

# 3. 【オーナーの個別承認の後だけ。未実施】実 Codex の設計呼び出し 1 回（下の節）→ "$RUN/runs/design"

# 4. 既存の包みの段（Codex を呼ばない）：台帳と出力の一致、指示文の再構築と SHA 照合、試作の安全検査、PC/SP 描画、intake
npx tsx scripts/design-artifact/phase2f-steps.ts --package --route B --prompt-version v2 \
  --direction "$RUN/runs/design-input/direction.json" --references "$RUN/runs/design-input/references.json" \
  --facts "$RUN/shop/facts-pack.json" --design "$RUN/runs/design" \
  --artifact-id DA-<YYYYMMDD>-<6文字> --shop-id <facts の shop_id> --shop-name <facts の name> \
  --out "$RUN/runs/artifact" --result "$RUN/runs/artifact-result.json"

# 5. 接着 → from-prototype → prepare-offline。目視レビューの前は --review を付けない（VISUAL_REVIEW_MISSING で止まり、
#    $RUN/runs/glue-1/offline/renders/desktop.png・mobile.png ができる。その絵を人が見て review.json を書く）
node scripts/sales/demo-version/from-generation.mjs --facts "$RUN/shop/facts-pack.json" \
  --directions "$RUN/shop/direction-set.json" --direction-id <direction-id> --design-input "$RUN/runs/design-input" \
  --expected-prompt-sha256 <2. の prompt_sha256> --design "$RUN/runs/design" \
  --artifact "$RUN/runs/artifact" --result "$RUN/runs/artifact-result.json" \
  --lane quality_research_fictional --out "$RUN/runs/glue-1"

# 6. レビューを書いた後：同じ入力で新しい --out に、--review を足して走らせる（v2 包みは $RUN/runs/glue-2/offline/package/）
node scripts/sales/demo-version/from-generation.mjs … --out "$RUN/runs/glue-2" --review "$RUN/review/review.json"
```

### オーナーが後で承認する実 Codex の呼び出し（3.）—— **このセッションでは実行していない**

```bash
npx tsx scripts/design-artifact/phase2f-design.ts --route B --prompt-version v2 \
  --facts "$RUN/shop/facts-pack.json" \
  --direction "$RUN/runs/design-input/direction.json" \
  --references "$RUN/runs/design-input/references.json" \
  --out "$RUN/runs/design" \
  --plan-id <オーナーが決める plan ID> --approval-id <オーナーが決める承認 ID（1回だけ使える）> \
  --expected-prompt-sha256 <2. の prompt_sha256> --expected-prompt-chars <2. の prompt_chars> \
  --expected-commit <実行時の origin/develop の SHA（作業ツリーが空であること）> \
  --human-approval-confirmed
```

- `references.json` の参照が 0 件（`TEXT_ONLY_PROVISIONAL`）なら `--reference-dir` は要らない。参照があるときは登録済み WebP を置いた
  `--reference-dir <dir>` が要る（承認を使う前に SHA を照合する）。
- 再試行は新しい承認 ID で `--retry-of <失敗した承認 ID>` を足す。台帳は plan ごとに初回4回・再試行2回までで、それを超える呼び出しは拒まれる。
- 呼び出しの上限・停止条件・台帳は既存の `phase2f-design` のまま（15分、承認は1回限り、SIGTERM/SIGINT/SIGHUP で停止して aborted を記録）。
- 例：架空店 環（`sendable-tamaki`）・方向 `d1-wheel-hub`・この commit なら、2. は `prompt_sha256 57e38cc1bc34d803a0555ebc5ed96bbf0337bc13e54a4c0dcc9ee1154176422b`、
  4648 文字（STEP 2 と同じ）。指示文のコードや入力が変われば SHA も変わるので、承認の前に必ず 2. を走らせ直す。

## CI での証明（`tests/unit/sales/s0-generation-glue.test.ts`）

一時ディレクトリで、本物の CLI を順に走らせる。モデル・Codex・ネットワーク・DB は使わない。

1. `prepare-design-input` → `phase2f-design --print-pin`（環、輪の方向案を 環 の shop ID と facts SHA に付け替えたもの。STEP 2 と同じ）。
   同じビルダーで組んだ指示文の SHA と文字数が、印字された pin と一致することを確かめる。
2. **記録した答えで設計の1段を作る**：`runDesignCall` に、記録した答えを返す Codex の代わりを渡す（`phase2f-live/steps.test.ts` と同じ仕組み）。
   台帳は一時ディレクトリ（`SR_PHASE2F_STATE`）で、本物の台帳には触れない。承認 ID・plan・slot `first-1`・指示文 SHA が受領に入る。
   CLI の `--human-approval-confirmed` は使っていない。モデル名は記録しない（`model_reported: null`）。
3. ブラウザがあるとき：`phase2f-steps --package`（本物）が台帳・指示文・安全検査・PC/SP 描画を通し `render_pair_complete`。
4. 接着が、pin の違い（`GENERATION_PROMPT_NOT_PINNED`）、facts の1バイトの違い（`DESIGN_INPUT_MISMATCH`）、
   包みと違う答え（`PROTOTYPE_NOT_FROM_GENERATION`）を、何も書かずに拒む。
5. レビュー無し：文章監査 `owner_review`、PC/SP 描画（PNG 2枚）、そして `VISUAL_REVIEW_MISSING` で停止。包みは無い。
   facts SHA は design-input の pin・Design Artifact・from-prototype の status・copy.json・オフラインの status・段の facts コピーで同じ。
   status.json の pin は受領そのまま。
6. コミット済みのレビュー（`sendable-tamaki/step2-review/review.json`）を渡す：`--check-review` を通り、v2 包みができる。

**記録した答えの中身はモデルの生成ではない。**HTML は 環 のコミット済みページ（`sendable-tamaki/page/index.html`）、CSS はその目視レビュー1巡目の
`step2-review/style.css`。これを `codex_design_v1` の答えとして包んだ。この組み合わせは、STEP 2 で Claude が PC1440/SP390 の描画を見て
`review.json` を書いた、まさにそのバイト（HTML・CSS・導いた copy.json の SHA がレビューの `comp` と一致することをテストで確かめる）なので、
そのレビューは接着が描画したものについて正直に存在する。v2 包みの bundle SHA は STEP 2 と同じ `ed0123fc…bf40` になった。

## 観測した結果（この環境、`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`）

| 項目 | 値 |
| --- | --- |
| facts SHA（全段） | `dc4ce58609b5b2c602622dd6636b6563a86be0dc4456857697a79d3fbbd92595` |
| 指示文 pin | `57e38cc1…4176422b`、4648 文字、v2、route B |
| 受領 | 承認 ID `fictional-s0-glue-design-01`、plan `plan-fictional-s0-glue`、slot `first-1`、run ID は呼び出しごと（`p2f-…`） |
| Design Artifact | `render_pair_complete`、facts SHA 同じ、生成記録は受領と同じ |
| from-prototype | 事実 21 行（ラベル結び 5）、提案 13 行、copy SHA `2992996c…239a6cd1` |
| 文章監査 | `owner_review` |
| 描画 | PC1440・SP390、レビュー無しでは `render_review: none` |
| レビュー無し | `VISUAL_REVIEW_MISSING`（stage `offline`）、包み無し、`sendable: false` |
| レビュー有り | `--check-review` ok、`sales_demo_version_package_v2`、bundle SHA `ed0123fc63e550550e15734ef821c149723e947cac5232d113d3a2d640bebf40` |

## 証明したこと／していないこと

証明した：route B の設計出力（受領つき）から v2 包みまで、本物の CLI とブラウザで、同じ facts SHA・同じ店で、生成の pin を保ったまま通ること。
pin・facts・答えのどれかが食い違えば止まること。レビューが無ければ `VISUAL_REVIEW_MISSING` で止まること。

証明していない：**本物の新規生成**（Stage 0 の次の門。上の実 Codex 呼び出しはオーナーの個別承認の後）、生成物のデザインの質、店固有の方向づけ
（方向案は 輪 の付け替え）、ローカル DB と管理画面（A-4・C-8）、3業種の安定性。`show_owner` は合格ではない。決めるのはオーナー。

関連：`docs/operations/step2-fictional-e2e.md`、`docs/operations/offline-b-route-adapter.md`、`docs/operations/broute-copy-handoff.md`。
