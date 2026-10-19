const $ = s => document.querySelector(s);
const PHASES = ['listen', 'rewrite', 'review', 'voice', 'cut', 'finish'];
const VIDEO_TYPES = ['.mp4', '.mkv', '.mov'];
const STATUS_TEXT = {
  running: 'Working',
  paused: 'Waiting for the next build',
  review: 'Waiting for your review',
  done: 'Done',
  failed: 'Needs attention',
  stopped: 'Stopped',
};

/** 408.3 → "6:48" */
const fmt = sec => {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const clock = iso => new Date(iso).toTimeString().slice(0, 8);
const hourMin = iso => new Date(iso).toTimeString().slice(0, 5);
const day = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
/** 75.25 → "01:15.3" */
const tc = sec => {
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, '0')}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message ?? 'The local server did not answer.'), { hint: data.error?.hint });
  return data;
}

let narrator = 'the narrator';
fetch('/api/config').then(r => r.json()).then(c => {
  $('#narrator').textContent = `Narrator: ${c.narrator}`;
  if (!/not set up|not found/.test(c.narrator)) narrator = c.narrator;
}).catch(() => {});

/* ---------- routing ---------- */
let source = null;
function route() {
  source?.close();
  source = null;
  stopTakes();
  const m = location.hash.match(/^#\/job\/([a-z0-9-]+)$/);
  const voice = location.hash === '#/voice';
  $('#home').hidden = Boolean(m) || voice;
  $('#job').hidden = !m;
  $('#voice').hidden = !voice;
  if (!m) document.title = voice ? 'Voice test · Screencast Studio' : 'Screencast Studio';
  if (m) openJob(m[1]);
  else if (voice) openVoiceTest();
  else openHome();
  scrollTo(0, 0);
}
addEventListener('hashchange', route);

/* ---------- home ---------- */
let draft = null; // { xhr, job } while a recording is copied in but not started

function openHome() {
  if (!draft) resetDrop();
  loadRecent();
}

async function loadRecent() {
  const jobs = await api('/api/jobs').catch(() => []);
  $('#recent').hidden = jobs.length === 0;
  $('#recentRows').replaceChildren(...jobs.map(job => {
    const tr = document.createElement('tr');
    const cells = [
      ['', ''],
      ['made', day(job.createdAt)],
      ['', job.media ? fmt(job.media.durationSec) : ''],
      ['', job.result ? fmt(job.result.finalSec) : ''],
      [job.status === 'review' ? 'waiting' : job.status === 'failed' ? 'failed' : '', STATUS_TEXT[job.status] ?? ''],
    ].map(([cls, text]) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = text;
      return td;
    });
    const a = document.createElement('a');
    a.href = `#/job/${job.id}`;
    a.textContent = job.title ?? job.sourceName;
    cells[0].append(a);
    tr.append(...cells);
    return tr;
  }));
}

/** Ruler length in seconds: at least 10 minutes, one label per 1, 5 or 10 minutes. */
function drawRuler(durationSec) {
  const minutes = Math.max(10, Math.ceil(durationSec / 60));
  const step = minutes <= 12 ? 1 : minutes <= 30 ? 5 : 10;
  const tl = $('#tl');
  tl.style.setProperty('--major', `${step / minutes * 100}%`);
  tl.style.setProperty('--minor', `${100 / (minutes * 6)}%`);
  const labels = [];
  for (let m = 0; m < minutes; m += step) {
    const span = document.createElement('span');
    span.style.left = `${m / minutes * 100}%`;
    span.textContent = `${m}:00`;
    labels.push(span);
  }
  $('#tlRuler').replaceChildren(...labels);
  return minutes * 60;
}

function wavePath(peaks) {
  const n = peaks.length;
  let d = '';
  peaks.forEach((p, i) => {
    const h = Math.max(0.6, Math.sqrt(p) * 20);
    const x = (i + 0.5) / n * 400;
    d += `M${x.toFixed(2)} ${(22 - h).toFixed(2)}V${(22 + h).toFixed(2)}`;
  });
  return `<svg viewBox="0 0 400 44" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" stroke="#2443C4" stroke-opacity=".55" stroke-width="${Math.max(0.5, 320 / n)}" fill="none"/></svg>`;
}

