import { seekTo } from './ffmpeg.ts';
import { run } from './run.ts';

/**
 * SSIM between the frame on screen at `atA` in fileA and the frame on screen at `atB` in fileB (1 = identical).
 * `top` keeps only the top share of the picture, so burned-in subtitles do not count.
 */
export async function ssim(fileA: string, atA: number, fileB: string, atB: number, fps: number, top = 1): Promise<number> {
  const one = (1 / fps).toFixed(4);
  const crop = top < 1 ? `,crop=iw:ih*${top}:0:0` : '';
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-ss', seekTo(atA, fps).toFixed(4), '-t', one, '-i', fileA, '-ss', seekTo(atB, fps).toFixed(4), '-t', one, '-i', fileB,
    '-filter_complex', `[0:v]scale=960:540${crop}[a];[1:v]scale=960:540${crop}[b];[a][b]ssim`, '-an', '-f', 'null', '-']);
  return Number(stderr.match(/All:([\d.]+)/)?.[1] ?? 0);
}

/**
 * How many pixels differ by more than `pixelDiff` levels between the frames on screen at `atA` and `atB` in `file`,
 * at 960 × 540: the measure the screen analysis uses on neighbouring frames (see 03-analyze.ts).
 */
export async function changedPixels(file: string, atA: number, atB: number, fps: number, pixelDiff: number): Promise<number> {
  const one = (1 / fps).toFixed(4);
  // Both legs start at 0, or blend also pairs the first frame of one with nothing.
  const leg = (i: number) => `[${i}:v]setpts=PTS-STARTPTS,scale=960:540:flags=area,format=yuv420p[v${i}]`;
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-ss', seekTo(atA, fps).toFixed(4), '-t', one, '-i', file, '-ss', seekTo(atB, fps).toFixed(4), '-t', one, '-i', file,
    '-filter_complex', `${leg(0)};${leg(1)};[v0][v1]blend=all_mode=difference,lutyuv=y='if(gt(val,${pixelDiff}),255,0)',signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG`,
    '-an', '-f', 'null', '-']);
  const avg = stderr.match(/YAVG=([\d.]+)/);
  if (!avg) throw new Error(`Could not compare the frames at ${atA.toFixed(2)} s and ${atB.toFixed(2)} s of ${file}.`);
  return Math.round(Number(avg[1]) / 255 * 960 * 540);
}

/** Integrated loudness (LUFS) and true peak (dBTP) of a file's audio, per EBU R128, after an optional filter chain. */
export async function loudness(file: string, filter = ''): Promise<{ integrated: number; truePeak: number }> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-map', '0:a:0', '-af', `${filter ? `${filter},` : ''}ebur128=peak=true`, '-f', 'null', '-']);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  return {
    integrated: Number(summary.match(/I:\s+(-?[\d.]+|-inf) LUFS/)?.[1] ?? NaN),
    truePeak: Number(summary.match(/Peak:\s+(-?[\d.]+|-inf) dBFS/)?.[1] ?? NaN),
  };
}
