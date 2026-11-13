"use client";
/**
 * DEV-263i (Issue #263): 版を取り込む — the owner picks a reviewed package directory (package-local.ts's output, the
 * same one import-local.ts takes) and the browser sends its files to the server in three steps
 * (app/admin/sales/demos/[prospectId]/import/route.ts): begin (package.json, checked; nothing written), put (each
 * page file not yet staged, with its sha256), finalize (package.json + the copy files; the server re-reads every page
 * file, runs the same checks as the local import and ingests with the facts from the facts store). Nothing the browser
 * says is taken as a verdict: the browser's own sha256 only stops a mismatched file early. A version appears only after
 * finalize; an interrupted import is resumed by running it again (the same files replay).
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import styles from "./demo.module.css";

type Step = { ok: true; [k: string]: unknown } | { ok: false; code: string; error: string; details?: string[] };
type Begin = { ok: true; pageFiles: { name: string; sha256: string; bytes: number; contentType: string; staged: boolean }[]; copyFiles: { name: string; bytes: number }[] };
type Finalize = { ok: true; versionNo: number; created: boolean; copyStatus: string };

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** relative path inside the picked directory (its own name dropped) → file */
function filesByPath(list: FileList): Map<string, File> {
  const out = new Map<string, File>();
  for (const f of Array.from(list)) {
    const rel = f.webkitRelativePath || f.name;
    const parts = rel.split("/");
    out.set(parts.length > 1 ? parts.slice(1).join("/") : rel, f);
  }
  return out;
}

export default function VersionImport({ prospectId, enabled }: { prospectId: string; enabled: boolean }) {
  const router = useRouter();
  const [files, setFiles] = useState<Map<string, File> | null>(null);
  const [status, setStatus] = useState<{ kind: "error" | "progress" | "done"; text: string } | null>(null);
  const [pending, start] = useTransition();
  // remounts the file input after an import, so picking the same folder again fires a change
  const [inputKey, setInputKey] = useState(0);
  const url = (step: string) => `/admin/sales/demos/${prospectId}/import?step=${step}`;

  const post = async (step: string, body: BodyInit, headers: Record<string, string> = {}): Promise<Step> => {
    const r = await fetch(url(step), { method: "POST", body, headers, credentials: "same-origin" });
    try {
      return (await r.json()) as Step;
    } catch {
      return { ok: false, code: `HTTP_${r.status}`, error: "取り込めませんでした。画面を再読み込みしてください。" };
    }
  };
  const fail = (s: Extract<Step, { ok: false }>) => setStatus({ kind: "error", text: `${s.error}（${s.code}${s.details?.length ? `: ${s.details.join(", ")}` : ""}）` });

  const run = () =>
    start(async () => {
      if (!files) return;
      const pkgFile = files.get("package.json");
      if (!pkgFile) return setStatus({ kind: "error", text: "選んだフォルダに package.json がありません（包みのフォルダを選んでください）。" });
      const packageJson = await pkgFile.text();
      setStatus({ kind: "progress", text: "包みを確かめています…" });
      const begin = await post("begin", packageJson, { "content-type": "application/json" });
      if (!begin.ok) return fail(begin);
      const plan = begin as Begin;
      const todo = plan.pageFiles.filter((f) => !f.staged);
      for (let i = 0; i < todo.length; i++) {
        const f = todo[i]!;
        const file = files.get(f.name);
        if (!file) return setStatus({ kind: "error", text: `頁のファイルがフォルダにありません: ${f.name}` });
        const bytes = await file.arrayBuffer();
        if (bytes.byteLength !== f.bytes || hex(await crypto.subtle.digest("SHA-256", bytes)) !== f.sha256) return setStatus({ kind: "error", text: `ファイルの中身が manifest と違います: ${f.name}` });
        setStatus({ kind: "progress", text: `頁のファイルを送っています（${i + 1} / ${todo.length}）…` });
        const put = await post("put", bytes, { "content-type": f.contentType, "x-content-sha256": f.sha256 });
        if (!put.ok) return fail(put);
      }
      const form = new FormData();
      form.append("package.json", new Blob([packageJson], { type: "application/json" }), "package.json");
      for (const c of plan.copyFiles) {
        const file = files.get(c.name);
        if (!file) return setStatus({ kind: "error", text: `文章のファイルがフォルダにありません: ${c.name}` });
        form.append(c.name, file, c.name.split("/").pop());
      }
      setStatus({ kind: "progress", text: "サーバーで検め直して、版にしています…" });
      const fin = await post("finalize", form);
      if (!fin.ok) return fail(fin);
      const done = fin as Finalize;
      setStatus({ kind: "done", text: done.created ? `版 v${done.versionNo} を取り込みました（下書き。品質と文章の承認はまだです）。` : `この包みはすでに版 v${done.versionNo} です（変更なし）。` });
      setFiles(null);
      setInputKey((k) => k + 1);
      router.refresh();
    });

  if (!enabled) return null;
  return (
    <section className={styles.panel} aria-labelledby="version-import-h" data-version-import="">
      <h2 id="version-import-h" className={styles.h2}>
        版を取り込む
      </h2>
      <p className={styles.note}>
        package-local.ts で作った包み（文章の監査つき、v2）のフォルダを選びます。サーバーがすべてのファイルを検め直し、店舗の事実は登録済みのものだけを使います。取り込んだ版は下書きで、品質と文章の承認は別にオーナーが行います。途中で止まったら、もう一度取り込むと続きから入ります。
      </p>
      <label className={styles.note}>
        包みのフォルダ
        <input
          key={inputKey}
          type="file"
          multiple
          {...{ webkitdirectory: "", directory: "" }}
          disabled={pending}
          onChange={(e) => {
            setStatus(null);
            setFiles(e.target.files && e.target.files.length ? filesByPath(e.target.files) : null);
          }}
          style={{ display: "block" }}
          data-version-import-input=""
        />
      </label>
      <p style={{ margin: "8px 0 0" }}>
        <button type="button" className={styles.primary} disabled={pending || !files} onClick={run}>
          版を取り込む
        </button>
      </p>
      {status && (
        <p className={status.kind === "error" ? styles.alert : styles.note} role={status.kind === "error" ? "alert" : "status"} data-version-import-result={status.kind}>
          {status.text}
        </p>
      )}
    </section>
  );
}
