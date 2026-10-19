import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plan } from '../src/lib/timemap.ts';
import { planLines, splitMerged } from '../src/steps/07-plan.ts';
import type { VoiceLine } from '../src/steps/06-voice.ts';

const voiced = (id: number, speechStart: number, speechEnd: number, extra: Partial<VoiceLine> = {}): VoiceLine =>
  ({ id, file: 'voice/take-001.mp3', speechStart, speechEnd, words: [], anchors: [], breaks: [], runsOn: false, characters: 0, ...extra });

const recorded = new Map([
  [1, voiced(1, 0, 2)],
  // The take runs from line 1 straight into line 2.
  [2, voiced(2, 2.02, 3.5, { runsOn: true, anchors: [{ word: 'click', source: 12, at: 12, voiceAt: 2.8 }] })],
  [3, voiced(3, 3.9, 5)],
]);
const kept = [{ id: 1, start: 10, end: 11.5 }, { id: 2, start: 11.6, end: 13 }, { id: 3, start: 14, end: 15 }];

test('a line the voice runs into is planned together with the line before it', () => {
  const { lines, members } = planLines(kept, recorded);
  assert.deepEqual(lines.map(l => l.id), [1, 3]);
  assert.deepEqual(members.get(1), [1, 2]);
  assert.equal(lines[0].speech, 3.5);
  assert.deepEqual(lines[0].anchors, [{ word: 'click', source: 12, voice: 2.8 }]);
  assert.ok(Math.abs(lines[1].pauseBefore! - 0.4) < 1e-9);
});

test('merged lines get their own clips back, and the take plays straight through between them', () => {
  const { lines, members } = planLines(kept, recorded);
  const edl = splitMerged(plan({ fps: 30, durationSec: 20, still: [{ start: 0, end: 10 }, { start: 15, end: 20 }], lines }), members, recorded);
  const [a, b] = edl.voice;
  assert.deepEqual([a.lineId, b.lineId], [1, 2]);
  assert.ok(Math.abs(a.at + (a.to - a.from) - b.at) < 1e-9, 'the clips meet in time');
  assert.ok(Math.abs(recorded.get(1)!.speechStart + a.to - (recorded.get(2)!.speechStart + b.from)) < 1e-9, 'and in the take');
  assert.equal(edl.anchors[0].lineId, 2, 'the cue keeps its own line');
});
