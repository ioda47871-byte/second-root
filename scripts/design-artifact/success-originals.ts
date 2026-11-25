/**
 * Issue #336 CLI — OFFLINE: checks the success-case originals the owner hands over, and writes the owner's private viewer
 * of all adopted success cases (docs/design/success-originals-handover.md).
 *
 *   npx tsx scripts/design-artifact/success-originals.ts verify --root ~/second-root-originals [--sr001-job <dir>]
 *   npx tsx scripts/design-artifact/success-originals.ts viewer --out <empty dir> [--root ~/second-root-originals]
 *
 * verify  every file in <root>/<ID>/ (and <root>/<ID>/pseudo/) is hashed and judged against the SHA-256 recorded for
 *         that id (originals-handover.json, manifest.json, originals-index.json). A ZIP is read (CRC-checked; its
 *         SHA256SUMS, when present, must match entirely) and, when verified, extracted to <root>/_extracted/<ID>/.
 *         The PRIVATE index is written to <root>/_index/private-originals-index.json. --sr001-job also registers SR-001's
 *         completed AI-photo renders from that private image-run output, through the page SHA-256 chain.
 * viewer  a static page (no script, no network; CSP) listing every case with its status, the repository files and the
 *         verified private files (re-hashed), written to --out (outside this repository; empty or absent).
 *
 * The root and --out must be OUTSIDE this repository. Nothing is committed, sent or generated.
 * Exit: 0 done, 1 stopped (a named ORIGINALS_* code), 2 refused (bad arguments).
 */
import { resolve } from "node:path";
import { OriginalsStop, verifyProvidedOriginals, writeSuccessCasesViewer } from "../../lib/design-agent/case-study/success-originals";

const REPO = resolve(__dirname, "../..");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

type Args = { mode: "verify"; root: string; sr001Job?: string } | { mode: "viewer"; out: string; root?: string };
export function parseSuccessOriginalsArgs(argv: string[]): Args | null {
  const [mode, ...rest] = argv;
  const o: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]!;
    const v = rest[i + 1];
    if (!["--root", "--out", "--sr001-job"].includes(k) || !v || v.startsWith("--") || k in o) return null;
    o[k] = v;
  }
  if (mode === "verify") return o["--root"] && !o["--out"] ? { mode, root: resolve(o["--root"]), ...(o["--sr001-job"] ? { sr001Job: resolve(o["--sr001-job"]) } : {}) } : null;
  if (mode === "viewer") return o["--out"] && !o["--sr001-job"] ? { mode, out: resolve(o["--out"]), ...(o["--root"] ? { root: resolve(o["--root"]) } : {}) } : null;
  return null;
}

export async function successOriginalsMain(argv: string[], repo = REPO): Promise<number> {
  const a = parseSuccessOriginalsArgs(argv);
  if (!a) return (say({ status: "refused", code: "ARGS_INVALID" }), 2);
  try {
    if (a.mode === "verify") {
      const idx = await verifyProvidedOriginals({ repo, root: a.root, sr001Job: a.sr001Job });
      const byStatus: Record<string, number> = {};
      for (const e of idx.entries) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
      say({ status: "verified", index: `${idx.root}/_index/private-originals-index.json`, files: idx.entries.length, by_status: byStatus, entries: idx.entries.map((e) => ({ id: e.id, name: e.name, sha256: e.sha256, status: e.status, sums: e.zip?.sums ?? null })), ignored: idx.ignored.length });
      return 0;
    }
    const r = await writeSuccessCasesViewer({ repo, root: a.root, out: a.out });
    say({ status: "written", ...r });
    return 0;
  } catch (e) {
    if (e instanceof OriginalsStop) return (say({ status: "stopped", code: e.code }), 1);
    throw e;
  }
}

if (require.main === module)
  successOriginalsMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      say({ status: "refused", code: "REFUSED" });
      process.exit(2);
    },
  );
