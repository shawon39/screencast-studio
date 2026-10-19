import type { Word } from '../steps/02-transcribe.ts';

/** A sentence of the transcript: the unit Claude rewrites and the voice later reads. */
export interface SourceLine {
  id: number;
  start: number;
  end: number;
  /** Index range into transcript.words, inclusive. */
  first: number;
  last: number;
}

/** An action word in the clean text, tied to the moment the speaker said it. */
export interface Anchor {
  word: string;
  /** Index of the spoken word in transcript.words. */
  source: number;
  /** When it was said, in seconds of the raw recording. */
  at: number;
}

export interface ScriptLine {
  id: number;
  start: number;
  end: number;
  /** What was said, word by word, fillers included. Audio events are in [brackets]. */
  said: string[];
  /** Words that carry content: fillers and immediate repeats are not counted. */
  saidCount: number;
  keep: boolean;
  clean: string;
  /** Why Claude dropped the line, for the reviewer. Empty for kept lines. */
  reason: string;
  /** Cues Claude marked, in order. A cue whose word was edited away is ignored (see activeAnchors). */
  anchors: Anchor[];
}

export interface Script {
  title: string;
  lines: ScriptLine[];
  editedAt?: string;
  approvedAt?: string;
}

/** What Claude returns for each line. */
export interface RewriteAnswer {
  title: string;
  lines: { id: number; keep: boolean; clean: string; reason?: string; anchors: { word: string; source: number }[] }[];
}

