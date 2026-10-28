import { spawnSync } from "node:child_process";
import { appendFileSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkArtifactPng, checkCodexDesign, IntakeError, intakeArtifact } from "@/lib/design-agent/artifact/intake";
import { CODEX_ANSWER_MAX_BYTES, IMAGE_OUTCOMES, MAX_RENDER_HEIGHT, PNG_LIMITS, PROTOTYPE_LIMITS, RelPath, STOP_CLASSES } from "@/lib/design-agent/artifact/schema";
import { IMAGE_OUTCOMES as CAPABILITY_OUTCOMES } from "@/lib/design-agent/design-image/capability";
import { checkPng, MOCKUP_PNG_LIMITS } from "@/lib/design-agent/design-image/png";
import { CSS, declared, FACTS, HTML, ihdr, makePng, PNG_SIG, pngChunk, routeA, routeB, routeC, writePackage, type Pkg } from "./fixtures";

// DEV-114: intake of a Design Artifact package. Fictional data only.

const REPO = resolve(__dirname, "../../../..");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const write = (p: Pkg, opts?: Parameters<typeof writePackage>[1]) => {
  const w = writePackage(p, opts);
  made.push(w.base);
  return w;
};
const run = (p: Pkg, opts?: Parameters<typeof writePackage>[1]) => {
  const w = write(p, opts);
  return intakeArtifact({ packageDir: w.dir, factsPath: w.factsPath });
};
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof IntakeError) return e.code;
    throw e;
  }
};
const detail = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof IntakeError) return `${e.code} ${e.detail}`;
    throw e;
  }
};
const edit = (make: () => Pkg, fn: (p: Pkg) => void) => {
  const p = make();
  fn(p);
  return p;
};

