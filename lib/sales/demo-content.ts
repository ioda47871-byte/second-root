import { CATEGORIES, TEMPLATE_BY_CATEGORY, type Category } from "./types";

// What a public demo may show (MVP_SPEC §7): verified public facts only.
// Anything else stored in sales_demos.content — or added by mistake later —
// is dropped here before rendering. Email addresses are never shown.

export type DemoTemplate = "bakery_v1" | "baked_goods_v1" | "cafe_v1";

export type DemoView = {
  template: DemoTemplate;
  name: string;
  category: Category;
  ward: string | null;
  address: string | null;
  hours: string | null;
  closedDays: string | null;
  access: string | null;
  phone: string | null;
  description: string | null;
  menuItems: string[];
};

const TEMPLATES: readonly DemoTemplate[] = ["bakery_v1", "baked_goods_v1", "cafe_v1"];
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || EMAIL.test(trimmed)) return null;
  return trimmed.slice(0, max);
}

export function toDemoView(template: unknown, content: unknown): DemoView | null {
  if (!TEMPLATES.includes(template as DemoTemplate)) return null;
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const c = content as Record<string, unknown>;
  const name = text(c.name, 200);
  const category = CATEGORIES.includes(c.category as Category) ? (c.category as Category) : null;
  if (!name || !category) return null;
  // The template must match the verified category (no bakery page for a cafe).
  if (TEMPLATE_BY_CATEGORY[category] !== template) return null;
  const menu = Array.isArray(c.menu_items) ? c.menu_items : [];
  return {
    template: template as DemoTemplate,
    name,
    category,
    ward: text(c.ward, 20),
    address: text(c.address, 300),
    hours: text(c.hours, 500),
    closedDays: text(c.closed_days, 500),
    access: text(c.access, 500),
    phone: text(c.phone, 30),
    description: text(c.description, 500),
    menuItems: menu.map((m) => text(m, 100)).filter((m): m is string => m !== null).slice(0, 12),
  };
}

export const CATEGORY_LABEL: Record<Category, string> = {
  bakery: "パン屋",
  baked_goods: "焼菓子店",
  cafe: "カフェ",
};
