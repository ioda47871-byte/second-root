import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildResearchBrief, ShopResearchInput } from "@/lib/design-agent/intelligence/brief";
import { buildCorpus, CorpusError, loadResearchCorpus, RESEARCH_FILES } from "@/lib/design-agent/intelligence/corpus";
import { LEDGER_NOTES, LedgerError, SelectionLedger, validateLedger } from "@/lib/design-agent/intelligence/ledger";
import { fictionalFiles, fictionalLedger, ledgerManifestFiles, SHA } from "./fixtures";
import { GOLDEN_SHOPS } from "./golden-shops";

// DEV-113: the selection ledger, its three modes and Phase 1 compatibility. Fictional data only.

type Ledger = ReturnType<typeof fictionalLedger>;
type V = Ledger["records"][number]["versions"][number] & Record<string, unknown>;

const withLedger = (ledger: unknown, files = ledgerManifestFiles()) => ({ ...files, ledger: { json: ledger, sha256: SHA.ledger } });
const partial = (ledger: unknown, files = ledgerManifestFiles()) => buildCorpus(withLedger(ledger, files), "partial");
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError || e instanceof CorpusError) return e.code;
    throw e;
  }
  return "OK";
};
const edit = (fn: (l: Ledger) => void) => {
  const l = fictionalLedger();
  fn(l);
  return l;
};
const ver = (l: Ledger, caseId: string, label: string) => l.records.find((r) => r.case_id === caseId)!.versions.find((v) => v.version_label === label)! as V;

describe("phase1_compat: Phase 1 output is unchanged", () => {
  const golden = readFileSync(resolve(__dirname, "phase1-compat.golden.json"), "utf8");
  const render = (c: ReturnType<typeof buildCorpus>) =>
    JSON.stringify({ corpus: c, briefs: GOLDEN_SHOPS.map((s) => buildResearchBrief(c, ShopResearchInput.parse(s))) }, null, 2) + "\n";

  it("matches the pre-DEV-113 output byte for byte, by default and with the explicit mode", () => {
    expect(render(buildCorpus(fictionalFiles()))).toBe(golden);
    expect(render(buildCorpus(fictionalFiles(), "phase1_compat"))).toBe(golden);
    // the extra manifest fields the ledger checks do not leak into the Phase 1 output
    expect(render(buildCorpus(ledgerManifestFiles(), "phase1_compat"))).toBe(golden);
  });

  it("never reads a ledger: one handed in is refused, not silently ignored", () => {
    expect(code(() => buildCorpus(withLedger(fictionalLedger()), "phase1_compat"))).toBe("CORPUS_MODE_INVALID");
  });

  it("refuses an unknown mode", () => {
    expect(code(() => buildCorpus(withLedger(fictionalLedger()), "loose" as never))).toBe("CORPUS_MODE_INVALID");
  });
});

