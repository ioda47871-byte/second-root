/**
 * Diagnostics of one design-image PoC run (DEV-077): enough to tell apart why
 * a run ended without an image, and nothing that could leak.
 *
 *   (a) Codex never called the image tool and ended with a text answer
 *   (b) the image tool ran but the file went somewhere else (another dir
 *       under generated_images, a nested dir, another extension, the cwd)
 *   (c) the image tool ran but failed (error events, a refusal)
 *   (d) the turn failed or was cut short
 *
 * Only fixed codes, booleans and numbers are recorded: counts of Codex JSON
 * event and item types from a fixed allowlist (anything else is `other`),
 * the codes of error events (classified here, never their text), the number
 * of agent messages and their total length (never the text), timings, the
 * exit code / signal, and file counts by fixed labels. Never the prompt, the
 * answer, a path, a file name, the thread id, the sign-in or any env value.
 */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AnswerTextCode, ImageOutcome, SessionFacts } from "./capability";

/** /2 (DEV-078): adds preflight, session and classification. /3 (DEV-080): session gains history_mode, tool_mode, code_mode_cells, code_mode_imagegen_ref. */
export const DIAGNOSTICS_SCHEMA = "sr-design-image-poc-diagnostics/3";

/** `codex exec --json` event types counted by name (any other: `other`). */
export const EVENT_TYPES = ["thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed", "error"] as const;
/**
 * Item types that are an image-generation tool call. DEV-078: in Codex CLI
 * 0.163.0 `codex exec --json` has NO image item at all (exec_events.rs lists
 * agent_message … error only; event_processor_with_jsonl_output.rs maps every
 * other thread item to None), so these counts stay 0 even when the tool ran:
 * `image_tool=0/0` proves nothing. The CLI's session log decides
 * (capability.ts readSessionFacts: `session` in the diagnostics). The
 * spellings stay counted in case a later CLI emits them.
 */
