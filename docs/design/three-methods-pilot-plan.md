# 3方式の最初のパイロットの実行計画 (最小の配線) — DEV-149

DEV-149。Issue #180。オーナーは、#177/#180 のオフラインの作業が済んだことを確かめ、**3方式の実画面を比べられる状態に早く届くこと**を優先すると示した。この文書は、そのための**最小の配線**と、最初のパイロットの実行の手順をまとめた計画である。

**この文書は計画だけである。** ここに書いた配線は、まだ1行も行っていない。実 Codex・画像生成・有料 API・WSL・jail・worker・timer・Production/Staging には触れていない。配線の PR を作ること、マージすること、呼び出しの1回ずつは、それぞれ別のオーナーの承認が要る (§10)。

前提にする文書:

- 研究の設計: `docs/design/three-methods-study.md` (以下「研究」)。特に §3〜§8・§10 のオーナーの暫定方針・§13。
- 実験レーンと、つなぐときの差分: `docs/design/three-methods-entries.md` (以下「入口」)。特に §8・§10・§12。
- 実の呼び出しの守り: `docs/design/phase2f-live.md`、`lib/design-agent/phase2f-live/*`。

最初のパイロットは、研究 §10 の暫定方針で行う。

| 項目 | 暫定方針 (研究 §10) |
|---|---|
| 共通ブリーフ | `design-library/research/three-methods/brief.json` (SHA-256 `efe91cf2…4b4c`) |
| 成功例の要約 | Codex に渡さない |
| VISUAL_FIRST | Route C (Codex の HTML 試作 + 画像0〜1枚)。条件は `route_c_prototype` |
| DIRECTION_FIRST | 文章の方向。条件は `direction_text` |
| LAYOUT_FIRST | 条件は `claude_layout` |
| 位置を測れない画像の要求 | 断る (`runnableAssetRequests`) |
| 回数 | 各方式1回 |
| 評価の前の途中確認 | しない (盲検) |
| 自動修正のきっかけ | Claude の実装の横はみ出しだけ |

## 1. 変えるファイルと既存の機能への影響

入口 §8 の差分のうち、最初のパイロットに要るものだけにした。PR は1本にする (§8)。

### 1.1 変える既存のファイル

| ファイル | 変えること | 理由 | 既存の動きへの影響 |
|---|---|---|---|
| `lib/design-agent/phase2f-live/ledger.ts` | `CallKind` に `direction`・`page_image`、`Route` に `direction_text`・`claude_page` を足す。`precheck` と `reserve` の最初に、kind と route の組の検査 (`ledger-proposal.ts` の `KIND_ROUTES` と同じ組) を足す | DIRECTION_FIRST の方向と、Claude のページの画像を、同じ台帳 (1回限りの承認・回数・時間) に載せるため | 今の組 (`design`×B/C、`image`×C、`concept_image`×A) は今の入口が書くものと同じなので、通る。上限 (`LIVE_LIMITS`)・ID の規則・receipt の schema 名は変えない。今の receipt は提案の receipt としても読める (入口 §7、`lane.test.ts`) |
| `lib/design-agent/phase2f/prompt.ts` | `PromptVariant` に `{ version: "tm0"; brief: ThreeMethodBrief }` を足す。`promptVariantOf` は新しい入力 `tmBrief` を `ThreeMethodBrief` の schema で読み、`research`・`direction`・`references` を断る (`promptVariantOf` は事実パックを持たないので、ここでは `checkBrief` を呼べない)。`buildDesignPrompt` は、ブリーフの有無の検査を `(variant.version === "v2" \|\| variant.version === "tm0") === (o.brief !== undefined)` にし、tm0 のときは `checkBrief(variant.brief, o.facts)` で店と事実の id を検めてから、レーンの `buildVisualFirstPrompt({ route, facts, brief, maxAssets: o.maxAssets })` を**呼んで**その文を返す (呼び出し側は今と同じく `maxAssets: 1` を渡す。CLI の `MAX_ASSETS`、runner の `PLAN_LIMITS.maxAssetCalls`)。入口 §8 と同じ形 | VISUAL_FIRST のデザインを、今の design step・pre-render・packaging で使うため | v1・v1.1・v2 の分岐は変えない。prompt の文を prompt.ts に**写さない** (レーンから import する) ので、レーンの pin は変わりようがない。v1/v1.1/v2 の pin は既存のテストが固定する (§1.4) |
| `scripts/design-artifact/phase2f-design.ts` | `--prompt-version tm0` と `--tm-brief <brief.json>` を足す (v2 と同じく `--brief` を取らない)。`--print-pin` の任意フラグに `--tm-brief`、出力に `prompt_version: "tm0"` とブリーフの SHA-256 | VISUAL_FIRST のデザインの1回を、今の入口で呼ぶため | 実の呼び出しの部分 (`liveContext`・`runDesignCall`・承認・commit・sandbox) は変えない。tm0 も同じ検査を通る。今のフラグの組は今と同じ結果 |
| `scripts/design-artifact/phase2f-live-cli.ts` | ページのファイルが追跡されているかを返す関数を足す (今の commit の検査と同じ `runBounded` の git、同じ timeout) | ページの画像の検査 2 のため | 今の関数は変えない |
| `scripts/design-artifact/phase2f-steps.ts` | `--package` に `--tm-brief` を足す (packaging は prompt を組み直して、記録の SHA と照らすため) | VISUAL_FIRST の Artifact 化 | `--prerender` は答えだけを読むので変えない。`--sheet` も変えない |
| `lib/design-agent/phase2f-live/image-call.ts` | `ImageCallInput` に `{ route: "claude_page"; request; page: { root }; common }` を足す。kind は `page_image`。承認を使う前の検査は入口 §8 の 0〜4 (DOM の安全検査・要求の schema と pin・ページのファイルと SHA・要求の組み直し・測った位置)。**ブラウザと git が要る検査は、このモジュールでは行わない** (今の `image-call.ts` が取り込めるのは node・`../codex`・`./ledger`・`./steps` だけで、プロセスも起動できない)。DOM の安全検査と alt の取り出し (`checkPrototype`) と、ページのファイルが追跡されていることの確認は、CLI から関数として注入する (`design-call.ts` が Codex を注入されるのと同じ形)。モジュールが自分で行うのは、要求の schema と pin・ページの SHA-256・注入された DOM の結果からの要求の組み直し・測った位置 (`runnableAssetRequests`) だけ。新しく取り込むのは `../three-methods/page-assets` (純粋) だけ | LAYOUT_FIRST・DIRECTION_FIRST の画像 (0〜1枚) | Route C と Route A の分岐は変えない。今の要求 (`phase2f_image_request_v1`) の扱いも変えない |
| `scripts/design-artifact/phase2f-image.ts` | `--route P --page-request <request.json> --page-root <dir>` と、`--print-pin --page-request` を足す。`P` は `--request`・`--concept-v4` と同時に使えない。注入する2つを作る: `playwright` の Chromium で `checkPrototype` (`lib/design-agent/phase2f/prototype-safety.ts`) を走らせる関数 (承認を使う前、`P` のときだけ起動する。design step の v2 の参照画像と同じ扱い) と、ページのファイルが追跡されているかを返す関数 (`phase2f-live-cli.ts` に足す。画像 CLI 自身はプロセスを起動しない) | 同上 | 画像の PoC の承認・pin・使用済みの記録・出力は触らない。C と A の今のフラグは今と同じ結果 |

