import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { demoContentWithFactsSha, onboardingDemoContent } from "@/lib/demo-version-package/facts-content";
import { LocalInputError } from "@/lib/demo-version-package/local-input-error";
import { demoContentFromFacts } from "@/lib/demo-version-package/seed-rin";
import { SENDABLE_FACTS_PATH } from "@/lib/demo-version-package/seed-sendable";
import { near, NEAR_MIN_RATIO, planFactsOnboarding, type OnboardingDemoState } from "@/lib/sales/facts-onboarding";
import { LOCAL_SHOPS_DIR, readOnboardingFacts } from "@/lib/sales/facts-onboarding-local";
import { BASE_FACTS as BASE, fictionalPack } from "@/tests/support/fictional-facts-pack";

// DEV-263h (Issue #263): a shop's demo content from its facts pack — the strict derivation, the onboarding plan's
// refusals, the local CLI's file rule, and that the real-shop working directory is never tracked. Fictional data only.

const REPO = resolve(__dirname, "../../..");

const enc = (s: string) => new TextEncoder().encode(s);
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof LocalInputError ? e.code : (e as { code?: string }).code ?? String(e);
  }
  return "no-throw";
};
const state = (o: Partial<OnboardingDemoState> = {}): OnboardingDemoState => ({ doNotContact: false, approvalInFlight: false, shopOnOtherProspect: false, demo: null, prospect: { name: "架空の店 試験", address: "愛知県架空市架空区試験町1-2-3 架空ビル" }, ...o });
const demo = (content: unknown, o: Partial<NonNullable<OnboardingDemoState["demo"]>> = {}) => ({ content, expiresAt: null, disabledAt: null, designStatus: null, ...o });

describe("onboardingDemoContent (strict derivation)", () => {
  it("is demoContentWithFactsSha: every fact under the version page's keys, services and statements in number order, the shop and the bytes' sha256", () => {
    const text = fictionalPack();
    const c = onboardingDemoContent(enc(text));
    expect(c).toEqual(demoContentWithFactsSha(enc(text)));
    expect(c.menu_items).toEqual(["一番目の品", "二番目の品", "十番目の品"]);
    expect(c.statements).toEqual(["架空の文"]);
    expect(c.facts_pack).toBe("fictional-onboarding-h1");
    expect(c.facts_pack_sha256).toMatch(/^[0-9a-f]{64}$/);
    // the committed 環 pack derives exactly as its seed does
    const tamaki = readFileSync(resolve(REPO, SENDABLE_FACTS_PATH));
    expect(onboardingDemoContent(new Uint8Array(tamaki))).toMatchObject(demoContentFromFacts(JSON.parse(tamaki.toString("utf8"))));
  });

  it("refuses an unmapped key, a key twice, a missing key, an extra field, malformed JSON, untrimmed values and 輪", () => {
    expect(code(() => onboardingDemoContent(enc(fictionalPack({ facts: [...BASE, ["menu_price", "500円"]] }))))).toBe("TRUSTED_FACTS_UNMAPPED_KEY");
    expect(code(() => onboardingDemoContent(enc(fictionalPack({ facts: [...BASE, ["hours", "9:00〜17:00"]] }))))).toBe("TRUSTED_FACTS_DUPLICATE_KEY");
    expect(code(() => onboardingDemoContent(enc(fictionalPack({ facts: BASE.filter(([k]) => k !== "phone") }))))).toBe("TRUSTED_FACTS_INCOMPLETE");
    expect(code(() => onboardingDemoContent(enc(fictionalPack({ extra: { note: "x" } }))))).toBe("TRUSTED_FACTS_INVALID");
    expect(code(() => onboardingDemoContent(enc("{")))).toBe("TRUSTED_FACTS_INVALID");
    for (const v of [" 前に空白", "後ろに空白\u3000", "\u00a0nbsp"])
      expect(code(() => onboardingDemoContent(enc(fictionalPack({ facts: BASE.map(([k, x]) => [k, k === "hours" ? v : x]) }))))).toBe("TRUSTED_FACTS_VALUE_UNTRIMMED");
    expect(code(() => onboardingDemoContent(enc(fictionalPack({ shopId: "fictional-bicycle-repair-wa" }))))).toBe("TRUSTED_FACTS_RIN_DEMO");
  });
});

