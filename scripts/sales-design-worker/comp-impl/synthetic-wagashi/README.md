# SYNTHETIC comp-to-site fixture (DEV-082)

**Not a design result. Not Codex output. Not a real comp.** A test fixture for the comp-to-site harness
(`lib/design-agent/comp-impl/`, `docs/operations/comp-to-site.md`):

- `comp.html` — a hand-drawn stand-in for a Codex comp (flat shapes and type on a 1440 × 2050 artboard).
  `buildSyntheticBundle` renders it to `mockup.png` at half scale (720 × 1025) at test / run time.
  Its words are never read as facts.
- `layout-spec.json` — the implementation spec Claude wrote from that comp (fractions of the artboard).
  `comp_sha256` is filled in when the comp is rendered (the PNG's bytes depend on the machine's fonts).
- `evaluation.json` — `comp_kind: synthetic`, not human-confirmed: the run can never report it as a design result.
- `page/` — Claude's hand-written implementation (`index.html`, `style.css`, `assets.json` with no assets):
  flat CSS placeholders for every image slot, no AI image, no real photo, no template markup.

Facts: the DEV-073 fixture `scripts/sales-design-worker/compare/shops/wagashi.json` (fictional shop 架空菓庵).
Every result of a run on this fixture is labelled `synthetic_only`.
