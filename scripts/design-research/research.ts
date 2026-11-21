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
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { entryFromInbox } from "../../lib/design-agent/research-log/intake";
import { ReviewNotes, reviewPage } from "../../lib/design-agent/research-log/review-page";
import { DECISIONS, type ResearchState } from "../../lib/design-agent/research-log/schema";
import { advanceToNextShop, currentDecision, LogStop, readEntry, readState, resumeSummary, writeDecision, writeEntry, writeState } from "../../lib/design-agent/research-log/store";

const REPO = resolve(__dirname, "../..");
const LOG = process.env.SR_RESEARCH_LOG_ROOT ?? join(REPO, "design-library/research-log");
const INBOX = process.env.SR_REVIEW_INBOX ?? join(homedir(), "sr-runs/review-inbox");
const now = () => new Date().toISOString();

function refuse(code: string, msg: string): never {
  throw new LogStop(code, msg);
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
    },
  });

  switch (cmd) {
    case "status":
      process.stdout.write(await resumeSummary(LOG));
      return;

    case "intake": {
      const id = pos[0] ?? refuse("USAGE", "intake <bundle id>");
      if (!v.shop || !v.direction || v.iteration === undefined) refuse("USAGE", "--shop, --direction and --iteration are required");
      const e = await entryFromInbox({ inbox: INBOX, bundleId: id, shop: v.shop, direction: v.direction, iteration: Number(v.iteration), parentEntryId: v.parent ?? null, now: now() });
      await writeEntry(LOG, e);
      const s = await readState(LOG);
      await writeState(LOG, {
        ...s,
        current: { shop: e.shop, direction: e.direction, entry_id: e.entry_id, phase: "awaiting_owner_review", brief: s.current?.shop === e.shop ? s.current.brief : null },
        next_action: `Publish the review page of ${e.entry_id} and wait for the owner's decision.`,
        waiting_on_owner: [`decide on ${e.entry_id} (改善して / 成功例として保存 / 不採用)`],
        updated_at: now(),
      } satisfies ResearchState);
      process.stdout.write(`${JSON.stringify({ status: "recorded", entry_id: e.entry_id, previews: e.provenance.previews.length, audit: e.audit?.verdict ?? null })}\n`);
      return;
    }

    case "review-page": {
      const id = pos[0] ?? refuse("USAGE", "review-page <entry id> --out <dir>");
      if (!v.out) refuse("USAGE", "--out <dir> is required");
      const e = await readEntry(LOG, id);
      const notes = v.notes ? ReviewNotes.parse(JSON.parse(await readFile(v.notes, "utf8"))) : null;
      const { html, files } = reviewPage(e, notes, await currentDecision(LOG, id));
      const out = resolve(v.out);
      if (out === REPO || out.startsWith(`${REPO}/`)) refuse("OUT_IN_REPO", "the review page holds private images; write it outside the repository");
      await mkdir(join(out, "img"), { recursive: true, mode: 0o700 });
      for (const f of files) {
        const src = join(INBOX, "previews", id, f);
        const want = e.provenance.previews.find((p) => p.file === f)!.preview_sha256;
        if (createHash("sha256").update(await readFile(src)).digest("hex") !== want) refuse("PREVIEW_CHANGED", `${src} no longer matches the recorded SHA-256`);
        await copyFile(src, join(out, "img", f));
      }
      await writeFile(join(out, "index.html"), html, { mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ status: "written", page: join(out, "index.html"), images: files.map((f) => `img/${f}`) })}\n`);
      return;
    }

    case "decide": {
      const id = pos[0] ?? refuse("USAGE", "decide <entry id>");
      const decision = DECISIONS.find((d) => d === v.decision) ?? refuse("USAGE", `--decision must be one of ${DECISIONS.join(", ")}`);
      if (!v.words || !v.reason?.length) refuse("USAGE", "--words and at least one --reason are required");
      const d = await writeDecision(LOG, { entry_id: id, decision, owner_words: v.words, reasons: v.reason, keep: v.keep ?? [], improve: v.improve ?? [], decided_at: now() });
      const e = await readEntry(LOG, id);
      const s = await readState(LOG);
      const phase = decision === "adopt" ? "adopted" : "improving";
      const next =
        v.next ??
        (decision === "adopt"
          ? "The shop's design is adopted. Say 次の店へ to move to the next fictional shop."
          : `Write the improved direction for ${e.shop} from decision ${id}--${d.seq} (keep / improve), update the prompt and packet, and ask the owner to approve one generation.`);
      await writeState(LOG, {
        ...s,
        current: { shop: e.shop, direction: e.direction, entry_id: id, phase, brief: v.brief ?? s.current?.brief ?? null },
        next_action: next,
        waiting_on_owner: decision === "adopt" ? [] : s.waiting_on_owner.filter((w) => !w.includes(id)),
        updated_at: now(),
      } satisfies ResearchState);
      process.stdout.write(`${JSON.stringify({ status: "recorded", entry_id: id, seq: d.seq, decision, phase })}\n`);
      return;
    }

    case "queue-add": {
      const shop = pos[0] ?? refuse("USAGE", "queue-add <shop> --note <why>");
      if (!v.note) refuse("USAGE", "--note is required");
      const s = await readState(LOG);
      if (s.shop_queue.some((q) => q.shop === shop) || s.current?.shop === shop) refuse("QUEUE_DUPLICATE", shop);
      await writeState(LOG, { ...s, shop_queue: [...s.shop_queue, { shop, note: v.note }], updated_at: now() });
      process.stdout.write(`${JSON.stringify({ status: "queued", shop })}\n`);
      return;
    }

    case "next-shop": {
      const s = await writeState(LOG, advanceToNextShop(await readState(LOG), now()));
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
