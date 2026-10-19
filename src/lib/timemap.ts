/**
 * The timing planner: bends the recorded video to fit the new voice. Pure function, no I/O.
 *
 * The video follows the voice line by line. Inside a line, every cue (an action word) is a fixed
 * point: the frame you saw when you said "click" plays when the new voice says "click". Between
 * fixed points each piece is fitted on its own, in this order (PLAN.md, re-timing rules):
 *   too long:  cut still frames, then speed up (at most 1.5x while the voice plays); if that is not
 *              enough the voice waits, never mid-sentence if it can help it: before the sentence for
 *              its first cue, else at the last comma before the cue, else just before the cue word.
 *   too short: hold a frame inside a still part (invisible); with no still part, hold the frame
 *              before the next action (up to 2 s), then slow down (to 0.8x at the slowest).
 * Between lines: still parts shrink to a 0.4 s rest, moving parts (page loads, typing) play at
 * 2x to 4x and take 3 s at most; a moving part over 12 s keeps its two ends and crossfades. Two lines
 * from one voice take are never closer than the pause the voice made between them.
 * Cuts happen only inside still parts, so nothing ever jumps.
 */

export interface Interval { start: number; end: number }

export interface PlanLine {
  id: number;
  /** Source window: first to last spoken word. */
  start: number;
  end: number;
  /** Length of the new voice, first to last sound. */
  speech: number;
  /** Cues: when the word was said in the recording, and when the new voice says it (from speech start). */
  anchors: { word: string; source: number; voice: number }[];
  /** Where a pause sounds natural inside the line: the start of each word after a comma (from speech start). */
  breaks: number[];
  /** The pause the voice made before this line, when it was voiced in one take with the line before. */
  pauseBefore: number | null;
}

export interface PlanInput {
  fps: number;
  durationSec: number;
  still: Interval[];
  /** Kept lines only, in order. */
  lines: PlanLine[];
}

export type VideoOp =
  | { kind: 'play'; src: number; srcEnd: number; frames: number }
  | { kind: 'hold'; at: number; frames: number }
  | { kind: 'xfade'; a: Interval; b: Interval; fadeSec: number; frames: number };

/** A stretch of one line's voice, `from`/`to` in seconds from its speech start, placed at output time `at`. */
export interface VoiceClip { lineId: number; from: number; to: number; at: number }

export interface Edl {
  fps: number;
  frames: number;
  durationSec: number;
  video: VideoOp[];
  voice: VoiceClip[];
  anchors: { lineId: number; word: string; source: number; voiceAt: number; videoAt: number; errorMs: number }[];
  /** Source time left out, and whether it was a crossfade over a long page load. */
  cuts: (Interval & { crossfade: boolean })[];
  stats: { maxSpeedWhileSpeaking: number; minSpeed: number; holdSec: number; voicePauseSec: number };
  notes: string[];
}

export const LIMITS = {
  rest: 0.4,
  leadIn: 0.3,
  tail: 1.0,
  minPause: 0.3,
  maxSpeakSpeed: 1.5,
  minSpeed: 0.8,
  maxHold: 2,
  gapSpeedMin: 2,
  gapSpeedMax: 4,
  gapMaxOut: 3,
  crossfadeAfter: 12,
  crossfadeKeep: 6,
  crossfadeSec: 0.3,
  prePad: 0.05,
  postPad: 0.12,
};

type Op =
  | { kind: 'play'; src: number; srcEnd: number; out: number; speaking: boolean }
  | { kind: 'hold'; at: number; out: number }
  | { kind: 'xfade'; a: Interval; b: Interval; fadeSec: number; out: number };

const EPS = 1e-6;

