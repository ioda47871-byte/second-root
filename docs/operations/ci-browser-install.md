# CI: the slow Chromium install (DEV-089, study and design only)

> **Status: proposal.** Nothing in `.github/**` is changed by this document.
> The human approved the investigation and the design on 2026-10-23
> (「キャッシュ、依存パッケージの削減、インストール方法の見直しなどを比較してください。
> ただし、テストやセキュリティ検査を省略してはいけません。CI設定の実変更は、改善案を
> レビューした後に別途判断します。」). Applying §6 needs a separate decision.

## 要約（日本語）

- 遅いのは **apt の .deb の取得**（azure の Ubuntu mirror、遅い時は 35〜60 kB/s）で、
  Chromium 本体の取得（cdn.playwright.dev、約 316 MB）は中央値 9 秒で問題ではない。
- `--with-deps` が毎回取りに行くのは 17 個・25.9 MB。うち **21.1 MB はフォント**
  （runner image に無い 9 個）、残りは image にある libnss3・glib・xvfb の更新。
  test は IPAGothic と WenQuanYi Zen Hei を名指しで使い、pixel を比べるので、
  フォントは減らさない。
- 直近 30 run（2026-10-22 12:35〜21:55 UTC）で install step は 196 回、
  **26 回が 8 分の timeout で失敗**、30 run 中 13 run が影響を受けた。
- **推奨（第一案）**: コマンドは `npx playwright install --with-deps chromium` の
  まま変えず、取った .deb を first-party の `actions/cache`（commit SHA で固定）に
  保存し、次の run では **署名された apt の index の SHA256 と一致するものだけ** を
  apt の archive に置く。入る package の集合は今と同じなので test の忠実度は変わらない。
  apt は archive にある同じ大きさの file を hash 検査せずに使う（この container で確認）
  ので、照合は必須。
- **代替案**: mirror の順番を archive.ubuntu.com（https）先にする（1 行、効果は未計測）。
- **8 分の timeout**: 第一案と一緒に 8 分のまま維持し、検証（V-2）の後に見直す。
  単に延ばすと、unit (2/2)・shop-css (1/2)（test 約 7 分、job 20 分）では job の timeout に
  なるだけ。
- 具体的な実装案（file ごとの diff、contract test）と検証方法・成功の基準・戻し方は
  **§6「実装案と検証方法（承認判断用、日本語の要約付き）」**。
- test・セキュリティ検査は一つも省かない。失敗は今と同じく job を失敗させる。
  required check の名前は変わらない。`continue-on-error` は使わない。secret は不要。

Numbers are labelled **[CI logs]** (computed from GitHub Actions job logs and step
timestamps), **[measured here]** (this Claude container, 2026-10-23) or **[estimated]**.

## 1. Where the install runs today

`.github/workflows/ci.yml` (develop `cc14cf8`) runs `npx playwright install --with-deps chromium`
with `timeout-minutes: 8` in six jobs: `unit (1/2)`, `unit (2/2)`, `shop-css (1/2)`,
`shop-css (2/2)`, `e2e`, `e2e-sales`. Before DEV-085 (PR #99 `feature/ci-unit-split`, first run
2026-10-22 19:35 UTC) unit was one job and **no job** had a step timeout on the install (only the
job timeouts: 20 min for unit, shop-css and e2e, 25 min for e2e-sales).

The unit shards also run `sudo apt-get install -y bubblewrap` (50 kB) in a separate step with
no step timeout; it uses the same mirror.

Playwright `1.62.1` (`package.json` `^1.62.1`, lockfile `1.62.1`). Its
`installDependenciesLinux` (in `node_modules/playwright-core/lib/coreBundle.js`) runs, as root:

```
apt-get update
apt-get install -y --no-install-recommends <tools + chromium list for ubuntu24.04-x64>
```

so `--no-install-recommends` is already used, and there is no retry of its own.

## 2. Findings

### 2.1 Install durations [CI logs]

Source: all jobs (`filter=all`, so re-run attempts included) of the 59 most recent completed
`CI` runs (2026-10-21 12:02 → 2026-10-22 21:55 UTC), 336 install steps. "Last 30" = the 30 most
recent completed runs (2026-10-22 12:35 → 21:55 UTC, run 39779571817 … 39861095331), 196 steps.
Phases are split from log timestamps: *apt* = step start → first "Downloading Chrome for
Testing" line (or the end of the step if it never got there); *browser* = that line → the last
"downloaded to" line. Times in seconds.

**Last 30 runs**

| job | n | total median | total p90 | total max | apt median | apt p90 | apt max | browser median | browser max | ≥ 120 s | failed (timeout) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| unit (1/2) | 21 | 25 | 493 | 493 | 16 | 493 | 493 | 9 | 10 | 7 | 6 |
| unit (2/2) | 21 | 26 | 493 | 493 | 16 | 493 | 493 | 10 | 10 | 7 | 6 |
| unit (pre-split, single job) | 14 | 26 | 452 | 894 | 18 | 442 | 895 | 9 | 10 | 3 | 0 (1 cancelled at 894 s) |
| shop-css (1/2) | 35 | 27 | 492 | 714 | 17 | 493 | 706 | 9 | 11 | 7 | 3 |
| shop-css (2/2) | 35 | 30 | 493 | 591 | 20 | 493 | 582 | 9 | 13 | 11 | 6 |
| e2e | 35 | 27 | 399 | 492 | 17 | 389 | 493 | 10 | 12 | 6 | 1 |
| e2e-sales | 35 | 27 | 493 | 694 | 17 | 493 | 685 | 9 | 290 | 11 | 4 |
| **all** | **196** | **27** | **493** | **894** | **17** | **493** | **895** | **9** | **290** | **52** | **26** |

**All 59 runs**: n = 336, total median 25 / p90 492 / max 894; apt median 16 / p90 493 / max 895;
browser median 9 / p90 10 / max 290; 26 failed, 2 cancelled, 308 succeeded.

