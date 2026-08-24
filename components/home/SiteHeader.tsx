"use client";

import { useState } from "react";
import { RootMark, IconMail } from "./Decor";
import { NAV } from "./nav";

export default function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="hdr">
      <div className="hdr-in">
        <a className="hdr-logo" href="#home" onClick={() => setOpen(false)}>
          <RootMark className="logo-mark" style={{ color: "var(--green)" }} />
          <span>
            <span className="logo-name">Second Root</span>
            <br />
            <span className="logo-sub">WEB DESIGN STUDIO</span>
          </span>
        </a>

        <nav className="hdr-nav">
          {NAV.map((n) => (
            <a key={n.href} href={n.href}>
              {n.label}
            </a>
          ))}
        </nav>

        <a className="btn btn--green btn--sm hdr-cta" href="#contact" data-ga="header_cta_click">
          <IconMail className="" />
          無料診断を申し込む
        </a>

        <button
          type="button"
          className={`burger${open ? " is-open" : ""}`}
          aria-label="メニューを開く"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
      </div>

      {open && (
        <div className="mnav">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} onClick={() => setOpen(false)}>
              {n.label}
            </a>
          ))}
          <a className="btn btn--green" href="#contact" onClick={() => setOpen(false)}>
            <IconMail className="" />
            無料診断を申し込む
          </a>
        </div>
      )}
    </header>
  );
}
