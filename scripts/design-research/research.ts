/**
 * Issue #302 P5: the design research loop's one entry point (lib/design-agent/research-log/; docs/operations/design-research-loop.md).
 * Claude runs it when the owner says "改善して" / "成功例として保存" / "次の店へ" in the Claude app (.claude/skills/second-root-research-loop/).
 *
 *   node --import tsx scripts/design-research/research.ts status
 *   node --import tsx scripts/design-research/research.ts intake <bundle id> --shop <s> --direction <d> --iteration <n> [--parent <entry id>]
 *   node --import tsx scripts/design-research/research.ts review-page <entry id> --out <dir> [--notes <notes.json>]
 *   node --import tsx scripts/design-research/research.ts decide <entry id> --decision adopt|revise|reject --words <owner's words>
 *        --reason <r>… [--keep <k>…] [--improve <i>…] [--brief briefs/<name>.md] [--next <next action>]
 *   node --import tsx scripts/design-research/research.ts queue-add <shop> --note <why>
 *   node --import tsx scripts/design-research/research.ts next-shop
 *
 * Offline and local only: reads the private review inbox (~/sr-runs/review-inbox, read-only) and writes the committed log
 * (design-library/research-log/) or the review page's folder. It never generates an image, never starts a model, and never
 * issues, claims or spends an approval ID. Exit 0 done, 2 refused (a code on stderr, nothing written).
 */
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { entryFromInbox } from "../../lib/design-agent/research-log/intake";
import { ReviewNotes, reviewPage } from "../../lib/design-agent/research-log/review-page";
import { DECISIONS, ResearchState } from "../../lib/design-agent/research-log/schema";
import { assertFictionalShop } from "../../lib/design-agent/research-log/shops";
import { advanceToNextShop, currentDecision, LogStop, readEntry, readState, resumeSummary, writeDecision, writeEntry, writeState } from "../../lib/design-agent/research-log/store";

const REPO = resolve(__dirname, "../..");
const LOG = process.env.SR_RESEARCH_LOG_ROOT ?? join(REPO, "design-library/research-log");
const INBOX = process.env.SR_REVIEW_INBOX ?? join(homedir(), "sr-runs/review-inbox");
const now = () => new Date().toISOString();

function refuse(code: string, msg: string): never {
  throw new LogStop(code, msg);
}

