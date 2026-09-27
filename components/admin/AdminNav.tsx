"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./admin.module.css";

const ITEMS = [
  { href: "/admin/sales", label: "今日" },
  { href: "/admin/sales/replies", label: "返信" },
  { href: "/admin/sales/meetings", label: "商談" },
  { href: "/admin/sales/history", label: "履歴" },
] as const;

export default function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className={styles.nav} aria-label="営業管理">
      {ITEMS.map((item) => {
        const active = item.href === "/admin/sales" ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} className={styles.navItem} aria-current={active ? "page" : undefined}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
