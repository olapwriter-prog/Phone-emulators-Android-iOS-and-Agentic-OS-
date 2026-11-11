// agenticOS: the headless phone OS from github.com/olapwriter-prog/agenticOS, simulated.
//
// postmarketOS with no UI plus one daemon, agentd, that *is* the phone. What is ported
// behaviour-for-behaviour from the Rust (see src/os/agentos/*):
//   - stage machine (crates/stage): Asleep / Active / Deep / WindingDown and its events
//   - power policy (crates/power): governor and model budget per stage and battery
//   - kernel (crates/kerneld): every stage change is written to the ledger, background slices
//     frozen unless Deep, governor applied
//   - request routing (crates/agentd core): feedback words → exact phrases → learned shortcuts →
//     Naive Bayes classifier (≥0.6, crates/understand, same seeds) → code answers → the LLM
//   - tiers (crates/executor) and the approval gateway (crates/gateway): High actions queue,
//     the volume-down key held ≥2 s approves the ONE waiting action (never a guess among
//     several), a grant lasts 10 minutes and runs once; pending items expire after 10 minutes
//   - notification policy (crates/notify): quiet hours 22:00–07:00, daily budget 5, urgent
//     (incoming calls) and VIPs always get through, the rest held for the digest
//   - tamper-evident ledger (crates/ledger): SHA-256 hash chain, verify()
//   - models (agentd wanted_roles + crates/models + crates/prio): small model always loaded,
//     large one on the charger with ≥30 % battery, warm-up of the system prompt, one core kept
//     for calls, boost dropped above hot_c and restored below cool_c
//   - learning (crates/learn) and overnight training (agentd trainer conditions)
// What is simulated rather than real: the LLM's choice (no weights are run; latency is
// computed from the engine's measured speeds scaled to the phone's chip), the modem and the
// outside world.

import { BaseOS, fmtUptime } from '../core/os-base.js';
import { Classifier, command as qaCommand, person, answer as qaAnswer } from './agentos/understand.js';
import { SEEDS } from './agentos/seeds.js';
import { IntentTable } from './agentos/intents.js';
import { Ledger } from './agentos/ledger.js';

// ---------------------------------------------------------------- tools & tiers (from the crates)
const T = (tier, desc) => ({ tier, desc });
export const TOOLS = {
  // crates/phone
  phone_status: T('Low', 'operator, signal, data and wifi'), find_contact: T('Low', "a contact's number"),
  list_contacts: T('Low', 'every saved contact'), add_contact: T('Medium', 'save a contact'),
  call: T('High', 'place a phone call to a person or number'), answer_call: T('Medium', 'pick up the phone call that is ringing now'),
  hangup: T('Low', 'end or decline the call'), list_calls: T('Low', 'recent and missed calls'),
  send_sms: T('High', 'send a text message (SMS) to a person or number'), read_messages: T('Low', 'read received texts'),
  all_messages: T('Low', 'every text (for analysis)'), call_log: T('Low', 'every call (for analysis)'),
  messages_from: T('Low', 'texts from one person'), ussd: T('Medium', 'send a USSD code like *123# (balance, data pack)'),
  wifi_scan: T('Low', 'list wifi networks'), wifi_connect: T('Medium', 'join a wifi network'),
  airplane_mode: T('Medium', 'turn airplane mode on or off (on = all radios off)'), mobile_data: T('Medium', 'mobile data on or off'),
  where_am_i: T('Medium', 'location from GPS or the cell'), flashlight: T('Low', 'torch on or off'),
  set_volume: T('Low', 'ringer and media volume 0-100'), ring_phone: T('Low', 'ring loudly to find the phone'),
  // crates/connectors
  read_calendar: T('Low', "what is on a day"), add_event: T('Medium', 'add an event to the calendar'),
  set_reminder: T('Medium', 'remind me later'), send_message: T('High', 'send a chat-app message (not SMS) to a person'),
  // crates/functions
  list_functions: T('Low', 'functions the agent wrote'), show_function: T('Low', "a function's code"),
  write_function: T('Medium', 'write a new Rust function'), install_function: T('High', 'install a written function'),
  run_function: T('Low', 'run an installed function'),
  // crates/partner (Low reads, Medium bookkeeping, High money and messages)
  inbox: T('Low', 'business inbox (WhatsApp, email)'), read_thread: T('Low', 'one conversation'), reply: T('High', 'reply to a customer'),
  invoices: T('Low', 'invoices and who owes money'), invoice: T('Medium', 'make an invoice'), send_invoice: T('High', 'send an invoice'),
  gst_summary: T('Low', 'GST figures for a period'), file_gst: T('High', 'file a GST return'), bills: T('Low', 'bills due'),
  pay_bill: T('High', 'pay a bill'), wallet: T('Low', 'wallet balance'), pay: T('High', 'pay someone'), orders: T('Low', 'order history'),
  best_price: T('Low', 'compare prices'), buy: T('High', 'buy something'), news: T('Low', 'news'), book: T('High', 'book an event'),
  // crates/skillpack, crates/docs, crates/apps
  skills: T('Low', 'find guides'), skill: T('Low', 'read part of a guide'), documents: T('Low', 'list documents'), read_document: T('Low', 'answer from a document'),
  weather: T('Low', 'weather'), air_quality: T('Low', 'air quality'), time_in: T('Low', 'local time in a place'), directions: T('Low', 'route between places'),
  places: T('Low', 'places nearby'), convert_currency: T('Low', 'convert money'), wiki: T('Low', 'encyclopedia'), define: T('Low', 'dictionary'),
  holidays: T('Low', 'public holidays'), radio: T('Low', 'internet radio'), recipe: T('Low', 'recipes'), translate: T('Low', 'translate text'), crypto: T('Low', 'crypto prices'),
};
const NETWORK_TOOLS = new Set(['weather', 'air_quality', 'time_in', 'directions', 'places', 'convert_currency', 'wiki', 'define', 'holidays', 'radio', 'recipe', 'translate', 'crypto', 'news', 'send_message', 'inbox', 'reply', 'pay', 'pay_bill', 'buy', 'book', 'file_gst', 'send_invoice', 'best_price']);

// ------------------------------------------------------------- models (os/postmarketos/agentd.toml)
const MODELS = {
  'qwen2.5-0.5b': { params: 0.5, memMB: 520, fileMB: 400, speed: 7.0 },
  'qwen3.5-4b': { params: 4, memMB: 3000, fileMB: 2740, speed: 1.0 },
  'qwen3.5-9b': { params: 9, memMB: 6000, fileMB: 5680, speed: 0.45 },
};
const SYSTEM_PROMPT_TOKENS = 897;  // PROGRESS.md: 51 s first read on M-series, 2.8 s from the snapshot
const M_SERIES_PERF = 12;          // the Mac CPU the engine's speeds were measured on
const KERNEL = { i8mm: 1.25, sdot: 1, none: 0.5 }; // SMMLA / SDOT / portable code (Cortex-A53)

