# IMAGE_FIRST — モデル生成の全頁デザイン画像から忠実実装への受け渡し契約（Issue #293 P1）

2026-11-19。**オフラインの契約と検査だけ**を定める。この文書とコードは、Codex の実呼び出し・画像生成・有料 API・
WSL 操作・DB・worker・timer・本番の変更を**承認しない**。実生成は P2 の「1回ごとの承認パケット」をオーナーが
承認するまで実行しない（下の §6）。

- 経路名: `IMAGE_FIRST`、出力種別: `MODEL_GENERATED_FULL_PAGE_COMP`、記録: `model_full_page_comp_v0`
- 正本のコード: `lib/design-agent/image-first/`、CLI: `scripts/design-artifact/image-first-check.ts`、
  テスト: `tests/unit/design-agent/image-first/`（ダミーの合成画像だけ）
- 上位の方針: [`design-first-workflow-decision.md`](design-first-workflow-decision.md)（G2 デザイン画像 → G4 実装 → G5 比較）、
  [`quality-first-process.md`](quality-first-process.md)

## 1. 何であり、何でないか

| もの | IMAGE_FIRST の原本になるか |
|---|---|
| Codex の画像ツール（`image_gen.imagegen`）が描いた Web ページの全頁画像（PC1440 と SP390 の**独立した**2つの設計） | なる |
| HTML/CSS をブラウザで撮ったスクリーンショット（#180 の VISUAL_FIRST、B 方式の試作、Claude の comp） | ならない（`COMP_NOT_MODEL_GENERATED`） |
| 写真1枚・ポスター | ならない（`COMP_NOT_A_WEBSITE`） |
| Hero だけの画像、PC だけ、PC を縮めた SP | ならない（`COMP_HERO_ONLY` / `COMP_SP_MISSING` / `COMP_SP_IS_PC_SCALED`） |

画像上の文字は**事実の根拠にしない**。実装の文言は事実パックと `copy.json`（`checkCopyRecord` / `compCopyGate`）だけ。
comp から切り抜いた写真を Web 素材に使わない（`COMP_CROP_AS_ASSET`）。

## 2. セクション連続体（生成の前に定める）

画像ツールはサイズを指定できない（`gpt-image-2`、`size: auto`、観測は縦横比 1.5 程度まで。
`docs/operations/imagegen-timeout-investigation.md` §2）。そこで各ビューポートを、**生成前に宣言した**
セクション画像の列として扱う。

- 1枚 = 1回の画像呼び出し。1ビューポート最大6枚（1回のバッチの上限 6 と同じ）。
- 各画像は、含む方向性のセクション ID と、画像内での各セクションの枠（幅・高さに対する割合）を宣言する。
- ページのセクション順: PC は方向性の順そのもの。SP は同じセクションを並べ替えてよい（`sp_plan`）が、落とさない。
- 継ぎ目は1つずつ宣言する。`section_break` = セクションの境で切る。`continuous` = 1つのセクションが継ぎ目をまたぐ
  （前の画像の最後と次の画像の最初が同じ ID）。
- 合成: 各画像を 1440 / 390 の幅へ拡縮し（倍率を記録）、上から重ねずに積む。重なり帯はプロンプトの文脈だけで使う。
- 検査（暫定の閾値、実 comp でオーナーと決め直す）:
  - 宣言とページ順が一致し、欠け・重複・順序違いがない（`COMP_SECTION_SEQUENCE_INVALID`）
  - `continuous` の継ぎ目の上下の帯の平均色差 ΔE ≤ 14（`COMP_SEAM_BROKEN`）
  - 1画面より長い: PC は 900px の 1.5 画面以上、SP は 844px の 2 画面以上（`COMP_HERO_ONLY`）
  - 比較で描ける高さ 16000px 以下（`COMP_COMPOSITE_OUT_OF_RANGE`）
  - SP が PC の縮小でない: 同じ画像のバイト、または同じ縦横比で格子 SSIM が高い（`COMP_SP_IS_PC_SCALED`）

## 3. 非公開の run ディレクトリ（リポジトリの外）

```
<run>/manifest.json          model_full_page_comp_v0（--assemble で run-plan.json と各ファイルから作る）
<run>/run-plan.json          SHA・寸法を除いた同じ記録（生成の前に書く計画）
<run>/facts-pack.json        shop_facts_pack_v1（バイトの SHA が記録と一致）
<run>/direction.json         選んだ方向性1つだけ（方向性セット全体は渡さない）
<run>/parts/<name>.png       画像ツールの出力（CODEX_HOME/generated_images/<thread>/ から取り出したまま）
<run>/prompts/<name>.txt     各呼び出しのプロンプト全文（非公開。記録には SHA と文字数だけ）
<run>/visual-read.json       image_first_visual_read_v0（各画像の SHA に結び付けた located read）
<run>/identity.json          image_first_identity_v0（画像ごとの Identity Lock 監査。auditIdentity の入力そのまま）
<run>/owner-evaluation.json  image_first_owner_evaluation_v0（オーナーが画像を見て採点するまで無い）
```

