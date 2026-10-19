import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { UserError } from './errors.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
export const JOBS_DIR = join(ROOT, 'jobs');
export const CACHE_DIR = join(ROOT, 'cache');
export const CONFIG_DIR = join(ROOT, 'config');

const envFile = join(ROOT, '.env');

/** Copies .env into process.env, filling only values that are missing or empty. */
function loadEnv(): void {
  if (!existsSync(envFile)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (!process.env[key]?.trim()) process.env[key] = value;
  }
}
loadEnv();

/** Reads a required setting from .env, re-reading the file so a fresh edit needs no restart. Never log the value. */
export function requireEnv(name: string): string {
  if (!process.env[name]?.trim()) loadEnv();
  const value = process.env[name]?.trim();
  if (!value) throw new UserError(`${name} is missing from .env.`, 'Copy .env.example to .env in the project folder, fill it in, then try again.');
  return value;
}
