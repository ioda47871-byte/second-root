# Business Discovery PoC（meta-check）

design worker が公開情報を取る経路として、Meta 公式の Business Discovery API が使えるかを確かめる、読み取りだけの道具。
worker にはまだ組み込まない（Playwright の取得はそのまま）。

- API: **Instagram API with Facebook Login**（`graph.facebook.com`）。Business Discovery は Instagram Login 系では使えない
- **Messaging 用の Meta App（Instagram Login）とは別の App** を使う。既存の Messaging 設定（`docs/INSTAGRAM_SETUP.md`）、その token、Vercel の `INSTAGRAM_*` には触れない
- 取るのは metadata だけ。画像はダウンロードしない
- 出力は符号・項目名・件数だけ。bio・キャプション・URL・username・Meta のエラー文は出さない
- token は WSL の `sr-designgen` のホームにだけ置く
  - repo・GitHub Actions・Vercel・Claude Cloud には置かない
  - 子 process の環境変数にも渡さない。Authorization header でしか送らない

調べた内容と未確認の点は `.ai/research/meta-business-discovery-2026-09-29.md` にある。

> **BLOCKED（人間の判断待ち）**: 取得した他社の公開情報を「営業デモのアートディレクションの参考」に使ってよいか。
> Meta Platform Terms の禁止事項（差別・適格性の判断・監視など）には当たらないが、この用途を明示的に許す記述も確認できていない。
> この PoC は「取れるか」だけを確かめ、何も保存しない。デザイン材料としての利用は、人間が規約を確認してから決める。

## 1. Meta の画面で行うこと（人間）

Meta の画面名・ボタン名は変わることがある。見当たらないときは、近い名前のものを選ぶ。

**A. 自社の Instagram をプロアカウントにし、Facebook ページとつなぐ**

1. Instagram アプリで Second Root 自社のアカウントを開く → プロフィール → 右上の「≡」
2. 「アカウントの種類とツール」→ まだなら「プロアカウントに切り替える」→「ビジネス」（または「クリエイター」）
3. Facebook で Second Root 自社のページを開く（無ければ作る）
4. ページの「設定」→「リンク済みのアカウント」→「Instagram」→「アカウントをリンク」→ 上のアカウントでログインして許可

**B. Business Discovery 用の Meta App を新しく作る（Messaging 用 App とは別）**

1. https://developers.facebook.com/apps →「アプリを作成」
2. 名前: `Second Root Design Discovery`（Messaging 用と区別できる名前）
3. ユースケース / 種類の選択
   - 「その他」→ アプリタイプ「ビジネス」を選ぶ
   - 画面がユースケース選択の形なら、「Instagram のメッセージとコンテンツを管理」系を選び、次に「**Facebook ログインを使った API 設定**」を選ぶ（Instagram ログインの方は選ばない）
4. ビジネスポートフォリオは「今は接続しない」でよい
5. 作成後、アプリの「モード」は**開発**のまま。公開（ライブ）にしない
6. 「アプリの役割」→「役割」で、自分が「管理者」になっていることを確認する

**C. token を作る**

1. https://developers.facebook.com/tools/explorer/ （グラフ API エクスプローラ）を開く
2. 右側の「Meta App」で B の App を選ぶ
3. 「ユーザーまたはページ」→「ユーザートークン」
4. 「アクセス許可を追加」で次を追加する
   - `instagram_basic`
   - `pages_show_list`
   - `pages_read_engagement`
   - ページをビジネスポートフォリオで管理している場合だけ `business_management`
5. 「Generate Access Token」→ Facebook のダイアログで、A-3 のページと A-1 の Instagram を選んで許可する
6. エクスプローラの入力欄に `me/accounts?fields=instagram_business_account{id}` を入れて「送信」
   - 返ってきた `instagram_business_account` の `id` を控える（自社の IG user id。数字）
7. https://developers.facebook.com/tools/debug/accesstoken/ （アクセストークンデバッガー）に、エクスプローラの token を貼って「デバッグ」→ 下の「アクセストークンを延長」
   - 表示された長期 token（約 60 日）をコピーする
   - token はこの後の WSL の手順以外には貼らない（チャット・メモ・repo に残さない）

**D. WSL（sr-designgen）に置く**

```bash
mkdir -p -m 700 ~/.config/sr-design-worker && chmod 700 ~/.config/sr-design-worker
( umask 077; read -rs T; printf '%s\n' "$T" > ~/.config/sr-design-worker/meta-token; unset T )   # 貼り付けて Enter（画面には出ない）
printf '%s\n' '<C-6 の数字>' > ~/.config/sr-design-worker/meta-ig-user-id
```

App の設定で「App Secret を必須にする（Require App Secret）」を有効にしている場合だけ、App secret を `meta-app-secret` に同じ方法で置く。
既定では不要。

## 2. 確かめる

```bash
cd ~/work/second-root && npm run -s sales:design-worker -- meta-check --username <target username>
```

| 表示 | 意味 | 終了コード |
|---|---|---|
| `AUTH_OK` | token が有効 | — |
| `CALLER_OK` | token で自社の IG プロアカウントに届く | — |
| `TARGET_FOUND` + 項目名・件数 | 相手の公開情報が取れた（値は出さない） | 0 |
| `TARGET_UNSUPPORTED` | 相手が見つからない、または Business / Creator ではない | 4 |
| `CALLER_INVALID` | IG user id が違う、または token の人が自社 IG に届かない | 3 |
| `TOKEN_EXPIRED` / `TOKEN_INVALID` | C をやり直す | 3 |
| `PERMISSION_ERROR` | C-4 の権限が足りない。または Standard Access では許されない呼び出し | 3 |
| `RATE_LIMITED` | 時間をおく | 3 |
| `META_TRANSIENT_ERROR` | Meta 側の障害かネットワーク。時間をおく | 3 |
| `TOKEN_FILE_MISSING` / `TOKEN_FILE_UNSAFE` / `TOKEN_FILE_INVALID` | D をやり直す（ファイル 0600・ディレクトリ 0700・どちらも自分の所有・link でない） | 2 |
| `SECRET_FILE_UNSAFE` | `meta-app-secret` を置いた場合だけ。token と同じ条件で置き直す | 2 |
| `META_UNKNOWN_ERROR` | 想定外の応答。時間をおいて 1 回だけやり直し、同じならそこで止める | 3 |

エラーのときは `(graph code N, subcode M)` の数字だけが出る。Meta のエラー文は出さない（相手の情報や token が混ざりうるため）。

## 3. token の期限

- 長期 token は約 60 日で切れる（未確認。C-7 のデバッガーで期限を見られる）
- 切れたら C をやり直して、D のファイルを置き換える
- 使い終えたら、次の順で消す
  1. Meta の「ビジネス統合」でこの App を削除する
  2. `rm ~/.config/sr-design-worker/meta-token` で WSL のファイルを消す
