import { join } from 'node:path';
import type { Step } from '../pipeline.ts';
import { elevenlabs, explainElevenLabsError } from '../lib/elevenlabs.ts';
import { CONFIG_DIR } from '../lib/env.ts';
import { cacheRead, cacheWrite, hashFile, hashJson, readJson, writeJson } from '../lib/files.ts';
import { formatDuration } from '../lib/time.ts';

export interface Word {
  text: string;
  start: number;
  end: number;
  type: 'word' | 'audio_event';
  logprob?: number;
}

export interface Transcript {
  language: string;
  text: string;
  durationSec: number;
  /** Words and audio events in order. Fillers stay in, with their times. */
  words: Word[];
}

const KEYTERMS = join(CONFIG_DIR, 'keyterms.json');

/** Stage 2. Word-level transcript from ElevenLabs Scribe v2, cached by audio hash and settings. */
export const transcribeStep: Step = {
  name: 'Transcribing your speech',
  phase: 'listen',
  weight: 4,
  inputs: ctx => [ctx.work('speech.flac'), KEYTERMS],
  outputs: ctx => [ctx.work('transcript.json')],

  async run(ctx) {
    const { transcript, cached } = await transcribe(ctx.work('speech.flac'), ctx.job.media?.durationSec ?? 0, () =>
      ctx.detail(`Sending ${formatDuration(ctx.job.media?.durationSec ?? 0)} of audio to ElevenLabs. Every word gets its own timestamp.`));
    if (cached) ctx.detail('Already transcribed earlier, so this costs nothing.');

    await writeJson(ctx.work('transcript.json'), transcript);
    const words = transcript.words.filter(w => w.type === 'word').length;
    ctx.job.listen = { ...ctx.job.listen, words };
    ctx.detail(`Heard ${words} words.`);
  },
};

/**
 * Word-level transcript of a mono audio file from ElevenLabs Scribe v2, cached by audio hash and
 * settings so the same audio is never paid for twice. `onCall` runs just before a paid request.
 */
export async function transcribe(file: string, durationSec: number, onCall?: () => void): Promise<{ transcript: Transcript; cached: boolean }> {
  const settings = {
    modelId: 'scribe_v2',
    languageCode: 'en',
    tagAudioEvents: true,
    timestampsGranularity: 'word' as const,
    noVerbatim: false,
    keyterms: await readJson<string[]>(KEYTERMS),
  };
  const key = hashJson({ audio: await hashFile(file), settings });
  const hit = await cacheRead<Transcript>('transcripts', key);
  if (hit) return { transcript: hit, cached: true };
  onCall?.();
  let res;
  try {
    res = await elevenlabs().speechToText.convert({ file: { path: file, contentType: 'audio/flac' }, ...settings });
  } catch (err) {
    throw explainElevenLabsError(err);
  }
  if (!('words' in res)) throw new Error('ElevenLabs returned no word list for this audio.');
  const transcript: Transcript = {
    language: res.languageCode,
    text: res.text,
    durationSec,
    words: res.words
      .filter(w => w.type !== 'spacing' && w.start != null && w.end != null)
      .map(w => ({ text: w.text, start: w.start!, end: w.end!, type: w.type as Word['type'], logprob: w.logprob })),
  };
  await cacheWrite('transcripts', key, transcript);
  return { transcript, cached: false };
}
