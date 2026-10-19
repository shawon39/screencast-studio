import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeAnchors, buildScript, contentCount, splitLines, validate } from '../src/lib/script.ts';
import type { RewriteAnswer } from '../src/lib/script.ts';
import type { Word } from '../src/steps/02-transcribe.ts';

/** Builds timed words from text: each word 0.3 s, a pause where "|" appears. */
function words(text: string): Word[] {
  const out: Word[] = [];
  let t = 0;
  for (const part of text.split(' ')) {
    if (part === '|') { t += 2; continue; }
    out.push({ text: part, start: t, end: t + 0.25, type: part.startsWith('(') ? 'audio_event' : 'word' });
    t += 0.3;
  }
  return out;
}

test('splits at sentence ends and long pauses', () => {
  const w = words('Hi everyone. Now click here on New Flow. then select | screen flow');
  const lines = splitLines(w);
  assert.deepEqual(lines.map(l => [l.first, l.last]), [[0, 1], [2, 7], [8, 9], [10, 11]]);
});

test('a trailing ellipsis without a pause does not end the line', () => {
  const lines = splitLines(words('Then select the, the... Sorry.'));
  assert.equal(lines.length, 1);
});

test('fillers and stutters are not counted as said words', () => {
  const w = words('so uhm today we gonna build a screen flow that, that creates a case.');
  assert.equal(contentCount(w, splitLines(w)[0]), 12);
});

const w = words('Now click here on New Flow. Then select the, the... | Sorry. uh so we we add a lot of extra stuff.');
const source = splitLines(w);

const good: RewriteAnswer = {
  title: 'New flow',
  lines: [
    { id: 1, keep: true, clean: 'Now click here on New Flow.', anchors: [{ word: 'click', source: 1 }, { word: 'here', source: 2 }] },
    { id: 2, keep: false, clean: 'Then select the...', reason: 'A false start.', anchors: [{ word: 'select', source: 7 }] },
    { id: 3, keep: false, clean: 'Sorry.', reason: 'Not an instruction.', anchors: [] },
    { id: 4, keep: true, clean: 'We add a lot of extra stuff.', anchors: [] },
  ],
};

test('a rule-following answer passes', () => {
  assert.deepEqual(validate(source, w, good), []);
});

test('adding words fails', () => {
  const bad = structuredClone(good);
  bad.lines[3].clean = 'Next we add a lot of extra stuff to the flow builder canvas today.';
  assert.match(validate(source, w, bad).join(' '), /Line 4 has \d+ words/);
});

test('dropping an action word fails, and so does not marking it', () => {
  const dropped = structuredClone(good);
  dropped.lines[0].clean = 'Now go to New Flow.';
  dropped.lines[0].anchors = [];
  assert.match(validate(source, w, dropped).join(' '), /said "click", but the clean text dropped it/);
  const unmarked = structuredClone(good);
  unmarked.lines[0].anchors = [];
  assert.match(validate(source, w, unmarked).join(' '), /"click" is not marked as a cue/);
});

test('a cue must point at the same spoken word inside its line', () => {
  const bad = structuredClone(good);
  bad.lines[0].anchors[0].source = 4;
  assert.match(validate(source, w, bad).join(' '), /points at word #4, which is "New"/);
});

test('missing or doubled lines fail', () => {
  const bad = structuredClone(good);
  bad.lines.pop();
  bad.lines.push({ ...bad.lines[0] });
  const problems = validate(source, w, bad).join(' ');
  assert.match(problems, /Line 4 is missing/);
  assert.match(problems, /more than once/);
});

test('a cue edited out of the clean text stops counting', () => {
  const script = buildScript(source, w, good, 'New flow');
  const line = { ...script.lines[0], clean: 'Now open New Flow.' };
  assert.deepEqual(activeAnchors(line), []);
  assert.deepEqual(activeAnchors(script.lines[0]).map(a => a.word), ['click', 'here']);
});
