# Instagram capture helper（DEV-028 Phase 3）

ログイン済みの Instagram 専用 browser profile を、**それ専用の Linux 利用者 `sr-igcapture`** に移す。
worker・Codex・Claude（`sr-designgen`）は profile を一切読めない。
頼めるのは「この公開プロフィールを 1 件撮って」だけで、返ってくるのは符号と privacy 処理済みの PNG だけになる。

境界は 2 層（詳しくは `design-wsl-isolation.md`）:
1. **requester jail**: `sr-designgen` の process はすべて systemd の `sr-jail-*.service` の中でだけ動く。そこからは
   WSL の interop socket・vsock・Windows の drive・display・Windows host / LAN が見えない・届かない。
   WSL2 では Linux の利用者を分けただけでは境界にならない（どの process も interop socket から Windows に届き、
   Windows からは `wsl.exe -u root` で root になれる）ので、この層が前提になる
2. **Linux 利用者の分離**: その上で、profile は別の利用者 `sr-igcapture` のホーム（0700）にあり、頼める内容も spool で絞る

```
Claude（Remote Control）/ worker / Codex          ← 利用者 sr-designgen
   │  request: { id, 公開プロフィールの URL } だけ
   ▼
/srv/sr-capture/requests/   （sr-designgen は作れるだけ。一覧・読む・消すはできない）
   │  systemd が request を見て起動
   ▼
capture helper                                     ← 利用者 sr-igcapture（ホーム 0700）
   │  人が承認した commit の checkout だけを実行（自分では更新しない）
   │  ~sr-igcapture/.local/share/sr-instagram-browser/  ← ここに触れるのはこの利用者だけ
   ▼
/srv/sr-capture/results/<id>/ （sr-designgen は読むだけ）
   status.json（符号）＋ profile.png / grid-top.png / grid-lower.png（privacy 処理済み）
```

## 境界（OS が守る）

| 何を | どう守るか |
|---|---|
| `sr-designgen` の process から Windows（→ root → profile）への経路 | requester jail（`jail/jail.properties`）。`/run`（interop socket）・`/mnt`（Windows の drive・WSLg）・`/usr/lib/wsl` を隠し、vsock・io_uring・ptrace と私設 address・gateway を kernel が拒否し、専用の network namespace（pasta）で VM の localhost・abstract socket から切り離す。起動のたびに probe が実機で確かめ、満たさなければ起動しない |
| jail の外で動く `sr-designgen` | login shell は nologin、crontab / at / ssh も止める。helper は撮影のたびに、`sr-designgen` のすべての process が `sr-jail-*.service` の cgroup にいることを確かめる（cgroup に入れられるのは root だけ） |
| profile・cookie・session | `sr-igcapture` のホーム 0700。`sr-designgen` は別の利用者で、その group にも入らない |
| `sr-igcapture` の process（Chromium） | 別の uid。`/proc/<pid>/environ`・`cwd`・`fd`・`root`・`mem` は読めない |
| helper のコード | `sr-igcapture` のホームの checkout。人が `admin.sh approve <sha>` で承認した commit だけを `run.sh` が実行する。helper は fetch も更新もしない |
| root が動かす・入れるもの | `admin.sh`・systemd の unit・jail の設定は、root だけの clone（`/root/sr-capture-admin`、承認する commit）からだけ。requester の repo や helper の checkout からは動かさない |
| 頼める内容 | request は id と公開 Instagram プロフィール URL だけ（strict schema）。path・command・option・出力先は書けない |
| request の読み方 | link を辿らない・通常ファイル・link 数 1・4 KiB 以下。それ以外は `REQUEST_INVALID` |
| 返すもの | 固定の符号と、固定名の PNG（最大 3 枚）だけ。PNG は撮った時点で画像を blur → 画素化済み（生の画像は disk に書かない） |
| 濫用 | 1 回の起動で 3 件、撮影の間は 60 秒、1 日 30 件まで。結果は 24 時間で消す |
| ログイン | helper は**ログインしない**。session が切れていれば `LOGIN_REQUIRED` で止まり、人が headed login をする |

