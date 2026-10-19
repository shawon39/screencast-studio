import { tmpdir } from 'node:os';
import { UserError } from './errors.ts';
import { run } from './run.ts';

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
}

const NOT_SIGNED_IN = new UserError('Claude Code is not signed in on this Mac.', 'Run claude in a terminal, sign in with your Max plan, then try again.');

/**
 * Asks Claude Code (print mode, on the signed-in plan) for one JSON answer that matches `schema`.
 * No tools, no MCP servers, no saved session; it runs from the temp folder so no project CLAUDE.md loads.
 */
export async function askClaude<T>(opts: { system: string; prompt: string; schema: object; timeoutMs?: number }): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const args = [
    '-p', '--output-format', 'json', '--json-schema', JSON.stringify(opts.schema),
    '--system-prompt', opts.system,
    '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
  ];
  let stdout: string;
  try {
    ({ stdout } = await run('claude', args, { stdin: opts.prompt, cwd: tmpdir(), timeoutMs }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not installed/.test(message)) throw new UserError('Claude Code is not installed on this Mac.', 'Install it, sign in once by running claude in a terminal, then try again.');
    if (/did not finish/.test(message)) throw new UserError(`Claude took longer than ${Math.round(timeoutMs / 60_000)} minutes.`, 'Try again. If it keeps happening, the recording may be too long for one pass.');
    if (/log ?in|not authenticated|credential/i.test(message)) throw NOT_SIGNED_IN;
    throw err;
  }
  const res = JSON.parse(stdout) as ClaudeResult;
  if (res.is_error || res.structured_output === undefined) {
    const detail = (res.result ?? '').slice(0, 300);
    if (/log ?in|not authenticated|credential/i.test(detail)) throw NOT_SIGNED_IN;
    if (/usage limit|rate limit/i.test(detail)) throw new UserError('Claude says your plan\'s usage limit is reached.', 'Wait until the limit resets, then try again.');
    throw new Error(`Claude did not return a usable answer: ${detail}`);
  }
  return res.structured_output as T;
}