### 1.2 新しいファイル

| ファイル | 中身 | Codex |
|---|---|---|
| `lib/design-agent/phase2f-live/direction-call.ts` | 方向の1回 (`runDesignCall` と同じ順序: `checkBeforeApproval` → `reserve` → 1回 → `answer.json`・`generation.json`・`call.json` → 台帳の結果)。kind `direction`、route `direction_text`、schema は `directionJsonSchema()`。答えは `checkDirection` で検め、合わなければ失敗として記録する。やり直さない | 注入された関数だけ (このファイルはプロセスもネットワークも持たない) |
| `scripts/design-artifact/phase2f-direction.ts` | 方向の入口。`--print-pin --facts --tm-brief` と、実の呼び出しのフラグ (design step と同じ一式)。Codex は `runCodexJsonWithMeta` だけ、preflight が用意した sandbox の中だけ | 1回 (承認1件につき) |
| `scripts/design-artifact/three-methods-steps.ts` | **オフライン**の手順。Codex も画像ツールも呼ばない。`--lane` (VISUAL_FIRST の package から `prepareImplementationLane`)、`--direction` (方向の記録を `readStep` で読み、`checkDirection` で検めて Claude に渡す)、`--page-request` (Claude のページを `checkPrototype` に通し、仮の画像で描いて位置を測り、`buildPageAssetRequests` → `runnableAssetRequests` で要求と `prerender.md` を書く)、`--check` (Claude のページを PC1440/SP390 で描き、PNG・`scrollWidth`・`measureMobileQuality`・`auditPageText`・`observeStructure` を記録する。`--image` を渡せば `readStep` で画像の記録を検めてから組み込む)。**Identity Lock (`lib/design-agent/identity/identity-lock.ts`) と構造の観察 (`lib/design-agent/structure/observe.ts`) を、テストの外で初めて取り込むファイルになる** (構造の観察は、完成した package だけを見る `phase2f-structure-observe.ts` に次いで2つ目)。どちらも今は、テスト (と構造はその CLI) のほかは取り込まないと固定されている (§2.3)。この取り込みを、承認 A の中で名指しする (§10)。`--check` は Claude のページだけを見る。Codex の試作は見ない (§2.2) | 呼ばない |

- 事実パックの schema は、レーンの `brief.ts` が再び出している `FactsPack` から取る (artifact の隔離の例外を増やさない)。
- `three-methods-steps.ts` は検査を新しく作らない。既存の関数を呼んで、結果を記録するだけである。閾値・停止条件・合否は足さない (研究 §5)。

### 1.3 足すテスト (偽の port と一時ディレクトリだけ。実の呼び出しは無い)

| テスト | 確かめること |
|---|---|
| `tests/unit/design-agent/phase2f/prompt-tm0.test.ts` (新規) | `buildDesignPrompt` の tm0 の文が、レーンの `buildVisualFirstPrompt` とバイト単位で同じ。pin が入口 §10 の表 (`b3d51744…`/4398、`d8cc6c69…`/3846) と同じ。tm0 で `--research`・`--direction`・`DesignBrief` を断る |
| `tests/unit/design-agent/phase2f-live/direction-call.test.ts` (新規) | `design-call.test.ts` と同じ形。承認を使う前の停止では何も使わない。台帳の receipt が `direction`×`direction_text`。答えが schema に合わなければ `failed`。やり直さない |
| `tests/unit/design-agent/phase2f-live/steps.test.ts` などに追記 | kind と route の違う組を台帳が断る。今の組は今のまま通る |
| `tests/unit/design-agent/phase2f-live/steps.test.ts` に追記 (今、`runImageCall` のテストはここにある。大きくなるなら新しい `page-image-call.test.ts` に分ける) | 0〜4 の検査のそれぞれで、承認を使わずに止まる。測っていない要求は `ASSET_PLACEMENT_UNMEASURED` |
| `tests/unit/design-agent/research/three-methods-steps.test.ts` (新規) | 4つの手順を、DEV-142 の模擬の fixture で通す。書く先は新しいディレクトリだけ |
| `tests/unit/design-agent/phase2f-live/inputs.test.ts` などに追記 | `phase2f-image.ts --route P` の引数の組と、注入する DOM の検査・追跡の確認が承認を使う前に走ること |
| 隔離のテスト (§2.3) | 正確なパスの追加だけ |

### 1.4 既存の動きが変わらないことを固定しているテスト

- v1 の B (`a2fdd003…`/5706)・C (`20b6ec35…`/6200)・v1.1 (`c5973afb…`/6010、`a0dbb48c…`/7741): `tests/unit/design-agent/phase2f/prompt-v11.test.ts`、`parts.test.ts`。v2 は `open-direction.test.ts`。どれも変えない。
- レーンの pin: `tests/unit/design-agent/three-methods/lane.test.ts` が、CLI と同じ組み立てで計算し直し、入口 §10 の表と比べる。prompt の文か入力が変われば落ちる。
- 実の呼び出しの守り: `tests/unit/design-agent/phase2f-live/design-call.test.ts`・`steps.test.ts`・`preflight.test.ts`・`inputs.test.ts`・`image-once.test.ts`。
- 研究の入力のハッシュ: `tests/unit/design-agent/research/three-methods.test.ts`。模擬の通し: `three-methods-mock.test.ts`。統合検証の模擬: `tests/unit/design-agent/integration-check/*`。

### 1.5 つながないもの (この計画の外)

- worker・bridge・timer・pipeline・Production/Staging・本番の design 経路。新しい入口も、手で起動するだけ (package.json・`.github`・`ops` から起動しない)。
- limited autofix (`lib/design-agent/autofix-mock/`)。修正は Claude が手で行う (§3)。
- 統合検証の報告 (`integration_check_report_v0`) の live 化。`tests/unit/design-agent/integration-check/integration-check.ts` はテストの補助で、`run_kind: "live"` を断る (`docs/design/integration-check.md` §5)。live の報告にするには別の承認が要る。パイロットでは、同じ検査の結果を `three_method_run_v0` の `checks` に記録する。
- V-A (画像ツールの完成デザイン、`image_tool_design`) と、方向の画像 (`direction_image`)。研究 §13 の別条件で、入口・承認とも別。
- 成功例の要約の prompt への追加 (暫定方針で渡さない)。
- `LIVE_LIMITS` の変更、自動のやり直し。

## 2. 承認ゲート・Identity Lock・隔離をどう保つか

### 2.1 既存の守りと、配線のあと

