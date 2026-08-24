/**
 * Decorative + icon kit.
 *
 * Everything here is hand-authored SVG so the "plants / root / growing"
 * motif can be tinted per section with currentColor. Nothing is a
 * generated image, and no person is ever depicted.
 */

type S = { className?: string; style?: React.CSSProperties };

/* ---------------- organic background shapes ---------------- */

/** Deep-green organic blob used behind the hero / philosophy. */
export function BlobGreen({ className, style }: S) {
  return (
    <svg className={className} style={style} viewBox="0 0 600 600" fill="none" aria-hidden="true">
      <path
        d="M486 62c62 46 92 138 78 222-14 84-72 160-146 202-74 42-164 50-224 14-60-36-90-116-96-198-6-82 12-166 66-218 54-52 144-72 214-58 24 5 76 20 108 36Z"
        fill="#214C35"
      />
    </svg>
  );
}

/** Soft sand blob for the light side of the hero. */
export function BlobSand({ className, style }: S) {
  return (
    <svg className={className} style={style} viewBox="0 0 600 600" fill="none" aria-hidden="true">
      <path
        d="M470 96c56 60 76 158 52 240-24 82-92 148-176 172-84 24-184 6-236-52-52-58-56-156-24-236S212 78 292 60c80-18 122-24 178 36Z"
        fill="#EFE3CE"
      />
    </svg>
  );
}

/** A spray of leaves on a stem. */
export function LeafSpray({ className, style }: S) {
  return (
    <svg className={className} style={style} viewBox="0 0 200 260" fill="none" aria-hidden="true">
      <path d="M100 250C100 250 96 150 100 100C104 50 118 18 118 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M101 196c-16-6-38-2-50-16-12-14-10-34-10-34s26-4 42 6 18 44 18 44Z" fill="currentColor" opacity=".5" />
      <path d="M104 150c16-8 26-30 44-34 18-4 34 8 34 8s-12 24-30 30-48-4-48-4Z" fill="currentColor" opacity=".38" />
      <path d="M104 108c-14-8-34-6-46-22-12-16-6-36-6-36s24 2 38 14 14 44 14 44Z" fill="currentColor" opacity=".5" />
      <path d="M110 70c14-10 20-32 38-38 18-6 32 4 32 4s-8 26-26 34-44 0-44 0Z" fill="currentColor" opacity=".33" />
    </svg>
  );
}

/** A small branch with round leaves — lighter, for card corners. */
export function LeafBranch({ className, style }: S) {
  return (
    <svg className={className} style={style} viewBox="0 0 160 160" fill="none" aria-hidden="true">
      <path d="M18 148C18 148 60 118 88 84c28-34 46-70 46-70" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <ellipse cx="52" cy="112" rx="24" ry="14" transform="rotate(-38 52 112)" fill="currentColor" opacity=".45" />
      <ellipse cx="88" cy="76" rx="26" ry="15" transform="rotate(-38 88 76)" fill="currentColor" opacity=".38" />
      <ellipse cx="116" cy="42" rx="22" ry="13" transform="rotate(-38 116 42)" fill="currentColor" opacity=".5" />
    </svg>
  );
}

/** Dot grid. */
export function Dots({ className, style, cols = 6, rows = 4 }: S & { cols?: number; rows?: number }) {
  const r = 2.6;
  const gap = 13;
  return (
    <svg
      className={className}
      style={style}
      width={cols * gap}
      height={rows * gap}
      viewBox={`0 0 ${cols * gap} ${rows * gap}`}
      fill="none"
      aria-hidden="true"
    >
      {Array.from({ length: rows }).map((_, y) =>
        Array.from({ length: cols }).map((_, x) => (
          <circle key={`${x}-${y}`} cx={x * gap + gap / 2} cy={y * gap + gap / 2} r={r} fill="currentColor" />
        ))
      )}
    </svg>
  );
}

