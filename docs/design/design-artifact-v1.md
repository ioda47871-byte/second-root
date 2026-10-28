# Design Artifact v1（DEV-114 / Phase 2d-min）

Codex が作ったデザインを、Claude Code の実装へ安全に渡すための共通形式と、その受け入れ検査（Intake）である。オーナーが 2026-10-28 に承認した範囲（スキーマ・Intake・CLI・架空データのテスト）だけを実装する。Codex の実行、画像生成、描画、表現実装レーン（2e）、A/B/C の実証（2f）、人の承認記録は含まない。

最終目標は、Codex が店舗固有の独創的な Web デザインを作り、Claude Code がそれを忠実に実装する自動制作である。この形式は、その受け渡しの土台にあたる。

## 1. 2種類のデータを型と欄で分ける

| 欄 | 書く者 | 中身 | 信頼 |
|---|---|---|---|
| `declared` | Codex（答えの形は `codex_design_v1` に固定） | Design DNA（8項目、各項目に事実の参照）、構造仕様（1440/390 の箱・順序・読む順・表示する文字）、B/C の試作 HTML/CSS（本文は答えの中だけ） | 信頼しない。参照はすべて Intake が解決する |
| `observed` | 実行プログラム（Codex ではない） | 書いたファイルの SHA-256 とバイト数、原本の種類と寸法、描画条件、生成情報、停止コード、欠落 | ファイルの事実は Intake が再計算する。生成情報は「実行プログラムの報告」として示すだけで、承認として扱わない |

- `codex_design_v1` には、状態・承認・検証・ファイル・SHA の欄が無い。Codex は、それらを書く場所を持たない。
- 判定は、型・許可された欄・データの出所で行う。文字列の中の単語（approved など）を探して拒否する方式には頼らない。デザインの説明に「approved」という語があっても、それだけでは拒否しない。
- 試作の HTML/CSS は Codex の答えの JSON で返る。Codex は `--sandbox read-only` のままで、隔離領域（`quarantine/`）への書き出しは 2f の実行プログラムが行う。`codex.ts` の回答ファイル上限 1 MiB は変えない。試作の上限は HTML 384 KiB・CSS 256 KiB とし、実際の出力量は 2f で測る。

## 2. パッケージの形

```
artifact.json            design_artifact_v1
originals/*.png          PC 1440 / SP 390 のブラウザ描画、または構想画像（A）
assets/*.png             デザイン素材（C、素材ごとに承認 ID）
quarantine/*.html|*.css  Codex の試作（B/C）。実装レーンへの受け渡し一覧に入らない
```

事実パック（`shop_facts_pack_v1`）はパッケージの外に置く。`artifact.json` の `facts_pack_sha256` と、バイト単位で一致しなければならない。

## 3. 検証状態（承認ではない）

| 状態 | 条件 | 実装への受け渡し |
|---|---|---|
| `render_pair_complete` | 1440px と 390px のブラウザ描画が両方あり、全検査を通過。生成情報に不明が無く、停止も欠落も無い | 可（原本・素材・`artifact.json` だけ） |
| `concept_only` | 構想画像（A の画像ツール）として技術検証を通過。正確な PC/SP 描画ではない | 不可 |
| `incomplete` | 原本の欠落・生成失敗、生成情報の不明（`null` や `unknown`）、停止、宣言された欠落、時刻の矛盾、オーナーのアップロード（出所の記録方式が未設計のため常に） | 不可 |

- 状態は Intake を実行するたびに導く。どこにも保存しないし、読み込みもしない。パッケージ内に置かれた記録ファイル（例: `gate-record.json`）は、未宣言ファイルとして拒否する。
- `render_pair_complete` は、G2・G3・G5 の品質承認を意味しない。人のゲート（Identity の目視確認・G2・G3・G5）は常に `not_done` と出力され、Intake にそれを変える処理は無い。DEV-114 には人の承認を作る処理も、確定する処理も無い。
- A は、正確な viewport_render を持たない限り、実装へ進める完成品として扱わない。

## 4. 画像の大きさ

- ブラウザ描画は、幅がちょうど 1440 と 390、高さ 16000px 以下（comp-impl の `MAX_PAGE_HEIGHT` と同じ値をテストで固定）。2f の描画は deviceScaleFactor=1・JS 無効・ネットワーク遮断・全ページで行う計画で、`observed.render` にこの4条件を固定値で記録する（違えば拒否）。2倍の解像度の画像は、幅が合わないので拒否する。
- 上限:
  - 1440 の描画は 24 MiB・1440×16000 画素
  - 390 の描画は 12 MiB・390×16000 画素
  - 構想画像は design-image と同じ数値（24 MiB、1 辺 512〜8192、4000 万画素）
  - 素材は 16 MiB
  - パッケージ全体で 96 MiB、ファイル 32 個、`artifact.json` 1 MiB
- メモリ: Intake は画素を展開しない（チャンクと CRC の検査だけ）。後で展開する場合も、最大の描画で約 92 MB（RGBA）に収まる。
- `png.ts` は変えない。design-image を読み込めるのは PoC と comp-impl だけという既存のガード（design-image PoC の隔離テスト）を守るため、同じ構造検査（シグネチャ、全チャンクと CRC、IHDR、IDAT、空の IEND）を `intake.ts` に持つ。両者が同じ判定を返すことをテストで確かめる。

## 5. ファイルの安全性

