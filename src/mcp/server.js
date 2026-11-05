// MCP server (stdio) that lets an AI agent drive the plotter.
//
// It talks to the running web server's REST API (`npm start`), so everything the
// agent does shows up live in the browser UI, and the job keeps running on the server.
//
// Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout. stdout carries protocol
// messages only; diagnostics go to stderr.

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { polylinesToGcode } from './draw.js';
import { renderPreview } from './render.js';

const SERVER_INFO = { name: 'xy-plotter', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const env = process.env;
const settings = () => ({
  baseUrl: (env.PLOTTER_URL || `http://127.0.0.1:${config.port}`).replace(/\/+$/, '') + '/api',
  penUp: env.PEN_UP || 'M5',
  penDown: env.PEN_DOWN || 'M3 S1000',
  drawFeed: Number(env.DRAW_FEED) || 3000,
});

const INSTRUCTIONS = `Controls a GRBL pen plotter (XY, millimetres, absolute coordinates, origin at the work zero, X right, Y up).
Typical workflow: get_state -> connect if needed -> draw_polylines or load_gcode (both return a preview image: black = pen down, grey = pen-up travel, axes cross at the origin) -> check the preview -> start_job -> wait_for_job.
Pen commands: up "${settings().penUp}", down "${settings().penDown}". send_commands runs any line, including GRBL $ commands ($$, $X, $H, $N=...), but only while no job is running.
The browser UI at ${settings().baseUrl.replace(/\/api$/, '')} shows the same state live.`;

// ---- REST client ----------------------------------------------------------

async function api(method, route, body) {
  const { baseUrl } = settings();
  const init = { method, headers: {} };
  if (typeof body === 'string') {
    init.headers['Content-Type'] = 'text/plain';
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(baseUrl + route, init);
  } catch (err) {
    throw new Error(`Cannot reach the plotter server at ${baseUrl} (${err.cause?.message ?? err.message}). Is it running (npm start)?`);
  }
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.error ?? `HTTP ${res.status}`);
    if (isJson && data?.responses) err.details = data.responses;
    throw err;
  }
  return data;
}

// ---- Tool helpers ---------------------------------------------------------

const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });

function previewContent(gcode, { size, showTravel } = {}) {
  const r = renderPreview(gcode, { size: clamp(size ?? 800, 128, 2000), showTravel: showTravel ?? true });
  const round = (n) => Math.round(n * 100) / 100;
  const summary = {
    bounds: r.bounds && Object.fromEntries(Object.entries(r.bounds).map(([k, v]) => [k, round(v)])),
    drawLengthMm: round(r.drawLength),
    travelLengthMm: round(r.travelLength),
    commands: r.commandCount,
    image: `${r.width}x${r.height}px, grid every ${r.gridMm} mm`,
  };
  return [text(summary), { type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' }];
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(n) || lo));
}

function need(args, key, type) {
  const v = args?.[key];
  const ok = type === 'array' ? Array.isArray(v) : typeof v === type && (type !== 'string' || v.length > 0);
  if (!ok) throw new Error(`"${key}" is required (${type})`);
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };

// ---- Tools ----------------------------------------------------------------

