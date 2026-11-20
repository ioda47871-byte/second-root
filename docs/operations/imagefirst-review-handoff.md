# IMAGE_FIRST の結果を、オーナーのローカル Claude（Remote Control）に読ませる — 受け渡しとダミー PoC（Issue #302 P3）

2026-11-20。Issue #302 P3（オフライン）。**これは承認ではない。** WSL・root・systemd・timer・chmod・外部サービスには何もしていない。
実機での確認はオーナーが §3 の手順で行うまで**未確認**である。ChatGPT 側で画像を見ることは**未達**（§5）。

- 追加したもの:
  - `lib/design-agent/imagefirst-worker/local-inbox.ts` — 既存の転送 interface（`BundleTransport`）の、ローカルの review inbox 版。
    受け手は既存の `transport.ts` の receiver（`verifyBundleDir` で期待する記録と照合 → staging → atomic rename → 同じ SHA は
    `duplicate`、違うバイトは `BUNDLE_ID_CONFLICT`）をそのまま使う。配送の状態機械（`registerSealed` / `deliverBundle`。再送は同じ封入済み
    bundle だけ、Codex は再実行しない）も既存のまま。
  - `lib/design-agent/imagefirst-worker/preview.ts` — 検証済みの bundle から、Claude の Read で表示できる大きさのプレビューと `INDEX.md` を作る。
  - `lib/design-agent/imagefirst-worker/review-poc.ts` と `scripts/sales-design-worker/imagefirst-review-poc.ts` — 無害なダミー画像での PoC。
  - `tests/unit/design-agent/imagefirst-worker/review-handoff.test.ts`
- worker（`cycle.ts`・`imagefirst-worker.ts`）・自動起動・unit は**変更していない**。実際の d3 の run を inbox へ渡す入口は、まだ無い
  （実 run の後に `packBundle` → `handOffToLocalInbox` を呼ぶだけの小さな入口を、承認後に足す）。

## 1. 置き場所の根拠 — jail の中の Claude が実際に読めるもの

| 事実 | 出典 |
|---|---|
| jail の Claude（`sr-jail-claude.service`）は requester ユーザーとして動く: `User=$req` | `scripts/sales-design-capture/admin.sh:126` |
| requester の既定は `sr-designgen`（`claude-start` も同じ） | `admin.sh:485`（`install` は `admin.sh:358`） |
| jail はホームを全部隠し（`ProtectHome=tmpfs`）、requester 自身のホームだけを読み書きで戻す: `BindPaths=$home`、`WorkingDirectory=$home` | `jail/jail.properties:21`、`admin.sh:127-128` |
| `/srv` と `/mnt` は空の読み取り専用（決まった spool と `/mnt/sr-export` だけ戻す）。他人のホームは見えない（probe が `OTHER_HOMES_VISIBLE` を検査） | `jail.properties:34-46`、`jail/probe.py:257-259` |
| Claude の作業ディレクトリは `~/work/second-root`（`claude remote-control` をそこで起動） | `admin.sh:209` |
| IMAGE_FIRST worker も `sr-designgen` として動き、結果を `~/sr-runs`（0700）に置く | `scripts/sales-design-worker/imagefirst-worker.ts:2-3,56`、`imagefirst-autostart.sh:126` |
| worker と jail の Claude は同時に動かない（自動起動は `sr-jail-claude` が active / enabled なら busy で止まる） | `imagefirst-autostart.sh` 冒頭の手順 4、`imagefirst-worker-port.md` §6 |

したがって **inbox は `~/sr-runs/review-inbox/`（`/home/sr-designgen/sr-runs/review-inbox/`）** にした。

- worker と jail の Claude は**同じ uid**。0700 / 0600 のまま、jail の Claude は読め、他のユーザー（helper、bridge）は読めない。
  **chmod・グループ・bind mount・WSL の設定変更は要らない。オーナーの事前設定はゼロ。**
- リポジトリの作業木（`~/work/second-root`）の中の git-ignore された場所にはしなかった。非公開の画像を git の作業木に置くと、
  `git add -f` や広い編集で混ざる危険があり、`.gitignore` にも該当する行が無い（足す利点も無い）。PoC はリポジトリの中の inbox を拒否する。
