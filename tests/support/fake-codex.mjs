#!/usr/bin/env node
// Fake Codex CLI for the design agent tests (DEV-028). Same entry points as
// the real one: `codex login status` and `codex exec ... --output-last-message
// <file> ... -` (prompt on stdin). Behaviour comes from files named in the
// environment, so tests never need a real sign-in or network.
//
//   FAKE_CODEX_LOGIN   chatgpt (default) | apikey | none
//   FAKE_CODEX_STEPS   JSON file: array of steps, one per `exec` call:
//                        { "answer": {...} } | { "text": "..." } | { "exit": 1, "stderr": "..." } | { "sleepMs": 5000 }
//   FAKE_CODEX_STATE   file holding the index of the next step
//   FAKE_CODEX_RECORD  JSONL file: one line per call (args, stdin size, which API-key variables were visible)
//   FAKE_CODEX_PROMPTS JSONL file (optional): the full stdin of each exec, and the attached images (path, sha256)
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const record = (extra) => {
  if (!process.env.FAKE_CODEX_RECORD) return;
  const keys = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"].filter((k) => process.env[k] !== undefined);
  const secretVars = Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD|SUPABASE/i.test(k));
  appendFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ args, cwd: process.cwd(), apiKeyVars: keys, secretVars, tmpdir: process.env.TMPDIR ?? null, ...extra }) + "\n");
};

if (args[0] === "login" && args[1] === "status") {
  record({});
  const mode = process.env.FAKE_CODEX_LOGIN ?? "chatgpt";
  if (mode === "chatgpt") {
    process.stdout.write("Logged in using ChatGPT\n");
    process.exit(0);
  }
  if (mode === "apikey") {
    process.stdout.write("Logged in using an API key - sk-***\n");
    process.exit(0);
  }
  process.stderr.write("Not logged in\n");
  process.exit(1);
}

if (args[0] !== "exec") {
  process.stderr.write("unsupported\n");
  process.exit(2);
}

let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", async () => {
  const steps = JSON.parse(readFileSync(process.env.FAKE_CODEX_STEPS, "utf8"));
  const statePath = process.env.FAKE_CODEX_STATE;
  const index = existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
  writeFileSync(statePath, String(index + 1));
  const step = steps[Math.min(index, steps.length - 1)];
  // Which schema was sent: the strict one carries length limits, the loose one does not.
  const schemaPath = args[args.indexOf("--output-schema") + 1];
  const schemaText = schemaPath && existsSync(schemaPath) ? readFileSync(schemaPath, "utf8") : "";
  record({ stdinLength: stdin.length, stdinHasFacts: stdin.includes("Verified facts"), step: index, strictSchema: schemaText.includes("maxLength") });
  if (process.env.FAKE_CODEX_PROMPTS) {
    const images = args.filter((a) => a.startsWith("--image=")).map((a) => a.slice(8)).map((path) => ({ path, sha256: existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null }));
    appendFileSync(process.env.FAKE_CODEX_PROMPTS, JSON.stringify({ cwd: process.cwd(), stdin, images, schema: schemaText }) + "\n");
  }
  // Like the real CLI: a session log that holds the request (and its images).
  const THREAD = "00000000-0000-4000-8000-000000000000";
  if (process.env.CODEX_HOME) {
    const dir = join(process.env.CODEX_HOME, "sessions", "2026", "09", "29");
    mkdirSync(dir, { recursive: true });
    const images = args.filter((a) => a.startsWith("--image=")).length;
    writeFileSync(join(dir, `rollout-2026-09-29T10-00-00-${THREAD}.jsonl`), JSON.stringify({ type: "session_meta", payload: { cwd: process.cwd() } }) + "\n" + JSON.stringify({ images }) + "\n");
    writeFileSync(join(dir, "rollout-2026-09-29T09-00-00-11111111-1111-4111-8111-111111111111.jsonl"), "{}\n");
  }
  if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));
  if (step.exit) {
    process.stderr.write(step.stderr ?? "");
    process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: step.eventMessage ?? "" } }) + "\n");
    process.exit(step.exit);
  }
  const text = step.text ?? JSON.stringify(step.answer);
  const out = args[args.indexOf("--output-last-message") + 1];
  if (!step.noFile && out) writeFileSync(out, text);
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: THREAD }) + "\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n");
  process.exit(0);
});
