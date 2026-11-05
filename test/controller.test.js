import test from 'node:test';
import assert from 'node:assert/strict';
import { GrblController, GrblError } from '../src/grbl/controller.js';
import { LineSplitter } from '../src/transport/tcp-connection.js';
import { parseResponse } from '../src/grbl/protocol.js';
import { startFakeGrbl, until } from './helpers/fake-grbl.js';

test('LineSplitter handles fragmented and coalesced chunks', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('o'), []);
  assert.deepEqual(s.push('k\r\nok\r\ner'), ['ok', 'ok']);
  assert.deepEqual(s.push('ror:20\r\n'), ['error:20']);
});

test('parseResponse classifies GRBL output', () => {
  assert.equal(parseResponse('ok').kind, 'ok');
  assert.deepEqual(parseResponse('error:20'), { kind: 'error', code: '20', message: 'Unsupported command' });
  assert.equal(parseResponse('ALARM:1').kind, 'alarm');
  assert.equal(parseResponse("Grbl 1.1h ['$' for help]").kind, 'welcome');
  assert.equal(parseResponse('[MSG:Pgm End]').kind, 'message');
  const st = parseResponse('<Run|WPos:1.5,2,0|FS:500,0>').status;
  assert.equal(st.state, 'Run');
  assert.deepEqual(st.wpos, { x: 1.5, y: 2, z: 0 });
});

async function setup(t, opts) {
  const fake = await startFakeGrbl(opts);
  const controller = new GrblController({ lineTimeoutMs: 1000, reconnectDelaysMs: [50] });
  t.after(async () => {
    controller.disconnect();
    await fake.close();
  });
  await controller.connect('127.0.0.1', fake.port, { autoReconnect: false });
  return { fake, controller };
}

test('only one line in flight; coalesced oks resolve the right commands', async (t) => {
  const { fake, controller } = await setup(t);
  fake.holdReplies = true;
  const p = ['G1 X1', 'G1 X2', 'G1 X3'].map((l) => controller.send(l));
  await until(() => fake.received.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fake.received.length, 1, 'second line must wait for ok');
  fake.holdReplies = false;
  fake.flushCoalesced();
  await Promise.all(p);
  assert.deepEqual(fake.received, ['G1 X1', 'G1 X2', 'G1 X3']);
});

test('unsolicited lines do not resolve pending commands', async (t) => {
  const { fake, controller } = await setup(t, {
    respond: (line) => (line === '$$' ? '$0=10\r\n$1=25\r\nok' : 'ok'),
  });
  const res = await controller.send('$$');
  assert.equal(res, 'ok');
  fake.write('[MSG:hello]\r\n');
  await controller.send('G90');
  assert.deepEqual(fake.received, ['$$', 'G90']);
});

test('error:N rejects with GrblError', async (t) => {
  const { controller } = await setup(t, { respond: (l) => (l === 'G99' ? 'error:20' : 'ok') });
  await assert.rejects(controller.send('G99'), GrblError);
  assert.equal(await controller.send('G90'), 'ok');
});

test('realtime commands bypass the queue and do not wait for ok', async (t) => {
  const { fake, controller } = await setup(t);
  const statuses = [];
  controller.on('status', (s) => statuses.push(s));
  controller.realtime('?');
  await until(() => statuses.length === 1);
  assert.deepEqual(statuses[0].wpos, { x: 1, y: 2, z: 0 });
  assert.deepEqual(fake.realtime, ['?']);
  assert.deepEqual(fake.received, []);
});

test('timeout rejects and lets the queue continue', async (t) => {
  const { controller } = await setup(t, { respond: (l) => (l === 'SLOW' ? null : 'ok') });
  controller.lineTimeoutMs = 100;
  await assert.rejects(controller.send('SLOW'), /No response/);
  assert.equal(await controller.send('G90'), 'ok');
});

test('auto-reconnects after the connection drops', async (t) => {
  const fake = await startFakeGrbl();
  const controller = new GrblController({ reconnectDelaysMs: [50] });
  t.after(async () => {
    controller.disconnect();
    await fake.close();
  });
  await controller.connect('127.0.0.1', fake.port, { autoReconnect: true });
  const reconnected = new Promise((r) => controller.once('reconnected', r));
  fake.dropClients();
  await reconnected;
  assert.equal(controller.state, 'connected');
  assert.equal(await controller.send('G90'), 'ok');
});

test('connect failure rejects instead of hanging', async () => {
  const controller = new GrblController();
  // Port 1 on localhost is essentially never open.
  await assert.rejects(controller.connect('127.0.0.1', 1, { autoReconnect: false }));
  assert.equal(controller.state, 'disconnected');
});
