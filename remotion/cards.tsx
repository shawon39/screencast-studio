import { loadFont } from '@remotion/google-fonts/IBMPlexSans';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender, Easing, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

/** What the cards need from config/brand.json; files arrive as data URLs. */
export type Brand = {
  name: string;
  series: string;
  colors: { background: string; text: string; muted: string; accent: string };
  fontData: string | null;
  logo: string | null;
  outro: { title: string; line: string };
};

// Type aliases, not interfaces: Remotion needs props it can treat as a plain record.
export type CardProps = { title: string; brand: Brand };
export type SubtitleProps = { lines: string[]; active: number; brand: Brand };

const plex = loadFont('normal', { weights: ['400', '500', '600'], subsets: ['latin'] }).fontFamily;

/** The brand font if one was given, else IBM Plex Sans. */
function useFont(brand: Brand): string {
  const [family, setFamily] = useState(brand.fontData ? 'BrandFont' : plex);
  const [handle] = useState(() => (brand.fontData ? delayRender('Loading the brand font') : null));
  useEffect(() => {
    if (!brand.fontData || handle === null) return;
    const face = new FontFace('BrandFont', `url(${brand.fontData})`);
    face.load()
      .then(f => { document.fonts.add(f); setFamily('BrandFont'); })
      .catch(() => setFamily(plex))
      .finally(() => continueRender(handle));
  }, [brand.fontData, handle]);
  return family;
}

const PAD = 134; // 7% of the width, as in the design

function Card({ brand, children }: { brand: Brand; children: ReactNode }) {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [30, 44], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const font = useFont(brand);
  return (
    <AbsoluteFill style={{ background: brand.colors.background, color: brand.colors.text, fontFamily: font, padding: PAD, justifyContent: 'center' }}>
      {children}
      <div style={{ position: 'absolute', left: PAD, bottom: 115, fontSize: 46, fontWeight: 500, opacity: fade }}>{brand.name}</div>
      {brand.logo && (
        <Img src={brand.logo} style={{ position: 'absolute', right: PAD, bottom: 104, height: 134, maxWidth: 360, objectFit: 'contain', opacity: fade }} />
      )}
    </AbsoluteFill>
  );
}

/** 3.5 s: the series line fades in, the title rises, the blue rule draws left to right. */
export function Intro({ title, brand }: CardProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = spring({ frame: frame - 8, fps, config: { damping: 200 } });
  const topic = interpolate(frame, [4, 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const rule = interpolate(frame, [22, 48], [0, 38], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const long = title.length > 44;
  const titleStyle: CSSProperties = {
    fontSize: long ? 96 : 117,
    fontWeight: 600,
    lineHeight: 1.08,
    letterSpacing: '-0.02em',
    maxWidth: long ? '20ch' : '16ch',
    opacity: rise,
    transform: `translateY(${(1 - rise) * 24}px)`,
  };
  return (
    <Card brand={brand}>
      <div style={{ fontSize: 50, color: brand.colors.muted, marginBottom: 31, opacity: topic }}>{brand.series}</div>
      <div style={titleStyle}>{title}</div>
      <div style={{ height: 10, width: `${rule}%`, background: brand.colors.accent, marginTop: 65 }} />
    </Card>
  );
}

/** 5 s: the closing card rises in while the last screen fades into it. */
export function Outro({ brand }: CardProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = spring({ frame: frame - 6, fps, config: { damping: 200 } });
  return (
    <Card brand={brand}>
      <div style={{ fontSize: 100, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1, opacity: rise, transform: `translateY(${(1 - rise) * 20}px)` }}>
        {brand.outro.title}
      </div>
      <div style={{ fontSize: 50, color: brand.colors.muted, marginTop: 42, opacity: rise }}>{brand.outro.line}</div>
    </Card>
  );
}

/** A thin dark ring around each glyph (16 offsets) plus a soft shadow, so white text holds on a white page. */
const EDGE = [
  ...Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    return `${(Math.cos(a) * 1.9).toFixed(2)}px ${(Math.sin(a) * 1.9).toFixed(2)}px 0 rgba(18, 20, 22, 0.88)`;
  }),
  '0 0 2px rgba(18, 20, 22, 0.8)',
  '0 2px 12px rgba(0, 0, 0, 0.5)',
].join(', ');

/** Every word gets the same padding, so the words are spaced by it and moving the chip never shifts the line. */
const WORD: CSSProperties = { display: 'inline-block', padding: '0 0.16em', margin: '0 -0.04em', borderRadius: '0.2em' };

/**
 * One subtitle, two lines at most, small near the bottom with no box: white text with a thin dark
 * edge, and word `active` (counted across both lines) on a chip in the brand accent. Transparent elsewhere.
 */
export function Subtitle({ lines, active, brand }: SubtitleProps) {
  const font = useFont(brand);
  if (!lines.length) return <AbsoluteFill />;
  let n = 0;
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 62 }}>
      <div style={{
        maxWidth: '76%',
        textAlign: 'center',
        color: '#fff',
        fontFamily: font,
        fontWeight: 600,
        fontSize: 36,
        lineHeight: 1.36,
        letterSpacing: '-0.005em',
        WebkitFontSmoothing: 'antialiased',
      }}>
        {lines.map((l, i) => (
          <div key={i}>
            {l.split(' ').map((w, j) => n++ === active
              ? <span key={j} style={{ ...WORD, background: brand.colors.accent, boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)' }}>{w}</span>
              : <span key={j} style={{ ...WORD, textShadow: EDGE }}>{w}</span>)}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
}
