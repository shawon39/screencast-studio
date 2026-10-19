import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { getJob, jobDir } from './jobs.ts';
import { loudness } from './lib/check.ts';
import { CACHE_DIR, requireEnv } from './lib/env.ts';
import { UserError } from './lib/errors.ts';
import { ffmpeg } from './lib/ffmpeg.ts';
import { hashJson, readJson, tempPath, writeJson } from './lib/files.ts';
import type { Script } from './lib/script.ts';
import { cachedSpeech, recordSpeech, ttsAudio, ttsKey, VOICE_CONFIG } from './steps/06-voice.ts';
import type { VoiceConfig } from './steps/06-voice.ts';

/**
 * The Voice test page: one paragraph of a real recording, in your own voice and in your clone on each
 * model, so you can hear which sounds most like you. Clone takes share the voice step's TTS cache.
 */

/** Lines 24 to 27 of the first real recording: there, what was said is closest to the clean text. */
const SOURCE = { job: '2026-10-17-screen-recording-2026-10-17-at-3-13-26-pm', from: 24, to: 27 };

interface CloneTake {
  id: string;
  label: string;
  detail: string;
  model_id: string;
  stability: number;
  similarity_boost: number;
}

const CLONE_TAKES: CloneTake[] = [
  { id: 'v2', label: 'Your clone on Multilingual v2', detail: 'The current settings: stability 0.5, similarity 0.75.',
    model_id: 'eleven_multilingual_v2', stability: 0.5, similarity_boost: 0.75 },
  { id: 'v4', label: 'Your clone on Eleven v4', detail: 'Same settings. v4 has no speed or style setting, so the video does all the timing.',
    model_id: 'eleven_v4', stability: 0.5, similarity_boost: 0.75 },
  { id: 'v2-close', label: 'Your clone on Multilingual v2, closer to the sample', detail: 'Stability 0.4, similarity 0.9: more like your sample, a little less steady.',
    model_id: 'eleven_multilingual_v2', stability: 0.4, similarity_boost: 0.9 },
  { id: 'v2-calm', label: 'Your clone on Multilingual v2, calm', detail: 'Stability 0.65, similarity 0.75: a soft, steady explaining voice.',
    model_id: 'eleven_multilingual_v2', stability: 0.65, similarity_boost: 0.75 },
];

export interface TakeState {
  id: string;
  label: string;
  detail: string;
  ready: boolean;
  /** True when config/voice.json uses this take's model and settings. */
  chosen: boolean;
  /** Integrated loudness, so the page can play every take equally loud. */
  lufs: number | null;
}

export interface VoiceTest {
  text: string;
  source: string;
  takes: TakeState[];
}

async function paragraph(): Promise<{ text: string; start: number; end: number; input: string; title: string }> {
  const job = getJob(SOURCE.job);
  if (!job) throw new UserError('The recording this test is cut from is gone.', `Put the job folder jobs/${SOURCE.job} back, or change SOURCE in src/voicetest.ts.`);
  const script = await readJson<Script>(join(jobDir(SOURCE.job), 'work', 'script.json'));
  const at = script.lines.findIndex(l => l.id === SOURCE.from);
  const to = script.lines.findIndex(l => l.id === SOURCE.to);
  const lines = script.lines.slice(at, to + 1);
  const before = script.lines[at - 1];
  const after = script.lines[to + 1];
  return {
    text: lines.map(l => l.clean.trim()).join(' '),
    // A little room around the speech, without reaching into the lines either side.
    start: Math.max(before ? before.end + 0.02 : 0, lines[0].start - 0.3),
    end: Math.min(after ? after.start - 0.02 : Infinity, lines.at(-1)!.end + 0.3),
    input: join(jobDir(SOURCE.job), job.inputFile),
    title: script.title,
  };
}

const takeConfig = (base: VoiceConfig, t: CloneTake): VoiceConfig => ({
  ...base,
  model_id: t.model_id,
  voice_settings: { ...base.voice_settings, stability: t.stability, similarity_boost: t.similarity_boost },
});

