/**
 * Cleans a voice-clone sample: cuts "uh"/"um" and other sounds, and shortens every pause over 0.7 s
 * to 0.5 s. It only cuts your real audio; it never generates any.
 *
 *   npm run clean-training -- path/to/sample.wav          writes path/to/sample.clean.mp3
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { decodeAudio, RATE, writeWav } from '../src/lib/audio.ts';
import { isFiller, keepRanges } from '../src/lib/clean.ts';
import { ffmpeg, probe } from '../src/lib/ffmpeg.ts';
import { formatDuration } from '../src/lib/time.ts';
import { transcribe } from '../src/steps/02-transcribe.ts';

const input = process.argv[2] ? resolve(process.argv[2]) : '';
if (!input || !existsSync(input)) {
  console.error('Usage: npm run clean-training -- <recording of your voice, 1 to 3 minutes>');
  process.exit(1);
}
const output = join(dirname(input), `${basename(input, extname(input))}.clean.mp3`);
const SPLICE = Math.round(0.015 * RATE); // 15 ms crossfade at every cut

const tmp = await mkdtemp(join(tmpdir(), 'studio-clean-'));
try {
  const durationSec = (await probe(input)).durationSec;
  console.log(`Transcribing ${formatDuration(durationSec)} of audio to find fillers and pauses...`);
  const speech = join(tmp, 'speech.flac');
  await ffmpeg(['-i', input, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'flac', speech]);
  const { transcript, cached } = await transcribe(speech, durationSec);
  if (cached) console.log('(Transcribed before, so this cost nothing.)');

  const ranges = keepRanges(transcript.words, durationSec);
  if (!ranges.length) throw new Error('No speech was found in this file.');
  const pcm = await decodeAudio(input);

  // Join the kept ranges, overlapping each splice by 15 ms with an equal-power crossfade.
  const total = ranges.reduce((n, r) => n + Math.round((r.end - r.start) * RATE), 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const [i, r] of ranges.entries()) {
    const s0 = Math.round(r.start * RATE);
    const n = Math.min(pcm.length, Math.round(r.end * RATE)) - s0;
    const start = i === 0 ? at : Math.max(0, at - SPLICE);
    for (let k = 0; k < n; k++) {
      const fadeIn = i > 0 && k < SPLICE ? Math.sin((k / SPLICE) * Math.PI / 2) : 1;
      const fadeOut = i < ranges.length - 1 && k >= n - SPLICE ? Math.cos(((k - (n - SPLICE)) / SPLICE) * Math.PI / 2) : 1;
      if (start + k < out.length) out[start + k] += pcm[s0 + k] * fadeIn * fadeOut;
    }
    at = start + n;
  }
  const wav = join(tmp, 'clean.wav');
  await writeWav(wav, out.subarray(0, at));
  await ffmpeg(['-i', wav, '-c:a', 'libmp3lame', '-b:a', '192k', output]);

  // Check the result: the longest pause left.
  const log = await ffmpeg(['-i', output, '-af', 'silencedetect=noise=-40dB:d=0.3', '-f', 'null', '-']);
  const pauses = [...log.matchAll(/silence_duration: ([\d.]+)/g)].map(m => Number(m[1]));
  const fillers = transcript.words.filter(isFiller).length;
  const longest = pauses.length ? Math.max(...pauses) : 0;
  console.log(`\nRemoved ${fillers} filler${fillers === 1 ? '' : 's'} and sounds. ${formatDuration(durationSec)} became ${formatDuration(at / RATE)}.`);
  console.log(`Longest pause left: ${longest.toFixed(2)} s${longest > 0.75 ? ' (over 0.7 s; check the start or end of the file)' : ''}.`);
  console.log(`Saved ${output}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