Inside the apt phase (last 30, completed steps only): `apt-get update` median 5 / p90 11 /
max **34** s; the `.deb` download median 1 / p90 282 / max 695 s (steps that timed out never
finished their download and are not in these .deb numbers). The rest (~9 s) is dpkg and
needrestart.

Other facts from the logs:

- **The slow part is the `.deb` download, every time.** All 26 failures timed out inside the apt
  phase (none reached the browser download). `apt-get update` (12.5 MB of indexes from the same
  mirror) stayed fast even during the slow periods (max 34 s).
- Effective `.deb` throughput over 308 completed downloads: median 18.8 MB/s, but 31 steps
  (10 %) below 200 kB/s, minimum 35 kB/s. 25.9 MB at 58 kB/s is 7 min 27 s (job 120104341213).
- Every one of the 336 steps used `azure.archive.ubuntu.com` (the runner's
  `mirror+file:/etc/apt/apt-mirrors.txt`, priority 1). `Ign:` lines (a timed-out fetch, retried)
  appear in 35 steps and hit every package, not only fonts — counts: fonts-freefont-ttf 21,
  xfonts-scalable 19, fonts-wqy-zenhei 19, fonts-tlwg-loma-otf 17, xvfb 16, xfonts-cyrillic 16,
  xserver-common 15, fonts-unifont 14, fonts-ipafont-gothic 14, libnss3-tools 13, … , even
  bubblewrap 2. Fonts dominate only because they are most of the bytes. After an `Ign` the same
  azure URL was tried again; the mirror list's fail-over is for errors, not for a slow mirror.
- By time of day: on 2026-10-21 (60 steps) the max was 43 s. The slowness started around
  2026-10-22 06:00 UTC and was severe from ~10:30 UTC. Before 19:35, 10 of 308 successful steps
  took 570–738 s (and one took exactly 480 s); all would fail under the 8-min limit. (The 894 s
  unit step was cancelled, not a success.) All 26 failures come after the 8-minute step timeout
  was added at 19:35.
  So the timeout turned "very slow" into "failed", which is what it was meant to do (a hung
  install must not hold a job for 20 min), but it makes a mirror incident a red CI.
- Cost of the last 30 runs: 26 failed steps × ~8 min ≈ **213 job-minutes** lost, plus 5 manual
  re-runs (`run_attempt` 2) and the slow successes.
- Named jobs: run 39851107227 job 120077196353 (shop-css 2/2) and job 120077195964 timed out in
  the font downloads; run 39858950364 job 120104341213 (unit 2/2) finished the apt download in
  7 min 27 s and passed with 9 s to spare (the step took 471 s of its 480); run 39847738432 job 120065405427 timed out after
  `Ign` on fonts-wqy-zenhei and libnss3; run 39855133605 failed e2e-sales in both attempts.
- The browser download was slow once in 308: job 119881212859 (e2e-sales, 14:25 UTC), where
  `chrome-headless-shell-linux64.zip` (redirected to storage.googleapis.com) trickled to 20 % in
  4 min 39 s, then hit Playwright's 30 s idle timeout; Playwright's own retry fetched it in 5 s.

### 2.2 What `--with-deps` installs, and what the runner already has

Playwright 1.62.1, `ubuntu24.04-x64` [read from `playwright-core` 1.62.1]:

- `tools` (12): xvfb, fonts-noto-color-emoji, fonts-unifont, libfontconfig1, libfreetype6,
  xfonts-cyrillic, xfonts-scalable, fonts-liberation, fonts-ipafont-gothic, fonts-wqy-zenhei,
  fonts-tlwg-loma-otf, fonts-freefont-ttf
- `chromium` (21): libasound2t64, libatk-bridge2.0-0t64, libatk1.0-0t64, libatspi2.0-0t64,
  libcairo2, libcups2t64, libdbus-1-3, libdrm2, libgbm1, libglib2.0-0t64, libnspr4, libnss3,
  libpango-1.0-0, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3,
  libxkbcommon0, libxrandr2

On the ubuntu-24.04 runner (apt output in job 120077196353) [CI logs]:

| group | packages | bytes [measured here, same versions] |
|---|---|---|
| already on the image, newest version | 26 of the 33 named (all chromium libs except libglib2.0-0t64 and libnss3; fonts-noto-color-emoji, fonts-liberation, libfontconfig1, libfreetype6) | 0 |
| **new** (not on the image) | fonts-freefont-ttf 5.64 MB, fonts-wqy-zenhei 7.47 MB, fonts-ipafont-gothic 3.51 MB, fonts-unifont 2.99 MB, xfonts-encodings 0.58 MB, xfonts-cyrillic 0.38 MB, xfonts-scalable 0.30 MB, fonts-tlwg-loma-otf 0.11 MB, xfonts-utils 0.09 MB | **21.07 MB** |
| upgraded (on the image, older version) | libglib2.0-0t64 1.55 MB, libnss3 1.44 MB, xvfb 0.88 MB, libnss3-tools 0.62 MB, gir1.2-glib-2.0 0.18 MB, libglib2.0-bin 0.10 MB, libglib2.0-data 0.05 MB, xserver-common 0.04 MB | 4.87 MB |
| total | 17 files | **25,937,806 B** (= "Need to get 25.9 MB" in CI) |

The "upgraded" group depends on how old the runner image is: 20 steps needed only 21.1 MB and
15 needed 23.9 MB [CI logs], i.e. on newer images some upgrades were already in. The new fonts
come from the `noble` release pocket and do not change during 24.04's life.

`xvfb` is only needed for headed Chromium; every test here launches headless (the sign-in window
in `lib/design-agent/browser/session.ts` is headed in production but run headless in
`tests/unit/design-agent/browser.test.ts`).

### 2.3 Which fonts the tests depend on

Fonts are part of what the tests measure, so they are a fidelity question, not only a size one.

