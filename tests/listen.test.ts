// Shot 1 check: on the synthetic recording, screen.json must show the still pause and the
// page load at the right times. Build the fixture first: node scripts/make-test-video.ts
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Job } from '../src/jobs.ts';
import { readJson } from '../src/lib/files.ts';
import type { StepContext } from '../src/pipeline.ts';
import { probeStep } from '../src/steps/01-probe.ts';
import { analyzeStep } from '../src/steps/03-analyze.ts';
import type { Interval, Screen } from '../src/steps/03-analyze.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'test-recording.mp4');
const TRUTH = join(import.meta.dirname, 'fixtures', 'test-recording.truth.json');
const haveFixture = existsSync(FIXTURE) && existsSync(TRUTH);

interface Truth {
  durationSec: number;
  clicks: number[];
  stillPause: Interval;
  pageLoad: Interval;
  lines: Record<string, Interval & { text: string }>;
}

let dir = '';
let screen: Screen;
let truth: Truth;

before(async () => {
  if (!haveFixture) return;
  dir = await mkdtemp(join(tmpdir(), 'studio-listen-'));
  const job = { listen: {}, media: null } as unknown as Job;
  const ctx: StepContext = {
    job,
    input: FIXTURE,
    work: name => join(dir, name),
    output: name => join(dir, name),
    say: () => {},
    detail: () => {},
    progress: () => {},
  };
  await probeStep.run(ctx);
  await analyzeStep.run(ctx);
  screen = await readJson<Screen>(join(dir, 'screen.json'));
  truth = await readJson<Truth>(TRUTH);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const contains = (outer: Interval, inner: Interval, slack: number) =>
  outer.start <= inner.start + slack && outer.end >= inner.end - slack;

test('the 10-second still pause is one still part', { skip: !haveFixture }, () => {
  // The caret blinks during the pause; it must not count as movement.
  const hit = screen.still.find(s => contains(s, truth.stillPause, 0.15));
  assert.ok(hit, `no still part covers ${JSON.stringify(truth.stillPause)}; found ${JSON.stringify(screen.still)}`);
});

test('the 10-second page load is one moving part', { skip: !haveFixture }, () => {
  const hit = screen.moving.find(m => contains(m, truth.pageLoad, 0.15));
  assert.ok(hit, `no moving part covers ${JSON.stringify(truth.pageLoad)}; found ${JSON.stringify(screen.moving)}`);
});

test('each click shows up as a screen change within 100 ms', { skip: !haveFixture }, () => {
  for (const click of truth.clicks) {
    const near = screen.changes.find(c => Math.abs(c.t - click) <= 0.1);
    assert.ok(near, `no screen change near the click at ${click} s; changes: ${JSON.stringify(screen.changes)}`);
  }
});

test('a moving cursor is never inside a still part', { skip: !haveFixture }, () => {
  // The cursor travels to the New Flow button during the third line.
  const line = truth.lines.click1;
  const travel = { start: line.start + 0.1, end: line.start + (line.end - line.start) * 0.8 };
  const overlap = screen.still.find(s => s.start < travel.end && s.end > travel.start);
  assert.equal(overlap, undefined, `still part ${JSON.stringify(overlap)} overlaps cursor travel ${JSON.stringify(travel)}`);
});

test('pauses in speech are found', { skip: !haveFixture }, () => {
  const long = screen.silences.find(s => contains(s, { start: truth.stillPause.start + 0.3, end: truth.stillPause.end - 0.3 }, 0));
  assert.ok(long, 'the 10-second silent pause is missing from silences');
});
