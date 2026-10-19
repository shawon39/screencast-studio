import { copyFile, rename, writeFile } from 'node:fs/promises';
import type { Step } from '../pipeline.ts';
import { probe } from '../lib/ffmpeg.ts';
import { readJson, tempPath } from '../lib/files.ts';
import { buildReport, summarizeChanges } from '../lib/report.ts';
import type { Script } from '../lib/script.ts';
import type { Edl } from '../lib/timemap.ts';
import type { Voice } from './06-voice.ts';
import type { CheckResult } from './11-check.ts';
import type { CutPictures } from './12-pictures.ts';

const FILES = ['final.mp4', 'final.srt', 'thumbnail.png'];

/** Stage 13. Puts the finished files in output/ and writes report.md. */
export const deliverStep: Step = {
  name: 'Writing the video, subtitles, thumbnail and report',
  phase: 'finish',
  weight: 1,
  inputs: ctx => [...FILES.map(f => ctx.work(f)), ctx.work('check.json'), ctx.work('cut-pictures.json')],
  outputs: ctx => [...FILES.map(f => ctx.output(f)), ctx.output('report.md')],

  async run(ctx) {
    for (const f of FILES) {
      await copyFile(ctx.work(f), tempPath(ctx.output(f)));
      await rename(tempPath(ctx.output(f)), ctx.output(f));
    }
    const script = await readJson<Script>(ctx.work('script.json'));
    const edl = await readJson<Edl>(ctx.work('edl.json'));
    const check = await readJson<CheckResult>(ctx.work('check.json'));
    const pictures = await readJson<CutPictures>(ctx.work('cut-pictures.json'));
    const voice = await readJson<Voice>(ctx.work('voice.json'));
    const characters = voice.lines.reduce((n, l) => n + (l.characters ?? 0), 0);
    const rawSec = ctx.job.media?.durationSec ?? 0;
    const { width, height } = (await probe(ctx.work('final.mp4'))).video!;

    const report = ctx.output('report.md');
    await writeFile(tempPath(report), buildReport({
      title: script.title,
      sourceName: ctx.job.sourceName,
      rawSec,
      finalSec: check.durationSec,
      size: { width, height },
      script,
      edl,
      check,
      pictures,
      characters,
    }));
    await rename(tempPath(report), report);
    ctx.job.result = {
      finalSec: check.durationSec,
      rawSec,
      cues: edl.anchors.length,
      cuesInSync: edl.anchors.filter(a => a.errorMs <= 150).length,
      worstSsim: check.worstSsim,
      lufs: check.lufs,
      truePeak: check.truePeak,
      characters,
      problems: check.problems,
      changes: summarizeChanges(script, edl),
    };
  },
};
