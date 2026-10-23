# Updating passt / pasta without weakening the jail (DEV-086 design, DEV-087 final review)

Status: **final plan for the approval decision (DEV-087, 2026-10-22). Nothing has been installed, changed or run on the
WSL machine.** No Codex run, no passt update, no WSL config change, no jail change, no worker or timer change. Every step
in §4.6 and §5–§6 is a proposal, and each needs the human approval named in §8, in that order. **Only A-1 (HUMAN-024b
and 24b-host) is done.** 2026-10-23: A-2 and A-3 adopted as policy (`.ai/blockers.md` HUMAN-024); A-3's code is
implemented in DEV-088 (§4.6) and **not applied on WSL**; applying it, and every WSL step, still needs its own approval. Related: [`imagegen-timeout-investigation.md`](imagegen-timeout-investigation.md)
(H1), [`design-image-poc.md`](design-image-poc.md) §"HUMAN-024" (24a and 24b results, the EOF analysis, 24b-v2),
[`design-wsl-isolation.md`](design-wsl-isolation.md) (the jail), `.ai/blockers.md` HUMAN-024.

Labels used below:
- **CONFIRMED**: read in a primary source, or checked here.
- **INFERRED**: reasoned from sources but not run.
- **UNVERIFIED**: not checked yet; marked where it matters.

## 0. 承認判断のための要約

**結論.** 24b（jail の中で A が 27 秒・B が 57 秒で終わり、C と host の 3 本は 100 秒開いたまま）は、
「古い pasta（`1e6f92b`）が keepalive の probe に ACK を返さないので、jail の kernel が接続を切る」ことを強く支持する。
直す版は Ubuntu 26.04（resolute）の `passt 0.0~git20260120.386b5f5-1`（署名と hash を確認済み）。
ただし **画像生成の約 156 秒の失敗が同じ原因だとはまだ言えない**（24b は応答を受け取った後の待機、Codex は応答前の POST の待機）。
それを示せるのは更新後の Codex 1 回（A-8）だけ。
EOF（`ERR_ETIMEDOUT` ではなかった）について: Ubuntu 24.04 の Python 3.12 の ssl が kernel の `ETIMEDOUT` を EOF として返すことを
手元の試験（noble と同じ package）で確認した。人の machine での errno そのものは 24b では出せないので未確認だが、時刻の一致から
これが最も確からしい（`design-image-poc.md` の「24b result」）。結論は変わらない。

以下の 7 点は、どれも「事実 → リスク → 対策 → 残るリスク」の順。

**1. Ubuntu 26.04 版の passt を 24.04 に入れる影響（§3.1）**
- 事実: 依存は `libc6 (>= 2.38)` だけ（noble は 2.39、`GLIBC_2.38` より新しい symbol は使っていない）。他の package は引き上げない。
  増える file は `/usr/bin/passt-repair`・その man・`/etc/apparmor.d/usr.bin.pasta`（AppArmor の profile）の 3 つ。消える file はない。
  変わるのは passt / pasta の binary（hard link のまま）・`qrap`・AppArmor の abstractions と `usr.bin.passt`・man。
  postinst は `local/usr.bin.pasta`（空）を作る。noble で passt を参照するのは podman（Recommends）と libvirt-daemon-driver-qemu（Suggests）だけで、Depends はない。
  apt の source は足さない（deb 1 つを hash で固定して `dpkg -i`、その後 `apt-mark hold passt`）。
  jail の flag の意味は `--dns-forward` 以外変わらない（option の削除なし、`--netns` では user namespace を作らないのは両方の版で同じ）。
- リスク: (a) 他の release の deb を入れることになり、`design-wsl-isolation.md` §6 の規則に反する。
  (b) 自動の security update が来ない（resolute の universe、noble の apt からは見えない）。
  (c) podman などが pasta を使っていれば、その動作も変わる。
- 対策: (a) は人の明示の例外（A-2）。(b) は保守の担当と頻度を決める（A-10。Ubuntu と Debian の CVE tracker と resolute の公開履歴を毎月と jail の変更の前に見る。現時点で passt の CVE はない）。
  (c) は V-0 が他の pasta / passt の process と podman / buildah / libvirt の有無を記録し、あれば止まる。
- 残るリスク: 更新は人の手作業（新しい版ごとに V-1〜V-3 を再実行）。resolute の universe は Canonical の security の保証の対象外。

**2. DNS の UDP/853 が新たに許可される問題（§4.6）**
- 事実: 新しい pasta の `--dns-forward` は UDP と TCP の 53 と 853 を host の resolver（WSL の DNS tunnel `10.255.255.254`）へ送る（`fwd.c` `is_dns_flow`）。
  TCP は今の ip rule（`198.51.100.53` への TCP をすべて `prohibit`）で引き続き拒否される。**UDP/853 だけが新しく通る。**
  386b5f5 には DNS の転送を 53 番に限る option はない（man page・`conf.c` を確認）。
- リスク: jail から WSL VM の loopback 上の `10.255.255.254:853/udp` に届く（そこで何かが聞いていれば）。小さいが、今より広い。
- 対策（安全性を緩めない方式）: jail の namespace の ip rule を「`198.51.100.53` へは UDP/53 だけ、他はすべて `prohibit`」に変え、853 は明示の `prohibit` も置く（3 行、§4.6 D-1）。
  probe に「UDP/853 と他の port が即座に `EACCES`」の確認を足す。**更新の前に**入れる（古い pasta では、届かない文書用 address へ出ていた UDP が止まるだけなので、何も壊れないことを JAIL_OK と `getent` で示せる）。更新の後もそのまま。
  jail の変更なので別の承認（A-3）。**A-3 は方針として採用済み（2026-10-23）、code は DEV-088 で実装済み。実 WSL への適用（§4.6 D-0〜D-4、`jail-install` を使い `approve` は使わない。root clone ごと動くので、D-0 が出す commit と file の一覧ごと承認する）は別の承認。**
- 残るリスク: UDP/53 で host の resolver に届くのは今と同じ。kernel が UDP の `prohibit` に `EACCES` を返すことは kernel の source で確認したが、WSL の kernel での実測は A-3 の適用の後の D-3 で行う。

**3. AppArmor・seccomp・jail のネットワーク制限の維持（§4.3〜§4.7）**
- 事実: jail の制限（`jail.properties` の seccomp・`IPAddressDeny`、pasta の unit の `IPAddressAllow/Deny`、namespace の ip rule、probe）は systemd と kernel が持ち、package の更新では変わらない。
  pasta 自身の seccomp と capability の削減は pasta の code が行う（版で変わりうる）。今の pasta は AppArmor の profile がなく、この WSL kernel では AppArmor は動いていない見込み（INFERRED）。
- リスク: 新しい pasta が自分の権限を前より広く残すこと。AppArmor が動いていた場合に新しい profile が `/run/netns/srjail` を拒むこと。
- 対策: 更新の前後で同じ snapshot（S-1）を取り、稼働中の pasta の `/proc/<pid>/status`（`Uid`・`CapEff/CapPrm/CapBnd/CapAmb`・`NoNewPrivs`・`Seccomp`）、AppArmor の状態（`/sys/kernel/security/lsm`・`aa-enabled`・profile の file）、ip rule、unit の hash と `IPAddressAllow/Deny`、`jail.properties` と probe の hash を行ごとに比べる。
  capability が 1 つでも増える・`Seccomp` が 2 でない・unit / rule / 設定の hash が変わる → rollback。最後に JAIL_OK。
  pasta が起動できなければ jail の unit はすべて止まる（`BindsTo`）ので、失敗は**閉じる側**（§4.7）。
- 残るリスク: pasta は root で動くので、pasta の脆弱性は root への道のまま（今と同じ。`design-wsl-isolation.md` §6 の既存のリスク）。

**4. 既存の Claude・worker の運用への影響（§5.0）**
- 事実: 更新の間止まるのは jail の中のもの全部: `sr-jail-claude`（Remote Control の Claude）と、`admin.sh run` で動く一時 unit（worker・PoC・probe）。
  `claude-stop` は `sr-jail-*` をすべて止めるので、**動いている worker の job も途中で止める**。jail の外の capture helper・bridge は pasta を通らないので影響なし。
  記録では cycle の timer は有効化されていない（HUMAN-010 は保留）。
- リスク: 作業中の worker の job や Codex を途中で切ること。Claude の作業中の turn が失われること。
- 対策: timer を変えずに、作業の前に読むだけの確認（W-0）をする: timer の一覧と次の実行、`sr-jail-run-*` などの unit、worker / Codex の process、cycle の lock。何か動いていれば待つ。
  timer が有効なら、次の実行まで 30 分以上ある時間を選ぶ。それができないときだけ、cycle 自身の lock を作業の間持つ（A-12a）か、timer を止める（A-12b、別の承認）。jail の Claude には事前に commit と push を済ませて止まってもらう。
- 停止時間の見込み: Claude と jail の中のもの 5〜10 分（更新と直後の確認、24b-v2 を含む）。rollback すると +5〜10 分。jail の外と cloud の Claude Code の session は影響なし。
- 残るリスク: 人が窓の間に手で worker や PoC を始めないこと（運用の約束）。

**5. 更新前の状態保存と確実な rollback（§5 V-0、§6）**
- 事実: 変わるのは passt の file・AppArmor の file（conffile、`local/`・`disable/`・`force-complain/`・cache）・dpkg の記録と hold・稼働中の pasta・Claude の enabled / active。
- 対策: V-0 が全部を記録する（S-1 の snapshot を `v0.txt` に、Claude と hold を `v0-state` に、AppArmor の周りの file を `v0-apparmor.tar` に、旧版の deb を hash 付きで保存）。
  rollback は「purge → 保存した noble の deb を `dpkg -i` → AppArmor の周りの file を V-0 と同じに戻す → hold を戻す → jail を起こす → Claude を V-0 の状態に戻す」。
  最後に S-1 をもう一度取り、`v0.txt` と `diff` して差がないことを確かめる（§6.4 の checklist）。
- 今回の見直しで直した点: (a) `systemctl show -p ExecStart` は起動時刻と pid を含み、更新の前後で必ず変わるので、比較は unit file の行と hash にした。
  (b) purge は `local/usr.bin.passt` と `disable/`・`force-complain/` の passt の file も消すので、V-0 でそれらを保存し、R-2 で戻すようにした。
  (c) file の比較から inode を外した（再 install で必ず変わる）。hard link は `-ef` で見る。
- 残るリスク: 更新と rollback は root の手作業（1 行ずつ人が実行）。WSL 全体の backup（`wsl --export`）は提案しない。

**6. 更新後の通信検証とセキュリティ確認（§5 V-3）**
- 直後（A-5 の中）: S-1 の比較（上の 3）、`pasta --version`、hash、hold、`dpkg --verify`、JAIL_OK、jail の中で `getent hosts github.com`、UDP/853 の確認（A-3 を入れていれば `EACCES`、入れていなければ UDP は `NOT_REFUSED`）、TCP/53 と TCP/853 が `EACCES`。capability は減るのは可、増えれば rollback。`Seccomp_filters` は V-0 以上。
- 通信（A-6）: 24b の代わりに **24b-v2** を jail と host で 1 回ずつ。期待: jail で A・B・C とも `end=OPEN`、A と B の `ack_age_max_s` が 20 以下（keepalive に ACK が返っている）、host は今と同じく 3 本とも `OPEN`。
- 成功: 上のすべて → Claude を V-0 の状態に戻す（V-2b）。その後に Codex 1 回（A-8、別の承認）。
- rollback する: jail-net が動かない、JAIL_OK でない、capability が増えた・`Seccomp` が 2 でない・unit / rule / 設定の hash が変わった、`dpkg --verify` が clean でない、jail で DNS が引けない、A-3 があるのに UDP/853 が通る、AppArmor の拒否（A-9 を承認していなければ）。
- 止めて報告（自動で rollback しない）: 24b-v2 で jail の A / B がまだ `LOCAL_TIMEOUT`（直っていない。rollback を推奨）、host の結果が変わった、予想外の `PEER_RST` / `PEER_FIN`。
- 残るリスク: 24b-v2 が OPEN でも、画像生成の失敗が直ったことにはならない（A-8 で初めて分かる）。

**7. 作業ごとに必要な人の承認（§8）**: 下の表。**現時点で承認されているものはない。A-1（24b と 24b-host）だけが済み。**

| # | 作業 | 何が変わるか | 戻せるか | 承認 | コマンド |
|---|---|---|---|---|---|
| A-1 | 24b・24b-host | なし（読むだけの通信） | – | **済み（2026-10-22）** | `design-image-poc.md` 24b |
| A-1b | 任意: 更新前の 24b-v2（jail・host） | なし | – | 要（A-1 と同じ種類）。必須ではない | `design-image-poc.md` 24b-v2 |
| A-2 | passt を更新すると決める + `design-wsl-isolation.md` §6 の例外（resolute の `386b5f5-1` だけ） | 方針（docs） | はい | 要（人の判断） | – |
| A-3 | DNS の rule を UDP/53 だけにする（方針は採用済み、code は DEV-088 で実装済み → **適用は DEV-091 の backport**: root clone の commit `c066618` に DEV-088 の 3 file だけを足した 1 commit `fbfce3c` で `admin.sh jail-install`。clone を `e525371` へ動かす D-2 は行わない） | jail-net の unit の ip rule・probe・`jail-check`。適用時に jail が数秒止まる。timer・helper・worker・cycle・Codex の code と設定は変わらない（`sr-jail-claude.service` は byte 単位で同じ） | はい（`c066618` で `jail-install`、D-4） | **適用は要（別の承認）** | §4.6「A-3 by backport onto `c066618`」（W-0・AW-1・D-0b・D-2b・D-3・D-4。D-0 は済み） |
| A-4 | 窓の確認と V-0 の snapshot | `/root/sr-passt-update/` に記録の file だけ | はい（消すだけ） | 要 | S-1、W-0、V-0 |
| A-5 | V-1 取得と検証、V-2 更新と hold、V-3a 直後の確認、成功なら V-2b。**失敗時の rollback（R-1〜R-3）を中止の手順として同時に承認** | passt の package・AppArmor の file・dpkg の hold・pasta の再起動・Claude の停止 | はい（R-1〜R-3） | 要（root、人がその場で実行） | V-1、V-2、V-3a、V-2b、R-1〜R-3 |
| A-6 | 更新後の 24b-v2（jail・host） | なし | – | 要 | V-3b |
| A-7 | 任意: jail の中の `sandbox.test.ts` / `worker.test.ts` | なし（resource preflight の後） | – | 要 | §5.1 |
| A-8 | Codex 1 回（HUMAN-021b の v1 のコマンド） | plan の利用枠 | – | 要 | V-4 |
| A-9 | AppArmor が動いていて pasta が拒否されたときだけ: complain → profile の調整、または pasta の profile を無効化 | AppArmor の設定 | はい | 要 | §4.3 |
| A-10 | 手で入れた package の保守の担当と頻度 | 運用 | はい | 要 | §6.3 |
| A-11 | 任意: noble への SRU の依頼（外部への投稿） | 外部 | – | 要 | §7 |
| A-12a | timer が有効で窓が取れないときだけ: 作業の間 cycle の lock を持つ | なし（cycle は `CYCLE_LOCKED` で何もせず終わる） | はい（lock を離す） | 要 | L-1 |
| A-12b | A-12a でも足りないときだけ: worker の timer を止めて戻す | timer | はい | 要（worker / timer の変更） | §5.0 |

## 1. Where we are