`sr-designgen` が自由な shell を持っていても（jail の中の Claude の Remote Control session など）、これらは jail と Unix の権限の両方で守られる。
利用者の分離は `tests/unit/design-agent/cross-user.test.ts`（本物の利用者 2 人、CI では root の段）、jail の設定と probe は
`tests/unit/design-agent/jail.test.ts`・`host-check.test.ts` が確かめる。jail が実際の systemd で効くことは、container の中の
systemd 255 と実機の `admin.sh jail-check`（`JAIL_OK`）で確かめた（`design-wsl-isolation.md` §5）。

## 1. 入れる（人が 1 回、sudo で）

前提（**全部必須**。満たさないと `install` も `login` も `HOST_UNSAFE` で止まり、helper も毎回 profile を開かずに `HELPER_ERROR` を返す）:
- WSL で systemd が有効（`/etc/wsl.conf` に `[boot]` `systemd=true`）
- **WSL の Windows 連携（interop）を切る（衛生。境界ではない）。**連携が有効だと、jail の外の WSL の誰でも `wsl.exe -u root` で
  root になれる。切っても境界にはならない（下記）が、jail の外の口を減らすために続ける。`/etc/wsl.conf`:

  ```ini
  [boot]
  systemd=true

  [interop]
  enabled=false
  appendWindowsPath=false
  ```

  書いたら Windows 側で `wsl --shutdown` してから WSL を開き直す（動いている間の設定も確かめる）。
  `[interop]` の綴りはこのとおり（小文字）に。別の綴りの節や同じ key が 2 回あって片方でも `false` でなければ断る。
  開き直した後、一度確かめる（どちらかが違えば interop は切れていない。止めて知らせる）:

  ```bash
  sudo /mnt/c/Windows/System32/cmd.exe /c ver        # 失敗する（Exec format error など）こと
  cat /proc/sys/fs/binfmt_misc/WSLInterop* 2>&1       # 無い、または disabled
  ```

  **これは境界ではない。**WSL 2.7.14 では interop を切っても `/run/WSL/*_interop` が `root:root 0777` で残り、
  どの利用者も Windows に届く（Microsoft も `enabled=false` を security boundary とは扱っていない）。
  境界は **requester jail**（`design-wsl-isolation.md`）: `sr-designgen` の process は `sr-jail-*.service` の中でしか動かず、
  そこからは socket・vsock・Windows の drive・display・Windows host が見えない。install が jail を入れ、probe が実機で確かめる
- requester は**一度も** admin の group（`sudo` / `docker` / `lxd` / `incus` / `disk` / `libvirt` など）や sudo を持ったことのない、新しく作った利用者にする。
  一度でも持っていたなら、その間に root で残せたもの（setuid の file、root の cron・SSH 鍵、常駐の container）は、group から外しても
  ここの確認では見つからない。その場合は新しい requester 利用者を作り直す（できれば distro も新しく）
- requester の動いている process が admin の group を持っていない（group から外しても、その前に起動した shell や Claude は
  group を持ち続ける。`REQUESTER_PROCESS_PRIVILEGED` が出たら `sudo pkill -u sr-designgen` してからやり直す）
- requester（`sr-designgen`）は **Windows が WSL を開くときの既定の利用者ではない**（uid 1000 か `[user] default` の利用者は断る）、
  `sudo` / `admin` / `wheel` / `adm` / `lxd` / `disk` / `docker` / `libvirt` / `kvm` / `systemd-journal` の group に入っていない、
  sudo の規則が無い（`sudo -l -U sr-designgen` が空）
