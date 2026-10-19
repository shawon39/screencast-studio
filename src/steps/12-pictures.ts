import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import type { Step } from '../pipeline.ts';
import { RATE } from '../lib/audio.ts';
import { ffmpeg, seekTo } from '../lib/ffmpeg.ts';
import { hashFile, hashJson, readJson, tempPath, writeJson } from '../lib/files.ts';
import { inParallel } from '../lib/run.ts';
import { bodyWords } from '../lib/subtitles.ts';
import { videoCutsOf } from '../lib/timemap.ts';
import type { Edl } from '../lib/timemap.ts';
import type { Voice } from './06-voice.ts';
import type { VoiceCut } from './08-render.ts';
import type { FinishInfo } from './10-finish.ts';
import type { CheckResult } from './11-check.ts';

/** Seconds shown on each side of a cut. */
const HALF_SEC = 1.5;
/** Frames in the strip; an odd number, so the middle one shows the cut. */
const FRAMES = 7;
/** Each frame is 256 × 144 in a 4 px border. The cells span the time axis, so each frame sits above the moment it shows. */
const CELL_W = 264;
const CELL_H = 152;
const WIDTH = FRAMES * CELL_W;
const WAVE_H = 200;
const LANE_H = 24;
/** Gaps between words at least this long are shaded as pauses, as in video-use's timeline_view. */
const PAUSE_SEC = 0.4;
/** A video cut closer than this to the one before it shares its picture: in a 3 s window the two look the same. */
const JOIN_SEC = 0.1;
/** Voice cuts and problems are marked in red, video cuts in amber. */
const COLOR = { background: '0x121216', panel: '0x1c1c22', wave: '0x8cb4ff', pause: '0x325078@0.5', word: '0x6e6e78', cut: '0xff4d4d', videoCut: '0xffb02e' };
const PARALLEL = 4;

/** The name of every picture this step draws in output/cuts. The server and the report match on it too. */
export const PICTURE_FILE = /^(cut|video|problem)-\d+\.png$/;

export interface CutPicture {
  /** Relative to output/. */
  file: string;
  /** The moment it shows, in the final video, in seconds. */
  at: number;
}

export interface CutPictures {
  /** One per entry in voice-cuts.json, in its order. */
  cuts: CutPicture[];
  /**
   * One per video cut (see videoCutsOf in timemap.ts) in time order, but cuts less than 0.1 s apart share
   * one, at the first of them, which marks the others. A video cut at a voice cut shares its picture.
   */
  videoCuts: CutPicture[];
  /** One per problem in check.json; null where a problem has no one place. A problem at a cut shares its picture. */
  problems: (CutPicture | null)[];
  /** What each file was drawn from, so an unchanged picture is not drawn again. */
  keys: Record<string, string>;
}

/** What one picture shows. Everything but the window and the frames is in pixels on the time axis. */
export interface PicturePlan {
  /** The window in the final video, in seconds. */
  start: number;
  span: number;
  /** One frame per cell, from the middle of the cell's time, counted from the frame on screen at the window start. */
  frames: number[];
  /** The cell holding the picture's moment, outlined. */
  cell: number;
  mark: number;
  /** The other voice cuts and video cuts in the window. */
  cuts: number[];
  videoCuts: number[];
  words: [number, number][];
  pauses: [number, number][];
  /** showwavespic gives each pixel column a whole number of samples, rounded down; this rate makes it exact, so the wave lines up with the marks. */
  audio: { rate: number; samples: number };
}

/**
 * Lays out the picture of moment `at` in the final video: the window, the frames, and where the words,
 * the pauses between them and the voice and video cuts fall on the time axis. Words and cuts are in final-video seconds.
 */
