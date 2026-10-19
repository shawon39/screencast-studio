import type { Word } from '../steps/02-transcribe.ts';
import { norm } from './script.ts';
import type { Interval } from './timemap.ts';

const FILLERS = new Set(['uh', 'uhm', 'um', 'umm', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm']);

export const CLEAN_LIMITS = { maxGap: 0.7, keepGap: 0.5, edge: 0.3, pad: 0.03 };

export const isFiller = (w: Word) => w.type === 'audio_event' || FILLERS.has(norm(w.text));

/**
 * What to keep from a voice-clone sample: every real word, natural pauses up to 0.7 s, and no
 * fillers or sounds. A pause that was longer, or that held a filler, becomes 0.5 s of real silence.
 */
export function keepRanges(words: Word[], durationSec: number, o = CLEAN_LIMITS): Interval[] {
  const speech = words.filter(w => w.type === 'word' && !isFiller(w));
  if (!speech.length) return [];
  const removed = words.filter(isFiller);
  const ranges: Interval[] = [{ start: Math.max(0, speech[0].start - o.edge), end: speech[0].start }];
  for (let i = 0; i < speech.length; i++) {
    const a = speech[i];
    ranges.push({ start: Math.max(0, a.start - o.pad), end: a.end + o.pad });
    const b = speech[i + 1];
    if (!b) break;
    const inside = removed.filter(f => f.start >= a.end - 1e-3 && f.end <= b.start + 1e-3);
    const gap = b.start - a.end;
    if (!inside.length && gap <= o.maxGap) {
      ranges.push({ start: a.end, end: b.start });
      continue;
    }
    // Keep up to half the new pause on each side, taken only from silence, never from a filler.
    const half = Math.min(o.keepGap, gap - inside.reduce((n, f) => n + f.end - f.start, 0)) / 2;
    const quietAfterA = (inside[0]?.start ?? b.start) - o.pad - a.end;
    const quietBeforeB = b.start - o.pad - (inside.at(-1)?.end ?? a.end);
    ranges.push({ start: a.end, end: a.end + Math.max(0, Math.min(half, quietAfterA)) });
    ranges.push({ start: b.start - Math.max(0, Math.min(half, quietBeforeB)), end: b.start });
  }
  const last = speech.at(-1)!;
  ranges.push({ start: last.end, end: Math.min(durationSec, last.end + o.edge) });
  return merge(ranges);
}

function merge(ranges: Interval[]): Interval[] {
  const sorted = ranges.filter(r => r.end - r.start > 1e-4).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.start <= last.end + 1e-4) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}
