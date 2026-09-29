# Second Root Sales Agent — MVP仕様

> 本書は Second Root Sales Agent MVP の**正本仕様**である。
> 実装判断に迷ったら本書 → `docs/ARCHITECTURE.md` → `docs/SECURITY.md` の順に参照する。
> 本書の変更は「MVP重大変更」にあたる場合、人間承認が必要（`docs/AI_WORKFLOW.md` Protected Scope 参照）。

## 1. 目的

Second Root の営業を、人間ができるだけ考えず、少ないクリックで回せるようにする。

```
候補発見 → 公式サイト有無確認 → 重複除外 → 簡易デモ生成 → 営業文生成
  → 人間が確認・送信 → 返信 / 商談 / 成約を記録 → 営業条件と成果を分析
```

- Instagram DM とコールド営業メールの**最終送信は必ず人間**が行う。
- 自動大量送信システムにはしない。
- 既存 Second Root サイト（トップ、問い合わせフォーム、法務ページ、契約情報等）を壊さない。

## 2. 対象

| 項目 | 値 |
|---|---|
| 地域 | 名古屋市のみ |
| 業種 (`category`) | `bakery`（パン屋） / `baked_goods`（焼菓子店） / `cafe`（カフェ） |
| 利用者 | Second Root 管理者 1名（非公開の内部機能） |

## 3. 営業ルール（サーバー側で強制する Hard Rules）

以下は Claude のプロンプトだけに依存せず、通常コード / SQL / DB constraint で強制する。

### 3.1 量の上限

| ルール | 値 | 備考 |
|---|---|---|
| 新規営業候補 | **最大5件/日**（Asia/Tokyo 基準の日付） | 条件を満たす候補が5件未満なら増やさない |
| 今日の作業キュー | **原則最大5アクション** | 5日後フォローメールは新規より優先して5枠に含める |
| ingest 1 run あたりの検証済み候補数（batch上限） | **10件** | Operational Claude が提出できる `verified` 候補の上限。超過した要求は schema validation で全体を拒否（400、何も保存しない） |
| 1 run で新規に営業準備完了（actionable）になる店舗 | **当日の残り枠まで（最大5件）** | サーバーが duplicate / DNC / eligibility / 当日上限を判定した結果。条件を緩めて5件を埋めない |

### 3.2 チャネル決定（初回営業は1店舗につき1チャネルのみ）

| website_status | Instagram | 第一者公開メール | 推奨チャネル |
|---|---|---|---|
| `present` | 任意 | あり | `email` |
| `present` | あり | なし | 対象外（MVPでは営業しない） |
| `not_found` | あり | なし | `instagram` |
| `not_found` | 任意 | あり | `email`（サイトなしでも第一者公開メールがあれば可） |
| `unknown` | 任意 | あり | `email` 可（メール出所条件を満たす場合のみ） |
| `unknown` | あり | なし | **対象外**（unknown は Instagram 営業対象にしない） |
| 任意 | なし | なし | 対象外 |

- 一方のチャネルで返信・拒否があれば、別チャネルで追撃しない。
- `do_not_contact = true` の店舗は全チャネル・フォローから除外。

### 3.3 website_status

- 最低限 `present` / `not_found` / `unknown` の3状態。
- 検索に失敗しただけで `not_found` にしてはいけない（失敗は `unknown`）。
- `not_found` は再検索を行った上でのみ設定する（ingest 時に再確認の記録を必須とする）。

### 3.4 メール取得ルール

- **推測禁止。** 店舗自身が公開している第一者情報のみ（公式サイト、公式Contact、公式プロフィール等）。
- 禁止: 推測メール / 購入リスト / 出所不明データ / 第三者スクレイピングデータ / 営業拒否が明記された連絡先。
- メールには出典（`source_url` と `source_type`）が必須。出典がなければ Email 候補にしない。
- 第一者と認める出典: `official_site` / `official_contact` はその店舗の公式サイト（検証済み website と同じサイト）上のページ、
  `official_profile` はその店舗自身の検証済み Instagram プロフィール（候補の Instagram URL と同じアカウント）だけ。
  リンク集サービス・他の SNS・他人のアカウントは店舗との結び付きをサーバーが確認できないため使わない（fail-closed）。

### 3.5 重複排除

次のキーで照合し、明確な同一店舗なら新規 prospect を作らず既存 record を再利用する。

- 正規化店名 + 正規化住所
- 公式サイトの domain
- Instagram URL（正規化済み handle）
- 公開メールアドレス（小文字化）

### 3.6 fail-closed（確認できなければ営業準備しない）

前工程の確認が取れない候補は、営業準備完了（outreach_ready）へ進めない。判断に迷う・確認に失敗した場合は「営業しない」側に倒す。