export function planPicture(at: number, o: { totalSec: number; fps: number; words: { start: number; end: number }[]; cuts: number[]; videoCuts: number[] }): PicturePlan {
  const span = Math.min(2 * HALF_SEC, o.totalSec);
  const start = Math.max(0, Math.min(at - HALF_SEC, o.totalSec - span));
  const end = start + span;
  const x = (t: number) => Math.round((Math.max(start, Math.min(end, t)) - start) / span * WIDTH);
  const words = o.words.filter(w => w.end > start && w.start < end);
  // The gaps before, between and after the words.
  const edges = [start, ...words.flatMap(w => [w.start, w.end]), end];
  const pauses: [number, number][] = [];
  for (let i = 0; i < edges.length; i += 2) {
    const a = Math.max(start, edges[i]);
    const b = Math.min(end, edges[i + 1]);
    if (b - a >= PAUSE_SEC) pauses.push([x(a), x(b)]);
  }
  const perColumn = Math.ceil(RATE * span / WIDTH);
  const others = (cuts: number[]) => cuts.filter(t => t >= start && t <= end && Math.abs(t - at) > 1e-3).map(x);
  return {
    start,
    span,
    frames: Array.from({ length: FRAMES }, (_, k) => Math.round((k + 0.5) * span / FRAMES * o.fps)),
    cell: Math.min(FRAMES - 1, Math.floor((at - start) / span * FRAMES)),
    mark: x(at),
    cuts: others(o.cuts),
    videoCuts: others(o.videoCuts),
    words: words.map(w => [x(w.start), x(w.end)]),
    pauses,
    audio: { rate: Math.round(perColumn * WIDTH / span), samples: perColumn * WIDTH },
  };
}

/** The video cuts that get a picture of their own: each that is at least 0.1 s after the one before it. */
export function ownPictures(times: number[]): number[] {
  return times.filter((t, i) => i === 0 || t - times[i - 1] >= JOIN_SEC - 1e-6);
}

/**
 * The frame strip over the waveform, a lane with the words below it, the pauses shaded and the cuts marked:
 * the picture's own moment in `color`, the other voice cuts in red and the other video cuts in amber.
 * The video is read from the frame on screen at the window start, the sound from that exact moment.
 */