describe("partial and strict modes", () => {
  it("both require a ledger", () => {
    expect(code(() => buildCorpus(ledgerManifestFiles(), "partial"))).toBe("LEDGER_MISSING");
    expect(code(() => buildCorpus(ledgerManifestFiles(), "strict"))).toBe("LEDGER_MISSING");
  });

  it("partial: a consistent ledger adds a report and changes nothing else", () => {
    const c = partial(fictionalLedger());
    const { ledger, ...rest } = c;
    expect(rest).toEqual(buildCorpus(ledgerManifestFiles()));
    expect(ledger).toMatchObject({
      mode: "partial",
      status: "partial_validation_only_not_strict",
      ledger_sha256: SHA.ledger,
      recorded_cases: ["CP-901", "CP-902", "CP-950"],
      unledgered_success_cases: [],
    });
    expect(ledger!.notes).toEqual([...LEDGER_NOTES]);
    expect(ledger!.versions.map((v) => [v.version_label, v.label_is_internal_identifier, v.selection_status])).toEqual([
      ["CP901_L0", true, "owner_rejected_explicit"],
      ["CP901_L1", true, "owner_selected"],
      ["RAIL_v1", true, "not_selected_in_relative_comparison"],
      ["RAIL_v2", false, "owner_selected"],
      ["RAIL_v3", true, "awaiting_owner_review"],
      ["CP950_L1", true, "owner_rejected_explicit"],
    ]);
  });

  it("partial: the ledger never adds a success (a rejected-only case stays out of the successes)", () => {
    const c = partial(fictionalLedger());
    expect(c.successes.map((s) => s.id)).toEqual(["CP-901", "CP-902"]);
    expect(c.counts.success_cases).toBe(2);
  });

  it("partial: a ledger covering only some cases passes and lists the rest as unledgered", () => {
    const l = edit((x) => (x.records = x.records.filter((r) => r.case_id === "CP-902")));
    expect(partial(l).ledger!.unledgered_success_cases).toEqual(["CP-901"]);
    expect(partial({ schema: "selection_ledger_v1", as_of: "2026-10-29", records: [] }).ledger!.unledgered_success_cases).toEqual(["CP-901", "CP-902"]);
  });

  it("strict: an incomplete ledger stops with LEDGER_INCOMPLETE", () => {
    const l = edit((x) => (x.records = x.records.filter((r) => r.case_id === "CP-902")));
    expect(code(() => buildCorpus(withLedger(l), "strict"))).toBe("LEDGER_INCOMPLETE");
  });

  it("strict: even a complete, consistent ledger stops (safe not-yet-implemented state)", () => {
    expect(code(() => buildCorpus(withLedger(fictionalLedger()), "strict"))).toBe("STRICT_APPROVAL_NOT_IMPLEMENTED");
  });

  it("strict: ledger errors are reported before the not-implemented stop", () => {
    const l = edit((x) => (ver(x, "CP-902", "RAIL_v2").version_label = "RAIL_v9"));
    expect(code(() => buildCorpus(withLedger(l), "strict"))).toBe("VERSION_LABEL_MISMATCH");
  });

  it("the brief carries the report last in partial mode and is otherwise the compat brief", () => {
    const shop = ShopResearchInput.parse(GOLDEN_SHOPS[0]);
    const p = buildResearchBrief(partial(fictionalLedger()), shop);
    const c = buildResearchBrief(buildCorpus(ledgerManifestFiles()), shop);
    expect(Object.keys(p).at(-1)).toBe("ledger");
    const { ledger, ...rest } = p as typeof p & { ledger?: unknown };
    expect(ledger).toBeDefined();
    expect(JSON.stringify(rest)).toBe(JSON.stringify(c));
    expect("ledger" in c).toBe(false);
  });

  it("does not relay owner quotes or analyst notes as part of the report", () => {
    const s = JSON.stringify(partial(fictionalLedger()).ledger);
    expect(s).not.toContain("架空のオーナー発言");
    expect(s).not.toContain("generic_split_hero");
  });
});