export function plan(input: PlanInput): Edl {
  const { fps, still } = input;
  const frame = 1 / fps;
  const ops: Op[] = [];
  const voice: VoiceClip[] = [];
  const notes: string[] = [];
  const cueTimes: { lineId: number; word: string; source: number; voiceAt: number }[] = [];
  let t = 0;
  let holdSec = 0;
  let voicePauseSec = 0;

  const play = (src: number, srcEnd: number, out: number, speaking: boolean) => {
    if (srcEnd - src < EPS || out < EPS) return;
    ops.push({ kind: 'play', src, srcEnd, out, speaking });
    t += out;
  };
  const hold = (at: number, out: number) => {
    if (out < EPS) return;
    ops.push({ kind: 'hold', at, out });
    t += out;
    holdSec += out;
  };

  /** Still parts inside [a, b], each trimmed by one frame at both ends so a cut never touches movement. */
  const stillsIn = (a: number, b: number): Interval[] =>
    still
      .map(s => ({ start: Math.max(s.start, a) + frame, end: Math.min(s.end, b) - frame }))
      .filter(s => s.end - s.start > frame);

  /** Splits [a, b] into still and moving parts (untrimmed). */
  const partsOf = (a: number, b: number): (Interval & { still: boolean })[] => {
    const parts: (Interval & { still: boolean })[] = [];
    let cursor = a;
    for (const s of still) {
      const s0 = Math.max(s.start, a);
      const s1 = Math.min(s.end, b);
      if (s1 - s0 < EPS) continue;
      if (s0 - cursor > EPS) parts.push({ start: cursor, end: s0, still: false });
      parts.push({ start: s0, end: s1, still: true });
      cursor = s1;
    }
    if (b - cursor > EPS) parts.push({ start: cursor, end: b, still: false });
    return parts;
  };

  /** Plays [a, b] with the given ranges left out (all inside still parts), at one speed. */
  const playWithout = (a: number, b: number, removed: Interval[], speed: number, speaking: boolean) => {
    let cursor = a;
    for (const r of [...removed].sort((x, y) => x.start - y.start)) {
      play(cursor, r.start, (r.start - cursor) / speed, speaking);
      cursor = r.end;
    }
    play(cursor, b, (b - cursor) / speed, speaking);
  };

  /**
   * Fits source [p0, p1] into `target` seconds while the voice plays. Returns how much longer the
   * video had to run (the voice waits that long before the next cue).
   */
  const fitPiece = (p0: number, p1: number, target: number): number => {
    const length = p1 - p0;
    if (length < EPS) { hold(p0, target); return 0; }
    if (Math.abs(length - target) < frame / 2) { play(p0, p1, target, true); return 0; }

    const stills = stillsIn(p0, p1);
    if (length > target) {
      const excess = length - target;
      const removable = stills.reduce((n, s) => n + s.end - s.start, 0);
      if (removable >= excess) {
        // Even out the pauses: shorten the longest still parts first, down to a common length.
        const level = waterLevel(stills.map(s => s.end - s.start), excess);
        const removed = stills.map(s => {
          const cut = Math.max(0, s.end - s.start - level);
          const mid = (s.start + s.end) / 2;
          return { start: mid - cut / 2, end: mid + cut / 2 };
        }).filter(r => r.end - r.start > EPS);
        playWithout(p0, p1, removed, 1, true);
        return 0;
      }
      const rest = length - removable;
      const speed = rest / target;
      if (speed <= LIMITS.maxSpeakSpeed) {
        playWithout(p0, p1, stills, speed, true);
        return 0;
      }
      playWithout(p0, p1, stills, LIMITS.maxSpeakSpeed, true);
      return rest / LIMITS.maxSpeakSpeed - target;
    }

    const short = target - length;
    if (stills.length) {
      // Hold inside the still part closest to the next cue: the screen is not moving, so it is invisible.
      const s = stills.at(-1)!;
      const at = (s.start + s.end) / 2;
      play(p0, at, at - p0, true);
      hold(at, short);
      play(at, p1, p1 - at, true);
      return 0;
    }
    // No still part: hold the frame just before the next action, then slow down.
    const holdOut = Math.min(short, LIMITS.maxHold);
    let speed = length / (target - holdOut);
    let extraHold = 0;
    if (speed < LIMITS.minSpeed) {
      speed = LIMITS.minSpeed;
      extraHold = target - holdOut - length / speed;
      notes.push(`At ${clock(p0)} the voice runs ${extraHold.toFixed(1)} s longer than the action; the screen holds a little longer than 2 s.`);
    }
    play(p0, p1, length / speed, true);
    hold(Math.max(p0, p1 - frame), holdOut + extraHold);
    return 0;
  };

  /**
   * Between lines: still parts shrink to one rest, moving parts speed up. `restAt` says which end of
   * the gap keeps its rest (after the voice for normal gaps, before it for the lead-in).
   */
  const gap = (g0: number, g1: number, restAt: 'start' | 'end', rest: number) => {
    if (g1 - g0 < EPS) return;
    const parts = partsOf(g0, g1);
    const restPart = restAt === 'start' ? parts.find(p => p.still) : parts.findLast(p => p.still);
    for (const p of parts) {
      const len = p.end - p.start;
      if (p.still) {
        const keep = p === restPart ? Math.min(rest, len) : 0;
        if (keep > 0) {
          if (restAt === 'start') play(p.start, p.start + keep, keep, false);
          else play(p.end - keep, p.end, keep, false);
        }
        continue;
      }
      if (len > LIMITS.crossfadeAfter) {
        const k = LIMITS.crossfadeKeep;
        const out = 2 * k / LIMITS.gapSpeedMax - LIMITS.crossfadeSec;
        ops.push({ kind: 'xfade', a: { start: p.start, end: p.start + k }, b: { start: p.end - k, end: p.end }, fadeSec: LIMITS.crossfadeSec, out });
        t += out;
        continue;
      }
      const speed = Math.min(LIMITS.gapSpeedMax, Math.max(LIMITS.gapSpeedMin, len / LIMITS.gapMaxOut));
      // At least one frame: a movement shorter than a frame after speed-up would be rounded away, and the picture would jump.
      play(p.start, p.end, Math.max(frame, len / speed), false);
    }
  };

  /** Holds the last frame shown until the voice has been quiet for `need` seconds since `voiceEnd`. */
  const breath = (from: number, voiceEnd: number, need: number) => {
    if (t - voiceEnd >= need - EPS || !ops.length) return;
    const last = ops.at(-1)!;
    const at = last.kind === 'play' ? last.srcEnd - frame : last.kind === 'hold' ? last.at : last.b.end - frame;
    hold(Math.max(from, at), need - (t - voiceEnd));
  };

  const lines = input.lines;
  let voiceEnd = 0;
  for (const [i, line] of lines.entries()) {
    if (i === 0) gap(0, line.start, 'end', LIMITS.leadIn);
    else {
      // Between two takes keep at least a short breath; inside a take, the pause the voice made.
      gap(lines[i - 1].end, line.start, 'start', line.pauseBefore ?? LIMITS.rest);
      breath(lines[i - 1].end, voiceEnd, line.pauseBefore ?? LIMITS.minPause);
    }

    // Fixed points: line start, each usable cue, line end.
    const points: { source: number; voice: number; cue?: string }[] = [{ source: line.start, voice: 0 }];
    for (const a of [...line.anchors].sort((x, y) => x.source - y.source)) {
      const prev = points.at(-1)!;
      const inside = a.source > line.start + frame && a.source < line.end - frame && a.voice > 0 && a.voice < line.speech;
      if (inside && a.source > prev.source + frame && a.voice > prev.voice + 0.01) {
        points.push({ source: a.source, voice: a.voice, cue: a.word });
      } else if (Math.abs(a.source - line.start) <= frame && a.voice < 0.15) {
        cueTimes.push({ lineId: line.id, word: a.word, source: line.start, voiceAt: t + a.voice });
      } else {
        notes.push(`Line ${line.id}: the cue "${a.word}" could not be placed in order, so the video does not wait for it.`);
      }
    }
    points.push({ source: line.end, voice: line.speech });

    const lineStart = t;
    let paused = 0;
    // Inside a take, clips meet in the middle of the voice's own pause, so the take plays straight through.
    let clipFrom = line.pauseBefore !== null ? -line.pauseBefore / 2 : -LIMITS.prePad;
    for (let k = 0; k + 1 < points.length; k++) {
      const a = points[k];
      const b = points[k + 1];
      const extra = fitPiece(a.source, b.source, b.voice - a.voice);
      if (extra > EPS && k + 2 < points.length) {
        // The voice waits for the screen: before the sentence when this is its first cue, so the
        // screen starts and then you speak; else at the last comma before the cue; else just before it.
        if (k > 0) {
          const at = line.breaks.filter(x => x > a.voice && x < b.voice).at(-1) ?? b.voice;
          voice.push({ lineId: line.id, from: clipFrom, to: at, at: lineStart + clipFrom + paused });
          clipFrom = at;
        }
        paused += extra;
        voicePauseSec += extra;
      } else if (extra > EPS) {
        voicePauseSec += extra;
      }
      if (b.cue) cueTimes.push({ lineId: line.id, word: b.cue, source: b.source, voiceAt: lineStart + b.voice + paused });
    }
    const next = lines[i + 1];
    const tail = next && next.pauseBefore !== null ? next.pauseBefore / 2 : LIMITS.postPad;
    voice.push({ lineId: line.id, from: clipFrom, to: line.speech + tail, at: lineStart + clipFrom + paused });
    voiceEnd = lineStart + line.speech + paused;
  }
  // After the last line the rest goes at the end, so the video finishes on the result of the last click.
  if (lines.length) gap(lines.at(-1)!.end, input.durationSec, 'end', LIMITS.tail);

  return quantize(ops, voice, cueTimes, fps, { holdSec, voicePauseSec }, notes);
}

