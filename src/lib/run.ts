import { spawn } from 'node:child_process';

export interface RunOptions {
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  stdin?: string;
  cwd?: string;
  /** Kills the command after this many milliseconds. */
  timeoutMs?: number;
}

/** Runs a command and collects its output. Rejects with the tail of stderr on a non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd });
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeoutMs) : null;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; opts.onStdout?.(d); });
    child.stderr.on('data', (d: string) => { stderr += d; opts.onStderr?.(d); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'ENOENT' ? new Error(`${cmd} is not installed or not on PATH.`) : err);
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (timedOut) reject(new Error(`${cmd} did not finish within ${Math.round((opts.timeoutMs ?? 0) / 1000)} s.`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
    });
    child.stdin.end(opts.stdin ?? '');
  });
}

/**
 * Runs `fn` on every item, at most `limit` at a time. After a failure no new item starts, and it throws
 * once the running ones end, so nothing keeps writing after the step has failed.
 */
export async function inParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) await fn(items[next++]).catch(err => { failed = true; throw err; });
  };
  const ends = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  const failure = ends.find((e): e is PromiseRejectedResult => e.status === 'rejected');
  if (failure) throw failure.reason;
}
