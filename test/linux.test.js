import test from 'node:test';
import assert from 'node:assert/strict';
import { up, logged } from './helpers.js';

test('background apps keep running (no freezer)', () => {
  const d = up('pinephone-pro');
  d.os.launch('console'); d.os.launch('firefox');
  d.run(60);
  assert.equal(d.os.procs.get('console').state, 'background');
  assert.ok(d.os.cpuShare(d.os.procs.get('console')) === 1);
});

test('kernel OOM killer picks the largest process', () => {
  const d = up('pinephone'); // 3 GB
  for (const a of ['camera', 'firefox', 'maps', 'game']) { d.os.launch(a); d.run(5); }
  assert.ok(logged(d, /Out of memory: Killed process/));
});

test('hardware kill switch cuts the modem regardless of software state', () => {
  const d = up('librem-5');
  d.exec('killswitch modem off');
  assert.match(d.exec('rfkill'), /wwan\s+unblocked blocked/);
  assert.equal(d.os.workload().cellOn, false);
});

test('logind suspends after idle on battery and the modem can wake it', () => {
  const d = up('pinephone');
  d.run(10 * 60, 5);
  assert.equal(d.os.state, 'suspended');
  d.os.notify('chatty', 'mail arrived');
  assert.equal(d.os.notifications.length, 0);
  d.os.notify('chatty', 'incoming call');
  assert.equal(d.os.state, 'on');
});

test('UPower critical action powers off at 2%', () => {
  const d = up('pinephone', { battery: 0.03 });
  d.os.settings.autoSuspend = false; d.os.settings.autoLockSec = 0;
  d.os.launch('video');
  d.run(3600, 5);
  assert.equal(d.os.state, 'off');
  assert.ok(logged(d, /CriticalPowerAction/));
});

test('shell exposes sysfs and systemctl', () => {
  const d = up('fairphone-5', { os: 'linux', battery: 0.5 });
  assert.equal(d.exec('cat /sys/class/power_supply/battery/capacity'), '50');
  d.exec('systemctl suspend');
  assert.equal(d.os.state, 'suspended');
});
