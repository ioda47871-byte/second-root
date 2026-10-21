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
| `CODEX_DOTENV_PRESENT` | `$CODEX_HOME/.env` exists (DEV-078): Codex would load it into its own environment (only `CODEX_*` keys are filtered), which can carry an API key past the env allowlist. Codex not started; the file is never opened. Remove or move it as `sr-designgen` |
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
| `capability` | `CODEX_IMAGE_TOOL_FAILED`; `CODEX_NO_IMAGE` with `outcome=TOOL_NOT_CALLED answer=TEXT_TOOL_UNAVAILABLE` | halt and alert; the human runs HUMAN-021a's local checks. The model's words may choose this class only because it halts and never loosens anything |
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
  to start when that file exists. **The design worker's Codex calls (`lib/design-agent/codex.ts`: `assertChatGptSignIn`,
  `runCodexJson`, used by the production worker) do not check it yet**, so a `.env` in `sr-designgen`'s CODEX_HOME could feed an
  `OPENAI_API_KEY` / `OPENAI_BASE_URL` to them. Moving the check into `codex.ts` and failing closed before every sandboxed Codex
  process is **DEV-079** (P1, backlog, its own review); until then, HUMAN-021a's first line shows whether the file exists. The diagnostics dirs stay in the output root (repo-external, never published); delete them with `sudo rm -r` when done.

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
Claude scores the uploaded image with the rubric in [`design-image-eval-template.md`](design-image-eval-template.md) (5 criteria × 1–5; the human's target is **≥ 22/25**, plus hard-fail checks that enforce the human's own rules: invented facts, store / people imagery, a missing or altered disclosure, a logo or realism claim, garbled shop facts), and the human confirms the score. Claude additionally proposes "no criterion below 4"; it is recorded on the sheet but is a pass requirement only if the human adopts it. DEV-075 is done only when a human-run image passes. The rubric applies to this PoC only; no existing quality gate, threshold or CI check changes.

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

`tests/unit/design-agent/design-image-poc.test.ts` (fake sandbox playing the Codex CLI): refusal without the flag (no file access, no sandbox) and without the shell token; the wrapper's STOP before preflight / lock / git / npm / tsx, its env allowlist, budget cap and lock; the happy path; no thread; no image; invalid PNGs (bad CRC, truncated, trailing data, too small, too large, a link); quota; timeout; sign-out (not from the model's words); API-key sign-in; cleanup (session log, new image dirs only, work dir, also on a signal); output permissions 0700 / 0600 outside the repo; report with codes and numbers only; the prompt's content and no environment in it; nothing else reads the output root.

第2案 (DEV-075) adds: the direction choice (`parseDirectionVersion`: unset / empty → v2, v1 and v2 pass, anything else `POC_DIRECTION_INVALID`; refused in `runDesignImagePoc` before any file or sandbox, in `design-image-poc.ts` and in the wrapper before the preflight; the allowlist passes `SR_DESIGN_IMAGE_POC_DIRECTION` through); v2 is the default (report `direction_version`, the v2 notes incl. `AI_FOOD_VISUALS_CONCEPT_ONLY` / `EVALUATION_REQUIRED`, `design-spec.json` = the v2 file) and v1 still runs (its notes and spec); the v1 prompt unchanged byte for byte (sha256) with its prohibition lines; the v2 direction file (0.3-poc, exact disclosure, section order, two nav anchors) and its strict checks (a dropped disclosure, an extra key, a reservation / purchase / order word in the CTA, nav or info labels, a single anchor, a reordered section → `POC_INPUT_INVALID`); the v2 prompt (website comp not poster, 2:3, nav and CTA, 2–3 cards with verbatim captions only, the definition-list block, wagashi visuals allowed, store / people / hands forbidden, no logos / prices / reviews / awards / history, no realism claim, no Instagram / third-party copying, the disclosure, limited Japanese text, facts only in the data block, no environment); the fixture unchanged; isolation: nothing outside the PoC entry and `lib/design-agent/design-image/` names `wagashi-art-direction-v2`, `AI_FOOD_VISUALS`, `design-library/poc` or `DIRECTION_PATHS`.
