# IMAGE_FIRST: オーナーの承認を誰も偽造できない形で root に届ける（設計案、Issue #302）

状態: **設計案（未実装）**。実装は OWNER MERGE ONLY の別 PR。この文書は境界を何も変えない。

経緯: 2026-11-22 に GitHub での本人承認（C 案）を採る方向になり、専用の承認者アカウントを推奨した。2026-11-23 にオーナーから、
GitHub の利用規約では 1 人の無料アカウントは原則 1 つ（例外は自動処理専用の machine account）との指摘があり、専用アカウントの作成を保留、
パスキーなどの署名方式との比較を求められた。本版はその比較と、新しい推奨（パスキーの署名 + 承認ブランチ）である。

## 0. 目的と要件

- 目的: 毎回 WSL を触らず、オーナーが**スマホでの承認操作だけ**で、生成 → 監査 → 研究ログ保存まで進む。操作は少ないほどよいが**安全を優先**。
- 要件:
  1. Claude 以外の連携も含め、**オーナーの GitHub 権限を使っても承認を偽造できない**。
  2. 通常の開発（develop）は Claude が自律的に統合し、**画像生成に使う commit だけ**オーナーの承認が必須。
  3. GitHub の利用規約に適合する（追加の無料アカウントを人が使わない）。
- 守ること（緩めない）: 1 パケット = 1 承認 ID = 1 回、再試行・延長・再利用なし、期限はパケット §10 だけ、未承認・期限切れ・方向の取り違えは
  claim の前に止まる、Claude（jail の sr-designgen）は root にならず、root の設定・timer・状態に書けない。

## 1. 承認は 2 つのものを信じている

今の承認コマンド（`fetch` → `checkout --detach origin/develop` → `imagefirst-approve.sh <ID>`）で、オーナーは
**実行の承認**（このパケットで 1 回）と、**コードの信頼**（その commit の木全体を root と worker として動かす）を同時に認めている。
特定のパスだけを守ると、root と worker が実際に動かすコードは import と依存を辿って広がり漏れる（#327 レビュー 1 回目の Critical 2 件）。
したがって承認は **ある 1 つの commit C の木全体**に付け、root は C だけを動かす。コードについての承認は、今の承認コマンド
（その時点の develop を丸ごと信じる）と同じ水準であり、それ以上の保証はしない（スマホで全部の差分は読めない）。

## 2. GitHub の利用規約（2026-11-23 に確かめた。法的な助言ではない）

GitHub Terms of Service B.3（2026-04-27 版）:

- 「One person or legal entity may maintain no more than one free Account」。
- machine account は認められるが「used exclusively for performing automated tasks」。「no more than one free machine account in addition to your free Personal Account」。
- 数の上限はどれも「free」の口座について書かれている。有料の 2 つ目を明示的に認める文も、禁じる文も無い。

したがって:

| 案 | 規約 |
|---|---|
| 人が手で承認だけに使う 2 つ目の無料アカウント（前の版の (iii)） | **不適合**（自動処理ではないので machine account に当たらない） |
| Claude だけが使う machine account（PR・push を自動で行う） | 適合（人が作り、規約に同意し、責任を持つこと） |
| 2 つ目の有料アカウントを承認者にする | 規約の文言上は上限の外だが明示の許可も無い。推奨しない |

## 3. 方式の比較（要件 1・3）

