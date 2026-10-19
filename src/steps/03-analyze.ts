import { spawn } from 'node:child_process';
import type { Step } from '../pipeline.ts';
import { writeJson } from '../lib/files.ts';

export interface Interval { start: number; end: number }

export interface Screen {
  fps: number;
  durationSec: number;
  params: typeof PARAMS;
  /** Parts where nothing on screen moves or drifts, cursor included. Cuts happen only inside these. */
  still: Interval[];
  /** Everything else: cursor moves, typing, page loads. */
  moving: Interval[];
  /** Single-frame jumps where a large part of the screen changed (clicks that open a page). */
  changes: { t: number; size: number }[];
  /** Pauses in the speech track. */
  silences: Interval[];
  /** Changed pixels per frame at the analysis size, for later steps and debugging. */
  motion: number[];
}

// The screen is compared at 960 × 540 (half size for 16:9; a taller screen is squeezed a little), on the brightness plane. A pixel counts as changed when it differs by more
// than `pixelDiff` levels; a frame is still when at most `stillMaxPixels` changed from the frame before it, and as
// many from the first frame of the still part it would extend. The first test ignores a blinking text caret and
// compression noise but catches a moving cursor, which freezedetect's average misses. The second catches what
// changes too slowly for the first: a pointer creeping 1–2 px a frame, a hover colour fading. A cut inside such a
// part would drop the change and the picture would jump. A frame where at least 0.5% of pixels changed counts as a
// screen change (a toast is about 1%, a fast cursor about 0.06%).
const W = 960;
const H = 540;
const PARAMS = {
  pixelDiff: 20,
  stillMaxPixels: 40,
  changeMinFraction: 0.005,
  minStillSec: 0.5,
  silenceDb: -35,
  minSilenceSec: 0.35,
};
const FPS = 30;

/** One frame from the second on: pixels changed from the frame before, and whether it extends a still part. */
interface FrameMotion { px: number; still: boolean }

/** Stage 3. One ffmpeg pass hands every frame to the comparison and finds pauses in the audio. */
export const analyzeStep: Step = {
  name: 'Finding still screens, page changes and pauses',
  phase: 'listen',
  weight: 2,
  inputs: ctx => [ctx.work('master.mp4')],
  outputs: ctx => [ctx.work('screen.json')],

  async run(ctx) {
    const durationSec = ctx.job.media?.durationSec ?? 0;
    const { frames, log } = await measure(ctx.work('master.mp4'), Math.round(durationSec * FPS), ctx.progress);
    const screen = screenOf(frames, silencesOf(log, durationSec), durationSec);
    await writeJson(ctx.work('screen.json'), screen);
    ctx.job.listen = { ...ctx.job.listen, stills: screen.still.length, changes: screen.changes.length, pauses: screen.silences.length };
    ctx.detail(`Found ${screen.still.length} still parts, ${screen.changes.length} screen changes and ${screen.silences.length} pauses.`);
  },
};

/**
 * Reads master.mp4 as raw brightness frames at the analysis size (the same pixels check.ts compares) and compares
 * each with the frame before it and with the first frame of the still part so far. ffmpeg's log, for silencedetect.
 */
