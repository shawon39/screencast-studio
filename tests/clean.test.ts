import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepRanges } from '../src/lib/clean.ts';
import type { Word } from '../src/steps/02-transcribe.ts';

/** Words 0.3 s each with 0.05 s between; "|n" inserts an n-second pause. */
function words(text: string): Word[] {
  const out: Word[] = [];
  let t = 1;
  for (const part of text.split(' ')) {
    if (part.startsWith('|')) { t += Number(part.slice(1)); continue; }
    out.push({ text: part, start: t, end: t + 0.3, type: part.startsWith('(') ? 'audio_event' : 'word' });
    t += 0.35;
  }
  return out;
}

const keptSec = (ranges: { start: number; end: number }[], a: number, b: number) =>
  ranges.reduce((n, r) => n + Math.max(0, Math.min(r.end, b) - Math.max(r.start, a)), 0);

test('fillers and sounds are cut out completely', () => {
  const w = words('so uhm today we (cough) build a flow');
  const ranges = keepRanges(w, 10);
  for (const f of w.filter(x => x.text === 'uhm' || x.text === '(cough)')) {
    assert.ok(keptSec(ranges, f.start, f.end) < 1e-6, `${f.text} is still in the sample`);
  }
  for (const s of w.filter(x => x.text === 'today' || x.text === 'flow')) {
    assert.ok(keptSec(ranges, s.start, s.end) > 0.299, `${s.text} was cut`);
  }
});

test('no pause in the result is longer than 0.7 s', () => {
  const w = words('first we open setup |2.5 then search |0.6 for flows');
  const ranges = keepRanges(w, 12);
  // Rebuild the output timeline and measure the silence between kept words.
  let out = 0;
  const at = new Map<Word, number>();
  for (const r of ranges) {
    for (const x of w) if (x.start >= r.start - 1e-6 && x.start < r.end) at.set(x, out + (x.start - r.start));
    out += r.end - r.start;
  }
  const times = w.map(x => at.get(x)!);
  for (let i = 1; i < w.length; i++) {
    const gap = times[i] - (times[i - 1] + 0.3);
    assert.ok(gap <= 0.7 + 1e-6, `pause before "${w[i].text}" is ${gap.toFixed(2)} s`);
  }
  // A natural pause under 0.7 s (here 0.65 s) is left alone.
  const search = w.findIndex(x => x.text === 'search');
  assert.ok(Math.abs(times[search + 1] - times[search] - 0.95) < 1e-6);
});

test('the start and end are trimmed to 0.3 s of room', () => {
  const ranges = keepRanges(words('hello there'), 20);
  assert.ok(Math.abs(ranges[0].start - 0.7) < 1e-6);
  assert.ok(Math.abs(ranges.at(-1)!.end - (1 + 0.35 + 0.3 + 0.3)) < 1e-6);
});
