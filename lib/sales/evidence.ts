import { CATEGORY_LABEL } from "./demo-content";
import { initialSendAllowed, type DesignStatus } from "./design";
import { checkTarget, type TargetRejection } from "./eligibility";
import { EXCLUSION_REASON_LABEL, type ExclusionReason } from "./exclusions";
import { FIRST_PARTY_SOURCE_TYPES, SOURCE_FIELDS, type Category, type Channel, type SourceField, type SourceType, type WebsiteStatus } from "./types";
import { normalizeEmail } from "./normalize";
import { isSafeHttpUrl } from "./url";

// DEV-194: why a shop is on today's list, where its facts come from, and
// whether it can be contacted — as a typed view model the today card shows
// now and later steps (demo preview, message editing, send approval) can
// reuse. Pure: no database, no clock, no environment. Everything here comes
// from stored columns; nothing missing is filled in (it is shown as 未確認).
//
// Contact verdict parity: the checks below mirror, one for one, what the
// database refuses when an outreach is marked sent:
//   sales_mark_sent            initial, status drafted
//   sales_assert_outreach_eligible (trigger on the sent transition)
//     do_not_contact           -> dnc
//     instagram: website_status = not_found, handle, no public email -> channel_rule
//     email: public email with a first-party sales_sources row       -> channel_rule
//     initial: recommended_channel = channel                         -> recommended_channel
//   markSent (server action)   AI design not pending/processing      -> design
//   sales_mark_follow_up_sent  email only (due / demo checked by the queue);
//     its insert re-runs the eligibility trigger (DNC + email provenance)
// The UI adds two stricter checks the database does not make at send time:
// a usable demo link (without one no message can be composed) and the
// admin's exclusion list (an exclusion added after the draft was made). Being
// stricter is safe; the card is never "sendable" where the server would refuse.

export const UNCONFIRMED = "未確認";

export const CHANNEL_LABEL: Record<Channel, string> = { instagram: "Instagram", email: "メール" };

export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  official_site: "公式サイト",
  official_contact: "公式の問い合わせページ",
  official_profile: "公式プロフィール",
  instagram_profile: "Instagram プロフィール",
  map_listing: "地図・掲載サイト",
  other: "その他",
};

export const SOURCE_FIELD_LABEL: Record<SourceField, string> = {
  name: "店名",
  address: "住所",
  category: "業種",
  website_url: "公式サイト",
  instagram_url: "Instagram",
  email: "メール",
  hours: "営業時間",
  closed_days: "定休日",
  access: "アクセス",
  phone: "電話",
  description: "紹介文",
  menu_item: "メニュー",
};

const TARGET_REJECTION_LABEL: Record<TargetRejection, string> = {
  outside_nagoya: "名古屋市外の住所",
  unsupported_category: "対象外の業種",
};

/** One stored sales_sources row, as read through the admin's session. */
export type SourceRow = {
  field: string;
  value: string;
  source_url: string;
  source_type: string;
  verified_at: string;
};

export type SourceEvidence = {
  field: SourceField;
  fieldLabel: string;
  /** Shortened for the card; the full value stays in the database. */
  value: string;
  sourceType: SourceType;
  sourceTypeLabel: string;
  firstParty: boolean;
  /** Only a safe http(s) URL is ever linked; otherwise null (shown as 未確認). */
  sourceUrl: string | null;
  verifiedAt: string;
  verifiedDate: string;
};

/** A field the card expects a source for but none is stored. */
export type MissingSource = { field: SourceField; fieldLabel: string };

export type ExclusionRow = {
  reason: string;
  instagram_handle: string | null;
  website_domain: string | null;
  email_digest: string | null;
  normalized_name: string | null;
  normalized_address: string | null;
};

/**
 * The prospect's keys, normalised at ingest. Persist compares the same four
 * kinds of key, but on the candidate as submitted: its email digest covers any
 * email the candidate sent, first-party or not, and that is not stored. Here
 * the email side is the digests of what is stored: the public email and the
 * values of the prospect's `field = 'email'` source rows (DEV-194 review L2).
 */
export type ExclusionKeys = {
  instagramHandle: string | null;
  websiteDomain: string | null;
  /** lib/sales/email-digest.ts of each stored email (normalised), computed by the server. */
  emailDigests: string[];
  normalizedName: string | null;
  normalizedAddress: string | null;
};

