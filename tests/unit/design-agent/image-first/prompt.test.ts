import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BATCH_IMAGES } from "@/lib/design-agent/design-image/image-once";
import { sequenceProblems } from "@/lib/design-agent/image-first/composition";
import { buildPromptPlan, DIRECTIONS, EXCLUDED_READS, LINEAGE_PATTERNS, LINEAGE_TOKENS, loadPromptInputs, NAV_LABELS, pinOf, PROMPT_INPUTS, PromptStop, readChecked, SECTION_TEXT_KEYS, type DirectionKey, type Reader } from "@/lib/design-agent/image-first/prompt";
import { Composition } from "@/lib/design-agent/image-first/record";

// Issue #293 P3 (preparation): the deterministic prompt builder. Offline: the reader is injected (it reads the repo's
// pinned inputs, recording every path), nothing calls Codex, a model, the image tool or the network.

const REPO = resolve(__dirname, "../../../..");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const KEYS: DirectionKey[] = ["d1", "d3"];
const BAKERY = "design-library/research/quality-pipeline/poc/bakery";

function recordingReader(over: Record<string, (b: Buffer) => Buffer> = {}): { reader: Reader; opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    reader: async (p) => {
      opened.push(p);
      const b = await readFile(resolve(REPO, p));
      return over[p] ? over[p](b) : b;
    },
  };
}
const planOf = async (key: DirectionKey) => buildPromptPlan(await loadPromptInputs(recordingReader().reader, key));
const allPrompts = (plan: Awaited<ReturnType<typeof planOf>>) => [plan.batch.prompt, ...plan.viewports.desktop_1440.parts.map((p) => p.prompt), ...plan.viewports.mobile_390.parts.map((p) => p.prompt)];

/** The words of the earlier same-shop design (assembled here, as the module does, so no file names them whole). */
const D2_TOKENS = [["hea", "rth"], ["d", "2"], ["ph-", "mouth"], ["ph-", "loaf"], ["窯", "口"]].map((p) => p.join(""));

/** The pins the approval packet shows (docs/design/image-first-hoshigama-p3-packet.md); a change to a prompt changes them. */
const PINNED = {
  d1: { plan: "3b7fd1605c1187ad5e8788dba02b561f324566c9f0488312272f79977682d611", batch: "dff5edbfa82c8ec02192d3d9b7d2d0f1d2da728da867fb89636a84a2f10eab34" },
  d3: { plan: "a19b6896ffd50111df9ad7029f49ded5757999ddfb31943103a206f6a44072a8", batch: "291475d9ae66b2308d147a7b56ae1a0c9c53822e44cd5425d60976513712e398" },
} as const;

