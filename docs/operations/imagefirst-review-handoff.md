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
- 追記（Issue #302 P3 の続き）: 本物の run を inbox へ渡す入口 `lib/design-agent/imagefirst-worker/deliver-review.ts` を足した（§4）。
  自動起動の script・unit・timer は**変更していない**。

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
  埋まらなければ `PREVIEWS_BUSY`（L2）。
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
#    b) 次の 2 つの timer が install も有効化もされていない（list-unit-files が「0 unit files listed」か STATE が disabled、
#       is-active が 2 行とも active 以外）
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
worker（`cycle.ts`）・承認の claim・自動起動の grant・受け渡しは、日付 `00000000`（と暦に無い日付）の承認 ID を拒否する（`APPROVAL_ID_RESERVED`）。PoC をもう一度走らせると、inbox のダミーだけを置き換える。

## 4. 本物の run での流れ（Issue #302 P3 の続き。オフラインで実装・テスト済み、実機では未実施）

実画像の生成そのもの（実 Codex、PR #300 の承認パケット、timer の設置）は、どれも**別のオーナー承認**が要り、この変更では何もしていない。

**入口は worker の CLI（`scripts/sales-design-worker/imagefirst-worker.ts`）の末尾。** cycle（`runImagefirstCycle`）が `succeeded` を返した
ときだけ、同じプロセス・同じ `sr-designgen` のまま `deliverAfterRun`（`deliver-review.ts`）を呼ぶ:

1. 承認 ID が本物の形（日付 `00000000` のダミーと暦に無い日付は拒否）
2. worker のロック（`imagefirst.lock`。cycle が外した後に取り直す）
3. `~/sr-runs/<承認 ID>-<UTC>.receipt.json` がちょうど 1 つ。0600・自分のもの・link でない。cycle が報告した receipt と同じもの
4. receipt が `succeeded`・`verified`・`interrupted: false`・PC 2 + SP 4・停止 0、ほし窯 d3、plan SHA / prompt SHA / 文字数が固定の許可表どおり
5. **receipt のコミットにある承認パケット**を、worker と同じ読み手（`readApprovalPacket` と `packetPins`。新しい parser は作らない。`cycle.ts`
   の `readApprovalAt`）で読む: 承認済み・d3 だけ・承認 ID が receipt と同じ・plan ID が同じ・パケットの SHA が同じ・§3 の pin が同じ・
   run の開始が承認の期限内（期限より後、24 時間の窓より前なら `RUN_NOT_IN_APPROVAL_WINDOW`）。その前に、receipt のコミットが worker の
   clone で **origin/develop に含まれる**こと（`git merge-base --is-ancestor`。違えば `COMMIT_NOT_ON_ORIGIN_DEVELOP`）。最後に、worker 自身の
   **claim の印**（`<state>/claims/<承認 ID>.used`）があり、承認 ID と時刻が receipt と合うこと（読むだけ。`CLAIM_MISSING` / `CLAIM_MISMATCH`）。PR #310 レビュー M2
6. `packBundle`（各画像の SHA-256 を receipt と照合、link 拒否、0700 / 0600、`~/sr-runs/bundles/<承認 ID>/`。一時ディレクトリに書いて 1 回の
   rename で置く: 空や書きかけの bundle は残らない）。既に封入済みなら作り直さず、検証し直して**同じ receipt のバイトから作ったもの**であることを
   確かめる（`SEALED_BUNDLE_MISMATCH`）。パスは実パスで比べる（ホームが symlink 経由でもよい。L1）
7. `handOffToLocalInbox`（受け手が承認の記録で検証し直す → atomic rename → プレビューと `INDEX`）

**run の結果の 1 行（stdout）は受け渡しの前に出す**（PR #310 レビュー M1）。止める合図が来ていれば受け渡しはしない、受け渡し中に来れば中止する
（封入済みなら bundle は残り、下の再送で直る）。受け渡しの結果（`delivered` / `duplicate` / `not_delivered` / `refused`、コードだけ）は
stderr と worker の `audit.jsonl` にだけ書き、stdout は 1 行のまま（自動起動はその最後の行を読む）。**worker の終了コードは変えない**。

ロック: cycle が worker のロックを外してから受け渡しが取り直す。その間に手で worker を起動していると受け渡しは `REVIEW_LOCKED` になる。
そのときも下の再送で直す（L3）。

