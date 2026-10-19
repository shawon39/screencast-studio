import { CUT_QUIET_DB, JUMP_PIXELS, RIDE_DB } from '../steps/11-check.ts';
import type { CheckResult } from '../steps/11-check.ts';
import { PICTURE_FILE } from '../steps/12-pictures.ts';
import type { CutPictures } from '../steps/12-pictures.ts';
import type { Script } from './script.ts';
import { formatDuration } from './time.ts';
import type { Edl } from './timemap.ts';
import { cutsOf } from './timemap.ts';

const tc = (sec: number) => {
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, '0')}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const signedDb = (db: number) => `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
const speedOf = (op: Extract<Edl['video'][number], { kind: 'play' }>, fps: number) => (op.srcEnd - op.src) * fps / op.frames;

/** The short "what changed" list for the Done screen. */
export function summarizeChanges(script: Script, edl: Edl): string[] {
  const out: string[] = [];
  const dropped = script.lines.filter(l => !l.keep).length;
  if (dropped) out.push(`${plural(dropped, 'line')} dropped: retakes, false starts and talk with nothing to follow`);
  const cuts = cutsOf(edl.video).filter(c => !c.crossfade);
  const cutSec = cuts.reduce((n, c) => n + c.end - c.start, 0);
  if (cuts.length) out.push(`${plural(cuts.length, 'still pause')} shortened, saving ${formatDuration(cutSec)}`);
  const fast = edl.video.filter((op): op is Extract<typeof op, { kind: 'play' }> => op.kind === 'play' && op.srcEnd - op.src >= 2 && speedOf(op, edl.fps) >= 1.9);
  if (fast.length) {
    const speeds = fast.map(op => speedOf(op, edl.fps));
    const lo = Math.min(...speeds).toFixed(1);
    const hi = Math.max(...speeds).toFixed(1);
    out.push(`${plural(fast.length, 'page load or wait', 'page loads or waits')} sped up ${lo === hi ? `${lo}×` : `${lo}× to ${hi}×`}, with no voice`);
  }
  const holds = edl.video.filter(op => op.kind === 'hold' && op.frames / edl.fps >= 0.15);
  if (holds.length) out.push(`The picture paused ${plural(holds.length, 'time')}, up to ${(Math.max(...holds.map(h => h.frames)) / edl.fps).toFixed(1)} s, so the voice could finish`);
  if (edl.stats.voicePauseSec > 0.05) out.push(`The voice waits ${edl.stats.voicePauseSec.toFixed(1)} s in total for the screen to catch up`);
  out.push(`Fastest speed-up while the voice speaks: ${edl.stats.maxSpeedWhileSpeaking.toFixed(2)}×`);
  return out;
}

export function buildReport(o: {
  title: string;
  sourceName: string;
  rawSec: number;
  finalSec: number;
  /** The final video's frame size. */
  size: { width: number; height: number };
  script: Script;
  edl: Edl;
  check: CheckResult;
  pictures: CutPictures;
  characters: number;
}): string {
  const { script, edl, check, pictures } = o;
  const inSync = edl.anchors.filter(a => a.errorMs <= 150).length;
  const worstMs = edl.anchors.length ? Math.max(...edl.anchors.map(a => a.errorMs)) : 0;
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const { voiceCuts, gain, stops } = check;
  const noJump = check.videoCuts.count ? `${check.videoCuts.noJump} of ${check.videoCuts.count}, the most ${check.videoCuts.mostChangedPx} of 518,400 pixels` : 'nothing cut out to compare';
  const cutsInPause = voiceCuts.count ? `${voiceCuts.inPause} of ${voiceCuts.count}, the closest ${voiceCuts.minUnderDb!.toFixed(0)} dB under` : 'no cuts inside a take';
  const seeEach = (list: CutPictures['cuts']) => list.length ? `. See each one, by time in the video: ${list.map(p => `[${tc(p.at)}](${p.file})`).join(', ')}` : '';
  const sameGain = gain.words !== null && gain.pauses !== null
    ? `${Math.abs(gain.pauses - gain.words).toFixed(1)} dB apart (words ${signedDb(gain.words)}, pauses ${signedDb(gain.pauses)})`
    : 'no pauses to compare';
  const stopList = stops.length
    ? `${stops.length}: ${stops.map(s => `line ${s.lineId}, "${s.before} ⏸ ${s.after}" for ${s.waitSec.toFixed(1)} s, ${s.atComma ? 'at a comma pause' : 'where it does not pause'}`).join('; ')}`
    : 'none';
  const lines: string[] = [
    `# ${o.title}`,
    '',
    `Made ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} from ${o.sourceName} (${formatDuration(o.rawSec)}). Final video: ${formatDuration(o.finalSec)} at ${o.size.width} × ${o.size.height}, 30 fps.`,
    '',
    '## Checks',
    '',
    '| Check | Result |',
    '| --- | --- |',
    `| Cues within 150 ms of their action | ${inSync} of ${edl.anchors.length}${edl.anchors.length ? `, the worst ${worstMs} ms off` : ''} |`,
    `| Frame at each cue matches the recording | ${edl.anchors.length ? `lowest SSIM ${check.worstSsim.toFixed(4)} (1 = same frame)` : 'no cues'} |`,
    `| Cuts only on still screens | ${check.cutsOnStillOnly ? 'yes' : 'no'} |`,
    `| No jump at a video cut: ${JUMP_PIXELS} pixels or fewer change in the part cut out | ${noJump}${seeEach(pictures.videoCuts)} |`,
    `| Loudness | ${check.lufs} LUFS, true peak ${check.truePeak} dBTP (${plural(check.passes, 'pass', 'passes')}) |`,
    `| Voice cut only in real pauses, ${CUT_QUIET_DB} dB or more under the words | ${cutsInPause}${seeEach(pictures.cuts)} |`,
    `| Same gain on pauses and words, within ${RIDE_DB} dB | ${sameGain} |`,
    `| Voice stops inside a sentence | ${cell(stopList)} |`,
    `| ElevenLabs characters for this video | ${o.characters} |`,
    '',
    check.problems.length ? `Problems left after ${plural(check.passes, 'pass', 'passes')}:` : 'No problems found.',
    ...check.problems.map((p, i) => {
      const picture = pictures.problems[i];
      return `- ${p}${picture ? ` [See it at ${tc(picture.at)}](${picture.file})` : ''}`;
    }),
    '',
    '## What changed',
    '',
    ...summarizeChanges(script, edl).map(c => `- ${c}`),
    '',
    '## Script',
    '',
    '| # | At | You said | Clean line |',
    '| --- | --- | --- | --- |',
    ...script.lines.map(l => `| ${l.id} | ${tc(l.start)} | ${cell(l.said.join(' '))} | ${l.keep ? cell(l.clean) : `Dropped. ${cell(l.reason || 'Dropped by you.')}`} |`),
    '',
    '## Every cut and speed change',
    '',
    'Times are in the original recording.',
    '',
    '| At | Change |',
    '| --- | --- |',
  ];
  const events: { at: number; text: string }[] = [];
  for (const c of cutsOf(edl.video)) {
    events.push({ at: c.start, text: c.crossfade ? `Long page load: the middle ${(c.end - c.start).toFixed(1)} s replaced by a 0.3 s crossfade` : `Cut ${(c.end - c.start).toFixed(2)} s of still screen` });
  }
  for (const op of edl.video) {
    if (op.kind === 'play') {
      const speed = speedOf(op, edl.fps);
      if (Math.abs(speed - 1) >= 0.03) events.push({ at: op.src, text: `${(op.srcEnd - op.src).toFixed(2)} s played at ${speed.toFixed(2)}×` });
    } else if (op.kind === 'hold') {
      events.push({ at: op.at, text: `Frame held ${(op.frames / edl.fps).toFixed(2)} s` });
    }
  }
  events.sort((a, b) => a.at - b.at);
  lines.push(...events.map(e => `| ${tc(e.at)} | ${e.text} |`), '', '## Cues', '', '| Line | Word | You said it at | Off by | Frame match |', '| --- | --- | --- | --- | --- |');
  for (const a of edl.anchors) {
    const c = check.anchors.find(x => x.lineId === a.lineId && x.word === a.word);
    lines.push(`| ${a.lineId} | ${a.word} | ${tc(a.source)} | ${a.errorMs} ms | ${c ? c.ssim.toFixed(4) : ''} |`);
  }
  for (const n of edl.notes) lines.push('', `Note: ${n}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The report as a download. Away from output/, its cuts/ links would open nothing, so they point at the
 * app instead, and a line under the title says so and where the pictures are on disk. Each link carries
 * its picture's key (`keys` from cut-pictures.json), so after a new render it says the picture is gone
 * instead of showing a different one.
 */
export function reportForDownload(report: string, o: { pictureUrl: string; folder: string; keys: Record<string, string> }): string {
  let linked = 0;
  const out = report.replace(/\]\(cuts\/([^)\s]+)\)/g, (link, name: string) => {
    if (!PICTURE_FILE.test(name)) return link;
    linked++;
    const key = o.keys[`cuts/${name}`];
    return `](${o.pictureUrl}/${name}${key ? `?k=${key.slice(0, 12)}` : ''})`;
  });
  if (!linked) return report;
  const note = `The picture links open in Screencast Studio while it is running, until the video is rendered again. The pictures are also in \`${o.folder}\`.`;
  return out.replace('\n\n## ', () => `\n\n${note}\n\n## `);
}