| 守り | どこにあるか | 配線のあと |
|---|---|---|
| オーナーの確認 (`--human-approval-confirmed`) | `checkBeforeApproval` (`steps.ts`) | 方向・ページの画像も同じ関数を通る |
| prompt の pin (SHA-256 と文字数。prompt の文字そのものから計算) | 同上 (`PROMPT_PIN_MISMATCH`) | 同じ。tm0 も方向も、CLI が組み立てた文で比べる |
| commit の pin (HEAD = origin/develop = 承認した commit、作業ツリーが空) | 同上 + `liveContext` の `commit` (`phase2f-live-cli.ts`) | 同じ。新しい入口も `liveContext` を使う |
| 出力先 (新しい・リポジトリの外・親が実在・親が Codex のホーム/一時/ホーム/リポジトリを含まない) | `checkBeforeApproval`、`liveContext` | 同じ |
| sandbox (jail) の準備と `.env` の検査 | `liveContext` の `preflight` (`prepareCodexSandbox`・`codexDotenvPresent`) | 同じ。Codex は sandbox の中だけ |
| 承認 ID (1回だけ。原子的な mkdir) | `ledger.ts` の `reserve` | 同じ。kind と route の組を先に検める (§1.1) |
| plan_id ごとの回数 (最初4回・やり直し2回) と時間 (1回15分・計画2時間) | `LIVE_LIMITS` | 変えない。方式ごとに別の plan_id |
| やり直しは同じ route と kind の、成功していない呼び出しを名指しした新しい承認だけ | `precheck` | 同じ。新しい kind にもそのまま効く |
| 後の工程は、出力のフォルダーと台帳の両方が成功のときだけ使う | `readStep` | 方向 (`--direction`) とページの画像 (`--check --image`) も `readStep` を通す |
| Route C の画像は、成功したデザインの実行に結び付き、同じ plan | `image-call.ts` | 変えない |
| ページの画像は、ページの SHA・組み直した要求・測った位置に結び付く | 新規 (入口 §8 の 0〜4) | ページはリポジトリの中の研究のディレクトリにあり、追跡されていることを検める。commit の pin と合わせて、ページのバイト列が承認した commit のものに固定される |
| Claude に Codex の試作の HTML/CSS を渡さない | `prepareImplementationLane` (DEV-128) | VISUAL_FIRST の受け渡しは `--lane` だけで行う。**これは手順の上の分離で、OS の分離ではない** (`handoff.ts` の注記)。デザインの出力の `answer.json` (試作の HTML/CSS を含む) と package の `quarantine/` は、`sr-designgen` から読めるまま残る。そのため、pre-render・Artifact 化・lane づくり (§3.2 の 4・7・8) は**オーナーが** `sr-designgen` で走らせ、Claude には lane のディレクトリの写しだけを渡す。Claude は `answer.json`・`quarantine/`・デザインの出力のフォルダーを開かない。どう渡すかは承認 B で決める |

### 2.2 Identity Lock

- **呼び出しの前:** 研究の Identity Lock (`identity-lock.json`、`is_research_only: true`) は、`auditPageText(lock, 事実の文)` で `PASS_IDENTITY_ONLY` になることを確かめる (`tests/unit/design-agent/research/three-methods.test.ts` が既に同じ形で固定している)。`auditIdentity` は使わない: これは生成した画像を、記録した目視 (`output.image_sha256` と `visual_inspection`) と照らす関数で、Lock だけを渡すと `HOLD` になる。ブリーフと事実パックの店が同じことは `checkBrief` (`BRIEF_SHOP_MISMATCH`) が検める。どちらも §9 のオフラインの準備で行う。
- **Codex の試作 (VISUAL_FIRST):** 機械では検めない。今の runner は Identity を走らせない (`runner.ts` は package の `checks.identity` を `null` にする)。試作の HTML を Claude 側で読むと手順の分離 (§2.1) が崩れるので、`--check` は試作を見ない。試作の店名の取り違えが Claude の実装に写れば、次の行の検査で止まる。
- **生成した画像 (C1-c・C2-a/b):** `auditIdentity` を目視の記録つきで当てるかは、決まっていない (§10)。当てるなら、誰がいつ絵を見るかが盲検に関わる。
- **Claude の実装 (3方式):** `--check` で、PC 1440 と SP 390 の見える文字に `auditPageText` を当てる。`PASS_IDENTITY_ONLY` でなければ、修正せずに止める (`runLoop` と同じ。研究 §4)。
- `PASS_IDENTITY_ONLY` は「正しい店」というだけで、品質の合格ではない。

### 2.3 隔離のテストに足す正確なパス

ゆるい規則にはしない。足すのは次の正確なパスと、取り込む名前の一覧だけである。

| テスト | 足すもの |
|---|---|
| `tests/unit/design-agent/three-methods/isolation.test.ts` (「レーンを取り込むのは CLI だけ」の git grep) | 取り込むファイルに、正確なパスで `lib/design-agent/phase2f/prompt.ts` (`brief`・`visual-first`)、`lib/design-agent/phase2f-live/image-call.ts` (`page-assets`)、`lib/design-agent/phase2f-live/direction-call.ts` (`direction`)、`scripts/design-artifact/phase2f-direction.ts`、`scripts/design-artifact/three-methods-steps.ts`。レーンのファイルの import の固定 (`ALLOWED`) はそのまま (レーンは既存のモジュールを新しく取り込まない) |
| `tests/unit/design-agent/phase2f/isolation.test.ts` | `ALLOWED` の `prompt.ts` に `../three-methods/brief`・`../three-methods/visual-first`。「phase2f を取り込むのはこれだけ」の一覧 (今 `[CLI, DESIGN_STEP, STEPS]`) に、`scripts/design-artifact/phase2f-image.ts` (`prototype-safety` の `checkPrototype`・`PrototypeUnsafe` だけ) と `scripts/design-artifact/three-methods-steps.ts` (`prototype-safety`・`render-prototype`・`runner` の `placeholderPng` など、使う名前だけ) を、DESIGN_STEP・STEPS と同じく名前の一覧つきで足す |
| `tests/unit/design-agent/phase2f-live/isolation.test.ts` | `ALLOWED` に `lib/design-agent/phase2f-live/direction-call.ts` (`node:crypto`・`node:fs/promises`・`node:path`・`../codex`・`./ledger`・`./steps`・`../three-methods/direction`)。`image-call.ts` に `../three-methods/page-assets`。`IMAGE_CLI` に `playwright` と `${L}/phase2f/prototype-safety` (名前は `checkPrototype`・`PrototypeUnsafe` だけ)。`CLIS` に2つの CLI を足し、「has exactly the expected files」が通るよう、どちらにも `ALLOWED` の一覧を置く: `scripts/design-artifact/phase2f-direction.ts` は `node:fs/promises`・`node:path`・`${L}/codex`・`${L}/three-methods/brief`・`${L}/three-methods/direction`・`${L}/phase2f-live/direction-call`・`${L}/phase2f-live/ledger`・`./phase2f-live-cli` (Codex は `runCodexJsonWithMeta(` だけ、画像のことばなし)。`scripts/design-artifact/three-methods-steps.ts` は `node:crypto`・`node:fs/promises`・`node:os`・`node:path`・`playwright`・`${L}/impl-lane/handoff`・`${L}/identity/identity-lock`・`${L}/structure/observe`・`${L}/structure/references`・`${L}/phase2f/prototype-safety`・`${L}/phase2f/render-prototype`・`${L}/phase2f/runner`・`${L}/phase2f-live/ledger`・`${L}/phase2f-live/steps`・`${L}/three-methods/brief`・`${L}/three-methods/direction`・`${L}/three-methods/page-assets` (`STEPS_CLI` と同じ「Codex・画像ツール・sandbox・プロセスに届かない」検査を掛ける)。実装でこれより少なくなれば、その分だけ減らす。「ほかに取り込むものは無い」の git grep の一覧 (今 `[DESIGN_CLI, IMAGE_CLI, CLI_SHARED, STEPS_CLI]`) に `phase2f-direction.ts` と `three-methods-steps.ts` (`readStep`・`openLedger` を使う)。`phase2f-live-cli` を取り込むものの一覧 (今 `[DESIGN_CLI, IMAGE_CLI]`) に `phase2f-direction.ts` |
| `tests/unit/design-agent/identity/identity-lock.test.ts` (「別の承認があるまでテストだけが取り込む」の git grep) | 除外に `scripts/design-artifact/three-methods-steps.ts` を1つだけ足す。取り込む名前は `auditPageText` だけ (別の検査で固定する)。**Identity Lock を初めてテストの外につなぐ**ので、承認 A で名指しする |
| `tests/unit/design-agent/structure/structure.test.ts` (「自分のモジュールとテストの外からは取り込まない」の git grep) | 除外に `scripts/design-artifact/three-methods-steps.ts` を1つだけ足す。取り込む名前は `observeStructure`・`failedObservation` と参照の集合の読み込みだけ。今の唯一の例外 `phase2f-structure-observe.ts` と同じく、記録だけで門にしない。承認 A で名指しする |

