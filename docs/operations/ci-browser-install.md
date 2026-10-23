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
- test・セキュリティ検査は一つも省かない。失敗は今と同じく job を失敗させる。
  required check の名前は変わらない。`continue-on-error` は使わない。secret は不要。

Numbers are labelled **[CI logs]** (computed from GitHub Actions job logs and step
timestamps), **[measured here]** (this Claude container, 2026-10-23) or **[estimated]**.

## 1. Where the install runs today

`.github/workflows/ci.yml` (develop `cc14cf8`) runs `npx playwright install --with-deps chromium`
with `timeout-minutes: 8` in six jobs: `unit (1/2)`, `unit (2/2)`, `shop-css (1/2)`,
`shop-css (2/2)`, `e2e`, `e2e-sales`. Before DEV-085 (PR `feature/ci-unit-split`, first run
2026-10-22 19:35 UTC) unit was one job and the step had no timeout.

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
  2026-10-22 06:00 UTC and was severe from ~10:30 UTC. Before 19:35 slow installs **succeeded**
  after up to 12–15 min; all 26 failures come after the 8-minute step timeout was added at 19:35.
  So the timeout turned "very slow" into "failed", which is what it was meant to do (a hung
  install must not hold a job for 20 min), but it makes a mirror incident a red CI.
- Cost of the last 30 runs: 26 failed steps × ~8 min ≈ **213 job-minutes** lost, plus 5 manual
  re-runs (`run_attempt` 2) and the slow successes.
- Named jobs: run 39851107227 job 120077196353 (shop-css 2/2) and job 120077195964 timed out in
  the font downloads; run 39858950364 job 120104341213 (unit 2/2) finished the apt download in
  7 min 27 s and passed with 33 s to spare; run 39847738432 job 120065405427 timed out after
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
  The azure mirror is healthy today; the incident was transient.
- **apt does not re-hash files already in its archive directory.** A copy of
  `xvfb_2:21.1.12-1ubuntu1.9_amd64.deb` with one byte flipped (same size) was accepted by
  `apt-get install -d` ("Need to get 0 B"), although its SHA256 (`0194285f…`) differs from the
  signed index (`2011271e…`). So a `.deb` cache that is copied straight into
  `/var/cache/apt/archives` would bypass apt's signature chain. Any cache design must check each
  file against the signed index itself (§6 does).
- The check in §6.2, run against that tampered file plus a junk `evil_1.0_amd64.deb`: both
  dropped, the other 19 used, 1.3 s for 21 files.
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
| **(b1)** cache `.deb` files with `actions/cache` + verify against the signed index (§6) | in an incident: ~7 min → ~30 s for the 21 MB of fonts, always; upgrades (≤ 5 MB) only on the first run after Ubuntu publishes them | **Yes**, for the bytes that matter; `apt-get update` still uses the mirror (max 34 s seen) | the verify script is new code in CI; a wrong script only means "dropped → downloaded as today" | medium (one composite action + one script) | first-party action pinned by SHA; each file must match the SHA256 in the signed index or it is not used — apt itself would not check (§2.5) | **identical**: same command, same package set, same versions |
| (b2) `awalsh128/cache-apt-pkgs-action` | similar to (b1) | yes | third-party code running as root; it restores installed files with its own logic rather than through apt's verification; its own package list would replace Playwright's | low to write, high to trust | needs SHA pin (`v1.6.3` = `553a35bb…`) and review of every update; supply-chain exposure | must reproduce Playwright's list by hand; drift when Playwright changes it |
| **(c)** `playwright install chromium` (no deps) + explicit apt list, `--no-install-recommends`, `Acquire::Retries` / timeouts | full list: 25.9 → 21.1 MB (skip upgrades) ≈ 1 min of a 7-min incident; minimal list (IPAGothic + WenQuanYi only): → 11 MB ≈ 3 min of 7 | no (still the same mirror) | missing lib → launch fails loudly; **missing fallback font → silent pixel change** | low–medium; the list must follow Playwright upgrades | unchanged | full list: same; minimal list: fallback glyphs change (§2.3) |
| **(d)** change mirror order (e.g. `https://archive.ubuntu.com` first) | unknown — no CI data for archive.ubuntu.com (all 336 steps used azure); from here 5.9 s vs 2.7 s for 26 MB on a good day | only if the incident is azure-only | archive.ubuntu.com has its own incidents and rate limits; the image's choice is overridden | very low (one step) | same Ubuntu signatures; https instead of http | identical |
| **(e)** `mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e…` as job container | no apt at all, but a 949 MB pull per job (~30–90 s) | yes for apt; adds a registry dependency | **unit**: bubblewrap + `sysctl kernel.apparmor_restrict_unprivileged_userns` act on the host kernel; unprivileged user namespaces inside Docker need relaxed seccomp/AppArmor (`--privileged` or `--security-opt`), which changes the very boundary `SR_REQUIRE_BWRAP=1` tests; the cross-user test uses `sudo` (the image runs as root and may lack sudo); **e2e-sales**: `supabase start` needs a Docker daemon (socket mount); DejaVu may be missing in the image (unverified) | high | Microsoft-built image pinned by digest; broader privileges for the container | different OS image from the WSL worker and from today's CI; fonts may differ |
| **(f)** install once in a separate job, share via artifact | negative for wall time: every job waits for the installer job (+ upload/download); the installer still hits the mirror | no | artifacts carry files, not installed system state; would still need dpkg on each job | high | artifacts are writable by the run itself; same verification problem as (b1) | depends on how it is re-installed |
| **(g)** do nothing (timeout + one manual re-run) | 0 | no | 13 of the last 30 runs touched; ~213 job-minutes lost; merges wait for re-runs | none | none | identical |

