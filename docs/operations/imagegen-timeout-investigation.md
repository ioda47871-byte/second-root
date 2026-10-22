# Imagegen ~156 s failures — investigation (DEV-084, HUMAN-022 follow-up)

Status: research note (2026-10-22). **No Codex run, no image, no API call** was made for it. `openai/codex` at tag
`rust-v0.159.0` (commit `687a119f`) was read as data and never built or run; paths below are under `codex-rs/` at that tag
unless they say otherwise. reqwest `0.12.28` (the version in that tag's `Cargo.lock`) was read from its crates.io source.
Related: `design-image-poc.md` §"Why a called image tool failed: HUMAN-021b and DEV-081", `.ai/blockers.md` HUMAN-022 / HUMAN-024.

## 1. The facts (HUMAN-022, run by the human on 2026-10-22)

Codex's state DB holds 79 design-agent threads. The four image PoC runs share model `gpt-6.1-sol`, CLI `0.159.0` and
`hist=paginated`. Their `imageGeneration` items (`status/failure/duration`) are:

| run | prompt | image tool items | outcome |
|---|---|---|---|
| HUMAN-018 | v1 | `failed/none/155584ms`, then `completed/none/32648ms` | image produced |
| HUMAN-019 | v2 | `failed/none/157760ms` | no image |
| HUMAN-020 | v2 | `failed/none/155770ms` | no image |
| HUMAN-021b | v1 | `failed/none/157684ms` | no image |

The first imagegen call failed every time after **155.6–157.8 s** with `failure: null`. In HUMAN-018 the model then called
the tool again, and that call succeeded in 32.6 s. The model and the CLI were the same in all four runs, so a model change
does not explain it. The prompt does not either: v1 failed the same way in 21b.
Two corrections to earlier readings follow. **HUMAN-019 and HUMAN-020 did call the tool.** Their `CODEX_NO_IMAGE` /
`image_tool=0/0` happened because `codex exec --json` shows no image item (DEV-078/080). The model did not choose text.
And **HUMAN-018 was not a clean success**: its first call failed in the same way.

## 2. The image request path in 0.159.0 (CONFIRMED from source)

- **Who sends it.** `ext/image-generation/src/tool.rs:145-258` `handle_call`. The args are checked first (:149-152). Then
  the Extension item is started (`emit_started`, :153-170). Then **one** call to `backend.generate` / `backend.edit` runs
  (:171-174). An `Err` writes the item `status:"failed"` with `failure` only for an `image_gen` usage limit (:175-221,
  :261-286). The generate/edit choice is made in `request_for_call_args` (:427-497). There is no reference path and no
  `num_last_images_to_include`, so the request is **Generate** (:443-453). Our PoC passes neither, so the PoC always
  **generates**: model `gpt-image-2` (:58), `background: opaque`, `quality: auto`, `size: auto`, `n` omitted.
  The tool args are only `prompt`, `transparent_background`, `referenced_image_paths`, `num_last_images_to_include`
  (:89-98). The model cannot set quality, size or a timeout.
- **Which provider.** The session's own model provider (`ext/image-generation/src/extension.rs:43-47`, :102). It is
  available for `openai` or any `requires_openai_auth` provider. With ChatGPT sign-in the base URL is
  `https://chatgpt.com/backend-api/codex` (`model-provider-info/src/lib.rs:77`, :419-437); with an API key it would be
  `https://api.openai.com/v1`. Our jail refuses API-key sign-in, so the request is
  **`POST https://chatgpt.com/backend-api/codex/images/generations`** (`codex-api/src/endpoint/images.rs:62-74`). Edits
  use `…/images/edits` (:76-83).
- **Format.** One unary JSON POST. It is **not streamed**. `EndpointSession::execute` (`codex-api/src/endpoint/session.rs:63-114`)
  sends the body, and `post_image_request` waits for the whole body, then `serde_json` decodes it (`images.rs:85-107`).
  Extra headers: `x-codex-image-turn-id: <turn id>` and the originator (`ext/image-generation/src/backend.rs:17`, :132-141).
- **Timeouts.**
  - Per request: `None`. `Provider::build_request` sets `timeout: None` (`codex-client/src/provider.rs:79-89`). The images
    endpoint does not set one, and `execute` passes a no-op configure (`session.rs:63-72`).
    `ReqwestTransport::send` copies that `None` onto the request (`http-client/src/transport.rs:79-93`), and the
    route-aware pool's deadline comes only from it (`http-client/src/route_aware_client_pool/execution.rs:81`, :111-119,
    :171-179).
  - Connect: none. Codex's builder sets `connect_timeout` only when asked (`http-client/src/client_builder.rs:382-384`),
    and `default_http_client_builder()` does not ask (`login/src/auth/default_client.rs:416-420`).
  - Stream idle: `stream_idle_timeout` (300 s by default, `model-provider-info/src/lib.rs:63`, :504-509) applies to
    streaming responses only. The images call is unary, so it is not used.
  - **reqwest's own defaults stay in force, because Codex overrides none of them.** No `tcp_user_timeout` or
    `tcp_keepalive` appears anywhere in `codex-rs` at this tag. `base_reqwest_builder` starts from
    `reqwest::Client::builder()` (`client_builder.rs:357-392`). In reqwest 0.12.28, `src/async_impl/client.rs:299-307`
    sets these defaults: `connect_timeout: None`, `tcp_keepalive: 15 s`, `tcp_keepalive_interval: 15 s`,
    `tcp_keepalive_retries: 3`, and **on Linux (`cfg target_os = "linux"`) `tcp_user_timeout: 30 s`**. They are applied to
    every socket (:917-923). reqwest's changelog for v0.12.23 says "Fix default TCP timeout values to enabled and faster".
    WSL2 runs a Linux kernel, so this default applies to our runs.