export const IMAGE_ITEM_TYPES = ["image_generation", "image_generation_call", "image_gen", "imagegen", "generate_image"] as const;
/** Item types counted by name (any other: `other`). */
export const ITEM_TYPES = ["agent_message", "reasoning", "command_execution", "file_change", "mcp_tool_call", "collab_tool_call", "web_search", "todo_list", "error", ...IMAGE_ITEM_TYPES] as const;
/** Fixed codes for an error / turn.failed event or an error item (classified from the CLI's own text, which is never kept). */
export const ERROR_CODES = ["SIGNED_OUT", "QUOTA", "POLICY", "IMAGE_TOOL", "OTHER"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const SIGNED_OUT_SIGN = /\b401\b|unauthori[sz]ed|refresh token|sign in again|not logged in|invalid_grant/i;
const QUOTA_SIGN = /usage limit|rate limit|quota|too many requests|\b429\b/i;
const POLICY_SIGN = /content[ _-]?policy|safety|moderation|policy[ _-]?violation|refus/i;
const IMAGE_SIGN = /image/i;

export function classifyError(text: string): ErrorCode {
  if (SIGNED_OUT_SIGN.test(text)) return "SIGNED_OUT";
  if (QUOTA_SIGN.test(text)) return "QUOTA";
  if (POLICY_SIGN.test(text)) return "POLICY";
  if (IMAGE_SIGN.test(text)) return "IMAGE_TOOL";
  return "OTHER";
}

/** The longest unfinished line kept while reading live stdout; anything longer is dropped (counted as unparsed, `truncated`). */
export const MAX_PARTIAL_LINE_CHARS = 1024 * 1024;

type Counts = Record<string, number>;
const zero = (names: readonly string[]): Counts => Object.fromEntries([...names, "other"].map((n) => [n, 0]));
const bump = (counts: Counts, name: unknown): void => {
  const key = typeof name === "string" && Object.hasOwn(counts, name) && name !== "other" ? name : "other";
  counts[key] = (counts[key] ?? 0) + 1;
};

export interface EventDiagnostics {
  /** Non-empty stdout lines, and those that were not a JSON object. */
  lines: number;
  unparsed_lines: number;
  types: Counts;
  items_started: Counts;
  items_completed: Counts;
  image_tool_started: boolean;
  image_tool_completed: boolean;
  agent_messages: number;
  agent_text_chars: number;
  error_events: number;
  error_items: number;
  turn_failed: boolean;
  /** How the turn ended in the event stream: completed, failed, or no end event at all (cut short). */
  turn: "completed" | "failed" | "none";
  error_codes: ErrorCode[];
  thread_started: boolean;
  /** A line longer than MAX_PARTIAL_LINE_CHARS was dropped (the counts are then lower bounds). */
  truncated: boolean;
}

/**
 * Reads `codex exec --json` stdout as it arrives (or all at once afterwards)
 * and keeps counts only. `live` chunks also time the first event and the
 * first image-tool event.
 */
export class CodexEventTracker {
  private partial = "";
  /** Dropping the rest of an over-long line until its newline. */
  private skipping = false;
  private seen = false;
  private readonly d: EventDiagnostics = {
    lines: 0,
    unparsed_lines: 0,
    types: zero(EVENT_TYPES),
    items_started: zero(ITEM_TYPES),
    items_completed: zero(ITEM_TYPES),
    image_tool_started: false,
    image_tool_completed: false,
    agent_messages: 0,
    agent_text_chars: 0,
    error_events: 0,
    error_items: 0,
    turn_failed: false,
    turn: "none",
    error_codes: [],
    thread_started: false,
    truncated: false,
  };
  firstEventMs: number | null = null;
  firstImageToolMs: number | null = null;

  constructor(
    private readonly startedAt: number,
    private readonly now: () => number,
  ) {}

  /** Whether any stdout was fed live (then the final stdout is not read again). */
  get sawLiveOutput(): boolean {
    return this.seen;
  }

  feed(chunk: string, live = true): void {
    if (live && chunk.length > 0) this.seen = true;
    let rest = chunk;
    if (this.skipping) {
      const nl = rest.indexOf("\n");
      if (nl === -1) return;
      rest = rest.slice(nl + 1);
      this.skipping = false;
    }
    const lines = (this.partial + rest).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) this.line(line, live);
    if (this.partial.length > MAX_PARTIAL_LINE_CHARS) this.dropPartial();
  }

  /** An over-long unfinished line: dropped, counted once as an unparsed line, the rest skipped up to its newline. */
  private dropPartial(): void {
    this.partial = "";
    this.skipping = true;
    this.d.lines += 1;
    this.d.unparsed_lines += 1;
    this.d.truncated = true;
  }

  /** Characters held for an unfinished line (at most MAX_PARTIAL_LINE_CHARS plus one chunk). */
  get bufferedChars(): number {
    return this.partial.length;
  }

  /** The last line without a newline. */
  end(live = true): void {
    if (this.partial !== "") this.line(this.partial, live);
    this.partial = "";
    this.skipping = false;
  }

  private line(raw: string, live: boolean): void {
    const line = raw.trim();
    if (line === "") return;
    this.d.lines += 1;
    let event: { type?: unknown; message?: unknown; error?: { message?: unknown }; item?: { type?: unknown; text?: unknown; message?: unknown } } | null;
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      event = null;
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      this.d.unparsed_lines += 1;
      return;
    }
    if (live && this.firstEventMs === null) this.firstEventMs = this.now() - this.startedAt;
    bump(this.d.types, event.type);
    const item = event.item && typeof event.item === "object" ? event.item : undefined;
    const isImage = typeof item?.type === "string" && (IMAGE_ITEM_TYPES as readonly string[]).includes(item.type);
    if (event.type === "thread.started") this.d.thread_started = true;
    if (event.type === "item.started" && item) {
      bump(this.d.items_started, item.type);
      if (isImage) this.d.image_tool_started = true;
    }
    if (event.type === "item.completed" && item) {
      bump(this.d.items_completed, item.type);
      if (isImage) this.d.image_tool_completed = true;
      if (item.type === "agent_message") {
        this.d.agent_messages += 1;
        if (typeof item.text === "string") this.d.agent_text_chars += item.text.length;
      }
      if (item.type === "error") {
        this.d.error_items += 1;
        this.code(String(item.message ?? ""));
      }
    }
    if (isImage && live && this.firstImageToolMs === null) this.firstImageToolMs = this.now() - this.startedAt;
    if (event.type === "error") {
      this.d.error_events += 1;
      this.code(`${String(event.message ?? "")} ${String(event.error?.message ?? "")}`);
    }
    if (event.type === "turn.failed") {
      this.d.turn_failed = true;
      this.d.turn = "failed";
      this.code(`${String(event.message ?? "")} ${String(event.error?.message ?? "")}`);
    }
    if (event.type === "turn.completed" && this.d.turn !== "failed") this.d.turn = "completed";
  }

  private code(text: string): void {
    const c = classifyError(text);
    if (!this.d.error_codes.includes(c)) this.d.error_codes.push(c);
  }

  result(): EventDiagnostics {
    return {
      ...this.d,
      types: { ...this.d.types },
      items_started: { ...this.d.items_started },
      items_completed: { ...this.d.items_completed },
      error_codes: ERROR_CODES.filter((c) => this.d.error_codes.includes(c)),
    };
  }
}

