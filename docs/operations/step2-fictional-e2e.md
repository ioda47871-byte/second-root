# DEV-139 STEP 2 — 架空の1店で B-route の鎖を本物の CLI で通す（Issue #139 / #263）

更新日：2026-11-17。基準：`develop` の `4d4ff905`。**成功例ではない。営業送信できる状態でもない。**
出力はすべて `owner_approval: required`・`sendable: false`・`package_prepared_owner_review_required` のまま。

## 何を確かめたか

「確認済み facts → 店固有のデザイン入力 → HTML/CSS → 文章監査 → PC1440/SP390 の目視レビュー → v2 デモ包み」を、
develop にある CLI だけで、**同じ facts SHA のまま**1店ぶん通した。新しい生成（Codex・モデル・画像）はしていない。
DB・ネットワーク・worker/timer・Staging/Production・公開・送信には触れていない。

## 店の選び方（なぜ 環 か）

コミット済みの架空店で、「文章監査が owner_review に届く」かつ「`show_owner` の目視レビューがある」ものは無かった。
2つの候補を本物の CLI で試した。

| 候補 | 結果 |
| --- | --- |
| 輪 `fictional-bicycle-repair-wa`（方向案 `bicycle/direction-set.json`、カンプ `d1-wheel-hub-v6` は `show_owner`） | `prepare-design-input` と `--print-pin` は通る（prompt SHA `4c1137b2…4bc4d91`）。しかし `from-prototype` が **`LABEL_NOT_ADJACENT_TO_FACT`** で止まる。v6 の HTML は `<wbr>` で文を細かく割っており、サーバーの `checkArtifactHtml` が返す表示文字は「架空市」「架空区」…の断片になる。断片では事実にもラベルの値にも一致しない。コミット済みの v6 の copy.json を同じ検査（`checkArtifactCopy`、`package-local` が使うもの）にかけても `UNVERIFIED_COPY`（62件）と `JOINED_TEXT_LOOKS_LIKE_FACT`（2件）。さらに文章監査はそのままでは `revise`（`COPY_RHETORICAL_OVERUSE`・`COPY_REPETITIVE_CADENCE`）。**HTML の文字の組み方そのものが包みの経路と合わない**ので、検査を緩めず、ここで止めた。 |
| 環 `fictional-bicycle-repair-tamaki`（`sendable-tamaki/page`、DEV-263a） | 輪 d1-wheel-hub と同じデザインを、`<wbr>` 無し・平明な文章で組んだページ。文章監査は owner_review、描画と v2 包みも通る。足りないのは**方向案**と**目視レビュー**だけだった。→ こちらで通した。 |

**環 の方向案について（作ったものではない）**：環 には自分の `art_direction_set_v0` が無い。ページは 輪 の
`d1-wheel-hub` のデザインそのものである。輪 の方向案は事実を ID（F9〜F16）でしか参照せず、その値は 環 の facts でも
同じなので、**`shop_id` と `facts_sha256` だけを 環 のものに付け替えた**（他の1バイトも変えない。下のコマンド）。
既存の方向案の検査（C1〜C7、`direction-set.ts`）は 環 の facts に対してそのまま走り `READY_FOR_COMPS`。
ただしこれは「環 のために方向を考えた」証拠ではない。また、このページは `--print-pin` の指示文から生成したものではない。

## 実行したコマンド（リポジトリの外、`$RUN` は新しい空のディレクトリ）

