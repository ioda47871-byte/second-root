// Fails when a tracked file looks like it contains a real secret. This is a
// cheap safety net for docs/SECURITY.md §1, not a replacement for care:
// Supabase keys, Resend keys, private keys and bearer tokens must never be
// committed. Placeholder values (all x / "dummy" / "test") are allowed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["Resend API key", /\bre_[A-Za-z0-9_]{20,}\b/g],
  ["JWT (e.g. Supabase anon/service role key)", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{10,}/g],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["Vercel token", /\bvercel_[A-Za-z0-9]{20,}\b/gi],
  ["Anthropic / OpenAI key", /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/g],
  ["Postgres URL with password", /postgres(ql)?:\/\/[^:\s/]+:[^@\s]{6,}@(?!127\.0\.0\.1|localhost)/g],
];

const isPlaceholder = (value) => /^(re_)?x+$/i.test(value) || /(dummy|test|example|placeholder)/i.test(value);

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((f) => !/\.(png|jpe?g|webp|gif|ico|woff2?|ttf|pdf)$/i.test(f) && f !== "package-lock.json");

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const [label, pattern] of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (isPlaceholder(match[0])) continue;
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(`${file}:${line}  ${label}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Possible secrets found in tracked files (values not printed):");
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-secrets: ${files.length} tracked files scanned, no secrets found.`);
