# 3方式の実行の入口 (実験レーン、opt-in) — DEV-143

DEV-143。Issue #180 のオーナーの最新のコメントで、設計・オフラインの実装・模擬のテスト・独立レビュー・PR 作成を承認されたもの。**この PR のマージには、別にオーナーの承認が要る。**

**この文書とコードは、実行の準備だけである。** 実 Codex・画像生成・有料 API・WSL の jail・worker・bridge・timer・Production/Staging は、どれも呼んでいないし、起動もしていない。ここにある pin は prompt の文字列のハッシュで、**生成ができること、デザインの質が良いことは何も示していない。**

設計の正本は `docs/design/three-methods-study.md` (DEV-141)。ここは、その §3・§4・§7・§9 で「今の入口では呼べない」とした3つ (DNA の無いブリーフ・方向の呼び出し・Claude が書いた素材の要求) を、**既存の実行経路から切り離した実験レーン**に作ったものと、将来つなぐときに既存のコードに要る差分を書く。

## 1. 作ったもの

| ファイル | 中身 |
|---|---|
| `lib/design-agent/three-methods/brief.ts` | 共通ブリーフ `three_method_brief_v0` の schema と検査 (`checkBrief`)。DNA を書く場所が無い |
| `lib/design-agent/three-methods/visual-first.ts` | VISUAL_FIRST (V-B) のデザインの prompt (`buildVisualFirstPrompt`)。Route B と C の2つ |
| `lib/design-agent/three-methods/direction.ts` | DIRECTION_FIRST の方向の prompt (`buildDirectionPrompt`)、答えの schema `three_method_direction_v0`、答えの検査、偽の port で順序を示す `runDirectionOffline` |
| `lib/design-agent/three-methods/page-assets.ts` | Claude が書いたページの印から、`AssetRequest` の形の素材の要求を作る (`buildPageAssetRequests`) |
| `lib/design-agent/three-methods/ledger-proposal.ts` | ledger の receipt に「方向」と「Claude のページの画像」を足す**提案**の型と検査。ledger そのものは変えない |
| `lib/design-agent/three-methods/pins.ts` | パイロットの全 prompt の pin を集める (`pilotPins`) |
| `scripts/research/three-methods-pins.ts` | オフラインの pin の CLI (`--print-pin`) |
| `design-library/research/three-methods/brief.json` | 研究の共通ブリーフ (DNA なし) |
| `tests/unit/design-agent/three-methods/lane.test.ts` | prompt・schema・素材の要求・ledger の提案・pin のテスト (偽の port だけ) |
| `tests/unit/design-agent/three-methods/isolation.test.ts` | 隔離のテストと CLI のテスト |
| `tests/unit/design-agent/three-methods/fixtures/mock-layout-page.html` | テスト用の模擬のページ (`MOCK`。デザインではなく、評価しない) |

## 2. opt-in・実験・未接続であること

テスト (`tests/unit/design-agent/three-methods/isolation.test.ts`) で、次を固定した。

- このレーンを取り込むのは、`lib`・`app`・`components`・`scripts`・`proxy.ts`・`supabase` の中で **`scripts/research/three-methods-pins.ts` だけ** (正確なパス)。既存の design step・image step・runner・worker・bridge・pipeline は、どれもこのレーンを知らない。
- package.json・`.github`・`ops`・ほかの scripts から CLI を起動するものは無い (手で起動するだけ)。
- レーンのファイルの import は、ファイルごとに完全に固定した。既存のモジュールからの import は `brief.ts` の `../artifact/schema` (事実パックの schema・DNA の観点の名前・安全な文字の規則。純粋) の1つだけ。
- Codex (`codex.ts`)・`child_process`・ネットワーク (`fetch`・`node:http(s)`・`node:net`)・playwright・モデルの API・画像ツール・sandbox・`bounded-process`・worker・ledger のファイル・既存の実行の入口を、どのファイルも名指ししない。
- レーンはファイルを読み書きしない。CLI は `readFile` で読むだけで、書かない。
- CLI は `--print-pin` 以外のことをしない。承認・plan・出力先・route などのフラグは、どれも `USAGE` で断る (終了コード 2)。

既存の隔離のテストへの例外は1つだけ足した (§9)。

