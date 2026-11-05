import { analyze, splitLines } from '/shared/gcode.js';
import { $, api, attempt, fmt, formatDuration, toast } from './util.js';
import { LiveSocket } from './socket.js';
import { loadSettings, readForm, saveSettings, writeForm } from './settings.js';
import { History, Terminal } from './terminal.js';
import { CodeList } from './code-list.js';
import { Preview } from './preview.js';

// ------------------------------------------------------------------ state

let settings = loadSettings();
const state = {
  online: false, // WebSocket to our server is up
  connection: { state: 'disconnected' },
  job: { state: 'empty', id: null },
  progress: { line: 0, totalLines: 0, elapsedMs: 0 },
  machine: null,
};
const program = {
  id: null,
  text: '',
  lines: [],
  analysis: null,
  cumLength: new Float64Array(1), // path length up to (not including) each line, for the ETA
  segStart: new Int32Array(1), // first segment of each line; line i's segments are [segStart[i], segStart[i + 1])
};
let uploading = false;

// ------------------------------------------------------------------ components

const terminal = new Terminal($('terminal'));
terminal.showJobTraffic = settings.showJobTraffic;
const history = new History($('termInput'));
const preview = new Preview({ base: $('baseCanvas'), progress: $('progressCanvas'), overlay: $('overlayCanvas') });
preview.showTravel = settings.showTravel;
const codeList = new CodeList($('codeList'), (index) => {
  $('lineInput').value = index + 1;
  $('lineInput').focus();
});

// ------------------------------------------------------------------ server link

const live = new LiveSocket();
live
  .on('open', () => {
    state.online = true;
    render();
  })
  .on('close', () => {
    state.online = false;
    render();
  })
  .on('hello', (msg) => {
    terminal.clear();
    msg.log.forEach((entry) => terminal.append(entry));
    state.connection = msg.connection;
    state.machine = msg.connection.machine;
    onJob(msg.job);
    render();
  })
  .on('connection', (msg) => {
    state.connection = msg;
    if (msg.state !== 'connected') state.machine = null;
    render();
  })
  .on('job', (msg) => {
    onJob(msg);
    render();
  })
  .on('progress', (msg) => {
    state.progress = msg;
    renderProgress();
  })
  .on('machine', (msg) => {
    state.machine = msg;
    renderMachine();
  })
  .on('log', (entry) => terminal.append(entry));
live.connect();

function onJob(job) {
  const lineChanged = job.line !== state.job.line || job.state !== state.job.state;
  state.job = job;
  state.progress = { line: job.line, totalLines: job.totalLines, elapsedMs: job.elapsedMs };
  if (job.id !== program.id && !uploading) syncProgram(job.id);
  if (lineChanged && document.activeElement !== $('lineInput')) {
    $('lineInput').value = job.state === 'done' ? 1 : Math.min(job.line + 1, Math.max(1, job.totalLines));
  }
}

/** Another tab (or a page reload) loaded a job: fetch it so preview and listing match. */
async function syncProgram(id) {
  if (id === null) return showProgram(null, '');
  try {
    const text = await api('/job/gcode', { method: 'GET' });
    if (state.job.id === id) showProgram(id, text);
  } catch (err) {
    toast(`Could not load the current job: ${err.message}`, { error: true });
  }
}

function showProgram(id, text) {
  program.id = id;
  program.text = id === null ? '' : text;
  program.lines = id === null ? [] : splitLines(text);
  program.analysis = analyze(program.lines);

  const cum = new Float64Array(program.lines.length + 1);
  const s = program.analysis.segments;
  for (let i = 0; i < s.length; i += 6) cum[s[i + 5] + 1] += Math.hypot(s[i + 2] - s[i], s[i + 3] - s[i + 1]);
  for (let i = 1; i < cum.length; i++) cum[i] += cum[i - 1];
  program.cumLength = cum;
  const segStart = new Int32Array(program.lines.length + 1);
  for (let i = 0; i < s.length; i += 6) segStart[s[i + 5] + 1]++;
  for (let i = 1; i < segStart.length; i++) segStart[i] += segStart[i - 1];
  program.segStart = segStart;

  if (!editor.dirty) preview.setProgram(program.analysis);
  codeList.setLines(program.lines);
  $('simSlider').max = program.lines.length;
  if (sim.on) id === null ? setSimulating(false) : setSimLine(sim.line); // re-apply over the new program
  if (editor.open && !editor.dirty) openEditor(); // another tab changed the job: show it
  $('dropHint').classList.toggle('hidden', id !== null);

  const b = program.analysis.bounds;
  if (b) {
    $('boxX').value = round(b.minX);
    $('boxY').value = round(b.minY);
    $('boxW').value = round(b.maxX - b.minX);
    $('boxH').value = round(b.maxY - b.minY);
  }
  renderJob();
  renderProgress();
}