/** Extension classes (the name itself is never kept). */
export type ExtCounts = { png: number; jpg: number; webp: number; gif: number; other: number };
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const extOf = (name: string): keyof ExtCounts => {
  const n = name.toLowerCase();
  if (n.endsWith(".png")) return "png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "jpg";
  if (n.endsWith(".webp")) return "webp";
  if (n.endsWith(".gif")) return "gif";
  return "other";
};
const noExt = (): ExtCounts => ({ png: 0, jpg: 0, webp: 0, gif: 0, other: 0 });

/** At most this many entries are looked at per walk (a huge CODEX_HOME cannot stall the exit). */
const WALK_LIMIT = 20_000;

interface Walk {
  files: number;
  dirs: number;
  links: number;
  ext: ExtCounts;
  /** Image-like regular files (png / jpg / jpeg / webp / gif) modified at or after `since`. */
  newImages: number;
  truncated: boolean;
}

/** Counts below `dir` without following links (lstat only); `skip` names top-level entries to leave out. */
async function walk(dir: string, opts: { depth: number; since?: number; skip?: ReadonlySet<string> } = { depth: 4 }): Promise<Walk> {
  const out: Walk = { files: 0, dirs: 0, links: 0, ext: noExt(), newImages: 0, truncated: false };
  let seen = 0;
  const go = async (path: string, depth: number, top: boolean): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(path);
    } catch {
      return;
    }
    for (const name of names) {
      if (top && opts.skip?.has(name)) continue;
      if (++seen > WALK_LIMIT) {
        out.truncated = true;
        return;
      }
      const child = join(path, name);
      const info = await lstat(child).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) out.links += 1;
      else if (info.isDirectory()) {
        out.dirs += 1;
        if (depth > 0) await go(child, depth - 1, false);
      } else if (info.isFile()) {
        out.files += 1;
        out.ext[extOf(name)] += 1;
        if (opts.since !== undefined && IMAGE_EXT.test(name) && info.mtimeMs >= opts.since) out.newImages += 1;
      }
    }
  };
  await go(dir, opts.depth, true);
  return out;
}

/** All entry names of CODEX_HOME/generated_images (for "new dirs not named after this thread"); undefined when unreadable, empty when absent. */
export async function generatedImageEntries(codexHome: string): Promise<Set<string> | undefined> {
  try {
    return new Set(await readdir(join(codexHome, "generated_images")));
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? new Set() : undefined;
  }
}

export interface ImageLocationDiagnostics {
  generated_images_exists: boolean;
  thread_dir_exists: boolean;
  /** Regular files in the thread's dir (and below it, a few levels), by extension class; links and sub-dirs counted apart. */
  thread_files: number;
  thread_ext: ExtCounts;
  thread_subdirs: number;
  thread_links: number;
  /** Entries of generated_images that appeared during this run and are not this thread's (null: no start snapshot). */
  new_other_dirs: number | null;
  new_other_files: number | null;
  new_other_ext: ExtCounts | null;
  /** Image-like files under this run's work dir (cwd) before cleanup. */
  cwd_image_files: number;
  /** Image-like files modified during this run anywhere else in CODEX_HOME (not generated_images). */
  codex_home_new_images_elsewhere: number;
  /** A walk hit its entry limit (the counts are then lower bounds). */
  truncated: boolean;
}

