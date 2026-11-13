# DEV-263a — 架空・写真なしの送信用デモを v2 の包み + ローカルの facts の経路で通す (Issue #263 の 1)

Base: develop (059b458d) + PR #264 (DEV-199b) の branch を merge commit で取り込んだ上。migration なし。フラグは触っていない。

## 何をしたか

### 1. `package-local.ts --copy <カンプ> --facts <facts pack>` (v2 の包み)

- 頁はカンプの `index.html` / `style.css`。文章は facts pack・`copy.json`・`copy-review.json` (`scripts/design-artifact/comp-copy.ts --audit` が書いたもの)・`copy-rounds/<i>/` の前の round を、そのまま既存の `buildPackage` の `copy` に渡す (`lib/demo-version-package/local-inputs.ts` の `compCopyInput`、読むだけ)。監査はここでやり直さない: `buildPackage` が `verifyPackageCopy` でもう一度検め、通らないものは作らない。
- `--copy` は `--facts` が必須で、`--source` / `--page` とは併用できない (使い方の誤り、exit 2)。文章の記録・監査・facts pack が無い、前の round が欠けている → `FAIL` (exit 1、描く前)。
- `--copy` なしは従来どおり (v1)。

### 2. `import-local.ts --trusted-facts <コミット済みの facts pack>` (ローカルの facts の経路)

- `readCommittedFacts`: リポジトリの中・シンボリックリンクでない・HEAD のバイトと同じ (`git cat-file blob HEAD:<path>`)。外 (`TRUSTED_FACTS_OUTSIDE_REPO`)・未追跡や stage だけ (`TRUSTED_FACTS_NOT_COMMITTED`)・編集済み (`TRUSTED_FACTS_MODIFIED`)・リンク (`TRUSTED_FACTS_SYMLINK`) は、どの request よりも前に拒否。
- 取り込みの前に、対象のデモの `sales_demos.content` が**同じバイト**から導いた内容 (`demoContentFromFacts`: 輪 の seed が使ってきた導き方を一般化したもの。`rinDemoContent` はこれを呼ぶだけで出力は不変) と、正規化した JSON (キーの順序を無視) で一致しなければ `TRUSTED_FACTS_CONTENT_MISMATCH`。デモの行と facts の証拠の出どころが 1 つであることの確認。
- 通ったバイトを `importPackage` の `trustedFactsPack` に渡す (既存の照合: 包みの facts pack と同じバイトでなければ `COPY_FACTS_NOT_FROM_FACTS_PATH`)。
- `--seed-sendable` (下の 4) は `--trusted-facts` なしでは取り込めない (`--seed-only` は別)。`--seed-rin` とは併用できない (輪 の写真の包みは `ai_demo_internal`)。

**これはローカルの facts の経路だけ**。次の 2 つはオーナー承認の未着手のまま開いている (`human_approval_triggers`):

- hosted の facts の保存先 (登録の時に書く、追記のみの表)。
- 送信の時点で保存済みの review の facts pack を facts の経路のものと比べ直すこと (DEV-199b の必須の前提、`sales_copy_send_block` と `lib/sales/copy-review/gate.ts` の両方)。

### 3. fixture: 架空の店 環 (`design-library/research/quality-pipeline/poc/sendable-tamaki/`)

