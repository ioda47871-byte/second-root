# DEV-199b: 文章品質監査を生成・レビュー経路に接続する (Issue #258 の 2/3)

branch `feature/dev-199b-copy-gate-integration` (`origin/develop` 059b458d、DEV-199a / d / e / f の merge 後から)。

**Staging / Production には何も当てていない。フラグはどこでも有効にしていない (既定 OFF のまま)。migration は足していない。deploy・Vercel の env・実際の送信・画像生成・LLM の呼び出しもしていない。「輪」(SR-001) のデータ・オーナーの WSL / ローカル環境の設定には触れていない** (ローカルの統合テストは scratch に複製した別 project id `sr-dev199b` のスタックで行った)。

## 何を接続したか

### 1. comp-lane の門 (コピーが実際に作られる経路)

- `lib/design-agent/quality-pipeline/comp-copy-gate.ts` (新規、純粋): `compCopyGate` は既存の関数だけを呼ぶ。監査は作り直さない。
  - `copyReviewAppendBlockers(前の round の review, 今の review)` と `checkCopyQualityReview(今の review, ファイル, { previous: 前の round, photoUrls: 空 })` の**両方** (DEV-199a の引き継ぎ round 7)。改ざん・古い・手書きの review・鎖の崩れは `refused`。
  - 正直な fail (review が自分の失敗した改稿の段を名指すだけ) は `refused` ではなく `stop_fail` (`planCopyAppend` と同じ扱い)。
  - 次の段は `nextCopyStep`: `owner_review` (文章の判定 approve_candidate) だけがオーナーに見せられる。`revise` は次の round (上限 `MAX_COPY_REVISION_ROUNDS` = 2)、上限で `stop_hold` + `COPY_REVISION_CAP_REACHED`。`stop_hold` は hold の指摘を理由に出す。`stop_fail` は終端。
  - comp-lane にはオーナーの保存先が無いので、渡されたオーナーの記録は使わない (`ownerRevision: null`)。実店舗の owner_review の後の改稿はここでは受けない (閉じる側)。`sendable` は常に false、`sendBlockers` は `copyGateSendBlockers(…, null, …)` (少なくとも `OWNER_APPROVAL_MISSING`、架空の研究は `FICTIONAL_RESEARCH_NOT_SENDABLE`)。
  - `compShowOwnerCodes`: カンプの review の `show_owner` に、文章の門が owner_review でなければ `SHOW_WITHOUT_COPY_APPROVE_CANDIDATE` + `COPY_<段>` + `COPY_<理由>`。
- `scripts/design-artifact/comp-copy.ts` (新規): `--audit` (今のファイルを鎖の次の round として `reviewCopyQuality` で監査し `copy-review.json` を書く。同じ facts の別のファイルの監査は上書きしない: `COPY_REVIEW_EXISTS_FOR_OTHER_FILES`)・`--revise` (段が revise のときだけ、今のファイルと監査を `copy-rounds/<n>/` へ移す)・`--gate`。改稿は鎖の再監査 (`validateCopyRevision` を含む) を毎回通る。
- `scripts/design-artifact/comp-lane.ts`: `checkReviewFile(dir, renders, factsPath?)` が `show_owner` に文章の門を足すだけ。`--check-review` は `--facts` を取る (無ければ `SHOW_WITHOUT_COPY_REVIEW`・`COPY_FACTS_PACK_REQUIRED`)。描く経路は `--facts` をそのまま渡す。`comp-review.ts` は変えていない (forbidden_scope)。
- `docs/design/comp-lane.md` に「4. 文章の品質監査」。