/** The brand's root/sprout mark. */
export function RootMark({ className, style }: S) {
  return (
    <svg className={className} style={style} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <circle cx="32" cy="32" r="30" stroke="currentColor" strokeWidth="1.6" opacity=".45" />
      <path d="M32 46V28" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M32 30c0-6 5-11 11-11 0 6-5 11-11 11Z" fill="currentColor" opacity=".85" />
      <path d="M32 34c0-5-4-9-9-9 0 5 4 9 9 9Z" fill="currentColor" opacity=".55" />
      <path d="M32 46c-4 0-7 2-9 5M32 46c4 0 7 2 9 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".7" />
    </svg>
  );
}

/* ---------------- line icons ---------------- */

const ico = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconInstagram({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
export function IconClock({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}
export function IconPhone({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10.5 5.5h3M12 18.2h.01" />
    </svg>
  );
}
export function IconPencil({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z" />
      <path d="M14.5 5.5 18.5 9.5" />
    </svg>
  );
}
export function IconMonitor({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M9 20.5h6M12 17v3.5" />
    </svg>
  );
}
export function IconRefresh({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20.5 3.5V9H15" />
    </svg>
  );
}
export function IconHands({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <path d="M12 21c-3.5-2.6-7-5.2-7-9a3.6 3.6 0 0 1 7-1.3A3.6 3.6 0 0 1 19 12c0 3.8-3.5 6.4-7 9Z" />
    </svg>
  );
}
export function IconMail({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  );
}
export function IconChat({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <path d="M21 12a7.5 7.5 0 0 1-7.5 7.5H8L4 22l1.2-3.4A7.5 7.5 0 1 1 21 12Z" />
    </svg>
  );
}
export function IconDoc({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <path d="M14 2.5H7A2.5 2.5 0 0 0 4.5 5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8L14 2.5Z" />
      <path d="M13.5 3v5.5H19M8 13h8M8 17h5" />
    </svg>
  );
}
export function IconLayout({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <rect x="3" y="3.5" width="18" height="17" rx="2.5" />
      <path d="M3 9h18M9 9v11.5" />
    </svg>
  );
}
export function IconCheckCircle({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="m8.2 12.2 2.6 2.6 5-5.2" />
    </svg>
  );
}
export function IconRocket({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <path d="M13.5 3.5c4 1 7 4 8 8-3 3-6 4-6 4l-6-6s1-3 4-6Z" />
      <path d="M9.5 9.5 4 12l3 1.2M14.5 14.5 12 20l-1.2-3" />
      <path d="M6.5 17.5c-1 1-1.2 3-1.2 3s2-.2 3-1.2" />
    </svg>
  );
}
export function IconSearch({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  );
}
export function IconUser({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.8 20c.6-3.6 3.6-6 7.2-6s6.6 2.4 7.2 6" />
    </svg>
  );
}
export function IconYen({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <path d="M7 5.5 12 12l5-6.5M12 12v7M8.5 14h7M8.5 17h7" />
    </svg>
  );
}
export function IconGift({ className }: S) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" {...ico} aria-hidden="true">
      <rect x="3" y="8.5" width="18" height="12.5" rx="2" />
      <path d="M3 12.5h18M12 8.5V21" />
      <path d="M12 8.5S10.5 4 8 4a2.2 2.2 0 0 0 0 4.5h4Zm0 0S13.5 4 16 4a2.2 2.2 0 0 1 0 4.5h-4Z" />
    </svg>
  );
}
export function IconCheck({ className }: S) {
  return (
    <svg className={className} width="15" height="15" viewBox="0 0 24 24" {...ico} strokeWidth={2.4} aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}
export function IconArrow({ className }: S) {
  return (
    <svg className={`arrow ${className ?? ""}`} width="17" height="12" viewBox="0 0 17 12" {...ico} aria-hidden="true">
      <path d="M1 6h14M11 1.5 15.5 6 11 10.5" />
    </svg>
  );
}
export function IconExternal({ className }: S) {
  return (
    <svg className={className} width="13" height="13" viewBox="0 0 24 24" {...ico} strokeWidth={2} aria-hidden="true">
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10" />
    </svg>
  );
}
