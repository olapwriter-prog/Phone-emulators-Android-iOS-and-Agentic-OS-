// agenticOS (github.com/olapwriter-prog/agenticOS): the simulator must behave like agentd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Device } from '../src/index.js';
import { Classifier } from '../src/os/agentos/understand.js';
import { SEEDS } from '../src/os/agentos/seeds.js';
import { IntentTable } from '../src/os/agentos/intents.js';
import { Ledger, sha256 } from '../src/os/agentos/ledger.js';

function phone(id = 'oneplus-6', opts = {}) {
  const d = new Device(id, { os: 'agentic', battery: 0.8, maxEvents: 3000, ...opts });
  d.os.boot();
  d.runUntil(x => x.os.state === 'on', 300, 0.25);
  return d;
}
const warm = d => d.runUntil(x => x.os.snapshot().models.every(m => m.state === 'ready'), 4 * 3600, 1);

test('only phones postmarketOS supports with a working modem run agenticOS', () => {
  assert.doesNotThrow(() => new Device('pinephone', { os: 'agentic' }));
  assert.doesNotThrow(() => new Device('oneplus-6t', { os: 'agentic' }));
  assert.throws(() => new Device('pixel-9', { os: 'agentic' }), /cannot run agentic/);
  assert.throws(() => new Device('volla-x23', { os: 'agentic' }), /cannot run agentic/); // oFono, no backend yet
});

test('classifier port matches agentd on its held-out questions (qa.rs HELD_OUT)', () => {
  const c = new Classifier();
  for (const [l, ps] of SEEDS) for (const p of ps) c.train(l, p);
  const held = [['how many texts did Mum send me', 'q.msgs_from'], ['how many promotional texts did I get', 'q.strangers'],
    ['how many calls did Ravi make to me', 'q.calls_from'], ['who texted me the most', 'q.top_sender'],
    ['how many people in my contacts texted me', 'q.contacts_texted'], ['did Mum call me', 'q.did_call'],
    ['how many texts did I send', 'q.msgs_sent'], ["what was Ravi's last message", 'q.last_from']];
  for (const [q, l] of held) assert.equal(c.decide(q, 0.6)?.[0], l, q);
  assert.equal(c.decide('how is the network', 0.6), null, 'unsure: goes to the LLM');
});

test('intent table: two slots split on the literal between them', () => {
  const t = new IntentTable();
  assert.deepEqual(t.resolve('text asha hello there'), { tool: 'send_sms', args: { to: 'asha', text: 'hello there' } });
  assert.deepEqual(t.resolve('Call Mum.'), { tool: 'call', args: { to: 'Mum' } });
  assert.equal(t.resolve('please call mum'), null);
});

