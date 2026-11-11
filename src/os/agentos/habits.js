// Habits: answering simple questions by similarity, and turning what a person does again and
// again into code the phone runs by itself.
//
//   1. Question bank + Jaccard similarity. Every phrasing the phone has answered (seeded with a
//      few per tool, then every request that worked) is kept as a set of content words. A new
//      request whose word set overlaps a known one by at least `minJaccard` runs the same tool:
//      no classifier pass, no LLM.
//   2. Routines. When a person asks B within a few minutes after A, again and again (default 3
//      times), the phone writes a routine: a short program that answers A and then B (and C, if
//      B is in turn usually followed by C). After that, asking A answers the whole chain.
//   3. Widgets. A question asked often (default 3 times in 7 days) becomes a widget: a program
//      that fetches the answer (and its routine's follow-ups) and is refreshed as often as the
//      answer goes stale (the time every minute, the nakshatra every half hour, vastu daily).
//
// Routines and widgets are generated source code, compiled into a sandbox that can only call
// read-only (Low tier) tools: a widget can never call, text or pay.

import { STALE_AFTER } from './almanac.js';

const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'am', 'was', 'be', 'what', 'whats', 'which', 'me', 'tell', 'please', 'can', 'could',
  'would', 'you', 'i', 'it', 'its', 'my', 'for', 'of', 'to', 'do', 'does', 'now', 'show', 'give', 'get', 'let', 'know', 'current',
  'currently', 'right', 'just', 'hey', 'ok', 'okay', 'kindly', 'so', 'at', 'on', 'in', 'and', 'or', 'some', 'any', 'tip', 'suggest', 'suggestion', 'advice']);
const ALIAS = { clock: 'time', hour: 'time', o: 'time', moon: 'nakshatra', star: 'nakshatra', nakshatram: 'nakshatra', vaastu: 'vastu', vasthu: 'vastu',
  rahukaal: 'rahu', rahukalam: 'rahu', kalam: 'kaal', islamic: 'hijri', chinese: 'lunar', fengshui: 'feng' };

function stem(w) {
  for (const s of ['ing', 'ed', 'es', 's']) if (w.length > s.length + 3 && w.endsWith(s)) return w.slice(0, -s.length);
  return w;
}

