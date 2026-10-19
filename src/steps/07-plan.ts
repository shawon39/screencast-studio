import type { Step } from '../pipeline.ts';
import { readJson, writeJson } from '../lib/files.ts';
import type { Script } from '../lib/script.ts';
import { formatDuration } from '../lib/time.ts';
import { plan } from '../lib/timemap.ts';
import type { Edl, PlanLine } from '../lib/timemap.ts';
import type { Screen } from './03-analyze.ts';
import type { Voice, VoiceLine } from './06-voice.ts';

/** Stage 7. Builds edl.json: which source frames play when, and where each voice clip goes. */
export const planStep: Step = {
  name: 'Planning the cut',
  phase: 'cut',
  weight: 1,
  inputs: ctx => [ctx.work('script.json'), ctx.work('screen.json'), ctx.work('voice.json')],
  outputs: ctx => [ctx.work('edl.json')],

  async run(ctx) {
    const script = await readJson<Script>(ctx.work('script.json'));
    const screen = await readJson<Screen>(ctx.work('screen.json'));
    const voice = await readJson<Voice>(ctx.work('voice.json'));
    const recorded = new Map(voice.lines.map(l => [l.id, l]));

    const { lines, members } = planLines(script.lines.filter(l => l.keep && recorded.has(l.id)), recorded);
    const edl = splitMerged(plan({ fps: screen.fps, durationSec: screen.durationSec, still: screen.still, lines }), members, recorded);
    await writeJson(ctx.work('edl.json'), edl);

    const inSync = edl.anchors.filter(a => a.errorMs <= 150).length;
    ctx.job.cut = { durationSec: edl.durationSec, cues: edl.anchors.length, cuesInSync: inSync, maxSpeed: edl.stats.maxSpeedWhileSpeaking };
    ctx.detail(`The cut runs ${formatDuration(edl.durationSec)}, from ${formatDuration(screen.durationSec)}. ${inSync} of ${edl.anchors.length} cues land within 150 ms.`);
  },
};

/**
 * One plan line per kept line, except that a line the voice runs into without a pause is planned
 * together with the line before it: no pause can be added between them without chopping a word, so
 * the video fits around the two as one. `members` maps each plan line to the script lines it holds.
 */
export function planLines(kept: { id: number; start: number; end: number }[], recorded: Map<number, VoiceLine>): { lines: PlanLine[]; members: Map<number, number[]> } {
  const groups: (typeof kept)[] = [];
  for (const l of kept) {
    const last = groups.at(-1)?.at(-1);
    if (last && recorded.get(l.id)!.runsOn && recorded.get(last.id)!.file === recorded.get(l.id)!.file) groups.at(-1)!.push(l);
    else groups.push([l]);
  }
  const lines = groups.map((g, i): PlanLine => {
    const first = recorded.get(g[0].id)!;
    const prev = i > 0 ? recorded.get(groups[i - 1].at(-1)!.id)! : null;
    const vs = g.map(l => recorded.get(l.id)!);
    return {
      id: g[0].id,
      start: g[0].start,
      end: g.at(-1)!.end,
      speech: vs.at(-1)!.speechEnd - first.speechStart,
      anchors: vs.flatMap(v => v.anchors.map(a => ({ word: a.word, source: a.at, voice: a.voiceAt - first.speechStart }))),
      breaks: vs.flatMap(v => v.breaks.map(b => b + v.speechStart - first.speechStart)),
      // Lines from one take keep the pause the voice made between them.
      pauseBefore: prev?.file === first.file ? Math.max(0, first.speechStart - prev.speechEnd) : null,
    };
  });
  return { lines, members: new Map(groups.map(g => [g[0].id, g.map(l => l.id)])) };
}

/**
 * Gives every merged line its own clips and cues back. The clips meet in the middle of the pause the
 * take made between two lines (or where it ran on), so the take plays straight through.
 */
export function splitMerged(edl: Edl, members: Map<number, number[]>, recorded: Map<number, VoiceLine>): Edl {
  const voice = edl.voice.flatMap(clip => {
    const ids = members.get(clip.lineId) ?? [clip.lineId];
    if (ids.length === 1) return [clip];
    const vs = ids.map(id => recorded.get(id)!);
    const f0 = vs[0].speechStart + clip.from;
    const f1 = vs[0].speechStart + clip.to;
    return vs.flatMap((v, k) => {
      const a = Math.max(f0, k > 0 ? (vs[k - 1].speechEnd + v.speechStart) / 2 : -Infinity);
      const b = Math.min(f1, k + 1 < vs.length ? (v.speechEnd + vs[k + 1].speechStart) / 2 : Infinity);
      return b - a > 1e-6 ? [{ lineId: v.id, from: a - v.speechStart, to: b - v.speechStart, at: clip.at + (a - f0) }] : [];
    });
  });
  const anchors = edl.anchors.map(c => {
    const owner = (members.get(c.lineId) ?? []).find(id => recorded.get(id)!.anchors.some(a => a.word === c.word && Math.abs(a.at - c.source) < 1e-6));
    return owner ? { ...c, lineId: owner } : c;
  });
  return { ...edl, voice, anchors };
}
