import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Step } from '../pipeline.ts';
import { decodeAudio, RATE, writeWav } from '../lib/audio.ts';
import { brandInputs, loadBrand } from '../lib/brand.ts';
import { loudness } from '../lib/check.ts';
import { CACHE_DIR, ROOT } from '../lib/env.ts';
import { ffmpeg, probe } from '../lib/ffmpeg.ts';
import { hashJson, readJson, tempPath, writeJson } from '../lib/files.ts';
import { renderPng, withBrowser } from '../lib/remotion.ts';
import { bodyWords, buildCues, highlightFrames, shiftCues, toSrt } from '../lib/subtitles.ts';
import type { Cue } from '../lib/subtitles.ts';
import { formatDuration } from '../lib/time.ts';
import type { Edl } from '../lib/timemap.ts';
import type { Voice } from './06-voice.ts';

/** Where the body sits inside the final video. Check and Deliver read this back. */
export interface FinishInfo {
  introSec: number;
  outroSec: number;
  bodyStart: number;
  outroStart: number;
  totalSec: number;
  cues: number;
  subtitles: boolean;
}

const INTRO_FADE = 0.4;
const OUTRO_FADE = 0.5;
/** A calm, unpushed level for speech; YouTube turns louder videos down to -14 but never turns quieter ones up. */
export const LUFS_TARGET = -16;
/** -2 dBFS, so the true peak stays under -1.5 dBTP. */
const PEAK_LIMIT = 0.79;
/**
 * Cleanup before loudness: no rumble, and no compressor, which made the voice sound pushed. The mono
 * mix goes to stereo first, because two identical channels measure 3 dB louder than one.
 */
const VOICE_CHAIN = 'pan=stereo|c0=c0|c1=c0,highpass=f=70';
/** Every input is converted to BT.709 (from its own tag; untagged files are read as BT.601). */
const TO_709 = 'scale=out_color_matrix=bt709:out_range=tv';

/**
 * Stage 10. Subtitles from the voice timing (burned last), the voice and any music mixed and set
 * to -16 LUFS in two passes, then the one real encode: intro, body and outro joined with fades.
 */
export const finishStep: Step = {
  name: 'Adding subtitles and setting the loudness',
  phase: 'finish',
  weight: 6,
  inputs: ctx => [ctx.work('body-video.mp4'), ctx.work('voice.wav'), ctx.work('edl.json'), ctx.work('voice.json'),
    ctx.work('intro.mp4'), ctx.work('outro.mp4'), ctx.work('options.json'), ...brandInputs()],
  outputs: ctx => [ctx.work('final.mp4'), ctx.work('final.srt'), ctx.work('finish.json')],

  async run(ctx) {
    const edl = await readJson<Edl>(ctx.work('edl.json'));
    const voice = await readJson<Voice>(ctx.work('voice.json'));
    const options = existsSync(ctx.work('options.json')) ? await readJson<{ subtitles: boolean }>(ctx.work('options.json')) : { subtitles: false };
    const { config, card } = await loadBrand();

    const introSec = (await probe(ctx.work('intro.mp4'))).durationSec;
    const outroSec = (await probe(ctx.work('outro.mp4'))).durationSec;
    const fps = edl.fps;
    const bodyStart = introSec - INTRO_FADE;
    const outroStart = bodyStart + edl.durationSec - OUTRO_FADE;
    const totalSec = Math.round((outroStart + outroSec) * fps) / fps;

    // Subtitles, timed from the words the new voice actually speaks.
    const cues = shiftCues(buildCues(bodyWords(edl, voice)), bodyStart);
    await writeFile(ctx.work('final.srt'), toSrt(cues));
    let subsList: string | null = null;
    if (options.subtitles && cues.length) {
      ctx.say('Drawing the subtitles', `${cues.length} subtitles, each word lit as the voice says it.`);
      subsList = await subtitleTrack(cues, card, totalSec, fps, ctx.work('subs.ffconcat'), f => ctx.progress(f * 0.25));
    }

    ctx.say('Setting the loudness', `Two passes to ${LUFS_TARGET} LUFS with one even gain, peaks under -1.5 dBTP.`);
    const mix = await mixAudio(ctx.work('voice.wav'), bodyStart, totalSec, config.music ? join(ROOT, config.music) : null, config.musicVolume);
    await writeWav(ctx.work('mix.wav'), mix);
    await normalize(ctx.work('mix.wav'), ctx.work('final-audio.wav'));
    ctx.progress(0.35);

    const { width, height } = (await probe(ctx.work('body-video.mp4'))).video!;
    ctx.say('Encoding the final video', `${formatDuration(totalSec)} at ${width} × ${height}, one high-quality pass.`);
    const graph = [
      `[0:v]fps=${fps},${TO_709},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[i]`,
      `[1:v]fps=${fps},${TO_709},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[b]`,
      `[2:v]fps=${fps},${TO_709},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[o]`,
      `[i][b]xfade=transition=fade:duration=${INTRO_FADE}:offset=${bodyStart.toFixed(4)}[ib]`,
      `[ib][o]xfade=transition=fade:duration=${OUTRO_FADE}:offset=${outroStart.toFixed(4)}${subsList ? '[v]' : ',format=yuv420p[out]'}`,
      // Subtitles are applied last in the chain. Their 1920 × 1080 pictures sit at the bottom of a taller screen.
      ...(subsList ? [`[3:v]fps=${fps},format=rgba,${TO_709},format=yuva420p,setpts=PTS-STARTPTS[s]`, '[v][s]overlay=0:H-h:format=auto:eof_action=pass,format=yuv420p[out]'] : []),
    ].join(';');
    const audioInput = subsList ? 4 : 3;
    const final = ctx.work('final.mp4');
    await ffmpeg([
      '-i', ctx.work('intro.mp4'), '-i', ctx.work('body-video.mp4'), '-i', ctx.work('outro.mp4'),
      ...(subsList ? ['-f', 'concat', '-safe', '0', '-i', subsList] : []),
      '-i', ctx.work('final-audio.wav'),
      '-filter_complex', graph, '-map', '[out]', '-map', `${audioInput}:a`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-r', String(fps),
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', String(RATE),
      '-t', totalSec.toFixed(4), '-movflags', '+faststart', tempPath(final),
    ], { durationSec: totalSec, onProgress: f => ctx.progress(0.35 + f * 0.65) });
    await rename(tempPath(final), final);

    const info: FinishInfo = { introSec, outroSec, bodyStart, outroStart, totalSec, cues: cues.length, subtitles: Boolean(subsList) };
    await writeJson(ctx.work('finish.json'), info);
  },
};

