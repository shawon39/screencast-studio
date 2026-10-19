import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutsOf, LIMITS, plan, videoCutsOf } from '../src/lib/timemap.ts';
import type { Edl, Interval, PlanLine } from '../src/lib/timemap.ts';

const FPS = 30;
const FRAME = 1 / FPS;

function run(lines: PlanLine[], still: Interval[], durationSec: number): Edl {
  const edl = plan({ fps: FPS, durationSec, still, lines });
  assert.equal(edl.video.reduce((n, op) => n + op.frames, 0), edl.frames, 'op frames add up to the total');
  assertCutsInsideStills(edl, still);
  return edl;
}

/** The cut rule: the video only skips time inside still parts (or crossfades over a long page load). */
function assertCutsInsideStills(edl: Edl, still: Interval[]) {
  for (const cut of cutsOf(edl.video).filter(c => !c.crossfade)) {
    const inside = still.some(s => cut.start >= s.start - FRAME && cut.end <= s.end + FRAME);
    assert.ok(inside, `cut ${cut.start}–${cut.end} is not inside a still part`);
  }
}

const line = (id: number, start: number, end: number, speech: number, anchors: PlanLine['anchors'] = [], breaks: number[] = [], pauseBefore: number | null = null): PlanLine =>
  ({ id, start, end, speech, anchors, breaks, pauseBefore });
const near = (a: number, b: number, tol = FRAME) => Math.abs(a - b) <= tol + 1e-9;

test('shorter audio: still frames are cut, nothing speeds up', () => {
  const edl = run([line(1, 10, 14, 3)], [{ start: 0, end: 10 }, { start: 11, end: 12.5 }, { start: 14, end: 20 }], 20);
  assert.ok(near(edl.durationSec, LIMITS.leadIn + 3 + LIMITS.tail));
  assert.ok(edl.stats.maxSpeedWhileSpeaking <= 1.01, `speed ${edl.stats.maxSpeedWhileSpeaking}`);
});

test('shorter audio with no still frames speeds up, at most 1.5x', () => {
  const edl = run([line(1, 10, 14, 3)], [{ start: 0, end: 10 }, { start: 14, end: 20 }], 20);
  assert.ok(near(edl.stats.maxSpeedWhileSpeaking, 4 / 3, 0.02), `speed ${edl.stats.maxSpeedWhileSpeaking}`);
});

test('longer audio: a frame is held inside a still part, nothing slows down', () => {
  const edl = run([line(1, 10, 12, 3)], [{ start: 0, end: 10 }, { start: 10.5, end: 11.5 }, { start: 12, end: 20 }], 20);
  assert.ok(near(edl.durationSec, LIMITS.leadIn + 3 + LIMITS.tail));
  assert.ok(edl.stats.minSpeed >= 0.99, `min speed ${edl.stats.minSpeed}`);
  assert.ok(near(edl.stats.holdSec, 1, 0.01), `held ${edl.stats.holdSec} s`);
});

test('longer audio with no still part: hold up to 2 s before the action, then slow down to 0.8x', () => {
  const edl = run([line(1, 10, 12, 5)], [{ start: 0, end: 10 }, { start: 12, end: 20 }], 20);
  assert.ok(edl.stats.minSpeed >= LIMITS.minSpeed - 0.01, `min speed ${edl.stats.minSpeed}`);
  assert.equal(edl.notes.length, 1, 'the extra hold beyond 2 s is reported');
});

test('still gap between lines shrinks to a 0.4 s rest', () => {
  const edl = run([line(1, 2, 4, 2), line(2, 12, 14, 2)], [{ start: 0, end: 2 }, { start: 4, end: 12 }, { start: 14, end: 16 }], 16);
  assert.ok(near(edl.durationSec, LIMITS.leadIn + 2 + LIMITS.rest + 2 + LIMITS.tail));
});

test('moving gap (a page load) plays faster, takes 3 s at most and is never cut', () => {
  const still = [{ start: 0, end: 2 }, { start: 16, end: 18 }];
  const edl = run([line(1, 2, 4, 2), line(2, 14, 16, 2)], still, 18);
  assert.ok(near(edl.durationSec, LIMITS.leadIn + 2 + 3 + 2 + LIMITS.tail), `took ${edl.durationSec}`);
  assert.equal(cutsOf(edl.video).filter(c => c.start < 14 && c.end > 4).length, 0);
});

