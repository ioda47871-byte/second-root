# DEV-028 local design worker — fresh review

- 対象: `a063702..4118533`（worker の実装、run.sh、runbook、テスト）
- 方法: 実装と文脈を共有しない独立 agent。Playwright 1.62.1 で実際に試して確認した（popup、CSP、shadow DOM、redirect、短いグリッド）
- 結果: High 1 / Medium 5 / Low 7。すべて修正した。ただし「同じ id が failed/ と done/ の両方に入る」と「遅れた遷移の理由表示」の 2 件は、結果が正しいので記録だけにした

| # | 重さ | 指摘 | 対応 |
|---|---|---|---|
| H1 | High | ネットワーク失敗・5xx・予期しない browser の失敗まで `PUBLIC_SOURCE_UNAVAILABLE`（done）になり、job が二度と試されない。短いページでは grid-lower の clip が外れ、撮れた 2 枚まで失う | 確定の答え（ログイン壁・challenge・rate limit・非公開/無い・Instagram 外・空）だけを `PUBLIC_SOURCE_UNAVAILABLE` にした。一時的な失敗は `SOURCE_CAPTURE_FAILED` として ledger で 1 回やり直す。clip はページの高さで切り詰め、3 枚目の失敗は無視する。テスト: 5xx、接続拒否、短いグリッド |
| M1 | Medium | `window.open` の popup で `request.frame()` が throw し、worker が落ちる | frame が無い遷移は popup として黙って止める。route handler 全体を catch する。テスト: popup |
| M2 | Medium | report.json を書いた後に失敗すると、catch が run directory を消す | report.json がある run directory は消さない。done への移動だけをやり直す |
| M3 | Medium | CSS の blur が class の背景画像・SVG image・shadow DOM に届かない。CSP で style が止まりうる。確認もしない | `bypassCSP`。加えて、撮った PNG の中ですべての media の矩形（shadow DOM を含む）を 1/10 に縮めて blur をかけて戻す。テスト: 縞模様の画像 3 種のコントラストが消えることを画素で確認 |
| M4 | Medium | Codex CLI の session log（`$CODEX_HOME/sessions/.../rollout-*.jsonl`）に参考画像が残りうる | 呼び出しごとに、その thread id の session log だけを消す。テスト: 偽の CLI が書いた log が消え、他の log は残る |
| M5 | Medium | brief のやり直しが最初の timeout を使い回して時間を超えうる。signal・watchdog で止まると job が stale として 1 回に数えられる | 呼び出しごとに残り時間を読み直す。signal・watchdog では作業中の job を inbox に戻し、回数に数えない |
| L | Low | 空の lock ファイルで 3 時間止まる | 読めない lock は 1 分で古いとみなす（テストあり）。JSON の読み違いで lock・claim・marker の読み取りが throw していた不具合も直した（テスト: 壊れた claim） |
| L | Low | 死んだ worker の一時ディレクトリが 6 時間残る（browser cache に元の画像） | 持ち主が死んでいればすぐ消す（テストあり） |
| L | Low | 呼び出し側の環境変数で run.sh の環境の掃除を飛ばせる | 再起動の目印を引数にした（テストあり） |
| L | Low | Windows 側の symlink を辿って書く | コピー先と中のファイルが link なら `windows_copy: failed`（テストあり） |
| L | Low | report の revisions が少なく出る。category default のときに Codex の低い confidence が見えない | pipeline が数えた `revisions` と `brief_confidence` を report に出す（テストあり） |
| L | Low | 同じ id の superseded が failed/ に残る | 記録のみ（inbox に新しい同じ id があるときだけ起き、新しい方が処理される） |
| L | Low | 遅れた script 遷移が OFF_SITE ではなく EMPTY_PAGE と出る | 記録のみ（結果は同じ `PUBLIC_SOURCE_UNAVAILABLE`） |

レビュー中に見つけた flaky: 負荷の高いときに mock への `route.fetch` がすぐ失敗した（keep-alive の接続を相手が閉じた直後）。fetch を 1 回だけやり直すようにし、design-agent のテストを 4 回続けて全件 PASS にした。

検証: unit 472 件 PASS、lint・typecheck PASS、run.sh の実ファイルのテスト PASS。本番の build → next start → 撮影の経路は container で確認した。

## 修正の再確認（58cac66）

- H1〜M5 と Low の修正は reviewer が実際に試して確認した
- **新しい High**: `mediaRects` の page callback の中の名前付き関数を、tsx（keepNames）が `__name()` で包む。その helper はページに無いので、本番（run.sh → tsx）では取得が毎回 CAPTURE_ERROR になっていた
  - vitest の変換では起きないため、テストでは見えなかった
  - 対応: page callback の中に名前付き関数を置かない（stack を使うループにした）
  - 回帰テストを追加した: worker 1 件を tsx の子 process で端から端まで動かす
  - 修正前のコードでは、このテストが落ちることを確かめた
- Low の追加対応
  - 予期しない crash と watchdog: job を processing に残し、recovery が回数に数える。いつも run を壊す job も failed/ に行く。人や systemd の signal だけは数えずに inbox へ戻す
  - `abandonActiveJobSync` は、inbox に同じ id の新しい job があれば上書きしない
  - signal で途中止めになった Codex の session log: 起動時に消す。対象は、1 行目の cwd が design agent の一時ディレクトリを指すものだけ。他の Codex session には触らない（テストあり）
  - lock の引き取りの race（rm → wx）は run.sh の flock で直列化されるので、記録だけにした

## 最終確認（11f75bd）

- 確認して問題なし: tsx での取得（通常のページ・popup・iframe）、他の page callback、signal・crash の扱い、inbox の上書き防止
- Low 1 件を修正した: session log の片付けが 1 行目全体に正規表現を当てていたため、指示文に worker のパスが書かれた無関係な session まで消しうる。1 行目を JSON として読み、`cwd` のパスの要素だけを見るようにした（テストあり）
- 最終判定: **PASS**。Critical・High・Medium は 0 件。残りは記録だけの Low 3 件（superseded、遅れた遷移の理由表示、flock で直列化される lock の race）

## schema の fallback（実走前 preflight の指摘）

