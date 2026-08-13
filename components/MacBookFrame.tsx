type Props = {
  src: string;
  alt: string;
  /** width / height of the source image, used to crop the bottom watermark strip only */
  aspectRatio: number;
};

export default function MacBookFrame({ src, alt, aspectRatio }: Props) {
  return (
    <div className="macbook-frame">
      <div className="macbook-screen">
        <div className="macbook-camera" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="shot" src={src} alt={alt} style={{ aspectRatio }} />
      </div>
      <div className="macbook-hinge" />
      <div className="macbook-base" />
    </div>
  );
}