- requester は Windows の drive（`/mnt/c` など）に書けない。**既定の WSL では `/mnt/c` は誰でも書ける（777 に見える）ので、
  必ず自動 mount を人だけのものにする。**Windows の Startup folder に置いたものは Windows の人の権限で動き、そこから
  `wsl.exe -u root` に届くため。`/etc/wsl.conf` に追加（`wsl --shutdown` の後に効く）:

  ```ini
  [automount]
  options="uid=1000,gid=1000,umask=077"
  ```

  （uid / gid は人の WSL 利用者のもの。人は今までどおり `/mnt/c` を使え、requester は読むことも書くこともできない。
  Windows の文書を Claude / Codex から隠す効果もある。確かめ方: `sudo -u sr-designgen ls /mnt/c` が Permission denied になる）
  worker の Windows へのコピー（`SR_DESIGN_EXPORT_DIR`）が要るなら、**その folder だけ**を `/mnt/sr-export` に mount する
  （`/etc/fstab`: `C:\Users\<you>\SecondRootDemos /mnt/sr-export drvfs uid=<sr-designgen の uid>,gid=<同 gid>,umask=077 0 0`）。
  ここだけは書けてよい。mount するのは 3 段目以下の、ただの folder（`C:\Users\<you>\<folder>`）。drive や利用者の folder、
  `AppData` / `ProgramData` / `Windows` を mount していれば `EXPORT_MOUNT_UNSAFE` で断る
- **system 全体の Node 22**（`/usr/local/bin` か `/usr/bin`、実体まで root の所有で他人が書けないこと）。`sr-designgen` の nvm の node は `sr-igcapture` から読めないので使えない
  （例: NodeSource の手順 https://github.com/nodesource/distributions 。tarball を `sudo tar` で展開したなら `sudo chown -R root:root <dir>`）

- **`sr-designgen` の process をすべて止める**（Phase 2 の Remote Control・worker: `sudo pkill -u sr-designgen`）。動いていると install は
  `REQUESTER_RUNNING` で止まる。install は `sr-designgen` の login shell を nologin にし、以降は jail の中でだけ動かす
- **Phase 2 の古い profile を先に消す**（`sudo rm -rf /home/sr-designgen/.local/share/sr-instagram-browser`）。
  jail の中でも `sr-designgen` 自身の home は見えるので、残っていれば Claude が読める。残っていると probe（`BROWSER_PROFILE_IN_HOME`）で install が止まる
- requester jail の前提: `sudo apt install -y tmux passt iproute2 python3`、WSL の cgroup が v2 だけ
  （`stat -fc %T /sys/fs/cgroup` が `cgroup2fs`。違えば Windows の `.wslconfig` に `kernelCommandLine = cgroup_no_v1=all`）、
  DNS は dnsTunneling（`/etc/resolv.conf` が `nameserver 10.255.255.254`。systemd-resolved の stub や dnsTunneling を切った構成は使えない）、
  networkingMode は NAT（既定）。`.wslconfig` を変えたら Windows で `wsl --shutdown`

`admin.sh` は root で動くので、**requester が書き換えられる checkout（`~sr-designgen/work/second-root` など）からは動かない**
（`ADMIN_SCRIPT_UNTRUSTED`）。install も、その後の login・approve・jail-check なども、root だけの clone から行う:

```bash
SHA=<承認する commit の 40 文字>
sudo git clone -q https://github.com/ioda47871-byte/second-root.git /root/sr-capture-admin
sudo git -C /root/sr-capture-admin checkout -q "$SHA"
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh install "$SHA"
```

- 上の前提を確かめる（どれか欠ければ理由を全部表示して止まる）
- 利用者 `sr-igcapture`（パスワードなし、ホーム 0700）と group `sr-capture` を作る
- `sr-designgen` を `sr-capture` に入れる（`sr-igcapture` の group には入れない）
- `/srv/sr-capture/{requests,results}` を正しい権限で作る
- requester の login shell を nologin にし、crontab・at の job を消し、ssh の `DenyUsers` を置き、lingering の user service を止める
  （jail の外で `sr-designgen` が動く道を残さない）
- 承認の確認（commit の先頭 12 文字を打つ）の後、`sr-igcapture` のホームに repo を clone し、指定した commit を checkout、
  `npm ci --ignore-scripts`（依存の install script は動かさない）、Chromium を入れる。使う node の場所も記録する
- systemd の `sr-capture.path` / `sr-capture.timer` を有効にする