test('a page load over 12 s keeps both ends and crossfades the middle', () => {
  const edl = run([line(1, 2, 4, 2), line(2, 24, 26, 2)], [{ start: 0, end: 2 }], 26);
  const fades = edl.video.filter(op => op.kind === 'xfade');
  assert.equal(fades.length, 1);
  assert.ok(near(fades[0].frames / FPS, 2.7));
});

test('a dropped sentence: removed if the screen was still, sped up if it moved', () => {
  // Kept lines at 0–3 and 10–13; the dropped sentence was said at 5–8.
  const stillDuring = run([line(1, 1, 3, 2), line(2, 10, 13, 3)], [{ start: 0, end: 1 }, { start: 3, end: 10 }], 13);
  assert.ok(near(stillDuring.durationSec, LIMITS.leadIn + 2 + LIMITS.rest + 3));
  const movedDuring = run([line(1, 1, 3, 2), line(2, 10, 13, 3)], [{ start: 0, end: 1 }, { start: 3, end: 5 }, { start: 8, end: 10 }], 13);
  // 0.4 s rest from the first still part, the 3 s of movement at 2x, the second still part cut.
  assert.ok(near(movedDuring.durationSec, LIMITS.leadIn + 2 + LIMITS.rest + 1.5 + 3), `took ${movedDuring.durationSec}`);
});

test('cues: each action frame plays within one frame of its word', () => {
  const anchors = [{ word: 'click', source: 12, voice: 1.5 }, { word: 'here', source: 14, voice: 3 }];
  const edl = run([line(1, 10, 16, 4, anchors)], [{ start: 0, end: 10 }, { start: 10.5, end: 11.5 }, { start: 14.5, end: 15.5 }, { start: 16, end: 18 }], 18);
  assert.equal(edl.anchors.length, 2);
  for (const a of edl.anchors) assert.ok(a.errorMs <= 34, `${a.word} is off by ${a.errorMs} ms`);
});

test('a cue the screen cannot reach at 1.5x makes the voice wait before the sentence, and stays in sync', () => {
  const edl = run([line(1, 10, 16, 2, [{ word: 'click', source: 15, voice: 0.5 }])], [{ start: 0, end: 10 }, { start: 16, end: 18 }], 18);
  assert.ok(edl.stats.maxSpeedWhileSpeaking <= LIMITS.maxSpeakSpeed + 0.01);
  const clips = edl.voice.filter(c => c.lineId === 1);
  assert.equal(clips.length, 1, 'the sentence is not split');
  assert.ok(near(clips[0].at, LIMITS.leadIn - LIMITS.prePad + 5 / 1.5 - 0.5, 0.01), `the voice starts at ${clips[0].at}`);
  assert.ok(near(edl.stats.voicePauseSec, 5 / 1.5 - 0.5, 0.01));
  assert.ok(edl.anchors[0].errorMs <= 34, `off by ${edl.anchors[0].errorMs} ms`);
});

test('voice clips play in order without overlapping speech', () => {
  const anchors = [{ word: 'click', source: 12, voice: 1 }];
  const edl = run([line(1, 2, 4, 2), line(2, 10, 16, 3, anchors), line(3, 20, 22, 1.5)], [{ start: 0, end: 2 }, { start: 4, end: 10 }, { start: 16, end: 20 }], 24);
  for (let i = 1; i < edl.voice.length; i++) {
    const prevSpeechEnd = edl.voice[i - 1].at + (edl.voice[i - 1].to - LIMITS.postPad - edl.voice[i - 1].from);
    assert.ok(edl.voice[i].at + LIMITS.prePad >= prevSpeechEnd - 1e-6, `clip ${i} starts before clip ${i - 1} ends`);
  }
});

test('a one-frame movement between two still parts is played, not skipped', () => {
  // From a real recording: the screen changed for one frame at 15.30 between two still parts.
  const still = [{ start: 0, end: 10 }, { start: 12.87, end: 15.3 }, { start: 15.33, end: 18.23 }];
  const edl = run([line(1, 10, 14.5, 4.5), line(2, 16.44, 18, 1.56)], still, 20);
  assert.ok(edl.video.some(op => op.kind === 'play' && op.src <= 15.3 + 1e-6 && op.srcEnd >= 15.33 - 1e-6), 'the moving frame plays');
});

