import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Step } from '../pipeline.ts';
import { decodeAudio, levelDb, quietest, RATE, writeWav } from '../lib/audio.ts';
import { ffmpeg, probe, seekTo } from '../lib/ffmpeg.ts';
import { hashJson, readJson, tempPath, writeJson } from '../lib/files.ts';
import { inParallel } from '../lib/run.ts';
import { formatDuration } from '../lib/time.ts';
import type { Edl, VideoOp } from '../lib/timemap.ts';
import { COMMA_SEARCH, JOIN_SEARCH } from './06-voice.ts';
import type { Voice, VoiceLine } from './06-voice.ts';

/** Pieces are near-lossless; the one real encode happens once, in Finish. */
const PIECE_ENCODE = ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-pix_fmt', 'yuv420p'];
const PARALLEL = 4;
const EDGE_FADE = 0.03;

/** A cut inside a take, written to voice-cuts.json so Check can tell whether it landed in a real pause. */
export interface VoiceCut {
  lineId: number;
  /** The take, relative to work/. */
  take: string;
  /** Where the cut is in the take, in seconds. */
  at: number;
  /** Where the cut plays in the body, in seconds. */
  bodyAt: number;
  /** How far the quietest 10 ms at the cut is under the take's level over its words, in dB. */
  underDb: number;
}

/** Stage 8. Renders every piece of the plan, joins them, and lays the voice under the picture. */
export const renderStep: Step = {
  name: 'Cutting the video to fit the voice',
  phase: 'cut',
  weight: 6,
  inputs: ctx => [ctx.work('edl.json'), ctx.work('voice.json'), ctx.work('master.mp4')],
  outputs: ctx => [ctx.work('body.mp4'), ctx.work('voice-cuts.json')],

  async run(ctx) {
    const edl = await readJson<Edl>(ctx.work('edl.json'));
    const voice = await readJson<Voice>(ctx.work('voice.json'));
    const master = ctx.work('master.mp4');
    const m = statSync(master);
    const piecesDir = ctx.work('pieces');
    await mkdir(piecesDir, { recursive: true });

    // Each piece is named by what it contains, so a re-run only renders pieces that changed.
    const pieces = edl.video.map(op => ({
      op,
      file: join(piecesDir, `${hashJson({ op, fps: edl.fps, master: [m.size, m.mtimeMs], PIECE_ENCODE, seek: 'on-screen' }).slice(0, 20)}.mp4`),
    }));
    const todo = pieces.filter(p => !existsSync(p.file));
    let done = 0;
    ctx.detail(`Cutting ${todo.length} pieces${todo.length < pieces.length ? ` (${pieces.length - todo.length} kept from before)` : ''}.`);
    await inParallel(todo, PARALLEL, async p => {
      await renderPiece(master, p.op, edl.fps, p.file);
      done++;
      ctx.progress(done / Math.max(1, todo.length) * 0.85);
      ctx.detail(`Cut piece ${done} of ${todo.length}. Every cue stays within 150 ms of its word.`);
    });

    ctx.say('Joining the pieces and laying in the voice');
    const list = join(piecesDir, `list-${hashJson(pieces.map(p => p.file)).slice(0, 12)}.txt`);
    await writeFile(list, pieces.map(p => `file '${basename(p.file)}'`).join('\n'));
    const video = ctx.work('body-video.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', tempPath(video)]);
    await rename(tempPath(video), video);

    const track = await voiceTrack(edl, voice, name => ctx.work(name));
    await writeWav(ctx.work('voice.wav'), track.pcm);
    await writeJson(ctx.work('voice-cuts.json'), track.cuts);
    ctx.progress(0.95);

    const body = ctx.work('body.mp4');
    await ffmpeg(['-i', video, '-i', ctx.work('voice.wav'), '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', String(RATE), '-movflags', '+faststart', tempPath(body)]);
    const made = await probe(tempPath(body));
    if (Math.abs(made.durationSec - edl.durationSec) > 2 / edl.fps) {
      throw new Error(`The cut came out ${made.durationSec.toFixed(3)} s long, but the plan says ${edl.durationSec.toFixed(3)} s.`);
    }
    await rename(tempPath(body), body);
    ctx.detail(`The cut is ready: ${formatDuration(edl.durationSec)} long.`);
  },
};

