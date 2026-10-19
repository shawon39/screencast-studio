import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { addLog, createJob, deleteJob, getJob, isJobId, jobDir, jobEvents, listJobs, loadJobs, saveJob } from './jobs.ts';
import type { Job } from './jobs.ts';
import { elevenlabs } from './lib/elevenlabs.ts';
import { requireEnv, ROOT } from './lib/env.ts';
import { UserError } from './lib/errors.ts';
import { probe, waveform } from './lib/ffmpeg.ts';
import { readJson, writeJson } from './lib/files.ts';
import { reportForDownload } from './lib/report.ts';
import { activeAnchors } from './lib/script.ts';
import type { Script } from './lib/script.ts';
import { startJob } from './pipeline.ts';
import { PICTURE_FILE } from './steps/12-pictures.ts';
import type { CutPictures } from './steps/12-pictures.ts';
import { chooseTake, recordTake, takeAudio, voiceTest } from './voicetest.ts';

const PORT = Number(process.env.PORT ?? 4321);
const URL_BASE = `http://localhost:${PORT}`;
const PUBLIC = join(ROOT, 'public');
const VIDEO_TYPES = new Set(['.mp4', '.mkv', '.mov']);
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, status: number, message: string, hint?: string): void {
  send(res, status, { error: { message, hint } });
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return (raw ? JSON.parse(raw) : {}) as T;
}

/** The narrator's name for the header, looked up once. */
let narrator: Promise<string> | null = null;
function narratorName(): Promise<string> {
  narrator ??= (async () => {
    let id: string;
    try {
      id = requireEnv('ELEVENLABS_VOICE_ID');
      requireEnv('ELEVENLABS_API_KEY');
    } catch {
      narrator = null;
      return 'not set up yet';
    }
    try {
      // Stock voices are named like "Eric - Smooth, Trustworthy"; the header shows "Eric".
      return (await elevenlabs().voices.get(id)).name?.split(' - ')[0] ?? 'stock voice';
    } catch {
      narrator = null;
      return 'voice not found';
    }
  })();
  return narrator;
}

async function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const name = (url.searchParams.get('name') ?? 'recording.mp4').slice(0, 200);
  const ext = extname(name).toLowerCase();
  if (!VIDEO_TYPES.has(ext)) return fail(res, 415, 'Only .mp4, .mkv and .mov recordings work.', 'Save the recording in one of those formats and drop it again.');
  const job = await createJob(name, ext);
  const file = join(jobDir(job.id), job.inputFile);
  try {
    await pipeline(req, createWriteStream(file));
    const media = await probe(file);
    if (!media.video || !media.audio.length) throw new Error('no video or no audio');
    job.media = media;
    job.waveform = await waveform(file, 400, media.durationSec);
    await saveJob(job, { now: true });
    send(res, 201, job);
  } catch {
    await deleteJob(job.id);
    if (!res.headersSent && !req.destroyed) fail(res, 422, 'This file could not be read as a recording with sound.', 'Check that it plays in QuickTime with your voice, then drop it again.');
  }
}

function streamEvents(req: IncomingMessage, res: ServerResponse, job: Job): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const push = (j: Job) => { if (j.id === job.id) res.write(`data: ${JSON.stringify(j)}\n\n`); };
  push(job);
  jobEvents.on('change', push);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    jobEvents.off('change', push);
  });
}

