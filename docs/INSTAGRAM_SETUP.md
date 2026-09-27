# Instagram 返信機能: 人間の設定手順（DEV-024 / HUMAN-006）

> コード・DB・管理画面・テストは完成済み（DEV-020〜023）。ここにあるのは **Meta の実アカウントでしかできない操作**だけ。
> 仕様: `docs/INSTAGRAM_MESSAGING.md`。公式ドキュメントの確認記録: `.ai/research/meta-instagram-messaging-2026-09-27.md`（2026-09-27 時点、Graph API v26.0）。
> Meta の画面名・項目名は変わることがあるので、見当たらない場合は公式ドキュメントの「Instagram API with Instagram Login」を正本にする。

## 0. 前提と順番

- 使う API: **Instagram API with Instagram Login**（`graph.instagram.com`）。Facebook ページとの連携は不要。
- 必要な権限は `instagram_business_basic` と `instagram_business_manage_messages` の 2 つだけ。
- **初回 DM は今まで通り人間が Instagram アプリから送る。** この設定で自動化されるのは「相手から返信が来た後」の受信・分類・返信案・送信（人間の 1 タップ後）だけ。
- 推奨の順番: **Staging（HUMAN-004 で作る Preview 環境。固定 URL が必要）で 1〜8 を通して確認 → Release 承認後に Production で 5・7 をやり直す。**
  Webhook の callback は公開 HTTPS の固定 URL が必要（Vercel の毎回変わる Preview URL や、Vercel の認証がかかった URL は使えない）。
- Access Token・App Secret・Verify Token は **Vercel の環境変数にだけ**入れる。GitHub・チャット・Claude の session には貼らない。
- 下の `curl` の例は、token をコマンドライン（shell の履歴）に残さないよう、先に `read -rs IG_TOKEN`（入力は表示されない）で token を変数に読み込んでから使い、終わったら `unset IG_TOKEN` する。

## 1. Meta App を作る（人間、約 10 分）

1. https://developers.facebook.com/apps → **アプリを作成**。
2. ユースケースで **Instagram のメッセージとコンテンツを管理**（英語: "Manage messaging & content on Instagram"）を選ぶ。種類は Business。
3. アプリ名は例: `Second Root Messaging`。ビジネスポートフォリオは任意。

## 2. Instagram アカウントをつなぐ（人間）

1. 前提: Second Root の Instagram が **プロアカウント（ビジネスまたはクリエイター）**であること。
2. Instagram アプリで: 設定 → **メッセージとストーリーへの返信** → **メッセージのコントロール** → **接続済みのツール** → **メッセージへのアクセスを許可**をオン。
3. Meta App の管理画面 → **Instagram** → **Instagram ログインによる API 設定** → **アカウントを追加** → Second Root の Instagram でログインし、権限を許可する。
4. 同じ画面で **アクセストークンを生成**を押す。表示された token が `INSTAGRAM_ACCESS_TOKEN`（長期トークン、**60 日で失効**）。
5. アカウント ID（数字）を控える → `INSTAGRAM_ACCOUNT_ID`。表示がなければ、手元の terminal で
   `curl -s -H "Authorization: Bearer $IG_TOKEN" "https://graph.instagram.com/v26.0/me?fields=user_id,username"` の `user_id`。

## 3. 値を作って Vercel に入れる（人間）

Vercel → Project → Settings → Environment Variables。**Staging は Preview、本番は Production にだけ**設定し、再デプロイする。

| 名前 | 値 |
|---|---|
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | 新しく作るランダム値（`openssl rand -hex 32`）。4 で Meta 側にも同じ値を入れる |
| `INSTAGRAM_APP_SECRET` | Meta App → Instagram → Instagram ログインによる API 設定 → **Instagram アプリシークレット**（下の注意を参照） |
| `INSTAGRAM_ACCOUNT_ID` | 2-5 の数字 |
| `INSTAGRAM_ACCESS_TOKEN` | 2-4 の token |

- 注意（公式ドキュメントで確定できなかった点）: Webhook の署名に使われるのが「Instagram アプリシークレット」か「Meta アプリのシークレット（設定 → ベーシック）」か。
  4 の後に 8 のテスト DM が管理画面に出ない場合は、`INSTAGRAM_APP_SECRET` をもう一方の値に替えて再デプロイし、もう一度テストする。

## 4. Webhook を登録する（人間。3 の再デプロイ後）

1. Meta App → Instagram → Instagram ログインによる API 設定 → **Webhook を設定**。
2. **コールバック URL**: `https://<Staging または本番のドメイン>/api/webhooks/instagram`
3. **認証トークン**: 3 の `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` と同じ値 → **認証して保存**。
   失敗する場合: 環境変数が未設定か再デプロイ前（サーバーは 503 を返す）、または値の不一致（403）。
