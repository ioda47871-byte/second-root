/**
 * DEV-196d-4 (spec §4.1・§7.2・§7.5, display only): what changed between two versions — the hashes and facts, the
 * worker commit, the validator codes, the rights counts, the files, the structure descriptor's 8 aspects and the
 * page's visible text line by line. Every word is a fixed label, a fixed code, a vocabulary word or the page's own
 * visible text; no free text from a row.
 */
import type { CopyDiff } from "@/lib/admin/demo-compare";
import { RIGHTS_STATUS_LABEL } from "@/lib/sales/demo-version/admin-messages";
import type { FileChange, FileDiffEntry, StructureDiffEntry, VersionMetaDiff } from "@/lib/sales/demo-version/compare";
import styles from "./demo.module.css";

const CHANGE_LABEL: Record<FileChange, string> = { added: "追加", removed: "削除", changed: "変更", same: "同じ" };
const ASPECT_LABEL: Record<StructureDiffEntry["aspect"], string> = {
  hero: "ヒーロー",
  flow: "流れ",
  navigation: "ナビゲーション",
  reading_path: "読む順",
  section_layouts: "区画の配置",
  transitions: "区画のつなぎ",
  text_direction: "文字の向き",
  imagery: "画像の使い方",
};
const yesNo = (changed: boolean) => (changed ? "変わった" : "同じ");

export function MetaDiffTable({ meta, a, b }: { meta: VersionMetaDiff; a: string; b: string }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} data-compare="meta">
        <thead>
          <tr>
            <th scope="col">項目</th>
            <th scope="col">{a}</th>
            <th scope="col">{b}</th>
          </tr>
        </thead>
        <tbody>
          <tr className={meta.bundleChanged ? styles.changed : undefined}>
            <th scope="row">成果物の中身</th>
            <td colSpan={2}>{yesNo(meta.bundleChanged)}</td>
          </tr>
          <tr className={meta.factsChanged ? styles.changed : undefined} data-facts-changed={meta.factsChanged ? "true" : "false"}>
            <th scope="row">作ったときの店舗の事実</th>
            <td colSpan={2}>{meta.factsChanged ? "違う事実から作られています" : "同じ事実から作られています"}</td>
          </tr>
          <tr className={meta.workerCommit.changed ? styles.changed : undefined}>
            <th scope="row">作った worker の版</th>
            <td className={styles.mono}>{meta.workerCommit.a?.slice(0, 12) ?? "不明"}</td>
            <td className={styles.mono}>{meta.workerCommit.b?.slice(0, 12) ?? "不明"}</td>
          </tr>
          <tr className={meta.validator.added.length || meta.validator.removed.length || meta.validator.a.ok !== meta.validator.b.ok ? styles.changed : undefined}>
            <th scope="row">サーバーの検査</th>
            <td>
              {meta.validator.a.ok ? "合格" : "不合格"}
              {meta.validator.a.codes.length > 0 && <div className={styles.mono}>{meta.validator.a.codes.join(" ")}</div>}
            </td>
            <td>
              {meta.validator.b.ok ? "合格" : "不合格"}
              {meta.validator.b.codes.length > 0 && <div className={styles.mono}>{meta.validator.b.codes.join(" ")}</div>}
            </td>
          </tr>
          {meta.rights.length === 0 ? (
            <tr>
              <th scope="row">画像の権利</th>
              <td colSpan={2}>どちらにも写真はありません</td>
            </tr>
          ) : (
            meta.rights.map((r) => (
              <tr key={r.status} className={r.a !== r.b ? styles.changed : undefined}>
                <th scope="row">画像: {RIGHTS_STATUS_LABEL[r.status]}</th>
                <td>{r.a} 枚</td>
                <td>{r.b} 枚</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function FilesDiffTable({ entries, counts }: { entries: FileDiffEntry[]; counts: Record<FileChange, number> }) {
  return (
    <>
      <p className={styles.sub} data-file-counts={`${counts.added}/${counts.removed}/${counts.changed}/${counts.same}`}>
        追加 {counts.added}・削除 {counts.removed}・変更 {counts.changed}・同じ {counts.same}
      </p>
      <div className={styles.tableWrap}>
        <table className={styles.table} data-compare="files">
          <thead>
            <tr>
              <th scope="col">ファイル</th>
              <th scope="col">変化</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.name} className={e.change === "same" ? undefined : styles.changed} data-file={e.name} data-change={e.change}>
                <td className={styles.mono}>{e.name}</td>
                <td>{CHANGE_LABEL[e.change]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function StructureDiffTable({ entries, a, b }: { entries: StructureDiffEntry[]; a: string; b: string }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} data-compare="structure">
        <thead>
          <tr>
            <th scope="col">観点</th>
            <th scope="col">{a}</th>
            <th scope="col">{b}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.aspect} className={e.changed ? styles.changed : undefined} data-aspect={e.aspect} data-changed={e.changed ? "true" : "false"}>
              <th scope="row">{ASPECT_LABEL[e.aspect]}</th>
              <td className={styles.mono}>{e.a ?? "計測なし"}</td>
              <td className={styles.mono}>{e.b ?? "計測なし"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.note}>同じ語が並ぶほど構成が近い版です。両方とも「計測なし」の観点は同じとは扱いません。</p>
    </div>
  );
}

const UNAVAILABLE_SIDE = { a: "比べる元の版", b: "比べる版", both: "両方の版" } as const;

export function CopyDiffList({ copy }: { copy: CopyDiff }) {
  if (copy.kind === "unavailable") {
    return (
      <p className={styles.warn} role="status" data-copy="unavailable">
        {UNAVAILABLE_SIDE[copy.side]}の頁を読めないため、文の差分は出せません（表示できない版か、成果物を読み出せませんでした）。
      </p>
    );
  }
  if (!copy.result.ok) {
    return (
      <p className={styles.warn} role="status" data-copy="too-large">
        文が多すぎるため、差分を出しません。
      </p>
    );
  }
  const { ops, added, removed } = copy.result;
  return (
    <>
      <p className={styles.sub} data-copy-counts={`${added}/${removed}`}>
        追加 {added} 行・削除 {removed} 行。「事実」は店舗の事実と同じ文の行です。それ以外の行は、創作の見出しか、事実と一致しない文です（copy record が保存されていないため、区別しません）。
      </p>
      <ol className={styles.lines} data-copy="ok">
        {ops.map((o, i) => (
          <li key={i} className={o.op === "add" ? styles.lineAdd : o.op === "del" ? styles.lineDel : undefined} data-op={o.op} data-kind={o.kind}>
            <span className={styles.tag}>{o.op === "add" ? "＋" : o.op === "del" ? "−" : "＝"}</span> {o.kind === "fact" && <span className={styles.tag}>事実</span>} {o.text}
          </li>
        ))}
      </ol>
    </>
  );
}
