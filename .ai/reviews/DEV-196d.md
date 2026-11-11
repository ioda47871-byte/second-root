# DEV-196d: 店舗デモの版の管理者プレビューと品質承認の画面

オーナー承認 2026-11-11 (196d-1〜7)。仕様は `docs/design/DEV-196-demo-admin-spec.md` (§3・§6.1〜§6.8・§7・§8・§9・§12・§15)、MVP_SPEC §4・§7・§7.1、ARCHITECTURE §11、SECURITY §12、DEV-196c の migration `supabase/migrations/20261111000000_sales_demo_versions.sql` と `.ai/reviews/DEV-196c.md`。

**全 PR に共通**: 旗 `SALES_DEMO_VERSIONS_ENABLED` (既定で無効) の後ろ。無効のとき新しい route は 404、今日の画面・React のデモ・送信は変わらない。環境変数は名前だけで、値はどこにも登録しない (Vercel・`.env` の値・workflow の変更なし)。共有の scope `p` は作らない (常に 404)。新しい migration・Protected Scope の変更・権限の拡大が要るときは実装せずに止まって報告する。

## 196d-1: 旗・文言・比較・view model (unit だけ)

branch `feature/dev-196d-1-foundation` (`origin/develop` ae2720a から)。route・頁・component・DB・next.config の変更なし。足したのは `lib/sales/demo-version/` の 4 つの module とその unit テストだけで、どの app の route・頁・component からもまだ import されていない (`purity.test.ts` の「app から import されない」の検査はそのまま通る)。

| module | 中身 | 仕様 |
|---|---|---|
| `flags.ts` (`server-only`) | `SALES_DEMO_VERSIONS_ENABLED` は `"true"` ちょうどだけ有効 (`TRUE`・`1`・前後の空白は無効)。無効なら他の設定を読まない (テストで固定)。`SALES_DEMO_VIEW_SIGNING_KEY` は base64 / base64url (padding 任意、正準の綴りだけ、2 つの alphabet の混在・空白・改行は拒否) で 32 bytes 以上。足りない・形が違えば null (token を発行しない)。`SALES_DEMO_ARTIFACT_ORIGIN` は unset / set / invalid (空文字も invalid。unset と取り違えない)。env は引数で、この module は env を読まない (purity の規則を緩めずに済む) | §6.2・§6.4 手順 1・§6.8、ARCHITECTURE §9 |
| `admin-messages.ts` | 管理画面の文言をすべて固定の符号から引く。管理者の 5 つの RPC 関数 (品質承認・取り下げ・版の取り消し・画像の取り消し・`sales_demo_assert_no_open_send`) が raise する符号すべてに日本語がある (テストが migration から符号を読んで照合)。状態・権利・7 項目 (3・4・5 に「どうなら問題あり」の hint)・取り消しの固定の理由 (`^[A-Z][A-Z0-9_]{2,47}$`)・取り下げ / 取り消しの確認文・AI の赤い印・「事実の偽装なし」の固定の文 | §4.6・§6.6・§7.2・§8.1・§9.5 |
| `compare.ts` | manifest の差分 (名前と sha256)、copy の行の LCS 差分 (事実の行と創作の見出しを区別、上限: 片側 2000 行・1 行 2000 字・共通の頭と尾を除いた DP 200 万 cell。超えたら `TOO_LARGE`)、構造記述子の 8 つの観点の差分 (structure の module は import しない。語彙の形 `[a-z_]` の語だけを表示し、自由文は出さない)、hash・事実・worker commit・検査の符号・権利の要約の差分、既定の比較相手 (承認済みの版 → 親 → なし) | §4.1・§7.2・§7.5 |
| `view-model.ts` | 管理者の RLS のセッションが読む行から画面の内容を導く。プレビューは `canAdminPreview` と全画像の権利 (`sales_demo_image_previewable` と同じ: 許された状態・取り消しなし・JST の暦日で期限内) の両方。画像の行の sha256 がファイルと違えば権利は無いものとして扱う。1 枚でも使えなければ版ごと出さない。判定の可否は `sales_review_demo_version` が全判定に課す条件 (状態・demo の無効・事実の変化・検査・権利)、承認はさらに必須の描画 2 つ、版のすべての描画画像を画面で表示できること (`RENDER_UNVIEWABLE`: RPC は版の render のファイルすべてを見たことを承認に要求するので、表示できない viewport や寸法の無い render があれば承認を出さない)、`send_opened` が無いこと。阻む理由ごとの固定の文言は `APPROVE_BLOCKER_LABEL`。事実の hash が読めないときは「同じ」と言わない。出所は日付・承認 ID の有無・prompt の hash の頭 8 字だけ (モデル名・生成の手段の自由文は出さない) | §4.6・§6.1・§7.2・§8.1〜§8.3・§9.2〜§9.5 |

