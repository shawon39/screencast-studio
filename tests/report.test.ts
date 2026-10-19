import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport, reportForDownload } from '../src/lib/report.ts';
import type { Script } from '../src/lib/script.ts';
import type { Edl } from '../src/lib/timemap.ts';
import type { CheckResult } from '../src/steps/11-check.ts';

const where = {
  pictureUrl: 'http://localhost:4321/api/jobs/demo/cuts',
  folder: '/Users/me/Video Rec/jobs/demo/output/cuts',
  keys: { 'cuts/cut-01.png': 'aaaaaaaaaaaa1111', 'cuts/problem-01.png': 'bbbbbbbbbbbb2222' },
};

test('the downloaded report links its pictures through the app and says where they are', () => {
  const report = '# Demo\n\nMade today.\n\n## Checks\n\n| Voice cut | [00:36.1](cuts/cut-01.png), [00:55.4](cuts/cut-02.png) |\n| Still screens | [00:03.2](cuts/video-01.png) |\n\n- Too loud [See it at 01:10.2](cuts/problem-01.png)\n';
  const out = reportForDownload(report, where);
  assert.match(out, /\[00:36\.1\]\(http:\/\/localhost:4321\/api\/jobs\/demo\/cuts\/cut-01\.png\?k=aaaaaaaaaaaa\)/);
  assert.match(out, /\[See it at 01:10\.2\]\(http:\/\/localhost:4321\/api\/jobs\/demo\/cuts\/problem-01\.png\?k=bbbbbbbbbbbb\)/);
  assert.match(out, /\[00:55\.4\]\(http:\/\/localhost:4321\/api\/jobs\/demo\/cuts\/cut-02\.png\)/, 'a picture with no key is linked without one');
  assert.doesNotMatch(out, /\]\(cuts\//);
  assert.match(out, /^# Demo\n\nMade today\.\n\nThe picture links open in Screencast Studio.*`\/Users\/me\/Video Rec\/jobs\/demo\/output\/cuts`\.\n\n## Checks\n/);
});

test('a report without pictures downloads as it is', () => {
  const report = '# Demo\n\nMade today.\n\n## Checks\n\nNo problems found.\n';
  assert.equal(reportForDownload(report, where), report);
  const other = '# Demo\n\nSee [the notes](cuts/notes.md).\n\n## Checks\n';
  assert.equal(reportForDownload(other, where), other, 'only links to pictures are rewritten');
});

test('the report links each voice cut and video cut by its time, and a problem to its picture', () => {
  const script = { title: 'Demo', lines: [{ id: 1, start: 0, end: 2, said: ['Click', 'here.'], saidCount: 2, keep: true, clean: 'Click here.', reason: '', anchors: [] }] } as Script;
  const edl = { fps: 30, frames: 60, durationSec: 2, video: [], voice: [], anchors: [], cuts: [], stats: { maxSpeedWhileSpeaking: 1, minSpeed: 1, holdSec: 0, voicePauseSec: 0 }, notes: [] } as Edl;
  const check: CheckResult = {
    passes: 1, durationSec: 5, expectedSec: 5, lufs: -16, truePeak: -1.5, anchors: [], worstSsim: 1, cutsOnStillOnly: true, videoCuts: { count: 3, noJump: 2, mostChangedPx: 844 },
    voiceCuts: { count: 2, inPause: 1, minUnderDb: 20 }, gain: { words: 3, pauses: 3.2 }, stops: [],
    problems: ['Line 1: the voice is cut on a word.', 'The true peak is too high.'], problemAt: [1.5, null],
  };
  const pictures = { cuts: [{ file: 'cuts/cut-01.png', at: 1.5 }, { file: 'cuts/cut-02.png', at: 62.2 }], videoCuts: [{ file: 'cuts/video-01.png', at: 3.2 }], problems: [{ file: 'cuts/cut-01.png', at: 1.5 }, null], keys: {} };
  const report = buildReport({ title: 'Demo', sourceName: 'demo.mov', rawSec: 10, finalSec: 5, size: { width: 1920, height: 1248 }, script, edl, check, pictures, characters: 11 });
  assert.match(report, /\| 1 of 2, the closest 20 dB under\. See each one, by time in the video: \[00:01\.5\]\(cuts\/cut-01\.png\), \[01:02\.2\]\(cuts\/cut-02\.png\) \|/);
  assert.match(report, /Final video: 0:05 at 1920 × 1248, 30 fps\./);
  assert.match(report, /\| Cuts only on still screens \| yes \|/);
  assert.match(report, /\| No jump at a video cut: 100 pixels or fewer change in the part cut out \| 2 of 3, the most 844 of 518,400 pixels\. See each one, by time in the video: \[00:03\.2\]\(cuts\/video-01\.png\) \|/);
  assert.match(report, /^- Line 1: the voice is cut on a word\. \[See it at 00:01\.5\]\(cuts\/cut-01\.png\)$/m);
  assert.match(report, /^- The true peak is too high\.$/m);
});
