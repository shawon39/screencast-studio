import { rename } from 'node:fs/promises';
import type { Step } from '../pipeline.ts';
import { UserError } from '../lib/errors.ts';
import { ffmpeg, probe } from '../lib/ffmpeg.ts';
import { tempPath, writeJson } from '../lib/files.ts';

/**
 * The size every later step works at: 1920 wide, in the recording's own shape, so nothing is cut and
 * nothing is padded. A 16:10 Mac screen gives 1920 × 1248. The height is a multiple of 4.
 */
export function frameSize(width: number, height: number): { width: number; height: number } {
  return { width: 1920, height: Math.round(1920 * height / width / 4) * 4 };
}

/**
 * Stage 1. Reads the upload and writes the two files every later step works from:
 * master.mp4 (see frameSize, constant 30 fps, near-lossless) and speech.flac (mono 16 kHz, for transcription).
 */
export const probeStep: Step = {
  name: 'Reading the file',
  phase: 'listen',
  weight: 3,
  inputs: ctx => [ctx.input],
  outputs: ctx => [ctx.work('probe.json'), ctx.work('master.mp4'), ctx.work('speech.flac')],

  async run(ctx) {
    const info = await probe(ctx.input);
    const v = info.video;
    if (!v) throw new UserError('This file has no video track.', 'Drop a screen recording saved as .mp4, .mkv or .mov.');
    if (!info.audio.length) throw new UserError('This file has no audio track.', 'Record with your microphone on, so there is speech to transcribe.');
    ctx.job.media = info;
    await writeJson(ctx.work('probe.json'), info);

    // OBS output at 1080p, 30 fps is copied untouched. Anything else is re-encoded once,
    // near-lossless, so later cuts start from a clean, constant-rate master.
    const size = frameSize(v.width, v.height);
    const ready = v.codec === 'h264' && v.width === size.width && v.height === size.height
      && v.constantFps && Math.abs(v.fps - 30) < 0.01 && v.pixFmt === 'yuv420p';
    const audio = `0:${info.audio[0].index}`;
    const tracks = info.audio.length > 1 ? ` Using audio track 1 of ${info.audio.length}.` : '';
    if (ready) {
      ctx.say('Copying the video', `It is already ${size.width} × ${size.height} at 30 fps.${tracks}`);
    } else {
      const rateText = v.constantFps ? `${Math.round(v.fps * 100) / 100} fps` : 'a variable frame rate';
      ctx.say(`Converting to ${size.width} × ${size.height} at a steady 30 fps`, `From ${v.width} × ${v.height} at ${rateText}, keeping its shape.${tracks}`);
    }
    const videoArgs = ready
      ? ['-c:v', 'copy']
      : [
          '-vf', `scale=${size.width}:${size.height}:flags=lanczos,setsar=1,fps=30,format=yuv420p`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12',
        ];
    const master = ctx.work('master.mp4');
    await ffmpeg(['-i', ctx.input, '-map', '0:v:0', '-map', audio, ...videoArgs,
      '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', tempPath(master)],
      { durationSec: info.durationSec, onProgress: f => ctx.progress(f * 0.9) });
    await rename(tempPath(master), master);

    ctx.say('Pulling out your voice for transcription');
    const speech = ctx.work('speech.flac');
    await ffmpeg(['-i', ctx.input, '-map', audio, '-ac', '1', '-ar', '16000', '-c:a', 'flac', tempPath(speech)]);
    await rename(tempPath(speech), speech);
  },
};