describe("stop codes", () => {
  it.each<[string, string, (l: Ledger) => void]>([
    ["LEDGER_SCHEMA_INVALID", "wrong schema name", (l) => ((l as Record<string, unknown>).schema = "selection_ledger_v2")],
    ["LEDGER_SCHEMA_INVALID", "a self-declared verified anchor", (l) => (ver(l, "CP-902", "RAIL_v2").anchor!.verification = "verified_against_file" as never)],
    ["LEDGER_SCHEMA_INVALID", "an anchor without the record that justifies it", (l) => delete (ver(l, "CP-902", "RAIL_v2").anchor as Record<string, unknown>).evidence_ref],
    ["LEDGER_SCHEMA_INVALID", "an analyst code inside the owner's evidence", (l) => ((ver(l, "CP-901", "CP901_L1").owner_decision_evidence as Record<string, unknown>).failure_reason_codes = ["x_y"])],
    ["LEDGER_SCHEMA_INVALID", "an owner quote inside the analyst classification", (l) => ((l.records[2]!.analyst_classification as Record<string, unknown>).quote_verbatim = "x")],
    ["LEDGER_SCHEMA_INVALID", "an analyst classification claiming to be the owner", (l) => (l.records[2]!.analyst_classification!.classified_by = "owner" as never)],
    ["LEDGER_SCHEMA_INVALID", "a self-declared approval flag", (l) => (ver(l, "CP-901", "CP901_L1").approved_by_owner = true)],
    ["LEDGER_SCHEMA_INVALID", "markup in a quote", (l) => (ver(l, "CP-901", "CP901_L1").owner_decision_evidence!.quote_verbatim = "<img src=x>")],
    ["LEDGER_SCHEMA_INVALID", "a source_ref outside the research records", (l) => (ver(l, "CP-901", "CP901_L1").owner_decision_evidence!.source_ref = "design-library/../.env.md")],
    ["LEDGER_UNKNOWN_STATUS", "an unknown status", (l) => (ver(l, "CP-901", "CP901_L1").selection_status = "owner_approved")],
    ["LEDGER_DUPLICATE_CASE", "the same case twice", (l) => l.records.push(structuredClone(l.records[2]!))],
    ["LEDGER_DUPLICATE_VERSION", "the same version twice", (l) => (ver(l, "CP-902", "RAIL_v3").version_label = "RAIL_v1")],
    ["LEDGER_DUPLICATE_VERSION", "labels differing only in case", (l) => (ver(l, "CP-902", "RAIL_v3").version_label = "rail_v1")],
    ["LEDGER_CONTRADICTS_MANIFEST", "a selected version of a case the manifest does not hold", (l) => {
      const v = ver(l, "CP-950", "CP950_L1");
      v.selection_status = "owner_selected";
      v.owner_decision_evidence!.quote_kind = "explicit_selection";
    }],
    ["LEDGER_CONTRADICTS_MANIFEST", "no selected version for a manifest success", (l) => {
      const v = ver(l, "CP-901", "CP901_L1");
      v.selection_status = "owner_rejected_explicit";
      v.owner_decision_evidence!.quote_kind = "explicit_rejection";
    }],
    ["LEDGER_CONTRADICTS_MANIFEST", "two selected versions", (l) => {
      const v = ver(l, "CP-901", "CP901_L0");
      v.selection_status = "owner_selected";
      v.owner_decision_evidence!.quote_kind = "explicit_selection";
    }],
    ["LEDGER_CONTRADICTS_MANIFEST", "a conditional selection recorded as a plain one", (l) => {
      const v = ver(l, "CP-901", "CP901_L1");
      v.selection_status = "owner_conditionally_selected";
      v.owner_decision_evidence!.quote_kind = "conditional_selection";
    }],
    ["LEDGER_QUOTE_MISSING", "a rejection without the owner's words", (l) => (ver(l, "CP-901", "CP901_L0").owner_decision_evidence = null)],
    ["LEDGER_QUOTE_MISSING", "a manifest-labelled selection without the owner's words", (l) => (ver(l, "CP-902", "RAIL_v2").owner_decision_evidence = null)],
    ["LEDGER_ASSIGNED_LABEL_AS_APPROVAL", "a ledger-assigned label selected with no quote", (l) => (ver(l, "CP-901", "CP901_L1").owner_decision_evidence = null)],
    ["LEDGER_QUOTE_KIND_MISMATCH", "a relative comparison recorded as an explicit rejection", (l) => (ver(l, "CP-901", "CP901_L0").owner_decision_evidence!.quote_kind = "relative_preference")],
    ["LEDGER_QUOTE_KIND_MISMATCH", "a rejection quote supporting a selection", (l) => (ver(l, "CP-901", "CP901_L1").owner_decision_evidence!.quote_kind = "explicit_rejection")],
    ["LEDGER_QUOTE_KIND_MISMATCH", "an unknown quote kind", (l) => (ver(l, "CP-901", "CP901_L1").owner_decision_evidence!.quote_kind = "implied")],
    ["LEDGER_ANCHOR_UNSUPPORTED", "an anchor whose value differs from the manifest", (l) => (ver(l, "CP-902", "RAIL_v2").anchor!.sha256 = "f".repeat(64))],
    ["LEDGER_ANCHOR_UNSUPPORTED", "an anchor on a field the manifest record lacks", (l) => (ver(l, "CP-902", "RAIL_v2").anchor!.manifest_field = "desktop_1440_png_sha256")],
    ["LEDGER_ANCHOR_UNSUPPORTED", "an anchor for a case not in the manifest", (l) => (ver(l, "CP-950", "CP950_L1").anchor = { manifest_field: "approved_html_sha256", sha256: SHA.html, evidence_ref: "design-library/success-cases/CP-950-Fictional.md", verification: "recorded_unverified" })],
    ["LEDGER_ANCHOR_UNSUPPORTED", "one field anchoring two versions", (l) => (ver(l, "CP-902", "RAIL_v1").anchor = { ...ver(l, "CP-902", "RAIL_v2").anchor! })],
    ["VERSION_LABEL_MISMATCH", "a label differing from the manifest's approved_version", (l) => (ver(l, "CP-902", "RAIL_v2").version_label = "RAIL_v9")],
    ["VERSION_LABEL_MISMATCH", "the ledger replacing the manifest's label with its own", (l) => (ver(l, "CP-902", "RAIL_v2").version_label_source = "ledger_assigned")],
    ["VERSION_LABEL_MISMATCH", "a manifest label source on a non-selected version", (l) => (ver(l, "CP-902", "RAIL_v1").version_label_source = "manifest_approved_version")],
    ["VERSION_LABEL_MISMATCH", "a manifest label the manifest does not have", (l) => (ver(l, "CP-901", "CP901_L1").version_label_source = "manifest_owner_approved_version")],
    ["VERSION_LABEL_MISMATCH", "a manifest label source on a case the manifest does not hold", (l) => (ver(l, "CP-950", "CP950_L1").version_label_source = "manifest_approved_version")],
  ])("%s: %s", (expected, _name, mutate) => {
    expect(code(() => partial(edit(mutate)))).toBe(expected);
  });

  it("LEDGER_CONTRADICTS_MANIFEST: the manifest's two label fields disagree", () => {
    const files = ledgerManifestFiles();
    // a label no ledger version uses, so only the disagreement check can stop it
    (files.manifest.records[1] as Record<string, unknown>).owner_approved_version = "RAIL_vX";
    expect(code(() => partial(fictionalLedger(), files))).toBe("LEDGER_CONTRADICTS_MANIFEST");
  });

  it("accepts two manifest label fields that agree", () => {
    const files = ledgerManifestFiles();
    (files.manifest.records[1] as Record<string, unknown>).owner_approved_version = "RAIL_v2";
    expect(code(() => partial(fictionalLedger(), files))).toBe("OK");
  });

  it.each([[2], [""], [null], [["RAIL_v2"]]])("VERSION_LABEL_MISMATCH: a manifest label field that is not a label (%j) fails closed", (value) => {
    const files = ledgerManifestFiles();
    (files.manifest.records[0] as Record<string, unknown>).approved_version = value;
    expect(code(() => partial(fictionalLedger(), files))).toBe("VERSION_LABEL_MISMATCH");
  });

  it("LEDGER_ANCHOR_UNSUPPORTED: the same bytes under two fields cannot anchor two versions", () => {
    const files = ledgerManifestFiles();
    (files.manifest.records[1] as Record<string, unknown>).approved_rejected_v1_png_sha256 = SHA.firstConcept;
    const l = edit((x) => (ver(x, "CP-902", "RAIL_v1").anchor!.sha256 = SHA.firstConcept));
    expect(code(() => partial(l, files))).toBe("LEDGER_ANCHOR_UNSUPPORTED");
  });

  it("LEDGER_CONTRADICTS_MANIFEST: a conditional manifest success recorded as a plain selection", () => {
    const files = ledgerManifestFiles();
    files.manifest.records[1]!.status = "owner_conditionally_authorized_fallback_research_success";
    expect(code(() => partial(fictionalLedger(), files))).toBe("LEDGER_CONTRADICTS_MANIFEST");
  });

  it("does not infer anything from a SHA field's name: a cited first_* or approved_* field is accepted as recorded", () => {
    const v = partial(fictionalLedger()).ledger!.versions;
    expect(v.find((x) => x.version_label === "RAIL_v2")!.anchor).toEqual({ manifest_field: "first_concept_png_sha256", verification: "recorded_unverified" });
    expect(v.find((x) => x.version_label === "RAIL_v1")!.anchor).toEqual({ manifest_field: "approved_rejected_v1_png_sha256", verification: "original_unavailable" });
  });

  it("awaiting review needs no quote, or a deferral; never a selection quote", () => {
    expect(code(() => partial(edit((l) => (ver(l, "CP-902", "RAIL_v3").owner_decision_evidence = { quote_verbatim: "あとで見る", quote_kind: "deferral", source_ref: "design-library/x.md" }))))).toBe("OK");
    expect(code(() => partial(edit((l) => (ver(l, "CP-902", "RAIL_v3").owner_decision_evidence = { quote_verbatim: "これで", quote_kind: "explicit_selection", source_ref: "design-library/x.md" }))))).toBe("LEDGER_QUOTE_KIND_MISMATCH");
  });

  it("has no anchor state that claims a verified file", () => {
    const anchor = SelectionLedger.shape.records.element.shape.versions.element.shape.anchor.unwrap().shape.verification;
    expect(anchor.options).toEqual(["recorded_unverified", "original_unavailable"]);
  });

  it("validateLedger in strict mode never returns", () => {
    const f = buildCorpus(ledgerManifestFiles());
    const manifestCases = f.successes.map((s) => ({ id: s.id, conditional: s.conditional, fields: {} }));
    const base = fictionalLedger();
    const l = { ...base, records: base.records.map((r) => ({ ...r, versions: r.versions.map((v) => ({ ...v, anchor: null, version_label_source: "ledger_assigned" })) })) };
    expect(code(() => validateLedger({ ledger: l, ledgerSha256: SHA.ledger, manifestCases, mode: "strict" }))).toBe("STRICT_APPROVAL_NOT_IMPLEMENTED");
  });
});

