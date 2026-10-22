# Design image PoC — 架空菓庵 (local only, DEV-074 / 第2案 DEV-075)

> **第2案 (v2) is the default since DEV-075** — see [第2案](#第2案-v2-dev-075) below for the policy change of 2026-10-21 (AI concept
> visuals of the wagashi allowed, store and people imagery still forbidden), the run (HUMAN-019), the viewing steps and the evaluation rubric.
> `SR_DESIGN_IMAGE_POC_DIRECTION=v1` still runs the first PoC unchanged. Everything below about the wrapper, the jail, the cleanup and the stop codes applies to both.

> **DEV-077 (2026-10-21):** the HUMAN-019 v2 run stopped with `CODEX_NO_IMAGE`. Every run now leaves [diagnostics](#diagnostics-dev-077)
> (`POC_DIAG` / `POC_DIAG_SUMMARY`, fixed codes and numbers only) and the v2 prompt was tightened ([below](#what-the-v2-prompt-asks-for)).
> The next v2 run is HUMAN-020.

> **DEV-078 (2026-10-21):** HUMAN-020 (v2, cae33e8) stopped with `CODEX_NO_IMAGE` again (exit 0, `image_tool=0/0`, one 32-char answer).
> In Codex CLI 0.163.0 `codex exec --json` never shows the image tool, and a failed image call returns to the model as text, so
> that summary could not tell "not offered / not called / failed / refused" apart. Each run now has a model-free
> [preflight](#preflight-dev-078) and reads the CLI's own session log **in memory** before the cleanup removes it
> ([why](#why-the-image-tool-was-not-used-dev-078), [new codes](#stop-classes-dev-078)). The prompt is unchanged. Next: HUMAN-021 (local check → v1 re-run → v2).

> **DEV-080 (2026-10-21):** HUMAN-021a found **Codex CLI 0.159.0** on the machine (`.env` absent, no `config.toml` line, bundled models with
> `['text','image']`). Read at that version, `codex exec` writes its session log in the **paginated** history mode (not legacy:
> no `image_generation_end`; the tool's end record is an `item_completed` **Extension** item), and every bundled model but `gpt-5.5`
> is **code-mode-only** (imagegen is called from JavaScript inside an `exec` cell; there is no `function_call imagegen`). DEV-078's
> parsing read neither, so it could report `TOOL_NOT_CALLED` for a call it could not see. Fixed: [DEV-080](#codex-cli-01590-paginated-history-and-code-mode-dev-080).
> A new outcome `TOOL_NOT_SEEN_CODE_MODE` (class `inconclusive`) replaces "not called" where the log cannot tell. Nothing about the run changed (no `-m`).

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

Every run that reached the output root (success or stop) also leaves `diag-XXXXXX/diagnostics.json` next to it, fixed codes and numbers only ([Diagnostics](#diagnostics-dev-077)).

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
| `CODEX_QUOTA` | ChatGPT plan usage limit / busy (stderr / the CLI's error events), or (DEV-078) the image tool's own `image_gen` usage limit in the session log: try another day |
| `CODEX_TIMEOUT` | the call passed 15 min |
| `CODEX_EXEC_FAILED`, `CODEX_NO_THREAD`, `CODEX_NO_IMAGE`, `CODEX_IMAGE_INVALID` | no acceptable image; no result dir (only `diag-XXXXXX/`). Read `POC_DIAG_SUMMARY` ([Diagnostics](#diagnostics-dev-077)) |
| `CODEX_IMAGE_UNSUPPORTED_FORMAT` | the thread's dir holds a regular JPEG / WebP / GIF file (judged by its name; a link is ignored) but no PNG: never converted or accepted (DEV-077) |
| `CODEX_DOTENV_PRESENT` | `$CODEX_HOME/.env` exists (DEV-078; since DEV-079 also refused by the jail before every Codex process): Codex would load it into its own environment (only `CODEX_*` keys are filtered), which can carry an API key past the env allowlist. Codex not started; the file is never opened. Remove or move it as `sr-designgen` (`design-worker-wsl.md`, `CODEX_DOTENV_PRESENT`) |
| `CODEX_PREFLIGHT_FAILED` | `codex --version` inside the jail did not run cleanly (DEV-078); no model call was made |
| `CODEX_IMAGE_TOOL_FAILED` | the CLI's session log shows the image tool was called and failed (not a usage limit: that is `CODEX_QUOTA`); `img_fail=` says `POLICY` / `OTHER` (DEV-078) |
| `POC_STOPPED_BY_SIGNAL`, `POC_KILLED_OR_TIMED_OUT`, exit 137 / 124 | check for an OOM kill first (the wrapper prints `--oom-check`) |

## Diagnostics (DEV-077)

Why: the HUMAN-019 run (v2) stopped with `CODEX_NO_IMAGE` and nothing said whether Codex never called the image tool, the image
went somewhere else, the tool failed, or the turn was cut short. Every run that got as far as the output root now leaves
`~/sr-design-image-poc/diag-XXXXXX/diagnostics.json` (dir 0700, file 0600) — on success and on every stop, also on a signal or the
watchdog — and prints two lines before the final status:

```
POC_DIAG: /home/sr-designgen/sr-design-image-poc/diag-AbC123/diagnostics.json
POC_DIAG_SUMMARY code=CODEX_NO_IMAGE dir=v2 prompt_chars=6801 codex=1 exit=0 thread=1 image_tool=0/0 agent_msgs=1 agent_chars=812 reasoning=1 cmds=0 other_items=0 errors=0 error_codes=- turn=completed gen_dir=1 thread_dir=0 images_thread=0 thread_png=0 thread_other=0 images_other=0 other_dirs=0 cwd_images=0 home_images=0 unparsed=0 trunc=0 ms=184233 codex_ms=181020 first_event_ms=1450 image_tool_ms=-
```

**What it contains — only fixed codes, booleans and numbers** (`lib/design-agent/design-image/diagnostics.ts`):
- the outcome and stop code, the direction version, the prompt length in chars, the commit
- Codex: whether the exec call was made (the jail's probe runs first), exit code or signal, timed out, whether a thread id came
- timings in ms: total, the Codex call, time to the first JSON event, time to the first image-tool event
- counts of `codex exec --json` event types (`thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error`) and item types started / completed (`agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error`, and the image-tool spellings `image_generation`, `image_generation_call`, `image_gen`, `imagegen`, `generate_image`); any other name counts as `other`
- whether an image-tool item started / completed (from the item type only), the number of agent messages and their total length (never the text), error events / error items and their **codes** (`SIGNED_OUT`, `QUOTA`, `POLICY`, `IMAGE_TOOL`, `OTHER`, classified from the CLI's own error text, which is never kept), how the turn ended (`completed` / `failed` / `none`)
- where image files are, counted right **before** the cleanup (which removes exactly what it removed before): whether `CODEX_HOME/generated_images` and the thread's dir exist; files in the thread's dir by extension class (png / jpg / webp / gif / other), nested dirs and links in it; new dirs under `generated_images` not named after the thread and their files; image-like files under the work dir; image-like files written during the run elsewhere in `CODEX_HOME`

**Never recorded or printed:** the prompt, Codex's answer or error text, stdout / stderr, the sign-in, session-log contents, any path inside `CODEX_HOME`, file or dir names, the thread id, environment values. Tests plant a canary in the prompt, the answer, error messages, stderr, file names and an env var and assert it never appears in `diagnostics.json` or stdout.

**Reading `POC_DIAG_SUMMARY`** (`-` = not known at that point):

| what you see | case | meaning |
|---|---|---|
| `image_tool=0/0 agent_msgs≥1 turn=completed images_thread=0 images_other=0` | (a) **or (c)** | **DEV-078 correction:** with Codex CLI 0.163.0 `image_tool` is always `0/0` (exec `--json` has no image item), so this row alone does not mean "never called". Read `outcome=` / `img_calls=` (below) |
| `thread_dir=0` or `images_thread=0`, but `images_other>0`, `thread_other>0` (nested dir), `cwd_images>0` or `home_images>0` | (b) | the tool wrote an image somewhere this PoC does not take it from; send the summary, the location rule needs a reviewed fix |
| `code=CODEX_IMAGE_UNSUPPORTED_FORMAT` / `thread_png=0` with `images_thread>0` (`images_thread` counts png + jpg + webp + gif) | (b) | another format; never converted |
| `image_tool=1/0` or `errors>0` with `error_codes=POLICY` / `IMAGE_TOOL` / `QUOTA` | (c) | the tool was called but failed or was refused (`agent_msgs` then usually holds the tool's error, which is not recorded) |
| `turn=failed`, `turn=none`, `exit≠0`, `exit=SIGKILL`, `code=CODEX_TIMEOUT` / `POC_STOPPED_BY_SIGNAL` / `POC_RUN_TIME_BUDGET` | (d) | the turn failed or was cut short (on a signal or the watchdog the summary carries that code, the same as `POC_STOP`) |
| `unparsed=N` | any | stdout lines that were not a JSON object (a line over 1 MiB is dropped and counted here once) |
| `trunc=1` | any | the counts are lower bounds: a stdout line over 1 MiB was dropped, or a directory walk hit its 20 000-entry limit |

Note (DEV-078, settled): in Codex CLI 0.163.0 `codex exec --json` has no image-generation item at all, so `image_tool=0/0`
never proves the tool was not called. The session-log fields below decide.

### DEV-078 fields (schema `sr-design-image-poc-diagnostics/2`; `/3` since DEV-080)

`diagnostics.json` gains `preflight`, `session` and `classification`; `POC_DIAG_SUMMARY` gains
`cli= dotenv= model= provider_openai= log= img_calls= img_ok= img_failed= img_fail= other_calls= outcome= answer= class=`.
DEV-080 (schema `/3`) adds `hist= tool_mode= cm_cells= cm_ref=` after `log=` (`session.history_mode`, `tool_mode`,
`code_mode_cells`, `code_mode_imagegen_ref`).

| field | from | meaning |
|---|---|---|
| `cli` | `codex --version` in the jail (preflight), else the session log's `cli_version` | the Codex CLI version, only when it has the shape of a version |
| `dotenv` | `lstat $CODEX_HOME/.env` (never opened) | 1 stops the run (`CODEX_DOTENV_PRESENT`) |
| `model`, `provider_openai` | the session log's `turn_context.model` / `session_meta.model_provider` | the model slug (`other` if it does not look like an OpenAI model name) and whether the provider was `openai` |
| `log` | the session log of this thread exists (regular file, not a link) | 0: nothing below can be known (`outcome=NO_SESSION_LOG`) |
| `hist` (DEV-080) | `session_meta.history_mode` | `paginated` (what `codex exec` writes), `legacy`, `other` (any other string), `-` (not recorded) |
| `tool_mode` (DEV-080) | the model slug against a fixed list from the 0.159.0 bundled catalog (never read at runtime) | `direct` (`gpt-5.5`: imagegen is a direct function tool), `code_mode_only` (every other bundled slug), `unknown` (any other slug) |
| `cm_cells`, `cm_ref` (DEV-080) | `response_item` `custom_tool_call` name `exec` (code-mode cells; no longer counted in `other_calls`); whether any cell's input contains `image_gen__imagegen` (matched in memory, the input is never kept) | the model ran JavaScript cells, and whether one named the image tool |
| `img_calls`, `img_ok`, `img_failed` | distinct call ids from: `response_item` `function_call` name `imagegen` namespace `image_gen` (direct mode), `event_msg` `item_completed` with `item.type = "Extension"`, `item.kind = "image_gen.generation"` (paginated history, also for a call from a code-mode cell: `item.id` is the call id), `event_msg` `image_generation_end` (legacy history), or the older `image_generation_call`; and the `function_call_output` of a direct call | how often the image tool was called and how each call ended |
| `img_fail` | the CLI's failure record (`failure.type = usageLimitExceeded` on the Extension item or on `image_generation_end`) first, else the tool output matched in memory | `USAGE_LIMIT`, `POLICY`, `OTHER` (see the precedence below) |
| `other_calls` | other tool calls in the session log (count only; code-mode `exec` cells are `cm_cells`) | e.g. the model ran a shell command instead |
| `outcome` | the above | `IMAGE_SAVED`, `NO_SESSION_LOG`, `TOOL_NOT_CALLED`, `TOOL_NOT_SEEN_CODE_MODE` (DEV-080), `TOOL_FAILED_USAGE_LIMIT`, `TOOL_FAILED_POLICY`, `TOOL_FAILED`, `TOOL_CALLED_NO_FILE` |
| `answer` | the model's final answer, matched in memory against fixed patterns | `TEXT_NONE`, `TEXT_TOOL_UNAVAILABLE`, `TEXT_TOOL_ERROR`, `TEXT_USAGE_LIMIT`, `TEXT_REFUSAL`, `TEXT_OTHER` — informational: a machine state is never decided from it |
| `class` | `pocStopClass` (run.ts) | see [Stop classes](#stop-classes-dev-078) |

**Precedence per image call** (`readSessionFacts`, independent of the order of the records; `codex exec` 0.159.0 / 0.163.0 writes,
in direct mode, `function_call` → `item_completed` Extension → `function_call_output` (paginated history; a legacy-history log has
`image_generation_end` where the Extension item is), and in code mode `custom_tool_call` exec → `item_completed` Extension →
`custom_tool_call_output`, with no `function_call` at all): (1) a structured `failure` object on the CLI's
end record (the Extension item or `image_generation_end`) decides *failed* and its code (`usageLimitExceeded` → `USAGE_LIMIT`, any other type → `OTHER`) and nothing overrides it;
(2) else the CLI's end `status` (`completed` / `failed`; `in_progress` is ignored) decides the status and wins over the shape of the tool output — so
`end(completed)` with an output that carries no image counts as completed (`outcome=TOOL_CALLED_NO_FILE`); (3) else the output's
shape decides (an image content item → completed, none → failed). A failed call without a structured failure takes `USAGE_LIMIT`
or `POLICY` from the tool output's text when it names one; any failed call still without a code becomes `OTHER`, only at the end.
**Mixed results** (several image calls): `img_fail` lists every failed call's code; `outcome` is `IMAGE_SAVED` whenever a PNG was
taken, otherwise any failed call makes it `TOOL_FAILED_*` (`USAGE_LIMIT` before `POLICY` before `OTHER`) even if another call completed.
`log=1` with `outcome=NO_SESSION_LOG` means the log was found but not usable: `truncated` (over 64 MiB, or the walk of the session
dirs hit 20 000 entries) or `unreadable` (could not be opened, or its real path leaves `CODEX_HOME`); a symlinked
`sessions` / `archived_sessions` dir is never walked. On a signal before the thread id came, the log is found by this run's own
work dir (as the cleanup finds it), never another call's.

Reading HUMAN-021's runs (corrected by DEV-080; check `cli=0.159.0 hist=paginated` and `tool_mode=` first):

| what you see | meaning |
|---|---|
| `outcome=TOOL_FAILED_USAGE_LIMIT` (stop `CODEX_QUOTA`) | the image tool's own `image_gen` usage window (structured failure on the Extension item); wait, do not re-run the same day |
| `outcome=TOOL_FAILED` / `TOOL_FAILED_POLICY` (stop `CODEX_IMAGE_TOOL_FAILED`) | the tool ran and failed (`img_fail`); in code mode `cm_ref=1` and `img_calls≥1` with no `function_call` is normal |
| `outcome=TOOL_NOT_SEEN_CODE_MODE` (class `inconclusive`) | no image call is visible, but imagegen was reachable only from code-mode `exec` cells (`cm_cells>0` or `tool_mode=code_mode_only`). A call refused before the tool started (argument validation) leaves no record, and the tool list is not in a 0.159.0 log, so it is **not known** whether the model tried. `cm_ref=1` says a cell at least named `image_gen__imagegen`. Not a prompt verdict; see the [`-m gpt-5.5` proposal](#proposal-not-applied-a-direct-mode-model) |
| `outcome=TOOL_NOT_CALLED` | trustworthy **only** with `tool_mode=direct` (or `unknown`) **and** `cm_cells=0`: imagegen was a direct tool and no call was made. With `answer=TEXT_TOOL_UNAVAILABLE` the tool was most likely not offered (compare with HUMAN-021a); with `TEXT_OTHER` / `TEXT_REFUSAL` the model chose text: a prompt question |

Still never recorded or printed: the session log's content (prompt, answer, tool arguments and output, base64 image, base
instructions), any path or file name, the thread id. The session log is read in memory (≤ 64 MiB, `O_NOFOLLOW`, regular files
only) and removed by the cleanup exactly as before. Tests plant a canary in the prompt, the answer, the tool's arguments and
output, the base instructions, the model name, the CLI version and `.env`, and assert none reaches `diagnostics.json` or the summary.

### Preflight (DEV-078)

Before the one model call, in the same jail with the same environment allowlist: (1) `$CODEX_HOME/.env` must not exist
(`lstat` only), **checked first, before any Codex process** — every `codex` invocation, `--version` and `login status`
included, first runs arg0's setup: `load_dotenv` reads `$CODEX_HOME/.env` into Codex's own environment (only `CODEX_*` keys are
filtered) and the arg0 alias setup writes under `CODEX_HOME`, all before clap parses the arguments; (2) `codex --version`
(after that arg0 setup, clap prints the version and exits before config, sign-in or network; no model call, no plan usage). `codex features list` and `codex debug models` are **not** run automatically: they load Codex's config, which can
fetch a cloud config bundle over the network (`codex-rs/cli/src/cloud_config.rs`), so they are a human, local step (HUMAN-021a;
`codex debug models --bundled` reads only the catalog in the binary).
`exec` also gets `-c features.image_generation=true`: the image tool's feature flag (stable, default on in 0.163.0) pinned on
the command line so a `config.toml` cannot switch it off; `config.toml` itself is never changed, and an older CLI only warns
about an unknown feature key. Nothing about the sandbox (`--sandbox read-only`, the jail) or the network changes.

### Stop classes (DEV-078)

For a later automated worker (`pocStopClass` in `run.ts`). **No class retries the same request automatically**; each run
is still exactly one model call.

| class | codes | what automation does |
|---|---|---|
| `approval`, `input` | `POC_NOT_APPROVED`, `POC_INPUT_INVALID`, `POC_DIRECTION_INVALID` | nothing was started; fix the request |
| `environment` | `CODEX_QUOTA`, `CODEX_NOT_SIGNED_IN`, `CODEX_API_KEY_AUTH`, `CODEX_SANDBOX_*`, `CODEX_NOT_INSTALLED`, `CODEX_DOTENV_PRESENT`, `CODEX_PREFLIGHT_FAILED`, `POC_OUTPUT_UNSAFE` | halt the whole queue and alert a human; no further model call until fixed (quota: after the reset) |
| `capability` | `CODEX_IMAGE_TOOL_FAILED` (also `outcome=TOOL_FAILED_UNSUPPORTED`, DEV-081); `CODEX_NO_IMAGE` with `outcome=TOOL_NOT_CALLED answer=TEXT_TOOL_UNAVAILABLE` | halt and alert; the human runs HUMAN-021a's local checks. The model's words may choose this class only because it halts and never loosens anything |
| `transient` (DEV-081) | `CODEX_IMAGE_TOOL_FAILED` with `outcome=TOOL_FAILED_TRANSIENT` (every failed call was 5xx / timeout / connection, from Codex's own error text) | halt and alert; nothing is retried automatically. A human may approve one new run later; read `img_fail_reason` / `img_http` first |
| `inconclusive` (DEV-080) | `CODEX_NO_IMAGE` with `outcome=TOOL_NOT_SEEN_CODE_MODE`, whatever the answer | halt and alert; the log cannot say whether the model tried the tool (code mode). Never read as a prompt failure, never retried; a human decides the next step (e.g. the direct-mode proposal below) |
| `request` | `CODEX_NO_IMAGE` (otherwise), `CODEX_NO_THREAD`, `CODEX_EXEC_FAILED` | a failure of this request with its code; never re-sent unchanged (a changed prompt is a new, reviewed request) |
| `output` | `CODEX_IMAGE_INVALID`, `CODEX_IMAGE_UNSUPPORTED_FORMAT` | the image is refused; never converted |
| `interrupted` | `CODEX_TIMEOUT`, `POC_STOPPED_BY_SIGNAL`, `POC_RUN_TIME_BUDGET`, `POC_UNEXPECTED` | check for an OOM kill first; then treat as `request` |

### Why the image tool was not used (DEV-078)

Research without running Codex (sources: the openai/codex repository at tag `rust-v0.163.0`, the current npm `latest`
published 2026-10-15, and the `@openai/codex@0.163.0-linux-x64` package read as data, never executed):

- **The tool.** `image_gen.imagegen`, an extension function tool (`codex-rs/ext/image-generation/src/lib.rs`:
  `IMAGE_GEN_NAMESPACE = "image_gen"`, `IMAGEGEN_TOOL_NAME = "imagegen"`), backed by the images API with `gpt-image-2`
  through the ChatGPT sign-in (`tool.rs`: `IMAGE_MODEL`). The bundled `imagegen` skill says the built-in tool "Does not require `OPENAI_API_KEY`".
- **Feature flag.** `image_generation`, `Stage::Stable`, `default_enabled: true` (`codex-rs/features/src/lib.rs`); legacy alias `imagegenext`.
- **When it is offered to the model** (`codex-rs/core/src/tools/spec_plan.rs` `image_generation_available`): the flag is on, the
  ChatGPT plan is **not Free**, the provider's capabilities include image generation, the model's `input_modalities` include
  images, and the provider uses OpenAI auth with the Codex (ChatGPT) backend. The extension is only installed for an OpenAI
  provider (`ext/image-generation/src/extension.rs`; we pass `-c model_provider="openai"`). Nothing depends on `exec` vs the TUI or on `--sandbox read-only`.
- **`codex exec --json` does not show it.** `exec/src/exec_events.rs` has item types `agent_message`, `reasoning`,
  `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error` only, and
  `exec/src/event_processor_with_jsonl_output.rs` maps every other item to `None`. DEV-077's `image_tool` counter therefore stays 0.
- **A failure goes to the model, not to an error event.** `tool.rs` returns `FunctionCallError::RespondToModel("image generation failed: …")`;
  a usage limit with `limit_id == "image_gen"` is recorded as `ImageGenerationFailure::UsageLimitExceeded` on the item. The turn
  completes with exit 0, and the v2 prompt's last TASK line asks the model to answer with that error. OpenAI support confirmed
  on 2026-10-02 that some `gpt-image-2-codex` rate-limit failures come back "inside an HTTP 200 response"
  (community.openai.com/t/…/1382726), i.e. not as a 429 our quota check would see.
- **Where the file goes.** `<save_root>/generated_images/<thread>/<call_id>.png` (`ext/image-generation/src/artifact.rs`), written
  by the CLI itself (not a sandboxed command), as the PoC already expects.
- **What the session log keeps.** `rollout/src/policy.rs` persists `session_meta` (incl. `cli_version`, `model_provider`,
  `history_mode`), `turn_context` (incl. `model`), `function_call` / `function_call_output` and `custom_tool_call` /
  `custom_tool_call_output`. **Corrected by DEV-080:** `image_generation_end` is kept only in the *legacy* history mode, and
  `codex exec` does not use it — it writes *paginated* history, where the tool's status and failure are on an `item_completed`
  Extension item ([below](#codex-cli-01590-paginated-history-and-code-mode-dev-080)). The log does **not** list the tools
  offered to the model, so "not offered" vs "offered but not called" is inferred (no call + the answer's code + HUMAN-021a), not read.
- **Version.** No stable Codex CLI was published between HUMAN-018 and HUMAN-020 (all on 2026-10-21; `latest` 0.163.0 since
  2026-10-15), so a CLI update between the runs is unlikely unless the machine runs an alpha. Plan-side usage windows and the
  server-side model catalog can change without a CLI update. **DEV-080:** HUMAN-021a found the machine on 0.159.0 (2026-09-29);
  the parts read here are the same at that tag ([below](#codex-cli-01590-paginated-history-and-code-mode-dev-080)).
- **The v2 escape-hatch line** ("If the image generation tool cannot be used, do not use any substitute; answer only with the
  error it returned.") is a faithful English rendering of curiosity-media's daily-working line
  (「画像生成ツールが使えないときは、代替手段を取らずに、返ってきたエラーをそのまま答えてください。」, `entry-image.ts` /
  `kaii-body-images.ts`); v1 has no such line. It only shapes the answer when the tool is missing or failed, so it explains the
  short answer, not the missing image. The prompt is left unchanged until HUMAN-021 separates the causes.
- Side finding: Codex loads `$CODEX_HOME/.env` into its own environment at start, filtering only `CODEX_*` keys
  (`codex-rs/arg0/src/lib.rs` `load_dotenv`), so an `OPENAI_API_KEY` there would bypass the env allowlist. The PoC now refuses
  to start when that file exists. Before DEV-079 the design worker's Codex calls (`lib/design-agent/codex.ts`: `assertChatGptSignIn`,
  `runCodexJson`, used by the production worker) did not check it, so a `.env` in `sr-designgen`'s CODEX_HOME could feed an
  API key or base URL to them. **DEV-079** closes this: the check lives in `lib/design-agent/codex-dotenv.ts` (re-exported by
  `codex.ts` and `capability.ts`) and the jail's `run()` (`sandbox.ts`) refuses every Codex process while the file exists
  (before the probe, again right before the spawn, and after Codex ends: then its result is thrown away), for the worker, photos, compare, design-demo and this PoC alike. The
  PoC's own preflight still runs first and records `dotenv=1`; a `.env` that appears after it is refused by the jail with the
  same `CODEX_DOTENV_PRESENT` (then `dotenv=0` in the diagnostics: the preflight saw none; `codex=0` when refused before the
  spawn, `codex=1` when found after Codex ended). Checked on the machine's version too (openai/codex `rust-v0.159.0`,
  `codex-rs/arg0/src/lib.rs`): line 164 calls `load_dotenv()` in `arg0_dispatch`; lines 308–310 read only
  `find_codex_home()`/`.env` with `dotenvy::from_path_iter`; line 302 `ILLEGAL_ENV_VAR_PREFIX = "CODEX_"`, line 322 the
  case-insensitive filter. No `dotenvy::dotenv()` (a walk up from the cwd) in that file, so `$CODEX_HOME/.env` is the one file. Removing it: `design-worker-wsl.md`
  (`CODEX_DOTENV_PRESENT`). The diagnostics dirs stay in the output root (repo-external, never published); delete them with `sudo rm -r` when done.

### Codex CLI 0.159.0, paginated history and code mode (DEV-080)

HUMAN-021a (2026-10-21) returned: `.env: absent`, `codex-cli 0.159.0`, `config.toml: no matching line`, and the bundled models
with `['text','image']`. 0.159.0 was released on 2026-09-29. Research without running Codex: the openai/codex repository at tags
`rust-v0.159.0` and `rust-v0.163.0`, read as data. The behaviour relevant here is **identical in both versions**:

- **The rollout wire format** is the same: one JSON object per line, `{"timestamp", "type": "session_meta" | "turn_context" |
  "response_item" | "event_msg", "payload": …}`. Unchanged and still read as before: `session_meta.cli_version` /
  `model_provider`, `turn_context.model`, `function_call {name, namespace, call_id}`, a function output as a plain string or an
  array with `input_image` / `input_text`, the image path `<CODEX_HOME>/generated_images/<thread>/<call_id>.png`, and
  `codex --version` printing `codex-cli 0.159.0` (`parseCodexVersion` accepts it, tested).
- **`codex exec` asks for paginated history, not legacy.** `exec/src/lib.rs` (≈ line 1380): `history_mode:
  (!config.ephemeral).then_some(ThreadHistoryMode::Paginated)`; when the server rejects paginated threads, exec drops the
  request and falls back to legacy history (≈ lines 1346–1351). So a run's log can be either, and **both are parsed**
  (`hist=` says which); `session_meta.payload.history_mode` is `"legacy"` or `"paginated"`. In paginated mode `rollout/src/policy.rs` (≈ 121–134) drops
  `ImageGenerationEnd` and keeps `ItemCompleted` events with the TurnItem, serialized as
  `{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Extension","kind":"image_gen.generation","id":<call_id>,
  "status":"completed|failed|in_progress","failure":{"type":"usageLimitExceeded","limitId":"image_gen","resetsAt":…}|…, …}}}`
  (TurnItem `#[serde(tag = "type")]` variant `Extension`; ExtensionItem `#[serde(tag = "kind")]`, rename `image_gen.generation`).
  The Extension item is **camelCase** (ImageGenerationItem `rename_all = "camelCase"`) while the legacy `image_generation_end`
  is snake_case; only `type`, `kind`, `id`, `status` and `failure.type` are read, and none of those differ between the two.
  The item can also carry `revisedPrompt`, `result` (the base64 image) and `savedPath`; **none of them is ever recorded** (tested
  with canaries). DEV-078 only accepted an `item.type` like `image_generation`, so on the default path the structured status and
  failure were never read.
- **Code mode.** In the 0.159.0 bundled catalog (`codex-rs/models-manager/models.json`) every model except `gpt-5.5`
  (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-daybreak-blue-latest`,
  `gpt-daybreak-red-latest`, `codex-auto-review`) has `"tool_mode": "code_mode_only"`, and the PoC passes no `-m`. A model's own
  `tool_mode` takes precedence over the features (`core/src/tools/mod.rs` ≈ 74–84 `requested_tool_mode`; `code_mode` /
  `code_mode_only` are off by default in `features/src/lib.rs`, so `gpt-5.5` is direct). In code-mode-only, direct tools such as
  imagegen are hidden; they can only be called from JavaScript inside the `exec` custom tool as `image_gen__imagegen`
  (`tools/src/code_mode.rs` ≈ 230–242). The log then has `response_item` `custom_tool_call` name `exec` plus
  `custom_tool_call_output`, and **no** `function_call imagegen` / `function_call_output`. The extension still writes the
  Extension item above for a call that started; a call that fails argument validation before it started leaves **no** item.
- **The tool list is not in the log.** 0.159.0 does not persist the tools offered to the model (that persistence began in 0.162),
  so "not offered" can still not be read from the log.
- **0.160–0.163.** Their release notes contain no image-generation change; the files above were compared at both tags.

**What changed in the PoC** (`capability.ts`, `diagnostics.ts`, `run.ts`): the Extension item is read as the structured end
record (keyed by `item.id`, the same precedence as `image_generation_end`, which is still read for a legacy log); an Extension
item without a `function_call` counts as a call (`img_calls` = distinct call ids from `function_call`, the Extension item or
`image_generation_end`); `hist=`, `tool_mode=`, `cm_cells=`, `cm_ref=` are recorded; no image call seen with `cm_cells>0` or
`tool_mode=code_mode_only` is `TOOL_NOT_SEEN_CODE_MODE` (class `inconclusive`), never `TOOL_NOT_CALLED`. The session log is read
line by line from the capped buffer (≤ 64 MiB, a large base64 line is parsed once and dropped) and still removed by the cleanup.
Unchanged: the command line, the jail, sign-in, `run.lock`, the env allowlist, the budget, the cleanup, the PNG checks, exactly
one model call without retry, both prompts byte for byte.

**Outcome table** (no PNG taken; `log=1`, not truncated or unreadable):

| `img_calls` | `cm_cells` / `tool_mode` | failures | `outcome` | stop code | class |
|---|---|---|---|---|---|
| 0 | `cm_cells=0` and `tool_mode` `direct` / `unknown` | – | `TOOL_NOT_CALLED` | `CODEX_NO_IMAGE` | `request` (`capability` with `answer=TEXT_TOOL_UNAVAILABLE`) |
| 0 | `cm_cells>0` or `tool_mode=code_mode_only` | – | `TOOL_NOT_SEEN_CODE_MODE` | `CODEX_NO_IMAGE` | `inconclusive` (whatever the answer) |
| ≥ 1 | any | any `USAGE_LIMIT` | `TOOL_FAILED_USAGE_LIMIT` | `CODEX_QUOTA` | `environment` |
| ≥ 1 | any | `POLICY` (no usage limit) | `TOOL_FAILED_POLICY` | `CODEX_IMAGE_TOOL_FAILED` | `capability` |
| ≥ 1 | any | `OTHER` only | `TOOL_FAILED` | `CODEX_IMAGE_TOOL_FAILED` | `capability` |
| ≥ 1 | any | none, no file | `TOOL_CALLED_NO_FILE` | `CODEX_NO_IMAGE` | `request` |

A PNG taken is always `IMAGE_SAVED`; `log=0`, `truncated` or `unreadable` is `NO_SESSION_LOG`.

Note: a `code_mode_only` model with `cm_cells=0` is also reported as `TOOL_NOT_SEEN_CODE_MODE` (`inconclusive`), although zero
exec cells means the model did not call the tool in that turn (in code mode it can reach imagegen only from a cell). This is the
conservative choice: `tool_mode` is a slug-based hint, not a reading of the tools actually offered, so the PoC does not turn it
into a "not called" verdict. Read `tool_mode=code_mode_only cm_cells=0` as "the model wrote no code cell at all".

#### Proposal (not applied): a direct-mode model

Option: add `-m gpt-5.5` to the one `codex exec` so that imagegen is a **direct** tool (`gpt-5.5` has no `tool_mode` in the
0.159.0 catalog and the code-mode features are off by default; a model's own `tool_mode` wins over features,
`core/src/tools/mod.rs` ≈ 74–84). The log would then show a `function_call imagegen` for every call, and `TOOL_NOT_CALLED`
would be conclusive. This changes which model runs (behaviour, quality and plan usage), so it **needs human approval** and its
own small PR; DEV-080 does not add `-m` or any other model / config override. Ask for it only if HUMAN-021b ends
`TOOL_NOT_SEEN_CODE_MODE`.

To send back (no secrets inside): the `POC_STOP` line and the `POC_DIAG_SUMMARY` line, or `sudo cat <POC_DIAG path>`.

### Why a called image tool failed: HUMAN-021b and DEV-081

**HUMAN-021b (2026-10-22, develop c3fa813, v1, Codex 1 call):** `cli=0.159.0`, model `gpt-6.1-sol` (not in the 0.159.0 bundled
catalog, so `tool_mode=unknown`), prompt 4 754 chars, `hist=paginated cm_cells=1 cm_ref=1 img_calls=1 img_ok=0 img_failed=1
img_fail=OTHER` → `outcome=TOOL_FAILED`, stop `CODEX_IMAGE_TOOL_FAILED`, class `capability`, no image. The model called imagegen
from a code-mode cell and the images request failed. HUMAN-018 (same v1 prompt) had made an image.

Research (openai/codex `rust-v0.159.0`, read as data, never built or run; paths under `codex-rs/`):

- **Where a failure is recorded.** `ext/image-generation/src/tool.rs:145-258` `handle_call`: `parse_args` (:149, :602-605) and
  `request_for_call_args` (:150-152, :427-497) run **before** `emit_started` (:153-170). Their errors (`unknown field …`,
  `` `referenced_image_paths` must contain at most 5 paths ``, `` `num_last_images_to_include` must be between 1 and 5 ``,
  `provide only one of …`, `requested the last N conversation images, but only M were available`, `unable to read / process
  referenced image at …`, `referenced image paths are unavailable in this session`; :439-598) return
  `FunctionCallError::RespondToModel` and leave **no** item. After `emit_started` there are three endings:
  1. the images request fails (`backend.generate` / `edit`, :171-181): an item `{status:"failed", failure}` (:204-219) and
     `RespondToModel("image generation failed: <message>")` (:177, :220);
  2. the response has no image (:195-199): `failure: None`, message `image generation returned no image data`;
  3. success (:235-257): `status:"completed"`. A failed **save** to disk still ends `completed` with `savedPath` absent (:288-419).
- **The only failure variant.** `ext/items/src/image_generation.rs:7-20`: `ImageGenerationFailure` is `#[serde(tag = "type",
  rename_all = "camelCase")]` with exactly one variant, `UsageLimitExceeded { limitId, resetsAt }` →
  `{"type":"usageLimitExceeded","limitId":"image_gen","resetsAt":1761…|null}`. `failure` has `#[serde(default)]` and no
  `skip_serializing_if` (:36-37), so every other ending is written as `"failure": null`. `usage_limit_failure` (tool.rs:261-286)
  returns `Some` **only** for `CodexErrorDetails::UsageLimitReached` whose `rate_limits.limit_id == "image_gen"`; the limit id comes
  from the `x-codex-active-limit` header and defaults to `codex` when it is missing (`codex-api/src/rate_limits.rs:57-66`,
  `codex-api/src/api_bridge.rs:179-216`). So **a usage limit under another or a missing limit id is also `failure: null`**.
- **The message.** `ImageBackendError.message` is the un-mapped `ApiError`'s Display (`ext/image-generation/src/backend.rs:26-34`):
  `http 429 Too Many Requests: Some("<body>")` (`http-client/src/error.rs:13-20`), `timeout`, `connection failed: …`,
  `network error: …`, `request build error: …`, `retry limit reached`, `api error 400 Bad Request: …`, `stream error: failed to
  decode image generation response: …` (`codex-api/src/error.rs:9-52`, `codex-api/src/endpoint/images.rs:85-107`); provider / auth
  setup errors before the request (`backend.rs:79-96`). The HTTP client retries 429 / 5xx / transport errors itself per the
  provider's retry policy and returns the last error (`codex-client/src/retry.rs:22-41`, :84-117). No response-size limit is set
  for images (`codex-client/src/provider.rs:87`).
- **How it reaches the model.** Direct mode: `function_call_output` with the text (`core/src/tools/parallel.rs:303-327`). Code
  mode: the nested call's error becomes a string (`core/src/tools/code_mode/delegate.rs:455-461`; `RespondToModel` displays as
  the bare message, `tools/src/function_call_error.rs:5-10`) and **rejects the cell's JavaScript promise**
  (`code-mode-runtime/src/runtime/module_loader.rs:84-94`). It appears in the exec cell's `custom_tool_call_output` only if the
  script prints it or leaves it uncaught (`Script failed` + `Script error:\n<text>`, `core/src/tools/code_mode/mod.rs:260-298`;
  a string rejection is its own text, `runtime/value.rs:330-343`). A yielded cell's later output comes through the `wait` function
  tool (`code-mode-protocol/src/lib.rs:52-53`). The rollout keeps `custom_tool_call_output` and `function_call_output`
  (`rollout/src/policy.rs:42-60`) and, paginated, the `item_completed` Extension item (:94-111).
- **What DEV-080 mapped to OTHER.** Every ending 1–2 except an `image_gen` usage limit: the item's `failure: null` made
  `readSessionFacts` use the status only, and in code mode there is no `function_call_output` for the call, so no text was read.
  `img_fail=OTHER` therefore means: **the images request itself failed (after argument checks), and it was not an `image_gen`
  usage limit as Codex recognises one** — it may still be a 429 under another limit id, a 4xx (policy, not supported, auth,
  bad request), a 5xx / timeout / connection, a decode error or no image data. It is **not** an argument error (no item then).

**What DEV-081 records** (fixed values only; the text is matched in memory and dropped):

| field | values | from |
|---|---|---|
| `img_fail_type` | `usageLimitExceeded`, `other` (unknown type), `none` (`failure: null`), `no_record` (failed only by output shape) | the Extension item / `image_generation_end` |
| `img_fail_reason` | `USAGE_LIMIT`, `HTTP_429`, `HTTP_5XX`, `TIMEOUT`, `NETWORK`, `AUTH`, `NOT_SUPPORTED`, `POLICY`, `BAD_REQUEST`, `INVALID_ARGS`, `NO_IMAGE_DATA`, `BAD_RESPONSE`, `OTHER`, `NO_TEXT` | direct: the call's `function_call_output` (written by Codex); code mode: exec / `wait` outputs, from Codex's prefix `image generation failed:` / `… returned no image data` on. `NO_TEXT`: a failed call whose message was nowhere (the script caught it and printed nothing) |
| `img_fail_src` | `struct`, `fn_output`, `cell_error`, `cell_print`, `none` | where the code came from (review F1). **The cell's script can print anything, Codex's prefix included**, so in code mode only `cell_error` — Codex's own uncaught-error item of a failed cell: item 0 is Codex's header `Script failed\nWall time …` (`core/src/tools/code_mode/output.rs:27-33`) and the **last** item is the `Script error:\n…` Codex appends after the script's items (`code_mode/mod.rs:286-289`); the rollout keeps no `success` flag (`protocol/src/models.rs:2178, 2253-2262`) — may decide the code. `cell_print` (the text appears anywhere else, or Codex merged the items for size, `utils/output-truncation/src/lib.rs:58-81`) is only a recorded reason; the code stays `OTHER`, never `TRANSIENT` / `UNSUPPORTED` / `USAGE_LIMIT`. Residual: a script that `throw`s a string of its own puts that string in Codex's error item |
| `img_http` | integers 400–599 | `http NNN` / `api error NNN` in that text |
| `img_err` | an allowlisted API error code / type (`usage_limit_reached`, `moderation_blocked`, `model_not_found`, `usage_not_included`, `server_is_overloaded`, …) or `other` | `"code"` / `"type"` in the body |
| `cm_arg_err` | 0/1 | an argument error (above) in the output of an exec cell that named `image_gen__imagegen` (the call then leaves no item) |
| `effort` | `none` … `persistent`, `other` | `turn_context.effort` |
| `model_cache`, `model_cache_cli`, `model_cache_age_s`, `model_listed`, `model_tool_mode`, `model_image_input`, `tool_mode_src` | fixed | `$CODEX_HOME/models_cache.json` (below) |

Text rules (review F1 / F2): `POLICY` wins over `USAGE_LIMIT` when a text names both; for a 4xx status the timeout / network /
5xx rules are skipped (a 4xx is never transient: 408 and 4xx bodies that say "timeout" are `BAD_REQUEST`); `NOT_SUPPORTED` only
for 403 / 404, an allowlisted code (`model_not_found`, `unsupported_model`, `not_found_error`, `usage_not_included`) or, with no
HTTP status, ApiError's own `usage not included` — never from the words of a 400 body; 401 or an auth code is `AUTH`.

Coarse codes and outcomes (`img_fail`, `outcome`): `USAGE_LIMIT` (structured, or reason `USAGE_LIMIT` / `HTTP_429` — a generic
429 stays a usage window as DEV-078 read it) → `TOOL_FAILED_USAGE_LIMIT` / `CODEX_QUOTA`; `POLICY` → `TOOL_FAILED_POLICY`;
`UNSUPPORTED` (`NOT_SUPPORTED`) → **`TOOL_FAILED_UNSUPPORTED`** (class `capability`); `TRANSIENT` (`HTTP_5XX`, `TIMEOUT`, `NETWORK`)
→ **`TOOL_FAILED_TRANSIENT`** (class `transient`) only when every failed call was transient; anything else → `TOOL_FAILED`. Both new
outcomes stop as `CODEX_IMAGE_TOOL_FAILED`. The structured failure still decides the code; the text decides only when there is
none. No retry anywhere.

**Models cache.** `$CODEX_HOME/models_cache.json` (`models-manager/src/manager.rs:31`) is pretty JSON of `ModelsCacheEntry`
(`models-manager/src/cache.rs:63-84`): `fetched_at`, `etag`, `client_version`, `identity` (a SHA-256 over the account, email and
plan, `model-provider/src/models_identity.rs:13-57`), `models: ModelInfo[]` (with `slug`, `tool_mode` — `direct` / `code_mode` /
`code_mode_only`, snake_case, `protocol/src/openai_models.rs:344-350, :501` — `input_modalities` (default text + image when
absent, :186-192, :470-471), `priority`, `visibility`). It is rewritten whenever the catalog is fetched (TTL 300 s,
`manager.rs:32`, :519-545); the default model is the first picker-visible one by priority (`manager.rs:168-180`,
`protocol/src/openai_models.rs:1019-1031`), which is how `gpt-6.1-sol` was chosen without `-m`. The PoC now reads it after the
call, like the session log (O_NOFOLLOW, a regular file directly in CODEX_HOME, never a link, ≤ 8 MiB, in memory, never written),
and records only the fields above; when the model is listed **and the cache's `client_version` equals the session's CLI version**
its `tool_mode` replaces the slug hint (`tool_mode_src=cache`; `none` → `direct`, since the code-mode features are off by
default). A cache from another version is `model_cache=stale` (review F3: Codex itself ignores it, `cache.rs:200-208`) with no
`model_tool_mode` / `model_image_input`, and the slug hint stays. Never the identity, the ETag or any text.

Other local state that survives the PoC's cleanup (which deletes only `sessions/**/rollout-*.jsonl`): `state_5.sqlite` table
`threads` (`state/src/sqlite.rs:33`, `state/migrations/0001_threads.sql`, `0020` `model` / `reasoning_effort`, `0005`
`cli_version`, `0040` `history_mode`) and `thread_history_1.sqlite` tables `thread_items` / `thread_turns`
(`state/thread_history_migrations/0001`, `0002` `item_type`, `0007` timestamps), which a paginated thread projects on every
durable write (`thread-store/src/local/live_writer.rs:159-180`, :335-352; `thread_history.rs:425-470`: `item_json` is the
app-server `ThreadItem`, `item_type = "imageGeneration"`, with `status` and `failure`). Codex removes those rows only on an
explicit thread delete (`state/src/runtime/threads.rs:1152-1199`). `codex exec` writes no log DB (`exec/src/lib.rs:721`
`log_db: None`) and logs only errors to stderr by default (:251-257).

**Still not knowable locally:** the HTTP status or body of HUMAN-021b's failure (unless the model's script printed it — the next
run will tell, via `img_fail_reason`); the tools offered to the model (not in a 0.159.0 log); HUMAN-018's catalog (the cache is
overwritten); server-side quota state.

#### HUMAN-022 — read what HUMAN-018 and HUMAN-021b left in CODEX_HOME (0 Codex calls)

Local, no network, no model, no `codex` process. Inside the jail as `sr-designgen`, under the worker's run lock (no
worker run at the same time). It opens the two SQLite files with `mode=ro` (no row and no existing file is changed; but SQLite
may create empty `-wal` / `-shm` side files next to a WAL database when they are missing, so "nothing is written" is not
claimed; `immutable=1` is deliberately not used, it would skip locking), filters threads by the design agent's work dir
prefix, and prints **only** fixed fields: creation time (UTC, minutes), model slug, effort, CLI version, history mode, source,
whether the rollout file still exists, and per `imageGeneration` item `status/failure-type/duration`; then the models cache's
version, fetch time (only when it has the RFC 3339 shape, else `other`) and per model `slug visibility tool_mode image_input`. Never the thread id, cwd, title, first message, prompt,
`revisedPrompt`, result, path, identity or ETag.

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc '
S=~/.local/state/sr-design-worker; mkdir -p "$S" && chmod 700 "$S"
H="${CODEX_HOME:-$HOME/.codex}"
flock -n "$S/run.lock" python3 -I - "$H" <<"PY" || echo "STOP: a design worker run is in progress, or the read failed; nothing was changed"
import sys, os, json, re, sqlite3, datetime
H = sys.argv[1]
SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]{0,40}$").match
VER = re.compile(r"^\d{1,3}\.\d{1,4}\.\d{1,4}$").match
RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$").match
def pick(v, ok):
    if v is None:
        return "-"
    return v if isinstance(v, str) and ok(v) else "other"
def among(*names):
    return lambda v: v in names
def ts(sec):
    return datetime.datetime.fromtimestamp(sec, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ") if isinstance(sec, (int, float)) else "-"
def ro(name):
    p = os.path.join(H, name)
    if os.path.islink(p) or not os.path.isfile(p):
        print(name + ": absent")
        return None
    return sqlite3.connect("file:" + p + "?mode=ro", uri=True)
st = ro("state_5.sqlite")
th = ro("thread_history_1.sqlite")
rows = []
if st:
    cols = {r[1] for r in st.execute("PRAGMA table_info(threads)")}
    want = [c for c in ["created_at", "model", "reasoning_effort", "cli_version", "history_mode", "source"] if c in cols]
    q = "SELECT id, rollout_path, " + ", ".join(want) + " FROM threads WHERE cwd LIKE ? ORDER BY created_at"
    rows = [dict(zip(["id", "rollout"] + want, r)) for r in st.execute(q, ("%/sr-design-codex-%",))]
print("design-agent threads:", len(rows))
for i, d in enumerate(rows, 1):
    out = ["n=%d" % i, "created=" + ts(d.get("created_at")), "model=" + pick(d.get("model"), SLUG),
           "effort=" + pick(d.get("reasoning_effort"), among("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent")),
           "cli=" + pick(d.get("cli_version"), VER), "hist=" + pick(d.get("history_mode"), among("legacy", "paginated")),
           "source=" + pick(d.get("source"), among("exec", "cli", "vscode", "mcp")),
           "rollout_kept=" + ("1" if isinstance(d.get("rollout"), str) and os.path.exists(d["rollout"]) else "0")]
    if th:
        items = th.execute("SELECT item_json, started_at_ms, completed_at_ms FROM thread_items WHERE thread_id = ? AND item_type = ?", (d["id"], "imageGeneration")).fetchall()
        res = []
        for j, a, b in items:
            try:
                it = json.loads(j)
            except Exception:
                it = {}
            f = it.get("failure") if isinstance(it, dict) else None
            ft = "none" if f is None else (f.get("type") if isinstance(f, dict) and f.get("type") == "usageLimitExceeded" else "other")
            ms = str(b - a) if isinstance(a, int) and isinstance(b, int) else "-"
            res.append(pick(it.get("status") if isinstance(it, dict) else None, among("in_progress", "completed", "failed")) + "/" + ft + "/" + ms + "ms")
        turns = th.execute("SELECT status, error_json IS NOT NULL FROM thread_turns WHERE thread_id = ?", (d["id"],)).fetchall()
        out.append("image_items=" + (",".join(res) if res else "0"))
        out.append("turns=" + ",".join(pick(s, among("completed", "failed", "interrupted", "in_progress")) + ("+err" if e else "") for s, e in turns))
    print(" ".join(out))
p = os.path.join(H, "models_cache.json")
try:
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as fh:
        raw = fh.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError("too large")
    c = json.loads(raw)
    ms = [m for m in c.get("models", []) if isinstance(m, dict)]
    print("models_cache: cli=" + pick(c.get("client_version"), VER), "fetched=" + pick(c.get("fetched_at"), RFC3339)[:16], "models=%d" % len(ms))
    for m in sorted(ms, key=lambda m: m.get("priority") if isinstance(m.get("priority"), int) else 9999):
        im = m.get("input_modalities")
        print("  " + pick(m.get("slug"), SLUG), "visibility=" + pick(m.get("visibility"), among("list", "hide", "none")),
              "tool_mode=" + ("none" if m.get("tool_mode") is None else pick(m.get("tool_mode"), among("direct", "code_mode", "code_mode_only"))),
              "image_input=" + ("1" if im is None or (isinstance(im, list) and "image" in im) else "0"))
except FileNotFoundError:
    print("models_cache: absent")
except Exception:
    print("models_cache: unreadable")
PY'
```

Cost: none (no Codex, no model, no network). Returns: the printed lines (no secrets inside). How to read them:

- **HUMAN-018's row vs HUMAN-021b's row** (by `created=`): if HUMAN-018 shows `model=` something other than `gpt-6.1-sol` (e.g.
  `gpt-6-sol`) **and** `image_items=completed/…`, the server's default model changed between the two runs — the strongest
  lead, and the case for the `-m` proposal below. Same model on both → the model is not the difference.
- **HUMAN-021b's `image_items=failed/none/<ms>`**: a few hundred ms to a few s → refused at once (4xx: auth, not supported,
  policy, 429); tens of seconds or more → generation started and the server failed or timed out (5xx / timeout); `usageLimitExceeded`
  would have read `USAGE_LIMIT` already. HUMAN-019/020 rows show whether those v2 runs called the tool at all
  (`image_items=0` vs `failed/…`).
- **`hist=legacy` or no `image_items` on HUMAN-018** → that thread was not projected (no answer from this file; the state row
  still gives the model).
- **models cache**: which model is first and listed, and whether `gpt-6.1-sol` is `code_mode_only` with image input.
- `design-agent threads: 0` / `state_5.sqlite: absent` → the state DB is elsewhere (`sqlite_home`) or disabled; nothing to learn here.

#### HUMAN-022 result and DEV-084: every first call failed at about 156 s

HUMAN-022 (2026-10-22) printed the four PoC runs:

| run | model, CLI, history | image items |
|---|---|---|
| HUMAN-018 (v1) | `gpt-6.1-sol`, 0.159.0, paginated | `failed/none/155584ms`, then `completed/none/32648ms` |
| HUMAN-019 (v2) | same | `failed/none/157760ms` |
| HUMAN-020 (v2) | same | `failed/none/155770ms` |
| HUMAN-021b (v1) | same | `failed/none/157684ms` |

Neither the model nor the prompt explains it. HUMAN-019 and HUMAN-020 did call the tool. The cause is investigated in
[`imagegen-timeout-investigation.md`](imagegen-timeout-investigation.md). In short, one tool call makes up to 5 HTTP
attempts. reqwest's Linux default `TCP_USER_TIMEOUT` (30 s) most likely ends each one, which gives 5 × about 31 s + about
3 s of backoff. That is inferred, and HUMAN-024 checks it without Codex.

DEV-084 adds two fields at the end of the summary (schema `/5`):

- `img_call_ms=`: each image call's duration from the rollout's ItemCompleted `started_at_ms` / `completed_at_ms`.
- `img_fail_timing=`: one bucket per failed call: `<5s`, `5-60s`, `60-140s`, `140-170s`, `>170s` or `unknown`.

Nothing else changes: the command line, prompts, jail, cleanup and retries are untouched.

#### HUMAN-024 — separate the causes of the ~156 s failure without Codex (DEV-084; each step needs its own approval)

Background: [`imagegen-timeout-investigation.md`](imagegen-timeout-investigation.md) §3. The leading hypothesis (H1) is
that the jail's kernel cuts each idle images request at about 30 s. That happens because reqwest sets `TCP_USER_TIMEOUT`
30 s and keepalive 15 s on Linux, and the keepalive ACKs never come back. Codex's TCP peer is **pasta**: the jail has its
own network namespace, and an old passt does not ACK keep-alive segments.

**24a — read only, no network, no Codex.** First, in the human's own WSL shell, outside the jail:

```bash
uname -r
wslinfo --networking-mode 2>/dev/null || echo "wslinfo: unavailable"
dpkg-query -W -f='${Package} ${Version}\n' passt 2>/dev/null || echo "passt: no dpkg entry"
command -v pasta >/dev/null && pasta --version 2>/dev/null | head -n 1 || echo "pasta: unavailable"
sysctl -n net.ipv4.tcp_keepalive_time net.ipv4.tcp_keepalive_intvl net.ipv4.tcp_keepalive_probes | paste -sd" "
```

Then, inside the jail as `sr-designgen`, check the environment Codex inherits (whether each variable is set, never the value):

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc '
for v in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy ALL_PROXY all_proxy; do if [ -n "${!v:-}" ]; then echo "$v: set"; else echo "$v: unset"; fi; done'
```

Reading 24a:

- **passt version.** A version older than upstream `2024_11_21.238c69f` ("tcp: Acknowledge keep-alive segments") makes
  pasta the prime suspect. Ubuntu packages use a date-based version such as `0.0~git2024MMDD…`.
- **Proxy variables.** Codex receives only `HTTP(S)_PROXY` / `NO_PROXY`. `ALL_PROXY` is cleared by the sandbox's env
  allowlist (`lib/design-agent/sandbox.ts:79`). A proxy at a private address (10/8, 172.16/12, 192.168/16, 169.254/16,
  100.64/10) is unreachable from the jail (`IPAddressDeny`, `scripts/sales-design-capture/jail/jail.properties:66-67`).
  If `HTTPS_PROXY` is set to a reachable address, Codex's TCP goes to that proxy, and 24b, which dials directly, does not
  mirror Codex's path.

**24a result (done, 2026-10-22, run by the human):**

| item | value |
|---|---|
| kernel | `6.18.33.2-microsoft-standard-WSL2` |
| WSL networking mode | `nat` |
| passt (dpkg) | `0.0~git20240220.1e6f92b-1`: Ubuntu 24.04's own package (noble release pocket; noble has no `-updates`, `-security` or `-backports` build of passt) |
| `pasta --version` | `pasta unknown version` (pasta prints its mode name, then the version). The Debian/Ubuntu build has no git tree, so the Makefile's `VERSION` falls back to `unknown version`. Identify the binary by its dpkg version and hash, not by `--version` |
| system keepalive sysctls | `7200 75 9`. They do not apply to Codex's sockets: reqwest sets keepalive 15/15/3 and `TCP_USER_TIMEOUT` 30 s per socket |
| jail | `JAIL_OK` |
| proxy variables in the jail | all unset (`HTTP(S)_PROXY`, `NO_PROXY`, `ALL_PROXY`, upper and lower case) |

Reading: upstream commit `1e6f92b` (2024-02-20) is an ancestor of `238c69f` (2024-11-21) "tcp: Acknowledge keep-alive
segments", so the installed pasta does **not** ACK keep-alive probes. That alone predicts H1 on the jail path, and it
makes pasta the prime suspect. With no proxy set, Codex dials chatgpt.com directly from the jail, and that is the path
24b probes. The 24a in-jail check is valid as written: `systemd-run` expands `${VAR}` in the command (systemd 255,
`--expand-environment` defaults to on for services), but `${!v:-}` is not expanded. ExecStart expansion runs with
flags 0, which means no `:-` syntax, so the text is left as it is (`src/basic/env-util.c` `replace_env_full`, v255).
The design for updating passt is in [`passt-update-plan.md`](passt-update-plan.md). **24b and 24b-host: done
(2026-10-22), results below** ("24b result").

**24b — 0 Codex calls, no sign-in, no billing, about 2 min.** The probe opens three TLS connections to chatgpt.com:443 at
the same time:

- **A**: reqwest's Linux socket options (keepalive 15/15/3 + `TCP_USER_TIMEOUT` 30 s);
- **B**: keepalive only;
- **C**: no options.

Each sends one unauthenticated `GET /robots.txt`, reads for up to 3 s, then sends nothing for up to 100 s. It prints only
`TCP_PROBE <name> status=<HTTP code> idle_end=<OPEN|CUT_EARLY|EOF|DATA|ERR_xxx|SSL_xxx> idle_s=<s>` (or
`setup_failed=…`). No cookie, body, header or address is printed. It does not touch CODEX_HOME, run.lock or the worker.

Re-checked against the jail implementation (DEV-086, read only; the commands below are unchanged):

- **Same path as Codex.** `admin.sh run` starts a transient unit with every `jail.properties` line, including
  `NetworkNamespacePath=/run/netns/srjail`. Codex's image request is sent by the Codex process itself, not by a sandboxed
  tool. That process runs in this namespace, and bubblewrap does not unshare the network (`sandbox.ts:161`). So the
  probe's sockets and Codex's sockets have the same TCP peer: pasta's tap side in `sr-jail-net.service`. Remaining
  differences, none of which touch the TCP keepalive path:
  - Codex POSTs and waits for an answer that has not started; the probe idles after a complete answer.
  - ALPN: the probe asks for `http/1.1`, while Codex may negotiate h2. h2 PINGs are off by default in hyper.
  - Address choice: `getaddrinfo` order versus hyper's happy-eyeballs. The probe does not print the address family.
    Under WSL `nat` without IPv6 both use IPv4. If the jail run and the host run might differ here, compare with
    `getent ahosts chatgpt.com` in each.
- **`IPAddressDeny`.** The jail denies 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, fc00::/7, fe80::/10 and the
  default gateway. chatgpt.com resolves to public Cloudflare addresses (104.18.32.47 and 172.64.155.209 when this was
  checked; 172.64/13 is **not** inside 172.16/12), so the probe is allowed, exactly as Codex is. pasta's own unit denies
  the same private ranges and allows only 10.255.255.254 (the DNS tunnel).
- **DNS.** The jail's `resolv.conf` is `nameserver 198.51.100.53` + `options edns0`. pasta forwards that address over
  UDP/53 to the host resolver. TCP to it is refused by the ip rule, which is fine because `getaddrinfo` uses UDP.
- **Port forwarding.** There is none. The unit runs pasta with `-t none -u none -T none -U none --no-map-gw`. Outbound
  connections from the jail are not port forwards: pasta terminates each jail-side TCP connection and opens its own
  host-side socket to the same destination. That is why its handling of keep-alive segments decides H1.
- **`systemd-run` expansion.** The service manager expands `${VAR}` and collapses `$$` in the command line. The 24b
  script has no `$` and no `${`. `%` is safe because transient ExecStart lines are written with specifiers escaped
  (`dbus-execute.c`, `UNIT_ESCAPE_SPECIFIERS`).
- **No writes, no config.**
  - `python3 -I -` reads the script from stdin: no `.pyc` is written, and no site or user directories are used.
  - `bash -lc` is non-interactive, so there is no history file.
  - The transient unit (`--collect`) exists only in `/run` while it runs, and journald logs its start and stop lines.
  - `jail_args` runs `systemctl start sr-jail-net`, which does nothing when it is already running.
  - The host run writes nothing either.
  - Nothing touches CODEX_HOME, `~/.codex/config.toml`, `.wslconfig`, the passt package or any unit file.

Run it inside the jail, which is Codex's path:

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc 'timeout 180 python3 -I - <<"PY"
import socket, ssl, sys, time, threading, errno
HOST = sys.argv[1] if len(sys.argv) > 1 else "chatgpt.com"
PORT = 443
HOLD = 100
CA = None
def ename(e):
    return errno.errorcode.get(e.errno, "E%s" % e.errno) if isinstance(getattr(e, "errno", None), int) else type(e).__name__
def opts(s, keep, user):
    if keep:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 15)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 15)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
    if user:
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_USER_TIMEOUT, 30000)
def wait(s, sec):
    s.settimeout(sec)
    try:
        b = s.recv(65536)
        return ("EOF" if not b else "DATA"), b
    except ssl.SSLError as e:
        return "SSL_" + type(e).__name__, b""
    except OSError as e:
        if isinstance(e, TimeoutError) and e.errno is None:
            return "QUIET", b""
        return "ERR_" + ename(e), b""
out = {}
def run(name, keep, user):
    t0 = time.monotonic()
    try:
        raw = socket.create_connection((HOST, PORT), timeout=15)
        opts(raw, keep, user)
        ctx = ssl.create_default_context(cafile=CA)
        ctx.set_alpn_protocols(["http/1.1"])
        s = ctx.wrap_socket(raw, server_hostname=HOST)
        s.sendall(("GET /robots.txt HTTP/1.1\r\nHost: %s\r\nUser-Agent: sr-tcp-probe\r\nConnection: keep-alive\r\n\r\n" % HOST).encode())
        head = b""
        res = "QUIET"
        while True:
            res, b = wait(s, 3)
            if res != "DATA":
                break
            head += b
        st = head[9:12].decode("ascii", "replace") if head.startswith(b"HTTP/1.") else "none"
        t1 = time.monotonic()
        if res == "QUIET":
            res, _ = wait(s, HOLD)
        idle = time.monotonic() - t1
        if res == "QUIET":
            res = "OPEN" if idle >= HOLD - 1 else "CUT_EARLY"
        out[name] = "status=%s idle_end=%s idle_s=%d" % (st, res, round(idle))
    except ssl.SSLError as e:
        out[name] = "setup_failed=SSL_%s after_s=%d" % (type(e).__name__, round(time.monotonic() - t0))
    except OSError as e:
        out[name] = "setup_failed=%s after_s=%d" % (ename(e), round(time.monotonic() - t0))
ts = [threading.Thread(target=run, args=a) for a in [("A_reqwest_default", True, True), ("B_keepalive_only", True, False), ("C_plain", False, False)]]
[t.start() for t in ts]; [t.join() for t in ts]
for k in sorted(out): print("TCP_PROBE", k, out[k])
PY'
```

**24b-host (optional, same cost).** Run the same probe once in the host network namespace, as the human's own WSL user
(not `sr-designgen`, outside the jail). This separates pasta from WSL's NAT and anything beyond it:

```bash
timeout 180 python3 -I - <<"PY"
import socket, ssl, sys, time, threading, errno
HOST = sys.argv[1] if len(sys.argv) > 1 else "chatgpt.com"
PORT = 443
HOLD = 100
CA = None
def ename(e):
    return errno.errorcode.get(e.errno, "E%s" % e.errno) if isinstance(getattr(e, "errno", None), int) else type(e).__name__
def opts(s, keep, user):
    if keep:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 15)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 15)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
    if user:
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_USER_TIMEOUT, 30000)
def wait(s, sec):
    s.settimeout(sec)
    try:
        b = s.recv(65536)
        return ("EOF" if not b else "DATA"), b
    except ssl.SSLError as e:
        return "SSL_" + type(e).__name__, b""
    except OSError as e:
        if isinstance(e, TimeoutError) and e.errno is None:
            return "QUIET", b""
        return "ERR_" + ename(e), b""
out = {}
def run(name, keep, user):
    t0 = time.monotonic()
    try:
        raw = socket.create_connection((HOST, PORT), timeout=15)
        opts(raw, keep, user)
        ctx = ssl.create_default_context(cafile=CA)
        ctx.set_alpn_protocols(["http/1.1"])
        s = ctx.wrap_socket(raw, server_hostname=HOST)
        s.sendall(("GET /robots.txt HTTP/1.1\r\nHost: %s\r\nUser-Agent: sr-tcp-probe\r\nConnection: keep-alive\r\n\r\n" % HOST).encode())
        head = b""
        res = "QUIET"
        while True:
            res, b = wait(s, 3)
            if res != "DATA":
                break
            head += b
        st = head[9:12].decode("ascii", "replace") if head.startswith(b"HTTP/1.") else "none"
        t1 = time.monotonic()
        if res == "QUIET":
            res, _ = wait(s, HOLD)
        idle = time.monotonic() - t1
        if res == "QUIET":
            res = "OPEN" if idle >= HOLD - 1 else "CUT_EARLY"
        out[name] = "status=%s idle_end=%s idle_s=%d" % (st, res, round(idle))
    except ssl.SSLError as e:
        out[name] = "setup_failed=SSL_%s after_s=%d" % (type(e).__name__, round(time.monotonic() - t0))
    except OSError as e:
        out[name] = "setup_failed=%s after_s=%d" % (ename(e), round(time.monotonic() - t0))
ts = [threading.Thread(target=run, args=a) for a in [("A_reqwest_default", True, True), ("B_keepalive_only", True, False), ("C_plain", False, False)]]
[t.start() for t in ts]; [t.join() for t in ts]
for k in sorted(out): print("TCP_PROBE", k, out[k])
PY
```

Reading 24b. `idle_s` starts **after** the 3 s read window, so a cut 30 s after the last received segment shows as about
**27 s**, and the keepalive-only give-up at 15 + 3 × 15 = 60 s shows as about **57 s**. These timings were reproduced
locally with dropped ACKs (investigation §3).

"Cut" below means A ends `ERR_ETIMEDOUT` with `idle_s` about 27 (B, if it is cut too, at about 57; C stays `OPEN`).
**Correction after the run (DEV-087):** on Python 3.12 (Ubuntu 24.04's `python3`) the same cut prints **`EOF`**, not
`ERR_ETIMEDOUT`: Python 3.12's ssl module reports a socket the kernel aborted as a ragged EOF, and the probe's default
`suppress_ragged_eofs=True` turns that into an empty read. So read "cut" as `ERR_ETIMEDOUT` **or** `EOF` at about 27 s
(A) / 57 s (B) with C `OPEN`. See "24b result" below; 24b-v2 tells the cases apart directly.
"OPEN" means all three end `OPEN` with `idle_s` = 100. A lost keepalive ACK cuts A and B and never C, because C sends no
probes.

**The decision (jail run × host run):**

| 24b (jail) | 24b-host | decision | next |
|---|---|---|---|
| A cut at about 27 s | all `OPEN` | **pasta drops the keepalive ACKs** (H1's mechanism is present on the jail path). Whether it explains the image failures, and H2 / H3 for a pending POST, stays open until A-8. Fits 24a: passt `1e6f92b` predates `238c69f` | the passt update, [`passt-update-plan.md`](passt-update-plan.md); each step has its own approval |
| A cut at about 27 s | A cut at about 27 s | **WSL's NAT or something upstream** (a middlebox, the edge). H1's mechanism is present, but updating passt alone will not fix it | WSL networking (`.wslconfig`, human approval) or an upstream report; not the passt plan alone |
| all `OPEN` | all `OPEN` (or not run) | **unexpected given 24a** (the installed pasta `1e6f92b` does not ACK keepalives): send the output as it is. If it holds up, keepalives are answered on Codex's path, the ~156 s is not the TCP cut, and **H2** leads (the server or edge answers 5xx at about 30 s) | send the output; then H2 / 24c (one Codex run) |
| all `OPEN` | A cut | unexpected: the jail path answers but the host path does not | send both outputs as they are |
| A cut at about 27 s | not run | H1's mechanism is present on Codex's path; pasta versus NAT is still open | run 24b-host (same approval class) before deciding on the passt update |

Other single-run results:

| result | meaning |
|---|---|
| A `ERR_ETIMEDOUT` at about 27 s; B `ERR_ETIMEDOUT` at about 57 s (or `OPEN`); C `OPEN` | keepalive ACKs are lost on that path: **H1's mechanism is present**. Whether it explains the image failures, and H2 / H3 for a POST still waiting for its response, stays open until A-8 (`passt-update-plan.md`); see "24b result" |
| the same with `EOF` in place of `ERR_ETIMEDOUT` (Python 3.12, DEV-087) | read it the same way: keepalive ACKs are lost on that path (H1's mechanism is present), and the image failures' cause stays open until A-8. Python 3.12's ssl module reports the kernel's `ETIMEDOUT` abort as EOF ("24b result") |
| `CUT_EARLY` | a quiet end before 100 s without an error. Unexpected: send it as it is |
| `EOF` early on all three | the server closed the idle connection first. Inconclusive |
| `setup_failed=…` / `SSL_…` | no connection (DNS, TLS, certificate). Nothing learned about H1 |
| any other `ERR_…` (e.g. `ERR_ECONNRESET`), `DATA`, or a mix not listed above | unexpected: send the output as it is |

**24b result (done, 2026-10-22, run by the human: 24b in the jail and 24b-host in the host namespace).** The output,
as sent:

| connection | 24b, in the jail (through pasta `1e6f92b`) | 24b-host (WSL `nat`, no pasta) |
|---|---|---|
| jail check | `JAIL_OK` | – |
| A_reqwest_default (keepalive 15/15/3 + `TCP_USER_TIMEOUT` 30 s) | `status=200 idle_end=EOF idle_s=27` | `status=200 idle_end=OPEN idle_s=100` |
| B_keepalive_only (keepalive 15/15/3) | `status=200 idle_end=EOF idle_s=57` | `status=200 idle_end=OPEN idle_s=100` |
| C_plain (no options) | `status=200 idle_end=OPEN idle_s=100` | `status=200 idle_end=OPEN idle_s=100` |

Reading:

- **The results strongly support that the old pasta drops keep-alive ACKs on the jail path.** Only the connections that
  send keepalive probes end, and they end at exactly the predicted times: A at about 27 s (`TCP_USER_TIMEOUT` 30 s minus
  the 3 s read window) and B at about 57 s (15 + 3 × 15 − 3). C, which sends no probes, stays open for 100 s in the jail.
  On the host all three stay `OPEN`, so neither the server, the edge nor WSL's NAT closes an idle connection within
  100 s, and the keepalive probes are answered there. This is the decision table's first row ("A cut in the jail, all
  `OPEN` on the host" → pasta). It fits 24a (passt `1e6f92b` predates `238c69f`) and the source of `1e6f92b` (see (b)
  below).
- **It is NOT proven that the ~156 s image-generation failures have the same cause.** 24b is an idle `GET` after a
  complete response. Codex sends a `POST` and waits for a response that has not started. The same socket options and
  kernel timers apply to that wait (nothing is sent or received while the server generates), so H1 is now the strongest
  explanation, but only a Codex run after the fix (A-8 in `passt-update-plan.md`) can show it. H2 (the server answers
  5xx at about 30 s) is not excluded by 24b for a request that is still in progress.
- **Differs from the expectation:** A and B ended `EOF`, not `ERR_ETIMEDOUT`. Analysed next.

**Why `EOF` and not `ERR_ETIMEDOUT` (DEV-087).** The probe's `wait()` returns `EOF` when the TLS socket's `recv` returns
`b""`. Three mechanisms can produce that:

- **(a) An error-reporting artefact: the kernel aborted the socket with `ETIMEDOUT`, and Python's ssl layer reported it
  as EOF.**
  - CPython 3.12.3 `Modules/_ssl.c`: `_ssl__SSLSocket_read_impl` calls `SSL_read_ex`, which returns **0** on any failure,
    and passes that 0 to `PySSL_SetError`.
  - For `SSL_ERROR_SYSCALL` with an empty OpenSSL error queue, `PySSL_SetError` tests `ret == 0` **first** and raises
    `SSLEOFError` ("EOF occurred in violation of protocol"). The branch that would raise `OSError(errno)` from the saved
    errno is only reached for `ret == -1`, which `SSL_read_ex` never returns.
  - `ssl.py`'s `SSLSocket.read` turns `SSLEOFError` into `b""` when `suppress_ragged_eofs=True` (the default, as in 24b).
  - CPython fixed this in **3.13.0a6** (gh-115627, "Fix the ssl module error handling of connection terminate by peer. It
    now throws an OSError with the appropriate error code instead of an EOFError"). In 3.13.0 the `ret == 0` test is gone
    and the saved errno is raised. The 3.12 changelog has no gh-115627 entry, so it was not backported. A later 3.12 fix,
    gh-127257 (3.12.9), covers errors OpenSSL reports with `ERR_LIB_SYS`, a different path.
- **(b) A peer FIN: pasta, or the server, closed the connection.**
  - The timing argues against it. The server kept C open for 100 s, and on the host it kept A and B open too. If pasta
    closed the connection when the first keepalive probe arrived, A would end at about 12 s on the idle clock (15 s after
    the last segment), not 27 s.
  - passt `1e6f92b` `tcp.c`: in `tcp_data_from_tap()` (:2249) a keep-alive segment (`seq = seq_from_tap − 1`, no data,
    the same ACK number and window) only sets `retr` (:2299, a fast retransmit of nothing, since all data is acknowledged).
    It ends in `tcp_send_flag(c, conn, ACK_IF_NEEDED)`, which returns without sending anything when nothing new is to be
    acknowledged (:1573). `tcp_data_from_sock()` sends a FIN only after the host socket read EOF (`SOCK_FIN_RCVD`), and
    an RST only on a host socket error other than `EAGAIN`. pasta's own timers do not fire either: no data is
    unacknowledged, and the activity timeout is 7200 s (`ACT_TIMEOUT`). So pasta sends **no ACK, no FIN and no RST** in
    answer to a keepalive probe (CONFIRMED from source).
- **(c) An RST.** It would normally surface as `ECONNRESET`, but Python 3.12.3 maps it to `EOF` in the same way as (a)
  (tested below). The direction of the RST is the other way round: Linux's keepalive timer **sends** an RST to the peer
  when it gives up (`tcp_timer.c` v6.18 `tcp_keepalive_timer`, `tcp_send_active_reset()` before `tcp_write_err()`), and
  `tcp_write_err()` sets the socket error to `ETIMEDOUT` (`tcp_done_with_error(sk, … ETIMEDOUT)`). pasta then sees the
  jail's RST and closes its host socket.

**Local tests (this container; unprivileged; TLS client and server on 127.0.0.1; no namespace, pasta or iptables).** The
container is Ubuntu 24.04.5 with **noble's own packages** `python3.12 3.12.3-1ubuntu0.17` and `libssl3t64
3.0.13-0ubuntu3.16`, kernel 6.18.44, plus a `python3.13 3.13.16` built against the same OpenSSL. The kernel abort was
produced without privileges: `TCP_USER_TIMEOUT` 3 s on a client whose peer never reads, so its window is zero and data
stays unacknowledged; the persist timer then gives up through the same `tcp_write_err()` → `ETIMEDOUT` as the keepalive
timer.

| how the connection ended | Python 3.12.3 (noble), `suppress_ragged_eofs` True / False | Python 3.13.16 | `tcpi_state` after |
|---|---|---|---|
| kernel abort, `ETIMEDOUT` | `EOF` / `SSLEOFError` | `ERR_ETIMEDOUT` | `CLOSE` |
| peer RST (`SO_LINGER` 0) | `EOF` / `SSLEOFError` | `ERR_ECONNRESET` | `CLOSE` |
| peer FIN without TLS `close_notify` | `EOF` / `SSLEOFError` | `EOF` / `SSLEOFError` | `CLOSE_WAIT` |
| peer `close_notify` | `EOF` / `EOF` | `EOF` / `EOF` | `ESTABLISHED` |

- **On Python 3.12.3, `EOF` cannot tell (a), (b) and (c) apart.** `SO_ERROR` read after the TLS read is `0`, because the
  read consumed the kernel's error. Read **before** the TLS read, `SO_ERROR` is `ETIMEDOUT` for the abort on both
  versions (tested), which is what 24b-v2 uses.
- **Why DEV-084's local reproduction printed `ERR_ETIMEDOUT`:** this container's default `python3` is 3.13.16.
  The investigation did not record the version; that it ran on 3.13 is INFERRED.
- **The human's Python** was not printed by 24a or 24b. Ubuntu 24.04's `python3` is 3.12.3, and the jail runs
  `/usr/bin/python3` (`admin.sh` `jail_python`), so 3.12.3 is likely (UNVERIFIED; 24b-v2 prints it).

**Conclusion:**

| | claim |
|---|---|
| CONFIRMED (local test + CPython source) | On noble's Python 3.12.3 + OpenSSL 3.0.13, a socket the kernel aborts with `ETIMEDOUT` reads as `EOF` in 24b. 24b's `EOF` is therefore what the predicted cut looks like on that Python. RST and FIN look the same there |
| CONFIRMED (passt source) | pasta `1e6f92b` sends no ACK, FIN or RST in answer to a keepalive probe |
| CONFIRMED (kernel source) | When the keepalive timer gives up, the jail kernel sets `ETIMEDOUT` and sends an RST to pasta |
| LIKELY | A and B were aborted by the jail's own kernel (mechanism (a)), because the probes went unanswered: only the probing connections ended, at the two predicted times, and the host path keeps all three |
| UNKNOWN | the errno itself on the human's machine (24b cannot print it on Python 3.12); whether the image failures have the same cause (needs A-8 after the fix) |

**24b-v2 — optional, needs its own approval, same cost class as 24b (0 Codex calls, no sign-in, no billing, about
2 min, the same 3 unauthenticated `GET /robots.txt`).** The same read-only probe, with three changes:

- `suppress_ragged_eofs=False`, so an unclean end is never an empty read.
- While idle it watches the socket with `select` and samples `TCP_INFO` once a second without reading. When the socket
  becomes readable it reads **`SO_ERROR` and `TCP_INFO` first**, then does the TLS read. At the 100 s deadline it reads
  them too, and reports `OPEN` only if `SO_ERROR` is 0 and `tcpi_state` is ESTABLISHED; otherwise the end is classified
  like any other. `end=` is `LOCAL_TIMEOUT`
  (`so_error=ETIMEDOUT`), `PEER_RST` (`ECONNRESET`), `PEER_FIN` (no error, `tcpi_state=CLOSE_WAIT`), `PEER_DATA`, `OPEN`
  or `OTHER`.
- It also prints `probes_max` (the most keepalive probes outstanding at once), `ack_age_max_s` (the longest time without
  any ACK from the peer, from `tcpi_last_ack_recv`), and `backoff`, `retransmits` and `unacked` at the end, plus one
  `TCP_PROBE2_ENV` line with the Python and OpenSSL versions. Codes and numbers only: no address, header, cookie or body.

Tested here against the 127.0.0.1 TLS server on Python 3.12.3 (constants pointed at the local server; the text below is
otherwise byte for byte what was run):

| local case | result |
|---|---|
| server keeps the connection open (20 s) | all three `end=OPEN`; A and B `ack_age_max_s=15` (each keepalive probe answered), C `ack_age_max_s=23` |
| server FIN after 8 s | all three `end=PEER_FIN so_error=0 tcpi_state=CLOSE_WAIT` |
| server RST after 8 s | all three `end=PEER_RST so_error=ECONNRESET tcpi_state=CLOSE` |
| kernel abort (zero window, `TCP_USER_TIMEOUT` 3 s; the probe's `idle()` / `verdict()` reused) | `end=LOCAL_TIMEOUT so_error=ETIMEDOUT tcpi_state=CLOSE` on 3.12.3 and 3.13.16 |
| the same abort with `select` patched to never report the socket readable (only the deadline check sees it) | `end=LOCAL_TIMEOUT so_error=ETIMEDOUT tcpi_state=CLOSE` at the deadline, not `OPEN` |

The `struct tcp_info` offsets read are `tcpi_state`, `tcpi_retransmits`, `tcpi_probes` and `tcpi_backoff` (bytes 0, 2,
3, 4), `tcpi_unacked` (24) and `tcpi_last_ack_recv` (56), from `linux/tcp.h`. The `TCP_INFO` counters are not reliable
after an abort (the local abort read back 0), which is why `probes_max` and `ack_age_max_s` are sampled while the
connection is alive.

In the jail (the same wrapper as 24b; the script has no `$`, `${` or `'`):

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash -lc 'timeout 180 python3 -I - <<"PY"
import socket, ssl, sys, time, threading, errno, select, struct
HOST = sys.argv[1] if len(sys.argv) > 1 else "chatgpt.com"
PORT = 443
HOLD = 100
CA = None
STATES = {1: "ESTABLISHED", 4: "FIN_WAIT1", 5: "FIN_WAIT2", 6: "TIME_WAIT", 7: "CLOSE", 8: "CLOSE_WAIT", 9: "LAST_ACK", 11: "CLOSING"}
def ename(n):
    return errno.errorcode.get(n, "E%s" % n) if n else "0"
def info(s):
    # struct tcp_info: 8 x u8 (state, ca_state, retransmits, probes, backoff, ...), then u32 fields;
    # unacked at byte 24, last_ack_recv (ms since the last ACK came in) at byte 56
    b = s.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, 104)
    st, _, retr, probes, backoff = struct.unpack_from("5B", b, 0)
    return {"state": st, "retr": retr, "probes": probes, "backoff": backoff,
            "unacked": struct.unpack_from("I", b, 24)[0], "ack_age": struct.unpack_from("I", b, 56)[0]}
def opts(s, keep, user):
    if keep:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 15)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 15)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
    if user:
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_USER_TIMEOUT, 30000)
def read(s, sec):
    s.settimeout(sec)
    try:
        b = s.recv(65536)
        return ("EOF" if not b else "DATA"), b
    except ssl.SSLError as e:
        return "SSL_" + type(e).__name__, b""
    except OSError as e:
        if isinstance(e, TimeoutError) and e.errno is None:
            return "QUIET", b""
        return "ERR_" + ename(e.errno if isinstance(e.errno, int) else 0), b""
def idle(s, hold):
    # Watch the socket without reading it; when it becomes readable, take SO_ERROR and TCP_INFO
    # first (the TLS read below would consume the kernel error), then read once.
    t1 = time.monotonic()
    ack_age = probes = 0
    while True:
        left = hold - (time.monotonic() - t1)
        if left <= 0:
            # OPEN only if the kernel holds no error and the connection is still ESTABLISHED
            err = s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            i = info(s)
            ack_age, probes = max(ack_age, i["ack_age"]), max(probes, i["probes"])
            if not err and i["state"] == 1:
                return "OPEN", 0, i, ack_age, probes, time.monotonic() - t1
            res, _ = read(s, 0.5)
            return res, err, i, ack_age, probes, time.monotonic() - t1
        r, _, _ = select.select([s], [], [], min(1.0, left))
        i = info(s)
        ack_age, probes = max(ack_age, i["ack_age"]), max(probes, i["probes"])
        if r or s.pending():
            err = s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            i = info(s)
            res, _ = read(s, 0.5)
            if res == "QUIET" and not err and i["state"] == 1:
                continue  # a TLS record without application data (e.g. a session ticket)
            return res, err, i, ack_age, probes, time.monotonic() - t1
def verdict(res, err, st):
    if res == "OPEN":
        return "OPEN"
    if err == errno.ETIMEDOUT:
        return "LOCAL_TIMEOUT"
    if err == errno.ECONNRESET:
        return "PEER_RST"
    if not err and st == 8:
        return "PEER_FIN"
    if res == "DATA":
        return "PEER_DATA"
    return "OTHER"
out = {}
def run(name, keep, user):
    t0 = time.monotonic()
    try:
        raw = socket.create_connection((HOST, PORT), timeout=15)
        opts(raw, keep, user)
        ctx = ssl.create_default_context(cafile=CA)
        ctx.set_alpn_protocols(["http/1.1"])
        s = ctx.wrap_socket(raw, server_hostname=HOST, suppress_ragged_eofs=False)
        s.sendall(("GET /robots.txt HTTP/1.1\r\nHost: %s\r\nUser-Agent: sr-tcp-probe\r\nConnection: keep-alive\r\n\r\n" % HOST).encode())
        head = b""
        while True:
            res, b = read(s, 3)
            if res != "DATA":
                break
            head += b
        st = head[9:12].decode("ascii", "replace") if head.startswith(b"HTTP/1.") else "none"
        if res == "QUIET":
            res, err, i, age, probes, t = idle(s, HOLD)
        else:
            err, i, age, probes, t = 0, info(s), 0, 0, 0.0
        out[name] = "status=%s idle_end=%s idle_s=%d end=%s so_error=%s tcpi_state=%s probes_max=%d ack_age_max_s=%d backoff=%d retransmits=%d unacked=%d" % (
            st, res, round(t), verdict(res, err, i["state"]), ename(err), STATES.get(i["state"], i["state"]),
            probes, round(age / 1000), i["backoff"], i["retr"], i["unacked"])
    except ssl.SSLError as e:
        out[name] = "setup_failed=SSL_%s after_s=%d" % (type(e).__name__, round(time.monotonic() - t0))
    except OSError as e:
        out[name] = "setup_failed=%s after_s=%d" % (ename(e.errno) if isinstance(e.errno, int) else type(e).__name__, round(time.monotonic() - t0))
    except Exception as e:
        out[name] = "probe_error=%s" % type(e).__name__
print("TCP_PROBE2_ENV py=%s openssl=%s" % (sys.version.split()[0], ssl.OPENSSL_VERSION.split()[1]))
ts = [threading.Thread(target=run, args=a) for a in [("A_reqwest_default", True, True), ("B_keepalive_only", True, False), ("C_plain", False, False)]]
[t.start() for t in ts]; [t.join() for t in ts]
for k in sorted(out): print("TCP_PROBE2", k, out[k])
PY'
```

24b-v2-host, as the human's own WSL user, outside the jail:

```bash
timeout 180 python3 -I - <<"PY"
import socket, ssl, sys, time, threading, errno, select, struct
HOST = sys.argv[1] if len(sys.argv) > 1 else "chatgpt.com"
PORT = 443
HOLD = 100
CA = None
STATES = {1: "ESTABLISHED", 4: "FIN_WAIT1", 5: "FIN_WAIT2", 6: "TIME_WAIT", 7: "CLOSE", 8: "CLOSE_WAIT", 9: "LAST_ACK", 11: "CLOSING"}
def ename(n):
    return errno.errorcode.get(n, "E%s" % n) if n else "0"
def info(s):
    # struct tcp_info: 8 x u8 (state, ca_state, retransmits, probes, backoff, ...), then u32 fields;
    # unacked at byte 24, last_ack_recv (ms since the last ACK came in) at byte 56
    b = s.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, 104)
    st, _, retr, probes, backoff = struct.unpack_from("5B", b, 0)
    return {"state": st, "retr": retr, "probes": probes, "backoff": backoff,
            "unacked": struct.unpack_from("I", b, 24)[0], "ack_age": struct.unpack_from("I", b, 56)[0]}
def opts(s, keep, user):
    if keep:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 15)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 15)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
    if user:
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_USER_TIMEOUT, 30000)
def read(s, sec):
    s.settimeout(sec)
    try:
        b = s.recv(65536)
        return ("EOF" if not b else "DATA"), b
    except ssl.SSLError as e:
        return "SSL_" + type(e).__name__, b""
    except OSError as e:
        if isinstance(e, TimeoutError) and e.errno is None:
            return "QUIET", b""
        return "ERR_" + ename(e.errno if isinstance(e.errno, int) else 0), b""
def idle(s, hold):
    # Watch the socket without reading it; when it becomes readable, take SO_ERROR and TCP_INFO
    # first (the TLS read below would consume the kernel error), then read once.
    t1 = time.monotonic()
    ack_age = probes = 0
    while True:
        left = hold - (time.monotonic() - t1)
        if left <= 0:
            # OPEN only if the kernel holds no error and the connection is still ESTABLISHED
            err = s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            i = info(s)
            ack_age, probes = max(ack_age, i["ack_age"]), max(probes, i["probes"])
            if not err and i["state"] == 1:
                return "OPEN", 0, i, ack_age, probes, time.monotonic() - t1
            res, _ = read(s, 0.5)
            return res, err, i, ack_age, probes, time.monotonic() - t1
        r, _, _ = select.select([s], [], [], min(1.0, left))
        i = info(s)
        ack_age, probes = max(ack_age, i["ack_age"]), max(probes, i["probes"])
        if r or s.pending():
            err = s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            i = info(s)
            res, _ = read(s, 0.5)
            if res == "QUIET" and not err and i["state"] == 1:
                continue  # a TLS record without application data (e.g. a session ticket)
            return res, err, i, ack_age, probes, time.monotonic() - t1
def verdict(res, err, st):
    if res == "OPEN":
        return "OPEN"
    if err == errno.ETIMEDOUT:
        return "LOCAL_TIMEOUT"
    if err == errno.ECONNRESET:
        return "PEER_RST"
    if not err and st == 8:
        return "PEER_FIN"
    if res == "DATA":
        return "PEER_DATA"
    return "OTHER"
out = {}
def run(name, keep, user):
    t0 = time.monotonic()
    try:
        raw = socket.create_connection((HOST, PORT), timeout=15)
        opts(raw, keep, user)
        ctx = ssl.create_default_context(cafile=CA)
        ctx.set_alpn_protocols(["http/1.1"])
        s = ctx.wrap_socket(raw, server_hostname=HOST, suppress_ragged_eofs=False)
        s.sendall(("GET /robots.txt HTTP/1.1\r\nHost: %s\r\nUser-Agent: sr-tcp-probe\r\nConnection: keep-alive\r\n\r\n" % HOST).encode())
        head = b""
        while True:
            res, b = read(s, 3)
            if res != "DATA":
                break
            head += b
        st = head[9:12].decode("ascii", "replace") if head.startswith(b"HTTP/1.") else "none"
        if res == "QUIET":
            res, err, i, age, probes, t = idle(s, HOLD)
        else:
            err, i, age, probes, t = 0, info(s), 0, 0, 0.0
        out[name] = "status=%s idle_end=%s idle_s=%d end=%s so_error=%s tcpi_state=%s probes_max=%d ack_age_max_s=%d backoff=%d retransmits=%d unacked=%d" % (
            st, res, round(t), verdict(res, err, i["state"]), ename(err), STATES.get(i["state"], i["state"]),
            probes, round(age / 1000), i["backoff"], i["retr"], i["unacked"])
    except ssl.SSLError as e:
        out[name] = "setup_failed=SSL_%s after_s=%d" % (type(e).__name__, round(time.monotonic() - t0))
    except OSError as e:
        out[name] = "setup_failed=%s after_s=%d" % (ename(e.errno) if isinstance(e.errno, int) else type(e).__name__, round(time.monotonic() - t0))
    except Exception as e:
        out[name] = "probe_error=%s" % type(e).__name__
print("TCP_PROBE2_ENV py=%s openssl=%s" % (sys.version.split()[0], ssl.OPENSSL_VERSION.split()[1]))
ts = [threading.Thread(target=run, args=a) for a in [("A_reqwest_default", True, True), ("B_keepalive_only", True, False), ("C_plain", False, False)]]
[t.start() for t in ts]; [t.join() for t in ts]
for k in sorted(out): print("TCP_PROBE2", k, out[k])
PY
```

Reading 24b-v2:

| result | meaning |
|---|---|
| jail: A `end=LOCAL_TIMEOUT so_error=ETIMEDOUT idle_s≈27 probes_max=1 ack_age_max_s≈30`, B the same at `idle_s≈57` with `probes_max=3`, C `OPEN`; host: all `OPEN` with A/B `ack_age_max_s≈15` | today's expected result: the jail kernel gave up because no keepalive ACK came back. This settles mechanism (a) |
| A/B `end=PEER_RST` or `PEER_FIN` in the jail | something closed the connection from the far side (unexpected given the pasta source): send the output as it is |
| jail: all three `OPEN`, A/B `ack_age_max_s` ≤ 20 | keepalive probes are answered on the jail path: **the expected result after the passt update** |
| anything else | send the output as it is |

**Is 24b-v2 needed before the update decision? No.** The A/B/C timing pattern of 24b already discriminates: only a lost
keepalive ACK cuts A at 27 s and B at 57 s while C and the host stay open, and the passt source explains it. 24b-v2
would only name the errno. It would, however, make the **post-update check** more conclusive: `ack_age_max_s` ≤ 20 on A
and B shows directly that the keepalive probes are now answered, not only that nothing ended within 100 s. **Proposal:
V-3 / A-6 in `passt-update-plan.md` runs 24b-v2 (jail and host) instead of 24b.** Running 24b-v2 once before the update
is optional: it gives a same-tool baseline for that comparison (approval in the A-1 class).

**24c — only if 24b is inconclusive.** One Codex run with image generation, using HUMAN-021b's v1 command, after DEV-084
is merged. It records `img_call_ms=` / `img_fail_timing=` per call. If the cell's script leaves the error uncaught, it
also records `img_fail_reason=TIMEOUT` (H1) or `HTTP_5XX` (H2).

To send back: the printed lines as they are (no secrets inside).

#### Larger options (each needs its own human approval; not applied)

- **`-m gpt-5.5`** (a model in the 0.159.0 bundled catalog with direct tools): only if HUMAN-022 shows HUMAN-018 ran on a
  different model than HUMAN-021b, or the next failure's `img_fail_reason` points at the model (`NOT_SUPPORTED`). Changes which
  model runs and its plan usage.
- **Update the CLI** (0.159.0 → current; not expected to change the ~156 s failure, DEV-084: upstream main still uses reqwest 0.12.28 with no TCP option override): only if the reason is `BAD_RESPONSE` / `BAD_REQUEST` / `NOT_SUPPORTED` against the
  image endpoint (a client / server contract drift). The files read here were the same in 0.163.0 (DEV-080).
- **HUMAN-021c (v2)** stays on hold until v1 makes an image again.

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

DEV-077 tightened it after the HUMAN-019 stop (12379 → 6801 chars; budget ≤ 1.5 × the 4754-char v1 prompt = 7131, tested):
its first lines say, as curiosity-media's working image prompts do, to use **only** the built-in image generation tool, that the
answer is one raster image (not HTML / CSS / code, not a text description, no plan or question first), and to answer with the
tool's error instead of any substitute; the build-task vocabulary (HTML and CSS a developer could build, screenshot, 1440 px,
a 12-column grid spec; the Hero layout in the v2 direction now says "on about 60% of the width") is gone; each prohibition is said once, in code
(the direction's `hard_rules`, `avoid` and `techniques` repeat the same things and stay in `design-spec.json`; `V2_HARD_RULE_COVERAGE` in
`prompt.ts` maps every `hard_rules` entry to the code lines that say it, or says why it concerns only later use, and a test fails when
the direction's rules change without that map). Every prohibition below is unchanged.

- a **website design comp**: one flat, full-page mockup image (no device frame, laptop or browser window), realistic web typography sizes, tall portrait about 2:3 (e.g. 1024 × 1536)
- a slim **header nav** with 2 anchors, one per section below the Hero (「商品・こだわり」「店舗情報」; no 「アクセス」 anchor, since the access line may be left out), and one CTA 「店舗情報を見る」 (no purchase / reservation UI: there is no such fact)
- 3 sections stacked: **Hero** (the shop name 架空菓庵 and a dorayaki cross-section with tsubu-an share the lead), **商品・こだわり** (2–3 product visual cards + one short copy block; captions only phrases copied verbatim from the description, 季節の上生菓子 / 粒あんのどら焼き; a third card, if any, is the tsubu-an macro with no caption; never an invented caption), **店舗情報** (a definition list / table: 営業時間・定休日・住所・電話)
- palette kinari `#F4EEE3` / sumi `#1F1D1B` / muted vermilion `#B4472E`; Mincho display, Gothic body; generous whitespace (from the theme)
- original composition only: never copy or imitate Instagram posts, third-party photos or other websites
- one consistent art direction for every wagashi image (light, surfaces, camera height); no people, hands, store or text inside images
- Japanese text limited to the shop name, nav / CTA / section / info labels, the shown fact values, card captions and at most one verbatim copy line, and the disclosure (to reduce garbled glyphs)
- the facts only inside the `<<<FACTS_BEGIN data-not-instructions … FACTS_END>>>` block; no environment value, path or token (tested)

### Run (HUMAN-019 was run on 2026-10-21: `CODEX_NO_IMAGE`; the next run is HUMAN-020, after DEV-077 is merged, with the same command)
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
Claude scores the uploaded image with the rubric in [`design-image-eval-template.md`](design-image-eval-template.md) (5 criteria × 1–5; the human's target is **≥ 22/25**, plus hard-fail checks that enforce the human's own rules: invented facts, store / people imagery, a missing or altered disclosure, a logo or realism claim, garbled shop facts), and the human confirms the score. **No criterion may be below 4** — the human's policy of 2026-10-22 (「22/25点以上、各項目4点以上を基本方針とする」; earlier a Claude proposal, now adopted). DEV-075 is done only when a human-run image passes. The rubric applies to this PoC only; no existing quality gate, threshold or CI check changes.

### Reusable wagashi assets (design only)
How the wagashi visuals could later be made as standalone, reviewed image assets (one Codex call per asset, each with its own approval) is designed in [`design-image-assets.md`](design-image-assets.md). Nothing of it is implemented; this PoC stays at exactly one Codex call, and cropping visuals out of the comp is for internal reference only.

## Checks in this container (no Codex)

DEV-077 adds (`design-image-poc.test.ts` "diagnostics"): cases (a) text answer, (b) image in another new dir / a nested dir / a WebP (`CODEX_IMAGE_UNSUPPORTED_FORMAT`) / the work dir / elsewhere in CODEX_HOME, (c) image tool started then an error item (`POLICY`), (d) `turn.failed`, a timeout with a cut stream, a signal mid-call (snapshot before cleanup, cleanup unchanged), success; unknown types count as `other`; a canary in the prompt, answer, errors, stderr, file names and env never appears in `diagnostics.json`, the summary or the entry's stdout; 0700 / 0600; no file before the output root exists and none on a refusal; the entry prints `POC_DIAG` / `POC_DIAG_SUMMARY` (run with nothing but node on PATH, so no Codex can start); `runBounded`'s stdout observer only observes; the v2 prompt's first lines, no build-task words, each prohibition exactly once, ≤ 7131 chars; v1 byte-identical. Review fixes: a signal's / the watchdog's stop code is frozen when the cleanup starts (diagnostics and `POC_STOP` agree even if the killed child returns first); a stdout line over 1 MiB is dropped (`unparsed`, `trunc=1`) and `runBounded` stops calling the observer at its 64 MiB capture cap (a 64 MiB newline-free stream stays bounded); GIF is its own class; a link named `.jpg` is not taken for another format; every v2 `hard_rules` entry is mapped (`V2_HARD_RULE_COVERAGE`).

DEV-080 adds (`design-image-poc.test.ts` "DEV-080", fixtures in the 0.159.0 shape: `history_mode: "paginated"`, Extension items,
`custom_tool_call` exec cells): paginated direct mode, `function_call` + Extension failed `usageLimitExceeded` → `CODEX_QUOTA`
(`environment`); the Extension failure decides over the output text, `in_progress` is ignored, another Extension kind is not the
tool; code mode, an exec cell naming `image_gen__imagegen` + Extension failed (other) → `img_calls=1`, `CODEX_IMAGE_TOOL_FAILED`;
an exec cell without an Extension item → `TOOL_NOT_SEEN_CODE_MODE`, class `inconclusive` for every answer (also a code_mode_only
model without cells, and an unknown model with a cell); direct mode with no call → `TOOL_NOT_CALLED` (`request`); Extension
completed with the PNG → `IMAGE_SAVED` with a ~16 MiB base64 `result` on one line; `history_mode` legacy / paginated / other /
absent; a log over 64 MiB is still not read; `toolModeOf`; `parseCodexVersion("codex-cli 0.159.0")`; canaries in the exec input,
`revisedPrompt`, `result` and `savedPath` (and their snake_case spellings, as an extra case) never reach `diagnostics.json` or the summary.

DEV-081 adds (`design-image-poc.test.ts` "DEV-081", 0.159.0-shaped fixtures with model `gpt-6.1-sol` and `effort`): HUMAN-021b's
exact shape (code mode, Extension `failure: null`, no readable text → `img_fail_type=none img_fail_reason=NO_TEXT`, `TOOL_FAILED`,
`capability`); an uncaught `Script error:` with `http 429 … usage_limit_reached` → `CODEX_QUOTA`; 502 / timeout / connection /
overloaded → `TOOL_FAILED_TRANSIENT` (`transient`, one model call); 404 `model_not_found` / 403 `usage_not_included` →
`TOOL_FAILED_UNSUPPORTED`; 400 `moderation_blocked` → `TOOL_FAILED_POLICY`; the structured failure still decides; an unknown
`failure.type` is `other`; direct-mode text, a pre-start argument error (`no_record` / `INVALID_ARGS`), DEV-078's text codes;
a `wait` output; `cm_arg_err` only for a cell naming the tool; the model's words without Codex's prefix are no reason;
review fixes: the two spoof cases (a completed cell printing a 503 with Codex's prefix → `cell_print`, `OTHER`; usage-limit text
printed by a failed cell → never `CODEX_QUOTA`, Codex's own error item decides; a merged single item → `cell_print`), `POLICY`
over `USAGE_LIMIT`, 4xx never transient / `NOT_SUPPORTED` only for 403 / 404 / allowlisted codes, a `stale` cache not applied;
`classifyImageFailureText`; the models cache (found / absent / link / too large / invalid / not listed / `tool_mode` none / text-only);
`effort`; `pocStopClass`. Canaries in the body, the identity, the ETag, descriptions and the effort never come out.

`tests/unit/design-agent/design-image-poc.test.ts` (fake sandbox playing the Codex CLI): refusal without the flag (no file access, no sandbox) and without the shell token; the wrapper's STOP before preflight / lock / git / npm / tsx, its env allowlist, budget cap and lock; the happy path; no thread; no image; invalid PNGs (bad CRC, truncated, trailing data, too small, too large, a link); quota; timeout; sign-out (not from the model's words); API-key sign-in; cleanup (session log, new image dirs only, work dir, also on a signal); output permissions 0700 / 0600 outside the repo; report with codes and numbers only; the prompt's content and no environment in it; nothing else reads the output root.

第2案 (DEV-075) adds: the direction choice (`parseDirectionVersion`: unset / empty → v2, v1 and v2 pass, anything else `POC_DIRECTION_INVALID`; refused in `runDesignImagePoc` before any file or sandbox, in `design-image-poc.ts` and in the wrapper before the preflight; the allowlist passes `SR_DESIGN_IMAGE_POC_DIRECTION` through); v2 is the default (report `direction_version`, the v2 notes incl. `AI_FOOD_VISUALS_CONCEPT_ONLY` / `EVALUATION_REQUIRED`, `design-spec.json` = the v2 file) and v1 still runs (its notes and spec); the v1 prompt unchanged byte for byte (sha256) with its prohibition lines; the v2 direction file (0.3-poc, exact disclosure, section order, two nav anchors) and its strict checks (a dropped disclosure, an extra key, a reservation / purchase / order word in the CTA, nav or info labels, a single anchor, a reordered section → `POC_INPUT_INVALID`); the v2 prompt (website comp not poster, 2:3, nav and CTA, 2–3 cards with verbatim captions only, the definition-list block, wagashi visuals allowed, store / people / hands forbidden, no logos / prices / reviews / awards / history, no realism claim, no Instagram / third-party copying, the disclosure, limited Japanese text, facts only in the data block, no environment); the fixture unchanged; isolation: nothing outside the PoC entry and `lib/design-agent/design-image/` names `wagashi-art-direction-v2`, `AI_FOOD_VISUALS`, `design-library/poc` or `DIRECTION_PATHS`.
