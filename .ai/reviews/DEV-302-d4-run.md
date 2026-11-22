# DEV-302 d4 run path (PR #320, OWNER MERGE ONLY) — Fresh Review

Independent reviewer (separate context, read-only; no script under sales-design-worker / capture / design-artifact run),
base `origin/develop` 5d359cd2.

## Round 1 — 2fda20ff — PASS (C0 / H0 / M1, Low 3)

Holds: d3 row and P3 packet parsing unchanged (stricter only: `plan.direction_key === a.direction`); no cross-direction
approval (id → exactly one row, per-row packet path, id and plan-id regexes, receipt / manifest / delivery / audit
direction checks); the d4 packet stays unapproved and no `.md` under tests/ reads as an approved d4 packet; shell regexes
still anchored, reserved date widened to d4, root / trusted-path checks unchanged; one use per full id; fixture approach
sound; import-allowlist edits limited to two data-only modules.

- M1: a new test (`full-page-call.test.ts:700`) timed out under a parallel run → explicit 30 s timeout.
- L1: an unused P3 `PACKET_PATH` in `imagefirst-autostart.sh` → replaced by a comment (the worker picks the packet).
- L2: d4 packet §4 left out the hand-run entry → one bullet added; the SHA-pinned unapproved fixture refreshed.
- L3: `docs/operations/imagefirst-pilot.md` described d3 only → a d4 note at the top.

Known host-only failures (also on develop; CI green): 4 in `pilot.test.ts` (a real codex / claude on this WSL's PATH),
1 in `claude-audit.test.ts`.

## Round 2 — e605b655 — PASS (C0 / H0 / M0, no new findings)

M1 and L1–L3 confirmed fixed; the three unit folders: 558 passed, only the 5 known host failures; the d4 packet stayed
未承認 / 未記入. CI run 44933238961 success on e605b655. Recorded on the PR (comment 7067513407) and merged by the owner
(PR #320 → develop 745d0388, OWNER MERGE ONLY).
