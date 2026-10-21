# Design image PoC — 架空菓庵 (local only, DEV-074 / 第2案 DEV-075)

> **第2案 (v2) is the default since DEV-075** — see [第2案](#第2案-v2-dev-075) below for the policy change of 2026-10-21 (AI concept
> visuals of the wagashi allowed, store and people imagery still forbidden), the run (HUMAN-019), the viewing steps and the evaluation rubric.
> `SR_DESIGN_IMAGE_POC_DIRECTION=v1` still runs the first PoC unchanged. Everything below about the wrapper, the jail, the cleanup and the stop codes applies to both.

> **Human approval is required first** (`.ai/blockers.md` HUMAN-018) for **each** run. With approval, add `--human-approval-confirmed`.
> Without it, neither `design-image-poc.sh` nor `design-image-poc.ts` reads a file, prepares the sandbox or starts Codex
> (`STOP: --human-approval-confirmed is missing`).
> The only entry point is `design-image-poc.sh`. Starting `design-image-poc.ts` directly stops too (no run lock, no pinned checkout, no env allowlist).
> **It never touches the worker's timer** (`sr-design-worker.timer`: not stopped, not restarted, not enabled). Not running at the same time as the worker is kept by `run.lock`.
> **It runs from `develop` only**, after PR #88 is merged (the wrapper pins the checkout to `origin/develop`; on an older develop it stops with `POC_NOT_ON_REF`).

## Purpose
Use Second Root's curated v0.2 art-direction knowledge and the existing DEV-073 **fictional wagashi** facts to ask Codex (signed in with ChatGPT) for **one visual PNG mockup**, not a website. Compare later with the existing generator only after the visual is reviewed. This PoC **does not** publish or modify a site.

## Source of truth
- Store facts: `scripts/sales-design-worker/compare/shops/wagashi.json` (never copy facts from generated pixels).
- Curated art direction: `design-library/poc/wagashi-art-direction-v2.json` (第2案, default) and `design-library/poc/wagashi-art-direction.json` (v1, kept for history).
- Wrapper (the only entry point): `scripts/sales-design-worker/design-image-poc.sh`.
- Entry: `scripts/sales-design-worker/design-image-poc.ts`; logic: `lib/design-agent/design-image/` (`run.ts`, `prompt.ts`, `png.ts`).
- Reference implementation: curiosity-media `packages/automation/src/codex-image.ts` (D-139 / D-141 / D-143): the image is taken from `<CODEX_HOME>/generated_images/<thread_id>/`, Codex runs with `--sandbox read-only` (its commands cannot write there, so the image can only come from the image tool), ChatGPT sign-in only, the original and the work dir are deleted.
- Reference research v0.2 is a working draft; claims about unverified sites are not treated as confirmed and third-party imagery is not used as an asset.

## Safety
- **Human approval required for each Codex image generation run**; no job/timer automatically invokes this script. Not in CI (tests use a fake sandbox only).
- Use only the existing isolated `sr-designgen` WSL account with its own ChatGPT-authenticated Codex; **do not** use the account that runs 怪異読本, copy tokens, or move auth files.
- Codex runs through **the existing `prepareCodexSandbox` bubblewrap OS jail**, with the worker's `workerProtectedPaths` plus this PoC's output root. Its own `--sandbox read-only` alone is not adequate.
- No Supabase, Staging, Production, Vercel, flag, bridge, worker queue / results / ledger, browser helper, timer, sales DM, or GitHub push is involved. Nothing is committed or published.
- Generated image can be imperfect: text may be wrong, aspect ratio may differ from requested layout, and three sections may not fit. Report actual PNG size, do not claim success until viewed.
- v1: photo-free means no unapproved product photographs **and no invented photorealistic product imagery** (no AI-generated shop photos).
- v2 (第2案): AI concept visuals of the **wagashi only** (and abstract materials) are allowed by the human's decision of 2026-10-21; AI images of a store, its interior or exterior, staff or any people, logos, copied photos and any claim that a visual is real stay forbidden.
- No first-party credentials or API keys are copied into this repo. Never log full Codex stdout, stderr, responses, or auth tokens.

## What the wrapper does (`design-image-poc.sh`, each step stops on failure)

Same pattern as DEV-073 `compare-local.sh`:

