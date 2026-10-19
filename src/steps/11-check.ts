import { rename } from 'node:fs/promises';
import type { Step } from '../pipeline.ts';
import { decodeAudio, levelDb, RATE } from '../lib/audio.ts';
import { changedPixels, loudness, ssim } from '../lib/check.ts';
import { ffmpeg, probe } from '../lib/ffmpeg.ts';
import { readJson, tempPath, writeJson } from '../lib/files.ts';
import { inParallel } from '../lib/run.ts';
import { cutsOf, videoCutsOf } from '../lib/timemap.ts';
import type { Edl, Interval, VoiceClip } from '../lib/timemap.ts';
import type { Screen } from './03-analyze.ts';
import type { Voice, VoiceLine } from './06-voice.ts';
import type { VoiceCut } from './08-render.ts';
import { LUFS_TARGET } from './10-finish.ts';
import type { FinishInfo } from './10-finish.ts';

/** Where the voice stops inside a line, the words on each side, and whether it really paused there. */
export interface VoiceStop {
  lineId: number;
  before: string;
  after: string;
  waitSec: number;
  atComma: boolean;
  /** Where the voice stops, in the body, in seconds. */
  bodyAt: number;
}

export interface CheckResult {
  passes: number;
  durationSec: number;
  expectedSec: number;
  lufs: number;
  truePeak: number;
  anchors: { lineId: number; word: string; errorMs: number; ssim: number }[];
  worstSsim: number;
  cutsOnStillOnly: boolean;
  /** Video cuts other than crossfades, how many cut out a part that stayed still, and the most pixels that changed in one. */
  videoCuts: { count: number; noJump: number; mostChangedPx: number | null };
  /** Voice cuts inside a take, how many sit in a real pause, and the least quiet one (dB under the words). */
  voiceCuts: { count: number; inPause: number; minUnderDb: number | null };
  /** The median gain mastering gave words and pauses, in dB; null when there was nothing to measure. */
  gain: { words: number | null; pauses: number | null };
  stops: VoiceStop[];
  problems: string[];
  /** Where each problem is in the final video, in seconds, by index in `problems`; null when it has no one place. */
  problemAt: (number | null)[];
}

const MAX_PASSES = 3;
/** Video cuts compared at once. */
const PARALLEL = 4;
/** A voice cut this far under the words is in a real pause; closer, it may clip a word. */
export const CUT_QUIET_DB = 25;
/**
 * A part cut out of the recording may change this many pixels at 960 × 540 from its first frame to its last.
 * Below it the pointer changed shape or moved a few pixels (44 to 77 in real recordings); a link preview
 * that vanished or a hover colour that faded measured 844 and more, and shows as a jump.
 */
export const JUMP_PIXELS = 100;
/** A time this many frames or less under a frame edge is on the edge: it was rounded down to the ms. */
const FRAME_SLACK = 0.05;
/** Words and pauses may get this different a gain before it counts as riding the volume. */
export const RIDE_DB = 2;
/** 50 ms windows above this level in the mix are words, below it pauses. */
const WORD_DB = -35;
/** Windows under this carry no sound to measure a gain on: digital silence, the intro and the outro. */
const SILENT_DB = -80;

/**
 * Stage 11. Measures the finished file: length, loudness, every cue on the actual frames, the cut
 * rule, no jump at a video cut, and the voice: cuts in real pauses, one even gain, no stop inside a
 * sentence. Loudness that misses is fixed and re-measured, at most 3 passes. Whatever is left goes in the report.
 */
