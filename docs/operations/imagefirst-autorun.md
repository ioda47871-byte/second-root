# IMAGE_FIRST の自動実行（包括的な事前許可 → 依頼ごとに生成 1 回。Issue #302・DEV-303）

> **状態: コードと手順だけ。WSL には install も enable もしていない。** 下の §0 の設置（`imagefirst-autorun-setup.sh` の
> check → apply → standing → enable-timer）は、オーナーが WSL の root で行う**安全境界の操作**である（systemd の unit と timer を
> 入れ、root が動かすスクリプトを `/usr/local/lib/sr-imagefirst/` に置き、Remote Control を自動で止めて戻すことを許し、
> 画像生成の包括的な事前許可を書く）。Claude は行わない。入れた後も、オーナーの switch と、事前許可（または 1 回ごとの承認の印）が
> 無ければ何もせず、Remote Control にも触らない。

## 0. 包括的な事前許可（DEV-303、オーナー決定 2026-11-23。MVP_SPEC §7.1）

画像生成は、オーナーが**一度だけ**設定する包括的な事前許可のもとで動く。以後は 1 回ごとの WSL の操作もオーナーの承認も要らない。
守るもの（緩めない）: root の分離、認証情報の保護（#326 の実行ごとの設定の写し）、生成の上限、無限の再試行の防止、実行コードの保護。

### 0.1 オーナーが一度だけすること（WSL の root で、上から順に。どれも別々の承認）

```bash
# 管理用の clone を develop のその commit に合わせる（<sha> は origin の develop の 40 桁）
sudo git -C /root/sr-capture-admin fetch -q origin && sudo git -C /root/sr-capture-admin checkout -q --detach <sha>
S=/root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh
sudo bash $S check --expect <sha>                      # 読むだけ。SETUP_STEP が 5 行（cli・codex_config・scripts・units・hardening_check）
sudo bash $S apply --yes --expect <sha>                # 入れる（timer は入れない）。scripts で root のスクリプトを /usr/local/lib/sr-imagefirst/ へ
sudo bash $S standing --yes --expect <sha> --per-day 2 --per-week 8 --days 30   # 事前許可（値は例）
sudo bash $S enable-timer --yes --expect <sha>         # 10 分ごとの timer を入れる
```

- `standing` の上限: `--per-day` は 1〜4、`--per-week` は 1〜20（`--per-day` 以上）、`--days` は 1〜90。外れると `STANDING_INVALID` で何も書かない。
  書くのは root の `/etc/sr-design-worker/imagefirst-standing.json`（0644）だけ:
  `{"schema": "sr_imagefirst_standing_v1", "per_day", "per_week", "not_after"（今 + D 日、UTC）, "created_at", "worker_commit"（= --expect）, "origin_url"（管理用 clone の origin）}`。
  setup.log に記録する。値を変えるときは `standing` をもう一度打つ（置き換わる）。期限が過ぎると何も動かない（もう一度 `standing`）。
- **worker のコードの固定**: `worker_commit` は `--expect` の commit（その時、管理用 clone のきれいな detached HEAD で、origin の develop であると
  確かめたもの）。事前許可がある間、**依頼の回も 1 回ごとの承認の回も、この commit の worker のコードだけ**が jail の外で動く（develop の最新は
  動かさない。Claude がマージしたコードが勝手に root の回で動くことはない）。**新しい worker のコードを回に届ける方法は、オーナーが
  `standing --yes --expect <新しい commit> ...` を打ち直すことだけ**。origin がその commit を持っていなければ（force push などで消えた）
  `AUTORUN_STANDING_COMMIT_UNAVAILABLE` で何も試さない（試行も使わない）。
- **凍結の解除**: 実行の後に root が数えた画像が 6 枚を超えると（`AUTORUN_IMAGE_CAP_EXCEEDED`）、root は
  `/var/lib/sr-imagefirst-autostart/standing.frozen` を書き、事前許可での拾い上げを止める（`AUTORUN_STANDING_FROZEN`）。その回を確かめてから
  `sudo bash /usr/local/lib/sr-imagefirst/scripts/sales-design-worker/imagefirst-autorun-setup.sh standing --unfreeze --yes`。
- **取り消し**（いつでも、`--expect` も管理用 clone も要らない）:
  `sudo bash /usr/local/lib/sr-imagefirst/scripts/sales-design-worker/imagefirst-autorun-setup.sh standing --revoke --yes`
  （動いている 1 回は最後まで行く。止めるなら `sudo systemctl stop sr-imagefirst-autorun.service`）。timer ごと止めるのは §3。
- develop が新しくなっても、root が動かすスクリプトは**入れた写しのまま**。新しい root のスクリプトを使うには check → apply をもう一度（オーナーの操作）。
  worker（node のコード）は毎回、その時の develop の commit の新しい clone で動く（下の 0.3）。

### 0.2 依頼のファイル（Claude が置く。worker 側と共有する形）

Claude（jail の sr-designgen）が `~/sr-runs/requests/<依頼 ID>.json` を置く。root が見るのは外側だけ:

- 依頼 ID: `^req-[a-z0-9][a-z0-9-]{2,58}$`（ファイル名と同じ。必ず `req-` で始まり、承認 ID の形 `hoshigama-imagefirst-...` にはならない。承認 ID も `req-` では始まらない）。ファイルは 16 KiB まで、普通のファイル（リンク・FIFO・ディレクトリは不可）。
- JSON: `{"schema": "sr_imagefirst_request_v1", "id": <ファイル名と同じ>, "shop_id": <^[a-z0-9_-]{2,41}$>, "kind": "real_shop" | "fictional", "created_at": <UTC の ISO、末尾 Z>, ...}`。
  ほかの欄は worker の仕事（root は読まない）。**依頼はデータだけ**: 依頼の中身でコード・commit・上限・場所は選べない（動くのはオーナーが固定した commit の worker）。
- root は依頼を **worker として**読む（setpriv、root 自身の作業ファイルへの pipe。root は worker のファイルを開かない）。
- 形が違う依頼は root の `rejected/<ID>`（理由のコード）に記録し、`~/sr-runs/review-inbox/requests/<ID>.rejected` に
  `IMAGEFIRST_REQUEST_REJECTED id=<ID> reason=<コード>` を worker として書く。二度と読まない（直しても同じ ID は動かない。新しい ID で置く）。
  理由のコード: `REQ_NOT_REGULAR`・`REQ_UNREADABLE`・`REQ_TOO_LARGE`・`REQ_NOT_JSON`・`REQ_SCHEMA`・`REQ_ID_MISMATCH`・`REQ_SHOP_ID`・`REQ_KIND`・`REQ_CREATED_AT`。