`sr-designgen` は以後 jail の unit としてだけ起動する（group の変更も、その起動時に反映される）。

install は最後に requester jail を入れる（`sr-jail-net.service`（jail 専用の network）と `sr-jail-claude.service` を書き、
読み込まれた unit の設定を確かめ、`admin.sh jail-check` で probe を通す）。probe が通らなければ install は `JAIL_UNSAFE` で止まる。
その後、人が `admin.sh shell`（jail の中の shell）で Claude Code を入れて sign-in し、`admin.sh claude-start` で Remote Control を起動する
（`design-wsl-autonomy.md` §1）。

helper（`run.sh`）は起動のたびに、interop の設定と requester の group、**requester のすべての process が jail の中にあること**を確かめ直す。
満たさない間の依頼には、profile を開かずに `HELPER_ERROR`（`WSL_INTEROP_ON` / `REQUESTER_PRIVILEGED` / `PROC_HIDDEN`）を返す。
jail の外に `sr-designgen` の process が 1 つでもあれば（人が `sudo -u sr-designgen …` を打った間など）`REQUESTER_PRIVILEGED` になる。

## 2. ログイン（人が、headed で）

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh login
```

- `admin.sh login` は、まず jail の unit（Claude の Remote Control・`run`・`shell`）を止め、ログインの間は Claude が起動しないようにする
  （jail は display を見られないが、念のため）。jail の外に `sr-designgen` の process が残っていれば
  `HOST_UNSAFE`（`REQUESTER_OUTSIDE_JAIL`）か `REQUESTER_RUNNING` で止まる（`sudo pkill -u sr-designgen` の後にやり直す）
- ログインが済んだら（`LOGIN_OK`）、helper の「待ち」の印も消え、止める前に動いていた Claude と helper は起動し直される

窓の中で自分でログインする（password・2FA・確認画面も自分で）。この道具は入力もクリックもしない。

**以前の profile（`sr-designgen` のホームのもの）は移さない。**コピーは cookie の持ち出しと同じなので行わない。
新しくログインした後、古いものは消す。

```bash
rm -rf /home/sr-designgen/.local/share/sr-instagram-browser
```

## 3. 頼む（Claude・worker、jail の中の `sr-designgen` で。人は `admin.sh shell` / `admin.sh run sr-designgen -- …`）

```bash
cd ~/work/second-root
npm run -s sales:design-capture -- --request-id shop-001 --source-file ~/sr-design-input/shop-001/source.json
```

| 表示 | 意味 | 終了コード |
|---|---|---|
| `CAPTURED` | 撮れた。PNG は `~/.local/share/second-root-design/helper-captures/<id>/`（24 時間で消える） | 0 |
| `LOGIN_REQUIRED (NO_PROFILE など)` | session が無い・切れた。表示された login コマンドを**人が**打つ。`(WAITING_FOR_PERSON)` は「前に壁に当たったので、人がログインするまで browser を開かない」 | 5 |
| `INSTAGRAM_CHALLENGE` / `INSTAGRAM_CAPTCHA` | 確認を求められた。回避しない。人が様子を見る | 6 |
| `PUBLIC_SOURCE_UNAVAILABLE (理由)` | 非公開・存在しない・外への移動など | 4 |
| `RATE_CAPPED` | 1 日の上限 | 4 |
| `REQUEST_INVALID` | request の形が違う | 4 |
| `CAPTURE_HELPER_TIMEOUT` | 時間内に答えが無い（helper が止まっている、順番待ち） | 4 |
| `CAPTURE_HELPER_UNAVAILABLE` | helper が入っていない（spool が無い） | 3 |

worker は helper が入っていれば自動で使う（公式サイトが無いとき、公開 Instagram より先に）。

## 4. helper を新しい版にする（人が、sudo で）

helper のコードは自動では変わらない。新しい commit を使うときは、差分を**全部**確かめてから承認する。
`lib/` や `scripts/` だけでなく、`package.json`・`package-lock.json`・`tsconfig.json`・`.npmrc` の変更も helper の動きを変えうる。

```bash
sudo git -C /root/sr-capture-admin fetch -q origin
sudo git -C /root/sr-capture-admin checkout -q --detach <新しい sha>
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh approve <新しい sha>
```

- 承認済みの commit からの変更（`git diff --stat`）を表示し、全文の見方を示す
- commit の先頭 12 文字を打つと承認される（打たなければ何も変わらない）
- systemd の unit と jail の設定は、root だけの clone（`/root/sr-capture-admin`。その commit に合わせておく）から入れる。
  `sr-designgen` の repo からも、Instagram の画面を描く `sr-igcapture` の checkout からも入れない（どちらも root 以外が書き換えられる）。
  root の clone がその commit でなければ `ROOT_CLONE_NOT_AT_SHA` で止まる

## 5. 状態と後片付け

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh status
journalctl -u sr-capture.service -n 50     # 符号だけが出る
```