- preflight で見つけたこと: strict schema は `maxLength` などを含む。loose への fallback は brief にしか無かった。API が strict を拒むと review が毎回失敗し、run は必ず fallback_template で終わる
- 修正: 各 job は strict から始める。CODEX_EXEC_FAILED / CODEX_NO_JSON のときだけ、その呼び出しを loose で 1 回だけ送り直し、その job の残り（brief / review）は最初から loose を使う
  - その他の失敗（timeout・quota・サインイン）では送り直さない
  - 答えは完全な zod schema と palette の検査で従来どおり検証する
  - report には `codex.schema_mode` と `SCHEMA_LOOSE_AFTER_<BRIEF|REVIEW>_<code>` だけを残す
- テスト（偽の Codex が、受け取った schema が strict か loose かを記録する）
  - strict の brief が失敗 → loose の brief → loose の review
  - strict の review が失敗 → loose の review → 2 回目の review は最初から loose
  - loose でも失敗 → 従来どおり fallback（brief / review それぞれ）
  - loose の答えも palette と余分な項目で弾く
  - quota では送り直さない
  - strict が通れば最後まで strict

## Business Discovery PoC（meta-check）の fresh review

- 対象: b7b0642。独立した agent が注入した `fetchImpl` で実際に試した
- Medium 1 件（修正済み）
  - HTTP 200 で本文が error（期限切れの token・rate limit）や proxy の HTML だった場合に、TARGET_UNSUPPORTED と判定していた
  - 対応: error 本文と JSON でない本文は数値で分類する。`business_discovery` が無い 200 は META_UNKNOWN_ERROR にする（テストあり）
- Low 3 件（修正済み）
  - token のディレクトリの所有者・種類を検査していなかった → 検査する
  - link を辿ると token の置き場所が repo の中を指せた → realpath で比べる
  - `lstat` から読むまでの間に差し替えられうる → O_NOFOLLOW で開き、開いた handle の stat で検査する
  - 応答の大きさの上限が読み終えた後にかかっていた → 読む途中で打ち切る
  - 文書に SECRET_FILE_UNSAFE / META_UNKNOWN_ERROR が無かった → 追加
- 確認済みで問題なし
  - token は Authorization header だけ・redirect で失敗・timeout・appsecret_proof・出力の許可リスト・username の注入不可・テスト用の注入口を CLI から使えないこと・Messaging のコードに触れていないこと・文書の保存手順

## 専用ブラウザ profile の PoC（login / capture）の fresh review

- 対象: ba2fd1d。独立 agent が実際に動かして確かめた
- Medium 3 件（修正済み）
  1. profile の検査が link を辿っていた（Node 22 の `readdir` recursive は link 先のディレクトリにも入る。`/` への link で木の外を歩き、止まらない）
     - 対応: 自前で歩く。link には入らず、数えながら上限で止まる
     - テスト: `/` への link で 5 秒以内に拒否する
  2. アカウント部分を隠す処理が、bio や profile 全体を隠しうる
     - 「おすすめ」を含む bio にも反応していた
     - main を包む sticky の要素まで隠していた
     - 対応: 「おすすめ」はセクションの題名と完全一致したときだけ扱う。header や投稿を含む要素は決して隠さない。main を包む要素は除く
     - テスト: 和文の bio、sticky で包まれた main
  3. 画面表示の変数（DISPLAY など）が、共有の子 process 環境を通じて Codex にも渡っていた
     - 対応: ログインの窓にだけ渡す
     - テスト: 共有環境には入らないこと
- Low（修正済み）
  - 親ディレクトリがまだ無いとき、リンクを解決しない path で検査していた → 存在する最も近い祖先を解決して検査し、作成後にもう一度検査する（テストあり）
  - サインイン済みの判定が弱かった（未ログインでも出る `/explore/` を含んでいた）→ サインイン済みにしか無い要素だけにし、定義を 1 か所にまとめた
  - main が無いと切り出しができない → EMPTY_PAGE で止める（テストあり）
  - 例外が出たときに空の撮影フォルダが残った → 消す
  - テストの穴: profile の session が次の起動に残ることを確かめるテストを追加した
- **残る未検証**: 表示ありのログインで書いた session を、表示なし（`channel: "chromium"`）の撮影で読めるか。この環境には画面が無いため試せない。人の WSL での初回実走で確かめる
- 再確認（f02ac38）: **PASS**（Critical / High / Medium は 0 件）。残っていた Low 2 件も直した
  - 「おすすめ」だけの語が bio の中にあると bio の塊を隠しうる → header の中の要素は対象にしない（テストあり）
  - profile の中に読めないフォルダがあると、中を検査せずに飛ばしていた → PROFILE_UNSAFE_ENTRY で止める

## Browser diagnose (PRIVATE_OR_MISSING split) — independent review 2026-09-30

No Critical findings. Output of every path is fixed codes only; no click / input / scroll / cookie read / screenshot; the capture guard is unchanged apart from the added `detail`.