- 一度に 1 件。上限の中で、まだ見ていない正しい依頼のうち**いちばん古いもの**（created_at、同じなら ID の順）を拾う。
- 結果は今までどおり `~/sr-runs/review-inbox/runs/<ID>.share.txt`（共有してよい行だけ）と、受け渡しの inbox・監査。

### 0.3 root が守ること

- **上限**: root の記録 `autorun/<ID>/attempt`（消さない）の時刻から、直近 24 時間と直近 7 日の試行を数える（失敗した試行も数える。
  時刻の読めない記録は「今」として数える）。`per_day` / `per_week` に届いていれば何も読まずに終わる（`AUTORUN_IDLE_QUOTA`）。
  1 回ごとの承認の試行も同じ数に入る。
- **1 件 1 回**: 拾った依頼は root の `requests/<ID>.json`（0600）に写して SHA-256 を記録し、`autorun/<ID>` を作ってから動かす。
  何が起きても同じ ID は二度と動かない（再試行なし）。1 回の中身は今までどおり（Codex 1 回・画像 6 枚まで・15 分）。
- **commit の固定**: 事前許可がある間は、その `worker_commit` だけ（上の 0.1）。root は試行の前に、その commit を root の使い捨ての
  リポジトリへ fetch して origin が持っていることを確かめる（root は何も動かさない）。pilot は worker として新しい場所に `git init` し、
  その commit を**id で** fetch して（`refs/remotes/origin/develop` に入れる。worker は HEAD = origin/develop を確かめる）checkout する。
  develop の最新や祖先は見ない。develop が進んでも、その回は固定した commit で動く（以前の `AUTORUN_STOP_DEVELOP_MOVED` で承認を無駄にする
  問題は、事前許可のもとでは起きない）。事前許可が無いとき（1 回ごとの承認だけ）は DEV-303 の前と同じ: 管理用 clone がきれいで HEAD = origin の develop、
  止めた後にもう一度確かめる（動いていれば pilot なし）。
- **root が守る上限と、worker が守る上限**: root が守るのは、回数（1 日・1 週）、1 件 1 回、固定した commit、時間の上限（timeout）、そして実行の後の
  画像の枚数（worker として、その回の `parts/` と inbox の bundle を数える。6 枚を超えると凍結）。Codex 1 回・画像 6 枚まで・15 分・再試行なしは、
  オーナーが固定した commit の worker のコードが守る。
- **実行コードの保護**: unit が動かすのは `/usr/local/lib/sr-imagefirst/` の写しだけ。autorun は毎回、写しの全部（autorun・pilot・preflight・
  admin.sh と host-check.sh・jail のファイル・メモリの検査など）が root の持ち物で誰も書けず（`/` まで）、`SHA256SUMS` の SHA-256 と同じことを
  確かめる（違えば `AUTORUN_INSTALL_UNTRUSTED` で何もしない）。管理用 clone のスクリプトを root で動かすことはもう無い。
- **worker への受け渡し**: pilot は root の `requests/<ID>.json` の SHA-256 を確かめ、worker として、その回の clone の隣の
  `<clone>.request/<ID>.json`（0600）へ写す。worker は `imagefirst-worker.ts --request <ID> --request-sha256 <hex>` で 1 回だけ動く
  （環境変数 `SR_IMAGEFIRST_REQUEST_FILE` がその写しを指す。承認 ID の grant は渡さない）。
- **実店舗の画像は社内のデザインの参考だけ**（相手に見せない・共有しない・版に入れない）。本番の公開と営業の送信は今までどおりオーナーの確認が要る。自動送信は無い。

### 0.4 1 回ごとの承認（手動の代替。下の §1）

事前許可が無くても、今までの承認コマンド（`imagefirst-approve.sh <承認 ID>`、入れた写しでも管理用 clone のものでもよい）は動く。
印があれば、それが事前許可の依頼より先に動く。印の回には上限を当てない（数には入る）。

## 1. 1 回ごとの承認の流れ（手動の代替。オーナーの操作はマージと root の 1 行だけ）

1. Claude がパケットの PR を作り、オーナーが Claude アプリで中身を確かめて承認し、PR をマージする（今まで通り）。
2. オーナーが WSL の root で **1 行だけ** 打つ（`<ID>` は承認 ID、例 `hoshigama-imagefirst-d4-20261122-01`）:

   ```bash
   sudo git -C /root/sr-capture-admin fetch -q origin && sudo git -C /root/sr-capture-admin checkout -q --detach origin/develop && sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-approve.sh <ID>
   ```

   最後の行が `IMAGEFIRST_APPROVE APPROVE_RECORDED approval=<ID> exit=0`（または `APPROVE_RECORDED_DEFERRED`）なら終わり。
3. あとは自動（Remote Control の Claude はその間止まる）:

   ```
   sr-imagefirst-autorun.timer（10 分ごと + 最大 90 秒の揺らぎ、Persistent=false）
     → sr-imagefirst-autorun.service（root、oneshot）→ imagefirst-autorun.sh
         1. switch・印（無ければ §0 の事前許可と依頼）・使用済み・試行済みを見る。入れた写し（/usr/local/lib/sr-imagefirst）が
            SHA256SUMS のとおりであること。commit を決める: 事前許可がある間はその worker_commit（origin が持っていること）、
            無いときは admin clone がきれいで HEAD = origin の develop（ls-remote）。どれかが違えば静かに終わる（Remote Control に触らない）
         2. 試行を記録（autorun/<ID>、その commit も。消さない）→ sr-jail-claude が enable だったかを復元フラグに書く
            → admin.sh claude-stop → sr-designgen のプロセスが無くなるまで待つ（最大 180 秒）
         3. （事前許可が無いときだけ admin clone をもう一度確かめる）→ imagefirst-pilot.sh --autorun <ID> <commit> <origin URL>
              使い回しの clone は使わず、root が決めた新しい場所（~/imagefirst/autorun-<ID>-<UTC>）に root の origin URL から
              その commit だけを id で fetch し（利用者・システムの git 設定なし）、HEAD = <commit>、status --ignored が空、npm ci
              → preflight（全部 PASS でなければ何も使わずに終わる）→ used/<ID> を作る → worker 1 回（Codex 1 回）
              → 受け渡し（必要なら再送 1 回）→ 監査の dry-run → 監査 1 回 → 要約
         4. 必ず: review-ready ファイルを書く → claude-start（実行前に enable だったときだけ）→ 復元フラグを消す
            （EXIT trap。sr-designgen のプロセスがまだ残っていれば、claude-start は unit の ExecStopPost に任せてフラグを残す。
            SIGKILL などで trap が飛んだときも、ExecStopPost が `--restore` でフラグを見て claude-start を 1 回）
   ```

