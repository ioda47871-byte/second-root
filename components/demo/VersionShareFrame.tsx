import styles from "./demo.module.css";

// DEV-196g (spec §6.1・§6.7・§6.8, MVP_SPEC §7): the trusted outer frame of a shared demo VERSION. The notice and the
// footer are drawn here, by the app, never by the version's page; the page itself is a sandboxed iframe (no
// allow-* at all: an opaque origin, no script, no form, no top navigation) from the dedicated artifact origin, with no
// referrer and no permission. Same wording as the React demo's frame (components/demo/DemoFrame.tsx).

export default function VersionShareFrame({ shopName, frameSrc }: { shopName: string; frameSrc: string }) {
  return (
    <div className={styles.page} data-share-version="">
      <p className={styles.notice} role="note">
        これは <strong>Second Root</strong> が作成した<strong>ご提案用のデモページ</strong>です。{shopName}
        様の公式サイトではありません。
      </p>
      <iframe
        src={frameSrc}
        title={`${shopName}様向けのご提案用デモ`}
        sandbox=""
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{ display: "block", width: "100%", height: "calc(100vh - 7rem)", minHeight: "32rem", border: 0 }}
      />
      <footer className={styles.footer}>
        <p>
          このページは、{shopName}様に向けて Second Root が公開情報をもとに作成したデモです。
          <br />
          掲載内容は確認できた公開情報のみで、公式サイト・公式情報ではありません。
        </p>
        <p>
          <a href="https://secondroot.jp" rel="noopener">
            Second Root（セカンドルート）｜名古屋の小さなお店のホームページ制作
          </a>
        </p>
      </footer>
    </div>
  );
}