**今コミットされているカンプへの効き目** (確認だけ、ファイルは変えていない): `show_owner` の過去のカンプは `--check-review` で落ちるようになる (`--facts` なしでは文章の監査が無い)。試しに一時ディレクトリへ写して監査すると、つぐ手 d1-v9 は `stop_fail` (`COPY_FACT_UNSUPPORTED`)、銭湯 d1-v6 は `revise` (`COPY_REPETITIVE_CADENCE`)、輪 (bicycle) d1-v6 は `revise` (`COPY_RHETORICAL_OVERUSE`・`COPY_REPETITIVE_CADENCE`: Issue #258 の指摘どおり)。既存のテストで `--check-review` するのは `revise` のつぐ手 d1 だけで、変わらず通る。

### 2. 管理画面 (版のデモの頁)

- `lib/sales/copy-review/store.ts`: `loadVersionCopyGate` の読み出しを `loadVersionCopyContext` に切り出した (読み出しの経路は 1 つのまま。失敗は今までどおり `demo_copy_review_unverifiable`)。
- `lib/sales/copy-review/gate.ts`: `copyDecisionRefusals(ctx, decision)` — DB の `sales_check_copy_decision_write` の規則 (版に結び付いた review・実店舗レーン・facts の経路の照合・owner_review・revise の上限・後の round なし・記録は 1 つ) と、承認には送信の門が見るもの (版の facts での照合 `COPY_FACTS_STALE`、`gate_blockers` と保存したバイトでの監査の再実行 `recheckStoredReview` → `COPY_SEND_BLOCKERS_REMAIN`)。
- `lib/sales/copy-review/view.ts` (新規、純粋): 版の文章の監査の表示 (round・レーン・文章の判定・次の段・指摘と監査の理由・revision_findings (改稿で変わったことのオーナー向けの注記)・`facts_from_facts_path`・`gate_blockers`・オーナーの記録・送信の門の本当の止まり (`evaluateVersionCopyGate`)・判断ごとの拒否)。
- `lib/admin/demo-copy-review.ts` (新規、server-only): `loadVersionCopyReview` (管理者本人のセッション、RLS) と `submitCopyDecision`: フラグ (`SALES_DEMO_QUALITY_REVIEW_ENABLED` + preview。OFF なら何も読まない) → 入力の形 → 版が prospect のデモのものか → 保存先を今読み直し、画面が見た review id と 5 つの hash が同じか (違えば `COPY_STALE_INPUT`) → `copyDecisionRefusals` → `sales_decide_copy_review` (管理者本人、DB がもう一度検める)。DB の拒否はオーナーの言葉で返す (生のメッセージは出さない)。
- `app/admin/sales/_actions/demo-versions.ts`: `decideCopyReview` (フラグ → `requireAdmin` → 上)。他の品質の書き込みと同じ順序。
- `components/admin/demo/CopyReviewPanel.tsx`・`CopyDecisionForm.tsx` (新規)・`page.tsx`: 選んだ版の文章の監査の区画。表示は preview のフラグ (頁と同じ)、判断の form は書き込みのフラグがあり、記録が無く、版が取り消されておらず、デモが無効でないときだけ。拒否される判断は理由つきで押せない。既定は何も選ばれていない。CSP: 既存の部品と同じ (inline の style 属性だけ、script なし)。
- `lib/admin/demo-versions.ts` (DEV-199e L2′): `buildDemoVersionsView` の `copySendBlock` を配線。送信の止まりが他の段をすべて通って copy の段に来たとき (未読なら `demo_copy_review_unverifiable`) だけ承認された版の文章の門を読み、本当の理由を出す。版の共有が無効の間 (DEV-196g まで) は `demo_not_shareable` で先に止まるので、この読み出しは起きない。本当の文章の止まりは文章の監査の区画 (送信の門) に常に出る。
  - Today のバッジ (`lib/admin/demo-version-badges.ts`) は「全店で 1 回の request」の約束があるので配線していない (共有が無効の間は copy の段に届かない。DEV-196g で決める)。

### 3. facts の経路 (前提)

**コードベースに facts の経路 (生成・改稿の側が書けない店舗の facts pack の保存先) は無い。** `trustedFactsPack` を渡す呼び出し元は app・lib・scripts に無い (テストの代役だけ)。だから作っていない (発明しない):

- 取り込みの結果はすべて `facts_from_facts_path = false` で送信不可。管理画面にもそう出る。
- オーナーの文章の確認は、サーバー (`COPY_FACTS_NOT_FROM_FACTS_PATH`) と DB (`copy_facts_not_from_facts_path`) の両方で拒否される。画面の form は 3 つの判断とも理由つきで押せない。
- `.ai/tasks.json` の DEV-199b の必須の前提 (送信の時点で保存済みの facts pack を今の facts の経路と比べ直す。`sales_copy_send_block` と `gate.ts` の両方) は**未着手のまま開いている**。facts の経路の新設はオーナー承認 (human_approval_triggers に追加)。

## 既存のテストの変更 (固定した一覧への追加だけ)

- `tests/unit/design-agent/quality-pipeline/copy-quality-review.test.ts`: isolation の呼び出し元の一覧に `lib/design-agent/quality-pipeline/comp-copy-gate.ts`・`scripts/design-artifact/comp-copy.ts` を追加 (DEV-199d / e と同じ扱い)。
- `tests/unit/design-agent/phase2f/isolation.test.ts`: comp-lane の import の一覧に `comp-copy-gate`・`./comp-copy` を追加し、2 つの新しいファイルの import を固定。
- `tests/unit/sales/demo-version/purity.test.ts`: demo-version を import する部品の一覧に `components/admin/demo/CopyDecisionForm.tsx` (server action の import)。
- `tests/unit/admin/flag-split.test.ts`: フラグ OFF の拒否の表に `decideCopyReview`。
- `.ai/tasks.json`: DEV-199e は PR #262 で develop に merge 済み (059b458d) なので `done` に (DEV-199b を review にする前提。`ai-tasks.test.ts` が依存の完了を要求)。

## テスト

- 新規 `tests/unit/design-agent/quality-pipeline/comp-copy-gate.test.ts` (10): approve_candidate → オーナー (架空は送信不可)、実店舗は owner の承認待ち、revise / hold / fail の分岐、欠落・schema・古い・偽造の review は refused、owner の記録を渡しても comp-lane では改稿不可、`--audit`→`--revise`→`--audit` の鎖と上限、上書きの拒否、前の round の改ざん、事実の洗浄の fail の後は改稿不可、hold は改稿不可、コミット済みの show_owner のカンプが止まる、revise のカンプは影響なし。
- 新規 `tests/unit/admin/demo-copy-review.test.tsx` (17): facts の経路なしで全判断拒否・送信の門の理由、照合ありで判断可、facts の照合が別の facts なら承認だけ拒否、架空・owner_review でない・後の round・記録済み・上限、保存したバイトの改ざんで承認拒否、submit (RPC だけ・5 つの hash に束縛・メモの正規化)、フラグ OFF で何も読まない、古い画面・別の店・形・メモ・読めない保存先、DB の拒否の文言、action (フラグ → admin の順、非 admin は拒否)、区画の markup。
- 新規 `tests/integration/demo-copy-decision.test.ts` (4、ローカルの Supabase): facts の経路なしで全判断がサーバーで拒否・記録なし / 代役の facts の経路で承認が管理者本人として 5 つの hash に束縛されて記録され 2 回目は拒否 / 古い画面と owner_review でない review の拒否 / 別の店・非 admin (読めない・書けない、DB も拒否)・フラグ OFF。
- 統合の全体 (ローカル、`sr-dev199b`): 31 ファイル・502 件 pass。
- unit: `tests/unit/admin`・`tests/unit/sales`・`tests/unit/demo-version-package`・`tests/unit/design-agent/**`・`ai-tasks` は pass。ブラウザを使う件はこのサンドボックスの playwright の版のブラウザが無いので、ある版 (`/opt/pw-browsers/chromium_headless_shell-1194`) を `PLAYWRIGHT_CHROMIUM_EXECUTABLE` で渡して流した (comp-lane の CLI のテストを含む)。全体の結果は下。
- `npm run typecheck`・`npm run lint`・`npm run check:secrets`: pass。

## 既知の限界

- comp-lane はファイルで動く: `copy-review.json` を消して直したファイルを round 0 として監査し直すことは、ファイルだけでは止められない。追記のみの鎖は取り込みの時に DB の保存先 (DEV-199e) が強制する。comp-lane の門は「オーナーに見せる前に通す」段。
- comp-lane のカンプは写真を持たない (`photoUrls` は空)。写真のある頁の監査は取り込み (DEV-199d / e) が manifest の写真で行う。
- 管理画面の判断は facts の経路ができるまで押せない (上記)。実際に押せる経路は統合テストの代役でだけ確認した。
- Today のバッジは copySendBlock を読まない (上記)。
- DEV-199c (4 業種以上の実例での過検出・見逃し) は未着手。