function drawArgs(plan: PicturePlan, color: string, fps: number, final: string, out: string): string[] {
  const box = (x: number, y: number, w: number, h: number, color: string) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:t=fill:color=${color}`;
  const film = [
    `[0:v]select='${plan.frames.map(n => `eq(n\\,${n})`).join('+')}'`,
    `scale=${CELL_W - 8}:${CELL_H - 8}:flags=area`,
    `pad=${CELL_W}:${CELL_H}:4:4:color=${COLOR.background}`,
    `tile=${FRAMES}x1`,
    `drawbox=x=${plan.cell * CELL_W}:y=0:w=${CELL_W}:h=${CELL_H}:t=4:color=${color}[film]`,
  ].join(',');
  const { rate, samples } = plan.audio;
  const wave = `[1:a]aformat=channel_layouts=mono,aresample=${rate},apad=whole_len=${samples},atrim=end_sample=${samples},`
    + `showwavespic=s=${WIDTH}x${WAVE_H}:colors=${COLOR.wave}:scale=sqrt:filter=peak[wave]`;
  const panel = [`color=c=${COLOR.panel}:s=${WIDTH}x${WAVE_H}:d=1`, ...plan.pauses.map(([a, b]) => box(a, 0, b - a, WAVE_H, COLOR.pause))].join(',');
  const lane = [`color=c=${COLOR.background}:s=${WIDTH}x${LANE_H}:d=1`, ...plan.words.map(([a, b]) => box(a + 1, 6, Math.max(1, b - a - 2), LANE_H - 12, COLOR.word))].join(',');
  const marks = [
    ...plan.cuts.map(x => box(x, 0, 1, WAVE_H + LANE_H, `${COLOR.cut}@0.6`)),
    ...plan.videoCuts.map(x => box(x, 0, 1, WAVE_H + LANE_H, `${COLOR.videoCut}@0.6`)),
    box(plan.mark - 1, 0, 3, WAVE_H + LANE_H, color),
  ].join(',');
  const graph = [
    film,
    wave,
    `${panel}[panel]`,
    `${lane}[lane]`,
    '[panel][wave]overlay=format=auto[sound]',
    `[sound][lane]vstack,${marks}[below]`,
    `[film][below]vstack,pad=iw+32:ih+32:16:16:color=${COLOR.background},format=rgb24[out]`,
  ].join(';');
  const t = plan.span.toFixed(4);
  return ['-ss', seekTo(plan.start, fps).toFixed(4), '-t', t, '-i', final, '-ss', plan.start.toFixed(4), '-t', t, '-i', final,
    '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', out];
}

/**
 * Stage 12. A picture of every voice cut, every video cut and every problem with a time, so they can be seen
 * without watching the video: frames over the waveform for 3 s around it, the words below, the cut marked.
 * After Check, so drawing never makes Check run again. A picture is redrawn only when what it shows changed.
 */
export const picturesStep: Step = {
  name: 'Drawing a picture of each cut',
  phase: 'finish',
  weight: 1,
  inputs: ctx => ['final.mp4', 'check.json', 'voice-cuts.json', 'voice.json', 'edl.json', 'finish.json'].map(f => ctx.work(f)),
  outputs: ctx => [ctx.work('cut-pictures.json')],

  async run(ctx) {
    const edl = await readJson<Edl>(ctx.work('edl.json'));
    const voice = await readJson<Voice>(ctx.work('voice.json'));
    const finish = await readJson<FinishInfo>(ctx.work('finish.json'));
    const check = await readJson<CheckResult>(ctx.work('check.json'));
    const voiceCuts = await readJson<VoiceCut[]>(ctx.work('voice-cuts.json'));
    const before = await readJson<CutPictures>(ctx.work('cut-pictures.json')).catch(() => null);
    const final = ctx.work('final.mp4');

    const words = bodyWords(edl, voice).map(w => ({ start: finish.bodyStart + w.start, end: finish.bodyStart + w.end }));
    const cutTimes = voiceCuts.map(c => finish.bodyStart + c.bodyAt);
    const videoTimes = videoCutsOf(edl).map(c => finish.bodyStart + c.at);
    const all: { picture: CutPicture; color: string }[] = [];
    const pictureAt = (at: number, name: string, color = COLOR.cut): CutPicture => {
      const same = all.find(p => Math.abs(p.picture.at - at) < 1e-3);
      if (same) return same.picture;
      const picture = { file: `cuts/${name}.png`, at };
      all.push({ picture, color });
      return picture;
    };
    const num = (i: number) => String(i + 1).padStart(2, '0');
    const result: CutPictures = {
      cuts: cutTimes.map((at, i) => pictureAt(at, `cut-${num(i)}`)),
      videoCuts: ownPictures(videoTimes).map((at, i) => pictureAt(at, `video-${num(i)}`, COLOR.videoCut)),
      problems: check.problems.map((_, i) => {
        const at = check.problemAt?.[i] ?? null;
        return at === null ? null : pictureAt(at, `problem-${num(i)}`);
      }),
      keys: {},
    };

    // Keyed on the video's content, so a re-render that changed nothing redraws nothing.
    const video = await hashFile(final);
    const todo: { out: string; args: string[] }[] = [];
    for (const { picture: p, color } of all) {
      const out = ctx.output(p.file);
      const plan = planPicture(p.at, { totalSec: finish.totalSec, fps: edl.fps, words, cuts: cutTimes, videoCuts: videoTimes });
      const args = drawArgs(plan, color, edl.fps, final, tempPath(out));
      result.keys[p.file] = hashJson({ video, args });
      if (before?.keys[p.file] !== result.keys[p.file] || !existsSync(out)) todo.push({ out, args });
    }

    // The old keys stop describing the pictures once one is redrawn, so a crash part-way redraws them all next time.
    if (todo.length) await rm(ctx.work('cut-pictures.json'), { force: true });
    await mkdir(ctx.output('cuts'), { recursive: true });
    let done = 0;
    if (todo.length) ctx.detail(`Drawing ${todo.length} picture${todo.length === 1 ? '' : 's'}${todo.length < all.length ? ` (${all.length - todo.length} kept from before)` : ''}.`);
    await inParallel(todo, PARALLEL, async t => {
      await ffmpeg(t.args);
      await rename(tempPath(t.out), t.out);
      ctx.progress(++done / todo.length);
    });
    await writeJson(ctx.work('cut-pictures.json'), result);
    // Pictures of cuts and problems an earlier render had and this one does not, and drawings a crash left.
    for (const f of await readdir(ctx.output('cuts'))) {
      if (PICTURE_FILE.test(f.replace('.tmp.', '.')) && !all.some(p => p.picture.file === `cuts/${f}`)) await rm(ctx.output(`cuts/${f}`));
    }
    ctx.detail(all.length ? `${all.length} picture${all.length === 1 ? '' : 's'} in output/cuts, linked from the report.` : 'No cuts or problems to draw.');
  },
};