function measure(file: string, expectedFrames: number, onProgress: (fraction: number) => void): Promise<{ frames: FrameMotion[]; log: string }> {
  const graph = [
    `[0:v]scale=${W}:${H}:flags=area,format=yuv420p,extractplanes=y[v]`,
    `[0:a]silencedetect=noise=${PARAMS.silenceDb}dB:d=${PARAMS.minSilenceSec}[a]`,
  ].join(';');
  const args = ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-filter_complex', graph,
    '-map', '[v]', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1', '-map', '[a]', '-f', 'null', '-'];
  const size = W * H;
  const frames: FrameMotion[] = [];
  let prev = new Uint8Array(size);
  let cur = new Uint8Array(size);
  const first = new Uint8Array(size);
  let fill = 0;
  let count = 0;
  const compare = () => {
    let px = 0;
    let drift = 0;
    for (let i = 0; i < size; i++) {
      const v = cur[i];
      const a = v - prev[i];
      if (a > PARAMS.pixelDiff || a < -PARAMS.pixelDiff) px++;
      const b = v - first[i];
      if (b > PARAMS.pixelDiff || b < -PARAMS.pixelDiff) drift++;
    }
    const still = px <= PARAMS.stillMaxPixels && drift <= PARAMS.stillMaxPixels;
    // A frame that breaks a still part is where the next one starts.
    if (!still) first.set(cur);
    frames.push({ px, still });
  };

  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { log += d; });
    child.stdout.on('data', (chunk: Buffer) => {
      for (let off = 0; off < chunk.length;) {
        const n = Math.min(size - fill, chunk.length - off);
        cur.set(chunk.subarray(off, off + n), fill);
        fill += n;
        off += n;
        if (fill < size) continue;
        if (count === 0) first.set(cur);
        else compare();
        [prev, cur] = [cur, prev];
        fill = 0;
        count++;
        if (expectedFrames > 0) onProgress(Math.min(1, count / expectedFrames));
      }
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'ENOENT' ? new Error('ffmpeg is not installed or not on PATH.') : err);
    });
    child.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg could not read ${file} (exit code ${code}): ${log.trim().split('\n').slice(-4).join(' | ')}`));
      else if (count === 0) reject(new Error(`ffmpeg read no frames from ${file}. Run the Listen phase again; if it fails again, the recording may be damaged.`));
      else resolve({ frames, log });
    });
  });
}

function silencesOf(log: string, durationSec: number): Interval[] {
  const silences: Interval[] = [];
  let silenceStart: number | null = null;
  for (const line of log.split('\n')) {
    const s = line.match(/silence_start: ([-\d.]+)/);
    if (s) { silenceStart = Math.max(0, Number(s[1])); continue; }
    const e = line.match(/silence_end: ([-\d.]+)/);
    if (e && silenceStart !== null) { silences.push({ start: silenceStart, end: Number(e[1]) }); silenceStart = null; }
  }
  if (silenceStart !== null) silences.push({ start: silenceStart, end: durationSec });
  return silences.map(s => ({ start: round(s.start), end: round(s.end) }));
}

/** `frames[i]` is frame i + 1, at (i + 1) / FPS. */
function screenOf(frames: FrameMotion[], silences: Interval[], durationSec: number): Screen {
  // A still part runs from the frame before its first still frame to its last one, counted in frames.
  const still: Interval[] = [];
  let runStart: number | null = null;
  let runEnd = 0;
  const closeRun = () => {
    if (runStart !== null && runEnd - runStart >= PARAMS.minStillSec * FPS) still.push({ start: round(runStart / FPS), end: round(runEnd / FPS) });
    runStart = null;
  };
  frames.forEach((f, i) => {
    const k = i + 1;
    if (f.still) {
      if (runStart === null) runStart = k - 1;
      runEnd = k;
    } else {
      closeRun();
    }
  });
  closeRun();

  const moving: Interval[] = [];
  let cursor = 0;
  for (const s of still) {
    if (s.start - cursor > 1e-6) moving.push({ start: round(cursor), end: s.start });
    cursor = s.end;
  }
  if (durationSec - cursor > 1 / FPS) moving.push({ start: round(cursor), end: round(durationSec) });

  const changes: { t: number; size: number }[] = [];
  frames.forEach((f, i) => {
    const t = (i + 1) / FPS;
    const size = f.px / (W * H);
    if (size < PARAMS.changeMinFraction) return;
    const last = changes.at(-1);
    if (last && t - last.t < 0.2) last.size = Math.max(last.size, round(size));
    else changes.push({ t: round(t), size: round(size) });
  });

  return {
    fps: FPS,
    durationSec,
    params: PARAMS,
    still,
    moving,
    changes,
    silences,
    motion: frames.map(f => f.px),
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