- **Retries.** `run_with_retry` makes attempts `0..=max_attempts` (`codex-client/src/retry.rs:84-118`).
  `max_attempts = request_max_retries = 4` by default (`model-provider-info/src/lib.rs:65`, :446-452, :491-495), so there
  are **up to 5 HTTP attempts per tool call**. What is retried: 5xx and transport errors (`Timeout`, `Connection`,
  `Network`). 429 is not retried (`retry_429: false`, lib.rs:449). 4xx, build and policy errors are not retried
  (`retry.rs:23-41`). Backoff is `200 ms × 2^(n−1)` with ±10 % jitter: 200, 400, 800, 1600 ms, about **3.0 s in total**
  (`retry.rs:43-52`), unless the response carries `Retry-After` (:103-112). The error returned is the **last attempt's**
  own error, because `should_retry` is false at the last attempt, so `retry limit reached` is not reached in practice
  (:23-26, :93-117). These retries are **inside one tool call** and leave no trace in the rollout.
- **Error text.** `ImageBackendError.message` is the `ApiError` Display (`backend.rs:26-34`). The tool prefixes it with
  `image generation failed: ` (`tool.rs:177`). The possible Display strings:

  | case | text |
  |---|---|
  | transport timeout | `timeout` (`http-client/src/error.rs:23-24`) |
  | 5xx | `http 504 Gateway Timeout: Some("<body>")` (`error.rs:13-20`) |
  | connection / network | `connection failed: …` or `network error: …` (`error.rs:25-28`) |

  A reqwest error whose source chain holds an `io::ErrorKind::TimedOut` (which is ETIMEDOUT, errno 110) or a hyper
  timeout counts as `is_timeout()` (reqwest `src/error.rs:116-138`). Codex maps that to `TransportError::Timeout`
  (`transport.rs:120-131`, :133-137).
