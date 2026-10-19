import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Step } from '../pipeline.ts';
import { decodeAudio, levelDb, quietest } from '../lib/audio.ts';
import { elevenlabs, explainElevenLabsError } from '../lib/elevenlabs.ts';
import { CACHE_DIR, CONFIG_DIR, requireEnv } from '../lib/env.ts';
import { cacheRead, cacheWrite, hashJson, readJson, writeJson } from '../lib/files.ts';
import { anchorPositions } from '../lib/script.ts';
import type { Script } from '../lib/script.ts';

export interface VoiceConfig {
  model_id: string;
  output_format: string;
  seed: number;
  voice_settings: { stability: number; similarity_boost: number; style: number; use_speaker_boost: boolean; speed: number };
}

interface Alignment {
  characters: string[];
  starts: number[];
  ends: number[];
}

export interface CachedSpeech {
  requestId: string;
  createdAt: string;
  characters: number;
  text: string;
  alignment: Alignment;
}

export interface VoiceLine {
  id: number;
  /** The take this line is in, relative to work/. Lines of one paragraph share a take. */
  file: string;
  /** First and last spoken sound of this line in the file, in seconds. */
  speechStart: number;
  speechEnd: number;
  words: { text: string; start: number; end: number }[];
  /** Cues with their time in the file. */
  anchors: { word: string; source: number; at: number; voiceAt: number }[];
  /** Where the voice really pauses inside the line: the start of each word after a comma it pauses at (from speech start). */
  breaks: number[];
  /** The take runs from the line before into this one with no pause, so no pause can be added between them. */
  runsOn: boolean;
  /** What ElevenLabs billed when this take was first recorded, counted on its first line. */
  characters: number;
}

export interface Voice {
  voiceId: string;
  modelId: string;
  /** Characters billed by ElevenLabs in the run that last changed this file. */
  characters: number;
  lines: VoiceLine[];
}

export const VOICE_CONFIG = join(CONFIG_DIR, 'voice.json');
const STITCH_MAX_AGE_MS = 110 * 60 * 1000; // ElevenLabs accepts request IDs up to 2 hours old
/** A pause this long in the recording starts a new take. */
const TAKE_GAP_SEC = 1;
/** A longer paragraph splits at its longest pause, so changing one line never re-voices much. */
const TAKE_MAX_CHARS = 800;
/** Where to look for the pause between two sentences of a take: seconds before the first ends and after the next starts. Word timings can be 0.15 s off. */
export const JOIN_SEARCH = [0.1, 0.25] as const;
/** The same around a comma. */
export const COMMA_SEARCH = [0.04, 0.1] as const;
/** A pause counts when the take is at least this much quieter than its words. */
const QUIET_DB = 30;

/**
 * Groups kept lines into paragraphs, each voiced in one take, so ElevenLabs makes the pauses and breaths
 * between sentences itself. Breaks depend on the recording's pauses, not the text, so an edit to one line
 * changes only its own paragraph.
 */
export function paragraphs<T extends { start: number; end: number; clean: string }>(lines: T[]): T[][] {
  if (!lines.length) return [];
  const runs: T[][] = [[lines[0]]];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].start - lines[i - 1].end >= TAKE_GAP_SEC) runs.push([]);
    runs.at(-1)!.push(lines[i]);
  }
  const split = (p: T[]): T[][] => {
    if (p.length < 2 || p.reduce((n, l) => n + l.clean.trim().length + 1, 0) <= TAKE_MAX_CHARS) return [p];
    let at = 1;
    for (let i = 2; i < p.length; i++) if (p[i].start - p[i - 1].end > p[at].start - p[at - 1].end) at = i;
    return [...split(p.slice(0, at)), ...split(p.slice(at))];
  };
  return runs.flatMap(split);
}

