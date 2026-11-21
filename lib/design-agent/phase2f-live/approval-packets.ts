/**
 * Issue #302 (d4 run path): which owner approval packet approves which IMAGE_FIRST direction. Data only (no import, no
 * I/O), so the light modules (the bundle, the audit) can read it without the call path.
 *
 * One packet per direction, never another: d1 / d3 are approved only by the P3 packet (unchanged), d4 only by its own
 * packet. A direction missing here has no packet and is refused by the entry. Each packet's §10 has one approval ID row
 * per direction it can approve (`<key> の承認 ID`), and its 承認する方向性 row must be one of `directionSets`.
 */
export type ApprovalPacketSpec = {
  /** The packet, repository-relative (after links are resolved). Nothing under tests/ or elsewhere. */
  readonly path: string;
  /** The directions this packet has an approval ID row for (in the order of its §10). */
  readonly keys: readonly string[];
  /** The 承認する方向性 values it accepts, written exactly (comma-separated, no space). */
  readonly directionSets: readonly string[];
};

/** The P3 packet (d1 / d3): unchanged since the owner's d3 approval. */
export const P3_PACKET: ApprovalPacketSpec = { path: "docs/design/image-first-hoshigama-p3-packet.md", keys: ["d1", "d3"], directionSets: ["d1", "d3", "d1,d3"] };
/** The d4 packet: d4 alone. */
export const D4_PACKET: ApprovalPacketSpec = { path: "docs/design/image-first-hoshigama-d4-packet.md", keys: ["d4"], directionSets: ["d4"] };

/** The one packet each direction is approved by. */
export const PACKET_OF_DIRECTION: Readonly<Record<string, ApprovalPacketSpec>> = { d1: P3_PACKET, d3: P3_PACKET, d4: D4_PACKET };

/** The packet for `key`, or null (no packet: the direction cannot run). Own keys only (never a prototype name). */
export const packetOfDirection = (key: string): ApprovalPacketSpec | null => (Object.prototype.hasOwnProperty.call(PACKET_OF_DIRECTION, key) ? PACKET_OF_DIRECTION[key]! : null);