## 3. 方式ごとの実行の手順

### 3.0 共通の前提

- **誰が起動するか:** 実の呼び出しは、オーナーが起動する。Claude は起動しない (研究 §7)。
- **どこで:** WSL の `sr-designgen` の利用者で、その checkout (`~/work/second-root`、origin/develop に detach) から。Codex は jail の中 (`sr-jail-*.service`、ChatGPT のサインイン、API キーなし) で動く (研究 §7、`docs/operations/design-image-poc.md`)。
  - 台帳は `sr-designgen` の `~/.local/state/sr-design-worker/phase2f-live/` にある。`readStep` を使うオフラインの手順 (`--prerender`・`--package`・`three-methods-steps.ts`) も、台帳を読むため同じ利用者で走らせる。
  - **`sr-designgen` で走る手順は、すべてオーナーが走らせる** (案)。`--prerender`・`--package`・`--lane` に加えて、台帳を `readStep` で読む `--direction` と `--check --image` も含む。`sr-designgen` で走れば、技術的には `answer.json` と `quarantine/` を読めるからである。Claude は、名指しした出力 (lane・`direction.json`・検めた画像と組み込んだ描画・検査の報告) の写しだけを受け取る (§2.1)。
  - 台帳を読まない `--page-request` と `--check` (`--image` なし) は、Claude が自分の作業場所で、自分のページの写しに対して走らせてよい。
  - **phase2f の CLI を `sr-designgen` で起動する手順書は、リポジトリに無い。** 画像の PoC には `admin.sh run sr-designgen` と run.lock の中で origin/develop に揃える手順がある (`design-image-poc.md`)。同じ形を使うかは、§10 の B で確かめる。
- **始める前 (毎回):**
  - 実機の resource preflight (`scripts/ops/wsl-resource-preflight.sh`、`docs/operations/wsl-resource-preflight.md`)。`STOP` なら始めない。
  - **本番の worker と画像の PoC が止まっていること** (前提)。worker を止める・戻す操作は、それ自体が別の承認の対象である (CLAUDE.md、`docs/operations/claude-autonomy.md` §3)。誰がどう止め、パイロットのあとどう戻すかを承認 B に含める。同時に別の design-agent の呼び出しを走らせない (`phase2f-live.md` §7: 各呼び出しは途中で切れた呼び出しの残りを消すので、同時の別の呼び出しの記録まで消えうる)。
  - Codex のサインイン・`.env` が無いこと・jail は、入口の preflight が承認を使う前に検める。
- **出力先:** リポジトリの外。例 `~/sr-three-methods/<plan_id>/<呼び出し>`。親 (`~/sr-three-methods/<plan_id>`) は事前に作る (`OUT_DIR_PARENT_MISSING` を避ける)。
- **盲検:** オーナーは、評価 (§6) の前に成果物の絵を見ない。Claude も途中の絵をオーナーに見せない。ただし画像の承認では、`prerender.md` の絵の説明 (alt) と位置をオーナーが読む。これは盲検を弱める (研究 §11 の「オーナーは実行計画を承認して起動に立ち会う」と同じ種類)。記録に残す。
- **develop を止めるか:** commit の pin は「HEAD = origin/develop」なので、パイロットの途中で develop が進むと、次の呼び出しの承認は新しい commit を名指しする必要がある (§10 の決めてほしいこと)。

### 3.1 全体の順番

commit の pin が変わる回数を減らすため、次の順で進める。C1 は配線の PR をマージしたあとの develop の commit である。

| 段 | 方式 | 何をするか | commit |
|---|---|---|---|
| 1 | VISUAL_FIRST | デザインの1回 | C1 |
| 1 | DIRECTION_FIRST | 方向の1回 | C1 |
| 2 | VISUAL_FIRST | pre-render (オフライン) → 画像の1回 | C1 |
| 2 | LAYOUT_FIRST・DIRECTION_FIRST | Claude がページを書く (オフライン)。画像を求めるなら、2つのページを1本の PR で研究のディレクトリに入れてマージ | C1 → C2 |
| 3 | LAYOUT_FIRST・DIRECTION_FIRST | ページの画像の1回ずつ (求めたときだけ) | C2 |
| 4 | 3方式 | Claude の実装・組み込み・検査・記録 (オフライン)。盲検の評価票 | — |

LAYOUT_FIRST のページは Codex の出力に拠らないので、段1 より前に書き始めてよい。

### 3.2 VISUAL_FIRST (`route_c_prototype`)

1. **Claude (オフライン):** pin を出す。
   `npx tsx scripts/design-artifact/phase2f-design.ts --print-pin --route C --facts design-library/research/three-methods/facts-pack.json --prompt-version tm0 --tm-brief design-library/research/three-methods/brief.json`
   期待: `b3d51744a75810b1bd6fe0531eb3e91843912add60e2babe194e163c7d11938f` / 4398。
2. **オーナーが承認する (C1-a):** plan_id・approval_id・SHA と文字数・commit C1 の組。
3. **オーナーが起動する:** 同じ入力に `--out <新しいフォルダー> --plan-id … --approval-id … --expected-prompt-sha256 … --expected-prompt-chars 4398 --expected-commit <C1> --human-approval-confirmed`。
4. **pre-render (オフライン、Codex なし、オーナーが走らせる):** `phase2f-steps.ts --prerender --route C --design <デザインの出力> --facts … --out <新しいフォルダー>`。`image-request-A1.json` と `prerender.md` (絵の説明の全文・SHA・位置・主役かどうか・この計画の回数と時間) ができる。
   - 試作に画像が1枚も無ければ、ここで `CODEX_NO_ASSET_ON_ROUTE_C` で止まる (既存の runner の規則。§7)。
   - **pre-render が止めるのは、安全検査と、仮の画像での描画の外部への要求だけである** (`runner.ts` の `preflightRoute`)。試作の横はみ出し (`PROTOTYPE_HORIZONTAL_OVERFLOW`) は、画像のあとの Artifact 化 (7.) で初めて分かる (`runner.ts` の package の描画)。はみ出す試作でも画像の1回を使いうることを、C1-c の承認のときにオーナーに伝える。
5. **オーナーが画像を承認する (C1-c):** `prerender.md` を見て、approval_id を決める。同じ plan_id。
6. **オーナーが起動する:** `phase2f-image.ts --route C --request <…/image-request-A1.json> --out … --plan-id <同じ> --approval-id … --expected-prompt-sha256 … --expected-prompt-chars … --expected-commit <C1> --human-approval-confirmed`。
7. **Artifact 化 (オフライン、オーナーが走らせる):** `phase2f-steps.ts --package --route C --facts … --prompt-version tm0 --tm-brief … --design … --image … --artifact-id … --shop-id fictional-bakery-komugi --shop-name 架空パン工房 こむぎ灯 --out … --result …`。prompt を組み直して記録の SHA と照らし (`RECORD_PROMPT_MISMATCH`)、intake まで行う。
   - 主役でない画像が失敗していれば、runner の規則で B へ切り替える (失敗を記録したまま)。主役の画像の失敗はオーナーへ止める。
