import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { submitDemoReview } from "@/lib/admin/demo-review";
import { INVALID_NOTE_MESSAGE } from "@/lib/sales/demo-version/admin-messages";
import { QUALITY_CHECKLIST_ITEMS } from "@/lib/sales/demo-version/quality";
import { normaliseNote } from "@/lib/sales/demo-version/review-input";
import { seedDemoVersion, type SeededVersion } from "../support/seed-demo-version";
import { createUser, db, makeAdmin, serviceClient, signedInClient } from "./helpers";

// DEV-196d-5: the admin's quality decision through the server's re-check and the DEV-196c function
// sales_review_demo_version, on the LOCAL stack, as a signed-in admin. No object is read (runs in CI). Fictional
// shops and example.com only.

const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: randomBytes(32).toString("base64url") };
const ALL_OK = Object.fromEntries(QUALITY_CHECKLIST_ITEMS.map((k) => [k, "ok"]));
let admin: SupabaseClient;
let adminId: string;
let outsider: SupabaseClient;

beforeAll(async () => {
  const n = randomBytes(4).toString("hex");
  adminId = await createUser(`demo-review-admin-${n}@test.example.com`);
  await makeAdmin(adminId);
  await createUser(`demo-review-outsider-${n}@test.example.com`);
  admin = await signedInClient(`demo-review-admin-${n}@test.example.com`);
  outsider = await signedInClient(`demo-review-outsider-${n}@test.example.com`);
});

async function seed(o: { ai?: boolean } = {}) {
  return seedDemoVersion(db, serviceClient(), { upload: false, ...(o.ai ? { aiConceptConfirmedBy: adminId } : {}) });
}
const fileSha = async (v: SeededVersion, path: string) => (await db.query("select sha256 from public.sales_demo_version_files where version_id = $1 and path = $2", [v.versionId, path])).rows[0].sha256 as string;
const bundle = async (v: SeededVersion) => (await db.query("select bundle_sha256 from public.sales_demo_versions where id = $1", [v.versionId])).rows[0].bundle_sha256 as string;
const imageSha = async (v: SeededVersion) => (await db.query("select sha256 from public.sales_demo_images where id = $1", [v.imageId])).rows[0].sha256 as string;

async function input(v: SeededVersion, over: Record<string, unknown> = {}) {
  return {
    prospectId: v.prospectId,
    versionId: v.versionId,
    decision: "approved",
    checklist: ALL_OK,
    viewedRenders: { desktop_1440: await fileSha(v, "renders/desktop_1440.webp"), mobile_390: await fileSha(v, "renders/mobile_390.webp") },
    bundleSha256: await bundle(v),
    impersonation: [],
    acknowledgedSendStop: true,
    note: null,
    ...over,
  };
}
const submit = (raw: unknown, client: SupabaseClient = admin, env: Record<string, string | undefined> = ENV) => submitDemoReview(raw, { env, now: new Date(), client: client as never });
const reviews = async (v: SeededVersion) => (await db.query("select decision, state, checklist, viewed_renders_sha256, reviewed_by from public.sales_demo_quality_reviews where version_id = $1", [v.versionId])).rows;
const status = async (v: SeededVersion) => (await db.query("select status from public.sales_demo_versions where id = $1", [v.versionId])).rows[0].status as string;