- 置き場所は WSL の `~/sr-runs/<run>/`（0700 / 0600）など**リポジトリの外**。CLI はリポジトリ内の run を拒否する
  （`RUN_DIR_IN_REPO`）。画像・プロンプト・manifest を GitHub へ push しない。受け渡しは tar + SHA256SUMS でオーナーへ。
- 記録が持つメタデータ: 店舗（ID・表示名・業種）、事実パック SHA、方向性 ID と SHA、PC/SP の各画像の SHA・ピクセル寸法・
  バイト数、プロンプト全文の SHA と文字数、CLI・ツール・バージョン、セッションモデル（不明は警告）、画像モデル（不明は警告）、
  画像呼び出し ID（Codex のスレッド ID + 呼び出しの item id。`capability.ts readSessionFacts` の `image_call_ids`）、
  リポジトリのコミット、plan ID、一回限りの承認 ID、承認パケットの SHA、生成時刻、権利（design_reference_only、
  page_asset false、public_web false、ai_generated true、切り抜き不可、文字は事実の根拠でない）、保存場所の種類
  （private_outside_repo、パスは記録しない）。

## 4. 判定と拒否コード

`validateImageFirst` はすべての SHA・寸法を**バイトから計算し直す**。記録の値は信用しない。状態:

- `REJECT` — 拒否コードが1つでもある。実装へ進まない。
- `AWAITING_OWNER_EVALUATION` — 機械の検査は通り、オーナーの評価がまだ無い。**機械の検査だけで READY にはならない。**
- `READY_FOR_IMPLEMENTATION` — 機械の検査が通り、かつオーナー評価がこの comp に結び付いて合格した。

| コード | 意味 |
|---|---|
| `COMP_RECORD_INVALID` | manifest が無い・読めない・形が違う |
| `COMP_PC_MISSING` / `COMP_SP_MISSING` | PC1440 / SP390 の全頁設計が無い |
| `COMP_SP_IS_PC_SCALED` | SP が PC の縮小（同じバイト・同じレイアウトと縦横比）か、read が SP の独立を認めない |
| `COMP_HERO_ONLY` | 1画面分しかない、read が下のセクション・header・footer を見ていない |
| `COMP_SECTION_SEQUENCE_INVALID` | 宣言（順序・枠・継ぎ目・幅）がセクション連続体の規則に合わない |
| `COMP_SEAM_BROKEN` | `continuous` の継ぎ目がつながっていない |
| `COMP_COMPOSITE_OUT_OF_RANGE` | 合成が比較で描けない高さ |
| `COMP_PART_UNDECODABLE` | PNG として正しいが比較の読み手が読めない形式 |
| `COMP_NOT_MODEL_GENERATED` | HTML スクリーンショットの偽装（`rendered_from` が image_tool でない、出力種別・経路・ツールが違う、幅がブラウザ描画の 1440/390/2880/780、呼び出し ID の使い回し、read がスクリーンショットと判断） |
| `COMP_NOT_A_WEBSITE` | 写真・ポスターだけ、nav・本文・店舗情報のどれかが無い |
| `COMP_IDENTITY_REJECT` / `COMP_IDENTITY_HOLD` | 別の店（Identity Lock の `auditIdentity` をそのまま使う）／監査が無い・未完了 |
| `COMP_PROVENANCE_MISSING` | 出典不明（コミット・plan・CLI・時刻・呼び出し ID・プロンプト・事実パック・方向性・保存場所） |
| `COMP_SHA_MISMATCH` | 画像・寸法・プロンプト・事実パック・方向性・店舗が記録と違う |
| `COMP_TEXT_FABRICATED` | 画像の文字が事実に無い「事実」、価格・受賞・歴史などの捏造（`factParts` / `INVENTED_FACT_SIGNS`。文字は出力しない） |
| `COMP_RIGHTS_MISSING` | 権利の宣言が design_reference_only 等でない |
| `COMP_GENERATION_UNAPPROVED` | 承認 ID・承認パケットが無い、承認外の呼び出し |
| `COMP_VISUAL_READ_MISSING` | 各画像の SHA に結び付いた read が無い |
| `COMP_NOT_OWNER_APPROVED` | オーナー評価が不合格（理由は `owner.reasons`） |
| `COMP_CROP_AS_ASSET` / `ASSET_RIGHTS_MISSING` | 実装素材が comp の切り抜き（同じバイト・等倍の部分一致・申告）／権利記録が無い |
| `CODEX_*`（`CODEX_NO_IMAGE`、`CODEX_IMAGE_TOOL_FAILED`、`CODEX_QUOTA`、`CODEX_TIMEOUT`、`CODEX_IMAGE_COUNT_MISMATCH` ほか） | 画像呼び出しの停止コードをそのまま拒否する。失敗した呼び出しが1つでもある・呼び出しが画像の数より多い・完了が足りない も拒否 |
| `CODEX_OUTCOME_INCONCLUSIVE` | code mode で呼び出しが見えない・ログが無い（「呼ばれなかった」とは読まない） |
| `CODEX_STOP_UNKNOWN` | 知らない停止コード |

