import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { isPrivateAddress, validateTarget } from '../src/api/targets.js';
import { startFakeGrbl, until } from './helpers/fake-grbl.js';

const cfg = { lineTimeoutMs: 2000, connectTimeoutMs: 1000, maxUploadBytes: 1024 * 1024, allowedTargets: 'private' };

async function setup(t) {
  const fake = await startFakeGrbl();
  const { server, close } = createApp(cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    await close();
    await fake.close();
  });
  const call = async (method, path, body, type = 'application/json') => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': type },
      body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body,
    });
    return { status: res.status, body: await res.json() };
  };
  return { fake, call };
}

test('target validation', async () => {
  assert.ok(isPrivateAddress('192.168.1.5'));
  assert.ok(isPrivateAddress('10.0.0.1'));
  assert.ok(!isPrivateAddress('8.8.8.8'));
  await assert.rejects(validateTarget('8.8.8.8', 80, 'private'), /local network/);
  await assert.rejects(validateTarget('192.168.1.5', 99999, 'private'), /port/);
  await assert.doesNotReject(validateTarget('8.8.8.8', 80, 'any'));
});

test('connect failure returns an error response instead of hanging', async (t) => {
  const { call } = await setup(t);
  const r = await call('POST', '/connect', { host: '127.0.0.1', port: 1, autoReconnect: false });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Could not connect/);
});

test('connect, run commands, upload and run a job', async (t) => {
  const { fake, call } = await setup(t);
  let r = await call('POST', '/connect', { host: '127.0.0.1', port: fake.port });
  assert.equal(r.status, 200);
  assert.equal(r.body.connection.state, 'connected');

  r = await call('POST', '/connect', { host: '127.0.0.1', port: fake.port });
  assert.equal(r.status, 409);

  r = await call('POST', '/commands', { commands: ['g90', '; comment', 'M5'] });
  assert.equal(r.status, 200);
  assert.deepEqual(fake.received, ['G90', 'M5']);

  r = await call('POST', '/job?name=t.gcode', 'G1 X1\nG1 X2\n', 'text/plain');
  assert.equal(r.body.job.state, 'ready');
  assert.equal(r.body.job.totalLines, 2);

  r = await call('POST', '/job/start', { fromLine: 0 });
  assert.equal(r.status, 200);
  await until(() => fake.received.includes('G1 X2'));

  r = await call('POST', '/realtime', { command: 'nope' });
  assert.equal(r.status, 400);
});