8. **受け渡し (オフライン、オーナーが走らせる):** `three-methods-steps.ts --lane --package … --facts … --out <lane>`。lane には `artifact.json` と PC/SP の原本と素材だけが入る。Codex の試作の HTML/CSS は入らない。`render_pair_complete` でなければ lane は作られない。Claude には lane の写しだけを渡す (§2.1)。
9. **Claude (オフライン):** lane の原本を見て実装する (`index.html`・`style.css`・`assets/`)。スキルは `second-root-design-director` と `frontend-design`、B方式の制約と実装レーンの許可一覧。
10. **検査 (オフライン):** `three-methods-steps.ts --check --page <実装> --out …` (Claude の実装のはみ出し・SP・Identity・構造) と `impl-compare.ts --lane <lane> --impl <実装> --out <report.json>` (忠実度、記録だけ)。
    - 横はみ出しがあれば Claude が直す。上限は `LIMITS` (`implementationAttempts: 3`、`fixesPerCause: 2`、`lib/design-agent/loop/controller.ts`)。ほかの所見は直さず記録する。
11. **記録:** `three_method_run_v0`、`method: "VISUAL_FIRST"`、`condition: "route_c_prototype"`、`run_kind: "live"`。

### 3.3 LAYOUT_FIRST (`claude_layout`)

1. **Claude (オフライン):** 共通の入力 (事実パック・Identity Lock・ブリーフ) から、PC/SP の構図と実装を書く。画像を使うなら1枚まで、`<img src="assets/A1.png" alt="…">` か `data-asset` の印で書く (入口 §6)。各区画に `data-section`。
2. **検査と修正 (オフライン):** 仮の画像で `--check`。横はみ出しだけを `LIMITS` の中で直す。
3. **画像を使わないなら:** Codex の呼び出しは0回。6. へ。
4. **画像を使うなら:**
   - ページを研究のディレクトリ (例 `design-library/research/three-methods/pilot-1/layout-first/`) に入れる PR を作り、DIRECTION_FIRST のページと一緒にマージする (→ C2)。研究のデータだけの PR。
   - `three-methods-steps.ts --page-request --method LAYOUT_FIRST --page … --hero <hero の区画> --facts … --out …` で、測った位置つきの要求と `prerender.md` を作る。測れていなければ断る。
   - pin は `phase2f-image.ts --print-pin --page-request …` でも出す (要求を組み直して検める)。
   - **オーナーが承認する (C2-a)** → **起動する:** `phase2f-image.ts --route P --page-request … --page-root design-library/research/three-methods/pilot-1 --out … --plan-id … --approval-id … --expected-prompt-sha256 … --expected-prompt-chars … --expected-commit <C2> --human-approval-confirmed`。
5. **組み込み (オフライン):** `--check --page … --image <画像の出力>`。`readStep` で記録を検めてから、絵を `assets/` に入れて描く。
6. **記録:** `method: "LAYOUT_FIRST"`、`condition: "claude_layout"`。忠実度は「原本が無いので測らない」と記録する。

### 3.4 DIRECTION_FIRST (`direction_text`)

1. **Claude (オフライン):** pin を出す。`npx tsx scripts/design-artifact/phase2f-direction.ts --print-pin --facts design-library/research/three-methods/facts-pack.json --tm-brief design-library/research/three-methods/brief.json`。期待: `641d01f91d85bfd0005effd08b2ec9c0767a384878fd6f2accaeed730dc6d3ad` / 3353。答えの JSON Schema の SHA-256 は `e9050605…a555ef`。
2. **オーナーが承認する (C1-b)** → **起動する:** 同じ入力に実の呼び出しのフラグ一式。
3. **方向の受け渡し (オフライン):** `three-methods-steps.ts --direction --step <方向の出力> --facts … --out …`。`readStep` と `checkDirection` を通った方向 (concept・DNA の8観点・avoid) だけを Claude に渡す。
4. **Claude (オフライン):** 方向・事実パック・Identity Lock・ブリーフから、実装できる PC/SP の構図を設計して実装する。方向に無い事実を作らない。
5. 以降は LAYOUT_FIRST の 2.〜5. と同じ (画像は C2-b)。
6. **記録:** `method: "DIRECTION_FIRST"`、`condition: "direction_text"`。方向の文書と実装の対応を、評価のあとでオーナーが見られる形にする (研究 §3)。

## 4. Codex の呼び出しの数と利用枠

| | VISUAL_FIRST | LAYOUT_FIRST | DIRECTION_FIRST | 合計 |
|---|---|---|---|---|
| デザイン/方向 | 1 | 0 | 1 | 2 |
| 画像 | 0〜1 (§7 のとおり、Route C は事実上1) | 0〜1 | 0〜1 | 0〜3 |
| 最初の呼び出しの最大 | 2 | 1 | 2 | **5** |
| やり直しの最大 | 1 | 1 | 1 | **3** |
| 最大 | 3 | 2 | 3 | **8** |
| 最小 (画像なし・やり直しなし) | 1 (※) | 0 | 1 | 2 |

※ VISUAL_FIRST の Route C は、試作に画像が無いと pre-render で止まる (§7)。止まらずに進む最小は、デザイン1と画像1の2回。

- 研究 §6 の「パイロットは最大8回」と同じ。
- 1つの plan の上限は `LIVE_LIMITS` (最初4回・やり直し2回)。方式ごとに別の plan_id にする (研究 §6)。**方式ごとのやり直し1回は、台帳ではなく承認で守る** (台帳は2回まで通す)。オーナーが2回目のやり直しの承認を出さない。
- **費用:** Codex CLI は `sr-designgen` の ChatGPT のサインインで使う。API キーは使わず、API の課金は無い (`phase2f-b-v11-experiment-plan.md` §4、`design-image-poc.md`)。ChatGPT の利用枠を、最大8回分使う。**1回が利用枠をどれだけ使うか、円・ドルの単価は、リポジトリのどこにも記録が無い。** 呼び出しの数で比べる。
- **時間:**
  - 1回は15分で打ち切る (`LIVE_LIMITS.callTimeoutMs`)。見張りは20分 (`WATCHDOG_MS`)。1つの plan は2時間 (`planBudgetMs`)。
  - 記録にある実の値: **画像の PoC** (`design-image-poc.sh`、2026-10-23 の A-8) の1回は、画像の呼び出し 54.8秒、Codex 全体 97.9秒 (`.ai/progress.md`)。phase2f の Route C の画像の呼び出しの値ではない (その実行の記録は無い)。passt の更新の前は、最初の画像の呼び出しが約156秒で失敗していた (HUMAN-022)。デザインの1回の成功の所要時間は、記録 (`wagashi-b-noresearch-20261029-02.json`) で `started_at`・`finished_at` が `null` で、残っていない。
  - 見込み (研究 §6): Codex の呼び出しが 0.5〜2時間 (オーナーが立ち会う)、Claude の作業が 1.5〜3時間 (方式ごとに 30〜60分)。
  - 配線の PR の作成・テスト・独立レビュー・CI の時間は、この見込みに入っていない。