警告（拒否しない）: `IMAGE_MODEL_UNKNOWN`、`SESSION_MODEL_UNKNOWN`、`PART_UPSCALED_OVER_2X`。

検査できないこと（人が見る）: 縮小・色調整した切り抜き、PNG の中身が本当に画像ツール由来か（記録とバイトの結び付き、
呼び出し ID、幅の特徴だけで守る）、デザインの美しさ。

## 5. オーナー評価のゲート（P2 の門。実装の前）

既存の design-image の評価表をそのまま使う（`comp-impl/bundle.ts` の `EvaluationSchema` / `evaluationVerdict`）:
hard fail なし・合計 22/25 以上・各項目 4 以上・オーナーの確認・`real`。IMAGE_FIRST では、これを
manifest のバイトの SHA と、PC/SP の全画像の集合の SHA（`compSetSha256`）に結び付け、両方の合成画像を見たこと
（`viewed_composites`）と、追加の hard fail（Web でない・Hero だけ・SP が独立でない・別の店・文字の捏造）を求める。
Claude の採点だけでは確認にならない。

## 6. 実装レーンと比較への受け渡し

`toImplCompareInput` は `READY_FOR_IMPLEMENTATION` の判定（`validateImageFirst` 自身が作ったもの）だけを受け付け、
1440 / 390 ちょうどの合成画像と、宣言された枠を合成座標へ直したもの（`box_source: "declared"`）を返す。
`compareImageFirst` は impl-lane の `renderImplementation` と `compareViewport` / `viewportDifferences` を
そのまま使う（報告だけ、`passing` は常に false）。既存の `prepareImplementationLane` の `render_pair_complete` と
`impl-compare` の `not_a_render` の規則は**変えていない**。

実装そのものは既存のとおり: 事実パック → `copy.json` と文言ゲート → comp-lane → 権利のある写真
（`photo-rights`、承認済みの範囲だけ）→ `compareImageFirst` → `measureMobileQuality` → 9幅のはみ出し → オーナー。

## 7. 実行の順番（P2 / P3。この PR では実行しない）

1. P2: 店・方向性・PC と SP それぞれの枚数と用途、モデル/CLI/ツール、プロンプト全文と SHA、呼び出し回数と時間・費用の上限、
   オーナーが実行する WSL 環境、一回限りの承認 ID と期限、失敗時の停止（再試行なし）、非公開アーカイブを書いた
   **承認パケット**をオーナーに提示して止まる。
2. 承認後だけ: 生成 → `run-plan.json` から `--assemble` → read / identity を記録 → `--run` で `AWAITING_OWNER_EVALUATION`
   → オーナーが合成画像と各画像を評価 → `--run` で `READY_FOR_IMPLEMENTATION` → 実装 → 比較。
3. 使用済みの承認 ID・写真の承認・切り替えは再利用しない。先行する同じ店の解（以前の comp や画面）は、画像を作る側の
   プロンプト・作業場・添付に入れない。

```
npx tsx scripts/design-artifact/image-first-check.ts --assemble <private run dir>
npx tsx scripts/design-artifact/image-first-check.ts --run <private run dir> [--impl <implementation dir>]
```

P3 の準備（未承認）: プロンプトの決定的な組み立て（`lib/design-agent/image-first/prompt.ts`、ピンの表示
`scripts/design-artifact/image-first-prompt.ts --direction d1|d3 --print-pin`）、承認がなければ動かない実呼び出しの入口
（`scripts/design-artifact/image-first-generate.ts`）と、承認パケットの下書き [`image-first-hoshigama-p3-packet.md`](image-first-hoshigama-p3-packet.md)。

CLI は読むだけで、ファイルを書かず、アップロードもしない。終了コード: 0 READY（または --assemble 成功）、1 REJECT / AWAITING、2 拒否。