const FILLERS = new Set(['uh', 'uhm', 'um', 'umm', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm']);
/** Action words a kept line must keep and mark as cues. "here" and "this" are left to Claude's judgment. */
export const ACTION_WORDS = ['click', 'select', 'open', 'type', 'drag'];

/** "Click," → "click"; keeps inner apostrophes ("we're"). */
export const norm = (w: string) => w.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
export const tokens = (text: string) => text.split(/\s+/).map(norm).filter(Boolean);

/** Same word, allowing a changed ending ("clicking" said, "click" written). */
const sameWord = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * Splits the transcript into sentences at sentence-ending punctuation, or at a pause over 1.5 s.
 * A trailing "..." only ends a sentence when a pause follows.
 */
export function splitLines(words: Word[]): SourceLine[] {
  const lines: SourceLine[] = [];
  let first = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (first < 0) first = i;
    const gap = i + 1 < words.length ? words[i + 1].start - w.end : Infinity;
    const ellipsis = /\.\.\.["')\]]*$/.test(w.text) || /…$/.test(w.text);
    const stop = w.type === 'word' && /[.?!]["')\]]*$/.test(w.text) && (!ellipsis || gap > 0.6);
    if (stop || gap > 1.5) {
      const span = words.slice(first, i + 1);
      if (span.some(x => x.type === 'word')) {
        lines.push({ id: lines.length + 1, start: span[0].start, end: span.at(-1)!.end, first, last: i });
      }
      first = -1;
    }
  }
  return lines;
}

export function saidWords(words: Word[], line: SourceLine): string[] {
  return words.slice(line.first, line.last + 1).map(w => (w.type === 'audio_event' ? `[${w.text.replace(/^\(|\)$/g, '')}]` : w.text));
}

export function contentCount(words: Word[], line: SourceLine): number {
  let count = 0;
  let previous = '';
  for (const w of words.slice(line.first, line.last + 1)) {
    if (w.type !== 'word') continue;
    const n = norm(w.text);
    if (!n || FILLERS.has(n) || n === previous) continue;
    previous = n;
    count++;
  }
  return count;
}

/** The longest a clean line may be: +15% of what was said, with one word of slack for short lines. */
export const maxWords = (saidCount: number) => Math.floor(saidCount * 1.15) + 1;

/**
 * Checks Claude's answer against the hard rules. Returns one plain sentence per problem;
 * an empty list means the answer can be used.
 */
export function validate(source: SourceLine[], words: Word[], answer: RewriteAnswer): string[] {
  const problems: string[] = [];
  const byId = new Map(answer.lines.map(l => [l.id, l]));
  if (byId.size !== answer.lines.length) problems.push('Some line numbers appear more than once.');
  for (const id of byId.keys()) if (!source.some(s => s.id === id)) problems.push(`Line ${id} does not exist.`);

  for (const s of source) {
    const a = byId.get(s.id);
    if (!a) { problems.push(`Line ${s.id} is missing.`); continue; }
    const clean = tokens(a.clean);
    if (a.keep && clean.length === 0) problems.push(`Line ${s.id} is kept but its clean text is empty.`);
    const limit = maxWords(contentCount(words, s));
    if (clean.length > limit) problems.push(`Line ${s.id} has ${clean.length} words; the most allowed is ${limit}. Do not add anything the speaker did not say.`);

    let from = 0;
    for (const anchor of a.anchors) {
      const spoken = words[anchor.source];
      const want = norm(anchor.word);
      if (anchor.source < s.first || anchor.source > s.last || !spoken) {
        problems.push(`Line ${s.id}: cue "${anchor.word}" points at word #${anchor.source}, which is not in this line (#${s.first} to #${s.last}).`);
        continue;
      }
      if (!sameWord(norm(spoken.text), want)) {
        problems.push(`Line ${s.id}: cue "${anchor.word}" points at word #${anchor.source}, which is "${spoken.text}".`);
      }
      const at = clean.findIndex((t, i) => i >= from && sameWord(t, want));
      if (at < 0) problems.push(`Line ${s.id}: cue "${anchor.word}" is not in the clean text, or the cues are out of order.`);
      else from = at + 1;
    }

    if (a.keep) {
      const spoken = new Set(words.slice(s.first, s.last + 1).filter(w => w.type === 'word').map(w => norm(w.text)));
      for (const action of ACTION_WORDS) {
        if (![...spoken].some(t => sameWord(t, action))) continue;
        if (!clean.some(t => sameWord(t, action))) problems.push(`Line ${s.id}: the speaker said "${action}", but the clean text dropped it. Keep every action word.`);
        else if (!a.anchors.some(x => sameWord(norm(x.word), action))) problems.push(`Line ${s.id}: "${action}" is not marked as a cue.`);
      }
    }
  }
  return problems;
}

/** Removes cues that break the rules, for use after Claude's second try. Line-level problems are left alone. */
export function dropBadAnchors(source: SourceLine[], words: Word[], answer: RewriteAnswer): RewriteAnswer {
  return {
    ...answer,
    lines: answer.lines.map(a => {
      const s = source.find(x => x.id === a.id);
      if (!s) return a;
      const clean = tokens(a.clean);
      let from = 0;
      const anchors = a.anchors.filter(anchor => {
        const spoken = words[anchor.source];
        const want = norm(anchor.word);
        if (anchor.source < s.first || anchor.source > s.last || !spoken || !sameWord(norm(spoken.text), want)) return false;
        const at = clean.findIndex((t, i) => i >= from && sameWord(t, want));
        if (at < 0) return false;
        from = at + 1;
        return true;
      });
      return { ...a, anchors };
    }),
  };
}

/** Where each cue sits in `text` (character offsets), matching words in order. Cues not found are left out. */
export function anchorPositions(text: string, anchors: Anchor[]): { anchor: Anchor; start: number; end: number }[] {
  const words = [...text.matchAll(/\S+/g)].map(m => ({ n: norm(m[0]), start: m.index, end: m.index + m[0].length }));
  const out: { anchor: Anchor; start: number; end: number }[] = [];
  let from = 0;
  for (const anchor of anchors) {
    const at = words.findIndex((w, i) => i >= from && sameWord(w.n, norm(anchor.word)));
    if (at < 0) continue;
    out.push({ anchor, start: words[at].start, end: words[at].end });
    from = at + 1;
  }
  return out;
}

/** Cues still present in the line's clean text, matched in order. */
export function activeAnchors(line: ScriptLine): Anchor[] {
  return anchorPositions(line.clean, line.anchors).map(p => p.anchor);
}

export function buildScript(source: SourceLine[], words: Word[], answer: RewriteAnswer, title: string): Script {
  const byId = new Map(answer.lines.map(l => [l.id, l]));
  return {
    title,
    lines: source.map(s => {
      const a = byId.get(s.id)!;
      return {
        id: s.id,
        start: s.start,
        end: s.end,
        said: saidWords(words, s),
        saidCount: contentCount(words, s),
        keep: a.keep,
        clean: a.clean.trim(),
        reason: a.keep ? '' : (a.reason ?? '').trim(),
        anchors: a.anchors.map(x => ({ word: x.word, source: x.source, at: words[x.source].start })),
      };
    }),
  };
}