const round = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------ rendering

function setPill(el, text, tone = '', busy = false) {
  el.textContent = text;
  el.className = `pill ${tone}${busy ? ' busy' : ''}`;
}

function render() {
  renderConnection();
  renderMachine();
  renderJob();
  renderProgress();
}

function renderConnection() {
  const c = state.connection;
  const pill = $('connPill');
  if (!state.online) setPill(pill, 'Server offline', 'danger');
  else if (c.state === 'connected') setPill(pill, `Connected · ${c.target.host}:${c.target.port}`, 'ok');
  else if (c.state === 'connecting') setPill(pill, 'Connecting…', 'info', true);
  else if (c.state === 'reconnecting') setPill(pill, 'Reconnecting…', 'warn', true);
  else setPill(pill, 'Disconnected', c.lastError ? 'danger' : '');
  pill.title = c.lastError ?? '';

  const idle = c.state === 'disconnected';
  if (!idle && c.target) {
    // Show what the server is actually connected to (it may have been set from another tab).
    $('host').value = c.target.host;
    $('port').value = c.target.port;
    $('autoReconnect').checked = !!c.autoReconnect;
  }
  $('host').disabled = $('port').disabled = !idle || !state.online;
  const btn = $('connectBtn');
  btn.disabled = !state.online;
  btn.textContent = idle ? 'Connect' : c.state === 'connected' ? 'Disconnect' : 'Cancel';
  btn.className = idle ? 'primary' : 'danger';
  updateEnabled();
}

function renderMachine() {
  const m = state.machine;
  const pill = $('machinePill');
  pill.classList.toggle('hidden', !m?.state); // estimates have no machine state
  $('position').classList.toggle('hidden', !m?.wpos);
  $('position').classList.toggle('estimated', !!m?.estimated);
  $('position').title = m?.estimated ? 'Estimated from the commands sent (no status reports)' : '';
  if (m) {
    if (m.state) {
      const tone = { Idle: 'ok', Run: 'info', Jog: 'info', Hold: 'warn', Door: 'warn', Alarm: 'danger' }[m.state] ?? '';
      setPill(pill, m.state, tone, m.state === 'Run' || m.state === 'Jog');
    }
    if (m.wpos) {
      $('posX').textContent = fmt(m.wpos.x);
      $('posY').textContent = fmt(m.wpos.y);
    }
  }
  if (!sim.on) preview.setMarker(m?.wpos ?? null);
}

function renderJob() {
  const job = state.job;
  const labels = {
    empty: ['No job', ''],
    ready: ['Ready', 'info'],
    running: ['Running', 'ok'],
    paused: ['Paused', 'warn'],
    done: ['Done', 'ok'],
  };
  const [label, tone] = labels[job.state] ?? [job.state, ''];
  setPill($('jobPill'), label, tone, job.state === 'running');

  $('fileName').textContent = job.name ?? 'No file loaded';
  const a = program.analysis;
  if (job.state === 'empty' || !a) {
    $('fileStats').textContent = 'Open or drop a G-code file';
  } else {
    const parts = [`${job.totalLines.toLocaleString()} lines`];
    if (a.bounds) parts.push(`${fmt(a.bounds.maxX - a.bounds.minX, 1)} × ${fmt(a.bounds.maxY - a.bounds.minY, 1)} mm`);
    parts.push(`draw ${fmt(a.drawLength / 1000, 2)} m`, `travel ${fmt(a.travelLength / 1000, 2)} m`);
    $('fileStats').textContent = parts.join(' · ');
  }

  const reason = $('pauseReason');
  reason.classList.toggle('hidden', !(job.state === 'paused' && job.pauseReason));
  reason.classList.toggle('error', job.pauseReason !== 'Paused by user');
  reason.textContent = job.pauseReason ?? '';

  $('autoResume').checked = !!job.autoResume;
  updateEnabled();
}

