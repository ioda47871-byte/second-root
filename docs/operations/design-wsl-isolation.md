# WSL での隔離の設計（DEV-028 Phase 3、2026-10-01 再設計）

Claude（Remote Control）・worker・Codex が `sr-designgen` で任意の shell を持ったままでも、
Instagram のログイン済み browser profile（`sr-igcapture`）に届かないようにする。その境界を、
WSL 2.7.14 の実機の挙動を前提に作り直した記録。

## 1. 何が起きたか（実機の事実）

WSL 2.7.14.0 / kernel 6.18.33.2-2 / Ubuntu 24.04。`/etc/wsl.conf` は `[interop] enabled=false`・`appendWindowsPath=false`。

- `WSLInterop` の binfmt は無い。`sr-designgen` から `cmd.exe` を実行しても Permission denied
- `/mnt/c` は metadata・uid/gid・umask=077 で、`sr-designgen` からは書けない。sudo の規則も無い
- **しかし `wsl --shutdown` の後も `/run/WSL/1_interop -> 2_interop` が残り、`2_interop` は `srwxrwxrwx root:root`。
  `sr-designgen` から書ける（＝接続できる）**

WSL の interop socket に接続できれば、`/init` を interop の client として使って Windows の process を
Windows の利用者として起動できる。Windows 側からは `wsl.exe -u root` で、どの distro でも root になれる。
Microsoft は `[interop] enabled=false` を security boundary として扱っていない。
WSL2 の VM には、ほかにも vsock という Windows への経路がある。

**結論: WSL2 の中では「別の Linux 利用者」は、Windows（と root）に対する境界にならない。**
前の設計（Linux 利用者の分離 + interop off の確認）は、ここで成り立たなくなった。

## 2. 脅威モデル

| 項目 | 内容 |
|---|---|
| 守るもの | `sr-igcapture` の Instagram profile（cookie・session）。次に、人の Windows 利用者の権限（そこから root・profile へ届くため） |
| 攻撃者 | `sr-designgen` で動くものすべて: Claude（Remote Control の任意 shell。prompt injection を受けうる）、worker、Codex、Chromium、npm の依存 |
| 攻撃者ができること | `sr-designgen` として任意の code を実行する。network に出る。spool に依頼を書く |
| 信頼するもの | Windows の人と、人の WSL 利用者（uid 1000）。root。`sr-igcapture`（承認した commit だけを動かす helper） |
| 境界 | `sr-designgen` の process から Windows へ届く経路を、OS（mount namespace・seccomp・cgroup BPF）でなくす。そのうえで Linux 利用者を分ける（profile の Unix 権限） |

Windows へ届く経路と、それぞれの塞ぎ方:

| 経路 | 塞ぎ方 |
|---|---|
| `/run/WSL/*_interop`（0777 の Unix socket） | `/run` を空の tmpfs にする（mount namespace）。jail の中には socket が存在しない |
| vsock（WSL2 の VM と Windows の間の socket） | `RestrictAddressFamilies`（seccomp）で `AF_VSOCK` を拒否。`/dev/vsock` も無い（`PrivateDevices`） |
| io_uring（`socket()` を通らずに socket を作れる） | `SystemCallFilter=~io_uring_*`（EPERM） |
| `/init`・`/usr/lib/wsl` | 読めない（`InaccessiblePaths`） |
| Windows の drive（`/mnt/c` の Startup folder など） | `/mnt` を空の tmpfs にする（DNS の `resolv.conf` だけ戻す） |
| WSLg の display（`/mnt/wslg`・`/tmp/.X11-unix`） | `/mnt` は空、`/tmp` は private |
| Windows host への network（NAT の gateway）、LAN、cloud metadata | `IPAddressDeny`（cgroup BPF）。私設・link-local の範囲すべてと、その時点の default gateway。WSL の DNS tunnel（10.255.255.254）だけ許す |
| 他の利用者の process（`/proc/<pid>/root` など） | `ProtectProc=invisible`、別 uid |
| 新しい権限（setuid・sudo） | `NoNewPrivileges`、`RestrictSUIDSGID` |
| jail の外で動く `sr-designgen` の process（`su`・`wsl.exe -u`・ssh・cron など） | login shell を nologin にし、cron / at / linger を拒否。`run.sh`（毎回）と `admin.sh` が、`sr-designgen` の**すべての process** が `sr-jail-*.service` の cgroup の中にあることを確かめる（cgroup に process を入れられるのは root だけ） |