export const checkStep: Step = {
  name: 'Checking every cue, cut and the loudness',
  phase: 'finish',
  weight: 2,
  inputs: ctx => [ctx.work('final.mp4'), ctx.work('finish.json')],
  outputs: ctx => [ctx.work('check.json')],

  async run(ctx) {
    const edl = await readJson<Edl>(ctx.work('edl.json'));
    const screen = await readJson<Screen>(ctx.work('screen.json'));
    const finish = await readJson<FinishInfo>(ctx.work('finish.json'));
    const voice = await readJson<Voice>(ctx.work('voice.json'));
    const final = ctx.work('final.mp4');
    const problems: string[] = [];
    const problemAt: (number | null)[] = [];
    const problem = (text: string, at: number | null = null) => {
      problems.push(text);
      problemAt.push(at);
    };

    let passes = 0;
    let level = { integrated: NaN, truePeak: NaN };
    while (passes < MAX_PASSES) {
      passes++;
      level = await loudness(final);
      const ok = Math.abs(level.integrated - LUFS_TARGET) <= 1 && level.truePeak <= -1;
      if (ok || passes === MAX_PASSES) break;
      ctx.say('Fixing the loudness', `Pass ${passes} measured ${level.integrated} LUFS and a ${level.truePeak} dBTP peak.`);
      const gain = LUFS_TARGET - level.integrated;
      const audio = ctx.work('final-audio.wav');
      await ffmpeg(['-i', audio, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.84:level=false`, '-ar', String(RATE), tempPath(audio)]);
      await rename(tempPath(audio), audio);
      await ffmpeg(['-i', final, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-movflags', '+faststart', tempPath(final)]);
      await rename(tempPath(final), final);
    }
    if (Math.abs(level.integrated - LUFS_TARGET) > 1) problem(`Loudness is ${level.integrated} LUFS after ${passes} passes; the target is ${LUFS_TARGET} ±1.`);
    if (level.truePeak > -1) problem(`The true peak is ${level.truePeak} dBTP; it should be -1 or lower.`);

    const durationSec = (await probe(final)).durationSec;
    if (Math.abs(durationSec - finish.totalSec) > 2 / edl.fps) problem(`The video is ${durationSec.toFixed(2)} s long; the plan says ${finish.totalSec.toFixed(2)} s.`);

    // Every cue on the real frames: what the final shows when the voice says the word must match the
    // recording at the moment you said it. The bottom fifth is left out, where subtitles sit.
    ctx.detail(`Comparing the frame at each of ${edl.anchors.length} cues with your recording.`);
    const anchors: CheckResult['anchors'] = [];
    for (const a of edl.anchors) {
      const at = finish.bodyStart + (Math.round(a.voiceAt * edl.fps) + 0.5) / edl.fps;
      const score = await ssim(final, at, ctx.work('master.mp4'), (Math.floor(a.source * edl.fps) + 0.5) / edl.fps, edl.fps, 0.8);
      anchors.push({ lineId: a.lineId, word: a.word, errorMs: a.errorMs, ssim: score });
      if (a.errorMs > 150) problem(`Line ${a.lineId}: "${a.word}" is ${a.errorMs} ms off its action.`, at);
      else if (score < 0.97) problem(`Line ${a.lineId}: the frame at "${a.word}" does not match the recording (SSIM ${score.toFixed(3)}).`, at);
    }

    const offStill = cutsOf(edl.video).filter(c => !c.crossfade && !screen.still.some(s => c.start >= s.start - 1 / edl.fps && c.end <= s.end + 1 / edl.fps));
    for (const c of offStill) {
      const at = playsAt(edl, c.end);
      problem(`A cut at ${c.start.toFixed(2)}–${c.end.toFixed(2)} s of the recording is not on a still screen.`, at === null ? null : finish.bodyStart + at);
    }

    // The same rule on the real frames. The analysis compares each frame with the one before, so a slow change
    // (a fade, a pointer creeping) can pass as still; then the cut drops it and the picture jumps. So the first
    // and last frames cut out must match too. Not the frames on each side of the cut in the final video: there a
    // page that changes right after the cut differs as well, and nothing is wrong with it. Crossfades are meant to change.
    const jumpCuts = videoCutsOf(edl).filter(c => !c.crossfade);
    ctx.detail(`Comparing the first and last frame cut out at each of ${jumpCuts.length} video cuts.`);
    const changed: number[] = [];
    await inParallel([...jumpCuts.keys()], PARALLEL, async i => {
      const [first, last] = framesCutOut(jumpCuts[i], edl.fps);
      changed[i] = await changedPixels(ctx.work('master.mp4'), (first + 0.5) / edl.fps, (last + 0.5) / edl.fps, edl.fps, screen.params.pixelDiff);
    });
    for (const [i, c] of jumpCuts.entries()) {
      if (changed[i] <= JUMP_PIXELS) continue;
      const at = finish.bodyStart + c.at;
      problem(`The picture jumps ${at.toFixed(1)} s into the video: in the ${(c.end - c.start).toFixed(2)} s cut out of the recording at ${c.start.toFixed(2)} s, ${changed[i]} pixels changed (${JUMP_PIXELS} allowed), a slow change the screen analysis took for a still screen. Watch the video there; if the jump shows, record that part again.`, at);
    }

    // The sound problems once found by ear: a voice cut on a word, the volume riding up in pauses,
    // and the voice stopping in the middle of a sentence.
    ctx.detail('Listening to every voice cut, the gain on pauses and words, and stops inside sentences.');
    const voiceCuts = await readJson<VoiceCut[]>(ctx.work('voice-cuts.json'));
    for (const c of voiceCuts.filter(c => c.underDb < CUT_QUIET_DB)) {
      problem(`Line ${c.lineId}: the voice is cut ${(finish.bodyStart + c.bodyAt).toFixed(1)} s into the video, only ${c.underDb.toFixed(0)} dB under the words, so it may clip a word. Listen there; if it does, add a comma at that point in the script so the voice pauses, and render again.`, finish.bodyStart + c.bodyAt);
    }
    const gain = gainOnWordsAndPauses(await decodeAudio(ctx.work('mix.wav')), await decodeAudio(ctx.work('final-audio.wav')));
    const ride = gain.words !== null && gain.pauses !== null ? gain.pauses - gain.words : 0;
    if (Math.abs(ride) > RIDE_DB) {
      problem(`Mastering gave the pauses ${Math.abs(ride).toFixed(1)} dB ${ride > 0 ? 'more' : 'less'} gain than the words (${RIDE_DB} dB allowed), so the volume rides between sentences. Set the level in Finish with one even gain and a peak limiter, not loudnorm or a compressor.`);
    }
    const stops = voiceStops(edl.voice, voice.lines);
    for (const s of stops.filter(s => !s.atComma)) {
      problem(`Line ${s.lineId}: the voice stops for ${s.waitSec.toFixed(1)} s between "${s.before}" and "${s.after}", where it does not pause, so the sentence sounds cut off. Add a comma before "${s.after}" in the script, and render again.`, finish.bodyStart + s.bodyAt + s.waitSec / 2);
    }

    const result: CheckResult = {
      passes,
      durationSec,
      expectedSec: finish.totalSec,
      lufs: level.integrated,
      truePeak: level.truePeak,
      anchors,
      worstSsim: anchors.length ? Math.min(...anchors.map(a => a.ssim)) : 1,
      cutsOnStillOnly: offStill.length === 0,
      videoCuts: { count: changed.length, noJump: changed.filter(px => px <= JUMP_PIXELS).length, mostChangedPx: changed.length ? Math.max(...changed) : null },
      voiceCuts: {
        count: voiceCuts.length,
        inPause: voiceCuts.filter(c => c.underDb >= CUT_QUIET_DB).length,
        minUnderDb: voiceCuts.length ? Math.min(...voiceCuts.map(c => c.underDb)) : null,
      },
      gain,
      stops,
      problems,
      problemAt,
    };
    await writeJson(ctx.work('check.json'), result);
    ctx.detail(problems.length ? `${problems.length} problem${problems.length > 1 ? 's' : ''} found; the report lists them.` : 'Every check passed.');
  },
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The gain mastering gave the words and the pauses: the median over 50 ms windows of the level in
 * `final` minus the level in `mix`. One even gain gives both the same; riding the volume lifts the pauses.
 */
export function gainOnWordsAndPauses(mix: Float32Array, final: Float32Array): CheckResult['gain'] {
  const w = 0.05;
  const words: number[] = [];
  const pauses: number[] = [];
  const windows = Math.floor(Math.min(mix.length, final.length) / (w * RATE));
  for (let i = 0; i < windows; i++) {
    const before = levelDb(mix, i * w, (i + 1) * w);
    if (before < SILENT_DB) continue;
    (before > WORD_DB ? words : pauses).push(levelDb(final, i * w, (i + 1) * w) - before);
  }
  return { words: median(words), pauses: median(pauses) };
}

/**
 * Every place the voice stops inside a line: two clips of one line in a row that do not play straight
 * through. A stop at a comma where the voice really paused sounds natural; anywhere else it sounds cut off.
 */
export function voiceStops(clips: VoiceClip[], lines: VoiceLine[]): VoiceStop[] {
  const lineOf = new Map(lines.map(l => [l.id, l]));
  const stops: VoiceStop[] = [];
  for (const [i, b] of clips.entries()) {
    const a = clips[i - 1];
    if (a?.lineId !== b.lineId) continue;
    const waitSec = b.at - (a.at + a.to - a.from);
    if (Math.abs(b.from - a.to) < 1e-4 && Math.abs(waitSec) < 1e-4) continue;
    const line = lineOf.get(b.lineId)!;
    // The word the clip starts on; word timings can be a little off the clip edge.
    const k = line.words.findIndex(w => w.start > line.speechStart + b.from - 0.02);
    const next = k < 0 ? line.words.length : k;
    stops.push({
      lineId: b.lineId,
      before: line.words[next - 1]?.text ?? '',
      after: line.words[next]?.text ?? '',
      waitSec,
      atComma: line.breaks.some(x => Math.abs(x - b.from) < 1e-3),
      bodyAt: a.at + a.to - a.from,
    });
  }
  return stops;
}

/**
 * The first and last frame a cut leaves out of the recording. A time in the edl can sit just under a frame edge,
 * rounded to 1 ms (0.03 frames at 30 fps): frame 460 starts at 15.3333 s and is stored as 15.333. Such a time is on the edge.
 */
export function framesCutOut(cut: Interval, fps: number): [number, number] {
  return [Math.floor(cut.start * fps + FRAME_SLACK), Math.floor(cut.end * fps + FRAME_SLACK) - 1];
}

/** Where the first piece that starts at recording time `src` plays in the body, in seconds; null if none does. */
function playsAt(edl: Edl, src: number): number | null {
  let frames = 0;
  for (const op of edl.video) {
    const start = op.kind === 'play' ? op.src : op.kind === 'hold' ? op.at : op.a.start;
    if (Math.abs(start - src) < 2e-3) return frames / edl.fps;
    frames += op.frames;
  }
  return null;
}
