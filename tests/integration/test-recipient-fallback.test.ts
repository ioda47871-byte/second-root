import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isReservedEmailDomain } from "@/lib/sales/test-recipient";
import { db } from "./helpers";

// PR #270 review Low 1 (folded into DEV-263h): the database's test-recipient fallback removes only the invisible
// characters and keeps every other character inside its label, so a real non-ASCII domain is not read as a reserved one.
// Migration 20261116000100, on the LOCAL stack.

const MIGRATION = "supabase/migrations/20261116000100_sales_test_email_reserved_fallback.sql";
const reserved = async (email: string | null) => (await db.query("select public.sales_test_email_reserved($1) as r", [email])).rows[0].r as boolean;

const CASES: [string, boolean][] = [
  // real non-ASCII domains: never reserved (the server's IDNA mapping agrees)
  ["info@日本example.com", false],
  ["info@shop.example.東京", false],
  ["info@ショップexample.net", false],
  ["info@例え.test.jp", false],
  // invisible characters cannot hide a reserved name
  ["info@ex\u200dample.com", true],
  ["info@exa\u00admple.com", true],
  ["info@example\u2060.org", true],
  ["info@example.com\ufe0f", true],
  ["info@\u200bexample.net", true],
  // unchanged from 20261115000100
  ["info@example.com", true],
  ["info@ｅｘａｍｐｌｅ．ｎｅｔ", true],
  ["info@example。com", true],
  ["info@x.test", true],
  // PR #271 L1: the shorthand format controls (UTS46 ignored) are removed too
  [`info@exampl${String.fromCodePoint(0x1bca0)}e.com`, true],
  [`info@example.org${String.fromCodePoint(0x1bca3)}`, true],
  // PR #271 L2: the placeholder is not a letter, so a non-ASCII character cannot complete a reserved name
  ["info@e日ample.com", false],
  ["info@exampl日.net", false],
  ["info@日.example.com", true],
  ["info@shop.co.jp", false],
  ["info@mytest.com", false],
];

describe("sales_test_email_reserved: the fallback (20261116000100)", () => {
  it("does not refuse real non-ASCII domains; invisible characters still cannot hide a reserved name", async () => {
    for (const [email, want] of CASES) expect(await reserved(email), email).toBe(want);
    expect(await reserved("info@\u200b")).toBe(true);
    expect(await reserved(null)).toBe(false);
  });

  it("agrees with the server's gate on the non-ASCII and invisible cases", async () => {
    for (const [email] of CASES.slice(0, 9)) expect(await reserved(email), email).toBe(isReservedEmailDomain(email));
  });
});

/** The rollback SQL of the review record, without its own begin / commit (the test owns the transaction). */
function rollbackSql(): string {
  const md = readFileSync(".ai/reviews/DEV-263h.md", "utf8");
  const block = md.slice(md.indexOf("<!-- rollback-sql-20261116000100:start -->"), md.indexOf("<!-- rollback-sql-20261116000100:end -->"));
  const sql = block.slice(block.indexOf("```sql") + "```sql".length, block.lastIndexOf("```"));
  return sql.replace(/^\s*(begin|commit);\s*$/gm, "");
}

describe("the migration's rollback", () => {
  it("restores the 20261115000100 fallback, and applies again (inside a rolled-back transaction)", async () => {
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query(rollbackSql());
      expect((await c.query("select public.sales_test_email_reserved('info@日本example.com') as r")).rows[0].r).toBe(true);
      await c.query(readFileSync(MIGRATION, "utf8"));
      expect((await c.query("select public.sales_test_email_reserved('info@日本example.com') as r")).rows[0].r).toBe(false);
      expect((await c.query("select public.sales_test_email_reserved($1) as r", ["info@ex\u200dample.com"])).rows[0].r).toBe(true);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