/** Converts exact output durations to whole frames, carrying the rounding so it never adds up. */
function quantize(
  ops: Op[],
  voice: VoiceClip[],
  cueTimes: { lineId: number; word: string; source: number; voiceAt: number }[],
  fps: number,
  totals: { holdSec: number; voicePauseSec: number },
  notes: string[],
): Edl {
  const video: VideoOp[] = [];
  const placed: { op: VideoOp; startFrame: number }[] = [];
  let exact = 0;
  let frames = 0;
  let maxSpeak = 1;
  let minSpeed = Infinity;
  for (const op of ops) {
    exact += op.out;
    const n = Math.round(exact * fps) - frames;
    if (n <= 0) continue;
    let v: VideoOp;
    if (op.kind === 'play') {
      v = { kind: 'play', src: op.src, srcEnd: op.srcEnd, frames: n };
      const speed = (op.srcEnd - op.src) * fps / n;
      if (op.speaking) maxSpeak = Math.max(maxSpeak, speed);
      minSpeed = Math.min(minSpeed, speed);
    } else if (op.kind === 'hold') {
      v = { kind: 'hold', at: op.at, frames: n };
    } else {
      v = { kind: 'xfade', a: op.a, b: op.b, fadeSec: op.fadeSec, frames: n };
    }
    placed.push({ op: v, startFrame: frames });
    video.push(v);
    frames += n;
  }

  // Where each cue's source frame actually lands after rounding.
  const anchors = cueTimes.map(c => {
    const hit = placed.find(p => p.op.kind === 'play' && c.source >= p.op.src - 1e-6 && c.source < p.op.srcEnd - 1e-6);
    let videoAt = c.voiceAt;
    if (hit && hit.op.kind === 'play') {
      const within = (c.source - hit.op.src) / (hit.op.srcEnd - hit.op.src);
      videoAt = (hit.startFrame + Math.floor(within * hit.op.frames + 1e-6)) / fps;
    }
    return { ...c, videoAt, errorMs: Math.round(Math.abs(videoAt - c.voiceAt) * 1000) };
  });

  return {
    fps,
    frames,
    durationSec: frames / fps,
    video,
    voice,
    anchors,
    cuts: cutsOf(video),
    stats: { maxSpeedWhileSpeaking: round(maxSpeak), minSpeed: round(minSpeed === Infinity ? 1 : minSpeed), holdSec: round(totals.holdSec), voicePauseSec: round(totals.voicePauseSec) },
    notes,
  };
}