## 5. 呼び出しごとの pin・承認 ID・実行環境

pin は配線の前の今の値 (develop `7f32579`、`npx tsx scripts/research/three-methods-pins.ts --print-pin`、2026-11-01)。入力: `facts-pack.json` `e63d925a…97c0`、`brief.json` `efe91cf2…4b4c`。

| # | 方式 | 用途 | kind・route | 入口 | prompt の SHA-256 | 文字数 | 答え |
|---|---|---|---|---|---|---|---|
| C1-a | VISUAL_FIRST | デザイン | `design`・`C_hybrid` | `phase2f-design.ts --prompt-version tm0` | `b3d51744a75810b1bd6fe0531eb3e91843912add60e2babe194e163c7d11938f` | 4398 | `codex_design_v1` |
| C1-b | DIRECTION_FIRST | 方向 | `direction`・`direction_text` | `phase2f-direction.ts` | `641d01f91d85bfd0005effd08b2ec9c0767a384878fd6f2accaeed730dc6d3ad` | 3353 | `three_method_direction_v0` (schema `e9050605def92bb9556a25e7a2bc88657c41a3fb21b2d70ed1521a97bfa555ef`) |
| C1-c | VISUAL_FIRST | 画像 A1 | `image`・`C_hybrid` | `phase2f-image.ts --route C` | デザインの答えの alt から決まる。pre-render のあとに `prerender.md` で出る | — | PNG |
| C2-a | LAYOUT_FIRST | 画像 A1 (求めたとき) | `page_image`・`claude_page` | `phase2f-image.ts --route P` | Claude のページの alt から決まる。ページができたあとに出る | — | PNG |
| C2-b | DIRECTION_FIRST | 画像 A1 (求めたとき) | `page_image`・`claude_page` | 同上 | 同上 | — | PNG |
| R-* | 各方式 | やり直し (1回まで) | 元と同じ | 元と同じ + `--retry-of <元の approval_id>` | 元と同じ | 元と同じ | 元と同じ |

- **画像の pin は、今は計算できない。** 画像の prompt は、絵の説明 (alt) と事実パックだけで決まる (`buildAssetPrompt` と同じ文)。alt は、Codex の試作 (C1-c) か Claude のページ (C2-a/b) ができるまで無い。ページができたら `three-methods-pins.ts --print-pin --layout-page <html> --direction-page <html>` でも出せる。
- Route B の pin (`d8cc6c69…`/3846) は比較のために残すが、最初のパイロットでは使わない。
- **pin が変わるとき:** `facts-pack.json`・`brief.json` が変わったとき、レーンの prompt の文が変わったとき。配線は prompt の文を写さずにレーンから import するので、配線だけでは変わらない。`lane.test.ts` (入口 §10 の表と比べる) と、新しい `prompt-tm0.test.ts` (レーンとバイト単位で同じ) が、変われば落ちる。配線のあと、§9 で CLI の出す値がこの表と同じことを確かめる。
- **承認 ID と plan_id:**
  - 形: `APPROVAL_ID` = `^[a-z0-9][a-z0-9._-]{3,95}$`、`PLAN_ID` = `^[a-z0-9][a-z0-9._-]{3,63}$` (`ledger.ts`)。
  - 出すのはオーナーである (研究 §7)。Claude は案を書くだけ。これまでの例: plan `wagashi-b-v11-20261030`、approval `wagashi-b-v11-plain-20261030-01` (`phase2f-b-v11-experiment-plan.md` §3)。
  - 案: plan は `komugi-tm-vf-<日付>`・`komugi-tm-lf-<日付>`・`komugi-tm-df-<日付>`。approval は `komugi-tm-vf-design-<日付>-01`・`komugi-tm-vf-image-<日付>-01`・`komugi-tm-df-direction-<日付>-01`・`komugi-tm-lf-image-<日付>-01`・`komugi-tm-df-image-<日付>-01`。やり直しは `-02` と `--retry-of`。
  - 承認の組: approval_id・plan_id・expected prompt SHA と文字数・expected commit (研究 §7)。
- **実行環境:** WSL の `sr-designgen`、jail (`prepareCodexSandbox`、通信は `sr-jail-net.service` の pasta)、ChatGPT のサインイン (API キーなし)、台帳は `sr-designgen` の state。CLI の版とモデルは、jail の中の `codex --version` とセッションログから、呼び出しごとに `generation.json` に記録される (`runCodexJsonWithMeta`)。直近の記録は `0.159.0`・`gpt-6.1-sol` (2026-10-29)。今の版は、実行のときの記録で分かる。3方式で版かモデルが違えば、その差を記録する (`phase2f-b-v11-experiment-plan.md` §3 の 7.)。

## 6. PC1440 / SP390 の成果物と比べ方

### 6.1 方式ごとの成果物

| | VISUAL_FIRST | LAYOUT_FIRST | DIRECTION_FIRST |
|---|---|---|---|
| 盲検で見せる絵 | Claude の実装の PC1440・SP390 の全頁 PNG | Claude の実装の PC1440・SP390 の全頁 PNG | Claude の実装の PC1440・SP390 の全頁 PNG |
| 評価のあとに開くもの | Codex の試作の描画 (lane の原本)、impl-compare の報告 | — | 方向の文書 (concept・DNA・avoid) |
| ファイル | `index.html`・`style.css`・`assets/`、package (`artifact.json`)、lane | `index.html`・`style.css`・`assets/` | 同左 + `direction.json` |
| 呼び出しの記録 | 各出力の `call.json`・`generation.json`、台帳の receipt と result | 画像を求めたときだけ | 同左 |
| 研究の記録 | `three_method_run_v0` (`condition: "route_c_prototype"`) | 同 (`claude_layout`) | 同 (`direction_text`) |

- 描画は、Phase 2f と同じ (PC 1440 / SP 390、dsf 1、JavaScript なし、外部通信なし。研究 §4)。
- 成果物は、盲検の評価が済むまでリポジトリに入れない (LAYOUT_FIRST・DIRECTION_FIRST のページを画像のために先に入れる場合を除く。§10)。評価のあと、研究のディレクトリ (例 `design-library/research/three-methods/pilot-1/`) に記録と一緒に入れる。

### 6.2 比べ方

- **オーナーの盲検の評価が主である。** `design-library/research/three-methods/review-sheet.md` で、X/Y/Z (並び順は無作為) の5つの観点 (店舗らしさ・デザイン独創性・視覚的完成度・PC の出来・SP の出来) を 1〜5 で付け、「採れない印」を別に付ける。点を付けたあとで、方式名と記録を開く。X/Y/Z と方式の対応は、Claude が別のファイルに書き、オーナーが点を付け終えるまで開かない。
- **機械の検査は記録するだけである** (研究 §5)。順位付け・採否・合格には使わない。閾値はどれも仮のまま。
  - 横はみ出し (`scrollWidth`)、SP の所見 (`measureMobileQuality`)、Identity (`auditPageText`)、構造の観察 (`observeStructure`、成功例・不採用例との近さは参考だけ)、事実に無い文 (design-director の評価と同じ数え方、記録だけ)。
  - 忠実度 (`impl-compare`) は VISUAL_FIRST だけ。ほかの2つは「原本が無いので測らない」と記録する。
  - 報告の形は、統合検証 (`integration_check_report_v0`) の項目に合わせて `three_method_run_v0` の `checks` に書く。統合検証の報告そのものは live では作らない (§1.5)。