describe("verification states (never approvals)", () => {
  it("route B: two browser renders → render_pair_complete, handoff without the prototype", async () => {
    const r = await run(routeB());
    expect(r.verification_state).toBe("render_pair_complete");
    expect(r.implementation_handoff_allowed).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.handoff.files.map((f) => f.path)).toEqual(["artifact.json", "originals/desktop_1440.png", "originals/mobile_390.png"]);
    expect(JSON.stringify(r.handoff)).not.toMatch(/quarantine|\.html|\.css/);
    expect(r.handoff.excluded_roles).toEqual(["prototype"]);
    // the prototype is still checked and listed for the record, just never handed over
    expect(r.files.filter((f) => f.role === "prototype").map((f) => f.path)).toEqual(["quarantine/index.html", "quarantine/styles.css"]);
    expect(r.files.find((f) => f.path === "originals/mobile_390.png")).toMatchObject({ width: 390, height: 3000 });
  });

  it("route C: renders plus an approved generated asset → render_pair_complete; the asset is handed over, the prototype is not", async () => {
    const r = await run(routeC());
    expect(r.verification_state).toBe("render_pair_complete");
    expect(r.handoff.files.map((f) => f.path)).toEqual(["artifact.json", "originals/desktop_1440.png", "originals/mobile_390.png", "assets/a1.png"]);
    expect(JSON.stringify(r.handoff)).not.toContain("quarantine");
  });

  it("route A: concept images → concept_only, never handed to implementation", async () => {
    const r = await run(routeA());
    expect(r.verification_state).toBe("concept_only");
    expect(r.implementation_handoff_allowed).toBe(false);
    expect(r.handoff.files).toEqual([]);
    expect(r.reasons).toEqual(["concept_images_are_not_pc_sp_renders"]);
  });

  it.each<[string, (p: Pkg) => void, string]>([
    ["a missing mobile render", (p) => {
      delete p.files["originals/mobile_390.png"];
      p.artifact.observed.originals.mobile_390 = { state: "missing" };
    }, "original_missing:mobile_390"],
    ["a failed desktop render", (p) => {
      delete p.files["originals/desktop_1440.png"];
      p.artifact.observed.originals.desktop_1440 = { state: "generation_failed" };
    }, "original_generation_failed:desktop_1440"],
    ["an unknown approval ID", (p) => (p.artifact.observed.generation.approval_id = null), "generation_unverified:approval_id"],
    ["unknown tool version and commit", (p) => Object.assign(p.artifact.observed.generation, { tool_version: null, worker_commit: null }), "generation_unverified:tool_version,worker_commit"],
    ["a run of unknown outcome", (p) => (p.artifact.observed.generation.status = "unknown"), "generation_unknown"],
    ["a stopped run", (p) => {
      p.artifact.observed.generation.status = "stopped";
      p.artifact.observed.stops = [{ code: "CODEX_TIMEOUT", class: "interrupted", stage: "generation" }];
    }, "run_stopped:CODEX_TIMEOUT"],
    ["a declared missing item", (p) => (p.artifact.observed.missing = [{ item: "product_photo", reason: "no approved photo" }]), "declared_missing:product_photo"],
    ["times out of order", (p) => (p.artifact.observed.generation.finished_at = "2026-10-28T09:00:00Z"), "generation_unverified:time_order"],
  ])("route B with %s → incomplete, no handoff", async (_n, mutate, reason) => {
    const r = await run(edit(routeB, mutate));
    expect(r.verification_state).toBe("incomplete");
    expect(r.reasons).toContain(reason);
    expect(r.implementation_handoff_allowed).toBe(false);
    expect(r.handoff.files).toEqual([]);
  });

  it("an owner upload with unknown generation facts is incomplete, not a success", async () => {
    const r = await run(edit(routeA, (p) => {
      p.artifact.source_kind = "chatgpt_owner_upload_compat";
      p.artifact.observed.originals.desktop_1440.rendered_from = "owner_upload";
      p.artifact.observed.originals.mobile_390.rendered_from = "owner_upload";
      Object.assign(p.artifact.observed.generation, { tool: null, tool_version: null, approval_id: null, prompt_sha256: null, run_id: null, image_outcome: "not_applicable" });
    }));
    expect(r.verification_state).toBe("incomplete");
    expect(r.reasons).toContain("owner_upload_provenance_not_implemented");
    expect(r.implementation_handoff_allowed).toBe(false);
  });

  it.each<[string, (p: Pkg) => void]>([
    ["claims IMAGE_SAVED", (p) => (p.artifact.observed.generation.image_outcome = "IMAGE_SAVED")],
    ["claims a Codex tool", (p) => (p.artifact.observed.generation.tool = "codex_cli")],
    ["claims a prompt SHA", (p) => (p.artifact.observed.generation.prompt_sha256 = "b".repeat(64))],
  ])("an owner upload that %s is refused (ARTIFACT_ROUTE_INCONSISTENT)", async (_n, mutate) => {
    const upload = edit(routeA, (p) => {
      p.artifact.source_kind = "chatgpt_owner_upload_compat";
      p.artifact.observed.originals.desktop_1440.rendered_from = "owner_upload";
      p.artifact.observed.originals.mobile_390.rendered_from = "owner_upload";
      Object.assign(p.artifact.observed.generation, { tool: null, prompt_sha256: null, image_outcome: "not_applicable" });
      mutate(p);
    });
    expect(await code(run(upload))).toBe("ARTIFACT_ROUTE_INCONSISTENT");
  });

  it("an owner upload on route B is refused for its route even without Codex facts", async () => {
    const d = await detail(run(edit(routeB, (p) => {
      p.artifact.source_kind = "chatgpt_owner_upload_compat";
      Object.assign(p.artifact.observed.generation, { tool: null, prompt_sha256: null, image_outcome: "not_applicable" });
    })));
    expect(d).toBe("ARTIFACT_ROUTE_INCONSISTENT an owner upload is a concept image (route A)");
  });

  it("an unknown model does not fail valid files: still render_pair_complete, with a warning (no false stop)", async () => {
    for (const make of [routeB, routeC]) {
      const r = await run(edit(make, (p) => (p.artifact.observed.generation.model_reported = null)));
      expect(r.verification_state).toBe("render_pair_complete");
      expect(r.reasons).toEqual([]);
      expect(r.warnings).toEqual(["generation_model_unknown"]);
      expect(r.handoff.files.length).toBeGreaterThan(0);
      // the unknown model stays visible to any step that needs it
      expect(r.runner_reported.generation.model_reported).toBeNull();
    }
    expect((await run(routeB())).warnings).toEqual([]);
  });

  describe("route C → B fallback made explicitly by the runner", () => {
    const fallbackB = (over: Record<string, unknown> = {}, outcome = "TOOL_FAILED") =>
      edit(routeB, (p) => {
        p.artifact.observed.generation.image_outcome = outcome;
        p.artifact.observed.fallback = {
          from_route: "C_hybrid",
          image_outcome: "TOOL_FAILED",
          image_stop_code: "CODEX_IMAGE_TOOL_FAILED",
          image_approval_id: "fictional-asset-20261028-01",
          image_essential: false,
          decided_by: "runner",
          ...over,
        };
      });

    it("is accepted when the prototype and renders are valid (recoverable case, no false stop), keeping the failure visible", async () => {
      const r = await run(fallbackB());
      expect(r.verification_state).toBe("render_pair_complete");
      expect(r.route).toBe("B_html_prototype");
      expect(r.warnings).toEqual(["fallback_from_c_hybrid:image_TOOL_FAILED"]);
      expect(r.runner_reported.fallback).toMatchObject({ from_route: "C_hybrid", image_outcome: "TOOL_FAILED", image_stop_code: "CODEX_IMAGE_TOOL_FAILED" });
      expect(r.runner_reported.generation.image_outcome).toBe("TOOL_FAILED");
    });

    it.each(["TOOL_NOT_CALLED", "TOOL_FAILED_TRANSIENT", "TOOL_CALLED_NO_FILE"])("accepts the failed outcome %s as recorded", async (outcome) => {
      expect((await run(fallbackB({ image_outcome: outcome }, outcome))).verification_state).toBe("render_pair_complete");
    });

    it.each<[string, () => Pkg, string]>([
      ["a fallback that claims the image was saved", () => fallbackB({ image_outcome: "IMAGE_SAVED" }, "IMAGE_SAVED"), "ARTIFACT_SCHEMA_INVALID"],
      ["a fallback where the image was essential (re-generate or ask the owner)", () => fallbackB({ image_essential: true }), "ARTIFACT_SCHEMA_INVALID"],
      ["a fallback not decided by the runner", () => fallbackB({ decided_by: "codex" }), "ARTIFACT_SCHEMA_INVALID"],
      ["a fallback whose outcome differs from the run's (history rewritten)", () => fallbackB({}, "not_applicable"), "ARTIFACT_ROUTE_INCONSISTENT"],
      ["a fallback after a policy refusal (a safety stop goes to the owner)", () => fallbackB({ image_outcome: "TOOL_FAILED_POLICY" }, "TOOL_FAILED_POLICY"), "ARTIFACT_SCHEMA_INVALID"],
      ["a fallback on route A", () => edit(routeA, (p) => (p.artifact.observed.fallback = { from_route: "C_hybrid", image_outcome: "TOOL_FAILED", image_stop_code: "CODEX_IMAGE_TOOL_FAILED", image_approval_id: null, image_essential: false, decided_by: "runner" })), "ARTIFACT_ROUTE_INCONSISTENT"],
      ["a fallback reusing the run's approval ID for the image attempt", () => fallbackB({ image_approval_id: "fictional-run-20261028-01" }), "ARTIFACT_ROUTE_INCONSISTENT"],
      ["a fallback without the failed attempt's stop code", () => fallbackB({ image_stop_code: null }), "ARTIFACT_ROUTE_INCONSISTENT"],
      ["a fallback on route C", () => edit(routeC, (p) => (p.artifact.observed.fallback = { from_route: "C_hybrid", image_outcome: "TOOL_FAILED", image_stop_code: null, image_approval_id: null, image_essential: false, decided_by: "runner" })), "ARTIFACT_ROUTE_INCONSISTENT"],
      ["a fallback B that still carries a generated asset", () => edit(() => fallbackB(), (p) => {
        p.files["assets/a1.png"] = makePng(64, 64);
        p.artifact.observed.assets = [{ id: "A1", path: "assets/a1.png", kind: "ai_concept", approval_id: "fictional-asset-20261028-09", use: "design_only" }];
        p.artifact.declared.structure_spec.sections[1].asset_refs = ["A1"];
      }), "ARTIFACT_ROUTE_INCONSISTENT"],
      ["a plain B with a failed image outcome but no fallback record", () => edit(routeB, (p) => (p.artifact.observed.generation.image_outcome = "TOOL_FAILED")), "ARTIFACT_ROUTE_INCONSISTENT"],
    ])("refuses %s", async (_n, make, expected) => {
      expect(await code(run(make()))).toBe(expected);
    });
  });

  it.each<[string, (p: Pkg) => void]>([
    ["no generated asset and a failed image tool", (p) => {
      delete p.files["assets/a1.png"];
      p.artifact.observed.assets = [];
      p.artifact.declared.structure_spec.sections[1].asset_refs = [];
      p.artifact.observed.generation.image_outcome = "TOOL_FAILED";
    }],
    ["no generated asset even with IMAGE_SAVED", (p) => {
      delete p.files["assets/a1.png"];
      p.artifact.observed.assets = [];
      p.artifact.declared.structure_spec.sections[1].asset_refs = [];
    }],
    ["only a placeholder asset", (p) => (p.artifact.observed.assets[0].kind = "placeholder")],
  ])("route C with %s is refused, never a success (regression)", async (_n, mutate) => {
    expect(await detail(run(edit(routeC, mutate)))).toBe("ARTIFACT_ROUTE_INCONSISTENT route C needs at least one generated asset (otherwise it is route B)");
  });

  it.each(["TOOL_FAILED", "TOOL_NOT_CALLED", "TOOL_CALLED_NO_FILE", "not_applicable"])("route C with a generated asset but image outcome %s is refused", async (outcome) => {
    expect(await detail(run(edit(routeC, (p) => (p.artifact.observed.generation.image_outcome = outcome))))).toBe("ARTIFACT_ROUTE_INCONSISTENT route C: generated assets without IMAGE_SAVED");
  });

  it("route A carries no assets", async () => {
    const d = await detail(run(edit(routeA, (p) => {
      p.files["assets/a1.png"] = makePng(64, 64);
      p.artifact.observed.assets = [{ id: "A1", path: "assets/a1.png", kind: "placeholder", approval_id: null, use: "design_only" }];
      p.artifact.declared.structure_spec.sections[1].asset_refs = ["A1"];
    })));
    expect(d).toBe("ARTIFACT_ROUTE_INCONSISTENT route A carries no prototype, render or assets");
  });

  it.each(["tool", "tool_version", "approval_id", "prompt_sha256", "worker_commit", "run_id", "started_at", "finished_at"])(
    "an unknown %s alone makes route B incomplete",
    async (field) => {
      const r = await run(edit(routeB, (p) => (p.artifact.observed.generation[field] = null)));
      expect(r.verification_state).toBe("incomplete");
      expect(r.reasons).toContain(`generation_unverified:${field}`);
    },
  );

  it("reports every human gate as not_done, whatever the state", async () => {
    for (const make of [routeA, routeB, routeC]) {
      const r = await run(make());
      expect(r.human_gates).toEqual({ identity_visual_check: "not_done", g2_design: "not_done", g3_responsive: "not_done", g5_final_comparison: "not_done" });
      expect(r.notes.join(" ")).toMatch(/not an owner approval/);
      expect(r.notes.join(" ")).toMatch(/Phase 2e/);
    }
  });
});

