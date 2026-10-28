# Second Root | Design Intelligence Pilot v0.1

**Research-only / 2026-10-27 / proposal pending review.**

This folder organizes **fifteen owner-selected design study cases** and **a queue of 20 detailed reference reviews** as *structured evidence*, not templates or approved model prompts. It complements, but does not mutate, the existing reference collections.

## Files

| Path | Role | Current status |
| --- | --- | --- |
| [success-patterns.json](success-patterns.json) | CP-001–013: shop characteristics → composition principles → what was selected/rejected → implementation gaps | Fifteen documented study cases; analysis interpretation, not scientific proof |
| [review-queue.json](review-queue.json) | Source-traceable priority list of 10 existing AI-reviewed screenshots and 10 new audits | **Not** 20 completed human reviews |
| [validate.mjs](validate.mjs) | Offline, read-only cross-check against case registry, original v03 candidate source URLs and pending owner review status | May be run with `node design-library/intelligence/v01/validate.mjs` |

## Exact current inventory

- v02 reference library: **40** historical entries with mixed review labels, **none attributable to a human review**.
- v03 additive candidate set: **40** entries, page text or gallery metadata checked; text alone does not establish how a page looks.
- v03 AI viewport evidence: **10** specific references, 1440px + 390px notes, recorded as AI observations; **owner decision pending**.
- Second Root study successes: **14** case IDs, **7 with local HTML/CSS/JS PoCs** (CP-003/004/005/007/009/010/011), **6 concept/image only** (CP-001/002/006/008/012); **no production deployment is implied**.
- This v0.1 pilot prioritizes **20 depth reviews**, but it does **not** automatically accept or score any design reference.

## How to use this in a new design experiment

1. Confirm the *new* shop's official facts and imagery rights independently; mark any unavailable details as unknown.
2. Form at least **two truly different conceptual compositions** from the verified shop-specific characteristic. The principle is to translate its inherent geometry, motion, material, or experience, **not** to fetch a fixed pattern based on shop industry.
3. Use the case records to identify **possible pitfalls** and conceptual transformations; do not copy any existing case's wording, photography, visual hierarchy or exact geometry.
4. Show the original compositions to the owner for qualitative selection. Record what the owner actually chose separately from designer interpretation.
5. Once a concept is selected, split photographic assets from type, build responsive PC/mobile layouts, compare real browser screenshots, document issues and design fidelity, and retain the rejected experiments.
6. Obtain a separate **human review** before new source analysis can be labeled reviewed/usable for an automated prompt. Nothing in this folder is auto-injected into Codex/Claude or a sales workflow.

## Example (reasoning only, NOT a template)

If a shop has a verified signature material with linear grain, try generating a composition from the grain direction. Another plausible original direction may come from the purchasing experience, such as repeated small decisions along a path. The reference case of a loaf or a spinning cookie cannot be transplanted to the new shop just because both are food businesses.

## Review process / next work

**Phase A (first 10):** human acceptance or rejection of existing AI viewport evidence in `design-library/research/v03/viewport-evidence-20261025.json`. Screenshots are *not* in GitHub; re-obtain when necessary. Record uncertainty where inaccessible.

**Phase B (next 10):** perform source-specific 1440/390 visual captures and explicit strengths, weaknesses, mobile differences and rights notes for new candidates. Concentrates on salons, wellness, beauty and restaurant material to address the current overemphasis on food.

Two **non-food shop studies** now have owner-selected HTML PoCs: ORGN. (CP-007, salon/fashion) and 豆＊豆 (CP-009, handmade crafts). The wellness study Seitai Go (CP-008) has a selected static design but no functioning site. More businesses and live, owner-approved implementations are needed before generalizing this design workflow. Only after comparing with owner feedback should any generalized design process be proposed for production.

## Immutable safety boundaries

- Never claim an unreviewed candidate is reviewed, or an AI observation constitutes human review.
- Never use third-party imagery, logos, copy, trademarks or a copied layout as deployable assets.
- Do not promote the selected cases to templates. Stored descriptions are **design research data**, not instructions or evidence of a client contract.
- No changes to `main`, Supabase, Vercel, sales automations, or `lib/design-agent` in this work.
- This is version 0.1 **in a review branch**, not a connected Supabase or production generation database.

## v0.2 — Structure First（新規研究）

[構造を先に3案発明する手順と、静的な重複チェック](../v02/README.md) を試験導入。従来の研究事例12件は参照資料であり、自動的に構図を再利用するわけではない。v0.2は研究専用・未承認で、制作・営業・公開の生成器にはまだつながっていない。

### CP-011 BAR N（2026-10-27研究採用）

[CP-011研究記録](../../success-cases/CP-011-BAR-N-GLASS-SILENCE.md)：HTML v1でありきたりになった中盤の横長写真帯を改善したv2が採用された。巨大グラスと屈折光の構図は保護し、静かなバーの世界観を写真・余白・レイヤーの非対称なリズムに変換。承認は研究デザインのみに限定され、公式サイトの公開・店の許諾ではない。

### CP-012 Admy（2026-10-27研究採用）

[Admyの鉱物標本型エディトリアル研究](../../success-cases/CP-012-Admy-ONE-OF-A-KIND.md)を12件目として追加。ユーザーが初期FULLデザインを採用したが、**画像1枚のみの研究成功**。HTML/CSS/JS・PC/スマホ実ブラウザ検証や実店舗による許諾は未実施。

### CP-013 スペースたのしい（2026-10-28研究採用）

[CP-013研究記録](../../success-cases/CP-013-SpaceTanoshii-TOY-PACKAGING.md)：レトロ玩具のブリスターパック、貼り絵、シール、紙の質感をHeroと下層構造に変換。元のHeroを保護した軽微な改良v2をユーザーが「成功例でいいです」と承認。画像のみ・HTML未実装。成功事例は**13件（ローカルPoC7件＋画像のみ6件）**。20件の審査キューは未承認のまま。

### CP-015 imairo. — TABLE JOURNAL v2（2026-10-28研究採用）

[採用事例の正式研究記録](../../success-cases/CP-015-imairo-TABLE-JOURNAL-v2.md)。ユーザー「成功例とします」により食卓マップのワイドHeroを保護した紙片ノート型ローカルHTML/CSS/JS PoCを採用。**現在の成功事例は14件（ローカルHTML PoC 8件・画像のみ6件）**。生成画像中に焼き込まれた文字と研究用画像の切り出しは実店舗サイトに再利用できず、商用公開や生成器投入の許可ではない。CP-014は引き続き審査保留。

### CP-016 ズールー工作所 — COUNTERWEIGHT ZK-01 v1（2026-10-28採用）

[15件目の正式研究成功記録](../../success-cases/CP-016-Zulu-COUNTERWEIGHT-ZK01.md)／[3構造比較とブラウザPoCの履歴](../v02/experiments/CP016-zulu-structural-reset.json)。写真＋見出し＋波型境界の初稿を不採用にし、支点・重り・余白の実操作をHTML/SVGで構築。ユーザー「成功例でいいと思います」により研究採用。**現時点で15件（ローカルPoC9件・画像のみ6件）**。CP-014は未採用。本番/実店舗許諾なし。
