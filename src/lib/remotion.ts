import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, openBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import type { CardProps, SubtitleProps } from '../../remotion/cards.tsx';
import { ROOT } from './env.ts';
import { tempPath } from './files.ts';

type Browser = Awaited<ReturnType<typeof openBrowser>>;

let served: Promise<string> | null = null;

/** Bundles the cards once per server run. */
function serveUrl(): Promise<string> {
  served ??= bundle({ entryPoint: join(ROOT, 'remotion', 'index.ts') }).catch(err => {
    served = null;
    throw err;
  });
  return served;
}

/** Opens one headless browser for a batch of renders. The first run downloads it (about 100 MB). */
export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  await ensureBrowser();
  const browser = await openBrowser('chrome');
  try {
    return await fn(browser);
  } finally {
    await browser.close({ silent: true });
  }
}

/**
 * Renders the intro or outro to a near-lossless H.264 file at `size`, the size of the video it joins;
 * the final encode happens once, later.
 */
export async function renderCard(browser: Browser, id: 'Intro' | 'Outro', props: CardProps, size: { width: number; height: number }, out: string, onProgress?: (f: number) => void): Promise<number> {
  const url = await serveUrl();
  const inputProps = props as unknown as Record<string, unknown>;
  const composition = { ...await selectComposition({ serveUrl: url, id, inputProps, puppeteerInstance: browser }), ...size };
  await renderMedia({
    composition,
    serveUrl: url,
    codec: 'h264',
    crf: 10,
    pixelFormat: 'yuv420p',
    colorSpace: 'bt709',
    imageFormat: 'png',
    muted: true,
    inputProps,
    outputLocation: tempPath(out),
    puppeteerInstance: browser,
    onProgress: ({ progress }) => onProgress?.(progress),
  });
  await rename(tempPath(out), out);
  return composition.durationInFrames / composition.fps;
}

/** Renders one frame of a composition to a PNG (transparent where the composition draws nothing). */
export async function renderPng(browser: Browser, id: 'Intro' | 'Subtitle', props: CardProps | SubtitleProps, out: string, frame = 0): Promise<void> {
  const url = await serveUrl();
  const inputProps = props as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl: url, id, inputProps, puppeteerInstance: browser });
  await renderStill({ composition, serveUrl: url, output: tempPath(out), inputProps, imageFormat: 'png', frame, puppeteerInstance: browser });
  await rename(tempPath(out), out);
}