describe("self-declared state is impossible by shape, not by word search", () => {
  it.each<[string, (p: Pkg) => void]>([
    ["a top-level approval", (p) => (p.artifact.approved = true)],
    ["a stored verification state", (p) => (p.artifact.verification_state = "render_pair_complete")],
    ["human gates in the artifact", (p) => (p.artifact.human_gates = { g2_design: "pass" })],
    ["a verified flag in the declared design", (p) => (p.artifact.declared.verified = true)],
    ["an approval on an original", (p) => (p.artifact.observed.originals.desktop_1440.owner_approved = true)],
    ["a trust state in observed", (p) => (p.artifact.observed.trust_state = "owner_approved")],
    ["a non-1 device scale factor", (p) => (p.artifact.observed.render.device_scale_factor = 2)],
    ["interactions (not part of 2d-min)", (p) => (p.artifact.declared.interaction_spec = [{ id: "x" }])],
  ])("refuses %s (ARTIFACT_SCHEMA_INVALID)", async (_n, mutate) => {
    expect(await code(run(edit(routeB, mutate)))).toBe("ARTIFACT_SCHEMA_INVALID");
  });

  it("accepts design text that merely contains the words approved / verified", async () => {
    const r = await run(edit(routeB, (p) => (p.artifact.declared.design_dna.hero.choice = "approved と verified という語を含む架空の説明")));
    expect(r.verification_state).toBe("render_pair_complete");
  });

  it("Codex's answer shape has no file, SHA, state or approval field", () => {
    const ok = { ...declared(), prototype: { html: HTML, css: CSS } };
    expect(checkCodexDesign(ok).prototype?.html).toBe(HTML);
    expect(checkCodexDesign({ ...declared(), prototype: null }).prototype).toBeNull();
    for (const extra of [{ approved: true }, { verified: true }, { files: [] }, { sha256: "a".repeat(64) }, { generation: {} }, { verification_state: "render_pair_complete" }]) {
      expect(() => checkCodexDesign({ ...ok, ...extra })).toThrow(IntakeError);
    }
    expect(() => checkCodexDesign({ ...ok, prototype: { html: "x".repeat(PROTOTYPE_LIMITS.html + 1), css: "" } })).toThrow(IntakeError);
  });

  it("a stored record inside the package is never read: it is an undeclared file", async () => {
    const p = routeB();
    p.files["gate-record.json"] = JSON.stringify({ verification_state: "render_pair_complete", human_gates: { g2_design: "pass" } });
    const w = write(p);
    // writePackage declares every file it wrote; take the record back out of the declaration
    const a = JSON.parse(readFileSync(join(w.dir, "artifact.json"), "utf8"));
    a.observed.files = a.observed.files.filter((f: { path: string }) => f.path !== "gate-record.json");
    writeFileSync(join(w.dir, "artifact.json"), JSON.stringify(a));
    expect(await code(intakeArtifact({ packageDir: w.dir, factsPath: w.factsPath }))).toBe("ARTIFACT_UNDECLARED_FILE");
  });
});

