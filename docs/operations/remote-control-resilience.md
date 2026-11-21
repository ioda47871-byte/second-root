# Remote Control の切断と翌日の再開（jail の Claude、DEV-302 の調査）

## 目標

- 一度の準備のあとは、オーナーが WSL のコマンドを打たずに、Claude アプリから Second Root のデザイン調査を続けられること
- 接続が切れても、次のものを失わないこと
  - 生成の job
  - 監査の結果
  - 元画像
  - 成功例
  - 改善の履歴

この文書は**調査と提案**である。変えたのは2つだけで、どちらも読むだけか、断る側を増やすだけの変更である。

- 読むだけの診断 `rc-diagnose.sh` を足した
- worker に「jail の unit の中では一度きりの生成を始めない」という拒否を1つ足した（§7）

`admin.sh` の unit の書き方・systemd・WSL・Windows の設定は、どれも変えていない。§8 の変更には、オーナーの承認と実機での確認が要る。

**原因はまだ確定していない。** オーナーが `rc-diagnose.sh` を実機で1回実行するまで、下の原因はすべて候補である。

**一度きりのパイロットは、オーナーの WSL で既に終わっている**（`PILOT_DONE`、commit `7327c689`）。

- 承認 ID `hoshigama-imagefirst-d3-20261121-01` は使用済みである。再利用しない・延長しない
- 2回目は worker の claim（`APPROVAL_ALREADY_CLAIMED`）と入口の ledger（`APPROVAL_ALREADY_USED`）で必ず止まる
- 生成をもう一度行うには、新しい承認パケット・新しい承認 ID・オーナーのマージが要る

### 根拠の区分（この文書の各項目に付ける）

| 区分 | 意味 |
|---|---|
| **[コード]** コードで確認済み | この repo のコード（`admin.sh`・worker など）を読んで確かめた |
| **[公式]** 公式仕様で確認済み | 公式文書（code.claude.com の remote-control の頁）のうち、**オーナーが確かめた中核の事実だけ**。次の6つに限る。(1) 引数なしの再起動は、止まってから約 4 時間以内なら、前の server が仕えていたすべての session を戻す (2) `--continue` は最初の1つの session だけを戻す (3) server mode は約 10 分の network 断で終わる (4) interactive mode は断が続く間再試行する (5) `claude` の process が動き続けている必要がある (6) tmux / screen の中で動かすことを勧めている |
| **[文書・未確認]** 文書にあるが、オーナーは未確認 | coordinator が同じ頁（と desktop-wsl の頁）を読んで引用したもの。オーナーはまだ確かめていない |
| **[CLI --help]** CLI の help | この cloud 環境で `claude --help` と `claude remote-control --help`（2.1.330）を実行した結果。どちらもモデルを呼ばず、Remote Control も起動しない command で、option の事実を見るためだけに使った |
| **[バイナリ]** バイナリの文字列の観察 | CLI 2.1.330 の実行ファイルの文字列から読んだもの。公式文書には書かれておらず、オーナーの WSL でも確かめていない |
| **[未確認]** 実機未確認 | 推定である。オーナーの WSL での確認が要る |

## 0. 現在の構成 [コード]

```
Claude アプリ ── Remote Control ── claude remote-control（server mode、sr-designgen、jail の中）
                                     ▲ tmux の中（pty、オーナーの覗き窓）
sr-jail-claude.service（root が入れた system unit）
  Type=forking、Restart=always、RestartSec=60、StartLimitBurst=10 / 1h
  KillMode は既定（control-group）
  User=sr-designgen
  WorkingDirectory=$home、BindPaths=$home（読み書き）
  ProtectHome=tmpfs、PrivateTmp=yes
  ExecStart = tmux -S $home/.sr-claude.tmux new-session -d -s claude "cd ~/work/second-root && exec claude remote-control"
  Requires / BindsTo / After = sr-jail-net.service
  WantedBy=multi-user.target（enable されていれば、distro の起動ごとに自動で起動する）
```

