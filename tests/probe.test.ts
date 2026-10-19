import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameSize } from '../src/steps/01-probe.ts';

test('the master is 1920 wide in the recording\'s own shape, never cut or padded', () => {
  assert.deepEqual(frameSize(1920, 1080), { width: 1920, height: 1080 }); // OBS 1080p is copied as it is
  assert.deepEqual(frameSize(3420, 2224), { width: 1920, height: 1248 }); // a 16:10 MacBook screen
  assert.deepEqual(frameSize(3644, 2372), { width: 1920, height: 1248 });
  assert.equal(frameSize(2560, 1080).height % 4, 0); // ultrawide: still a multiple of 4
});