0. the approval flag (`STOP`, exit 2: nothing started)
1. restart with an allowlisted environment (as `run.sh`: no API key, token or database credential; `OPENAI_API_KEY` / `CODEX_API_KEY` / `OPENAI_BASE_URL` never reach Codex)
2. the machine resource preflight (`scripts/ops/wsl-resource-preflight.sh`, `docs/operations/wsl-resource-preflight.md`; `STOP`, exit 20)
3. `flock -n` on the worker's `~/.local/state/sr-design-worker/run.lock` (`STOP`, exit 3 when a worker run holds it; a timer-fired `run.sh` meanwhile finds the lock taken and exits 0)
4. inside the lock: `git fetch` + `checkout --force --detach origin/develop` + `git clean`; `npm ci` only when `package-lock.json` changed
5. `design-image-poc.ts` with `SR_DESIGN_IMAGE_POC_LOCKED=run.lock` and the time budget: the whole PoC ≤ 3300 s (inside the jail's `RuntimeMaxSec=3500`, as `run.sh`); it starts only with ≥ 18 min left; the one Codex call ≤ 15 min

Then `design-image-poc.ts` (`lib/design-agent/design-image/run.ts`):

- reads and checks the fixture and the art direction; the output root must be outside the repository, the worker's directories and CODEX_HOME (0700, not a link)
- prepares the worker's sandbox; removes session logs a cut-off design-agent call left (and those threads' image dirs); `codex login status` must say ChatGPT
- snapshots the thread dirs in `CODEX_HOME/generated_images/`
- one `codex exec --skip-git-repo-check --sandbox read-only --json -c model_provider="openai" --cd <work dir> -` (prompt on stdin, **no reference image attached**), work dir `$TMPDIR/sr-design-codex-XXXXXX` (the design agent's prefix, so `removeStaleCodexSessions` recognises it)
- takes the newest PNG in `CODEX_HOME/generated_images/<thread>/`; any link or non-regular `.png` there is refused; the PNG is opened with `O_NOFOLLOW` and fully checked (signature, chunk walk with CRC, IHDR first with sane depth / colour type, 512–8192 px a side, ≤ 40 Mpx, ≤ 24 MiB, IDAT present, IEND last, nothing after it)
- on every exit (success, failure, timeout, signal), in this order: removes the thread's image dir and every image dir that **appeared during this run** (never one that existed before; if the snapshot of `generated_images/` could not be read, only the thread's own dir), then this run's session logs (this thread's, and any whose cwd is this run's work dir — never another design-agent call's: `design-demo.ts` and the photo PoC do not take `run.lock`), a partly written result dir, and the work dir. A signal (SIGTERM / SIGINT / SIGHUP, the watchdog) waits for that same cleanup (memoised; at most 20 s) before exiting. Only a SIGKILL (e.g. the wrapper's `timeout --kill-after=30`, an OOM kill) or a cleanup longer than 20 s can leave something; the next run's start removes leftover design-agent session logs and those threads' image dirs

### Isolation (what Codex can see)
- The bubblewrap jail of `lib/design-agent/sandbox.ts`: `/` read-only; `/home`, the real home, `/root`, `/mnt` (incl. `/mnt/c`), `/media`, `/srv`, `/run` are empty tmpfs; `/tmp` is an empty writable tmpfs; the worker's protected paths (browser profile, capture spool, `~/.ssh`, `~/.config/gh`, `~/.claude`, git credentials, the worker's state / queue / results, the asset store) and this PoC's output root are checked invisible by the probe before each call.
- Put back: the Codex install and node (read-only), **CODEX_HOME read-write** (its sign-in and session logs; `generated_images/` lies inside it, which is how the image gets out), the work dir read-write (empty; `inputs/` empty and read-only). Nothing else of the home is exposed.
- The renderer, the worker, `/design-preview`, `/demo` and the asset store never read `~/sr-design-image-poc` (a test asserts that only the PoC entry names it or imports `lib/design-agent/design-image/`).

## Run (only after explicit human approval, HUMAN-018, and after the PR is merged to develop)

One command, as DEV-073 (the jail's one run; the checkout changes only inside the worker's run lock; the timer is left as it is):

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc '
S=~/.local/state/sr-design-worker; mkdir -p "$S" && chmod 700 "$S"
# so that an older checkout without the wrapper also works: move to develop only inside the worker run lock (if the worker runs, change nothing and stop)
flock -n "$S/run.lock" sh -c "cd ~/work/second-root && timeout 180 git fetch -q --no-tags origin +refs/heads/develop:refs/remotes/origin/develop && timeout 60 git checkout -q --force --detach origin/develop" \
  || { echo "STOP: a design worker run is in progress; nothing was changed"; exit 3; }
