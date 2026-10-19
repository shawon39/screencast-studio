import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { addLog, getJob, jobDir, PHASES, saveJob } from './jobs.ts';
import type { Job, Phase } from './jobs.ts';
import { UserError } from './lib/errors.ts';
import { probeStep } from './steps/01-probe.ts';
import { transcribeStep } from './steps/02-transcribe.ts';
import { analyzeStep } from './steps/03-analyze.ts';
import { rewriteStep } from './steps/04-rewrite.ts';
import { reviewStep } from './steps/05-review.ts';
import { voiceStep } from './steps/06-voice.ts';
import { planStep } from './steps/07-plan.ts';
import { renderStep } from './steps/08-render.ts';
import { cardsStep } from './steps/09-cards.ts';
import { finishStep } from './steps/10-finish.ts';
import { checkStep } from './steps/11-check.ts';
import { picturesStep } from './steps/12-pictures.ts';
import { deliverStep } from './steps/13-deliver.ts';

export interface StepContext {
  job: Job;
  /** The untouched upload. */
  input: string;
  /** A path inside the job's work/ folder. */
  work: (name: string) => string;
  /** A path inside the job's output/ folder, for the finished files. */
  output: (name: string) => string;
  /** Sets the headline of what is happening and logs it. */
  say: (main: string, sub?: string) => void;
  /** Updates the detail line only, without logging. */
  detail: (sub: string) => void;
  /** Progress inside this step, 0..1. */
  progress: (fraction: number) => void;
}

export interface Step {
  /** Shown in the log, e.g. "Reading the file". */
  name: string;
  phase: Phase;
  /** This step's share of its phase on the progress ruler. */
  weight: number;
  inputs: (ctx: StepContext) => string[];
  outputs: (ctx: StepContext) => string[];
  run: (ctx: StepContext) => Promise<void>;
  /** A stop for the person: while this returns true, the job waits in 'review'. */
  waitsForPerson?: (ctx: StepContext) => Promise<boolean>;
}

const STEPS: Step[] = [
  probeStep, transcribeStep, analyzeStep, // Listen
  rewriteStep, // Rewrite
  reviewStep, // Review: the one stop
  voiceStep, // Voice
  planStep, renderStep, // Cut
  cardsStep, finishStep, checkStep, picturesStep, deliverStep, // Finish
];

const PHASE_HEADLINE: Record<Phase, string> = {
  listen: 'Listening to your recording',
  rewrite: 'Cleaning up the script',
  review: 'Waiting for your review',
  voice: 'Recording the new voice',
  cut: 'Cutting the video to fit the voice',
  finish: 'Adding intro, outro and subtitles',
};

const sentence = (s: string) => /[.!?]$/.test(s) ? s : `${s}.`;

/** A step is fresh when every output exists and none is older than any input. */
function isFresh(step: Step, ctx: StepContext): boolean {
  const outputs = step.outputs(ctx);
  if (!outputs.every(f => existsSync(f))) return false;
  const oldestOutput = Math.min(...outputs.map(f => statSync(f).mtimeMs));
  const newestInput = Math.max(0, ...step.inputs(ctx).filter(f => existsSync(f)).map(f => statSync(f).mtimeMs));
  return oldestOutput >= newestInput;
}

function setProgress(job: Job, step: Step, fraction: number): void {
  const phaseSteps = STEPS.filter(s => s.phase === step.phase);
  const total = phaseSteps.reduce((sum, s) => sum + s.weight, 0);
  const before = phaseSteps.slice(0, phaseSteps.indexOf(step)).reduce((sum, s) => sum + s.weight, 0);
  const within = (before + step.weight * Math.max(0, Math.min(1, fraction))) / total;
  job.progress = (PHASES.indexOf(step.phase) + within) / PHASES.length;
}

let queue: Promise<void> = Promise.resolve();

/** Runs (or resumes) a job. Jobs run one at a time; finished steps are skipped. */
export function startJob(id: string): void {
  const job = getJob(id);
  if (!job || job.status === 'running') return;
  job.status = 'running';
  job.error = null;
  job.now = { main: PHASE_HEADLINE[job.phase ?? 'listen'], sub: 'Waiting for the video before it to finish' };
  void saveJob(job, { now: true });
  queue = queue.then(() => runSteps(job));
}

async function runSteps(job: Job): Promise<void> {
  const dir = jobDir(job.id);
  let lastSaved = 0;
  try {
    for (const step of STEPS) {
      if (job.phase !== step.phase || !job.phaseTimes[step.phase]) {
        job.phase = step.phase;
        job.phaseTimes[step.phase] ??= { start: new Date().toISOString() };
      }
      const ctx: StepContext = {
        job,
        input: join(dir, job.inputFile),
        work: name => join(dir, 'work', name),
        output: name => join(dir, 'output', name),
        say: (main, sub = '') => {
          job.now = { main: PHASE_HEADLINE[step.phase], sub: [main, sub].filter(Boolean).map(sentence).join(' ') };
          addLog(job, main);
          void saveJob(job);
        },
        detail: sub => {
          job.now = { main: PHASE_HEADLINE[step.phase], sub };
          void saveJob(job);
        },
        progress: fraction => {
          setProgress(job, step, fraction);
          if (Date.now() - lastSaved > 250) {
            lastSaved = Date.now();
            void saveJob(job);
          }
        },
      };
      if (step.waitsForPerson) {
        if (await step.waitsForPerson(ctx)) {
          const r = job.review;
          job.status = 'review';
          job.progress = (PHASES.indexOf(step.phase) + 0.12) / PHASES.length;
          job.now = {
            main: 'Your turn: review the script',
            sub: r ? `Claude cleaned ${r.lines} lines, dropped ${r.dropped} and marked ${r.cues} cues. Check them, then approve.` : 'Check the script, then approve.',
          };
          addLog(job, 'Waiting for your review');
          await saveJob(job, { now: true });
          return;
        }
      } else if (isFresh(step, ctx)) {
        addLog(job, `${step.name}: already done`);
      } else {
        ctx.say(step.name);
        await step.run(ctx);
      }
      setProgress(job, step, 1);
      const last = STEPS.filter(s => s.phase === step.phase).at(-1);
      if (last === step) job.phaseTimes[step.phase]!.end ??= new Date().toISOString();
      await saveJob(job, { now: true });
    }
    job.status = 'done';
    job.progress = 1;
    job.now = { main: 'Your video is ready', sub: job.result?.problems.length ? 'The report lists what to look at.' : 'Every check passed.' };
    addLog(job, 'Your video is ready');
    await saveJob(job, { now: true });
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof UserError
      ? { message: err.message, hint: err.hint }
      : { message: err instanceof Error ? err.message : String(err), hint: 'Try again. If it fails the same way, the log below shows the step that broke.' };
    addLog(job, `Stopped: ${job.error.message}`);
    console.error(`[${job.id}]`, err);
    await saveJob(job, { now: true });
  }
}
