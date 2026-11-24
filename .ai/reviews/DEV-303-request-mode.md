# DEV-303 IMAGE_FIRST request mode (PR #331) — Fresh Review

Independent reviewer (separate context, read-only), also checking integration with #326 → #328 → #330.

## Round 1 — e3318d75 — #331 PASS (M1 / L2); integration FAIL (H1 / M1 / L1)

- #331 sound: one use per request id (O_EXCL claim + ledger), one Codex batch / 6 images in schema and code, outputs
  only under ~/sr-runs, Codex blocked from ~/second-root-shops and the request dir, real-shop records private,
  research-log refuses real shops, request ids never "imagefirst", d1/d3/d4 pins untouched.
- M: real-shop facts allowed under `.local-shops` (inside the clone) → only `second-root-shops` for real_shop.
  L: quote characters in direction text → refused. L: created_at fractional seconds → exact `YYYY-MM-DDTHH:MM:SSZ`.
- Integration H: phase2f-live/isolation.test.ts pinned two pilot worker lines; #330 adds a third → expectations
  updated in #330. M: no worker precheck before root's marker → preflight runs the worker `--request … --precheck`
  as the worker first. L: root allowed ids containing "imagefirst" → refused on the root side too.

## Round 2 — #331 cdc14710, #330 799a6b82 — PASS (both; no new findings)

- develop + #326 + #328 + #330 + #331 merge cleanly; typecheck clean; imagefirst-worker + image-first +
  phase2f-live/isolation 451 passed, 5 failed = the known host-only failures on this WSL. Precheck contract (args,
  env, exit codes, JSON status) matches end to end.