| 案 | 毎回の操作 | 偽造できない根拠 | 判定 |
|---|---|---|---|
| G1. オーナーの普段のアカウントで GitHub の承認 | GitHub アプリで Approve（1〜2 タップ） | 無い。Claude と、オーナーの token を持つすべての連携（OAuth・GitHub App のユーザー token、git の proxy、connector、Vercel 等）が承認を作れる。API では区別できない | **不可**（要件 1） |
| G2. 専用の人の承認者アカウント | 同上 | どの連携もその資格情報を持たない | **不可**（要件 3） |
| G3. Claude を machine account にし、普段のアカウントで承認 | 同上 | Claude は防げるが、ほかの連携は防げない | 不十分（要件 1） |
| **P. iPhone のパスキー（WebAuthn）で「承認 ID・期限・commit・パケット」に署名し、root が公開鍵で検証** | Claude アプリのリンクを開く → 内容を見て「承認して署名」→ Face ID → 「コピー」→ Claude アプリに貼って送る（約 4 操作） | 秘密鍵は iPhone（iCloud キーチェーン）の外に出ない。署名は内容に結びつく。GitHub の権限はどれも信頼の経路に入らない | **推奨** |
| S. iPhone の a-Shell（`ssh-keygen -Y sign`）で同じ文に署名 | 文を貼って 1 行実行 → 署名を貼る | 鍵は端末の中（ハードウェアの鍵ではない）。署名するページが要らない | 代わりの案（ページを置きたくない場合） |
| F. PC のセキュリティキー / Windows Hello で署名 | PC での操作 | 強い | 目標（スマホだけ）に合わない |

**推奨は P**。GitHub のアカウントを増やさず（要件 3）、GitHub のどの権限でも偽造できない（要件 1）。操作は G1 より 2〜3 手多いが、安全を優先する。

## 4. 推奨案 P の仕組み

### 4.1 署名する文（正準形）

UTF-8、改行は LF、最後に改行。値は固定の書式だけ:

```
sr-imagefirst-approve/v1
id=<承認 ID>
expires=<§10 の期限、UTC の ISO 8601>
commit=<C の 40 桁>
packet_sha256=<C の中のパケットのファイルの SHA-256>
```

WebAuthn の challenge = この文の SHA-256（32 バイト）。WebAuthn の署名は `authenticatorData || SHA-256(clientDataJSON)` に対する ES256（DER）で、
clientDataJSON に challenge・origin・type が入るので、署名はこの文と署名ページの origin に結びつく。challenge は乱数ではないが、
文に一度しか使えない承認 ID が入り、root が `used/<ID>` で再利用を拒むので、再送（replay）は通らない。

### 4.2 署名ページ（信頼できる表示）

署名する前にオーナーが見る内容は、**署名される内容と同じでなければならない**。パスキーの画面は Face ID だけで中身を見せないので、
ページそのものが信頼の一部になる。だから:

- ページは 1 枚の静的な HTML（外部の script・通信なし。WebCrypto で文の SHA-256 を計算し、`navigator.credentials.get` を呼ぶだけ）。
  ソースはこのリポジトリに置き、レビューする。
- **置き場所は、Claude とオーナーの GitHub の連携が書けない場所**にする（4.5 で比較）。root は毎回そのページを取得し、
  レビュー済みの SHA-256 と一致しなければ凍結する（すり替えの検出）。
- ページは URL の `#` 以降（サーバーに送られない）から値を読み、書式を検査し、ID・期限（JST でも表示）・commit（全桁）・パケットの SHA-256 を大きく表示する。
- 署名の結果（authenticatorData・clientDataJSON・signature・credential id）を 1 つの文字列にまとめ、コピーのボタンを出す。
- WebAuthn は origin に結びつく。偽のドメインのページは本物の RP ID の署名を作れず、root も origin を確かめるので、Claude が偽のリンクを送っても通らない。

### 4.3 一度だけの準備（オーナー）

1. 署名ページを 4.5 の置き場所に置く（レビュー済みのファイルをそのまま。SHA-256 を root に固定）。
2. パスキーを登録する: 登録のページを開き（iPhone、または PC のブラウザで iPhone を使う）、表示された公開鍵（PEM）と指紋を、
   **オーナーが WSL の root で直接**登録する（Claude を経由しない。経由すると Claude が鍵をすり替えられる）。
   root は公開鍵の指紋を表示し、オーナーはページの表示と一致を確かめる。
3. 承認ブランチ `imagefirst/approved` を作る（force push・削除の禁止だけ。承認の要件は付けない。root はこれに頼らない）。

### 4.4 毎回の流れ