async function renderPiece(master: string, op: VideoOp, fps: number, out: string): Promise<void> {
  const tmp = tempPath(out);
  const frames = String(op.frames);
  if (op.kind === 'play') {
    const len = op.srcEnd - op.src;
    const speed = len * fps / op.frames;
    await ffmpeg(['-ss', seekTo(op.src, fps).toFixed(4), '-t', (len + 0.25).toFixed(4), '-i', master,
      '-vf', `setpts=(PTS-STARTPTS)/${speed.toFixed(6)},fps=${fps},tpad=stop_mode=clone:stop_duration=1`,
      '-frames:v', frames, ...PIECE_ENCODE, '-r', String(fps), tmp]);
  } else if (op.kind === 'hold') {
    await ffmpeg(['-ss', seekTo(op.at, fps).toFixed(4), '-i', master,
      '-vf', `trim=end_frame=1,setpts=PTS-STARTPTS,fps=${fps},tpad=stop_mode=clone:stop=${op.frames}`,
      '-frames:v', frames, ...PIECE_ENCODE, '-r', String(fps), tmp]);
  } else {
    const aLen = op.a.end - op.a.start;
    const bLen = op.b.end - op.b.start;
    const speed = (aLen + bLen) / (op.frames / fps + op.fadeSec);
    const offset = aLen / speed - op.fadeSec;
    const leg = (i: number) => `[${i}:v]setpts=(PTS-STARTPTS)/${speed.toFixed(6)},fps=${fps},format=yuv420p[v${i}]`;
    await ffmpeg(['-ss', seekTo(op.a.start, fps).toFixed(4), '-t', (aLen + 0.25).toFixed(4), '-i', master,
      '-ss', seekTo(op.b.start, fps).toFixed(4), '-t', (bLen + 0.25).toFixed(4), '-i', master,
      '-filter_complex', `${leg(0)};${leg(1)};[v0][v1]xfade=transition=fade:duration=${op.fadeSec}:offset=${offset.toFixed(4)},tpad=stop_mode=clone:stop_duration=1[v]`,
      '-map', '[v]', '-frames:v', frames, ...PIECE_ENCODE, '-r', String(fps), tmp]);
  }
  await rename(tmp, out);
}

/** Fade at a cut inside a take. The cut sits on the take's quietest moment, so the fade touches no word. */
const SPLIT_FADE = 0.01;
/** Fade at the start of a take: short, because ElevenLabs often starts the first word right away. */
const TAKE_FADE_IN = 0.005;

/**
 * Mixes the voice into one track at its planned times. Where the plan keeps the pause a take made
 * between two lines, the take plays straight through, untouched. Where the plan needs a longer pause,
 * or the voice waits for the screen inside a line, the take is cut at its quietest moment between the
 * two words, found in the audio itself, since word timings can be tens of milliseconds off. The rest of
 * such a pause is silence: a clean clone's own pauses are just as quiet. Every cut is returned too.
 */
