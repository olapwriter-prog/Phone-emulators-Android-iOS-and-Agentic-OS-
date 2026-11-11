import test from 'node:test';
import assert from 'node:assert/strict';
import { up } from './helpers.js';

test('model size follows RAM; NPU vs CPU fallback', () => {
  assert.equal(up('agentic-one').os.model.params, '8B');
  assert.equal(up('agentic-pocket').os.model.params, '1B');
  assert.equal(up('pixel-6', { os: 'agentic' }).os.model.accel, 'CPU');
});

test('sensitive steps wait for an unlocked human approval', () => {
  const d = up('agentic-one');
  const t = d.os.submit('text Sam I am late').task;
  d.run(60, 0.5);
  assert.equal(t.status, 'awaiting-approval');
  d.os.lock();
  assert.equal(d.os.approve(t.id).ok, false);
  d.os.unlock({ pin: '0000' });
  assert.equal(d.os.approve(t.id).ok, true);
  d.run(30, 0.5);
  assert.equal(t.status, 'done');
  assert.ok(d.os.audit.some(e => e.step === 'messages.send' && e.approved));
  assert.equal(d.os.grants.length, 0, 'task-scoped grants are revoked');
});

test('a parked approval does not block other tasks', () => {
  const d = up('agentic-one');
  const a = d.os.submit('call Sam').task;
  const b = d.os.submit('summarize the news').task;
  d.run(180, 0.5);
  assert.equal(a.status, 'awaiting-approval');
  assert.equal(b.status, 'done');
});

test('low battery defers low-priority work until charging', () => {
  const d = up('agentic-one', { battery: 0.12 });
  const t = d.os.submit('clean up old files', { priority: 'low' }).task;
  d.run(30, 0.5);
  assert.equal(t.status, 'deferred');
  d.plug('usb-pd-30w');
  d.run(60, 0.5);
  assert.notEqual(t.status, 'deferred');
});

test('no network: tool steps wait; local inference still works', () => {
  const d = up('agentic-one');
  d.os.set('airplane', true);
  const t = d.os.submit('summarize the news').task;
  d.run(30, 0.5);
  assert.equal(t.note, 'waiting for network');
  d.os.set('airplane', false); d.os.set('wifi', true);
  d.run(120, 0.5);
  assert.equal(t.status, 'done');
});

test('hot device offloads to cloud only when privacy policy allows', () => {
  const d = up('agentic-one');
  d.hw.thermal.tempC = d.hw.limits.end + 1;
  d.os.submit('summarize the news', { cloud: true });
  d.run(30, 0.5);
  assert.ok(d.os.audit.some(e => e.mode === 'cloud'));
  const d2 = up('agentic-one');
  d2.hw.thermal.tempC = d2.hw.limits.end + 1;
  d2.os.submit('summarize the news');
  d2.run(30, 0.5);
  assert.ok(!d2.os.audit.some(e => e.mode === 'cloud'));
});

test('memory pressure evicts the model, which reloads on demand', () => {
  const d = up('agentic-pocket');
  d.os.modelLoaded = false; // simulate eviction
  const t = d.os.submit('what is the weather').task;
  d.run(60, 0.5);
  assert.ok(d.os.modelLoaded);
  assert.equal(t.status, 'done');
});
