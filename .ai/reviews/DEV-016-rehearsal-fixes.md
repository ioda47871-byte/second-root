# DEV-016 rehearsal fixes review (PR #24) — fresh-context reviewer

VERDICT: PASS (Critical 0 / High 0 / Medium 2 / Low 5)

Verified: grants preserved on sales_run_status (postgres, service_role), search_path=''; a genuinely running run is never blocked (running runs are found before today's run); expiry only affects runs started on an earlier JST day; JST boundary correct; prompt's one-run/day rule consistent with server responses (completed 200 `none`, failed 409 `start_new_run`, null → start); official-site guidance matches lib/sales/url.ts; rehearsal log has no secrets or real shop names.

| Sev | Finding | Resolution |
|---|---|---|
| Medium | Instagram candidates may be prepared without anyone reading the profile (DM refusal notice unseen) | Human gate: 「DMを送る」 now tells the admin to check the profile for 「DM不可」「営業お断り」 before sending (MVP_SPEC §4.1); prompt records 「プロフィール未確認」 |
| Medium | ARCHITECTURE §5 status row outdated | Fixed (running → today's run → null; 409 for failed) |
| Low | One run/day enforced only by prompt | Documented as accepted in §7.3 (daily cap is global under a lock) |
| Low | dry-run broke on a second local run the same day | Fixed |
| Low | Marketplaces (minne / Creema / Yahoo!ショッピング) treated as official by the server | Fixed: not official |
| Low | Verified example used an unread instagram_profile source | Fixed |
| Low | Step 5 wording | Fixed |
| (test) | No API test for 409 on status for today's failed run | Added |