describe("IMAGE_FIRST P3 prompt builder: inputs", () => {
  it.each(KEYS)("%s reads exactly the three pinned inputs, none of them under an excluded path", async (key) => {
    const r = recordingReader();
    await loadPromptInputs(r.reader, key);
    expect([...r.opened].sort()).toEqual([PROMPT_INPUTS.factsPack.path, PROMPT_INPUTS.directionSet.path, PROMPT_INPUTS.principles.path].sort());
    for (const p of r.opened) expect(EXCLUDED_READS.some((re) => re.test(p)), p).toBe(false);
    for (const p of r.opened) expect(p).not.toMatch(/\/(fidelity|comps)\/|photo-slot|three-methods\/pilot-1|s0-generation-selection|mapping/);
  });

  it("the excluded paths are refused before the reader is called", async () => {
    const shop = ["hoshi", "gama"].join("");
    const excluded = [`${BAKERY}/fidelity/x.json`, `${BAKERY}/comps/d/index.html`, `${BAKERY}/photo-slots-x.json`, `${BAKERY}/photo-slot-edges-x.json`, "design-library/research/three-methods/pilot-1/x", "design-library/research/quality-pipeline/poc/s0-generation-selection.json", `docs/design/${shop}-ai-photo-brief.md`, `lib/design-agent/quality-pipeline/${shop}-ai-photos.ts`, "x/mapping.json"];
    const asked: string[] = [];
    const spy: Reader = async (p) => {
      asked.push(p);
      return Buffer.alloc(0);
    };
    for (const p of excluded) {
      expect(EXCLUDED_READS.some((re) => re.test(p)), p).toBe(true);
      await expect(readChecked(spy, p), p).rejects.toMatchObject({ code: "READ_EXCLUDED_PATH" });
    }
    expect(asked).toEqual([]);
    // an unknown direction key reads nothing
    await expect(loadPromptInputs(spy, "d2x" as DirectionKey)).rejects.toMatchObject({ code: "DIRECTION_UNKNOWN" });
    expect(asked).toEqual([]);
  });

  it("the facts pack, the principle record and the chosen direction object are pinned by their bytes", async () => {
    expect(sha(await readFile(resolve(REPO, PROMPT_INPUTS.factsPack.path)))).toBe("d46adc81bee7b7096e47f57091d88df348ac37cf389d7cce071a76f634fcf715");
    const bump = (b: Buffer) => Buffer.concat([b, Buffer.from(" ")]);
    await expect(loadPromptInputs(recordingReader({ [PROMPT_INPUTS.factsPack.path]: bump }).reader, "d1")).rejects.toMatchObject({ code: "FACTS_PIN_MISMATCH" });
    await expect(loadPromptInputs(recordingReader({ [PROMPT_INPUTS.principles.path]: bump }).reader, "d1")).rejects.toMatchObject({ code: "PRINCIPLES_PIN_MISMATCH" });
    // the chosen object edited (here: the chosen one's concept) refuses; the set's whitespace alone does not matter
    const edit = (b: Buffer) => {
      const set = JSON.parse(b.toString("utf8")) as { directions: { id: string; concept: string }[] };
      for (const d of set.directions) if (d.id === DIRECTIONS.d1.id) d.concept += "。";
      return Buffer.from(JSON.stringify(set));
    };
    await expect(loadPromptInputs(recordingReader({ [PROMPT_INPUTS.directionSet.path]: edit }).reader, "d1")).rejects.toBeInstanceOf(PromptStop);
    await expect(loadPromptInputs(recordingReader({ [PROMPT_INPUTS.directionSet.path]: edit }).reader, "d1")).rejects.toMatchObject({ code: "DIRECTION_PIN_MISMATCH" });
    const compact = (b: Buffer) => Buffer.from(JSON.stringify(JSON.parse(b.toString("utf8"))));
    const inputs = await loadPromptInputs(recordingReader({ [PROMPT_INPUTS.directionSet.path]: compact }).reader, "d1");
    expect(sha(inputs.directionBytes)).toBe(DIRECTIONS.d1.sha256);
  });

  it("direction.json is the chosen object only, canonically serialised", async () => {
    for (const key of KEYS) {
      const inputs = await loadPromptInputs(recordingReader().reader, key);
      const obj = JSON.parse(inputs.directionBytes.toString("utf8")) as { id: string };
      expect(obj.id).toBe(DIRECTIONS[key].id);
      expect(inputs.directionBytes.toString("utf8")).toBe(`${JSON.stringify(obj, null, 2)}\n`);
      expect(sha(inputs.directionBytes)).toBe(DIRECTIONS[key].sha256);
    }
  });
});

