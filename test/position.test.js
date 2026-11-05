import test from 'node:test';
import assert from 'node:assert/strict';
import { PositionEstimate } from '../src/grbl/position.js';
import { GrblController } from '../src/grbl/controller.js';
import { startFakeGrbl, until } from './helpers/fake-grbl.js';

test('estimate follows jogs, absolute moves and set zero', () => {
  const p = new PositionEstimate();
  assert.deepEqual(p.position, { x: 0, y: 0 });

  // G91 jog (the default jog method), then back to G90
  p.apply('G21 G91 G1 X10 F1000');
  p.apply('G90');
  p.apply('G21 G91 G1 Y-5 F1000');
  p.apply('G90');
  assert.deepEqual(p.position, { x: 10, y: -5 });

  // $J= jogs don't change the modal state
  p.apply('$J=G21 G91 X2.5 F1000');
  assert.deepEqual(p.position, { x: 12.5, y: -5 });
  p.apply('G0 X1');
  assert.deepEqual(p.position, { x: 1, y: -5 }, 'still absolute after a $J= jog');

  // Set zero
  p.apply('G10 P0 L20 X0 Y0 Z0');
  assert.deepEqual(p.position, { x: 0, y: 0 });
  p.apply('G92 X5 Y6');
  assert.deepEqual(p.position, { x: 5, y: 6 });

  // Non-moves change nothing
  assert.equal(p.apply('M3 S1000'), false);
  assert.equal(p.apply('$$'), false);
});

test('estimate becomes unknown after homing until an absolute XY move', () => {
  const p = new PositionEstimate();
  assert.equal(p.apply('$H'), true);
  assert.equal(p.position, null);
  p.apply('G91 G1 X10');
  assert.equal(p.position, null);
  p.apply('G90 G0 X3 Y4');
  assert.deepEqual(p.position, { x: 3, y: 4 });
  p.apply('G28');
  assert.equal(p.position, null);
});

test('controller publishes estimates from acknowledged commands', async (t) => {
  const fake = await startFakeGrbl();
  const controller = new GrblController({ lineTimeoutMs: 1000 });
  t.after(async () => {
    controller.disconnect();
    await fake.close();
  });
  const estimates = [];
  controller.on('estimate', (m) => estimates.push(m));
  await controller.connect('127.0.0.1', fake.port, { autoReconnect: false });
  assert.deepEqual(estimates[0].wpos, { x: 0, y: 0, z: null });
  assert.equal(estimates[0].estimated, true);

  await controller.send('G21 G91 G1 X10 Y20 F1000');
  await controller.send('G90');
  await until(() => estimates.at(-1).wpos.x === 10);
  assert.deepEqual(controller.snapshot().machine.wpos, { x: 10, y: 20, z: null });
});
