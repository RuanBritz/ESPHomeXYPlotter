import test from 'node:test';
import assert from 'node:assert/strict';
import { GrblController } from '../src/grbl/controller.js';
import { JobRunner } from '../src/job/runner.js';
import { startFakeGrbl, until } from './helpers/fake-grbl.js';

// Character-counting streaming: several lines in flight, never more than rxBufferSize bytes unanswered.

async function setup(t, opts = {}) {
  const fake = await startFakeGrbl(opts);
  const controller = new GrblController({ lineTimeoutMs: 3000, streaming: 'char-count', rxBufferSize: 128 });
  const runner = new JobRunner(controller);
  t.after(async () => {
    controller.disconnect();
    await fake.close();
  });
  await controller.connect('127.0.0.1', fake.port, { autoReconnect: false });
  return { fake, controller, runner };
}

const waitState = (runner, state) =>
  new Promise((resolve) => {
    if (runner.state === state) return resolve();
    const on = (s) => s.state === state && (runner.off('state', on), resolve());
    runner.on('state', on);
  });

const program = (n) => ['G21', 'G90', 'M3 S1000', ...Array.from({ length: n }, (_, i) => `G1 X${i}.123 Y${i}.456 F3000`), 'M5'].join('\n');

test('fills the receive buffer without overflowing it', async (t) => {
  const { fake, controller } = await setup(t, { delayMs: 5 });
  const lines = Array.from({ length: 40 }, (_, i) => `G1 X${i} Y${i}`);
  const results = await Promise.all(lines.map((l) => controller.send(l)));
  assert.equal(results.length, 40);
  assert.deepEqual(fake.received, lines);
  assert.ok(fake.maxBufferedBytes <= 128, `buffer overflow: ${fake.maxBufferedBytes} bytes`);
  assert.ok(fake.maxBufferedBytes > 40, 'several lines should have been in flight');
});

test('$ system commands are sent alone', async (t) => {
  const { fake, controller } = await setup(t);
  fake.holdReplies = true;
  const p = [controller.send('G1 X1'), controller.send('$$'), controller.send('G1 X2')];
  await until(() => fake.received.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fake.received, ['G1 X1'], '$$ waits for the buffer to empty');
  fake.flushCoalesced();
  await until(() => fake.received.length === 2);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fake.received, ['G1 X1', '$$'], 'nothing is sent after $$ until it is answered');
  fake.holdReplies = false;
  fake.flushCoalesced();
  await Promise.all(p);
  assert.deepEqual(fake.received, ['G1 X1', '$$', 'G1 X2']);
});

test('job streams every line exactly once, in order', async (t) => {
  const { fake, runner } = await setup(t, { delayMs: 1 });
  runner.load('p.gcode', program(200));
  runner.start();
  await waitState(runner, 'done');
  assert.deepEqual(fake.received, runner.lines);
  assert.ok(fake.maxBufferedBytes <= 128);
});

test('pause stops writing promptly; resume neither repeats nor skips', async (t) => {
  const { fake, runner } = await setup(t, { delayMs: 3 });
  runner.load('p.gcode', program(200));
  runner.start();
  await until(() => fake.received.length > 50);
  runner.pause();
  await new Promise((r) => setTimeout(r, 100)); // let in-flight lines drain
  const sentAtPause = fake.received.length;
  assert.equal(runner.lines[runner.next - 1], fake.received[sentAtPause - 1], 'resume point is right after the last line sent');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.received.length, sentAtPause, 'nothing written while paused');

  runner.resume();
  await waitState(runner, 'done');
  for (const line of runner.lines.filter((l) => l.startsWith('G1'))) {
    assert.equal(fake.received.filter((r) => r === line).length, 1, `${line} sent once`);
  }
});

test('an error mid-stream pauses after the lines that already ran', async (t) => {
  const bad = 'G1 X50.123 Y50.456 F3000';
  const { fake, runner } = await setup(t, { delayMs: 2, respond: (l) => (l === bad ? 'error:33' : 'ok') });
  runner.load('p.gcode', program(120));
  runner.start();
  await waitState(runner, 'paused');
  const badIndex = runner.lines.indexOf(bad);
  assert.match(runner.pauseReason, new RegExp(`Line ${badIndex + 1}: error:33`));
  assert.ok(runner.next > badIndex, 'resume point is past the failed line');
  assert.equal(runner.lines[runner.next - 1], fake.received[fake.received.length - 1], 'and right after the last line the controller ran');

  runner.resume();
  await waitState(runner, 'done');
  for (const line of runner.lines.filter((l) => l.startsWith('G1') && l !== bad)) {
    assert.equal(fake.received.filter((r) => r === line).length, 1, `${line} sent once`);
  }
});