function renderProgress() {
  const { line, totalLines, elapsedMs } = state.progress;
  const pct = totalLines ? (line / totalLines) * 100 : 0;
  $('progressFill').style.width = `${pct}%`;
  $('progress').classList.toggle('done', state.job.state === 'done');
  $('progressLine').textContent = `${line.toLocaleString()} / ${totalLines.toLocaleString()}`;
  $('progressPct').textContent = `${pct.toFixed(1)}%`;
  $('elapsed').textContent = formatDuration(elapsedMs);

  // ETA from path length plotted so far, which is far steadier than line count.
  const cum = program.cumLength;
  const total = cum[cum.length - 1];
  const done = cum[Math.min(line, cum.length - 1)];
  const fraction = total > 0 ? done / total : 0;
  const showEta = state.job.state === 'running' && fraction > 0.02 && fraction < 1;
  $('etaWrap').classList.toggle('hidden', !showEta);
  if (showEta) $('eta').textContent = formatDuration((elapsedMs * (1 - fraction)) / fraction);

  if (sim.on) return; // the simulation owns the preview and listing
  preview.setProgress(line);
  codeList.setCurrent(line, { follow: settings.followCode && state.job.state === 'running' });
}

function updateEnabled() {
  const online = state.online;
  const connected = online && state.connection.state === 'connected';
  const js = state.job.state;
  const running = js === 'running';
  const canCommand = connected && !running;

  document.querySelectorAll('[data-jog]').forEach((b) => (b.disabled = !canCommand));
  for (const id of ['goZeroBtn', 'penUpBtn', 'penDownBtn', 'setZeroBtn', 'unlockBtn', 'infoBtn', 'frameBtn', 'drawBoxBtn', 'termSend']) {
    $(id).disabled = !canCommand;
  }
  for (const id of ['holdBtn', 'cycleBtn', 'resetBtn', 'statusBtn']) $(id).disabled = !connected;

  $('startBtn').classList.toggle('hidden', running || js === 'paused');
  $('startBtn').disabled = !connected || !(js === 'ready' || js === 'done');
  $('pauseBtn').classList.toggle('hidden', !running);
  $('resumeBtn').classList.toggle('hidden', js !== 'paused');
  $('resumeBtn').disabled = !connected;
  $('stopBtn').disabled = !online || !(running || js === 'paused');
  $('setLineBtn').classList.toggle('hidden', js !== 'paused');
  $('lineInput').disabled = running || js === 'empty';
  $('fileInput').disabled = running || !online;
  $('openBtn').style.opacity = running || !online ? 0.4 : '';

  $('simBtn').disabled = js === 'empty';
  $('editBtn').disabled = running || js === 'empty';
  $('downloadBtn').disabled = js === 'empty';
  $('applyEditBtn').disabled = running || !online;
}

// ------------------------------------------------------------------ actions

const run = (commands) => attempt(() => api('/commands', { json: { commands } }));
const realtime = (command) => attempt(() => api('/realtime', { json: { command } }));

$('connForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.connection.state !== 'disconnected') {
    attempt(() => api('/disconnect'));
    return;
  }
  const host = $('host').value.trim();
  const port = Number($('port').value);
  settings = { ...settings, host, port, autoReconnect: $('autoReconnect').checked };
  saveSettings(settings);
  attempt(async () => {
    const res = await api('/connect', { json: { host, port, autoReconnect: settings.autoReconnect, ...serverOptions() } });
    await syncServerOptions(res.connection); // settings may have changed while connecting
  });
});

/** Connection options that live on the server but are chosen in this browser's settings. */
const serverOptions = () => ({
  statusPollMs: settings.statusPollMs,
  streaming: settings.streaming,
  rxBufferSize: settings.rxBufferSize,
});