All options keep every test and security check, keep the 8-minute step timeout, keep the job
names (so required checks are unchanged), and need no secret. None needs `continue-on-error`.

## 4. Recommendation

**Primary: (b1)** — keep `npx playwright install --with-deps chromium` exactly as it is, and in
front of it restore the `.deb` files from `actions/cache` (first-party, pinned by commit SHA),
put into `/var/cache/apt/archives` only the files whose SHA256 matches the signed apt index,
and after the install copy the archive back for the cache. Package for the six jobs as one local
composite action so the six call sites stay one line each.

Why: it removes the ~21 MB of fonts (81 % of the bytes; the packages that never change in 24.04)
from the slow path permanently, keeps the installed set byte-for-byte what Playwright chooses (so
no font, pixel or library question arises), keeps every failure of apt or Playwright failing the
step, and adds no third-party code. Its weak spots are bounded: on a cache miss or a bad cache it
degrades to today's behaviour; a security update of libnss3/glib is downloaded once per image
version (≤ 5 MB).

Expected after [estimated]: cache hit — restore 1–3 s, `apt-get update` ~5 s (max 34 s seen),
verify ~1–2 s, Playwright's own `apt-get update` (all "Hit") ~2 s, dpkg ~9 s, browser ~9 s ⇒
**~30 s typical, ≤ ~1.5 min during a mirror incident** (only `apt-get update` and any fresh
upgrade still use the mirror), against today's p90 493 s.

**Fallback: (d)** — if (b1) is not accepted, or the validation shows the runner cleans
`/var/cache/apt/archives`: one step before the install that puts `https://archive.ubuntu.com`
first in `/etc/apt/apt-mirrors.txt` (azure second). Signed by Ubuntu either way; benefit unknown
until measured, so it would be validated the same way (§7).

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
| no secrets | the cache uses the job's own `GITHUB_TOKEN`-scoped cache service |

## 6. Proposed change (not applied)

### 6.1 `ci.yml` diff

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ unit-shard
       - run: npm ci
       # The design worker tests capture a local mock page with headless Chromium.
-      # Normally 20-40 s; the slowest seen was 6m47s on a slow apt mirror (still progressing).
-      # The limit stops a hung install; a timeout fails the step and the job.
-      - run: npx playwright install --with-deps chromium
+      # Normally 20-40 s. The .deb files come from a verified cache (DEV-089,
+      # docs/operations/ci-browser-install.md); the install command is unchanged.
+      # The limit stops a hung install; a timeout fails the step and the job.
+      - uses: ./.github/actions/playwright-chromium
         timeout-minutes: 8
@@ shop-css
       - run: npm ci
-      - run: npx playwright install --with-deps chromium
+      - uses: ./.github/actions/playwright-chromium
         timeout-minutes: 8
@@ e2e
       - run: npm ci
-      - run: npx playwright install --with-deps chromium
+      - uses: ./.github/actions/playwright-chromium
         timeout-minutes: 8
@@ e2e-sales
       - run: npm ci
-      - run: npx playwright install --with-deps chromium
+      - uses: ./.github/actions/playwright-chromium
         timeout-minutes: 8
```

(four hunks; `unit-shard` and `shop-css` are matrix jobs, so this covers all six jobs.)

### 6.2 New `.github/actions/playwright-chromium/action.yml`

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
      run: |
        rm -rf ~/.cache/sr-apt-debs
        mkdir -p ~/.cache/sr-apt-debs
        shopt -s nullglob
        debs=(/var/cache/apt/archives/*.deb)
        if [ "${#debs[@]}" -gt 0 ]; then cp "${debs[@]}" ~/.cache/sr-apt-debs/; fi
        echo "apt .deb cache: ${#debs[@]} files kept for the next run"
```

The cache key changes with the runner image and the Playwright version; `restore-keys` lets a
new key start from the previous files (stale ones are dropped by the check). `actions/cache`
saves in its post step only when the job succeeds, and only for a key not yet saved.

### 6.3 New `.github/actions/playwright-chromium/seed-apt-cache.sh`

