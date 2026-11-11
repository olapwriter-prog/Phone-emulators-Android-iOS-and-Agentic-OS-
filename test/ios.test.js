import test from 'node:test';
import assert from 'node:assert/strict';
import { up, logged } from './helpers.js';

test('apps suspend shortly after leaving the foreground, except audio/navigation', () => {
  const d = up('iphone-15');
  d.os.launch('safari'); d.os.launch('music'); d.os.launch('maps'); d.os.home();
  d.run(10);
  assert.equal(d.os.procs.get('safari').state, 'suspended');
  assert.equal(d.os.procs.get('music').state, 'background');
  assert.equal(d.os.procs.get('maps').state, 'background');
});

test('jetsam kills suspended apps under memory pressure, never the foreground', () => {
  const d = up('iphone-12'); // 4 GB
  for (const a of ['safari', 'camera', 'photos', 'mail', 'tv', 'game']) { d.os.launch(a); d.run(10); }
  assert.ok(logged(d, /jetsam/));
  assert.equal(d.os.foreground, 'game');
});

test('Face ID needs the passcode after restart and passcode lockout escalates', () => {
  const d = up('iphone-16', { unlock: false });
  assert.match(d.os.unlock({ method: 'face' }).msg, /passcode/);
  for (let i = 0; i < 5; i++) d.os.unlock({ pin: '9999' });
  assert.match(d.os.unlock({ pin: '0000' }).msg, /locked out/);
  d.run(61);
  assert.equal(d.os.unlock({ pin: '0000' }).ok, true);
});

test('Low Power Mode prompt at 20%, auto-off when charged to 80%', () => {
  const d = up('iphone-14', { battery: 0.21 });
  d.os.settings.autoLockSec = 0; d.os.launch('tv');
  d.runUntil(x => x.os.settings.lowPower, 3 * 3600, 5);
  assert.ok(d.hw.battery.level <= 0.205);
  d.plug('usb-pd-20w');
  d.runUntil(x => !x.os.settings.lowPower, 4 * 3600, 10);
  assert.ok(d.hw.battery.level >= 0.79);
});

test('Optimized Battery Charging holds at 80%; a lower charge limit is honoured', () => {
  const d = up('iphone-16-pro', { battery: 0.5 });
  d.plug('usb-pd-30w'); d.os.screenOff(); d.run(3 * 3600, 10);
  assert.ok(Math.abs(d.hw.battery.level - 0.8) < 0.01);
  d.os.set('optimizedCharging', false); d.os.set('chargeLimit', 0.9);
  d.run(3 * 3600, 10);
  assert.ok(Math.abs(d.hw.battery.level - 0.9) < 0.01);
});

test('overheating shows the temperature screen and blocks apps', () => {
  const d = up('iphone-15-pro', { env: { ambientC: 40, sunW: 3 } });
  d.os.settings.autoLockSec = 0;
  d.os.launch('game');
  d.runUntil(x => x.os.coolDown, 3600, 1);
  assert.ok(d.os.coolDown);
  assert.equal(d.os.launch('safari').ok, false);
});