## 1. まず読むだけの診断を1回（オーナー、WSL の root）

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/rc-diagnose.sh
```

**変えないこと:**

- systemctl は `show` だけを使う。journal は読むだけ
- tmux には触れない
- ファイルは一時ファイルも含めて1つも書かない（journal は pipe で流し、64 KiB を超える here-string で bash が一時ファイルを作らないようにした。テストが 64 KiB を超える journal で TMPDIR に何も作られないことを確かめる。残る小さな here-string が一時ファイルを作らないのは bash 5.1 以上の動作で、WSL の Ubuntu 24.04 の bash 5.2 と CI はこれに当たる。古い bash では小さな here-string ごとに一時ファイルができて即座に消える）
- `sr-designgen` として何も動かさない（jail の外で動かすと `REQUESTER_OUTSIDE_JAIL` になるため）

**読むもの（root として）:**

- `systemctl show`、`journalctl`、`/proc`
- process の argv は、プログラムが Claude かどうかと、いくつかの option 名の有無だけを調べる。表示はしない
- Remote Control の process の cwd は `~/work/second-root` と比べるだけで、表示しない
- 他の利用者の process については、Claude の数だけを数える
  - Claude かどうかはプログラムだけで判断する（`claude` の実行ファイル、または node が動かす Claude Code の script）。`grep claude` や Playwright の `cli.js` は数えない
- PATH は、何かのコマンドを探す前に system の PATH にする（テストの偽 WSL を指す変数があるときだけ呼び出し側の PATH。その変数は root だけの clone では拒否される）

**`sr-designgen` の home で見るのは、再開の記録 [バイナリ] 1つだけ。**

- 存在と mtime を `stat` で見るだけで、開かない
- パスと project key は表示しない
- Claude・Codex のサインインのファイル、session の中身、鍵、token は開かない

**出力:**

- すべて共有してよい形にしてある: 符号、件数、分単位の経過時間、分に丸めた UTC 時刻、決まった unit 名
- 最後の行は `RC_DIAGNOSE <候補の符号> codes=<出た符号すべて>`
- その下に、Windows と Claude アプリで確かめることの一覧が出る（どれも読むだけ）
  - PowerShell: `wsl --version`、`wsl -l -v`、`Get-Content $env:USERPROFILE\.wslconfig`
  - `.wslconfig` は読むだけにする。CLAUDE.md により、承認なしには変えない

**終了コード:** 実行できれば常に 0。読めない項目は `*_UNREADABLE` になる。2 は引数の誤りか、root だけの clone 以外から動かしたとき。

**オーナーに記録してほしいこと（診断では見えない）:**

1. 「not connected」「Remote Control disconnected / the computer may be asleep or offline / reopen in Claude Code」と出た session は、どちらの種類だったか
   - **この jail の server の session**: 名前がホスト名で始まる
   - **Claude Desktop の Code タブの WSL session で、Remote Control を入れたもの**（`/remote-control`、または設定「Connect new sessions to Remote Control」）
2. 最後に使った時刻と、そう出た時刻（4 時間の再開の窓と比べるため）
3. その間に起きたこと
   - Windows のスリープ・再起動・更新があったか
   - Claude Desktop の更新・再起動があったか

## 2. 候補の原因と、rc-diagnose での見え方

| 候補 | 内容 | rc-diagnose の符号 | 根拠 |
|---|---|---|---|
| (a) | 長い network 断（Windows のスリープなど）で server が終わり、systemd が 60 秒後に起動し直した | `RC_EXIT_AFTER_NETWORK_LOSS=N`（終了の前 15 分以内に network の error の行があった終了の数。数だけで、本文は出さない）、`RC_UNIT_EXITS_7D`、`RC_LAST_EXIT_TO_START_MIN`、`RC_NETWORK_ERROR_LINES_7D` | [公式] server mode は約 10 分で終わる。[コード] Restart=always。network の error の行の形は [未確認]。スリープ中は journal に何も残らないこともある |
| (b) | 止まっていた時間が 4 時間を超えた | `RC_STOP_GAP_OVER_4H=分`（unit の終了から次の起動まで、または前の boot の終わりから今の boot まで）、`RC_BRIDGE_POINTER_AGE=gt4h` / `RC_RESUME_WINDOW_EXPIRED` | [公式] 再開は止まってから約 4 時間 |
| (c) | unit の再起動、起動回数の上限、sr-jail-net の再起動 | `RC_UNIT_RESTARTS=N`（**今の boot の中の systemd の自動の再起動だけ**: journal の `Scheduled restart job`。人の `claude-stop` → `claude-start` と、前の boot は数えない）、`RC_UNIT_AUTO_RESTARTS_THIS_BOOT` / `_7D`、`RC_UNIT_STOPS_THIS_BOOT`（人などの停止）、`RC_UNIT_STARTS_THIS_BOOT`、`RC_UNIT_START_LIMIT`、`RC_UNIT_PROBE_FAILED`、`RC_NET_RESTARTS=N`（今の boot での sr-jail-net の2回目以降の起動。自動・人の restart・approve / jail-install のどれでも Claude は一緒に起動し直す）、`RC_UNIT_NRESTARTS` | [コード]。「今の boot」が読めないときは直近 24 時間 |
| (d) | WSL の VM・distro の再起動 | `WSL_RESTARTED_RECENTLY`、`WSL_DISTRO_RESTARTED_VM_KEPT`、`WSL_BOOT at=… down_before_min=…`、`WSL_BOOTS_7D` / `_PER_DAY` | [コード] `journalctl --list-boots`。JSON の形は [未確認] |
| (e) | 別の server がいた／session が archive された／`--no-create-session-in-dir`／cwd が違う | `RC_MULTIPLE_SERVERS=N`、`RC_NO_CREATE_SESSION_IN_DIR`、`RC_PROC_CWD_UNEXPECTED`、`RC_ARGV_RESTORE`、`RC_ARGV_SPAWN`、`RC_ARGV_CREATE_SESSION_IN_DIR`、`RC_MODE` | [文書・未確認] Ctrl+C は archive しない。ただし同じディレクトリで別の server が動いていた場合と、`--no-create-session-in-dir` の場合は archive する。記録はディレクトリごと。`RC_MULTIPLE_SERVERS` は、親が Remote Control の process でないものだけを server と数える（server が session を子の process として起こすかどうかは [未確認]） |
| (f) | 問題の session は実は Claude Desktop の WSL ローカル session（Remote Control 付き）で、jail の unit ではなかった | `OTHER_USER_CLAUDE_PROCS` / `OTHER_USER_RC_PROCS`（他の利用者の Claude の数だけ）、`OTHER_USER_CLAUDE_RUNNING`。そのほかは §1 のオーナーの記録で判断する | [文書・未確認] Desktop の WSL ローカル session の idle の扱いと、アプリ再起動後の自動再接続は文書に無い。オーナーが挙げた報告（anthropics/claude-code#86563、#105690、#100114、#100743、#102534、#109264）は**オーナーの報告、未検証** |

ほかにも次の行が出る。

- 再開の記録 [バイナリ]
  - `RC_BRIDGE_POINTER=present|absent`
  - `RC_BRIDGE_POINTER_AGE=lt4h|gt4h`
  - `RC_BRIDGE_POINTER_AGE_MIN`
  - `RC_BRIDGE_POINTER_SINCE_PROC_START`（今の server が起動したあとに書かれたか）
- `RC_UNIT_WANTED_BY_MULTI_USER=yes|no`（WSL の起動ごとに自動で起動するか）
- `RC_UNIT_JOBS_AT_RISK=N`（§7）
- `REQUESTER_OUTSIDE_JAIL_PROCS` / `REQUESTER_OUTSIDE_JAIL_UNIT <unit>=N`
- `PILOT_UNIT …`（パイロット・自動起動の unit の状態）

**候補の選び方:** 次の順で、最初に当たったものが最後の行に出る。上ほど特定的な原因である。

1. `RC_UNIT_NOT_INSTALLED`
2. `RC_UNIT_STOPPED_BY_OWNER`
3. `RC_UNIT_START_LIMIT`
4. `RC_UNIT_PROBE_FAILED`
5. `RC_PROC_MISSING`
6. `RC_NO_CREATE_SESSION_IN_DIR`
7. `RC_MULTIPLE_SERVERS`
8. `RC_PROC_CWD_UNEXPECTED`
9. `RC_STOP_GAP_OVER_4H`
10. `RC_EXIT_AFTER_NETWORK_LOSS`
11. `WSL_RESTARTED_RECENTLY`
12. `WSL_DISTRO_RESTARTED_VM_KEPT`
13. `RC_NET_RESTARTS`
14. `RC_UNIT_RESTARTS`
15. `RC_PROC_YOUNGER_THAN_UNIT`

どれにも当たらなければ `RC_NO_LINUX_CAUSE_FOUND` になる。この場合は WSL 側に原因が見えないので、(f) Desktop の session、通信、アプリの側を疑う。

## 3. jail の再起動で session はどうなるか

### 起動の条件 [コード]

- 利用者は常に `sr-designgen`
- `HOME` は `/home/sr-designgen`
  - `ProtectHome=tmpfs` で他の home は隠れる
  - 自分の home は `BindPaths=$home` で読み書きのまま戻る
  - だから `~/.claude` は unit を再起動しても残る
- `PrivateTmp=yes` の `/tmp` は起動ごとに空になる
  - ただし Claude の状態は `/tmp` には無い見込みである [未確認]
- cwd は tmux の命令で毎回 `~/work/second-root` になる
  - `WorkingDirectory=$home` から `cd` する
  - したがって、再開の記録を探すディレクトリは毎回同じになる

### 再開の記録

- [文書・未確認] 記録は「ディレクトリごと」に保たれ、他の worktree にも探しに行く。置き場所は文書に書かれていない
- [バイナリ] 置き場所は Claude の状態の下の `projects/<project key>/bridge-pointer.json` である
  - project key は、ディレクトリのパスの英数字以外を `-` にしたもの
  - 既定の有効期間は mtime から 4 時間（定数 14400000 ms）で、古いものは消される
  - 条件付きの長い期間（7 日・30 日）の定数もあったが、どの条件で使われるかは確かめていない
  - 中身には、仕えていた session の一覧の欄があった

### ExecStart [コード] [公式]

- 今の unit は `claude remote-control` を引数なしで起動する
- 公式文書によれば、引数なしの起動は「止まってから約 4 時間以内なら、前の server が仕えていた**すべての** session を戻す」
- したがって、**4 時間以内の再起動では、本来は前の session に戻れるはず**である

それでも「not connected」が出るなら、次のどれかを疑う。

- 再起動はしたが、戻すのに失敗した
  - 記録が書かれていない: `RC_BRIDGE_POINTER=absent`、`RC_BRIDGE_POINTER_SINCE_PROC_START=no`
  - cwd が違う: `RC_PROC_CWD_UNEXPECTED`
  - 別の server がいた: `RC_MULTIPLE_SERVERS`
- 止まっていた時間が 4 時間を超えた（`RC_STOP_GAP_OVER_4H`）
- 起動回数の上限に当たって、起動し直していない（`RC_UNIT_START_LIMIT`）
- その session は Desktop の session だった（(f)）

**`--continue` を常に付ける案は採らない。**

- [公式] `--continue` は「server が最初に始めた1つの session だけ」を戻す。[文書・未確認] その session が終わると server も終わる
- [CLI --help] 記録が無いとエラーで終わる
- unit に入れると、戻せる session が減るうえ、失敗のたびに起動が繰り返されて、起動回数の上限に当たりうる

## 4. 場合ごとに戻れるか

「戻れる」は、アプリの前の session がそのまま続きを受け付けることを指す。4 時間を超えたら、新しい Remote Control の session が要る。
ローカルの会話の履歴（`claude --resume` の記録）と調査の台帳は、それとは別に残る [文書・未確認]。

| 場合 | 引数なし（今） | `--continue` | `--session-id` | rc-diagnose |
|---|---|---|---|---|
| unit を再起動した直後（Claude の終了 → 60 秒後に起動） | 戻れる見込み（すべての session）[公式]。だめなら §3 の失敗 | 最初の session だけ | その session だけ | `RC_UNIT_RESTARTS`、`RC_LAST_EXIT_TO_START_MIN`、`RC_BRIDGE_POINTER_SINCE_PROC_START` |
| 短い network 断（process は生きたまま） | process が自分でつなぎ直す [文書・未確認: 「マシンがオンラインに戻ると自動で再接続」。server mode でのスリープ時の動きは文書に無い] | 同じ | 同じ | 何も出ない（`RC_NO_LINUX_CAUSE_FOUND`） |
| 10 分を超える network 断（スリープなど） | server が終わる [公式] → systemd が起動し直す → 4 時間以内なら戻れる見込み | 同上（1 つだけ） | 同上 | `RC_EXIT_AFTER_NETWORK_LOSS`、`RC_UNIT_RESTARTS` |
| 4 時間より短い停止（`claude-stop` → `claude-start`、WSL の再起動） | 戻れる見込み [公式] | 1 つだけ | その session | `WSL_RESTARTED_RECENTLY` / `RC_UNIT_STOPPED_BY_OWNER`、`RC_BRIDGE_POINTER_AGE=lt4h` |
| 4 時間より長い停止（一晩の `wsl --shutdown`、Windows の長いスリープ） | **戻れない**。新しい session が要る | 戻れない | 戻れない | `RC_STOP_GAP_OVER_4H`、`RC_RESUME_WINDOW_EXPIRED` |
| Windows の再起動のあと WSL が起動していない | 何も動いていない（unit は WSL の起動で動くので、WSL を誰かが起動するまで止まったまま） | — | — | 診断自体が実行できない。WSL を開くと上の行のどれかになる |
| オーナーがパイロットで止めた（`claude-stop`）まま | `claude-start` するまで何も起動しない | — | — | `RC_UNIT_STOPPED_BY_OWNER` |
| Desktop の WSL session（Remote Control 付き） | jail と関係しない。Desktop の扱いは文書に無い | — | — | `OTHER_USER_CLAUDE_PROCS`、オーナーの記録 |

## 5. 方式の比較

### 二つの mode（10 分で終わる／再試行し続けるは [公式]、ほかは [文書・未確認]）

| | server mode（`claude remote-control`、今の unit） | interactive（`claude --remote-control`） |
|---|---|---|
| session | 多数（`--capacity` 既定 32、spawn は `same-dir` / `worktree` / `session`） | 1 つの process に 1 つ |
| 長い network 断 | 約 10 分で諦めて process が終わる | 断が続く間ずっと再試行し、自分でつなぎ直す（403 は最大 3 分再試行。presence の heartbeat が失敗すると「約 30 分 Remote Control の server に届かない」と表示） |
| 落ちた session | 接続中の端末が送れば、また仕える（v2.1.238 以降） | — |
| 止めた後の再開 | 4 時間以内なら、引数なし（すべて）／`--continue`（最初の1つ）／`--session-id`（その1つ） | `claude --continue` / `claude --resume` |
| CLI の有無 [CLI --help] | あり | `--remote-control [name]` がある（「Start an interactive session with Remote Control enabled (optionally named)」） |

### 置き方

| 案 | 長所 | 短所 | 判定 |
|---|---|---|---|
| Desktop の Code タブの WSL ローカル session + Remote Control | 設定が簡単 | Desktop の利用者（人の WSL 利用者）で動き、**jail の外**である。jail の設計の前提（`sr-designgen` だけが Claude を動かす）と合わない。idle・更新時の扱いは文書に無い（オーナーが挙げた報告は未検証） | Second Root の作業には使わない |
| jail の unit + server mode（今） | WSL の起動で自動で動く。session を多数持てる。4 時間以内なら引数なしで戻る | 10 分を超える network 断で終わる（systemd が戻す）。4 時間を超えたら新しい session | 現状維持で、まず診断 |
| jail の unit + tmux の中の interactive `claude --remote-control` | network 断のあいだ再試行し続けるので、スリープのあとも同じ process・同じ session のまま戻れる見込み。tmux が pty を与える | 1 つの session だけ。アプリから新しい session を作れない（server mode の spawn が無い）。process が終わると `claude --continue` が要る（unit の ExecStart の変更が要る） | **候補として、承認後に実機で試す**（§9） |
| オーナーが手で tmux を開く（systemd なし） | 何も入れない | 毎回コマンドが要る。WSL と一緒に消える | 目標に合わない |
| `systemd --user` + linger | — | jail の設計が `sr-designgen` の linger・cron・at を拒否し、すべての process が `sr-jail-*.service` にあることを求める | 不採用 |

tmux の役割は pty とオーナーの覗き窓であり、通信は Remote Control が担う。公式文書は tmux / screen の中で動かすことを勧めており、systemd についての案内は見当たらない [文書・未確認]。

## 6. 翌日の再開（最小の構成）

### 現在オーナーが経験していること

翌日アプリで前の session を開くと「not connected」と出る。前の server が止まってから 4 時間を過ぎると、Remote Control の仕様として戻せない [公式]。

### 最小の構成

**前提として、4 時間を過ぎたら新しい session を受け入れる。続きは保存された調査のデータから戻す。**

1. **server を WSL の起動で自動で動かす** [コード、既にある]
   - unit は `WantedBy=multi-user.target` で、enable なら WSL の起動ごとに動く（`RC_UNIT_WANTED_BY_MULTI_USER=yes`）
   - パイロットのあとで `claude-stop` したままなら、`admin.sh claude-start` を1回打つ（§8 iii）
2. **WSL を Windows のログオン時に起動する**（タスク スケジューラ。**承認が要る**、§8 ii）
   - これが無いと、Windows を再起動したあと誰かが WSL を開くまで何も動かない
3. **アプリから新しい session を始める**
   - server mode は、アプリからそのマシン・フォルダーに新しい session を作れる
   - `same-dir` が既定、`--spawn session` / `worktree` も選べる [文書・未確認]、[CLI --help]
   - 今の unit のままで使える [未確認: オーナーのアプリでの見え方]
4. **続きは、session の同一性ではなく、保存された調査の記録から戻す**
   - 新しい session は最初に、決まった1つの調査の記録（例: `docs/` か `.ai/` の下の研究日誌）を読む
   - それを repo の CLAUDE.md または project skill から指す
   - その記録は commit して push する
   - 補助として、`~/.claude/projects` の会話の記録（`claude --resume`）も使える
   - この日誌の新設は、Task 化の承認が要る（CLAUDE.md: 新機能の Task 化は承認制）

承認が要るもの:

- 2（タスク スケジューラ）
- 4 の日誌の新設と CLAUDE.md への組み込み
- §8 の unit の変更（入れる場合）

1 と 3 は今のままで使える。

### 一度だけの導入手順（承認されたら。戻し方つき）

1. 診断（読むだけ）を実行する: `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/rc-diagnose.sh`
2. Remote Control が止まったままなら（`RC_UNIT_STOPPED_BY_OWNER`）、`sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start`
   - 戻し方: `admin.sh claude-stop`
3. （承認後）タスク スケジューラに WSL の起動のタスクを入れる（§8 ii）
   - 戻し方: タスクを無効化・削除する
4. （承認後）研究日誌と CLAUDE.md の指示を、別の PR で入れる
   - 戻し方: その PR を develop で revert する

### 再接続の試験の一覧（オーナーの手元で）

1. アプリで jail の session を開き、短い作業をする
2. `sudo systemctl restart sr-jail-claude` を1回行う
   - **systemd の再起動になるので承認が要る。unit の中で job が動いていないときに行う**（`RC_UNIT_OTHER_PROCS=0`）
3. 1〜2 分後、同じ session が続くか、新しい session が出るかを記録する
4. rc-diagnose の最後の行を記録する
5. 次の 3 つの場合も、それぞれ同じ記録を取る
   - 15 分以上のスリープ（10 分を超える network 断）
   - `wsl --shutdown` → 5 分後に開く（4 時間以内）
   - 翌日（4 時間超）

## 7. 消えないこと（durability）

### 置き場所 [コード]

| もの | 置き場所 | 接続が切れる／unit が再起動すると |
|---|---|---|
| worker の claim・lock・audit の行 | `~sr-designgen/.local/state/sr-design-worker/imagefirst-worker/`（0700） | 消えない。claim は結果にかかわらず消さない |
| 入口の ledger | `~sr-designgen/.local/state/sr-design-worker/phase2f-live/` | 消えない |
| run（元画像）・receipt | `~sr-designgen/sr-runs/<承認 ID>-<UTC>/`、`….receipt.json` | 消えない |
| bundle・review inbox・監査 | `~sr-designgen/sr-runs/review-inbox/`（`audits/<承認 ID>/` を含む） | 消えない |
| 自動起動の使用済みの印 | root の `/var/lib/sr-imagefirst-autostart/` | 消えない |
| 成功例・改善の履歴 | git の `design-library/`（`success-cases/` など）と `.ai/` | **commit して push したものだけ**が確実に残る |
| アプリの会話 | Claude 側。ローカルの `claude --resume` の記録は `~/.claude/projects` | 履歴は残る。4 時間を過ぎると、その session に Remote Control で付き直すことはできない |

**接続が切れるだけでは、ディスク上のものは何も消えない。**

### 消えうるもの [コード]

**unit が止まるときに、その中で動いていた process** が消えうる。

- KillMode は control-group なので、Claude・tmux と一緒に、Claude が始めた worker・Codex・Chromium・テストも終わる
  - 止めるときは SIGTERM を送り、既定では 90 秒後に SIGKILL を送る
  - WSL の停止では、猶予なしに終わる
- rc-diagnose はこの状態を `RC_UNIT_JOBS_AT_RISK=N` で示す

### 設計: job の寿命を session の寿命から切り離す

- 長い・重い job を、jail の Remote Control の Claude の子として動かさない。承認された専用の worker の経路だけを使う
  - 一度きりの生成は、root のパイロット・自動起動だけで行う
  - これらは jail の外の独立した unit で動き、jail の Claude とは排他である
- 同じ承認 ID でモデルを再び呼ばない
  - claim と ledger が二重に守っている
  - 再送（`imagefirst-deliver-review.sh`）も生成をしない
- 再接続したあとは、job の状態を読むだけにする（receipt・claim・audit・inbox）

### 承認 ID だけが使われる事故（点 5）[コード]

**既存の門:**

- worker は claim（`O_EXCL` の印）を作ってから、入口を1回起動する（`cycle.ts`）
- 入口は ledger を予約してから Codex を呼ぶ（`full-page-call.ts`）
- 起動したあとで process が殺されると、承認 ID は使用済みのまま残る
  - SIGTERM なら、worker は receipt（`WORKER_INTERRUPTED`）を書いてから終わる
  - SIGKILL や WSL の停止では、receipt が残らないことがある

**この PR の前に残っていた穴:**

- worker を引数なしで起動する道（手での起動）には、jail の状態の確認が無かった
- 付与の環境変数 `SR_IMAGEFIRST_EXPECT_APPROVAL_ID` は任意である
- root の印（`/etc/sr-design-worker/…`）は自動起動の側の門で、worker を直接起動するときには使われない
- したがって、jail の Claude が自分の clone で worker を起動すると、承認された未使用のパケットがある限り claim まで進めた
- その process は sr-jail-claude の cgroup の中にあり、unit が再起動すると一緒に殺される

**この PR で足した拒否（断る側を増やすだけ。オーナーに知ってほしい挙動の変化）:**

- worker は、引数なしの実行と `--precheck` の前に、自分の `/proc/self/cgroup` を読む
- `/system.slice/sr-jail-*.service` の中にいれば、`RUN_INSIDE_JAIL_UNIT` で何もせずに止まる
  - 対象は Remote Control、jailed shell、`admin.sh run` で、どれも sr-jail-net と一緒に終わる
- cgroup が読めなければ `OWN_CGROUP_UNREADABLE` で止まる
- 止まるのは lock・claim・書き込みの前である
- 解除する環境変数も引数も無い。本番の入口は自分の `/proc/self/cgroup` だけを読む
  - テストだけが、テスト用の入口（`tests/unit/design-agent/imagefirst-worker/fixtures/worker-cli-entry.ts`）から cgroup の文字列を渡せる
- root のパイロット・自動起動は jail の外で worker を起動するので、影響を受けない
- **挙動の変化**: `imagefirst-worker-port.md` §5 の「`sr-designgen` として手で起動する」手順は、WSL では使えなくなった
  - `sr-designgen` には jail の外の login shell が無く、`admin.sh shell` / `admin.sh run` は jail の unit なので、`RUN_INSIDE_JAIL_UNIT` で断られる
  - 一度きりの生成の承認された経路は、root の `imagefirst-pilot.sh` と `imagefirst-autostart.sh` だけになる
  - jail の Claude の中で unit テスト一式を流すと、worker の CLI のテストは `RUN_INSIDE_JAIL_UNIT` を期待する（同じ reader で期待値を出す）
- **これは事故を防ぐための確認で、安全の境界ではない**
  - jail の中の process なら、`NODE_OPTIONS` で読み取りを差し替える、`cycle.ts` を直接 import する、入口を直接起動する、などで回り込める
  - 一度きりであることを守るのは、今までどおり claim と入口の ledger である
- **cgroup v2 に依存する**
  - 確かめるのは `/proc/self/cgroup` の `0::` の行だけである
  - cgroup v1 だけの host にはこの行が無いので、実行は通る。WSL2 と GitHub の ubuntu-latest は v2 か hybrid である
  - `/proc/self/cgroup` が無い OS（macOS・native Windows）では `OWN_CGROUP_UNREADABLE` で断る
  - worker の CLI のテストは、そこでもこの期待値を計算して合わせる（skip しない）
- 実装は `lib/design-agent/imagefirst-worker/jail-state.ts` の `ownJailUnit`、テストは `tests/unit/design-agent/imagefirst-worker/jail-guard.test.ts`
- `--check-codex-auth-only` と `--deliver-review` は生成しないので対象外である。`--deliver-review` には以前から jail の停止の確認がある

**残る穴（次の PR の候補）:**

- 入口 `scripts/design-artifact/image-first-generate.ts` を jail の中から直接起動する道にも、同じ拒否は無い
  - 入口は承認パケットに書かれた、オーナーが手で起動する道でもある
  - そのため、変えるには承認パケットの手順との整合を確かめる別の PR が要る
- 別案: 長い job を、jail の設定で作った**専用の一時的な unit**（`admin.sh run` と同じ形）で動かす。管理者が承認した仕組みとして作る

## 8. 承認が要る変更（提案だけ、未適用）

### (i) unit の ExecStart の変更（入れるかどうかは §9 の試験の後で決める）

- 候補 A: 今のまま（引数なしの server mode）
  - 4 時間以内なら公式にはすべての session が戻る
  - 診断で戻すのに失敗している原因が見つかれば、それを直す
- 候補 B: tmux の中で interactive の `claude --remote-control`（network 断で終わらない）にし、終わったら `claude --continue --remote-control` で戻す
  - 1 つの session だけになり、アプリから新しい session を作れなくなる
- `--continue` を server mode に常に付ける案は採らない（§3）
- 手順（どの候補でも）:
  1. `admin.sh` の `jail_install` の ExecStart と `jail.test.ts` を変える PR を作る
  2. オーナーがマージする
  3. root の clone を承認したコミットに detached で合わせる
  4. `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh jail-install`（または `approve <sha>`）
     - sr-jail-net を作り直すので、Claude が起動し直す
- 戻し方: 前のコミットに clone を戻して、同じく `jail-install`

### (ii) Windows のログオン時に WSL を起動する

**要承認・要実機確認。`.wslconfig` は変えない。**

- 方法: タスク スケジューラの「ログオン時」に、人の既定の WSL 利用者として WSL を起動したままにする
  - 例: `wsl.exe -d <distro> --exec /bin/sleep infinity` を、ウィンドウを出さずに動かす
  - `sr-designgen` では動かさない（nologin で、jail の外の process になる）
- 効果: distro が起き、unit が `multi-user.target` で起動する
  - Windows 側に wsl.exe が残る間は、アイドル停止を避けられる見込み [未確認、WSL の版による]
- 危険:
  - VM のメモリを常に使う
  - Windows のスリープ・休止・更新では止まる
  - Windows から WSL への入口の一つになる。中身は固定の sleep だけにし、引数を外から受けない
- 戻し方: タスクを無効化・削除する

### (iii) パイロットの後に Remote Control を戻す

- パイロットの前提は `claude-stop`（disable）なので、終わったあとはオーナーが `claude-start` を打つまで戻らない
- pilot の最後で戻す変更は、排他を緩めずに、別の承認で行う
- 今は、パイロットのあとに `claude-start` を1回打つ手順のまま

### (iv) start-limit は緩めない

- 1 時間に 10 回の上限は、落ち続ける Claude を止めるためにある
- `RC_UNIT_START_LIMIT` が出たら、原因を見てから**オーナーが**（Claude ではなく、承認のうえで）`sudo systemctl reset-failed sr-jail-claude` と `admin.sh claude-start` を行う

### (v) 研究日誌と CLAUDE.md の読み込み

§6 の 4。Task 化と、CLAUDE.md の変更に承認が要る。

## 9. 実機での試験計画（承認後、オーナーの WSL で）

ここでは実際の Remote Control を動かせないので、すべて計画である。各回で次の3つを記録する。

- rc-diagnose の最後の行
- アプリで前の session が続いたか
- 新しい session が出たか

| # | 構成 | 操作 | 期待（公式） |
|---|---|---|---|
| 1 | 今の unit（引数なし、server） | `systemctl restart sr-jail-claude` | 前のすべての session が戻る |
| 2 | 同上 | 15 分以上のスリープ | server が終わり（約 10 分）、systemd が起動し直し、戻る |
| 3 | 同上 | `wsl --shutdown` → 5 分後に開く | 戻る（4 時間以内） |
| 4 | 同上 | 一晩止める | 戻らない（新しい session）。研究日誌で続きを戻す |
| 5 | `--continue` を付けた server（手で、jail の shell の tmux で） | 1 と同じ | 最初の session だけが戻る |
| 6 | `--session-id <id>` の server（手で） | 1 と同じ | その session だけが戻る |
| 7 | tmux の中の interactive `claude --remote-control`（手で） | 15 分以上のスリープ | process は終わらず、自分でつなぎ直す |
| 8 | 同上 | process を終わらせて `claude --continue --remote-control` | 前の会話が続く。Remote Control で同じ session として見えるかは [未確認] |

5〜8 は jail の shell（`admin.sh shell`）の中の tmux で、人が一時的に試す。unit は変えない。
今の unit を止める・再起動する操作は、systemd の操作なので承認が要る。

## 10. 今回できなかったこと

- 実機の WSL に触れていない。原因はすべて、オーナーが rc-diagnose を実行するまで推定である
- Remote Control・モデルは一度も動かしていない。CLI の事実は `--help` とバイナリの文字列だけから取った
- 次の形はテストの偽物の上でしか確かめていない（`tests/unit/design-agent/rc-diagnose.test.ts`）
  - `journalctl --list-boots -o json` の形
  - `systemctl show --timestamp=unix` の形
  - tmux の server の process 名
  - network の error の行の文言
  - 再開の記録の置き場所 [バイナリ]
- Desktop の WSL ローカル session の idle・更新の扱いは、公式文書に無く、オーナーが挙げた報告も検証していない
