/**
 * Issue #302 (d4 run path): the fixed per-direction allowlist of the IMAGE_FIRST one-shot run path (worker cycle, entry
 * arguments, bundle, review delivery, audit). One row per direction; nothing here is taken from a job file or an
 * argument: a different shop, direction or plan needs a code change and its own review.
 *
 * Each row ties together: the shop, the plan / batch pins (the packet's §3 must show the same numbers), the picture
 * counts, the one packet that approves it (approval-packets.ts), the approval ID form and the plan ID form. The approval
 * ID names its direction (`hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN`), so the ID alone selects the row: a d3 ID can never
 * run, deliver or audit as d4, and the other way round. Data only, plus pure lookups (no I/O).
 *
 * d3's row is exactly the allowlist approved for the owner's d3 pilot (unchanged). d4's row is inert until the owner fills
 * in docs/design/image-first-hoshigama-d4-packet.md §10 and it is merged: the packet reader refuses it until then.
 */
import { D4_PACKET, P3_PACKET, type ApprovalPacketSpec } from "../phase2f-live/approval-packets";

/** Where the packet's §3 pins are read: the row labels and the cell that holds this direction's value. */
export type PinTable = { readonly plan: string; readonly prompt: string; readonly chars: string; readonly cells: number; readonly column: number };

export type ImagefirstRun = {
  readonly shop: "hoshigama";
  readonly shopId: "fictional-bakery-hoshigama";
  readonly direction: RunDirection;
  readonly planSha256: string;
  readonly promptSha256: string;
  readonly promptChars: number;
  readonly images: { readonly pc: number; readonly sp: number };
  readonly packet: ApprovalPacketSpec;
  /** This direction's approval IDs (and no other direction's). */
  readonly approvalId: RegExp;
  /** This direction's plan IDs. */
  readonly planId: RegExp;
  readonly pins: PinTable;
};
export type RunDirection = "d3" | "d4";

export const IMAGEFIRST_RUNS: Readonly<Record<RunDirection, ImagefirstRun>> = {
  // the P3 packet's §3 table `| | d1 | d3 |`: the d3 column
  d3: {
    shop: "hoshigama",
    shopId: "fictional-bakery-hoshigama",
    direction: "d3",
    planSha256: "a19b6896ffd50111df9ad7029f49ded5757999ddfb31943103a206f6a44072a8",
    promptSha256: "291475d9ae66b2308d147a7b56ae1a0c9c53822e44cd5425d60976513712e398",
    promptChars: 12338,
    images: { pc: 2, sp: 4 },
    packet: P3_PACKET,
    approvalId: /^hoshigama-imagefirst-d3-\d{8}-\d{2}$/,
    planId: /^hoshigama-imagefirst-p3-\d{8}$/,
    pins: { plan: "計画 SHA", prompt: "バッチ SHA", chars: "バッチ文字数", cells: 3, column: 2 },
  },
  // the d4 packet's §3 table `| 項目 | d4 |`
  d4: {
    shop: "hoshigama",
    shopId: "fictional-bakery-hoshigama",
    direction: "d4",
    planSha256: "0c3849b2d2e22f65601c7c3515028a999eb1ef39256b2fe08681bd8f771338cd",
    promptSha256: "993d938ab72df308fefef55f84d1fca0b197cb5f913273809dcd7ad464ae7e7e",
    promptChars: 14408,
    images: { pc: 2, sp: 4 },
    packet: D4_PACKET,
    approvalId: /^hoshigama-imagefirst-d4-\d{8}-\d{2}$/,
    planId: /^hoshigama-imagefirst-p4-\d{8}$/,
    pins: { plan: "plan SHA-256", prompt: "バッチ SHA-256", chars: "バッチの文字数", cells: 2, column: 1 },
  },
};
export const RUN_DIRECTIONS = Object.keys(IMAGEFIRST_RUNS) as RunDirection[];

/** Any run's approval ID (the hand-off, the inbox and the transport accept these; each still names one direction). */
export const RUN_APPROVAL_ID_RE = new RegExp(`^hoshigama-imagefirst-(?:${RUN_DIRECTIONS.join("|")})-\\d{8}-\\d{2}$`);

/** The one row whose approval ID form `id` has, or null. At most one row matches (the direction is in the ID). */
export function runOfApprovalId(id: string): ImagefirstRun | null {
  const hits = RUN_DIRECTIONS.map((k) => IMAGEFIRST_RUNS[k]).filter((r) => r.approvalId.test(id));
  return hits.length === 1 ? hits[0]! : null;
}