describe("submitDemoReview (local stack, through sales_review_demo_version)", () => {
  it("approves when every condition holds: recorded as this admin, with the 7 answers and the renders seen", async () => {
    const v = await seed();
    const raw = await input(v);
    const r = await submit(raw);
    expect(r).toEqual({ ok: true, decision: "approved", replayed: false });
    expect(await status(v)).toBe("approved");
    const [row] = await reviews(v);
    expect(row).toMatchObject({ decision: "approved", state: "active", checklist: ALL_OK, viewed_renders_sha256: raw.viewedRenders, reviewed_by: adminId });
    expect((await db.query("select approved_version_id from public.sales_demos where id = $1", [v.demoId])).rows[0].approved_version_id).toBe(v.versionId);
  });

  it("flag off and a non-admin: refused, nothing written", async () => {
    const v = await seed();
    expect((await submit(await input(v), admin, { ...ENV, SALES_DEMO_VERSIONS_ENABLED: "false" })).ok).toBe(false);
    expect((await submit(await input(v), outsider)).ok).toBe(false); // RLS: the outsider sees no shop
    expect(await reviews(v)).toEqual([]);
    expect(await status(v)).toBe("draft");
  });

  it("stale bundle, a missing answer, an ng on approve, a render not viewed, no acknowledgement: refused, nothing written", async () => {
    const v = await seed();
    const cases: Array<[string, Record<string, unknown>, string | null]> = [
      ["stale", { bundleSha256: "0".repeat(64) }, "STALE"],
      ["missing item", { checklist: { ...ALL_OK, not_a_copy: undefined } }, null],
      ["ng on approve", { checklist: { ...ALL_OK, not_a_copy: "ng" } }, "CHECKLIST_HAS_NG"],
      ["SP not viewed", { viewedRenders: { desktop_1440: await fileSha(v, "renders/desktop_1440.webp") } }, "RENDER_NOT_VIEWED"],
      ["wrong render sha", { viewedRenders: { desktop_1440: "a".repeat(64), mobile_390: await fileSha(v, "renders/mobile_390.webp") } }, "RENDER_NOT_VIEWED"],
      ["no acknowledgement", { acknowledgedSendStop: false }, "SEND_STOP_NOT_ACKNOWLEDGED"],
      ["unknown image confirmation", { impersonation: [{ imageId: v.imageId, sha256: "b".repeat(64) }] }, "IMPERSONATION_UNKNOWN_IMAGE"],
    ];
    for (const [label, over, code] of cases) {
      const r = await submit(await input(v, over));
      expect(r.ok, label).toBe(false);
      if (code && !r.ok) expect(r.refusals, label).toContain(code);
    }
    expect(await reviews(v)).toEqual([]);
  });

  it("AI concept image: approval needs its confirmation by id AND current sha256", async () => {
    const v = await seed({ ai: true });
    const none = await submit(await input(v));
    expect(none.ok === false && none.refusals).toContain("IMPERSONATION_NOT_CONFIRMED");
    const wrong = await submit(await input(v, { impersonation: [{ imageId: v.imageId, sha256: "c".repeat(64) }] }));
    expect(wrong.ok === false && wrong.refusals).toEqual(expect.arrayContaining(["IMPERSONATION_UNKNOWN_IMAGE", "IMPERSONATION_NOT_CONFIRMED"]));
    const foreign = await submit(await input(v, { impersonation: [{ imageId: v.imageId, sha256: await imageSha(v) }, { imageId: "00000000-0000-4000-8000-000000000999", sha256: await imageSha(v) }] }));
    expect(foreign.ok === false && foreign.refusals).toContain("IMPERSONATION_UNKNOWN_IMAGE");
    expect(await reviews(v)).toEqual([]);
    const ok = await submit(await input(v, { impersonation: [{ imageId: v.imageId, sha256: await imageSha(v) }] }));
    expect(ok).toMatchObject({ ok: true, decision: "approved" });
  });

  it("rights no longer usable (image revoked) block every decision", async () => {
    const v = await seed();
    expect((await admin.rpc("sales_revoke_demo_image", { p_image_id: v.imageId, p_code: "RIGHTS_COMPLAINT" })).error).toBeNull();
    for (const over of [{}, { decision: "changes_requested", checklist: { ...ALL_OK, not_a_copy: "ng" } }]) {
      const r = await submit(await input(v, over));
      expect(r.ok === false && r.refusals).toContain("BLOCKED");
    }
    expect(await reviews(v)).toEqual([]);
  });

  it("修正を依頼 / 却下 need an ng; they do not need the renders viewed or the acknowledgement", async () => {
    const v = await seed();
    const allOk = await submit(await input(v, { decision: "changes_requested", viewedRenders: {}, acknowledgedSendStop: false }));
    expect(allOk.ok === false && allOk.refusals).toContain("DECISION_NEEDS_NG");
    const r = await submit(await input(v, { decision: "changes_requested", checklist: { ...ALL_OK, shop_specific_structure: "ng" }, viewedRenders: {}, acknowledgedSendStop: false, note: "店名を入れ替えても成り立つ構成" }));
    expect(r).toMatchObject({ ok: true, decision: "changes_requested" });
    expect(await status(v)).toBe("draft");
    expect(await reviews(v)).toEqual([expect.objectContaining({ decision: "changes_requested", state: "active" })]);
  });

  it("Low (a): a note like style.css is refused with the clear message, before the database", async () => {
    const v = await seed();
    const r = await submit(await input(v, { note: "style.css を直す" }));
    expect(r).toMatchObject({ ok: false, error: INVALID_NOTE_MESSAGE });
    expect(await reviews(v)).toEqual([]);
  });

  it("Low (a): the form's note rule agrees with the database's sales_demo_note_valid on a corpus", async () => {
    const corpus = [
      "店名を入れ替えても成り立つ", "style.css", "example.com", "v1.de", "https://x", "www.example", "info@example.com", "見出し。次へ", "ver 1.0",
      "ｓｔｙｌｅ．ｃｓｓ", "abc.de/", "a.b", "ﾃｽﾄ", "x".repeat(500), "x".repeat(501), "font:bold", "mailto:x", "1.5倍", "CSS の調整", "index.html を確認",
      // review of #250 L1: the database's word boundary (\M) counts Japanese as word characters
      "style.cssを直す", "example.comです", "style.cssです", "index.htmlの余白", "修正style.css", "修正style.cssを直す", "style.css。", "example.com、",
      "style.css）", "style.css 直す", "style.css_x", "style.cssー", "style.css々", "style.css1", "style.css-x", "style.css：", "style.css!", "見出しv1.de",
    ];
    const results: Array<[string, boolean]> = [];
    for (const n of corpus) {
      const db_ = (await db.query("select public.sales_demo_note_valid($1) as ok", [n])).rows[0].ok as boolean;
      results.push([n, db_]);
      expect(normaliseNote(n).ok, n).toBe(db_);
    }
    // both directions are exercised: the corpus holds notes the database accepts and notes it refuses, including
    // the dot-word + Japanese cases (a locale whose word characters differ would flip these and fail this test)
    const byNote = Object.fromEntries(results);
    expect(byNote["style.cssを直す"]).toBe(true);
    expect(byNote["example.comです"]).toBe(true);
    expect(byNote["修正style.css"]).toBe(false);
    expect(byNote["style.css。"]).toBe(false);
    expect(results.some(([, ok]) => ok) && results.some(([, ok]) => !ok)).toBe(true);
  });
});