/** Stage 6. One ElevenLabs request per paragraph, stitched to the takes before it, cached forever. */
export const voiceStep: Step = {
  name: 'Recording the new voice',
  phase: 'voice',
  weight: 1,
  inputs: ctx => [ctx.work('script.json'), VOICE_CONFIG],
  outputs: ctx => [ctx.work('voice.json')],

  async run(ctx) {
    const script = await readJson<Script>(ctx.work('script.json'));
    const config = await readJson<VoiceConfig>(VOICE_CONFIG);
    const voiceId = requireEnv('ELEVENLABS_VOICE_ID');

    const kept = script.lines.filter(l => l.keep && l.clean.trim());
    const takes = paragraphs(kept);
    const recent: { id: string; at: number }[] = [];
    const lines: VoiceLine[] = [];
    let billed = 0;
    let fromCache = 0;
    await mkdir(ctx.work('voice'), { recursive: true });

    for (const [i, take] of takes.entries()) {
      const texts = take.map(l => l.clean.trim());
      const text = texts.join(' ');
      const key = ttsKey(text, voiceId, config);
      const which = take.length > 1 ? `lines ${take[0].id} to ${take.at(-1)!.id}` : `line ${take[0].id}`;
      let speech = await cachedSpeech(key);
      if (speech) {
        fromCache += take.length;
        ctx.detail(`Take ${i + 1} of ${takes.length} (${which}) was recorded before, so it costs nothing.`);
      } else {
        ctx.detail(`Recording take ${i + 1} of ${takes.length} (${which}) in one go, so the sentences flow into each other.`);
        const previous = recent.filter(r => Date.now() - r.at < STITCH_MAX_AGE_MS).slice(-3).map(r => r.id);
        speech = await recordSpeech(key, text, voiceId, config, previous);
        billed += speech.characters;
      }
      if (speech.requestId) recent.push({ id: speech.requestId, at: Date.parse(speech.createdAt) });

      const file = `voice/take-${String(take[0].id).padStart(3, '0')}.mp3`;
      await copyFile(ttsAudio(key), ctx.work(file));
      // Each line's own stretch of the take's timing; the lines were joined with one space.
      let offset = 0;
      const timed = take.map((line, j) => {
        const end = offset + texts[j].length;
        const al = speech.alignment;
        const own = { characters: al.characters.slice(offset, end), starts: al.starts.slice(offset, end), ends: al.ends.slice(offset, end) };
        offset = end + 1;
        return timeLine(line.id, file, own, line.anchors);
      });
      // Listen for where the voice really pauses: a cut anywhere else would chop a word.
      const pcm = await decodeAudio(ctx.work(file));
      const words = levelDb(pcm, timed[0].speechStart, timed.at(-1)!.speechEnd);
      const pausesAt = (lo: number, hi: number) => quietest(pcm, lo, hi).db <= words - QUIET_DB;
      for (const [j, t] of timed.entries()) {
        const breaks = t.words.slice(1)
          .filter((w, k) => /[,;:–—]$/.test(t.words[k].text) && pausesAt(t.words[k].end - COMMA_SEARCH[0], w.start + COMMA_SEARCH[1]))
          .map(w => w.start - t.speechStart);
        const prev = timed[j - 1];
        const runsOn = prev !== undefined && !pausesAt(prev.speechEnd - JOIN_SEARCH[0], t.speechStart + JOIN_SEARCH[1]);
        lines.push({ ...t, breaks, runsOn, characters: j === 0 ? speech.characters : 0 });
      }
      ctx.progress((i + 1) / takes.length);
    }

    const voice: Voice = { voiceId, modelId: config.model_id, characters: billed, lines };
    await writeJson(ctx.work('voice.json'), voice);
    ctx.job.voice = { lines: kept.length, fromCache, characters: billed };
    ctx.detail(`Recorded ${kept.length} lines in ${takes.length} takes${fromCache ? `, ${fromCache} lines from earlier runs` : ''}. ElevenLabs billed ${billed} characters.`);
  },
};

/** What ElevenLabs gets as voice settings. eleven_v4 has no speed or style setting. */
function sentSettings(config: VoiceConfig) {
  const { speed, style, ...rest } = config.voice_settings;
  return config.model_id.startsWith('eleven_v4') ? rest : { ...rest, speed, style };
}

/** The TTS cache key: everything that changes the audio. Request stitching is left out, so a re-run never pays again. */
export function ttsKey(text: string, voiceId: string, config: VoiceConfig): string {
  return hashJson({ text, voiceId, model: config.model_id, settings: sentSettings(config), seed: config.seed, format: config.output_format });
}

export const ttsAudio = (key: string): string => join(CACHE_DIR, 'tts', `${key}.mp3`);

/** A recording made before with exactly these inputs, or null. */
export async function cachedSpeech(key: string): Promise<CachedSpeech | null> {
  const speech = await cacheRead<CachedSpeech>('tts', key);
  return speech && existsSync(ttsAudio(key)) ? speech : null;
}

/** One ElevenLabs request, kept in cache/tts forever. `previous` are request IDs that this one flows from. */
export async function recordSpeech(key: string, text: string, voiceId: string, config: VoiceConfig, previous: string[] = []): Promise<CachedSpeech> {
  const settings = sentSettings(config);
  let res;
  try {
    res = await elevenlabs().textToSpeech.convertWithTimestamps(voiceId, {
      text,
      modelId: config.model_id,
      outputFormat: config.output_format as never,
      seed: config.seed,
      voiceSettings: {
        stability: settings.stability,
        similarityBoost: settings.similarity_boost,
        useSpeakerBoost: settings.use_speaker_boost,
        ...('speed' in settings ? { speed: settings.speed, style: settings.style } : {}),
      },
      previousRequestIds: previous.length ? previous : undefined,
    }).withRawResponse();
  } catch (err) {
    throw explainElevenLabsError(err);
  }
  const a = res.data.alignment;
  if (!a) throw new Error(`ElevenLabs returned no timing for "${text.slice(0, 60)}".`);
  const speech: CachedSpeech = {
    requestId: res.rawResponse.headers.get('request-id') ?? '',
    createdAt: new Date().toISOString(),
    characters: Number(res.rawResponse.headers.get('character-cost') ?? text.length),
    text,
    alignment: { characters: a.characters, starts: a.characterStartTimesSeconds, ends: a.characterEndTimesSeconds },
  };
  await mkdir(join(CACHE_DIR, 'tts'), { recursive: true });
  await writeFile(ttsAudio(key), Buffer.from(res.data.audioBase64, 'base64'));
  await cacheWrite('tts', key, speech);
  return speech;
}

/** Word and cue times inside one recorded line, from ElevenLabs' character timing. */
function timeLine(id: number, file: string, al: Alignment, anchors: Script['lines'][number]['anchors']): Omit<VoiceLine, 'characters' | 'breaks' | 'runsOn'> {
  // The alignment covers the text exactly as sent, so its characters are the source of truth.
  const spoken = al.characters.join('');
  const words = [...spoken.matchAll(/\S+/g)].map(m => ({
    text: m[0],
    start: al.starts[m.index],
    end: al.ends[m.index + m[0].length - 1],
  }));
  if (!words.length) throw new Error(`Line ${id} came back with no words.`);
  return {
    id,
    file,
    speechStart: words[0].start,
    speechEnd: words.at(-1)!.end,
    words,
    anchors: anchorPositions(spoken, anchors).map(p => ({ word: p.anchor.word, source: p.anchor.source, at: p.anchor.at, voiceAt: al.starts[p.start] })),
  };
}
