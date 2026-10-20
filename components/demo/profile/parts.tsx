import type { CSSProperties } from "react";
import type { RenderFeature, RenderPhoto } from "@/lib/design-agent/assets/resolve";
import { keepTogether } from "./text";
import styles from "./profile.module.css";

// Small pieces shared by the profile renderer and its sections (DEV-071a moved
// them out of ProfileRenderer.tsx unchanged).

/** English labels of the information rows (fixed words). */
export const ROW_EN = { hours: "Hours", closedDays: "Closed", address: "Address", access: "Access", phone: "Tel" } as const;

/** A fact as text, with number runs ("1-2-3") kept on one line when it wraps. */
export function FactText({ text }: { text: string }) {
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
 * drawn over it, and nothing is drawn on the photo. Only approved_real photos
 * exist (DEV-070 removed generated images and their label).
 */
export function PhotoFigure({ photo, className, role, side }: { photo: RenderPhoto; className: string; role: "hero" | RenderFeature["slot"]; side?: RenderFeature["side"] }) {
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
      <img className={styles.photoImg} src={photo.src} alt="" width={photo.width} height={photo.height} loading="eager" decoding="sync" />
    </figure>
  );
}