/** Puts the clip on the timeline at its real length. */
function placeClip(name, durationSec, label) {
  $('#tlCall').hidden = true;
  const span = drawRuler(durationSec ?? 600);
  const width = `${Math.min(100, (durationSec ?? 60) / span * 100)}%`;
  let v = $('#laneV .clip');
  if (!v) {
    $('#laneV').innerHTML = '<div class="clip v"><span class="clip-name"></span><span class="clip-len"></span></div>';
    $('#laneA').innerHTML = '<div class="clip a"></div>';
    v = $('#laneV .clip');
    requestAnimationFrame(() => requestAnimationFrame(() => setClipWidth(width)));
  } else {
    setClipWidth(width);
  }
  v.querySelector('.clip-name').textContent = name;
  v.querySelector('.clip-len').textContent = label;
}
const setClipWidth = w => document.querySelectorAll('.clip').forEach(c => { c.style.width = w; });
const setClipLabel = text => { const el = $('#laneV .clip-len'); if (el) el.textContent = text; };

function resetDrop() {
  draft = null;
  $('#tlCall').hidden = false;
  $('#laneV').replaceChildren();
  $('#laneA').replaceChildren();
  $('#startForm').hidden = true;
  $('#title').value = '';
  $('#subtitles').checked = false;
  $('#picker').value = '';
  drawRuler(600);
}

function showDropError(message, hint) {
  const el = $('#dropError');
  el.textContent = hint ? `${message} ${hint}` : message;
  el.hidden = false;
}

/** The browser can often read the length before the copy finishes. */
function readDuration(file) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = value => { URL.revokeObjectURL(url); resolve(value); };
    video.preload = 'metadata';
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => done(null);
    setTimeout(() => done(null), 2500);
    video.src = url;
  });
}

function factsFor(job) {
  const m = job.media;
  const v = m.video;
  const rate = v.constantFps ? `${Math.round(v.fps * 100) / 100} fps` : 'a variable frame rate';
  let text = `${job.sourceName} is ${fmt(m.durationSec)} long, ${v.width} × ${v.height} at ${rate}.`;
  // The same size as frameSize in src/steps/01-probe.ts: 1920 wide, in the recording's own shape.
  const height = Math.round(1920 * v.height / v.width / 4) * 4;
  if (!(v.width === 1920 && v.height === height && v.constantFps && Math.abs(v.fps - 30) < 0.01)) text += ` It will be converted to 1920 × ${height} at 30 fps, keeping its shape.`;
  if (m.audio.length > 1) text += ` It has ${m.audio.length} audio tracks; the first one is used.`;
  return text;
}