- `/mnt/sr-export` は使わない（jail の外へ出す用途の場所で、非公開の受け渡しの目的に合わない）。
- 順番: **worker が終わる → 受け渡し（inbox + プレビュー）→ オーナーが `claude-start`**。受け渡しは worker と同じユーザーで、Claude の起動前に行う。
- Claude Code は作業ディレクトリ（`~/work/second-root`）の外のファイルを Read するとき、許可を求めることがある。そのときはオーナーが
  Remote Control の画面で、その 1 ファイル（または `~/sr-runs/review-inbox`）だけを許可する。設定ファイルは変えない。

```
~/sr-runs/review-inbox/<bundle ID>/            受け手が検証し直して rename した bundle（0700 / 0600、元のファイル集合そのまま）
~/sr-runs/review-inbox/.records/<ID>.json       受け手の受け取り時刻と削除時刻（自分の時計と定数。7 日）
~/sr-runs/review-inbox/previews/<ID>/INDEX.md   プレビューの一覧: bundle SHA、各プレビューの元ファイルと元の SHA-256
~/sr-runs/review-inbox/previews/<ID>/*.png      プレビュー（派生ファイル。元の画像は変えない）
```

## 2. プレビューの上限

| 項目 | 値 | 理由 |
|---|---|---|
| 長辺 | ≤ 1568 px | これを超える画像は表示時にどのみち縮められる。控えめな値 |
| 1 枚のバイト数 | ≤ 3.5 MiB | 画像 1 枚あたりの上限（base64 後 5 MB）より十分小さい。可逆 PNG → パレット PNG → 0.8 倍ずつ縮小、の順で収める |
| 縦長の分割 | 幅を合わせた後に高さ > 1568 かつ 縦横比 > 2 なら、縦に分割（重なり 64 px、最大 16 枚）＋全体の縮小図 1 枚 | PC の合成（1440 × 最大 16000）は約 11 枚。境界の文字はどちらかの tile で切れずに読める |
| 入力 | 最大 40 Mpx（bundle の上限と同じ） | |

- プレビューは、bundle を `verifyBundleDir`（期待する承認 ID・plan ID・コミット・bundle SHA）で検証した**同じバイト**から作る。検証の後に差し替えた
  ファイルはプレビューに届かない。inbox の bundle が変わっていれば `BUNDLE_UNVERIFIED` で作らない。
- `INDEX.md` / `INDEX.json` は各プレビューの `source`（`parts/pc-1.png` など）、`source_sha256`（= bundle の `SHA256SUMS` の行）、
  `preview_sha256`、大きさ、tile なら元画像の何行目から何行目か、を持つ。`verifyPreviews` はファイル集合・SHA・大きさ・`INDEX.md` の一致を検める。
- 同じ bundle でもう一度作ると `duplicate`（何も変えない）。ただし `duplicate` と答えるのは、既にあるプレビューが**この bundle の検証済みの
  バイトから作り直したものと完全に一致する**とき（元ファイルのパスと SHA、各プレビューの SHA、ID）だけ。同じ名前で別の bundle SHA なら
  `PREVIEWS_CONFLICT`、SHA の札だけ合わせた別物なら `PREVIEWS_NOT_FROM_BUNDLE`（PR #308 レビュー L1。黙って使い回さない）。
- 2 つが同時に作ると、遅れた方は先の方が確保した空のディレクトリが埋まるのを待ち（最大 10 秒）、同じものなら `duplicate`。
  埋まらなければ `PREVIEWS_BUSY`（L2）。待つ間も毎回、そのディレクトリが自分のもので 0700 であることを確かめる（違えば `PREVIEWS_DIR_UNSAFE`）。
- 作る途中で落ちた（OOM や kill）ときは、空の `previews/<ID>/` が残る。作られてから 120 秒より古い空のディレクトリは待たずに
  `PREVIEWS_STALE_CLAIM` で止まる（PR #309 レビュー L3）。**直し方（手で）**: 中身が空であることを確かめてから、その空ディレクトリだけを消し、
  もう一度作る（ダミーなら PoC をもう一度走らせる）:
  `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- bash -c 'rmdir ~/sr-runs/review-inbox/previews/<ID>'`（`rmdir` は空でなければ失敗するので、中身は消えない）
- inbox からの削除（`removeFromInbox`・保持期限の削除）は、`previews` や `.records` が symlink・他人のもの・0700 でないときは
  何も消さずに `INBOX_SUBDIR_UNSAFE` で止まる（L3）。

## 3. オーナーの確認手順（実機の WSL、ダミー PoC。読むだけで終わらせてよい）