```bash
export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium   # 実機ではその環境の Chromium
T=design-library/research/quality-pipeline/poc/sendable-tamaki
mkdir -p "$RUN/shop" "$RUN/runs"
cp "$T/facts-pack.json" "$RUN/shop/"
# 輪 の方向案を 環 に付け替える（shop_id と facts_sha256 だけ）
node -e 'const fs=require("fs"),c=require("crypto");const [s,f,o]=process.argv.slice(1);const b=fs.readFileSync(f);const d=JSON.parse(fs.readFileSync(s,"utf8"));d.shop_id=JSON.parse(b).shop_id;d.facts_sha256=c.createHash("sha256").update(b).digest("hex");fs.writeFileSync(o,JSON.stringify(d,null,2)+"\n")' \
  design-library/research/quality-pipeline/poc/bicycle/direction-set.json "$RUN/shop/facts-pack.json" "$RUN/shop/direction-set.json"

# 1. デザイン入力（モデル呼び出し・指示文の生成なし）
npx tsx scripts/sales/demo-version/prepare-design-input.ts --facts "$RUN/shop/facts-pack.json" \
  --directions "$RUN/shop/direction-set.json" --direction-id d1-wheel-hub --out "$RUN/runs/design-input"
# 2. 既存 phase2f の指示文 pin（--print-pin だけ。Codex は呼ばない、承認も使わない）
npx tsx scripts/design-artifact/phase2f-design.ts --print-pin --route B --prompt-version v2 \
  --facts "$RUN/shop/facts-pack.json" --direction "$RUN/runs/design-input/direction.json" \
  --references "$RUN/runs/design-input/references.json"
# 3. 既存の HTML/CSS → comp_copy_v1（文章台帳はページと facts から導く。手で書かない）
npx tsx scripts/sales/demo-version/from-prototype.ts --facts "$RUN/shop/facts-pack.json" --prototype "$T/page" \
  --directions "$RUN/shop/direction-set.json" --direction-id d1-wheel-hub --lane quality_research_fictional \
  --out "$RUN/runs/prototype"
# 4. レビュー済みのカンプ：導いた index.html・copy.json ＋ レビュー1巡目の style.css と review.json
mkdir -p "$RUN/shop/comps/d1-wheel-hub"
cp "$RUN/runs/prototype/comp/d1-wheel-hub/"{index.html,copy.json} "$RUN/shop/comps/d1-wheel-hub/"
cp "$T/step2-review/"{style.css,review.json} "$RUN/shop/comps/d1-wheel-hub/"
# 5. 文章監査 → PC/SP 描画 → --check-review → v2 包み
node scripts/sales/demo-version/prepare-offline.mjs --facts "$RUN/shop/facts-pack.json" \
  --comp "$RUN/shop/comps/d1-wheel-hub" --out "$RUN/runs/offline"
```

目視レビューの前は、手順4で `review.json` を置かずに5を走らせる。文章監査と描画のあと **`VISUAL_REVIEW_MISSING`** で
止まり、`renders/desktop.png`・`renders/mobile.png` ができる。その絵を見てレビューを書く（次節）。

## 観測した結果

| 工程 | 結果 |
| --- | --- |
| facts SHA（全工程で同じ） | `dc4ce58609b5b2c602622dd6636b6563a86be0dc4456857697a79d3fbbd92595`（design-input の `pin.json`、from-prototype の `status.json`、`copy.json`、adapter の `status.json`、包みの `copy/facts-pack.json` のバイト、包みの `copy/copy.json`・`copy/review.json`） |
| 方向案（付け替え後） | `READY_FOR_COMPS`、SHA `c915b3ba…a915a560`、`reference_mode: TEXT_ONLY_PROVISIONAL`、参照画像 0 件 |
| prompt pin | `prompt_sha256 57e38cc1bc34d803a0555ebc5ed96bbf0337bc13e54a4c0dcc9ee1154176422b`、4648 文字（v2、route B） |
| from-prototype | 事実 21 行（うちラベルで結んだ行 `label_bound_fact_lines` 5）、提案 13 行、表示文字 44。copy SHA `2992996c…239a6cd1` |
| 文章監査 | `copy-review.json` の verdict `approve_candidate`、gate `owner_review`（round 0） |
| 描画 | PC 1440×5260、SP 390×5599、`status: OK`、検出なし。`render_review: {structural_ok: true, renders_match_here: true}` |
| 目視レビュー | `show_owner`（1巡、既知の失敗コードなし）。`--check-review` は `ok` |
| v2 包み | `sales_demo_version_package_v2`、bundle SHA `ed0123fc63e550550e15734ef821c149723e947cac5232d113d3a2d640bebf40` |
| 状態 | `package_prepared_owner_review_required`、`owner_approval: required`、`external_send: disabled`、`sendable: false` |

## 目視レビューをどう行ったか

`step2-review/review.json`（`comp_review_v1`）は、Claude が comp-lane の描画（JS 無効・通信遮断）を Read で実際に見て書いた。

- 1巡目の前：PC を 1315px ごとの4枚（半分の縮尺）、SP を 1120px ごとの5枚（等倍）で上から全部見た。
  点検は design-director スキルの `critique-checklist.md` に沿った。
- 見つけた原因（1つ）：PC の spokes 区画で、見出し「修理のご案内」が `top: 55vw` に置かれ、2つの駅の後ろ・駅名より
  小さく、案内する内容の後に来る迷子の注記に見えた。
- 守ったもの：Hero の車輪と 環 のハブ、4本の黄のスポークと吊った板・名前の位置、「まわる」が区画をまたぐこと、SP とタブレット。
- 直したもの：PC（1000px 以上）の `.spokes-h` だけを、区画の左上に縦書きで置いた（`style.css` の1規則）。文字・HTML・SP は不変。
- 1巡目の後：PC の該当部を半分と等倍で見直し、前後の PC の描画の差が 81,1079–319,1860 の範囲だけであることを画素差で確かめた。
  SP の描画は前とバイト単位で同じ。
