-- Second Root Sales Agent — the test-recipient guard's fallback no longer
-- refuses real non-ASCII domains (DEV-263h, PR #270 review Low 1;
-- Issue #263. Code, tests and the local DB approved. Staging / Production need
-- their own approval — this migration is applied to the local stack only).
--
-- 1. sales_test_email_reserved (20261115000100): a domain with characters
--    other than [a-z0-9.-] left after NFKC / folding was tested with EVERY
--    such character removed, so 日本example.com or shop.example.東京 read as
--    example.com / shop.example and were refused. Now only the invisible
--    (default-ignorable / format) characters are removed — soft hyphen, the
--    zero-width and bidi controls, word joiner and invisible operators, BOM,
--    variation selectors, tags, the combining grapheme joiner, Hangul fillers,
--    Mongolian / Khmer invisibles — and every other remaining character is
--    replaced with a placeholder letter (x), so it still separates labels the
--    way the server's IDNA mapping does (lib/sales/test-recipient.ts:
--    domainToASCII turns a non-ASCII label into an xn-- label, never into
--    ASCII that could match a reserved name). A zero-width character still
--    cannot hide a reserved name (ex\u200dample.com stays reserved).
-- (PR #270 Low 4 — revoking `grant select … to authenticated` on
-- sales_local_test_settings — is NOT done: scripts/staging/lib.mjs check
-- authenticated_can_read requires SELECT for the signed-in role on every
-- sales_* table, RLS limiting rows; the table has no policy, so no row is read.)
--
-- Rollback (one transaction; restores the 20261115000100 definition):
--   begin;
--   create or replace function public.sales_test_email_reserved(p_email text)
--   returns boolean language plpgsql immutable set search_path = '' as $$
--   declare v_at integer; v_domain text;
--   begin
--     if p_email is null then return false; end if;
--     v_at := length(p_email) - strpos(reverse(p_email), '@') + 1;
--     if strpos(p_email, '@') = 0 then return false; end if;
--     v_domain := btrim(substr(p_email, v_at + 1));
--     if v_domain = '' then return false; end if;
--     v_domain := lower(translate(normalize(v_domain, NFKC), '。．｡', '...'));
--     v_domain := regexp_replace(v_domain, '\.+$', '');
--     if v_domain = '' then return true; end if;
--     if public.sales_reserved_test_domain(v_domain) then return true; end if;
--     if v_domain ~ '[^a-z0-9.-]' then
--       return public.sales_reserved_test_domain(regexp_replace(regexp_replace(v_domain, '[^a-z0-9.-]', '', 'g'), '\.+$', ''));
--     end if;
--     return false;
--   end;
--   $$;
--   delete from supabase_migrations.schema_migrations where version = '20261116000100';
--   commit;
-- (.ai/reviews/DEV-263h.md holds the same block; an integration test runs it.)

create or replace function public.sales_test_email_reserved(p_email text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_at integer;
  v_domain text;
begin
  if p_email is null then
    return false;
  end if;
  v_at := length(p_email) - strpos(reverse(p_email), '@') + 1;
  if strpos(p_email, '@') = 0 then
    return false;
  end if;
  v_domain := btrim(substr(p_email, v_at + 1));
  if v_domain = '' then
    return false;
  end if;
  v_domain := lower(translate(normalize(v_domain, NFKC), '。．｡', '...'));
  v_domain := regexp_replace(v_domain, '\.+$', '');
  if v_domain = '' then
    return true;
  end if;
  if public.sales_reserved_test_domain(v_domain) then
    return true;
  end if;
  if v_domain ~ '[^a-z0-9.-]' then
    -- the invisible characters go; every other character becomes a letter (it still belongs to its label)
    v_domain := regexp_replace(v_domain,
      '[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8\U000e0000-\U000e0fff]',
      '', 'g');
    v_domain := regexp_replace(regexp_replace(v_domain, '[^a-z0-9.-]', 'x', 'g'), '\.+$', '');
    return v_domain = '' or public.sales_reserved_test_domain(v_domain);
  end if;
  return false;
end;
$$;