describe("planFactsOnboarding", () => {
  const text = fictionalPack();
  const derived = onboardingDemoContent(enc(text));
  const legacy = { name: "テストベーカリー", category: "bakery" };

  it("create (no demo) / replace a legacy demo / replace older facts of the same shop / unchanged", () => {
    expect(planFactsOnboarding(text, state())).toMatchObject({ ok: true, action: "create", needsConfirm: false, shopId: "fictional-onboarding-h1" });
    expect(planFactsOnboarding(text, state({ demo: demo(legacy) }))).toMatchObject({ ok: true, action: "replace_legacy", needsConfirm: true });
    const older = onboardingDemoContent(enc(fictionalPack({ facts: BASE.map(([k, v]) => [k, k === "hours" ? "9:00〜17:00" : v]) })));
    expect(planFactsOnboarding(text, state({ demo: demo(older) }))).toMatchObject({ ok: true, action: "replace_facts", needsConfirm: true });
    // jsonb does not keep key order: the same content in another order is unchanged
    const reordered = Object.fromEntries(Object.entries(derived).reverse());
    expect(planFactsOnboarding(text, state({ demo: demo(reordered) }))).toMatchObject({ ok: true, action: "unchanged", needsConfirm: false });
  });

  it("refuses DNC, a shop already on another prospect, another shop's demo, 輪, a disabled / shared / approved demo and a running design job", () => {
    const refused = (s: OnboardingDemoState) => (planFactsOnboarding(text, s) as { code?: string }).code;
    expect(refused(state({ doNotContact: true }))).toBe("facts_onboarding_do_not_contact");
    expect(refused(state({ shopOnOtherProspect: true }))).toBe("facts_onboarding_shop_other_prospect");
    expect(refused(state({ demo: demo({ ...derived, facts_pack: "fictional-other-shop", facts_pack_sha256: "0".repeat(64) }) }))).toBe("facts_onboarding_shop_changed");
    expect(refused(state({ demo: demo({ name: "輪", facts_pack: "fictional-bicycle-repair-wa" }) }))).toBe("facts_onboarding_rin");
    expect(refused(state({ demo: demo(legacy, { disabledAt: "2026-11-01T00:00:00Z" }) }))).toBe("demo_unavailable");
    expect(refused(state({ demo: demo(legacy, { expiresAt: "2026-12-01T00:00:00Z" }) }))).toBe("facts_onboarding_demo_in_use");
    expect(refused(state({ approvalInFlight: true, demo: demo(legacy) }))).toBe("facts_onboarding_demo_in_use");
    expect(refused(state({ demo: demo(legacy, { designStatus: "processing" }) }))).toBe("design_pending");
    expect(planFactsOnboarding("{", state())).toMatchObject({ ok: false, code: "TRUSTED_FACTS_INVALID", sha256: null });
  });
});

describe("onboardingIdentity (PR #271 L3)", () => {
  const text = fictionalPack();
  it("matches when the pack's name and address are the prospect's (whitespace, width and one inside the other ignored)", () => {
    const p = planFactsOnboarding(text, state());
    expect(p).toMatchObject({ ok: true, identity: { packName: "架空の店 試験", packAddress: "架空市架空区試験町1-2-3", mismatch: false } });
    expect(planFactsOnboarding(text, state({ prospect: { name: "架空の店\u3000試験", address: "架空市架空区試験町１-２-３" } }))).toMatchObject({ ok: true, identity: { mismatch: false } });
  });
  it("flags another name or another address (the plan still says what would happen; the confirmation is the caller's)", () => {
    expect(planFactsOnboarding(text, state({ prospect: { name: "別の店", address: "架空市架空区試験町1-2-3" } }))).toMatchObject({ ok: true, identity: { mismatch: true, prospectName: "別の店" } });
    expect(planFactsOnboarding(text, state({ prospect: { name: "架空の店 試験", address: "愛知県名古屋市中区別町9" } }))).toMatchObject({ ok: true, identity: { mismatch: true } });
    expect(planFactsOnboarding(text, state({ prospect: { name: "", address: "" } }))).toMatchObject({ ok: true, identity: { mismatch: true } });
  });
});

