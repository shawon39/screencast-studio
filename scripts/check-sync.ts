/**
 * Checks sync on the rendered cut, not just the plan: for every cue, the frame the cut shows when the
 * new voice says the word must match the recording's frame from when you said it.
 *
 *   node scripts/check-sync.ts <job-id>
 */
import { join } from 'node:path';
import { JOBS_DIR } from '../src/lib/env.ts';
import { ssim } from '../src/lib/check.ts';
import { readJson } from '../src/lib/files.ts';
import type { Edl } from '../src/lib/timemap.ts';

const id = process.argv[2];
if (!id) {
  console.error('Usage: node scripts/check-sync.ts <job-id>');
  process.exit(1);
}
const work = join(JOBS_DIR, id, 'work');
const edl = await readJson<Edl>(join(work, 'edl.json'));
const fps = edl.fps;

let worst = 1;
console.log('cue           said at   voice at   match   control (+0.75 s)');
for (const a of edl.anchors) {
  // The middle of the frame showing when the voice says the word.
  const outFrame = Math.round(a.voiceAt * fps);
  const match = await ssim(join(work, 'body.mp4'), (outFrame + 0.5) / fps, join(work, 'master.mp4'), (Math.floor(a.source * fps) + 0.5) / fps, fps);
  const control = await ssim(join(work, 'body.mp4'), (outFrame + 0.5) / fps, join(work, 'master.mp4'), a.source + 0.75, fps);
  worst = Math.min(worst, match);
  console.log(`${`${a.lineId}:${a.word}`.padEnd(13)} ${a.source.toFixed(2).padStart(7)}   ${a.voiceAt.toFixed(2).padStart(7)}   ${match.toFixed(4)}  ${control.toFixed(4)}`);
}
console.log(`\nLowest match: ${worst.toFixed(4)} (1 = the very same frame).`);
process.exit(worst >= 0.98 ? 0 : 1);