/** The content words of a request, as a set. */
export function contentWords(text) {
  const out = new Set();
  for (let w of text.toLowerCase().replace(/'s\b/g, '').replace(/'/g, '').split(/[^\p{L}\p{N}]+/u)) {
    if (!w || STOP.has(w)) continue;
    w = ALIAS[w] || stem(w);
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Phrasings the phone starts with. Every request that works is added to these. */
const BANK_SEEDS = {
  time_now: ['what is the time', 'tell me the time', 'time please', 'what time is it now', 'current time'],
  nakshatra: ["what is today's nakshatra", 'which nakshatra is it today', 'moon star today', 'nakshatra today'],
  panchang: ["today's panchang", 'panchang for today', 'tithi today'],
  rahu_kaal: ['when is rahu kaal today', 'rahu kaal timing'],
  vastu: ['vastu tip', 'any vastu advice', 'vastu suggestion for the house'],
  hijri_date: ['islamic date today', 'what is the hijri date'],
  lunar_date: ['chinese lunar date', 'lunar calendar date today'],
  feng_shui: ['feng shui tip for today'],
  rokuyo: ['rokuyo today', 'is today a lucky day in the japanese calendar'],
  phone_status: ['how is my signal', 'network status'],
  read_messages: ['any new texts', 'show my texts'],
  weather: ['how is the weather', 'weather today'],
};

export class Habits {
  constructor({ tierOf, minJaccard = 0.5, routineAfter = 3, widgetAfter = 3, followWithinS = 300, windowDays = 7 } = {}) {
    this.tierOf = tierOf;
    this.cfg = { minJaccard, routineAfter, widgetAfter, followWithinS, windowDays };
    this.bank = [];            // { words:Set, text, action, learned }
    for (const [tool, ps] of Object.entries(BANK_SEEDS)) for (const p of ps) this.bank.push({ words: contentWords(p), text: p, action: { tool, args: {} }, learned: false });
    this.history = [];         // { t, text, tool, args }
    this.pairs = new Map();    // "A>B" -> count
    this.routines = new Map(); // head tool -> { id, chain, count, version, source, run }
    this.widgets = [];         // { id, tools, title, everyS, source, run, lastAt, lastText, version, pinned }
    this.nextId = 1;
  }

  /** The best match in the question bank, or null. */
  match(text) {
    const w = contentWords(text);
    if (!w.size) return null;
    let best = null;
    for (const e of this.bank) {
      const s = jaccard(w, e.words);
      if (!best || s > best.score || (s === best.score && e.learned && !best.entry.learned)) best = { score: s, entry: e };
    }
    if (!best || best.score < this.cfg.minJaccard) return null;
    const { action } = best.entry;
    return { action: { tool: action.tool, args: { ...action.args } }, score: +best.score.toFixed(2), like: best.entry.text };
  }

  /**
   * A request that worked: remember its phrasing, its place in this session, and how often it
   * comes. A session is a run of requests with gaps of at most `followWithinS`; what a person
   * asks in a session, in order, after its first request is what a routine for that first
   * request answers. Counting from the session's first request only keeps routines from
   * looping (time → nakshatra → vastu never turns into vastu → time).
   */
  observe(t, text, action) {
    const words = contentWords(text);
    if (words.size && !this.bank.some(e => e.text === text.toLowerCase())) this.bank.push({ words, text: text.toLowerCase(), action: { tool: action.tool, args: { ...action.args } }, learned: true });
    this.history.push({ t, text, tool: action.tool, args: action.args });
    if (this.history.length > 500) this.history.shift();
    const changes = [];
    const s = this.session;
    if (!s || t - s.last > this.cfg.followWithinS) this.session = { last: t, chain: [action.tool], counted: new Set() };
    else {
      s.last = t;
      if (!s.chain.includes(action.tool) && s.chain.length < 4) {
        s.chain.push(action.tool);
        const key = s.chain.join('>');
        if (!s.counted.has(key)) { s.counted.add(key); this.pairs.set(key, (this.pairs.get(key) || 0) + 1); }
        const r = this.learnRoutine(s.chain[0]);
        if (r) changes.push(r);
        this.dropCoveredWidgets();
      }
    }
    for (const r of this.routines.values()) if (r.chain.includes(action.tool) && r.argsKey !== this.argsKey(r.chain)) this.refreshRoutine(r);
    for (const w of this.widgets) if (w.tools.includes(action.tool) && w.argsKey !== this.argsKey(w.tools)) this.rebuildWidget(w, w.tools);
    const w = this.learnWidget(t, action.tool);
    if (w) changes.push(w);
    return changes;
  }

  /** The longest sequence starting with `head`, all read-only, seen in at least `routineAfter` sessions. */
  chainFrom(head) {
    let best = [head];
    for (const [k, n] of this.pairs) {
      const chain = k.split('>');
      if (chain[0] === head && n >= this.cfg.routineAfter && chain.length > best.length && chain.every(x => this.safe(x))) best = chain;
    }
    return best;
  }

  /** The arguments a tool was last asked with ("vastu for kitchen" → {topic: kitchen}). */
  lastArgs = tool => ({ ...([...this.history].reverse().find(h => h.tool === tool)?.args || {}) });

  safe(tool) { return this.tierOf(tool) === 'Low'; }

  argsKey(tools) { return JSON.stringify(tools.map(this.lastArgs)); }

  refreshRoutine(r) {
    r.version++;
    r.source = programSource(`routine: after "${r.chain[0]}" you usually ask ${r.chain.slice(1).join(', then ')}`, r.chain, `learned from ${r.count} sessions where you asked them in this order`, this.lastArgs);
    r.run = compile(r.source, this.tierOf);
    r.argsKey = this.argsKey(r.chain);
  }

  learnRoutine(head) {
    if (!this.safe(head)) return null;
    const chain = this.chainFrom(head);
    if (chain.length < 2) return null;
    const old = this.routines.get(head);
    if (old && old.chain.join() === chain.join()) return null;
    const count = this.pairs.get(chain.join('>'));
    const r = { id: old?.id ?? this.nextId++, chain, count, version: (old?.version || 0) + 1 };
    r.source = programSource(`routine: after "${head}" you usually ask ${chain.slice(1).join(', then ')}`, chain, `learned from ${count} sessions where you asked them in this order`, this.lastArgs);
    r.run = compile(r.source, this.tierOf);
    r.argsKey = this.argsKey(chain);
    this.routines.set(head, r);
    // a widget showing the head now also shows what follows it
    for (const w of this.widgets) if (w.tools[0] === head) this.rebuildWidget(w, chain);
    return { kind: 'routine', text: `routine ${r.id} v${r.version}: ${chain.join(' → ')} (seen ${count} times)` };
  }

  /** A widget whose tools are all shown by another widget is redundant. */
  dropCoveredWidgets() {
    this.widgets = this.widgets.filter(w => !this.widgets.some(o => o !== w && o.tools.length > w.tools.length && w.tools.every(x => o.tools.includes(x))));
  }

  learnWidget(t, tool) {
    if (!this.safe(tool) || this.widgets.some(w => w.tools.includes(tool))) return null;
    const since = t - this.cfg.windowDays * 86400;
    const n = this.history.filter(h => h.tool === tool && h.t >= since).length;
    if (n < this.cfg.widgetAfter) return null;
    const chain = this.routines.get(tool)?.chain || [tool];
    const w = { id: this.nextId++, tools: [], version: 0, pinned: true, lastAt: -Infinity, asked: n };
    this.rebuildWidget(w, chain);
    this.widgets.push(w);
    return { kind: 'widget', text: `widget ${w.id}: ${w.title} (asked ${n} times in ${this.cfg.windowDays} days; refreshes every ${fmtEvery(w.everyS)})` };
  }

  rebuildWidget(w, chain) {
    w.tools = chain.filter(x => this.safe(x));
    w.title = w.tools.map(x => ({ time_now: 'time' }[x] || x.replace(/_/g, ' '))).join(' · ');
    w.everyS = Math.min(...w.tools.map(x => STALE_AFTER[x] || 900));
    w.version++;
    w.source = programSource(`widget: ${w.title}`, w.tools, `asked often; refreshed every ${fmtEvery(w.everyS)}`, this.lastArgs);
    w.run = compile(w.source, this.tierOf);
    w.argsKey = this.argsKey(w.tools);
    w.lastAt = -Infinity;
  }

  /** Refresh widgets that have gone stale. `call(tool, args)` runs a tool. Returns the ones refreshed. */
  refresh(t, call) {
    const done = [];
    for (const w of this.widgets) {
      if (!w.pinned || t - w.lastAt < w.everyS) continue;
      w.lastText = w.run(call).join('\n');
      w.lastAt = t;
      done.push(w);
    }
    return done;
  }
}

const fmtEvery = s => (s % 86400 === 0 ? `${s / 86400} d` : s % 3600 === 0 ? `${s / 3600} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

/** The program the phone writes for a routine or widget. Plain code over read-only tools. */
export function programSource(title, tools, why, argsOf = () => ({})) {
  return [
    `// ${title}`,
    `// written by agentd: ${why}`,
    `// runs in the sandbox; only read-only (Low tier) tools can be called`,
    `function run(tool) {`,
    `  const out = [];`,
    ...tools.map(x => `  out.push(tool(${JSON.stringify(x)}, ${JSON.stringify(argsOf(x))}));`),
    `  return out;`,
    `}`,
  ].join('\n');
}

/** Compile generated source. The only thing it can reach is `tool`, and only Low tier tools. */
export function compile(source, tierOf) {
  const code = source.replace(/"(?:[^"\\\n]|\\.)*"/g, '""'); // string literals are data
  if (/\b(import|require|process|globalThis|window|document|eval|Function|fetch|constructor|__proto__|this)\b/.test(code.replace(/^\s*\/\/.*$/gm, ''))) throw new Error('refused: program reaches outside the sandbox');
  // eslint-disable-next-line no-new-func
  const fn = new Function('"use strict";\n' + source + '\nreturn run;')();
  return call => fn((tool, args) => {
    if (tierOf(tool) !== 'Low') throw new Error(`refused: ${tool} is ${tierOf(tool) || 'unknown'} tier; widgets and routines only read`);
    return call(tool, args);
  });
}