**なぜここか（自動起動の script ではなく）**: (a) worker と同じユーザー・同じ場所（`~/sr-runs`）で、権限の境界を一つも増やさない。root の
script が worker のファイルを読む道を作らない（自動起動の方針「root は worker のファイルに git も node も parser も使わない」を守る）。
(b) 手で動かした run（§5 の手順）にも同じように効く。(c) worker の排他の中にある: 自動起動は `sr-jail-claude` が止まっていて
disabled / masked のときだけ worker を起動するので、受け渡しの間に jail の Claude は動いていない。(d) `deliver-review.ts` は cycle を
呼ばず、プロセスを起動できない（`runBounded`・入口・Codex・画像の道具を import しない。テストで固定）。claim を作らず、入口の ledger
に触れない。

**失敗したとき**: 封入済みの bundle は残り、配送の状態は `sealed`。オーナーが**同じ bundle だけ**を、root の再送 wrapper で送り直す
（PR #310 レビュー H1。`admin.sh run` は jail の中で動き、jail には /run もシステムバスも無いので、そこからは systemd の状態を確かめられない）:

```bash
# WSL の root で。root 専用の admin clone から（何も install・enable しない。jail の Claude は止めて disabled のまま）
sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-deliver-review.sh <承認 ID>
```

wrapper（`scripts/sales-design-worker/imagefirst-deliver-review.sh`）は自動起動と同じ規則で確かめる: 承認 ID の形（`00000000` は拒否）、
自動起動の lock と design cycle の lock を持つ、`busy()`（自動起動のものと一字一句同じ。テストで固定）= `sr-jail-claude` と `sr-design-cycle`
が inactive / failed、`sr-jail-claude` が disabled / masked、`sr-designgen` のプロセスが無い（＝worker のロックを持つ者がいない）。次に
worker の専用 clone（`~/imagefirst/second-root`、worker が走るのと同じ場所）がきれいで HEAD = origin/develop（読むだけ。fetch も checkout も
しない。M3）。最後に自動起動と同じ `setpriv` で `sr-designgen` に落とし、**jail の外で** `imagefirst-worker.ts --deliver-review <承認 ID>` を 1 回だけ。
`--deliver-review` は cycle を動かさず、claim も ledger も使わず、何も起動しない。自分でも HEAD = origin/develop・きれいな tree、jail の状態
（`/usr/bin/systemctl` を絶対パスで。L5）、上の 1〜7 を確かめ直す。**封入済みの bundle が無い・空なら `SEALED_BUNDLE_MISSING` で止まり、作り直さない**
（L2。新しく pack すると別のバイトになる）。そのときは報告して止める（生成は再試行しない）。
終了コード（wrapper）: 0 = 渡した（または既に渡っている）、1 = 渡せなかった（bundle は封入のまま。あとでもう一度）、2 = 拒否、12 = busy、20 = clone の状態。
再送は封入済みのバイトの再送だけで、Codex の再実行・再生成・再 pack は無い。GitHub・bridge の JSON spool・公開の保存先へは何も置かない。

渡った後: オーナーが `claude-start` → Remote Control の Claude が `~/sr-runs/review-inbox/previews/<承認 ID>/INDEX.md` とプレビューを Read して評価する。

オフラインの E2E（`tests/unit/design-agent/imagefirst-worker/deliver-review.test.ts`。偽 Codex で本物の cycle を 1 回 → 本物の inbox）:
成功（パーツ 6 枚のプレビューと INDEX、元の SHA = bundle の SHA = receipt の SHA）、receipt が succeeded でない、期限の窓の外、承認・plan・prompt・
パケット・コミットの不一致、画像の改ざん、run dir / receipt / パーツの symlink、inbox / previews の symlink、重複（冪等）、中断した受け渡しの
同じ SHA での再送、jail の排他、ダミー ID、ロック、origin/develop に無いコミット、claim の印の欠落・不一致、symlink 経由のホーム、止める合図、
封入の無い再送。どの場合も claim と ledger の**中身の SHA-256**・Codex の実行回数が受け渡しの前後で変わらないことを確かめている。jail の状態の読み取りは
偽の systemctl で（`deliver-review.test.ts`）、wrapper は偽の WSL で（`deliver-review-wrapper.test.ts`）テストしている。

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
