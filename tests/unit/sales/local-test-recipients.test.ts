import { describe, expect, it } from "vitest";
import { loopbackDbUrl } from "@/tests/support/local-test-recipients";

// PR #270 review L2 (folded into DEV-263h): the local test switches are set only on a loopback database — the host
// node-postgres would really connect to, read with pg's own parser.

describe("loopbackDbUrl", () => {
  it("accepts localhost, 127.0.0.0/8 and [::1]", () => {
    for (const u of ["postgresql://postgres:postgres@127.0.0.1:54322/postgres", "postgresql://p@127.8.9.10:5432/db", "postgres://p@localhost/db", "postgresql://p@[::1]:5432/db"])
      expect(loopbackDbUrl(u), u).toBe(u);
  });

  it("refuses a hosted host, a ?host= / ?hostaddr= override, a socket path and anything else", () => {
    for (const u of [
      "postgresql://p@db.example.com:5432/db",
      "postgresql://p@127.0.0.1:5432/db?host=db.example.com",
      "postgresql://p@127.0.0.1:5432/db?host=/var/run/postgresql",
      "postgresql://p@localhost:5432/db?hostaddr=10.0.0.1",
      "postgresql://p@128.0.0.1:5432/db",
      "postgresql://p@127.0.0.1.example.com/db",
      "http://127.0.0.1:5432/db",
      "not a url",
      "",
      undefined,
    ])
      expect(loopbackDbUrl(u), String(u)).toBeNull();
  });
});
