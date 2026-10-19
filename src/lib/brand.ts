import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Brand } from '../../remotion/cards.tsx';
import { CONFIG_DIR, ROOT } from './env.ts';
import { UserError } from './errors.ts';
import { readJson } from './files.ts';

export interface BrandConfig {
  name: string;
  series: string;
  colors: Brand['colors'];
  /** Paths relative to the project folder, or null. */
  fontFile: string | null;
  logo: string | null;
  outro: Brand['outro'];
  music: string | null;
  musicVolume: number;
}

export const BRAND_CONFIG = join(CONFIG_DIR, 'brand.json');

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

/** A brand file as a data URL, so the Remotion cards need no file server. */
async function dataUrl(rel: string, field: string): Promise<string> {
  const file = join(ROOT, rel);
  if (!existsSync(file)) throw new UserError(`config/brand.json points "${field}" at ${rel}, but that file is missing.`, `Put the file there, or set "${field}" to null.`);
  const type = MIME[extname(file).toLowerCase()];
  if (!type) throw new UserError(`${rel} is not a supported ${field} file.`, field === 'logo' ? 'Use a PNG, JPG, SVG or WebP.' : 'Use a WOFF2, WOFF, TTF or OTF font.');
  return `data:${type};base64,${(await readFile(file)).toString('base64')}`;
}

export async function loadBrand(): Promise<{ config: BrandConfig; card: Brand }> {
  const config = await readJson<BrandConfig>(BRAND_CONFIG);
  return {
    config,
    card: {
      name: config.name,
      series: config.series,
      colors: config.colors,
      fontData: config.fontFile ? await dataUrl(config.fontFile, 'fontFile') : null,
      logo: config.logo ? await dataUrl(config.logo, 'logo') : null,
      outro: config.outro,
    },
  };
}

/** config/brand.json and the files it points at, so a step re-runs when any of them changes. */
export function brandInputs(): string[] {
  const config = JSON.parse(readFileSync(BRAND_CONFIG, 'utf8')) as BrandConfig;
  return [BRAND_CONFIG, ...[config.fontFile, config.logo, config.music].filter((f): f is string => Boolean(f)).map(f => join(ROOT, f))];
}
