import type { CSSProperties } from "react";
import type { DesignProfile } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "../DemoFrame";
import { areaLabel, infoRows } from "../info";
import { editorial, grotesk } from "./fonts";
import { locationLabels, monogram, nameLines, nameSizing, ordinal } from "./text";
import styles from "./profile.module.css";

// Shared renderer for design profiles (DEV-028). Every word on the page comes
// from the fact-only DemoView or from fixed template copy (headings, the
// English category, romanised ward, the name's own initials). The profile
// only switches visual settings, through data attributes and colour tokens;
// it can never add text.

const CATEGORY_EN: Record<DemoView["category"], string> = { bakery: "Bakery", baked_goods: "Baked Goods", cafe: "Cafe" };
const ROW_EN = { hours: "Hours", closedDays: "Closed", address: "Address", access: "Access", phone: "Tel" } as const;

function tokens(p: DesignProfile): CSSProperties {
  const c = p.palette;
  return {
    "--p-bg": c.background,
    "--p-surface": c.surface,
    "--p-text": c.text,
    "--p-primary": c.primary,
    "--p-secondary": c.secondary,
    "--p-accent": c.accent,
    // DemoFrame's notice bar and footer.
    "--notice-bg": c.background,
    "--notice-ink": c.secondary,
    "--notice-line": c.primary,
    "--footer-bg": c.primary,
    "--footer-ink": c.background,
    "--paper": c.background,
    "--ink": c.text,
    "--line": c.primary,
  } as CSSProperties;
}

function PleatsArt() {
  // Abstract pleated-liner lines: a scalloped rim over converging strokes.
  const pleats = Array.from({ length: 13 }, (_, i) => i);
  return (
    <svg className={styles.pleats} viewBox="0 0 260 160" aria-hidden="true">
      <path className={styles.pleatRim} d={`M10 30 ${pleats.map(() => "q 10 -14 20 0").join(" ")}`} />
      {pleats.map((i) => (
        <path key={i} className={styles.pleatLine} d={`M${20 + i * 18} 36 L${48 + i * 13.5} 150`} />
      ))}
      <path className={styles.pleatBase} d="M44 150 H226" />
    </svg>
  );
}

export default function ProfileRenderer({ demo, profile }: { demo: DemoView; profile: DesignProfile }) {
  const rows = infoRows(demo);
  const address = rows.find((r) => r.key === "address");
  const others = rows.filter((r) => r !== address);
  const motifs = new Set(profile.motifs);
  const mark = monogram(demo.name);
  const lines = profile.heroLayout.layout === "split_crop" ? nameLines(demo.name) : [demo.name];
  const labels = motifs.has("location_labels") ? locationLabels(demo) : [];
  const t = profile.typography;

  return (
    <DemoFrame
      shopName={demo.name}
      template={demo.template}
      className={`${styles.root} ${editorial.variable} ${grotesk.variable}`}
      style={tokens(profile)}
    >
      <div
        className={styles.canvas}
        data-direction={profile.direction}
        data-display={t.display}
        data-body={t.body}
        data-case={t.displayCase}
        data-weight={t.displayWeight}
        data-tracking={t.tracking}
        data-grid={profile.composition.grid}
        data-info={profile.composition.infoStyle}
        data-divider={profile.composition.divider}
        data-align={profile.heroLayout.alignment}
        data-spacing={profile.spacing.scale}
        data-intro={profile.motion.intro}
        data-fade={profile.motion.sectionFade ? "" : undefined}
      >
        <header className={styles.hero} data-layout={profile.heroLayout.layout} data-height={profile.heroLayout.height}>
          {motifs.has("ruled_frame") && <span className={styles.frame} aria-hidden="true" />}
          {motifs.has("corner_marks") && (
            <span className={styles.corners} aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
          )}
          {motifs.has("dot_grid") && <span className={styles.dots} aria-hidden="true" />}

          <div className={styles.folio}>
            <span lang="en">{CATEGORY_EN[demo.category]}</span>
            {motifs.has("monogram") && !motifs.has("stamp_ring") && (
              <span className={styles.monogram} aria-hidden="true">
                {mark}
              </span>
            )}
            <span className={styles.labels} lang="en">
              {labels.length > 0
                ? labels.map((label) => (
                    <span key={label} className={styles.label}>
                      {label}
                    </span>
                  ))
                : null}
            </span>
          </div>

          <div className={styles.title}>
            <h1 className={styles.name} style={nameSizing(demo.name)} data-lines={lines.length}>
              {lines.map((line, i) => (
                <span key={`${i}-${line}`} className={styles.line}>
                  {i > 0 ? " " : null}
                  <span className={styles.lineText}>{line}</span>
                </span>
              ))}
            </h1>
          </div>

          <p className={styles.dek}>
            <span className={styles.rule} aria-hidden="true" />
            <span>{areaLabel(demo)}</span>
          </p>

          {motifs.has("stamp_ring") && (
            <span className={styles.stamp} aria-hidden="true">
              <span className={styles.stampMark}>{mark}</span>
            </span>
          )}
          {motifs.has("muffin_paper_svg") && <PleatsArt />}
        </header>

        <main className={styles.main}>
          {demo.description && (
            <section className={styles.section} aria-labelledby="pr-about">
              <h2 id="pr-about" className={styles.heading}>
                <span lang="en">About</span>
              </h2>
              <p className={styles.lead}>{demo.description}</p>
            </section>
          )}

          {demo.menuItems.length > 0 && (
            <section className={styles.section} aria-labelledby="pr-menu">
              <h2 id="pr-menu" className={styles.heading}>
                <span lang="en">Menu</span>
                <span className={styles.headingJa}>メニュー</span>
              </h2>
              <ol className={styles.menu}>
                {demo.menuItems.map((item, i) => (
                  <li key={`${i}-${item}`} className={styles.menuItem}>
                    <span className={styles.menuNo}>{ordinal(i)}</span>
                    <span className={styles.menuName}>{item}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {rows.length > 0 && (
            <section className={styles.section} aria-labelledby="pr-visit" data-single={rows.length === 1 ? "" : undefined}>
              <h2 id="pr-visit" className={styles.heading}>
                <span lang="en">Visit</span>
                <span className={styles.headingJa}>店舗のご案内</span>
              </h2>
              <div className={styles.visit}>
                {address && (
                  <div className={styles.address}>
                    <p className={styles.rowLabel}>
                      <span lang="en" className={styles.rowEn}>
                        {ROW_EN.address}
                      </span>
                      <span>{address.label}</span>
                    </p>
                    <p className={styles.addressValue}>{address.value}</p>
                    {labels.length > 0 && (
                      <p className={styles.addressTags} lang="en" aria-hidden="true">
                        {labels.map((label) => (
                          <span key={label}>{label}</span>
                        ))}
                      </p>
                    )}
                  </div>
                )}
                {others.length > 0 && (
                  <dl className={styles.rows}>
                    {others.map((row) => (
                      <div key={row.key} className={styles.row}>
                        <dt className={styles.rowLabel}>
                          <span lang="en" className={styles.rowEn}>
                            {ROW_EN[row.key]}
                          </span>
                          <span>{row.label}</span>
                        </dt>
                        <dd className={styles.rowValue}>{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </section>
          )}
        </main>
      </div>
    </DemoFrame>
  );
}
