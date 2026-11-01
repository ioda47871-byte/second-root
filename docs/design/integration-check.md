# 制作工程の統合検証 (DEV-147、Issue #177 E、MOCK のみ)

Issue #177 の E の段にあたる。A〜D の段 (DEV-139・DEV-140・DEV-144・DEV-146) が、1本のオフラインの流れとしてつながることを、
架空の店舗だけで確かめる。**offline・report-only・opt-in である。**実運用では何も有効にしない。

- テスト: `tests/unit/design-agent/integration-check/integration-check.test.ts`
- 報告をまとめる補助: 同じ場所の `integration-check.ts` (テストの補助。lib ではない)
- 隔離: 同じ場所の `isolation.test.ts`

lib のファイルは1つも足していないし、変えてもいない。既存の段を、テストの中でつないで呼ぶだけである。
新しい検査・閾値・停止条件・CLI は無い。

## 1. 何をつなぐか

架空の店舗は、3方式の研究 (Issue #180) の「架空パン工房 こむぎ灯」である。DEV-142 の MOCK の fixture
(`design-library/research/three-methods/mock/`) と補助 (`tests/unit/design-agent/research/three-methods-mock.ts`) を、
そのまま使う。3方式の模擬の通し実行そのものは、やり直さない。

1. **デザイン:** 研究の Route B の試作 fixture を、偽の `DesignPort` が返す。本物の Phase 2f の runner (`runPrototypeRoute`) が描き、
   `intakeArtifact` が `render_pair_complete` を出し、`prepareImplementationLane` が lane を作る。
   lane には `artifact.json` と PC/SP の原本だけが入り、試作の HTML/CSS は入らない。
2. **実装:** 試作と別に書いた Claude の実装 (研究の `visual-first/claude-impl`) と、テストの中で書いた、その変形。
3. **Identity:** 研究の Identity Lock を、PC 1440 と SP 390 の見える文字に当てる (`auditPageText`)。
   `PASS_IDENTITY_ONLY` 以外なら、**その場で流れを止める。**A〜D のどれも走らせない。
4. **A (DEV-139):** `compareImplementation` で、lane の原本と実装を比べる。
5. **B (DEV-134/140):** `renderPrototype` の `mobileQuality` (`measureMobileQuality`) で、実装の SP の所見を取る。
6. **C (DEV-138/144):** `observeStructure` で、実際の参照の集合 (`structure-descriptors-v0.json`) と比べる。助言だけである。
7. **D (DEV-146):** `runAutofixMock` を、実装の CSS に掛ける。port は本物を使う。
   - Identity: 上と同じ。
   - 描画と SP の検査: `renderPrototype`。
   - 位置: `LOCATE_SCRIPT`。
   - PC の変化: `compare/metrics` の `pixelDifference`。
   - 出せるのは、せいぜい `owner_review` の提案 (`applied: false`) までである。
8. **提案の再確認:** D が `owner_review` のときだけ、**提案の CSS をメモリの上で**、A と B にもう一度掛ける。
   前と後を両方とも記録する。提案はどこにも書かず、適用もしない。
9. **報告:** 1つの場面につき1つ、`integration_check_report_v0` にまとめる。

テストは、流れのあとで次を確かめる。

- 実装の HTML/CSS のバイト列、事実の値、lane の全ファイルのハッシュが変わっていない。
- D の port には、いつも元の HTML が渡っている。

## 2. 各段が報告に足すもの

| 段 | 足すもの | 足さないもの |
| --- | --- | --- |
| Identity | PC・SP の判定と、悪い方 | 品質の点数・承認 (`PASS_IDENTITY_ONLY` は「正しい店」というだけ) |
| A | `compared` / `partial` / `not_compared`、原因コード、幅ごとの原本の状態・箱の出所・実装の PNG のハッシュ・ページの数値 (SSIM など) | 合否 (`passing` はいつも `false`) |
| B | SP の所見・数・例 (コードと文の先頭40字)・`scrollWidth`・拒否した通信の数 | 停止・修正のきっかけ (所見は助言) |
| C | `observed` / `check_failed`、汎用 LP の印、成功例の写し・不採用例との近さ (参照の id)、`undecided` の数と、そのうち `undecided_too_thin` の数 | 順位・採否 (`undecided` は「近くない」ではない) |
| D | `no_change` / `owner_review` / `stopped`、停止のコード、出来事、試した修正 (原因・版・残したか・戻した理由・新しい所見・PC の変化・diff のハッシュ)、提案の CSS のハッシュと diff | 適用 (`applied: false`)・合格・デザインの承認 |
| 再確認 | A の原因コードとページの数値、B の所見・数・`scrollWidth` の、前と後と増減 | 提案の方が良いという判断 |

## 3. 報告の形 (`integration_check_report_v0`)

| 欄 | 中身 |
| --- | --- |
| `schema` / `run_kind` / `scope` / `advisory` | `integration_check_report_v0` / `mock` / `offline_report_only` / `true` |
| `passing` / `design_approved` / `applied` | いつも `false` |
| `case_id` | 場面の名前 |
| `shop` | shop_id、事実パックと Identity Lock の SHA-256 |
| `design` | artifact_id、`verification_state`、引き渡しの可否、lane の `artifact.json`・`lane.json` の SHA-256、デザインの呼び出しの数 (偽の port)、MOCK の注 |
| `implementation` | HTML・CSS の SHA-256 と注 |
| `identity` | `status` (悪い方)、`desktop_1440`、`mobile_390` |
| `phases.a_impl_compare` | §2 の A。走らなかったときは `{ status: "not_run", reason }` |
| `phases.b_mobile_quality` | §2 の B (同上) |
| `phases.c_structure` | §2 の C (同上) |
| `phases.d_autofix` | §2 の D (同上) |
| `phases.d_proposal_recheck` | §2 の再確認。提案が無ければ `not_run` と理由 |
| `stops` | `{ code, stage, reason }`。Identity の停止は `stage: "implementation"`、D の停止は `stage: "d_autofix"` |
| `notes` | MOCK であること、合否・採用でないこと、閾値を足していないこと、C は助言、D は提案だけ |

報告を作る関数 (`buildReport`) は、報告が言ってはならないことを断る。

- `run_kind` が `mock` 以外。`live` の報告は、まだ作れない (§5)。
- A が合格と言う。
- D が適用した・承認した・模擬でないと言う。
- `owner_review` の提案が無いのに再確認がある。
- Identity が止めたのに、どれかの段が走った。Identity の停止が `stops` に無い。

報告は、テストのあいだは一時ディレクトリの外に書かない。残すときは、空のディレクトリを `INTEGRATION_CHECK_OUT` に渡す。
場面ごとに `<case_id>.json` を新しく書く (`wx`、上書きしない)。

## 4. 場面と結果 (MOCK、この container での1回の値)

数値は描画の環境 (書体など) で変わりうる。テストでは、環境で揺れにくいもの (状態・所見・修正の経過・PC が変わらないこと) だけを固定し、
SSIM などの数値と A の原因コードの細かい中身は固定していない。

| 場面 | Identity | A (原因コード、SSIM PC / SP) | B (SP の所見) | C | D | 再確認 (提案の CSS) |
| --- | --- | --- | --- | --- | --- | --- |
| (a) きれいな実装 (研究の実装そのまま) | PASS | compared。`PC_PAGE_LAYOUT`・`PC_SECTION_COLOUR_STORY`・`SP_PAGE_LAYOUT` (0.78 / 0.759) | なし | 印・近さなし。undecided PC 30・SP 35 (うち too_thin 24) | `no_change` | なし |
| (b) 電話番号を小さなリンクにした (高さ 15px) | PASS | compared。上に `SP_SECTION_COLOUR_INFO` が加わる (0.771 / 0.649) | `SP_TAP_TARGET_TOO_SMALL` | (a) と同じ | TAP_TARGET v1 を残す (PC の変化 0) → `owner_review` | B: 所見なし。A: `SP_PAGE_LAYOUT` が消える。SP の SSIM 0.649 → 0.887、PC は同じ |
| (c) フッターに別の店の名前 | **REJECT** (PC・SP) | 走らない | 走らない | 走らない | 走らない | なし。`stops` に `IDENTITY_REJECT` |
| (d) 情報の行を 720px にし、`overflow: hidden` で値を 400px にした | PASS | compared。SP に `SP_SECTION_POSITION_INFO`・`COLOUR_INFO`・`SIZE_INFO` (0.78 / 0.468) | `SP_TEXT_OFFSCREEN` (SP の scrollWidth 740) | (a) と同じ | HORIZONTAL_OVERFLOW v1 (`max-width`) は、営業時間・所在地・アクセスを切るので `NEW_FINDING` で戻す。v2 (折り返し) を残す → `owner_review` | B: 所見なし、scrollWidth 390。A: SP の INFO の3つが消える。SP の SSIM 0.468 → 0.759、PC は同じ |
| (e) 小さなリンクを `!important` で固めた | PASS | compared (0.771 / 0.673) | `SP_TAP_TARGET_TOO_SMALL` | (a) と同じ | v1・v2 とも `NOT_RESOLVED` で戻す → `stopped` (`SAME_CAUSE_FIX_LIMIT`)、元の CSS のまま | なし。`stops` に `SAME_CAUSE_FIX_LIMIT` |
| (f) Hero に印の無い大きな飾りの文字 (DEV-140 の `deco_type_not_marked` と同じ作り) | PASS | compared (0.774 / 0.747) | `SP_TEXT_CLIPPED`・`SP_TEXT_OFFSCREEN` (既知の誤検知) | (a) と同じ | `skip:TEXT_CLIPPED:not_located` → `no_change` | なし |

(c) では、D も単独で同じ判定をする。流れの外で同じページを D に渡しても、最初の Identity で `IDENTITY_REJECT` になり、
描画も修正もしない (port が呼ばれたのは Identity の1回だけ)。

(b) と (d) の再確認では、提案のあと A の差が減り、SP の SSIM が上がった。**これは、模擬の実装と模擬の試作の差が変わったというだけである。**
忠実度が上がった証拠にも、提案を採る理由にもしない。(b) の SP の SSIM は、元の実装 (a) より高くなった。
SSIM はページ全体の画素の近さで、どこが近づいたかは言わない。オーナーが画像で見る。

## 5. 模擬と実際

- この報告は、すべて `run_kind: "mock"` である。デザインは手で書いた fixture を偽の port が返したもの、実装も手で書いた fixture である。
  Codex・画像生成・ネットワーク・有料 API・WSL は使っていない。
- `run_kind: "live"` の報告は作らない (`buildReport` が断る)。実際の Codex のデザインと Claude の実装でこの流れを走らせるには、
  次の二つが別に要る。
  - 3方式の研究 §7 の、呼び出しごとの承認
  - この流れを runner・worker・修正ループのどこかで使うことの、オーナーの承認
- 模擬と実際の報告は混ぜない。実際の報告ができたら、`run_kind` で分けて置く。

## 6. これが示さないこと

- **品質。**どの場面の数値も、デザインや実装の良し悪しを示さない。A の閾値は DEV-131 の仮の値、C の語彙と閾値も仮 (Issue #159) である。
- **採用。**報告に合否は無い。`passing`・`design_approved`・`applied` は、いつも `false` である。どの段の所見も、止めたり直したりする門ではない。
- **自動修正の実運用での信頼性。**D の提案が残ったのは、架空の小さなページでのことである。実運用で使う前の信頼性の門 (`limited-autofix.md` §6) は、そのまま残る。
- **3方式の優劣。**同じ1つの方式 (Route B の試作 → 実装) の上で、段のつながりを確かめただけである。

## 7. 限界

- **仮の閾値。**A (DEV-131) と C (`descriptor.ts`) の閾値は仮のまま。新しい閾値は足していない。
- **DEV-140 の誤検知。**B の SP の検査には、既知の誤検知が2件ある (`deco_type_not_marked`・`drawer_translated`)。(f) のように、報告には所見として残る。
  D は位置を出さないので直さないが、所見が消えるわけではない。読む人が、既知の誤検知だと分かるようにする必要がある (報告は区別しない)。
- **自動修正の見えないところ。**D の回帰の確認は、SP の検査の `examples` (文の先頭40字) に頼る。本当の入れ替わりは見分けられない。
  - 入れ替わりとは、ある要素の所見が消え、同時に、先頭40字が同じ別の要素が同じコードで新しく問題になる場合である。
  - 提案は `max-width: 480px` の中に置くので、描画も検査もしていない 391〜480px の幅にも掛かる。
  - 再確認は 1440 と 390 の2つの幅だけで、この見えないところは埋めない (`limited-autofix.md` §7)。
- **C の検出力。**今の参照データでは、多くの参照が `undecided` になる (この店では PC 30・SP 35、そのうち参照の記録が薄い too_thin が 24)。
  写しの検出力は低い (`phase2f-structure-observation.md`)。
- **小さな場面。**架空の店1つ、手で書いた変形5つである。セクションの多い実際のページ、詳細度の高い CSS、画像のあるページでは試していない。
- **A の差は模擬どうしの差。**A の原因コード (a の `PC_PAGE_LAYOUT` など) は、手で書いた実装と手で書いた試作の差であり、Claude の実装の忠実度を示さない (研究の §12 と同じ)。

## 8. 3方式の研究 (Issue #180) とのつなぎ方 (作らない)

3方式の研究の実行は、まだ承認されていない。ここでは何も作らず、あとで同じ報告につなぐ道筋だけを書く。

- **同じ報告の形を使う。**研究の1回の実行 (`three_method_run_v0`) ごとに、`integration_check_report_v0` を1つ作れる。研究の記録からは、報告のパスとハッシュで指す。
- **方式と条件で分ける。**報告に `method` と、研究 §13 の `condition` を足す。どちらも別の変更である。
  - `method`: `VISUAL_FIRST` / `LAYOUT_FIRST` / `DIRECTION_FIRST`
  - `condition`: `route_c_prototype`・`image_tool_design`・`claude_layout`・`direction_text`・`direction_image`
- **原本の無い方式。**LAYOUT_FIRST と DIRECTION_FIRST には、その幅の原本が無い。A は、`not_run` と理由を書く。研究の記録の `not_applicable` と同じ扱いである。
  画像生成方式 (`image_tool_design`) の原本は concept image なので、A は比べない (DEV-139 の `not_a_render`)。オーナーの目視を主にする。
- **修正のきっかけは研究のまま。**研究の暫定方針では、修正のきっかけは Claude の実装の横はみ出しだけである (§10)。
  D の提案は記録として足せるが、研究の実行では適用しない。研究の条件 (予算・回数・盲検) も変えない。
- 実際の実行の報告は `run_kind: "live"` になる。§5 の承認が先に要る。

## 9. 範囲と隔離 (Issue #177 の条件)

- 変えていないもの: prompt、承認の流れ、Identity Lock、停止条件、モデルや画像の実行、worker/bridge/jail/timer、Production/Staging、CI、`.github/workflows/**`、既存の閾値、研究データの意味。
- lib の既存ファイルは変えていない。lib のファイルも足していない。
- 補助 (`integration-check.ts`) が読み込むのは、`node:crypto` と既存の段の型だけ。lib・app・components・scripts のどこからも import されない (`isolation.test.ts`)。
- 既存の隔離テストのうち2つに、新しいテストのファイルを正確なパスで足した。足したのは、取り込んでよい例外である。
  - Identity Lock の隔離 (`identity-lock.test.ts`): この統合検証のテストが Lock を使う。
  - 構造モジュールの隔離 (`structure.test.ts`): この統合検証のテストが観察を使う。
- Chromium は、既存のテストと同じく playwright で起動する (`PLAYWRIGHT_CHROMIUM_EXECUTABLE` があればそれを使う)。