/** Your own voice, cut from the raw recording with a 30 ms fade at each edge. Made once. */
async function realClip(): Promise<string> {
  const p = await paragraph();
  const file = join(CACHE_DIR, 'voice-test', `real-${hashJson({ ...SOURCE, start: p.start, end: p.end }).slice(0, 16)}.mp3`);
  if (existsSync(file)) return file;
  await mkdir(join(CACHE_DIR, 'voice-test'), { recursive: true });
  const length = p.end - p.start;
  await ffmpeg(['-ss', p.start.toFixed(3), '-to', p.end.toFixed(3), '-i', p.input, '-map', '0:a:0',
    '-af', `afade=t=in:d=0.03,afade=t=out:st=${(length - 0.03).toFixed(3)}:d=0.03`, '-c:a', 'libmp3lame', '-b:a', '192k', tempPath(file)]);
  await rename(tempPath(file), file);
  return file;
}

const levels = new Map<string, Promise<number>>();
function lufsOf(file: string): Promise<number> {
  if (!levels.has(file)) levels.set(file, loudness(file).then(l => l.integrated));
  return levels.get(file)!;
}

/** The audio file for a take, or null when that clone take has not been recorded yet. */
export async function takeAudio(id: string): Promise<string | null> {
  if (id === 'real') return realClip();
  const take = CLONE_TAKES.find(t => t.id === id);
  if (!take) return null;
  const { text } = await paragraph();
  const key = ttsKey(text, requireEnv('ELEVENLABS_VOICE_ID'), takeConfig(await readJson<VoiceConfig>(VOICE_CONFIG), take));
  return (await cachedSpeech(key)) ? ttsAudio(key) : null;
}

export async function voiceTest(): Promise<VoiceTest> {
  const p = await paragraph();
  const config = await readJson<VoiceConfig>(VOICE_CONFIG);
  const real = await realClip();
  const takes: TakeState[] = [{
    id: 'real', label: 'Your real voice', detail: 'Cut from the recording, exactly as you said it.',
    ready: true, chosen: false, lufs: await lufsOf(real),
  }];
  for (const t of CLONE_TAKES) {
    const file = await takeAudio(t.id);
    takes.push({
      id: t.id, label: t.label, detail: t.detail, ready: Boolean(file),
      chosen: config.model_id === t.model_id && config.voice_settings.stability === t.stability && config.voice_settings.similarity_boost === t.similarity_boost,
      lufs: file ? await lufsOf(file) : null,
    });
  }
  return { text: p.text, source: `Lines ${SOURCE.from} to ${SOURCE.to} of “${p.title}”`, takes };
}

const recording = new Map<string, Promise<unknown>>();

/** Records one clone take, unless it is cached. A second click while it records waits for the first. */
export async function recordTake(id: string): Promise<VoiceTest> {
  const take = CLONE_TAKES.find(t => t.id === id);
  if (!take) throw new UserError(`There is no take called ${id}.`);
  if (!(await takeAudio(id))) {
    if (!recording.has(id)) {
      const { text } = await paragraph();
      const voiceId = requireEnv('ELEVENLABS_VOICE_ID');
      const config = takeConfig(await readJson<VoiceConfig>(VOICE_CONFIG), take);
      recording.set(id, recordSpeech(ttsKey(text, voiceId, config), text, voiceId, config).finally(() => recording.delete(id)));
    }
    await recording.get(id);
  }
  return voiceTest();
}

/** Saves a take's model and settings to config/voice.json, where the voice step reads them. */
export async function chooseTake(id: string): Promise<VoiceTest> {
  const take = CLONE_TAKES.find(t => t.id === id);
  if (!take) throw new UserError(`There is no take called ${id}.`);
  await writeJson(VOICE_CONFIG, takeConfig(await readJson<VoiceConfig>(VOICE_CONFIG), take));
  return voiceTest();
}