/**
 * Where image files are, right before cleanup removes anything. Never
 * returns a name or a path; never follows a link.
 */
export async function snapshotImageLocations(o: {
  codexHome: string;
  threadId?: string;
  before?: ReadonlySet<string>;
  cwd?: string;
  sinceMs: number;
}): Promise<ImageLocationDiagnostics> {
  const images = join(o.codexHome, "generated_images");
  const gi = await lstat(images).catch(() => null);
  const giExists = !!gi && gi.isDirectory() && !gi.isSymbolicLink();
  let thread: Walk | null = null;
  if (giExists && o.threadId) {
    const t = await lstat(join(images, o.threadId)).catch(() => null);
    if (t && t.isDirectory() && !t.isSymbolicLink()) thread = await walk(join(images, o.threadId), { depth: 3 });
  }
  let newOther: { dirs: number; files: number; ext: ExtCounts; truncated: boolean } | null = null;
  if (o.before) {
    newOther = { dirs: 0, files: 0, ext: noExt(), truncated: false };
    const now = giExists ? await readdir(images).catch(() => [] as string[]) : [];
    for (const name of now) {
      if (o.before.has(name) || name === o.threadId) continue;
      const info = await lstat(join(images, name)).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        newOther.dirs += 1;
        const w = await walk(join(images, name), { depth: 3 });
        newOther.files += w.files;
        for (const k of Object.keys(w.ext) as Array<keyof ExtCounts>) newOther.ext[k] += w.ext[k];
        newOther.truncated ||= w.truncated;
      } else if (info.isFile()) {
        newOther.files += 1;
        newOther.ext[extOf(name)] += 1;
      }
    }
  }
  const cwd = o.cwd ? await walk(o.cwd, { depth: 6, since: 0 }) : null;
  const elsewhere = await walk(o.codexHome, { depth: 8, since: o.sinceMs, skip: new Set(["generated_images"]) });
  return {
    generated_images_exists: giExists,
    thread_dir_exists: thread !== null,
    thread_files: thread?.files ?? 0,
    thread_ext: thread?.ext ?? noExt(),
    thread_subdirs: thread?.dirs ?? 0,
    thread_links: thread?.links ?? 0,
    new_other_dirs: newOther?.dirs ?? null,
    new_other_files: newOther?.files ?? null,
    new_other_ext: newOther?.ext ?? null,
    cwd_image_files: cwd?.newImages ?? 0,
    codex_home_new_images_elsewhere: elsewhere.newImages,
    truncated: !!(thread?.truncated || newOther?.truncated || cwd?.truncated || elsewhere.truncated),
  };
}

export interface PocDiagnostics {
  schema: typeof DIAGNOSTICS_SCHEMA;
  outcome: "done" | "stopped";
  /** The stop code (null when an image was accepted). */
  stop_code: string | null;
  direction_version: string | null;
  prompt_chars: number | null;
  worker_commit: string | null;
  codex: {
    invoked: boolean;
    exit_code: number | null;
    signal: string | null;
    timed_out: boolean;
    thread_id_present: boolean;
  };
  timings_ms: {
    total: number;
    codex: number | null;
    first_event: number | null;
    first_image_tool_event: number | null;
  };
  events: EventDiagnostics | null;
  images: ImageLocationDiagnostics | null;
  /** DEV-078 preflight, before the model call (null: not reached). */
  preflight: { cli_version: string | null; dotenv_present: boolean } | null;
  /** DEV-078: the CLI's own session log of this thread, read in memory (fixed facts only; null: no call made). */
  session: SessionFacts | null;
  classification: {
    image_outcome: ImageOutcome | null;
    /** The model's final answer as a fixed code (informational; the text is never kept). */
    answer_text: AnswerTextCode | null;
    /** pocStopClass of the stop code (null on success). */
    stop_class: string | null;
  };
}