const STAGE_NEXT = (stage, ev) => {
  if (ev === 'ChatArrived') return 'Active';
  if (stage === 'Active' && ev === 'ChatIdle') return 'Asleep';
  if ((stage === 'Asleep' || stage === 'Active') && ev === 'ChargerReady') return 'Deep';
  if (stage === 'Deep' && (ev === 'PowerLost' || ev === 'QueueEmpty')) return 'WindingDown';
  if (stage === 'WindingDown' && ev === 'WindDownDone') return 'Asleep';
  return stage;
};

const FEEDBACK_GOOD = ['that was right', 'that s right', 'thats right', 'correct', 'good', 'right', 'yes that s right', 'well done'];
const FEEDBACK_BAD = ['that was wrong', 'that s wrong', 'thats wrong', 'wrong', 'no that s wrong', 'not that', 'that is wrong', 'bad'];
const words = t => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const normal = t => words(t).join(' ');
const canonical = a => JSON.stringify({ tool: a.tool, args: Object.fromEntries(Object.entries(a.args || {}).sort()) });

const CTL = new Set(['status', 'stage', 'chat', 'pending', 'press', 'key', 'decline', 'phone', 'models', 'prio', 'power', 'notify',
  'sim-sms', 'sim-call', 'sim-caller-hangup', 'learn', 'ledger', 'digest', 'state', 'help', 'tools', 'set', 'contacts', 'train']);

export class AgenticOS extends BaseOS {
  static id = 'agentic';
  static label = 'agenticOS';

  constructor(device) {
    super(device);
    const s = this.spec;
    this.cfg = {
      idle_secs: 120, quiet_start_min: 22 * 60, quiet_end_min: 7 * 60, daily_budget: 5, utc_offset_minutes: 330,
      approval_hold_ms: 2000, hot_c: 80, cool_c: 70, keep_small_loaded: true, model_wait_secs: 20,
      train_min_new: 20, train_min_battery: 50, train_steps: 60, train_nightly: true, train_enabled: true,
      online: true, low_battery_floor: 15, deep_min_battery: 30, vip: [], startMinute: 9 * 60,
    };
    // Model set from the comments in os/postmarketos/agentd.toml and the install guide.
    const r = s.ramGB;
    this.modelSpecs = r >= 12 ? [['qwen3.5-4b', 'small'], ['qwen3.5-9b', 'large']]
      : r > 4 ? [['qwen3.5-4b', 'small']]
        : [['qwen2.5-0.5b', 'small']];
    this.models = Object.fromEntries(this.modelSpecs.map(([name, role]) => [name, { name, role, ...MODELS[name], state: 'stopped', warm: false, warmLeft: 0, loadLeft: 0 }]));
    this.reset();
  }

  reset() {
    this.stage = 'Asleep';
    this.ledger = new Ledger();
    this.intents = new IntentTable();
    this.contacts = new Map();
    this.messages = [];
    this.calls = [];
    this.radio = { airplane: false, data: true, wifiSsid: 'HomeNet', torch: false, volume: 50, gpsUntil: 0, ringUntil: 0 };
    this.pending = []; this.granted = []; this.nextPending = 1;
    this.episodes = []; this.lastEpisode = null;
    this.held = []; this.deliveredToday = 0; this.lastDay = null;
    this.job = null;
    this.mode = 'Idle';
    this.hot = false;
    this.lastActivity = 0;
    this.trainer = { running: null, trainedOn: 0, lastDay: null, last: null, adapter: null, forced: false };
    this.lastReply = '';
    this.retrain();
  }

  // ---------------------------------------------------------------- headless
  hasLockScreen() { return false; }
  defaultSettings() { return { ui: false, autoLockSec: 0 }; }
  defaultApps() { return {}; }
  systemMemMB() { return 260 + Object.values(this.models).filter(m => m.state !== 'stopped').reduce((a, m) => a + m.memMB, 0) + (this.trainer.running ? 900 : 0); }
  get distro() { return 'postmarketOS edge (ui=none)'; }
  get governor() {
    const b = this.hw.battery;
    if (b.present && b.level * 100 <= this.cfg.low_battery_floor && !b.external) return 'powersave';
    return { Asleep: 'powersave', WindingDown: 'powersave', Active: 'schedutil', Deep: b.external ? 'performance' : 'schedutil' }[this.stage];
  }

  bootStages() {
    return [
      ['bootloader → postmarketOS kernel (mainline)', 1.5],
      ['initramfs: unlock the encrypted root filesystem (--fde)', 2],
      ['OpenRC: modemmanager, networkmanager, agentd-session (audio, vibration)', 4],
      ['agentd: unlock vault (Argon2, 64 MiB), verify ledger against the saved anchor', 2.5],
      ['agentd: control socket, MCP on 127.0.0.1:8765, approval key armed (volume-down)', 0.5],
    ];
  }

  onBooted() {
    this.screenOn = this.settings.ui;
    this.record('agentd started; ledger verified');
    this.lastActivity = this.now;
    this.syncModels();
  }

  // ----------------------------------------------------------------- kernel
  record(line) { const seq = this.ledger.append(line); this.log('ledger', `#${seq} ${line}`, 'debug'); return seq; }

  handle(ev) {
    const before = this.stage, after = STAGE_NEXT(before, ev);
    if (after !== before) {
      this.stage = after;
      this.record(`stage ${before} -> ${after} on ${ev}`);
      this.log('kerneld', `stage ${before} → ${after} (${ev}); background ${after === 'Deep' ? 'thawed' : 'frozen'}; governor ${this.governor}`);
      if (this.settings.ui) this.screenOn = after === 'Active';
    }
    return this.stage;
  }

  touch() { super.touch(); this.lastActivity = this.now; this.handle('ChatArrived'); }

  modelBudget() {
    const b = this.hw.battery, pct = b.level * 100;
    if (this.stage === 'Asleep' || this.stage === 'WindingDown') return 'None';
    if (this.stage === 'Active') return 'Small';
    return b.external && pct >= this.cfg.deep_min_battery ? 'Large' : 'Small';
  }

  wantedRoles() {
    const b = this.hw.battery;
    const plugged = b.external && b.level * 100 >= 30;
    if (this.trainer.running) return ['small'];
    const budget = this.modelBudget();
    if (budget === 'Large' || plugged) return ['small', 'large'];
    if (budget === 'Small') return ['small'];
    return this.cfg.keep_small_loaded ? ['small'] : [];
  }

  syncModels() {
    if (this.state !== 'on') return;
    const roles = this.wantedRoles();
    for (const m of Object.values(this.models)) {
      const want = roles.includes(m.role);
      if (want && m.state === 'stopped') {
        this.ensureMemory(m.memMB);
        if (this.freeMB - m.memMB < 64) { if (!m.noRoom) this.log('models', `${m.name}: not enough memory (${Math.round(this.freeMB)} MB free)`, 'warn'); m.noRoom = true; continue; }
        m.state = 'loading'; m.loadLeft = 0.1 + m.fileMB / 2000; m.warm = false; m.noRoom = false;
        this.log('models', `starting agentos-llm for ${m.name} (${m.role}), pinned to cores ${this.modelCores().join(',')}`);
      } else if (!want && m.state !== 'stopped') {
        m.state = 'stopped'; m.warm = false;
        this.log('models', `stopped ${m.name} (${m.role}): stage ${this.stage}`);
      }
    }
  }

