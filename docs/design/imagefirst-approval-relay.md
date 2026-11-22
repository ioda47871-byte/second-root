# IMAGE_FIRST: オーナーの承認を Claude が偽造できない形で root に届ける（設計案、Issue #302）

状態: **設計案（未実装・オーナーの判断待ち）**。実装は OWNER MERGE ONLY の別 PR。この文書は境界を何も変えない。

## 0. 目的と前提

- 目的: オーナーが毎回 WSL の root で `imagefirst-approve.sh <ID>` を打つ操作をなくし、Claude アプリから辿る **1 回の承認操作**だけで
  生成 → 監査 → 研究ログ保存まで進むようにする。
- 守ること（緩めない）: 1 パケット = 1 承認 ID = 1 回、再試行・延長・再利用なし、期限はパケット §10 だけ、未承認・期限切れ・方向の取り違えは
  claim の前に止まる、Claude（jail の sr-designgen）は root にならず、root の設定・timer・承認の印に書けない。
- 前提とする自動化: PR #325（timer・autorun）と #326（設定の信頼境界）。この文書は、その中の「root の承認コマンド」だけを置き換える。

## 1. 今の信頼の穴（先に塞ぐ必要があるもの）

2026-11-22 に確かめた事実: **jail の Claude が使う GitHub の token はオーナー本人のアカウント（`ioda47871-byte`）のもの**である。

このため、GitHub の上で「オーナーがした」ように見えること（PR の承認・マージ・コメント）は、すべて Claude にも作れる。
「OWNER MERGE ONLY」は今は運用の約束であって、技術的な壁ではない。具体的には:

1. **Claude アプリの会話**: Claude が読み、Claude が中継する。会話の中の「承認します」を root に渡す経路は、どれも Claude が作れる。
2. **claude.ai の Artifact の共有データ**: Claude もオーナーとして書ける（`ArtifactData` は利用者として書く）。
3. **GitHub のマージ・レビュー**: 上の通り、同じアカウント。
4. **root が実行するコード**: autorun の unit は `/root/sr-capture-admin` の develop の `imagefirst-autorun.sh` を root で動かす。
   承認コマンドの 1 行目（`fetch` + `checkout origin/develop`）が、今は「その時点の develop を root で信じる」というオーナーの判断を兼ねている。
   承認コマンドをなくして root が develop に自動で追従すると、**develop にマージできる者 = root のコードを書ける者**になり、上の 3 によって
   Claude がそれに当たる。

したがって「承認コマンドをなくす」前に、**Claude の GitHub の身元をオーナーから分ける**ことが必須である（§3 段階 1）。

## 2. 方式の比較

| 案 | オーナーの操作 | 偽造できない根拠 | 判定 |
|---|---|---|---|
| A. Claude アプリの会話・ボタンだけ | アプリで「承認」 | なし（Claude が中継・同じアカウント） | **不可** |
| B. TOTP（認証アプリの 6 桁）をアプリに打つ | アプリで 6 桁 | 秘密は root だけが持つ。ただし 6 桁は中身（どのパケットか）に結びつかず、表示も Claude 経由なので、Claude が別のパケットに使い回せる | 単独では**不可** |
| C. **GitHub の身元の分離 + オーナーの GitHub 承認を root が API で確かめる** | Claude アプリのリンクから GitHub アプリで PR を「Approve」して マージ（1〜2 タップ） | Claude の token は別の身元で、ruleset により保護したパスへの承認・マージができない。root は自分の読み取り専用 token で GitHub の記録（数値の user id、承認した commit）を確かめる | **推奨** |
| D. オーナーの署名鍵（FIDO2 のセキュリティキー / Windows Hello の `ssh-keygen -Y sign`）| 署名した 1 行をアプリに貼る | 鍵は WSL の外、署名は「ID + パケットの SHA-256 + 期限」に結びつく。root が公開鍵で確かめる | 補助案（GitHub に頼らない。操作は C より重い） |

**推奨は C**。今の「パケットの PR をオーナーがマージする」という流れのまま、それを技術的な承認にする。毎回の操作は GitHub アプリでの承認とマージだけで、
WSL には触らない。D は、GitHub が使えないときや、GitHub を信頼の根拠にしたくない場合の代わりとして残す。

## 3. 推奨案 C の段階

### 段階 0: 今の自動化を安全に動かす（承認コマンドは残る）

1. #324（inbox-scan）を通常の規則でマージ。
2. オーナーが #325 → #326 の順にマージ（OWNER MERGE ONLY。#326 は #325 のマージの後に base を develop に変え、差分と CI を確かめ直す）。
3. 一度だけの root の操作（それぞれ安全確認とオーナーの明示承認）: `claude`・`codex` を root の持ち物として入れ直す、
   `/etc/sr-design-worker/codex-config.toml` の配置、`imagefirst-autorun.md` §2 の確認、timer の有効化。
4. 新しいパケット（新しい承認 ID）で、承認コマンド 1 行の自動実行を 1 回確かめる。

### 段階 1: Claude の GitHub の身元をオーナーから分ける（オーナーの GitHub での操作。WSL の root 操作は token の差し替え 1 回）