4. 次に Claude アプリで新しいセッションを開くと、Claude が `~/sr-runs/review-inbox/runs/<ID>.share.txt` を読み、
   inbox の bundle・プレビュー・監査を照合してオーナーに出す（d4 の実行シートの「Claude が引き受ける後処理」と同じ）。

時間: 承認コマンドから最長でおよそ 10〜12 分で始まる。生成と監査で最長およそ 1 時間 50 分（各段階の timeout の合計。普段はずっと短い）。

## 2. 一度だけの設置（オーナーの承認が要る安全境界の操作。WSL の root で）

前提: `docs/operations/imagefirst-worker-port.md` §7.2 の専用 clone（`/home/sr-designgen/imagefirst/second-root`）と、
`~sr-designgen/sr-runs`（sr-designgen の 0700）があること。古い毎時の自動起動（`sr-imagefirst-autostart.timer`）は入っていれば
設置の script が止める（同じ印を読むため。承認コマンド・自動実行・preflight のどれも、それが enable か active なら断る）。

設置は 1 つの script（`scripts/sales-design-worker/imagefirst-autorun-setup.sh`）にまとめてあり、オーナーの操作は次の 3 回だけ
（それぞれ別の承認）。`<SHA>` は Claude が示す origin の develop の commit（40 桁）。script は admin clone が root のもので・きれいで・
`<SHA>` に detach されていて、`<SHA>` が origin の develop（admin clone 自身の URL への `ls-remote`）でなければ何もせずに断る。

**(a) 確かめる（読むだけ。どこにも何も書かない）**: 出力をそのまま Claude に見せる。

```bash
sudo git -C /root/sr-capture-admin fetch -q origin && sudo git -C /root/sr-capture-admin checkout -q --detach <SHA>
sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh check --expect <SHA>
```

4 つの段階ごとに `SETUP_STEP <名前> <DONE|TODO|BLOCKED> <理由>` が出て、最後の行が `IMAGEFIRST_SETUP CHECK_OK exit=0`
（BLOCKED が無い）か `CHECK_BLOCKED exit=3`。段階:

| 段階 | すること（apply のとき） |
|---|---|
| `cli` | `claude`・`codex` を root 所有で `/usr/local` に入れる。**root でベンダーのコードを動かさない**: 使う 4 つの tarball（`@anthropic-ai/claude-code@2.1.295`、そのネイティブ版 `@anthropic-ai/claude-code-linux-x64@2.1.295`、`@openai/codex@0.159.0`、そのネイティブ版 `@openai/codex@0.159.0-linux-x64`）は、registry の URL と sha512（npm の `dist.integrity`）を script に固定してある。(1) 4 つを `curl -q`（https だけ、`env -i`）で root だけの場所に落とし、**何かを変える前に** sha512 を照合し、中身が `package/` の下のふつうのファイルとディレクトリだけであることを確かめる。(2) いまの `/usr/local/bin/claude`・`codex`（sr-designgen の home を指す root の symlink）の**指す先を setup.log に記録してから、その 2 つの symlink だけ**を消す（そこが home を指す symlink 以外なら BLOCKED で何も触らない）。(3) 2 つの本体を**照合済みの手元の tarball から** `/usr/bin/npm install -g --prefix /usr/local --ignore-scripts --omit=optional` で入れ（`env -i`・`HOME=/root`・固定の PATH・umask 022。proxy・CA・npm の環境変数は渡さない。利用者と全体の npm 設定は `/dev/null`）、入ったファイルを tarball のものとすべて比べる。(4) claude-code の唯一の lifecycle script（postinstall の `node install.cjs`。ネイティブの `claude` を `bin/claude.exe` の placeholder の上に写すだけ）は動かさず、script 自身が照合済みのネイティブ `claude` を `bin/claude.exe` に root 0755 で置く。codex には lifecycle script が無く、ネイティブ版を npm が optional dependency を置く場所（`@openai/codex/node_modules/@openai/codex-linux-x64`。`bin/codex.js` がそこを探す）に置く。DONE の条件: それぞれの実体（`readlink -f`）が root のもので `/` まで他人が書けない、package.json の版が固定の版、ネイティブの 2 つが 1 MiB を超える ELF で SHA-256 が固定値と同じ（CLI は実行しない） |
| `codex_config` | リポジトリの `codex-config.toml` を `/etc/sr-design-worker/`（root 0755）に root 0644 で置き、SHA-256 が pilot と preflight の `CODEX_CONFIG_SHA256` と同じことを確かめる |
| `units` | 古い `sr-imagefirst-autostart.timer` を disable（あれば）→ 自動実行の unit 2 つを 0644 で置く → `daemon-reload` → switch `/etc/sr-design-worker/imagefirst-autostart.json` を**無いときだけ** `{"enabled": true}` で作る（あれば中身を変えない） |
| `hardening_check` | 下の付録の確認 1 を、unit の `[Service]` の性質を**すべて**（lifecycle の `Type`・`ExecStart`・`ExecStopPost`・`TimeoutStartSec`・`TimeoutStopSec`・`KillMode`・`SuccessExitStatus` を除く。`ProtectKernelLogs`・`LockPersonality`・`RestrictRealtime`・`UMask`・`StateDirectory`・`ReadWritePaths=/home/sr-designgen -/var/lib/sr-design-cycle`・資源の上限を含む）付けて行う（`admin.sh status`。Remote Control は止まらない。テストが script と unit の一致を両方向で固定）。表が出なければ `SETUP_HARDENING_FAILED` でそこで止まり、timer は off のまま、rollback の行を出す |

**(b) 入れる（別の承認）**: (a) が `CHECK_OK` で、Claude と中身を確かめた後。

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh apply --yes --expect <SHA>
```

ダウンロードは約 280 MB（ほとんどがネイティブ版 2 つ）。`/var/lib/sr-imagefirst-autostart/` の下の一時 dir に展開し（約 700 MB）、終わったら消す。
その filesystem の空きが 1024 MiB 未満なら `SETUP_BLOCKED`（何も落とさない）。各 tarball は固定した大きさ + 4 KiB を超えると curl が止める
（`--max-filesize`）。setuid・setgid・sticky の付いた中身は断り、置いた後も 2 つの package に `chmod -R u-s,g-s,-t` をかける。入った package の dir に
tarball に無いファイルがあれば断る。rollback は途中で止まっても打ち直せる（もう戻っている symlink は済みとして扱う）。
最後の行が `IMAGEFIRST_SETUP APPLY_OK exit=0`（4 段階すべて DONE）なら終わり。もう一度打っても、DONE の段階は何もしない。
**apply は timer を enable しない。** 何をしたか（古い symlink の指す先を含む）は root だけが読める
`/var/lib/sr-imagefirst-autostart/setup.log`（0600、dir は 0700）に残る。`SETUP_HARDENING_FAILED` など途中で止まったら、その出力を Claude に見せる
（hardening の調整は別の承認）。

**(c) timer を入れる（別の承認）**: 4 段階すべてが DONE でなければ断る（TODO が残れば `TIMER_NOT_READY` exit 4、BLOCKED があれば `SETUP_BLOCKED` exit 3）。

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh enable-timer --yes --expect <SHA>
```

