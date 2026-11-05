import test from 'node:test';
import assert from 'node:assert/strict';
import { GrblController } from '../src/grbl/controller.js';
import { JobRunner } from '../src/job/runner.js';
import { startFakeGrbl, until } from './helpers/fake-grbl.js';

const PROGRAM = ['; header comment', 'G21', 'G90', '(paren comment)', 'M5', 'G0 X0 Y0', 'M3 S1000', 'G1 X10 Y0', 'G1 X10 Y10', '', 'M5'].join('\r\n');

async function setup(t, opts = {}) {
  const fake = await startFakeGrbl(opts);
  const controller = new GrblController({ lineTimeoutMs: 2000, reconnectDelaysMs: [50] });
  const runner = new JobRunner(controller);
  t.after(async () => {
    controller.disconnect();
    await fake.close();
  });
  await controller.connect('127.0.0.1', fake.port, { autoReconnect: opts.autoReconnect ?? false });
  return { fake, controller, runner };
}

const waitState = (runner, state) =>
  new Promise((resolve) => {
    if (runner.state === state) return resolve();
    const on = (s) => s.state === state && (runner.off('state', on), resolve());
    runner.on('state', on);
  });

test('streams a file, skipping comments and blank lines', async (t) => {
  const { fake, runner } = await setup(t);
  runner.load('box.gcode', PROGRAM);
  runner.start();
  await waitState(runner, 'done');
  assert.deepEqual(fake.received, ['G21', 'G90', 'M5', 'G0 X0 Y0', 'M3 S1000', 'G1 X10 Y0', 'G1 X10 Y10', 'M5']);
  assert.equal(runner.next, runner.lines.length);
});

test('pause keeps position; resume restores state and continues without repeating or skipping', async (t) => {
  const { fake, runner } = await setup(t, { delayMs: 10 });
  runner.load('box.gcode', PROGRAM);
  runner.start();
  await until(() => fake.received.includes('M3 S1000'));
  runner.pause();
  await new Promise((r) => setTimeout(r, 50));
  const pausedAt = runner.next;
  assert.equal(runner.state, 'paused');
  assert.ok(pausedAt > 0 && pausedAt < runner.lines.length, 'did not reset to line 0');
  const before = fake.received.length;

  runner.resume();
  await waitState(runner, 'done');
  const after = fake.received.slice(before);
  // preamble first: pen up, absolute, travel to where we stopped, pen down again
  assert.equal(after[0], 'M5');
  assert.ok(after.includes('G0 X0 Y0'));
  const jobLines = fake.received.filter((l) => l.startsWith('G1 X10'));
  assert.deepEqual(jobLines, ['G1 X10 Y0', 'G1 X10 Y10'], 'each move sent exactly once');
});

test('rapid pause/resume does not duplicate the in-flight line', async (t) => {
  const { fake, runner } = await setup(t, { delayMs: 20 });
  runner.load('box.gcode', PROGRAM);
  runner.start();
  await until(() => fake.received.includes('G1 X10 Y0'));
  runner.pause();
  runner.resume(); // before the in-flight ok arrived
  await waitState(runner, 'done');
  assert.equal(fake.received.filter((l) => l === 'G1 X10 Y0').length, 1);
  assert.equal(fake.received.filter((l) => l === 'G1 X10 Y10').length, 1);
});

test('G-code error pauses the job at the failing line', async (t) => {
  const { runner } = await setup(t, { respond: (l) => (l === 'G1 X10 Y0' ? 'error:33' : 'ok') });
  runner.load('box.gcode', PROGRAM);
  runner.start();
  await waitState(runner, 'paused');
  assert.equal(runner.lines[runner.next], 'G1 X10 Y0');
  assert.match(runner.pauseReason, /error:33/);
  // user can skip the bad line and continue
  runner.setNextLine(runner.next + 1);
});

test('connection loss pauses and auto-resumes after reconnect', async (t) => {
  let dropped = false;
  const { fake, runner } = await setup(t, {
    autoReconnect: true,
    respond: (line) => {
      if (line === 'G1 X10 Y0' && !dropped) {
        dropped = true;
        setTimeout(() => fake.dropClients(), 0);
        return null; // the line is lost with the connection
      }
      return 'ok';
    },
  });
  runner.load('box.gcode', PROGRAM);
  runner.start();
  await waitState(runner, 'paused');
  assert.match(runner.pauseReason, /Will resume/);
  await waitState(runner, 'done');
  assert.equal(fake.received.filter((l) => l === 'G1 X10 Y0').length, 2, 'lost line re-sent once');
  assert.equal(fake.received.filter((l) => l === 'G1 X10 Y10').length, 1);
});

test('controller reset blocks auto-resume', async (t) => {
  const { fake, runner } = await setup(t, { delayMs: 30 });
  runner.load('box.gcode', PROGRAM);
  runner.start();
  await until(() => fake.received.length >= 3);
  fake.write("Grbl 1.1h ['$' for help]\r\n");
  await waitState(runner, 'paused');
  assert.match(runner.pauseReason, /reset/i);
});