async function takeFile(file) {
  if (!file || draft) return;
  $('#dropError').hidden = true;
  const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
  if (!VIDEO_TYPES.includes(ext)) return showDropError('Only .mp4, .mkv and .mov recordings work.', 'Save the recording in one of those formats and drop it again.');

  const xhr = new XMLHttpRequest();
  draft = { xhr, job: null };
  placeClip(file.name, await readDuration(file), 'Copying 0%');
  $('#startForm').hidden = false;
  $('#startBtn').disabled = true;
  $('#facts').textContent = `Copying ${file.name} into the studio.`;

  xhr.open('POST', `/api/jobs?name=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = e => { if (e.lengthComputable) setClipLabel(`Copying ${Math.floor(e.loaded / e.total * 100)}%`); };
  xhr.onload = () => {
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* handled below */ }
    if (xhr.status >= 300 || !data.id) {
      resetDrop();
      showDropError(data.error?.message ?? 'The copy failed.', data.error?.hint);
      return;
    }
    draft.job = data;
    placeClip(data.sourceName, data.media.durationSec, fmt(data.media.durationSec));
    if (data.waveform?.length) $('#laneA .clip').innerHTML = wavePath(data.waveform);
    $('#facts').textContent = factsFor(data);
    $('#startBtn').disabled = false;
  };
  xhr.onerror = () => {
    resetDrop();
    showDropError('The copy stopped.', 'Check that npm start is still running, then drop the file again.');
  };
  xhr.send(file);
}

const tl = $('#tl');
$('#pick').addEventListener('click', () => $('#picker').click());
$('#picker').addEventListener('change', e => takeFile(e.target.files[0]));
for (const ev of ['dragenter', 'dragover']) tl.addEventListener(ev, e => { e.preventDefault(); if (!draft) tl.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) tl.addEventListener(ev, e => { e.preventDefault(); tl.classList.remove('over'); });
tl.addEventListener('drop', e => takeFile(e.dataTransfer.files[0]));
// A file dropped beside the timeline should not make the browser open it.
for (const ev of ['dragover', 'drop']) addEventListener(ev, e => e.preventDefault());

$('#swap').addEventListener('click', async () => {
  const current = draft;
  resetDrop();
  current?.xhr.abort();
  if (current?.job) await api(`/api/jobs/${current.job.id}`, { method: 'DELETE' }).catch(() => {});
});

$('#startForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!draft?.job) return;
  $('#startBtn').disabled = true;
  try {
    const job = await api(`/api/jobs/${draft.job.id}/start`, {
      method: 'POST',
      body: { title: $('#title').value, subtitles: $('#subtitles').checked },
    });
    draft = null;
    location.hash = `#/job/${job.id}`;
  } catch (err) {
    $('#startBtn').disabled = false;
    showDropError(err.message, err.hint ?? 'Drop the recording again.');
  }
});

/* ---------- one video ---------- */
let current = null;

function openJob(id) {
  closeReview();
  const final = $('#finalVideo');
  final.removeAttribute('src');
  final.removeAttribute('poster');
  delete final.dataset.job;
  $('#jobTitle').textContent = '';
  $('#jobMeta').textContent = '';
  source = new EventSource(`/api/jobs/${id}/events`);
  source.onmessage = e => renderJob(JSON.parse(e.data));
  source.onerror = () => {
    if (source?.readyState === EventSource.CLOSED) $('#nowSub').textContent = 'Lost contact with the app. Check that npm start is still running, then reload.';
  };
}

function took(times) {
  if (!times?.end) return '';
  return fmt((new Date(times.end) - new Date(times.start)) / 1000);
}

function renderLog(list, entries) {
  list.replaceChildren(...entries.map(entry => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = clock(entry.at);
    const text = document.createElement('span');
    text.textContent = entry.text;
    li.append(time, text);
    return li;
  }));
}

function renderJob(job) {
  current = job;
  const started = job.phaseTimes.listen?.start;
  const length = job.media ? fmt(job.media.durationSec) : '';
  $('#jobTitle').textContent = job.title ?? job.sourceName;
  $('#jobMeta').textContent = [
    job.title ? `From ${job.sourceName}, ${length} raw` : `${length} raw recording`,
    started ? `started at ${hourMin(started)}` : '',
  ].filter(Boolean).join(', ');
  document.title = `${job.title ?? job.sourceName} · Screencast Studio`;

  const at = PHASES.indexOf(job.phase);
  $('#ruler').style.setProperty('--p', job.status === 'done' ? 1 : job.progress);
  document.querySelectorAll('#phases li').forEach((li, i) => {
    let state = 'wait';
    let text = '';
    if (job.status === 'done' || i < at) {
      state = 'done';
      text = took(job.phaseTimes[PHASES[i]]);
    } else if (i === at) {
      [state, text] = {
        running: ['now', 'Working'],
        failed: ['fail', 'Stopped'],
        stopped: ['fail', 'Stopped'],
        review: ['you', 'Your turn'],
        paused: ['wait', 'Next build'],
      }[job.status] ?? ['wait', ''];
    }
    li.className = state;
    li.querySelector('.pt').textContent = text;
  });

  const failed = job.status === 'failed';
  const reviewing = job.status === 'review';
  const done = job.status === 'done';
  $('#paneWork').hidden = failed || reviewing || done;
  $('#paneError').hidden = !failed;
  $('#paneReview').hidden = !reviewing;
  $('#paneDone').hidden = !done;
  if (reviewing) {
    openReview(job);
    return;
  }
  closeReview();
  if (done) {
    renderDone(job);
    return;
  }
  if (failed) {
    $('#errMessage').textContent = job.error?.message ?? 'Something stopped the work.';
    $('#errHint').textContent = job.error?.hint ?? '';
    renderLog($('#fullLog'), job.log);
    return;
  }
  $('#nowMain').textContent = job.now?.main ?? '';
  $('#nowSub').textContent = job.now?.sub ?? '';
  renderLog($('#log'), job.log.slice(-5));
  $('#closeNote').hidden = job.status !== 'running';
  $('#continueBtn').hidden = job.status !== 'stopped' && job.status !== 'paused';
}

