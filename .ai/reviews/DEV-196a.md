# DEV-196a: 仕様の文書を DEV-196 の設計に合わせる (docs だけ)

2026-11-10。branch `feature/dev-196a-spec-docs` (`origin/develop` 8fe0f80 から)。設計の正本: `docs/design/DEV-196-demo-admin-spec.md` (以下「仕様」)。
**docs と `.ai/` だけ。コード・設定・migration・workflow・package / lockfile・環境変数の既定値 (`PUBLIC_DEMO_ASSETS_ENABLED`・`APPROVED_CAPABILITIES` を含む) の変更なし。** どの実装の段も承認していない (仕様 §12)。

承認: 仕様 §12 の DEV-196a はオーナー決定 2026-11-10 で承認済み (仕様の文書だけ)。MVP_SPEC の変更は Protected Scope (`docs/AI_WORKFLOW.md` §7「MVP 重大変更」) なので、PR のレビューと merge は別に人が判断する。

## 変更ごとの対応

### `docs/MVP_SPEC.md`

| 変更 | 従った仕様の節 |
|---|---|
| §4: 送信承認の前に、版ごとのデモの品質承認が別に要ること。版の無い店舗は今の手順のまま | §9.1・§9.2・§15-3 |
| §7: 写真の規則に「実店舗の管理者だけのデザイン検討で AI 概念画像を使う例外」を 1 行足した (相手に見せる頁には及ばない、公開 demo の規則は不変) | §8.3・§15-1 |
| §7.1 (新): 版と系譜 | §4.1・§4.6・§10.1 |
| §7.1: 二つの別々の承認、無効になる条件、`send_opened` の間は版を変える操作を断る | §9.1〜§9.5 |
| §7.1: 承認済みの版が無い店舗は React のデモで一時的に送ってよい (人の確認と送信承認は必須、自動の切り替えなし、品質確認を飛ばさない) | §9.2・§15-3 |
| §7.1: 管理者プレビュー (`/admin/sales/demos/[prospectId]`) と共有 URL (`/demo/[publicToken]` のまま) の分離 | §6.1・§6.4 |
| §7.1: 専用の別 origin。DNS と Vercel は今は変えない。設定まで共有の成果物の route は 404 | §6.8・§15-2・T23 |
| §7.1: HMAC の token (管理者 15 分・共有 30 分・共有 URL 原則 30 日・開き直すたびに発行) と要求ごとの DB の照合 | §6.2・§6.6・§15-5 |
| §7.1: 取り消し → 404、ほかの版や React のデモへ自動で切り替えない | §6.6・§9.4・§15-4・T22 |
| §7.1: 保持 (未送信 約 60 日・送信済み 共有の後 約 30 日・削除は別の承認) | §4.1・§6.6・§15-5・§12 DEV-196j |
| §7.1: AI 画像 (架空の店の研究は今までどおり、実店舗は管理者だけで 3 条件、相手に共有しない、将来は別の仕様変更と承認、生成は 1 回ごとの承認) | §8.3・§15-1 |
| §7.1: 写真の共有は無効のまま (`PUBLIC_DEMO_ASSETS_ENABLED = false`)、共有できる版は写真 0 枚だけ、写真の共有は別の承認 | §8.3 (最後から 2 つ目)・§12 DEV-196a |
| §7.1: PC1440 / SP390 の全頁と 7 項目 (3・4・5 を重視)、1 つでも ng なら承認しない、類似は警告だけ | §7.2・§7.5・§15-6 |
| §8: 管理者プレビューの頁 | §6.1・§7.2 |
| §11.1: DEV-196 の段と承認の状態 (承認済みは 196a・196b だけ) | §12・§15-7 |

### `docs/ARCHITECTURE.md`

