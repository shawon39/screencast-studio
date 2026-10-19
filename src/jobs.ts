import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JOBS_DIR } from './lib/env.ts';
import type { MediaInfo } from './lib/ffmpeg.ts';
import { readJson, writeJson } from './lib/files.ts';

export const PHASES = ['listen', 'rewrite', 'review', 'voice', 'cut', 'finish'] as const;
export type Phase = typeof PHASES[number];

/**
 * draft: uploaded, not started. running: steps are working. paused: stopped where the
 * current build ends. review: waiting for the person. stopped: the app closed mid-run.
 */
export type Status = 'draft' | 'running' | 'paused' | 'review' | 'done' | 'failed' | 'stopped';

export interface Job {
  id: string;
  createdAt: string;
  sourceName: string;
  /** Relative to the job folder, e.g. "input/raw.mp4". Never written after upload. */
  inputFile: string;
  title: string | null;
  options: { subtitles: boolean };
  media: MediaInfo | null;
  /** Loudness envelope for the timeline, 0..1 per step. */
  waveform?: number[];
  status: Status;
  phase: Phase | null;
  /** 0..1 across all six phases; drives the playhead. */
  progress: number;
  phaseTimes: Partial<Record<Phase, { start: string; end?: string }>>;
  now: { main: string; sub: string } | null;
  log: { at: string; text: string }[];
  error: { message: string; hint?: string } | null;
  listen?: { words?: number; stills?: number; changes?: number; pauses?: number };
  review?: { lines: number; dropped: number; cues: number };
  voice?: { lines: number; fromCache: number; characters: number };
  cut?: { durationSec: number; cues: number; cuesInSync: number; maxSpeed: number };
  result?: {
    finalSec: number;
    rawSec: number;
    cues: number;
    cuesInSync: number;
    worstSsim: number;
    lufs: number;
    truePeak: number;
    characters: number;
    problems: string[];
    changes: string[];
  };
}

const jobs = new Map<string, Job>();
const pendingWrites = new Map<string, NodeJS.Timeout>();
/** Writes of one job.json run one after another, so an older snapshot never lands last. */
const writeChains = new Map<string, Promise<void>>();

/** Emits 'change' with the job after every update. */
export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);

export const jobDir = (id: string) => join(JOBS_DIR, id);
export const isJobId = (id: string) => /^[a-z0-9][a-z0-9-]{0,80}$/.test(id);

export async function loadJobs(): Promise<void> {
  await mkdir(JOBS_DIR, { recursive: true });
  for (const id of await readdir(JOBS_DIR)) {
    const file = join(jobDir(id), 'job.json');
    if (!isJobId(id) || !existsSync(file)) continue;
    const job = await readJson<Job>(file);
    if (job.status === 'draft') {
      await rm(jobDir(id), { recursive: true, force: true });
      continue;
    }
    if (job.status === 'running') {
      job.status = 'stopped';
      job.now = { main: 'This video stopped when the app closed', sub: 'Continue to pick up where it left off. Finished steps are kept.' };
      await writeJson(file, job);
    }
    jobs.set(id, job);
  }
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export async function createJob(sourceName: string, ext: string): Promise<Job> {
  const stem = sourceName.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'recording';
  const base = `${new Date().toISOString().slice(0, 10)}-${stem}`;
  let id = base;
  for (let n = 2; jobs.has(id) || existsSync(jobDir(id)); n++) id = `${base}-${n}`;
  for (const sub of ['input', 'work', 'output']) await mkdir(join(jobDir(id), sub), { recursive: true });
  const job: Job = {
    id,
    createdAt: new Date().toISOString(),
    sourceName,
    inputFile: `input/raw${ext}`,
    title: null,
    options: { subtitles: false },
    media: null,
    status: 'draft',
    phase: null,
    progress: 0,
    phaseTimes: {},
    now: null,
    log: [],
    error: null,
  };
  jobs.set(id, job);
  await saveJob(job, { now: true });
  return job;
}

/** Tells listeners right away; writes job.json at most every 400 ms unless `now` is set. */
export async function saveJob(job: Job, opts: { now?: boolean } = {}): Promise<void> {
  jobEvents.emit('change', job);
  const write = () => {
    pendingWrites.delete(job.id);
    const snapshot = JSON.parse(JSON.stringify(job)) as Job;
    const next = (writeChains.get(job.id) ?? Promise.resolve())
      .then(() => (jobs.has(job.id) ? writeJson(join(jobDir(job.id), 'job.json'), snapshot) : undefined));
    writeChains.set(job.id, next.catch(() => {}));
    return next;
  };
  const pending = pendingWrites.get(job.id);
  if (opts.now) {
    if (pending) clearTimeout(pending);
    await write();
  } else if (!pending) {
    pendingWrites.set(job.id, setTimeout(() => { write().catch(err => console.error(err)); }, 400));
  }
}

export async function deleteJob(id: string): Promise<void> {
  const pending = pendingWrites.get(id);
  if (pending) clearTimeout(pending);
  pendingWrites.delete(id);
  jobs.delete(id);
  await rm(jobDir(id), { recursive: true, force: true });
}

export function addLog(job: Job, text: string): void {
  job.log.push({ at: new Date().toISOString(), text });
  if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
}