事前: jail が install 済み（`design-capture-helper.md`）。worker も自動起動も旧 design cycle も動いていない（手順 0 で確かめる）。
jail の Claude が worker と同じユーザーであることが §1 の前提なので、手順 0 d) で unit の `User=` が `sr-designgen` であることを確かめる
（`claude-start` は unit の `User=` を書き換えない。`install` に別のユーザーを渡していたら、この受け渡しは成り立たない。PR #308 レビュー L5）。`admin.sh` は root 専用の clone
（`/root/sr-capture-admin`）から実行する（`admin.sh:76-77` が他の場所からの実行を拒否する）。この変更を含む develop と
`node_modules`（`sharp` を含む）が `sr-designgen` の checkout にあること。

```bash
A=/root/sr-capture-admin/scripts/sales-design-capture/admin.sh
# 0) 何も動いていないこと（読むだけ。どれか一つでも違えば、そこで止めて報告する）
#    a) 次の 3 つの service がどれも active でない（3 行とも active 以外。inactive / failed / unknown など）
systemctl is-active sr-jail-claude.service sr-imagefirst-autostart.service sr-design-cycle.service
#    b) 次の 2 つの timer が enable されていない（list-unit-files が「0 unit files listed」、または STATE が disabled / masked）。
#       決め手は次の is-active: 2 行とも active 以外であること
systemctl list-unit-files sr-design-cycle.timer sr-imagefirst-autostart.timer
systemctl is-active sr-design-cycle.timer sr-imagefirst-autostart.timer
#    c) sr-designgen のプロセスが無い
pgrep -u sr-designgen || echo "no sr-designgen process"
#    d) jail の unit が sr-designgen として動く設定であること（User=sr-designgen と 1 行だけ出る。違う・空なら止める）
systemctl show sr-jail-claude.service -p User
sudo bash $A run sr-designgen -- bash -c 'cd ~/work/second-root && git log --oneline -1 && ls -d node_modules/sharp'

# 1) ダミー PoC を sr-designgen として jail の中で 1 回（画像はその場で作る。Codex・ネットワークなし、数秒）
sudo bash $A run sr-designgen -- bash -c 'cd ~/work/second-root && node --import tsx scripts/sales-design-worker/imagefirst-review-poc.ts'
#    出力: inbox と previews のパス、INDEX.md、Claude への質問文、最後に「OWNER ONLY」の答え（6 枚の色・図形・4 桁の数字）。
#    答えはオーナーの端末にだけ出る。Claude のセッションに貼らない。

# 2) jail の Claude を起動（enable もされる。動いている間、自動起動は busy で止まる＝意図どおりの排他）
sudo bash $A claude-start
```

3. Claude アプリ（または claude.ai/code）で、その Remote Control のセッションを開き、PoC が出した質問文をそのまま送る:
   「Read ツールだけを使って、次の 6 ファイルを読み、それぞれの背景色・白い図形・4 桁の数字を答えてください: `/home/sr-designgen/sr-runs/review-inbox/previews/hoshigama-imagefirst-d3-00000000-00/pc-1.png` …」
   作業ディレクトリの外なので Read の許可を求められたら、その場所だけを許可する。
4. **証拠として数えるもの**
   - セッションの記録に、6 つのプレビューのパスへの **Read** の呼び出しがあり、それ以外のコマンド（画像を解析するスクリプトなど）を使っていない。
   - Claude の答えが、手順 1 の「OWNER ONLY」の 6 行と**全部一致**する（色・図形・数字）。答えはどのファイルにも書かれていないので
     （テストで固定）、一致は画像を見たことを意味する。
   - 記録すること: 日時、一致した枚数、許可を求められたか。画面の写しを撮るならオーナーの手元に置く（GitHub や外部へ上げない）。
   - 別に観察すること: Read した画像そのものが、オーナーのアプリの画面にも表示されたか。これは「Claude が見られる」とは別の事実で、
     表示されなくても (a) は成立する。
5. 片付け:

```bash
sudo bash $A claude-stop
sudo bash $A run sr-designgen -- bash -c 'I=~/sr-runs/review-inbox; D=hoshigama-imagefirst-d3-00000000-00; rm -rf "$I/$D" "$I/.records/$D.json" "$I/previews/$D"'
```

