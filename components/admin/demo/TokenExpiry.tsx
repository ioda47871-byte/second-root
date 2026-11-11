"use client";
/** DEV-196d-3 (spec §6.6): the view tokens last 15 minutes; after that the renders and frame 404, so say so and offer a reload. */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TOKEN_EXPIRED_TEXT } from "@/lib/sales/demo-version/admin-messages";
import styles from "./demo.module.css";

export default function TokenExpiry({ seconds }: { seconds: number }) {
  const router = useRouter();
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setExpired(true), Math.max(0, seconds - 30) * 1000);
    return () => clearTimeout(t);
  }, [seconds]);
  if (!expired) return null;
  return (
    <p className={styles.warn} role="status">
      {TOKEN_EXPIRED_TEXT}{" "}
      <button
        type="button"
        className={styles.tab}
        onClick={() => {
          setExpired(false);
          router.refresh();
        }}
      >
        再読み込み
      </button>
    </p>
  );
}
