# DEV-303 photo-materials stage + MVP_SPEC §7.1 amendment (PR #333) — Fresh Review

Independent reviewer (separate context, read-only), also checking integration with #326 → #328 → #330. OWNER MERGE ONLY.

## Round 1 — 4258a70f — PR PASS (M2 / L3); integration PASS (M1 / L1)

- Sound: strict schemas for both stages; photo_inputs resolved only from the stage-1 run's private output (O_NOFOLLOW,
  nlink 1, size cap, PNG magic, sha256 in request and receipt), bound into plan_sha256 and re-hashed by the entry;
  inputs staged only in the Codex temp dir (never in parts/ or the inbox); one use per id for both stages; nothing in
  the repo; d1/d3/d4 pins unchanged; research log refuses image-material bundles and real shops; the 5 §7.1 conditions
  are in the prompts.
- M: a hand-made photo run by the same uid can pass uid/mode checks → raised the bar (receipt without stop_code,
  not interrupted, verifying sealed inbox bundle with each sha256); residual documented and owner-gated (it adds
  nothing beyond what the implementing Claude could place in HTML; the owner's final review is the gate).
  M: product-like subjects only prompt-blocked → documented; Claude's independent review checks the brief.
- Integration M: every photo run would end PILOT_AUDIT_DRY_RUN_FAILED → the audit skips image-material bundles with
  the pilot's expected planned/completed status, calls 0. L: summary regex prints pc=0 sp=0 for photo runs (cosmetic,
  in #330). L: stop_code / sealed checks; record `use` by stage — fixed.

## Round 2 — aafcd09d — PASS (PR alone and integration)

- All fixes confirmed; a photo run now ends PILOT_DONE in the integrated pilot. Integrated tree: no conflicts,
  typecheck clean, 678 passed, 5 failed = known host-only. Root limits unchanged: envelope accepts the new fields,
  ≤6 images per run for both stages, one attempt per id, pinned worker_commit, quotas, freeze.
- Accepted residual (Medium): same-uid forged run with a self-consistent sealed bundle; gate = owner's final check.