- `facts-pack.json`: `fictional-bicycle-repair-tamaki`、名前「架空自転車修理 環」、所在地「架空市架空区架空町二丁目3-5」、電話 `000-0000-0263`、説明の冒頭「動作確認用の架空の自転車修理店です。実在の店ではありません。」。項目は 輪 と同じ鍵 (同じ導き方でデモの内容になる)。
- `page/`: 輪 の写真なしの頁 `fidelity/d1-v9` の写し。**輪 のファイルは 1 バイトも変えていない** (`git diff origin/develop -- design-library/research/quality-pipeline/poc/bicycle` は空)。変えたのは:
  - 店の事実 (名前・電話・時間・定休・所在地・道順・架空の注記) を新しい facts pack の値に。
  - 見出し 5 つを、場面の内容を言う平らな見出しに (事実を作らない、facts の語だけ): 「修理のご案内」「振れ取り」「修理の流れ」「空気の入れ方の講座」「店舗情報」。元の 「スポークの先に、修理がある。」「一本ずつ。」「どこを直すか、先に決める。」「空気を入れる日。」「一周して、店先へ。」 が `COPY_RHETORICAL_OVERUSE`・`COPY_REPETITIVE_CADENCE` (terminal_period / comma_split / particle_fragment) の元だった。Hero の 1 行 「まがった車輪も、まっすぐに。」 は監査の規則どおり残した (Hero は 1 行の強い言葉を持てる)。「修理のメニュー」 は 「メニュー」 が copy-record の事実らしさの印 (money_or_menu) に当たるので使わない。
  - **`<wbr>` と `<br>` を外し、`word-break: keep-all` を `word-break: auto-phrase` に** (CSS の 1 宣言)。サーバーの抽出 (`checkArtifactHtml().texts`) は `<wbr>` / `<br>` で文を切るので、輪 の d1-v9 そのままでは v2 の包みのサーバーの文章の検査 (`UNVERIFIED_COPY`・`JOINED_TEXT_LOOKS_LIKE_FACT`) に落ちる (DEV-196r の v1 は文章を検めなかったので表に出なかった)。`auto-phrase` は Chromium の文節単位の改行で、`<wbr>` の手置きと同じ目的。サーバーの検査は変えていない。
  - CSS の先頭に、写しであることの注記 1 行。
- `page/copy.json` (`real_shop_proposal`) と `page/copy-review.json` (`comp-copy.ts --audit` で作った round 0)。

**監査の結果**

| レーン | verdict | 文章の判定 | 段 | 指摘 |
| --- | --- | --- | --- | --- |
| `real_shop_proposal` (コミットした `copy-review.json`) | hold | approve_candidate | owner_review | `COPY_APPROVAL_MISSING` だけ |
| `quality_research_fictional` (同じ頁・同じ文、レーンと claim_type だけ変えた一時の写し) | approve_candidate | approve_candidate | owner_review | なし |

- `proposal_pending_review` は 13 項目: Hero の 1 行、平らな見出し 5 つ、飾りの語 2 つ (「まわる」「締める」、`aria-hidden` の大きな文字、元の頁の構図の一部)、写真の枠の説明 5 つ (「写真｜パンクを直す手元」 など。写真なしの頁で、店の写真が入る場所を示す)。どれも事実を主張しない (copy-record の事実らしさの印に当たらない)。実店舗の頁では店の言葉ではないので、オーナーの確認を通るまで送らない (`COPY_APPROVAL_MISSING`)。主張を事実に付け替えてレーンを通したものは無い: 事実の項目は facts の値そのまま、それ以外は全部 `proposal_pending_review`。
- 頁の検査: `comp-lane.ts --dir … --facts …` で PC 1440 (5260px) と SP 390 (5633px) の全頁が `status: OK`・findings 0。目でも見た (見出しの重なり・はみ出しなし)。
- `package-local.ts --copy` で v2 の包みになる (`format: sales_demo_version_package_v2`、写真なし)。

### 4. seed: 送信可能な架空の prospect (`lib/demo-version-package/seed-sendable.ts`)

- 固定の id `5e2d0a63-7c1b-4f0e-9a6d-263a00000001`。連絡先は予約済みのドメイン `info@tamaki-demo.example.com` (RFC 2606、誰にも届かない) とその一次の出典 (`sales_sources`、official_contact)、推奨チャネル email。登録の列はスキーマの仮の値 (category `bakery`、template `bakery_v1`、名古屋の仮の住所 `SENDABLE_REGISTRY_ADDRESS`。輪 と同じ扱い)。店の事実は `sales_demos.content` (facts pack から導いたもの)。
- 1 つのトランザクション (メールの出典の検査は commit の時)。冪等: 既にあれば同じ店か (名前・住所・メール・Instagram なし・内容) を確かめ、違えば `SENDABLE_SEED_ID_TAKEN` / `SENDABLE_SEED_CONTENT_STALE`。outreach は作らない (送らない)。
- `import-local.ts --seed-sendable --seed-only` / `--package <包み> --seed-sendable --trusted-facts design-library/research/quality-pipeline/poc/sendable-tamaki/facts-pack.json`。後の E2E がこれを使う。

### 5. PR #264 の review の Low