describe("files and CLI", () => {
  let root = "";
  const ledgerPath = () => join(root, "ledger.json");
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "dev113-"));
    const f = ledgerManifestFiles();
    const put = (rel: string, v: unknown) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), JSON.stringify(v));
    };
    put(RESEARCH_FILES.manifest, f.manifest);
    put(RESEARCH_FILES.patterns, f.patterns);
    put(RESEARCH_FILES.queue, f.queue);
    put(RESEARCH_FILES.referencesV02, f.referencesV02);
    RESEARCH_FILES.candidatesV03.forEach((p, i) => put(p, f.candidatesV03[i]));
    writeFileSync(ledgerPath(), JSON.stringify(fictionalLedger()));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("loads phase1_compat by default without a ledger key, and refuses a ledger path in compat", async () => {
    const c = await loadResearchCorpus(root);
    expect("ledger" in c).toBe(false);
    expect(Object.keys(c.source_sha256)).toHaveLength(6);
    await expect(loadResearchCorpus(root, { mode: "phase1_compat", ledgerPath: ledgerPath() } as never)).rejects.toMatchObject({ code: "CORPUS_MODE_INVALID" });
  });

  it("reads the ledger in partial mode, records its SHA-256 and leaves the research SHA list unchanged", async () => {
    const c = await loadResearchCorpus(root, { mode: "partial", ledgerPath: ledgerPath() });
    expect(c.ledger!.ledger_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(c.source_sha256)).toHaveLength(6);
    await expect(loadResearchCorpus(root, { mode: "partial", ledgerPath: join(root, "nope.json") })).rejects.toMatchObject({ code: "LEDGER_MISSING" });
    await expect(loadResearchCorpus(root, { mode: "strict" })).rejects.toMatchObject({ code: "LEDGER_MISSING" });
  });

  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", resolve(__dirname, "../../../../scripts/design-intelligence/brief.ts"), "--research-root", root, ...args], { encoding: "utf8" });

  it("CLI: compat by default, partial with --ledger, strict always stops, bad usage refused", () => {
    const compat = cli(["--summary"]);
    expect(compat.status).toBe(0);
    expect(JSON.parse(compat.stdout)).not.toHaveProperty("ledger");
    expect(cli(["--summary", "--mode", "phase1_compat"]).stdout).toBe(compat.stdout);

    const p = cli(["--summary", "--mode", "partial", "--ledger", ledgerPath()]);
    expect(p.status).toBe(0);
    expect(JSON.parse(p.stdout).ledger.status).toBe("partial_validation_only_not_strict");

    const s = cli(["--summary", "--mode", "strict", "--ledger", ledgerPath()]);
    expect(s.status).toBe(2);
    expect(s.stderr).toContain("STRICT_APPROVAL_NOT_IMPLEMENTED");
    expect(s.stdout).toBe("");

    expect(cli(["--summary", "--mode", "partial"]).stderr).toContain("LEDGER_MISSING");
    expect(cli(["--summary", "--ledger", ledgerPath()]).status).toBe(2);
    expect(cli(["--summary", "--mode", "loose"]).status).toBe(2);
    // argument mistakes never fall back to phase1_compat
    for (const bad of [["--summary", "--mode"], ["--summary", "--mode=partial", "--ledger=x"], ["--summary", "--mode", "partial", "--mode", "phase1_compat", "--ledger", ledgerPath()], ["--summary", "--verbose"], ["--summary", "--summary"], ["--summary", "--ledger"]]) {
      const r = cli(bad);
      expect(r.status, bad.join(" ")).toBe(2);
      expect(r.stdout, bad.join(" ")).toBe("");
      expect(r.stderr, bad.join(" ")).toContain("usage:");
    }
  }, 60_000);
});