/** Streams a video (or audio) file with byte-range support, so the browser can seek in it. */
async function serveVideo(req: IncomingMessage, res: ServerResponse, file: string, type = 'video/mp4'): Promise<void> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return fail(res, 404, 'The video is not ready yet.');
  }
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range) {
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    return void createReadStream(file).pipe(res);
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    return void res.end();
  }
  res.writeHead(206, {
    'content-type': type,
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${size}`,
    'accept-ranges': 'bytes',
  });
  createReadStream(file, { start, end }).pipe(res);
}

/** Applies the reviewer's edits: keep or drop, and the clean text. Cues follow the text (see activeAnchors). */
async function saveScriptEdits(req: IncomingMessage, res: ServerResponse, job: Job): Promise<void> {
  if (job.status !== 'review') return fail(res, 409, 'The script can only be changed while it waits for review.');
  const file = join(jobDir(job.id), 'work', 'script.json');
  const script = await readJson<Script>(file);
  const body = await readBody<{ lines?: { id: number; keep: boolean; clean: string }[] }>(req);
  for (const edit of body.lines ?? []) {
    const line = script.lines.find(l => l.id === edit.id);
    if (!line) return fail(res, 400, `There is no line ${edit.id}.`);
    line.keep = Boolean(edit.keep);
    line.clean = String(edit.clean ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  }
  script.editedAt = new Date().toISOString();
  await writeJson(file, script);
  const kept = script.lines.filter(l => l.keep);
  job.review = { lines: script.lines.length, dropped: script.lines.length - kept.length, cues: kept.reduce((n, l) => n + activeAnchors(l).length, 0) };
  await saveJob(job);
  send(res, 200, script);
}

async function approveScript(res: ServerResponse, job: Job): Promise<void> {
  if (job.status !== 'review') return fail(res, 409, 'This script is not waiting for review.');
  const file = join(jobDir(job.id), 'work', 'script.json');
  const script = await readJson<Script>(file);
  if (!script.lines.some(l => l.keep && l.clean)) return fail(res, 422, 'Every line is dropped, so there is nothing to voice.', 'Keep at least one line, then approve.');
  script.approvedAt = new Date().toISOString();
  await writeJson(file, script);
  startJob(job.id);
  send(res, 200, job);
}

/** Sends the script back for review after the video is done. Approving again re-runs only what changed. */
async function reopenScript(res: ServerResponse, job: Job): Promise<void> {
  if (job.status !== 'done' && job.status !== 'paused') return fail(res, 409, 'The script can be reopened once the video is done.');
  const file = join(jobDir(job.id), 'work', 'script.json');
  const script = await readJson<Script>(file);
  delete script.approvedAt;
  await writeJson(file, script);
  job.status = 'review';
  job.phase = 'review';
  job.progress = 2.12 / 6;
  job.phaseTimes.review = { start: new Date().toISOString() };
  for (const phase of ['voice', 'cut', 'finish'] as const) delete job.phaseTimes[phase];
  job.now = { main: 'Your turn: review the script', sub: 'Change what you need, then approve. Only the changed lines are voiced again.' };
  addLog(job, 'Script reopened for changes');
  await saveJob(job, { now: true });
  send(res, 200, job);
}

const DOWNLOADS: Record<string, string> = {
  'final.mp4': 'video/mp4',
  'final.srt': 'application/x-subrip',
  'thumbnail.png': 'image/png',
  'report.md': 'text/markdown; charset=utf-8',
};

/** A finished file as a download, named after the video's title. */
async function download(res: ServerResponse, job: Job, file: string): Promise<void> {
  const type = DOWNLOADS[file];
  if (!type) return fail(res, 404, 'Not found.');
  let body: Buffer;
  try {
    body = await readFile(join(jobDir(job.id), 'output', file));
  } catch {
    return fail(res, 404, 'This file is not ready yet.');
  }
  if (file === 'report.md') {
    const keys = await readJson<CutPictures>(join(jobDir(job.id), 'work', 'cut-pictures.json')).then(p => p.keys, () => ({}));
    body = Buffer.from(reportForDownload(body.toString('utf8'), {
      pictureUrl: `${URL_BASE}/api/jobs/${job.id}/cuts`,
      folder: join(jobDir(job.id), 'output', 'cuts'),
      keys,
    }));
  }
  const stem = (job.title ?? job.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'video';
  const name = file === 'final.mp4' ? `${stem}.mp4` : file === 'final.srt' ? `${stem}.srt` : file === 'thumbnail.png' ? `${stem}-thumbnail.png` : `${stem}-report.md`;
  res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'content-disposition': `attachment; filename="${name}"` });
  res.end(body);
}

/**
 * The pictures of the voice cuts, video cuts and problems (see 12-pictures.ts): the list without a name, one PNG with one.
 * A link from a downloaded report carries the picture's key (?k=), so it opens only the render the report describes.
 */
async function cutPictures(res: ServerResponse, job: Job, name: string, key: string | null): Promise<void> {
  const list = join(jobDir(job.id), 'work', 'cut-pictures.json');
  if (!name) {
    try {
      // A list drawn before video cuts had pictures has none.
      const { cuts, videoCuts = [], problems } = await readJson<CutPictures>(list);
      return send(res, 200, { cuts, videoCuts, problems });
    } catch {
      return send(res, 200, { cuts: [], videoCuts: [], problems: [] });
    }
  }
  if (!PICTURE_FILE.test(name)) return fail(res, 404, 'Not found.');
  if (key !== null) {
    const keys = await readJson<CutPictures>(list).then(p => p.keys, () => ({} as CutPictures['keys']));
    if (!key || !keys[`cuts/${name}`]?.startsWith(key)) {
      return fail(res, 410, 'This picture is from an earlier render of the video.', 'Download the report again from the Done screen to see the pictures of this render.');
    }
  }
  let body: Buffer;
  try {
    body = await readFile(join(jobDir(job.id), 'output', 'cuts', name));
  } catch {
    return fail(res, 404, 'This picture is not drawn yet.', 'Render the video again to draw it.');
  }
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length });
  res.end(body);
}

/** The Voice test page: hear the paragraph in your voice and in each clone take, then pick one. */
async function voiceTestRoute(req: IncomingMessage, res: ServerResponse, method: string, path: string): Promise<void> {
  try {
    if (method === 'GET' && path === '/api/voice-test') return send(res, 200, await voiceTest());
    const m = path.match(/^\/api\/voice-test\/([a-z0-9-]+)\/(audio|record|choose)$/);
    if (method === 'GET' && m?.[2] === 'audio') {
      const file = await takeAudio(m[1]);
      return file ? serveVideo(req, res, file, 'audio/mpeg') : fail(res, 404, 'This take is not recorded yet.');
    }
    if (method === 'POST' && m?.[2] === 'record') return send(res, 200, await recordTake(m[1]));
    if (method === 'POST' && m?.[2] === 'choose') return send(res, 200, await chooseTake(m[1]));
    fail(res, 404, 'Not found.');
  } catch (err) {
    if (err instanceof UserError) return fail(res, 422, err.message, err.hint);
    throw err;
  }
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[a-z0-9-]+\.(html|css|js|svg)$/.test(file)) return fail(res, 404, 'Not found.');
  try {
    const body = await readFile(join(PUBLIC, file));
    res.writeHead(200, { 'content-type': STATIC_TYPES[extname(file)], 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    fail(res, 404, 'Not found.');
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', URL_BASE);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && !path.startsWith('/api/')) return serveStatic(res, path);
  if (method === 'GET' && path === '/api/config') return send(res, 200, { narrator: await narratorName() });
  if (method === 'GET' && path === '/api/jobs') return send(res, 200, listJobs().filter(j => j.status !== 'draft'));
  if (method === 'POST' && path === '/api/jobs') return handleUpload(req, res, url);
  if (path.startsWith('/api/voice-test')) return voiceTestRoute(req, res, method, path);

  const m = path.match(/^\/api\/jobs\/([^/]+)(?:\/([a-z]+)(?:\/([a-z0-9.-]+))?)?$/);
  const job = m && isJobId(m[1]) ? getJob(m[1]) : undefined;
  if (!m || !job) return fail(res, 404, 'There is no such video.');
  const action = m[2] ?? '';
  const file = m[3] ?? '';

  if (method === 'GET' && action === '') return send(res, 200, job);
  if (method === 'GET' && action === 'events') return streamEvents(req, res, job);
  if (method === 'GET' && action === 'master') return serveVideo(req, res, join(jobDir(job.id), 'work', 'master.mp4'));
  if (method === 'GET' && action === 'final') return serveVideo(req, res, join(jobDir(job.id), 'output', 'final.mp4'));
  if (method === 'GET' && action === 'download') return download(res, job, file);
  if (method === 'GET' && action === 'cuts') return cutPictures(res, job, file, url.searchParams.get('k'));
  if (method === 'POST' && action === 'reopen') return reopenScript(res, job);
  if (method === 'POST' && action === 'reveal') {
    const target = join(jobDir(job.id), 'output', 'final.mp4');
    if (process.platform === 'darwin') spawn('open', ['-R', target], { stdio: 'ignore', detached: true }).unref();
    else spawn(process.platform === 'win32' ? 'explorer' : 'xdg-open', [join(jobDir(job.id), 'output')], { stdio: 'ignore', detached: true }).unref();
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && action === 'script') {
    try {
      return send(res, 200, await readJson<Script>(join(jobDir(job.id), 'work', 'script.json')));
    } catch {
      return fail(res, 404, 'The script is not written yet.');
    }
  }
  if (method === 'PUT' && action === 'script') return saveScriptEdits(req, res, job);
  if (method === 'POST' && action === 'approve') return approveScript(res, job);
  if (method === 'DELETE' && action === '') {
    if (job.status !== 'draft') return fail(res, 409, 'Only a video that has not started can be removed here.');
    await deleteJob(job.id);
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && action === 'start') {
    if (job.status !== 'draft') return fail(res, 409, 'This video has already started.');
    const body = await readBody<{ title?: string; subtitles?: boolean }>(req);
    job.title = body.title?.trim().slice(0, 120) || null;
    job.options.subtitles = body.subtitles === true;
    // A file, so the Finish step re-runs when the choice changes.
    await writeJson(join(jobDir(job.id), 'work', 'options.json'), job.options);
    startJob(job.id);
    return send(res, 200, job);
  }
  if (method === 'POST' && action === 'continue') {
    if (!['failed', 'stopped', 'paused'].includes(job.status)) return fail(res, 409, 'This video is not waiting to continue.');
    startJob(job.id);
    return send(res, 200, job);
  }
  fail(res, 404, 'Not found.');
}

function openBrowser(url: string): void {
  if (process.argv.includes('--no-open')) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

await loadJobs();
const server = createServer((req, res) => {
  route(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) fail(res, 500, 'Something went wrong on the local server.', 'The terminal running npm start shows the details.');
    else res.end();
  });
});
server.requestTimeout = 0; // uploads of long recordings can take a while
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.log(`Screencast Studio is already running at ${URL_BASE}`);
  openBrowser(URL_BASE);
  process.exit(0);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Screencast Studio is running at ${URL_BASE}  (Ctrl+C to stop)`);
  openBrowser(URL_BASE);
});
