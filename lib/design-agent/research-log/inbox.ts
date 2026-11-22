/**
 * Issue #302 (image generation automation): find delivered IMAGE_FIRST runs in the private review inbox that the research
 * log has not recorded yet, so a new Claude session can pick them up on its own (CLAUDE.md, skill second-root-research-loop).
 *
 * Read-only: lists directory names and checks that the files a later `intake` needs exist. It verifies nothing about the
 * bytes (intake does that) and never writes. The suggested intake arguments come only from the bundle id's own form
 * (`<shop>-imagefirst-<direction>-YYYYMMDD-NN`) and the log's state; the shop must still pass intake's fictional-shop check.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchEntry, ResearchState } from "./schema";

const BUNDLE_ID = /^([a-z0-9][a-z0-9-]{1,40})-imagefirst-(d\d{1,2})-(\d{8})-(\d{2})$/;

export type InboxRun = {
  bundle_id: string;
  previews: boolean;
  audit: boolean;
  /** the autorun's review-ready file (only share: lines), when the run came through the automatic path */
  share: boolean;
  /** what `intake` should be given, or null when the id has an unexpected form */
  suggest: { shop: string; direction: string; iteration: number; parent: string | null } | null;
};

const exists = (p: string) => stat(p).then(() => true, () => false);

/**
 * Runs present in the inbox (previews/<id>/INDEX.json) and absent from the log's entries, oldest id first. Only the oldest
 * carries a suggestion: the next one's parent depends on recording it first (scan again after each intake). Null when the
 * inbox has no previews directory at all (unreadable or absent), so "nothing to do" and "cannot see" are not confused.
 */
export async function unrecordedRuns(inbox: string, entries: readonly ResearchEntry[], state: ResearchState): Promise<InboxRun[] | null> {
  const names = await readdir(join(inbox, "previews")).catch(() => null);
  if (names === null) return null;
  const ids = names.filter((n) => BUNDLE_ID.test(n)).sort();
  const recorded = new Set(entries.map((e) => e.entry_id));
  const out: InboxRun[] = [];
  for (const id of ids) {
    if (recorded.has(id)) continue;
    const m = BUNDLE_ID.exec(id)!;
    const [shop, direction] = [m[1]!, m[2]!];
    // any later run of the shop the research stands on continues the current entry's line (another direction, or a retry
    // of the same one); a run of another shop starts at 0 and intake refuses it until 次の店へ (SHOP_NOT_CURRENT)
    const parent = state.current?.shop === shop && state.current.entry_id ? entries.find((e) => e.entry_id === state.current!.entry_id) : undefined;
    out.push({
      bundle_id: id,
      previews: await exists(join(inbox, "previews", id, "INDEX.json")),
      audit: await exists(join(inbox, "audits", id, "audit.json")),
      share: await exists(join(inbox, "runs", `${id}.share.txt`)),
      suggest: out.length === 0 ? { shop, direction, iteration: parent ? parent.iteration + 1 : 0, parent: parent?.entry_id ?? null } : null,
    });
  }
  return out;
}