async function syncServerOptions(connection = state.connection) {
  if (connection.state === 'disconnected') return; // sent on the next connect instead
  const wanted = serverOptions();
  const changed = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => connection[k] !== v));
  if (Object.keys(changed).length) await api('/connection/options', { method: 'PATCH', json: changed });
}

$('autoReconnect').addEventListener('change', (e) => {
  settings = { ...settings, autoReconnect: e.target.checked };
  saveSettings(settings);
  if (state.connection.state !== 'disconnected') {
    attempt(() => api('/connection/options', { method: 'PATCH', json: { autoReconnect: e.target.checked } }));
  }
});

// ---- file loading

/** Make `text` the server's job. Returns true on success. */
async function uploadProgram(name, text) {
  uploading = true;
  try {
    const res = await api('/job', { text, query: { name } });
    showProgram(res.job.id, text);
    onJob(res.job);
    render();
    $('lineInput').value = 1;
    return true;
  } catch (err) {
    toast(err.message, { error: true });
    return false;
  } finally {
    uploading = false;
  }
}

async function loadFile(file) {
  if (!file) return;
  if (state.job.state === 'running') return toast('Pause or stop the job before loading another file', { error: true });
  if (editor.dirty && !confirm('Discard your unsaved G-code edits?')) return;
  closeEditor();
  await uploadProgram(file.name, await file.text());
}

$('fileInput').addEventListener('change', (e) => {
  loadFile(e.target.files[0]);
  e.target.value = ''; // allow re-opening the same file
});

const jobCard = $('jobCard');
jobCard.addEventListener('dragover', (e) => {
  e.preventDefault();
  jobCard.classList.add('dragover');
});
jobCard.addEventListener('dragleave', (e) => {
  if (!jobCard.contains(e.relatedTarget)) jobCard.classList.remove('dragover');
});
jobCard.addEventListener('drop', (e) => {
  e.preventDefault();
  jobCard.classList.remove('dragover');
  loadFile(e.dataTransfer.files[0]);
});

// ---- job control

const fromLine = () => Math.max(0, (Number($('lineInput').value) || 1) - 1);

$('startBtn').addEventListener('click', () => attempt(() => api('/job/start', { json: { fromLine: fromLine() } })));
$('pauseBtn').addEventListener('click', () => attempt(() => api('/job/pause')));
$('resumeBtn').addEventListener('click', () => attempt(() => api('/job/resume')));
$('stopBtn').addEventListener('click', () => attempt(() => api('/job/stop')));
$('setLineBtn').addEventListener('click', () => attempt(() => api('/job/line', { json: { line: fromLine() } })));
$('autoResume').addEventListener('change', (e) =>
  attempt(() => api('/job/options', { method: 'PATCH', json: { autoResume: e.target.checked } })),
);

// ---- G-code editor

const editor = { open: false, dirty: false, previewTimer: 0 };
const editorEl = $('codeEditor');

function renderEditor() {
  editorEl.classList.toggle('hidden', !editor.open);
  $('codeList').classList.toggle('hidden', editor.open);
  for (const id of ['editBtn', 'downloadBtn']) $(id).classList.toggle('hidden', editor.open);
  for (const id of ['cancelEditBtn', 'applyEditBtn']) $(id).classList.toggle('hidden', !editor.open);
  $('editStatus').classList.toggle('hidden', !editor.dirty);
  $('editStatus').textContent = 'Unsaved changes';
}

/** Open the editor on the current program, with the caret on the "From line" line. */
function openEditor() {
  setSimulating(false); // the editor redraws the preview from its own text
  editor.open = true;
  editor.dirty = false;
  editorEl.value = program.text;
  renderEditor();
  const line = Math.min(fromLine(), Math.max(0, program.lines.length - 1));
  let offset = 0;
  for (let i = 0; i < line; i++) offset += program.lines[i].length + 1;
  // Uploaded text may use \r\n, but a textarea normalises to \n, so this offset is right.
  editorEl.focus({ preventScroll: true });
  editorEl.setSelectionRange(offset, offset);
  editorEl.scrollTop = line * 20 - editorEl.clientHeight / 2;
}