1. Claude が新しいパケット（新しい承認 ID）を develop に作る（§10 は承認待ち。今まで通り自律マージ）。
2. Claude が `imagefirst/approved` に実行用の commit C を作る（develop の取り込み + §10 を「承認済み」にする 1 commit）。
   承認済みの §10 は承認ブランチにしか無いので、develop の自律マージから実行は生まれない（要件 2）。
3. Claude が Claude アプリに、レビューページ（前回との比較・プロンプト・6 枚の内訳・上限）と、署名ページのリンク（`#` 以降に 4.1 の値）と、
   GitHub の差分のリンク（前回の承認からの比較）を出す。
4. **オーナーが署名ページで内容を見て「承認して署名」→ Face ID → コピー → Claude アプリに貼って送る**。
5. Claude が署名を `~/sr-runs/approvals/<ID>.json` に置く（Claude が中継しても、署名は作れない・変えられない）。
6. root の timer が検証し（4.6）、通れば C に固定して claude-stop → 生成 1 回 → 監査 → claude-start（#325 / #326 のまま）。
7. 次のセッションで Claude が inbox を読み、研究ログ（develop）に記録してレビューページを出す（#324）。

### 4.5 署名ページの置き場所

| 置き場所 | Claude・連携が書けるか | 判定 |
|---|---|---|
| オーナーの GitHub Pages（`<user>.github.io`） | 書ける（Claude の今の token、連携の token）。root の SHA-256 の照合で後から気づけても、承認の間だけ差し替えて戻す攻撃が残る | 推奨しない |
| claude.ai の Artifact | Claude が書く。さらに WebAuthn は別 origin の iframe では既定で使えない | **不可** |
| **GitHub と連携していない静的ホスティング（例: Cloudflare Pages の手動アップロード）。オーナーだけがログインできる** | 書けない（資格情報を Claude も連携も持たない） | **推奨**。オーナーのアカウントが 1 つ増えるが、GitHub の規約とは無関係 |
| ページを置かない（案 S） | — | 代わりの案 |

置き場所を決めるのはオーナー。どこでも、root はページの SHA-256 を毎回照合し、違えば凍結する。

### 4.6 root の検証器

- 検証器は **root の持ち物の固定の場所**（例 `/usr/local/lib/sr-imagefirst/`）に置き、unit はそれを動かす。リポジトリから自分を更新しない。
- root だけの設定 `/etc/sr-design-worker/approval-relay.json`（0600 root）: パスキーの公開鍵（PEM）と credential id、RP ID、origin、
  署名ページの URL と SHA-256。状態 `/var/lib/sr-imagefirst-autostart/`（root の 0700）。
- 検証（全部満たさなければ何もしない。FAIL CLOSED）:
  1. 署名ページを取得（`curl` は proxy の環境変数を無視、https だけ、大きさの上限）し、SHA-256 が固定値と一致。違えば凍結して知らせる。
  2. `~/sr-runs/approvals/` の署名のファイルを**信頼しない入力として**読む（通常のファイル・リンクでない・8 KiB 以下、root の持ち物の
     `python3 -I` の標準ライブラリで厳密に解析）。
  3. clientDataJSON: `type = "webauthn.get"`、`origin` = 固定値、`crossOrigin` が true でない、`challenge` = 4.1 の文の SHA-256（base64url）。
  4. authenticatorData: rpIdHash = SHA-256(RP ID)、UP と UV のビットが立っている、AT は立っていない。credential id が固定値。
  5. 署名: root の持ち物の `openssl dgst -sha256 -verify <公開鍵> -signature <DER> <authenticatorData || SHA-256(clientDataJSON)>` が成功。
  6. 文の値: root の admin clone で `imagefirst/approved` を fetch し、`commit` = C が承認ブランチの先端から辿れる。C のパケットの §10 が承認済みで、
     ID と期限が文と一致、期限が未来で 24 時間以内、`packet_sha256` が C の中のファイルと一致。ID は未使用（`used/<ID>` と `autorun/<ID>/attempt` が無い）。
     パケットのパスは、C の中の対応表（JSON。worker の `approval-packets.ts` と一致をテストで固定）が ID の方向に割り当てたもので、
     検証器が自分の中に持つ形（`docs/design/image-first-<店>-<方向>-packet.md`）に合うこと。
  7. 通ったら C に固定し、印を書いて autorun → pilot に渡す（pilot は C を SHA で新しく clone する）。以後、生きているブランチは見ない。
