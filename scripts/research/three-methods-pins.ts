/**
 * DEV-143 (Issue #180, EXPERIMENTAL, opt-in): prints the pins (SHA-256 and length) of every prompt of the
 * three-method pilot, from the study's own inputs. OFFLINE ONLY: it reads files and prints JSON. It calls nothing:
 * no Codex, no image tool, no process, no network, no ledger. It has no flag that could make a call.
 *
 *   --print-pin [--layout-page <html>] [--direction-page <html>]
 *
 * The inputs are design-library/research/three-methods/facts-pack.json and brief.json (the common brief without
 * DNA). A page Claude wrote for LAYOUT_FIRST or DIRECTION_FIRST may be given to print its picture requests' pins too.
 * The pins are what an owner approval would name; printing them approves nothing and runs nothing.
 *
 * Exit: 0 printed, 2 refused (usage or an input that does not check).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "../../lib/design-agent/three-methods/brief";
import { pilotPins } from "../../lib/design-agent/three-methods/pins";

const REPO = resolve(__dirname, "../..");
const INPUTS = "design-library/research/three-methods";
const PAGE_FLAGS = { "--layout-page": "LAYOUT_FIRST", "--direction-page": "DIRECTION_FIRST" } as const;

const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

/** `--print-pin` once, and each page flag at most once with a value; anything else is refused. */
function parse(argv: string[]): { pages: [keyof typeof PAGE_FLAGS, string][] } | null {
  if (argv.filter((a) => a === "--print-pin").length !== 1) return null;
  const pages: [keyof typeof PAGE_FLAGS, string][] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--print-pin") continue;
    if (!(a in PAGE_FLAGS)) return null;
    const v = argv[++i];
    if (v === undefined || v.startsWith("--") || pages.some(([f]) => f === a)) return null;
    pages.push([a as keyof typeof PAGE_FLAGS, v]);
  }
  return { pages };
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (!args) return (say({ status: "refused", code: "USAGE" }), 2);
  const read = (p: string) => readFile(p, "utf8");
  let factsText: string, briefText: string, facts: unknown, brief: unknown;
  const pages: { method: (typeof PAGE_FLAGS)[keyof typeof PAGE_FLAGS]; path: string; html: string }[] = [];
  try {
    factsText = await read(resolve(REPO, INPUTS, "facts-pack.json"));
    briefText = await read(resolve(REPO, INPUTS, "brief.json"));
    facts = JSON.parse(factsText);
    brief = JSON.parse(briefText);
    for (const [flag, path] of args.pages) pages.push({ method: PAGE_FLAGS[flag], path, html: await read(resolve(path)) });
  } catch {
    return (say({ status: "refused", code: "INPUT_UNREADABLE" }), 2);
  }
  const r = pilotPins({ facts, brief, pages });
  if (!r.ok) return (say({ status: "refused", code: r.code }), 2);
  say({
    mode: "print_pin",
    lane: "three_methods_experimental",
    calls_made: 0,
    note: "Offline pins only. Nothing was called, nothing is approved, and no generation or visual quality is shown by this output.",
    inputs: { facts_pack_sha256: sha256(factsText), brief_sha256: sha256(briefText), pages: pages.map((p) => ({ method: p.method, path: p.path, html_sha256: sha256(p.html) })) },
    pins: r.pins,
  });
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => (say({ status: "refused", code: "UNEXPECTED" }), process.exit(2)),
);
