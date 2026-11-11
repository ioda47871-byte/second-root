import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as messages from "@/lib/sales/demo-version/admin-messages";
import {
  CHECKLIST_TEXT,
  DEMO_VERSION_ERROR_LABEL,
  demoVersionErrorMessage,
  errorCodeOf,
  INVALID_NOTE_MESSAGE,
  QUALITY_CODE_LABEL,
  REVOKE_REASON_LABEL,
  REVOKE_REASONS,
  RIGHTS_STATUS_LABEL,
  templateWarningText,
  VERSION_STATUS_LABEL,
} from "@/lib/sales/demo-version/admin-messages";
import { EMPHASISED_ITEMS, QUALITY_CHECKLIST_ITEMS } from "@/lib/sales/demo-version/quality";
import { RIGHTS_STATUSES } from "@/lib/sales/demo-version/rights";
import { VERSION_STATUSES } from "@/lib/sales/demo-version/version-state";

const MIGRATION = readFileSync("supabase/migrations/20261111000000_sales_demo_versions.sql", "utf8");

/** The codes a function raises, read from its body in the migration. */
function raisedCodes(fn: string): string[] {
  const start = MIGRATION.indexOf(`create function public.${fn}(`);
  expect(start, fn).toBeGreaterThan(-1);
  const end = MIGRATION.indexOf("\n$$;", start);
  return [...MIGRATION.slice(start, end).matchAll(/raise exception '([a-z_]+)'/g)].map((m) => m[1]!);
}