- **DEV-081's classifier** (`capability.ts` `classifyImageFailureText`):
  - `…: timeout` → `TIMEOUT`
  - `…: http 5NN …` → `HTTP_5XX`
  - `connection failed` / `network error` → `NETWORK`

  All three map to coarse `TRANSIENT` → `TOOL_FAILED_TRANSIENT`. In code mode the text reaches the session log only if
  the cell's script leaves the rejection uncaught (`Script error:`) or prints it. HUMAN-021b's script did neither, so it
  recorded `NO_TEXT`.
- **The duration in our data is the HTTP time.** `emit_turn_item_started` records `started_at_ms` right before the request.
  `emit_turn_item_completed` stamps `completed_at_ms` when it returns (`core/src/session/mod.rs:2584-2640`). The
  `ItemCompleted` event carries both (`protocol/src/protocol.rs:1948-1960`). The paginated rollout keeps it
  (`rollout/src/policy.rs:94-112`), and `thread_items.started_at_ms/completed_at_ms` are projected from it
  (`app-server-protocol/src/protocol/thread_history_projection.rs:78-86`).
  A `failed` item requires the request to have **returned an error** (or 200 with no image data). A call cancelled
  mid-way never emits `ItemCompleted`, and only `ItemCompleted` makes an item (projection :78-99).

## 3. What produces ~156 s

**Arithmetic.** With 5 attempts and about 3.0 s of backoff, 155.6–157.8 s means **30.5–31.0 s per attempt**. Other
attempt counts give other per-attempt times:

| attempts | per attempt |
|---|---|
| 1 | about 156 s |
| 2 | about 78 s |
| 3 | about 51 s |
| 4 | about 38 s |
| 5 | 30.5–31.0 s |

Only the 5-attempt case lines up with a known constant: reqwest's 30 s `TCP_USER_TIMEOUT`.

**How the 30 s cut works.** While the server generates, the socket sits idle. The keepalive timer sends its first probe at
15 s idle. At 30 s idle, if no ACK has arrived since, the kernel aborts the connection with ETIMEDOUT, because
`TCP_USER_TIMEOUT` overrides the keepalive count once it is set. reqwest reports `is_timeout()`, Codex reports `timeout`
and retries, and five times that is about 2 min 36 s. This fires **only when the probe's ACK never comes back**.

**Reproduced locally** (DEV-084, Linux 6.18 container, loopback TLS server, no Codex, no external network). A temporary
iptables rule dropped the server's ACKs after the response and was removed afterwards (INPUT back to `ACCEPT`). With the
HUMAN-024b probe:

| socket | result |
|---|---|
| A (reqwest's Linux options) | cut with `ETIMEDOUT` at 27 s of idle (30 s after the last received segment; the probe's idle clock starts after its 3 s read window) |
| B (keepalive only) | cut at 57 s (15 + 3 × 15 = 60 s) |
| C (no options) | stayed open |

Without the drop rule, all three stayed open for 45 s. The kernel side is therefore **confirmed** on this kernel. The WSL
kernel was not tested.

