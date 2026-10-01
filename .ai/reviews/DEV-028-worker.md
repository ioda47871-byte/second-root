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