/* ---------- done ---------- */
let pictures = { key: '', cuts: [], videoCuts: [], problems: [] }; // the cut pictures of the video on the Done screen

async function loadPictures(job, key) {
  pictures = { key, cuts: [], videoCuts: [], problems: [] };
  try {
    const data = await api(`/api/jobs/${job.id}/cuts`);
    if (pictures.key !== key) return;
    pictures = { key, ...data };
    if (current?.id === job.id && current.status === 'done') renderDone(current);
  } catch {
    // The Done screen works without them.
  }
}

/** A thumbnail that opens the full picture. `p.file` is relative to output/, as the server serves it. */
function shot(job, version, p, label, alt) {
  const url = `/api/jobs/${job.id}/${p.file}?v=${encodeURIComponent(version)}`;
  const a = document.createElement('a');
  a.className = 'shot';
  a.href = url;
  a.target = '_blank';
  const img = document.createElement('img');
  img.src = url;
  img.alt = alt;
  const span = document.createElement('span');
  span.textContent = label;
  a.append(img, span);
  return a;
}

function renderDone(job) {
  const r = job.result;
  const video = $('#finalVideo');
  const version = job.phaseTimes.finish?.end ?? '';
  if (video.dataset.job !== `${job.id}@${version}`) {
    video.dataset.job = `${job.id}@${version}`;
    video.src = `/api/jobs/${job.id}/final?v=${encodeURIComponent(version)}`;
    video.poster = `/api/jobs/${job.id}/download/thumbnail.png?v=${encodeURIComponent(version)}`;
    loadPictures(job, video.dataset.job);
  }
  for (const [id, file] of [['#dlVideo', 'final.mp4'], ['#dlSrt', 'final.srt'], ['#dlThumb', 'thumbnail.png'], ['#dlReport', 'report.md']]) {
    $(id).href = `/api/jobs/${job.id}/download/${file}`;
  }
  if (!r) return;
  const verdict = $('#verdict');
  verdict.replaceChildren();
  const b = document.createElement('b');
  b.textContent = fmt(r.finalSec);
  const cues = !r.cues ? '' : r.cuesInSync === r.cues
    ? ` All ${r.cues} cues land within 150 ms of their action.`
    : ` ${r.cuesInSync} of ${r.cues} cues land within 150 ms; the report says which.`;
  verdict.append('The video is ', b, ` long, cut from ${fmt(r.rawSec)}.${cues} Loudness is ${r.lufs} LUFS with peaks at ${r.truePeak} dBTP. It used ${r.characters.toLocaleString('en')} voice characters.`);
  $('#problems').hidden = !r.problems.length;
  $('#problems').replaceChildren(...r.problems.map((text, i) => {
    const li = document.createElement('li');
    li.textContent = text;
    const p = pictures.problems[i];
    if (p) li.append(shot(job, version, p, `At ${tc(p.at)} in the video`, `Picture of the problem at ${tc(p.at)}`));
    return li;
  }));
  $('#cutsBox').hidden = !pictures.cuts.length;
  $('#cutShots').replaceChildren(...pictures.cuts.map(p => {
    const li = document.createElement('li');
    li.append(shot(job, version, p, tc(p.at), `Picture of the voice cut at ${tc(p.at)}`));
    return li;
  }));
  $('#videoCutsBox').hidden = !pictures.videoCuts.length;
  $('#videoCutShots').replaceChildren(...pictures.videoCuts.map(p => {
    const li = document.createElement('li');
    li.append(shot(job, version, p, tc(p.at), `Picture of the video cut at ${tc(p.at)}`));
    return li;
  }));
  $('#changes').replaceChildren(...r.changes.map(c => Object.assign(document.createElement('li'), { textContent: c })));
}