- **模擬と実画像を混ぜない。** DEV-142 の模擬 (`run_kind: "mock"`) の値は比べない。条件の違う記録 (`route_b_prototype` と `route_c_prototype` など) も混ぜない (研究 §5)。
- Route C の HTML 試作は、画像ツールの完成デザイン (V-A) と同じ条件ではない。その忠実度を V-A の値として報告しない (研究 §13、入口 §11)。

## 7. 失敗したときの停止と復旧

共通の規則:

- **自動のやり直しはしない。** やり直しは、方式ごとに1回まで、新しい承認 (`--retry-of`) で行う。
- やり直してよいのは、環境の失敗 (`network_or_transport`・`authentication` など) と、時間切れ・中止である。**出来が悪いことを理由にやり直さない** (`phase2f-b-v11-experiment-plan.md` §4 と同じ)。
- 承認を使う前に断られたもの (終了コード 2) は、何も使っていない。原因を直して、**同じ approval_id で**起動し直せる。
- 承認を使ったあとの失敗 (終了コード 1) は、その承認を二度と使わない。**利用枠も使ったものとして数える** (どれだけ使ったかは記録が無い)。
- 止まったら、記録 (`call.json`・台帳・`generation.json`) をそのまま残す。成功に書き換えない。

| 失敗 | 止まるもの | 残るもの | 復旧 |
|---|---|---|---|
| 承認を使う前の検査 (pin・commit・出力先・`.env`・jail・承認 ID・回数・時間) | その起動だけ | 何も使っていない | 原因を直す (checkout を C1 に揃える、作業ツリーを空にする、新しい出力先など)。同じ承認で起動し直す |
| `CODEX_EXEC_FAILED` (`diagnostic` の class つき) | その呼び出し | `call.json`、台帳の `failed` | class が環境の失敗なら、やり直しの承認 (1回)。原因が分からなければオーナーへ止める |
| 呼び出しの途中で落ちた・殺された (結果の無い receipt) | その呼び出し | 台帳に receipt だけ (結果なし)。後の工程は `RECORD_UNFINISHED` で使わない。plan の時間は約20.5分 (`UNFINISHED_CALL_MS`) と数える | 成功していないので、やり直しの承認 (`--retry-of`、1回) で作り直せる。やり直しの枠を使う |
| 予期しない例外 (`runMain` の `UNEXPECTED`、終了コード 1) | その起動 | 出力に `approval_used` が出ない | 台帳の `approvals/<approval_id>/` (`receipt.json`・`result.json`) があるかを見て、承認を使ったかを決める。無ければ使っていないので、原因を直して同じ承認で起動し直す。あれば上の行と同じ |
| 答えが拒まれた (`CODEX_ANSWER_REJECTED`) | その呼び出し | 台帳の `failed` | 環境の失敗ならやり直しの承認。原因が分からなければオーナーへ止める |
| サインイン・sandbox (`CODEX_NOT_SIGNED_IN`・`CODEX_SANDBOX_*`) | その起動か呼び出し | preflight で見つかれば何も使っていない。呼び出しの直前 (サインインの確認・bubblewrap の確認) で見つかれば承認を使った (`failed`) | `sr-designgen` で `codex login --device-auth`、または jail を直す。承認を使っていれば、やり直しの承認 |
| 時間切れ (15分、`CODEX_TIMEOUT`)・中止 (`CODEX_ABORTED`)・答えが JSON でない (`CODEX_NO_JSON`) | その呼び出し | 台帳の `failed`/`aborted` | やり直しの承認 (1回) |
| 利用上限 (`CODEX_QUOTA`) | その方式 | 台帳の `failed` | 利用枠が戻るまで待つ。やり直しの承認 |
| 画像の拒否 (画像ツールの `TOOL_FAILED_POLICY`、runner の `IMAGE_POLICY_REFUSAL`) | その方式 | 記録 | 自動で回避しない。オーナーへ止める |
| 方向の答えが schema に合わない (`DIRECTION_ANSWER_INVALID`・`DIRECTION_FACT_UNKNOWN`) | DIRECTION_FIRST | 台帳の `failed`、`answer.json` | やり直しの承認 (1回)。prompt は変えない |
| **デザインの答えが使えない** (答えの形の誤り、`PROTOTYPE_UNSAFE`、`CODEX_NO_ASSET_ON_ROUTE_C`、試作の横はみ出し `PROTOTYPE_HORIZONTAL_OVERFLOW` で incomplete) | VISUAL_FIRST | 台帳では `succeeded` (呼び出しは成功した) | **`--retry-of` は使えない** (成功した呼び出しのやり直しを台帳が断る、`RETRY_OF_SUCCEEDED`)。もう1回行うなら、新しい「最初の呼び出し」(同じ plan の first 枠) をオーナーが承認する。これを方式の「やり直し1回」と数えるかは §10 で決める。試作は修正しない (研究 §4)。横はみ出しは Artifact 化で初めて分かるので、それまでに画像の1回を使っていることがある (§3.2 の 4.) |
| Identity の REJECT / HOLD (Claude の実装) | その方式 | 検査の記録 | 修正せず、オーナーへ止める |
| Claude の実装の横はみ出し | — | 修正の記録 | Claude がオフラインで直す。`LIMITS` (3回・原因ごとに2回) を使い切ったら、その方式をオーナーへ止める |
| 主役の画像の失敗 (`IMAGE_ESSENTIAL_FAILED`) | その方式 | 記録 | オーナーへ止める。勝手に絵を外さない |
| 主役でない画像の失敗 | — | 失敗の記録 | VISUAL_FIRST は runner の規則で B へ切り替える (失敗を記録したまま)。Claude のページの扱いは決まっていない。案は、絵を外して記録すること (§10) |
| 測っていない画像の要求 (`ASSET_PLACEMENT_UNMEASURED`) | その起動 | 何も使っていない | `--page-request` で測り直す |
| 回数・時間を使い切った (`RUN_LIMIT_*`・`RUN_TIME_BUDGET`) | その plan | 記録 | 上限は上げない。オーナーへ止める |
| 実機の `Killed` (OOM) | すべて | — | `docs/operations/wsl-resource-preflight.md` §2 で OOM を確かめ、resource の失敗として止まる。修正のループに入らない。`.wslconfig` は変えない |

**CLI の版・モデルが呼び出しのあいだで変わったとき:** 自動では止まらない (`generation.json` に記録されるだけ)。案: 記録して、次の呼び出しの前にオーナーが続けるかを決める (§10)。v1.1 の比較では「違えば比較を無効と記録する」とした (`phase2f-b-v11-experiment-plan.md` §3)。

**配線の PR を戻すとき:** develop へ revert の PR を出す (オーナーの承認)。既存の入口は配線の前と同じに戻る。台帳に残った新しい kind の記録は、方式ごとの plan_id にしか属さないので、ほかの plan の上限に数えられない。既存の v1/v1.1/v2 の記録と台帳には触れない。

## 8. 最小の配線 PR の範囲

