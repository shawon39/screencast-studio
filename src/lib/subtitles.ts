import type { Edl } from './timemap.ts';

export interface TimedWord { lineId: number; text: string; start: number; end: number }
/** `wordStarts` holds when each word of `lines` is said, in order, for the word highlight. */
export interface Cue { start: number; end: number; lines: string[]; wordStarts: number[] }

const MAX_CHARS = 42;
const MAX_LINES = 2;
const MIN_SEC = 1;
const GAP_SEC = 0.08;
const HANG_SEC = 0.25;

interface VoiceWords { id: number; speechStart: number; words: { text: string; start: number; end: number }[] }

/** Every spoken word with its time in the body video, read from the voice timing and the plan. */
export function bodyWords(edl: Edl, voice: { lines: VoiceWords[] }): TimedWord[] {
  const byId = new Map(voice.lines.map(l => [l.id, l]));
  const out: TimedWord[] = [];
  for (const clip of edl.voice) {
    const line = byId.get(clip.lineId);
    if (!line) continue;
    const from = line.speechStart + clip.from;
    const to = line.speechStart + clip.to;
    for (const w of line.words) {
      if (w.start < from - 1e-3 || w.start >= to - 1e-3) continue;
      out.push({ lineId: line.id, text: w.text, start: clip.at + (w.start - from), end: clip.at + (w.end - from) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Groups words into cues: a cue never spans two script lines, holds at most two balanced rows of
 * 42 characters, stays up at least a second when there is room, and never overlaps the next cue.
 */
export function buildCues(words: TimedWord[]): Cue[] {
  const cues: Cue[] = [];
  const byLine = new Map<number, TimedWord[]>();
  for (const w of words) byLine.set(w.lineId, [...(byLine.get(w.lineId) ?? []), w]);
  for (const lineWords of byLine.values()) {
    for (const chunk of chunks(lineWords)) {
      cues.push({ start: chunk[0].start, end: chunk.at(-1)!.end + HANG_SEC, lines: balance(chunk.map(w => w.text)), wordStarts: chunk.map(w => w.start) });
    }
  }
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length; i++) {
    const limit = i + 1 < cues.length ? cues[i + 1].start - GAP_SEC : Infinity;
    cues[i].end = Math.min(Math.max(cues[i].end, cues[i].start + MIN_SEC), limit);
  }
  return cues;
}

const length = (ws: string[]) => ws.join(' ').length;

/** Splits a line's words into pieces that fit two rows, cutting after punctuation when it can. */
function chunks(words: TimedWord[]): TimedWord[][] {
  const out: TimedWord[][] = [];
  let rest = words;
  while (rest.length) {
    if (length(rest.map(w => w.text)) <= MAX_CHARS * MAX_LINES - 6) { out.push(rest); break; }
    let fit = 1;
    while (fit < rest.length && length(rest.slice(0, fit + 1).map(w => w.text)) <= MAX_CHARS * MAX_LINES - 6) fit++;
    // Prefer to end on punctuation in the second half of what fits.
    let cut = fit;
    for (let i = fit; i > Math.ceil(fit / 2); i--) {
      if (/[,;:.!?]$/.test(rest[i - 1].text)) { cut = i; break; }
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return out;
}

/** One row if it fits, else two rows split where they come out most even. */
function balance(words: string[]): string[] {
  if (length(words) <= MAX_CHARS) return [words.join(' ')];
  let best = 1;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = length(words.slice(0, i));
    const b = length(words.slice(i));
    if (a > MAX_CHARS || b > MAX_CHARS) continue;
    const score = Math.abs(a - b) - (/[,;:.!?]$/.test(words[i - 1]) ? 6 : 0);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

export function shiftCues(cues: Cue[], by: number): Cue[] {
  return cues.map(c => ({ ...c, start: c.start + by, end: c.end + by, wordStarts: c.wordStarts.map(t => t + by) }));
}

/**
 * The cue as word states in whole frames: each word stays lit from when it is said until the next
 * word starts, the last one until the cue ends. A state shorter than a frame is skipped.
 */
export function highlightFrames(cue: Cue, fps: number): { active: number; from: number; to: number }[] {
  const end = Math.round(cue.end * fps);
  const out: { active: number; from: number; to: number }[] = [];
  let from = Math.round(cue.start * fps);
  cue.wordStarts.forEach((_, k) => {
    const to = Math.min(end, k + 1 < cue.wordStarts.length ? Math.round(cue.wordStarts[k + 1] * fps) : end);
    if (to <= from) return;
    out.push({ active: k, from, to });
    from = to;
  });
  return out;
}

export function toSrt(cues: Pick<Cue, 'start' | 'end' | 'lines'>[]): string {
  const stamp = (sec: number) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  };
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.lines.join('\n')}\n`).join('\n');
}
