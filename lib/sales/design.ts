import { checkProfile, type DesignProfile } from "@/lib/design-agent/profile";
import { REVIEW_SCORE_KEYS, type ReviewScoreKey, type ReviewSummary } from "@/lib/design-agent/review-summary";

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

/**
 * Why a demo is blocked / failed, in words for the admin (design_error_code).
 * The codes are the fixed ones the worker, the bridge and the database write.
 */
export const DESIGN_ERROR_LABEL: Readonly<Record<string, string>> = {
  PUBLIC_SOURCE_UNAVAILABLE: "公開の参照元（公式サイト・Instagram）を取得できなかった",
  FALLBACK_TEMPLATE: "AIデザインを作れなかった（既存テンプレート）",
  DESIGN_BLOCKED: "AIデザインが止まった（人の確認が必要）",
  RENDERER_CHANGE_NEEDED: "描画側の拡張が必要（人の判断）",
  QUALITY_NOT_ACCEPTED: "品質の確認で合格しなかった（レビューが一度も accept しなかった）",
  DO_NOT_CONTACT: "連絡しない店",
  DEMO_DISABLED: "デモが無効",
  ALREADY_SENT: "初回は送信済み",
  OUTREACH_CLOSED: "送らずに失注にした",
  NO_VISUAL_SOURCE: "参照元（公式サイト・Instagram）がない",
  DEMO_CONTENT_INVALID: "デモの内容が不正",
  DESIGN_STALE: "期限内に結果が届かなかった",
  PROFILE_INVALID: "AIデザインの profile が検証を通らなかった",
  RESULT_MISSING: "worker の結果がなかった",
  WORKER_FAILED: "worker が失敗した",
};

/** The admin's words for a design_error_code; an unknown code is shown as it is (it is always a fixed code). */
export function designErrorLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(DESIGN_ERROR_LABEL, code) ? DESIGN_ERROR_LABEL[code]! : code;
}

/** DEV-058: the admin's words for the review's score axes (generic_template_feel: lower is better). */
export const REVIEW_AXIS_LABEL: Readonly<Record<ReviewScoreKey, string>> = {
  brand_fit: "店らしさ",
  visual_quality: "見た目",
  hierarchy: "情報の階層",
  mobile_quality: "スマホ",
  generic_template_feel: "テンプレ感（低いほど良い）",
};

/** DEV-058: one line for a stored review summary, e.g. 「AI レビュー: accept 19/25（2 回）」. Numbers and enums only. */
export function reviewSummaryLine(r: ReviewSummary): string {
  return `AI レビュー: ${r.verdict} ${r.total}/${r.max}（${r.rounds} 回）`;
}

/** DEV-058: the axis scores of a summary in the review schema's order, then the confidence when recorded. */
export function reviewAxisLines(r: ReviewSummary): string[] {
  const axes = REVIEW_SCORE_KEYS.map((k) => `${REVIEW_AXIS_LABEL[k]} ${r.scores[k]}/5`);
  return r.confidence === null ? axes : [...axes, `確信度 ${r.confidence.toFixed(2)}`];
}