## 3. 共通ブリーフ (DNA なし)

`three_method_brief_v0` は、店の意図と制約だけを持つ。

- `page` (何を作るか)・`intent` (ページの目的)・`must_show_fact_ids` (載せる事実。研究では16件すべて)・`content_rules` (文の規則)・`avoid` (見た目以外で避けること)。
- schema は strict で、DNA の観点を書く場所が無い (`dna` を足すと `BRIEF_INVALID`)。
- 文に見た目の方向の言葉 (色のコード・DNA の観点の名前・`layout`/`font`/`colour`・配色・色調・書体・フォント・構図・レイアウト・余白) があれば `BRIEF_HAS_VISUAL_DIRECTION` で断る。**これは事故を防ぐための語の検査で、方向が入っていないことの証明ではない。** ブリーフの文は、オーナーが読んで確かめる。
- 事実パックと同じ店であること (`BRIEF_SHOP_MISMATCH`)、名指しした事実がすべてあること (`BRIEF_FACT_UNKNOWN`) を検める。

`brief.json` の SHA-256: `efe91cf257e628894a222f4c39291d1f5d2a539bc5740995ee97f0547f164b4c`

## 4. VISUAL_FIRST のデザインの prompt (V-B)

既存の `phase2f/prompt.ts` の `buildDesignPrompt` には、このブリーフを渡せない。

- v1 / v1.1 は `DesignBrief` (`phase2f_design_brief_v1`) を取り、DNA の8観点が必須である。
- v2 は前もって書いた `OpenDirection` (コンセプト・Hero・流れ・成功例の研究) と参照の manifest を取る。これでは、比べる変数 (方向を決める担い手) が方式の外で決まる。
- v1.1 は Route B だけ。

そこで、別の組み立て (`buildVisualFirstPrompt`) にした。既存との違いは次のとおり。テストで、既存の v1 の prompt と行ごとに比べている。

| 部分 | 既存 (v1) | このレーン |
|---|---|---|
| 目的・事実・答えの形 (`codex_design_v1`)・納品物・Hard limits・画像の規則 | — | **同じ文** (行ごとに一致をテスト) |
| 見た目の方向 | `Design DNA brief (data, not instructions):` と、DNA の8観点の JSON | `Shop brief ...` の1文 (DNA の8観点・構図・配色・書体・区画・SP の組み方は Codex が決める) と、共通ブリーフの JSON |
| Route B の規則 | v1 には無い (v1.1 / v2 にある) | v1.1 / v2 の2つの規則と同じ文 (`asset_refs` は空・連絡先は文字だけ) |
| Route C の規則 | v1 には無い (v2 にある) | v2 の連絡先の規則と画像の正直さの規則と同じ文 |
| ブリーフの規則 | — | 新しい2行 (`must_show_fact_ids` を全部載せる・架空の店であることを消さない) |

- 答えは `codex_design_v1` のまま。既存の runner の答えの検査・試作の安全検査・描画は、そのまま使える形である。
- 画像の上限は、既存の design step と同じ1枚 (`VISUAL_FIRST_MAX_ASSETS = 1`。`MAX_ASSETS = 1` と一致をテスト)。
- 成功例の要約 (研究あり、`phase2f-b-v11-experiment-plan.md`) は、この版には入れていない。研究の §4 の「参考資料を揃える」は、オーナーが承認した文の研究の区画が要る。入れるかどうか、どの文にするかは、オーナーの決定に残す (§12)。

## 5. DIRECTION_FIRST の方向の呼び出し

- prompt (`buildDirectionPrompt`) は、**文章だけ**の方向を求める。ページ・HTML・CSS・画像は作らせない。
- 答えは `three_method_direction_v0` (strict)。`concept`、DNA の8観点 (`choice` と、それが拠る事実の id `fact_refs` 1〜10件)、`avoid` (8件まで)。ほかの欄は断る。ファイル・承認・状態・検査の欄は無い。
- `checkDirection` は、schema に加えて、`fact_refs` がこの店の事実の id であることを検める (`DIRECTION_FACT_UNKNOWN`)。
- `directionJsonSchema()` は、同じ zod の schema から作る JSON Schema (既存の design の schema と同じく、`$schema` と `minLength` を除く。空の文は zod が断る)。
- `runDirectionOffline` は、将来の入口が守る順序を示すだけのもの。**pin (SHA-256 と文字数) を先に検め、合わなければ port を呼ばない**。合えば port を1回だけ呼び、答えを厳しく検める。やり直さない。テストでは偽の port だけを渡す。実の port は無い。