| 変更 | 従った仕様の節 |
|---|---|
| §4 `sales_demos`: 版の表は提案だけで未作成、§11 へ | §4 |
| §9: 提案の環境変数 `SALES_DEMO_VERSIONS_ENABLED`・`SALES_DEMO_SHARE_ENABLED`・`SALES_DEMO_VIEW_SIGNING_KEY`・`SALES_DEMO_ARTIFACT_ORIGIN` (未作成・未承認と明記。値も既定値も設定していない) | §6.2・§6.4・§12 DEV-196d / 196g |
| §10.3: React の経路は変えず、版のデモは並べて足す | §1 範囲外・§6.1 |
| §11 (新): 全体の図 | §3 |
| §11.1: 提案の表と `sales_demo_version(d)` の拡張 | §4.1〜§4.4・§9.2・§9.3 |
| §11.2: 二つの承認、照合の符号、`send_opened` の扱い、版の無い店舗 | §9 |
| §11.3: アプリの origin と artifact origin の表、設定まで共有は 404、管理者プレビューの暫定、要求ごとの確認の順、origin の名前の案 | §6.4・§6.7・§6.8・§14 Q11 |
| §11.4: token・期限・取り消し・保持の表 | §6.2・§6.6 |
| §11.5: 品質 (警告だけ) と AI 画像の導き方、写真 0 枚 | §7.1・§7.5・§8.1・§8.3.1 |

### `docs/SECURITY.md`

| 変更 | 従った仕様の節 |
|---|---|
| §1: 提案の `SALES_DEMO_VIEW_SIGNING_KEY` (server only、未作成) | §6.2・§10.3 |
| §5.1: 外枠は今のヘッダのまま、`/demo-frame/*` だけ別の規則 | §6.7・T13 |
| §6: 公開 demo には写真を出さないこと、AI 概念画像の例外は相手に見せる頁に及ばないこと | §8.3 |
| §12 (新): Storage (非公開・署名付き URL なし・metadata に出所を書かない) | §5・§6.5・§8.2・T4・T17 |
| §12: 成果物の route (cookie を読まない・token の期限・要求ごとの DB の照合・manifest との完全一致・応答ヘッダと CSP・token を log に出さない) | §6.2〜§6.4・§6.7・T1・T3・T7・T8・T11・T12・T19 |
| §12: 専用の別 origin (cookie なし・host-only・DNS と Vercel は今は変えない・設定まで 404・多層の 1 枚・管理者の暫定) | §6.8・T23 |
| §12: 取り消しと保持 | §6.6・§9.4・T22 |
| §12: HTML/CSS の検査は server が正本、B方式の規則を緩めない | §7.1・§7.3・T2 |
| §12: 画像の権利と出所、AI 概念画像の条件、「事実の偽装なし」の確認の手順の案、写真の共有は無効 | §8・§14 Q12・T6・T21 |
| §12: 受け入れるリスク (管理者用の token) | T19 |
| §12: worker と bridge | §10.3・§10.4・T9 |

### `.ai/tasks.json`

- DEV-196 の `allowed_scope` に 2 行を足した (DEV-196 review L1): PR #241 が DEV-196 の項目の追加に加えて DEV-195 と DEV-197 を done にし、`.ai/reviews/DEV-197.md` に Staging の節を足したこと。DEV-196 の `status` と `note` は触っていない (DEV-196b の PR #243 との衝突を避けるため)。
- DEV-196a の項目を追加 (status `review`、depends_on DEV-196)。

## 決めなかったこと (案だけ書いた)

- **artifact origin の名前** (仕様 §14 Q11): ARCHITECTURE §11.3 に案 (アプリの domain の下の専用 sub domain、より強い分離として別の登録 domain) を書いた。決定と DNS / Vercel の設定はオーナーと別の承認。
- **「事実の偽装なし」の確認の手順** (仕様 §14 Q12): SECURITY §12 に案 (画像ごとに固定の文を読んで押す、bytes が変われば無効) を書いた。文言と手順は DEV-196i の前にオーナーが決める。
- 仕様の文書 (`docs/design/DEV-196-demo-admin-spec.md`) は変えていない (§12 の DEV-196a の状態の欄を含む)。

## テスト

- `npx vitest run tests/unit/ai-tasks.test.ts`: 207 passed / 1 failed。落ちたのは「DEV-196a needs DEV-196: expected 'review' to be 'done'」だけ (develop で DEV-196 がまだ `review` のため)。DEV-196b の PR が DEV-196 を done にした後に rebase すれば通る。それまでこの PR の CI の unit は赤になる。
- モデル名・secret の記載なし (docs の追記を目で確認)。
