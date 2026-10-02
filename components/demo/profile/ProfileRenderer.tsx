import type { CSSProperties } from "react";
import type { RenderFeature, RenderPhoto, RenderPhotos } from "@/lib/design-agent/assets/resolve";
import type { DesignProfile } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "../DemoFrame";
import { areaLabel, infoRows } from "../info";
import { editorial, grotesk } from "./fonts";
import { keepTogether, locationLabels, monogram, nameLines, nameSizing, ordinal } from "./text";
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

/** A fact as text, with number runs ("1-2-3") kept on one line when it wraps. */
function FactText({ text }: { text: string }) {
  return keepTogether(text).map((part, i) =>
    part.keep ? (
      <span key={i} className={styles.keep} data-keep="">
        {part.text}
      </span>
    ) : (
      part.text
    ),
  );
}

const ratio = (aspect: string) => aspect.replace(":", " / ");
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/**
 * One photo (DEV-029). Its area is a grid cell of its own: no page text is ever
 * drawn over it. A generated image always carries the fixed "イメージ画像"
 * label, drawn here and not switchable by the profile or the direction.
 */
function PhotoFigure({ photo, className, role, side }: { photo: RenderPhoto; className: string; role: "hero" | RenderFeature["slot"]; side?: RenderFeature["side"] }) {
  const style = {
    "--ar": ratio(photo.aspect.mobile),
    "--ar-d": ratio(photo.aspect.desktop),
    "--fx": pct(photo.mobileFocal.x),
    "--fy": pct(photo.mobileFocal.y),
    "--fx-d": pct(photo.focal.x),
    "--fy-d": pct(photo.focal.y),
  } as CSSProperties;
  return (
    <figure className={`${styles.photo} ${className}`} data-asset={photo.assetId} data-role={role} data-fit={photo.fit} data-treatment={photo.treatment} data-source={photo.sourceKind} data-side={side} style={style}>
      {/* A local preview route: no image optimisation, no remote loader. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.photoImg} src={photo.src} alt="" width={photo.width} height={photo.height} loading="eager" decoding="async" />
      {photo.sourceKind === "generated_concept" && (
        <span className={styles.imageLabel} data-image-label="">
          イメージ画像
        </span>
      )}
    </figure>
  );
}

export default function ProfileRenderer({ demo, profile, photos = null }: { demo: DemoView; profile: DesignProfile; photos?: RenderPhotos | null }) {
  const rows = infoRows(demo);
  const address = rows.find((r) => r.key === "address");
  const others = rows.filter((r) => r !== address);
  const motifs = new Set(profile.motifs);
  const mark = monogram(demo.name);
  const lines = profile.heroLayout.layout === "split_crop" ? nameLines(demo.name) : [demo.name];
  const labels = motifs.has("location_labels") ? locationLabels(demo) : [];
  const t = profile.typography;
  const heroPhoto = photos?.hero ?? null;
  const split = photos?.layout === "split_hero" && heroPhoto !== null;
  const framed = photos?.layout === "framed_hero" && heroPhoto !== null;
  const feature = (slot: RenderFeature["slot"]) => photos?.features.find((f) => f.slot === slot) ?? null;
  const aboutPhoto = feature("about");
  const visitPhoto = feature("visit");

  const hero = (
    <header
      className={styles.hero}
      data-layout={profile.heroLayout.layout}
      data-height={profile.heroLayout.height}
      data-photo={split ? "split" : framed ? "framed" : undefined}
      data-photo-section={framed ? "hero" : undefined}
    >
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

      {(motifs.has("stamp_ring") || motifs.has("muffin_paper_svg")) && (
        <div className={styles.motifRow} aria-hidden="true">
          {motifs.has("stamp_ring") && (
            <span className={styles.stamp}>
              <span className={styles.stampMark}>{mark}</span>
            </span>
          )}
          {motifs.has("muffin_paper_svg") && <PleatsArt />}
        </div>
      )}

      {framed && <PhotoFigure photo={heroPhoto} className={styles.framePhoto} role="hero" />}

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
    </header>
  );

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
        {split ? (
          <div className={styles.heroSplit} data-photo-section="hero">
            <PhotoFigure photo={heroPhoto} className={styles.splitPhoto} role="hero" />
            {hero}
          </div>
        ) : (
          hero
        )}

        <main className={styles.main}>
          {demo.description && (
            <section className={styles.section} aria-labelledby="pr-about" data-photo-section={aboutPhoto ? "about" : undefined}>
              <h2 id="pr-about" className={styles.heading}>
                <span lang="en">About</span>
              </h2>
              <p className={styles.lead}>{demo.description}</p>
              {aboutPhoto && <PhotoFigure photo={aboutPhoto} className={styles.band} role="about" side={aboutPhoto.side} />}
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
            <section className={styles.section} aria-labelledby="pr-visit" data-single={rows.length === 1 ? "" : undefined} data-photo-section={visitPhoto ? "visit" : undefined}>
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
                    <p className={styles.addressValue}>
                      <FactText text={address.value} />
                    </p>
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
                        <dd className={styles.rowValue}>
                          <FactText text={row.value} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
              {visitPhoto && <PhotoFigure photo={visitPhoto} className={styles.band} role="visit" side={visitPhoto.side} />}
            </section>
          )}
        </main>
      </div>
    </DemoFrame>
  );
}