  // ------------------------------------------------------------------- prio
  get cores() { return this.spec.soc.perfCores + this.spec.soc.effCores; }
  modelCores() { return Array.from({ length: Math.max(1, this.cores - 1) }, (_, i) => i + 1); } // core 0 (slowest) kept for calls
  dieC() { return this.hw.thermal.tempC + 3.5 * (this.hw.power.cpuW || 0); }
  /** Tokens per second for a model: measured engine speed scaled to this chip, its kernels and its cores. */
  speed(m, kind) {
    const s = this.spec.soc;
    const base = kind === 'prompt' ? 17 : 10; // Qwen3.5-4B Q4_K_M on M-series CPU (PROGRESS.md)
    const share = (this.cores - 1) / this.cores;
    const k = KERNEL[s.armDot || 'sdot'];
    const thermal = this.hot ? 0.5 : 1;
    const gov = this.governor === 'powersave' ? 0.55 : 1;
    return base * (s.perf / M_SERIES_PERF) * m.speed * share * (kind === 'prompt' ? k : Math.sqrt(k)) * thermal * gov * Math.min(1, this.hw.cpu.satisfaction + 0.2);
  }
  model(role) { return Object.values(this.models).find(m => m.role === role); }
  brain() {
    const large = this.model('large');
    return large && large.state === 'ready' && this.hw.battery.external ? large : this.model('small');
  }

  // --------------------------------------------------------------- learning
  retrain() {
    this.classifier = new Classifier();
    for (const [label, phrases] of SEEDS) for (const p of phrases) this.classifier.train(label, p);
    for (const e of this.episodes) { const t = this.target(e); if (t) this.classifier.train(t.tool, e.prompt); }
  }
  target(e) {
    if (e.correctedTo) return e.correctedTo;
    if (e.reward > 0 && e.action) return e.action;
    return null;
  }
  labelled() { return this.episodes.filter(e => this.target(e)).length; }
  begin(prompt, action, source) {
    const e = { id: this.episodes.length + 1, t: this.now, prompt, action, source, reward: 0, outcome: null, queue: null };
    this.episodes.push(e); this.lastEpisode = e; return e;
  }
  shortcut(prompt) {
    const key = normal(prompt);
    const hits = this.episodes.filter(e => normal(e.prompt) === key);
    if (hits.some(e => e.reward < 0 && !e.correctedTo)) return null;
    const ok = hits.map(e => this.target(e)).filter(Boolean);
    return ok.length ? ok.at(-1) : null;
  }

  // ---------------------------------------------------------------- the chat
  /** agentd ctl chat. Returns a string, or {job} when the LLM is working (the caller waits). */
  chat(text) {
    if (this.state === 'off' || this.state === 'booting') return `agentd is not running (${this.state})`;
    this.touch();
    this.syncModels();
    const t = normal(text);
    if (FEEDBACK_GOOD.includes(t) || FEEDBACK_BAD.includes(t)) {
      const good = FEEDBACK_GOOD.includes(t), e = this.lastEpisode;
      if (!e) return 'nothing to give feedback on yet';
      e.reward += good ? 1 : -1; e.awaitingCorrection = !good;
      this.retrain();
      return good ? `noted: "${e.prompt}" was right` : `noted: "${e.prompt}" was wrong. Do it the right way now (say it differently) and I will learn from that`;
    }
    const intent = this.intents.resolve(text);
    if (intent) return this.act(text, intent, 'intent');
    const sc = this.shortcut(text);
    if (sc) return this.act(text, sc, 'shortcut');
    const decided = this.classifier.decide(text, 0.6);
    if (decided) {
      const [label] = decided;
      if (!label.startsWith('q.')) {
        const a = qaCommand(label, text, [...this.contacts.keys()]);
        if (a) return this.act(text, a, 'classifier');
      } else {
        const ans = this.answerByCode(label, text);
        if (ans) { const e = this.begin(text, { tool: label, args: {} }, 'classifier'); e.outcome = 'ran'; return `answer: ${ans}`; }
      }
    }
    return this.askModel(text);
  }

  /** Questions over every message, call and contact, answered by code (no LLM; data stays put). */
  answerByCode(label, text) {
    const rec = x => ({ incoming: x.dir === 'in', name: this.nameOf(x.number), number: x.number, text: x.text });
    return qaAnswer(label, text, { messages: this.messages.map(rec), calls: this.calls.map(rec), contacts: [...this.contacts.keys()] });
  }

  askModel(text) {
    const m = this.brain();
    if (!m || m.state === 'stopped') return 'not done: no local model is loaded (agentd models pull)';
    const examples = this.episodes.filter(e => this.target(e) && words(e.prompt).some(w => words(text).includes(w))).slice(-4);
    const userTokens = 40 + Math.ceil(text.length / 4) + examples.length * 30;
    const prompt = (m.warm ? 0 : SYSTEM_PROMPT_TOKENS) + userTokens;
    const out = 28; // one tool call under the grammar
    const loadWait = m.state === 'loading' ? Math.min(this.cfg.model_wait_secs, m.loadLeft + (m.warmLeft || 0)) : 0;
    this.job = { text, model: m.name, promptLeft: prompt, outLeft: out, wait: loadWait, started: this.now, examples: examples.length };
    this.mode = 'Inference';
    this.log('agentd', `asking ${m.name} (${prompt} prompt tokens${m.warm ? ', system prompt from snapshot' : ', system prompt not warm yet'}, ${examples.length} similar confirmed requests)`);
    return { job: this.job };
  }

  /** What the (simulated) model answers: the grammar forces exactly one registered tool call. */
  modelChoice(text) {
    const ranked = this.classifier.predict(text);
    const contacts = [...this.contacts.keys()];
    for (const [label, p] of ranked.slice(0, 3)) {
      if (p < 0.15 || label.startsWith('q.')) continue;
      const a = qaCommand(label, text, contacts);
      if (a) return a;
      if (label === 'send_sms' || label === 'call') {
        const to = person(text, contacts);
        if (to) return { tool: label, args: label === 'call' ? { to } : { to, text: text.replace(/^.*?\b(that|saying|:)\s*/i, '') || text } };
      }
    }
    // otherwise the tool whose description shares the most words with the request
    const w = new Set(words(text));
    let best = null, score = 0;
    for (const [name, t] of Object.entries(TOOLS)) {
      const sc = words(`${name.replace(/_/g, ' ')} ${t.desc}`).filter(x => x.length > 3 && w.has(x)).length;
      if (sc > score) { best = name; score = sc; }
    }
    return best && score >= 1 && Object.keys(this.argsFor(best, text) || {}).length >= 0 ? { tool: best, args: this.argsFor(best, text) || {} } : null;
  }
  argsFor(tool, text) {
    const contacts = [...this.contacts.keys()];
    if (['call', 'find_contact', 'messages_from'].includes(tool)) { const p = person(text, contacts); return p ? { [tool === 'messages_from' ? 'from' : tool === 'call' ? 'to' : 'name']: p } : null; }
    if (['weather', 'air_quality', 'time_in'].includes(tool)) { const m = /\bin ([\p{L} ]+)$/u.exec(text); return m ? { place: m[1] } : {}; }
    return {};
  }

