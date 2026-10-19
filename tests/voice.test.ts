import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphs } from '../src/steps/06-voice.ts';

const l = (id: number, start: number, end: number, clean = 'A short sentence.') => ({ id, start, end, clean });
const ids = (groups: { id: number }[][]) => groups.map(g => g.map(x => x.id));

test('a pause of a second or more in the recording starts a new take', () => {
  assert.deepEqual(ids(paragraphs([l(1, 0, 2), l(2, 2.3, 4), l(3, 5.2, 7), l(4, 7.1, 9)])), [[1, 2], [3, 4]]);
});

test('a long paragraph splits at its longest pause', () => {
  const long = 'x'.repeat(300);
  const lines = [l(1, 0, 2, long), l(2, 2.2, 4, long), l(3, 4.9, 6, long), l(4, 6.1, 8, long)];
  assert.deepEqual(ids(paragraphs(lines)), [[1, 2], [3, 4]]);
});

test('editing a line never moves the take breaks', () => {
  const before = [l(1, 0, 2), l(2, 2.3, 4), l(3, 5.2, 7)];
  const after = [l(1, 0, 2), l(2, 2.3, 4, 'A much longer sentence than it was before the edit.'), l(3, 5.2, 7)];
  assert.deepEqual(ids(paragraphs(before)), ids(paragraphs(after)));
});