### オーナーの要求と DEV-196c の Low

- **品質基準を正しく判断できる**: 7 項目の文言と hint (3「店名を入れ替えても成り立つなら問題あり」、4「帯やカードを積み重ねただけなら問題あり」、5「SP が PC の縮小・横はみ出し・読めない・PC の間延びなら問題あり」)。テンプレート化の警告は「参考」と明記 (止めない)。画面に使うのは 196d-3・196d-5。
- **Low (a)** (note の規則が `style.css` などを拒否する): `INVALID_NOTE_MESSAGE` に「`style.css`・`example.com` のように『.』の後に英字が続く語は書けない、言い換えるか『.』を外す」と具体的に書いた。form での事前の確認と表示は 196d-5。
- **Low (d)** (品質承認で送信が止まる警告): `APPROVAL_STOPS_SENDING_BEFORE` / `_AFTER` と、view model の `sendStoppedBy` (承認済みの版があれば理由の一覧。今は版での共有が無効なので常に `versioned_sharing_disabled`、AI 画像・写真があればそれも)。画面に出すのは 196d-5・196d-7。
- **Low (c)** (画像ごとの偽装なしの確認を管理者の操作に): view model に `needsImpersonationConfirm` / `impersonationConfirmImageIds` と固定の文 `NO_IMPERSONATION_STATEMENT`。**記録の方法は DB の変更が要る見込み** (下の「判断が要ること」)。
- **Low (b)** (生成時の事実の hash の照合): 196d-1 の範囲外。下の「判断が要ること」。
- 権利不明・事実の未確認は fail closed (画像 1 枚で版ごと不可、事実が読めなければ「同じ」と言わない)。取り消し後に別のデモへ切り替えないことは確認文に明記 (`REVOKE_CONFIRM_TEXT`)。

### 判断が要ること (coordinator へ)

1. **Low (c)**: `sales_demo_images` の `no_factual_impersonation_confirmed_at/_by` は ingest の挿入時に入り、行は trigger で不変 (`demo_image_immutable`)。`ai_concept_internal` の table の check もこの 2 列を挿入時に要求する。管理画面のボタンで画像ごとに記録するには、新しい管理者の関数 (例: 画像 id と sha256 を受け、確認した管理者と時刻を別の列か別の表に追記する SECURITY DEFINER の関数) と、品質承認の関数がその確認を要求する変更が要る = **新しい migration**。196d-5 では DB を変えずにできる範囲 (画面で画像ごとの確認を必須にし、sha256 を server action で照合) まで実装し、DB の変更は止まって報告する予定。
2. **Low (b)**: `sales_ingest_demo_version` は事実の hash を DB で計算するだけで、worker の申告を受ける引数が無い。照合するには ingest の関数の引数 (または upload の API の begin の段) の変更 = **DB の変更**。7 つの PR の中に ingest / upload の API は無いので、どの PR で扱うか (または DEV-196i へ送るか) の判断が要る。

### テスト

- unit: `tests/unit/sales/demo-version/` に `flags.test.ts`・`admin-messages.test.ts`・`compare.test.ts`・`view-model.test.ts` を追加、`purity.test.ts` の module 一覧に 4 つを追加 (env を読まない・I/O なし・app から import されない、の規則は変えていない)。
- 結果 (2026-11-11、worktree、develop ae2720a + この branch): `npx vitest run tests/unit/sales/demo-version tests/unit/ai-tasks.test.ts tests/unit/guardrails.test.ts` 20 files / 648 tests 合格。`tests/unit/sales` 全体も合格。`npx tsc --noEmit`・eslint (変更した dir)・`npm run check:secrets`・`npm run build` 合格。
- 全 unit (`npx vitest run`) では `tests/unit/design-agent/**` の Chromium を起動するテストだけが落ちる。container の `/opt/pw-browsers` にあるのは `chromium_headless_shell-1194` で、repo の Playwright が探す `-1234` が無いため (環境の問題。この PR は触れていない)。196d-2 以降の e2e では対処が要る。