## 6. Claude が書いたページからの素材の要求 (LAYOUT_FIRST・DIRECTION_FIRST)

Claude は、ページの HTML に素材の印を書く。

- `<img src="assets/A1.png" alt="描いてほしい絵の説明 (1〜2文)">` (`data-asset="A1"` は任意。書くなら一致させる)
- CSS で置く絵は、任意の要素に `data-asset="A1" data-asset-alt="描いてほしい絵の説明"`

`buildPageAssetRequests` が、印から要求を作る。

- 画像の prompt は、既存の Route C の素材の prompt (`buildAssetPrompt`) と**バイト単位で同じ文**にした (テストで比べる)。どの方式でも、画像ツールが受け取る要求は同じ種類になる。
- 印がはっきりしないときは、推測せず断る。`assets/` 以外の画像 (`ASSET_SRC_INVALID`)・説明の無い絵 (`ASSET_DESCRIPTION_MISSING`)・同じ絵に違う説明 (`ASSET_DESCRIPTION_CONFLICT`)・同じ属性の重複や、引用符の中の `>` で読み取れない印 (`ASSET_MARKER_AMBIGUOUS`)・上限 (1枚) を越える数 (`RUN_LIMIT_ASSET_CALLS`)。
- 絵の位置は、呼び出し側が測って渡す (runner と同じく、仮の画像で描いて測る)。**測っていない絵は、すべて `essential` (失敗したらオーナーへ止める) とする。** 測った位置は runner の `AssetRequest` と同じ形で、`toAssetRequestShape` はその型に代入できる (テストで型を検める)。測った絵がどちらの幅でも見えなければ断る (`ASSET_NOT_SHOWN`)。

### 既存の `image-call.ts` の `ImageRequest` との違い

| | 既存の `ImageRequest` (Route C) | このレーンの `three_method_asset_request_v0` |
|---|---|---|
| 何に結び付くか | Codex のデザインの実行 (`design`: 出力の場所・approval_id・run_id・prompt の SHA・commit・plan_id)。`readStep` で、出力の場所と ledger の両方が「成功」であることを検める | Claude が書いたページ (`page`: パスと HTML の SHA-256)。**デザインの実行は無い** |
| 位置と essential | pre-render の描画で測る | 呼び出し側が測って渡す。測っていなければ essential |
| prompt | `buildAssetPrompt` | 同じ文 |
| route・kind | `C_hybrid`・`image` | 提案: `claude_page`・`page_image` (§7) |

今の `runImageCall` は、`design` の欄が無い要求を受け付けない (`IMAGE_REQUEST_INVALID`)。**このレーンの要求は、今の画像の入口では呼べないし、呼べるようにもしていない。**

## 7. ledger の種類 (提案。ledger.ts は変えていない)

`ledger-proposal.ts` に、提案の receipt (`ProposedReceipt`) を書いた。今の receipt の欄・schema の名前 (`phase2f_live_receipt_v1`)・ID の規則・上限は、そのまま。足すのは値だけである。

| kind | route | 何の呼び出しか |
|---|---|---|
| `design` | `B_html_prototype` / `C_hybrid` | 今のまま |
| `image` | `C_hybrid` | 今のまま |
| `concept_image` | `A_image` | 今のまま |
| **`direction`** | **`direction_text`** | DIRECTION_FIRST の方向 (文章) |
| **`page_image`** | **`claude_page`** | Claude が書いたページの素材 |

- kind と route の組は1対1に決め、違う組は断る (`KIND_ROUTE_MISMATCH`)。やり直しは、今と同じく、同じ route と kind の失敗した呼び出しだけを名指しできる。
- テストで、今の実の ledger (一時ディレクトリ) が書いた receipt が、提案の receipt としても正しいことを確かめた (値を足すだけで、今の記録は読める)。
- 上限は変えない (最初の呼び出し4回・やり直し2回・1回15分・1つの計画2時間・承認は1回だけ)。方式ごとに別の plan_id にする (研究 §6)。