4. Webhook フィールドで **`messages`** を購読（Subscribe）する。
5. 2-3 で追加したアカウントの行で **Webhook の受信（subscription）をオン**にする。画面にない場合は手元の terminal で
   `curl -s -X POST -H "Authorization: Bearer $IG_TOKEN" "https://graph.instagram.com/v26.0/<INSTAGRAM_ACCOUNT_ID>/subscribed_apps?subscribed_fields=messages"` → `{"success":true}`。

## 5. アプリをライブにする（人間）

- Webhook は **アプリがライブ（Live）でないと実ユーザーのメッセージが届かない**。管理画面上部のモード切替で Live にする（プライバシーポリシー URL が必要: `https://<ドメイン>/privacy` など既存の法務ページ）。
- アクセスレベル: **自社アカウントだけに使うアプリは Standard Access で足り、App Review は不要**（公式の App Review ページの表による）。
- ただし「アプリに役割のない一般ユーザーからの DM を受け取り、返信できるか」は公式ドキュメント同士で記述が食い違う。**8 のテストで必ず確認する。**
  失敗した場合は Advanced Access（ビジネス認証 + App Review）が必要。**App Review の申請は人間の判断**（Claude は申請しない）。

## 6. Inbox の Routine を作る（人間）

`ops/sales-agent/SCHEDULE.md` §5 のとおり `second-root-sales-inbox` を作成する。環境変数は店舗探索 job と同じ `SALES_AGENT_INGEST_URL` / `SALES_AGENT_INGEST_TOKEN` だけ。Meta の値は渡さない。

## 7. トークンの更新（60 日ごと、人間）

- 50 日目を目安にカレンダーへ登録する。手元の terminal で
  `curl -s -G "https://graph.instagram.com/refresh_access_token" --data-urlencode grant_type=ig_refresh_token --data-urlencode "access_token=$IG_TOKEN"`（公式の更新 endpoint は token を query で受け取る仕様。履歴に残さないため変数で渡す） を実行し、返った `access_token` で Vercel の `INSTAGRAM_ACCESS_TOKEN` を更新して再デプロイする。
- 期限が切れると、送信時に「アクセストークンの期限切れ」と表示される（送信はされず、sent にもならない）。受信（Webhook）は token がなくても続く。

## 8. 設定後の確認（ここから自動・半自動）

人間が 1〜6 を終えたら、次の順に確認する。テストには**店舗ではない自分の個人 Instagram アカウント**を使う（実店舗には送らない）。

| # | 確認 | 誰が | 期待する結果 |
|---|---|---|---|
| 1 | 4-3 の「認証して保存」 | Meta が自動 | 成功（GET handshake が verify token を確認） |
| 2 | 管理画面 → 返信 → **Instagram 連携を確認** | 人間が押す（読み取りのみ） | 「送信用の接続: OK（@secondroot…）。受信（Webhook）の設定: あり。」 |
| 3 | 個人アカウントから Second Root に DM | 人間 | 数秒で 返信 → Instagram の返信 に「未照合: @個人アカウント」として表示（署名検証・保存・冪等性が本番設定で動作） |
| 4 | inbox Routine を手動実行 | 人間が起動、Claude が実行 | 同じ会話に AI 分類と返信案が付く |
| 5 | 3 の会話で店舗を選ばず **営業と関係ない** | 人間 | 一覧から消える（照合は人間だけ） |
| 6 | 個人アカウントからもう一度 DM →（テスト用に）照合 → **この内容で返信** | 人間 | 個人アカウントに届く。管理画面は「送信しました」、やりとり履歴に 1 回だけ表示（echo の重複なし） |
| 7 | 6 の直後にもう一度 **この内容で返信** を押す | 人間 | 「この返信は送信済みです」。二重送信されない |

- 公開状態の確認（Claude が secret なしで実行できる）: `GET /api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1` → 403、署名なしの POST → 401。
- 二重送信・失敗時に sent にしない・再起動後の継続・未照合の保存・Webhook の冪等性は、自動テスト（`tests/integration/ig-*.test.ts`、`tests/e2e/ig-inbox.spec.ts`）で毎回 CI が確認している。
- 3 が失敗するとき: Meta App → Webhook の配信ログを見る。401 なら 3 の「注意」、Live でなければ 5、個人アカウントがアプリに役割のないユーザーで届かないなら 5 の Advanced Access。

## 9. 保存期間（決定済み、自動）

会話（メッセージ・返信案・送信記録）は最後のメッセージから 180 日で自動削除する。送信結果の確認待ち（送信中・不明）の会話は削除しない。Webhook の受信記録は 30 日で削除し、7 日より古い event は受け付けない（詳細: `docs/INSTAGRAM_MESSAGING.md` §8）。
