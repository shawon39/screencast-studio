import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CACHE_DIR } from './env.ts';

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** Writes through a temp file and a rename, so a crash never leaves half a file behind. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

/** A sibling path for a file being written, keeping the extension so ffmpeg picks the right muxer. */
export function tempPath(path: string): string {
  return path.replace(/(\.[^./]+)$/, '.tmp$1');
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** The shared cache under cache/<kind>/, reused across jobs so a paid call never repeats. */
export async function cacheRead<T>(kind: string, key: string): Promise<T | null> {
  try {
    return await readJson<T>(join(CACHE_DIR, kind, `${key}.json`));
  } catch {
    return null;
  }
}

export async function cacheWrite(kind: string, key: string, value: unknown): Promise<void> {
  await writeJson(join(CACHE_DIR, kind, `${key}.json`), value);
}
