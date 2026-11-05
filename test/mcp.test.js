import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';
import { handleMessage, TOOLS } from '../src/mcp/server.js';
import { polylinesToGcode } from '../src/mcp/draw.js';
import { renderPreview } from '../src/mcp/render.js';
import { startFakeGrbl, until } from './helpers/fake-grbl.js';

const cfg = { lineTimeoutMs: 2000, connectTimeoutMs: 1000, maxUploadBytes: 1024 * 1024, allowedTargets: 'private' };
const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/mcp/server.js');

async function setup(t) {
  const fake = await startFakeGrbl();
  const { server, close } = createApp(cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const previous = process.env.PLOTTER_URL;
  process.env.PLOTTER_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    process.env.PLOTTER_URL = previous;
    if (previous === undefined) delete process.env.PLOTTER_URL;
    await close();
    await fake.close();
  });
  let id = 0;
  const call = async (name, args = {}) => (await handleMessage({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })).result;
  return { fake, call };
}

test('polylines become pen-up travel and pen-down drawing', () => {
  const g = polylinesToGcode([[[0, 0], [10, 0], [10, 10]], [[5, 5]]], { penUp: 'M5', penDown: 'M3 S1000', feed: 1200, closed: true });
  const lines = g.split('\n').filter((l) => l && !l.startsWith(';'));
  assert.deepEqual(lines, [
    'G21', 'G90', 'M5',
    'G0 X0 Y0', 'M3 S1000', 'G1 X10 Y0 F1200', 'G1 X10 Y10', 'G1 X0 Y0', 'M5',
    'G0 X5 Y5', 'M3 S1000', 'M5',
  ]);
  assert.throws(() => polylinesToGcode([[[0, 'a']]]), /point 0/);
});

test('preview renders a valid PNG', () => {
  const r = renderPreview('M3\nG1 X50 Y20\nM5\nG0 X0 Y0\n', { size: 200 });
  assert.deepEqual([...r.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(r.width, 200);
  assert.ok(r.height < r.width);
  assert.equal(Math.round(r.drawLength), Math.round(Math.hypot(50, 20)));
});

test('handshake and tool list', async () => {
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, TOOLS.length);
  assert.ok(list.result.tools.every((t) => t.inputSchema.type === 'object' && !('run' in t)));
  const missing = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope' });
  assert.equal(missing.error.code, -32601);
});

test('agent connects, runs $ commands, draws and plots', async (t) => {
  const { fake, call } = await setup(t);

  let r = await call('connect', { host: '127.0.0.1', port: fake.port, autoReconnect: false });
  assert.ok(!r.isError, r.content[0].text);

  r = await call('send_commands', { commands: ['$$', '$X'] });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(fake.received.slice(-2), ['$$', '$X']);

  r = await call('draw_polylines', { polylines: [[[0, 0], [20, 0], [20, 20], [0, 20]]], closed: true, feed: 1500 });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(JSON.parse(r.content[0].text).job.state, 'ready');
  assert.equal(r.content.at(-1).type, 'image');
  assert.equal(r.content.at(-1).mimeType, 'image/png');

  r = await call('start_job');
  assert.ok(!r.isError, r.content[0].text);
  r = await call('wait_for_job', { timeoutSeconds: 5 });
  const state = JSON.parse(r.content[0].text);
  assert.equal(state.finished, true);
  assert.equal(state.job.state, 'done');
  await until(() => fake.received.includes('G1 X20 Y0 F1500'));

  r = await call('get_gcode', { fromLine: 0, maxLines: 3 });
  assert.match(r.content[0].text, /^0: ; generated/);
});

test('tool errors come back as isError results', async (t) => {
  const { call } = await setup(t);
  const r = await call('send_commands', { commands: ['G0 X1'] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not connected/);
});

test('stdio transport answers JSON-RPC lines', async (t) => {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => child.kill());
  const lines = readline.createInterface({ input: child.stdout });
  const next = () => new Promise((resolve) => lines.once('line', (l) => resolve(JSON.parse(l))));

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
  const init = await next();
  assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, 'xy-plotter');

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
  assert.deepEqual((await next()).result, {});
});