## 8. 将来つなぐときに既存のコードに要る差分

**どれもまだ行っていない。** つなぐこと自体が、オーナーの別の承認の対象である。既存の守り (prompt の pin・SHA・approval ID・回数と時間の上限・commit と環境の検査) は、どれも弱めない前提で書く。

### `lib/design-agent/phase2f-live/ledger.ts`

```diff
-export type CallKind = "design" | "image" | "concept_image";
-export type Route = "A_image" | "B_html_prototype" | "C_hybrid";
+export type CallKind = "design" | "image" | "concept_image" | "direction" | "page_image";
+export type Route = "A_image" | "B_html_prototype" | "C_hybrid" | "direction_text" | "claude_page";
```

- ほかの行は変えない。`precheck` の「やり直しは同じ route と kind」の検査が、新しい kind にもそのまま効く。
- kind と route の組の検査 (§7) は、`reserve` の前に入口 (各 CLI) で行う。ledger に入れるなら、`precheck` と `reserve` の最初に `KIND_ROUTES` の検査を足す (今の組は今の入口が書くものと同じなので、今の動きは変わらない)。

### `lib/design-agent/phase2f/prompt.ts`

VISUAL_FIRST の prompt を、既存の design step・pre-render・packaging (runner が prompt を組み直して SHA を検める) で使えるようにするには、prompt の版を1つ足す。

```diff
 export type PromptVariant =
   | { version: "v1" }
   | { version: "v1.1"; research: ResearchSection | null }
-  | { version: "v2"; direction: OpenDirection; references: Reference[] };
+  | { version: "v2"; direction: OpenDirection; references: Reference[] }
+  /** DEV-143: the three-method common brief without DNA (VISUAL_FIRST V-B). Routes B and C. */
+  | { version: "tm0"; brief: ThreeMethodBrief };
```

- `promptVariantOf`: `version === "tm0"` のとき、ブリーフの JSON (新しい入力 `tmBrief`) を `ThreeMethodBrief` で検め、`research`・`direction`・`references` を断る。今の v1/v1.1/v2 の分岐は変えない。
- `buildDesignPrompt`: ブリーフの有無の検査を `(variant.version === "v2" || variant.version === "tm0") === (o.brief !== undefined)` にする (tm0 は `DesignBrief` を取らない)。tm0 のときは、このレーンの `buildVisualFirstPrompt` と**同じ文**を返す (文を prompt.ts に移すなら、このレーンの pin が変わらないことをテストで固定する。レーンから import するなら、`tests/unit/design-agent/phase2f/isolation.test.ts` の prompt.ts の許可に正確なパスを足す)。
- tm0 では、`checkBrief` でブリーフと事実パックの店・事実の id を検める (`buildDesignPrompt` は事実パックを持っているので、そこで断れる)。
- v1 / v1.1 / v2 の prompt は、1バイトも変えない (既存のテストがそのまま固定する)。

### `scripts/design-artifact/phase2f-design.ts`

```diff
-const VALUES = new Set(["--route", "--facts", "--brief", ..., "--prompt-version", "--research", "--direction", "--references", "--reference-dir"]);
+const VALUES = new Set(["--route", "--facts", "--brief", ..., "--prompt-version", "--research", "--direction", "--references", "--reference-dir", "--tm-brief"]);
```

- `promptFor`: `--prompt-version tm0` は `--brief` を取らず `--tm-brief <brief.json>` を取る (v2 と同じ扱い)。
- `--print-pin` の任意のフラグの一覧に `--tm-brief` を足す。出力に `prompt_version: "tm0"` と、ブリーフの SHA-256 を足す。
- 実の呼び出しの部分 (`liveContext`・`runDesignCall`・承認・commit・sandbox の検査) は変えない。tm0 でも同じ検査を通る。
- `scripts/design-artifact/phase2f-steps.ts` (pre-render・packaging) にも、同じ `--tm-brief` を足す (packaging が同じ prompt を組み直すため)。

### 方向の呼び出しの入口 (新しいファイル)

`phase2f-design.ts` は `codex_design_v1` の答えと Route B/C を前提にしているので、方向の呼び出しは**別の入口**にするのがよい。