`systemctl enable --now sr-imagefirst-autorun.timer` をして、その `list-timers` の行を出す（`IMAGEFIRST_SETUP TIMER_ENABLED exit=0`）。

**サインインのファイル**（`~/.codex/auth.json`・`~/.claude/.credentials.json`）は sr-designgen の home に置いたまま。設置の script も root も読まない
（実行のたびに pilot が sr-designgen として写す。§6）。sr-designgen 自身の PATH（`~/.npm-global/bin` が先）と home の CLI は変えないので、
jail の Claude は今まで通り自分の claude を使う。自動実行の worker の PATH（`/usr/local/bin:/usr/bin:/bin`）だけが root の CLI を見る。

**任意の確認 2**（**Remote Control が数秒止まり、この Claude のセッションも切れる**。WSL の端末で、オーナーが打つ。(c) の前がよい）:
同じ hardening で `claude-stop` → `claude-start` が動くか。`CLAUDE_STOPPED` と `CLAUDE_STARTED (jailed)` が出れば合格。
`claude-start` が失敗したら、hardening なしで `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start` を 1 回打って戻す
（ExecStopPost の `--restore` は `+` で hardening なしに動くので、本番でも最後は戻せる）。

```bash
H='-p ProtectSystem=strict -p ProtectHome=read-only -p ReadWritePaths=/home/sr-designgen -p PrivateTmp=yes -p NoNewPrivileges=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes'
sudo systemd-run --wait --pipe --collect $H /usr/bin/bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-stop
sudo systemd-run --wait --pipe --collect $H /usr/bin/bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start
```