export type ExclusionCheck =
  | { state: "clear" }
  | { state: "match"; reasons: ExclusionReason[] }
  /** The list could not be read: fail closed (MVP_SPEC §3.6). */
  | { state: "unchecked" };

export type CheckId =
  | "outreach_state"
  | "dnc"
  | "exclusion"
  | "target"
  | "recommended_channel"
  | "channel_rule"
  | "design"
  | "demo_link";

export type CheckState = "ok" | "ng" | "unconfirmed";

export type VerdictCheck = {
  id: CheckId;
  label: string;
  state: CheckState;
  detail: string;
  /** true when the database itself refuses on ng; false for the UI's stricter checks. */
  serverEnforced: boolean;
};

export type ContactVerdict = {
  /** sendable only when every check is ok. */
  sendable: boolean;
  badge: string;
  checks: VerdictCheck[];
  /** Short reasons the card shows next to a 送信不可 badge (ng and 未確認 checks). */
  blockers: string[];
  /** What a human still has to confirm (does not change sendable). */
  unconfirmed: string[];
  channel: Channel;
  channelLabel: string;
  recommendedChannelLabel: string;
  emailProvenance: { state: "first_party"; source: SourceEvidence } | { state: "missing" } | { state: "not_applicable" };
  instagram: { handle: string; url: string | null } | null;
};

export type SelectionLine = { label: string; value: string; unconfirmed: boolean };

export type TodayEvidence = {
  /** One sentence built only from stored fields. */
  summary: string;
  lines: SelectionLine[];
  /**
   * No column holds why this shop was chosen beyond the stored fields above
   * (no hypothesis / note is stored by ingest), so this is always 未確認 for now.
   */
  hypothesis: string | null;
  sources: SourceEvidence[];
  missingSources: MissingSource[];
  /** The newest / oldest verified_at of the stored sources, as JST dates. */
  researchedDate: string;
  registeredDate: string;
  contact: ContactVerdict;
};

export type EvidenceInput = {
  kind: "initial" | "follow_up";
  /** Status of the outreach the card acts on (initial: drafted; follow-up: the initial's, sent). */
  outreachStatus: string;
  channel: Channel;
  category: Category | null;
  ward: string | null;
  address: string | null;
  doNotContact: boolean | null;
  websiteStatus: WebsiteStatus | null;
  websiteDomain: string | null;
  instagramUrl: string | null;
  instagramHandle: string | null;
  publicEmail: string | null;
  recommendedChannel: Channel | null;
  registeredAt: string | null;
  sources: SourceRow[] | null;
  designEnabled: boolean;
  designStatus: DesignStatus | null;
  demoAvailable: boolean;
  exclusion: ExclusionCheck;
};

/** "2026/11/07" in Asia/Tokyo, or 未確認 for anything that is not a valid timestamp. */
export function formatJstDate(iso: string | null | undefined): string {
  if (!iso) return UNCONFIRMED;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return UNCONFIRMED;
  const d = new Date(t + 9 * 60 * 60 * 1000).toISOString();
  return `${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}`;
}

const isField = (v: string): v is SourceField => (SOURCE_FIELDS as readonly string[]).includes(v);
const SOURCE_TYPE_KEYS = Object.keys(SOURCE_TYPE_LABEL) as SourceType[];
const isSourceType = (v: string): v is SourceType => (SOURCE_TYPE_KEYS as string[]).includes(v);

