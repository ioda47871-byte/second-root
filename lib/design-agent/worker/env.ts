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
  // DEV-302 (the IMAGE_FIRST automatic run): set by root so a child git reads no user / system config and no attributes
  // file (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1, core.attributesFile=/dev/null through GIT_CONFIG_COUNT).
  // Passing them on can only narrow what git loads.
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
]);

export function childEnvironment(base: Record<string, string | undefined>, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && (ALLOWED.has(name) || name.startsWith("LC_"))) env[name] = value;
  }
  return codexEnvironment({ ...env, NEXT_TELEMETRY_DISABLED: "1", ...extra });
}