- `docs/design/comp-lane.md` §4: 文章の門より前に `show_owner` になったコミット済みのカンプは `--check-review` で落ちる (意図どおり、ファイルは変えない) の 1 文。
- `comp-lane.ts checkReviewFile`: `CompCopyError` (前の round の欠け) を捕まえて `SHOW_WITHOUT_COPY_APPROVE_CANDIDATE`・`COPY_REVIEW_REFUSED`・`COPY_ROUNDS_MALFORMED` に (入力の誤りで落ちない)。
- `comp-copy-gate.ts`: 正直な fail の免除は、追記の blockers が空で、前の round がそれぞれ自分のファイルで `checkCopyQualityReview` を通るときだけ。
- メモの上限: DB (`sales_demo_note_valid`、500 文字) に合わせて `NOTE_MAX_CHARS = 500` を `review-client.ts` に置き、`normaliseNote`・`CopyDecisionInput` (zod は 2000 だった → 前後の空白を除いた文字数で 500)・form の `maxLength` と表示が同じ値を使う。

## 既存のテストの変更 (固定した一覧への追加だけ)

- `tests/unit/design-agent/phase2f/isolation.test.ts`: `package-local.ts` の import の一覧に `../../../lib/demo-version-package/local-inputs` (カンプの頁と文章を読むだけ)。
- 既存のテストの期待値は変えていない。`comp-copy-gate.test.ts`・`demo-copy-review.test.tsx` には新しい `describe` を足しただけ。

## テスト

- 新規 `tests/unit/demo-version-package/sendable-demo.test.ts` (13): fixture が架空・輪 でない・画像も `<wbr>` も無い / real_shop_proposal の監査がコミットどおりで owner_review / 架空レーンで approve_candidate / 導き方が 輪 と同じ / v2 の包みと facts の経路あり・なしの送信の止まり / 前の round を運ぶ (revise → 改稿 → owner_review の鎖) / `compCopyInput` の拒否 / `package-local` の CLI (使い方・監査なし) / `readCommittedFacts` (一時の git: 未追跡・stage だけ・編集・外・`..`・リンク・無い) / fixture の facts pack がコミット済み / 内容の一致 (キーの順序・違う時間・余分な鍵・輪 の facts・壊れた JSON) / `import-local` の CLI (外の facts は request の前に拒否、`--seed-sendable` は facts の経路なしで使い方の誤り) / 代役の client での取り込み (`facts_from_facts_path: true`、`send_blockers: ["OWNER_APPROVAL_MISSING"]`、`sales_record_copy_review` に `p_facts_from_facts_path: true`)。
- 新規 `tests/integration/demo-sendable-seed.test.ts` (3、ローカルの Supabase): seed の冪等と連絡先・outreach なし / facts の経路で取り込み → 保存された review が facts の経路から・`gate_blockers` は `OWNER_APPROVAL_MISSING` だけ・`sales_copy_send_block` は `demo_copy_owner_confirmation_missing` / 内容が違うデモは拒否、seed も `SENDABLE_SEED_CONTENT_STALE`。
- `comp-copy-gate.test.ts` に 2 件 (COPY_ROUNDS_MALFORMED、正直な fail の免除の条件)、`demo-copy-review.test.tsx` に 1 件 (メモの上限)。
- 実際の CLI を一時のローカルの stack (`sr-dev263a`、scratch の設定、ポート 595xx) で通した: `--seed-sendable --seed-only` → `--package … --seed-sendable --trusted-facts …` で版が作られ、copy は checked・approve_candidate・`facts_from_facts_path: true`、`sales_copy_send_block` = `demo_copy_owner_confirmation_missing`、2 回目は replay。内容を変えると `TRUSTED_FACTS_CONTENT_MISMATCH`。
- 統合: `demo-sendable-seed`・`demo-copy-decision`・`demo-copy-send-guard` (26 件) pass。unit の結果と tsc・eslint・check:secrets は PR に記す。

## 既知の限界・開いている項目

- facts の経路はローカルのもの (コミット済みの facts pack) だけ。hosted の facts の保存先と送信時の比べ直しはオーナー承認待ち (上)。
- 管理画面のオーナーの文章の確認・品質の承認・公開の共有 URL・送信の全体の E2E は後の PR。
- 輪 の d1-v9 (と `<wbr>` を使う研究の頁) は、そのままでは v2 の包みのサーバーの文章の検査を通らない。サーバーの抽出を `<wbr>` で切らないようにするかは別の判断 (ここでは検査を変えず、fixture 側で `<wbr>` を外した)。

