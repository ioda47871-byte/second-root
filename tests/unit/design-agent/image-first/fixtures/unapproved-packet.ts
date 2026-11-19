import { resolve } from "node:path";

/**
 * Issue #293 P3: a test-only, immutable copy of the approval packet as drafted (header 「**状態: 未承認。**」, §10 未記入),
 * byte for byte the version of docs/design/image-first-hoshigama-p3-packet.md that was on develop when it was copied.
 * Tests that need an unapproved packet, or that fill one in, use this copy (filled only in memory / a temporary
 * directory), so the real packet can be filled by the owner without turning CI red. Never fill this file in place and
 * never commit an approved packet anywhere in the repository. The SHA-256 below is asserted by the tests.
 */
export const UNAPPROVED_PACKET_FIXTURE = resolve(__dirname, "image-first-packet-unapproved.md");
export const UNAPPROVED_PACKET_FIXTURE_SHA256 = "d26a807fe197411a82750d1908e93f2e56d9e5022dd1653e1ff5d2765672622e";
