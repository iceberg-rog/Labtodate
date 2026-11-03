import { ImageResponse } from 'next/og';

// Share card for og:image / twitter:image on every page that does not set its
// own. next/og renders it at build time, so it needs no font files, no network
// and no runtime work. Keep the markup satori-safe: flexbox only, and every
// element with more than one child carries an explicit display:flex.
export const alt = 'Labtodate — refurbished and surplus lab equipment marketplace';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const LIME = '#A3E635';
const INK = '#031110';

function Dot({ size: d, opacity }: { size: number; opacity: number }) {
  return (
    <div
      style={{
        width: d,
        height: d,
        borderRadius: 999,
        backgroundColor: LIME,
        opacity,
        marginRight: 10,
      }}
    />
  );
}

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 76,
          backgroundColor: INK,
          backgroundImage:
            'radial-gradient(circle at 78% 22%, rgba(163,230,53,0.26), rgba(3,17,16,0) 58%)',
          color: '#FFFFFF',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Dot size={18} opacity={1} />
          <Dot size={12} opacity={0.75} />
          <Dot size={8} opacity={0.5} />
          <div
            style={{
              marginLeft: 14,
              fontSize: 24,
              letterSpacing: 7,
              color: LIME,
            }}
          >
            MOLECULAR ANALYSIS
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 118, fontWeight: 700, letterSpacing: -3, lineHeight: 1.05 }}>
            Labtodate
          </div>
          <div
            style={{
              marginTop: 18,
              fontSize: 38,
              lineHeight: 1.3,
              color: 'rgba(255,255,255,0.74)',
            }}
          >
            Refurbished &amp; surplus laboratory equipment, across Europe.
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div
              style={{
                padding: '10px 22px',
                borderRadius: 999,
                backgroundColor: LIME,
                color: INK,
                fontSize: 24,
                fontWeight: 600,
              }}
            >
              14-point inspection
            </div>
            <div style={{ marginLeft: 20, fontSize: 24, color: 'rgba(255,255,255,0.6)' }}>
              Quote, proforma and insured shipping
            </div>
          </div>
          <div style={{ fontSize: 28, color: 'rgba(255,255,255,0.85)' }}>labtodate.com</div>
        </div>
      </div>
    ),
    size,
  );
}