```bash
#!/usr/bin/env bash
# DEV-089 proposal: put cached .deb files into apt's archive directory before
# `playwright install --with-deps`, so apt does not download them again.
# apt trusts any file of the right size in /var/cache/apt/archives, so each
# file is used only if its SHA256 equals the one in the signed apt index;
# anything else is dropped and apt downloads it as before.
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
  have=$(sha256sum "$f" | cut -d' ' -f1)
  if grep -qxF "$pkg $ver $arch $have" <<<"$index"; then
    sudo install -m 0644 "$f" "$dest/"
    used=$((used + 1))
  else
    echo "apt .deb cache: dropped $base (not in the signed index, or hash differs)"
    dropped=$((dropped + 1))
  fi
done
echo "apt .deb cache: $used verified and used, $dropped dropped"
```

Notes on the script:

- `apt-cache show` exits non-zero when one name is unknown (e.g. a junk file); `|| true` keeps
  the lines it did print. A missing or wrong entry can only lead to "dropped".
- The index it reads is the one `apt-get update` just fetched and verified (InRelease signature
  → Packages hashes), so the SHA256 compared here is as trusted as a normal apt download.
- `apt-get update` failing (mirror down) fails the step — the same as today, where Playwright's
  `apt-get update` would fail it.
- Tested here (§2.5) with apt redirected to an isolated root; on the runner it uses the system
  apt configuration unchanged.

### 6.4 Fallback (d), if chosen instead

```diff
@@ (in each of the four jobs, before the install step)
+      # DEV-089 fallback: try archive.ubuntu.com (https) before the azure mirror.
+      - run: printf 'https://archive.ubuntu.com/ubuntu/\tpriority:1\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n' | sudo tee /etc/apt/apt-mirrors.txt
       - run: npx playwright install --with-deps chromium
         timeout-minutes: 8
```

## 7. Validation once approved

All on one feature PR to develop; nothing merged until it passes.

1. **V-1 first run** (cache empty): the log shows `apt .deb cache: empty`, install times like
   today, and the post step saves `pw-apt-v1-…` (~26 MB). Check `gh cache list`.
2. **V-2 repeat N = 10** pushes (or re-runs) on the PR → 60 install steps. Pass when: log shows
   `N verified and used, 0 dropped`, apt prints `Need to get 0 B` (or only fresh upgrades), install
   step median ≤ 40 s and max ≤ 90 s, 0 timeouts. Compare with the §2.1 table using the same
   parsing (step timestamps + log phases).
3. **V-3 fidelity** (temporary diagnostic steps on the validation branch only, removed before
   merge): after the install, `dpkg-query -W | sort | sha256sum` and `fc-list | sort | sha256sum`
   on a cache-hit run and on a run of today's `ci.yml` started from the same runner image — the
   hashes must be equal. All test counts per job unchanged (vitest/Playwright summaries); the
   font-dependent tests of §2.3 pass (phase-a IPAGothic check, shop-css pixel proofs including
   `fonts.test.tsx`, `renderer-jp-name`).
4. **V-4 negative checks** (temporary, validation branch only):
   (a) flip a byte of one cached `.deb` before the seed step → it is `dropped`, apt downloads it,
   the job passes; (b) make the install fail (e.g. `npx playwright install --with-deps chromium-nope`)
   → the step and job fail; (c) a `sleep 600` inside the composite action with
   `timeout-minutes: 1` on the `uses:` step → the step is killed and the job fails (proves the
   step timeout covers a composite action).
5. **V-5** required checks on the PR: the same names (`static`, `unit`, `integration`, `build`,
   `e2e`, `e2e-sales`, plus the shard jobs) report as before.
6. Check the archive is not cleaned by the runner (V-1 post step must save > 0 files); if it is,
   switch to the fallback.
7. Fresh Review of the PR (AI_WORKFLOW §4) with this document and the V-2/V-3 data attached.
   `.github/**` changes need the human's approval before merge (CLAUDE.md, AI_WORKFLOW §7).

## 8. Rollback

- Revert the commit: the four `uses: ./.github/actions/playwright-chromium` lines go back to
  `run: npx playwright install --with-deps chromium`, and the action directory is removed.
  Nothing else depends on it.
- Delete the cache entries (`gh cache delete --all`, or the `pw-apt-v1-` keys in the Actions
  UI), or invalidate them by bumping the key prefix to `pw-apt-v2-`.
- No runner, secret, branch protection or required check is involved, so there is nothing else
  to restore.

## 9. Not covered / open

- `sudo apt-get install -y bubblewrap` in the unit shards (50 kB) still uses the mirror without a
  step timeout (the job's 20 min applies). It could be added to the same cache later; low value.
- `apt-get update` still uses the mirror. In 335 steps it never took more than 34 s [CI logs].
- No data exists on archive.ubuntu.com from GitHub's runners; (d) stays a guess until measured.
- The Docker image's font set (DejaVu, fallback fonts) was not inspected; only needed if (e) is
  ever reconsidered.