**What HUMAN-024a (2026-10-22) showed:**
- passt `0.0~git20240220.1e6f92b-1`, Ubuntu 24.04's own package.
- Kernel `6.18.33.2-microsoft-standard-WSL2`, WSL `nat`.
- Jail `JAIL_OK`, no proxy variables.
- Upstream `1e6f92b` is an ancestor of `238c69f` (checked with `git merge-base --is-ancestor` in passt.top's repository).
  So the pasta that carries every jail TCP connection does **not** ACK keep-alive segments (CONFIRMED from source, §2;
  DEV-087 re-read `tcp_data_from_tap()` at `1e6f92b`: a keep-alive gets no ACK, no FIN and no RST).

**What HUMAN-024b and 24b-host (2026-10-22) showed** (`design-image-poc.md` "24b result"):
- In the jail: A (reqwest's options) ended at 27 s, B (keepalive only) at 57 s, C (no options) stayed open 100 s.
- On the host: all three stayed open 100 s.
- A and B printed `EOF`, not `ERR_ETIMEDOUT`. On Ubuntu 24.04's Python 3.12, the ssl module reports a socket the kernel
  aborted with `ETIMEDOUT` as a ragged EOF (CONFIRMED by a local test on noble's own `python3.12` and `libssl3t64`, and
  by the CPython source; fixed only in 3.13, gh-115627). The timing, not the word, is the evidence.

**Reading.** This strongly supports H1 on the jail path: the old pasta drops the keep-alive ACKs, and the jail's kernel
gives up at exactly the predicted times (`TCP_USER_TIMEOUT` 30 s − 3 s read window = 27 s; 15 + 3 × 15 − 3 = 57 s). The
host path answers the probes. **It is not proven that the ~156 s image failures have the same cause**: 24b idles after
a complete `GET`, while Codex `POST`s and waits for a response that has not started. That is why A-8 (one Codex run after
the fix) stays in the plan as the deciding check.

**How H1 would produce the image failures (INFERRED):**
- Codex's reqwest sockets probe after 15 s idle, and they abort at 30 s without an ACK (`TCP_USER_TIMEOUT`).
- An image generation that keeps the connection silent for more than about 30 s is therefore cut.
- Codex retries this five times, which gives about 156 s.

Ubuntu 24.04 has **no** newer passt: there is no `noble-updates`, `noble-security` or `noble-backports` build. The
Launchpad publishing history for noble ends with the release pocket's `1e6f92b-1` (published 2024-02-24, still
Published). The earlier release-pocket uploads (`08344da`, `f091893`, …) are Superseded by it, and the `-proposed`
uploads were Deleted. Nothing was published to noble after it. So "update passt" always means a package from outside
noble.

## 2. (a) Which upstream version fixes it

Upstream git, `https://passt.top/passt`. Commit dates are from `git log`; "first tag" is the oldest tag that contains the
commit (`git tag --contains`):

| commit | what | first tag | needed for H1? |
|---|---|---|---|
| `238c69f` "tcp: Acknowledge keep-alive segments, ignore them for the rest" (2024-11-21) | `tcp_data_from_tap()` sees `seq < seq_from_tap && len <= 1`, **sends an ACK**, resets the activity timer and ignores the segment. Before it, the probe was treated as a duplicate ACK, the second one triggered a fast retransmit, and **no ACK was sent** | `2024_11_21.238c69f` | **yes**: this is the fix |
| `472e2e9` "tcp: Don't discard window information on keep-alive segments" (2025-02-12) | keeps the window update carried by a keep-alive (`Fixes: 238c69f`). The commit message's motivation is TCP_REPAIR migration | `2025_02_17.a1e48a0` | no for H1, but it fixes the fix |
| `90f91fe` zero-window probe on ACK timeout (2025-02-12) | related robustness | `2025_02_17.a1e48a0` | no |
| `aa809d3` "tcp: Enable SO_KEEPALIVE if we see keep-alive segments from container / guest" (committed 2025-12-07, authored 2025-07-17) | pasta also turns on keepalive on its **host-side** socket, so WSL's NAT and middleboxes see traffic on a long idle connection | `2025_12_09.c3f1ba7` | not for the jail-side cut; helps the host-side leg of long idles (INFERRED) |
| `28f413d` don't clear ACK_TO_TAP_DUE with a zero window (2025-12-08) | related ACK fix | `2025_12_09.c3f1ba7` | no |
| `a681e44` / `d2f7c21` pasta sends its own keepalives to the guest after 5–10 min of tap-side inactivity (2026-02-25) | new behaviour, unrelated to H1 | `2026_05_07.1afd4ed` | no |

- **Minimum:** `2024_11_21.238c69f`.
- **Recommended:** at least `2025_12_09.c3f1ba7`, so that all three keep-alive commits are in. In practice that means
  Ubuntu 26.04's **`0.0~git20260120.386b5f5-1`** (§3). It contains `238c69f`, `472e2e9`, `90f91fe`, `aa809d3` and
  `28f413d`, and not `a681e44` / `d2f7c21`.

Upstream tags are **lightweight tags on unsigned commits** (`git cat-file -t` gives `commit`; no PGP signature on the
tag or the commits checked). Provenance therefore comes from the distribution archives' signatures, not from upstream git.

## 3. (b) Candidate sources

| source | version | contains the fix? | provenance / signing | how it would be installed | maintenance |
|---|---|---|---|---|---|
| Ubuntu noble (`-updates`, `-security`, `-backports`) | none: only `1e6f92b-1` | – | – | – | – |
| **Ubuntu 26.04 LTS `resolute`** (release pocket) | **`0.0~git20260120.386b5f5-1`**, published 2026-01-22 | **yes, all three** | `InRelease` signed by "Ubuntu Archive Automatic Signing Key (2018)" (key `F6ECB376…991BC93C`, already in noble's `/usr/share/keyrings/ubuntu-archive-keyring.gpg`) → `universe/binary-amd64/Packages.xz` SHA256 → deb SHA256 `49eaf773c120432bdf439d26d3de4d9867116580a819e6eba815b600c45b9840`. **Checked here** (gpgv "Good signature"; Packages hash matched Release; the deb matched Packages) | download that one `.deb`, verify the chain, `dpkg -i`. **Do not** add resolute to `sources.list` | universe. resolute is supported until 2031, but universe gets no guaranteed security updates. Security or bug fixes would appear as a resolute SRU, which a person would have to fetch again by hand |
| Ubuntu 26.10 `stonking` / 27.04 `tenacious` | `0.0~git20260728.f8df3f1-1` | yes | same archive key | same | interim releases (9 months). Newer isolation churn (§4.3) |
| Ubuntu 25.04 `plucky` / 25.10 `questing` | `2025_02_17.a1e48a0` / `2025_05_03.587980c-2` | `238c69f` and `472e2e9` only | same archive key | same | **both end of life**. Not recommended |
| Debian 13 `trixie` (stable) | `0.0~git20250503.587980c-2+deb13u1` | `238c69f` and `472e2e9`, not `aa809d3` | Debian archive key (not on Ubuntu by default) | would need the Debian keyring | stable updates. The only trixie update so far raised the AppArmor ABI to 4.0 |
| Debian `trixie-backports` / testing / unstable | `f8df3f1-1~bpo13+1` / `cba3570-1` | yes | Debian archive key | same | the newest (2026-10-02) includes isolation and AppArmor changes made that same week (§4.3) |
| upstream git tag, built from source | any tag | yes | **unsigned** lightweight tags over HTTPS only. A build depends on the local toolchain (`make`; `seccomp.sh` generates the filter at build time), and its reproducibility was not checked | `make` + manual install | a person owns every rebuild. **Conflicts with the standing rule** (below) |
| passt.top `/builds/latest/x86_64/` | builds of the current untagged HEAD (`8ba4132`, 2026-10-14), plus "unofficial" rpm/deb | yes | **no signature or checksum file** next to them; the project calls them unofficial | copy the binary | none. Not recommended |

The packages are maintained by upstream's own maintainer (Stefano Brivio signs the Debian changelog entries). Ubuntu
syncs them from Debian, so resolute's package is upstream's own Debian packaging.

**The standing rule.** `design-wsl-isolation.md` §6 says: "他の release の deb や自前の build は入れない" (do not install
another release's deb or a self-built binary). **Every candidate that fixes H1 breaks this rule**, because noble has no
newer passt. So the update needs an explicit, written exception from the human (A-2 in §8). That PR would also update §6.

**Recommendation: Ubuntu 26.04 `resolute`'s `passt_0.0~git20260120.386b5f5-1_amd64.deb`, installed alone with
`dpkg -i`, then `apt-mark hold passt`.** Reasons:

- **The fix and its follow-ups.** It has `238c69f`, `472e2e9` and `aa809d3`, and not the 2026-02 keepalive-to-guest
  change.
- **Provenance.** It is verifiable with the archive key the machine already trusts, through the signed `InRelease`. No
  new key, no new apt source and no pinning to another release are needed.
- **Dependencies.** The only dependency is `libc6 (>= 2.38)`. The binary needs no glibc symbol newer than `GLIBC_2.38`
  (checked with `objdump -T`), and noble has 2.39. Nothing else on the system is pulled forward.
- **Same paths.** `/usr/bin/pasta` is still a hard link to `/usr/bin/passt`, so the unit's `ExecStart` does not change.
- **Support.** It comes from an LTS series with the same maintainer chain. Its supported life is longer than the
  interim releases'.
- **Stability.** It predates the 2026-05 to 2026-10 isolation and AppArmor rework (§4.3).

**What gets worse.** Updates become manual (§6.3). Today's state is the same, though: noble's passt has not changed
since 2024-02, and it sits in universe too. There are no CVEs for passt in the Ubuntu CVE tracker or the Debian security
tracker (checked 2026-10-22).

### 3.1 What installing resolute's deb on noble changes (DEV-087, checked against both `.deb` files)

Both debs were downloaded again here and matched the hashes in V-1 (`de07c44d…` and `49eaf773…`).

**Control fields.** Identical apart from `Version` and `Installed-Size` (432 → 680 KiB): `Depends: libc6 (>= 2.38)`,
`Suggests: apparmor`, no `Pre-Depends`, `Breaks`, `Conflicts`, `Replaces` or `Provides`. The maintainer scripts are the
same `dh_apparmor` blocks plus one for `usr.bin.passt-repair` (a profile the deb does not ship, so that block does
nothing).

**Files** (`dpkg-deb -c`, compared by path):

| | files |
|---|---|
| new | `/usr/bin/passt-repair` (0755, no setuid, no file capabilities), `/usr/share/man/man1/passt-repair.1.gz`, `/etc/apparmor.d/usr.bin.pasta` (conffile) |
| removed | none |
| changed | `/usr/bin/passt`, `/usr/bin/passt.avx2` and their hard links `pasta`, `pasta.avx2`; `qrap`; the conffiles `/etc/apparmor.d/abstractions/passt` and `abstractions/pasta` (ABI 3.0 → 4.0, `userns`, new `/proc/sys/net/ipv4/*` reads, `@{run}/user/@{uid}/** rw`, `ptrace r`) and `/etc/apparmor.d/usr.bin.passt` (ABI 4.0, libvirt paths); man pages and docs |
| created by the postinst (both versions) | `/etc/apparmor.d/local/usr.bin.passt` and, new, `local/usr.bin.pasta` (empty files), whether AppArmor runs or not. Profiles are loaded only when `aa-enabled` succeeds |

noble's `apparmor` is 4.0.x, which understands `abi <abi/4.0>` (INFERRED from the version; it only matters if AppArmor
is active, §4.3).

**Other packages that use passt** (noble and noble-updates `Packages`, main and universe, amd64, searched 2026-10-22):

| package | relation |
|---|---|
| `podman` 4.9.3 | `Recommends: … passt …` |
| `libvirt-daemon-driver-qemu` 10.0.0 | `Suggests: … passt …` |

Nothing **depends** on passt, so `dpkg --purge passt` in the rollback is not blocked by them. `buildah` does not
reference passt. If podman or libvirt is installed **and** uses pasta / passt, new containers or VMs would start the new
binary; podman 4.9's arguments are still accepted, because no option was removed between the two man pages (INFERRED: the
podman side was not run). Running processes keep the old binary until they restart. S-1 records whether these packages
are installed and whether any other pasta / passt process runs; if one does, stop and decide before V-2.

**apt and the hold.** No apt source and no pin are added. With `386b5f5-1` installed by `dpkg -i`, apt sees an installed
version higher than any candidate, so `apt upgrade` / `full-upgrade` never downgrades it, and `apt install passt` reports
it as the newest version. `apt-mark hold passt` makes that explicit, covers a future noble upload with a higher version
string, and is respected by unattended-upgrades (§6.2). The passt package was installed with `apt install` (`admin.sh`
`PASTA_MISSING` hint), so it stays marked manual and `autoremove` does not touch it.

**Security updates.** On noble nothing would ever offer an update for this package: noble's archive does not have it,
and resolute is not an apt source. resolute's passt is in universe, which has no guaranteed security support from the
Ubuntu Security Team. A fix would appear as a resolute upload, which a person has to notice and install by hand (V-1 to
V-3 again, with the new hash). Responsibility, as proposed in A-10 (§6.3): the human, or Claude in a docs session on the
human's request, checks the [Ubuntu CVE tracker](https://ubuntu.com/security/cves?package=passt), the
[Debian security tracker](https://security-tracker.debian.org/tracker/source-package/passt) and resolute's publishing
history monthly and before any jail change. No CVE for passt was listed in either tracker on 2026-10-22.

## 4. (c) Keeping the jail exactly as strong

### 4.1 How the jail runs pasta (`scripts/sales-design-capture/admin.sh`)

- **The binary.** `pasta_bin="$(command -v pasta)"` must be root-owned all the way up (:149). The path is resolved
  **when `jail-install` runs** and written into the unit.
- **The unit.** `sr-jail-net.service` (:163-190):
  - `ExecStartPre`: `ip netns add srjail`; the ip rules for the DNS address inside the namespace (before DEV-088: `to
    198.51.100.53/32 ipproto tcp prohibit`; from DEV-088: UDP/53 only, §4.6);
    the jail's `resolv.conf` and the netns id.
  - `ExecStart=/usr/bin/pasta -f -q --runas 0 --config-net --no-map-gw -t none -u none -T none -U none --dns-forward
    198.51.100.53 --netns /run/netns/srjail`.
  - pasta's own sockets: `IPAddressAllow=10.255.255.254/32` (the WSL DNS tunnel) and
    `IPAddressDeny=10/8 172.16/12 192.168/16 169.254/16 100.64/10 127/8 ::1 fc00::/7 fe80::/10`.
  - `Restart=always`.
  - `tests/unit/design-agent/jail.test.ts` pins the ExecStart flag string and the order of the ip rule.
- **The jail side** (`jail.properties`):
  - `NetworkNamespacePath=/run/netns/srjail`.
  - `IPAddressAllow=127/8 ::1 198.51.100.53/32`.
  - `IPAddressDeny` with the private ranges, plus the default gateway (added by `jail_props`).
  - The seccomp filter and the rest of the list.
  - `probe.py` checks it before every start: `JAIL_OK`, or one of the `JAIL_UNSAFE` codes such as
    `NETWORK_NOT_PRIVATE`, `PRIVATE_NETWORK_REACHABLE`, `DNS_TUNNEL_REACHABLE`, `DNS_TCP_NOT_REFUSED`.
- **No port forwarding.** There is none in either direction. Outbound jail connections are terminated by pasta, which
  opens its own host socket.

### 4.2 Did any flag change meaning between `1e6f92b` and `386b5f5`?

Compared from `passt.1` and `conf.c` at both commits:

| flag | 1e6f92b | 386b5f5 | effect on the jail |
|---|---|---|---|
| `-f`, `-q`, `--netns <path>` (implies `--netns-only`) | as now | same text | none |
| `--runas 0` | `conf_ugid()`: an explicit `--runas` wins; without it, root becomes `nobody` | same code | none (pasta stays uid 0, as today) |
| `--config-net` | configures the namespace's address and routes like the host's | same | none |
| `-t none -u none -T none -U none` | no port forwarding | `none` still parsed (`conf.c:218`); the port-spec parser was rewritten in 2026-04, **after** 386b5f5 | none |
| `--no-map-gw` | do not map the gateway to the host | same. New in 2024-08: `--map-host-loopback` defaults to the gateway **unless `--no-map-gw`**, and `--map-guest-addr` defaults to unset (`conf.c:2061-2067`, `fwd.c`). So nothing on the host is mapped | none |
| `--dns-forward 198.51.100.53` | maps **UDP/53 only** to the first host resolver | maps **UDP and TCP, ports 53 and 853** (`becf81a`, 2024-07, `fwd.c` `is_dns_flow`). New `--dns-host` (default: the first resolver in the host's `resolv.conf`, as before) | **changed**, see below |

**DNS after the update.** On the TCP side nothing changes for the jail. The ip rule refuses **all** TCP to
198.51.100.53 inside the namespace, so TCP/53 and TCP/853 are still refused with `EACCES`, and `probe.py`'s
`DNS_TCP_NOT_REFUSED` check still applies. **UDP to 198.51.100.53:853 is new.** Today pasta maps only UDP **port 53** on
that address to the host resolver (`1e6f92b` `udp.c:856-858`), and UDP to any other port of it is sent on unchanged to
the real 198.51.100.53, a documentation address nobody answers. After the update pasta would forward UDP/853 to the host
resolver, `10.255.255.254:853` (`386b5f5` `fwd.c:855-859` `is_dns_flow`). The WSL DNS tunnel address sits on the VM's
loopback, where every `0.0.0.0` UDP service answers (`design-wsl-isolation.md` §2). That is a small widening. The
tightening that removes it is designed in §4.6 (A-3).

**Other changes between `1e6f92b` and `386b5f5` that touch the jail's flags (DEV-087).** There are 967 commits between
the two. Reviewed: every commit to `conf.c` and `passt.1` (options and defaults), `isolation.c`, and the TCP keep-alive
and timer code. Not reviewed one by one: vhost-user, migration (`passt-repair`, TCP_REPAIR), qrap and test-only commits;
the jail runs pasta in namespace mode and uses none of them.

| area | change | effect on the jail |
|---|---|---|
| options | no option removed (`passt.1` option lists compared). New: `--dns-host`, `--fqdn`, `--freebind`, `--host-lo-to-ns-lo`, `--map-guest-addr`, `--map-host-loopback`, `--no-splice`, `--splice-only`, `--stats`, `--repair-path`, `--vhost-user`, `--print-capabilities`, `--migrate-*` | none: the unit uses none of them, and their defaults are off or, for the mappings, disabled by `--no-map-gw` (table above) |
| `--netns <path>` | implies `netns_only` in both versions (`conf_pasta_ns()`), so `isolate_user()` is called with `use_userns = 0`: pasta joins the jail's namespace and creates **no user namespace** (`1e6f92b` `conf.c:1682`, `386b5f5` `conf.c:2128`) | none; the capabilities in `/proc/<pid>/status` stay comparable before and after |
| DNS resolver choice | `--dns-host` (`ff63ac9`) defaults to the first `nameserver` in the host's `resolv.conf`, as before. `a3d142a` (host gateway is a resolver) and `5024908` (a loopback resolver with `--no-map-gw`) change other cases | none expected: WSL's resolver `10.255.255.254` is neither in 127/8 nor the default gateway (INFERRED; V-3a's `getent` in the jail checks it) |
| DNS ports | `becf81a` (2024-07): UDP and TCP, ports 53 and 853 | UDP/853 widening above, §4.6 |
| TCP keep-alive | `238c69f`: a keep-alive gets an ACK and resets the activity timer (`386b5f5` `tcp.c:1885-1905`); `aa809d3`: pasta then sets `SO_KEEPALIVE` on its host-side socket | the fix. The host socket uses the host's sysctls (`7200 75 9`, 24a), so pasta's own host-side probes start only after 2 h idle |
| TCP timers | `ACT_TIMEOUT` 7200 s and `FIN_TIMEOUT` 60 s unchanged; retransmission timeouts now follow RFC 6298 (`RTO_INIT` 1 s) and read `/proc/sys/net/ipv4/tcp_syn_retries` etc. | none on idle connections |
| UDP | flow table; an idle UDP flow expires after 180 s (`udp_flow.c:20`) | none for DNS (one query per flow) |
| isolation | `5da0316` keeps `CAP_DAC_OVERRIDE` during start-up (`isolate_initial()`); `isolate_user()` still drops every capability outside its keep-list afterwards | INFERRED unchanged final set; V-0 / V-3a compare it |

### 4.3 AppArmor

**CONFIRMED from the two `.deb` files (`dpkg-deb -c`):**
- **noble `1e6f92b-1`** ships `/etc/apparmor.d/usr.bin.passt` (`profile passt /usr/bin/passt{,.avx2}`) and the
  abstractions. It ships **no `usr.bin.pasta`** (Launchpad bug 2077158, fixed only in later packages). `pasta` is a hard
  link, and AppArmor attaches by the exec path. So **`/usr/bin/pasta` runs unconfined by AppArmor today**, whatever the
  LSM state.
- **resolute `386b5f5-1`** adds `/etc/apparmor.d/usr.bin.pasta`: `profile pasta /usr/bin/pasta{,.avx2}
  flags=(attach_disconnected)`, ABI 4.0, `include <abstractions/pasta>`.
  - Its file rules allow `@{run}/user/@{uid}/**`, `/tmp/**`, `@{PROC}/[0-9]*/ns/net` and the `/proc/net/*` tables.
  - They **do not allow `/run/netns/srjail`**, which `--netns` opens (INFERRED from the profile text, not run).
  - The profile has **no `include if exists <local/usr.bin.pasta>`** (Launchpad bug 2165739, open), so a local
    override file would not be read.
  - The postinst loads the profile only when `aa-enabled` succeeds.

**Is AppArmor active on this WSL kernel? INFERRED no.** Microsoft's `config-wsl` for the 6.18 branch has:
- `CONFIG_SECURITY_APPARMOR=y`, but `CONFIG_DEFAULT_SECURITY_SELINUX=y`.
- `CONFIG_LSM="landlock,lockdown,yama,loadpin,safesetid,integrity,selinux,apparmor,tomoyo,bpf"`.

SELinux comes first among the exclusive LSMs, so AppArmor is not the active major LSM unless the kernel command line
changes it. The snapshot (§5, V-0) checks `/sys/kernel/security/lsm` and `aa-enabled`.

**Consequences:**
- **AppArmor inactive** (expected): the new profile file is installed but never loaded. pasta stays exactly as confined
  as today (not by AppArmor). Nothing is weakened.
- **AppArmor active:** the update **adds** confinement, so it cannot weaken anything. But pasta would most likely fail
  to open `/run/netns/srjail`. Then `sr-jail-net` fails, and with it every jail unit (`BindsTo`): the jail **fails
  closed** and Claude does not start. The fix is contingency A-9: put the profile in complain mode, read the denials,
  then either add `/run/netns/srjail r,` (and whatever else the denials show) to the conffile, or disable the profile,
  which returns to today's unconfined state. Do not remove the jail's own limits to make pasta start.

**A source-built binary at another path loses the profile.** `make install` defaults to `/usr/local/bin`, and root's
`secure_path` puts `/usr/local/bin` **before** `/usr/bin`. The next `jail-install` would then silently put
`/usr/local/bin/pasta` into the unit: no profile attaches to it, and it is outside dpkg's verification. Another reason
not to build from source. If a source build is ever approved, it must replace `/usr/bin/{passt,pasta}` (same paths)
under a dpkg divert, never `/usr/local`.

### 4.4 seccomp, capabilities, privileges

passt confines itself (`isolation.c`):
- It drops capabilities it does not need.
- It detaches into new namespaces and `pivot_root`s into an empty tmpfs.
- It installs a seccomp filter generated at build time from the source's `#syscalls` annotations.

With `--netns <path>` pasta joins the jail's namespace without creating a user namespace, in both versions (§4.2), so
the capability masks in `/proc/<pid>/status` are in the initial user namespace and comparable.

Between the two versions, `isolation.c` changed (+48/−38). The commit relevant to root use is `5da0316` "keep
CAP_DAC_OVERRIDE initially", which keeps it during start-up. Larger isolation changes happened **after** `386b5f5`:
2026-07 `--chroot-fallback`, 2026-09 "Don't create our userns as nobody", and 2026-10 AppArmor fixes for the new
user-namespace procedure. This is one more reason to prefer `386b5f5` over Debian testing's `cba3570`.

The new package adds **one binary, `/usr/bin/passt-repair`** (a TCP_REPAIR helper for VM migration). Its mode is
`0755`: no setuid, and the postinst runs no `setcap` (it only reloads AppArmor profiles). Nothing runs it in the jail
or in our units. So no new privileged entry point appears (CONFIRMED from `dpkg-deb -c` and the postinst).

The system-side limits come from systemd and the kernel, not from pasta, and the update does not touch them:
- the unit's `IPAddressAllow/Deny` (cgroup BPF);
- the jail's seccomp list and `IPAddressDeny`;
- the namespace's ip rule.

**V-0 and V-3 compare the running pasta's `/proc/<pid>/status`** (`Uid`, `CapEff`, `CapPrm`, `CapBnd`, `NoNewPrivs`,
`Seccomp`). Any capability present after the update that was not present before stops the rollout (§6).

### 4.5 What stays the same

These are the same before and after:
- the unit file;
- `jail.properties`;
- the netns path and the netns-id check;
- `IPAddressAllow/Deny`, both pasta's and the jail's;
- the jail's `resolv.conf`;
- the namespace's ip rules (A-3, if approved, changes them **before** the update, in its own step).

dpkg does not touch `/etc/systemd/system/sr-jail-*.service`. The only behaviour changes are inside pasta:
- keep-alive ACKs;
- `SO_KEEPALIVE` on its host-side sockets when the jail sends keepalives;
- the DNS mapping in §4.2.

### 4.6 DNS: allow only UDP/53 to the jail's DNS address (A-3; code implemented in DEV-088, not applied on WSL)

**Status (2026-10-23).** The human adopted A-3 as policy (`.ai/blockers.md` HUMAN-024). DEV-088 implements it in the
repository: the three rules, the probe's checks, `admin.sh jail-rules`, the `getent` step in `jail-check`, tests and
docs. **Nothing has been applied on the WSL machine. Applying it (D-2) needs the human's separate approval**, and so does
each later step below that is marked so.

**Goal.** After the update the jail must reach no more of the host resolver than today: UDP/53 only. The change must
not loosen anything, must be deployable **before** the update as a provable no-op on the old pasta, and stays after it.

**Options compared:**

| option | safety | cost | verdict |
|---|---|---|---|
| **(1) ip rules in the jail's namespace** (the mechanism the jail already uses for TCP) | refuses everything to 198.51.100.53 except UDP/53, inside the jail's namespace, before any packet reaches pasta; independent of the pasta version; `EACCES` at once | 3 lines in `admin.sh`, a probe check, test updates | **recommended** |
| (2) a pasta option | – | – | **does not exist**: in `386b5f5` `--dns-forward` "Maps only UDP and TCP traffic to port 53 or port 853" (`passt.1:262-268`), the ports are fixed in `is_dns_flow()`, and no option disables 853 (`conf.c` option table checked) |
| (3) nftables in the jail's namespace | the same effect | a second packet-filter mechanism, the `nft` binary and its own ruleset to keep and test | not proposed |
| (4) systemd `IPAddressDeny=` | cannot filter by port | – | not possible |
| (5) accept the residual in writing | keeps a small widening | none | allowed by A-3 as the alternative, not recommended |

**D-1 — the change (implemented, DEV-088).** In `admin.sh` `jail_install`, the old single rule
(`to $JAIL_DNS/32 ipproto tcp prohibit priority 100`) became three rules, still inside the namespace, still before
`ExecStart` (pasta) and before the netns id / `resolv.conf` that a jail unit needs:

```diff
-    echo "ExecStartPre=$ip_bin -n srjail rule add to $JAIL_DNS/32 ipproto tcp prohibit priority 100"
+    echo "ExecStartPre=$ip_bin -n srjail rule add to $JAIL_DNS/32 prohibit priority 100"
+    echo "ExecStartPre=$ip_bin -n srjail rule add to $JAIL_DNS/32 ipproto udp dport 853 prohibit priority 98"
+    echo "ExecStartPre=$ip_bin -n srjail rule add to $JAIL_DNS/32 ipproto udp dport 53 lookup main priority 99"
```

- Priority 100 refuses **every** protocol and port to 198.51.100.53 (before: TCP only). TCP/53 and TCP/853 stay refused
  exactly as before. Priority 99 is the one allowance: UDP/53 to the main table (through pasta's tap). Priority 98 states
  the 853 refusal explicitly; it is redundant with 100 and keeps 853 shut if 99 is ever edited.
- **No window, idempotent.** Every start of `sr-jail-net` deletes the namespace, makes a new one and adds the rules to its
  empty rule table before pasta runs and before any jail unit can join (they are `After=`/`BindsTo=` the net unit, which
  is not active until every `ExecStartPre` has finished). The refusals are added first and the allowance last, so the
  set is never wider than the final one even inside that start. A failing `ip rule add` fails the unit (no `-` prefix),
  so no namespace runs without the rules. Re-running `jail-install` rewrites the same unit and restarts it: the same set.
  Nothing edits the rules of a running namespace; there is no `ip rule del` anywhere.
- **Kernel behaviour.** The kernel matches `ipproto` and `dport` in rules (`net/ipv4/fib_rules.c` `fib4_rule_match`,
  v6.18), a `prohibit` rule returns `-EACCES`, and `udp_sendmsg()` / `connect()` return that error from the route lookup.
  So a UDP `sendto` to a refused port fails at once with `EACCES`, like TCP's `connect` (CONFIRMED from the kernel source;
  D-3 runs it on the WSL kernel). iproute2 6.1 (noble) prints rules as `<prio>:\tfrom all to <addr> ipproto udp dport
  853 prohibit` (`ip/iprule.c` v6.1.0: ipproto, then sport, dport, then the action; `proto` only when not 0/kernel).
- **Replies.** pasta answers a UDP/53 query from 198.51.100.53 port 53. With any rule that has `ipproto` or a port in the
  namespace, `__fib_validate_source()` (`net/ipv4/fib_frontend.c` v6.18) dissects the incoming packet and **swaps the
  ports** before its reverse lookup, so the reply is looked up as "UDP to 198.51.100.53 dport 53" and matches rule 99
  (main): it is accepted under strict or loose rp_filter. Custom rules force that full check even with rp_filter 0
  (`fib4_has_custom_rules`); with rp_filter 0 a failed reverse lookup is accepted anyway (`last_resort`), with 1 or 2 it
  is dropped. **Expect rp_filter to be on in the jail's namespace:** with `net.core.devconf_inherit_init_net=0` (the
  default) a new namespace's IPv4 `conf/{all,default}` settings are copied from the initial namespace, and Ubuntu sets
  `rp_filter=2` there (`/usr/lib/sysctl.d/10-network-security.conf`). D-0 prints the value (read only). So the swap is
  what keeps UDP/53 replies working (CONFIRMED from the source; the D-3 `getent` proves it on WSL).
  **Caveat (availability only, not safety):** with rp_filter on, packets **from** 198.51.100.53 that carry no UDP/53
  ports fail the reverse check at rule 100 and are dropped: ICMP errors (e.g. a port-unreachable for a query) and IP
  fragments (only the first fragment has ports, and the check runs per fragment before reassembly). A lookup that would
  have failed fast on an ICMP error then waits for the resolver's timeout (5 s × 2 attempts). Fragmented DNS replies are
  not expected: pasta hands packets over its tap with a 65520-byte MTU, so it does not fragment a UDP reply.
- **IPv6.** There is nothing to change: `--dns-forward` is given only the IPv4 address, the jail's `resolv.conf` names
  only it, and pasta maps an IPv6 resolver only when the host's is loopback or the mapped gateway, which `--no-map-gw`
  leaves unset (`386b5f5` `conf.c` `add_dns_resolv6()`; WSL's resolver is IPv4 `10.255.255.254`). Whether the jail has
  IPv6 at all follows the host (`--config-net`); WSL NAT mode normally has none beyond link-local. `jail-rules` prints the
  IPv6 rules too, so a stray one would show.
- **The probe** (`probe.py`, every jail start and `jail-check`), failing closed:
  - the namespace's IPv4 rules, read over netlink (no `ip` text parsing), equal `EXPECTED_RULES` line for line: the
    kernel's `0: lookup 255`, `32766: lookup 254`, `32767: lookup 253` plus the three above. One more, one less, a
    different selector, action, table, flag (`not`) or any attribute it does not know → `DNS_RULES_NOT_EXACT`; an
    unreadable or malformed answer (including bytes left after the last attribute) → `DNS_RULES_UNCHECKED`.
    **The reader has been validated on this container's kernel (6.18.44, the real default rules, read only) and against
    built kernel-format dumps, not on the WSL kernel (6.18.33.2-microsoft-standard-WSL2).** If D-2 prints
    `DNS_RULES_UNCHECKED` or `DNS_RULES_NOT_EXACT`, the jail fails closed (no jail unit starts) and you go to D-4;
  - TCP to 53 and 853: `EACCES` within 1 s (`DNS_TCP_NOT_REFUSED` / `DNS_TCP_REFUSED_SLOWLY`);
  - UDP to 853 and 9: `EACCES` (`DNS_UDP_PORT_NOT_REFUSED`);
  - unchanged: the private ranges, the gateway, the WSL DNS tunnel on UDP and TCP, IPv6 private ranges.
- **`admin.sh jail-check`** runs the probe, then (only after `JAIL_OK`) `getent hosts github.com` in the jail with the
  same settings, and fails with `JAIL_DNS_FAILED` if it does not resolve. The per-start probe keeps DNS as a warning
  (`JAIL_WARN DNS_NOT_WORKING`) so that a host DNS outage cannot keep Claude from starting.
- **`admin.sh jail-rules`** (read only) prints the namespace's IPv4 and IPv6 rules, blanks squeezed, for the before/after
  comparison. `admin.sh status` prints the same.
- Tests: `tests/unit/design-agent/jail-dns-rules.test.ts` (the rendered unit's rule lines and order, the probe's expected
  set derived from the unit, the netlink reader against built dumps for the designed set and 17 deviations plus 9
  malformed answers, this machine's real rules read only, `jail_check` with stand-ins for `systemd-run`, `jail_rules` with
  a stand-in `ip`) and `jail.test.ts` (the probe outside a jail fails with the new codes). No test makes a namespace or a
  rule.

**Expected rules, before and after** (`admin.sh jail-rules`; before D-2 the root clone's older `admin.sh` has no
`jail-rules`, so D-0 takes the same form by hand):

```text
# before (today)                                    # after D-2
inet:                                               inet:
0: from all lookup local                            0: from all lookup local
100: from all to 198.51.100.53 ipproto tcp prohibit 98: from all to 198.51.100.53 ipproto udp dport 853 prohibit
32766: from all lookup main                         99: from all to 198.51.100.53 ipproto udp dport 53 lookup main
32767: from all lookup default                      100: from all to 198.51.100.53 prohibit
inet6:                                              32766: from all lookup main
0: from all lookup local                            32767: from all lookup default
32766: from all lookup main                         inet6:
                                                    0: from all lookup local
                                                    32766: from all lookup main
```

So `diff` of the two files prints exactly:

```text
3c3,5
< 100: from all to 198.51.100.53 ipproto tcp prohibit
---
> 98: from all to 198.51.100.53 ipproto udp dport 853 prohibit
> 99: from all to 198.51.100.53 ipproto udp dport 53 lookup main
> 100: from all to 198.51.100.53 prohibit
```

(the `inet6:` part may be empty if the WSL kernel has no IPv6 rules; it is the same before and after).

#### Applying A-3 on WSL (each step needs the human's approval; none has been run)

**Superseded in part (human, 2026-10-23; DEV-091).** W-0 and D-0 below have been run, and D-0's backups in
`/root/sr-a3/` are kept. **D-2 and D-4 below are not run.** The clone is not moved to the A-3 merge commit. Instead, the
three DEV-088 files are backported onto the clone's commit `c066618`: see "A-3 by backport onto `c066618`" after D-4,
which replaces D-2 with D-0b/D-2b and D-4 with its own D-4. D-3 stays as it is. The (A)/(B) comparison below
is kept as the record of the earlier plan.

Run by a person in the WSL shell, outside the jail, as the human's own user with `sudo`. Nothing here touches a timer,
the worker's units, Codex, authentication, the capture helper's checkout or units, or `.wslconfig`.

**What moves, and why it is approved as a list.** D-2 checks out the whole root-only clone `/root/sr-capture-admin` at
the A-3 merge commit `$SHA`. That clone is not only the jail's source: it also supplies `admin.sh` itself (`run`,
`login`, `claude-start`, …), `host-check.sh` and **the code the design cycle runs** (`sr-design-cycle.service` runs
`/root/sr-capture-admin/scripts/sales-design-worker/cycle.sh`, which runs the worker through `admin.sh run`). So
**every develop change between the clone's current commit (`previous-sha`) and `$SHA` ships with A-3**, not only the
DNS rules. And `jail-install` rewrites more than `sr-jail-net.service`: also `sr-jail-claude.service` and
`/usr/local/lib/sr-jail/{jail.properties,probe.py}`. D-0 therefore prints the exact commit list and file list between
the two commits, and backs up every file `jail-install` writes; **the human's D-2 approval is an approval of that
printed list**. D-3 diffs every one of those files.

**Two ways to deploy, compared.**

| | (A) move the root clone to `$SHA`, then `jail-install` (recommended) | (B) a second root-only clone at `$SHA`, `jail-install` from it, the main clone stays |
|---|---|---|
| what changes on the machine | the jail files and units from `$SHA`, **and** every later run of `admin.sh` / `cycle.sh` uses `$SHA` | only the jail files and units from `$SHA`; `cycle.sh` and `admin.sh` stay at `previous-sha` |
| repository mechanism | the existing one (`design-bridge.md` §4, `SECURITY.md`: install only from `/root/sr-capture-admin` at a reviewed commit, clean) | none: `admin.sh` would accept it (`trusted_path` only checks root ownership), but nothing in the repository documents or tests a second admin clone |
| durability | the deployed jail and its source are the same commit | **drift**: the next `jail-install` or `approve` from the main clone (e.g. the design-bridge runbook) silently writes the old single TCP rule and the old probe back, and that old probe accepts it, so A-3 is undone without any failure |
| review burden | the human approves the D-0 list (it may contain unrelated reviewed develop changes) | only the jail files' diff |

**Recommendation: (A).** (B) avoids shipping unrelated changes but leaves the machine in a state that any routine jail
re-install reverts without notice, and it invents a second admin clone the repository does not have. If the D-0 list
contains a change the human does not want on the machine yet, do not approve D-2: stop and ask for a narrower plan
(for example, waiting until that change is wanted, or a reviewed change that lets `jail-install` run from a pinned
second clone). Do not improvise (B) at the console.

| step | what it does | what it stops | approval |
|---|---|---|---|
| W-0 + D-0 | window check, then fetch (does not move the checkout), print what would move, record the current state and back up every file D-2 writes (read only, plus new files in `/root/sr-a3/`) | nothing | **approval 1**: run W-0/D-0 (read only). Its output is what approval 2 approves |
| D-2 | moves the root clone to `$SHA` and runs `jail-install` (ends with `jail-check`) | every jail unit for a few seconds (`sr-jail-net` restarts; Claude comes back by itself if enabled; a running `admin.sh run` worker job would be cut, which is why W-0 checks first). From then on `cycle.sh` and `admin.sh` run at `$SHA` | **approval 2 (required)**: A-3 apply, approving the exact D-0 commit and file list, together with D-4 as its abort path |
| D-3 | verify: diffs, `JAIL_OK`, `JAIL_DNS_OK`, `getent`, refusals (read only, plus 1-byte UDP sends and TCP connects that must be refused) | nothing | included in approval 2 |
| D-4 | rollback: clone back to `previous-sha`, `jail-install` | the same few seconds | included in approval 2 (abort path) |

**W-0 + D-0 — the window and the current state (approval 1; read only).** First W-0 (§5.0); go on only under its
conditions (no `sr-jail-run-*` / `sr-jail-shell-*` unit, no worker / PoC / Codex process, the cycle lock free, no `sr-*`
timer due within 30 minutes). Ask the jailed Claude to commit, push and stop at a clean point. Then, with `$SHA` set to
the A-3 merge commit:

```bash
SHA=PASTE_THE_40_HEX_A3_MERGE_SHA
if [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  sudo install -d -m 0700 /root/sr-a3 /root/sr-a3/before
  sudo git -C /root/sr-capture-admin fetch -q origin
  PREV="$(sudo git -C /root/sr-capture-admin rev-parse HEAD)"
  echo "$PREV" | sudo tee /root/sr-a3/previous-sha
  echo "$SHA" | sudo tee /root/sr-a3/target-sha
  sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal | sed 's/^/DIRTY /'
  sudo git -C /root/sr-capture-admin merge-base --is-ancestor "$PREV" "$SHA" && echo "D0: target is ahead of the clone" || echo "D0_STOP: $SHA does not contain the clone's commit"
  echo "== commits that move with A-3 =="; sudo git -C /root/sr-capture-admin --no-pager log --oneline "$PREV..$SHA"
  echo "== files that move with A-3 ==";   sudo git -C /root/sr-capture-admin --no-pager diff --stat "$PREV" "$SHA"
  echo "== of which the admin, jail and cycle code =="
  sudo git -C /root/sr-capture-admin --no-pager diff --stat "$PREV" "$SHA" -- scripts/sales-design-capture scripts/sales-design-worker
  sudo cp -p /etc/systemd/system/sr-jail-net.service /etc/systemd/system/sr-jail-claude.service /root/sr-a3/before/
  sudo cp -p /usr/local/lib/sr-jail/jail.properties /usr/local/lib/sr-jail/probe.py /root/sr-a3/before/
  sudo sh -c '{ echo "inet:"; ip -n srjail -4 rule show | sed -E "s/[[:space:]]+/ /g; s/ \$//"; echo "inet6:"; ip -n srjail -6 rule show 2>/dev/null | sed -E "s/[[:space:]]+/ /g; s/ \$//"; } > /root/sr-a3/rules.before'
  sudo cat /root/sr-a3/rules.before
  echo "rp_filter all/default in the jail namespace: $(sudo ip netns exec srjail cat /proc/sys/net/ipv4/conf/all/rp_filter /proc/sys/net/ipv4/conf/default/rp_filter | tr '\n' ' ')"
  systemctl is-enabled sr-jail-claude; systemctl is-active sr-jail-net sr-jail-claude
else
  echo "set SHA to the full A-3 merge commit first"
fi
```

Go on to D-2 only when: no `DIRTY` line; `D0: target is ahead of the clone`; `rules.before` matches the "before" column
above (otherwise the machine is not in the state this plan assumes: stop and report); and the human has read the
commit and file lists and approves exactly them. The `rp_filter` line is information (expected `2 2` on Ubuntu; see
"Replies" above). Note whether `sr-jail-claude` is enabled and active: D-3 compares against it.

**D-2 — deploy (approval 2).** **This moves the whole root clone, so from now on the design cycle (`cycle.sh`) and
every `admin.sh` command run the code at `$SHA`, i.e. everything in the D-0 lists, not only A-3.** One `&&` chain,
so nothing installs unless the clone is at `$SHA` and clean (`jail-install` does not check that itself). It ends with
`jail-check` (`JAIL_OK`, then `JAIL_DNS_OK`):

```bash
SHA="$(sudo cat /root/sr-a3/target-sha)"
if [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  sudo git -C /root/sr-capture-admin checkout -q --detach "$SHA" \
    && test -z "$(sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" \
    && sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh jail-install
else
  echo "no recorded target commit: run D-0 first"
fi
```

What it stops: `sr-jail-net` restarts, so `sr-jail-claude` and any other jail unit stop and the namespace is made again
(a few seconds). `ExecStartPost` starts Claude again if it is enabled. It does not touch `sr-capture.*`, the helper's
checkout, `sr-design-*` units or any timer.

What its last lines mean:
- `JAIL_UNSAFE …` (for example `DNS_RULES_UNCHECKED` or `DNS_RULES_NOT_EXACT`): the same probe runs before every jail
  unit, so the jail units do not start (fail closed). Go to D-4.
- `JAIL_OK` then `JAIL_DNS_FAILED`: **the jail units keep running with DNS broken.** `sr-jail-net` has already
  restarted, `ExecStartPost` has already started Claude again, and Claude's own start-up probe only warns on DNS
  (`JAIL_WARN DNS_NOT_WORKING`). Go to D-4.
- `JAIL_OK` then `JAIL_DNS_OK`: go on to D-3.

**D-3 — verify (included in approval 2; read only, plus sends that must be refused).**

```bash
A=/root/sr-capture-admin/scripts/sales-design-capture/admin.sh
sudo bash "$A" jail-rules | sudo tee /root/sr-a3/rules.after
echo "== rules =="; sudo diff /root/sr-a3/rules.before /root/sr-a3/rules.after
echo "== sr-jail-net.service =="; sudo diff /root/sr-a3/before/sr-jail-net.service /etc/systemd/system/sr-jail-net.service
echo "== sr-jail-claude.service =="; sudo diff /root/sr-a3/before/sr-jail-claude.service /etc/systemd/system/sr-jail-claude.service && echo SAME
echo "== jail.properties, settings only =="; sudo diff <(sudo grep -Ev '^[[:space:]]*(#|$)' /root/sr-a3/before/jail.properties) <(sudo grep -Ev '^[[:space:]]*(#|$)' /usr/local/lib/sr-jail/jail.properties) && echo SAME
echo "== probe.py =="; sudo cmp -s /root/sr-a3/before/probe.py /usr/local/lib/sr-jail/probe.py && echo SAME || echo CHANGED
sudo bash "$A" jail-check
sudo bash "$A" run sr-designgen -- getent hosts github.com
sudo bash "$A" run sr-designgen -- /usr/bin/python3 -I -c 'import socket, errno
for proto, port in (("udp", 853), ("udp", 9), ("tcp", 853), ("tcp", 53)):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM if proto == "udp" else socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        if proto == "udp":
            s.sendto(b"x", ("198.51.100.53", port))
        else:
            s.connect(("198.51.100.53", port))
        print("DNS_ADDR", proto, port, "NOT_REFUSED")
    except OSError as e:
        print("DNS_ADDR", proto, port, errno.errorcode.get(e.errno, e.errno))
    finally:
        s.close()'
systemctl is-active sr-jail-net sr-jail-claude
```

Expected, when D-0's file list under `scripts/sales-design-capture` showed only DEV-088's files (`admin.sh`,
`jail/probe.py`, `jail/jail.properties`):
- **rules:** exactly the 5 lines above (`3c3,5` …);
- **`sr-jail-net.service`:** only the one old `ExecStartPre=… ipproto tcp prohibit priority 100` line replaced by the
  three new `ExecStartPre` lines, plus its comment lines if any (`ExecStart`, `IPAddressAllow/Deny` and everything
  else unchanged);
- **`sr-jail-claude.service`:** `SAME` (its settings come from `jail.properties`, whose settings did not change; a
  different line means the default gateway changed or D-0's list contained another jail change: stop and report);
- **`jail.properties`, settings only:** `SAME` (DEV-088 changes comment lines only);
- **`probe.py`:** `CHANGED` (DEV-088's new checks), the only installed jail file whose content is meant to change;
- `JAIL_OK` and `JAIL_DNS_OK`; `getent` prints github.com's addresses;
- four lines `DNS_ADDR … EACCES`;
- `sr-jail-net` `active`; `sr-jail-claude` as in D-0 (`active` if it was enabled).

If D-0's list contained other changes under `scripts/sales-design-capture`, the human compares these diffs with that
list instead; anything the list does not explain is a failure. On any unexpected line: D-4, and report the lines.

On the old pasta this is the no-op proof: DNS still resolves, TCP is refused as before, and the only traffic now refused
is UDP to non-53 ports (and other protocols such as ICMP) to a documentation address that nothing answers. The same D-3
runs again in V-3a after the update. Before A-3 (today) the UDP lines print `NOT_REFUSED`, which is harmless with the
old pasta (the byte goes to the documentation address); after an update without A-3, `udp 853` would reach the host
resolver.

**D-4 — rollback (included in approval 2 as its abort path).** The clone back to the commit recorded in D-0, then
`jail-install`, which restarts the jail the same way and ends with that version's `jail-check`. Then every file
`jail-install` writes must equal its D-0 backup:

```bash
PREV="$(sudo cat /root/sr-a3/previous-sha)"
if [[ "$PREV" =~ ^[0-9a-f]{40}$ ]]; then
  sudo git -C /root/sr-capture-admin checkout -q --detach "$PREV" \
    && test -z "$(sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" \
    && sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh jail-install
  sudo ip -n srjail rule show
  for f in sr-jail-net.service sr-jail-claude.service; do sudo cmp /root/sr-a3/before/$f /etc/systemd/system/$f && echo "SAME $f"; done
  for f in jail.properties probe.py; do sudo cmp /root/sr-a3/before/$f /usr/local/lib/sr-jail/$f && echo "SAME $f"; done
  systemctl is-active sr-jail-net sr-jail-claude
else
  echo "no recorded previous commit: stop and report"
fi
```

Expected: the old single `100: from all to 198.51.100.53 ipproto tcp prohibit` rule, `JAIL_OK`, and four `SAME` lines;
`cycle.sh` and `admin.sh` are back at `previous-sha`. Do not delete rules by hand with `ip rule del`: the unit re-creates
its rules on every start, so hand edits are not durable and are not tested.

**Residual after A-3:** UDP/53 to the host resolver, exactly as today (DNS can still carry data out, as today; the jail
can reach public addresses anyway).

#### A-3 by backport onto `c066618` (DEV-091; replaces D-2 and D-4 above; none of it has been run)

**Decision (human, 2026-10-23).** D-0 above has been run. Its backups in `/root/sr-a3/` are kept, and the files it
recorded are `previous-sha` = `c066618` and `target-sha` = `e525371`. **D-2 above is not run.** It would move the root
clone across 230 files, and 24 of them are jail or worker files. The clone stays based on `c066618`, the commit it is at
(the PR #76 merge). Only the three files DEV-088 changed are added on top of it. The clone is not moved to `e525371`.
No other worker, Codex, cycle or capture-helper code, and no setting, changes. The goal is to get image generation
working again, so this repairs the machine safely and does not redesign anything. WSL code changes, `jail-install`,
the pasta update, stopping timers and Codex runs all need approval first. The approval points are marked below.

**The backport commit `X`.**
- `X` = `fbfce3c87abb185a4cc59d28f2a842a838ddeac0` on branch `hotfix/a3-dns-on-c066618`.
- It is exactly one commit, and its only parent is `c066618cd6a40fe1cef57f75a71b755eea4157e8`.
- It changes exactly these three paths. For each one, `git diff c066618 e525371 -- <file>` is byte-identical to the
  DEV-088 diff `e525371^1..e525371`, because no other commit after `c066618` touched `scripts/sales-design-capture`.
  The blobs at `X` therefore equal those at `e525371`:

| file (`scripts/sales-design-capture/…`) | blob at `X` = at `e525371` | sha256 at `X` | blob at `c066618` |
|---|---|---|---|
| `admin.sh` (mode 100755) | `f02a416e78a223dd65935cb0bcd8e61370474812` | `097494c4654dec2a68470db793d3a72f03875021f99fba1627107e03f5435551` | `414ed1fb17554ad3b4638ad674fcac9b872cf2ed` |
| `jail/jail.properties` | `1b932502dffe9446be1f9bbb1caaf09d4f9ae7b4` | `9b432f8ad26c913dec12f2e14b066503aa1dc61ede017d0c86777cc80f24d0a9` | `ed780fbb0862255b4b45a0f82307ebd9cf43e209` |
| `jail/probe.py` | `7de02da28637134a7c5999f7d8350af131dd3755` | `411b53e433512628ba18fad1b3b011e35669044ed60d753b32b28a9d4e971b54` | `fe4a08bea7ddf8f7c1294c0550529d50fe17e904` |

The target is pinned by the commit id, the three blob ids and the sha256 of each file, and D-0b checks all three.
`.gitattributes` (`eol=lf`) makes the checked-out bytes equal the blob. The commit is not GPG-signed. Keep the branch:
it is not reachable from `develop`, and the WSL clone fetches it from there. Draft PR #106 (`base/wsl-c066618` ←
the hotfix branch, **never merged**) exists only so that CI runs on `X` with `c066618`'s own workflow and tests.

**Compatibility with the old code (checked here; nothing run on WSL).**
- Tests at `X`, against `c066618`'s own tests, cover every test that reads `admin.sh`, `probe.py` or
  `jail.properties`: `jail.test.ts`, `design-worker-cycle.test.ts`, `host-check.test.ts` and `cross-user.test.ts`.
  All pass except **one expected failure**: `jail.test.ts` › "DNS is UDP-only …", which asserts the old single
  `ipproto tcp prohibit priority 100` line that this change replaces. At `c066618` that file passes 8/8; at `X` it
  passes 7/8. `cross-user.test.ts` skips without root, as at `c066618` (CI runs it with `sudo`).
- DEV-088's tests, copied from `develop` without being committed, pass against `X`: `jail-dns-rules.test.ts` 6/6 and
  the updated `jail.test.ts` 8/8. All of `tests/unit/design-agent/` with `design-worker-cycle.test.ts` gives 42 files,
  649 passed and 16 skipped.
- **The units.** Each commit's `jail_install` was run with stand-ins and both units diffed:
  - `sr-jail-claude.service` is **byte-identical** between `c066618` and `X`. Its settings come from
    `jail.properties` without comment lines, and DEV-088 changed comments only there.
  - `sr-jail-net.service` differs by exactly one hunk, and nothing else in the unit changes:
    `12c12,14`: `ExecStartPre=<ip> -n srjail rule add to 198.51.100.53/32 ipproto tcp prohibit priority 100` →
    the three lines `… prohibit priority 100`, `… ipproto udp dport 853 prohibit priority 98` and
    `… ipproto udp dport 53 lookup main priority 99`.
  - Both units at `X` are byte-identical to those at `e525371`.
- **What `jail-install` touches.** It is the same at `c066618` and at `X`, apart from the three rule lines:
  - It writes `/etc/systemd/system/sr-jail-net.service`, `/etc/systemd/system/sr-jail-claude.service`,
    `/usr/local/lib/sr-jail/jail.properties` and `/usr/local/lib/sr-jail/probe.py`.
  - It runs `usermod -s /usr/sbin/nologin sr-designgen` (already set), `daemon-reload`,
    `systemctl enable sr-jail-net` (already enabled) and `restart sr-jail-net`.
  - It then runs `jail-check`. At `X`, `jail-check` also runs `getent hosts github.com` in a throw-away
    `sr-jail-dns-*` unit.
  - It does not touch a timer, `sr-capture.*`, `/home/sr-igcapture`, `approved-sha`, `cycle.sh`, the worker,
    `sr-design-*` units or Codex. Only `approve` / `install` write the helper's units and checkout, and they are not
    run here.
- **Static dependencies.**
  - The new lines use only `ip`, `sed`, `getent`, `systemd-run` and the existing `JAIL_ARGS`.
  - The new probe uses only Python's standard library (`struct`) and an `AF_NETLINK` socket, which the jail's
    `RestrictAddressFamilies` already allows (unchanged).
  - Of the other files `admin.sh` reads (`host-check.sh` and `systemd/sr-capture.*`), none differs between
    `c066618` and `develop`.
  - `cycle.sh` at `c066618` (unchanged by `X`) only runs `admin.sh run` and checks that the clone is clean. It does
    not pin the clone's commit, and its `STOP_CODES` already contain `JAIL_UNSAFE`, which every new probe failure
    prints, so it fails closed.
- **Drift warning.** While the clone is at `X`:
  - Do not run `approve` or `install`. `approve <sha>` needs the clone at `<sha>` and then re-runs `jail_install`, so
    approving any commit without DEV-088 (for example `c066618`) silently restores the old rule and the old probe.
  - Any later commit that contains DEV-088 (on `develop`, at or after `e525371`) has the same three blobs, so a later
    reviewed move of the clone keeps A-3.

**`sr-claude-auth-watch.timer`.** No file in this repository defines it. The human's read-only check found that its
script mentions the design user, `admin.sh` and shell delegation. W-0 treats it as BLOCKING by name (§5.0, DEV-090):
it holds W-0 when it is due within 30 minutes or its service is running. **AW-1** (read only) shows what it runs as
fixed tokens only. It prints no script line, no argument, no environment and no credential. Unknown words are mapped
to `OTHER`. Paste the output back:

```bash
# AW-1: what sr-claude-auth-watch runs, as fixed tokens only (read only; prints no script line, no value, no secret)
AW_T=sr-claude-auth-watch.timer
echo "AW timer_enabled=$(systemctl is-enabled "$AW_T" 2>/dev/null | head -n1 | grep -xE '[a-z-]+' || echo none) timer_active=$(systemctl is-active "$AW_T" 2>/dev/null | head -n1 | grep -xE '[a-z-]+' || echo unknown)"
systemctl show "$AW_T" -p TimersCalendar -p TimersMonotonic -p NextElapseUSecRealtime -p LastTriggerUSec --no-pager | sed -E 's/^/AW timer /'
AW_S="$(systemctl show "$AW_T" -p Unit --value)"
case "$AW_S" in sr-*.service) ;; *) AW_S=UNKNOWN ;; esac
echo "AW service=$AW_S service_active=$(systemctl is-active "$AW_S" 2>/dev/null | head -n1 | grep -xE '[a-z-]+' || echo unknown) user=$(systemctl show "$AW_S" -p User --value 2>/dev/null | grep -xE '[a-z_][a-z0-9_-]{0,31}' || echo root_or_unset)"
AW_FILES="$(systemctl show "$AW_S" -p ExecStartPre -p ExecStart -p ExecStartPost -p ExecStop -p ExecStopPost --value 2>/dev/null \
  | grep -oE 'argv\[\]=[^;]*' | sed 's/^argv\[\]=//' | tr ' ' '\n' | grep -E '^/' | while IFS= read -r f; do sudo test -f "$f" && [ "$(sudo head -c 4 "$f" | od -An -c | tr -d ' \n')" != '177ELF' ] && echo "$f"; done | sort -u)"
echo "AW script_files=$(printf '%s\n' "$AW_FILES" | grep -c .)"
printf '%s\n' "$AW_FILES" | grep . | while IFS= read -r f; do
  AW_BODY="$(sudo cat "$f" | grep -vE '^[[:space:]]*#')"
  AW_VARS="$(printf '%s\n' "$AW_BODY" | grep -oE '^[[:space:]]*(export[[:space:]]+|readonly[[:space:]]+|local[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*admin\.sh' | sed -E 's/^[[:space:]]*(export|readonly|local)?[[:space:]]*//; s/=.*//' | sort -u | paste -sd'|' -)"
  AW_CALL='admin\.sh["'"'"']?'; [ -n "$AW_VARS" ] && AW_CALL="(admin\.sh|\\\$\{?($AW_VARS)\}?)[\"']?"
  printf '%s\n' "$AW_BODY" | grep -oE "${AW_CALL}[[:space:]]+[\"']?[A-Za-z0-9_-]+[\"']?([[:space:]]+[\"']?[A-Za-z0-9_.-]+)?" \
    | sed -E "s/[\"']//g; s/^[^[:space:]]+[[:space:]]+//" | while read -r sub u _; do
      case "$sub" in run|jail-check|jail-install|install|approve|login|shell|status|claude-start|claude-stop|jail-rules) ;; *) sub=OTHER ;; esac
      case "$u" in sr-designgen) u=sr-designgen ;; "") u=none ;; *) u=OTHER ;; esac
      echo "AW admin_call sub=$sub target=$u"
    done | sort | uniq -c | awk '{c=$1; $1=""; sub(/^ /, ""); print $0 " count=" c}'
  AW_M=$(printf '%s\n' "$AW_BODY" | grep -cE "admin\.sh${AW_VARS:+|\\\$\{?($AW_VARS)\}?}")
  AW_C=$(printf '%s\n' "$AW_BODY" | grep -cE "${AW_CALL}[[:space:]]+[\"']?[A-Za-z0-9_-]+")
  AW_A=$(printf '%s\n' "$AW_BODY" | grep -cE '^[[:space:]]*(export[[:space:]]+|readonly[[:space:]]+|local[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*admin\.sh')
  echo "AW admin_unparsed_lines=$(( AW_M - AW_C - AW_A > 0 ? AW_M - AW_C - AW_A : 0 ))"
  printf '%s\n' "$AW_BODY" | grep -E '(^|[^A-Za-z0-9_-])systemctl([^A-Za-z0-9_-]|$)' | while IFS= read -r l; do
      v="$(printf '%s\n' "$l" | grep -oE 'systemctl([[:space:]]+(-[-A-Za-z]+(=[^[:space:]]*)?|--[a-z-]+))*[[:space:]]+[a-z-]+' | head -n1 | awk '{print $NF}')"
      case "$v" in start|stop|restart|enable|disable|mask) ;; is-active|is-enabled|is-failed|status|show|cat|list-timers|list-units|list-unit-files) v=READ ;; *) v=OTHER ;; esac
      units="$(printf '%s\n' "$l" | grep -oE 'sr-[A-Za-z0-9@_.-]*\.(service|timer|path|socket|target)' | sort -u | paste -sd, -)"
      [ -z "$units" ] && { printf '%s\n' "$l" | grep -q '\$' && units=UNRESOLVED || units=none_sr; }
      echo "AW systemctl verb=$v units=$units"
    done | sort | uniq -c | awk '{c=$1; $1=""; sub(/^ /, ""); print $0 " count=" c}'
  for pat in '/etc/systemd' '/usr/local/lib/sr-jail' '/run/netns'; do
    printf '%s\n' "$AW_BODY" | grep -qF "$pat" && echo "AW mentions $pat=yes" || echo "AW mentions $pat=no"
  done
  for k in 'ip_rule:(^|[^A-Za-z0-9_-])ip([[:space:]]+-[A-Za-z0-9]+([[:space:]]+[A-Za-z0-9_-]+)?)*[[:space:]]+(rule|ru)([^A-Za-z]|$)' \
           'ip_netns:(^|[^A-Za-z0-9_-])ip([[:space:]]+-[A-Za-z0-9]+([[:space:]]+[A-Za-z0-9_-]+)?)*[[:space:]]+netns([^A-Za-z]|$)|(^|[^A-Za-z0-9_-])ip[[:space:]]+-n[[:space:]]' \
           'pasta:(^|[^A-Za-z0-9_-])(pasta|passt)([^A-Za-z0-9_-]|$)' \
           'nsenter:(^|[^A-Za-z0-9_-])nsenter([^A-Za-z0-9_-]|$)' \
           'systemd_run:(^|[^A-Za-z0-9_-])systemd-run([^A-Za-z0-9_-]|$)' \
           'sudo_su_runuser:(^|[^A-Za-z0-9_-])(sudo|su|runuser|machinectl)([^A-Za-z0-9_-]|$)' \
           'sh_c:(^|[^A-Za-z0-9_-])(ba)?sh[[:space:]]+-[a-z]*c' \
           'eval_or_source:(^|[^A-Za-z0-9_-])(eval|source|\.)[[:space:]]+[^=]' \
           'codex:(^|[^A-Za-z0-9_-])codex([^A-Za-z0-9_-]|$)' \
           'cycle_or_worker:cycle\.sh|sales-design-worker|sr-design-' \
           'capture_helper:sr-capture\.(service|timer|path)|sr-igcapture|sales-design-capture/run\.sh'; do
    printf '%s\n' "$AW_BODY" | grep -qE "${k#*:}" && echo "AW uses ${k%%:*}=yes" || echo "AW uses ${k%%:*}=no"
  done
  printf '%s\n' "$AW_BODY" | grep -v 'admin\.sh' | grep -qE "(^|[^A-Za-z0-9_-])(bash|sh|exec|python3?|node)[[:space:]]+[\"']?/" && echo "AW uses other_script=yes" || echo "AW uses other_script=no"
done
echo "AW_DONE"
unset AW_T AW_S AW_FILES AW_BODY AW_VARS AW_CALL AW_M AW_C AW_A
```

AW-1's output:
- `AW timer …`: the schedule and the next run.
- `AW service=… user=…`: the service and its user.
- `AW admin_call sub=<run|jail-check|jail-install|install|approve|login|shell|status|claude-start|claude-stop|jail-rules|OTHER> target=<sr-designgen|none|OTHER> count=N`:
  one line per kind of call.
- `AW admin_unparsed_lines=N`: mentions of `admin.sh` that are not a call AW-1 can read.
- `AW systemctl verb=<start|stop|restart|enable|disable|mask|READ|OTHER> units=<sr-* names|UNRESOLVED|none_sr>`.
  `READ` stands for `is-active`, `status`, `show`, `list-*` and similar.
- `AW mentions /etc/systemd|/usr/local/lib/sr-jail|/run/netns=yes|no`.
- `AW uses ip_rule|ip_netns|pasta|nsenter|systemd_run|sudo_su_runuser|sh_c|eval_or_source|codex|cycle_or_worker|capture_helper|other_script=yes|no`.

Tested here against synthetic scripts (stand-ins for `systemctl` and `sudo`). A script holding a token, a
`--token=` argument and a commented-out `claude-stop` printed none of them, and no line of any script appeared in the
output.

**Decision rule for AW-1:**
1. **Related but not conflicting:** go on, with W-0 holding it by name. This applies when **all** of these hold:
   - every `admin_call` is `sub=run target=sr-designgen`, `sub=status` or `sub=jail-check`;
   - `admin_unparsed_lines=0`;
   - every `systemctl` verb is `READ`;
   - every `mentions` and `uses ip_rule|ip_netns|pasta|nsenter|eval_or_source|other_script` is `no`.

   Its `admin.sh run` job is a transient `sr-jail-run-*` unit that does not change the jail. Its DNS goes over UDP/53,
   which stays allowed, and HTTPS is unchanged. W-0 holds it only when it is due within 30 minutes or running.
   `sudo_su_runuser=yes` and `sh_c=yes` alone are expected (`sudo bash admin.sh …`) and are accepted only together
   with the conditions above. A `run` or `jail-check` that happens to run during D-2b is cut by the restart of
   `sr-jail-net`, which is why W-0 holds a running or due service.
2. **Conflicting:** this applies to any `sub=claude-start`, `claude-stop`, `login`, `jail-install`, `install` or
   `approve`; any `systemctl` verb `start`, `stop`, `restart`, `enable`, `disable` or `mask` on an `sr-jail-*` unit
   (or `UNRESOLVED`); `mentions … =yes`; or `uses ip_rule`, `ip_netns` or `pasta` `=yes`.
   - The D-2b → D-3 (→ D-4) window must end before the timer's next run, and start at least 30 minutes before it.
   - Before D-2b, `NextElapseUSecRealtime` must be more than 45 minutes away (the window plus a margin), and the
     service must be `inactive`. Otherwise wait for the next gap.
   - If it runs during the window anyway, stop at once. Run D-3, and on any unexpected line go to D-4.
   - Neither the timer nor the service is stopped or disabled. That would be a separate approval.
3. **Anything else** (`OTHER`, `UNKNOWN`, `script_files=0`, `admin_unparsed_lines>0`, `eval_or_source=yes`,
   `other_script=yes`, a target that is not `sr-designgen`): **hold and ask.** Paste the AW-1 output and do not run
   D-2b.

**The steps (backport variant).** Run them as a person in the WSL shell, outside the jail, with `sudo`.

| step | what it does | what it stops | approval |
|---|---|---|---|
| W-0 | the canonical window check in §5.0 (DEV-090, PR #105); go on only when the last line is `W0_OK` | nothing | read only |
| AW-1 | what `sr-claude-auth-watch` runs, as tokens | nothing | read only |
| D-0b | fetches only the hotfix branch and verifies `X`, its parent, the three paths, the blobs and the sha256. Checks that the machine is still in `c066618`'s installed state and matches the D-0 backups, records `target-sha` = `X` (the old target is kept in `target-sha.e525371`) and snapshots the helper, design and auth-watch units | nothing (new files only in `/root/sr-a3/`) | **approval 2a**: run D-0b. The human approves its printed 3-file diff stat |
| D-2b | W-0 again (`W0_OK`), then checks out `X` (clean, exactly the 3 paths against `c066618`) and runs `jail-install` | `sr-jail-net` restarts, so every jail unit stops for a few seconds. `sr-jail-claude` starts again by itself if enabled. A running `sr-jail-run-*` job would be cut, which is why W-0 checks first. `cycle.sh` and all worker, helper and Codex code stay at `c066618`'s content | **approval 2b (required)**, together with D-3 and D-4 |
| D-3 | verify | nothing | included in 2b |
| D-4 | the clone back to `c066618`, `jail-install`, `cmp` against the D-0 backups | the same few seconds | included in 2b (abort path) |

**W-0** is the canonical block in §5.0 as merged with DEV-090 (PR #105). It prints `W0_OK` or `W0_HOLD` as its last
line. Run it before D-0b, and again right before D-2b. Until PR #105 is merged, `develop` has no `W0_OK` block, so do
not run D-2b.

**D-0b (approval 2a; read only, plus new files in `/root/sr-a3/`).** It reuses the D-0 backups and does not redo
them:

```bash
# D-0b (DEV-091): read only, plus files in /root/sr-a3/. Reuses the D-0 backups; does not redo them.
X=fbfce3c87abb185a4cc59d28f2a842a838ddeac0
BASE=c066618cd6a40fe1cef57f75a71b755eea4157e8
OLD_TARGET=e525371c4f768e24889954652d3f01241d8a6627
C=/root/sr-capture-admin
P=scripts/sales-design-capture
D0B=OK
d0b_stop() { echo "D0B_STOP: $*"; D0B=STOP; }
for f in previous-sha target-sha rules.before before/sr-jail-net.service before/sr-jail-claude.service before/jail.properties before/probe.py; do
  sudo test -s "/root/sr-a3/$f" || d0b_stop "missing D-0 file /root/sr-a3/$f"
done
[ "$(sudo cat /root/sr-a3/previous-sha 2>/dev/null)" = "$BASE" ] || d0b_stop "previous-sha is not $BASE"
case "$(sudo cat /root/sr-a3/target-sha 2>/dev/null)" in "$OLD_TARGET"|"$X") ;; *) d0b_stop "target-sha is neither $OLD_TARGET nor $X" ;; esac
sudo git -C "$C" fetch -q origin refs/heads/hotfix/a3-dns-on-c066618:refs/remotes/origin/hotfix/a3-dns-on-c066618 || d0b_stop "fetch of the hotfix branch failed"
[ "$(sudo git -C "$C" rev-parse HEAD)" = "$BASE" ] || d0b_stop "the clone is not at $BASE"
[ -z "$(sudo git -C "$C" status --porcelain --untracked-files=normal)" ] || d0b_stop "the clone is not clean"
[ "$(sudo git -C "$C" rev-parse -q --verify refs/remotes/origin/hotfix/a3-dns-on-c066618)" = "$X" ] || d0b_stop "the hotfix branch is not at $X"
[ "$(sudo git -C "$C" rev-parse "$X^@" 2>/dev/null)" = "$BASE" ] || d0b_stop "X's only parent is not $BASE"
[ "$(sudo git -C "$C" diff --name-only "$BASE" "$X")" = "$(printf '%s\n' "$P/admin.sh" "$P/jail/jail.properties" "$P/jail/probe.py")" ] || d0b_stop "X changes other files than the three"
for e in "admin.sh f02a416e78a223dd65935cb0bcd8e61370474812 097494c4654dec2a68470db793d3a72f03875021f99fba1627107e03f5435551" \
         "jail/jail.properties 1b932502dffe9446be1f9bbb1caaf09d4f9ae7b4 9b432f8ad26c913dec12f2e14b066503aa1dc61ede017d0c86777cc80f24d0a9" \
         "jail/probe.py 7de02da28637134a7c5999f7d8350af131dd3755 411b53e433512628ba18fad1b3b011e35669044ed60d753b32b28a9d4e971b54"; do
  set -- $e
  [ "$(sudo git -C "$C" rev-parse "$X:$P/$1")" = "$2" ] || d0b_stop "$1: blob at X is not $2"
  [ "$(sudo git -C "$C" rev-parse "$OLD_TARGET:$P/$1" 2>/dev/null)" = "$2" ] || d0b_stop "$1: blob at $OLD_TARGET is not $2"
  [ "$(sudo git -C "$C" show "$X:$P/$1" | sha256sum | cut -d' ' -f1)" = "$3" ] || d0b_stop "$1: sha256 is not $3"
done
set --
# the machine is in the state c066618 installs (so D-4 restores it exactly)
[ "$(sudo git -C "$C" hash-object --no-filters /usr/local/lib/sr-jail/probe.py)" = fe4a08bea7ddf8f7c1294c0550529d50fe17e904 ] || d0b_stop "installed probe.py is not c066618's"
[ "$(sudo git -C "$C" hash-object --no-filters /usr/local/lib/sr-jail/jail.properties)" = ed780fbb0862255b4b45a0f82307ebd9cf43e209 ] || d0b_stop "installed jail.properties is not c066618's"
sudo cmp -s /root/sr-a3/before/probe.py /usr/local/lib/sr-jail/probe.py || d0b_stop "probe.py changed since D-0"
for u in sr-jail-net.service sr-jail-claude.service; do sudo cmp -s "/root/sr-a3/before/$u" "/etc/systemd/system/$u" || d0b_stop "$u changed since D-0"; done
[ "$(sudo grep -c ' rule add ' /etc/systemd/system/sr-jail-net.service)" = 1 ] && sudo grep -qE ' rule add to 198\.51\.100\.53/32 ipproto tcp prohibit priority 100$' /etc/systemd/system/sr-jail-net.service || d0b_stop "sr-jail-net.service does not have exactly the old single rule"
[ "$(sudo sed -n 3p /root/sr-a3/rules.before)" = "100: from all to 198.51.100.53 ipproto tcp prohibit" ] || d0b_stop "rules.before is not the expected 'before' set"
echo "== the backport, X against the clone's commit =="
sudo git -C "$C" --no-pager diff --stat "$BASE" "$X"
if [ "$D0B" = OK ]; then
  sudo test -e /root/sr-a3/target-sha.e525371 || echo "$OLD_TARGET" | sudo tee /root/sr-a3/target-sha.e525371 >/dev/null
  echo "$X" | sudo tee /root/sr-a3/target-sha >/dev/null
  sr_a3_untouched() {
    local u p
    for u in sr-capture.service sr-capture.path sr-capture.timer sr-design-cycle.service sr-design-cycle.timer \
             sr-design-worker.service sr-design-worker.timer sr-design-bridge.service sr-design-bridge.timer \
             sr-claude-auth-watch.service sr-claude-auth-watch.timer; do
      p="$(systemctl show "$u" -p FragmentPath --value 2>/dev/null)"
      if [ -n "$p" ] && sudo test -f "$p"; then echo "unit $u $(systemctl is-enabled "$u" 2>/dev/null | head -n1) $(sudo sha256sum "$p" | cut -d' ' -f1)"; else echo "unit $u absent"; fi
    done
    echo "helper-head $(sudo git -C /home/sr-igcapture/second-root rev-parse HEAD 2>/dev/null || echo none)"
    echo "approved-sha $(sudo cat /home/sr-igcapture/.config/sr-capture/approved-sha 2>/dev/null || echo none)"
  }
  sr_a3_untouched | sudo tee /root/sr-a3/untouched.before
  echo "D0B_OK target-sha=$(sudo cat /root/sr-a3/target-sha) previous-sha=$(sudo cat /root/sr-a3/previous-sha)"
else
  echo "D0B_STOP: nothing recorded; report the lines above"
fi
```

Go on only when the output has no `D0B_STOP` line and ends with `D0B_OK target-sha=fbfce3c… previous-sha=c066618…`.
The diff stat must list exactly the three files, with 194 insertions and 30 deletions. The human approves exactly
this. Re-running D-0b before D-2b is safe.

**D-2b (approval 2b).** First run W-0 again, and go on only on `W0_OK`. Then:

```bash
# D-2b (DEV-091, approval 2b): only right after W-0 printed W0_OK. Moves the root clone to X (the 3 files only) and installs the jail.
X=fbfce3c87abb185a4cc59d28f2a842a838ddeac0
BASE=c066618cd6a40fe1cef57f75a71b755eea4157e8
C=/root/sr-capture-admin
P=scripts/sales-design-capture
if [ "$(sudo cat /root/sr-a3/target-sha 2>/dev/null)" = "$X" ] && [ "$(sudo git -C "$C" rev-parse HEAD)" = "$BASE" ]; then
  sudo git -C "$C" checkout -q --detach "$X" \
    && [ "$(sudo git -C "$C" rev-parse HEAD)" = "$X" ] \
    && [ -z "$(sudo git -C "$C" status --porcelain --untracked-files=normal)" ] \
    && [ "$(sudo git -C "$C" diff --name-only "$BASE" HEAD)" = "$(printf '%s\n' "$P/admin.sh" "$P/jail/jail.properties" "$P/jail/probe.py")" ] \
    && echo "D2B: clone at X, clean, 3 files; installing the jail" \
    && sudo bash "$C/$P/admin.sh" jail-install \
    && echo "D2B_DONE" \
    || echo "D2B_FAILED: read the lines above (no 'D2B: clone at X' line: put the clone back with: sudo git -C $C checkout -q --detach $BASE; after it: D-4)"
else
  echo "D2B_STOP: run D-0b first (target-sha must be X and the clone at $BASE)"
fi
```

The last lines mean the same as in D-2:
- `JAIL_OK`, then `JAIL_DNS_OK`, then `D2B_DONE`: go to D-3.
- `JAIL_UNSAFE …` (for example `DNS_RULES_UNCHECKED` or `DNS_RULES_NOT_EXACT`), `JAIL_DNS_FAILED`,
  `JAIL_UNIT_REJECTED` or `D2B_FAILED` after the `D2B: clone at X` line: go to D-4.
- `D2B_FAILED` without that line: nothing was installed. Put the clone back as printed.

**D-3 (included in approval 2b; read only, plus sends that must be refused).**

```bash
# D-3 (DEV-091, included in approval 2b): verify. Read only, plus 1-byte UDP sends and TCP connects that must be refused.
C=/root/sr-capture-admin
A="$C/scripts/sales-design-capture/admin.sh"
echo "clone: $(sudo git -C "$C" rev-parse HEAD) dirty-lines=$(sudo git -C "$C" status --porcelain --untracked-files=normal | wc -l)"
sudo bash "$A" jail-rules | sudo tee /root/sr-a3/rules.after
echo "== rules =="; sudo diff /root/sr-a3/rules.before /root/sr-a3/rules.after
echo "== sr-jail-net.service =="; sudo diff /root/sr-a3/before/sr-jail-net.service /etc/systemd/system/sr-jail-net.service
echo "== sr-jail-claude.service =="; sudo diff /root/sr-a3/before/sr-jail-claude.service /etc/systemd/system/sr-jail-claude.service && echo SAME
echo "== jail.properties, settings only =="; sudo diff <(sudo grep -Ev '^[[:space:]]*(#|$)' /root/sr-a3/before/jail.properties) <(sudo grep -Ev '^[[:space:]]*(#|$)' /usr/local/lib/sr-jail/jail.properties) && echo SAME
echo "== probe.py =="; sudo cmp -s /root/sr-a3/before/probe.py /usr/local/lib/sr-jail/probe.py && echo SAME || echo CHANGED
sr_a3_untouched() {
  local u p
  for u in sr-capture.service sr-capture.path sr-capture.timer sr-design-cycle.service sr-design-cycle.timer \
           sr-design-worker.service sr-design-worker.timer sr-design-bridge.service sr-design-bridge.timer \
           sr-claude-auth-watch.service sr-claude-auth-watch.timer; do
    p="$(systemctl show "$u" -p FragmentPath --value 2>/dev/null)"
    if [ -n "$p" ] && sudo test -f "$p"; then echo "unit $u $(systemctl is-enabled "$u" 2>/dev/null | head -n1) $(sudo sha256sum "$p" | cut -d' ' -f1)"; else echo "unit $u absent"; fi
  done
  echo "helper-head $(sudo git -C /home/sr-igcapture/second-root rev-parse HEAD 2>/dev/null || echo none)"
  echo "approved-sha $(sudo cat /home/sr-igcapture/.config/sr-capture/approved-sha 2>/dev/null || echo none)"
}
echo "== timers, helper, design and auth-watch units (expect no lines) =="; sr_a3_untouched | sudo diff /root/sr-a3/untouched.before - && echo UNTOUCHED
sudo bash "$A" jail-check
sudo bash "$A" run sr-designgen -- getent hosts github.com
sudo bash "$A" run sr-designgen -- /usr/bin/python3 -I -c 'import socket, errno
for proto, port in (("udp", 853), ("udp", 9), ("tcp", 853), ("tcp", 53)):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM if proto == "udp" else socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        if proto == "udp":
            s.sendto(b"x", ("198.51.100.53", port))
        else:
            s.connect(("198.51.100.53", port))
        print("DNS_ADDR", proto, port, "NOT_REFUSED")
    except OSError as e:
        print("DNS_ADDR", proto, port, errno.errorcode.get(e.errno, e.errno))
    finally:
        s.close()'
systemctl is-active sr-jail-net sr-jail-claude
```

Expected:
- `clone: fbfce3c87abb185a4cc59d28f2a842a838ddeac0 dirty-lines=0`.
- **rules:** exactly `3c3,5`: `< 100: from all to 198.51.100.53 ipproto tcp prohibit` →
  `> 98: … ipproto udp dport 853 prohibit`, `> 99: … ipproto udp dport 53 lookup main`, `> 100: … prohibit`.
- **`sr-jail-net.service`:** exactly one hunk, `12c12,14`: the old `ipproto tcp prohibit priority 100` line replaced by
  the three new `ExecStartPre` lines.
- **`sr-jail-claude.service`:** `SAME`. DEV-088 does not change it; this was proven by rendering it from both commits.
- **`jail.properties`, settings only:** `SAME`.
- **`probe.py`:** `CHANGED`.
- **untouched:** no diff lines, then `UNTOUCHED`. This covers the helper's units and checkout, `approved-sha`, the
  design units and the auth-watch units.
- `JAIL_OK` and `JAIL_DNS_OK`. `getent` prints github.com's addresses. There are four `DNS_ADDR … EACCES` lines.
  `sr-jail-net` is `active`, and `sr-jail-claude` is as in D-0.

On any other line, go to D-4 and report the lines.

**D-4 (the abort path, included in approval 2b).**

```bash
# D-4 (DEV-091, the abort path, included in approval 2b): the clone back to c066618, jail-install, compare with the D-0 backups.
BASE=c066618cd6a40fe1cef57f75a71b755eea4157e8
C=/root/sr-capture-admin
if [ "$(sudo cat /root/sr-a3/previous-sha 2>/dev/null)" = "$BASE" ]; then
  sudo git -C "$C" checkout -q --detach "$BASE" \
    && [ "$(sudo git -C "$C" rev-parse HEAD)" = "$BASE" ] \
    && [ -z "$(sudo git -C "$C" status --porcelain --untracked-files=normal)" ] \
    && sudo bash "$C/scripts/sales-design-capture/admin.sh" jail-install
  sudo ip -n srjail rule show
  for f in sr-jail-net.service sr-jail-claude.service; do sudo cmp "/root/sr-a3/before/$f" "/etc/systemd/system/$f" && echo "SAME $f"; done
  for f in jail.properties probe.py; do sudo cmp "/root/sr-a3/before/$f" "/usr/local/lib/sr-jail/$f" && echo "SAME $f"; done
  echo "clone: $(sudo git -C "$C" rev-parse HEAD)"
  systemctl is-active sr-jail-net sr-jail-claude
else
  echo "D4_STOP: previous-sha is not $BASE: stop and report"
fi
```

Expected:
- the old single `100: from all to 198.51.100.53 ipproto tcp prohibit` rule;
- `JAIL_OK` from `c066618`'s `jail-check` (it has no `JAIL_DNS_OK` step);
- four `SAME` lines;
- `clone: c066618…`.

D-0b checked that the installed files were `c066618`'s, so `jail-install` at `c066618` writes them back byte for byte.
Do not delete rules by hand.

The blocks above were checked with `bash -n`. D-0b, D-2b and D-4 were also run here against a simulated
`/root/sr-a3`, a clone, and stand-ins for `sudo`, `systemctl` and `admin.sh`. That covered the success path and the
stop paths for a dirty clone, a changed installed probe and the wrong commit.

### 4.7 What fails closed

| failure | what happens |
|---|---|
| pasta does not start (a bad binary, an AppArmor denial, a changed option) | `sr-jail-net` fails; every jail unit has `Requires=`/`BindsTo=sr-jail-net`, so Claude and `admin.sh run` cannot start (`systemd-run` fails on the dependency). Nothing runs outside the jail instead |
| pasta crashes at run time | the namespace keeps only `lo` and the dead tap: no way out. `Restart=always` starts pasta again after 5 s; Claude is restarted only if enabled |
| `ip rule add` fails in `ExecStartPre` | the unit fails before pasta starts (no `-` prefix on those lines) |
| any `JAIL_UNSAFE` from `probe.py` | `ExecStartPre` of every jail unit fails, the unit does not start |
| the jail's cgroup filters (`IPAddressAllow/Deny`) and seccomp | set by systemd from `jail.properties`; the package does not touch them |
| what does **not** fail closed | pasta's **own** self-confinement (dropped capabilities, its seccomp filter, its namespaces). Nothing outside pasta enforces it, which is why V-3a compares `/proc/<pid>/status` and stops on any increase |

## 5. (d) Verification plan (each step needs approval first; nothing here has been run)

Before any heavy step on the WSL machine, run the resource preflight (`docs/operations/wsl-resource-preflight.md`).

### 5.0 Claude, the worker and the window (DEV-087)

**What stops while the jail is down.** Everything that runs in the jail:
- `sr-jail-claude.service` (Claude Remote Control in tmux). `admin.sh claude-stop` disables and stops it.
- Transient `sr-jail-run-*` units from `admin.sh run`. They carry the design worker run started by `cycle.sh` (and a
  person's manual worker runs, PoC runs and probes); `sr-jail-shell-*` and `sr-jail-check-*` are a person's shell and
  `jail-check`.
- `claude-stop` stops **every** `sr-jail-*.service` except the net unit (`stop_jail_units`), so it would cut a worker job
  that is running. A restart of `sr-jail-net` does the same through `BindsTo`.

**What does not stop:** the Instagram capture helper (`sr-capture.*`, user `sr-igcapture`, outside the jail, host
namespace) and the design bridge (user `sr-designbridge`, outside the jail). Neither goes through pasta. While Claude
and the worker are stopped, nothing asks the helper for captures, and the bridge claims jobs only from a cycle (§ below).

**The worker timer.** `sr-design-cycle.timer` (hourly at :17 + up to 10 min) is not installed or enabled by the
repository, and the records say it has not been enabled (HUMAN-010 is on hold, 2026-10-19). The older
`sr-design-worker.timer` / `sr-design-bridge.timer` must not be enabled when the cycle is used (`cycle.sh`
`CHECK_UNIT_ENABLED`). W-0 checks all of them instead of trusting the records.

**How to keep a job from running mid-update without touching a timer:**
1. **W-0 (read only), right before D-2 and again before V-2:** no `sr-jail-run-*` / `sr-jail-shell-*` unit, no worker or
   Codex process, the cycle lock free, and no timer due within 30 minutes. If something runs, wait for it to end. Do not
   stop it.
2. If a worker timer **is** enabled: pick a window right after a cycle ended (the lock is free and the next start is more
   than 30 minutes away; a cycle can run up to 75 minutes). That needs no extra approval.
3. Only if no such window can be found: **L-1 (A-12a)** holds `cycle.sh`'s own lock for the window. A cycle the timer
   starts then ends at once with `CYCLE_LOCKED` (exit 11, a success status for the unit) before its preflight, claim or
   worker, and the timer stays as it is. A person's manual `run.sh` takes a different lock, which is why the window is
   also announced to whoever might start one.
4. Only if L-1 is not acceptable either: **A-12b** disables the timer for the window and enables it again afterwards
   (`systemctl disable --now` / `enable --now`, `design-worker-cycle.md`). That is a worker / timer change and needs its
   own approval.

**Claude in the jail.** Before the window, ask the jailed Claude to commit and push its work and to stop at a clean
point. `claude-stop` ends its tmux server: the Remote Control session disconnects, and a running turn and its in-memory
context are lost. Files in `~sr-designgen/work` stay on disk. V-2b starts it again only if V-0 had it enabled. Cloud
Claude Code sessions (like the one that wrote this plan) and Claude outside the jail are not affected.

**Expected downtime of the jail:** 5–10 minutes on the success path (V-2 under a minute, V-3a 2–3 minutes, 24b-v2
about 2 minutes if A-6 is approved together and run before V-2b), plus 5–10 minutes for a rollback. A-3's deploy (D-2)
interrupts the jail for a few seconds on its own.

**W-0 — the window check (read only).** Run as a person in the WSL shell, outside the jail:

```bash
systemctl list-timers --all --no-pager 'sr-*'
systemctl list-unit-files --no-legend 'sr-*.timer' 'sr-*.path' 'sr-*.service'
systemctl list-units --all --plain --no-legend 'sr-jail-*' 'sr-design-*'
if pgrep -u sr-designgen -f 'scripts/sales-design-worker/|sales-design-bridge/|design-image-poc|codex' >/dev/null; then echo "W0_STOP: a worker, PoC or Codex process of sr-designgen is running"; else echo "W0: no worker, PoC or Codex process"; fi
if sudo test -e /var/lib/sr-design-cycle/cycle.lock; then sudo flock -n /var/lib/sr-design-cycle/cycle.lock true && echo "W0: cycle lock free" || echo "W0_STOP: a cycle is running"; else echo "W0: no cycle state (the cycle never ran)"; fi
```

Go on only when: no `sr-jail-run-*` or `sr-jail-shell-*` unit is active, both checks print `W0:`, and no `sr-*` timer
is enabled with a next run within 30 minutes. Otherwise wait and run W-0 again.

**L-1 — hold the cycle lock (A-12a, only if approved).** In a second root terminal, before V-2; it prints
`CYCLE_LOCK_HELD` and holds the lock until Enter is pressed after V-3 / R-3:

```bash
sudo flock -n -E 75 /var/lib/sr-design-cycle/cycle.lock -c 'echo CYCLE_LOCK_HELD; read -r _'
```

Exit code 75 means a cycle holds the lock right now: wait. If the terminal closes, the lock is released.

### 5.1 The snapshot (S-1), V-0 and the update

**S-1 — the snapshot function.** Paste it into the WSL shell (outside the jail) before V-0, V-3a and R-3. It prints
codes, versions, hashes, unit lines and capability masks only (no secrets, no addresses beyond the unit's own lines).
It is run as root: `sudo bash -c "$(declare -f sr_snap); sr_snap"`.

```bash
sr_snap() {
  local f pid out
  dpkg-query -W -f='pkg ${Package} ${Version} ${db:Status-Abbrev}\n' passt 2>&1
  echo "held $(apt-mark showhold | grep -qx passt && echo yes || echo no)"
  for f in /usr/bin/passt /usr/bin/passt.avx2 /usr/bin/pasta /usr/bin/pasta.avx2 /usr/bin/passt-repair; do
    if [ -e "$f" ]; then echo "file $f $(stat -c '%U:%G %a links=%h' "$f") $(sha256sum < "$f" | cut -c1-64)"; else echo "file $f absent"; fi
  done
  echo "hardlinks pasta=passt:$([ /usr/bin/pasta -ef /usr/bin/passt ] && echo yes || echo no) pasta.avx2=passt.avx2:$([ /usr/bin/pasta.avx2 -ef /usr/bin/passt.avx2 ] && echo yes || echo no)"
  out="$(dpkg --verify passt 2>&1)"
  if [ -z "$out" ]; then echo "dpkg-verify clean"; else printf '%s\n' "$out" | sed 's/^/dpkg-verify /'; fi
  echo "rdepends $(apt-cache rdepends --installed --no-recommends --no-suggests passt 2>/dev/null | tail -n +3 | tr -d ' ' | paste -sd, -)"
  echo "other-users $(dpkg-query -W -f='${Package}:${db:Status-Abbrev} ' podman buildah libvirt-daemon-driver-qemu 2>/dev/null)"
  echo "processes pasta=$(pgrep -c -x 'pasta(\.avx2)?' || true) passt=$(pgrep -c -x 'passt(\.avx2)?' || true)"
  find /etc/apparmor.d /var/cache/apparmor -name 'usr.bin.pas*' -type f -exec sha256sum {} + 2>/dev/null | sort -k2 | sed 's/^/aa /'
  echo "lsm $(cat /sys/kernel/security/lsm 2>/dev/null)"
  echo "aa-enabled $(aa-enabled 2>&1 || true)"
  if aa-enabled --quiet 2>/dev/null; then aa-status 2>/dev/null | grep -E 'pas(st|ta)' | sed 's/^/aa-loaded /'; fi
  echo "unit-sha $(systemctl cat sr-jail-net.service 2>/dev/null | sha256sum | cut -c1-64)"
  grep -E '^(ExecStartPre|ExecStart|IPAddressAllow|IPAddressDeny)=' /etc/systemd/system/sr-jail-net.service | sed 's/^/unit /'
  echo "jail-files $(sha256sum < /usr/local/lib/sr-jail/jail.properties | cut -c1-64) $(sha256sum < /usr/local/lib/sr-jail/probe.py | cut -c1-64)"
  ip -n srjail rule show 2>&1 | sed 's/^/rule /'
  echo "net $(systemctl is-active sr-jail-net.service 2>/dev/null)"
  pid="$(systemctl show -p MainPID --value sr-jail-net.service 2>/dev/null)"
  if [ -n "$pid" ] && [ "$pid" != 0 ]; then
    echo "pasta-exe $(readlink "/proc/$pid/exe")"
    grep -E '^(Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp|Seccomp_filters):' "/proc/$pid/status" | tr -s '\t ' ' ' | sed 's/^/pasta /'
  else
    echo "pasta-exe none"
  fi
  echo "python $(python3 -c 'import sys, ssl; print(sys.version.split()[0], ssl.OPENSSL_VERSION.split()[1])' 2>&1)"
  echo "claude $(systemctl is-enabled sr-jail-claude.service 2>/dev/null || true)/$(systemctl is-active sr-jail-claude.service 2>/dev/null || true)"
  echo "timers $(systemctl list-unit-files --no-legend 'sr-*.timer' 'sr-*.path' 2>/dev/null | awk '{ print $1 "=" $2 }' | paste -sd' ' -)"
  echo "jail-units $(systemctl list-units --all --plain --no-legend 'sr-jail-*' 2>/dev/null | awk '{ u = ($1 == "●" ? $2 : $1); s = ($1 == "●" ? $4 : $3); print u "=" s }' | sort | paste -sd' ' -)"
}
```

**V-0 — snapshot before the update (A-4).** Everything is read only except the files it writes in the new root-only
directory `/root/sr-passt-update/`: the snapshot `v0.txt`, the restore state `v0-state`, and a copy of every AppArmor
side file of passt / pasta (`v0-apparmor.list`, `v0-apparmor.tar`), which a purge would delete.

```bash
sudo install -d -m 0700 /root/sr-passt-update
sudo bash -c "$(declare -f sr_snap); sr_snap" | sudo tee /root/sr-passt-update/v0.txt
{
  echo "claude_enabled=$(systemctl is-enabled sr-jail-claude.service 2>/dev/null || true)"
  echo "claude_active=$(systemctl is-active sr-jail-claude.service 2>/dev/null || true)"
  echo "passt_held=$(apt-mark showhold | grep -qx passt && echo yes || echo no)"
} | sudo tee /root/sr-passt-update/v0-state
sudo bash -c 'cd / && { find etc/apparmor.d/local etc/apparmor.d/disable etc/apparmor.d/force-complain var/cache/apparmor -name "usr.bin.pas*" -type f 2>/dev/null || true; } | sort > /root/sr-passt-update/v0-apparmor.list && tar -cpf /root/sr-passt-update/v0-apparmor.tar --no-recursion --files-from=/root/sr-passt-update/v0-apparmor.list && tar -tf /root/sr-passt-update/v0-apparmor.tar'
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh jail-check
```

Also keep the HUMAN-024b outputs, jail and host, as the baseline (and 24b-v2's, if A-1b ran).

Expected for today's package:
- `pkg passt 0.0~git20240220.1e6f92b-1 ii`, `held no` (most likely);
- `/usr/bin/passt` sha256 `2edcf1d787b21564045045f27def85e6397b930557ce5884ed8bfa8d0c77e048`, `passt.avx2`
  `da1809a041fd9075e638aaffc2b40b7be1723824fb8d0b6697c074c0cb4baec8`, `links=2` and `hardlinks pasta=passt:yes
  pasta.avx2=passt.avx2:yes`, `passt-repair absent`;
- `dpkg-verify clean`. On dpkg 1.22 `dpkg --verify` exits 0 even when it finds problems, which is why S-1 tests its
  output. Exception: `missing` lines only under `/usr/share/doc` or `/usr/share/man` come from dpkg path-excludes on a
  minimized image (`/etc/dpkg/dpkg.cfg.d/`) and are expected. Any line on `/usr/bin` or an `/etc` conffile means a passt
  file was changed locally: stop and report;
- `rdepends` empty, `processes pasta=1 passt=0` (only the jail's pasta). `other-users` lists podman / buildah / libvirt
  only if installed; if any of them is installed, or another pasta / passt process runs, stop and decide first (§3.1);
- `aa` lines: the noble conffiles and `local/usr.bin.passt`; no `usr.bin.pasta` anywhere;
- `pasta-exe /usr/bin/pasta.avx2` (or `/usr/bin/pasta` on a CPU without AVX2), never `(deleted)`; `pasta Seccomp: 2`;
- whatever V-0 shows is the state the rollback restores.

**V-1 — fetch and verify the package (part of A-5, no install).** Run as root in the root-only directory:

```bash
sudo install -d -m 0700 /root/sr-passt-update
sudo bash -euo pipefail -c '
cd /root/sr-passt-update
apt-get download passt=0.0~git20240220.1e6f92b-1
echo "de07c44dcae84b58107cdf47e58f7d6ca2fdd466b193a10aea8a7115cf97bead  passt_0.0~git20240220.1e6f92b-1_amd64.deb" | sha256sum -c
curl -fsSLo InRelease https://archive.ubuntu.com/ubuntu/dists/resolute/InRelease
gpgv --keyring /usr/share/keyrings/ubuntu-archive-keyring.gpg --output Release InRelease
H="$(awk '"'"'/^SHA256:/{x=1;next} /^[A-Z]/{x=0} x && $3=="universe/binary-amd64/Packages.xz"{print $1}'"'"' Release)"
curl -fsSLo Packages.xz https://archive.ubuntu.com/ubuntu/dists/resolute/universe/binary-amd64/Packages.xz
echo "$H  Packages.xz" | sha256sum -c
xz -dc Packages.xz | awk '"'"'/^Package: passt$/{p=1} p&&/^(Version|Filename|SHA256):/{print} p&&/^$/{p=0}'"'"'
curl -fsSLo passt_0.0~git20260120.386b5f5-1_amd64.deb https://archive.ubuntu.com/ubuntu/pool/universe/p/passt/passt_0.0~git20260120.386b5f5-1_amd64.deb
echo "49eaf773c120432bdf439d26d3de4d9867116580a819e6eba815b600c45b9840  passt_0.0~git20260120.386b5f5-1_amd64.deb" | sha256sum -c
dpkg-deb -f passt_0.0~git20260120.386b5f5-1_amd64.deb Package Version Depends
dpkg-deb -c passt_0.0~git20260120.386b5f5-1_amd64.deb | awk "{print \$6}"
'
```

**Stop if:**
- `gpgv` does not say "Good signature";
- any `sha256sum -c` fails;
- the `Packages` stanza shows a different `Version` or `SHA256` (resolute may have published an update since this plan
  was written; re-review it then).

The old deb kept here is the rollback copy (§6). `apt-get download` into a root-only directory prints a harmless
`W: Download is performed unsandboxed as root` warning. The script was run end to end in a scratch directory
on 2026-10-22: every check passed and the stanza matched. DEV-087 downloaded both debs again: the hashes still match.

**V-2 — the update (A-5).** Run it as a person, at the console, right after W-0 passed:

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-stop
echo "49eaf773c120432bdf439d26d3de4d9867116580a819e6eba815b600c45b9840  /root/sr-passt-update/passt_0.0~git20260120.386b5f5-1_amd64.deb" | sudo sha256sum -c
sudo dpkg -i /root/sr-passt-update/passt_0.0~git20260120.386b5f5-1_amd64.deb
sudo apt-mark hold passt
sudo systemctl restart sr-jail-net.service
systemctl is-active sr-jail-net.service
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh jail-check
```

- The hash is checked again right before `dpkg -i`, so the file installed is the file V-1 verified. If
  `sha256sum -c` fails, do not run `dpkg -i`.
- `dpkg -i` must not ask about a modified conffile. V-0's `dpkg-verify` lines show whether any was modified; if a
  prompt appears, answer **N** (keep the current one) and stop.
- Until the restart the jail keeps running the old pasta (the running process keeps the old file). The restart of
  `sr-jail-net` starts the new one; `ExecStartPost` does not start Claude, because `claude-stop` disabled it.
- If `sr-jail-net` is not `active` or `jail-check` is not `JAIL_OK`, roll back (§6). Do not change the jail to make it
  start.

**V-3a — immediate checks (part of A-5).**

```bash
sudo bash -c "$(declare -f sr_snap); sr_snap" | sudo tee /root/sr-passt-update/v3.txt >/dev/null
sudo diff /root/sr-passt-update/v0.txt /root/sr-passt-update/v3.txt
for k in CapInh CapPrm CapEff CapBnd CapAmb; do
  a="$(sudo awk -v k="$k:" '$1 == "pasta" && $2 == k { print $3 }' /root/sr-passt-update/v0.txt)"
  b="$(sudo awk -v k="$k:" '$1 == "pasta" && $2 == k { print $3 }' /root/sr-passt-update/v3.txt)"
  if [ -n "$a" ] && [ -n "$b" ] && [ $(( 0x$b & ~0x$a )) -eq 0 ]; then echo "caps $k ok"; else echo "caps $k CHECK v0=${a:-none} v3=${b:-none}"; fi
done
pasta --version | head -n 1
```

Then D-3 (§4.6) as written: the rules (`jail-rules`, now the same as `/root/sr-a3/rules.after`; the two `diff`s against
the pre-A-3 files show the A-3 change again and nothing else), `jail-check`, `getent hosts github.com` in the jail, and
the four `DNS_ADDR` lines.

The `diff` may show **only** these lines (anything else is a failure):
- `pkg passt 0.0~git20260120.386b5f5-1 ii` and `held yes`;
- the `file` lines: `/usr/bin/passt` sha256 `a10789852407f65160c4abfac002efe511b254e6ab2cbfc658e807575db44832`,
  `passt.avx2` `e02708849808156f0c7f92f39b7d970b01f2d5c392fc559eeb294dbda72abed7`, the same `root:root 755 links=2`,
  and `passt-repair` now present (`root:root 755 links=1`);
- `aa` lines: changed hashes of `abstractions/passt`, `abstractions/pasta`, `usr.bin.passt`; new `usr.bin.pasta` and
  `local/usr.bin.pasta` (the empty file's hash `e3b0c442…b855`); cache lines only if AppArmor is active (then A-9 may
  apply);
- `claude disabled/inactive` and the `jail-units` line (Claude stopped).

- `pasta Cap*` lines that **lost** bits (fewer capabilities). Whether a changed `Cap*` line is acceptable is decided by
  the capability loop, not by the `diff`: it must print `ok` five times (no bit that V-0 did not have); a decrease is
  fine;
- `pasta Seccomp_filters`: report the value. It must be ≥ V-0's (pasta installs its own filter at start; a new build may
  stack one more). A lower value, or `Seccomp` other than 2, is a failure;
- new `dpkg-verify … missing` lines **only** under `/usr/share/doc` or `/usr/share/man`, for example
  `/usr/share/man/man1/passt-repair.1.gz` on a minimized image (the same dpkg path-excludes as in V-0). Any other new
  `dpkg-verify` line is a failure.

Everything else must be identical: the other `dpkg-verify` lines, `rdepends`, `other-users`, `processes`, `lsm`,
`aa-enabled`, `unit-sha` and the `unit` lines, `jail-files`, every `rule` line, `net active`, `pasta-exe` (no
`(deleted)`), `pasta Uid`, `Gid`, `NoNewPrivs` and `Seccomp 2`, `python`, `timers`. `pasta --version` prints `pasta 0.0~git20260120.386b5f5-1` (this build embeds its version; noble's
printed `pasta unknown version`).

**V-3b — 24b-v2 in the jail and on the host (A-6).** The two 24b-v2 commands in `design-image-poc.md` §"HUMAN-024",
24b-v2 and 24b-v2-host, unchanged. (24b itself also works, but cannot show that the probes are answered.)

**Success, failure and stop criteria:**

| result | decision |
|---|---|
| V-3a as expected, D-3 as expected for the chosen A-3 option (with A-3: four `EACCES` lines; without A-3: UDP lines `NOT_REFUSED`, TCP lines `EACCES`), 24b-v2 in the jail: A, B and C `end=OPEN idle_s=100` with A and B `ack_age_max_s` ≤ 20; 24b-v2-host: all `OPEN` as before | **success**: V-2b, keep the hold, then A-8 (one Codex run, separately approved) |
| `sr-jail-net` not active; `jail-check` not `JAIL_OK`; a capability bit that V-0 did not have; `Seccomp` not 2; `NoNewPrivs` or `Uid` changed; `Seccomp_filters` lower than V-0; `unit-sha`, a `unit` line, `jail-files` or a `rule` changed; a new `dpkg-verify` line outside `/usr/share/doc` and `/usr/share/man`; `getent` fails in the jail; a `DNS_ADDR` line not `EACCES` although A-3 is deployed; any unexpected `diff` line | **roll back now** (R-1 → R-3), as approved with A-5. Report the lines |
| AppArmor active and pasta denied (journal shows `apparmor="DENIED"` for `pasta`) | roll back, unless A-9 is approved; never remove a jail limit to make pasta start |
| 24b-v2 in the jail: A or B still `end=LOCAL_TIMEOUT` | **stop and report.** The fix did not take effect, or something else drops the ACKs. Rollback is recommended (a hand-installed package with no benefit), the human decides. No Codex run |
| 24b-v2-host changed (a cut on the host), or `PEER_RST` / `PEER_FIN` on all three, or `setup_failed` | stop and report; not a reason by itself to keep or remove the new pasta |

**V-2b — restore Claude to its V-0 state (success path, after V-3a and, if approved together, V-3b).** The hold set in
V-2 is the one intended change (§6.2), so it stays.

```bash
CLAUDE_ENABLED="$(sudo sed -n 's/^claude_enabled=//p' /root/sr-passt-update/v0-state)"
if [ "$CLAUDE_ENABLED" = enabled ]; then sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start; else echo "sr-jail-claude stays stopped (V-0: ${CLAUDE_ENABLED:-unknown})"; fi
systemctl is-enabled sr-jail-claude.service; systemctl is-active sr-jail-claude.service
```

The last line must show the V-0 values (`claude_enabled` / `claude_active` in `v0-state`). If V-0 had Claude enabled but
not active, `claude-start` leaves it active: note that difference and do not stop it again on your own. If L-1 holds the
cycle lock, release it now (Enter in its terminal).

**The in-jail tests, optional** (A-7, after the resource preflight). `design-wsl-isolation.md` §5 ran
`tests/unit/design-agent/sandbox.test.ts` (real bubblewrap attacks) and `worker.test.ts` (Chromium) in the jail
(73 pass). Run the same two through `admin.sh run sr-designgen -- …` from the requester's checkout.

**V-4 — one Codex run (A-8, separately approved).** Only after V-3 passes: HUMAN-021b's v1 command once, as 24c.
Expected:
- `img_call_ms` for the first call well under the 156 s pattern;
- no `140-170s` in `img_fail_timing`;
- ideally an image.

A failure with a different timing is new evidence for H2/H3, not a reason to roll back passt. Only this run can show
whether the image failures had the keep-alive cause (24b cannot, §1).

**Optional, container-side (not the WSL machine).** An A/B of the two pasta binaries in a scratch network namespace:
- the jail's exact flags;
- a local TLS server;
- the 24b probe with `CA` pointed at the test certificate.

Expected: `1e6f92b` cuts A at about 27 s, and `386b5f5` keeps it open. It was set up in a DEV-086 session but **not
run**: the session's permission check stopped running the probe inside the scratch namespace. It needs the session
owner's permission, and its result would add evidence but replace none of V-3. DEV-087 did not retry it.

## 6. (e) Rollback and the hold policy

### 6.1 Rollback (approved together with A-5 as its abort path; run by a person)

**What the update changes, and where each item is captured and restored:**

| changed by A-5 | captured in | restored by |
|---|---|---|
| passt's files in `/usr/bin` and `/usr/share` | V-1: the verified noble deb (`de07c44d…`); V-0: `v0.txt` `file` lines | R-2: purge, then `dpkg -i` of that deb |
| passt's conffiles in `/etc/apparmor.d` (`abstractions/passt`, `abstractions/pasta`, `usr.bin.passt`; new `usr.bin.pasta`) | V-0: `v0.txt` `aa` lines and `dpkg-verify` | R-2: purge removes all of them, the noble deb installs its own; R-1 first proves none was changed locally |
| AppArmor side files: `local/`, `disable/`, `force-complain/` and `/var/cache/apparmor` entries for `usr.bin.pas*` (the 386b5f5 postinst creates `local/usr.bin.pasta`; its postrm on purge deletes the `local/`, `disable/`, `force-complain/` and cache entries of `usr.bin.passt` **and** `usr.bin.pasta`) | V-0: `v0-apparmor.list` + `v0-apparmor.tar` | R-2: delete what V-0 did not have, extract the tar |
| the loaded AppArmor policy (only if AppArmor is active) | V-0: `aa-enabled`, `aa-loaded` lines | R-2: unload the `pasta` profile before the purge; noble's postinst reloads `usr.bin.passt` |
| dpkg's record of passt, the hold | V-0: `pkg`, `held`; `v0-state` `passt_held` | R-2: purge + install; the hold as in V-0 |
| the running pasta | V-0: `pasta-exe`, `pasta` lines | R-2: restart `sr-jail-net` |
| Claude's enabled / active state | `v0-state` `claude_enabled` / `claude_active` | R-3 then V-2b |
| A-3's rules and probe (if deployed) | the root clone's commit | not part of this rollback: they stay (they are correct for both pasta versions). Their own rollback is D-4 |
| `/root/sr-passt-update/` (the debs, snapshots, `v0-*`) | – | kept on purpose for the record; nothing secret is in it. Removing it later is a separate, trivial decision |

The rollback **purges** the hand-installed package, then installs the verified noble deb. A plain downgrade with
`dpkg -i` is not used, for two reasons:
- **It leaves `/etc/apparmor.d/usr.bin.pasta` behind.** The noble package does not ship that conffile, so dpkg keeps
  it as an obsolete conffile of `passt`. If it stays on disk, noble's postinst still acts on it: it creates
  `local/usr.bin.pasta` and, when AppArmor is enabled, runs `apparmor_parser -r -T -W`, which writes a cache entry.
- **Moving the file aside does not help.** If it is moved aside first, `dpkg --verify` then reports `missing c` for it
  indefinitely.

`dpkg --purge passt` removes every passt conffile, and the 386b5f5 postrm (dh_apparmor) removes the `local/`,
`disable/`, `force-complain/` and `/var/cache/apparmor/*/` entries for `usr.bin.pasta`, `usr.bin.passt` and
`usr.bin.passt-repair`. After `dpkg -i` of the old deb and the restore of V-0's side files, the dpkg database and
`/etc/apparmor.d` are as V-0 recorded them, and `dpkg --verify` is clean.

Purging is only safe when:
- no passt conffile was changed locally (a purge would discard the change);
- no installed package depends on passt (`dpkg --purge` would refuse).

R-1 checks both (§3.1 found no package in noble that depends on passt). The jail is stopped during the purge, so a
missing `/usr/bin/pasta` affects nothing.

**R-1 — checks (read only).** Stop if:
- `sha256sum -c` fails;
- the verify output is not `dpkg-verify: clean` (apart from the doc and man lines V-0 allows);
- a package depends on passt;
- `v0-state`, `v0-apparmor.list` or `v0-apparmor.tar` is missing.

If the second or third is true, use the fallback below.

```bash
echo "de07c44dcae84b58107cdf47e58f7d6ca2fdd466b193a10aea8a7115cf97bead  /root/sr-passt-update/passt_0.0~git20240220.1e6f92b-1_amd64.deb" | sudo sha256sum -c
out="$(dpkg --verify passt)"; if [ -z "$out" ]; then echo "dpkg-verify: clean"; else printf '%s\n' "$out"; fi
apt-cache rdepends --installed --no-recommends --no-suggests passt | tail -n +3 | grep . || echo "no installed package depends on passt"
sudo cat /root/sr-passt-update/v0-state
sudo ls -l /root/sr-passt-update/v0-apparmor.list /root/sr-passt-update/v0-apparmor.tar
```

**R-2 — roll back.**

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-stop
sudo systemctl stop sr-jail-net.service
if [ -e /etc/apparmor.d/usr.bin.pasta ]; then
  sudo cp -p /etc/apparmor.d/usr.bin.pasta /root/sr-passt-update/usr.bin.pasta.from-386b5f5
  if aa-enabled --quiet 2>/dev/null; then sudo apparmor_parser -R /etc/apparmor.d/usr.bin.pasta || true; fi
fi
sudo apt-mark unhold passt
sudo dpkg --purge passt
sudo dpkg -i /root/sr-passt-update/passt_0.0~git20240220.1e6f92b-1_amd64.deb
sudo bash -c 'cd / && { find etc/apparmor.d/local etc/apparmor.d/disable etc/apparmor.d/force-complain var/cache/apparmor -name "usr.bin.pas*" -type f 2>/dev/null || true; } | sort | comm -23 - /root/sr-passt-update/v0-apparmor.list | while IFS= read -r f; do rm -f -- "/$f"; done; tar -xpf /root/sr-passt-update/v0-apparmor.tar'
if [ "$(sudo sed -n 's/^passt_held=//p' /root/sr-passt-update/v0-state)" = yes ]; then sudo apt-mark hold passt; fi
sudo systemctl start sr-jail-net.service
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh jail-check
```

- **The profile.** The loaded `pasta` profile (if AppArmor is active) is unloaded before the purge, because the purge
  removes the file but not the policy in the kernel. A copy is kept for reference. noble's postinst reloads its own
  `usr.bin.passt`.
- **The side files.** The `bash -c` line deletes every `usr.bin.pas*` file under `local/`, `disable/`,
  `force-complain/` and the cache that V-0 did not have, then extracts V-0's copies. It was tested here on a scratch tree
  (a new `local/usr.bin.pasta` and cache entry removed, a deleted `disable/usr.bin.passt` and a changed
  `local/usr.bin.passt` put back as V-0 had them). Cache entries exist only if AppArmor is active, which is not
  expected (§4.3).
- **The hold.** It ends as V-0 had it: unheld, unless V-0 showed `passt_held=yes`. It is lifted before the purge
  because dpkg may refuse to remove a held package.
- **Fallback, only if R-1 rules out the purge.**
  - Unload and move `/etc/apparmor.d/usr.bin.pasta` aside **before** the downgrade (same `if` block, `mv` instead of
    `cp`), then `sudo dpkg -i` the old deb.
  - Restore the side files as above.
  - Afterwards `dpkg --verify passt` prints exactly one expected line, `missing   c /etc/apparmor.d/usr.bin.pasta` (an
    obsolete conffile); any other line is a problem.
  - Record that line, and keep any locally changed conffile as it was.
- **Why not `apt-get install passt=0.0~git20240220.1e6f92b-1`.** The apt form also works (noble's release pocket still
  has that version), but the verified local copy works offline and pins the exact bytes.

**R-3 — verify, then restore Claude to its V-0 state.**

```bash
sudo bash -c "$(declare -f sr_snap); sr_snap" | sudo tee /root/sr-passt-update/r3.txt >/dev/null
sudo diff /root/sr-passt-update/v0.txt /root/sr-passt-update/r3.txt
pasta --version | head -n 1
```

The `diff` may show only the `claude` and `jail-units` lines (Claude is still stopped). With the fallback, it also shows
the one `dpkg-verify missing c /etc/apparmor.d/usr.bin.pasta` line. `pasta --version` prints `pasta unknown version`.
Then run V-2b's block, which starts Claude only if V-0 had it enabled, and the checklist in §6.4.

- **On a WSL backup:** `wsl --export` before A-5 is possible, but it is a Windows-side action with its own disk cost.
  It is not proposed; the deb copy and V-0's files are enough for one package.

### 6.2 Hold policy

- While `386b5f5-1` is installed by hand: **`apt-mark hold passt`**.
  - Today apt would not change it anyway: resolute is not an apt source, and noble's version is lower, so apt never
    downgrades on its own.
  - The hold makes that explicit, covers a future noble upload with a higher version string, and shows up in
    `apt-mark showhold`.
  - unattended-upgrades respects holds.
- After a rollback to noble's version: the hold state is whatever V-0 recorded (normally unheld). The machine is then
  back on the normal noble package, which gets whatever noble publishes.
- Any later change of the hand-installed version (a resolute SRU, a security fix) is a new approval. Follow V-1 → V-3
  with the new version and hash, and keep the previous deb as the rollback copy.

### 6.3 Who keeps it current

A hand-installed package gets no automatic updates (§3.1). Proposal (A-10):
- A person, or Claude in a docs session, checks resolute's passt publishing history and the Ubuntu and Debian security
  trackers monthly, and before any jail change.
- Return to the distro package when noble gets a fixed passt (unlikely) or when the machine moves to 26.04.

### 6.4 Rollback verification checklist

Tick every line after R-3 and V-2b. Any line that does not hold: stop, keep the jail stopped (`claude-stop`), report.

- [ ] `pkg passt 0.0~git20240220.1e6f92b-1 ii` in `r3.txt`, and `pasta --version` → `pasta unknown version`.
- [ ] `file` lines identical to `v0.txt` (hashes `2edcf1d7…` and `da1809a0…`, `links=2`, both `hardlinks … yes`,
      `passt-repair absent`).
- [ ] `dpkg-verify` lines identical to `v0.txt` (fallback: plus exactly the one `missing c …usr.bin.pasta` line).
- [ ] `aa` lines identical to `v0.txt`: no `usr.bin.pasta` profile, `local/`, `disable/`, `force-complain/` or cache
      entry that V-0 did not have, and the ones it had with the same hash. If AppArmor is active, the `aa-loaded`
      lines match too.
- [ ] `held` matches `passt_held` in `v0-state`.
- [ ] `unit-sha`, the `unit` lines, `jail-files` and every `rule` line identical (A-3's rules stay if they were in V-0).
- [ ] `net active`; `pasta-exe` the same path as V-0, not `(deleted)`; the `pasta` lines (`Uid`, `Gid`, `Cap*`,
      `NoNewPrivs`, `Seccomp`) identical.
- [ ] `jail-check` → `JAIL_OK`; `getent hosts github.com` resolves in the jail.
- [ ] After V-2b: the `claude` line matches `v0-state`; the `diff` against `v0.txt` is empty except a `jail-units`
      line that differs only in a transient unit.
- [ ] L-1 released, if it was held; timers as in V-0 (`timers` line).
- [ ] Optional: 24b (or 24b-v2) in the jail shows the pre-update pattern again (A cut at about 27 s), which shows the old
      pasta is back in the path.

## 7. (f) If updating is undesirable

- **pasta options in `1e6f92b`: none apply.**
  - The man page and `conf.c` at `1e6f92b` have no TCP keep-alive option.
  - The TCP-related options are `-t/-T` (port forwarding), `--no-tcp`, `--no-splice` and the address mappings.
  - The keep-alive handling is fixed code in `tcp_data_from_tap()`.
  - Nothing in pasta can be configured to ACK keep-alives.
- **Make the client not need ACKs.**
  - Codex has no key for `TCP_USER_TIMEOUT` or keepalive (investigation §6).
  - A provider override with `request_max_retries = 0` only shortens the failure to about 31 s.
  - The jail-wide sysctls (`net.ipv4.tcp_keepalive_*`) do not apply, because reqwest sets per-socket values.
  - Not a fix.
- **slirp4netns instead of pasta.**
  - A different user-space stack with its own TCP handling. Whether it ACKs keep-alives was not researched.
  - It changes the jail's network design: no `--dns-forward` equivalent with the same semantics, a different gateway
    model, a new root-run component, re-validating every probe check.
  - A large isolation change. Not recommended.
- **A loopback proxy inside the jail.**
  - It does not help: its upstream socket also goes through pasta (investigation §6).
  - It would only help if it never sent keepalives, and then it would need its own idle handling.
  - Not recommended.
- **The WSL networking mode** (`.wslconfig`). This only mattered if 24b-host was cut too; it was not (all three
  stayed open on the host, 2026-10-22). It changes nothing about pasta.
- **Move the machine to Ubuntu 26.04** (`do-release-upgrade`). That gives the same passt from a supported apt source,
  but it is a whole-distro change: systemd, apparmor, kernel userspace. The jail would need re-validation from scratch.
  Possibly the right long-term answer, but not as a fix for this.
- **An upstream report.** passt already fixed this in 2024-11, so there is nothing to report there. A request to Ubuntu
  for a noble SRU of `238c69f` is possible:
  - passt is in universe, so an SRU needs a sponsor;
  - it is an external post, so it is the human's decision (A-11);
  - it is slow.

  The Codex side (reqwest's 30 s `TCP_USER_TIMEOUT` default) is already discussed upstream (openai/codex#24323, #45381).

## 8. (g) Approvals, in order

Nothing advances without the one before it. Each is a separate human decision. **Status on 2026-10-22: A-1 is done;
nothing else is approved.** Not approved in particular: any package update, WSL setting, jail change, worker or timer
change, and any Codex run.

| # | step | what it changes | reversible? | runs on | depends on | command blocks |
|---|---|---|---|---|---|---|
| A-1 | **HUMAN-024b** (jail) and **24b-host**: the Codex-free probe | nothing (3 unauthenticated GETs per run) | – | WSL | – | **done 2026-10-22** (`design-image-poc.md` 24b) |
| A-1b | optional: **24b-v2** in the jail and on the host before the update, as a same-tool baseline | nothing | – | WSL | – | `design-image-poc.md` 24b-v2 |
| A-2 | Proceed with a passt update **and** grant a written exception to `design-wsl-isolation.md` §6 for exactly `passt 0.0~git20260120.386b5f5-1` from Ubuntu resolute, verified as in V-1 (the docs change goes in the A-3 PR or its own) | policy (docs) | yes | decision | A-1 (done: "cut in the jail, OPEN on the host") | – |
| A-3 | The jail's DNS rules: only UDP/53 to 198.51.100.53, plus the probe checks and tests (§4.6). **Policy adopted 2026-10-23; code implemented in DEV-088; applying it on WSL is a separate approval** | `sr-jail-net`'s ip rules, `probe.py`, `jail-check`, tests; the deploy restarts the jail for seconds | yes (D-4) | repo PR (DEV-088); on WSL `admin.sh jail-install` from the root clone at the DEV-091 backport commit `fbfce3c` (`c066618` + the three DEV-088 files), not at the merge commit | A-2 | D-1 (PR), D-0 (done), W-0, AW-1, D-0b, D-2b, D-3, D-4 (§4.6, backport variant) |
| A-4 | W-0 window check and V-0 snapshot | only new files in `/root/sr-passt-update/` | yes | WSL | A-2 (and A-3 deployed, if chosen) | S-1, W-0, V-0 |
| A-5 | V-1 fetch and verify, V-2 update and hold, V-3a immediate checks, and on success V-2b; **the rollback (R-1 → R-3, §6.4) approved together with A-5 as its abort path** | the passt package, its AppArmor files, the hold, a pasta restart, Claude stopped then restored | yes (R-1 → R-3) | WSL, root, a person at the console | A-4 | V-1, W-0, V-2, V-3a, D-3, V-2b, R-1, R-2, R-3 |
| A-6 | 24b-v2 in the jail and on the host after the update (can be approved together with A-5 and run before V-2b) | nothing | – | WSL | A-5 passes V-3a | V-3b |
| A-7 | In-jail `sandbox.test.ts` / `worker.test.ts` (optional; resource preflight first) | nothing | – | WSL | A-5 | §5.1 |
| A-8 | One Codex image run (24c-style, HUMAN-021b's v1 command) | plan quota | – | WSL | A-6 shows A and B `OPEN` with answered keepalives | V-4 |
| A-9 | Contingency, only if AppArmor is active and pasta is denied: complain mode → add `/run/netns/srjail r,` to the profile, or disable the pasta profile (back to today's unconfined state) | AppArmor config | yes | WSL | A-5 fails on AppArmor | §4.3 |
| A-10 | Maintenance owner and cadence for the hand-installed package (§6.3) | process | yes | process | A-5 | §6.3 |
| A-11 | Optional: ask Ubuntu for a noble SRU (external post) | external | – | external | any time | §7 |
| A-12a | Only if a worker timer is enabled and W-0 finds no window: hold `cycle.sh`'s lock for the window | nothing (a cycle ends with `CYCLE_LOCKED`) | yes (release) | WSL | A-4 | L-1 |
| A-12b | Only if A-12a is not acceptable: disable the worker timer for the window, then enable it again | the timer | yes | WSL | A-4 | §5.0 (`design-worker-cycle.md`) |

## 9. Confirmed vs inferred

| claim | status | evidence |
|---|---|---|
| installed passt `1e6f92b` lacks the keep-alive ACK, and sends no FIN or RST for one either | CONFIRMED | 24a; `git merge-base --is-ancestor 1e6f92b 238c69f`; the `238c69f` diff; `1e6f92b` `tcp.c` `tcp_data_from_tap()` / `tcp_send_flag()` (DEV-087) |
| the keep-alive cut on the jail path is caused by pasta | **strongly supported** (24b: A 27 s, B 57 s, C open in the jail; all open on the host) | `design-image-poc.md` "24b result" |
| 24b's `EOF` is the kernel's `ETIMEDOUT` abort as Python 3.12 reports it | CONFIRMED that Python 3.12.3 + OpenSSL 3.0.13 report it so (local test, CPython source, gh-115627); LIKELY that this is what happened (the errno itself was not printed) | `design-image-poc.md` "24b result"; 24b-v2 would print it |
| the ~156 s image failures have the same cause | INFERRED, **not proven** (idle GET vs a POST waiting for its response) | A-8 |
| noble has no newer passt in any pocket | CONFIRMED (2026-10-22) | Launchpad `getPublishedSources` |
| resolute deb's signature chain and hashes | CONFIRMED | gpgv + Release/Packages/deb SHA256 checked here |
| resolute deb installs on noble (libc6 ≥ 2.38 only, no symbol newer than GLIBC_2.38) | CONFIRMED (static) / install not run | `dpkg-deb -f`, `objdump -T` |
| jail flags keep their meaning, except `--dns-forward` gaining TCP and 853 | CONFIRMED (man page + `conf.c`/`fwd.c` at both commits) | §4.2 |
| `/usr/bin/pasta` is unconfined by AppArmor today | CONFIRMED (package contents) | no `usr.bin.pasta` in noble's deb |
| AppArmor inactive on this WSL kernel | INFERRED | `config-wsl` LSM order; V-0 checks |
| resolute's pasta profile would deny `/run/netns/srjail` | INFERRED (profile text) | §4.3; A-9 |
| `prohibit` gives `EACCES` for UDP `sendto` | CONFIRMED from the kernel source (v6.18 `fib_rules.c`, `udp.c`); not run on the WSL kernel | §4.6; D-3 runs it |
| 386b5f5 has no option to limit DNS forwarding to port 53 | CONFIRMED (`passt.1`, `conf.c` option table, `fwd.c` `is_dns_flow`) | §4.6 |
| no noble package depends on passt (podman recommends it, libvirt's qemu driver suggests it) | CONFIRMED (noble + noble-updates `Packages`, 2026-10-22) | §3.1 |
| `--netns <path>` creates no user namespace in either version | CONFIRMED (`conf.c`, `isolation.c`) | §4.2 |
| no worker timer is enabled on the WSL machine | per the records (HUMAN-010 on hold); UNVERIFIED on the machine | W-0 checks it |
| the update makes 24b's A `OPEN` | INFERRED | the `238c69f` diff; V-3b / A-6 measure it with 24b-v2 |
| pasta's capability / seccomp state unchanged after the update | UNVERIFIED | V-0 vs V-3a `/proc/<pid>/status` (S-1) |

## 10. Sources

- passt git: <https://passt.top/passt/> (commits [`238c69f`](https://passt.top/passt/commit/?id=238c69f9af458e41dea5ad8c988dbf65b05b5172),
  [`472e2e9`](https://passt.top/passt/commit/?id=472e2e930f6e17d9d8664d6cf44c47af1db58bb3),
  [`aa809d3`](https://passt.top/passt/commit/?id=aa809d31827638c09a08671800c4053d3d0ab5ed),
  [`becf81a`](https://passt.top/passt/commit/?id=becf81a), [`5da0316`](https://passt.top/passt/commit/?id=5da0316));
  [tags](https://passt.top/passt/refs/tags); [keep-alive log](https://passt.top/passt/log/?qt=grep&q=keep-alive);
  report: [containers/podman discussion 24572](https://github.com/containers/podman/discussions/24572);
  unofficial builds: <https://passt.top/builds/latest/x86_64/>.
- Ubuntu: [Launchpad passt source package](https://launchpad.net/ubuntu/+source/passt) (publishing history via the
  Launchpad API); [bug 2077158](https://bugs.launchpad.net/ubuntu/+source/passt/+bug/2077158) (pasta profile missing);
  [bug 2165739](https://bugs.launchpad.net/ubuntu/+source/passt/+bug/2165739) (no local overrides);
  archive `dists/{noble,resolute}/InRelease` and `universe/binary-amd64/Packages.xz`;
  [Ubuntu CVE tracker](https://ubuntu.com/security/cves?package=passt).
- Debian: [tracker](https://tracker.debian.org/pkg/passt), madison (`api.ftp-master.debian.org`),
  [security tracker](https://security-tracker.debian.org/tracker/source-package/passt),
  [trixie `+deb13u1` changelog](https://metadata.ftp-master.debian.org/changelogs//main/p/passt/passt_0.0~git20250503.587980c-2+deb13u1_changelog).
- WSL kernel config: [microsoft/WSL2-Linux-Kernel `linux-msft-wsl-6.18.y` `arch/x86/configs/config-wsl`](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.18.y/arch/x86/configs/config-wsl).
- systemd v255: `src/run/run.c` (`--expand-environment` default), `src/basic/env-util.c` (`replace_env_full`, `replace_env_argv`),
  `src/core/dbus-execute.c` (`UNIT_ESCAPE_SPECIFIERS`), `man/systemd-run.xml`.
- This repository: `scripts/sales-design-capture/admin.sh:100-106, :144-228, :248-254, :455-466`; `scripts/sales-design-capture/jail/jail.properties:47-67`;
  `scripts/sales-design-capture/jail/probe.py:240-280`; `scripts/sales-design-worker/cycle.sh` (lock, `CHECK_UNIT_*`);
  `scripts/sales-design-worker/systemd/sr-design-cycle.{service,timer}`; `tests/unit/design-agent/jail.test.ts`;
  `docs/operations/design-wsl-isolation.md` §2, §5, §6; `docs/operations/design-worker-cycle.md`.
- DEV-087 additions: passt `1e6f92b` `tcp.c` (:1573, :2249-2440, :2736-2790), `udp.c:856-858`; passt `386b5f5` `fwd.c:850-859`,
  `passt.1:262-276`, `conf.c` (option table, :2122-2128), `isolation.c:180-290`, `tcp.c:1885-1905`, `udp_flow.c:20`; commits
  `a3d142a`, `5024908`, `ff63ac9`. Linux v6.18 `net/ipv4/tcp_timer.c` (`tcp_keepalive_timer`, `tcp_write_err`),
  `net/ipv4/fib_rules.c` (:126-127, :180-212), `net/ipv4/udp.c` (:1443-1456). CPython `v3.12.3` and `v3.13.0`
  `Modules/_ssl.c` (`PySSL_SetError`, `_ssl__SSLSocket_read_impl`); the [3.13 changelog](https://docs.python.org/3.13/whatsnew/changelog.html)
  (gh-115627, 3.13.0a6) and the [3.12 changelog](https://docs.python.org/3.12/whatsnew/changelog.html) (no gh-115627; gh-127257 in 3.12.9).
  noble / noble-updates `main` and `universe` `binary-amd64/Packages.xz` (reverse dependencies).