function closeEditor() {
  clearTimeout(editor.previewTimer);
  if (editor.dirty) preview.setProgram(program.analysis);
  editor.open = editor.dirty = false;
  editorEl.value = '';
  renderEditor();
}

editorEl.addEventListener('input', () => {
  if (!editor.dirty) {
    editor.dirty = true;
    renderEditor();
  }
  // Redraw the preview as you type, without reparsing big files on every keystroke.
  clearTimeout(editor.previewTimer);
  editor.previewTimer = setTimeout(() => preview.setProgram(analyze(splitLines(editorEl.value))), 300);
});

async function applyEdits() {
  if (!editor.dirty) return closeEditor();
  if (state.job.state === 'running') return toast('Pause or stop the job before applying edits', { error: true });
  const text = editorEl.value;
  if (!text.trim()) return toast('The G-code is empty', { error: true });
  if (state.job.state === 'paused' && !confirm('Applying edits replaces the paused job, so it will start over. Continue?')) return;
  if (await uploadProgram(state.job.name ?? 'untitled.gcode', text)) {
    closeEditor(); // also redraws the preview from the applied program
    toast('Edits applied');
  }
}

$('editBtn').addEventListener('click', openEditor);
$('applyEditBtn').addEventListener('click', applyEdits);
$('cancelEditBtn').addEventListener('click', () => {
  if (!editor.dirty || confirm('Discard your changes?')) closeEditor();
});
editorEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    applyEdits();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (editor.dirty) e.preventDefault();
});

$('downloadBtn').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([program.text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = state.job.name ?? 'program.gcode';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---- tabs

document.querySelectorAll('.tabs button').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((t) => {
      t.classList.toggle('active', t === tab);
      $(t.dataset.tab).classList.toggle('hidden', t !== tab);
    });
    if (tab.dataset.tab === 'codePane' && !editor.open) requestAnimationFrame(() => codeList.reveal());
  }),
);
$('fitBtn').addEventListener('click', () => preview.fit());
$('originBtn').addEventListener('click', () => preview.fitOrigin());

// ---- simulation: scrub or play through the program in the preview, without touching the job

const SIM_SECONDS = 20; // at 1×, the whole drawing plays in this long
const sim = { on: false, line: 0, playing: false, dist: 0, last: 0, raf: 0 };
const PLAY_ICON = '<polygon points="6 3 20 12 6 21 6 3"/>';
const PAUSE_ICON = '<rect x="5" y="4" width="5" height="16"/><rect x="14" y="4" width="5" height="16"/>';

function setSimulating(on) {
  if (on === sim.on) return;
  sim.on = on;
  setSimPlaying(false);
  $('simBtn').classList.toggle('active', on);
  $('simBar').classList.toggle('hidden', !on);
  $('previewPane').classList.toggle('simulating', on);
  preview.setSimulating(on);
  if (on) {
    preview.setMarker(null); // the marker follows the simulated pen instead
    setSimLine(0);
  } else {
    // Back to the live job.
    preview.setHead(null);
    preview.setMarker(state.machine?.wpos ?? null);
    preview.setProgress(state.progress.line);
    codeList.setCurrent(state.progress.line);
  }
}

/**
 * Show the program as if lines before `line` have been plotted, and `drawn` mm of
 * line `line` itself (0 when scrubbing: the pen waits at the start of that line).
 */
function setSimLine(line, drawn = 0) {
  const total = program.lines.length;
  sim.line = Math.max(0, Math.min(total, Math.round(line) || 0));
  $('simSlider').value = sim.line;
  $('simLine').textContent = `${sim.line.toLocaleString()} / ${total.toLocaleString()}`;
  $('simCode').textContent = program.lines[sim.line]?.trim() ?? 'end';
  preview.setProgress(sim.line);
  preview.setHead(simHead(sim.line, drawn));
  codeList.setCurrent(sim.line, { follow: true }); // same meaning as during a job: the next line to send
}