describe("file safety", () => {
  const pkg = async (p: Pkg, after: (dir: string, base: string) => void) => {
    const w = write(p);
    after(w.dir, w.base);
    return code(intakeArtifact({ packageDir: w.dir, factsPath: w.factsPath }));
  };

  it("refuses a link to a file", async () => {
    expect(await pkg(routeB(), (dir, base) => {
      writeFileSync(join(base, "outside.png"), makePng(1440, 2000));
      rmSync(join(dir, "originals/desktop_1440.png"));
      symlinkSync(join(base, "outside.png"), join(dir, "originals/desktop_1440.png"));
    })).toBe("ARTIFACT_PATH_UNSAFE");
  });

  it("refuses a parent directory that is a link (escape through the parent)", async () => {
    expect(await pkg(routeB(), (dir, base) => {
      mkdirSync(join(base, "elsewhere"));
      for (const f of ["desktop_1440.png", "mobile_390.png"]) writeFileSync(join(base, "elsewhere", f), readFileSync(join(dir, "originals", f)));
      rmSync(join(dir, "originals"), { recursive: true });
      symlinkSync(join(base, "elsewhere"), join(dir, "originals"));
    })).toBe("ARTIFACT_PATH_UNSAFE");
  });

  it("refuses a hard link (the same bytes reachable from elsewhere)", async () => {
    expect(await pkg(routeB(), (dir, base) => linkSync(join(dir, "quarantine/styles.css"), join(base, "styles-copy.css")))).toBe("ARTIFACT_PATH_UNSAFE");
  });

  it("refuses a special file", async () => {
    expect(await pkg(routeB(), (dir) => spawnSync("mkfifo", [join(dir, "quarantine/pipe")]))).toBe("ARTIFACT_PATH_UNSAFE");
  });

  it("refuses an undeclared file", async () => {
    expect(await pkg(routeB(), (dir) => writeFileSync(join(dir, "assets-note.txt"), "x"))).toBe("ARTIFACT_UNDECLARED_FILE");
  });

  it("refuses bytes that changed after the SHA was recorded (same size and different size)", async () => {
    expect(await pkg(routeB(), (dir) => writeFileSync(join(dir, "quarantine/styles.css"), "body{margin:1}"))).toBe("ARTIFACT_SHA_MISMATCH");
    expect(await pkg(routeB(), (dir) => appendFileSync(join(dir, "quarantine/index.html"), " "))).toBe("ARTIFACT_SHA_MISMATCH");
  });

  describe("swaps between the walk and the read (each check by its own reason)", () => {
    const swapped = async (swap: (dir: string) => void) => {
      const w = write(routeB());
      return detail(intakeArtifact({ packageDir: w.dir, factsPath: w.factsPath }, { afterInventory: async () => swap(w.dir) }));
    };
    it("a file replaced by another file (new inode) → changed", async () => {
      expect(await swapped((dir) => {
        const f = join(dir, "originals/desktop_1440.png");
        writeFileSync(`${f}.new`, readFileSync(f));
        renameSync(`${f}.new`, f);
      })).toBe("ARTIFACT_PATH_UNSAFE changed: originals/desktop_1440.png");
    });
    it("a file grown in place → changed", async () => {
      expect(await swapped((dir) => appendFileSync(join(dir, "quarantine/styles.css"), "a"))).toBe("ARTIFACT_PATH_UNSAFE changed: quarantine/styles.css");
    });
    it("a parent directory replaced by a link to the very same files → escaped", async () => {
      expect(await swapped((dir) => {
        renameSync(join(dir, "originals"), join(dir, "..", "originals_real"));
        symlinkSync(join(dir, "..", "originals_real"), join(dir, "originals"));
      })).toBe("ARTIFACT_PATH_UNSAFE escaped: originals/desktop_1440.png");
    });
    it("a hard link added to a file → changed (the read re-checks the link count)", async () => {
      expect(await swapped((dir) => linkSync(join(dir, "quarantine/styles.css"), join(dir, "..", "styles-link.css")))).toBe("ARTIFACT_PATH_UNSAFE changed: quarantine/styles.css");
    });
    it("a parent directory replaced by a real directory holding the same files → parent changed", async () => {
      expect(await swapped((dir) => {
        renameSync(join(dir, "originals"), join(dir, "..", "originals_old"));
        mkdirSync(join(dir, "originals"));
        for (const f of ["desktop_1440.png", "mobile_390.png"]) renameSync(join(dir, "..", "originals_old", f), join(dir, "originals", f));
      })).toBe("ARTIFACT_PATH_UNSAFE parent changed: originals");
    });
    it("a file removed → refused, nothing read", async () => {
      expect(await swapped((dir) => rmSync(join(dir, "originals/mobile_390.png")))).toBe("ARTIFACT_PATH_UNSAFE originals/mobile_390.png");
    });
  });

  it("accepts a package reached through a link to its directory (resolved once)", async () => {
    const w = write(routeB());
    symlinkSync(w.dir, join(w.base, "alias"));
    expect((await intakeArtifact({ packageDir: join(w.base, "alias"), factsPath: w.factsPath })).verification_state).toBe("render_pair_complete");
  });

  it.each<[string, (p: Pkg) => void, string]>([
    ["a .. path", (p) => (p.artifact.observed.originals.desktop_1440.path = "originals/../artifact.json"), "ARTIFACT_SCHEMA_INVALID"],
    ["an absolute path", (p) => (p.artifact.observed.prototype.css_path = "/etc/passwd"), "ARTIFACT_SCHEMA_INVALID"],
    ["a backslash path", (p) => (p.artifact.observed.prototype.css_path = "quarantine\\styles.css"), "ARTIFACT_SCHEMA_INVALID"],
  ])("refuses %s", async (_n, mutate, expected) => {
    expect(await code(run(edit(routeB, mutate)))).toBe(expected);
  });

  it("refuses a file declared under another role's directory, and a prototype with the wrong extension", async () => {
    const w = write(edit(routeB, (p) => {
      p.files["originals/styles.css"] = CSS;
      delete p.files["quarantine/styles.css"];
      p.artifact.observed.prototype.css_path = "originals/styles.css";
    }));
    // declare it as the prototype it is, but under originals/
    const a = JSON.parse(readFileSync(join(w.dir, "artifact.json"), "utf8"));
    a.observed.files.find((f: { path: string }) => f.path === "originals/styles.css").role = "prototype";
    writeFileSync(join(w.dir, "artifact.json"), JSON.stringify(a));
    expect(await detail(intakeArtifact({ packageDir: w.dir, factsPath: w.factsPath }))).toBe("ARTIFACT_FILE_ROLE_MISMATCH outside its role directory: originals/styles.css");
    expect(await detail(run(edit(routeB, (p) => {
      p.files["quarantine/styles.txt"] = CSS;
      delete p.files["quarantine/styles.css"];
      p.artifact.observed.prototype.css_path = "quarantine/styles.txt";
    })))).toBe("ARTIFACT_FILE_ROLE_MISMATCH prototype extension: quarantine/styles.txt");
  });

  it("refuses an original whose name is not .png, even with PNG bytes", async () => {
    expect(await code(run(edit(routeB, (p) => {
      p.files["originals/desktop_1440.webp"] = p.files["originals/desktop_1440.png"]!;
      delete p.files["originals/desktop_1440.png"];
      p.artifact.observed.originals.desktop_1440.path = "originals/desktop_1440.webp";
    })))).toBe("ARTIFACT_FILE_ROLE_MISMATCH");
  });

  it("refuses path segments starting with - (option injection later)", () => {
    expect(RelPath.safeParse("originals/-rf.png").success).toBe(false);
    expect(RelPath.safeParse("-x/a.png").success).toBe(false);
    expect(RelPath.safeParse("originals/a-b.png").success).toBe(true);
  });

  it("keeps file names out of error text unescaped (no terminal or log injection)", async () => {
    const w = write(routeB());
    writeFileSync(join(w.dir, "evil\u001b[31m\nname"), "x");
    const d = await detail(intakeArtifact({ packageDir: w.dir, factsPath: w.factsPath }));
    expect(d.startsWith("ARTIFACT_PATH_UNSAFE")).toBe(true);
    expect(d).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(new IntakeError("X", "a\u0007\u001b\u00e9".padEnd(500, "z")).message).toMatch(/^X: a\?\?\?z{196}$/);
  });

  it("refuses files outside their role's directory, unreferenced files and double references", async () => {
    expect(await code(run(edit(routeB, (p) => {
      p.files["assets/desktop_1440.png"] = p.files["originals/desktop_1440.png"]!;
      delete p.files["originals/desktop_1440.png"];
      p.artifact.observed.originals.desktop_1440.path = "assets/desktop_1440.png";
    })))).toBe("ARTIFACT_FILE_ROLE_MISMATCH");
    expect(await code(run(edit(routeB, (p) => (p.files["assets/extra.png"] = makePng(64, 64)))))).toBe("ARTIFACT_FILE_ROLE_MISMATCH");
    expect(await code(run(edit(routeB, (p) => (p.artifact.observed.prototype.css_path = "quarantine/index.html"))))).toBe("ARTIFACT_FILE_ROLE_MISMATCH");
  });

  it("caps sizes: prototype CSS and artifact.json", async () => {
    expect(await code(run(edit(routeB, (p) => (p.files["quarantine/styles.css"] = "a".repeat(PROTOTYPE_LIMITS.css + 1)))))).toBe("ARTIFACT_TOO_LARGE");
    const big = edit(routeB, (p) => (p.artifact.declared.design_dna.hero.choice = "x"));
    const w = write(big);
    appendFileSync(join(w.dir, "artifact.json"), " ".repeat(1024 * 1024));
    expect(await code(intakeArtifact({ packageDir: w.dir, factsPath: w.factsPath }))).toBe("ARTIFACT_TOO_LARGE");
  });

  it("checks the facts pack byte for byte and by shop", async () => {
    const w = write(routeB());
    writeFileSync(w.factsPath, JSON.stringify(FACTS) + " ");
    expect(await code(intakeArtifact({ packageDir: w.dir, factsPath: w.factsPath }))).toBe("ARTIFACT_FACT_PACK_MISMATCH");
    expect(await code(run(routeB(), { facts: { ...FACTS, shop_id: "other-shop" } }))).toBe("ARTIFACT_FACT_PACK_MISMATCH");
    expect(await code(run(routeB(), { facts: { ...FACTS, facts: [{ id: "F1", key: "name", value: "<b>x</b>", source_id: "S1" }] } }))).toBe("ARTIFACT_FACTS_INVALID");
  });
});

