import { checkProfile, type DesignProfile } from "@/lib/design-agent/profile";

// AI design step for sales demos (DEV-030, Sales Design Bridge). Pure rules
// shared by the bridge API, the public demo, the admin screens and tests.
//
// The step is off unless SALES_AI_DESIGN_ENABLED is exactly "true". Off, the
// Sales Agent behaves exactly as before: persist makes legacy demos
// (design_status null), the bridge API answers 503, no design column is read
// and every demo renders with its existing template. The database columns
// exist only after migration 20261009000000, so with the flag off the code
// must not touch them (it is safe to deploy before the migration).

export const DESIGN_STATUSES = ["pending", "processing", "ready", "blocked", "failed"] as const;
export type DesignStatus = (typeof DESIGN_STATUSES)[number];

/** Same limits as sales_design_claim / sales_design_submit. */
export const DESIGN_MAX_ATTEMPTS = 3;
/** A job not answered within this time is handed out again (worker run ≤ 60 min, plus the bridge's own interval). */
export const DESIGN_LEASE_SECONDS = 2 * 60 * 60;

/** Fixed codes only (no free text): the DB checks the same pattern. */
export const DESIGN_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,47}$/;
export const WORKER_COMMIT = /^[0-9a-f]{7,40}$/;

export function aiDesignEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SALES_AI_DESIGN_ENABLED === "true";
}

export function isDesignStatus(value: unknown): value is DesignStatus {
  return typeof value === "string" && (DESIGN_STATUSES as readonly string[]).includes(value);
}

/**
 * The profile a demo may be drawn with, or null for the existing template.
 * Whatever is stored is checked again here (schema, palette contrast,
 * repeated motifs) and must carry no rationale: nothing read from the
 * database reaches the renderer unchecked.
 */
export function renderableProfile(input: { enabled: boolean; status: unknown; profile: unknown }): DesignProfile | null {
  if (!input.enabled || input.status !== "ready") return null;
  const checked = checkProfile(input.profile);
  if (!checked.ok || checked.profile.rationale.length > 0) return null;
  return checked.profile;
}

/** The profile as it may be uploaded and stored: the rationale (Codex's words) never leaves the PC. */
export function uploadableProfile(profile: DesignProfile): DesignProfile {
  return { ...profile, rationale: [] };
}

/**
 * Whether the first message may be sent. With the step on, a demo that is
 * still waiting for or getting its design cannot be sent (the admin would
 * send a link to a page that is about to change). Ready, blocked and failed
 * can: blocked and failed show the existing template.
 */
export function initialSendAllowed(enabled: boolean, status: DesignStatus | null): boolean {
  return !enabled || (status !== "pending" && status !== "processing");
}

export const DESIGN_STATUS_LABEL: Record<DesignStatus, string> = {
  pending: "AIデザイン待ち",
  processing: "AIデザイン生成中",
  ready: "デモ確認可能",
  blocked: "デザインBLOCKED",
  failed: "AIデザイン失敗",
};

/** What the admin is told for blocked / failed (the existing template is used). */
export const DESIGN_FALLBACK_NOTE = "AIデザインは使えません。既存テンプレートのデモで送れます。";
