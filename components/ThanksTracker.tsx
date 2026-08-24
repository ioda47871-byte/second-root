"use client";

import { useEffect } from "react";

type GtagWindow = Window & {
  gtag?: (command: string, eventName: string, params?: Record<string, unknown>) => void;
};

/**
 * Fires contact_submit_success once, on the page the form redirects to.
 * Kept here rather than inside ContactForm so the form's submit/validation
 * path stays untouched. No-ops when GA is absent (dev / preview).
 */
export default function ThanksTracker() {
  useEffect(() => {
    const w = window as GtagWindow;
    if (typeof w.gtag === "function") w.gtag("event", "contact_submit_success");
  }, []);
  return null;
}
