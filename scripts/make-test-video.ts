/**
 * Builds a synthetic screen recording with known timings, so each shot can be checked
 * before a real recording exists. macOS only (uses `say`).
 *
 *   node scripts/make-test-video.ts
 *
 * Writes tests/fixtures/test-recording.mp4 and test-recording.truth.json. The recording has
 * three "click here" actions, one slipped sentence that is said again, a 10-second still
 * pause and a 10-second page load, the test video PLAN.md asks for.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../src/lib/env.ts';
import { probe } from '../src/lib/ffmpeg.ts';
import { run } from '../src/lib/run.ts';

const OUT_DIR = join(ROOT, 'tests', 'fixtures');
const GAP = 0.7;
const PAUSE = 10;
const LOAD = 10;

const LINES = {
  intro: 'Hi everyone. Today we are going to build a screen flow that creates a case.',
  search: 'First, open Setup, and search for flows in the Quick Find box.',
  click1: 'Now, on the New Flow button, click here.',
  slip: 'Then select the, the, sorry.',
  click2: 'Then select Screen Flow, and to create it, click here.',
  drag: 'Drag a screen element onto the canvas, and give it a label.',
  click3: 'Finally, to save the flow, click here.',
};
type Line = keyof typeof LINES;

const tmp = await mkdtemp(join(tmpdir(), 'studio-fixture-'));
try {
  // 1. Speak each line and measure it.
  const length: Record<string, number> = {};
  for (const [key, text] of Object.entries(LINES)) {
    const aiff = join(tmp, `${key}.aiff`);
    await run('say', ['-v', 'Samantha', '-o', aiff, text]);
    await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '48000', join(tmp, `${key}.wav`)]);
    length[key] = (await probe(join(tmp, `${key}.wav`))).durationSec;
  }

  // 2. Lay the lines out in time.
  const at: Record<string, { start: number; end: number }> = {};
  let t = 1.0;
  const place = (key: Line, gapAfter = GAP) => {
    at[key] = { start: t, end: t + length[key] };
    t = at[key].end + gapAfter;
  };
  place('intro');
  place('search');
  place('click1', 0);
  const click1 = at.click1.end;
  const pause = { start: click1, end: click1 + PAUSE };
  t = pause.end;
  place('slip', 0.5);
  place('click2', 0);
  const click2 = at.click2.end;
  const load = { start: click2, end: click2 + LOAD };
  t = load.end + 0.8;
  place('drag');
  place('click3', 0);
  const click3 = at.click3.end;
  const total = click3 + 2.5;

  // 3. Cursor path: [time, x, y] keyframes, linear in between.
  const lerp = (line: Line, f: number) => at[line].start + (at[line].end - at[line].start) * f;
  const keys: [number, number, number][] = [
    [0, 1500, 700],
    [at.search.start, 1500, 700], [lerp('search', 0.4), 868, 44],
    [at.click1.start, 868, 44], [lerp('click1', 0.85), 1712, 166],
    [at.click2.start, 1712, 166], [lerp('click2', 0.45), 820, 452], [lerp('click2', 0.6), 820, 452], [lerp('click2', 0.95), 1150, 760],
    [at.drag.start, 1150, 760], [lerp('drag', 0.3), 150, 300], [lerp('drag', 0.9), 1000, 520],
    [at.click3.start, 1000, 520], [lerp('click3', 0.85), 1790, 44],
  ];
  const path = (axis: 1 | 2) => {
    let expr = `lt(t,${keys[0][0]})*${keys[0][axis]}`;
    for (let i = 0; i < keys.length - 1; i++) {
      const [t0, ...p0] = keys[i];
      const [t1, ...p1] = keys[i + 1];
      const a = p0[axis - 1];
      const b = p1[axis - 1];
      if (t1 <= t0) continue;
      expr += `+gte(t,${t0.toFixed(3)})*lt(t,${t1.toFixed(3)})*(${a}+(${b - a})*(t-${t0.toFixed(3)})/${(t1 - t0).toFixed(3)})`;
    }
    const last = keys.at(-1)!;
    return `${expr}+gte(t,${last[0].toFixed(3)})*${last[axis]}`;
  };

  // 4. Draw the fake app. Static boxes are switched on per time range with `enable`; in drawbox,
  // `t` inside x/y/w/h means thickness, so anything that moves is an overlay (where `t` is time)
  // and anything that grows is drawn in steps.
  const box = (x: number, y: number, w: number, h: number, color: string, enable = '1') =>
    `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill:enable='${enable}'`;
  const during = (a: number, b: number) => `gte(t,${a.toFixed(3)})*lt(t,${b.toFixed(3)})`;
  const grow = (x: number, y: number, maxW: number, h: number, color: string, from: number, to: number, steps: number, until: number) =>
    Array.from({ length: steps }, (_, i) => {
      const start = from + (to - from) * i / steps;
      return box(x, y, Math.round(maxW * (i + 1) / steps), h, color, during(start, i === steps - 1 ? until : from + (to - from) * (i + 1) / steps));
    });
  const typeStart = lerp('search', 0.5);
  const filters = [
    box(0, 0, 1920, 88, 'white'),
    box(24, 26, 64, 36, '0x7F90CC'),
    box(700, 24, 360, 40, '0xEEF0F3'),
    ...grow(708, 32, 300, 24, '0xB8BEC8', typeStart, at.search.end, 12, total), // typing in Quick Find
    box(1740, 26, 110, 36, '0x3D5BD9'),
    box(0, 88, 380, 992, 'white'),
    ...[0, 1, 2, 3, 4, 5].map(i => box(40, 140 + i * 56, 260 - i * 18, 18, '0xE3E6EB')),
    // State A: Setup home, with the New Flow button top right
    ...[0, 1, 2].map(i => box(440 + i * 470, 220, 440, 300, 'white', during(0, click1))),
    box(1650, 140, 220, 52, '0x3D5BD9', during(0, click1)),
    // State B: the new-flow dialog (the 10-second still pause and the slip happen here)
    box(380, 88, 1540, 992, '0x9AA0A8', during(click1, click2)), // dimmed page behind the dialog
    box(560, 260, 800, 600, 'white', during(click1, click2)),
    ...[0, 1, 2].map(i => box(620, 330 + i * 120, 680, 96, '0xEEF0F3', during(click1, click2))),
    box(1060, 740, 240, 56, '0x3D5BD9', during(click1, click2)),
    box(900, 560, 2, 24, 'black', `${during(click1, click2)}*lt(mod(t,1),0.5)`), // blinking text caret
    // Page load: dimmed page and a progress bar (the spinner is an overlay below)
    box(380, 88, 1540, 992, '0xDADDE2', during(click2, load.end)),
    ...grow(380, 88, 1540, 6, '0x3D5BD9', click2, load.end, 40, load.end),
    // State C: the flow canvas
    box(380, 88, 1540, 992, '0xEEF1F5', during(load.end, total)),
    box(1070, 200, 160, 160, '0x4E9B6F', during(load.end, total)),
    box(1000, 420, 300, 100, 'white', `gte(t,${lerp('drag', 0.9).toFixed(3)})`),
    // Saved toast
    box(760, 110, 400, 64, '0x4E9B6F', during(click3, total)),
  ];
  const sprite = (color: string, w: number, h: number) => `color=c=${color}:s=${w}x${h}:r=30:d=${total.toFixed(3)}`;
  const graph = [
    `[0:v]${filters.join(',')}[bg]`,
    `[bg][2:v]overlay=x='1130+70*cos(2*PI*t)':y='570+70*sin(2*PI*t)':enable='${during(click2, load.end)}'[v1]`,
    `[v1][3:v]overlay=x='${path(1)}-150':y='${path(2)}-50':enable='${during(lerp('drag', 0.3), lerp('drag', 0.9))}'[v2]`,
    `[v2][4:v]overlay=x='${path(1)}':y='${path(2)}'[vout]`,
  ].join(';');

  // 5. Speech track: every line placed at its start time.
  const keysInOrder = Object.keys(LINES) as Line[];
  const audioInputs = keysInOrder.flatMap(k => ['-i', join(tmp, `${k}.wav`)]);
  const delays = keysInOrder.map((k, i) => `[${i}:a]adelay=delays=${Math.round(at[k].start * 1000)}:all=1[a${i}]`);
  const mix = `${keysInOrder.map((_, i) => `[a${i}]`).join('')}amix=inputs=${keysInOrder.length}:normalize=0,apad=whole_dur=${total.toFixed(3)}[out]`;
  const speech = join(tmp, 'speech.wav');
  await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...audioInputs, '-filter_complex', [...delays, mix].join(';'), '-map', '[out]', '-t', total.toFixed(3), speech]);

  await mkdir(OUT_DIR, { recursive: true });
  const video = join(OUT_DIR, 'test-recording.mp4');
  await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0xF4F5F7:s=1920x1080:r=30:d=${total.toFixed(3)}`,
    '-i', speech,
    '-f', 'lavfi', '-i', sprite('0x3D5BD9', 28, 28),
    '-f', 'lavfi', '-i', sprite('0xD9E1F7', 300, 100),
    '-f', 'lavfi', '-i', sprite('0x1F2328', 20, 30),
    '-filter_complex', graph, '-map', '[vout]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', video]);

  const round = (n: number) => Math.round(n * 1000) / 1000;
  const truth = {
    durationSec: round(total),
    lines: Object.fromEntries(keysInOrder.map(k => [k, { text: LINES[k], start: round(at[k].start), end: round(at[k].end) }])),
    clicks: [click1, click2, click3].map(round),
    stillPause: { start: round(pause.start), end: round(pause.end) },
    pageLoad: { start: round(load.start), end: round(load.end) },
    slip: 'slip',
  };
  await writeFile(join(OUT_DIR, 'test-recording.truth.json'), JSON.stringify(truth, null, 2));
  console.log(`Wrote ${video} (${total.toFixed(1)} s)`);
  console.log(`Still pause ${truth.stillPause.start}–${truth.stillPause.end} s, page load ${truth.pageLoad.start}–${truth.pageLoad.end} s, clicks at ${truth.clicks.join(', ')} s`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
