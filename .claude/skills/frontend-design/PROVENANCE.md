# frontend-design (vendored, unmodified)

This directory carries Anthropic's official `frontend-design` skill so that the Claude Code cloud
sessions working on this repository can load it as a project skill (`.claude/skills/`), where the
account-level plugin is not available.

| Item | Value |
| --- | --- |
| Upstream repository | https://github.com/anthropics/claude-plugins-official |
| Upstream path | `plugins/frontend-design/skills/frontend-design/` |
| Plugin version | 1.1.1 (`plugins/frontend-design/.claude-plugin/plugin.json`) |
| Upstream commit | `a7ba5b93db0c7c8d17f3f1d25853adca79598a1a` (2026-10-30) |
| Author | Anthropic (authors listed in the upstream README: Prithvi Rajasekaran, Alexander Bricken) |
| License | Apache License 2.0 — full text in `LICENSE.txt` (copied unchanged from the upstream skill directory) |
| `SKILL.md` SHA-256 | `d91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3` |
| `LICENSE.txt` SHA-256 | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |
| Vendored on | 2026-10-31 (DEV-132) |

## Changes

None. `SKILL.md` and `LICENSE.txt` are byte-for-byte copies of the upstream files;
`tests/unit/skills/vendored-frontend-design.test.ts` pins both hashes. This file (`PROVENANCE.md`)
is the only addition and is not part of the upstream work.

To update: copy both files from a newer upstream commit, update the table above and the hashes in
the test, and record the upstream version in the PR.

## Precedence in Second Root

This is a general-purpose design skill. In this repository, Second Root's own rules come first
(`CLAUDE.md`, and the `second-root-design-director` skill for shop designs):

- The shop's fact pack and Identity Lock win over any copy or naming idea. Never invent shop facts.
- Method B limits (JavaScript, network, typefaces, assets) win over the skill's suggestions about
  motion, web fonts or imagery.
- The skill's advice on writing copy applies only to wording that the fact pack allows.
