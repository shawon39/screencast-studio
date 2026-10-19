import type { Step } from '../pipeline.ts';
import { askClaude } from '../lib/claude.ts';
import { UserError } from '../lib/errors.ts';
import { readJson, writeJson } from '../lib/files.ts';
import { activeAnchors, buildScript, dropBadAnchors, splitLines, validate } from '../lib/script.ts';
import type { RewriteAnswer, SourceLine } from '../lib/script.ts';
import { formatDuration } from '../lib/time.ts';
import type { Transcript, Word } from './02-transcribe.ts';

const SYSTEM = `You clean up the narration of a screen-recording tutorial. The speaker recorded their screen while talking. A synthetic voice will read your clean lines and the video will be re-timed to match, so every clean line must say what the speaker said, in the same order, and nothing more.

For each numbered line, return:
- keep: false for false starts, retakes that the speaker says properly later, and talk that teaches nothing (for example "wait, it's loading" or "sorry"). Otherwise true.
- clean: the line as the speaker would say it on a good take. Fix grammar, and remove fillers (uh, um, so at the start, you know), repeated words and false starts inside the line. Plain spoken English. Give clean text for dropped lines too, so the reviewer can restore them.
- reason: for a dropped line, one short sentence telling the reviewer why, for example "A retake; line 6 says it properly." Empty for kept lines.
- anchors: the action words in clean that the speaker said at the moment something happened on screen, such as click, here, this, select, open, type, drag, choose, press, scroll. For each, give the word exactly as written in clean, and the #index of the same spoken word in the original line. List them in order. Do this for dropped lines too.

Rules:
1. Fix grammar only. Never add a fact, claim, step, greeting or sign-off the speaker did not say.
2. Keep each clean line within 15% of the original word count, not counting fillers and repeated words.
3. Keep every action word (click, select, open, type, drag) of a kept line, and mark it as an anchor.
4. Keep the speaker's terms exactly as product and screen names: Setup, Quick Find, Screen Flow, Object Manager.
5. Do not merge or split lines. Answer every line number exactly once.

Also return title: a plain title for the video, under 60 characters, naming what the tutorial teaches, for example "Build a screen flow that creates a case".`;

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          keep: { type: 'boolean' },
          clean: { type: 'string' },
          reason: { type: 'string' },
          anchors: {
            type: 'array',
            items: {
              type: 'object',
              properties: { word: { type: 'string' }, source: { type: 'integer' } },
              required: ['word', 'source'],
            },
          },
        },
        required: ['id', 'keep', 'clean', 'reason', 'anchors'],
      },
    },
  },
  required: ['title', 'lines'],
};

const tc = (sec: number) => {
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, '0')}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
};

function buildPrompt(source: SourceLine[], words: Word[], title: string | null): string {
  const lines = source.map(s => {
    const said = words.slice(s.first, s.last + 1)
      .map((w, i) => `${w.type === 'audio_event' ? `[${w.text}]` : w.text}#${s.first + i}`)
      .join(' ');
    return `${s.id} [${tc(s.start)}] ${said}`;
  });
  return [
    'The recording, one numbered line per sentence. Each spoken word is followed by #index; use these indexes for anchors.',
    '',
    ...lines,
    '',
    title ? `The speaker already chose the title "${title}". Return it unchanged as title.` : 'Write the title.',
  ].join('\n');
}

/** Stage 4. Claude rewrites the transcript into clean lines with cues; the validator holds it to the hard rules. */
export const rewriteStep: Step = {
  name: 'Claude is cleaning up the script',
  phase: 'rewrite',
  weight: 1,
  inputs: ctx => [ctx.work('transcript.json')],
  outputs: ctx => [ctx.work('script.json')],

  async run(ctx) {
    const { words } = await readJson<Transcript>(ctx.work('transcript.json'));
    const source = splitLines(words);
    if (!source.length) throw new UserError('No speech was found in this recording.', 'Check that your microphone was recorded, then drop the file again.');

    const prompt = buildPrompt(source, words, ctx.job.title);
    const started = Date.now();
    let note = `Fixing grammar and marking cues in ${source.length} lines. It never adds anything you did not say.`;
    const tick = setInterval(() => ctx.detail(`${note} ${formatDuration((Date.now() - started) / 1000)}`), 1000);
    let answer: RewriteAnswer;
    let problems: string[];
    try {
      answer = await askClaude<RewriteAnswer>({ system: SYSTEM, prompt, schema: SCHEMA });
      problems = validate(source, words, answer);
      if (problems.length) {
        note = `The first answer broke ${problems.length === 1 ? 'a rule' : `${problems.length} rules`}, so Claude is fixing it.`;
        ctx.say('Asking Claude to fix its answer', problems[0]);
        const retry = `${prompt}\n\nYour previous answer had these problems. Fix them and return the whole answer again:\n${problems.map(p => `- ${p}`).join('\n')}`;
        answer = await askClaude<RewriteAnswer>({ system: SYSTEM, prompt: retry, schema: SCHEMA });
        problems = validate(source, words, answer);
      }
    } finally {
      clearInterval(tick);
    }
    if (problems.length) {
      // A wrong cue can be dropped safely; anything else means the script cannot be trusted.
      answer = dropBadAnchors(source, words, answer);
      problems = validate(source, words, answer);
      if (problems.length) throw new UserError(`Claude's rewrite broke the rules twice. ${problems[0]}`, 'Try again. A fresh attempt usually works.');
    }

    const title = ctx.job.title ?? (answer.title.trim() || ctx.job.sourceName);
    ctx.job.title = title;
    const script = buildScript(source, words, answer, title);
    await writeJson(ctx.work('script.json'), script);

    const kept = script.lines.filter(l => l.keep);
    const cues = kept.reduce((n, l) => n + activeAnchors(l).length, 0);
    ctx.job.review = { lines: script.lines.length, dropped: script.lines.length - kept.length, cues };
    ctx.detail(`Cleaned ${script.lines.length} lines, dropped ${script.lines.length - kept.length} and marked ${cues} cues.`);
  },
};