  finishJob() {
    const j = this.job; this.job = null; this.mode = this.baselineMode();
    const secs = this.now - j.started;
    const a = this.modelChoice(j.text);
    this.log('agentd', `${j.model} answered in ${secs.toFixed(1)} s`);
    if (!a) { const e = this.begin(j.text, null, 'model'); e.outcome = 'gave up'; j.reply = 'I could not turn that into something I am allowed to do.'; }
    else j.reply = this.act(j.text, a, 'model', secs);
    this.lastReply = j.reply;
    return j.reply;
  }

  // ------------------------------------------------------------------ act
  act(prompt, a, source, secs) {
    const e = this.begin(prompt, a, source);
    // a working action right after "that was wrong" is a correction
    const prev = this.episodes.at(-2);
    if (prev?.awaitingCorrection && prev !== e) { prev.correctedTo = a; prev.awaitingCorrection = false; }
    const r = this.callTool(a);
    const via = source === 'model' ? ` [model, ${secs?.toFixed(1)} s]` : ` [${source}]`;
    if (r.queued) { e.queue = r.queued; e.outcome = 'waiting'; return `not done: ${r.text}${via}`; }
    e.outcome = r.ok ? 'ran' : 'failed';
    this.retrain();
    return `${r.ok ? 'done' : 'not done'}: ${r.text}${via}`;
  }

  /** The gateway: Low/Medium run; High needs a grant for exactly this action (crates/gateway). */
  callTool(a) {
    const t = TOOLS[a.tool];
    if (!t) return { ok: false, text: `unknown tool ${a.tool}` };
    this.expirePending();
    if (t.tier === 'High') {
      const c = canonical(a);
      const gi = this.granted.findIndex(g => g.c === c && this.now - g.at <= 600);
      if (gi >= 0) {
        this.granted.splice(gi, 1); // consumed whatever happens next
        this.record(`${a.tool} approved`);
        return this.run(a);
      }
      const p = this.pending.find(x => x.c === c);
      if (p) return { ok: false, queued: p.id, text: `approval required (id ${p.id}): press the approval key on the phone, then ask again` };
      if (this.pending.length >= 20) return { ok: false, text: 'too many approvals are waiting; decline some first' };
      const id = this.nextPending++;
      this.pending.push({ id, action: a, c, at: this.now });
      this.record(`${a.tool} refused: needs approval (#${id})`);
      this.log('gateway', `#${id} ${a.tool} waiting for the approval key`);
      return { ok: false, queued: id, text: `approval required (id ${id}): press the approval key on the phone, then ask again` };
    }
    return this.run(a);
  }

  expirePending() {
    const before = this.pending.length;
    this.pending = this.pending.filter(p => this.now - p.at <= 600);
    if (this.pending.length < before) this.log('gateway', `${before - this.pending.length} approval(s) expired after 10 minutes`);
    this.granted = this.granted.filter(g => this.now - g.at <= 600);
  }

  /** The hardware key: hold volume-down. Short presses do nothing; with 2+ waiting, nothing. */
  approvalKey(ms = 2500) {
    if (this.state === 'off') return 'phone is off';
    this.expirePending();
    if (ms < this.cfg.approval_hold_ms) return `key held ${ms} ms (< ${this.cfg.approval_hold_ms} ms): nothing approved`;
    if (this.pending.length === 0) return 'nothing waiting';
    if (this.pending.length > 1) {
      this.record(`approval key held with ${this.pending.length} actions waiting; none approved`);
      return `${this.pending.length} actions waiting; the key approves only when one is: use press N`;
    }
    const p = this.pending[0];
    this.grant(p);
    this.record(`approved #${p.id} ${p.action.tool} with the approval key`);
    return `approved #${p.id} ${p.action.tool}`;
  }
  press(id) {
    this.expirePending();
    const p = this.pending.find(x => x.id === Number(String(id).replace('#', '')));
    if (!p) return 'no such pending item';
    this.grant(p);
    return `approved #${p.id}; ask again within 10 minutes`;
  }
  grant(p) {
    this.pending = this.pending.filter(x => x !== p);
    this.granted.push({ c: p.c, action: p.action, at: this.now });
    const e = this.episodes.find(x => x.queue === p.id);
    if (e) { e.reward += 1; e.outcome = 'approved'; }
    this.retrain();
    this.touch();
  }
  decline(id) {
    const p = this.pending.find(x => x.id === Number(String(id).replace('#', '')));
    if (!p) return 'no such pending item';
    this.pending = this.pending.filter(x => x !== p);
    const e = this.episodes.find(x => x.queue === p.id);
    if (e) { e.reward -= 1; e.outcome = 'declined'; }
    this.retrain();
    return `declined #${p.id}`;
  }

  // -------------------------------------------------------- the phone (sim)
  networkUp() {
    const e = this.device.env;
    return !this.radio.airplane && ((this.radio.wifiSsid && e.wifiAvailable) || (this.radio.data && e.signal > 0.05));
  }
  cellUp() { return !this.radio.airplane && this.device.env.signal > 0.05 && !!this.spec.radios.cellular; }
  nameOf(number) { for (const [n, v] of this.contacts) if (v === number) return n; return null; }
  numberOf(who) {
    if (this.contacts.has(who)) return this.contacts.get(who);
    const c = [...this.contacts.keys()].find(k => k.toLowerCase() === String(who).toLowerCase());
    if (c) return this.contacts.get(c);
    return /^\+?[\d\s-]{7,}$/.test(who) ? who.replace(/[\s-]/g, '') : null;
  }
  who(number) { const n = this.nameOf(number); return n ? `${n} (${number})` : number; }
  activeCall() { return this.calls.find(c => c.state === 'active' || c.state === 'dialing'); }

