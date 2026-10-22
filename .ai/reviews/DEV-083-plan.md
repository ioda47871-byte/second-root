# DEV-083 design plan review (PR #98, docs only) — fresh-context reviewers

Merged to develop as 860f36c (head 25c589f; CI green after one re-run of the unit job, whose first attempt was cancelled at the 15-min
limit while `npx playwright install --with-deps` hung on the Ubuntu apt mirror before any test ran — infrastructure).

| Round | Head | Verdict | Main findings | Resolution |
|---|---|---|---|---|
| 1 | 35e4f77 | FAIL | H1 ground-layer strokes invisible to ink proof; H2 proofs only for Chromium + Linux fonts; M1 V2 needs exact Appendix E paint order; M2–M8 (V4 vs §3.1(a), cropped-image contrast, PAIRS in 1px, vh sweep, spec freeze, approvals list, V6 cost); L1–L10 | 328f99d: V3b glyph-ground flatness / proven scrim / gradient stop rules; pinned fonts before overlap, perturbation pass, WebKit (approval); exact paint order; approvals A6b/A6c/A12/A12b/A14/A15; cost marked unmeasured; human rubric "each ≥4" recorded as adopted |
| 2 | 328f99d | PASS-with-nits | texture grounds between widths; scrim interval contrast; static flex/grid z-index stacking; phase-B naming; units; atomic-painting escapes; V4 exception scope; phase-A wiring | 723bd50 |

Docs: `docs/design/dev-083-expressive-safe-reproduction.md`, `docs/design/claude-auto-implementation-roadmap.md`. DEV-083 is backlog
(depends on DEV-072, DEV-082). Phase A (checks only, no relaxation, no outcome change for existing pages) follows AI_WORKFLOW §4; phases B–F
and every threshold need human approval.