describe("image sizes and limits", () => {
  it("keeps the limits tied to the existing ones without changing them", () => {
    const render = readFileSync(resolve(REPO, "lib/design-agent/comp-impl/render.ts"), "utf8");
    expect(render).toContain(`export const MAX_PAGE_HEIGHT = ${MAX_RENDER_HEIGHT};`);
    expect(MAX_RENDER_HEIGHT).toBe(16000);
    expect(PNG_LIMITS.concept_image).toEqual(MOCKUP_PNG_LIMITS);
    expect(readFileSync(resolve(REPO, "lib/design-agent/codex.ts"), "utf8")).toContain("info.size > 1024 * 1024");
    expect(CODEX_ANSWER_MAX_BYTES).toBe(1024 * 1024);
    expect(PROTOTYPE_LIMITS.html + PROTOTYPE_LIMITS.css).toBeLessThan(CODEX_ANSWER_MAX_BYTES);
    // a decode of the largest accepted render stays under 100 MB (RGBA)
    expect(PNG_LIMITS.viewport_render_desktop_1440.maxPixels * 4).toBeLessThan(100_000_000);
    expect(PNG_LIMITS.viewport_render_desktop_1440.maxPixels).toBe(1440 * 16000);
    expect(PNG_LIMITS.viewport_render_mobile_390.maxPixels).toBe(390 * 16000);
  });

  it("checks PNG structure exactly like design-image's png.ts (which it may not import)", () => {
    const good = makePng(600, 700);
    const crcBroken = Buffer.from(good);
    crcBroken[good.length - 20] = crcBroken[good.length - 20]! ^ 0xff;
    const depthBad = Buffer.from(good);
    depthBad[8 + 8 + 8] = 3; // IHDR bit depth 3
    const IEND = pngChunk("IEND", Buffer.alloc(0));
    const IDAT = pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]));
    const build = (...chunks: Buffer[]) => Buffer.concat([PNG_SIG, ...chunks]);
    const hugeLength = Buffer.from(good);
    hugeLength.writeUInt32BE(0x7ffffff0, 33); // the IDAT length field
    const cases: Buffer[] = [
      build(pngChunk("IHDR", ihdr(600, 700)), pngChunk("IHDR", ihdr(600, 700)), IDAT, IEND), // a second IHDR
      build(pngChunk("IHDR", ihdr(600, 700)), pngChunk("tEXt", Buffer.alloc(32)), IEND), // no IDAT (long enough to reach the IDAT rule)
      build(pngChunk("IHDR", ihdr(600, 700, { interlace: 2 })), IDAT, IEND), // bad interlace
      build(pngChunk("IHDR", ihdr(600, 700, { interlace: 1 })), IDAT, IEND), // Adam7 is allowed
      build(pngChunk("IHDR", ihdr(600, 700, { colour: 6, depth: 4 })), IDAT, IEND), // bad colour/depth pair
      build(pngChunk("IHDR", ihdr(600, 700)), IDAT, pngChunk("IEND", Buffer.from([1]))), // non-empty IEND
      build(pngChunk("IHDR", ihdr(600, 700)), pngChunk("ID@T", Buffer.alloc(1)), IDAT, IEND), // bad chunk name
      build(pngChunk("IDAT", Buffer.alloc(13)), IEND), // IDAT before IHDR
      hugeLength,
      good,
      good.subarray(0, good.length - 12), // no IEND
      Buffer.concat([good, Buffer.from([0])]), // trailing data
      crcBroken,
      depthBad,
      makePng(511, 700), // below the concept minimum
      makePng(8193, 600), // above the concept maximum
      Buffer.from("not a png"),
    ];
    const verdict = (fn: () => unknown) => {
      try {
        return JSON.stringify(fn());
      } catch {
        return "invalid";
      }
    };
    const limitsSets = [
      PNG_LIMITS.concept_image,
      PNG_LIMITS.viewport_render_mobile_390,
      PNG_LIMITS.viewport_render_desktop_1440,
      { maxBytes: good.length - 1, minSide: 1, maxSide: 8192, maxPixels: 40_000_000 }, // byte cap
      { maxBytes: 1 << 24, minSide: 1, maxSide: 8192, maxPixels: 600 * 700 - 1 }, // pixel cap
    ];
    let invalid = 0;
    for (const limits of limitsSets) {
      for (const b of [...cases, makePng(390, 16000), makePng(390, 16001)]) {
        const ours = verdict(() => checkArtifactPng(b, limits));
        const theirs = verdict(() => {
          const { width, height } = checkPng(b, limits);
          return { width, height };
        });
        expect(ours).toBe(theirs);
        if (ours === "invalid") invalid += 1;
      }
    }
    expect(invalid).toBeGreaterThan(40);
    expect(verdict(() => checkArtifactPng(good, PNG_LIMITS.concept_image))).toBe(JSON.stringify({ width: 600, height: 700 }));
  });

  it("mirrors the design-image stop classes and image outcomes", () => {
    expect(IMAGE_OUTCOMES.filter((o) => o !== "not_applicable")).toEqual([...CAPABILITY_OUTCOMES]);
    const run = readFileSync(resolve(REPO, "lib/design-agent/design-image/run.ts"), "utf8");
    const m = run.match(/export type PocStopClass = ([^;]+);/)!;
    expect([...m[1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]).sort()).toEqual([...STOP_CLASSES].sort());
  });

  it("refuses a concept image above the pixel cap (7000 × 6000 = 42 M pixels)", async () => {
    expect(await code(run(edit(routeA, (p) => {
      p.files["originals/desktop_concept.png"] = makePng(7000, 6000);
      Object.assign(p.artifact.observed.originals.desktop_1440, { width: 7000, height: 6000 });
    })))).toBe("ARTIFACT_PNG_INVALID");
  });

  it("refuses a render above its file size cap, before reading it", async () => {
    const padded = makePng(390, 3000, [pngChunk("tEXt", Buffer.alloc(PNG_LIMITS.viewport_render_mobile_390.maxBytes))]);
    expect(padded.length).toBeGreaterThan(PNG_LIMITS.viewport_render_mobile_390.maxBytes);
    expect(await detail(run(edit(routeB, (p) => (p.files["originals/mobile_390.png"] = padded))))).toBe("ARTIFACT_TOO_LARGE originals/mobile_390.png");
    // and the PNG check itself refuses it too (defence in depth)
    expect(() => checkArtifactPng(padded, PNG_LIMITS.viewport_render_mobile_390)).toThrow(IntakeError);
    expect(checkArtifactPng(makePng(390, 3000), PNG_LIMITS.viewport_render_mobile_390)).toEqual({ width: 390, height: 3000 });
  });

  it("refuses a package above the total cap (tests may only lower it)", async () => {
    const w = write(routeB());
    expect(await detail(intakeArtifact({ packageDir: w.dir, factsPath: w.factsPath }, { totalBytesCap: 1_000 }))).toBe("ARTIFACT_TOO_LARGE package");
    // a higher cap cannot raise the real one: a package over the real cap is refused even when a huge cap is asked for
    const big = write(edit(routeC, (p) => {
      for (let i = 2; i <= 8; i++) {
        p.files[`assets/a${i}.png`] = makePng(64, 64, [pngChunk("tEXt", Buffer.alloc(15 * 1024 * 1024))]);
        p.artifact.observed.assets.push({ id: `A${i}`, path: `assets/a${i}.png`, kind: "ai_concept", approval_id: `fictional-asset-20261028-0${i}`, use: "design_only" });
        p.artifact.declared.structure_spec.sections[2].asset_refs.push(`A${i}`);
      }
    }));
    expect(await detail(intakeArtifact({ packageDir: big.dir, factsPath: big.factsPath }, { totalBytesCap: Number.MAX_SAFE_INTEGER }))).toBe("ARTIFACT_TOO_LARGE package");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(await detail(intakeArtifact({ packageDir: w.dir, factsPath: w.factsPath }, { totalBytesCap: bad }))).toBe("ARTIFACT_TOO_LARGE invalid total cap");
    }
  });

  it("accepts a 390 × 16000 render and refuses 16001", async () => {
    const tall = (h: number) =>
      edit(routeB, (p) => {
        p.files["originals/mobile_390.png"] = makePng(390, h);
        Object.assign(p.artifact.observed.originals.mobile_390, { height: h });
        p.artifact.declared.structure_spec.page_height.mobile_390 = Math.min(h, 16000);
      });
    expect((await run(tall(16000))).verification_state).toBe("render_pair_complete");
    expect(await code(run(tall(16001)))).toBe("ARTIFACT_PNG_INVALID");
  });

  it.each<[string, (p: Pkg) => void, string]>([
    ["a desktop render not 1440 wide", (p) => {
      p.files["originals/desktop_1440.png"] = makePng(1400, 2000);
      p.artifact.observed.originals.desktop_1440.width = 1400;
    }, "ARTIFACT_VIEWPORT_MISMATCH"],
    ["a 2x mobile render (deviceScaleFactor 2)", (p) => {
      p.files["originals/mobile_390.png"] = makePng(780, 6000);
      Object.assign(p.artifact.observed.originals.mobile_390, { width: 780, height: 6000 });
    }, "ARTIFACT_VIEWPORT_MISMATCH"],
    ["a declared size that is not the file's", (p) => {
      // the spec's page agrees with the declared height, so only the declared-vs-file check can stop it
      p.artifact.observed.originals.mobile_390.height = 2999;
      p.artifact.declared.structure_spec.page_height.mobile_390 = 2999;
      p.artifact.declared.structure_spec.sections[3].boxes.mobile_390.h = 199;
    }, "ARTIFACT_VIEWPORT_MISMATCH"],
    ["a render shorter than the spec's page", (p) => (p.artifact.declared.structure_spec.page_height.desktop_1440 = 2100), "ARTIFACT_VIEWPORT_MISMATCH"],
    ["a truncated PNG", (p) => (p.files["originals/desktop_1440.png"] = (p.files["originals/desktop_1440.png"] as Buffer).subarray(0, 60)), "ARTIFACT_PNG_INVALID"],
    ["a non-PNG original", (p) => (p.files["originals/desktop_1440.png"] = "not a png"), "ARTIFACT_PNG_INVALID"],
  ])("refuses %s", async (_n, mutate, expected) => {
    expect(await code(run(edit(routeB, mutate)))).toBe(expected);
  });
});

