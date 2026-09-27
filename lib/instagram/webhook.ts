import { z } from "zod";

// Turns a verified Instagram webhook payload into the message events we
// store (supabase function sales_ig_ingest). Only messages are kept;
// reactions, reads, postbacks and other fields are ignored. Anything that
// does not look like a message to or from our own account is dropped
// (fail closed): nothing here is trusted beyond its shape.

const id = z.string().regex(/^[0-9]{1,32}$/);

const message = z.object({
  mid: z.string().min(1).max(512),
  text: z.string().optional(),
  attachments: z.array(z.object({ type: z.string().max(40) }).loose()).max(20).optional(),
  is_echo: z.boolean().optional(),
  is_deleted: z.boolean().optional(),
}).loose();

const messaging = z.object({
  sender: z.object({ id }).loose(),
  recipient: z.object({ id }).loose(),
  timestamp: z.number().int().positive(),
  message: message.optional(),
}).loose();

export const webhookPayload = z.object({
  object: z.literal("instagram"),
  entry: z
    .array(
      z.object({
        id,
        time: z.number().optional(),
        messaging: z.array(z.unknown()).max(1000).optional(),
      }).loose(),
    )
    .max(1000),
}).loose();

export type IgEvent = {
  account_id: string;
  igsid: string;
  mid: string;
  direction: "inbound" | "outbound";
  text: string | null;
  attachment_types: string[];
  sent_at_ms: number;
  is_deleted: boolean;
};

const MAX_TEXT = 4000;
const ATTACHMENT_TYPE = /^[a-z_]{1,40}$/;

/**
 * Extracts message events. `ownAccountId` (optional) limits them to our own
 * professional account. Returns null when the payload is not an Instagram
 * webhook at all.
 */
export function extractEvents(payload: unknown, ownAccountId?: string): { events: IgEvent[]; ignored: number } | null {
  const parsed = webhookPayload.safeParse(payload);
  if (!parsed.success) return null;
  const events: IgEvent[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  for (const entry of parsed.data.entry) {
    if (ownAccountId && entry.id !== ownAccountId) {
      ignored += entry.messaging?.length ?? 0;
      continue;
    }
    for (const raw of entry.messaging ?? []) {
      const item = messaging.safeParse(raw);
      if (!item.success || !item.data.message) {
        ignored += 1;
        continue;
      }
      const { sender, recipient, timestamp, message: m } = item.data;
      const outbound = m.is_echo === true;
      // A message is always between our account (entry.id) and one person.
      const ours = outbound ? sender.id : recipient.id;
      const other = outbound ? recipient.id : sender.id;
      if (ours !== entry.id || other === entry.id || seen.has(m.mid)) {
        ignored += 1;
        continue;
      }
      seen.add(m.mid);
      events.push({
        account_id: entry.id,
        igsid: other,
        mid: m.mid,
        direction: outbound ? "outbound" : "inbound",
        text: typeof m.text === "string" ? Array.from(m.text).slice(0, MAX_TEXT).join("") : null,
        attachment_types: (m.attachments ?? []).map((a) => a.type).filter((t) => ATTACHMENT_TYPE.test(t)).slice(0, 10),
        sent_at_ms: timestamp,
        is_deleted: m.is_deleted === true,
      });
    }
  }
  return { events, ignored };
}