## 3. 選択肢の比較

| 案 | 境界の強さ | 自律性 | 手間・費用 | 判定 |
|---|---|---|---|---|
| A. Linux 利用者の分離 + interop off（前の設計） | **成り立たない**（0777 の socket、vsock） | 高い | 低い | 不可 |
| **B. requester jail（systemd の sandbox）+ Linux 利用者の分離** | OS の境界（mount ns・seccomp・cgroup BPF・cgroup の所属）。起動ごとに probe が実機で確かめ、満たさなければ起動しない | 高い（Claude は jail の中で repo・test・worker・Codex・push を行える） | 低い（追加の machine なし。WSL のまま） | **採用** |
| C. Claude を別の VM（Hyper-V など、Windows 連携なし）へ | hypervisor の境界で最も強い | 高い | 中〜高（Hyper-V は Pro 以上、VM の管理、VM と helper の間の通信路が新しく要る） | B が実機の probe を通らないときの次の候補 |
| D. Instagram profile を別の machine（別端末・cloud VM）へ | 強い（この PC の Windows から届かない） | 中（headed login は遠隔の画面になる） | 中〜高（機材・費用） | 今は採らない |
| E. ログイン済み profile を使わない（公式サイト + 未ログインの公開 Instagram だけ） | 守るものが無くなる | 高い | なし | B が使えない間の安全な既定（helper を入れなければこうなる） |

B を選んだ理由:
- 塞ぐべき経路は「Windows へ届く経路」で、§2 の表のとおり有限であり、それぞれ OS の仕組みで塞げる
- 「設定したつもり」で終わらせない。jail の中で `jail/probe.py` が一つずつ確かめ、満たさなければ systemd が unit を起動しない（fail closed）
  - 確かめる項目: interop socket が無い、`AF_VSOCK` が拒否される、io_uring が拒否される、私設 address が `EPERM`、他の process・他の home が見えない、など
- Codex の sandbox（bubblewrap）・Chromium・Node はそのまま jail の中で動く（下の §5 で確認）

## 4. 構成

```
Windows（人）── WSL2 VM ── Ubuntu distro
                            ├─ uid 1000（人。信頼する。sudo を持つ）
                            ├─ sr-igcapture（Instagram profile。home 0700。helper は systemd の sr-capture.service）
                            └─ sr-designgen（login shell は nologin）
                                 └─ sr-jail-claude.service ← jail（jail/jail.properties + 起動前の probe）
                                       └─ tmux → claude remote-control → git / npm / worker → Codex（bubblewrap）・Chromium
```

- jail の設定は `scripts/sales-design-capture/jail/jail.properties` の一つの list にまとめた
  - `admin.sh` はこれを unit file（`sr-jail-claude.service`）と、人の jailed shell（`admin.sh shell`）・`admin.sh run`・`admin.sh jail-check` の `systemd-run -p` の両方に使う
  - list には `User=`・home の bind・default gateway の拒否・起動前の probe を加えて渡す
- jail の file（list と probe）は、root だけの clone か helper の checkout から、root の所有で `/usr/local/lib/sr-jail/` に入る。`sr-designgen` は変えられない
- spool は jail の中に `requests`（書き込み）と `results`（読み取り）だけが見える
- 人が Instagram にログインする間（`admin.sh login`）は、jail の unit をすべて止めてから始め、終わったら戻す

## 5. この設計を確かめた方法（container の中で systemd 255 を PID 1 として起動）

