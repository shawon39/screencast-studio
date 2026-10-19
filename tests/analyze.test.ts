// The screen analysis on synthetic clips: a change too slow to show between neighbouring frames must still end
// a still part, or the planner cuts inside it and the picture jumps.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Job } from '../src/jobs.ts';
import { readJson } from '../src/lib/files.ts';
import type { StepContext } from '../src/pipeline.ts';
import { analyzeStep } from '../src/steps/03-analyze.ts';
import type { Screen } from '../src/steps/03-analyze.ts';

/** Encodes a 4-second, 30 fps master.mp4 (lossless picture, silent audio) from a filter graph that ends in [v], and analyzes it. */
async function analyze(inputs: string[], graph: string): Promise<Screen> {
  const dir = await mkdtemp(join(tmpdir(), 'studio-analyze-'));
  try {
    const master = join(dir, 'master.mp4');
    execFileSync('ffmpeg', ['-v', 'error', ...inputs.flatMap(i => ['-f', 'lavfi', '-i', i]), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
      '-filter_complex', graph, '-map', '[v]', '-map', `${inputs.length}:a`, '-t', '4', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', master]);
    const ctx: StepContext = {
      job: { listen: {}, media: { durationSec: 4 } } as unknown as Job,
      input: master,
      work: name => join(dir, name),
      output: name => join(dir, name),
      say: () => {},
      detail: () => {},
      progress: () => {},
    };
    await analyzeStep.run(ctx);
    return await readJson<Screen>(join(dir, 'screen.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const covers = (s: Screen, start: number, end: number) => s.still.some(p => p.start <= start && p.end >= end);
const overlaps = (s: Screen, start: number, end: number) => s.still.some(p => p.start < end && p.end > start);

test('a slow fade ends the still part, though no two neighbouring frames differ', async () => {
  // On a grey of 100, a 4 × 4 square brightens by 5 levels a frame from 1 s to 2 s: under the 20 a pixel needs.
  const lum = "if(between(X,30,33)*between(Y,16,19),100+5*clip(N-30,0,30),100)";
  const screen = await analyze([`color=black:s=64x36:r=30:d=4`], `[0:v]format=gray,geq=lum='${lum}',format=yuv420p[v]`);
  // motion[i] is frame i + 1: no frame of the fade changed from the one before.
  assert.ok(screen.motion.slice(29, 60).every(px => px === 0), `motion in the fade: ${screen.motion.slice(29, 60)}`);
  assert.ok(!overlaps(screen, 1.2, 1.9), `a still part covers the fade: ${JSON.stringify(screen.still)}`);
  assert.ok(covers(screen, 0, 1) && covers(screen, 2.1, 3.9), `the screen before and after the fade is not still: ${JSON.stringify(screen.still)}`);
});

test('a square creeping 1 px a frame ends the still part, though each step is under the limit', async () => {
  // A dark 16 × 16 square on grey moves right 1 px a frame from 1 s to 3 s: 32 pixels change a frame, 40 are allowed.
  const screen = await analyze(['color=c=0x808080:s=960x540:r=30:d=4', 'color=c=0x303030:s=16x16:r=30:d=4'],
    "[0:v][1:v]overlay=x='100+clip(n-30,0,60)':y=200:format=yuv444,format=yuv420p[v]");
  assert.ok(screen.motion.slice(35, 85).every(px => px > 0 && px <= 40), `motion while creeping: ${screen.motion.slice(35, 85)}`);
  assert.ok(!overlaps(screen, 1.1, 2.9), `a still part covers the creep: ${JSON.stringify(screen.still)}`);
  assert.ok(covers(screen, 0, 1) && covers(screen, 3, 3.9), `the screen before and after the creep is not still: ${JSON.stringify(screen.still)}`);
});