/** Source time the video skips over, read back from the ops themselves. */
export function cutsOf(video: VideoOp[]): (Interval & { crossfade: boolean })[] {
  const cuts: (Interval & { crossfade: boolean })[] = [];
  let cursor: number | null = null;
  for (const op of video) {
    const start = op.kind === 'play' ? op.src : op.kind === 'hold' ? op.at : op.a.start;
    if (cursor !== null && start - cursor > 1e-3) cuts.push({ start: cursor, end: start, crossfade: false });
    if (op.kind === 'xfade') cuts.push({ start: op.a.end, end: op.b.start, crossfade: true });
    cursor = op.kind === 'play' ? op.srcEnd : op.kind === 'hold' ? Math.max(cursor ?? 0, op.at) : op.b.end;
  }
  return cuts.map(c => ({ ...c, start: round(c.start), end: round(c.end) }));
}

/** A place where the picture jumps: where it plays in the body, and the recording left out there. */
export interface VideoCut extends Interval { at: number; crossfade: boolean }

/**
 * Every place the video skips a frame or more of the recording (as cutsOf finds them, unrounded), at
 * the frame after the skip, and every crossfade, at the middle of its fade. A skip under one frame is
 * left out: no frame is lost, so nothing can be seen to jump.
 */
export function videoCutsOf(edl: Pick<Edl, 'fps' | 'video'>): VideoCut[] {
  const cuts: VideoCut[] = [];
  let cursor: number | null = null;
  let frames = 0;
  for (const op of edl.video) {
    const start = op.kind === 'play' ? op.src : op.kind === 'hold' ? op.at : op.a.start;
    if (cursor !== null && start - cursor >= 1 / edl.fps - EPS) cuts.push({ at: frames / edl.fps, start: cursor, end: start, crossfade: false });
    if (op.kind === 'xfade') {
      // As 08-render.ts plays it: both legs at one speed, the fade at the end of the first.
      const aLen = op.a.end - op.a.start;
      const speed = (aLen + op.b.end - op.b.start) / (op.frames / edl.fps + op.fadeSec);
      cuts.push({ at: frames / edl.fps + aLen / speed - op.fadeSec / 2, start: op.a.end, end: op.b.start, crossfade: true });
    }
    cursor = op.kind === 'play' ? op.srcEnd : op.kind === 'hold' ? Math.max(cursor ?? 0, op.at) : op.b.end;
    frames += op.frames;
  }
  return cuts;
}

/** The level h where cutting every length above h down to h removes exactly `amount`. */
function waterLevel(lengths: number[], amount: number): number {
  const sorted = [...lengths].sort((a, b) => b - a);
  let removed = 0;
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[i + 1] ?? 0;
    const step = (sorted[i] - next) * (i + 1);
    if (removed + step >= amount) return sorted[i] - (amount - removed) / (i + 1);
    removed += step;
  }
  return 0;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const clock = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
