import { Fragment, type CSSProperties } from "react";
import type { RenderFeature, RenderPhotos } from "@/lib/design-agent/assets/resolve";
import { DEFAULT_LAYOUT, normalizeLayout } from "@/lib/design-agent/layout";
import type { DesignProfile } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "../DemoFrame";
import { areaLabel, infoRows } from "../info";
import { displayFaceVariables } from "./fonts";
import { PhotoFigure } from "./parts";
import About from "./sections/About";
import FirstView from "./sections/FirstView";
import Hours from "./sections/Hours";
import Menu from "./sections/Menu";
import Visit from "./sections/Visit";
import { locationLabels, monogram, nameLines, nameSizing, nameTokens, phoneNameLines, setsInPieces } from "./text";
import styles from "./profile.module.css";
import sx from "./sections.module.css";

// Shared renderer for design profiles (DEV-028). Every word on the page comes
// from the fact-only DemoView or from fixed template copy (headings, the
// English category, romanised ward, the name's own initials). The profile
// only switches visual settings, through data attributes and colour tokens;
// it can never add text.
//
// Stage 1 (DEV-071a): a profile may carry a `layout` (the Design Spec): the
// first view, the sections in order with their variant and ground, and the
// type hierarchy. It is normalized against the facts before drawing
// (lib/design-agent/layout.ts), so a section without facts is never drawn and
// every fact stays on the page. A profile without `layout` draws the page
// before Stage 1 with exactly its markup (DEFAULT_LAYOUT, no layout attributes).

const CATEGORY_EN: Record<DemoView["category"], string> = { bakery: "Bakery", baked_goods: "Baked Goods", cafe: "Cafe" };

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

export default function ProfileRenderer({ demo, profile, photos = null }: { demo: DemoView; profile: DesignProfile; photos?: RenderPhotos | null }) {
  const rows = infoRows(demo);
  // null: no layout — the page before Stage 1, without any layout attribute
  const spec = profile.layout ? normalizeLayout(profile.layout, demo).layout : null;
  const sections = (spec ?? normalizeLayout(DEFAULT_LAYOUT, demo).layout).sections;
  const headings = spec?.type.headings ?? "en_ja";
  const firstView = spec?.firstView ?? "name_only";
  const hoursSection = sections.some((s) => s.kind === "hours");
  const hourRows = rows.filter((r) => r.key === "hours" || r.key === "closedDays");
  const visitRows = hoursSection ? rows.filter((r) => !hourRows.includes(r)) : rows;
  const motifs = new Set(profile.motifs);
  const mark = monogram(demo.name);
  // An unspaced or Japanese name (DEV-034) is set from unbreakable pieces, on the lines
  // a phone uses; a spaced Latin name keeps breaking at its spaces as before.
  const unspaced = setsInPieces(demo.name);
  const lines = unspaced ? phoneNameLines(demo.name) : profile.heroLayout.layout === "split_crop" ? nameLines(demo.name) : [demo.name];
  const labels = motifs.has("location_labels") ? locationLabels(demo) : [];
  const t = profile.typography;
  const heroPhoto = photos?.hero ?? null;
  const split = photos?.layout === "split_hero" && heroPhoto !== null;
  const framed = photos?.layout === "framed_hero" && heroPhoto !== null;
  const feature = (slot: RenderFeature["slot"]) => photos?.features.find((f) => f.slot === slot) ?? null;
  // a feature photo sits in its section, and only when that section is drawn
  const has = (kind: RenderFeature["slot"]) => sections.some((s) => s.kind === kind);
  const aboutPhoto = has("about") ? feature("about") : null;
  const visitPhoto = has("visit") ? feature("visit") : null;
  const vertical = firstView === "vertical_name";

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
        {unspaced ? (
          <h1 className={vertical ? `${styles.name} ${sx.vname}` : styles.name} style={nameSizing(demo.name)} data-lines={lines.length} data-fit="phone">
            {lines.map((line, i) => (
              <span key={`${i}-${line}`} className={styles.phoneLine}>
                {nameTokens(line).map((piece, j, all) => {
                  // a space after a piece stays outside it; one that ends a phone line is not shown there
                  const body = piece.replace(/\s+$/u, "");
                  const space = piece.slice(body.length);
                  return (
                    <Fragment key={`${j}-${piece}`}>
                      {body && <span className={styles.piece}>{body}</span>}
                      {space && j === all.length - 1 ? <span className={styles.lineEnd}>{space}</span> : space}
                    </Fragment>
                  );
                })}
              </span>
            ))}
          </h1>
        ) : (
          <h1 className={styles.name} style={nameSizing(demo.name)} data-lines={lines.length}>
            {lines.map((line, i) => (
              <span key={`${i}-${line}`} className={styles.line}>
                {i > 0 ? " " : null}
                <span className={styles.lineText}>{line}</span>
              </span>
            ))}
          </h1>
        )}
        {spec && <FirstView view={firstView} demo={demo} />}
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
      className={`${styles.root} ${displayFaceVariables}`}
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
        data-first-view={spec?.firstView}
        data-scale={spec?.type.scale}
        data-headings={spec?.type.headings}
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
          {sections.map((section) => {
            switch (section.kind) {
              case "about":
                return <About key="about" description={demo.description!} photo={aboutPhoto} spec={spec ? section : null} headings={headings} />;
              case "menu":
                return <Menu key="menu" items={demo.menuItems} spec={spec ? section : null} headings={headings} />;
              case "hours":
                return <Hours key="hours" rows={hourRows} spec={spec ? section : null} headings={headings} />;
              case "visit":
                return <Visit key="visit" rows={visitRows} labels={labels} photo={visitPhoto} spec={spec ? section : null} headings={headings} />;
            }
          })}
        </main>
      </div>
    </DemoFrame>
  );
}