| 確認できなかったもの | 扱い |
|---|---|
| 公式サイトの有無（検索失敗） | `website_status = unknown` → Instagram 営業不可 |
| 第一者メールの出典 | Email 営業不可 |
| DNC 照合（DB 確認失敗） | 営業準備不可（再試行待ち） |
| 重複照合（DB 確認失敗） | 営業準備不可（再試行待ち） |
| 永続化（保存失敗） | demo / outreach を ready にしない |

これは Operational Claude の prompt だけに依存せず、サーバー側のコード・API validation・DB 制約で強制する（詳細: `docs/ARCHITECTURE.md` §7.4）。

## 4. 送信 UX

### 4.1 Instagram

1. 管理画面「DMを送る」→ 営業文を clipboard へコピー ＋ 対象 Instagram を開く。
2. 人間がプロフィールに「DM不可」「営業お断り」等の記載がないことを確認し、貼り付けて送信（Operational Claude はログインなしで Instagram を読めないことが多いため、この確認は人間が行う。記載があれば送らず「営業不要（DNC）」にする）。
3. 戻って「送信済み」を1タップ。**開いただけでは sent にしない。**

Instagram DM の自動送信は行わない。

### 4.2 Email

- MVP では人間が端末のメールアプリから送る（`mailto:`）。
- 事前入力: recipient / subject / body / デモURL / Second Root 署名 / 「営業不要なら返信で伝えられる」旨。
- 人間は基本的に Send を押すだけ。戻って「送信済み」を1タップ。
- **既存 Resend はコールド営業メールに絶対に使わない**（問い合わせフォーム用途のみ）。

### 4.3 フォロー（Email のみ・1回のみ）

条件: 初回送信から5日以上 ＋ 返信なし ＋ follow-up 未実施 ＋ DNC でない → 「フォローメールを送る」を表示（mailto による人間送信）。
フォロー文面にはデモ URL を含むため、デモが公開中（無効化されておらず期限内）であることも条件とする。送信済みはフォロー用の outreach 行（`kind=follow_up`）として1回だけ記録する（DB の一意制約と管理者 RPC `sales_mark_follow_up_sent` で保証）。
Instagram フォローは MVP ではなし。

## 5. 返信・商談・成約

MVP では返信の自動取得は行わない（Instagram は後続の DEV-020〜024 で公式 API による受信に対応）。人間が返信を見たら「返信あり」を1タップし分類する。

```
drafted → sent → replied(interested|question|meeting_request|decline|other)
                     → meeting → won | lost
任意の状態 → lost（人間判断）
```

- 状態は prospect の初回営業（`kind=initial` の outreach）で管理する。フォローメールは状態ではなく、別の outreach 行（`kind=follow_up`）として記録する（§4.3）。フォロー後の返信も初回営業の状態を `replied` に進める。

- `won` のみ成約金額（円・正の整数）必須。
- `decline`（「今回は不要」「興味なし」等）だけでは `do_not_contact` にしない。この店舗への営業はそこで終了する（別チャネルで追撃しない・フォローしない）。MVP では再営業の仕組みは作らない（DNC と区別して記録するのは、将来の営業判断と計測のため）。
- 「今後連絡不要」「もう営業連絡しないでほしい」等、**将来の連絡を明示的に拒否**された場合だけ、管理者が返信記録時に「今後の連絡を拒否された（DNC）」を選び `do_not_contact = true` にする（§6）。
- 状態遷移はサーバー側の state machine で検証し、不正遷移は拒否する。

## 6. Do Not Contact (DNC)

- 将来の営業連絡を**明示的に拒否**された場合だけ `do_not_contact = true`（通常の decline では設定しない。§5）。設定は管理者のみ。
- 以後 Email / Follow-up / Instagram 候補すべてから除外。ingest で同一店舗が来ても候補化しない。
- **DNC 解除は人間管理者のみ。** Operational Claude の ingest API には DNC を変更する手段を持たせない。

## 7. デモ