$('#revealBtn').addEventListener('click', () => { if (current) api(`/api/jobs/${current.id}/reveal`, { method: 'POST' }).catch(() => {}); });
$('#reopenBtn').addEventListener('click', async () => {
  if (!current) return;
  $('#finalVideo').pause();
  try {
    await api(`/api/jobs/${current.id}/reopen`, { method: 'POST' });
    scrollTo(0, 0);
  } catch (err) {
    alert(`${err.message} ${err.hint ?? ''}`);
  }
});

/* ---------- review ---------- */
let review = null; // { jobId, script, dirty: Set of line ids, timer, saving }

const norm = w => w.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
const sameWord = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
const words = text => text.split(/\s+/).filter(Boolean);

/** Cues still in the clean text, matched in order (the same rule the server uses). Map: word index → cue. */
function cueHits(line) {
  const n = words(line.clean).map(norm);
  const hits = new Map();
  let from = 0;
  for (const anchor of line.anchors) {
    const at = n.findIndex((t, i) => i >= from && sameWord(t, norm(anchor.word)));
    if (at < 0) continue;
    hits.set(at, anchor);
    from = at + 1;
  }
  return hits;
}

/** Which said words the clean line no longer has: a longest-common-subsequence match on normalized words. */
function struck(said, clean) {
  const a = said.map(w => (w.startsWith('[') ? '' : norm(w)));
  const b = words(clean).map(norm).filter(Boolean);
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const kept = new Array(a.length).fill(false);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] && a[i] === b[j]) { kept[i] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return kept.map(k => !k);
}

function joinNodes(parts) {
  const out = [];
  parts.forEach((node, i) => { if (i) out.push(document.createTextNode(' ')); out.push(node); });
  return out;
}

function cleanNodes(line) {
  const hits = cueHits(line);
  return joinNodes(words(line.clean).map((word, i) => {
    const anchor = hits.get(i);
    if (!anchor) return document.createTextNode(word);
    // Underline the word only; punctuation stays outside the mark.
    const [, lead, core, trail] = word.match(/^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/);
    const span = document.createElement('span');
    span.className = 'cue';
    span.title = `The video waits here: you said it at ${tc(anchor.at)}`;
    span.textContent = core;
    const group = document.createDocumentFragment();
    group.append(lead, span, trail);
    return group;
  }));
}

function saidNodes(line) {
  const marks = line.keep ? struck(line.said, line.clean) : line.said.map(() => true);
  return joinNodes(line.said.map((word, i) => {
    if (!marks[i]) return document.createTextNode(word);
    const s = document.createElement('s');
    s.textContent = word;
    return s;
  }));
}

function lineWarning(line) {
  if (!line.keep) return null;
  const count = words(line.clean).map(norm).filter(Boolean).length;
  if (count === 0) return ['bad', 'This line is kept but empty. Write the line, or drop it.'];
  const lost = line.anchors.filter(a => ![...cueHits(line).values()].includes(a));
  if (lost.length) return ['bad', `The video will no longer wait for "${lost.map(a => a.word).join('", "')}". Put the word back to keep it in sync.`];
  const most = Math.floor(line.saidCount * 1.15) + 1;
  const least = Math.max(1, Math.ceil(line.saidCount * 0.85) - 1);
  if (count > most) return ['', `${count - line.saidCount} words longer than you said it. The video will slow down here to fit.`];
  if (count < least) return ['', `${line.saidCount - count} words shorter than you said it. The video will speed up here to fit.`];
  return null;
}