- Claude 用の別アカウント（machine user）を作り、collaborator（Write）にする。jail の `gh` の token をその fine-grained token に差し替える
  （今まで通り `admin.sh run sr-designgen -- gh auth login --with-token`、標準入力）。オーナーの token は jail から消す。
- develop の ruleset（オーナーが GitHub の Settings で作る。bypass は無し、またはオーナーだけ）:
  - develop への直接 push 禁止、PR 必須、必須 CI。
  - **Code owners のレビュー必須**、新しい push で古い承認を取り消す、最後の push をした人以外の承認が必要。
- `.github/CODEOWNERS`（OWNER MERGE ONLY の PR）で、次をオーナー（`@ioda47871-byte`）の持ち物にする:
  `scripts/sales-design-worker/**`、`lib/design-agent/imagefirst-worker/**`、`lib/design-agent/worker/**`、
  `scripts/design-artifact/**`、`docs/design/image-first-*-packet.md`、`.github/**`、`CODEOWNERS` 自体。
- 結果: 承認パケット・root が動かすスクリプト・worker の守りのコードは、オーナーの GitHub の承認なしに develop に入らない。
  Claude の自律マージ（保護していないパス）は今まで通り動く。

### 段階 2: root の検証器（OWNER MERGE ONLY の PR + 一度だけの設置）

timer の中で、`imagefirst-approve.sh` の印の代わりに、root が GitHub の記録から承認を確かめて **root 自身が印を書く**。

- root だけが読める設定 `/etc/sr-design-worker/approval-relay.json`（0600 root）: オーナーの**数値の** user id、リポジトリ、
  承認を受け付けるパケットのパスの形。読み取り専用の fine-grained token（Contents・Pull requests・Metadata の read だけ）は
  `/etc/sr-design-worker/github-read-token`（0600 root）。どちらも jail からは読めない・書けない。
- 検証（全部満たさなければ印を書かない。API の失敗・形の違いは何もしないで終わる。FAIL CLOSED）:
  1. root の admin clone を、**検証器自身は動かさずに** `ls-remote` で develop の commit C を得る。
  2. C のパケットの §10 が承認済みで、ID が未使用（`used/<ID>`・`autorun/<ID>` が無い）、期限が未来で §10 の値そのもの。
  3. GitHub API: パケットのファイルを最後に変えた PR が develop にマージ済みで、`merged_by.id` = オーナーの id、
     その PR の head の commit に対するオーナーの `APPROVED` のレビューがある（`commit_id` = head）。その後パケットは変わっていない。
  4. 同じく API の `GET /repos/{owner}/{repo}/rules/branches/develop` で、段階 1 の規則（PR 必須・Code owners のレビュー）が
     今も有効であること（外されていれば止める）。
  5. root が動かすスクリプト（`scripts/sales-design-worker/**`）について、C までの最後の変更がオーナーの承認つきの PR であること
     （3 と同じ確かめ方）。違えば止める。
- root が使うのは curl と、JSON の解析に root の持ち物の `python3 -I`（標準ライブラリだけ。この WSL には jq が無い）。
  sr-designgen のコードは何も動かさない（今の規則と同じ）。
- 承認コマンド `imagefirst-approve.sh` は**手動の代わりとして残す**（検証器を外す・GitHub が使えないとき）。

### 段階 3: Claude アプリの流れ

1. Claude が新しいパケットの PR を作り、Claude アプリにレビュー用のページ（前回との比較・プロンプト・6 枚の内訳・上限）と PR のリンクを出す。
2. オーナーが GitHub アプリで PR を Approve してマージする（これが実行の承認。Claude には作れない）。
3. timer が検証 → 印 → claude-stop → 生成 1 回 → 監査 → claude-start（#325 / #326 のまま）。
4. 次のセッションで Claude が inbox を読み、研究ログに記録してレビューページを出す（#324）。

## 4. 脅威ごとの確認

| 脅威 | 止める仕組み |
|---|---|
| Claude が承認を作る | Claude の token はオーナーではない。ruleset でパケットのパスに承認・マージできない。root は数値の id で確かめる |
| Claude が承認後にパケットを書き換える | 新しい push で承認が消える。root は「最後の変更」の PR を確かめる |
| Claude が root のスクリプトを書き換える | CODEOWNERS + ruleset。root は段階 2 の 5 で確かめる |
| Claude が root の設定・token を読む/書く | `/etc/sr-design-worker` は root の 0700、jail からは見えない（今の境界のまま） |
| 承認の使い回し・再試行 | `used/<ID>`・`autorun/<ID>` は消さない（今のまま）。再武装は新しいパケットだけ |
| GitHub の障害・API の改ざん応答 | 失敗は何もしない。TLS で GitHub に直接。応答の形が違えば止める |
| オーナーの token の流出 | 段階 1 で jail からオーナーの token を消す。root の token は読み取り専用 |

## 5. オーナーに決めてほしいこと

1. 推奨案 C で進めてよいか（D を併せて用意するか）。
2. Claude 用の別の GitHub アカウントを作れるか（作れない場合、GitHub App という方法もあるが設置は重い）。
3. 段階 1 の CODEOWNERS の範囲（上の一覧で足りるか）。
4. 段階 0 の一度だけの root の操作をいつ行うか（それぞれ別に確認と承認をもらう）。
