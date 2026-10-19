import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBrand } from './lib/brand.ts';
import { elevenlabs } from './lib/elevenlabs.ts';
import { ROOT } from './lib/env.ts';
import { renderPng, withBrowser } from './lib/remotion.ts';
import { run } from './lib/run.ts';

type Result = { ok: boolean; warn?: boolean; label: string; detail: string };
const results: Result[] = [];
const pass = (label: string, detail = '') => results.push({ ok: true, label, detail });
const failed = (label: string, detail: string) => results.push({ ok: false, label, detail });
const warn = (label: string, detail: string) => results.push({ ok: true, warn: true, label, detail });

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    failed(label, err instanceof Error ? err.message : String(err));
  }
}

// Node
const major = Number(process.versions.node.split('.')[0]);
if (major >= 24) pass('Node.js', process.versions.node);
else failed('Node.js', `Version ${process.versions.node} found. Install Node 24 LTS or newer.`);

// ffmpeg and the filters each shot needs
await check('ffmpeg and ffprobe', async () => {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-version']);
  await run('ffprobe', ['-hide_banner', '-version']);
  pass('ffmpeg and ffprobe', stdout.split('\n')[0].replace('ffmpeg version ', '').split(' ')[0]);

  const filters = (await run('ffmpeg', ['-hide_banner', '-filters'])).stdout;
  const has = (name: string) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(filters);
  const needed = ['tblend', 'lutyuv', 'signalstats', 'metadata', 'silencedetect', 'scale', 'pad', 'fps', 'loudnorm', 'ebur128', 'tpad', 'setpts', 'xfade', 'overlay', 'acompressor', 'ssim'];
  const missing = needed.filter(f => !has(f));
  if (missing.length) failed('ffmpeg filters', `Missing: ${missing.join(', ')}. Reinstall ffmpeg with: brew reinstall ffmpeg`);
  else pass('ffmpeg filters', `${needed.length} needed filters found`);

  const encoders = (await run('ffmpeg', ['-hide_banner', '-encoders'])).stdout;
  if (/libx264/.test(encoders)) pass('H.264 encoder', 'libx264');
  else failed('H.264 encoder', 'This ffmpeg has no libx264. Reinstall ffmpeg with: brew reinstall ffmpeg');
  if (!/libmp3lame/.test(encoders)) warn('MP3 encoder', 'No libmp3lame, so npm run clean-training cannot write MP3. Reinstall ffmpeg with: brew reinstall ffmpeg');
});

// Claude Code, which rewrites the script in shot 2
await check('Claude Code', async () => {
  const { stdout } = await run('claude', ['--version']);
  pass('Claude Code', stdout.trim());
});

// Remotion, which draws the intro, outro and subtitles
await check('Remotion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-doctor-'));
  try {
    const { card } = await loadBrand();
    await withBrowser(browser => renderPng(browser, 'Subtitle', { lines: [], active: 0, brand: card }, join(dir, 'blank.png')));
    pass('Remotion', 'a blank frame rendered');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Keys and voice
if (!existsSync(join(ROOT, '.env'))) {
  failed('.env', 'Not found. Copy .env.example to .env and fill in ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID.');
} else {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  const voice = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (!key) failed('ElevenLabs API key', 'ELEVENLABS_API_KEY is empty in .env.');
  if (!voice) failed('ElevenLabs voice', 'ELEVENLABS_VOICE_ID is empty in .env. Pick a stock English voice and paste its ID.');
  if (key && voice) {
    await check('ElevenLabs key and voice', async () => {
      try {
        const v = await elevenlabs().voices.get(voice);
        pass('ElevenLabs key and voice', `Key accepted. Voice: ${v.name ?? voice}`);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 401) throw new Error('The key was refused. Check ELEVENLABS_API_KEY, and that it has Voices, Speech to Text and Text to Speech access.');
        if (status === 404 || status === 400) throw new Error(`The key works, but no voice has the ID in ELEVENLABS_VOICE_ID.`);
        throw err;
      }
    });
  }
}

for (const r of results) {
  const mark = !r.ok ? '✗' : r.warn ? '!' : '✓';
  console.log(`${mark} ${r.label}${r.detail ? `: ${r.detail}` : ''}`);
}
const failures = results.filter(r => !r.ok).length;
console.log(failures ? `\n${failures} check${failures > 1 ? 's' : ''} failed.` : '\nReady.');
process.exit(failures ? 1 : 0);