describe("near (DEV-263i: a short value inside a long one is not a match)", () => {
  it("one inside the other counts only when the shorter is at least 65% of the longer", () => {
    expect(near("架空市架空区試験町1-2-3", "架空市架空区試験町１-２-３")).toBe(true);
    // the prospect's address carries the building name: the pack's address is most of it
    expect(near("架空市架空区試験町1-2-3", "架空市架空区試験町1-2-3 架空ビル")).toBe(true);
    expect(near("架空の店 試験", "架空の店試験 本店")).toBe(true);
    // a bare city (or prefecture) is inside almost any address there: not a match
    expect(near("名古屋市", "愛知県名古屋市中区別町9-9")).toBe(false);
    expect(near("愛知県名古屋市中区別町9-9", "名古屋市")).toBe(false);
    expect(near("店", "架空の店 試験")).toBe(false);
    expect(near("", "")).toBe(false);
    // a leading prefecture on one side only is ignored; a prefecture alone is nothing
    expect(near("愛知県架空市架空区試験町1-2-3", "架空市架空区試験町1-2-3")).toBe(true);
    expect(near("愛知県", "愛知県名古屋市中区別町9-9")).toBe(false);
    expect(NEAR_MIN_RATIO).toBe(0.65);
  });
  it("a pack address that is only a small part of the prospect's address is flagged as a mismatch", () => {
    expect(planFactsOnboarding(fictionalPack(), state({ prospect: { name: "架空の店 試験", address: "架空市架空区試験町1-2-3 架空ビル2階 奥の部屋の右側" } }))).toMatchObject({ ok: true, identity: { mismatch: true } });
  });
});

describe("readOnboardingFacts (the local CLI's file rule)", () => {
  const root = mkdtempSync(join(tmpdir(), "dev263h-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, LOCAL_SHOPS_DIR, "shop"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  const outside = join(root, "facts-pack.json");
  writeFileSync(outside, fictionalPack());
  writeFileSync(join(repo, LOCAL_SHOPS_DIR, "shop", "facts-pack.json"), fictionalPack());
  writeFileSync(join(repo, "docs", "facts-pack.json"), fictionalPack());
  symlinkSync(outside, join(root, "link.json"));
  const err = (p: string) => code(() => readOnboardingFacts(repo, p, root));

  it("reads a file outside the repository or under .local-shops/ byte for byte", () => {
    expect(readOnboardingFacts(repo, outside, root)).toBe(fictionalPack());
    expect(readOnboardingFacts(repo, join(repo, LOCAL_SHOPS_DIR, "shop", "facts-pack.json"), root)).toBe(fictionalPack());
  });

  it("refuses a tracked place in the repository, a link, a missing file and a BOM / non-UTF-8 file stays refused as JSON", () => {
    expect(err(join(repo, "docs", "facts-pack.json"))).toBe("FACTS_FILE_IN_REPO");
    expect(err(join(root, "link.json"))).toBe("FACTS_FILE_SYMLINK");
    expect(err(join(root, "nope.json"))).toBe("FACTS_FILE_MISSING");
    writeFileSync(join(root, "bad.json"), Buffer.from([0xff, 0xfe, 0x00]));
    expect(err(join(root, "bad.json"))).toBe("TRUSTED_FACTS_INVALID");
    writeFileSync(join(root, "bom.json"), `\ufeff${fictionalPack()}`);
    expect(planFactsOnboarding(readOnboardingFacts(repo, join(root, "bom.json"), root), state())).toMatchObject({ ok: false, code: "TRUSTED_FACTS_INVALID" });
  });
});

describe("the real-shop working directory is never tracked", () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
  it(".local-shops/ is gitignored and holds no tracked file", () => {
    expect(git("ls-files", "--", LOCAL_SHOPS_DIR, `${LOCAL_SHOPS_DIR}/**`).trim()).toBe("");
    expect(git("check-ignore", "--no-index", `${LOCAL_SHOPS_DIR}/some-shop/facts-pack.json`).trim()).toBe(`${LOCAL_SHOPS_DIR}/some-shop/facts-pack.json`);
    expect(readFileSync(resolve(REPO, ".gitignore"), "utf8")).toMatch(/^\/\.local-shops\/$/m);
  });
});
