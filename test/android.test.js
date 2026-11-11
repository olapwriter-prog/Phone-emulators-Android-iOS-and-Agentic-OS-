import test from 'node:test';
import assert from 'node:assert/strict';
import { up, logged } from './helpers.js';

test('fingerprint unlock needs the PIN first after boot', () => {
  const d = up('pixel-9', { unlock: false });
  assert.equal(d.os.unlock({ method: 'fingerprint' }).ok, false);
  assert.equal(d.os.unlock({ pin: '0000' }).ok, true);
  d.os.lock();
  assert.equal(d.os.unlock({ method: 'fingerprint' }).ok, true);
});

test('backgrounded apps are cached and frozen; lmkd kills cached apps first', () => {
  const d = up('redmi-note-13'); // 6 GB
  d.os.launch('music'); d.os.home();
  for (const a of ['chrome', 'camera', 'youtube', 'gmail', 'photos', 'game']) { d.os.launch(a); d.run(15); }
  assert.ok(logged(d, /lmkd/));
  assert.ok(d.os.procs.has('music'), 'foreground-service music survives');
  assert.ok([...d.os.procs.values()].some(p => p.state === 'cached'));
});

test('Doze walks light → deep idle when stationary and defers normal pushes', () => {
  const d = up('pixel-8');
  d.os.screenOff('power button');
  d.run(40 * 60, 5);
  assert.equal(d.os.doze, 'IDLE');
  d.os.notify('messages', 'hello');
  assert.equal(d.os.deferredPush.length, 1);
  d.os.notify('messages', 'urgent call');
  assert.equal(d.os.notifications.at(-1).text, 'urgent call');
});

test('motion keeps Doze in light mode', () => {
  const d = up('pixel-8', { env: { moving: true } });
  d.os.screenOff();
  d.run(60 * 60, 10);
  assert.equal(d.os.doze, 'LIGHT_IDLE');
});

test('Battery Saver turns on at 15% and off after charging to 90%', () => {
  const d = up('galaxy-a55', { battery: 0.16 });
  d.os.settings.autoLockSec = 0; d.os.launch('youtube');
  d.runUntil(x => x.os.settings.lowPower, 3 * 3600, 5);
  assert.ok(d.hw.battery.level <= 0.151);
  d.plug('usb-pd-30w');
  d.runUntil(x => !x.os.settings.lowPower, 6 * 3600, 10);
  assert.ok(d.hw.battery.level >= 0.9);
});

test('Pixel adaptive charging holds at 80%', () => {
  const d = up('pixel-9', { battery: 0.7 });
  d.plug('usb-pd-30w'); d.os.screenOff(); d.run(3 * 3600, 10);
  assert.ok(Math.abs(d.hw.battery.level - 0.8) < 0.01);
});

test('adb-style shell', () => {
  const d = up('pixel-9');
  assert.equal(d.exec('getprop ro.product.model'), 'Pixel 9');
  assert.match(d.exec('dumpsys battery'), /level: \d+/);
  d.exec('am start -n com.google.android.youtube/.Main');
  assert.equal(d.os.foreground, 'youtube');
  d.exec('input keyevent KEYCODE_POWER');
  assert.equal(d.os.screenOn, false);
});
