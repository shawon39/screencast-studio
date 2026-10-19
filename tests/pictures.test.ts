import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { readJson, writeJson } from '../src/lib/files.ts';
import type { StepContext } from '../src/pipeline.ts';
import { ownPictures, picturesStep, planPicture } from '../src/steps/12-pictures.ts';
import type { CutPictures } from '../src/steps/12-pictures.ts';

// 3 s across 1848 px: 616 px a second.
const words = [
  { start: 34, end: 34.5 },
  { start: 34.6, end: 35 },
  { start: 35, end: 35.9 },
  { start: 36.4, end: 36.8 },
  { start: 37, end: 37.6 },
  { start: 37.8, end: 38 },
];

test('a cut is in the middle of a 3 s window, under the middle frame', () => {
  const p = planPicture(36, { totalSec: 116, fps: 30, words, cuts: [36, 36.3, 40], videoCuts: [] });
  assert.equal(p.start, 34.5);
  assert.equal(p.span, 3);
  assert.equal(p.mark, 924);
  assert.equal(p.cell, 3);
  assert.deepEqual(p.frames, [6, 19, 32, 45, 58, 71, 84]);
});

test('words in the window are placed on the time axis, cut off at its edges', () => {
  const p = planPicture(36, { totalSec: 116, fps: 30, words, cuts: [], videoCuts: [] });
  assert.deepEqual(p.words, [[62, 308], [308, 862], [1170, 1417], [1540, 1848]]);
});

test('only gaps of 0.4 s or more between words are shaded as pauses', () => {
  assert.deepEqual(planPicture(36, { totalSec: 116, fps: 30, words, cuts: [], videoCuts: [] }).pauses, [[862, 1170]]);
  assert.deepEqual(planPicture(60, { totalSec: 116, fps: 30, words, cuts: [], videoCuts: [] }).pauses, [[0, 1848]]);
});

test('the other cuts in the window are marked, the picture\'s own cut and cuts outside it are not', () => {
  const p = planPicture(36, { totalSec: 116, fps: 30, words, cuts: [33, 36, 36.3, 40], videoCuts: [34, 35.1, 36] });
  assert.deepEqual(p.cuts, [1109]);
  assert.deepEqual(p.videoCuts, [370]);
});

test('video cuts less than 0.1 s after the one before share its picture', () => {
  assert.deepEqual(ownPictures([12.967, 13, 13.067, 13.4, 27.3, 27.4]), [12.967, 13.4, 27.3, 27.4]);
});

test('near the start or the end the window stays inside the video and the mark moves off the middle', () => {
  const first = planPicture(0.5, { totalSec: 116, fps: 30, words: [], cuts: [], videoCuts: [] });
  assert.deepEqual([first.start, first.mark, first.cell], [0, 308, 1]);
  const last = planPicture(116, { totalSec: 116, fps: 30, words: [], cuts: [], videoCuts: [] });
  assert.deepEqual([last.start, last.mark, last.cell], [113, 1848, 6]);
  const short = planPicture(1, { totalSec: 2, fps: 30, words: [], cuts: [], videoCuts: [] });
  assert.deepEqual([short.start, short.span], [0, 2]);
});

test('the wave gets the same whole number of samples in every pixel column', () => {
  const { audio } = planPicture(36, { totalSec: 116, fps: 30, words, cuts: [], videoCuts: [] });
  assert.deepEqual(audio, { rate: 48048, samples: 78 * 1848 });
});

