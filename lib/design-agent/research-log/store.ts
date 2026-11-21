/**
 * Issue #302 P5: the research log on disk (design-library/research-log/). Entries and decisions are write-once files
 * (O_EXCL); the state file is the only one rewritten, atomically (tmp + rename). Every read is parsed with the schema, so
 * a hand-edited or truncated file stops the command instead of being trusted.
 *
 *   entries/<entry id>.json                    ResearchEntry, write-once
 *   decisions/<entry id>--<seq>.json           OwnerDecision, write-once, seq 1, 2, … (a later one supersedes)
 *   briefs/<name>.md                           the improvement brief Claude wrote from a `revise` decision
 *   state.json                                 ResearchState
 */
import { mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OwnerDecision, ResearchEntry, ResearchState, Slug, type PHASES } from "./schema";

export class LogStop extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

async function writeOnce(path: string, body: string): Promise<void> {
  const fh = await open(path, "wx", 0o644).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EEXIST") throw new LogStop("LOG_ALREADY_WRITTEN", `${path} exists; records are never overwritten`);
    throw e;
  });
  try {
    await fh.writeFile(body);
  } finally {
    await fh.close();
  }
}

async function parseFile<T>(path: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, code: string): Promise<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new LogStop(code, `${path} is missing or not JSON`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new LogStop(code, `${path} does not match its schema`);
  return r.data;
}

export function logPaths(root: string) {
  return { root, entries: join(root, "entries"), decisions: join(root, "decisions"), briefs: join(root, "briefs"), state: join(root, "state.json") };
}

export async function writeEntry(root: string, raw: unknown): Promise<ResearchEntry> {
  const e = ResearchEntry.safeParse(raw);
  if (!e.success) throw new LogStop("ENTRY_INVALID", e.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const p = logPaths(root);
  await mkdir(p.entries, { recursive: true });
  await writeOnce(join(p.entries, `${e.data.entry_id}.json`), json(e.data));
  return e.data;
}

export async function readEntry(root: string, id: string): Promise<ResearchEntry> {
  if (!Slug.safeParse(id).success) throw new LogStop("ENTRY_ID_INVALID", id);
  return parseFile(join(logPaths(root).entries, `${id}.json`), ResearchEntry, "ENTRY_UNREADABLE");
}

export async function listEntries(root: string): Promise<ResearchEntry[]> {
  const dir = logPaths(root).entries;
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
  return Promise.all(names.map((n) => readEntry(root, n.slice(0, -5))));
}

export async function listDecisions(root: string, entryId?: string): Promise<OwnerDecision[]> {
  const dir = logPaths(root).decisions;
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^[a-z0-9-]+--\d{1,2}\.json$/.test(n));
  const all = await Promise.all(names.map((n) => parseFile(join(dir, n), OwnerDecision, "DECISION_UNREADABLE")));
  for (const [i, d] of all.entries()) {
    if (names[i] !== `${d.entry_id}--${d.seq}.json`) throw new LogStop("DECISION_UNREADABLE", `${names[i]} does not match its entry_id/seq`);
  }
  return all.filter((d) => !entryId || d.entry_id === entryId).sort((a, b) => a.entry_id.localeCompare(b.entry_id) || a.seq - b.seq);
}

/** The decision that stands for an entry: the highest seq. */
export async function currentDecision(root: string, entryId: string): Promise<OwnerDecision | null> {
  const ds = await listDecisions(root, entryId);
  return ds.at(-1) ?? null;
}

/** Appends the next decision for an existing entry. `seq` is assigned here (1 + the last). */
export async function writeDecision(root: string, raw: Omit<OwnerDecision, "seq" | "schema" | "decided_by" | "recorded_by">): Promise<OwnerDecision> {
  await readEntry(root, raw.entry_id); // the entry must exist and parse
  const last = await currentDecision(root, raw.entry_id);
  const d = OwnerDecision.safeParse({ ...raw, schema: "design_research_decision_v1", decided_by: "owner", recorded_by: "claude", seq: (last?.seq ?? 0) + 1 });
  if (!d.success) throw new LogStop("DECISION_INVALID", d.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const p = logPaths(root);
  await mkdir(p.decisions, { recursive: true });
  await writeOnce(join(p.decisions, `${d.data.entry_id}--${d.data.seq}.json`), json(d.data));
  return d.data;
}

export async function readState(root: string): Promise<ResearchState> {
  return parseFile(logPaths(root).state, ResearchState, "STATE_UNREADABLE");
}

export async function writeState(root: string, raw: unknown): Promise<ResearchState> {
  const s = ResearchState.safeParse(raw);
  if (!s.success) throw new LogStop("STATE_INVALID", s.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const p = logPaths(root);
  await mkdir(root, { recursive: true });
  const tmp = `${p.state}.tmp-${process.pid}`;
  await writeFile(tmp, json(s.data), { mode: 0o644 });
  await rename(tmp, p.state);
  return s.data;
}

/** "次の店へ": close the current shop (unless adopted) and move to the first queued one. Pure. */
export function advanceToNextShop(s: ResearchState, now: string): ResearchState {
  const [next, ...rest] = s.shop_queue;
  if (!next) throw new LogStop("QUEUE_EMPTY", "no fictional shop is queued; add one to shop_queue first");
  return {
    ...s,
    current: { shop: next.shop, direction: "d1", entry_id: null, phase: "improving" satisfies (typeof PHASES)[number], brief: null },
    shop_queue: rest,
    next_action: `${next.shop}: read its facts pack and write two or more directions (second-root-design-director), then prepare the generation packet for the owner's approval.`,
    waiting_on_owner: [],
    updated_at: now,
  };
}

/** The resume text a new session reads first: where things stand, the last decision, what to do next. */
export async function resumeSummary(root: string): Promise<string> {
  const s = await readState(root);
  const entries = await listEntries(root);
  const decisions = await listDecisions(root);
  const lines = [`# Design research — resume (${s.updated_at})`, ""];
  if (s.current) {
    lines.push(`- current: shop \`${s.current.shop}\`, direction \`${s.current.direction}\`, phase \`${s.current.phase}\``);
    if (s.current.entry_id) lines.push(`- latest entry: \`${s.current.entry_id}\``);
    if (s.current.brief) lines.push(`- brief: \`${s.current.brief}\``);
  } else lines.push("- current: none");
  lines.push(`- next action: ${s.next_action}`);
  if (s.waiting_on_owner.length) lines.push(`- waiting on the owner: ${s.waiting_on_owner.join(" / ")}`);
  lines.push(`- queued shops: ${s.shop_queue.map((q) => q.shop).join(", ") || "none"}`, "", "## History", "");
  for (const e of entries) {
    const d = decisions.filter((x) => x.entry_id === e.entry_id).at(-1);
    const a = e.audit ? ` · audit ${e.audit.verdict} PC ${e.audit.viewports.desktop_1440.total} / SP ${e.audit.viewports.mobile_390.total}` : "";
    lines.push(`- \`${e.entry_id}\` (${e.shop} ${e.direction} r${e.iteration})${a} · owner: ${d ? `${d.decision} (${d.decided_at.slice(0, 10)})` : "not decided"}`);
    if (d) for (const r of d.reasons.slice(0, 3)) lines.push(`  - ${r}`);
  }
  return `${lines.join("\n")}\n`;
}
