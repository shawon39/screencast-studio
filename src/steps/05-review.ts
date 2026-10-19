import type { Step } from '../pipeline.ts';
import { readJson } from '../lib/files.ts';
import type { Script } from '../lib/script.ts';

/** Stage 5. The one stop: the pipeline waits here until the script is approved. */
export const reviewStep: Step = {
  name: 'Waiting for your review',
  phase: 'review',
  weight: 1,
  inputs: () => [],
  outputs: () => [],
  waitsForPerson: async ctx => !(await readJson<Script>(ctx.work('script.json'))).approvedAt,
  async run() {},
};