- **1本の PR** (`feature/dev-XXX-…` → `develop`)。中身は §1 の表だけ。
- **テストはオフラインだけ:** 偽の Codex port・偽の画像ツール・一時ディレクトリの台帳。実の呼び出しは0回。既存のテストを消さない・skip しない。
- **独立の Fresh Review と、最新の head の必須 CI。**
- prompt・承認の流れ・台帳・画像の入口を変えるので、Issue #177 の条件付きマージの対象外である (入口 §12)。マージはオーナーの承認 (§10 の A) を受けてから。
- 文書: 入口の §8 を「行った」に直し、この文書の手順の CLI を実際のフラグに合わせる。レーンのファイルの見出しの注記 (`brief.ts`・`visual-first.ts`・`direction.ts`・`page-assets.ts` の `not wired`・「レーンの CLI とテストのほかは取り込まない」) と、Identity Lock・構造の観察のテストの注記を、つないだ事実に合わせる。
- 依存 (`package.json`) は足さない。`.github/**` は変えない。

## 9. オフラインの検証の準備

承認の前に、オフラインで確かめられるもの。どれも Codex・画像・ネットワークを使わない。

**今 (配線の前) できること:**

- [x] レーンの pin を出す (`three-methods-pins.ts --print-pin`)。§5 の表の値と同じ (2026-11-01、develop `7f32579`)。
- [ ] ブリーフの文をオーナーが読んで、見た目の方向を含まないことを確かめる (入口 §12 の 3)。
- [x] Identity Lock が、事実の文に対して `auditPageText` で `PASS_IDENTITY_ONLY` になる (研究のテスト `three-methods.test.ts` で既に固定)。
- [ ] 模擬の通し (`three-methods-mock.test.ts`) と統合検証の模擬 (`integration-check.test.ts`) が通る。

**配線の PR の中で確かめること:**

- [ ] `phase2f-design.ts --print-pin --route C --prompt-version tm0 --tm-brief …` が `b3d51744…`/4398 を出す。
- [ ] `phase2f-direction.ts --print-pin --facts … --tm-brief …` が `641d01f9…`/3353 を出す。
- [ ] v1・v1.1・v2 の `--print-pin` が今と同じ値を出す。
- [ ] 偽の port で、3方式の通し (デザイン → pre-render → 画像 → package → lane、方向 → `--direction`、ページ → `--page-request` → 画像 → `--check --image`) が通る。
- [ ] 承認を使う前の停止 (pin・commit・出力先・台帳) がどれも何も使わない。
- [ ] 隔離のテスト (§2.3) が、正確なパスだけで通る。

**実行の前 (配線のマージのあと、毎回):**

- [ ] WSL の resource preflight が `OK` か `SERIAL`。
- [ ] `sr-designgen` の checkout が承認の commit に揃い、作業ツリーが空。
- [ ] 本番の worker と画像の PoC が止まっている。同時に別の呼び出しが無い。
- [ ] 出力先の親が実在し、出力先は新しい。
- [ ] `--print-pin` を、その commit でもう一度出し、承認の値と同じ。

## 10. 決めてほしいこと (承認の単位)

順に、それぞれ別の承認である。前のものの承認は、後のものの承認ではない。

1. **A: 最小の配線の PR を作り、マージすること。** §1 の7つの既存のファイルの変更と3つの新しいファイル、テスト、隔離のテストの正確なパス (5つのテスト、§2.3)。**この中に、Identity Lock (`auditPageText`) と構造の観察 (`observeStructure`) を、テストの外の1つのオフラインの CLI (`three-methods-steps.ts`) へつなぐことを含む。** どちらも記録だけで、門・閾値・停止条件は足さない (Identity の REJECT/HOLD で止まるのは研究 §4 の今の約束どおり)。PR の作成とオフラインのテストまでを先に承認し、マージは独立レビューと CI のあとに別に承認する形でもよい。
2. **B: 実行の環境と手順。** `sr-designgen` で phase2f の CLI をどう起動するか (画像の PoC と同じ `admin.sh run sr-designgen` と run.lock の形にするか)、出力をどこに置き、Claude の作業場所へどう渡すか (リポジトリに手順書が無い)。手順の上の分離 (§2.1): `sr-designgen` で走る手順 (pre-render・Artifact 化・lane づくり・`--direction`・`--check --image`) はすべてオーナーが走らせ、Claude には名指しした出力 (lane・`direction.json`・検めた画像と描画・報告) の写しだけを渡す。Claude は `sr-designgen` で何も走らせず、`answer.json` と `quarantine/` を開かない。本番の worker と画像の PoC を誰がどう止め、どう戻すか (worker の操作は別の承認)。パイロットの間、develop へのマージを止めるか。
3. **C1-a: VISUAL_FIRST のデザインの1回。** plan_id・approval_id・`b3d51744…`/4398・commit C1。
4. **C1-b: DIRECTION_FIRST の方向の1回。** plan_id・approval_id・`641d01f9…`/3353・commit C1。
5. **C1-c: VISUAL_FIRST の画像の1回。** `prerender.md` を見てから。
6. **D: LAYOUT_FIRST と DIRECTION_FIRST のページを、研究のディレクトリに入れる PR のマージ** (画像を求めるときだけ)。commit が C2 に変わる。オーナーは盲検を保つため、その PR の絵を開かない。
7. **C2-a・C2-b: ページの画像の1回ずつ** (求めたときだけ)。
8. **R: やり直し。** 1回ずつ、新しい承認で。方式ごとに1回まで。
9. **E (任意):** 評価のあとの成果物と記録のコミット、2回目のパイロット (研究 §6、最大16回まで)、作り直しやすさの測定 (研究 §5、8回の外)。

### あわせて決めてほしい点

- **VISUAL_FIRST の Route C で、試作に画像が無いとき。** 今の runner は Route C で画像の無い試作を `CODEX_NO_ASSET_ON_ROUTE_C` で止める。prompt は「1枚まで」なので、0枚の答えはありうる。そのデザインの1回は台帳では成功なので、`--retry-of` では作り直せない。
- **「成功したが使えない」デザインの作り直しを、方式の「やり直し1回」と数えるか** (実際は新しい first 枠の呼び出しになる。§7)。
- **ページの画像を最初のパイロットに含めるか。** 含めないなら、配線は image-call・phase2f-image・`--page-request` の分だけ小さくなるが、LAYOUT_FIRST と DIRECTION_FIRST は画像0枚に固定され、Codex が画像を選べる VISUAL_FIRST と予算が揃わない。この計画は含める案である。
- **ページを先にリポジトリに入れること (入口 §8 の 2)。** ページのバイト列を承認の commit に固定するための規則で、この計画はそのまま守る。そのため D のマージが要る。
- **主役でない画像が失敗したときの Claude のページの扱い** (外して記録する案)。
- **盲検で見せる VISUAL_FIRST の絵は、Claude の実装の描画にする** (Codex の試作の描画は評価のあとに開く) こと。
- **生成した画像 (C1-c・C2-a/b) に `auditIdentity` を目視の記録つきで当てるか。** 当てるなら、絵を見るのは Claude (`assistant_visual`) にし、オーナーは評価まで見ない案。
- **CLI の版・モデルが呼び出しのあいだで変わったときに続けるか** (案: 記録して、次の呼び出しの前にオーナーが決める)。

## 11. 記録が無いこと・分からないこと

- 1回の呼び出しが ChatGPT の利用枠をどれだけ使うか。円・ドルの単価。
- デザインの1回の成功にかかった時間 (過去の記録で `null`)。
- `sr-designgen` で phase2f の CLI を起動した手順 (過去の B 方式の実行は、承認 ID・CLI の版・モデルだけが記録にある)。
- 今の機械の Codex CLI の版 (直近の記録は `0.159.0`)。実行のときに `generation.json` で分かる。
- 3方式の結果の差が、方式の差か、その回のぶれかは、1回では分けられない (研究 §11)。