**元に戻す**（apply を取り消す。admin clone はきれいで `<SHA>`（そのとき checkout されている commit）に detach されていること。develop が先へ進んでいてもよい）:

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh rollback --yes --expect <SHA>
```

**setup.log が「apply が変えた」と記録したもの（最後の完了した rollback より後）だけ**を戻す: `units` を変えていれば timer を disable → unit 2 つを消す →
`daemon-reload`。`cli` を変えていれば npm の 2 つを `npm uninstall -g --prefix /usr/local`（置いたネイティブ版ごと消える）→ 記録した古い symlink を
そのまま戻す（指す先がまだあり、場所が空いているときだけ）。`codex_config` を置いていれば `/etc/sr-design-worker/codex-config.toml` を消す。
確認 1 の合格の記録（`/var/lib/sr-imagefirst-autostart/setup-hardening.ok`）も消す。apply の前からあったもの（手で置いた config や unit）は消さない。
古い `sr-imagefirst-autostart.timer` は **disable のまま**（戻さない）。`used/`・`autorun/`・worker の claim・入口の ledger・switch は**消さない**。
自動実行が動いている間（service が active）は断る。

**rollback の後の注意**: 戻した `/usr/local/bin/claude`・`codex` は、今と同じく sr-designgen の home（jail の Claude が書ける場所）を指す root の symlink である。
**root（`sudo`）で `claude`・`codex` を打たない**（root が利用者の書けるプログラムを動かすことになる）。

終了コード（script の先頭にも書いてある）: 0 成功、2 断った（使い方・`--yes` なし・`--expect` なし・admin clone・test 用の写しを root で）、3 BLOCKED（`CHECK_BLOCKED` / `SETUP_BLOCKED`）、4 timer の前提が未完、
11 別の設置が実行中、20 origin を読めない、30〜33 apply の段階の失敗（cli / codex_config / units / hardening）、34 timer の enable の失敗、
35 rollback の一部ができなかった、40 / 41 signal / 内部。

設置した後も、印が無ければ 10 分ごとに switch と印を 1〜2 個読んで終わる（ネットワークなし、Remote Control に触らない）。
印があるときだけ、Remote Control を止める前に admin clone から origin の develop を `ls-remote` で読む（数秒）。

## 3. 止める・外す

| したいこと | すること |
|---|---|
| 自動実行を止める（すぐ） | `sudo systemctl disable --now sr-imagefirst-autorun.timer` |
| 実行中の 1 回を止める | `sudo systemctl stop sr-imagefirst-autorun.service`（pilot が worker・監査へ止める合図を渡して記録を待ち、その後 claude-start する。承認 ID は使った扱い） |
| OFF にする（timer は残す） | `echo '{"enabled": false}' \| sudo tee /etc/sr-design-worker/imagefirst-autostart.json` |
| 1 回の許可を取り消す（まだ始まっていなければ） | `sudo rm /etc/sr-design-worker/imagefirst-run.json` |
| すべて外す | `sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autorun-setup.sh rollback --yes --expect <SHA>`（§2。手で: timer を disable → `sudo rm /etc/systemd/system/sr-imagefirst-autorun.{service,timer}` → `sudo systemctl daemon-reload`） |
| Remote Control が戻っていない | `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh status` を見てから `claude-start` を 1 回 |

`/var/lib/sr-imagefirst-autostart/used/`・`autorun/`、worker の `claims/`、入口の ledger は**消さない**（消すと同じ承認 ID がもう一度使える状態になる）。
自動実行の timer が enable の間は、手で動かすパイロット（`imagefirst-pilot.sh <ID>`）の preflight が `timers` の行で FAIL する
（自動実行が途中で Remote Control を戻すのを防ぐため）。手で動かすときは先に timer を止める。

## 4. 承認コマンド（`imagefirst-approve.sh`）がすること・しないこと

- する: ID の形（`hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN`、日付 `00000000` は拒否）、admin clone がきれいで fetch 後の
  origin/develop と同じこと（違えば実行すべき `checkout` の 1 行を出して断る。自分では更新しない）、switch が `{"enabled": true}`
  （無い・false なら作り方を出して断る）、古い自動起動が off、自動実行の lock、`used/<ID>`・`autorun/<ID>` が無いこと、
  今の印が別の未使用・未試行・期限内の ID を指していないこと。そのうえで印を atomic に書く（同じ dir の一時ファイル → rename、root の 0644、
  中身は `{"approval_id": "<ID>", "expires_at": "<UTC>Z"}` だけ）。
- パケットの確認（どちらの場合も）: root は**自分の admin clone だけ**を、確かめたその commit で読む（`git show`。パーサは使わず、行の形を
  bash の pattern で見るだけ）。ID の方向性のパケット（d3 → p3 のパケット、d4 → d4 のパケット）の §10 が `承認済み` で、`<d> の承認 ID` の行が
  ちょうどこの ID であること（違えば `APPROVE_PACKET_NO_ID`）。`期限` の行が UTC の時刻ならそれがパケットの期限（過ぎていれば
  `APPROVE_PACKET_EXPIRED`）。本当の確認は今まで通り worker の `readApprovalPacket`。
- worker の事前確認: **sr-designgen が何も動かしていないとき（Remote Control が止まっているとき）だけ**、自動起動と同じ手順で専用 clone を
  早送りし、`imagefirst-worker.ts --precheck` を sr-designgen として jail の外で動かす。`{"status":"would_run","code":null,"invoked":false,"approval_id":"<ID>","expires_at":"…Z"}`
  の 1 行・exit 0・期限がパケットの期限と同じ・残り 20 分以上のときだけ受け付け、その期限を印に書く（`APPROVE_RECORDED`）。
- **Remote Control が動いているとき（普通はこちら）は、sr-designgen として何も動かさない**。印にはパケットの期限を書く
  （`APPROVE_RECORDED_DEFERRED`）。確認はすべて実行時に Remote Control を止めてから行う。
- **期限はパケットの §10 だけ**（オーナー方針、Issue #302）: §10 の `期限` が UTC の時刻として読めなければ `APPROVE_PACKET_EXPIRY_UNREADABLE`、
  24 時間より先なら `APPROVE_EXPIRY_INVALID`（後でもう一度打つ）で断る。「今 + 24 時間」のような推測は書かない。期限を引数で渡す方法も無い。
- しない: worker・pilot の起動、Remote Control の停止、claim、`used/`・`autorun/` の作成、systemd の変更。

## 5. 1 回限り・必ず戻す・の守り方

- **生成は印 1 つにつき 1 回まで**: 自動実行は Remote Control を止める前に `autorun/<ID>` を atomic mkdir で作る（root の 0700、消さない）。
  2 回目以降の timer は `AUTORUN_IDLE_ATTEMPTED` で静かに終わる。pilot は worker を起動する直前に `used/<ID>` を作る（自動起動の手順 7 と同じ）。
  その下に、worker 自身の claim と入口の ledger（今まで通り）。再試行はどこにも無い。
- **preflight で止まったとき**（未承認・期限が近い・メモリ・サインインなど）: 何も使っていない（`used/<ID>` も claim も無い）が、
  試行は記録されるので自動ではもう動かない。Remote Control は戻る。同じ ID でやり直すかはオーナーが決める（§7 の未決事項）。
- **Remote Control は必ず元に戻す**: claude-stop の直前に、sr-jail-claude が enable だったかを root の復元フラグ
  （`/var/lib/sr-imagefirst-autostart/autorun.restore-pending`、`was_enabled=yes|no`）に書き、同時に「止めた」と記録する
  （その間に止める合図が来たら、claude-stop はせずにフラグを消して exit 40）。EXIT trap で、成功・失敗・止める合図のどれでも、
  enable だったときだけ `admin.sh claude-start`（オーナーが止めていた Remote Control は止めたまま。`remote_control=left_stopped`）。
  終わりに sr-designgen のプロセスがまだ残っていれば（例: pilot の timeout の後に残った worker。この unit の cgroup にいて、script が
  終わると systemd が止める）、claude-start はせずフラグを残し（`remote_control=deferred`）、unit の `ExecStopPost`（`+` で sandbox なし、
  同じ cgroup。`--restore`）が 1 回だけ claude-start する。SIGKILL・`TimeoutStopSec` 超え・クラッシュでも同じ。WSL ごと止まったときは
  どちらも動かない（オーナーが `claude-start`）。claude-start が失敗したら終了コード 3（`AUTORUN_RC_NOT_RESTORED`）。
- **排他**: Remote Control を止める前に、古い自動起動の unit が off・設計サイクルの timer が off で service が停止・自動起動 / pilot / サイクルの
  lock が空いていることを確かめる（そうでなければ触らずに終わる）。止めた後は、自動起動の `busy()` が idle と言うまで待つ。
  preflight は自分の cgroup が `sr-imagefirst-autorun.service` のときだけ、その service（activating / active）と timer を許す。
- **`--autorun` は service の中だけ**: pilot と自動実行は自分の `/proc/self/cgroup` を読み、`0::/system.slice/sr-imagefirst-autorun.service`
  でなければ断る（引数や環境変数では選べない）。手で打つパイロットの動き（`imagefirst-pilot.sh <ID>`・`--sync-clone`）は変わらない。
  ただし preflight の `timers` の行は、自動実行の timer / service も off であることを見るようになった（表示も 1 項目増えた）。

## 6. 信頼の根拠（Remote Control が動いている間の承認）

- 承認コマンドが Remote Control の動いている間に書くのは、**オーナーが打った ID と root が作った期限だけ**である。jail の中の process は
  `/etc/sr-design-worker` に書けず、印の中身にも関われない。印はパケットの承認の代わりにならない（worker が HEAD のパケットで確かめる）。
- sr-designgen の process が生きている間は、root は sr-designgen として何も動かさない（git・node・npm も。jail の process が仕込んだ
  git の設定や node のコードが jail の外で同時に動くのを避ける。自動起動・pilot・preflight・再送と同じ規則）。
- **生成に使う clone は毎回新しく作り、root が確かめた commit に固定する**: Remote Control が動いていた間、jail の Claude（同じ利用者）は
  使い回しの clone（`~/imagefirst/second-root`）の `.git/config`・hooks・index のフラグ（skip-worktree など）・objects や alternates・
  無視されたファイル（`.env*`・cache）・`node_modules`、そして home の git 設定（`~/.gitconfig` とその include、`~/.config/git/config`・`attributes`）を
  書き換えられた。だから実行時は、Remote Control を止めて sr-designgen の process が 0 になってから、
  1. root がその commit を決める: 事前許可がある間はオーナーが固定した `worker_commit`（root が試行の前に、origin が持っていることを確かめる）。
     事前許可が無いときだけ、root の admin clone（きれい・HEAD = admin clone 自身の URL で `ls-remote` した origin の develop）で決める（止める前と後に 2 回）、
  2. pilot が sr-designgen として、root が決めた新しい場所 `~/imagefirst/autorun-<ID>-<UTC>` を `mkdir` で作り（symlink・既にある場所は断る）、
     `git init` して root の origin URL からその commit **だけを id で** fetch し（`refs/remotes/origin/develop` へ。objects は git が受け取って確かめたものだけ。
     何も共有しない）、取れなければ止め、`checkout --detach` し、HEAD = その commit、`git status --porcelain --ignored` が空でなければ止める
     （`PILOT_STANDING_COMMIT_UNAVAILABLE` / `PILOT_AUTORUN_TREE_DIRTY`。claim の前。develop の最新や祖先とは比べない）、
  3. その clone で `npm ci`（利用者・全体の npm の設定は `/dev/null`）、
  4. preflight・worker の実行・再送（`--deliver-review`）・監査はすべてその clone で動く（preflight は root の state ファイル `autorun-clone` で場所を知り、
     形を確かめる）。worker が claim の前にもう一度全部を確かめる。
  - worker の git はすべて `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1`（node の worker が起動する git にも `worker/env.ts` が渡す）。
    pilot・preflight が直接起動する git には、さらに `-c core.attributesFile=/dev/null -c core.excludesFile=/dev/null -c core.hooksPath=/dev/null
    -c core.fsmonitor=false -c credential.helper= -c protocol.ext.allow=never` を付ける。node の worker の git は `~/.config/git/attributes` を読みうるが、
    filter などの実行の定義は利用者の設定にしか置けず、それを読まないので何も起動しない。
  - 古い新規 clone: `~/imagefirst` の直下で `autorun-hoshigama-imagefirst-*` という名前の本物のディレクトリだけを対象に、いちばん新しい 1 つを残し、
    それより古いものを pilot が sr-designgen として消す（自動実行が lock を持ち Remote Control を止めている間なので、使っている run は無い）。
    symlink・ほかの名前・ほかの場所は消さない。画像・receipt・bundle は `~/sr-runs` にあり、clone を消しても残る。
  - Node は clone の親ディレクトリと全体のフォルダからも module や `package.json` を探す。だから `~/node_modules`・`~/.node_modules`・
    `~/.node_libraries`・`~/imagefirst/node_modules`・`~/package.json`・`~/imagefirst/package.json` のどれかがあれば（symlink も）、clone を作る前と
    npm ci の後に `PILOT_AUTORUN_NODE_PATHS` で止まる（claim の前）。`NODE_PATH` は worker に渡らない（`env -i`、`worker/env.ts` も渡さない）。
  - node の worker が起動する git にも `core.attributesFile=/dev/null` が効く（`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.attributesFile GIT_CONFIG_VALUE_0=/dev/null`）。
  - 古い clone の掃除は NUL 区切りで名前を読み、名前全体が `autorun-hoshigama-imagefirst-d[34]-YYYYMMDD-NN-<UTC>` で、親がちょうど `~/imagefirst`、
    本物のディレクトリのものだけを対象にする（改行を含む名前などは触らない）。
  - ディスク: 新しい clone と `node_modules` で約 1 GiB、さらに 1 つ前のものを残す。自動実行の中では preflight の `disk` の行が
    4096 + 2048 = 6144 MiB 以上の空きを求める（手動のパイロットは 4096 MiB のまま）。
  - 手で動かすパイロットは今まで通り `~/imagefirst/second-root` を使う（変えていない）。
  印の期限（最長 24 時間）は「いつまで拾うか」だけを決め、パケットの期限は worker が守る。

### 設定の信頼境界（モデル CLI の設定。Issue #302 オーナー方針 1、OWNER MERGE ONLY の PR）

jail の外で sr-designgen として動くモデル CLI（生成の Codex、監査の Claude CLI、preflight の Codex サインイン確認と claude の auth 確認）は、
何もしなければ `~/.codex`（`config.toml` の `mcp_servers`・`notify`・`model_providers`・`profiles`、`AGENTS.md`、prompts）と
`~/.claude`（`CLAUDE.md`、settings の hooks、plugins・agents・commands）・`~/.claude.json` を読む。どれも jail の Claude が書ける。

**選んだ方式 (a)（自動実行だけ）**: 1 回の実行ごとに、pilot が sr-designgen として、新しい clone の隣に root が決めた新しい場所
`~/imagefirst/autorun-<ID>-<UTC>.cfg/` を作り（既にある場所・symlink は断る）、その中に
- `codex/`（`CODEX_HOME`）: root の `/etc/sr-design-worker/codex-config.toml`（root 所有・他人が書けない・SHA-256 がリポジトリに固定されたものと同じ）の写しの
  `config.toml` と、`~/.codex/auth.json`（Codex のサインイン）の写し**だけ**、
- `claude/`（`CLAUDE_CONFIG_DIR`）: `~/.claude/.credentials.json`（Claude のサインイン）の写し**だけ**

を置き、worker・監査・preflight の worker の行をすべて `CODEX_HOME` / `CLAUDE_CONFIG_DIR` をそこへ向けて動かす（`worker/env.ts` が両方を子へ渡す。
Codex の sandbox は `CODEX_HOME` だけを読み書きで bind する）。サインインの写しは sr-designgen が作る（root は中身を読まない。本物のファイル・symlink でない・
1 MiB 以下）。実行の後（成功・失敗・止める合図のどれでも、worker の process が全部終わってから）、CLI が更新したサインインだけを、変わっていれば
元の場所へ sr-designgen として戻し（同じ dir の一時ファイル → rename。symlink の先・symlink の dir には書かない）、`.cfg` を写しごと消す。
前の実行が残した `.cfg` は次の実行の始めに消す。監査の既存のフラグ（`--tools ""`・`--strict-mcp-config`・`--setting-sources ""`・`--no-session-persistence`）は変えていない。

**FAIL CLOSED（claim の前）**: preflight の新しい行 `config_trust`（自動実行の中だけ）が、root の config が無い・root だけのものでない（他人が書ける・symlink）・
SHA-256 が違う、`.cfg` に予定外のもの（`codex/` は `auth.json` と `config.toml` だけ、`claude/` は `.credentials.json` だけ、symlink なし）がある、
監査の作業 dir（`~/.local/state/...`）の親（`~` を含む）に `CLAUDE.md`・`CLAUDE.local.md`・`.claude/CLAUDE.md`・`.claude/rules` がある
（Claude は作業 dir の親のこれらを project の memory として読む。だから `~/.claude/CLAUDE.md` も断る）、
worker の PATH で見た `claude`・`codex`・`node` の実体（symlink をたどった先）が root のもの・他人が書けないもの（`/` まで。`trusted_path`）でない
（`~/.local/bin`・nvm・npm-global など worker の home の中の CLI は jail の Claude が差し替えられる）、のどれかで FAIL にし、pilot は何も始めない。
**オーナーの前提**: 自動実行を使うには、`claude`・`codex`・`node` を root 所有の場所（`/usr/local/bin` など）に入れておく必要がある
（いまの WSL では `/usr/local/bin/claude` は `~/.npm-global`、`/usr/local/bin/codex` は `~/.local/bin` を指す symlink で、このままでは `config_trust` が FAIL する）。
§2 の設置の script の `cli` の段階がこれを行う（固定の版を root 所有で `/usr/local` に入れ、古い symlink は記録して rollback で戻せる）。
tsx の loader は新しい clone の `node_modules`（固定の lockfile からの `npm ci`）のものを使う。

**途中で殺された run のサインイン**: pilot が SIGKILL などで終わると、その copy-back は走らない。(1) 自動実行は、pilot を回収した後に結果が無い・
signal で終わったときは、pilot の state ファイルが指す（形を厳密に確かめた）その run の `.cfg` について、sr-designgen の process が無ければ、
写しが元より新しい（`-nt`）サインインだけを sr-designgen として戻し、`.cfg` を消す。(2) それができなかった `.cfg` は、次の実行の始めに同じ規則
（新しいものだけ戻す・symlink/大きさ/本物のファイルの確認）で戻してから消す。更新された OAuth の refresh token を失わないため。
CLI が実行中に `.cfg` へ書くログ・バックアップなどは戻さず、`.cfg` ごと消える（戻すのは 2 つのサインインのファイルだけ）。

**Claude のサインインのファイル（確かめたこと・前提）**: この WSL の sr-designgen では、claude.ai のサインインは `~/.claude/.credentials.json` にある
（Linux の Claude Code の既定の置き場所。`CLAUDE_CONFIG_DIR` を指定すると `$CLAUDE_CONFIG_DIR/.credentials.json` を読む）。`~/.claude.json`
（アカウントの表示用の情報のほか、利用者の MCP 設定なども入る）は**写さない**。**前提**: `claude auth status` と `-p` の呼び出しが
`.credentials.json` だけで claude.ai のサインインとして通ること。もう 1 つの**前提**: `CLAUDE_CONFIG_DIR` を指定すると、CLI は全体の設定を
`~/.claude.json` ではなく `$CLAUDE_CONFIG_DIR/.claude.json` から読む（無ければ作る。`.cfg` ごと消える）。`~/.claude.json` は読まれない前提。本物の claude はこの開発では動かしていないので未確認。通らなければ preflight の
`claude_auth` の行が `CLAUDE_NOT_SIGNED_IN` などで FAIL し、claim の前に止まる（その場合の対応は §7）。

**手で動かすパイロットは変えていない**: 承認済みのコミットに固定して run sheet で動かす手順（d4 の実行シート）の見える動きを変えないため、
(a) は自動実行（`--autorun`）だけに入れた。手動のパイロットは今まで通り `~/.codex` と `~/.claude` を使う（既知の前提として残る）。

**(a) と (b) の比較**

| | (a) 実行ごとの専用の設定 dir（採用） | (b) home の設定を既知の正しい写しとバイト比較 |
|---|---|---|
| jail からの書き換え | CLI は home の設定をそもそも読まない。未知のファイルが増えても見えない | 比べたファイルは守れるが、CLI が読む新しい場所（新しい版の設定ファイル・plugins など）が増えると漏れる |
| 運用 | root の config を一度置くだけ。サインインの更新は写して戻す | 正しい写しを root が持ち、CLI の更新・オーナーの設定変更のたびに写しを更新する必要 |
| 失敗の形 | 予定外のものがあれば claim の前に FAIL | 差分があれば claim の前に FAIL（正当な変更でも止まる） |
| 弱点 | サインインの写しと戻しが要る。Claude が `.credentials.json` だけで動くことが前提 | 比べる対象の一覧を正しく保ち続ける必要。比較と実行の間の書き換えは RC 停止で防ぐ |

(a) を選んだ理由: 守る対象を「読ませるものの一覧」（config 1 つ + サインイン 2 つ）に絞れ、CLI の版が上がって読む場所が増えても既定で見えないため。

**オーナーの一度だけの root 操作（承認が要る。まだ誰も行っていない）**: リポジトリの `scripts/sales-design-worker/codex-config.toml` を置く
（§2 の設置の script の `codex_config` の段階。script は固定値を pilot・preflight から読み、置いた後に SHA-256 を確かめる）。
中身はコメントだけ（MCP サーバー・notify・provider・profile なし）。SHA-256 `697ade397a322574f3b9693811ad257e6a6f1bb511bbed37626c849c7a53b9dd`
（`imagefirst-pilot.sh` と `imagefirst-pilot-preflight.sh` の `CODEX_CONFIG_SHA256`。テストがリポジトリのファイルと一致することを固定）。

```bash
sudo install -o root -g root -m 0644 /root/sr-capture-admin/scripts/sales-design-worker/codex-config.toml /etc/sr-design-worker/codex-config.toml
sudo sha256sum /etc/sr-design-worker/codex-config.toml   # 697ade39...b9dd であること
```

**秘密の扱い**: リポジトリにも Issue にもサインインの中身・トークンを置かない。サインインのファイルは sr-designgen 自身の dir の間で
（`~/.codex` ↔ `.cfg/codex`、`~/.claude` ↔ `.cfg/claude`）sr-designgen が写すだけで、root は中身を読まず、表示もしない。`.cfg` は 0700、
ファイルは 0600 で、実行の後に消す。

### 再承認の提案（提案のみ。実装していない）

preflight で止まって何も使っていない（`used/<ID>` も claim も無い）承認 ID でも、自動では再試行しない（`autorun/<ID>` が残る）。
回復の提案: 使用済みの印・`autorun/`・worker の claim・入口の ledger は**どれも消さず**、新しい承認 ID（新しいパケットの §10 を記入した PR を
オーナーがマージ）で `imagefirst-approve.sh <新しい ID>` を 1 回打つ。古い ID は延長も流用もしない。これなら「1 つの ID は 1 回だけ」の約束が保たれ、
台帳を書き換える操作が要らない。
- review-ready ファイルは root ではなく sr-designgen として、sr-designgen の process が無い間に書く（`setpriv`）。中身は pilot の `share:` の行・
  最後の行・自動実行の結果 1 行だけ（`local-only:` の行・SHA-256・場所・画像・プロンプト・秘密は入らない）。既にあれば上書きしない。
  dir が symlink なら書かない。

## 7. 未決事項（オーナーに決めてほしいこと）

1. preflight で止まった（何も使っていない）承認 ID は自動では再試行しない（オーナー方針）。回復は §6 の「再承認の提案」（新しい ID）。
6. Claude CLI が `.credentials.json` だけ（`.claude.json` なし）で claude.ai のサインインとして通るかは未確認（§6）。通らない場合の選択肢:
   `.claude.json` のうちサインインに要る項目だけを root が決めた形で作る、または監査だけ手動のパイロットに残す。
7. `codex-config.toml` をコメントだけにした。Codex がサインインの保存先などを設定で求める版では、その 1 行を足して SHA-256 を更新する（別 PR）。
2. （DEV-303 で一部解消）包括的な事前許可の下では、実行はオーナーが `standing` で固定した `worker_commit` だけを使い、develop の先端も
   管理用 clone の HEAD も見ない（develop が進んでも承認は無駄にならない）。事前許可が無いときの承認コマンドの経路は従来どおりで、
   管理用 clone が origin の develop と違えば断り（`AUTORUN_ADMIN_NOT_DEVELOP`）、Remote Control を止める間に develop が進むと止まる（`AUTORUN_STOP_DEVELOP_MOVED`）。
3. unit の hardening（`ProtectSystem=strict` など）の下で `admin.sh claude-stop / claude-start` が実機で動くかは未確認（§2 の確認 1・2）。
4. `Conflicts=` は古い自動起動の **timer** にだけ付けた（自動実行の service が動くとその timer は止まる）。service には付けない
   （生成の途中の worker を止めてしまうため）。service が動いている・enable のときは、script・preflight・承認コマンドが断る。
5. 新しい clone と `npm ci` のぶん、ディスク（clone 1 つ + `node_modules`。古いものは 1 つだけ残す）と時間（clone 最大 10 分 + npm ci 最大 15 分）が
   増える。自動実行の中では preflight の `disk` の行が 6144 MiB 以上の空きを求める。unit の `TimeoutStartSec` は 10800 秒。

## 8. テスト

```
npx vitest run tests/unit/design-agent/imagefirst-worker/autorun.test.ts tests/unit/design-agent/imagefirst-worker/approve.test.ts
npx vitest run tests/unit/design-agent/imagefirst-worker/setup.test.ts
```

`setup.test.ts` は設置の script を、test の root の中の偽の `/usr`・`/etc`・`/var/lib`・`/root`・`/home` の上で動かす（registry は npm の形の
偽の tarball 4 つと test だけの固定値、curl はそれを写す代役、npm は手元の tarball を npm と同じ形に入れる代役、systemctl・systemd-run は呼ばれ方を
記録する代役）。sha512・中身・ネイティブ版の照合、`--ignore-scripts`、proxy などの環境変数が npm・curl に渡らないこと、hardening が unit と両方向で一致することも確かめる。check が何も書かないこと、apply の拒否・冪等・timer を enable しないこと、
hardening の失敗で止まること、rollback が symlink を戻し `used/`・`autorun/` に触らないこと、固定の SHA-256 が一致することを確かめる。

pilot の偽 WSL（`tests/unit/design-agent/imagefirst-worker/pilot-world.ts`）の上で、本物の自動実行・承認コマンド・pilot・preflight・再送を動かす。
admin.sh は claude-stop / claude-start を記録して偽の jail の状態を切り替える代役、cgroup は test の root の中のファイル。本物の root・systemd・
Remote Control・Codex・Claude・ネットワークは使わない。

## 付録 A. 手で打つ設置（以前の手順。設置の script が同じことをする）

script を使わずに設置するときの元の手順（確認 1 を含む）。script と違い、`claude`・`codex` を root 所有の場所へ入れる段階は含まない
（§6 の「オーナーの前提」）。

```bash
sudo git -C /root/sr-capture-admin fetch -q origin && sudo git -C /root/sr-capture-admin checkout -q --detach origin/develop
sudo systemctl disable --now sr-imagefirst-autostart.timer 2>/dev/null || true
sudo install -m 0644 /root/sr-capture-admin/scripts/sales-design-worker/systemd/sr-imagefirst-autorun.service /etc/systemd/system/
sudo install -m 0644 /root/sr-capture-admin/scripts/sales-design-worker/systemd/sr-imagefirst-autorun.timer /etc/systemd/system/
sudo systemctl daemon-reload
# enable の前の確認 1（Remote Control は止まらない）: unit と同じ hardening の下で admin.sh status が動くこと
sudo systemd-run --wait --pipe --collect -p ProtectSystem=strict -p ProtectHome=read-only -p ReadWritePaths=/home/sr-designgen -p PrivateTmp=yes -p NoNewPrivileges=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK" /usr/bin/bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh status
sudo install -d -o root -g root -m 0755 /etc/sr-design-worker
# the reviewed Codex config for the run's own CODEX_HOME (§6 設定の信頼境界; without it every run stops at config_trust)
sudo install -o root -g root -m 0644 /root/sr-capture-admin/scripts/sales-design-worker/codex-config.toml /etc/sr-design-worker/codex-config.toml
echo '{"enabled": true}' | sudo tee /etc/sr-design-worker/imagefirst-autostart.json >/dev/null && sudo chmod 0644 /etc/sr-design-worker/imagefirst-autostart.json
sudo systemctl enable --now sr-imagefirst-autorun.timer
systemctl list-timers --all | grep -i sr-imagefirst || true
```

確認 1 で `status` の表が出ず `Permission denied`・`Read-only file system` などで止まったら、**timer を enable しない**（最後の行は打たない）。
その行を Claude に見せる（hardening の調整は別の承認）。

enable の前の確認 2（任意。**Remote Control が数秒止まり、この Claude のセッションも切れる**。WSL の端末で、オーナーが打つ）:
同じ hardening で `claude-stop` → `claude-start` が動くか。`CLAUDE_STOPPED` と `CLAUDE_STARTED (jailed)` が出れば合格。
`claude-start` が失敗したら、hardening なしで `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start` を 1 回打って戻す
（ExecStopPost の `--restore` は `+` で hardening なしに動くので、本番でも最後は戻せる）。

```bash
H='-p ProtectSystem=strict -p ProtectHome=read-only -p ReadWritePaths=/home/sr-designgen -p PrivateTmp=yes -p NoNewPrivileges=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes'
sudo systemd-run --wait --pipe --collect $H /usr/bin/bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-stop
sudo systemd-run --wait --pipe --collect $H /usr/bin/bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start
```
