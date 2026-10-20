import type { RenderFeature } from "@/lib/design-agent/assets/resolve";
import type { InfoRow } from "../../info";
import { FactText, PhotoFigure, ROW_EN } from "../parts";
import styles from "../profile.module.css";
import sx from "../sections.module.css";
import { Heading, sectionAttrs, type SectionProps } from "./common";

// Visit: the address, access, phone and — when there is no hours section —
// the hours and closed days (facts). Rows without a value are never drawn.
//   ledger   the address block beside the ruled rows (the page before Stage 1)
//   cards    every row as a card of its own
//   split    the address large in one column, the other rows compact in the other
//   stacked  one centred column, each label over its value

function Label({ row, as: Tag }: { row: InfoRow; as: "p" | "dt" }) {
  return (
    <Tag className={styles.rowLabel}>
      <span lang="en" className={styles.rowEn}>
        {ROW_EN[row.key]}
      </span>
      <span>{row.label}</span>
    </Tag>
  );
}

function AddressTags({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <p className={styles.addressTags} lang="en" aria-hidden="true">
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </p>
  );
}

export default function Visit({ rows, labels, photo, spec, headings }: SectionProps<"visit"> & { rows: InfoRow[]; labels: string[]; photo: RenderFeature | null }) {
  const variant = spec?.variant ?? "ledger";
  const address = rows.find((r) => r.key === "address");
  const others = rows.filter((r) => r !== address);
  const ordered = address ? [address, ...others] : others;

  let body;
  if (variant === "ledger" || (variant === "split" && !address)) {
    body = (
      <div className={styles.visit}>
        {address && (
          <div className={styles.address}>
            <Label row={address} as="p" />
            <p className={styles.addressValue}>
              <FactText text={address.value} />
            </p>
            <AddressTags labels={labels} />
          </div>
        )}
        {others.length > 0 && (
          <dl className={styles.rows}>
            {others.map((row) => (
              <div key={row.key} className={styles.row}>
                <Label row={row} as="dt" />
                <dd className={styles.rowValue}>
                  <FactText text={row.value} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    );
  } else if (variant === "split") {
    body = (
      <div className={sx.split}>
        <div className={sx.splitMain}>
          <Label row={address!} as="p" />
          <p className={`${styles.addressValue} ${sx.splitAddress}`}>
            <FactText text={address!.value} />
          </p>
          <AddressTags labels={labels} />
        </div>
        {others.length > 0 && (
          <dl className={sx.splitRows}>
            {others.map((row) => (
              <div key={row.key} className={sx.splitRow}>
                <Label row={row} as="dt" />
                <dd className={sx.value}>
                  <FactText text={row.value} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    );
  } else {
    body = (
      <dl className={variant === "cards" ? sx.cards : sx.stacked} data-count={ordered.length}>
        {ordered.map((row) => (
          <div key={row.key} className={variant === "cards" ? sx.card : sx.stackRow} data-key={row.key}>
            <Label row={row} as="dt" />
            <dd className={sx.value}>
              <FactText text={row.value} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return (
    <section {...sectionAttrs(spec, rows.length <= 2)} aria-labelledby="pr-visit" data-single={rows.length === 1 ? "" : undefined} data-photo-section={photo ? "visit" : undefined}>
      <Heading kind="visit" headings={headings} layout={spec !== null} />
      {body}
      {photo && <PhotoFigure photo={photo} className={styles.band} role="visit" side={photo.side} />}
    </section>
  );
}