- 止まったときは、理由のコードだけを root の状態に書き、worker が読める写しを別に置く（Claude が次のセッションでオーナーに伝える）。
  凍結の解除はオーナーの root の操作だけ。
- root が使うのは git・curl・openssl・`python3 -I`（どれも root の持ち物。この WSL には jq が無い）。sr-designgen のコードは何も動かさない。
  **GitHub の API は使わない**（信頼の経路に GitHub の権限が入らない）。
- 実装の前に確かめること: iPhone の Safari で、選んだ置き場所の origin でパスキーの登録と署名ができること（RP ID がその origin の登録可能なドメイン）、
  同期されたパスキーの signCount が 0 のままでも検証が成り立つこと（signCount は使わない）、openssl で ES256 の DER 署名を検証できること
  （テストで本物の形の値を使う）。
- 承認コマンド `imagefirst-approve.sh` は**手動の代わりとして残す**。

## 5. 脅威ごとの確認

| 脅威 | 止める仕組み |
|---|---|
| Claude・連携がオーナーの GitHub 権限で承認を作る | GitHub は信頼の経路に無い。承認はパスキーの署名だけ |
| Claude が署名を作る・変える | 秘密鍵は iPhone の外に出ない。署名は文（ID・期限・commit・パケット）と origin に結びつく |
| 偽のページ・偽のリンク | WebAuthn は origin に結びつく。root が origin と RP ID を確かめる |
| 署名ページのすり替え（見せる内容と署名する内容のずれ） | 置き場所を Claude・連携が書けない所にする。root が毎回ページの SHA-256 を照合し、違えば凍結 |
| 公開鍵のすり替え | 登録はオーナーが WSL の root で直接。指紋をページと照合 |
| 署名の使い回し（replay） | 文に一度だけの ID。`used/<ID>`・`autorun/<ID>` は消さない |
| root・worker のコードの差し替え | 署名は C の木全体に付き、root は C だけを動かす |
| develop の自律マージから実行が生まれる | 承認済みの §10 は承認ブランチにしか無く、署名も C に付く |
| ブランチを動かして承認を潰す | C に固定し、生きているブランチと比べない |
| 署名のファイルで root を攻める | 大きさの上限・リンク拒否・標準ライブラリの厳密な解析・一時ファイルは root の 0700 |
| 検証器が自分を更新する | root の固定の場所。リポジトリから更新しない |
| iCloud のアカウントの乗っ取り | 本案の外（Apple ID の 2 段階認証、端末のロック） |

## 6. 移行の段階

1. **段階 0（今の自動化）**: #325（マージ済み）→ #326 → #328 をオーナーがマージ。#328 の `check` → `apply` → `enable-timer`（それぞれ別の承認）。
   新しいパケットで承認コマンド 1 行の自動実行を 1 回確かめる。
2. **段階 1**: 署名ページ・登録ページ・検証器を実装（OWNER MERGE ONLY）。偽の WebAuthn の値（テスト用の P-256 鍵で作る本物の形の値）でテスト。
3. **段階 2（オーナーの一度だけの準備）**: 置き場所を決めてページを置く、パスキーの登録（WSL の root で 1 回）、検証器の設置（#328 と同じ形の setup の手順に追加）。
4. **段階 3**: 承認コマンドを使わず、署名だけで 1 回の自動実行を確かめる。

Claude の machine account への切り替え（規約に適合）は、要件 1 には不要。最小権限として後から検討する。

## 7. オーナーに決めてほしいこと

1. 案 P（パスキーの署名）+ 承認ブランチで確定してよいか。
2. 署名ページの置き場所（推奨: GitHub と連携していない静的ホスティング。または案 S）。
3. 段階 0 の root の操作をいつ行うか（それぞれ別に確認と承認をもらう）。
