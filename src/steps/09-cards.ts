import { rename } from 'node:fs/promises';
import type { Step } from '../pipeline.ts';
import { brandInputs, loadBrand } from '../lib/brand.ts';
import { ffmpeg, probe } from '../lib/ffmpeg.ts';
import { readJson, tempPath } from '../lib/files.ts';
import { renderCard, renderPng, withBrowser } from '../lib/remotion.ts';
import type { Script } from '../lib/script.ts';

/**
 * Stage 9. The intro and outro cards (Remotion) at the size of the screen video, so they fade into it,
 * and the 16:9 thumbnail made from the intro's title frame.
 */
export const cardsStep: Step = {
  name: 'Rendering the intro and outro',
  phase: 'finish',
  weight: 2,
  inputs: ctx => [ctx.work('script.json'), ctx.work('master.mp4'), ...brandInputs()],
  outputs: ctx => [ctx.work('intro.mp4'), ctx.work('outro.mp4'), ctx.work('thumbnail.png')],

  async run(ctx) {
    const { title } = await readJson<Script>(ctx.work('script.json'));
    const { card } = await loadBrand();
    const props = { title, brand: card };
    const { width, height } = (await probe(ctx.work('master.mp4'))).video!;
    await withBrowser(async browser => {
      ctx.detail('Rendering the intro with your title, colors and logo.');
      await renderCard(browser, 'Intro', props, { width, height }, ctx.work('intro.mp4'), f => ctx.progress(f * 0.5));
      ctx.detail('Rendering the outro.');
      await renderCard(browser, 'Outro', props, { width, height }, ctx.work('outro.mp4'), f => ctx.progress(0.5 + f * 0.4));
      await renderPng(browser, 'Intro', props, ctx.work('thumbnail-full.png'), 80);
    });
    const thumb = ctx.work('thumbnail.png');
    await ffmpeg(['-i', ctx.work('thumbnail-full.png'), '-vf', 'scale=1280:720:flags=lanczos', tempPath(thumb)]);
    await rename(tempPath(thumb), thumb);
  },
};
