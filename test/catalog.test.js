import test from 'node:test';
import assert from 'node:assert/strict';
import { DEVICES, supportedOS, OS_REGISTRY, Device } from '../src/index.js';

test('catalog covers every OS family', () => {
  for (const os of Object.keys(OS_REGISTRY)) assert.ok(DEVICES.some(d => d.os === os), `no device ships ${os}`);
});

test('device ids are unique and specs are sane', () => {
  const ids = new Set();
  for (const d of DEVICES) {
    assert.ok(!ids.has(d.id), `duplicate ${d.id}`); ids.add(d.id);
    assert.ok(d.soc.perf > 0 && d.ramGB > 0 && d.massG > 0, d.id);
    if (d.display) assert.ok(d.display.ppi > 100 && d.display.hz >= d.display.minHz, d.id);
    if (d.battery) assert.ok(d.battery.wh > 3 && d.charge.wiredW > 0, d.id);
  }
});

test('every model boots on every OS it supports', () => {
  for (const spec of DEVICES) for (const os of supportedOS(spec)) {
    const d = new Device(spec.id, { os });
    d.os.boot();
    const t = d.runUntil(x => x.os.state === 'on', 300, 0.25);
    assert.equal(d.os.state, 'on', `${spec.id}/${os}`);
    assert.ok(t > 2 && t < 120, `${spec.id}/${os} boot ${t}s`);
  }
});

test('unsupported OS is rejected', () => {
  assert.throws(() => new Device('iphone-16', { os: 'android' }), /cannot run android/);
});