function paintLine(li, line, withCues) {
  li.classList.toggle('dropped', !line.keep);
  li.querySelector('.toggle').textContent = line.keep ? 'Drop' : 'Keep';
  if (withCues) li.querySelector('.clean').replaceChildren(...cleanNodes(line));
  li.querySelector('.said').replaceChildren(...saidNodes(line));
  const warning = lineWarning(line);
  const warn = li.querySelector('.warn');
  warn.hidden = !warning;
  if (warning) {
    warn.className = `warn ${warning[0]}`;
    warn.textContent = warning[1];
  }
}

function lineElement(line) {
  const li = document.createElement('li');
  li.className = 'line';
  li.dataset.id = line.id;
  li.innerHTML = '<button class="tc" type="button"></button><div class="body"><p class="clean" contenteditable="true" spellcheck="true"></p><p class="said"></p><p class="note drop-note"></p><p class="warn" hidden></p></div><button class="toggle" type="button"></button>';
  li.querySelector('.tc').textContent = tc(line.start);
  li.querySelector('.tc').setAttribute('aria-label', `Play from ${tc(line.start)}`);
  li.querySelector('.drop-note').textContent = line.reason ? `Dropped: ${line.reason}` : 'Dropped by you. Its video stays only if the screen moves.';
  paintLine(li, line, true);
  return li;
}

function updateFacts() {
  const lines = review.script.lines;
  const kept = lines.filter(l => l.keep);
  $('#factLines').textContent = lines.length;
  $('#factDropped').textContent = lines.length - kept.length;
  $('#factCues').textContent = kept.reduce((n, l) => n + cueHits(l).size, 0);
}

async function openReview(job) {
  if (review?.jobId === job.id) return;
  review = { jobId: job.id, script: null, dirty: new Set(), timer: null, saving: Promise.resolve() };
  $('#lines').replaceChildren();
  $('#savedNote').textContent = '';
  $('#approveBtn').disabled = false;
  $('#factLength').textContent = job.media ? fmt(job.media.durationSec) : '';
  $('#nextNote').textContent = `Next, ${narrator} reads the kept lines and the video is cut to match.`;
  $('#rawVideo').src = `/api/jobs/${job.id}/master`;
  try {
    const script = await api(`/api/jobs/${job.id}/script`);
    if (review?.jobId !== job.id) return;
    review.script = script;
    $('#lines').replaceChildren(...script.lines.map(lineElement));
    updateFacts();
  } catch (err) {
    $('#savedNote').textContent = `${err.message} Reload the page to try again.`;
  }
}

function closeReview() {
  if (!review) return;
  clearTimeout(review.timer);
  review = null;
  const video = $('#rawVideo');
  video.pause();
  video.removeAttribute('src');
  video.load();
}

const lineOf = li => review.script.lines.find(l => l.id === Number(li.dataset.id));

function queueSave(id) {
  review.dirty.add(id);
  $('#savedNote').textContent = 'Saving…';
  clearTimeout(review.timer);
  review.timer = setTimeout(flushEdits, 700);
}

/** Sends pending edits; saves run one after another so an older edit never lands last. */
function flushEdits() {
  if (!review) return Promise.resolve();
  clearTimeout(review.timer);
  const state = review;
  if (!state.dirty.size) return state.saving;
  const ids = [...state.dirty];
  state.dirty.clear();
  const lines = ids.map(id => {
    const line = state.script.lines.find(l => l.id === id);
    return { id, keep: line.keep, clean: line.clean };
  });
  state.saving = state.saving
    .then(() => api(`/api/jobs/${state.jobId}/script`, { method: 'PUT', body: { lines } }))
    .then(() => { if (review === state && !state.dirty.size) $('#savedNote').textContent = 'All changes saved.'; })
    .catch(err => {
      ids.forEach(id => state.dirty.add(id));
      if (review === state) $('#savedNote').textContent = `Not saved: ${err.message}`;
      throw err;
    });
  return state.saving;
}