/** One transparent PNG per word of each subtitle (cached), with that word lit, laid out in time as an ffconcat image sequence. */
async function subtitleTrack(cues: Cue[], brand: Awaited<ReturnType<typeof loadBrand>>['card'], totalSec: number, fps: number, listFile: string, onProgress: (f: number) => void): Promise<string> {
  const dir = join(CACHE_DIR, 'subs');
  await mkdir(dir, { recursive: true });
  const blank = join(dir, 'blank.png');
  if (!existsSync(blank)) {
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=black@0:s=1920x1080,format=rgba', '-frames:v', '1', tempPath(blank)]);
    await rename(tempPath(blank), blank);
  }
  const style = hashJson({ font: brand.fontData ? hashJson(brand.fontData) : 'plex', accent: brand.colors.accent, v: 3 });
  const states = cues.flatMap(c => highlightFrames(c, fps).map(s => ({
    ...s, lines: c.lines, file: join(dir, `${hashJson({ lines: c.lines, active: s.active, style }).slice(0, 20)}.png`),
  })));
  const missing = [...new Map(states.filter(s => !existsSync(s.file)).map(s => [s.file, s])).values()];
  if (missing.length) {
    // Four pages at once: with one PNG per word, a long video needs hundreds.
    const queue = [...missing];
    let done = 0;
    await withBrowser(browser => Promise.all(Array.from({ length: 4 }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        await renderPng(browser, 'Subtitle', { lines: s.lines, active: s.active, brand }, s.file);
        onProgress(++done / missing.length);
      }
    })));
  }

  // Durations in whole frames, so subtitles change exactly on frame boundaries.
  const lines = ['ffconcat version 1.0'];
  const entry = (file: string, frames: number) => {
    if (frames <= 0) return;
    lines.push(`file '${file.replace(/'/g, "'\\''")}'`, `duration ${(frames / fps).toFixed(6)}`);
  };
  let at = 0;
  for (const s of states) {
    entry(blank, s.from - at);
    entry(s.file, s.to - Math.max(s.from, at));
    at = Math.max(at, s.to);
  }
  entry(blank, Math.round(totalSec * fps) - at + 1);
  lines.push(`file '${blank.replace(/'/g, "'\\''")}'`); // the concat demuxer needs the last file repeated
  await writeFile(listFile, `${lines.join('\n')}\n`);
  return listFile;
}

/** The voice placed after the intro, with optional music that fades in, ducks under speech and fades out. */
async function mixAudio(voiceWav: string, bodyStart: number, totalSec: number, music: string | null, musicVolume: number): Promise<Float32Array> {
  const out = new Float32Array(Math.round(totalSec * RATE));
  const voice = await decodeAudio(voiceWav);
  const offset = Math.round(bodyStart * RATE);
  for (let i = 0; i < voice.length && offset + i < out.length; i++) out[offset + i] = voice[i];
  if (!music) return out;

  const bed = await decodeAudio(music);
  if (!bed.length) return out;
  // Duck: 10 ms windows; music drops to 35% while the voice speaks (60 ms attack, 500 ms release).
  const win = RATE / 100;
  const attack = Math.exp(-1 / (0.06 * 100));
  const release = Math.exp(-1 / (0.5 * 100));
  let gain = 1;
  const fadeIn = 1.5 * RATE;
  const fadeOut = 3 * RATE;
  for (let w = 0; w * win < out.length; w++) {
    let sum = 0;
    for (let i = w * win; i < Math.min(out.length, (w + 1) * win); i++) sum += out[i] * out[i];
    const speaking = Math.sqrt(sum / win) > 0.01;
    const target = speaking ? 0.35 : 1;
    const k = target < gain ? attack : release;
    gain = target + (gain - target) * k;
    for (let i = w * win; i < Math.min(out.length, (w + 1) * win); i++) {
      const edge = Math.min(1, i / fadeIn, (out.length - i) / fadeOut);
      out[i] += bed[i % bed.length] * musicVolume * gain * edge;
    }
  }
  return out;
}

/**
 * Two passes: measure the loudness, then raise everything by that one amount, with a limiter that
 * only catches the sharpest peaks. Not loudnorm: when the peaks are too high for a plain gain, it
 * quietly switches to riding the volume, which pumps up every pause between sentences.
 */
async function normalize(input: string, output: string): Promise<void> {
  const { integrated } = await loudness(input, VOICE_CHAIN);
  const gain = Number.isFinite(integrated) ? LUFS_TARGET - integrated : 0;
  await ffmpeg(['-i', input, '-af', `${VOICE_CHAIN},volume=${gain.toFixed(2)}dB,alimiter=limit=${PEAK_LIMIT}:attack=5:release=60:level=false`,
    '-ar', String(RATE), tempPath(output)]);
  await rename(tempPath(output), output);
}