describe("routes A/B/C are consistent", () => {
  it.each<[string, () => Pkg, (p: Pkg) => void]>([
    ["A with a prototype", routeA, (p) => {
      p.files["quarantine/index.html"] = HTML;
      p.files["quarantine/styles.css"] = CSS;
      p.artifact.observed.prototype = { html_path: "quarantine/index.html", css_path: "quarantine/styles.css" };
    }],
    ["A claiming a browser render", routeA, (p) => (p.artifact.observed.originals.desktop_1440.kind = "viewport_render")],
    ["A with an image but no IMAGE_SAVED", routeA, (p) => (p.artifact.observed.generation.image_outcome = "TOOL_NOT_CALLED")],
    ["B with a concept image", routeB, (p) => Object.assign(p.artifact.observed.originals.desktop_1440, { kind: "concept_image", rendered_from: "image_tool" })],
    ["B without the prototype", routeB, (p) => {
      delete p.files["quarantine/index.html"];
      delete p.files["quarantine/styles.css"];
      p.artifact.observed.prototype = null;
    }],
    ["B without render conditions", routeB, (p) => (p.artifact.observed.render = null)],
    ["B with a render said to come from the image tool", routeB, (p) => (p.artifact.observed.originals.mobile_390.rendered_from = "image_tool")],
    ["A (Codex) with a concept image said to be an owner upload", routeA, (p) => (p.artifact.observed.originals.mobile_390.rendered_from = "owner_upload")],
    ["C with two assets sharing one approval ID", routeC, (p) => {
      p.files["assets/a2.png"] = makePng(400, 300);
      p.artifact.observed.assets.push({ id: "A2", path: "assets/a2.png", kind: "ai_concept", approval_id: "fictional-asset-20261028-01", use: "design_only" });
      p.artifact.declared.structure_spec.sections[2].asset_refs = ["A2"];
    }],
    ["C with an asset approved under the run's own ID", routeC, (p) => (p.artifact.observed.assets[0].approval_id = p.artifact.observed.generation.approval_id)],
    ["C with generated assets but no IMAGE_SAVED", routeC, (p) => (p.artifact.observed.generation.image_outcome = "TOOL_NOT_CALLED")],
    ["B with a generated image", routeB, (p) => (p.artifact.observed.generation.image_outcome = "IMAGE_SAVED")],
    ["C with a generated asset lacking its own approval", routeC, (p) => (p.artifact.observed.assets[0].approval_id = null)],
    ["an owner upload on route B", routeB, (p) => (p.artifact.source_kind = "chatgpt_owner_upload_compat")],
  ])("refuses %s (ARTIFACT_ROUTE_INCONSISTENT)", async (_n, make, mutate) => {
    expect(await code(run(edit(make, mutate)))).toBe("ARTIFACT_ROUTE_INCONSISTENT");
  });
});