$('#lines').addEventListener('click', e => {
  const li = e.target.closest('.line');
  if (!li || !review?.script) return;
  const line = lineOf(li);
  if (e.target.closest('.tc')) {
    const video = $('#rawVideo');
    video.currentTime = line.start;
    video.play().catch(() => {});
  }
  if (e.target.closest('.toggle')) {
    line.keep = !line.keep;
    paintLine(li, line, true);
    updateFacts();
    queueSave(line.id);
  }
});
$('#lines').addEventListener('input', e => {
  const el = e.target.closest('.clean');
  if (!el || !review?.script) return;
  const li = el.closest('.line');
  const line = lineOf(li);
  line.clean = el.textContent.replace(/\s+/g, ' ').trim();
  paintLine(li, line, false);
  updateFacts();
  queueSave(line.id);
});
// Cue marks are redrawn when you leave a line, so the cursor never jumps while typing.
$('#lines').addEventListener('focusout', e => {
  const el = e.target.closest?.('.clean');
  if (el && review?.script) paintLine(el.closest('.line'), lineOf(el.closest('.line')), true);
});
$('#lines').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.closest('.clean')) {
    e.preventDefault();
    e.target.blur();
  }
});
$('#lines').addEventListener('paste', e => {
  if (!e.target.closest('.clean')) return;
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s+/g, ' '));
});

$('#rawVideo').addEventListener('timeupdate', () => {
  if (!review?.script) return;
  const t = $('#rawVideo').currentTime;
  $('#stamp').textContent = tc(t);
  document.querySelectorAll('#lines .line').forEach(li => {
    const line = lineOf(li);
    li.classList.toggle('playing', t >= line.start && t <= line.end + 0.3);
  });
});

$('#approveBtn').addEventListener('click', async () => {
  if (!review) return;
  const btn = $('#approveBtn');
  btn.disabled = true;
  try {
    await flushEdits();
    await api(`/api/jobs/${review.jobId}/approve`, { method: 'POST' });
  } catch (err) {
    btn.disabled = false;
    $('#savedNote').textContent = `${err.message} ${err.hint ?? ''}`;
  }
});

async function resume() {
  if (!current) return;
  try {
    await api(`/api/jobs/${current.id}/continue`, { method: 'POST' });
  } catch (err) {
    $('#errHint').textContent = `${err.message} ${err.hint ?? ''}`;
  }
}
$('#retryBtn').addEventListener('click', resume);
$('#continueBtn').addEventListener('click', resume);
$('#logBtn').addEventListener('click', () => {
  const list = $('#fullLog');
  list.hidden = !list.hidden;
  $('#logBtn').setAttribute('aria-expanded', String(!list.hidden));
  $('#logBtn').textContent = list.hidden ? 'Show the log' : 'Hide the log';
});

/* ---------- voice test ---------- */
const PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1v10l8.5-5z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1h3v10H2zM7 1h3v10H7z" fill="currentColor"/></svg>';
let voiceTest = null; // the last answer from /api/voice-test
const takeAudio = new Map(); // take id → Audio

function stopTakes() {
  for (const audio of takeAudio.values()) {
    audio.pause();
    audio.removeAttribute('src');
  }
  takeAudio.clear();
}

async function openVoiceTest() {
  $('#vtError').hidden = true;
  $('#vtSaved').textContent = '';
  try {
    renderVoiceTest(await api('/api/voice-test'));
  } catch (err) {
    showVoiceError(err);
  }
}

function showVoiceError(err) {
  $('#vtError').textContent = `${err.message} ${err.hint ?? ''}`;
  $('#vtError').hidden = false;
}

function renderVoiceTest(data) {
  stopTakes();
  voiceTest = data;
  $('#vtText').textContent = data.text;
  $('#vtMeta').textContent = `${data.source}. Every take plays equally loud, so none sounds better just by being louder.`;
  const missing = data.takes.filter(t => !t.ready);
  $('#vtBar').hidden = missing.length === 0;
  $('#vtRecord').disabled = false;
  $('#vtRecord').textContent = missing.length === 1 ? 'Record the missing take' : `Record the ${missing.length} clone takes`;
  $('#vtCost').textContent = `Each take costs at most ${data.text.length} credits, once. Recorded takes are kept, so playing them is free.`;
  // Play every take at the level of the quietest one.
  const quietest = Math.min(...data.takes.filter(t => t.ready && Number.isFinite(t.lufs)).map(t => t.lufs));
  $('#takes').replaceChildren(...data.takes.map((t, i) => takeRow(t, i, quietest)));
}

