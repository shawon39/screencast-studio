import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCues, highlightFrames, shiftCues, toSrt } from '../src/lib/subtitles.ts';
import type { TimedWord } from '../src/lib/subtitles.ts';

function words(lineId: number, text: string, start: number, perWord = 0.3): TimedWord[] {
  return text.split(' ').map((t, i) => ({ lineId, text: t, start: start + i * perWord, end: start + i * perWord + 0.25 }));
}

test('a short line is one cue on one row', () => {
  const cues = buildCues(words(1, 'Now, on the New Flow button, click here.', 2));
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0].lines, ['Now, on the New Flow button, click here.']);
});

test('a longer line splits into two even rows of at most 42 characters', () => {
  const cues = buildCues(words(1, 'Then select Screen Flow, and to create it, click here.', 0));
  assert.equal(cues.length, 1);
  assert.equal(cues[0].lines.length, 2);
  for (const row of cues[0].lines) assert.ok(row.length <= 42, row);
  assert.deepEqual(cues[0].lines, ['Then select Screen Flow,', 'and to create it, click here.']);
});

test('a very long line becomes several cues, each two rows at most', () => {
  const long = 'First, open Setup and search for flows in the Quick Find box, then open the Flows page, choose New Flow, pick a screen flow and wait for the canvas to load before you continue.';
  const cues = buildCues(words(1, long, 0));
  assert.ok(cues.length >= 2);
  for (const c of cues) {
    assert.ok(c.lines.length <= 2);
    for (const row of c.lines) assert.ok(row.length <= 42, row);
  }
  assert.equal(cues.map(c => c.lines.join(' ')).join(' '), long);
});

test('cues never overlap and never span two script lines', () => {
  const cues = buildCues([...words(1, 'Hi everyone.', 0), ...words(2, 'Today we build a flow.', 0.9)]);
  assert.equal(cues.length, 2);
  assert.ok(cues[0].end <= cues[1].start - 0.08 + 1e-9);
});

test('each cue keeps when each of its words is said, one per word in its rows', () => {
  const said = words(1, 'Then select Screen Flow, and to create it, click here.', 2);
  const cues = buildCues(said);
  assert.deepEqual(cues[0].wordStarts, said.map(w => w.start));
  assert.equal(cues[0].wordStarts.length, cues[0].lines.join(' ').split(' ').length);
  assert.deepEqual(shiftCues(cues, 3)[0].wordStarts, cues[0].wordStarts.map(t => t + 3));
});

test('each word stays lit until the next is said, the last until the cue ends', () => {
  const cue = { start: 1, end: 2.5, lines: ['Click here now.'], wordStarts: [1, 1.4, 1.5] };
  assert.deepEqual(highlightFrames(cue, 30), [
    { active: 0, from: 30, to: 42 },
    { active: 1, from: 42, to: 45 },
    { active: 2, from: 45, to: 75 },
  ]);
});

test('a word too short for a frame is skipped and the next takes over', () => {
  const cue = { start: 1, end: 2, lines: ['a b c'], wordStarts: [1, 1.01, 1.5] };
  assert.deepEqual(highlightFrames(cue, 30), [
    { active: 1, from: 30, to: 45 },
    { active: 2, from: 45, to: 60 },
  ]);
});

test('srt numbering and timestamps', () => {
  const srt = toSrt([{ start: 3.1, end: 4.25, lines: ['Hi everyone.'] }, { start: 61.5, end: 63, lines: ['Two', 'rows'] }]);
  assert.equal(srt, '1\n00:00:03,100 --> 00:00:04,250\nHi everyone.\n\n2\n00:01:01,500 --> 00:01:03,000\nTwo\nrows\n');
});