/** The next state, validated before any write-once record so a bad value never strands one (coded refusal, no trace). */
function checkedState(raw: unknown): ResearchState {
  const r = ResearchState.safeParse(raw);
  if (!r.success) refuse("STATE_INVALID", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

/**
 * The review page's folder: only under the temp directory (Claude's scratchpad) or ~/sr-runs/review-pages, resolved through
 * symlinks, never a symlink itself (nor its img/), so private previews cannot land in a checkout or anywhere else.
 */
async function reviewOutDir(raw: string): Promise<string> {
  const roots = await Promise.all([realpath(tmpdir()), realpath(join(homedir(), "sr-runs")).then((r) => join(r, "review-pages")).catch(() => null)]);
  const out = resolve(raw);
  // Decide where `out` really is before creating anything: resolve its deepest existing ancestor through symlinks.
  let probe = out;
  while (!(await lstat(probe).then(() => true, () => false))) probe = dirname(probe);
  const intended = join(await realpath(probe), relative(probe, out));
  const inside = (p: string) => roots.some((r) => r && p.startsWith(`${r}/`));
  if (!inside(intended)) refuse("OUT_UNSAFE", `${intended} is not inside ${roots.filter(Boolean).join(" or ")}`);
  const isLink = (p: string) => lstat(p).then((st) => st.isSymbolicLink(), () => false);
  for (const p of [out, join(out, "img")]) if (await isLink(p)) refuse("OUT_UNSAFE", `${p} is a symlink`); // before anything is created
  await mkdir(join(intended, "img"), { recursive: true, mode: 0o700 });
  for (const p of [out, join(out, "img")]) if (await isLink(p)) refuse("OUT_UNSAFE", `${p} is a symlink`);
  if ((await realpath(join(out, "img"))) !== join(intended, "img")) refuse("OUT_UNSAFE", `${out}/img resolves elsewhere`);
  return intended;
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const { values: v, positionals: pos } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      shop: { type: "string" },
      direction: { type: "string" },
      iteration: { type: "string" },
      parent: { type: "string" },
      out: { type: "string" },
      notes: { type: "string" },
      decision: { type: "string" },
      words: { type: "string" },
      reason: { type: "string", multiple: true },
      keep: { type: "string", multiple: true },
      improve: { type: "string", multiple: true },
      brief: { type: "string" },
      next: { type: "string" },
      note: { type: "string" },
      "force-close": { type: "boolean" },
    },
  });

  switch (cmd) {
    case "status":
      process.stdout.write(await resumeSummary(LOG));
      return;

    case "intake": {
      const id = pos[0] ?? refuse("USAGE", "intake <bundle id>");
      if (!v.shop || !v.direction || v.iteration === undefined) refuse("USAGE", "--shop, --direction and --iteration are required");
      const e = await entryFromInbox({ repo: REPO, inbox: INBOX, bundleId: id, shop: v.shop, direction: v.direction, iteration: Number(v.iteration), parentEntryId: v.parent ?? null, now: now() });
      const s = await readState(LOG);
      if (s.current && s.current.shop !== e.shop) refuse("SHOP_NOT_CURRENT", `the current shop is ${s.current.shop}; say 次の店へ first`);
      if (e.parent_entry_id) {
        const parent = await readEntry(LOG, e.parent_entry_id);
        if (parent.shop !== e.shop || e.iteration !== parent.iteration + 1) refuse("PARENT_MISMATCH", `--parent must be a ${e.shop} entry with iteration ${e.iteration - 1}`);
      } else if (e.iteration !== 0) refuse("PARENT_MISMATCH", "an improved version (iteration > 0) needs --parent");
      const nextState = checkedState({
        ...s,
        current: { shop: e.shop, direction: e.direction, entry_id: e.entry_id, phase: "awaiting_owner_review", brief: s.current?.shop === e.shop ? s.current.brief : null },
        next_action: `Publish the review page of ${e.entry_id} and wait for the owner's decision.`,
        waiting_on_owner: [`decide on ${e.entry_id} (改善して / 成功例として保存 / 不採用)`],
        updated_at: now(),
      } satisfies ResearchState); // validated before the write-once entry
      await writeEntry(LOG, e);
      await writeState(LOG, nextState);
      process.stdout.write(`${JSON.stringify({ status: "recorded", entry_id: e.entry_id, previews: e.provenance.previews.length, audit: e.audit?.verdict ?? null })}\n`);
      return;
    }

    case "review-page": {
      const id = pos[0] ?? refuse("USAGE", "review-page <entry id> --out <dir>");
      if (!v.out) refuse("USAGE", "--out <dir> is required");
      const e = await readEntry(LOG, id);
      let notes: ReviewNotes | null = null;
      if (v.notes) {
        const r = ReviewNotes.safeParse(await readFile(v.notes, "utf8").then((t) => JSON.parse(t) as unknown).catch(() => null));
        if (!r.success) refuse("NOTES_INVALID", `${v.notes} is not {"keep":[…],"weak":[…],"next":[…]}`);
        notes = r.data;
      }
      const { html, files } = reviewPage(e, notes, await currentDecision(LOG, id));
      const out = await reviewOutDir(v.out);
      for (const f of files) {
        const src = join(INBOX, "previews", id, f);
        const want = e.provenance.previews.find((p) => p.file === f)!.preview_sha256;
        const bytes = await readFile(src);
        if (createHash("sha256").update(bytes).digest("hex") !== want) refuse("PREVIEW_CHANGED", `${src} no longer matches the recorded SHA-256`);
        const dest = join(out, "img", f);
        if (await lstat(dest).then((st) => !st.isFile(), () => false)) refuse("OUT_UNSAFE", `${dest} exists and is not a plain file`);
        await writeFile(dest, bytes, { mode: 0o600 }); // the bytes that were checked, not a second read
      }
      const page = join(out, "index.html");
      if (await lstat(page).then((st) => !st.isFile(), () => false)) refuse("OUT_UNSAFE", `${page} exists and is not a plain file`);
      await writeFile(page, html, { mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ status: "written", page: join(out, "index.html"), images: files.map((f) => `img/${f}`) })}\n`);
      return;
    }

    case "decide": {
      const id = pos[0] ?? refuse("USAGE", "decide <entry id>");
      const decision = DECISIONS.find((d) => d === v.decision) ?? refuse("USAGE", `--decision must be one of ${DECISIONS.join(", ")}`);
      if (!v.words || !v.reason?.length) refuse("USAGE", "--words and at least one --reason are required");
      const e = await readEntry(LOG, id);
      const s = await readState(LOG);
      // Only the entry the research stands on: never move `current` to another shop or back to an older run.
      if (s.current?.shop !== e.shop) refuse("SHOP_NOT_CURRENT", `${id} is ${e.shop}; the current shop is ${s.current?.shop ?? "none"}`);
      if (s.current.entry_id !== id) refuse("ENTRY_NOT_CURRENT", `${id} is not the current entry (${s.current.entry_id ?? "none"})`);
      if (v.brief && !(await stat(join(LOG, v.brief)).then((st) => st.isFile(), () => false))) refuse("BRIEF_MISSING", `${v.brief} does not exist under the log`);
      const phase = decision === "adopt" ? "adopted" : decision === "revise" ? "improving" : "closed";
      const next =
        v.next ??
        {
          adopt: "The shop's design is adopted. Say 次の店へ to move to the next fictional shop.",
          revise: `Write the improved direction for ${e.shop} from decision ${id} (keep / improve), update the prompt and packet, and ask the owner to approve one generation.`,
          reject: `${e.shop} ${e.direction} was rejected. Write new directions for ${e.shop} that avoid the reasons, or say 次の店へ.`,
        }[decision];
      const nextState = checkedState({
        ...s,
        current: { shop: e.shop, direction: e.direction, entry_id: id, phase, brief: v.brief ?? s.current.brief },
        next_action: next,
        waiting_on_owner: s.waiting_on_owner.filter((w) => !w.includes(id)),
        updated_at: now(),
      } satisfies ResearchState); // validated before the write-once decision, so a bad state never strands a record
      const d = await writeDecision(LOG, { entry_id: id, decision, owner_words: v.words, reasons: v.reason, keep: v.keep ?? [], improve: v.improve ?? [], decided_at: now() });
      await writeState(LOG, nextState);
      process.stdout.write(`${JSON.stringify({ status: "recorded", entry_id: id, seq: d.seq, decision, phase })}\n`);
      return;
    }

    case "queue-add": {
      const shop = pos[0] ?? refuse("USAGE", "queue-add <shop> --note <why>");
      if (!v.note) refuse("USAGE", "--note is required");
      await assertFictionalShop(REPO, shop);
      const s = await readState(LOG);
      if (s.shop_queue.some((q) => q.shop === shop) || s.current?.shop === shop) refuse("QUEUE_DUPLICATE", shop);
      await writeState(LOG, { ...s, shop_queue: [...s.shop_queue, { shop, note: v.note }], updated_at: now() });
      process.stdout.write(`${JSON.stringify({ status: "queued", shop })}\n`);
      return;
    }

    case "next-shop": {
      const s = await writeState(LOG, advanceToNextShop(await readState(LOG), now(), { force: v["force-close"] === true }));
      process.stdout.write(`${JSON.stringify({ status: "moved", shop: s.current?.shop ?? null })}\n`);
      return;
    }

    default:
      refuse("USAGE", "status | intake | review-page | decide | queue-add | next-shop");
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof LogStop) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  throw err;
});