async function voiceTrack(edl: Edl, voice: Voice, work: (name: string) => string): Promise<{ pcm: Float32Array; cuts: VoiceCut[] }> {
  const out = new Float32Array(Math.round(edl.durationSec * RATE));
  const lineOf = new Map(voice.lines.map(l => [l.id, l]));
  const takes = new Map<string, Float32Array>();
  for (const line of voice.lines) if (!takes.has(line.file)) takes.set(line.file, await decodeAudio(work(line.file)));
  // Each take's level over its words, the same measure the voice step used to find its pauses.
  const wordsDb = new Map([...takes].map(([file, pcm]) => {
    const own = voice.lines.filter(l => l.file === file);
    return [file, levelDb(pcm, own[0].speechStart, own.at(-1)!.speechEnd)];
  }));
  const cuts: VoiceCut[] = [];

  const placed = edl.voice.map(clip => {
    const line = lineOf.get(clip.lineId)!;
    return { line, pcm: takes.get(line.file)!, from: line.speechStart + clip.from, to: line.speechStart + clip.to, at: clip.at, fadeIn: TAKE_FADE_IN, fadeOut: EDGE_FADE };
  });
  type Placed = (typeof placed)[number];
  const continues = (a: Placed, b: Placed) =>
    a.line.file === b.line.file && Math.abs(a.to - b.from) < 1e-4 && Math.abs(a.at + a.to - a.from - b.at) < 1e-4;
  const joinedAfter = placed.map((p, i) => i + 1 < placed.length && continues(p, placed[i + 1]));

  for (const [i, p] of placed.entries()) {
    if (i > 0 && joinedAfter[i - 1]) p.fadeIn = 0;
    else {
      const range = cutRange(voice, p.line, p.from, 'start');
      if (range) {
        const q = quietest(p.pcm, range[0], range[1]);
        p.at += q.at - p.from;
        p.from = q.at;
        p.fadeIn = SPLIT_FADE;
        cuts.push({ lineId: p.line.id, take: p.line.file, at: q.at, bodyAt: p.at, underDb: wordsDb.get(p.line.file)! - q.db });
      }
    }
    if (joinedAfter[i]) p.fadeOut = 0;
    else {
      const range = cutRange(voice, p.line, p.to, 'end');
      if (range) {
        const q = quietest(p.pcm, range[0], range[1]);
        p.to = q.at;
        p.fadeOut = SPLIT_FADE;
        cuts.push({ lineId: p.line.id, take: p.line.file, at: q.at, bodyAt: p.at + p.to - p.from, underDb: wordsDb.get(p.line.file)! - q.db });
      }
    }
  }

  for (const p of placed) {
    const s0 = Math.max(0, Math.round(p.from * RATE));
    const s1 = Math.min(p.pcm.length, Math.round(p.to * RATE));
    const base = Math.round(p.at * RATE) + (s0 - Math.round(p.from * RATE));
    const n = s1 - s0;
    const inLen = Math.round(p.fadeIn * RATE);
    const outLen = Math.round(p.fadeOut * RATE);
    for (let i = 0; i < n; i++) {
      const j = base + i;
      if (j < 0 || j >= out.length) continue;
      out[j] += p.pcm[s0 + i] * Math.min(1, inLen ? i / inLen : 1, outLen ? (n - 1 - i) / outLen : 1);
    }
  }
  return { pcm: out, cuts };
}

/**
 * Where to look for a cut at file time `t`, when it falls inside a take: between the two words around
 * it, the same search the voice step used to find the pause. Null at the very start or end of a take.
 */
function cutRange(voice: Voice, line: VoiceLine, t: number, edge: 'start' | 'end'): [number, number] | null {
  const inside = edge === 'start' ? t > line.speechStart + 1e-6 : t < line.speechEnd - 1e-6;
  if (inside) {
    const k = line.words.findIndex(w => Math.abs(w.start - t) < 0.02);
    return k > 0 ? [line.words[k - 1].end - COMMA_SEARCH[0], line.words[k].start + COMMA_SEARCH[1]] : [t - COMMA_SEARCH[0], t + COMMA_SEARCH[1]];
  }
  const i = voice.lines.indexOf(line);
  const other = voice.lines[edge === 'start' ? i - 1 : i + 1];
  if (other?.file !== line.file) return null;
  const [a, b] = edge === 'start' ? [other, line] : [line, other];
  return [a.speechEnd - JOIN_SEARCH[0], b.speechStart + JOIN_SEARCH[1]];
}
