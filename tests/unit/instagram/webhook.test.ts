import { describe, expect, it } from "vitest";
import { extractEvents } from "@/lib/instagram/webhook";

const OURS = "17841400000000001";
const THEM = "900000000000002";

const msg = (message: Record<string, unknown>, from = THEM, to = OURS, timestamp = 1790000000000) => ({
  sender: { id: from },
  recipient: { id: to },
  timestamp,
  message,
});
const payload = (messaging: unknown[], entryId = OURS) => ({ object: "instagram", entry: [{ id: entryId, time: 1790000000000, messaging }] });

describe("extractEvents", () => {
  it("keeps an inbound text message", () => {
    const r = extractEvents(payload([msg({ mid: "m1", text: "こんにちは" })]), OURS)!;
    expect(r.events).toEqual([
      { account_id: OURS, igsid: THEM, mid: "m1", direction: "inbound", text: "こんにちは", attachment_types: [], sent_at_ms: 1790000000000, is_deleted: false },
    ]);
  });

  it("treats echoes of our own messages as outbound in the same thread", () => {
    const r = extractEvents(payload([msg({ mid: "m2", text: "ご返信ありがとうございます", is_echo: true }, OURS, THEM)]), OURS)!;
    expect(r.events[0]).toMatchObject({ igsid: THEM, direction: "outbound" });
  });

  it("keeps attachment types only, never their URLs", () => {
    const r = extractEvents(payload([msg({ mid: "m3", attachments: [{ type: "image", payload: { url: "https://lookaside.example/x" } }] })]), OURS)!;
    expect(r.events[0]).toMatchObject({ text: null, attachment_types: ["image"] });
    expect(JSON.stringify(r.events)).not.toContain("https://");
  });

  it("passes unsent (deleted) messages through as deletions", () => {
    const r = extractEvents(payload([msg({ mid: "m4", is_deleted: true })]), OURS)!;
    expect(r.events[0]).toMatchObject({ mid: "m4", is_deleted: true });
  });

  it("ignores non-message events and malformed items", () => {
    const r = extractEvents(
      payload([
        { sender: { id: THEM }, recipient: { id: OURS }, timestamp: 1, read: { mid: "m1" } },
        { sender: { id: THEM }, recipient: { id: OURS }, timestamp: 1, reaction: { mid: "m1", reaction: "love" } },
        { sender: { id: "not-a-number" }, recipient: { id: OURS }, timestamp: 1, message: { mid: "m5", text: "x" } },
        "garbage",
      ]),
      OURS,
    )!;
    expect(r.events).toEqual([]);
    expect(r.ignored).toBe(4);
  });

  it("ignores messages not between our account and one other person", () => {
    const r = extractEvents(
      payload([
        msg({ mid: "m6", text: "x" }, THEM, "123"), // not addressed to us
        msg({ mid: "m7", text: "x", is_echo: true }, THEM, OURS), // echo not from us
        msg({ mid: "m8", text: "x" }, OURS, OURS), // to ourselves
      ]),
      OURS,
    )!;
    expect(r.events).toEqual([]);
    expect(r.ignored).toBe(3);
  });

  it("ignores entries for another account when our account id is configured", () => {
    const r = extractEvents(payload([msg({ mid: "m9", text: "x" }, THEM, "555")], "555"), OURS)!;
    expect(r.events).toEqual([]);
    expect(r.ignored).toBe(1);
  });

  it("drops duplicates within one delivery and truncates very long text", () => {
    const long = "あ".repeat(5000);
    const r = extractEvents(payload([msg({ mid: "m10", text: long }), msg({ mid: "m10", text: long })]), OURS)!;
    expect(r.events).toHaveLength(1);
    expect([...r.events[0].text!].length).toBe(4000);
  });

  it("returns null for anything that is not an Instagram webhook", () => {
    expect(extractEvents({ object: "page", entry: [] })).toBeNull();
    expect(extractEvents(null)).toBeNull();
    expect(extractEvents({ object: "instagram", entry: [{ id: "abc" }] })).toBeNull();
  });
});
