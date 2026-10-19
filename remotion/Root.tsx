import { Composition, Still } from 'remotion';
import { Intro, Outro, Subtitle } from './cards.tsx';
import type { Brand, CardProps, SubtitleProps } from './cards.tsx';

/** Lengths in frames at 30 fps. The server reads these back through selectComposition. */
export const INTRO_FRAMES = 105;
export const OUTRO_FRAMES = 150;

const brand: Brand = {
  name: 'Shakhawat Hossain',
  series: 'Salesforce',
  colors: { background: '#ECEEEA', text: '#232528', muted: '#5E6265', accent: '#2443C4' },
  fontData: null,
  logo: null,
  outro: { title: 'Thanks for watching.', line: 'Questions go in the comments.' },
};
const card: CardProps = { title: 'Build a screen flow that creates a case', brand };
const subtitle: SubtitleProps = { lines: ['Now, on the New Flow button,', 'click here.'], active: 5, brand };

export function Root() {
  return (
    <>
      <Composition id="Intro" component={Intro} durationInFrames={INTRO_FRAMES} fps={30} width={1920} height={1080} defaultProps={card} />
      <Composition id="Outro" component={Outro} durationInFrames={OUTRO_FRAMES} fps={30} width={1920} height={1080} defaultProps={card} />
      <Still id="Subtitle" component={Subtitle} width={1920} height={1080} defaultProps={subtitle} />
    </>
  );
}
