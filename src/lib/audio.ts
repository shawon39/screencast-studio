import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';

/** Every audio track is built at this rate, mono. */
export const RATE = 48_000;

/** Decodes any audio file to mono float samples at RATE. */
export function decodeAudio(file: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => { err += c; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg could not decode ${file}: ${err.trim()}`));
      const buf = Buffer.concat(chunks);
      const out = new Float32Array(buf.length / 4);
      for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });
}

/** Writes mono 16-bit PCM WAV through a temp file. */
export async function writeWav(path: string, samples: Float32Array): Promise<void> {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, Buffer.concat([header, data]));
  await rename(tmp, path);
}

/** Average level of `pcm` between two times in seconds, in dB. */
export function levelDb(pcm: Float32Array, from: number, to: number): number {
  const a = Math.max(0, Math.round(from * RATE));
  const b = Math.min(pcm.length, Math.round(to * RATE));
  let sum = 0;
  for (let i = a; i < b; i++) sum += pcm[i] * pcm[i];
  return 10 * Math.log10(sum / Math.max(1, b - a) + 1e-20);
}

/** The quietest 10 ms of `pcm` between `lo` and `hi` seconds: its middle, and its level in dB. */
export function quietest(pcm: Float32Array, lo: number, hi: number): { at: number; db: number } {
  const w = Math.round(0.01 * RATE);
  const a = Math.max(0, Math.round(lo * RATE));
  const b = Math.min(pcm.length - w, Math.round(hi * RATE) - w);
  let at = (lo + hi) / 2;
  let min = Infinity;
  for (let i = a; i <= b; i += Math.round(0.001 * RATE)) {
    let sum = 0;
    for (let k = i; k < i + w; k++) sum += pcm[k] * pcm[k];
    if (sum < min) {
      min = sum;
      at = (i + w / 2) / RATE;
    }
  }
  return { at, db: Number.isFinite(min) ? 10 * Math.log10(min / w + 1e-20) : 0 };
}