| test / fixture | font it names | package | how it depends |
|---|---|---|---|
| `tests/unit/design-agent/comp-impl/phase-a.test.ts` | IPAGothic | fonts-ipafont-gothic (new) | **asserts** the face is installed (canvas width check) and throws otherwise; V2 compares glyph pixels |
| `tests/unit/design-agent/shop-css/support.tsx` (all shop-css tests) | IPAGothic, Liberation Serif/Sans, DejaVu Serif/Sans | fonts-ipafont-gothic (new), fonts-liberation (image), DejaVu (image¹) | pixel proofs of the render check; vertical text needs IPA metrics |
| `tests/unit/design-agent/shop-css/fonts.test.tsx` | `OTHER_FACES`: DejaVu + WenQuanYi Zen Hei; a second fontconfig (LCD AA, full hinting) including `/etc/fonts/fonts.conf` | fonts-wqy-zenhei (new) | checks the render check does not depend on the face |
| `renderer-jp-name.test.tsx`, `renderer-hero-parity.test.tsx`, `renderer-sparse-density.test.tsx`, `renderer-density-pass2.test.tsx` | WenQuanYi Zen Hei, IPAGothic, Liberation, DejaVu | new + image | measure text in "really different" faces (`renderer-jp-name` asserts the faces differ) |
| `tests/unit/design-agent/stage1-fixtures.ts`, `scripts/sales-design-worker/comp-impl/synthetic-wagashi/page/style.css` | IPAGothic (IPAMincho, Noto CJK fall back to it) | fonts-ipafont-gothic | fixture rendering |
| `lib/design-agent/comp-impl/page-css.ts` | allowlist of family names (not a test of installation) | — | — |
| e2e (`tests/e2e/*`) | the app's own next/font faces (self-hosted in the build) | — | no screenshot assertions in e2e |

¹ DejaVu is not in Playwright's list and is not installed by the step, so it comes from the
runner image (the tests that need it pass today).

Glyphs that none of the named faces has fall back through fontconfig to whatever else is
installed (FreeFont, Unifont, TLWG, the X core fonts). Dropping those packages could change a
pixel somewhere without any test naming them. **Conclusion: keep the full Playwright font set.**
A smaller list saves at most the non-named fonts (≈ 9.7 MB) and buys a fidelity risk that would
need its own proof.

### 2.4 The browser itself

[measured here, `Content-Length` from cdn.playwright.dev; CI log for the time]

| file | size | from |
|---|---|---|
| chrome-linux64.zip (Chrome for Testing 151.0.7922.34, chromium-1234) | 193.3 MB | cdn.playwright.dev → storage.googleapis.com |
| chrome-headless-shell-linux64.zip | 120.2 MB | same |
| ffmpeg-linux.zip (ffmpeg-1011) | 2.4 MB | cdn.playwright.dev (Azure fallbacks) |
| **total** | **≈ 316 MB** | median **9 s** in CI (≈ 35 MB/s), max 290 s once |

The browser is not from apt. It is ~12× the bytes of the apt step and still ~1/50 of its time
in a bad hour. **apt is the slow part.**

### 2.5 Measured in this container (2026-10-23, apt 2.8.3, noble)

- `apt-get download` of the 17 files in an isolated apt root (no system change):
  azure.archive.ubuntu.com 2.7 s, archive.ubuntu.com 5.9 s, `apt-get update` ~3 s each.
  The azure mirror was fast from here; but the PR #103 CI run the same morning (2026-10-23 05:15
  UTC, job 120253690760) fetched the same 25.9 MB from it at 54.0 kB/s and timed out [CI logs].
  So the slowness is on the path from GitHub's runners, not visible from elsewhere.
- **apt does not re-hash files already in its archive directory.** A copy of
  `xvfb_2:21.1.12-1ubuntu1.9_amd64.deb` with one byte flipped (same size) was accepted by
  `apt-get install -d` ("Need to get 0 B"), although its SHA256 (`0194285f…`) differs from the
  signed index (`2011271e…`). So a `.deb` cache that is copied straight into
  `/var/cache/apt/archives` would bypass apt's signature chain. Any cache design must check each
  file against the signed index itself (§6 does).
- The check in §6.2 (seed script), run against that tampered file plus a junk
  `evil_1.0_amd64.deb`: both removed, the other 19 placed, ~1.3 s for 21 files.
- `mcr.microsoft.com/playwright:v1.62.1-noble`: index digest
  `sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e`,
  amd64 manifest `sha256:c091b21d…`, **949 MB compressed** (7 layers, includes Firefox and WebKit).
- `actions/cache` `v4.3.0` = commit `0057852bfaa89a56745cba8c7296529d2fc39830`.
- The runner image's apt config (actions/runner-images `configure-apt-sources.sh` and
  `configure-apt.sh`, main): mirror list azure (priority 1) → `https://archive.ubuntu.com`
  (2) → `https://security.ubuntu.com` (3); `Acquire::Retries 1`, `Acquire::http(s)::Timeout 15`
  on x64. Fail-over happens on a timeout or error, not on a slow-but-alive transfer — which is
  what the logs show.

## 3. Options compared

Time saved is per install step against today's median 27 s / p90 493 s / failure rate 26 of 196
[CI logs]; the "after" numbers are [estimated].