cd ~/work/second-root && ./scripts/sales-design-worker/design-image-poc.sh --human-approval-confirmed'
```

The flag means consent to the **one** image-generation Codex call and its ChatGPT plan usage. Do not fetch or check out a feature branch in the worker's checkout, do not build there, and do not run `design-image-poc.ts` by hand.

Do not run `design-demo.ts`, `photo-poc.sh` or a manual `codex` as `sr-designgen` while the PoC runs: they take no run.lock, and the PoC's start-of-run sweep and its exit-time image-dir diff could remove a concurrent call's session log or image.

### Time and cost
- Codex: **1 call** with image generation, on the ChatGPT plan of `sr-designgen`'s sign-in (plan usage; **no API billing**, no API key). Usually a few minutes; the call is cut at **15 min**.
- Whole run: checkout + (rarely) `npm ci` + the call; capped at **3300 s (55 min)**, inside the jail's 3500 s.

## Output
On success the last line is `POC_IMAGE_READY: /home/sr-designgen/sr-design-image-poc/wagashi-XXXXXX/mockup.png`. The directory (0700, files 0600, outside the repository) holds:
- `mockup.png` — unapproved *design concept*, not deployed.
- `shop-facts.json` — exact copied fictional facts from the DEV-073 fixture (after the worker's fact filter).
- `design-spec.json` — the selected curated art direction (v2 or v1), copied as parsed.
- `report.json` — fixed codes and numbers only: `status: IMAGE_GENERATED_NOT_IMPLEMENTED`, `direction_version` (`v1` / `v2`), width, height, aspect, bytes, sha256, chunk count, Codex time, prompt length, commit, fixed notes (v2 adds `AI_FOOD_VISUALS_CONCEPT_ONLY` and `EVALUATION_REQUIRED`). Never Codex's words.

`$SR_DESIGN_IMAGE_POC_ROOT` (absolute) changes the root. It is never committed, never published, never read by the worker or the site.

## Viewing the result (the human)

`sr-designgen`'s home is not readable by other users, so copy the one PNG out as your own admin WSL user (not inside the jail):

```bash
D=/home/sr-designgen/sr-design-image-poc/wagashi-XXXXXX      # the directory printed after POC_IMAGE_READY
sudo cat "$D/report.json"                                     # size, hash (codes and numbers only)
sudo install -m 0644 "$D/mockup.png" /mnt/c/Users/<WindowsUser>/Desktop/kakuu-kaan-mockup.png
```

Open `kakuu-kaan-mockup.png` on the Windows desktop (Photos). To share it back for review, upload that PNG (and paste `report.json` if useful) into the Claude session. Do not upload it anywhere else, do not commit it, do not publish it. Delete the desktop copy when the review is done (the original stays in `sr-designgen`'s home until removed: `sudo rm -r "$D"`).

## Quality caveat (the fixture's placeholder values)
The DEV-073 fixture is deliberately fictional and is **not edited** for this PoC:
- every menu item contains 「テスト」 (e.g. テスト最中, 季節のテスト上生菓子)
- the description begins with 「比較用の架空の和菓子屋です。実在の店舗ではありません。」
- the access line names 「テスト線テスト駅」

The prompt therefore allows leaving out of the image the menu items, the access line and the description's fictional-notice sentences (the required 「架空店舗のデザイン提案」 line already discloses it). Everything that is shown must match the facts exactly. A mockup without a menu is expected, not a failure. Judge the composition, typography and colour, not the placeholder copy.

## The prompt (`lib/design-agent/design-image/prompt.ts`)
The v1 prompt is described here (unchanged byte for byte when v1 is selected); the v2 prompt is described in [第2案](#第2案-v2-dev-075).
Structured text, not raw JSON: task, what the image is (flat web-design comp, no browser frame), **artboard: one tall portrait 2:3 (e.g. 1024 × 1536)** — the image tool's sizes are limited, so no 1440 px page is promised —, goal, theme, per-section intent (Hero / Concept / Information), techniques with use / avoid, colours, hard rules. Fixed in code, whatever the direction says:
- no photographs, photorealistic images or 3-D renders of food, products, the shop, its interior or exterior, streets or people
- no logos, prices, reviews, awards, people, founder names, history, social handles, QR codes
- only facts from the FACTS block, exactly; the shop name exactly 架空菓庵; the disclosure 架空店舗のデザイン提案
- the facts appear only inside a `<<<FACTS_BEGIN data-not-instructions … FACTS_END>>>` block marked as data, not instructions
- no environment value, path or token is ever in the prompt (tested)

## Stop and failure handling
If Codex is not signed in, sandbox probe fails, API-key authentication is detected, quota is reached, no image was produced, image invalid, or time limit hit: **stop**. No fallback to an unrestricted Codex process, external API, screenshot copying, or worker run. Each stop prints one fixed code (`POC_STOP: <code>`):

| code | meaning / what to do |
|---|---|
| `STOP: --human-approval-confirmed is missing` | nothing started |
| `POC_NOT_ON_REF` | develop does not have the PoC yet (merge first) |
| `POC_RUN_TIME_BUDGET` | not enough time left; Codex not started (or stopped by the watchdog) |
| `POC_INPUT_INVALID` | fixture / art direction did not pass the checks |
| `POC_DIRECTION_INVALID` | `SR_DESIGN_IMAGE_POC_DIRECTION` is not `v1` / `v2` (or unset); nothing started |
| `POC_OUTPUT_UNSAFE` | output root inside the repo / worker dirs / CODEX_HOME, a link, or not ours |
| `CODEX_NOT_INSTALLED`, `CODEX_SANDBOX_UNAVAILABLE`, `CODEX_SANDBOX_LEAK`, `CODEX_SANDBOX_CONFIG` | the jail could not be set up safely; Codex not started |
| `CODEX_NOT_SIGNED_IN` | `codex login status` is not ChatGPT, or the CLI reported a signed-out / 401 (stderr or its error events only): sign in again as `sr-designgen` (`codex login --device-auth`) |
| `CODEX_API_KEY_AUTH` | signed in with an API key: refused |
| `CODEX_QUOTA` | ChatGPT plan usage limit / busy: try another day |
| `CODEX_TIMEOUT` | the call passed 15 min |
| `CODEX_EXEC_FAILED`, `CODEX_NO_THREAD`, `CODEX_NO_IMAGE`, `CODEX_IMAGE_INVALID` | no acceptable image; nothing written |
| `POC_STOPPED_BY_SIGNAL`, `POC_KILLED_OR_TIMED_OUT`, exit 137 / 124 | check for an OOM kill first (the wrapper prints `--oom-check`) |

## Next steps (not part of this PoC)
No code implementation or screenshot QA has yet happened. Review image visually first; then Claude can implement the 3-section page in a **separate** isolated PoC, screenshot 1440/390, and compare. Existing worker / staging integration needs a distinct review and approval.

## Success criteria for this stage
One generated PNG genuinely reflects art direction; recognizable shop name; no fabricated factual content or photos; 3 coherent short sections; aesthetically strong first-fold composition. Passing a file checksum **is not** passing design review.

## 第2案 (v2, DEV-075)

### Policy change (2026-10-21, approved by the human)
The first image (HUMAN-018, v1) looked Japanese but read as a poster, with weak sales appeal as a website. For 第2案 the human approved:

- **Allowed now:** AI-generated visuals of the wagashi themselves (どら焼き, 上生菓子, a tsubu-an macro …) and abstract materials / textures (washi, wooden tray, ceramic plate, linen), **as proposal / concept imagery only**, never presented as real photos of the shop's products.
- **Still forbidden:** AI images of a fictional store (exterior, interior, staff, people, hands, signage); copying Instagram or third-party photos or designs; logos / emblems; any text claiming the visuals are real; invented prices, reviews, awards, history or people, even with visuals.
- **Disclosure in the image:** 「架空店舗のデザイン提案｜和菓子の画像はAI生成のイメージです」, small but legible, in the footer or under the Hero.
- The fixture's test placeholders (テスト-filled menu names, テスト線テスト駅) need not be shown; the facts are not edited.

**Scope: the PoC only.** The v2 direction and this policy are read only by `design-image-poc.sh` / `design-image-poc.ts` and `lib/design-agent/design-image/`. The sales worker, the demo generation, presets, the renderer and the asset store do not read them (a static test, `design-image-poc.test.ts` "isolation", fails if anything else names `wagashi-art-direction-v2` or `AI_FOOD_VISUALS`). The asset store still accepts `approved_real` only (DEV-070). **Adopting AI wagashi visuals in the worker, a demo or production needs a quality evaluation (below) plus a separate human approval.**

### What the v2 prompt asks for
- a **website design comp**: a full-page desktop screenshot-style mockup, flat browser-agnostic UI (no device frame, no browser chrome), realistic web typography sizes, tall portrait about 2:3 (e.g. 1024 × 1536)
- a slim **header nav** (「商品・こだわり」「店舗情報」「アクセス」) and one CTA 「店舗情報を見る」 (no purchase / reservation UI: there is no such fact)
- 3 sections stacked: **Hero** (the shop name 架空菓庵 and a dorayaki cross-section with tsubu-an share the lead), **商品・こだわり** (2–3 product visual cards + one short copy block; captions only verbatim from the description, e.g. 季節の上生菓子 / 粒あんのどら焼き, or placeholder lines), **店舗情報** (a definition list / table: 営業時間・定休日・住所・電話)
- palette kinari `#F4EEE3` / sumi `#1F1D1B` / muted vermilion `#B4472E`; Mincho display, Gothic body; 12-col grid, ~1200 px content, generous margins
- one consistent art direction for every wagashi image (light, surfaces, camera height); no people, hands, store or text inside images
- Japanese text limited to the shop name, nav / CTA / section / info labels, the shown fact values, card captions and at most one verbatim copy line, and the disclosure (to reduce garbled glyphs)
- the facts only inside the `<<<FACTS_BEGIN data-not-instructions … FACTS_END>>>` block; no environment value, path or token (tested)

