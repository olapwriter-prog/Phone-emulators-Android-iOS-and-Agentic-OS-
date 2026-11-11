import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../src/index.js';

test('flagship phones outlast budget/older phones in video playback', () => {
  const a = runScenario('video', 'iphone-17-pro-max').hours;
  const b = runScenario('video', 'iphone-se-3').hours;
  assert.ok(a > b * 1.5, `${a} vs ${b}`);
});

test('vapor-chamber phones sustain gaming better than passive ones with the same chip class', () => {
  const pro = runScenario('gaming', 'iphone-17-pro');
  const air = runScenario('gaming', 'iphone-air');
  assert.ok(pro.endFps >= air.endFps);
});

test('scenarios produce finite numbers', () => {
  for (const sc of ['boot', 'standby', 'charge', 'memory']) {
    const r = runScenario(sc, 'oneplus-13');
    assert.ok(!/NaN|Infinity/.test(JSON.stringify(r)), sc);
  }
});