/** Where the pen is after drawing `drawn` mm of line `line`, and the part of that line drawn so far. */
function simHead(line, drawn) {
  const s = program.analysis.segments;
  const first = program.segStart[line], end = program.segStart[Math.min(line + 1, program.lines.length)];
  const partial = [];
  let head = null;
  if (first > 0) {
    const i = (first - 1) * 6; // pen rests at the end of the last move before this line
    head = { x: s[i + 2], y: s[i + 3], down: s[i + 4] === 1, partial };
  }
  for (let n = first; n < end && drawn > 0; n++) {
    const i = n * 6;
    const [x1, y1, x2, y2, down] = [s[i], s[i + 1], s[i + 2], s[i + 3], s[i + 4]];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const f = len > 0 ? Math.min(1, drawn / len) : 1;
    const x = x1 + (x2 - x1) * f, y = y1 + (y2 - y1) * f;
    partial.push(x1, y1, x, y, down);
    head = { x, y, down: down === 1, partial };
    drawn -= len;
  }
  return head;
}

/** First line whose cumulative path length reaches `dist`. */
function lineAtDistance(dist) {
  const cum = program.cumLength;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] >= dist) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function setSimPlaying(playing) {
  sim.playing = playing;
  cancelAnimationFrame(sim.raf);
  $('simPlayIcon').innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  $('simPlayBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (!playing) return;
  if (sim.line >= program.lines.length) setSimLine(0); // replay from the start
  sim.dist = program.cumLength[sim.line];
  sim.last = performance.now();
  sim.raf = requestAnimationFrame(simTick);
}

function simTick(now) {
  const cum = program.cumLength;
  const total = cum[cum.length - 1];
  const dt = Math.min(0.1, (now - sim.last) / 1000); // don't jump after a background tab
  sim.last = now;
  sim.dist += (total / SIM_SECONDS) * Number($('simSpeed').value) * dt;
  if (sim.dist >= total) {
    setSimLine(program.lines.length);
    return setSimPlaying(false);
  }
  // cum[k - 1] < dist <= cum[k]: line k - 1 is being drawn.
  const line = Math.max(0, lineAtDistance(sim.dist) - 1);
  setSimLine(line, sim.dist - cum[line]);
  sim.raf = requestAnimationFrame(simTick);
}

$('simBtn').addEventListener('click', () => setSimulating(!sim.on));
$('simPlayBtn').addEventListener('click', () => setSimPlaying(!sim.playing));
$('simSlider').addEventListener('input', (e) => {
  setSimLine(Number(e.target.value));
  sim.dist = program.cumLength[sim.line]; // keep playing from where it was dragged to
});
$('simFromBtn').addEventListener('click', () => {
  if (state.job.state === 'running') return toast('The job is running; pause it to change the line', { error: true });
  const line = Math.min(sim.line + 1, Math.max(1, program.lines.length));
  $('lineInput').value = line;
  toast(`From line set to ${line}`);
});

// ---- machine

function jog(dx, dy) {
  const step = settings.jogStep;
  const feed = Number($('jogFeed').value) || settings.jogFeed;
  const x = dx * (settings.invertX ? -1 : 1) * step;
  const y = dy * (settings.invertY ? -1 : 1) * step;
  const axes = [x && `X${x}`, y && `Y${y}`].filter(Boolean).join(' ');
  // G91 is modal: always switch back to G90 so a following job isn't run in relative mode.
  const cmds = settings.jogMode === 'jog' ? [`$J=G21 G91 ${axes} F${feed}`] : [`G21 G91 G1 ${axes} F${feed}`, 'G90'];
  return run(cmds);
}

document.querySelectorAll('[data-jog]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const [dx, dy] = btn.dataset.jog.split(',').map(Number);
    jog(dx, dy);
  }),
);

function renderStep() {
  document.querySelectorAll('#stepSelect button').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.step) === settings.jogStep),
  );
}
document.querySelectorAll('#stepSelect button').forEach((b) =>
  b.addEventListener('click', () => {
    settings = { ...settings, jogStep: Number(b.dataset.step) };
    saveSettings(settings);
    renderStep();
  }),
);
$('jogFeed').addEventListener('change', (e) => {
  settings = { ...settings, jogFeed: Number(e.target.value) || settings.jogFeed };
  saveSettings(settings);
});