- 新しい `lib/design-agent/phase2f-live/direction-call.ts`: `runDesignCall` と同じ順序 (`checkBeforeApproval` → `reserve` → 1回の呼び出し → `answer.json`・`generation.json`・`call.json` → ledger の結果)。kind は `direction`、route は `direction_text`、schema は `directionJsonSchema()`。答えは `checkDirection` で検め、合わなければ失敗として記録する (やり直さない)。
- 新しい `scripts/design-artifact/phase2f-direction.ts`: `--print-pin --facts --tm-brief` と、実の呼び出しのフラグ (design step と同じ一式)。Codex は `runCodexJsonWithMeta` だけ、sandbox の中だけ。
- `checkBeforeApproval` (steps.ts) の `route` の型は `Route` を使っているので、ledger の差分で足りる。

### `lib/design-agent/phase2f-live/image-call.ts`

```diff
 export type ImageCallInput =
   | { route: "C_hybrid"; request: ImageRequest; common: Common }
-  | { route: "A_image"; prompt: string; common: Common };
+  | { route: "A_image"; prompt: string; common: Common }
+  | { route: "claude_page"; request: PageAssetRequest; page: { root: string }; common: Common };
```

- kind は `page_image`。
- 承認を使う前に、次を検める。
  1. 要求の schema が `three_method_asset_request_v0` で、prompt の SHA-256 と文字数が要求の中の値と一致する (今の Route C と同じ)。
  2. ページのファイルが、決まった根 (`page.root`。リポジトリの中の研究のディレクトリ) の下にあり、リンクではなく、追跡されている。その中身の SHA-256 が要求の `page.html_sha256` と一致する。今の commit の検査 (HEAD = origin/develop = 承認された commit、clean) と合わせて、ページのバイト列が承認された commit のものに固定される。
  3. そのページから `buildPageAssetRequests` で要求を組み直し、`asset_id`・`alt`・prompt が要求と同じである (手で書き換えた要求を通さない)。
  4. `placement` が測られていること (測っていない要求は essential のまま扱う。呼び出しを断るかどうかは、オーナーが決める)。
- 記録 (`call.json` の `request`) は、`{ page_path, page_sha256, asset_id, essential }`。
- Route C と Route A の分岐は変えない。

### `scripts/design-artifact/phase2f-image.ts`

```diff
-const VALUES = new Set(["--route", "--request", "--out", ...]);
+const VALUES = new Set(["--route", "--request", "--page-request", "--page-root", "--out", ...]);
```

- `--print-pin --page-request <request.json>`: 要求を組み直して検め、pin を出す (オフライン)。
- `--route P --page-request <request.json> --page-root <dir>` と実の呼び出しのフラグ: `runImageCall` の `claude_page` の分岐へ。`routeOk` に、`P` と `--page-request` の組を足す (`--request` や `--concept-v4` とは同時に使えない)。
- 画像の PoC の承認・pin・使った承認の記録・出力は、今のまま触らない。

### 隔離のテスト

つなぐときは、次のテストの許可に、正確なパスで足す。ゆるい規則にはしない。

- `tests/unit/design-agent/phase2f-live/isolation.test.ts` (新しいファイルと import)
- `tests/unit/design-agent/phase2f/isolation.test.ts` (prompt.ts が tm0 のためにレーンを import する場合)
- `tests/unit/design-agent/three-methods/isolation.test.ts` (取り込み元に、入口の正確なパスを足す)

## 9. 隔離の例外

既存の隔離のテストに足した例外は、1つだけである。

- `tests/unit/design-agent/artifact/isolation.test.ts` の「artifact を取り込むファイル」に、`lib/design-agent/three-methods/brief.ts` を正確なパスで足した (事実パックの schema・DNA の観点の名前・安全な文字の規則だけ。intake は使わない)。

既存のモジュールの lib のファイルは、1つも変えていない。

## 10. パイロットの pin

`node --import tsx scripts/research/three-methods-pins.ts --print-pin` の出力 (commit は出さない。git を呼ばないため。実の入口の commit の検査がそのまま効く)。

入力:

