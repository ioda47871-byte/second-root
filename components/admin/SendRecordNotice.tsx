"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { recordedSendMessage, type RecordedSend } from "@/lib/sales/approval";
import styles from "./admin.module.css";

// DEV-197: after 送信済み the card leaves the today list (the outreach is
// sent), so what the database stored is shown here, above the list, from the
// action's result: a normal send, or an after-the-fact record of a send made
// after the shop became DNC / excluded. Never the card's own guess.

type Notice = { recorded: RecordedSend | null };

const SetNotice = createContext<(notice: Notice) => void>(() => {});

/** InitialSend reports what the database stored; outside the provider (tests) it does nothing. */
export const useSendRecordNotice = () => useContext(SetNotice);

export default function SendRecordNotice({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const r = notice?.recorded ?? null;
  return (
    <SetNotice.Provider value={setNotice}>
      {notice && (
        <p
          className={r && r.blockedAfterOpen === null ? styles.muted : styles.error}
          role="status"
          data-testid="send-recorded"
          data-recorded={r === null ? "unknown" : r.blockedAfterOpen === null ? "sent" : "blocked_after_open"}
          data-blocked-after-open={r?.blockedAfterOpen ?? ""}
          data-stale-at-send={r?.staleAtSend ? "true" : "false"}
        >
          {recordedSendMessage(r)}
        </p>
      )}
      {children}
    </SetNotice.Provider>
  );
}