function shorten(value: string, max = 80): string {
  const s = value.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Stored source rows → card rows, in SOURCE_FIELDS order then newest first. Rows of unknown shape are dropped. */
export function mapSources(rows: SourceRow[] | null): SourceEvidence[] {
  const out: SourceEvidence[] = [];
  for (const r of rows ?? []) {
    if (!r || !isField(r.field) || !isSourceType(r.source_type) || typeof r.value !== "string") continue;
    out.push({
      field: r.field,
      fieldLabel: SOURCE_FIELD_LABEL[r.field],
      value: shorten(r.value),
      sourceType: r.source_type,
      sourceTypeLabel: SOURCE_TYPE_LABEL[r.source_type],
      firstParty: FIRST_PARTY_SOURCE_TYPES.includes(r.source_type),
      sourceUrl: isSafeHttpUrl(r.source_url) ? r.source_url : null,
      verifiedAt: r.verified_at,
      verifiedDate: formatJstDate(r.verified_at),
    });
  }
  const order = (f: SourceField) => SOURCE_FIELDS.indexOf(f);
  return out.sort((a, b) => order(a.field) - order(b.field) || (Date.parse(b.verifiedAt) || 0) - (Date.parse(a.verifiedAt) || 0));
}

/** The emails a prospect has stored (public email + email source rows), normalised and de-duplicated. */
export function storedEmails(publicEmail: string | null, sources: SourceRow[] | null): string[] {
  const raw = [publicEmail, ...(sources ?? []).filter((r) => r?.field === "email").map((r) => r.value)];
  const out = new Set<string>();
  for (const v of raw) {
    const n = typeof v === "string" ? normalizeEmail(v) : null;
    if (n) out.add(n);
  }
  return [...out];
}

/**
 * The admin's exclusion list against the prospect's stored keys (the four
 * kinds persist compares; see ExclusionKeys for the email difference).
 * `rows` is null when the list could not be read completely: 未確認.
 */
export function matchExclusions(keys: ExclusionKeys, rows: ExclusionRow[] | null): ExclusionCheck {
  if (!rows) return { state: "unchecked" };
  const reasons = new Set<ExclusionReason>();
  for (const r of rows) {
    const hit =
      (r.instagram_handle !== null && r.instagram_handle === keys.instagramHandle) ||
      (r.website_domain !== null && r.website_domain === keys.websiteDomain) ||
      (r.email_digest !== null && keys.emailDigests.includes(r.email_digest)) ||
      (r.normalized_name !== null &&
        r.normalized_name === keys.normalizedName &&
        r.normalized_address !== null &&
        r.normalized_address === keys.normalizedAddress);
    if (hit) reasons.add((r.reason in EXCLUSION_REASON_LABEL ? r.reason : "other") as ExclusionReason);
  }
  return reasons.size > 0 ? { state: "match", reasons: [...reasons] } : { state: "clear" };
}

const ok = (id: CheckId, label: string, detail: string, serverEnforced = true): VerdictCheck => ({ id, label, state: "ok", detail, serverEnforced });
const ng = (id: CheckId, label: string, detail: string, serverEnforced = true): VerdictCheck => ({ id, label, state: "ng", detail, serverEnforced });
const unknown = (id: CheckId, label: string, detail: string, serverEnforced = true): VerdictCheck => ({ id, label, state: "unconfirmed", detail, serverEnforced });

/** The stored first-party email source the database accepts (sales_has_first_party_email). */
function firstPartyEmailSource(publicEmail: string | null, rows: SourceRow[] | null): SourceEvidence | null {
  if (!publicEmail) return null;
  // Compare on the full stored value, as SQL does (lower(value) = public_email).
  const match = (rows ?? []).find(
    (r) =>
      r?.field === "email" &&
      typeof r.value === "string" &&
      r.value.toLowerCase() === publicEmail &&
      isSourceType(r.source_type) &&
      FIRST_PARTY_SOURCE_TYPES.includes(r.source_type),
  );
  return match ? (mapSources([match])[0] ?? null) : null;
}

function channelRule(input: EvidenceInput, emailSource: SourceEvidence | null, channel: Channel): VerdictCheck {
  const label = "連絡経路の条件";
  if (channel === "instagram") {
    if (input.websiteStatus === null) return unknown("channel_rule", label, `公式サイトの有無が${UNCONFIRMED}のため Instagram で送れません`);
    if (input.websiteStatus !== "not_found") return ng("channel_rule", label, "公式サイトが「見つからない」と確認された店舗だけが Instagram の対象です");
    if (!input.instagramHandle) return ng("channel_rule", label, "Instagram アカウントが登録されていません");
    if (input.publicEmail) return ng("channel_rule", label, "公開メールがある店舗は Instagram ではなくメールの対象です");
    return ok("channel_rule", label, "公式サイトなし（再検索済み）・Instagram あり・公開メールなし");
  }
  if (!input.publicEmail) return ng("channel_rule", label, "公開メールが登録されていません");
  if (input.sources === null) return unknown("channel_rule", label, `メールの出典が${UNCONFIRMED}です`);
  if (!emailSource) return ng("channel_rule", label, "店舗自身が公開したメールの出典（公式サイト等）が保存されていません");
  return ok("channel_rule", label, `店舗自身の公開メール（出典: ${emailSource.sourceTypeLabel}）`);
}

export function contactVerdict(input: EvidenceInput): ContactVerdict {
  const channel = input.channel;
  const emailSource = firstPartyEmailSource(input.publicEmail, input.sources);
  const checks: VerdictCheck[] = [];

  // sales_mark_sent / sales_mark_follow_up_sent: the state the RPC accepts.
  if (input.kind === "initial") {
    checks.push(
      input.outreachStatus === "drafted"
        ? ok("outreach_state", "下書きの状態", "未送信の下書き")
        : ng("outreach_state", "下書きの状態", "未送信の下書きではありません"),
    );
  } else {
    checks.push(
      input.outreachStatus === "sent" && channel === "email"
        ? ok("outreach_state", "フォローの条件", "メールで送信済み・5日以上返信なし")
        : ng("outreach_state", "フォローの条件", "フォローはメールで送信済みの初回営業だけです"),
    );
  }

  checks.push(
    input.doNotContact === null
      ? unknown("dnc", "営業不要（DNC）", `DNC の状態が${UNCONFIRMED}です`)
      : input.doNotContact
        ? ng("dnc", "営業不要（DNC）", "営業不要（DNC）の店舗です")
        : ok("dnc", "営業不要（DNC）", "DNC ではありません"),
  );

  checks.push(
    input.exclusion.state === "clear"
      ? ok("exclusion", "除外リスト", "除外リストに該当なし", false)
      : input.exclusion.state === "match"
        ? ng("exclusion", "除外リスト", `除外リストに一致（${input.exclusion.reasons.map((r) => EXCLUSION_REASON_LABEL[r]).join("・")}）。見送るか営業不要にしてください`, false)
        : unknown("exclusion", "除外リスト", `除外リストを照合できませんでした（${UNCONFIRMED}）`, false),
  );

  if (input.address === null || input.category === null) {
    checks.push(unknown("target", "対象（名古屋市・3業種）", `住所または業種が${UNCONFIRMED}です`));
  } else {
    const target = checkTarget({ address: input.address, category: input.category });
    checks.push(
      target.ok
        ? ok("target", "対象（名古屋市・3業種）", `名古屋市内の${CATEGORY_LABEL[target.category]}`)
        : ng("target", "対象（名古屋市・3業種）", TARGET_REJECTION_LABEL[target.reason]),
    );
  }

  if (input.kind === "initial") {
    checks.push(
      input.recommendedChannel === channel
        ? ok("recommended_channel", "推奨チャネル", `${CHANNEL_LABEL[channel]}（登録時に決定）`)
        : input.recommendedChannel === null
          ? ng("recommended_channel", "推奨チャネル", `推奨チャネルが登録されていません（${UNCONFIRMED}）`)
          : ng("recommended_channel", "推奨チャネル", `下書きのチャネル（${CHANNEL_LABEL[channel]}）が推奨チャネル（${CHANNEL_LABEL[input.recommendedChannel]}）と違います`),
    );
  }

  checks.push(channelRule(input, emailSource, channel));

  // With the AI design step off nothing waits for a design (initialSendAllowed is always true).
  if (input.kind === "initial" && input.designEnabled) {
    checks.push(
      initialSendAllowed(input.designEnabled, input.designStatus)
        ? ok("design", "AIデザイン", "完成待ちではありません")
        : ng("design", "AIデザイン", "AIデザインの完成を待っています"),
    );
  }

  checks.push(
    input.demoAvailable
      ? ok("demo_link", "デモのリンク", "デモのリンクがあります", false)
      : ng("demo_link", "デモのリンク", "デモが無いか無効のため、文面を作れません", false),
  );

  const sendable = checks.every((c) => c.state === "ok");
  const unconfirmed: string[] = [];
  if (channel === "instagram") unconfirmed.push("プロフィールに「DM不可」「営業お断り」の記載がないか（送る前に目で確認）");
  if (channel === "email") unconfirmed.push("出典ページに「営業お断り」の記載がないか（送る前に目で確認）");

  return {
    sendable,
    badge: sendable ? "送信できます" : "送信できません",
    checks,
    blockers: checks.filter((c) => c.state !== "ok").map((c) => `${c.label}: ${c.detail}`),
    unconfirmed,
    channel,
    channelLabel: CHANNEL_LABEL[channel],
    recommendedChannelLabel: input.recommendedChannel ? CHANNEL_LABEL[input.recommendedChannel] : UNCONFIRMED,
    emailProvenance: channel !== "email" && !input.publicEmail
      ? { state: "not_applicable" }
      : emailSource
        ? { state: "first_party", source: emailSource }
        : { state: "missing" },
    instagram: input.instagramHandle ? { handle: input.instagramHandle, url: isSafeHttpUrl(input.instagramUrl) ? input.instagramUrl : null } : null,
  };
}

const WEBSITE_LINE: Record<WebsiteStatus, (domain: string | null) => string> = {
  present: (d) => `あり${d ? `（${d}）` : ""}`,
  not_found: () => "見つからない（登録時に再検索済み）",
  unknown: () => `${UNCONFIRMED}（検索で確定できず）`,
};

/** The fields the card always expects a source for, plus the channel's own field. */
function expectedFields(channel: Channel): SourceField[] {
  return ["name", "address", "category", channel === "email" ? "email" : "instagram_url"];
}

export function buildTodayEvidence(input: EvidenceInput): TodayEvidence {
  const sources = mapSources(input.sources);
  const contact = contactVerdict(input);

  const place = input.ward ? `名古屋市${input.ward}` : null;
  const category = input.category ? CATEGORY_LABEL[input.category] : null;
  const lines: SelectionLine[] = [
    { label: "地域", value: place ?? `名古屋市（区は${UNCONFIRMED}）`, unconfirmed: !place },
    { label: "業種", value: category ?? UNCONFIRMED, unconfirmed: !category },
    {
      label: "公式サイト",
      value: input.websiteStatus ? WEBSITE_LINE[input.websiteStatus](input.websiteDomain) : UNCONFIRMED,
      unconfirmed: input.websiteStatus === null || input.websiteStatus === "unknown",
    },
    { label: "推奨チャネル", value: contact.recommendedChannelLabel, unconfirmed: input.recommendedChannel === null },
    {
      label: "メールの出所",
      value:
        contact.emailProvenance.state === "first_party"
          ? `店舗自身の公開（${contact.emailProvenance.source.sourceTypeLabel}）`
          : input.publicEmail
            ? `出典${UNCONFIRMED}`
            : "公開メールなし",
      unconfirmed: contact.emailProvenance.state === "missing",
    },
    { label: "Instagram", value: input.instagramHandle ? `@${input.instagramHandle}` : "登録なし", unconfirmed: false },
  ];

  // The sentence only restates stored fields; nothing is guessed.
  const where = [place ?? "名古屋市", category ?? `業種${UNCONFIRMED}`].join("の");
  const site =
    input.websiteStatus === "not_found"
      ? "公式サイトが見つからず"
      : input.websiteStatus === "present"
        ? "公式サイトはあり"
        : `公式サイトの有無は${UNCONFIRMED}で`;
  // Only the stored recommendation: whether it can be sent now is the verdict's job (DEV-194 review L3).
  const reach = input.recommendedChannel ? `推奨チャネルは${CHANNEL_LABEL[input.recommendedChannel]}の候補` : `推奨チャネルが${UNCONFIRMED}の候補`;
  const summary = `${where}。${site}、${reach}。`;

  const present = new Set(sources.map((s) => s.field));
  const missingSources = expectedFields(input.channel)
    .filter((f) => !present.has(f))
    .map((f) => ({ field: f, fieldLabel: SOURCE_FIELD_LABEL[f] }));

  const times = sources.map((s) => Date.parse(s.verifiedAt)).filter((t) => !Number.isNaN(t));
  const researchedDate =
    times.length === 0
      ? UNCONFIRMED
      : (() => {
          const newest = formatJstDate(new Date(Math.max(...times)).toISOString());
          const oldest = formatJstDate(new Date(Math.min(...times)).toISOString());
          return newest === oldest ? newest : `${oldest}〜${newest}`;
        })();

  return {
    summary,
    lines,
    hypothesis: null,
    sources,
    missingSources,
    researchedDate,
    registeredDate: formatJstDate(input.registeredAt),
    contact,
  };
}
