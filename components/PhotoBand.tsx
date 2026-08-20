import type { ReactNode, CSSProperties } from "react";

type Props = {
  src: string;
  alt?: string;
  objectPosition?: CSSProperties["objectPosition"];
  align?: "left" | "right";
  children: ReactNode;
};

/**
 * The Hero's language generalized: a full-bleed photo, a white gradient
 * scrim, and a short statement resting in the resulting whitespace.
 * Centralized here so that swapping in real photography later — or
 * retuning the scrim/position for a specific shot — only has to happen
 * in one place instead of six.
 */
export default function PhotoBand({ src, alt = "", objectPosition = "center", align = "left", children }: Props) {
  return (
    <div className={`photo-band${align === "right" ? " photo-band--right" : ""} reveal reveal-media`}>
      <div className="photo-band-img">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} style={{ objectPosition }} />
      </div>
      <div className="photo-band-scrim" aria-hidden="true" />
      <div className="photo-band-content">{children}</div>
    </div>
  );
}