| option | time saved | removes the failure mode? | risk | complexity | security | test fidelity |
|---|---|---|---|---|---|---|
| **(a)** `actions/cache` for `~/.cache/ms-playwright` (key: playwright version) | median ~0–5 s (restoring 316 MB from the Actions cache takes about as long as the 9 s CDN download); helps only on a CDN stall (1 in 308) | **No** — apt stays | cache eviction pressure (316 MB × key, 10 GB repo limit, may evict the npm cache) | low | first-party action; a poisoned cache would be a browser binary run in CI (PR caches are scoped to the PR ref, develop's are read-only to PRs) | same binary (keyed on version) |
| **(b1)** cache `.deb` files with `actions/cache` + verify against the signed index (§6) | in an incident: ~7 min → ~30 s for the 21 MB of fonts, always; upgrades (≤ 5 MB) only on the first run after Ubuntu publishes them | **Yes**, for the bytes that matter; `apt-get update` still uses the mirror (max 34 s seen) | the verify script is new code in CI; a wrong script only means "dropped → downloaded as today" | medium (one composite action + two scripts) | first-party action pinned by SHA; each file must match the SHA256 in the signed index or it is removed — apt itself would not check (§2.5). The hash covers the `.deb` contents only: the cache tarball is extracted (as the runner user, into `~/.cache/sr-apt-debs`) before any check, so it relies on the cache-scope assumption in §6.5 — the same exposure `setup-node` `cache: npm` already has | **identical**: same command, same package set, same versions. A cached version other than apt's candidate can pass the hash check but is never installed: apt installs the candidate and downloads it if its file is not there |
| (b2) `awalsh128/cache-apt-pkgs-action` | similar to (b1) | yes | third-party code running as root; it restores installed files with its own logic rather than through apt's verification; its own package list would replace Playwright's | low to write, high to trust | needs SHA pin (`v1.6.3` = `553a35bb…`) and review of every update; supply-chain exposure | must reproduce Playwright's list by hand; drift when Playwright changes it |
| **(c)** `playwright install chromium` (no deps) + explicit apt list, `--no-install-recommends`, `Acquire::Retries` / timeouts | full list: 25.9 → 21.1 MB (skip upgrades) ≈ 1 min of a 7-min incident; minimal list (IPAGothic + WenQuanYi only): → 11 MB ≈ 3 min of 7 | no (still the same mirror) | missing lib → launch fails loudly; **missing fallback font → silent pixel change** | low–medium; the list must follow Playwright upgrades | unchanged | full list: same; minimal list: fallback glyphs change (§2.3) |
| **(d)** change mirror order (e.g. `https://archive.ubuntu.com` first) | unknown — no CI data for archive.ubuntu.com (all 336 steps used azure); from here 5.9 s vs 2.7 s for 26 MB on a good day | only if the incident is azure-only | archive.ubuntu.com has its own incidents and rate limits; the image's choice is overridden | very low (one step) | same Ubuntu signatures; https instead of http | identical |
| **(e)** `mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e…` as job container | no apt at all, but a 949 MB pull per job (~30–90 s) | yes for apt; adds a registry dependency | **unit**: bubblewrap + `sysctl kernel.apparmor_restrict_unprivileged_userns` act on the host kernel; unprivileged user namespaces inside Docker need relaxed seccomp/AppArmor (`--privileged` or `--security-opt`), which changes the very boundary `SR_REQUIRE_BWRAP=1` tests; the cross-user test uses `sudo` (the image runs as root and may lack sudo); **e2e-sales**: `supabase start` needs a Docker daemon (socket mount); DejaVu may be missing in the image (unverified) | high | Microsoft-built image pinned by digest; broader privileges for the container | different OS image from the WSL worker and from today's CI; fonts may differ |
| **(f)** install once in a separate job, share via artifact | negative for wall time: every job waits for the installer job (+ upload/download); the installer still hits the mirror | no | artifacts carry files, not installed system state; would still need dpkg on each job | high | artifacts are writable by the run itself; same verification problem as (b1) | depends on how it is re-installed |
| **(g)** do nothing (timeout + one manual re-run) | 0 | no | 13 of the last 30 runs touched; ~213 job-minutes lost; merges wait for re-runs | none | none | identical |
| **(h)** keep, raise or condition the 8-min step timeout | ~13 min would have passed the 10 slow successes (570–738 s) and maybe some of the 26 timeouts (unknown: they were cut off) | partly — turns some red runs into slow green runs | **job budgets are tight** [CI logs, runs 39904571702 / 39858950364]: unit (2/2) tests ~403–413 s and shop-css (1/2) ~422–426 s inside a 20-min job, plus ~1.5 min setup; a 13-min install there ends in a *job* timeout instead (worse: the log stops mid-test). e2e 20 min (tests ~30 s), e2e-sales 25 min (tests ~2.5–3 min + `supabase start`). Raising the step limit means raising job limits too | low | none | identical |

All options keep every test and security check, keep the job names (so required checks are
unchanged), and need no secret. None needs `continue-on-error`. All except (h) keep the 8-minute
step timeout.

On (h): the 8-minute value from PR #99 rested on its comment "the slowest seen was 6m47s", which
was already wrong when it was written (738 s had succeeded at 12:34 UTC the same day). Still, the
limit does its job — it bounds a hung install well inside the job budget — and once (b1) takes the
fonts off the mirror a healthy install needs ~30 s. **Recommendation: keep 8 min together with
(b1), and re-evaluate after V-2 (§6.4)**: if any cache-hit install there exceeds 2 min, look at
what is still downloaded before touching the limit; raising it alone would need the job limits
raised as well.

## 4. Recommendation

**Primary: (b1)** — keep `npx playwright install --with-deps chromium` exactly as it is, and in
front of it restore the `.deb` files from `actions/cache` (first-party, pinned by commit SHA),
keep in `/var/cache/apt/archives` only the files whose root-owned copy there matches the SHA256
of the signed apt index, and after the install keep for the cache only the `.deb` files of the
installed versions. Package for the six jobs as one local composite action so the six call
sites stay one line each, and pin the invariants with a contract test (§6.3).

Why: it removes the ~21 MB of fonts (81 % of the bytes; the packages that never change in 24.04)
from the slow path permanently, keeps the installed set byte-for-byte what Playwright chooses (so
no font, pixel or library question arises), keeps every failure of apt or Playwright failing the
step, and adds no third-party code. Its weak spots are bounded: on a cache miss or a bad cache it
degrades to today's behaviour; a security update of libnss3/glib is downloaded once per image
version (≤ 5 MB).

Expected after [estimated]: cache hit — restore 1–3 s, `apt-get update` ~5 s (max 34 s seen),
place + verify ~1–2 s, Playwright's own `apt-get update` (all "Hit") ~2 s, dpkg ~9 s, browser ~9 s ⇒
**~30 s typical, ≤ ~1.5 min during a mirror incident** (only `apt-get update` and any fresh
upgrade still use the mirror), against today's p90 493 s.

**Fallback: (d)** — if (b1) is not accepted, or the validation shows the runner cleans
`/var/cache/apt/archives`: one step before the install that puts `https://archive.ubuntu.com`
first in `/etc/apt/apt-mirrors.txt` (azure second). Signed by Ubuntu either way; benefit unknown
until measured, so it would be validated the same way (§6.4).

Timeout (h): keep 8 min with (b1); re-evaluate after V-2.

Not recommended now: (a) (no gain on the measured bottleneck; revisit if CDN stalls recur),
(c) with a reduced font list (fidelity risk for ≤ 9.7 MB), (b2) (third-party root code),
(e) (breaks or weakens the bubblewrap / sudo / Supabase jobs), (f), (g).

## 5. Hard constraints, checked against the proposal

| constraint | how §6 meets it |
|---|---|
| no test or security check skipped | test steps, `bubblewrap`/sysctl, cross-user test, `check:secrets` untouched |
| install failure still fails the job | the install command is unchanged and runs without `|| true`; the seed script is `set -euo pipefail`; a failed `apt-get update` in it fails the step |
| required check names unchanged | job `name:` fields and the `unit` aggregate untouched |
| no `continue-on-error` | none added |
| third-party actions pinned by SHA | no third-party action; `actions/cache` (first-party) is pinned by SHA anyway |
| cache cannot be written by untrusted code for the base branch | assumption in §6.5, pinned by the contract test in §6.3 (no `pull_request_target` / `workflow_run` / `issue_comment`) |
| no secrets | the cache uses the job's own `GITHUB_TOKEN`-scoped cache service |

## 6. 実装案と検証方法（承認判断用、日本語の要約付き）

> Proposal only. Nothing below is applied by this PR; `.github/**` is unchanged. The human's
> request of 2026-10-23: 「署名済みaptインデックスのSHA256と照合するキャッシュ方式が有力です。
> ただし、CI設定の実変更はまだ承認しません。セキュリティ検査、フォント、テスト結果、required
> checksが維持されることを条件に、具体的な実装案と検証方法を提示してください。」

### 6.0 要約（日本語）

- **変えるもの**: `ci.yml` の 4 か所（6 job）で、`run: npx playwright install --with-deps chromium`
  を同じ内容の composite action `./.github/actions/playwright-chromium` に置き換える。
  `timeout-minutes: 8` はそのまま。action の中身:
  1. `actions/cache`（first-party、commit SHA 固定）が前回の `.deb` を `~/.cache/sr-apt-debs` に戻す。
  2. `seed-apt-cache.sh` が `apt-get update` の後、各 `.deb` を root 所有で apt の archive に置き、
     **置いた後の root 所有の file** の SHA256 を署名済み index と照合し、違えば消す
     （apt 自身は同じ大きさの file を検査しない、§2.5）。
  3. **今と同じ** `npx playwright install --with-deps chromium`（入る package と版は今と同一）。
  4. `save-apt-cache.sh` が、いま install されている版の `.deb` だけを次回用に残す。
- **変えないもの**: すべての test・`check:secrets`・bubblewrap（`SR_REQUIRE_BWRAP=1`）・
  cross-user の sudo test・job 名（required checks）・8 分の step timeout。
  `continue-on-error` や `|| true` で失敗を隠さない。secret は不要。
- **固定する仕組み**: 新しい contract test（`tests/unit/ci-browser-install-contract.test.ts`）が、
  required check 名、`continue-on-error` が無いこと、install step と 8 分の timeout、
  security step、action の SHA 固定、危険な trigger（`pull_request_target` /
  `workflow_run` / `issue_comment`）が無いこと、照合の順序を検査する。
  この container で、提案どおりの変更に対して 7/7 通り、6 種類の改悪（trigger の追加、
  timeout 13 分、check:secrets の削除、job 名の変更、continue-on-error、`|| true`）を
  それぞれ検出することを確認した。
- **検証**（§6.4）: 検証用の一時 commit で、①セキュリティ検査が同じ、②`fc-list` と
  `dpkg-query` の hash が今の install と同一、③shard ごとの test file 数・test 数・skip 数が
  base run と同一、④required checks が同じ名前で緑、を確かめる。成功の基準は
  cache hit の 10 run（install step 60 回）で中央値 ≤ 40 秒、最大 ≤ 90 秒、timeout 0 回。
- **戻し方**（§6.6）: revert 1 つと cache の削除だけ。

### 6.1 `.github/workflows/ci.yml`

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -55,9 +55,10 @@ jobs:
           cache: npm
       - run: npm ci
       # The design worker tests capture a local mock page with headless Chromium.
-      # Normally 20-40 s; the slowest seen was 6m47s on a slow apt mirror (still progressing).
+      # Normally 20-40 s; on a slow apt mirror it took up to 12 min (DEV-089). The .deb files
+      # come from a cache checked against the signed apt index; the install command is unchanged.
       # The limit stops a hung install; a timeout fails the step and the job.
-      - run: npx playwright install --with-deps chromium
+      - uses: ./.github/actions/playwright-chromium
         timeout-minutes: 8
       # The Codex sandbox tests run against real bubblewrap, unprivileged (as on the WSL worker).
       # Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor; WSL does not.
@@ -104,7 +105,7 @@ jobs:
           node-version: 22
           cache: npm
       - run: npm ci
-      - run: npx playwright install --with-deps chromium
+      - uses: ./.github/actions/playwright-chromium
         timeout-minutes: 8
       - run: npx vitest run tests/unit/design-agent/shop-css --shard=${{ matrix.shard }}/2
 
@@ -176,7 +177,7 @@ jobs:
           node-version: 22
           cache: npm
       - run: npm ci
-      - run: npx playwright install --with-deps chromium
+      - uses: ./.github/actions/playwright-chromium
         timeout-minutes: 8
       - uses: actions/download-artifact@v4
         with:
@@ -205,7 +206,7 @@ jobs:
           node-version: 22
           cache: npm
       - run: npm ci
-      - run: npx playwright install --with-deps chromium
+      - uses: ./.github/actions/playwright-chromium
         timeout-minutes: 8
       - run: npx supabase start -x studio,imgproxy,realtime,storage-api,edge-runtime,logflare,vector,supavisor,postgres-meta,mailpit
       - uses: actions/download-artifact@v4
```

(`unit-shard` and `shop-css` are matrix jobs, so the four hunks cover all six jobs.)

### 6.2 New `.github/actions/playwright-chromium/` (3 files)

`action.yml`:

```yaml
name: Playwright Chromium (verified apt cache)
description: >-
  npx playwright install --with-deps chromium, unchanged, with apt's .deb files restored
  from the Actions cache and used only if they match the signed apt index (DEV-089).
runs:
  using: composite
  steps:
    - id: image
      shell: bash
      run: echo "id=${ImageOS:-unknown}-${ImageVersion:-unknown}" >> "$GITHUB_OUTPUT"
    - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0
      with:
        path: ~/.cache/sr-apt-debs
        key: pw-apt-v1-${{ runner.os }}-${{ runner.arch }}-${{ steps.image.outputs.id }}-${{ hashFiles('node_modules/playwright-core/package.json') }}
        restore-keys: |
          pw-apt-v1-${{ runner.os }}-${{ runner.arch }}-
    - shell: bash
      run: bash "$GITHUB_ACTION_PATH/seed-apt-cache.sh"
    - shell: bash
      run: npx playwright install --with-deps chromium
    - shell: bash
      run: bash "$GITHUB_ACTION_PATH/save-apt-cache.sh"
```

`seed-apt-cache.sh` — runs before the install:

```bash
#!/usr/bin/env bash
# DEV-089: put cached .deb files into apt's archive directory before
# `playwright install --with-deps`, so apt does not download them again.
# apt trusts any file of the right size in /var/cache/apt/archives, so each
# file is used only if its SHA256 equals the one in the signed apt index.
# The hash is taken of the root-owned copy in the archive (not of the
# runner-writable source), so the checked bytes are the bytes apt will use.
# Anything else is removed and apt downloads it as before.
set -euo pipefail
src="$HOME/.cache/sr-apt-debs"
dest=/var/cache/apt/archives
shopt -s nullglob
debs=("$src"/*.deb)
if [ "${#debs[@]}" -eq 0 ]; then
  echo "apt .deb cache: empty (cache miss); apt downloads everything"
  exit 0
fi
sudo apt-get update -qq
names=()
for f in "${debs[@]}"; do b=$(basename "$f"); names+=("${b%%_*}"); done
# "package version architecture sha256" for every version the signed index knows
index=$(apt-cache show "${names[@]}" 2>/dev/null |
  awk '/^Package: /{p=$2} /^Version: /{v=$2} /^Architecture: /{a=$2} /^SHA256: /{print p, v, a, $2}') || true
used=0
dropped=0
for f in "${debs[@]}"; do
  base=$(basename "$f" .deb)
  pkg=${base%%_*}
  rest=${base#*_}
  arch=${rest##*_}
  ver=${rest%_*}
  ver=${ver//%3a/:}
  target="$dest/$base.deb"
  sudo install -m 0644 -o root -g root "$f" "$target"
  have=$(sha256sum "$target" | cut -d' ' -f1)
  if grep -qxF "$pkg $ver $arch $have" <<<"$index"; then
    used=$((used + 1))
  else
    sudo rm -f -- "$target"
    echo "apt .deb cache: dropped $base (not in the signed index, or hash differs)"
    dropped=$((dropped + 1))
  fi
done
echo "apt .deb cache: $used verified and placed, $dropped dropped"
```

`save-apt-cache.sh` — runs after the install; keeps only the installed versions so the cache does
not grow with old ones:

```bash
#!/usr/bin/env bash
# DEV-089: keep for the next run only the .deb files of the package versions
# that are installed now, so the cache does not grow with old versions.
set -euo pipefail
out="$HOME/.cache/sr-apt-debs"
rm -rf "$out"
mkdir -p "$out"
installed=$(dpkg-query -W -f='${Package} ${Version} ${Architecture}\n')
shopt -s nullglob
kept=0
for f in /var/cache/apt/archives/*.deb; do
  base=$(basename "$f" .deb)
  pkg=${base%%_*}
  rest=${base#*_}
  arch=${rest##*_}
  ver=${rest%_*}
  ver=${ver//%3a/:}
  if grep -qxF "$pkg $ver $arch" <<<"$installed"; then
    cp "$f" "$out/"
    kept=$((kept + 1))
  fi
done
echo "apt .deb cache: $kept files of installed versions kept for the next run"
```

Notes:

- **Order (no TOCTOU)**: the file is first copied by `sudo install` into the root-owned archive
  directory, then the root-owned copy is hashed, and removed with `sudo rm` on a mismatch. The
  runner user cannot change the bytes between the check and apt's use.
- **Versions**: the index lists every version the archive still has (release and `-updates`
  pockets). A cached version other than apt's candidate can pass the hash check but is never
  installed — apt installs only the candidate and downloads it when its file is missing. The save
  step drops such files: it keeps only files matching
  `dpkg-query -W -f='${Package} ${Version} ${Architecture}\n'`.
- `apt-cache show` exits non-zero when one name is unknown (e.g. a junk file); `|| true` keeps
  the lines it did print. A missing or wrong entry can only lead to "dropped". This is the only
  `|| true`, and it is not on the install.
- The index it reads is the one `apt-get update` just fetched and verified (InRelease signature
  → Packages hashes), so the SHA256 compared is as trusted as a normal apt download.
- A failing `apt-get update` (mirror down) fails the step, as Playwright's own `apt-get update`
  does today.
- The cache key changes with the runner image and the Playwright version; `restore-keys` lets a
  new key start from the previous files. `actions/cache` saves in its post step only when the job
  succeeds, and only for a key not saved yet.
- [measured here] Both scripts pass `bash -n`. With apt redirected to an isolated root:
  seed — a tampered `xvfb` (same size) and a junk `evil_1.0_amd64.deb` were both removed from the
  archive, the other 19 placed and byte-identical to the mirror's; save — of 18 files, the 9 whose
  version is installed in this container were kept and the newer `xvfb`/`libnss3` (not installed
  here) were not.

### 6.3 New `tests/unit/ci-browser-install-contract.test.ts`

Added in the same PR as §6.1/§6.2 (it reads the new action files, so it cannot land earlier). Plain
text checks, no new dependency.

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// DEV-089: pins what the verified apt .deb cache must never change in CI.
// Plain-text checks on purpose (no YAML dependency): the lines are simple and stable.
const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const ci = read(".github/workflows/ci.yml");
const ACTION_DIR = ".github/actions/playwright-chromium";
const action = read(`${ACTION_DIR}/action.yml`);
const seed = read(`${ACTION_DIR}/seed-apt-cache.sh`);
const save = read(`${ACTION_DIR}/save-apt-cache.sh`);
const workflows = readdirSync(join(root, ".github/workflows"))
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ f, text: read(`.github/workflows/${f}`) }));

/** The text of one job in ci.yml: from "  <id>:" to the next job header. */
function job(id: string): string {
  const lines = ci.split("\n");
  const start = lines.findIndex((l) => l === `  ${id}:`);
  expect(start, `job ${id} exists`).toBeGreaterThan(-1);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]) || /^\S/.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join("\n");
}