ログインを捨てるとき:
1. Instagram の「ログインアクティビティ」でこの端末をログアウトさせる
2. `sudo rm -rf /home/sr-igcapture/.local/share/sr-instagram-browser`

## 残るリスク（承知の上）

- headed login の窓は WSLg の display に出る。jail の中からは display（`/mnt/wslg`・`/tmp/.X11-unix`・VM の abstract socket）は
  見えない。加えて `admin.sh login` は jail の unit を止めてから始め、ログイン中も 0.5 秒ごとに見張り、jail の外に requester の process が
  現れたら窓を閉じる（Ctrl-C や端末を閉じても窓は消え、helper と Claude は戻る）。ログインの間は worker の timer も止めておく（`design-worker-wsl.md` §6）
- jail の境界そのものの残るリスク（kernel の脆弱性、jail の中で許している user namespace、root で動く pasta など）は
  `design-wsl-isolation.md` §6。より強い境界が要るなら、Claude を別の VM に置く（同 §3 の C）
- jail は LAN・Windows host の私設 address を拒否する。Windows drive の確認（mount の根元と Startup folder）は jail の外の口を減らすための
  もので、drvfs の `metadata` で個別の所有者を付けている場合、深い場所の folder までは見ない（jail の中からは `/mnt` 自体が見えない）
- helper の確認は起動ごと（1 回の起動は最長 1700 秒）。その途中で interop を戻したり group を足したりした分は、次の起動まで見えない。
  `/proc` を `hidepid` で mount している machine では、helper から requester の process が見えないので、helper は断る（`PROC_HIDDEN`）
- `admin.sh login` 自体が SIGKILL（root か OOM による）で止まると、後始末（窓を閉じる・helper の再開）は動かない。
  requester は root の process を止められないので、requester からは起こせない。起きたら `sudo pkill -u sr-igcapture` と
  `sudo systemctl start sr-capture.path sr-capture.timer`
- 公式サイトの撮影の間、worker の中の proxy（127.0.0.1）は同じ machine の誰でも使えるが、行けるのは公開の宛先の 80 / 443 だけ（新しい到達先は増えない）
- 公式サイトの撮影は worker の中の proxy が直接つなぐ（名前の確かめと接続先を一致させるため、`HTTPS_PROXY` の上位 proxy は使わない）。
  上位 proxy を通さないとインターネットに出られない network では公式サイトは使えない（家庭の WSL では問題にならない）
- 公式サイトの撮影は 198.18.0.0/15 を内部の宛先として断る。fake-IP 型の proxy DNS（Clash など）や一部の VPN はここを使うので、
  その環境では全サイトが `unavailable` になる（そのときは proxy を外して撮る）

- Instagram の利用規約は自動的な収集を制限している。1 件ずつ・少数・最小の操作にしてあるが、アカウント制限のリスクは無くならない（`design-browser-wsl.md`）
- root を持つ人（sudo）は何でも読める。sudo を Claude に渡さない（requester に sudo の規則や admin の group があれば install / login は断る）
- `sr-capture` の group に入った別の利用者は、results の PNG を読める（今は `sr-designgen` だけ）
