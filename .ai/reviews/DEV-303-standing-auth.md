# DEV-303 standing pre-authorization (root side) — Fresh Review

Independent reviewer (separate context, read-only; protected scripts only in the fake WSL). Base PR #328 d0827a29.
OWNER MERGE ONLY (root scripts, MVP_SPEC §7.1).

## Round 1 — 4927ec54 — FAIL (C1 / H2 / M2 / L3)

- C: root ran the develop TIP at pickup, so Claude-merged code (npm ci lifecycle, worker, preflight node) would run
  outside the jail with no human step (AF_UNIX reaches /run/WSL interop → Windows → root) → owner-pinned
  `worker_commit` recorded by `standing` (= the owner-checked admin clone HEAD = origin develop then); runs execute
  only it; root pre-fetches it (AUTORUN_STANDING_COMMIT_UNAVAILABLE); tip/ancestor rule removed.
- H: per-run limits were said to be root's but live in worker code → spec separates root-enforced (run count, one
  attempt per id, pinned commit, timeout) from pinned-worker limits; root counts images after the run and freezes on
  >6 or uncountable (only `standing --unfreeze`). H: stale doc → rewritten.
- M: `req-` request ids, never the approval-id form. M: ancestor acceptance → removed. L: unreadable attempt time →
  dir mtime; rejected/ capped at 200; origin URL leading `-` refused in setup.

## Round 2 — 58718f0d — PASS (L3)

- All fixes confirmed; throw-away fetch repo, pilot fetch by id, standing re-run during a run, freeze evasion probed
  and sound. L: the image check counts files left, not calls (spec says so; a provider spend cap would make it a real
  limit); one stale doc line (fixed in bb657247); residual: the pinned worker still runs outside the jail (owner-chosen
  code; long-term a jail-equivalent unit).

## Integration with #331 — Round 1 e3318d75 / c525c818 — FAIL (H1 / M1 / L1) → Round 2 799a6b82 / cdc14710 — PASS

- H: phase2f-live/isolation.test.ts expectations (3 pilot + 3 preflight worker lines). M: the preflight runs the
  worker's request precheck as the worker before root's marker. L: request ids containing "imagefirst" refused on the
  root side. Integrated tree: typecheck clean, 451 passed, 5 known host-only failures.
