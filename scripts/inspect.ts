/**
 * Prints what the Listen phase found for one job, in a form you can check against the video.
 *
 *   node scripts/inspect.ts <job-id>        (the folder name under jobs/)
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { JOBS_DIR } from '../src/lib/env.ts';
import { readJson } from '../src/lib/files.ts';
import type { Transcript } from '../src/steps/02-transcribe.ts';
import type { Interval, Screen } from '../src/steps/03-analyze.ts';

const id = process.argv[2];
if (!id) {
  console.error('Usage: node scripts/inspect.ts <job-id>');
  process.exit(1);
}
const work = join(JOBS_DIR, id, 'work');
if (!existsSync(work)) {
  console.error(`No job folder at jobs/${id}`);
  process.exit(1);
}

const tc = (sec: number) => {
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, '0')}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
};
const span = (i: Interval) => `${tc(i.start)}–${tc(i.end)}  (${(i.end - i.start).toFixed(1)} s)`;

if (existsSync(join(work, 'transcript.json'))) {
  const t = await readJson<Transcript>(join(work, 'transcript.json'));
  console.log('\nWhat you said (a new line after each pause over 0.5 s)');
  let line: string[] = [];
  let lineStart = 0;
  let lastEnd = -1;
  const flush = () => { if (line.length) console.log(`  ${tc(lineStart)}  ${line.join(' ')}`); line = []; };
  for (const w of t.words) {
    if (lastEnd >= 0 && w.start - lastEnd > 0.5) flush();
    if (!line.length) lineStart = w.start;
    line.push(w.type === 'audio_event' ? `[${w.text}]` : w.text);
    lastEnd = w.end;
  }
  flush();
}

if (existsSync(join(work, 'screen.json'))) {
  const s = await readJson<Screen>(join(work, 'screen.json'));
  console.log('\nStill screen, 1 s or longer (cuts may happen only here)');
  for (const i of s.still.filter(i => i.end - i.start >= 1)) console.log(`  ${span(i)}`);
  console.log('\nScreen moving, 1 s or longer (cursor, typing, page loads)');
  for (const i of s.moving.filter(i => i.end - i.start >= 1)) console.log(`  ${span(i)}`);
  console.log('\nScreen changes (share of the screen that changed in one frame)');
  for (const c of s.changes) console.log(`  ${tc(c.t)}  ${Math.round(c.size * 100)}%`);
  console.log('\nPauses in speech, 0.7 s or longer');
  for (const i of s.silences.filter(i => i.end - i.start >= 0.7)) console.log(`  ${span(i)}`);
}
console.log('');