- `facts-pack.json`: `e63d925a1e1cdae46502d9e2a1fc2745eb69a47e65df7ba51fdd9036d04597c0`
- `brief.json`: `efe91cf257e628894a222f4c39291d1f5d2a539bc5740995ee97f0547f164b4c`

| id | 方式 | 用途 | kind・route | 答えの形 | prompt の SHA-256 | 文字数 |
|---|---|---|---|---|---|---|
| `VISUAL_FIRST.design.B_html_prototype` | VISUAL_FIRST (V-B、画像なし) | design | `design`・`B_html_prototype` | `codex_design_v1` | `d8cc6c6984088245d68b00d694dc05bd4b67364de326421ad6d707750316812a` | 3846 |
| `VISUAL_FIRST.design.C_hybrid` | VISUAL_FIRST (V-B、画像1枚まで) | design | `design`・`C_hybrid` | `codex_design_v1` | `b3d51744a75810b1bd6fe0531eb3e91843912add60e2babe194e163c7d11938f` | 4398 |
| `DIRECTION_FIRST.direction` | DIRECTION_FIRST | direction | `direction`・`direction_text` (提案) | `three_method_direction_v0` | `641d01f91d85bfd0005effd08b2ec9c0767a384878fd6f2accaeed730dc6d3ad` | 3353 |

- 方向の答えの JSON Schema の SHA-256: `e9050605def92bb9556a25e7a2bc88657c41a3fb21b2d70ed1521a97bfa555ef`
- VISUAL_FIRST の Route B と C のどちらをパイロットで使うかは、オーナーが決める。両方を出したのは、ここで選ばないためである。
- 素材の pin は、Claude が書いたページがまだ無いので、出していない。ページができたら `--layout-page <html>` / `--direction-page <html>` で出す。素材の prompt は、絵の説明 (alt) と事実パックだけで決まる。
- この表の値は、テスト (`lane.test.ts`) が CLI と同じ組み立てで計算し直して、この文書と比べる。prompt か入力が変われば、テストが落ちる。

## 11. V-B と「Codex の画像ツールの完成デザイン」は同じ実験条件ではない

オーナーの指摘のとおり、次の2つは**別の条件**である。

- **V-B (このレーンで作ったもの):** Codex が HTML/CSS の試作を書き、runner がそれを PC1440/SP390 で描く。原本はその幅の描画で、実装の忠実度を `impl-compare` で測れる。
- **V-A (作っていない):** Codex の画像ツールが、完成デザインの絵を1枚作る。その幅の描画ではない (concept image)。今の実装レーンは concept image だけの artifact を引き渡さず、忠実度も機械では測れない。

V-B の結果を「Codex の画像ツールで作った完成デザイン」として報告しない。V-A を比べたい場合は、別の prompt (今の Route A の prompt は和菓子の固定の v4)・別の入口・別の引き渡しの道筋が要り、研究の §10.1 のオーナーの決定と、別の承認が要る。

## 12. まだオーナーの承認が要るもの

1. **この PR の develop へのマージ。** prompt・ledger の種類・画像の入口にかかわる準備なので、Issue #177 の条件付きマージの対象外である。
2. **つなぐこと (§8)。** prompt.ts・ledger.ts・image-call.ts・phase2f-design.ts・phase2f-image.ts と、新しい方向の入口の変更。
3. **ブリーフの文の確認。** `brief.json` の文がオーナーの意図どおりで、見た目の方向を含まないこと。
4. **成功例の要約を prompt に入れるか** (§4)。入れるなら、その文の承認。
5. **VISUAL_FIRST の Route (B か C か)** (§10)。
6. **呼び出しごとの実行の承認** (研究 §7)。approval_id・plan_id・expected prompt SHA と文字数・expected commit の組で、呼び出しごとに承認する。

## 13. 限界

- ブリーフの「見た目の方向が無い」検査は語の検査で、すべての言い換えは捕まえない。
- 素材の印の読み取りは、ブラウザではなく単純な読み取りである。はっきりしないものは断る側に倒した。絵の位置は読まない (呼び出し側が描いて測る)。
- pin は prompt の文字列のハッシュである。Codex が何を返すか、画像が作れるか、デザインが良いかは、何も示さない。
- CLI は commit を出さない。承認の組の commit は、オーナーが承認する commit を別に記録する。
