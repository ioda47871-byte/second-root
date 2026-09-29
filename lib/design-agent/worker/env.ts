// The environment the design worker hands to every child process (git, npm,
// next, Playwright, Codex). An allowlist: API keys, tokens, database and
// cloud credentials never reach a child, whatever the parent had. Codex gets
// the same list minus the OpenAI variables (codex.ts: codexEnvironment).
import { codexEnvironment } from "../codex";

const ALLOWED = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM", "TMPDIR",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "CODEX_HOME", "PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
]);

export function childEnvironment(base: Record<string, string | undefined>, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && (ALLOWED.has(name) || name.startsWith("LC_"))) env[name] = value;
  }
  return codexEnvironment({ ...env, NEXT_TELEMETRY_DISABLED: "1", ...extra });
}