Ubuntu 24.04 と同じ systemd 255 を、container の中で PID 1 として起動して確かめた。
WSL の状況は fixture で再現した（`/run/WSL/2_interop` を `root:root 0777` の待ち受け socket にする、`/mnt/c`・`/mnt/wslg`・`/usr/lib/wsl` も用意する）。

| 確かめたこと | jail の外（同じ利用者） | jail の中 |
|---|---|---|
| `/run/WSL/1_interop` への接続 | 届く | socket が存在しない |
| `socket(AF_VSOCK)` | 作れる | `EAFNOSUPPORT` |
| io_uring | 作れる | `EPERM` |
| 私設・link-local・gateway への UDP 送信 | 送れる | `EPERM`（cgroup BPF） |
| `/mnt/c`・`/mnt/wslg`・`/tmp/.X11-unix`・`/usr/lib/wsl` | 見える | 無い / 読めない |
| 他の home、`/home/sr-igcapture`、他の利用者の process | `/home/sr-igcapture` 以外は見える | 見えない |
| file system 全体を歩いて、接続できる Unix socket・abstract socket を探す | 対照は時間の都合で interop socket だけ確認 | なし |
| probe（`jail/probe.py`） | 13 項目で `JAIL_UNSAFE` | `JAIL_OK` |
| jail の外で abstract socket（`@/tmp/.X11-unix/X9`）を待ち受けさせる | — | probe が `ABSTRACT_SOCKET_REACHABLE` で止める |
| jail の中で `sandbox.test.ts`（本物の bubblewrap の攻撃テスト）と `worker.test.ts`（Chromium を含む） | — | 73 件すべて pass |
| `admin.sh jail-install` → `claude-start` → process の cgroup が `sr-jail-claude.service`、jail の外に process を起こすと `REQUESTER_OUTSIDE_JAIL` → `claude-stop` | — | 期待どおり |

わかったこと:
- `ProtectKernelTunables`・`ProtectKernelLogs`・`ProtectHostname` は `/proc` の一部を上書き mount するので、jail の中で
  bubblewrap が新しい `/proc` を mount できなくなる。Codex の sandbox が動かなくなるため外した（守っているものは root でしかできない操作）
- `IPAddressDeny` で落とされた TCP の SYN は timeout になるだけなので、probe は UDP で確かめる（拒否されれば即座に `EPERM`）
- requester 自身の home は jail の中から見える。Phase 2 の profile（`~/.local/share/sr-instagram-browser`）が残っていれば
  Claude が読めるため、probe は `BROWSER_PROFILE_IN_HOME` で止める（**古い profile の削除は必須**）

## 6. 残るリスク

- **kernel・WSL の不具合**: namespace / seccomp / BPF を越える kernel の脆弱性、または WSL の未知の経路。
  probe は既知の経路しか確かめない。より強い境界が要るなら §3 の C（別の VM）
- **abstract Unix socket**: network namespace は共有しているので、同じ VM の中で abstract socket を待ち受けている process には届きうる。
  probe は見えている abstract socket すべてに接続を試し、一つでも応じれば `ABSTRACT_SOCKET_REACHABLE` で止める（名前を `JAIL_NOTE` で表示）。
  WSLg の X server がこれに当たる場合は、§3 の C か、jail に専用の network namespace（pasta など）を与える案を検討する
- **localhost**: worker の preview と egress proxy のために loopback は許している。同じ VM の他の distro・人の利用者が
  localhost で認証なしの service（Chrome の remote debugging、Jupyter など）を動かしていれば届く。動かさないこと
- **networkingMode=mirrored は対象外**: loopback が Windows と共有になる。NAT（既定）で使う
- 人が root で `sudo -u sr-designgen <command>` を打つと jail の外で動く。helper はその間 `HELPER_ERROR` を返す（profile は開かない）
- Claude Code 自身の資格情報（`~/.claude`）、GitHub の token、Meta token は、jail の中の Claude からは読める（Claude 自身のもの）。
  Codex からは読めない（Codex の sandbox）
