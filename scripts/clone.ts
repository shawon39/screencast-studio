/**
 * Creates an Instant Voice Clone in ElevenLabs from cleaned samples of your voice, and prints its voice ID.
 *
 *   npm run clone -- path/to/sample.clean.mp3 --name "Shakhawat"
 *   npm run clone -- path/to/sample.clean.mp3 --name "Shakhawat (clean)" --remove-noise
 *
 * --remove-noise has ElevenLabs strip the room sound from the samples first. A clone copies everything it
 * hears, so room sound in the sample becomes a background under every sentence it speaks.
 *
 * Put the printed ID in .env as ELEVENLABS_VOICE_ID. The pipeline code does not change.
 */
import { createReadStream, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { elevenlabs, explainElevenLabsError } from '../src/lib/elevenlabs.ts';
import { UserError } from '../src/lib/errors.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { name: { type: 'string' }, 'remove-noise': { type: 'boolean' } } });
const files = positionals.map(f => resolve(f));
if (!files.length || !values.name) {
  console.error('Usage: npm run clone -- <cleaned sample> [more samples] --name "<voice name>"');
  process.exit(1);
}
const missing = files.find(f => !existsSync(f));
if (missing) {
  console.error(`No file at ${missing}`);
  process.exit(1);
}

console.log(`Creating the Instant Voice Clone "${values.name}" from ${files.map(f => basename(f)).join(', ')}...`);
try {
  const res = await elevenlabs().voices.ivc.create({
    name: values.name,
    files: files.map(f => createReadStream(f)),
    // ElevenLabs says noise removal can make audio that has no background noise worse, so it is opt-in.
    removeBackgroundNoise: Boolean(values['remove-noise']),
    description: `Instant clone from ${files.map(f => basename(f)).join(', ')}`,
  });
  console.log(`\nVoice ID: ${res.voiceId}`);
  if (res.requiresVerification) console.log('ElevenLabs wants to verify this voice before it can be used. Open Voices on elevenlabs.io and follow the steps.');
  console.log('Put it in .env as ELEVENLABS_VOICE_ID, then re-run the voice step.');
} catch (err) {
  const e = explainElevenLabsError(err);
  console.error(e instanceof Error ? e.message : e);
  if (e instanceof UserError && e.hint) console.error(e.hint);
  process.exit(1);
}