test('lines 0.04 s apart on a moving screen: the breath is a hold and nothing is skipped', () => {
  const edl = run([line(1, 10, 12, 2), line(2, 12.04, 14, 1.96)], [{ start: 0, end: 10 }, { start: 14, end: 16 }], 16);
  assert.equal(cutsOf(edl.video).filter(c => c.start > 10 && c.end < 14).length, 0);
  assert.ok(near(edl.stats.holdSec, LIMITS.minPause - FRAME, 0.01), `held ${edl.stats.holdSec} s`);
});

test('a later cue waits at the last comma before it, or right before the cue word if there is none', () => {
  // The first cue fits; the screen needs 5 s for the second, the voice 1.5 s.
  const anchors = [{ word: 'click', source: 10.5, voice: 0.5 }, { word: 'here', source: 15.5, voice: 2 }];
  const still = [{ start: 0, end: 10 }, { start: 16, end: 18 }];
  const withComma = run([line(1, 10, 16, 3, anchors, [0.3, 1.2])], still, 18);
  assert.deepEqual(withComma.voice.map(c => c.from), [-LIMITS.prePad, 1.2], 'split at the comma');
  const noComma = run([line(1, 10, 16, 3, anchors)], still, 18);
  assert.deepEqual(noComma.voice.map(c => c.from), [-LIMITS.prePad, 2], 'split right before the cue');
  for (const edl of [withComma, noComma]) for (const a of edl.anchors) assert.ok(a.errorMs <= 34, `${a.word} is off by ${a.errorMs} ms`);
});

/** Silence between the end of one line's speech and the start of the next, from the voice clips. */
function silences(edl: Edl, speech: Record<number, number>): number[] {
  const out: number[] = [];
  for (let i = 1; i < edl.voice.length; i++) {
    const a = edl.voice[i - 1], b = edl.voice[i];
    if (a.lineId === b.lineId) continue;
    out.push((b.at - b.from) - (a.at - a.from + speech[a.lineId]));
  }
  return out;
}

test('two lines from one take keep the pause the voice made, and the take plays straight through', () => {
  const edl = run([line(1, 2, 4, 2), line(2, 6, 8, 2, [], [], 0.25)], [{ start: 0, end: 2 }, { start: 4, end: 6 }, { start: 8, end: 10 }], 10);
  assert.ok(near(silences(edl, { 1: 2, 2: 2 })[0], 0.25, 0.001), `silence ${silences(edl, { 1: 2, 2: 2 })[0]}`);
  const [a, b] = edl.voice;
  assert.ok(near(a.at + (a.to - a.from), b.at, 1e-6), 'the clips meet');
  assert.ok(near(a.to - 2, -b.from, 1e-6), 'and they meet in the middle of the pause');
});

test('lines from one take on a moving screen never come closer than the pause the voice made', () => {
  const edl = run([line(1, 10, 12, 2), line(2, 12.1, 14, 1.9, [], [], 0.6)], [{ start: 0, end: 10 }, { start: 14, end: 16 }], 16);
  assert.ok(silences(edl, { 1: 2, 2: 1.9 })[0] >= 0.6 - 1e-6, `silence ${silences(edl, { 1: 2, 2: 1.9 })[0]}`);
  assert.equal(cutsOf(edl.video).filter(c => c.start > 10 && c.end < 14).length, 0);
});

test('a video cut is where the video skips a frame or more of the recording, or in the middle of a crossfade', () => {
  const video: Edl['video'] = [
    { kind: 'play', src: 0, srcEnd: 2, frames: 60 },
    // Skips 20 ms, less than a frame: there is no jump to see.
    { kind: 'play', src: 2.02, srcEnd: 3, frames: 29 },
    // Holds the last frame shown, so nothing is skipped.
    { kind: 'hold', at: 2.99, frames: 10 },
    // Skips 1 s, at 99 frames.
    { kind: 'play', src: 4, srcEnd: 10, frames: 45 },
    // 6 s on each side at 4x is 1.5 s; the 0.3 s fade ends there, so its middle is 1.35 s in.
    { kind: 'xfade', a: { start: 10, end: 16 }, b: { start: 30, end: 36 }, fadeSec: 0.3, frames: 81 },
  ];
  const cuts = videoCutsOf({ fps: FPS, video }).map(c => ({ ...c, at: Math.round(c.at * 1000) / 1000 }));
  assert.deepEqual(cuts, [{ at: 3.3, start: 3, end: 4, crossfade: false }, { at: 6.15, start: 16, end: 30, crossfade: true }]);
});