1. パッケージのルートは一度だけ実パスに解決する。
2. ツリーを、リンクをたどらずに走査する。リンク・ハードリンク・特殊ファイル・深すぎる階層・多すぎる項目は拒否する。宣言されていないファイルも拒否する。
3. パスは相対で、`.` と `..`、絶対パス、バックスラッシュを含まず、各部分が `-` で始まらないもの（後で外部ツールに渡す時のオプション誤認を防ぐ）だけを許す。各ファイルは、役割のディレクトリ（`originals/`・`assets/`・`quarantine/`）の下になければならない。
4. 各ファイルは `O_NOFOLLOW` で開く。開いたファイルが走査で見たものと同じであることを確かめる（デバイス・inode・サイズ、`/proc/self/fd` の実パス、親ディレクトリが変わっていないこと）。そのうえで、確かめたバイト数だけを読んで SHA-256 を再計算する。
   - これで、親ディレクトリのリンク経由の脱出と、確認と読み込みの間の差し替えを止める。
   - 差し替えの防御は、テスト専用の仕掛け（走査の直後に呼ぶ関数）で1つずつ検証している。テスト用の設定は、全体の上限を下げることしかできない。
   - エラーに含まれるファイル名は、印字可能な ASCII だけに置き換えて長さを制限する（端末やログへの注入を防ぐ）。
   - パッケージ外の事実パックも、リンクをたどらずに開き、確かめたサイズを超えて読まない。
   - Intake の**後**の差し替えは止められない。そのため結果を証拠として保存せず、使う時にその場のバイトで Intake を再実行する。

## 6. A/B/C の扱い

| 経路 | 原本 | 試作 | 素材 | 画像ツールの結果 |
|---|---|---|---|---|
| A 画像 | 構想画像（画像ツール）。完全な実画面ではないと記録する | なし | なし | 画像があれば `IMAGE_SAVED` |
| B HTML 試作 | 試作のスクリーンショット（1440/390 の描画） | 必須（`quarantine/`） | プレースホルダーだけ | `not_applicable` |
| C 併用 | B と同じ | 必須 | 生成素材は1点ごとに別の承認 ID（素材どうし、本体の実行とも異なる）。素材がある場合は `IMAGE_SAVED` | 素材があれば `IMAGE_SAVED` |
| オーナーのアップロード（互換） | 構想画像（`owner_upload`）。経路は A に限る | なし | なし | `not_applicable`。Codex の実行情報（ツール・指示文の SHA）は書けない |

- どの経路でも、素材はどこかの区画から参照されていなければならない（使われない素材は拒否）。
- 素材の承認 ID は、本体の生成情報と同じく「実行プログラムの報告」として記録に出すだけで、承認の証明ではない。
- 停止コード・欠落・ファイルの SHA は、3経路で共通の形式にする。
- 停止のクラスと画像ツールの結果は、design-image（`run.ts` の `PocStopClass`、`capability.ts` の `IMAGE_OUTCOMES`）と同じ語彙を使い、一致をテストで固定する。
- 「ツールを呼んでいない」「判定不能」「呼んだが失敗」「ファイルが無い」は、この語彙で区別できる。

## 7. 停止コード

- **形式:** `ARTIFACT_SCHEMA_INVALID`・`ARTIFACT_FACTS_INVALID`・`ARTIFACT_FACT_PACK_MISMATCH`
- **ファイル:** `ARTIFACT_PATH_UNSAFE`・`ARTIFACT_UNDECLARED_FILE`・`ARTIFACT_FILE_MISSING`・`ARTIFACT_FILE_ROLE_MISMATCH`・`ARTIFACT_TOO_LARGE`・`ARTIFACT_SHA_MISMATCH`
- **画像:** `ARTIFACT_PNG_INVALID`・`ARTIFACT_VIEWPORT_MISMATCH`
- **試作:** `ARTIFACT_PROTOTYPE_INVALID`
- **経路:** `ARTIFACT_ROUTE_INCONSISTENT`
- **デザインの参照:** `ARTIFACT_FACT_UNRESOLVED`・`ARTIFACT_STRUCTURE_INVALID`・`ARTIFACT_ASSET_UNRESOLVED`
- **Codex の答え:** `CODEX_DESIGN_INVALID`（`checkCodexDesign`）

## 8. 使い方

```
npx tsx scripts/design-artifact/intake.ts --package <dir> --facts <facts-pack.json>
```

標準出力に Intake の記録（`artifact_intake_record_v1`）を出す。終了コードは、記録を出したら 0（状態は問わない）、拒否したら 2（停止コードを標準エラーへ）。不明な引数、重複した引数、値の無い引数、`--x=y` の形は 2 で拒否する。

## 9. まだ無いもの（後続）

- Codex と Claude の OS レベルの分離（別ユーザー・jail）は Phase 2e。DEV-114 では、試作を受け渡し一覧から外しているだけである。
- 2f: 実行プログラム（Codex の答えの検査 → 隔離領域への書き出し → 描画 → パッケージ作成）、HTML/CSS の出力量の測定、A/B/C の比較。
- 人の承認記録の方式、Identity Lock（2c）、構造の重複検査（2b）、操作仕様（2d の完成形）。
- 生成情報（ツールの版・承認 ID など）が実際の実行と結びついていることの証明。今は「実行プログラムの報告」として示すだけで、Intake はファイルの事実だけを再計算する。
