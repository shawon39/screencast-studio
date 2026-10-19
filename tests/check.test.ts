import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RATE } from '../src/lib/audio.ts';
import { changedPixels, ssim } from '../src/lib/check.ts';
import type { VoiceClip } from '../src/lib/timemap.ts';
import type { VoiceLine } from '../src/steps/06-voice.ts';
import { framesCutOut, gainOnWordsAndPauses, voiceStops } from '../src/steps/11-check.ts';

/** One second of a 1 kHz tone per amplitude, in a row; 0 is digital silence. */
const tones = (...amps: number[]) => {
  const out = new Float32Array(amps.length * RATE);
  amps.forEach((a, k) => { for (let i = 0; i < RATE; i++) out[k * RATE + i] = a * Math.sin(2 * Math.PI * 1000 * i / RATE); });
  return out;
};
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 0.05, `${a} is not ${b}`);

test('one even gain gives words and pauses the same gain, and silence is left out', () => {
  const g = gainOnWordsAndPauses(tones(0.1, 0.001, 0), tones(0.2, 0.002, 0));
  near(g.words, 6.02);
  near(g.pauses, 6.02);
});

test('riding the volume shows as more gain in the pauses', () => {
  const g = gainOnWordsAndPauses(tones(0.1, 0.001), tones(0.2, 0.008));
  near(g.words, 6.02);
  near(g.pauses, 18.06);
});

test('with no pauses there is nothing to compare', () => {
  assert.equal(gainOnWordsAndPauses(tones(0.1, 0), tones(0.2, 0)).pauses, null);
});

const line: VoiceLine = {
  id: 7,
  file: 'voice/take-007.mp3',
  speechStart: 1,
  speechEnd: 2.1,
  words: [{ text: 'Then,', start: 1, end: 1.3 }, { text: 'click', start: 1.5, end: 1.8 }, { text: 'here.', start: 1.85, end: 2.1 }],
  anchors: [],
  breaks: [0.5],
  runsOn: false,
  characters: 0,
};

test('a line that plays straight through has no stops, and a new line is not a stop', () => {
  const clips: VoiceClip[] = [
    { lineId: 7, from: -0.05, to: 0.5, at: 0 },
    { lineId: 7, from: 0.5, to: 1.2, at: 0.55 },
    { lineId: 8, from: -0.05, to: 1, at: 3 },
  ];
  assert.deepEqual(voiceStops(clips, [line, { ...line, id: 8 }]), []);
});

test('a wait at a comma the voice paused at is listed with the words around it', () => {
  const stops = voiceStops([{ lineId: 7, from: -0.05, to: 0.5, at: 0 }, { lineId: 7, from: 0.5, to: 1.2, at: 1.35 }], [line]);
  assert.equal(stops.length, 1);
  const round = (n: number) => Math.round(n * 100) / 100;
  assert.deepEqual({ ...stops[0], waitSec: round(stops[0].waitSec), bodyAt: round(stops[0].bodyAt) }, { lineId: 7, before: 'Then,', after: 'click', waitSec: 0.8, atComma: true, bodyAt: 0.55 });
});

test('a wait where the voice does not pause is not at a comma', () => {
  const [stop] = voiceStops([{ lineId: 7, from: -0.05, to: 0.85, at: 0 }, { lineId: 7, from: 0.85, to: 1.2, at: 1.2 }], [line]);
  assert.equal(stop.before, 'click');
  assert.equal(stop.after, 'here.');
  assert.equal(stop.atComma, false);
});

test('a cut time rounded down to the ms still picks the frame it starts on', () => {
  // At 30 fps frame 460 starts at 15.3333 s, stored as 15.333; frame 493 starts at 16.4333 s, so 16.44 keeps it.
  assert.deepEqual(framesCutOut({ start: 15.333, end: 16.44 }, 30), [460, 492]);
  // Rounded up (frame 461 at 15.3667 s), and mid-frame times, stay as they were.
  assert.deepEqual(framesCutOut({ start: 15.367, end: 16.45 }, 30), [461, 492]);
  // The end rounded down the same way: frame 493 starts at 16.4333 s, stored as 16.433, and is kept.
  assert.deepEqual(framesCutOut({ start: 15.333, end: 16.433 }, 30), [460, 492]);
});

test('the frame match compares the frames on screen at the two times, not the ones after them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-check-'));
  try {
    // 10 fps, every frame a different grey: 2.05 s is in the middle of frame 20, which starts at 2.0 s.
    const clip = join(dir, 'frames.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "color=black:s=64x36:r=10:d=4,format=gray,geq=lum='N*6'", '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', clip]);
    assert.equal(await ssim(clip, 2.05, clip, 2.0, 10), 1);
    assert.ok(await ssim(clip, 2.05, clip, 2.1, 10) < 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a slow change shows between the first and last frame, though no two neighbouring frames differ', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-check-'));
  try {
    // 10 fps on a grey of 100: from frame 20 a 4 × 4 square brightens by 5 levels a frame, under the 20 a pixel needs.
    const clip = join(dir, 'fade.mp4');
    const lum = "if(between(X,30,33)*between(Y,16,19),100+5*max(0,N-20),100)";
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=black:s=64x36:r=10:d=4,format=gray,geq=lum='${lum}'`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', clip]);
    assert.equal(await changedPixels(clip, 0.05, 1.95, 10, 20), 0);
    assert.equal(await changedPixels(clip, 3.05, 3.15, 10, 20), 0);
    // The square is 60 × 60 at 960 × 540; frame 39 is 95 levels brighter than frame 20.
    const px = await changedPixels(clip, 2.05, 3.95, 10, 20);
    assert.ok(px > 3000 && px < 4500, `${px} pixels`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
