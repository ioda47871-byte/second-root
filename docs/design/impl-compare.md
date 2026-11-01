# デザイン画像と実装画面の一致検査 (DEV-139、Issue #177 A)

**offline・report-only。** Claude の実装を、デザインの PC 1440 / SP 390 の原本と比べ、差を原因コードとして報告する。合否・採用・修正の実行には使わない。最終的な見た目の判断はオーナーがする。

## 何を比べるか

- **デザイン側**: 実装レーン (DEV-128 `prepareImplementationLane`) にある artifact の記録と、PC / SP の原本。Codex の試作 (`quarantine/`) は入らない。
- **実装側**: Claude の実装。`index.html` と `style.css`、および任意で `assets/<name>.png` から成る。
- 実装は、原本と同じ条件で描く。
  - deviceScaleFactor 1、JavaScript 無効。
  - 自分のファイル以外への通信は拒否し、その数を記録する。
  - ページ全体を幅で切り出す。SP 390 は Phase 2f と同じく、mobile 化しない素の 390 幅で描く。
  - 区画の箱は、Phase 2f の runner がデザインの箱を測ったのと同じ規則で測る (phase2f は読み込まないので、規則を写した)。
    - その id を持つ最初の要素を測る。
    - `display:none` と `visibility:hidden` は 0×0 (非表示) とする。
    - 大きさ 0 の根 (`display:contents`、中身がすべて絶対配置など) は、描かれた中身で測る。ただし、切り抜く根は非表示のままとする。
    - 同じ id を持つ要素が2つ以上あれば、そのビューポートは `DUPLICATE_SECTION_ID` として比べない。
  - 同じページなら Phase 2f の描画と画像も区画の箱も一致することを、テストで確かめている。visibility:hidden・display:contents・高さ 0 の根・切り抜く根・無い区画も含めて確かめた。
- 比較は DEV-131 の `compareViewport` を使う。
  - ページ全体: SSIM、色ブロック、エッジ、高さ。
  - 区画ごと: 位置、順序、色、密度、大きさ。
  - 原因コード (`PC_SECTION_ORDER`、`SP_SECTION_MISSING_INFO` など) も DEV-131 のものをそのまま使う。閾値は DEV-131 の**仮**の値で、新しい閾値は足していない。

## 原本とみなさないもの

次のビューポートは**比べない**。比べないことと、その理由を報告に残す。

| `design.state` | 意味 |
|---|---|
| `missing` | 原本が無い (artifact が missing・generation_failed、または lane.json に載っていない) |
| `not_a_render` | concept image (画像ツールの絵)。その幅のページの描画ではない |
| `file_changed` | lane.json に記録されたハッシュと違う |
| `file_unreadable` | 読めない・リンク・上限より大きい |

- 片方だけ比べたときは `status: "partial"`、どちらも比べられないときは `not_compared` とする。比較が断ったビューポート (`DECODE_FAILED`・`WIDTH_MISMATCH`・`DUPLICATE_SECTION_ID`) は何も測っていないので、比べたとは数えない。その原因コードは `differences` に残る。
- artifact.json が lane.json のハッシュと違う lane は、報告を書かずに断る (`ARTIFACT_CHANGED`)。
- 区画の箱の出所を `box_source` に残す。
  - `measured_by_runner`: Phase 2f が描画で測った箱。
  - `declared`: 宣言された箱 (オーナーのアップロードなど)。宣言どおりの精度しかない。

## CLI

```
npx tsx scripts/design-artifact/impl-compare.ts --lane <実装レーン> --impl <実装のディレクトリ> --out <report.json>
```

- ファイルは開いたハンドルで読み、上限もそのハンドルで確かめる。読むパスのどこにもリンクがあってはならず、確かめたあとに差し替えられたものも辿らない。
- 入力は読むだけで、書くのは `--out` の新しいファイル1つ (`wx`、0600) だけ。
- 次の場合は断る (exit 2)。
  - `--out` が入力の中にある。名前 (`..x` を含む) でも、リンク越しの実パスでも断る。
  - `--out` が既にある。
  - 実装の `index.html` / `style.css` が無いか、リンクか、上限より大きい。
  - `assets/` がリンクである。PNG 以外の名前がある。
  - lane が使えない。
- 上限は artifact schema と同じ値 (HTML 384 KiB、CSS 256 KiB、画像 16 MiB、最大32枚)。
- ブラウザが起動しないときは `not_compared` の報告を書き、exit 0 で終わる。きれいな結果にはしない。

## 報告 (`impl_compare_report_v0`)

| フィールド | 中身 |
|---|---|
| `status` | `compared` / `partial` / `not_compared` |
| `passing` | 常に `false` |
| `lane` | artifact_id、artifact.json と lane.json のハッシュ |
| `implementation` | HTML・CSS・各画像のハッシュ |
| `viewports.<v>.design` | 原本の状態、パス、ハッシュ、`rendered_from`、`box_source` |
| `viewports.<v>.implementation` | `rendered` / `render_failed` (理由の1行目、パスは伏せる) / `not_rendered`、PNG のハッシュ、高さ、横幅、拒否した通信の数 |
| `viewports.<v>.compare` | DEV-131 の数値 (比べなかったときは null) |
| `differences` | 比べたビューポートの原因コード |

## テスト (架空の店舗だけ)

`tests/unit/design-agent/impl-lane/impl-compare.test.ts` で確かめていること:

- 架空のパン屋のデザインページを描いて原本を作り、route B の package にして、**本物の** DEV-128 lane を通す。
- 描画が Phase 2f の描画と、画像・箱とも同じになる。
- 忠実な実装は差なし (それでも `passing: false`)。
- 雑な実装 (区画の順序・欠落・色の違い) は、PC・SP それぞれに原因が出る。
- SP の組み直しだけが違う実装は、SP にだけ差が出る。
- 外への通信は拒否され、数が記録される。
- 原本が無い・concept image・ハッシュ違いは比べない。宣言の箱はそう記録する。
- 記録が変わった lane・lane でないもの・リンクした記録は断る。
- CLI について:
  - 入力を変えない (全ファイルのハッシュで比較)。上書きしない。
  - 中への出力・`..x`・リンク越しの出力を断る。
  - リンクした CSS・assets、PNG 以外を断る。
  - ブラウザが起動しないときは `not_compared` を書く。

## 隔離

- 新しいのは `lib/design-agent/impl-lane/impl-compare.ts` と、その CLI だけ。
- `impl-compare.ts` が読み込むのは、artifact の schema、DEV-131 の比較、node と playwright だけ。
  - phase2f・comp-impl・修正ループ・Codex・ネットワーク・子プロセスは読み込まない。
  - 何も書かない。
- 実装レーンを読み込めるのは、この CLI の正確なパス1つだけ。
- artifact モジュールを読み込める例外に、`impl-compare.ts` を正確なパスで足した (schema の `DesignArtifact` だけ)。
- `compare.ts` は、1ビューポートの比較 (`compareViewport`) と原因コード (`viewportDifferences`) を export しただけ。`compareRenders` の挙動は同じで、既存のテストはそのまま通る。

## 限界

- 閾値は DEV-131 の仮の値で、実際の組 (原本と実装) で確かめていない。数値と原因コードはオーナーの目視を助けるためのもので、採用の判断ではない。
- 実装は Claude が書いた HTML/CSS を前提にし、ここでは実装を作らない。実装を作る段と修正ループへの接続は、この段の外 (Issue #177 D は模擬のみ)。
- 描画は同じ Chromium の上で比べる。フォントの違いなど、環境の差は検査しない。