$('penUpBtn').addEventListener('click', () => run([settings.penUp]));
$('penDownBtn').addEventListener('click', () => run([settings.penDown]));
$('goZeroBtn').addEventListener('click', () => run([settings.penUp, 'G90', 'G0 X0 Y0']));
$('setZeroBtn').addEventListener('click', () => run(['G10 P0 L20 X0 Y0 Z0']));
$('unlockBtn').addEventListener('click', () => run(['$X']));
$('infoBtn').addEventListener('click', () => run(['$$']));
$('statusBtn').addEventListener('click', () => realtime('status'));
$('holdBtn').addEventListener('click', () => realtime('hold'));
$('cycleBtn').addEventListener('click', () => realtime('resume'));
$('resetBtn').addEventListener('click', () => {
  if (confirm('Soft reset the controller? Motion stops immediately and any running job is stopped.')) realtime('reset');
});

// ---- box & frame

function boxCorners() {
  const x = Number($('boxX').value), y = Number($('boxY').value);
  const w = Number($('boxW').value), h = Number($('boxH').value);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    toast('Enter a valid position and size', { error: true });
    return null;
  }
  const r = (n) => round(n);
  return [[r(x), r(y)], [r(x + w), r(y)], [r(x + w), r(y + h)], [r(x), r(y + h)], [r(x), r(y)]];
}

$('frameBtn').addEventListener('click', () => {
  const c = boxCorners();
  if (c) run([settings.penUp, 'G90', ...c.map(([x, y]) => `G0 X${x} Y${y}`)]);
});

$('drawBoxBtn').addEventListener('click', () => {
  const c = boxCorners();
  if (!c) return;
  const [[x0, y0], ...rest] = c;
  run([
    settings.penUp,
    'G21',
    'G90',
    `G0 X${x0} Y${y0}`,
    settings.penDown,
    ...rest.map(([x, y], i) => `G1 X${x} Y${y}${i === 0 ? ` F${settings.drawFeed}` : ''}`),
    settings.penUp,
  ]);
});

$('boundsBtn').addEventListener('click', () => {
  const b = program.analysis?.bounds;
  if (!b) return toast('Load a file with moves first');
  $('boxX').value = round(b.minX);
  $('boxY').value = round(b.minY);
  $('boxW').value = round(b.maxX - b.minX);
  $('boxH').value = round(b.maxY - b.minY);
});

// ---- console

$('termForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const cmd = $('termInput').value.trim();
  if (!cmd) return;
  history.push(cmd);
  $('termInput').value = '';
  // Realtime characters on their own are sent immediately, not as a line.
  const rt = { '!': 'hold', '~': 'resume', '?': 'status' }[cmd];
  if (rt) realtime(rt);
  else run([cmd]);
});
$('clearTermBtn').addEventListener('click', () => terminal.clear());
$('showJobTraffic').addEventListener('change', (e) => {
  terminal.showJobTraffic = e.target.checked;
  settings = { ...settings, showJobTraffic: e.target.checked };
  saveSettings(settings);
});

// ---- keyboard jogging

document.addEventListener('keydown', (e) => {
  if (sim.on && e.key === ' ' && !$('settingsDialog').open && (e.target === $('simSlider') || !e.target.closest('input, select, textarea, button'))) {
    e.preventDefault();
    return setSimPlaying(!sim.playing);
  }
  if (!settings.keyboardJog || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.target.closest('input, select, textarea, dialog') || $('settingsDialog').open) return;
  const dir = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
  if (!dir || state.connection.state !== 'connected' || state.job.state === 'running') return;
  e.preventDefault();
  jog(...dir);
});

// ---- settings dialog

const dialog = $('settingsDialog');
const form = $('settingsForm');
$('settingsBtn').addEventListener('click', () => {
  writeForm(form, settings);
  dialog.returnValue = '';
  dialog.showModal();
});
dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  settings = readForm(form, settings);
  saveSettings(settings);
  preview.setShowTravel(settings.showTravel);
  attempt(() => syncServerOptions()); // applies immediately if connected
  toast('Settings saved');
});

// ------------------------------------------------------------------ init

$('host').value = settings.host;
$('port').value = settings.port;
$('autoReconnect').checked = settings.autoReconnect;
$('jogFeed').value = settings.jogFeed;
$('showJobTraffic').checked = settings.showJobTraffic;
renderStep();
render();
