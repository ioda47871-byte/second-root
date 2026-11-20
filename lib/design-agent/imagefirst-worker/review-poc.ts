/**
 * Issue #302 P3: the DUMMY proof of the local review hand-off. It makes a finished "run" of six harmless synthetic PNGs
 * (a solid colour, one white shape, a 4-digit number drawn as blocks, the words DUMMY TEST IMAGE; no shop content, no
 * prompt, no model) plus PC / SP composites stacked from them and a receipt in the exact shape the worker writes, then
 * runs the real code path: packBundle → local inbox (re-verified, atomic) → previews + INDEX.
 *
 * What each picture shows is chosen at random per run and returned to the caller only (the CLI prints it to the owner's
 * terminal). Nothing in the bundle, the inbox or INDEX names it, so a Claude session that describes the pictures
 * correctly can only have done so by looking at them.
 *
 * The bundle ID is fixed to the reserved date 00000000, which no real run may use (PR #308 review L4: the worker's cycle
 * and precheck, its claim and the automatic start's grant and run marker refuse it; tests pin those), so the dummy can
 * never collide with a real approval's bundle in the inbox. The local hand-off accepts it (this PoC uses it); a new PoC
 * run replaces only that dummy ID there.
 */
import { createHash, randomInt } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { packBundle, type SealedBundle } from "./bundle";
import { handOffToLocalInbox, removeFromInbox, type HandOffResult } from "./local-inbox";

export const DUMMY_ID = "hoshigama-imagefirst-d3-00000000-00";
export const DUMMY_RECORD = { approval_id: DUMMY_ID, plan_id: "review-poc-dummy", commit: "0".repeat(40) } as const;
export const DUMMY_PARTS = [
  { name: "pc-1", width: 1440, height: 2400 },
  { name: "pc-2", width: 1440, height: 2400 },
  { name: "sp-1", width: 780, height: 1560 },
  { name: "sp-2", width: 780, height: 1560 },
  { name: "sp-3", width: 780, height: 1560 },
  { name: "sp-4", width: 780, height: 1560 },
] as const;
export const COLOURS = [
  ["red", "#d62828"],
  ["orange", "#f77f00"],
  ["yellow", "#ffd60a"],
  ["green", "#2b9348"],
  ["blue", "#1d4ed8"],
  ["purple", "#7b2cbf"],
  ["pink", "#ff4d9d"],
  ["brown", "#8b5a2b"],
] as const;
export const SHAPES = ["circle", "square", "triangle", "diamond"] as const;
export type Challenge = { part: string; colour: string; shape: (typeof SHAPES)[number]; number: string };

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** 5×7 block digits (no font needed: the number reads the same on every machine). */
const DIGITS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

function blockNumber(num: string, x0: number, y0: number, cell: number): string {
  const out: string[] = [];
  [...num].forEach((d, i) => {
    DIGITS[d]!.forEach((row, y) => {
      [...row].forEach((bit, x) => {
        if (bit === "1") out.push(`<rect x="${x0 + i * 6 * cell + x * cell}" y="${y0 + y * cell}" width="${cell}" height="${cell}" fill="#000"/>`);
      });
    });
  });
  return out.join("");
}

function shapeSvg(shape: Challenge["shape"], cx: number, cy: number, r: number): string {
  const style = `fill="#fff" stroke="#000" stroke-width="${Math.max(4, Math.round(r / 12))}"`;
  if (shape === "circle") return `<circle cx="${cx}" cy="${cy}" r="${r}" ${style}/>`;
  if (shape === "square") return `<rect x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" ${style}/>`;
  if (shape === "triangle") return `<polygon points="${cx},${cy - r} ${cx + r},${cy + r} ${cx - r},${cy + r}" ${style}/>`;
  return `<polygon points="${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}" ${style}/>`;
}

/** One harmless dummy picture: colour, shape, block number, the words DUMMY TEST IMAGE and the part name. */
export async function dummyPng(width: number, height: number, c: Challenge, hex: string): Promise<Buffer> {
  const cell = Math.floor(width / 40);
  const numW = (c.number.length * 6 - 1) * cell;
  const panelPad = cell * 2;
  const panelY = Math.round(height * 0.12);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" fill="${hex}"/>`,
    `<text x="${width / 2}" y="${Math.round(height * 0.07)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.round(width / 18)}" font-weight="bold" text-anchor="middle" fill="#fff" stroke="#000" stroke-width="2">DUMMY TEST IMAGE ${c.part.toUpperCase()}</text>`,
    `<rect x="${(width - numW) / 2 - panelPad}" y="${panelY - panelPad}" width="${numW + 2 * panelPad}" height="${7 * cell + 2 * panelPad}" fill="#fff"/>`,
    blockNumber(c.number, (width - numW) / 2, panelY, cell),
    shapeSvg(c.shape, width / 2, Math.round(height * 0.6), Math.round(Math.min(width, height) * 0.28)),
    `</svg>`,
  ].join("");
  return sharp(Buffer.from(svg)).flatten({ background: hex }).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
}