### Run (HUMAN-019: only after the human's explicit approval of this one run)
The same command as HUMAN-018; v2 is the default, so nothing is added:

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc '
S=~/.local/state/sr-design-worker; mkdir -p "$S" && chmod 700 "$S"
flock -n "$S/run.lock" sh -c "cd ~/work/second-root && timeout 180 git fetch -q --no-tags origin +refs/heads/develop:refs/remotes/origin/develop && timeout 60 git checkout -q --force --detach origin/develop" \
  || { echo "STOP: a design worker run is in progress; nothing was changed"; exit 3; }
cd ~/work/second-root && ./scripts/sales-design-worker/design-image-poc.sh --human-approval-confirmed'
```

It runs from `develop` after the 第2案 PR is merged (an older develop runs v1 silently: check that the log line says `direction v2`). To re-run the first PoC instead, put `SR_DESIGN_IMAGE_POC_DIRECTION=v1 ` before `./scripts/…` (any other value stops with `POC_DIRECTION_INVALID`). Cost and time as before: **1 Codex image call** (ChatGPT plan, no API billing), the call ≤ 15 min, the whole run ≤ 55 min. Do not run `design-demo.ts`, `photo-poc.sh` or a manual `codex` as `sr-designgen` at the same time.

### Viewing (the human)
```bash
D=/home/sr-designgen/sr-design-image-poc/wagashi-XXXXXX      # the directory printed after POC_IMAGE_READY
sudo cat "$D/report.json"                                     # direction_version must be "v2"
sudo install -m 0644 "$D/mockup.png" /mnt/c/Users/<WindowsUser>/Desktop/kakuu-kaan-mockup-v2.png
```

Open `kakuu-kaan-mockup-v2.png` on the Windows desktop and upload it (and `report.json`) into the Claude session only. Do not publish or commit it. Delete the desktop copy after the review (`sudo rm -r "$D"` removes the original).

### Evaluation (第2案 is not done because an image exists)
Claude scores the uploaded image with the rubric in [`design-image-eval-template.md`](design-image-eval-template.md) (5 criteria × 1–5, target **≥ 22/25 with no criterion below 4**, plus hard-fail checks: invented facts, store / people imagery, a missing or altered disclosure, a logo, garbled shop facts), and the human confirms the score. DEV-075 is done only when a human-run image passes. The rubric applies to this PoC only; no existing quality gate, threshold or CI check changes.

### Reusable wagashi assets (design only)
How the wagashi visuals could later be made as standalone, reviewed image assets (one Codex call per asset, each with its own approval) is designed in [`design-image-assets.md`](design-image-assets.md). Nothing of it is implemented; this PoC stays at exactly one Codex call, and cropping visuals out of the comp is for internal reference only.

## Checks in this container (no Codex)
`tests/unit/design-agent/design-image-poc.test.ts` (fake sandbox playing the Codex CLI): refusal without the flag (no file access, no sandbox) and without the shell token; the wrapper's STOP before preflight / lock / git / npm / tsx, its env allowlist, budget cap and lock; the happy path; no thread; no image; invalid PNGs (bad CRC, truncated, trailing data, too small, too large, a link); quota; timeout; sign-out (not from the model's words); API-key sign-in; cleanup (session log, new image dirs only, work dir, also on a signal); output permissions 0700 / 0600 outside the repo; report with codes and numbers only; the prompt's content and no environment in it; nothing else reads the output root.
