import { describe, expect, it } from "vitest";
import { toDemoView } from "@/lib/sales/demo-content";

describe("toDemoView", () => {
  it("keeps only allowed, verified fields", () => {
    const view = toDemoView("bakery_v1", {
      name: "テスト工房",
      category: "bakery",
      ward: "中区",
      hours: "8:00〜17:00",
      menu_items: ["食パン", 42, "クロワッサン"],
      public_email: "info@example.com",
      won_amount_jpy: 100000,
      internal_note: "high priority",
      prospect_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(view).toEqual({
      template: "bakery_v1",
      name: "テスト工房",
      category: "bakery",
      ward: "中区",
      address: null,
      hours: "8:00〜17:00",
      closedDays: null,
      access: null,
      phone: null,
      description: null,
      menuItems: ["食パン", "クロワッサン"],
    });
  });

  it("never shows an email address, even inside another field", () => {
    const view = toDemoView("cafe_v1", { name: "カフェ", category: "cafe", description: "ご予約は info@cafe.example.com まで" });
    expect(view?.description).toBeNull();
  });

  it.each([
    ["unknown template", "other_v1", { name: "x", category: "cafe" }],
    ["missing name", "cafe_v1", { category: "cafe" }],
    ["unknown category", "cafe_v1", { name: "x", category: "salon" }],
    ["non-object content", "cafe_v1", "x"],
    ["template that does not match the category", "bakery_v1", { name: "x", category: "cafe" }],
  ])("rejects %s", (_label, template, content) => {
    expect(toDemoView(template, content)).toBeNull();
  });
});