- ラベルで結んだ事実5行（電話・時間・定休・所在地・道順）は、PC/SP の両方でラベルと値が隣り合い、入れ替わり・隠れが無いことを目で確かめた（PR #279 L7）。
- 残したもの（`remaining`）：写真は仮の板のまま／SP のブレーキ調整の下に約160pxの働かない地／タブレット幅は未描画／
  IPAMincho が無く明朝指定の文字は代替書体／方向案は付け替え／ラベル行はオーナー確認が要る。

`review.json` の描画 SHA はこの環境の書体で撮ったもの。書体の違う機械では `renders_match_here` が false になるが、
`--check-review` の判定（構造・参照・巡回・カバー率）は描画のバイトに依存しない。

## 追加・変更したもの

- `scripts/sales/demo-version/from-prototype.ts`：カンプを `<out>/comp/<direction-id>/` に書く（次段の comp-lane が方向 ID をディレクトリ名から読むため。手でディレクトリ名を変える手間と取り違えを無くす）。方向 ID は方向案の ID 規則で検める。
- `lib/sales/b-route/derive-copy.ts`：`stats.label_bound_fact_lines`（PR #279 L7）。`status.json` の `copy` に出る。
- `scripts/sales/demo-version/prepare-offline.mjs`：`review.json` が無いときは視覚検査を走らせず `VISUAL_REVIEW_MISSING` で止める（以前は `STEP_INVALID_OUTPUT` / `INPUT_ERROR` に見えた）。`status.json` に `sendable: false`。
- `design-library/research/quality-pipeline/poc/sendable-tamaki/step2-review/`：レビュー1巡目の `style.css` と `review.json`。
- `tests/unit/sales/b-route-step2-fictional-e2e.test.ts`：上の鎖を一時ディレクトリで本物の CLI で通す。ブラウザ無しの部分（1〜4、本物の文章監査と `--check-review`）は常に走る。描画と包みは Chromium があるとき（`PLAYWRIGHT_CHROMIUM_EXECUTABLE`、無ければ Playwright 自身の Chromium。CI の unit job は `npx playwright install --with-deps chromium` 済み）に走り、無ければ skip と表示される。

## 証明したこと／していないこと

証明した：

- develop の CLI だけで、1つの架空店の facts バイトが、デザイン入力・prompt pin・導いた文章台帳・文章監査・描画・目視レビュー検査・v2 包みまで**同じ SHA で**通る。
- どの工程も門を緩めずに通った（監査・HTML 安全・Identity・視覚レビューの規則は変えていない）。

証明していない：

- **新しく生成したデザイン**の品質。HTML/CSS は既存の架空ページ（輪 のデザインの 環 版）で、prompt から生成したものではない。
- 店固有の方向づけ。方向案は 輪 のものの付け替え。
- 成功例と同等の美観。`show_owner` は「オーナーに見せてよい」であって合格ではない。決めるのはオーナー。
- 輪 の v6 のように `<wbr>` で割った HTML を包みの経路へ通すこと（上の表。サーバーの表示文字の取り方を変える判断が要る）。
- **DB の読み取り経路**（`lib/sales/b-route/verified-generation-facts.ts`、PR #280）。単体テストだけで、ローカル DB の seed は承認されていないので走らせていない（下）。
- 管理画面での表示、import、送信。タブレット幅の描画。

## DB 読み取り経路を通すには（未実施・要承認）

`loadVerifiedGenerationFacts(client, prospectId)` が成功するには、ローカル DB に次が要る（**書き込みは承認されていないので行っていない**）。

1. `sales_prospects`：`do_not_contact = false`。`name` と `address` が facts の `name`・`address` と**完全一致**。
2. `sales_sources`：メールの digest 照合用（任意）。
3. `sales_exclusions`：その店に当たる行が無いこと（読めない場合も停止）。
4. `sales_demos`：同じ prospect、`disabled_at` が null、`expires_at` が未来、`content` が facts バイトから導いた内容（`assertDemoContentFromFacts`）。
5. `sales_demo_facts_packs`：最新 seq の行の `facts_pack_text` が facts のバイトそのもの、`facts_sha256`・`shop_id`・`demo_id` が一致（既存の `sales_register_facts_pack_as`、`import-local.ts --trusted-facts … --admin …` が登録する）。

**既存の seed（`import-local.ts --seed-sendable`、`lib/demo-version-package/seed-sendable.ts`）のままでは通らない見込み**：
登録の `address` はスキーマが名古屋の住所を要求するため仮の住所 `SENDABLE_REGISTRY_ADDRESS` で、facts の「架空市架空区架空町二丁目3-5」と一致しない。
PR #280 の同一性の検査で `PROSPECT_FACTS_IDENTITY_HOLD` になる。検査を緩めるか、架空店の登録住所の扱いを決めるかはオーナーの判断が要る。

関連：`docs/operations/offline-b-route-adapter.md`、`docs/operations/broute-copy-handoff.md`、`docs/operations/verified-generation-facts.md`。