describe("DEV-196d admin messages", () => {
  it("has the owner's words for every refusal of the admin demo RPCs (and the checks they call)", () => {
    const codes = new Set([
      ...["sales_review_demo_version", "sales_withdraw_demo_quality_review", "sales_revoke_demo_version", "sales_revoke_demo_image", "sales_demo_assert_no_open_send"].flatMap(raisedCodes),
      // sales_assert_admin (DEV-195 migration) answers forbidden; the triggers bind writes to an admin identity
      "forbidden",
      "admin_identity_required",
    ]);
    expect(codes.size).toBeGreaterThan(15);
    for (const c of codes) expect(Object.hasOwn(DEMO_VERSION_ERROR_LABEL, c), c).toBe(true);
  });

  it("maps a database message to its label by the leading code, and falls back otherwise", () => {
    expect(errorCodeOf("invalid_version_transition:draft->approved")).toBe("invalid_version_transition");
    expect(errorCodeOf(undefined)).toBe("");
    expect(demoVersionErrorMessage("approval_open")).toBe(messages.APPROVAL_OPEN_MESSAGE);
    expect(demoVersionErrorMessage("render_not_viewed")).toContain("一番下まで");
    expect(demoVersionErrorMessage("some internal text with a secret", "既定")).toBe("既定");
    expect(demoVersionErrorMessage("toString")).toBe("記録できませんでした。画面を再読み込みしてください。");
  });

  it("Low (a): the note error explains that file names like style.css look like a domain", () => {
    expect(DEMO_VERSION_ERROR_LABEL.invalid_note).toBe(INVALID_NOTE_MESSAGE);
    expect(INVALID_NOTE_MESSAGE).toContain("style.css");
    expect(INVALID_NOTE_MESSAGE).toContain("500");
  });

  it("Low (d): the approval-stops-sending warning exists before and after, naming the refusal", () => {
    expect(messages.APPROVAL_STOPS_SENDING_BEFORE).toContain("送信承認は止まります");
    expect(messages.APPROVAL_STOPS_SENDING_AFTER).toContain("送信承認ができません");
    for (const t of [messages.APPROVAL_STOPS_SENDING_BEFORE, messages.APPROVAL_STOPS_SENDING_AFTER]) expect(t).toContain("デモを共有できない");
  });

  it("revoke and withdraw say what happens, including no automatic switch to another demo", () => {
    expect(messages.REVOKE_CONFIRM_TEXT).toContain("自動で切り替わりません");
    expect(messages.REVOKE_CONFIRM_TEXT).toContain("404");
    expect(messages.WITHDRAW_CONFIRM_TEXT).toContain("下書きに戻ります");
    expect(messages.WITHDRAW_CONFIRM_TEXT).toContain("送った版を出し続けます");
  });

  it("covers every status, rights status, checklist item and quality code", () => {
    for (const s of VERSION_STATUSES) expect(VERSION_STATUS_LABEL[s], s).toBeTruthy();
    for (const s of RIGHTS_STATUSES) expect(RIGHTS_STATUS_LABEL[s], s).toBeTruthy();
    expect(Object.keys(CHECKLIST_TEXT)).toEqual([...QUALITY_CHECKLIST_ITEMS]);
    for (const k of EMPHASISED_ITEMS) expect(CHECKLIST_TEXT[k].hint, k).toBeTruthy();
    expect(CHECKLIST_TEXT.shop_specific_structure.hint).toContain("入れ替えても");
    expect(CHECKLIST_TEXT.no_generic_lp_regression.hint).toContain("帯やカード");
    expect(CHECKLIST_TEXT.full_page_information.hint).toContain("縮小");
    for (const c of ["CHECKLIST_INVALID", "CHECKLIST_HAS_NG", "RENDER_MISSING", "RENDER_NOT_VIEWED", "DECISION_INVALID"] as const) expect(QUALITY_CODE_LABEL[c]).toBeTruthy();
  });

  it("every blocker the view model can return has the owner's words", () => {
    const blockers = ["VERSION_NOT_REVIEWABLE", "DEMO_DISABLED", "FACTS_CHANGED", "FACTS_UNKNOWN", "VALIDATOR_NOT_OK", "RIGHTS_NOT_PREVIEWABLE", "RENDER_MISSING", "RENDER_UNVIEWABLE", "APPROVAL_OPEN"] as const;
    expect(Object.keys(messages.APPROVE_BLOCKER_LABEL).sort()).toEqual([...blockers].sort());
    for (const b of blockers) expect(messages.APPROVE_BLOCKER_LABEL[b], b).toBeTruthy();
    expect(messages.APPROVE_BLOCKER_LABEL.APPROVAL_OPEN).toBe(messages.APPROVAL_OPEN_MESSAGE);
  });

  it("review round 1 L4: every reason sales_demo_version_send_block can return has the owner's words", () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf("create function public.sales_demo_version_send_block("));
    const body = fn.slice(0, fn.indexOf("\n$$;"));
    const codes = [...body.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]!);
    expect(codes).toEqual(["demo_version_unavailable", "demo_quality_not_approved", "demo_facts_changed", "demo_not_shareable"]);
    expect(Object.keys(messages.SEND_BLOCK_LABEL).sort()).toEqual([...codes].sort());
    for (const c of codes) expect(messages.SEND_BLOCK_LABEL[c as keyof typeof messages.SEND_BLOCK_LABEL], c).toBeTruthy();
    expect(messages.SEND_BLOCK_LABEL.demo_version_unavailable).toContain("自動で切り替わりません");
    expect(messages.SEND_BLOCK_FACTS_UNKNOWN_TEXT).toBeTruthy();
  });

  it("revoke reasons are fixed codes the database accepts", () => {
    for (const r of REVOKE_REASONS) {
      expect(r).toMatch(/^[A-Z][A-Z0-9_]{2,47}$/);
      expect(REVOKE_REASON_LABEL[r]).toBeTruthy();
    }
  });

  it("template warnings are advisory text", () => {
    expect(templateWarningText({ code: "GENERIC_SKELETON", reasons: ["x"] })).toContain("参考");
    expect(templateWarningText({ code: "SAME_SKELETON_AS_OTHER_SHOP", versionId: "v", similarity: 0.66 })).toBe("ほかの店舗の承認済みの版と骨格が近い（66%、参考）。");
    expect(templateWarningText({ code: "TOO_CLOSE_TO_REFERENCE", reference: "CP-001", similarity: 0.8 })).not.toContain("CP-001");
  });

  it("holds no URL, markup or email address in any text", () => {
    const texts: string[] = [];
    const collect = (x: unknown) => {
      if (typeof x === "string") texts.push(x);
      else if (x && typeof x === "object") Object.values(x).forEach(collect);
    };
    collect(messages);
    expect(texts.length).toBeGreaterThan(50);
    for (const t of texts) expect(t, t).not.toMatch(/https?:|<[a-z/]|@[a-z]/i);
  });
});