describe("IMAGE_FIRST P3 prompt builder: the plan", () => {
  it.each(KEYS)("%s: PC 2 + SP 4 = 6 pictures (one batch), section_break seams, a sequence the Phase 2 record accepts", async (key) => {
    const plan = await planOf(key);
    const inputs = await loadPromptInputs(recordingReader().reader, key);
    const ids = inputs.direction.sections.map((s) => s.id);
    expect(plan.viewports.desktop_1440.parts.map((p) => p.sections.map((s) => s.id))).toEqual([ids.slice(0, 3), ids.slice(3)]);
    expect(plan.viewports.mobile_390.parts.map((p) => p.sections.map((s) => s.id))).toEqual([[ids[0]], [ids[1]], ids.slice(2, 4), ids.slice(4)]);
    expect(plan.batch.images).toBe(MAX_BATCH_IMAGES);
    for (const v of ["desktop_1440", "mobile_390"] as const) {
      const vp = plan.viewports[v];
      expect(vp.seams.every((s) => s.kind === "section_break")).toBe(true);
      // the declared composition, with dummy computed fields, is a valid record composition and a valid sequence
      const c = Composition.parse({ ...vp, parts: vp.parts.map((p) => ({ index: p.index, file: p.file, png_sha256: "a".repeat(64), width: 768, height: 1152, bytes: 1, rendered_from: "image_tool", prompt_file: p.prompt_file, prompt_sha256: p.prompt_sha256, prompt_chars: p.prompt_chars, call: { thread_id: null, item_id: null, approval_id: null }, sections: p.sections })) });
      expect(sequenceProblems(c, v, ids)).toEqual([]);
    }
  });

  it.each(KEYS)("%s: deterministic, and the pins printed for the packet are these", async (key) => {
    const a = await planOf(key);
    const b = await planOf(key);
    expect(a).toEqual(b);
    expect(a.facts_sha256).toBe(PROMPT_INPUTS.factsPack.sha256);
    expect(a.direction_sha256).toBe(DIRECTIONS[key].sha256);
    expect({ plan: a.plan_sha256, batch: a.batch.sha256 }).toEqual(PINNED[key]);
    const pin = pinOf(a);
    expect(pin.parts.map((p) => p.prompt_sha256)).toEqual(pin.parts.map((p) => sha(p.prompt)));
    expect(pin.parts.map((p) => p.prompt_chars)).toEqual(pin.parts.map((p) => p.prompt.length));
    expect(a.batch.sha256).toBe(sha(a.batch.prompt));
    // every part prompt is inside the batch prompt exactly as written
    for (const p of pin.parts) expect(a.batch.prompt).toContain(`<<<\n${p.prompt}>>>`);
  });

  it.each(KEYS)("%s: no prompt carries a word of the earlier same-shop design", async (key) => {
    for (const t of allPrompts(await planOf(key))) for (const tok of D2_TOKENS) expect(t.toLowerCase().includes(tok.toLowerCase()), tok).toBe(false);
    for (const tok of D2_TOKENS) expect(LINEAGE_TOKENS).toContain(tok);
  });

  it("a direction text carrying such a word refuses the whole plan (PROMPT_LINEAGE_TOKEN)", async () => {
    const inputs = await loadPromptInputs(recordingReader().reader, "d1");
    for (const tok of D2_TOKENS) {
      const bad = structuredClone(inputs);
      bad.direction.sections[2]!.motif_facet += ` ${tok}`;
      expect(() => buildPromptPlan(bad), tok).toThrow(expect.objectContaining({ code: "PROMPT_LINEAGE_TOKEN" }) as Error);
    }
  });

  it("the earlier design's long wording for the kiln's mouth refuses too; d1's stone-kiln drawing is left to the owner (packet §8)", async () => {
    const word = ["窯の", "口"].join("");
    expect(LINEAGE_PATTERNS.some((re) => re.test(`Hero は${word}から`))).toBe(true);
    expect(LINEAGE_PATTERNS.some((re) => re.test(`石${word}の線画`))).toBe(false);
    const inputs = await loadPromptInputs(recordingReader().reader, "d1");
    expect(() => buildPromptPlan(inputs)).not.toThrow();
    const bad = structuredClone(inputs);
    bad.direction.sections[2]!.motif_facet += ` ${word}の弧`;
    expect(() => buildPromptPlan(bad)).toThrow(expect.objectContaining({ code: "PROMPT_LINEAGE_TOKEN" }) as Error);
  });

  it.each(KEYS)("%s: every allowed text is an exact fact value (or a facts-schema label in the header); nothing else is offered", async (key) => {
    const plan = await planOf(key);
    const inputs = await loadPromptInputs(recordingReader().reader, key);
    const values = new Set(inputs.facts.facts.map((f) => f.value));
    for (const v of ["desktop_1440", "mobile_390"] as const)
      for (const p of plan.viewports[v].parts) {
        const allowed = p.prompt.split("\n").filter((l) => l.startsWith("- 「")).map((l) => l.slice(3, -1));
        expect(allowed.length).toBeGreaterThan(0);
        for (const t of allowed) expect(values.has(t), t).toBe(true);
        const keys = p.sections.flatMap((s) => SECTION_TEXT_KEYS[key][s.id]!);
        expect(allowed).toEqual([...new Set(keys)].map((k) => inputs.facts.facts.find((f) => f.key === k)!.value));
        const nav = p.prompt.split("\n").find((l) => l.startsWith("ナビゲーションの項目"));
        if (p.index === 1) expect(nav).toBe(`ナビゲーションの項目に使ってよい語: ${NAV_LABELS.map(([, l]) => `「${l}」`).join(" ")}`);
        else expect(nav).toBeUndefined();
        // the rules every prompt states
        expect(p.prompt).toContain("写真でも、ポスターでも、パソコンやスマートフォンの写った見本画像でもありません");
        expect(p.prompt).toContain("価格・受賞・歴史や創業の年・人物（店主・職人など）");
        expect(p.prompt).toContain("数字だけの目盛りや時刻のラベルを単独で書かない");
        expect(p.prompt).not.toMatch(/\(F\d/);
      }
  });

  it.each(KEYS)("%s: the SP prompts are their own design (SP plan, no PC plan), the PC prompts never carry the SP plan", async (key) => {
    const plan = await planOf(key);
    const inputs = await loadPromptInputs(recordingReader().reader, key);
    for (const p of plan.viewports.desktop_1440.parts) {
      expect(p.prompt).toContain("PC 版（幅 1440px");
      expect(p.prompt).not.toContain(inputs.direction.sp_plan.reorder);
    }
    for (const p of plan.viewports.mobile_390.parts) {
      expect(p.prompt).toContain("スマートフォン版（幅 390px");
      expect(p.prompt).toContain("PC 版を縮めたものではなく");
      expect(p.prompt).toContain(inputs.direction.sp_plan.reorder);
      expect(p.prompt).not.toContain(inputs.direction.pc_plan);
    }
  });

  it("the principles come from the success-principle record with their case ids (no case is named in a prompt)", async () => {
    const plan = await planOf("d1");
    expect(plan.principles.map((p) => p.from)).toEqual(["P2", "P3", "P4", "P5", "P6"]);
    expect(plan.principles.find((p) => p.from === "P6")!.case_ids).toEqual(["CP-009", "CP-016", "CP-028"]);
    for (const t of allPrompts(plan)) expect(t).not.toMatch(/CP-\d/);
  });
});

describe("IMAGE_FIRST P3 approval packet (draft, unapproved)", () => {
  const packet = () => readFile(resolve(REPO, "docs/design/image-first-hoshigama-p3-packet.md"), "utf8");
  it.each(KEYS)("%s: the packet shows exactly the pins the builder prints", async (key) => {
    const text = await packet();
    const pin = pinOf(await planOf(key));
    for (const v of [pin.plan_sha256, pin.batch.sha256, `| ${pin.batch.chars} |`.slice(2, -2), pin.direction_sha256, pin.facts_sha256, pin.principles_sha256]) expect(text).toContain(String(v));
    for (const p of pin.parts) expect(text).toContain(`\`${p.prompt_sha256}\` / ${p.prompt_chars}`);
  });

  it("is marked unapproved, names no used approval, and carries no prompt text", async () => {
    const text = await packet();
    // the status line at the top carries the state (the title no longer does)
    expect(text.slice(0, text.indexOf("\n## "))).toContain("**状態: 未承認。**");
    expect(text).not.toMatch(new RegExp([["HOSHIGAMA_", "APPROVAL"], ["wagashi-a-v4-", "20261025-01"], ["map", "ping.json"]].map((p) => p.join("")).join("|")));
    for (const p of pinOf(await planOf("d1")).parts) expect(text).not.toContain(p.prompt.split("\n")[0]!);
  });
});