- 共通ルート `/demo/[publicToken]`。店舗ごとの Next.js プロジェクトや Vercel Deployment は作らない。
- テンプレート: `bakery_v1` / `baked_goods_v1` / `cafe_v1`（業種で選択）。
- `publicToken`: 暗号学的乱数、128bit 以上（例: 32 bytes base64url）。
- 「Second Root による提案用デモであり、店舗公式サイトではない」旨を明記。
- `noindex,nofollow`（meta）＋ `X-Robots-Tag: noindex, nofollow`。
- 表示できるのは**確認済みの公開情報のみ**。架空の営業時間・商品・価格・沿革・店主ストーリー・人気商品・受賞歴等は禁止。不明なら省略。
- Instagram 画像等を無断転載しない。Second Root 側のテンプレート素材と確認済みテキストのみ。
- 公開期間: 原則初回営業から30日。
  - デモ作成時（ingest 時・未送信）は `expires_at = null`。**未送信デモは公開 URL では表示せず**、ログイン済み管理者だけが管理画面のプレビューで確認できる。
  - 初回営業を人間が「送信済み」にした時点で `expires_at = sent_at + 30日` を設定し、公開 URL で表示されるようになる。
  - 公開 URL の表示条件: `disabled_at` が null かつ `expires_at` が設定済み かつ（`keep_alive` ／ 現在 < `expires_at`）。それ以外は 404。
  - DNC を設定した店舗のデモは `disabled_at` を設定して即時非公開にする。
  - 送信前に店舗がリンクを開くと 404 になりうるため、管理画面では送信後すぐ「送信済み」を押す導線にする。
  - row 削除は不要。
- 公開 demo に絶対出さない: 営業内部メモ / メールアドレス / Claude 内部評価 / 成約金額 / outcome / internal ID / secret。

## 8. 管理画面 `/admin/sales`

- Supabase Auth。MVP 管理者は明示された1名のみ。
- モバイルファースト。ナビは「今日 / 返信 / 商談 / 履歴」の4つ。
- 今日の画面: 店名・営業チャネル・最低限の状態・大きな送信ボタンを優先。詳細は折りたたむ。
- 日常操作を「開く → 送る → 送信済み」に近づける。

## 9. 計測（軽量）

- 営業条件（業種、チャネル、website_status、デモ有無、フォロー有無）ごとの sent / replied / meeting / won 件数と率、成約金額合計。
- AI 不要。SQL / 通常コードで集計する。

## 10. Operational Claude（日々の店舗探索）

フロー: Web検索 → 候補発見 → 公式サイト再確認 → 第一者公開メール確認 → 出典付き情報整理 → 推奨チャネル → 営業文準備 → `POST /api/internal/sales-agent/runs` へ提出。

run は `sales_agent_runs` に工程（phase）と checkpoint を残し、Claude のセッションが途中で消えても、次の run が Supabase の状態だけから続きを再開できる。

- 工程: 開始 → 候補探索完了 → 検証完了 → 重複/DNC 確認・永続化・デモ準備・営業文準備（サーバー側）→ 完了
- `run_id` を冪等キーとし、再送・再実行・resume で prospect / demo / 営業下書きを重複させない。完了済み run の再送は既存結果を返す。
- 詳細: `docs/ARCHITECTURE.md` §5（ingest API）, §7（checkpoint / resume / idempotency / fail-closed）

Operational Claude は次をしない: DM送信 / メール送信 / Supabase直接書き込み / GitHubコード変更 / DNC変更 / 成約状態変更。
実行基盤は Claude Cloud の scheduled job（Routine）を第一候補とし、Staging で実走確認する（DEV-016）。
実走失敗時に勝手に有料 API へ移行しない（BLOCKED として人間へ報告）。

## 11. コスト

追加ランニングコスト 0円を目標。MVP では原則追加しない: OpenAI API / Anthropic metered API / Google Places 有料依存 / 有料 Email Finder / 有料 Staging。

## 11.1 後続機能（MVP の後）

- Instagram 返信後の公式 Messaging API 連携（DEV-020〜DEV-024、2026-09-27 人間承認の scope extension）: 相手から Second Root の Instagram Professional Account へ届いた返信を公式 Webhook で受信し、分類・返信案を自動で用意、**人間が1タップで承認した返信だけ**を公式 Send API で送る。初回 cold DM は引き続き人間の手動送信。詳細: `docs/INSTAGRAM_MESSAGING.md`。

- デモの AI アートディレクション PoC（DEV-028、2026-09-29 人間承認）: 1 店舗ずつ人が手で起動するローカル CLI。ChatGPT でサインインした Codex CLI（API キーは使わない。従量課金の OpenAI API ではない）に、**確認済みの公開 fact** と**人が用意した公開ページのスクリーンショット**（Instagram はプロフィール上部と投稿グリッドだけ。コメント・DM・第三者の個人情報や顔を含めない）を渡し、見た目だけの design profile を JSON Schema の範囲で選ばせる。店舗の文言は fact-only の DemoView からしか出ない。PoC では DB に保存せず、Production・Staging・Routine・営業 Agent に接続しない。詳細: `docs/operations/design-agent-wsl.md`。

## 12. 範囲外（MVPでは作らない）

- 自動送信（DM・メールとも）、返信の自動取得（Instagram は後続 DEV-020〜024）、Instagram フォロー
- 名古屋市外・対象3業種以外
- 複数管理者・権限ロール
- 有料データソース・有料 API