describe("CI browser install contract (DEV-089)", () => {
  it("keeps every required check name", () => {
    for (const [id, name] of [
      ["static", "static"],
      ["unit-shard", "unit (${{ matrix.shard }}/2)"],
      ["unit", "unit"],
      ["shop-css", "shop-css (${{ matrix.shard }}/2)"],
      ["integration", "integration"],
      ["build", "build"],
      ["e2e", "e2e"],
      ["e2e-sales", "e2e-sales"],
    ]) expect(job(id)).toContain(`    name: ${name}\n`);
    expect(job("unit")).toContain('test "$RESULT" = "success"');
  });

  it("has no continue-on-error anywhere in CI or the action", () => {
    for (const { f, text } of workflows) expect(text, f).not.toMatch(/continue-on-error/);
    expect(action).not.toMatch(/continue-on-error/);
  });

  it("installs Chromium with deps in all four browser jobs, under an 8-minute step limit", () => {
    for (const id of ["unit-shard", "shop-css", "e2e", "e2e-sales"])
      expect(job(id)).toMatch(/- uses: \.\/\.github\/actions\/playwright-chromium\n\s+timeout-minutes: 8\n/);
    expect(action).toMatch(/\n\s+run: npx playwright install --with-deps chromium\n/);
    expect(action).not.toMatch(/\|\|\s*(true|:)/);
  });

  it("keeps the security steps", () => {
    expect(job("static")).toContain("npm run check:secrets");
    const unit = job("unit-shard");
    expect(unit).toContain("sudo apt-get install -y bubblewrap");
    expect(unit).toContain('SR_REQUIRE_BWRAP: "1"');
    expect(unit).toContain("SR_CROSS_USER_TEST=1 npx vitest run tests/unit/design-agent/cross-user.test.ts");
  });

  it("pins every action outside actions/* and every action in the composite by commit SHA", () => {
    const uses = [...workflows.map((w) => w.text), action].flatMap((t) => [...t.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]));
    for (const u of uses) {
      if (u.startsWith("./")) continue;
      if (!u.startsWith("actions/")) expect(u, u).toMatch(/@[0-9a-f]{40}$/);
    }
    for (const m of action.matchAll(/uses:\s*([^\s#]+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
  });

  it("runs on no trigger that would let untrusted code write a cache the base branch reads", () => {
    for (const { f, text } of workflows)
      expect(text, f).not.toMatch(/^\s*(pull_request_target|workflow_run|issue_comment)\s*:/m);
  });

  it("checks each cached .deb against the signed index, on the root-owned copy", () => {
    expect(seed).toMatch(/^set -euo pipefail$/m);
    expect(seed).toContain("sudo apt-get update");
    expect(seed).toMatch(/sudo install -m 0644 -o root -g root "\$f" "\$target"\n\s+have=\$\(sha256sum "\$target"/);
    expect(seed).toContain('sudo rm -f -- "$target"');
    expect(save).toMatch(/^set -euo pipefail$/m);
    expect(save).toContain("dpkg-query -W");
  });
});
```

[measured here] In a scratch worktree with §6.1 and §6.2 applied: 7/7 pass, eslint clean. Against
today's `ci.yml` the install test fails, as it should. Each of these mutations makes exactly one
test fail: `pull_request` → `pull_request_target`; one `timeout-minutes: 8` → `13`; `check:secrets`
removed; `e2e-sales` renamed; `continue-on-error: true` on a job; `|| true` after the install.

### 6.4 How each condition is verified

All on the implementation PR (feature → develop). Diagnostics marked "temporary" go into a separate
commit that is **reverted before the review**; the final head must then pass CI again on its own.

**Security checks unchanged**

| check | where | verification |
|---|---|---|
| secret scan | `static`: `npm run check:secrets` | contract test; `static` green |
| guardrails | `tests/unit/guardrails.test.ts` (unit shards) | the file is in the per-shard file list (below) and passes |
| real bubblewrap, unprivileged | unit shards: `apt-get install bubblewrap`, sysctl, `SR_REQUIRE_BWRAP: "1"` (`sandbox.test.ts`, `photo-codex.test.ts`, `jail.test.ts`, `codex*.test.ts`) | contract test; same test counts, 0 skipped in those files |
| cross-user boundary with real users | `unit (1/2)`: `sudo env … SR_CROSS_USER_TEST=1 … cross-user.test.ts` | contract test; the step runs and reports the same test count |
| apt signature chain | `apt-get update` + the seed check | V-4 tamper test; `dropped` lines appear only for tampered or stale files |
| workflow triggers / pins | contract test | it runs in the unit shards on every PR |

**Fonts identical** (temporary diagnostic)

1. In each of the six install jobs, after the action: print
   `echo "$ImageOS-$ImageVersion"`,
   `dpkg-query -W -f='${Package} ${Version} ${Architecture}\n' | sort | sha256sum`,
   `fc-list : family style file | sort | sha256sum`, and `fc-match` for `IPAGothic`,
   `WenQuanYi Zen Hei`, `DejaVu Sans`, `DejaVu Serif`, `Liberation Serif`, `sans-serif`, `serif`.
2. A temporary extra job `font-baseline` (not a required check) in the same run runs today's
   `npx playwright install --with-deps chromium` with no cache and prints the same.
3. Pass: for runs where the image id matches, all hashes and `fc-match` lines are equal between
   `font-baseline` and every cached job, on a cache-miss run **and** on a cache-hit run.

**Test results identical**

- Base: the latest green develop run before the PR (same commit as the PR's base).
- For each shard (`unit (1/2)`, `unit (2/2)`, the cross-user step, `shop-css (1/2)`,
  `shop-css (2/2)`, `e2e`, `e2e-sales`): the vitest summary (`Test Files … passed`,
  `Tests … passed | … skipped`) and the Playwright summary (`N passed`, `N skipped`) must equal the
  base run's. A temporary `--reporter=json` artifact can be diffed for the list of test names if a
  count differs.
- The font tests of §2.3 are part of these counts and must pass (phase-a's IPAGothic check,
  shop-css pixel proofs including `fonts.test.tsx`, `renderer-jp-name`).

**Required checks unchanged**

- The contract test pins the job names and the `unit` aggregate.
- On the PR, the check list shows `static`, `unit`, `integration`, `build`, `e2e`, `e2e-sales`
  (and the shard jobs) with the same names as on the base run, all green.

**Success criteria (measured)**

| | criterion |
|---|---|
| V-1 first run (cache miss) | log shows `apt .deb cache: empty`; install time like today; post step saves `pw-apt-v1-…` (~26 MB, > 0 files — if 0, the runner cleans the archive: stop and use the fallback) |
| V-2 N = 10 runs (pushes or re-runs), 60 install steps | each logs `N verified and placed, 0 dropped` (dropped > 0 only right after an Ubuntu update), apt prints `Need to get 0 B` or only the fresh upgrade; install step **median ≤ 40 s, max ≤ 90 s, 0 timeouts**; measured with the same timestamp/log parsing as §2.1 |
| V-3 fidelity | font and dpkg hashes equal (above); test counts equal (above) |
| V-4 negative (temporary) | (a) a byte flipped in one cached `.deb` before the seed step → `dropped`, apt downloads it, job passes; (b) `npx playwright install --with-deps chromium-nope` → the step and the job fail; (c) `sleep 600` inside the action with `timeout-minutes: 1` on the `uses:` step → the step is killed and the job fails |
| V-5 | required checks as above; contract test green |
| timeout (h) | if any V-2 cache-hit install exceeds 2 min, find what was downloaded before changing the 8-min limit |

Then the usual Fresh Review (AI_WORKFLOW §4) with the V-1…V-5 data, and the human's approval
of the `.github/**` change before merge.

### 6.5 Security assumption of the cache

The SHA256 check protects the `.deb` contents only. The cache tarball itself is extracted by
`actions/cache` (as the runner user, into `~/.cache/sr-apt-debs`) **before** any check. The design
therefore assumes nobody untrusted can write a cache entry that a trusted run restores:

- entries in the develop/main scope are written only by `push` runs on develop/main (trusted,
  already merged code);
- no workflow uses `pull_request_target`, `workflow_run` or `issue_comment` (which run with the
  base branch's cache scope on behalf of untrusted input) — today the only workflow is `ci.yml`
  with `pull_request` and `push` [read from the repo];
- caches written by a PR run, fork or not, are scoped to that PR's merge ref and are not restored
  by develop/main or by other PRs;
- this is the same exposure that already exists for `actions/setup-node` with `cache: npm`
  (`~/.npm` is restored before `npm ci`).

The contract test (§6.3) fails if one of those triggers is ever added while this cache is in use.

### 6.6 Rollback

- Revert the commit: the four `uses: ./.github/actions/playwright-chromium` lines go back to
  `run: npx playwright install --with-deps chromium`, the action directory and the contract test
  are removed. Nothing else depends on them.
- Delete the cache entries (`gh cache delete --all`, or the `pw-apt-v1-` keys in the Actions UI),
  or invalidate them by bumping the key prefix to `pw-apt-v2-`.
- No runner, secret, branch protection or required check is involved.

### 6.7 Fallback (d), if chosen instead

```diff
@@ (in each of the four jobs, before the install step)
+      # DEV-089 fallback: try archive.ubuntu.com (https) before the azure mirror.
+      - run: printf 'https://archive.ubuntu.com/ubuntu/\tpriority:1\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n' | sudo tee /etc/apt/apt-mirrors.txt
       - run: npx playwright install --with-deps chromium
         timeout-minutes: 8
```

Validated with V-1/V-2/V-5 the same way (V-3 is trivially equal: same packages from a different
mirror, same signatures).

## 7. Not covered / open

- `sudo apt-get install -y bubblewrap` in the unit shards (50 kB) still uses the mirror without a
  step timeout (the job's 20 min applies). It could be added to the same cache later; low value.
- `apt-get update` still uses the mirror. In 335 steps it never took more than 34 s [CI logs].
- No data exists on archive.ubuntu.com from GitHub's runners; (d) stays a guess until measured.
- The Docker image's font set (DejaVu, fallback fonts) was not inspected; only needed if (e) is
  ever reconsidered.