export const TOOLS = [
  {
    name: 'get_state',
    description: 'Connection state, machine status/position, and job state/progress.',
    inputSchema: obj(),
    run: async () => [text(await api('GET', '/state'))],
  },
  {
    name: 'connect',
    description: 'Connect to the plotter over TCP.',
    inputSchema: obj(
      {
        host: { type: 'string', description: 'Plotter IP or hostname' },
        port: { type: 'integer', description: 'TCP port (often 1234, or 23)' },
        autoReconnect: { type: 'boolean', default: true },
        streaming: { type: 'string', enum: ['send-response', 'char-count'], description: 'Flow control. char-count is faster but needs real GRBL.' },
        statusPollMs: { type: 'integer', description: 'Poll "?" status every N ms (0 = off). Only if the firmware supports it.' },
      },
      ['host', 'port'],
    ),
    run: async (a) => {
      need(a, 'host', 'string');
      need(a, 'port', 'number');
      return [text(await api('POST', '/connect', a))];
    },
  },
  {
    name: 'disconnect',
    description: 'Close the connection (pauses a running job).',
    inputSchema: obj(),
    run: async () => [text(await api('POST', '/disconnect'))],
  },
  {
    name: 'send_commands',
    description:
      'Send lines to the controller in order and return each response; stops at the first error. ' +
      'Anything goes: G-code moves, pen commands, and GRBL system commands such as $$, $#, $G, $I, $X (unlock), $H (home), $N=value (settings). ' +
      'Refused while a job is running.',
    inputSchema: obj({ commands: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['commands']),
    run: async (a) => {
      need(a, 'commands', 'array');
      try {
        return [text(await api('POST', '/commands', { commands: a.commands }))];
      } catch (err) {
        if (err.details) err.message += `\n${JSON.stringify(err.details, null, 2)}`;
        throw err;
      }
    },
  },
  {
    name: 'realtime',
    description: 'Send a realtime command: hold (feed hold "!"), resume ("~"), status ("?"), or reset (soft reset Ctrl-X, stops any job).',
    inputSchema: obj({ command: { type: 'string', enum: ['hold', 'resume', 'status', 'reset'] } }, ['command']),
    run: async (a) => [text(await api('POST', '/realtime', { command: need(a, 'command', 'string') }))],
  },
  {
    name: 'draw_polylines',
    description:
      'Turn polylines (mm) into G-code and load it as the job: travel pen-up to each polyline start, pen down, draw, pen up. ' +
      'Returns a preview image. Does not start plotting; call start_job after checking the preview. ' +
      'Tip: compute curves densely (e.g. 0.5-1 mm segments) for smooth results.',
    inputSchema: obj(
      {
        polylines: { type: 'array', items: { type: 'array', items: point, minItems: 1 }, minItems: 1, description: '[[[x,y],[x,y],...], ...]' },
        closed: { type: 'boolean', default: false, description: 'Close every polyline back to its first point' },
        feed: { type: 'number', description: 'Drawing feed rate in mm/min (default from DRAW_FEED, 3000)' },
        penDelayMs: { type: 'number', default: 0, description: 'Dwell after each pen up/down' },
        returnHome: { type: 'boolean', default: false, description: 'Travel to X0 Y0 at the end' },
        name: { type: 'string', default: 'agent-drawing.gcode' },
      },
      ['polylines'],
    ),
    run: async (a) => {
      const s = settings();
      const gcode = polylinesToGcode(need(a, 'polylines', 'array'), {
        penUp: s.penUp,
        penDown: s.penDown,
        feed: a.feed ?? s.drawFeed,
        closed: !!a.closed,
        penDelayMs: a.penDelayMs ?? 0,
        returnHome: !!a.returnHome,
      });
      const state = await api('POST', `/job?name=${encodeURIComponent(a.name || 'agent-drawing.gcode')}`, gcode);
      return [text({ job: state.job }), ...previewContent(gcode)];
    },
  },
  {
    name: 'load_gcode',
    description: 'Load raw G-code as the job (replaces the current one). Returns a preview image. Does not start plotting.',
    inputSchema: obj({ gcode: { type: 'string' }, name: { type: 'string', default: 'agent.gcode' } }, ['gcode']),
    run: async (a) => {
      const gcode = need(a, 'gcode', 'string');
      const state = await api('POST', `/job?name=${encodeURIComponent(a.name || 'agent.gcode')}`, gcode);
      return [text({ job: state.job }), ...previewContent(gcode)];
    },
  },
  {
    name: 'preview',
    description: 'Render a toolpath to an image: the given G-code, or the loaded job if omitted. Black = pen down, grey = travel, axes cross at the origin.',
    inputSchema: obj({
      gcode: { type: 'string' },
      size: { type: 'integer', default: 800, description: 'Longest side in pixels (128-2000)' },
      showTravel: { type: 'boolean', default: true },
    }),
    run: async (a) => previewContent(a.gcode ?? (await api('GET', '/job/gcode')), a),
  },
  {
    name: 'get_gcode',
    description: 'Read lines of the loaded job, prefixed with their 0-based line number.',
    inputSchema: obj({ fromLine: { type: 'integer', default: 0 }, maxLines: { type: 'integer', default: 300 } }),
    run: async (a) => {
      const lines = (await api('GET', '/job/gcode')).split(/\r\n|\r|\n/);
      const from = clamp(a.fromLine ?? 0, 0, lines.length);
      const slice = lines.slice(from, from + clamp(a.maxLines ?? 300, 1, 5000));
      const body = slice.map((l, i) => `${from + i}: ${l}`).join('\n');
      return [text(`${body}\n(${lines.length} lines total)`)];
    },
  },
  {
    name: 'unload_job',
    description: 'Unload the current job.',
    inputSchema: obj(),
    run: async () => [text(await api('DELETE', '/job'))],
  },
  {
    name: 'start_job',
    description: 'Start plotting the loaded job, optionally from a 0-based line (the machine state is restored first).',
    inputSchema: obj({ fromLine: { type: 'integer', default: 0 } }),
    run: async (a) => [text(await api('POST', '/job/start', { fromLine: a.fromLine ?? 0 }))],
  },
  {
    name: 'pause_job',
    description: 'Pause the job after the lines already sent finish.',
    inputSchema: obj(),
    run: async () => [text(await api('POST', '/job/pause'))],
  },
  {
    name: 'resume_job',
    description: 'Resume a paused job (lifts the pen and returns to where it left off).',
    inputSchema: obj(),
    run: async () => [text(await api('POST', '/job/resume'))],
  },
  {
    name: 'stop_job',
    description: 'Stop the job.',
    inputSchema: obj(),
    run: async () => [text(await api('POST', '/job/stop'))],
  },
  {
    name: 'wait_for_job',
    description: 'Wait until the job is no longer running (done, paused, error, stopped) or the timeout passes, then return the state.',
    inputSchema: obj({ timeoutSeconds: { type: 'number', default: 60, description: '1-600' } }),
    run: async (a) => {
      const deadline = Date.now() + clamp(a.timeoutSeconds ?? 60, 1, 600) * 1000;
      let state = await api('GET', '/state');
      while (state.job.state === 'running' && Date.now() < deadline) {
        await sleep(500);
        state = await api('GET', '/state');
      }
      const finished = state.job.state !== 'running';
      return [text({ finished, ...state })];
    },
  },
];

// ---- JSON-RPC -------------------------------------------------------------

/**
 * Handle one incoming message. Returns the response, or null for notifications.
 * @param {any} msg
 */
export async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return null; // responses to us, junk
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled, ...

  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

  switch (msg.method) {
    case 'initialize': {
      const wanted = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
      try {
        return reply({ content: await tool.run(msg.params.arguments ?? {}) });
      } catch (err) {
        return reply({ content: [text(err.message)], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

function main() {
  const write = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    try {
      const res = await handleMessage(msg);
      if (res) write(res);
    } catch (err) {
      console.error(err);
      if (msg?.id != null) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } });
    }
  });
  rl.on('close', () => process.exit(0));
  console.error(`xy-plotter MCP server ready (REST API: ${settings().baseUrl})`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
