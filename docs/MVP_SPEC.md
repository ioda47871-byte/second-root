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
| ingest 1 run あたりの候補数（batch上限） | **5件** | 超過分は保存せず拒否 |

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

### 3.5 重複排除

次のキーで照合し、明確な同一店舗なら新規 prospect を作らず既存 record を再利用する。

- 正規化店名 + 正規化住所
- 公式サイトの domain
- Instagram URL（正規化済み handle）
- 公開メールアドレス（小文字化）

## 4. 送信 UX

### 4.1 Instagram

1. 管理画面「DMを送る」→ 営業文を clipboard へコピー ＋ 対象 Instagram を開く。
2. 人間が貼り付けて送信。
3. 戻って「送信済み」を1タップ。**開いただけでは sent にしない。**

Instagram DM の自動送信は行わない。

### 4.2 Email

- MVP では人間が端末のメールアプリから送る（`mailto:`）。
- 事前入力: recipient / subject / body / デモURL / Second Root 署名 / 「営業不要なら返信で伝えられる」旨。
- 人間は基本的に Send を押すだけ。戻って「送信済み」を1タップ。
- **既存 Resend はコールド営業メールに絶対に使わない**（問い合わせフォーム用途のみ）。

### 4.3 フォロー（Email のみ・1回のみ）

条件: 初回送信から5日以上 ＋ 返信なし ＋ follow-up 未実施 ＋ DNC でない → 「フォローメールを送る」を表示（mailto による人間送信）。
Instagram フォローは MVP ではなし。

## 5. 返信・商談・成約

返信の自動取得は行わない。人間が返信を見たら「返信あり」を1タップし分類する。

```
drafted → sent → replied(interested|question|meeting_request|decline|other)
                     → meeting → won | lost
任意の状態 → lost（人間判断）
```

- 状態は prospect の初回営業（`kind=initial` の outreach）で管理する。フォローメールは状態ではなく、別の outreach 行（`kind=follow_up`）として記録する（§4.3）。フォロー後の返信も初回営業の状態を `replied` に進める。

- `won` のみ成約金額（円・正の整数）必須。
- `decline` または営業不要の意思表示 → `do_not_contact = true`。
- 状態遷移はサーバー側の state machine で検証し、不正遷移は拒否する。

## 6. Do Not Contact (DNC)

- 営業不要の意思表示があれば `do_not_contact = true`。
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
  - デモ作成時（ingest 時・未送信）は仮の `expires_at = 作成日時 + 30日`（送信前に人間が内容確認できるように）。
  - 初回営業を「送信済み」にした時点で `expires_at = sent_at + 30日` に更新する。
  - アクセス時に `expires_at` / `disabled_at` / `keep_alive` で判定（row 削除は不要）。
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

Operational Claude は次をしない: DM送信 / メール送信 / Supabase直接書き込み / GitHubコード変更 / DNC変更 / 成約状態変更。
実行基盤は Claude Cloud の scheduled job（Routine）を第一候補とし、Staging で実走確認する（DEV-016）。
実走失敗時に勝手に有料 API へ移行しない（BLOCKED として人間へ報告）。

## 11. コスト

追加ランニングコスト 0円を目標。MVP では原則追加しない: OpenAI API / Anthropic metered API / Google Places 有料依存 / 有料 Email Finder / 有料 Staging。

## 12. 範囲外（MVPでは作らない）

- 自動送信（DM・メールとも）、返信の自動取得、Instagram フォロー
- 名古屋市外・対象3業種以外
- 複数管理者・権限ロール
- 有料データソース・有料 API