うまくいかないとき: Claude が「読めない」「権限がない」と答えたら、その文言を記録して止める。**chmod や jail の設定を変えて通さない。**
ダミーの ID は日付 `00000000` で、本物の承認 ID と衝突しない。これは約束ではなくコードで強制している（PR #308 レビュー L4）:
worker（`cycle.ts` の cycle と precheck）・承認の claim・自動起動の grant は、日付 `00000000`・暦に無い日付・2000 年より前の年の承認 ID を拒否する
（`checkRealApprovalId` が `APPROVAL_ID_RESERVED` / `APPROVAL_ID_INVALID` を返し、grant の経路では worker が `GRANT_INVALID` で止まる。テストで固定）。
自動起動の run marker の検査（`imagefirst-autostart.sh` の MARKER_PY）が見るのは日付 `00000000` だけ。暦に無い日付（例 `20261399`）の marker は
その検査を通るが、続く worker の `--precheck` が `GRANT_INVALID`（exit 2）を返し、自動起動は `AUTOSTART_IDLE_NOT_RUNNABLE`（exit 10）で終わる。
承認は使われず marker も残るので、以後の poll は毎回同じ結果で止まる。**オーナーがその marker を手で消すまで続く**（PR #309 再レビュー L-1）。ローカルの受け渡し（`local-inbox.ts`）そのものはこの ID を受け付ける（このダミー PoC が使うため）。PoC をもう一度走らせると、inbox のダミーだけを置き換える。

## 4. 本物の run での流れ（承認の後。いまは入口なし）

worker の 1 回の run が `succeeded` で終わる → 同じ `sr-designgen` で `packBundle`（`~/sr-runs/bundles/`）→ `handOffToLocalInbox`
（期待する記録 = §10 の承認 ID・plan ID・コミット）→ プレビュー → オーナーが `claude-start` → Claude が `INDEX.md` とプレビューを Read して評価。
失敗した受け渡しは同じ bundle の再送だけ。Codex の再実行・再生成は無い。自動の公開も無い。

## 5. 状態のまとめ

### (a) Claude 側で画像を見られるか — 実装済み・**実機では未確認**

- 実装とオフラインのテスト（PoC の E2E、冪等・衝突・改ざんの拒否、上限、権限 0700 / 0600、import の固定）はこの変更で済んでいる。
- 開発用のクラウドのコンテナで、PoC が作ったプレビューを Claude Code の Read で開き、色・図形・数字が読めることは確かめた。
  ただしこれは**Remote Control でもオーナーの WSL でもない**。「プレビューの形式は Claude の Read で表示できる」ことの補強にすぎない。
- **オーナーの WSL 上の jail の Claude が Remote Control のセッションで読めるかは、§3 をオーナーが行うまで未確認。**

### (b) ChatGPT 側で画像を見られるか — **未達**

この会話（ChatGPT）は Claude の Remote Control とは別のサービスで、「Claude 側で見える」は「ChatGPT 側で見える」を意味しない。
リポジトリにも WSL にも、ChatGPT へ画像を渡す仕組みは無い。何も設定していない。現実的な選択肢（どれもオーナーの別承認が要る。ChatGPT が
その経路の**画像ファイル**を実際に読めるかは、どれも**要確認**）:

| 案 | 要るもの | 費用 | ChatGPT が画像を読めるか | 注意 |
|---|---|---|---|---|
| オーナーが手で添付 | Windows のエクスプローラーで `\\wsl$\<distro>\home\sr-designgen\sr-runs\review-inbox\previews\…` を開き、ChatGPT にドラッグ | なし | **はい**（通常の画像添付） | 自動ではない。いま設定なしで使える唯一の経路 |
| Google Drive を ChatGPT の connector で接続 | WSL から Drive へ送る手段（同期クライアントや rclone 等＝新しい道具と、WSL に置く資格情報）、ChatGPT 側の connector の接続 | 無料枠あり（容量次第で有料） | 要確認（connector は文書が主。画像の取り込みは実地で確かめる） | 画像が第三者のサービスへ出る。書き込み用の資格情報と、読み取りの許可・期限を分ける設計が要る |
| Dropbox を connector で接続 | 同上 | 無料枠あり（容量は小さい） | 要確認 | 同上 |
| 非公開のストレージ（Supabase の専用 bucket、S3 / R2 など）と署名つき URL | 新しい bucket・設定・資格情報、場合により依存の追加 | 従量（小さい） | 要確認（ChatGPT は認証つきの URL を自分では開けない。署名つき URL は「知っていれば誰でも読める」リンク） | 新サービス・課金・資格情報の承認。`imagefirst-private-return.md` §3 |

## 6. テスト

```
npx vitest run tests/unit/design-agent/imagefirst-worker
```