- H1 (fixed): A/B did not follow same-site redirects like capture's `open()`, so a redirect looked like a broken page. Now followed hop by hop in a fresh tab (max 4).
- H2 (fixed): the session check waited once for ≤3 s and did not follow redirects. Now follows them and polls for the signed-in navigation for up to 15 s.
- M1 (fixed): C now also stops at the first off-site main-frame request (redirect hops included), not only after the page has committed.
- M2 (fixed): C closes every page it did not open itself (noopener popups included). Without interception, a popup's first request cannot be held back (documented).
- M3 (fixed): the `report.json` key list documents `instagram.detail`.
- L2/L3/L4/L6/L7 (fixed): `about:*` is ignored; codes read while the page is leaving are not printed; a 5 s sample was added (capture's judge time); DIAGNOSE_FAILED when every run fails; the CLI prints only BROWSER_TOOL_FAILED on a stray error.
- L1 (kept): logs print the detail in place of the reason, as the requested format `PUBLIC_SOURCE_UNAVAILABLE (HTTP_404)` asks; `report.json` keeps both.
- L8 (documented): the settings shared with capture (service workers, CSP, viewport, locale) remain suspects when every mode fails.

## Navigation guard without fetch/fulfill — independent review 2026-09-30

Real diagnose run: A (headless+guard) and B (headed+guard) saw "page unavailable", C (no interception) saw the profile, session OK. Cause: `route.fetch()` re-sent the page request without the browser's own `sec-fetch-*` / `accept-language`. Fixture check: `route.continue()` alone never sees redirect hops (an off-site redirect reached its destination), so the guard now pauses document requests in Chromium (CDP Fetch, request stage) and continues them unchanged.

Review of 331006e (no Critical):
- H1 (fixed): frames Chromium runs in another process (a sandboxed same-site iframe) were not guarded; their navigations, redirect hops, nested frames and form posts reached off-site hosts. Now every such frame target (nested ones too) is auto-attached and held at start until the same document check is on (tests: 4 sandboxed-frame cases, which fail on 331006e).
- M2 (partly fixed / documented): Chromium's own preloading (speculation-rules prefetch, link prefetch/prerender) is not visible to page-level interception, and the feature flags tried did not turn it off. Prerendering is disallowed per page, and a main frame that commits off the site ends the capture (fail closed). The preloading requests themselves are documented as outside the guard, like subresources.
- L3 (unchanged by design): subresources are not guarded.
- L4 (fixed): tests added for meta refresh, form submit, `top.location` from a frame, popup with an opener, the redirect-hop limit, and sandboxed frames.
- L5 (mitigated): if the main frame id ever changed, off-site hops still fail in every frame, the commit backstop catches an off-site main frame, and `assertPublicPage` still catches a login/challenge page by its URL.

Re-review of 2e910c3: no Critical/High/Medium. Nothing reached the off-site host in any case tried (sandboxed and cross-site frames, three levels of nesting, frames that navigate at once, popups from frames, top navigation from a sandboxed frame). Chromium holds a new frame target until our session also releases it.
- L1 (fixed): a frame target now starts only after it has *answered* that its document requests are paused (before, the message being handed over was enough); if it refuses, it stays held. Dedicated workers, which load no document, are released at once (test added).
- L2 (documented): preloading and subresources are outside the guard.

## Phase 3 — Codex isolation, capture helper, visual sources (2026-10-01)

Two independent reviews (security; architecture / reliability) of 8d28f10..bb58b7a, both re-reviewed on 22deca0, then the remaining Mediums fixed.

Round 1, fixed in 22deca0:
- Architecture C1: run.sh's .env check matched the tracked `.env.local.example`, so the helper never ran. C2: result dirs lost setgid, so the requester could not read results. A real-user round-trip test now covers C2 and fails on the old code.
- Architecture H1–H4: WSL `resolv.conf` link inside the sandbox; a pinned system node for the helper; the helper wait capped by the run deadline; a new request id per attempt.
- Architecture M1–M5: the helper loops until the spool is empty, with a 2-minute timer; wall backoff; 8 MB cap; website robustness; retry semantics.
- Security H1: recursive `rm` in `requests/` let a symlink race delete the helper's files. Removal is now non-recursive (unlink / rmdir). Re-tested: 37,570 runs under a continuous swap race, 0 deletions.
- Security M1: one odd entry stopped the helper. Each entry is now handled separately.
- Security M2: approval now shows the whole-tree diff and needs the commit typed; `npm ci --ignore-scripts`.
- Security M3: login refuses while requester processes run.
- Security M4: SSRF host check on every request.
- Security M5: `/run` hidden in the sandbox.
- Lows: redaction, narrower binds, `O_NOFOLLOW` on `answer.json`, Instagram path allowlist.

Round 2, fixed after 22deca0:
- Security M1: WebSockets bypassed the host check. They are now blocked in website capture (test added).
- Security M2: IPv4-mapped / NAT64 IPv6 passed as public. Now checked with `net.BlockList` per address family (tests added).
- Security M3: login checked the requester only once. It now watches for the whole login and kills the window if a requester process appears. Install denies cron / at / linger for the requester; a requester in the docker group is refused.
- Security M4: the node pin did not check ownership. node and npm must now be root-owned and not writable by others up to `/`.
- Security L: answers containing any 12-character window of Codex's own auth tokens (split, separated or reversed) are rejected (test added). Shared-platform subdomains are not allowed.
- Architecture M1: a website-only job now retries a transient failure, and `instagram` is null when there is no Instagram source (test added).
- Architecture M2: login and helper now share one `browser.lock` state directory, and login pauses the helper units.

Documented residuals:
- network shared with Codex (Codex's inner sandbox blocks local sockets);
- DNS rebinding window on website capture;
- headed login on the shared X display (no private display);
- cert files in the home are not passed to Codex;
- npm-global Codex only;
- a dedicated `CODEX_HOME` is recommended.

Container end to end on real users:
- `admin.sh install` created the users, groups and spool with the right modes, cloned the repo and ran `npm ci --ignore-scripts`. The Chromium download is blocked by this container's network policy.
- `run.sh` answered a request from the requester user, and the requester read the result.
- `admin.sh login` refused while a requester process ran.

Round 3 (on 2bc6452), fixed next:
- Security C1: with WSL interop on (the WSL default), any WSL user can run `wsl.exe -u root`. Fixed with a new `scripts/sales-design-capture/host-check.sh`.
  - `admin.sh install` and `login` refuse unless `/etc/wsl.conf` has `[interop] enabled=false` and `appendWindowsPath=false`, and interop is off at runtime (`binfmt_misc/WSLInterop`).
  - They also refuse when the requester is the WSL default user (uid 1000, or `[user] default`), or when it can write a Windows drive root or a Startup folder. `/mnt/sr-export` is allowed as a single export folder.
  - `run.sh` re-checks interop and the requester's groups on every run. If either fails, every request gets `HELPER_ERROR` and the profile is never opened.
  - Tests: `host-check.test.ts`, plus a `hostUnsafe` case in the helper tests.
- Security H1: the requester was not checked for root, admin-equivalent groups (sudo, admin, wheel, adm, lxd, disk, docker, libvirt, kvm, shadow, systemd-journal, the helper's group) or sudo rules (`sudo -l -U`). It now is, and is refused.
- Security H2: a WebSocket or fetch from a Web Worker got past `routeWebSocket` and the route host check, and WebRTC STUN reached loopback over UDP. Fixed with an in-process egress proxy (`worker/egress-proxy.ts`).
  - Website capture now sends every request through it: page, frames and workers, with `<-loopback>`.
  - The proxy resolves each host itself, accepts only ports 80 and 443 where every address is public, and connects to the address it checked. This also closes the DNS-rebinding residual.
  - The browser starts with `--webrtc-ip-handling-policy=disable_non_proxied_udp --force-webrtc-ip-handling-policy --disable-quic`.
  - Test: a Web Worker WebSocket/fetch to localhost plus STUN to a local UDP socket. Without the fix it reached localhost and sent 3 packets; with it, nothing.
- Self-found High: the install docs ran `sudo bash scripts/…/admin.sh` from `~/work/second-root`, which the requester can write, so root would run code Claude can change. `admin.sh` now refuses unless it and `host-check.sh` are owned by root or the helper, with no group or other write anywhere up the path. Install is now done from a root-only clone (`/root/sr-capture-admin`).
- Security M1 / Architecture M: `admin.sh login` on Ctrl-C left the window open and the units stopped. Fixed with an EXIT trap: kill the helper's processes, restart the units; INT/TERM/HUP exit 130.
  - The exit code is now the login's own, or 3 when aborted, and login also stops a running `sr-capture.service`.
  - Checked in the container: SIGINT killed the helper's processes, the units restarted, rc=130.
  - The linger conflict is documented: the worker timer runs as a system unit and is stopped during login.
  - Polling (up to 0.5 s) remains a documented residual; a private display is not done yet.
- Lows:
  - `leaksTokens` now compares in lowercase and ignores timestamp strings (`last_refresh`).
  - The `NODE_MISSING` message now explains the tarball owner case.
  - The 198.18/15 fake-IP DNS case is documented.

Round 4 (on eab553d): no Critical or High from either reviewer. The security reviewer re-attacked the egress proxy and nothing got through:
- raw `CONNECT` to `0x7f.1`, `127.1`, `[::ffff:7f00:1]`, `localtest.me`, and octal or decimal hosts;
- `Host`-header mismatch, `sendBeacon`, prefetch, WebTransport, and a WebSocket or `fetch` from a Web Worker;
- mixed public/private DNS answers.

The Mediums were fixed next:
- Security M-a: a running requester process keeps its old supplementary groups after `gpasswd -d`. `host-check.sh` now scans `/proc/*/status` and refuses with `REQUESTER_PROCESS_PRIVILEGED`. In the container, a process started while in `adm` was still caught after the removal, and the check passed again once it ended.
- Security M-b: `wsl.conf` parsing is stricter. Only the exact `[interop]` / key spelling counts, and every spelling must say `false`. A world-writable `/run/WSL/*_interop` socket also refuses (as root, so does one the requester can write). The docs add a real-machine check.
- Security M-c: the `/mnt/sr-export` exemption now depends on the mounted source. It must be a plain folder at least three levels deep, not a drive, a user profile, `AppData`, `ProgramData` or `Windows`.
- Architecture M1: stock WSL shows `/mnt/c` as 777. The check is correct, so the docs now require `[automount] options="uid=1000,gid=1000,umask=077"`.
- Architecture M2: the egress proxy dials directly and ignores the worker's `HTTPS_PROXY`. Kept that way to preserve the checked-address guarantee, and documented.
- Architecture M3: the proxy's connection cap went from 64 to 256.

Lows fixed:
- next-address fallback;
- failed DNS lookups no longer cached;
- hop-by-hop headers removed from responses;
- `incus` groups added;
- primary-group members of `sr-capture` checked in `run.sh`;
- a `CONNECT` tunnel test added.

Documented residuals:
- the per-run check window;
- `hidepid`;
- SIGKILL of `admin.sh`;
- the local open proxy (public 80/443 only).

CI on eab553d caught a real gap: Playwright's default headless shell ignores `--webrtc-ip-handling-policy`, so STUN UDP went out. Fix, in 73cd096 (whose `RetryReason` type error is fixed in the next commit):
- The website capture now launches the full Chromium (`channel: "chromium"`).
- `webrtcSealed()` runs before any shop page opens: a STUN probe against a UDP socket of the worker's own. One packet stops the capture (`BROWSER_WEBRTC_OPEN`), whatever the build.
- Test: a launcher that drops the flags makes the capture stop before the site is opened.

Round 5 (on dcb6aa2): the security reviewer found no Critical or High issues and confirmed every round-4 Medium fixed. They tested with real users the process-group scan, user namespaces, a non-root scanner, `dial()` reaching only checked IPs, and UNC/`\\?\` export sources.
- Medium, "once privileged, always privileged": documented as a requirement. The requester must be a fresh user that never held an admin group or sudo; otherwise create a new requester (ideally a new distro).
- Lows fixed:
  - `[interop] # comment` headers now count;
  - the export source must be `X:\Users\<name>\<folder>…` with no `..` or `~` (8.3 names);
  - `hidepid` on `/proc` makes `run.sh` refuse (`PROC_HIDDEN`);
  - the WSL2 vsock reachability is listed as unverified.

## WSL isolation redesign (2026-10-01, after the real-machine check)

What the human found on the real machine (WSL 2.7.14.0, kernel 6.18.33.2-2, Ubuntu 24.04):
- With `[interop] enabled=false`, no binfmt entry, and `cmd.exe` denied to the requester, `/run/WSL/1_interop -> 2_interop` still survives `wsl --shutdown`.
- `2_interop` is `srwxrwxrwx root:root`, so the requester can connect to it. Through it, any Linux process reaches Windows as the Windows user, and from there `wsl.exe -u root`.
- Microsoft does not treat `enabled=false` as a security boundary. **A separate Linux user is therefore no boundary in WSL2.**

New design: the requester jail (`docs/operations/design-wsl-isolation.md`). Every process of `sr-designgen` runs only in `sr-jail-*.service` units.
- **Settings:** `scripts/sales-design-capture/jail/jail.properties` holds one shared list.
  - What it hides: `/run` and `/mnt` (empty tmpfs), `/srv` except the spool, `/usr/lib/wsl`, `/init`, `PrivateDevices`.
  - What the kernel refuses: `AF_VSOCK` (`RestrictAddressFamilies`); io_uring and syslog (EPERM); private, link-local and gateway addresses (`IPAddressDeny`, cgroup BPF).
  - Other: `ProtectProc=invisible`, `NoNewPrivileges`.
- **Fail-closed probe:** `jail/probe.py` runs as `ExecStartPre` inside the same sandbox and stops the unit on any doubt. It checks:
  - the WSL paths, the display, `/proc`, other homes, vsock, io_uring;
  - private/gateway addresses via UDP sends, which must return EPERM;
  - every listening abstract Unix socket, by connecting to it;
  - that no browser profile is left in the requester's own home.
- **admin.sh:**
  - New commands: `jail-install`, `jail-check`, `shell` (a jailed interactive shell), `run`, `claude-start` and `claude-stop`.
  - The requester's login shell becomes nologin. The default gateway is added to the deny list.
  - `login` stops the jail units first.
- **host-check.sh:**
  - New check: every requester process's cgroup must be `/system.slice/sr-jail-*.service`, and the login shell must be nologin. Only root can put a process into those cgroups.
  - The interop-socket mode check is dropped: on WSL 2.7.14 the socket is always 0777, and the jail is the boundary.

Evidence: systemd 255 (the version Ubuntu 24.04 ships) ran as PID 1 inside the container, with the WSL state recreated as fixtures (a 0777 `/run/WSL` socket, `/mnt/c`, `/mnt/wslg`, `/usr/lib/wsl`).

| Check | Outside the jail (same user) | Inside the jail |
|---|---|---|
| Interop socket | reachable | absent |
| `AF_VSOCK` socket | allowed | `EAFNOSUPPORT` |
| io_uring | allowed | `EPERM` |
| UDP to private / gateway addresses | sent | `EPERM` |
| Probe result | 13 `JAIL_UNSAFE` codes | `JAIL_OK` |

- A whole-filesystem walk inside the jail found no connectable socket, no `/proc` path out and no extra socket family.
- An abstract socket left listening outside the jail made `jail-check` fail with `ABSTRACT_SOCKET_REACHABLE`.
- Inside the jail, `sandbox.test.ts` (the real bubblewrap attacker) and `worker.test.ts` (Chromium) passed: 73/73.
- `jail-install` → `claude-start`: the processes run in the `sr-jail-claude.service` cgroup. A process started outside the jail gives `REQUESTER_OUTSIDE_JAIL`. `claude-stop` worked.

Found along the way:
- `ProtectKernelTunables`, `ProtectKernelLogs` and `ProtectHostname` overmount `/proc`, and then bubblewrap cannot mount a fresh `/proc`. They are dropped (what they guard needs root anyway), and syslog is denied by the system-call filter instead.
- A TCP SYN dropped by `IPAddressDeny` only times out, so the probe uses UDP.
- tmux needs `SHELL=/bin/bash` once the login shell is nologin.
- In the container, the default gateway (192.0.2.1) is outside the private ranges. `admin.sh` therefore always adds the current gateway to the deny list.

Options compared, in the design doc:
- A. Separate Linux user only: does not hold.
- B. Jail: adopted.
- C. Claude in a separate Hyper-V VM: the next step if the probe fails on the real machine.
- D. Profile on another machine.
- E. No signed-in profile at all.

Round 1 of the jail review (on 24a1788). Both reviews found no Critical. They agreed on one point: architecture rated it H1 and security M1.

- **Fixed — the jail shared the WSL VM's network namespace.**
  - Problem: abstract Unix sockets (WSLg's X server, systemd's buses, multipathd on CI) and localhost services of other users or distros were reachable from the jail. The probe would likely stop on WSLg, and the probe only checks at start.
  - Fix: the jail now has its own network namespace (`sr-jail-net.service`). It is created by root, and pasta runs as root as the only way out, with no port forwarding in either direction and `--no-map-gw`.
  - Every jail unit has Requires, BindsTo and After on that unit. The probe compares `/proc/self/ns/net` with the namespace id root records in `/run/sr-jail/netns-id`.
  - Checked on systemd 255 as PID 1:
    - From inside the jail, a host loopback listener refused the connection and no abstract socket was visible at all.
    - Claude restarted into the new namespace after the network unit was re-created.
    - `sandbox.test.ts` and `worker.test.ts` passed 73/73 inside it.
- **Fixed — a fail-open hole found during this work.** `$(…)` does not inherit `set -e`, so a failing `jail_props` would have written a unit without the jail settings.
  - The settings are now fetched on their own first.
  - Unit and transient arguments are refused unless they contain `NoNewPrivileges` and the probe.
  - Both units are written only when they were fully put together.
- **Fixed — architecture Mediums:**
  - Claude restarts with `Restart=always`: tmux exits 0 when Claude ends. `claude-start` waits before it checks.
  - The probe warns with `JAIL_WARN DNS_NOT_WORKING`. dnsTunneling and cgroup v2 are documented as required.
  - The `login` restore trap is now set before the jail units are stopped.
  - The worker timer docs now run it through `admin.sh run`, inside the jail.
  - `/mnt/sr-export` is bound into the jail.
- **Fixed — Lows:**
  - `approve` re-runs `jail_install` from the approved checkout.
  - The doc order is fixed: the old profile is removed before install.
  - The verification commands use `admin.sh jail-check` and `admin.sh run`.
  - git credentials are set up inside `admin.sh shell`.
  - The jail test now accepts `JAIL_NOTE` and `JAIL_WARN` lines.
- **Documented — security M2:** user namespaces stay allowed in the jail, because Codex's bubblewrap needs them. A userns kernel privilege escalation defeats the boundary, and that is the main argument for option C.
- **Documented — security Lows:** `AF_NETLINK`, the exact-match cgroup regex, and the IPv6 filter not being exercised on IPv6-less hosts.

Round 2 of the jail review (26ae59b).
- **Architecture:** nothing Critical or High; three Mediums, below.
- **Security:** stopped after a static pass (a safety check kept cutting its output), so I ran its live questions myself, on systemd 255 as PID 1.

Fixed, verified live:
- **Hole found from security's static question: the WSL DNS tunnel address `10.255.255.254` was allowed on every port.** On WSL that address sits on the VM's loopback, so a host service listening on `0.0.0.0` answers there too.
  - Reproduced: from the jail, `10.255.255.254:9935` CONNECTED to a host `0.0.0.0:9935` listener.
  - Fix:
    - The jail's only DNS server is now `198.51.100.53`, a documentation address. pasta `--dns-forward` answers it on port 53 only, using the host's resolver.
    - `/etc/resolv.conf` in the jail is a root-written file.
    - The jail no longer allows `10.255.255.254`.
    - pasta's own unit refuses the private ranges except the DNS tunnel.
  - Re-test:
    - `10.255.255.254:9935` is refused (it times out).
    - With a fake DNS on `10.255.255.254:53`, `getent hosts example.org` inside the jail resolves through pasta.
- **Architecture M1/M2 — Claude stayed down after a pasta crash, or after a boot race.** `BindsTo` stops Claude, and neither the auto-restart nor a "dependency failed" start job brings it back.
  - Fix: the net unit's `ExecStartPost` starts Claude when it is enabled. Absolute `systemctl` path; `claude-stop` disables it.
  - Re-test:
    - `kill -9` of pasta: the net unit restarts, Claude comes back in the new namespace, and the namespace id matches.
    - After `claude-stop`: Claude stays inactive.
- **Architecture M3 — DNS.** The DNS path above is verified. The docs now say a systemd-resolved stub, or dnsTunneling off, is unsupported.
- **Netns rejoin.** From the jail, only the jail's own namespace is visible under `/proc/*/ns/net`, `/run/netns` is gone, and `setns` returns EPERM.
- **Lows:**
  - `jail_install` restarts the net unit, so a re-install or `approve` takes effect.
  - `run` sets `RuntimeMaxSec=3500` and gives each run a unique unit name.
  - Docs: the start-limit reset, `wsl --shutdown` after editing `.wslconfig`, and a checklist for the real machine.

Round 3 of the jail review (1616829).
- **Architecture — H1, fixed: the first install refused itself.** `host_safe` requires a nologin shell, but `jail_install` set it only later. Any Phase 2 requester process also made install fail.
  - Install now refuses with `REQUESTER_RUNNING` (and how to stop it) while a requester process exists, then sets nologin, then runs `host_safe`.
  - A test pins that order. The docs add `pkill -u sr-designgen` before install.
- **Architecture — Lows, fixed:**
  - `login` masks the Claude unit (runtime) for the sign-in, so a pasta crash cannot start Claude mid-login.
  - The probe allows `/run/resolvconf` (the place of a bound `resolv.conf`).
  - The docs cover: `approve` and `jail-install` restart the jail; `restart sr-jail-net` after a host DNS change; the DNS-over-TCP check on the real machine.
- **Verified by architecture:** `/etc/resolv.conf` as a link into a `TemporaryFileSystem` works on systemd 255; the DNS variants match the docs; the restart logic.
- **Found while chasing the flaky host-check test: a real decoding bug.** `printf %b` on `/proc/mounts` reads `\0` followed by up to three more digits, so `\040` followed by a digit (e.g. "My Drive 2") decoded wrong, and the Windows-drive check looked at the wrong path.
  - Fix: `sr_unoctal` decodes exactly three octal digits per escape. The test now uses a "space + digit" name.
- **Security, round 3:** an independent reviewer started; the platform's safeguards stopped it (as one did in round 2). Its live questions were run by hand in rounds 2–3 instead, as recorded above:
  - host-namespace listeners;
  - `10.255.255.254` on any port;
  - abstract sockets;
  - `setns`;
  - pasta crash recovery;
  - fail-open unit writing.

Static fail-open review (afb6722; read only). The main path fails closed: no unit is written without its settings, and the probe cannot print JAIL_OK after an exception. Findings, all fixed:

- **H1: `host_safe` ran `runuser -u <requester> -- test -w` outside the jail.** The jail shares the PID namespace, so with Yama `ptrace_scope` 0 a jailed process could ptrace that short-lived process and leave the jail.
  - The writability check is now done as root from owner and mode (`sr_may_write`); nothing runs as the requester outside the jail. A test proves `runuser` is never called.
  - The jail also refuses `ptrace` and `process_vm_readv`/`writev`. The probe checks this with `PTRACE_SEIZE` on its own child. Chromium and bwrap still pass 73/73 in the jail.
- **M1: `admin.sh run/shell/check` passed the command to systemd-run without `--`.** A command starting with `-p` could override jail settings. Every such call now has `--`.
- **M2: the sudo-rule check grepped a translated answer, and could hit SIGPIPE.** It now captures the answer under `LC_ALL=C`; anything but the exact "is not allowed to run sudo" counts as rules.
- **M3: a runtime mask loses to the unit file in /etc.** `login` now writes a runtime drop-in with `ConditionPathExists=/nonexistent/...`. Verified on systemd 255: the unit does not start while the drop-in is in place, and starts after it is removed.
- **M4: a unit file silently drops settings it cannot parse.** `jail_install` now runs `systemd-analyze verify` and checks the loaded unit's key properties one by one; on any mismatch it removes the unit and stops. The probe also checks that /usr, /etc and /var are not writable, and checks `/init`.
- **M5: `run.sh` missed `hidepid=4` and `ptraceable`.** Any hidepid other than 0/off is now PROC_HIDDEN.
- **M6: old crontab and queued at jobs, and ssh forwarding, could run requester code outside the jail.** Install now runs `crontab -r` and `atrm` on the requester's jobs and writes `DenyUsers` into sshd_config.d.
- **M7: root installed units and jail files from the helper's checkout.** The helper renders Instagram pages, so that checkout is not root-trusted.
  - `admin.sh` now runs only from the root-only clone `/root/sr-capture-admin`, at the approved commit and clean (`ROOT_CLONE_NOT_AT_SHA` otherwise). `trusted_path` accepts root-owned paths only.
  - Units and jail files are installed from that clone. `LOGIN_COMMAND` and the docs now point to it.
- **Lows:**
  - `stop_jail_units` handles the `●` marker on failed units.
  - Probe "unknown means fine" cases now fail: `/run`, `/home`, `/mnt`, the route table, vsock as constant 40.
  - Unknown users are refused in the sub-checks.
  - `restore` restarts the helper units only if they were active before.

Independent security review status: rounds 2 and 3 of the live-attack security review were cut short by the platform's safeguards. Their live questions were run by hand and are recorded above. This read-only fail-open review completed.

## Jail DNS is UDP-only (2026-10-02, real-machine finding)

**Real machine** (Ubuntu 24.04, `passt 0.0~git20240220.1e6f92b-1`, the only version in noble / noble-updates / noble-backports):
- Normal names resolve inside the jail.
- An explicit TCP connection to `198.51.100.53:53` times out.
- Cause: Noble's `--dns-forward` remaps UDP/53 only. TCP to that address is ordinary outbound traffic to the unroutable documentation address.
- The earlier docs were wrong: `getent ahosts github.com` was cited as proof of TCP fallback, but github.com's answer fits in UDP.

**Reproduced with the same passt**, using a fake resolver on 10.255.255.254 that answers both UDP and TCP:
- UDP is answered; TCP times out; the resolver's TCP side receives nothing.
- With a truncated (TC=1) UDP answer, `getaddrinfo` failed only after **134.3 s**: glibc's TCP connect has no short timeout.

**Security:** no new path. TCP to the documentation address never reaches the host. 10.255.255.254 was already denied by the jail, although the probe skipped checking it.

**Fix (A1, approved):**
- `sr-jail-net` adds, inside the jail's namespace only, right after the namespace is created and before pasta starts:
  `ip -n srjail rule add to 198.51.100.53/32 ipproto tcp prohibit priority 100`
- The jail's `resolv.conf` gets `options edns0`.
- The probe now fails closed on:
  - TCP to `198.51.100.53:53` not refused with `EACCES` within 1 s (`DNS_TCP_NOT_REFUSED` / `DNS_TCP_REFUSED_SLOWLY`);
  - 10.255.255.254 reachable over UDP or TCP (`DNS_TUNNEL_REACHABLE`; no longer skipped).
- The probe runs its `getaddrinfo` check only when every other check passed, so it cannot hang itself.
- `admin.sh jail-check` runs the probe as the unit's main command, because `systemd-run --pipe` drops `ExecStartPre` output and the person could not see the failing code.
- `admin.sh status` prints the namespace's rules.
- Not done, on purpose: no newer passt (other releases or self-built), no TCP DNS proxy or DNAT.

**Verified on systemd 255 as PID 1, with the real generated unit and `admin.sh jail-install` / `jail-check` / `run`:**
- `ip -n srjail rule show` and `ip rule show` inside the jail both show `100: from all to 198.51.100.53 ipproto tcp prohibit`.
- TCP to `198.51.100.53:53`: EACCES after 0.000 s (3 out of 3).
- Truncated answer: `getaddrinfo` fails after 0.004 s.
- UDP DNS query answered in 0.001 s; `getaddrinfo` in 0.003 s; the jail's `resolv.conf` reads `nameserver 198.51.100.53 | options edns0`.
- 10.255.255.254:53: UDP EPERM in 0.000 s; TCP SYN dropped (timeout); the resolver's TCP side saw 0 queries.
- Rule deleted by hand: `jail-check` → `JAIL_UNSAFE DNS_TCP_NOT_REFUSED` (2.8 s). `systemctl restart sr-jail-net` restores the rule and gives `JAIL_OK`.
- A self-introduced regression was caught by the unit tests before commit: a function-local `import time` shadowed the module import, so the probe would have answered `PROBE_ERROR` (fail-closed).
- Self-review tightening: the probe's TCP check on 10.255.255.254 now passes only on a timeout (SYN dropped) or EPERM/EACCES. A refusal from the far end means the packet got out, so it fails with `DNS_TUNNEL_NOT_FILTERED`.
- Final run with the final code (systemd 255 as PID 1, real generated units):
  - `jail-install` → `JAIL_OK`.
  - TCP to `198.51.100.53:53`: EACCES after 0.000 s (3 out of 3).
  - TCP to 10.255.255.254:53 times out; UDP to it gets EPERM.
  - UDP `getaddrinfo` succeeds in 0.006 s.
  - Truncated answer: `getaddrinfo` fails after 0.006 s.
  - Rule deleted: `JAIL_UNSAFE DNS_TCP_NOT_REFUSED` (rc=1, 2.8 s). After a restart: rule back, `JAIL_OK`.

## Renderer: visit address typography (2026-10-02, after the first real-shop run)

**Real-machine run (human, WSL, worker at a7818a8):** `jail-check` JAIL_OK; TCP to the jail resolver refused at once (EACCES, 0.0 s); UDP DNS resolves; the jail came back by itself after a full WSL shutdown. Job `phase3-001`: `visual_source=instagram_signed_in`, capture `CAPTURED`, brief, render, visual review of candidate-0: 18/25, `revise`, `needs_renderer_change=true`. The pipeline stopped as designed with `RENDERER_CHANGE_NEEDED` (`blocked`, revisions=0); the revised profile was not used. The review's note: the visit address is set on the display scale, and the street number breaks across lines. No shop data from that run is in this repository.

**Change (renderer only; approved by the human as the renderer extension the BLOCKED stop asks for):**
- `.addressValue` keeps the display face but has its own caps: `clamp(1.2rem, 4.4vw, 1.9rem)`, a single fact `clamp(1.4rem, 3vw, 2.4rem)` (both below the section heading), `font-weight: min(var(--display-weight), 600)`, no display width / tracking / uppercase. Before: up to 3rem / 4.2rem at the display weight (900 for `black`).
- `keepTogether()` (`components/demo/profile/text.ts`) splits a visit fact into segments; a run of digits joined by hyphens (ASCII or full-width, at most 20 characters: a street number, a phone number) is wrapped in `<span class="keep" data-keep>` with `white-space: nowrap`. The rest wraps as before (`overflow-wrap: anywhere` stays). The segments join back to the exact fact.
- Not changed: the profile schema and vocabulary (no new field: the cap is safe for every profile, so stored and default profiles stay valid and Codex's output schema is the same), the prompts, the 2-revision limit, `RENDERER_CHANGE_NEEDED` → BLOCKED.

**Tests:** `renderer.test.tsx`
- `keepTogether` joins back to the exact text; keeps `9-99-99`, full-width `１－２－３`, phone numbers, two runs in one address; keeps nothing in plain text, letter-hyphen text or a run over 20 characters.
- Every profile in the matrix renders a long fictional address as one paragraph with only the number run in a `data-keep` span.
- The fact-only check runs on that address and on a full-width one with a line break as well.
- CSS: every `.addressValue` size is a clamp at most 2.4rem; weight cap, no display width / tracking / case, no `nowrap` on the whole address, `.keep` is `nowrap`.
- Both new checks fail on the previous renderer and CSS, and pass now.

**Browser check (Chromium, `next start` with a local preview of fictional facts, 4 profiles incl. condensed black uppercase and mincho, 390 and 1440 px):** the number run is one line box in every case; the address wraps to 2 lines at 390 px; no horizontal overflow; the address (19.2–38.4 px) stays below the Visit heading (35.2–57.6 px); weight 600 for `black`, 300 for `light`.

## Renderer: medium hero on phones and the liner motif (2026-10-02, after phase3-002)

**Real-machine run (human, worker at d0441cf):** job `phase3-002`, `visual_source=instagram_signed_in`, capture `CAPTURED`. candidate-0: 19/25, `revise`, `needs_renderer_change=false` → one profile revision → candidate-1: 19/25, `revise`, `needs_renderer_change=true` → `blocked`, revisions=1, final candidate-1. The address problem of phase3-001 did not come back. The review's note asked for three things: a lower mobile minimum height for the medium hero, the liner motif clear of the title, and less mobile footer padding while keeping the notice readable. The run's files stay on the WSL machine; this analysis reproduced each point with fictional shops in Chromium (390 × 844 as the worker's mobile shot, and 1440 × 900).

**Assessment:**
- Liner over the title: a layout defect. `muffin_paper_svg` was absolutely positioned (top-right on phones, bottom-right on desktop) with no room reserved, so it covered the name in most layouts and name lengths on phones, and the dek on every desktop render. A profile cannot avoid it except by dropping the motif. **Fixed.**
- Medium hero on phones: a structural limit. `medium` is the lowest height in the vocabulary, yet its floor was 56svh (473 px on the worker's phone shot), leaving empty space under a short name. **Fixed for phones only.**
- Footer padding: taste. The footer (DemoFrame, shared by every demo) is 28 / 40 px vertical padding around the fixed not-official notice; the text is 12.8 px, readable, no overflow. **Not changed**, and a test now pins the notice size and footer padding.

**Change:**
- The hero grid has four rows: folio, liner, title, dek (`grid-template-rows: auto auto 1fr auto`, explicit `grid-row` on each). The liner sits in its own row at the right edge (`min(32%, 112px)` on phones, `min(18%, 168px)` from 720 px). Rows do not overlap, so it cannot cover the name, the folio or the dek, whatever the name or layout. Without the motif the row is empty.
- `.hero[data-height="medium"]`: `min-height: 40svh` on phones, `56svh` from 720 px as before. It is a floor; content grows the hero.
- Not changed: profile schema and vocabulary, prompts, DemoFrame / demo.module.css, the 2-revision limit, `RENDERER_CHANGE_NEEDED` → BLOCKED.

**Tests:** `tests/unit/design-agent/renderer-layout.test.tsx` renders the real ProfileRenderer with the module CSS in Chromium:
- 3 fictional names (short, long Latin, long Japanese) × 5 medium profiles with the liner (split_crop, stacked, centered, condensed black, framed mincho) × phone / desktop: liner overlaps no name line, the folio or the dek; liner and name stay inside the hero; no sideways scroll.
- Phone medium hero: below the old floor for a short name; exactly 40svh without motifs; grows past 56svh for a long split name without clipping; desktop keeps 56svh.
- Notice 12.8 px and footer padding `28px 16px 40px` unchanged.
- With the previous CSS, the liner and hero tests fail; with the new CSS all pass.

**Browser check (next start, local preview, fictional facts, 7 profiles × 3 names × 390 / 1440):** liner-over-name and liner-over-dek area 0 everywhere (before: up to 30 733 px² over the name on desktop, 4 699 px² on phones); phone medium hero 355–428 px for short / Japanese names (before 473 px), 524 px for a long split name (grows); no horizontal overflow.

**Seen, not changed (outside this note):** `stamp_ring` is still absolutely positioned at the hero's bottom-right and can touch a long name (fictional long names, phone and desktop). Same kind of defect; left for a separate decision.

## Renderer: stamp ring (2026-10-02, before phase3-003)

Not from a real-shop review: found with fictional shops while fixing the liner, and fixed before the next real run, so the run is not blocked on a known defect.

**Defect:** `stamp_ring` was absolutely positioned at the hero's bottom-right (104 px, rotated). It covered the name on phones even for a short name, and long names on desktop. With `muffin_paper_svg` in the same profile, nothing kept the two apart.

**Change (follows the liner fix):**
- One decorative row (`.motifRow`, hero grid row 2, between the folio and the title, right edge) holds the stamp ring and the liner side by side (flex, 20 px / 28 px gap). Rows do not overlap, so neither motif can cover the name, the folio or the dek, and the gap keeps them apart. Padding and margins leave room for the stamp's −8° tilt.
- Stamp: `min(80px, 22vw)` on phones, 104 px from 720 px (as before). Liner: `min(112px, 30vw)` on phones, 168 px from 720 px.
- The row exists only when one of the two motifs is in the profile; without them the hero is as before (the 40svh / 56svh medium floor is unchanged and still tested).
- Not changed: profile schema and vocabulary, prompts, 2-revision limit, `RENDERER_CHANGE_NEEDED` → BLOCKED, DemoFrame (notice / footer), fact-only (the stamp still shows only the name's own initials).

**Tests:** `renderer-layout.test.tsx`, a new case over 3 fictional names (short Latin, long Latin, long Japanese) × 6 profiles with the stamp (alone in split / stacked / centered; with the liner in split, centered mincho and condensed black full) × 390 × 844 / 1440 × 900: stamp overlaps no name line, the folio, the dek or the liner; stamp, liner and name inside the hero; no sideways scroll. On the previous commit (7c86885) it fails (`short/stamp_split/phone: stamp over the name`); with this change all 4 layout tests pass. Full unit suite 602 passed.

**Browser check (next start, local preview, fictional facts, 3 names × 3 profiles × 390 / 1440):** stamp and liner side by side above the name in every case; no horizontal overflow; phone hero 365–533 px (grows for the long split name), desktop 504 px floor or more.

**Still not changed:** `dot_grid` is a faint absolutely positioned texture at the top right; not reported by a review, not changed here.

## Phase 3 end-to-end PoC done (2026-10-02, phase3-003)

**Real-machine run (human, WSL, worker at 2af0465):** job `phase3-003`, signed-in capture `CAPTURED`.
- candidate-0: `revise`, 19/25
- candidate-1: `revise`, 19/25 (revision 1)
- candidate-2: `accept`, 20/25 (revision 2, the limit)
- outcome `done`; `windows_copy: unavailable` (no export directory reachable for that run; the run directory is the source of truth).

The three real-shop runs, in order: phase3-001 blocked on the address typography (fixed in d0441cf), phase3-002 blocked after one revision on the phone hero height and the liner overlap (fixed in 7c86885), the stamp ring overlap was fixed before the next run (2af0465), and phase3-003 reached `accept` within the two-revision limit. Every block was the designed `RENDERER_CHANGE_NEEDED` stop; each fix was a generic renderer change with fictional-data tests, never a shop-specific branch, and the profile schema, prompts, revision limit and BLOCKED boundary stayed the same.

The run's files (report, candidates, reviews, screenshots) stay in the requester's run directory on that machine. No shop name, URL or image is in this repository or the PR.

**Left to people:** look at the final before / after images and decide whether the demo can be shown; decide what happens with PR #43 (Draft; merge is a human decision); DB schema and any connection to the sales Routine remain behind human approval.