/** The parts stacked top to bottom at one width (what image-first-check --run assembles, here only for the dummy). */
async function stack(parts: Buffer[], width: number): Promise<Buffer> {
  const scaled = await Promise.all(parts.map(async (p) => {
    const b = await sharp(p).resize({ width }).png().toBuffer();
    return { b, h: (await sharp(b).metadata()).height! };
  }));
  const height = scaled.reduce((n, s) => n + s.h, 0);
  let top = 0;
  const layers = scaled.map((s) => {
    const l = { input: s.b, top, left: 0 };
    top += s.h;
    return l;
  });
  return sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).composite(layers).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
}

async function write0600(path: string, bytes: Buffer | string) {
  const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await h.writeFile(bytes);
  } finally {
    await h.close();
  }
}

export type ReviewPocOptions = {
  /** A fresh private (0700, ours) directory outside the repository for the dummy run, bundle and delivery state. */
  workDir: string;
  /** The review inbox (its parent must exist, be ours and 0700). */
  inboxDir: string;
  now?: () => number;
  /** Random integer in [0, n) (tests inject it). */
  rand?: (n: number) => number;
};
export type ReviewPocResult = HandOffResult & { challenges: Challenge[]; bundle_sha256: string };

/** The dummy run + receipt, sealed into one bundle under <workDir>/bundles (no hand-off). */
export async function makeDummyBundle(o: Omit<ReviewPocOptions, "inboxDir">): Promise<{ sealed: SealedBundle; challenges: Challenge[] }> {
  const now = o.now ?? Date.now;
  const rand = o.rand ?? ((n: number) => randomInt(n));
  const info = await lstat(o.workDir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("WORK_DIR_UNSAFE");
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const runs = join(o.workDir, "runs");
  const runDir = join(runs, `${DUMMY_ID}-${stamp}`);
  await mkdir(join(runDir, "parts"), { recursive: true, mode: 0o700 });
  await mkdir(join(runDir, "composites"), { mode: 0o700 });

  const challenges: Challenge[] = [];
  const bytesOf: Record<string, Buffer> = {};
  const images: { file: string; sha256: string; bytes: number }[] = [];
  for (const p of DUMMY_PARTS) {
    const [colour, hex] = COLOURS[rand(COLOURS.length)]!;
    const c: Challenge = { part: p.name, colour, shape: SHAPES[rand(SHAPES.length)]!, number: String(rand(9000) + 1000) };
    const png = await dummyPng(p.width, p.height, c, hex);
    await write0600(join(runDir, "parts", `${p.name}.png`), png);
    challenges.push(c);
    bytesOf[p.name] = png;
    images.push({ file: `parts/${p.name}.png`, sha256: sha256(png), bytes: png.length });
  }
  const pc = await stack([bytesOf["pc-1"]!, bytesOf["pc-2"]!], 1440);
  const sp = await stack(["sp-1", "sp-2", "sp-3", "sp-4"].map((n) => bytesOf[n]!), 390);
  await write0600(join(runDir, "composites", "pc.png"), pc);
  await write0600(join(runDir, "composites", "sp.png"), sp);

  const t = new Date(now()).toISOString();
  const receipt = {
    schema: "imagefirst_worker_receipt_v1",
    status: "succeeded",
    stop_code: null,
    stage: null,
    interrupted: false,
    cli_exit: 0,
    cli_timed_out: false,
    shop: "hoshigama",
    direction: "d3",
    ...DUMMY_RECORD,
    packet_sha256: sha256("review-poc dummy packet"),
    plan_sha256: sha256("review-poc dummy plan"),
    prompt_sha256: sha256("review-poc: no prompt"),
    prompt_chars: 0,
    run_dir: runDir,
    images,
    stopped_images: [],
    counts: { pc: 2, sp: 4, total: 6, stopped: 0 },
    verified: true,
    timings: { started_at: t, finished_at: t, elapsed_ms: 0 },
  };
  const receiptPath = `${runDir}.receipt.json`;
  await write0600(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(o.workDir, "bundles"), composites: { pc: sha256(pc), sp: sha256(sp) }, now });
  return { sealed, challenges };
}

/** The whole PoC: the dummy bundle, then the real hand-off path (inbox + previews). */
export async function runReviewPoc(o: ReviewPocOptions): Promise<ReviewPocResult> {
  const now = o.now ?? Date.now;
  const { sealed, challenges } = await makeDummyBundle(o);
  // a previous dummy (another random set) would be a BUNDLE_ID_CONFLICT: only the fixed dummy ID is cleared
  await removeFromInbox(o.inboxDir, DUMMY_ID);
  const r = await handOffToLocalInbox({ sealed, stateDir: join(o.workDir, "state"), inboxDir: o.inboxDir, expected: { ...DUMMY_RECORD }, now });
  return { ...r, challenges, bundle_sha256: sealed.bundle_sha256 };
}