function takeRow(take, i, quietest) {
  const li = document.createElement('li');
  li.className = 'take';
  li.dataset.id = take.id;
  li.innerHTML = `<span class="take-no">Take ${i + 1}</span>
    <div><p class="take-name"></p><p class="take-detail"></p></div>
    <div class="player">
      <button class="play" type="button" aria-label="Play">${PLAY}</button>
      <div class="take-track"><div class="take-fill"></div><div class="take-head"></div></div>
      <span class="take-time"></span>
    </div>
    <div class="take-act"></div>`;
  li.querySelector('.take-name').textContent = take.label;
  li.querySelector('.take-detail').textContent = take.detail;
  const act = li.querySelector('.take-act');
  const btn = li.querySelector('.play');
  const track = li.querySelector('.take-track');
  const time = li.querySelector('.take-time');

  if (take.id === 'real') act.textContent = 'The reference';
  else if (!take.ready) act.textContent = 'Not recorded yet';
  else if (take.chosen) act.innerHTML = '<span class="in-use">In use</span>';
  else {
    const use = document.createElement('button');
    use.className = 'btn ghost';
    use.type = 'button';
    use.textContent = 'Use this voice';
    use.addEventListener('click', () => chooseTake(take, use));
    act.append(use);
  }
  if (!take.ready) {
    btn.disabled = true;
    track.classList.add('off');
    return li;
  }

  const audio = new Audio(`/api/voice-test/${take.id}/audio?at=${Date.now()}`);
  audio.preload = 'metadata';
  if (Number.isFinite(take.lufs) && Number.isFinite(quietest)) audio.volume = Math.min(1, 10 ** ((quietest - take.lufs) / 20));
  takeAudio.set(take.id, audio);
  const paint = () => {
    track.style.setProperty('--p', audio.duration ? audio.currentTime / audio.duration : 0);
    time.textContent = fmt(audio.paused && !audio.currentTime ? audio.duration || 0 : audio.currentTime);
    if (!audio.paused) requestAnimationFrame(paint);
  };
  audio.addEventListener('loadedmetadata', paint);
  audio.addEventListener('play', () => {
    for (const other of takeAudio.values()) if (other !== audio) other.pause();
    li.classList.add('playing', 'started');
    btn.innerHTML = PAUSE;
    btn.setAttribute('aria-label', 'Pause');
    paint();
  });
  audio.addEventListener('pause', () => {
    li.classList.remove('playing');
    btn.innerHTML = PLAY;
    btn.setAttribute('aria-label', 'Play');
  });
  audio.addEventListener('ended', () => {
    audio.currentTime = 0;
    li.classList.remove('started');
    paint();
  });
  btn.addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
  track.addEventListener('click', e => {
    if (!audio.duration) return;
    audio.currentTime = (e.offsetX / track.clientWidth) * audio.duration;
    li.classList.add('started');
    paint();
  });
  return li;
}

$('#vtRecord').addEventListener('click', async () => {
  $('#vtError').hidden = true;
  $('#vtRecord').disabled = true;
  try {
    for (const take of voiceTest.takes.filter(t => !t.ready)) {
      $(`.take[data-id="${take.id}"] .take-act`).textContent = 'Recording…';
      renderVoiceTest(await api(`/api/voice-test/${take.id}/record`, { method: 'POST' }));
      $('#vtRecord').disabled = true;
    }
  } catch (err) {
    await openVoiceTest();
    showVoiceError(err);
  }
  $('#vtRecord').disabled = false;
});

async function chooseTake(take, btn) {
  btn.disabled = true;
  try {
    renderVoiceTest(await api(`/api/voice-test/${take.id}/choose`, { method: 'POST' }));
    $('#vtSaved').textContent = `Saved. New videos, and any you render again, use ${take.label.replace(/^Your clone on /, '')}. It is in config/voice.json.`;
  } catch (err) {
    btn.disabled = false;
    showVoiceError(err);
  }
}

route();