test('ledger: SHA-256 chain verifies and names the first edited line', () => {
  assert.equal(sha256(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const l = new Ledger();
  for (const p of ['a', 'b', 'c', 'd']) l.append(p);
  assert.equal(l.verify(), 4);
  l.lines[2].payload = 'C';
  assert.throws(() => l.verify(), /broken at seq 2/);
  assert.throws(() => l.append('tab\there'), /tab or newline/);
});

test('stage machine: chat wakes, idle sleeps, the charger brings Deep, power loss winds down', () => {
  const d = phone();
  assert.equal(d.os.stage, 'Asleep');
  d.exec('signal');
  assert.equal(d.os.stage, 'Active');
  d.run(121);
  assert.equal(d.os.stage, 'Asleep');
  d.plug('usb-pd-20w'); d.run(2);
  assert.equal(d.os.stage, 'Deep');
  assert.equal(d.os.governor, 'performance');
  d.unplug(); d.run(3);
  assert.equal(d.os.stage, 'Asleep');
  assert.ok(d.os.ledger.lines.some(l => l.payload === 'stage Deep -> WindingDown on PowerLost'));
});

test('High actions: approval key semantics from agentd', () => {
  const d = phone();
  d.exec('save Mum as +919876543210');
  assert.match(d.exec('call mum'), /approval required \(id 1\)/);
  assert.match(d.exec('call mum'), /approval required \(id 1\)/, 'asking twice does not queue twice');
  assert.match(d.holdKey(300), /nothing approved/);
  assert.match(d.holdKey(2500), /approved #1 call/);
  assert.match(d.exec('call mum'), /^done: calling Mum/);
  assert.match(d.exec('call mum'), /approval required \(id 2\)/, 'one approval runs one action once');
  d.exec('text mum a'); d.exec('text mum b');
  assert.match(d.holdKey(2500), /3 actions waiting; the key approves only when one is/);
  assert.match(d.exec('press 3'), /approved #3/);
  assert.match(d.exec('decline 4'), /declined #4/);
  d.run(601);
  assert.equal(d.exec('pending'), 'nothing waiting', 'pending items expire after 10 minutes');
});

test('routing: phrase, then classifier, then code answers, then the LLM (slow, on the small model)', () => {
  const d = phone();
  warm(d);
  d.exec('save Mum as +919876543210');
  d.exec('sim-sms +919876543210|dinner at 8?');
  assert.match(d.exec('read my messages'), /\[intent\]/);
  assert.match(d.exec('could you put volume at 30'), /volume 30% \[classifier\]/);
  const t0 = d.clock;
  assert.equal(d.exec('how many texts did Mum send me'), 'answer: Mum sent you 1 text.');
  assert.equal(d.clock, t0, 'answered by code, no model time');
  const r = d.exec('how is the network');
  assert.match(r, /\[model, \d+\.\d s\]/);
  assert.ok(d.clock - t0 > 10 && d.clock - t0 < 90, `LLM took ${d.clock - t0}s`);
});

test('learning: an approved request becomes a shortcut; a correction is learned', () => {
  const d = phone();
  warm(d);
  d.exec('save Mum as +919876543210');
  d.exec('ring my mother'); d.holdKey();
  assert.match(d.exec('ring my mother'), /\[shortcut\]/);
  d.exec('how is the network');
  assert.match(d.exec('that was wrong'), /was wrong/);
  d.exec('signal');
  assert.match(d.exec('how is the network'), /\[shortcut\]/);
});

test('models follow RAM, stage and charger; warm-up reads the system prompt once', () => {
  const big = phone('oneplus-6');
  assert.deepEqual(big.os.modelSpecs.map(m => m[0]), ['qwen3.5-4b']);
  const tiny = phone('pinephone');
  assert.deepEqual(tiny.os.modelSpecs.map(m => m[0]), ['qwen2.5-0.5b']);
  const s = warm(big);
  assert.ok(s > 60, `a 4B model reads 897 prompt tokens slowly on a Snapdragon 845 (${s}s)`);
  assert.ok(big.os.speed(big.os.models['qwen3.5-4b'], 'gen') > tiny.os.speed(tiny.os.models['qwen2.5-0.5b'], 'gen') / 20);
});

test('notifications: quiet hours hold texts; calls always ring; the budget runs out', () => {
  const d = phone();
  d.os.cfg.startMinute = 23 * 60;
  assert.match(d.exec('sim-sms +918000000001|promo'), /held for the digest/);
  assert.match(d.exec('sim-call +918000000002'), /incoming call .* \(alerted\)/);
  d.os.cfg.startMinute = 12 * 60;
  for (let i = 0; i < 5; i++) assert.match(d.exec(`sim-sms +9180000000${10 + i}|hi`), /alerted/);
  assert.match(d.exec('sim-sms +918000000020|sixth'), /held/);
  assert.match(d.exec('digest'), /sms \(2\)/);
});

test('airplane mode stops calls; a call that rings out is missed', () => {
  const d = phone();
  d.exec('sim-call +919000000001');
  d.run(31);
  assert.match(d.exec('missed calls'), /missed: \+919000000001/);
  d.exec('airplane mode on');
  d.exec('save Mum as +919876543210');
  d.exec('call mum'); d.holdKey();
  assert.match(d.exec('call mum'), /not done: airplane mode is on/);
});

test('agentd never suspends the system: standby costs far more than stock Android', () => {
  const a = phone('oneplus-6'), b = new Device('oneplus-6', { battery: 0.8 });
  b.os.boot(); b.runUntil(x => x.os.state === 'on', 300, 0.25); b.os.unlock({ pin: '0000' }); b.os.screenOff();
  a.run(12 * 3600, 30); b.run(12 * 3600, 30);
  assert.equal(a.os.state, 'on');
  assert.ok((0.8 - a.hw.battery.level) > 2 * (0.8 - b.hw.battery.level));
});

test('nightly training starts on the charger and (as in agentd today) stops a tick later with < 20 new requests', () => {
  const d = phone();
  d.exec('save Mum as +919876543210'); d.exec('call mum'); d.holdKey(); // one confirmed request
  d.plug('usb-pd-20w');
  d.run(200, 1);
  const lines = d.os.ledger.lines.map(l => l.payload);
  assert.ok(lines.some(l => l.startsWith('training qwen3.5-4b on 1 confirmed')));
  assert.ok(lines.some(l => /training stopped \(1 new confirmed requests since the last run \(needs 20\)\)/.test(l)));
});