describe("the declared design resolves", () => {
  it.each<[string, (p: Pkg) => void, string]>([
    ["a Design DNA fact that does not exist", (p) => (p.artifact.declared.design_dna.palette.fact_refs = ["F9"]), "ARTIFACT_FACT_UNRESOLVED"],
    ["live text citing an unknown fact", (p) => (p.artifact.declared.structure_spec.sections[0].live_text = [{ fact_ref: "F8" }]), "ARTIFACT_FACT_UNRESOLVED"],
    ["an order that drops a section", (p) => p.artifact.declared.structure_spec.order.mobile_390.pop(), "ARTIFACT_STRUCTURE_INVALID"],
    ["a reading path naming an unknown section", (p) => p.artifact.declared.structure_spec.reading_path.desktop_1440.push("ghost"), "ARTIFACT_STRUCTURE_INVALID"],
    ["a duplicate section id", (p) => (p.artifact.declared.structure_spec.sections[3].id = "info"), "ARTIFACT_STRUCTURE_INVALID"],
    ["a box wider than the mobile viewport", (p) => (p.artifact.declared.structure_spec.sections[0].boxes.mobile_390.w = 400), "ARTIFACT_STRUCTURE_INVALID"],
    ["a box below the page", (p) => (p.artifact.declared.structure_spec.sections[3].boxes.desktop_1440.h = 500), "ARTIFACT_STRUCTURE_INVALID"],
    ["an asset reference with no asset", (p) => (p.artifact.declared.structure_spec.sections[1].asset_refs = ["A2"]), "ARTIFACT_ASSET_UNRESOLVED"],
    ["an asset no section uses", (p) => (p.artifact.declared.structure_spec.sections[1].asset_refs = []), "ARTIFACT_ASSET_UNRESOLVED"],
    ["a Design DNA part without a fact", (p) => (p.artifact.declared.design_dna.mobile.fact_refs = []), "ARTIFACT_SCHEMA_INVALID"],
    ["a missing Design DNA part", (p) => delete p.artifact.declared.design_dna.navigation, "ARTIFACT_SCHEMA_INVALID"],
  ])("refuses %s", async (_n, mutate, expected) => {
    expect(await code(run(edit(routeC, mutate)))).toBe(expected);
  });
});

describe("CLI", () => {
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, "scripts/design-artifact/intake.ts"), ...args], { encoding: "utf8" });

  it("prints the record, refuses with the stop code, and refuses argument mistakes", () => {
    const w = write(routeB());
    const ok = cli(["--package", w.dir, "--facts", w.factsPath]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).verification_state).toBe("render_pair_complete");

    writeFileSync(join(w.dir, "quarantine/styles.css"), "body{margin:9}");
    const bad = cli(["--package", w.dir, "--facts", w.factsPath]);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toContain("ARTIFACT_SHA_MISMATCH");

    for (const args of [[], ["--package", w.dir], ["--package", w.dir, "--facts"], ["--package=x", "--facts=y"], ["--package", w.dir, "--package", w.dir, "--facts", w.factsPath], ["--package", w.dir, "--facts", w.factsPath, "--approve"]]) {
      const r = cli(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).toBe("");
    }
  }, 60_000);
});
