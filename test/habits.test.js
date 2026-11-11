// Habits on agenticOS: Jaccard answers, routines from repeated sessions, widgets for frequent
// questions, country customs, and the almanac's astronomy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Device } from '../src/index.js';
import { contentWords, jaccard, compile, programSource } from '../src/os/agentos/habits.js';
import { nakshatra, tithi, rahuKaal, almanac } from '../src/os/agentos/almanac.js';

function phone(opts = {}) {
  const d = new Device('oneplus-6', { os: 'agentic', maxEvents: 3000, ...opts });
  d.os.boot();
  d.runUntil(x => x.os.state === 'on', 300, 0.25);
  return d;
}
const morning = (d, vastu = 'vastu tip') => { d.run(6 * 3600, 60); d.exec('tell me the time'); d.run(40); d.exec('nakshatra'); d.run(40); d.exec(vastu); };

test('almanac: nakshatra and tithi on known dates; rahu kaal by weekday', () => {
  const paushPurnima = Date.UTC(2024, 0, 25, 12, 30); // 25 Jan 2024 18:00 IST, full moon in Pushya
  assert.equal(nakshatra(paushPurnima).name, 'Pushya');
  assert.equal(tithi(paushPurnima).name, 'Purnima');
  const diwali = Date.UTC(2024, 10, 1, 12, 30);        // 1 Nov 2024, Amavasya in Swati
  assert.equal(nakshatra(diwali).name, 'Swati');
  assert.equal(tithi(diwali).name, 'Amavasya');
  assert.equal(rahuKaal(1), '07:30–09:00');            // Monday
  assert.equal(rahuKaal(0), '16:30–18:00');            // Sunday
  assert.match(almanac('hijri_date', {}, Date.UTC(2026, 10, 11, 4), 'SA'), /1448 AH/);
});

test('Jaccard: content words, stop words and aliases', () => {
  assert.deepEqual([...contentWords("What's the time now?")], ['time']);
  assert.equal(jaccard(contentWords('tell me the time'), contentWords('what time is it')), 1);
  assert.equal(jaccard(contentWords('which nakshatra is it today'), contentWords("what is today's nakshatra")), 1);
  assert.ok(jaccard(contentWords('text mum the time'), contentWords('what time is it')) < 0.5);
});

test('simple questions are answered by similarity, before the classifier and the LLM', () => {
  const d = phone();
  const t0 = d.clock;
  assert.match(d.exec('tell me the time'), /IST\) \[jaccard 1 ~ "(what is the time|what time is it)/);
  assert.match(d.exec('which nakshatra is it today'), /^done: Nakshatra \w+.*\[jaccard 1/);
  assert.equal(d.clock, t0, 'no model time spent');
});

test('India: the time is followed by nakshatra and vastu suggestions; auto mode answers them', () => {
  const d = phone();
  assert.match(d.exec('what time is it'), /also ask: nakshatra · vastu/);
  d.exec('set followups auto');
  const r = d.exec('what time is it');
  assert.match(r, /\+ Nakshatra .*\[IN custom\]/);
  assert.match(r, /\+ Vastu .*\[IN custom\]/);
});

test('every country follows the time with its own custom', () => {
  const d = phone();
  d.exec('set followups auto');
  d.exec('country CN'); assert.match(d.exec('time'), /CST\)[\s\S]*lunar date[\s\S]*Feng shui/);
  d.exec('country SA'); assert.match(d.exec('time'), /Hijri: .* AH/);
  d.exec('country JP'); assert.match(d.exec('time'), /令和[\s\S]*Rokuyō|Rokuyō/);
  d.exec('country US'); assert.doesNotMatch(d.exec('time'), /\+ /);
});

test('a sequence repeated in 3 sessions becomes a routine, run as code, with the arguments used', () => {
  const d = phone();
  for (let i = 0; i < 3; i++) morning(d, 'vastu for kitchen');
  const r = [...d.os.habits.routines.values()][0];
  assert.deepEqual(r.chain, ['time_now', 'nakshatra', 'vastu']);
  d.run(6 * 3600, 60);
  const out = d.exec('time');
  assert.match(out, /\+ Nakshatra .*\[routine \d+: you usually ask nakshatra next\]/);
  assert.match(out, /\+ Vastu \(kitchen\)/);
  assert.match(d.exec(`show routine ${r.id}`), /tool\("vastu", \{"topic":"kitchen"\}\)/);
  assert.ok(d.os.ledger.lines.some(l => l.payload.startsWith('routine learned: ')));
});

test('one long session counts once: no looping routines', () => {
  const d = phone();
  for (let i = 0; i < 5; i++) { d.exec('time'); d.exec('nakshatra'); d.exec('vastu'); }
  assert.equal(d.os.habits.routines.size, 0);
});

test('a question asked 3 times in a week becomes a widget that refreshes when stale', () => {
  const d = phone();
  for (let i = 0; i < 3; i++) { d.run(4 * 3600, 60); d.exec('what time is it'); }
  const w = d.os.habits.widgets[0];
  assert.equal(w.title, 'time');
  assert.equal(w.everyS, 60);
  d.run(61);
  const first = w.lastText;
  d.run(120);
  assert.notEqual(w.lastText, first, 'the time widget refreshed');
  assert.match(d.exec('widgets'), /\[\d+\] time · every 60 s/);
  assert.match(d.exec(`unpin widget ${w.id}`), /unpinned/);
  assert.equal(d.os.snapshot().widgets.length, 0);
});

test('widgets and routines can only read: the sandbox refuses calls, texts and payments', () => {
  const tierOf = t => ({ time_now: 'Low', call: 'High', send_sms: 'High' })[t];
  const run = compile(programSource('x', ['time_now', 'call'], 'test'), tierOf);
  assert.throws(() => run(() => 'ok'), /call is High tier/);
  assert.throws(() => compile('function run(tool) { return fetch("x") }', tierOf), /outside the sandbox/);
  assert.doesNotThrow(() => compile(programSource('x', ['time_now'], 'test', () => ({ topic: 'fetch this' })), tierOf));
  const d = phone();
  d.exec('save Mum as +919876543210');
  for (let i = 0; i < 4; i++) { d.run(3600, 60); d.exec('call mum'); }
  assert.ok(!d.os.habits.widgets.some(w => w.tools.includes('call')), 'no widget for a High tier tool');
});
