import { spawn } from 'node:child_process';
import { run } from './run.ts';

export interface MediaInfo {
  durationSec: number;
  sizeBytes: number;
  video: {
    codec: string;
    width: number;
    height: number;
    fps: number;
    constantFps: boolean;
    pixFmt: string;
  } | null;
  audio: { index: number; codec: string; channels: number; sampleRate: number }[];
}

interface FfprobeStream {
  index: number;
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  disposition?: { attached_pic?: number };
}

/**
 * Where to seek so the output starts on the frame that was on screen at time `t`. ffmpeg starts at
 * the first frame at or after the seek point, so seek half a frame after the one before it.
 */
export const seekTo = (t: number, fps: number) => Math.max(0, (Math.floor(t * fps + 1e-6) - 0.5) / fps);

const rate = (r = '0/1') => {
  const [n, d] = r.split('/').map(Number);
  return d ? n / d : n;
};

export async function probe(file: string): Promise<MediaInfo> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const data = JSON.parse(stdout) as { streams: FfprobeStream[]; format: { duration?: string; size?: string } };
  const v = data.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  return {
    durationSec: Number(data.format.duration ?? 0),
    sizeBytes: Number(data.format.size ?? 0),
    video: v ? {
      codec: v.codec_name,
      width: v.width ?? 0,
      height: v.height ?? 0,
      // Browser and QuickTime recordings often report no average rate (0/0): treat them as variable.
      fps: rate(v.avg_frame_rate),
      constantFps: rate(v.avg_frame_rate) > 0 && v.r_frame_rate === v.avg_frame_rate,
      pixFmt: v.pix_fmt ?? '',
    } : null,
    audio: data.streams.filter(s => s.codec_type === 'audio').map(s => ({
      index: s.index,
      codec: s.codec_name,
      channels: s.channels ?? 0,
      sampleRate: Number(s.sample_rate ?? 0),
    })),
  };
}

/** Loudness envelope of the first audio track in `buckets` steps, each 0..1, for drawing a waveform. */
export function waveform(file: string, buckets: number, durationSec: number): Promise<number[]> {
  const rateHz = 8000;
  const perBucket = Math.max(1, Math.floor(durationSec * rateHz / buckets));
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0',
      '-ac', '1', '-ar', String(rateHz), '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const peaks: number[] = [];
    let sumSq = 0;
    let count = 0;
    let carry: Buffer | null = null;
    child.stdout.on('data', (chunk: Buffer) => {
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const s = buf.readInt16LE(i) / 32768;
        sumSq += s * s;
        if (++count === perBucket) {
          peaks.push(Math.sqrt(sumSq / count));
          sumSq = 0;
          count = 0;
        }
      }
      carry = usable < buf.length ? buf.subarray(usable) : null;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error('ffmpeg could not read the audio track.'));
      if (count) peaks.push(Math.sqrt(sumSq / count));
      const max = Math.max(...peaks, 1e-6);
      resolve(peaks.slice(0, buckets).map(p => Math.round(p / max * 1000) / 1000));
    });
  });
}

export interface FfmpegOptions {
  /** Length of the output in seconds, so progress can be reported as a fraction. */
  durationSec?: number;
  onProgress?: (fraction: number) => void;
}

/** Runs ffmpeg, reporting progress from its -progress output. Resolves with stderr, where filters log. */
export async function ffmpeg(args: string[], opts: FfmpegOptions = {}): Promise<string> {
  let pending = '';
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args], {
    onStdout: chunk => {
      if (!opts.onProgress || !opts.durationSec) return;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('out_time_us=')) continue;
        const us = Number(line.slice('out_time_us='.length));
        if (Number.isFinite(us) && us >= 0) opts.onProgress(Math.min(1, us / 1e6 / opts.durationSec));
      }
    },
  });
  return stderr;
}