## Fresh Review (PR #266 @ 1ac51b5: C0 H0 M1 L5) への対応

- **M1 (内容の照合が facts pack 全体を縛らない / committed がローカルの HEAD だけ)**:
  - (a) seed は `sales_demos.content.facts_pack_sha256` に facts pack のバイトの sha256 を書く (`sendableSeedContent` = `demoContentWithFactsSha`)。`assertDemoContentFromFacts` は、trusted のバイトがその sha256 になることを先に要求し (`TRUSTED_FACTS_SHA_MISMATCH`)、そのうえで導いた内容 + sha と正規化した JSON で一致を見る。導き方 (`demoContentFromFactsBytes`) は、写していない鍵 (`TRUSTED_FACTS_UNMAPPED_KEY`) と同じ鍵の重複 (`TRUSTED_FACTS_DUPLICATE_KEY`) を拒否する。余分な欄は FactsPack の strictObject が拒否する。F17「創業50年」を足した pack は、鍵が写されない (`history`) なら導出で、写される (`statement_3`) なら sha で落ちる (テスト)。**輪 の経路は不変**: `rinDemoContent`・`seedRinShop` は変えていない (sha は 環 の seed だけ。輪 を seed し直す必要はない)。
  - (b) `readCommittedFacts` は、HEAD のバイトと作業ファイルの一致に加えて、`git rev-parse origin/develop:<rel>` の blob id が HEAD のものと同じことを要求する (fetch しない。無い・違う → `TRUSTED_FACTS_NOT_ON_DEVELOP`)。HEAD だけにある pack・ローカルの commit で変えた pack・origin/develop の無い repo は拒否 (一時の git のテスト)。seed は HEAD に commit 済みであれば読める (`requireBase: false`、取り込みの trusted は常に develop を要求)。
  - 結果として、この PR が develop に入るまで `--trusted-facts` で 環 を取り込むことはできない (ローカルで `TRUSTED_FACTS_NOT_ON_DEVELOP` を確認)。統合テストと代役の取り込みのテストは、コミット済みのバイトを直接使う (facts の経路の判定自体は一時の git で unit テスト)。
- **L1**: 対象のデモの `content.facts_pack` が `RIN_SHOP_ID` なら `TRUSTED_FACTS_RIN_DEMO` (sha の照合より先)。テスト。
- **L2**: 送信の門 `lib/sales/test-recipient.ts` (`testRecipientBlock`): デモの `content.facts_pack` が `^fictional-`、またはメールの宛先のドメインが予約済み (example.com / .net / .org とその下、`*.example`・`*.test`・`*.invalid`・`*.localhost`) なら、`approveSend` と `markFollowUpSent` は RPC の前に拒否する。`SALES_LOCAL_E2E_TEST_RECIPIENTS` がちょうど `"true"` のときだけ通す (既定 OFF)。ローカルの E2E は `playwright.config.ts` の webServer の env でこれを立てる (既存の e2e は example.com の宛先を承認するため。デプロイ先には設定しない)。`loadInitial` の select に `facts_pack:content->>facts_pack` を足した。**DB の guard は migration が要るので入れていない (サーバーの門だけ)**: DB 側 (`sales_approve_outreach`) の同等の拒否は、migration の承認とともに別の Task。テスト (`tests/unit/sales/test-recipient.test.ts`): 純粋な判定と、action が flag なしで拒否し RPC を呼ばない / flag ありで従来どおり承認。
- **L3**: `lib/demo-version-package/import.ts` の冒頭の注記 (「import-local.ts は渡さない」) を、`--trusted-facts` のときだけ渡す、に直した。
- **L4**: 環 は、送信の経路の試験のために、輪 の架空の事実の文 (statement / service / workshop) と頁の構成を**意図して**使い回している (架空の店どうし。実在の店の情報は含まない)。
- **L5**: `CopyDecisionInput.note` は、前後の空白を除いた文字数の refine の前に、生の `.max(NOTE_MAX_CHARS * 4)` を置いた。

再実行: 関係する unit (demo-version-package・sales・admin・phase2f isolation・comp-copy-gate・comp-lane・ai-tasks: 66 ファイル 1498 件) pass、統合 `demo-sendable-seed` (3) を scratch のローカルの stack で pass、tsc・eslint・check:secrets pass。e2e は CI (playwright.config.ts の env の追加を含む)。
