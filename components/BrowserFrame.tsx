type Props = {
  src: string;
  alt: string;
  aspectRatio: number;
  url?: string;
};

export default function BrowserFrame({ src, alt, aspectRatio, url = "secondroot.jp" }: Props) {
  return (
    <div className="browser-frame">
      <div className="browser-frame-bar">
        <span className="browser-frame-dot" />
        <span className="browser-frame-dot" />
        <span className="browser-frame-dot" />
        <span className="browser-frame-url">{url}</span>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="shot" src={src} alt={alt} style={{ aspectRatio }} />
    </div>
  );
}
