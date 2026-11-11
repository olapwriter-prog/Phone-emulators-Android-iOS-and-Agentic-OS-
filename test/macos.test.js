import test from 'node:test';
import assert from 'node:assert/strict';
import { up, logged } from './helpers.js';

test('memory pressure compresses and swaps instead of killing apps', () => {
  const d = up('macbook-air-13-m2');
  for (const id of Object.keys(d.os.apps)) d.os.launch(id);
  d.run(30);
  assert.equal(d.os.procs.size, Object.keys(d.os.apps).length);
  assert.ok(d.os.swapMB > 0);
  assert.ok(['warn', 'critical'].includes(d.os.memoryPressure()));
});

test('hidden idle apps enter App Nap; audio and builds do not', () => {
  const d = up('macbook-pro-14-m3-pro');
  d.os.launch('pages'); d.os.launch('music'); d.os.launch('xcode'); d.os.launch('safari');
  d.run(20);
  assert.ok(d.os.procs.get('pages').napped);
  assert.ok(!d.os.procs.get('music').napped);
  assert.ok(!d.os.procs.get('xcode').napped);
});

test('closing the lid sleeps, unless in clamshell mode', () => {
  const d = up('macbook-air-15-m3');
  d.os.closeLid();
  assert.equal(d.os.state, 'suspended');
  d.os.openLid();
  assert.equal(d.os.state, 'on');
  d.setEnv({ externalDisplay: true }); d.plug('usb-pd-65w');
  d.os.closeLid();
  assert.equal(d.os.state, 'on');
});

test('caffeinate prevents idle sleep', () => {
  const d = up('macbook-air-13-m3');
  d.exec('caffeinate');
  d.run(30 * 60, 5);
  assert.equal(d.os.state, 'on');
  d.exec('caffeinate stop');
  d.run(30 * 60, 5);
  assert.equal(d.os.state, 'suspended');
});

test('critically low battery hibernates', () => {
  const d = up('macbook-air-13-m3', { battery: 0.04 });
  d.os.settings.autoLockSec = 0; d.os.launch('game');
  d.run(3600, 5);
  assert.ok(d.os.hibernating);
  assert.ok(logged(d, /hibernatemode/));
});

test('zsh tools', () => {
  const d = up('macbook-pro-16-m3-max');
  assert.match(d.exec('pmset -g batt'), /InternalBattery-0/);
  assert.equal(d.exec('sysctl -n hw.memsize'), String(36 * 1024 ** 3));
  d.exec('open -a Safari');
  assert.equal(d.os.foreground, 'safari');
});