// The picture step on a 4 s clip at 10 fps whose frame n is grey level 6n, so a frame in a picture tells its number.
let dir = '';
const ctx = {
  job: {},
  input: '',
  work: (name: string) => join(dir, 'work', name),
  output: (name: string) => join(dir, 'output', name),
  say: () => {},
  detail: () => {},
  progress: () => {},
} as unknown as StepContext;
const list = () => readJson<CutPictures>(ctx.work('cut-pictures.json'));
/** The number of the frame in cell `k` of a picture's strip. */
const frameIn = (file: string, k: number) => {
  const crop = `crop=1:1:${16 + k * 264 + 132}:${16 + 76},format=gray`;
  return Math.round(execFileSync('ffmpeg', ['-v', 'error', '-i', ctx.output(file), '-vf', crop, '-f', 'rawvideo', '-'])[0] / 6);
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-pictures-'));
  await mkdir(ctx.output('cuts'), { recursive: true });
  await mkdir(ctx.work(''), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "color=black:s=64x36:r=10:d=4,format=gray,geq=lum='N*6'",
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ctx.work('final.mp4')]);
  await copyFile(ctx.work('final.mp4'), ctx.work('final.good.mp4'));
  // The video skips half a second of the recording at 1.5 s.
  await writeJson(ctx.work('edl.json'), { fps: 10, voice: [], video: [{ kind: 'play', src: 0, srcEnd: 1.5, frames: 15 }, { kind: 'play', src: 2, srcEnd: 4.5, frames: 25 }] });
  await writeJson(ctx.work('voice.json'), { lines: [] });
  await writeJson(ctx.work('finish.json'), { bodyStart: 0, totalSec: 4 });
  await writeJson(ctx.work('check.json'), { problems: ['At the first cut', 'Nowhere', 'Elsewhere'], problemAt: [2.05, null, 3.1] });
  await writeJson(ctx.work('voice-cuts.json'), [{ bodyAt: 2.05 }, { bodyAt: 1.2 }]);
  await writeFile(ctx.output('cuts/cut-09.png'), 'from an earlier render');
  await writeFile(ctx.output('cuts/keep.png'), 'not drawn by the step');
});
after(() => rm(dir, { recursive: true, force: true }));

test('every voice cut and video cut gets a picture, a problem at a cut shares it, and old pictures go', async () => {
  await picturesStep.run(ctx);
  const p = await list();
  assert.deepEqual(p.cuts.map(c => c.file), ['cuts/cut-01.png', 'cuts/cut-02.png']);
  assert.deepEqual(p.videoCuts, [{ file: 'cuts/video-01.png', at: 1.5 }]);
  assert.deepEqual(p.problems.map(c => c?.file ?? null), ['cuts/cut-01.png', null, 'cuts/problem-03.png']);
  for (const f of ['cut-01.png', 'cut-02.png', 'video-01.png', 'problem-03.png', 'keep.png']) assert.ok(existsSync(ctx.output(`cuts/${f}`)), f);
  assert.ok(!existsSync(ctx.output('cuts/cut-09.png')));
});

test('the outlined frame is the one on screen at the cut, not the one after it', () => {
  // 2.05 s is in the middle of frame 20.
  assert.equal(frameIn('cuts/cut-01.png', 3), 20);
  // At a video cut that is the first frame after the skip.
  assert.equal(frameIn('cuts/video-01.png', 3), 15);
});

test('a run with nothing changed draws nothing', async () => {
  const drawnAt = statSync(ctx.output('cuts/cut-01.png')).mtimeMs;
  await picturesStep.run(ctx);
  assert.equal(statSync(ctx.output('cuts/cut-01.png')).mtimeMs, drawnAt);
});

test('a run that fails part-way leaves no keys behind, so the next run draws every picture again', async () => {
  const drawnAt = statSync(ctx.output('cuts/cut-01.png')).mtimeMs;
  await writeFile(ctx.work('final.mp4'), 'not a video');
  await assert.rejects(picturesStep.run(ctx));
  assert.ok(!existsSync(ctx.work('cut-pictures.json')));
  await copyFile(ctx.work('final.good.mp4'), ctx.work('final.mp4'));
  await picturesStep.run(ctx);
  assert.ok(statSync(ctx.output('cuts/cut-01.png')).mtimeMs > drawnAt);
  assert.equal(frameIn('cuts/cut-01.png', 3), 20);
});