**Where the ACK can be lost on our path.** Codex runs in the requester jail's own network namespace
(`scripts/sales-design-capture/jail/jail.properties:47-51`). The only way out is **pasta**, a user-space TCP/IP
translator run by root (`scripts/sales-design-capture/admin.sh:149`, :160-178). So the jail kernel's TCP peer, for every
segment including keepalive probes, is **pasta**, not chatgpt.com. pasta opens its own host-side socket, which then goes
through WSL's NAT to the internet. Upstream passt only began answering keep-alive segments in **2024_11_21.238c69f**
"tcp: Acknowledge keep-alive segments, ignore them for the rest". Follow-ups came in 2025-02 (`472e2e9` "Don't discard
window information on keep-alive segments") and 2025-12 (`aa809d3` "Enable SO_KEEPALIVE if we see keep-alive
segments from container / guest"); `90f91fe` and `28f413d` near them in the log are related zero-window / ACK-timeout fixes, not keep-alive fixes ([passt log](https://passt.top/passt/log/?qt=grep&q=keep-alive);
[passt-dev thread](https://archives.passt.top/passt-dev/20241121102312.156af880@elisabeth/)). The jail was set up with
Ubuntu 24.04's `passt` package (`admin.sh:149` "sudo apt install -y passt"; the DNS note at `admin.sh:100`). **A distro
passt older than 238c69f alone would produce exactly H1.** HUMAN-024a (2026-10-22) printed `0.0~git20240220.1e6f92b-1`, Ubuntu 24.04's own package. Upstream `1e6f92b` is an ancestor of `238c69f`, so the installed pasta does not ACK keep-alive segments (DEV-086, `passt-update-plan.md`). Other
places the ACK could be lost: WSL's NAT, a middlebox, or the edge. HUMAN-024b (in the jail) and the optional 24b-host (the
same probe in the host namespace) separate pasta from the rest.

**Public evidence for the same signature on Linux:**

- **openai/codex#24323** (Linux, CLI 0.133.0): a unary `/responses/compact` request. Every attempt failed at
  30.87–31.33 s with `error.message="timeout"`, and the call failed at about 2 min 37 s. A later comment by zaid-marji
  reproduced it independently with `os error 110` (ETIMEDOUT). That is 5 ×
  about 31 s, even though a 20-minute request timeout was configured. Changing **only** reqwest's `TCP_USER_TIMEOUT` to
  600 s made the same request succeed in 42.7 s. The maintainer closed the issue by moving compaction to a different path,
  not by changing the TCP setting.
- **openai/codex#45381**, comment by thliborius (Linux Mint, CLI 0.162.1, no proxy): an `images/edits` call failed after
  159.7 s, 160.0 s and 160.9 s, with five attempts of 31.7–33.3 s each, `image generation failed: timeout`,
  `is_timeout=true`, `is_connect=false`.
- **openai/codex#45381**, comment by dreampuf (the issue's author): simple prompts generate successfully, and the timeouts
  come with more complex prompts, especially with reference images. This fits a cut that only slow generations hit.
- Upstream `main` (`61f34c3`, 2026-10-22) still locks reqwest 0.12.28, and `client_builder.rs` / `default_client.rs` there
  set no TCP options. **A CLI update is not expected to change this** (INFERRED: only those files were checked).

**Ranked hypotheses for the ~156 s:**

1. **H1 — client-side TCP abort at about 30 s × 5 attempts** (reqwest Linux `TCP_USER_TIMEOUT` 30 s plus keepalive 15/15,
   probes unanswered on the jail → pasta → WSL NAT → chatgpt.com path; an old pasta alone would do it). Text: `image generation failed: timeout`. Fits the arithmetic,
   matches two independent Linux reports to the second, and explains why fast generations (HUMAN-018's 32.6 s call, which
   started answering before 30 s of silence) succeed while slow ones fail. Most likely.
2. **H2 — the server or edge answers 5xx at about 30 s, 5 times.** Same arithmetic, because 5xx is retried. Text:
   `http 5NN …`. Possible, but the public Linux reports show `timeout` and not a status.
3. **H3 — one long attempt (about 156 s) ending in an error that is not retried.** For example, a 4xx after an internal
   server deadline, 200 with no `data` (`image generation returned no image data`), or a decode error. Four runs landing
   within ±1.1 s of each other would need a fixed server deadline near 155 s. Ruled out if HUMAN-024b shows the 30 s
   abort, because an idle connection could then not survive 156 s.
4. **Excluded:**
   - **The model or the prompt.** Same model and CLI in all four runs, and v1 failed too.
   - **An `image_gen` usage limit.** It would be structured (`failure.type = usageLimitExceeded`).
   - **A generic 429.** It is not retried and would end within seconds.
   - **Argument errors.** They leave no item.
   - **A Codex-side request timeout.** There is none.
   - **Cancellation.** It leaves no `failed` item.

Probably a different cause (proxied), but not excluded: the macOS and Windows reports in **#32297, #33050, #40233** and
the original **#45381** report show about **60 s** per attempt and about **305 s** in total, with `network error: error
sending request for url (…)`. Those platforms have no reqwest `TCP_USER_TIMEOUT` default. The original #45381 went
through a local proxy (FlClash) with a stalled upload. Note one coincidence, though: reqwest's keepalive (15 s, then 3
probes 15 s apart) gives up after **15 + 3 × 15 = 60 s on every OS** when probes go unanswered. So those reports may share
the unanswered-keepalive family with a longer limit. Do not merge the two patterns without evidence.

## 4. Issue #45381 compared with our runs

| | #45381 body | #45381, thliborius | ours |
|---|---|---|---|
| CLI | 0.154.0 | 0.162.1 | 0.159.0 |
| OS | macOS 26.5.1, arm64, via the FlClash proxy | Linux Mint, no proxy | WSL2 (Linux kernel), Codex in the jail's netns behind **pasta**; proxy env not known (HUMAN-024a prints it) |
| request | **edit** (`images/edits`, two JPEG references) | **edit** (three PNG references) | **generate** (`images/generations`, no references) |
| per attempt | about 60 s (upload 682 KB, then stall) | 31.7–33.3 s | 30.5–31.0 s (derived) |
| total | 304.6–304.7 s | 159.7–160.9 s | 155.6–157.8 s |
| error | `network error: error sending request for url (…/images/edits)` | `timeout`, `is_timeout=true` | unknown (`NO_TEXT`) |
| maintainer reply | none (open; labels CLI, connectivity, enhancement, imagen) | none | – |

Our pattern matches thliborius's Linux comment, not the issue body. The issue body is the macOS 60 s / `network error`
pattern, with a large upload that stalled. Edits upload reference images, which adds a few seconds per attempt and makes
an upload stall possible. Our generate requests are a small JSON body: the prompt is about 4.8–6.8 kB. Their failures
cannot be an upload stall; they are an idle wait for the response.

## 5. Why HUMAN-018 succeeded

- **CONFIRMED.** The two items have distinct ids, so the model called the tool **twice**. These are not internal retries:
  those happen inside one call and produce one item (`tool.rs:171-221`; `retry.rs:84-118`). The first call took 155.6 s,
  the length of five failed attempts. The second completed in 32.6 s.
- **CONFIRMED.** The client gives the second call nothing from the first. The request body is prompt, background, model,
  quality and size (`tool.rs:443-453`), with no generation or idempotency key. The only shared value is the
  `x-codex-image-turn-id` header (`backend.rs:17`, :132-141). It is the same for both calls of a turn.
  `imagegen_request_id` and `generation_id` are kept only in memory and never written (`ext/items/src/image_generation.rs:41-53`).
- **INFERRED (H1).** The second generation was fast enough that the server began answering before about 30 s of silence,
  and the remaining 2–3 s were the download of the base64 PNG. A server cache or warm path is possible, but **unknown**:
  nothing in the client source reuses a failed call's work. Whether the server finished, or charged, the generations of
  the five aborted attempts is not visible anywhere locally. On success the images path reads only the request-id header
  and no rate-limit headers (`images.rs:96-106`).

## 6. Counting and control

| what | where it is visible | can it be controlled in 0.159.0? |
|---|---|---|
| Codex runs | the PoC: exactly one `codex exec` per approved run (`codex.invoked`) | yes, already: one run, no retry by the PoC |
| image tool calls per turn | `img_calls` / `img_ok` / `img_failed` (session log); now also `img_call_ms` (DEV-084) | **no hard cap**. No config key limits tool calls. The model may call again (HUMAN-018) |
| HTTP attempts per call | **nowhere** at default settings. The `codex.retry` trace event is TRACE level on `codex_otel.trace_safe` (`retry.rs:62-82`, :107); exec's stderr filter is `error` (`exec/src/lib.rs:174`, :251-257) | only through a provider's `request_max_retries` (below) |
| usage | only a structured `usageLimitExceeded` failure | no |

**"No automatic retry" is not true end to end today.** Each failing tool call made up to 5 POSTs inside Codex, which is
4 automatic retries. The model can also re-call the tool. Ways to enforce it, each needing **human approval**, none
implemented here:

- **Retries to 0.** `request_max_retries` is a per-provider key (`model-provider-info/src/lib.rs:173-174`), but
  **`model_providers.openai` cannot be overridden**: `openai` is a reserved id and the config is rejected
  (`config/src/config_toml.rs:66-72`, :894-917). It would need a custom provider passed with `-c` on the exec command line
  only, for example `model_providers.sr-openai = { name = "…", base_url = "https://chatgpt.com/backend-api/codex",
  requires_openai_auth = true, request_max_retries = 0 }` and `model_provider = "sr-openai"`. That moves the **model**
  turns onto that provider too: `is_openai()` false, websockets off by default, no internal metadata, a different
  workspace-routing path (`model-provider/src/provider.rs:249-292`, :360-366). It is a behaviour change. Its effect is
  that a failure costs 1 attempt and about 31 s instead of 5 attempts and about 156 s. **It does not fix H1.**
- **At most one tool call (soft).** A prompt line "call the image tool at most once; if it fails, print the full error text
  and stop" is only an instruction, not a control. As a side effect it would put the error text into the cell output
  (`cell_print`: recorded as a reason, never decisive, per review F1). Prompts are fixed byte for byte, so this needs
  approval and its own PR.
- **Stop on the first failure (hard).** The PoC could watch the session log while Codex runs and terminate it when an
  image Extension item ends `failed`. This changes run.ts behaviour, so it needs approval.
- **No timeout key exists.** Codex has no `tcp_user_timeout` or request-timeout key for images, so a workaround for H1 is
  outside Codex config. All of the options below are proposals, and only if HUMAN-024b confirms H1:
  - **Update passt** (if 24a shows a version older than 2024_11_21.238c69f and 24b cuts in the jail but not on the host).
    This is a system-package change on the WSL machine. It is the direct fix when pasta is the culprit.
  - A **loopback HTTPS proxy inside the jail** does not remove a pasta problem. Its own upstream socket also goes through
    pasta, so it only helps if that socket sends no keepalive probes at all.
  - The **WSL networking mode** (`.wslconfig`, needs human approval). This is only relevant if the host-side probe is
    cut too.
  - An **upstream fix**.

## 7. Diagnostics added (DEV-084, schema `sr-design-image-poc-diagnostics/5`)

- `img_call_ms=<ms,…>`: each ended image call's `completed_at_ms − started_at_ms` from the rollout's ItemCompleted event,
  in call order, at most 16. Integers only, 0 ≤ ms ≤ 1 day, else not recorded. Before this change it was available only
  in the state DB (HUMAN-022). The **paginated** rollout already carries it on the event payload, so it is now read in
  run, before the cleanup deletes the log.
- `img_fail_timing=<bucket,…>`: one fixed bucket per failed call: `<5s` / `5-60s` / `60-140s` / `140-170s` / `>170s` /
  `unknown` (no timestamps: a legacy log has none, `protocol/src/protocol.rs:2796-2812`). Reading guide:

  | bucket | most likely meaning |
  |---|---|
  | `<5s` | an immediate 4xx (auth, policy, bad request) or a 429 that is not retried |
  | `140-170s` with reason `TIMEOUT` or `NO_TEXT` | the H1 / H2 five-attempt pattern |
  | `>170s` | something else (for example the 60 s × 5 pattern seen on macOS and Windows) |

- Unchanged: the command line, the prompts, the jail, the env allowlist, `run.lock`, the cleanup, one model call, every
  stop code and class. The new fields do not duplicate `timings_ms.first_image_tool_event`, which is the `--json` item
  stream and is always null on 0.159.0.

## 8. Next verifications, cheapest first

| # | what | cost | decides |
|---|---|---|---|
| V0 | HUMAN-022 | done, 0 | §1 |
| V1 | **HUMAN-024a**: read only. Outside the jail: kernel, WSL networking mode, **passt version**, keepalive sysctls. Inside the jail: whether a proxy env var is *set* (no value) | 0 Codex, no network | the passt lead (older than 2024_11_21.238c69f?) and context for V2 |
| V2 | **HUMAN-024b**: TCP probe in the jail, three TLS connections to chatgpt.com:443 with reqwest's Linux socket options vs without, idle 100 s | 0 Codex, no sign-in, no billing; about 2 min; 3 unauthenticated `GET /robots.txt` | H1 (A `ERR_ETIMEDOUT` at about 27 s) vs H2/H3 |
| V2' | optional **24b-host**: the same probe once in the host namespace as a non-Codex user | same as V2 | pasta vs WSL NAT / upstream |
| V3 | only if V2 is inconclusive: the same v1 PoC run (HUMAN-021b's command) after DEV-084 is merged | **1 Codex run** with image generation (plan quota) | `img_call_ms` / `img_fail_timing` per call, and the text if the script leaves it uncaught |

The exact commands and how to read them are in `design-image-poc.md` §"HUMAN-024"; `.ai/blockers.md` points there. The fix options in §6 come after V2 and each needs its own approval.

## 9. Confirmed vs inferred

| claim | status | evidence |
|---|---|---|
| endpoint `POST chatgpt.com/backend-api/codex/images/generations`, unary JSON, generate (no references) | CONFIRMED | images.rs:62-107; tool.rs:443-453; model-provider-info lib.rs:77, :419-437 |
| no request, connect or idle timeout set by Codex for images | CONFIRMED | provider.rs:79-89; transport.rs:79-93; client_builder.rs:357-392; default_client.rs:416-420 |
| reqwest 0.12.28 Linux defaults: TCP_USER_TIMEOUT 30 s, keepalive 15 s / 15 s / 3 | CONFIRMED | reqwest async_impl/client.rs:299-307, :917-923 |
| up to 5 attempts per call, 5xx and transport retried, 429 not, about 3 s backoff | CONFIRMED | retry.rs:23-52, :84-118; lib.rs:65, :446-452 |
| item duration = HTTP time of the call | CONFIRMED | session/mod.rs:2584-2640; tool.rs:153-221 |
| HUMAN-018 = two model-level calls, not internal retries | CONFIRMED | two item ids; tool.rs one request per call |
| ~156 s = 5 × ~31 s client-side TCP abort (H1) | INFERRED (strong) | arithmetic; #24323; #45381 (thliborius) |
| Linux cuts an idle `TCP_USER_TIMEOUT` 30 s + keepalive socket at about 30 s only when the probe ACKs are lost (A 27 s, B 57 s, C open; all open with ACKs) | CONFIRMED (this container's kernel, simulated drop) | §3 local reproduction |
| our path's TCP peer for Codex is pasta (jail netns) | CONFIRMED (repo config) | jail.properties:47-51; admin.sh:149, :160-178 |
| keepalive probes unanswered on our path (old pasta, or WSL NAT / upstream) | INFERRED (old pasta: 24a shows passt `1e6f92b`, older than `238c69f`); not yet measured | 24b / 24b-host (pending approval) |
| the server reuses or charges aborted generations | UNKNOWN | not visible locally |
| a CLI update would change it | INFERRED no | main 61f34c3: reqwest 0.12.28, no TCP options in the two files read |

Sources: [openai/codex#45381](https://github.com/openai/codex/issues/45381),
[openai/codex#24323](https://github.com/openai/codex/issues/24323),
[openai/codex#32297](https://github.com/openai/codex/issues/32297),
[openai/codex#33050](https://github.com/openai/codex/issues/33050),
[openai/codex#40233](https://github.com/openai/codex/issues/40233),
[reqwest CHANGELOG](https://github.com/seanmonstar/reqwest/blob/master/CHANGELOG.md).