  run(a) {
    const g = a.args || {};
    const R = (ok, text) => { this.record(`${a.tool} ${ok ? 'ok' : 'failed'}`); return { ok, text }; };
    if (NETWORK_TOOLS.has(a.tool) && !this.networkUp()) return R(false, 'no network (airplane mode, or no wifi and no data)');
    switch (a.tool) {
      case 'phone_status': return R(true, `operator ${this.cellUp() ? 'Airtel' : 'none'}, signal ${this.cellUp() ? Math.round(this.device.env.signal * 100) : 0}%, data ${this.radio.data && !this.radio.airplane ? 'on' : 'off'}, wifi ${this.radio.wifiSsid && this.device.env.wifiAvailable && !this.radio.airplane ? this.radio.wifiSsid : 'off'}, airplane ${this.radio.airplane ? 'on' : 'off'}`);
      case 'add_contact': {
        const num = String(g.number || '').replace(/[\s-]/g, '');
        if (!/^\+?\d{7,15}$/.test(num)) return R(false, `not a phone number: ${g.number}`);
        const existed = this.contacts.has(g.name); this.contacts.set(g.name, num);
        return R(true, `${existed ? 'updated' : 'saved'} ${g.name}: ${num}`);
      }
      case 'find_contact': { const n = this.numberOf(g.name); return n ? R(true, `${g.name}: ${n}`) : R(false, `no contact named ${g.name}`); }
      case 'list_contacts': return R(true, [...this.contacts].map(([n, v]) => `${n}: ${v}`).join('\n') || 'no contacts');
      case 'call': {
        if (!this.cellUp()) return R(false, this.radio.airplane ? 'airplane mode is on' : 'no service');
        const num = this.numberOf(g.to); if (!num) return R(false, `unknown name ${g.to}`);
        this.calls.push({ dir: 'out', number: num, state: 'dialing', t: this.now, answered: false });
        this.log('modem', `dialling ${this.who(num)}`);
        return R(true, `calling ${this.who(num)}`);
      }
      case 'answer_call': {
        const c = this.calls.find(x => x.state === 'ringing'); if (!c) return R(false, 'nothing is ringing');
        const held = this.activeCall(); if (held) held.state = 'held';
        c.state = 'active'; c.answered = true; this.wakeLocks.add('call');
        return R(true, `answered ${this.who(c.number)}${held ? ' (other call on hold)' : ''}`);
      }
      case 'hangup': {
        const c = this.calls.find(x => ['active', 'dialing', 'ringing'].includes(x.state)); if (!c) return R(false, 'no call to end');
        const declined = c.state === 'ringing'; c.state = 'ended'; c.declined = declined;
        const held = this.calls.find(x => x.state === 'held'); if (held) held.state = 'active';
        if (!this.activeCall()) this.wakeLocks.delete('call');
        return R(true, `${declined ? 'declined' : 'ended'} call with ${this.who(c.number)}`);
      }
      case 'list_calls': {
        const missed = this.calls.filter(c => c.missed);
        return R(true, missed.length ? missed.map(c => `missed: ${this.who(c.number)}`).join('\n') : 'no missed calls');
      }
      case 'call_log': return R(true, this.calls.map(c => `${c.dir === 'in' ? 'from' : 'to'} ${this.who(c.number)} ${c.state}`).join('\n') || 'no calls');
      case 'send_sms': {
        if (!this.cellUp()) return R(false, this.radio.airplane ? 'airplane mode is on' : 'no service');
        const num = this.numberOf(g.to); if (!num) return R(false, `unknown name ${g.to}`);
        this.messages.push({ dir: 'out', number: num, text: g.text, t: this.now });
        return R(true, `sent to ${this.who(num)}`);
      }
      case 'read_messages': {
        const inbox = this.messages.filter(m => m.dir === 'in').slice(-10);
        inbox.forEach(m => { m.read = true; });
        return R(true, inbox.map(m => `from ${this.who(m.number)}: ${m.text}`).join('\n') || 'no messages');
      }
      case 'all_messages': return R(true, this.messages.map(m => `${m.dir === 'in' ? 'from' : 'to'} ${this.who(m.number)}: ${m.text}`).join('\n') || 'no messages');
      case 'messages_from': {
        const num = this.numberOf(g.from); if (!num) return R(false, `unknown name ${g.from}`);
        return R(true, this.messages.filter(m => m.dir === 'in' && m.number === num).map(m => m.text).join('\n') || `no messages from ${g.from}`);
      }
      case 'ussd': return this.cellUp() ? R(true, `USSD ${g.code}: Main balance Rs 123.45, data 1.2 GB left`) : R(false, 'no service');
      case 'wifi_scan': return this.radio.airplane ? R(false, 'airplane mode is on') : R(true, this.device.env.wifiAvailable ? 'HomeNet (82%, WPA2)\nCafe-Guest (40%, open)' : 'no networks');
      case 'wifi_connect':
        if (!this.device.env.wifiAvailable || !['HomeNet', 'Cafe-Guest'].includes(g.ssid)) return R(false, `network ${g.ssid} not found`);
        if (g.ssid === 'HomeNet' && g.password !== 'secret123') return R(false, 'wrong password');
        this.radio.wifiSsid = g.ssid; return R(true, `connected to ${g.ssid}`);
      case 'airplane_mode': { const on = g.on === 'on'; this.radio.airplane = on; this.settings.airplane = on; return R(true, `airplane mode ${on ? 'on' : 'off'}`); }
      case 'mobile_data': { this.radio.data = g.on === 'on'; return R(true, `mobile data ${g.on}`); }
      case 'where_am_i':
        if (this.device.env.gps !== false && !this.radio.airplane) { this.radio.gpsUntil = this.now + 15; return R(true, '12.9716° N, 77.5946° E (GPS, ±8 m)'); }
        return this.cellUp() ? R(true, 'near 12.97, 77.59 (cell tower, ±1.5 km)') : R(false, 'no location: no GPS fix and no cell');
      case 'flashlight': this.radio.torch = g.on === 'on'; return R(true, `torch ${g.on}`);
      case 'set_volume': {
        const v = Number(g.percent);
        if (!Number.isFinite(v)) return R(false, 'volume must be a number 0-100');
        if (v < 0 || v > 100) return R(false, 'volume must be 0-100');
        this.radio.volume = v; return R(true, `volume ${v}%`);
      }
      case 'ring_phone': this.radio.ringUntil = this.now + 30; return R(true, 'ringing at full volume for 30 s');
      case 'read_calendar': return R(true, `${g.day}: nothing scheduled`);
      case 'add_event': case 'set_reminder': return R(true, `${a.tool === 'add_event' ? 'added' : 'reminder set'}: ${Object.values(g).join(', ')}`);
      case 'weather': return R(true, `${g.place || 'Bengaluru'}: 27°C, partly cloudy, 20% chance of rain (Open-Meteo, simulated world)`);
      default: return R(true, `${a.tool}${Object.keys(g).length ? ` ${Object.entries(g).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}: done (simulated world)`);
    }
  }

  // ------------------------------------------------- incoming (the network)
  minuteOfDay() { return Math.floor(this.cfg.startMinute + this.device.clock / 60) % 1440; }
  localDay() { return Math.floor((this.cfg.startMinute * 60 + this.device.clock) / 86400); }
  inQuiet(m = this.minuteOfDay()) {
    const { quiet_start_min: s, quiet_end_min: e } = this.cfg;
    return s === e ? false : s < e ? m >= s && m < e : m >= s || m < e;
  }
  offer(note) {
    const urgent = note.priority === 'urgent' || this.cfg.vip.includes(note.sender);
    const hold = !urgent && (this.inQuiet() || note.priority === 'low' || this.deliveredToday >= this.cfg.daily_budget);
    if (hold) { this.held.push(note); return 'held for the digest'; }
    if (!urgent) this.deliveredToday++;
    this.radio.buzzUntil = this.now + (note.app === 'phone' ? 2 : 1);
    return 'alerted';
  }

  incomingSms(number, text) {
    if (!this.cellUp()) return 'no service: the text waits at the network';
    this.messages.push({ dir: 'in', number, text, t: this.now });
    return this.announce({ app: 'sms', sender: this.nameOf(number) || number, text, priority: 'normal' }, 'phone: sms received');
  }
  incomingCall(number) {
    if (!this.cellUp()) return 'no service';
    const busy = this.activeCall();
    this.calls.push({ dir: 'in', number, state: 'ringing', t: this.now, answered: false, waiting: !!busy });
    return this.announce({ app: 'phone', sender: this.nameOf(number) || number, text: busy ? 'call waiting' : 'incoming call', priority: 'urgent' }, 'phone: incoming call');
  }
  callerHangsUp() {
    const c = this.calls.find(x => x.state === 'ringing');
    if (!c) return 'nothing ringing';
    c.state = 'ended'; c.missed = true;
    return this.announce({ app: 'phone', sender: this.nameOf(c.number) || c.number, text: 'missed call', priority: 'normal' }, 'phone: missed call');
  }
  announce(note, ledgerLine) {
    this.touch();
    this.record(ledgerLine);
    const d = this.offer(note);
    const line = `${note.app}: ${note.text} from ${note.sender} (${d})`;
    this.log('phone', line, 'info');
    this.notifications.push({ appId: note.app, text: `${note.sender}: ${note.text}`, at: this.now });
    return line;
  }
  // BaseOS.notify (used by generic scenarios): a text arriving from the network
  notify(appId, text) {
    if (this.state === 'off') return;
    if (/call/i.test(text)) { this.incomingCall('+919000011111'); this.callerHangsUp(); return; }
    this.incomingSms('+919000022222', text);
  }

  digest() {
    const by = {};
    for (const n of this.held.splice(0)) (by[n.app] ||= []).push(n);
    const keys = Object.keys(by);
    if (!keys.length) return 'Nothing new while you were away.';
    return keys.map(k => `${k} (${by[k].length}):\n${by[k].map(n => `  ${n.sender}: ${n.text}`).join('\n')}`).join('\n');
  }

  // ------------------------------------------------------------------ tick
  baselineMode() { if (this.job) return 'Inference'; return this.stage === 'Deep' || this.trainer.running ? 'Training' : 'Idle'; }

  osTick(dt) {
    if (this.state !== 'on') return;
    // new day: the alert budget resets; a digest is due in the morning
    const day = this.localDay();
    if (this.lastDay !== day) { this.deliveredToday = 0; this.lastDay = day; }
    if (this.stage === 'Active' && this.now - this.lastActivity >= this.cfg.idle_secs && !this.job) this.handle('ChatIdle');
    if (this.stage === 'WindingDown') this.handle('WindDownDone');
    // react_to_power
    const b = this.hw.battery, ready = b.external && b.level * 100 >= 20;
    if (ready && this.stage === 'Asleep') this.handle('ChargerReady');
    else if (!ready && this.stage === 'Deep') this.handle('PowerLost');

    // models load, then read the system prompt once (warm)
    for (const m of Object.values(this.models)) {
      if (m.state !== 'loading') continue;
      if (m.loadLeft > 0) { m.loadLeft -= dt; if (m.loadLeft <= 0) { m.warmLeft = SYSTEM_PROMPT_TOKENS; this.log('models', `${m.name} loaded (memory-mapped); reading the system prompt`); } continue; }
      m.warmLeft -= this.speed(m, 'prompt') * dt;
      if (m.warmLeft <= 0) { m.state = 'ready'; m.warm = true; this.log('models', `${m.name} ready; system prompt snapshot kept`); }
    }

    // the request the model is working on
    if (this.job) {
      const j = this.job, m = this.models[j.model];
      if (j.wait > 0) j.wait -= dt;
      else if (j.promptLeft > 0) j.promptLeft -= this.speed(m, 'prompt') * dt;
      else if (j.outLeft > 0) j.outLeft -= this.speed(m, 'gen') * dt;
      if (j.wait <= 0 && j.promptLeft <= 0 && j.outLeft <= 0) this.finishJob();
    }

    // prio: temperature guard with hysteresis
    const die = this.dieC();
    if (!this.hot && die >= this.cfg.hot_c) { this.hot = true; this.log('prio', `${die.toFixed(0)}°C ≥ ${this.cfg.hot_c}°C: boost dropped, model capped to half its cores' time`, 'warn'); }
    else if (this.hot && die < this.cfg.cool_c) { this.hot = false; this.log('prio', `${die.toFixed(0)}°C < ${this.cfg.cool_c}°C: boost restored`); }

    // calls: the other side answers an outgoing call; an unanswered incoming call becomes missed
    for (const c of this.calls) {
      if (c.state === 'dialing' && this.now - c.t > 6) { c.state = 'active'; c.answered = true; this.wakeLocks.add('call'); this.log('modem', `${this.who(c.number)} answered`); }
      if (c.state === 'ringing' && this.now - c.t > 30) { c.state = 'ended'; c.missed = true; this.announce({ app: 'phone', sender: this.nameOf(c.number) || c.number, text: 'missed call', priority: 'normal' }, 'phone: missed call'); }
    }
    this.trainTick(dt);
    this.syncModels();
    this.mode = this.baselineMode();
  }

  // --------------------------------------------------------------- training
  trainBlocker() {
    const b = this.hw.battery, pct = Math.round(b.level * 100);
    if (!b.external) return 'not on the charger';
    if (pct < this.cfg.train_min_battery) return `battery ${pct}% (needs ${this.cfg.train_min_battery}%)`;
    if (this.dieC() >= this.cfg.cool_c) return `phone at ${this.dieC().toFixed(0)}°C (needs below ${this.cfg.cool_c}°C)`;
    if (this.job) return 'the model is busy';
    if (this.trainer.forced) return null;
    if (this.stage !== 'Deep') return 'not in the Deep stage';
    const fresh = this.labelled() - this.trainer.trainedOn;
    const nightlyDue = this.cfg.train_nightly && fresh > 0 && this.trainer.lastDay !== this.localDay();
    if (fresh < this.cfg.train_min_new && !nightlyDue) return `${fresh} new confirmed requests since the last run (needs ${this.cfg.train_min_new})`;
    return null;
  }

  trainTick(dt) {
    const tr = this.trainer, why = this.trainBlocker();
    if (tr.running) {
      if (why && !why.includes('busy')) {
        tr.last = `training stopped (${why}); continues from its checkpoint next time`;
        tr.paused = tr.running; tr.running = null; this.record(tr.last); this.log('trainer', tr.last, 'warn');
        return;
      }
      tr.running.left -= dt;
      tr.running.step = Math.min(this.cfg.train_steps, Math.floor((1 - tr.running.left / tr.running.total) * this.cfg.train_steps));
      if (tr.running.left <= 0) {
        const n = tr.running.examples, base = 0.46, tuned = Math.min(0.92, base + 0.04 * Math.log2(1 + n));
        tr.trainedOn = n; tr.running = null; tr.paused = null; tr.forced = false;
        if (tuned > base) { tr.adapter = `adapter-day${this.localDay()}.aglora`; tr.last = `training kept ${tr.adapter}: ${Math.round(base * 100)}% -> ${Math.round(tuned * 100)}% on held-out requests`; }
        else tr.last = `training discarded: ${Math.round(base * 100)}% -> ${Math.round(tuned * 100)}% on held-out requests, not better`;
        this.record(tr.last); this.log('trainer', tr.last);
      }
      return;
    }
    if (!this.cfg.train_enabled || why) return;
    const small = this.model('small'), n = this.labelled();
    // one step ≈ a packed batch of 4 (PROGRESS.md: ~127 s on 4 x86 cores for 0.5B), scaled to this chip and model
    const stepS = 127 * (small.params / 0.5) * (6 / Math.max(0.3, this.spec.soc.perf)) / KERNEL[this.spec.soc.armDot || 'sdot'];
    const total = tr.paused ? tr.paused.left : stepS * this.cfg.train_steps;
    tr.running = { examples: n, left: total, total: tr.paused?.total ?? total, step: tr.paused?.step || 0 };
    tr.lastDay = this.localDay();
    tr.last = `training ${small.name} on ${n} confirmed requests${tr.paused ? ' (resumed from checkpoint)' : ''}`;
    this.record(tr.last); this.log('trainer', `${tr.last}, ~${(total / 3600).toFixed(1)} h left`);
  }

  // ------------------------------------------------------------- hardware
  workload() {
    const w = super.workload();
    w.display.on = this.settings.ui && this.stage === 'Active';
    w.display.aod = false;
    this.screenOn = w.display.on;
    w.perfCap = this.governor === 'powersave' ? 0.55 : 1;
    w.cellOn = !this.radio.airplane && !!this.spec.radios.cellular;
    w.wifiOn = !this.radio.airplane && !!this.radio.wifiSsid && this.device.env.wifiAvailable;
    return w;
  }

  systemCpu() { return this.state === 'on' ? 0.05 : 0; }

  extraLoad() {
    if (this.state !== 'on') return {};
    const soc = this.spec.soc, share = (this.cores - 1) / this.cores;
    let cpu = 0, extraW = 0, net = 0;
    const warming = Object.values(this.models).some(m => m.state === 'loading');
    if (this.job || warming || this.trainer.running) cpu += soc.perf * share * (this.hot ? 0.5 : 1);
    if (this.activeCall()) { cpu += 0.25; net += 0.4; }
    if (this.radio.torch) extraW += 1.0;
    if (this.radio.ringUntil > this.now) extraW += 0.6;
    if ((this.radio.buzzUntil || 0) > this.now) extraW += 0.4;
    return { cpu, net, extraW, gps: this.radio.gpsUntil > this.now };
  }

  // agentd never acts on kerneld's may_suspend(): the system stays up in the Asleep stage.
  idlePolicy() {}
  thermalPolicy() {
    if (this.hw.thermal.tempC >= this.hw.limits.critical + 2 && this.state === 'on') {
      this.log('kernel', 'thermal zone critical: orderly poweroff', 'error');
      this.shutdown('thermal critical');
    }
  }
  batteryPolicy() {}
  powerModeName() { return `governor ${this.governor}`; }

  statusLine() {
    const parts = [], b = this.hw.battery, pct = Math.round(b.level * 100);
    this.expirePending();
    if (this.pending.length) parts.push(`${this.pending.length} approval${this.pending.length === 1 ? '' : 's'} waiting for you`);
    const bg = this.trainer.running ? 1 : 0;
    parts.push({ Asleep: 'Asleep', Active: 'Active, background work paused', Deep: bg ? 'Working in the background' : 'Charging and idle, ready for background work', WindingDown: 'Finishing up' }[this.stage]);
    if (this.stage === 'Deep' && bg) parts.push('1 job running');
    parts.push(b.external ? `battery ${pct}% and charging` : `battery ${pct}%`);
    if (!this.networkUp()) parts.push('offline');
    if (!b.external && pct <= 15) parts.push('power saving on');
    return parts.join(', ');
  }

  extraSnapshot() {
    return {
      stage: this.stage, governor: this.governor, statusLine: this.statusLine(), mode: this.mode, hot: this.hot, dieC: +this.dieC().toFixed(1),
      models: Object.values(this.models).map(m => ({ name: m.name, role: m.role, state: m.state, warm: m.warm, tokPerSecGen: +this.speed(m, 'gen').toFixed(2), tokPerSecPrompt: +this.speed(m, 'prompt').toFixed(2) })),
      pending: this.pending.map(p => ({ id: p.id, tool: p.action.tool, args: p.action.args, ageS: Math.round(this.now - p.at) })),
      job: this.job ? { model: this.job.model, text: this.job.text, promptLeft: Math.max(0, Math.round(this.job.promptLeft)), outLeft: Math.max(0, Math.round(this.job.outLeft)) } : null,
      held: this.held.length, deliveredToday: this.deliveredToday, quiet: this.inQuiet(), localTime: `${String(Math.floor(this.minuteOfDay() / 60)).padStart(2, '0')}:${String(this.minuteOfDay() % 60).padStart(2, '0')}`,
      ledger: this.ledger.lines.length, episodes: this.episodes.length, labelled: this.labelled(),
      trainer: { running: this.trainer.running ? { step: this.trainer.running.step, of: this.cfg.train_steps } : null, last: this.trainer.last, adapter: this.trainer.adapter, blocker: this.trainBlocker() },
      call: this.activeCall() ? this.who(this.activeCall().number) : (this.calls.find(c => c.state === 'ringing') ? `ringing: ${this.who(this.calls.find(c => c.state === 'ringing').number)}` : null),
      torch: this.radio.torch, airplane: this.radio.airplane, lastReply: this.lastReply,
    };
  }

  // ------------------------------------------------------------- shell = agentd ctl
  exec(line) {
    let l = line.trim().replace(/^(sudo\s+)?agentd\s+ctl\s+(-c\s+\S+\s+)?/, '');
    if (!l) return '';
    const [cmd, ...rest] = l.split(/\s+/);
    const arg = l.slice(cmd.length).trim();
    if (!CTL.has(cmd)) { if (['uname', 'cat', 'uptime', 'free', 'rc-service', 'reboot', 'poweroff'].includes(cmd)) return this.sh(cmd, rest); return this.chat(l); }
    switch (cmd) {
      case 'help': return 'agentd ctl: status | stage | chat <text> (or just type it) | pending | key [ms] | press N | decline N | phone | contacts | models | prio | power <0-100> [charger] | notify app|sender|low/normal/urgent|text | sim-sms NUMBER|TEXT | sim-call NUMBER | sim-caller-hangup | digest | learn | train | ledger [verify|tamper] | tools | set <key> <value> | state\nshell: uname -a, cat /etc/os-release, uptime, free, rc-service agentd restart, reboot, poweroff';
      case 'status': return this.statusLine();
      case 'stage': return this.stage;
      case 'chat': return this.chat(arg);
      case 'pending': this.expirePending(); return this.pending.map(p => `#${p.id} ${p.action.tool} ${Object.entries(p.action.args).map(([k, v]) => `${k}=${v}`).join(' ')}`).join('\n') || 'nothing waiting';
      case 'key': return this.approvalKey(rest[0] ? Number(rest[0]) : 2500);
      case 'press': return this.press(rest[0]);
      case 'decline': return this.decline(rest[0]);
      case 'phone': return this.run({ tool: 'phone_status', args: {} }).text;
      case 'contacts': return this.run({ tool: 'list_contacts', args: {} }).text;
      case 'tools': return Object.entries(TOOLS).map(([n, t]) => `${t.tier.padEnd(6)} ${n.padEnd(17)} ${t.desc}`).join('\n');
      case 'models': return Object.values(this.models).map(m => `${m.name} (${m.role}): ${m.state}${m.state === 'ready' ? ', system prompt warm' : ''}; ~${this.speed(m, 'gen').toFixed(1)} tok/s answer, ~${this.speed(m, 'prompt').toFixed(1)} tok/s prompt; ${m.memMB} MB`).join('\n') || 'no models';
      case 'prio': return `mode ${this.mode}; model cores ${this.modelCores().join(',')} (core 0 kept for calls and the system); hottest zone ~${this.dieC().toFixed(0)}°C (hot ${this.cfg.hot_c}, cool ${this.cfg.cool_c})${this.hot ? '; HOT: boost dropped' : ''}; governor ${this.governor}; protected memory ${Object.values(this.models).filter(m => m.state !== 'stopped').reduce((a, m) => a + m.memMB, 0)} MB`;
      case 'power': {
        const lvl = Number(rest[0]); if (!(lvl >= 0 && lvl <= 100)) return 'usage: power <0-100> [charger]';
        this.hw.battery.level = lvl / 100;
        if (rest[1] === 'charger') this.device.plug('usb-pd-20w'); else this.device.unplug();
        this.device.refresh(); this.osTick(0);
        return `battery ${lvl}%${rest[1] === 'charger' ? ' charging' : ''}`;
      }
      case 'notify': {
        const p = arg.split('|'); if (p.length !== 4) return 'usage: notify app|sender|low/normal/urgent|text';
        const d = this.offer({ app: p[0], sender: p[1], priority: p[2], text: p[3] });
        return d === 'alerted' ? 'deliver now' : `held for the digest (${this.held.length} held)`;
      }
      case 'sim-sms': { const [num, ...t] = arg.split('|'); return this.incomingSms(num.trim(), t.join('|')); }
      case 'sim-call': return this.incomingCall(arg.trim());
      case 'sim-caller-hangup': return this.callerHangsUp();
      case 'digest': return this.digest();
      case 'learn': return `${this.episodes.length} episodes, ${this.labelled()} confirmed; shortcuts: ${new Set(this.episodes.filter(e => this.target(e)).map(e => normal(e.prompt))).size}; ${this.trainer.last || 'not trained yet'}`;
      case 'train': {
        if (rest[0] === 'now') { this.trainer.forced = true; return `training forced; blocker now: ${this.trainBlocker() || 'none, starting'}`; }
        return this.trainer.running ? `training step ${this.trainer.running.step}/${this.cfg.train_steps}` : `not training: ${this.trainBlocker() || 'starting'}; ${this.trainer.last || ''}`;
      }
      case 'ledger': {
        if (rest[0] === 'verify') { try { return `ledger ok: ${this.ledger.verify()} lines, head ${this.ledger.lastHash.slice(0, 16)}…`; } catch (e) { return e.message; } }
        if (rest[0] === 'tamper') { const l2 = this.ledger.lines[Number(rest[1]) || 0]; if (!l2) return 'no such line'; l2.payload += ' (edited)'; return `edited line ${l2.seq}; run "ledger verify"`; }
        return this.ledger.lines.slice(-15).map(x => `${x.seq}\t${x.hash.slice(0, 12)}…\t${x.payload}`).join('\n') || '(empty)';
      }
      case 'set': {
        const [k, v] = rest;
        if (k === 'ui') { this.settings.ui = v === 'on' || v === 'true'; return `agentos-ui ${this.settings.ui ? 'on' : 'off'}`; }
        if (k === 'vip') { this.cfg.vip.push(rest.slice(1).join(' ')); return `VIP: ${this.cfg.vip.join(', ')}`; }
        if (k in this.cfg) { this.cfg[k] = typeof this.cfg[k] === 'number' ? Number(v) : v === 'true'; return `${k} = ${this.cfg[k]}`; }
        return `unknown key ${k}`;
      }
      case 'state': return JSON.stringify(this.extraSnapshot(), null, 2);
    }
    return '';
  }

  sh(cmd, a) {
    switch (cmd) {
      case 'uname': return `Linux ${this.spec.id} 6.12.9-postmarketos #1 SMP PREEMPT aarch64 Linux`;
      case 'cat': return a[0] === '/etc/os-release' ? 'NAME="postmarketOS"\nVERSION_ID="edge"\nPRETTY_NAME="postmarketOS edge (agenticOS: ui=none + agentd)"' : `cat: ${a[0]}: not simulated`;
      case 'uptime': return `up ${fmtUptime(this.uptime)}`;
      case 'free': return `Mem: total ${Math.round(this.ramMB)} MB, used ${Math.round(this.usedMB)} MB (models ${Object.values(this.models).filter(m => m.state !== 'stopped').reduce((x, m) => x + m.memMB, 0)} MB), free ${Math.round(this.freeMB)} MB`;
      case 'rc-service': if (a[0] === 'agentd' && a[1] === 'restart') { for (const m of Object.values(this.models)) m.state = 'stopped'; this.record('agentd restarted'); this.syncModels(); return ' * Stopping agentd ... [ ok ]\n * Starting agentd ... [ ok ]'; } return 'usage: rc-service agentd restart';
      case 'reboot': this.reboot(); return '';
      case 'poweroff': this.shutdown(); return '';
    }
    return '';
  }

  shutdown(reason) { super.shutdown(reason); for (const m of Object.values(this.models)) { m.state = 'stopped'; m.warm = false; } this.job = null; this.stage = 'Asleep'; }
}
