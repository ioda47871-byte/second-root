import { spawnSync } from "node:child_process";
import { appendFileSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkArtifactPng, checkCodexDesign, IntakeError, intakeArtifact } from "@/lib/design-agent/artifact/intake";
import { CODEX_ANSWER_MAX_BYTES, IMAGE_OUTCOMES, MAX_RENDER_HEIGHT, PNG_LIMITS, PROTOTYPE_LIMITS, STOP_CLASSES } from "@/lib/design-agent/artifact/schema";
import { IMAGE_OUTCOMES as CAPABILITY_OUTCOMES } from "@/lib/design-agent/design-image/capability";
import { checkPng, MOCKUP_PNG_LIMITS } from "@/lib/design-agent/design-image/png";
import { CSS, declared, FACTS, HTML, makePng, routeA, routeB, routeC, writePackage, type Pkg } from "./fixtures";

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
    expect(r.reasons.join(" ")).toContain("generation_unverified");
  });

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
    const cases: Buffer[] = [
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
    for (const b of cases) {
      const ours = verdict(() => checkArtifactPng(b, PNG_LIMITS.concept_image));
      const theirs = verdict(() => {
        const { width, height } = checkPng(b, MOCKUP_PNG_LIMITS);
        return { width, height };
      });
      expect(ours).toBe(theirs);
    }
    expect(verdict(() => checkArtifactPng(good, PNG_LIMITS.concept_image))).toBe(JSON.stringify({ width: 600, height: 700 }));
  });

  it("mirrors the design-image stop classes and image outcomes", () => {
    expect(IMAGE_OUTCOMES.filter((o) => o !== "not_applicable")).toEqual([...CAPABILITY_OUTCOMES]);
    const run = readFileSync(resolve(REPO, "lib/design-agent/design-image/run.ts"), "utf8");
    const m = run.match(/export type PocStopClass = ([^;]+);/)!;
    expect([...m[1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]).sort()).toEqual([...STOP_CLASSES].sort());
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
    ["a declared size that is not the file's", (p) => (p.artifact.observed.originals.desktop_1440.height = 1999), "ARTIFACT_VIEWPORT_MISMATCH"],
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