const n = (v: number | null | undefined): string => (v === null || v === undefined ? "-" : String(v));
const b = (v: boolean): string => (v ? "1" : "0");

/** One line of fixed codes and numbers (POC_DIAG_SUMMARY). */
export function diagnosticsSummary(d: PocDiagnostics): string {
  const e = d.events;
  const i = d.images;
  const threadImages = i ? i.thread_ext.png + i.thread_ext.jpg + i.thread_ext.webp + i.thread_ext.gif : null;
  const parts = [
    `code=${d.stop_code ?? "IMAGE_READY"}`,
    `dir=${d.direction_version ?? "-"}`,
    `prompt_chars=${n(d.prompt_chars)}`,
    `codex=${b(d.codex.invoked)}`,
    `exit=${d.codex.signal ?? n(d.codex.exit_code)}`,
    `thread=${b(d.codex.thread_id_present)}`,
    `image_tool=${e ? `${b(e.image_tool_started)}/${b(e.image_tool_completed)}` : "-"}`,
    `agent_msgs=${n(e?.agent_messages)}`,
    `agent_chars=${n(e?.agent_text_chars)}`,
    `reasoning=${n(e?.items_completed.reasoning)}`,
    `cmds=${n(e?.items_completed.command_execution)}`,
    `other_items=${n(e ? e.items_started.other + e.items_completed.other : null)}`,
    `errors=${n(e ? e.error_events + e.error_items : null)}`,
    `error_codes=${e && e.error_codes.length > 0 ? e.error_codes.join(",") : "-"}`,
    `turn=${e?.turn ?? "-"}`,
    `gen_dir=${i ? b(i.generated_images_exists) : "-"}`,
    `thread_dir=${i ? b(i.thread_dir_exists) : "-"}`,
    `images_thread=${n(threadImages)}`,
    `thread_png=${n(i?.thread_ext.png)}`,
    `thread_other=${n(i ? i.thread_ext.other + i.thread_subdirs : null)}`,
    `images_other=${n(i?.new_other_files)}`,
    `other_dirs=${n(i?.new_other_dirs)}`,
    `cwd_images=${n(i?.cwd_image_files)}`,
    `home_images=${n(i?.codex_home_new_images_elsewhere)}`,
    `unparsed=${n(e?.unparsed_lines)}`,
    `trunc=${b(!!(e?.truncated || i?.truncated))}`,
    `cli=${d.preflight?.cli_version ?? d.session?.cli_version ?? "-"}`,
    `dotenv=${d.preflight ? b(d.preflight.dotenv_present) : "-"}`,
    `model=${d.session?.model ?? "-"}`,
    `provider_openai=${typeof d.session?.model_provider_openai === "boolean" ? b(d.session.model_provider_openai) : "-"}`,
    `log=${d.session ? b(d.session.log_found) : "-"}`,
    `hist=${d.session?.history_mode ?? "-"}`,
    `tool_mode=${d.session?.tool_mode ?? "-"}`,
    `cm_cells=${n(d.session?.code_mode_cells)}`,
    `cm_ref=${d.session ? b(d.session.code_mode_imagegen_ref) : "-"}`,
    `img_calls=${n(d.session?.image_tool_calls)}`,
    `img_ok=${n(d.session?.image_tool_completed)}`,
    `img_failed=${n(d.session?.image_tool_failed)}`,
    `img_fail=${d.session && d.session.image_failure_codes.length > 0 ? d.session.image_failure_codes.join(",") : "-"}`,
    `other_calls=${n(d.session?.other_tool_calls)}`,
    `outcome=${d.classification.image_outcome ?? "-"}`,
    `answer=${d.classification.answer_text ?? "-"}`,
    `class=${d.classification.stop_class ?? "-"}`,
    `ms=${n(d.timings_ms.total)}`,
    `codex_ms=${n(d.timings_ms.codex)}`,
    `first_event_ms=${n(d.timings_ms.first_event)}`,
    `image_tool_ms=${n(d.timings_ms.first_image_tool_event)}`,
  ];
  return parts.join(" ");
}
