type Props = {
  src: string;
  alt: string;
  aspectRatio: number;
  className?: string;
};

export default function PhoneFrame({ src, alt, aspectRatio, className }: Props) {
  return (
    <div className={className ? `phone-frame ${className}` : "phone-frame"}>
      <div className="phone-bezel">
        <div className="phone-notch" />
        <div className="phone-screen">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="shot" src={src} alt={alt} style={{ aspectRatio }} />
        </div>
      </div>
    </div>
  );
}
