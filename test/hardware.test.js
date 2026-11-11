import test from 'node:test';
import assert from 'node:assert/strict';
import { up } from './helpers.js';

test('screen-on use drains the battery; charging refills it', () => {
  const d = up('pixel-8', { battery: 0.6 });
  d.os.settings.autoLockSec = 0;
  d.os.launch('youtube');
  d.run(1800, 5);
  const after = d.hw.battery.level;
  assert.ok(after < 0.6 && after > 0.45, `level ${after}`);
  d.plug('usb-pd-30w');
  d.run(1200, 5);
  assert.ok(d.hw.battery.level > after + 0.15);
});

test('sustained load heats the device and throttles the CPU', () => {
  const d = up('galaxy-s23');
  d.os.settings.autoLockSec = 0;
  d.os.launch('game');
  for (let i = 0; i < 1800; i++) { d.tick(1); d.os.touch(); }
  assert.ok(d.hw.thermal.tempC > 38);
  assert.ok(d.hw.thermal.throttle < 0.9);
  assert.ok(d.os.fps() < d.hw.activeDisplay.hz);
});

test('a dead battery shuts the device down and blocks booting until charged', () => {
  const d = up('iphone-13', { battery: 0.003 });
  d.os.settings.autoLockSec = 0;
  d.os.launch('game');
  d.run(600, 1);
  assert.equal(d.os.state, 'off');
  d.os.boot();
  assert.equal(d.os.state, 'off');
  d.plug('usb-pd-20w'); d.run(60);
  d.os.boot();
  assert.equal(d.os.state, 'booting');
});

test('desktops without battery need mains power', () => {
  const d = up('mac-mini-m4');
  assert.equal(d.os.state, 'on');
  d.setMains(false);
  assert.equal(d.os.state, 'off');
});

test('foldables switch displays and power draw', () => {
  const d = up('galaxy-z-fold6');
  d.os.settings.autoLockSec = 0; d.os.launch('chrome'); d.run(5);
  const open = d.hw.power.displayW;
  d.fold(true); d.run(5);
  assert.ok(d.hw.power.displayW < open);
  assert.equal(d.hw.activeDisplay, d.spec.coverDisplay);
});
