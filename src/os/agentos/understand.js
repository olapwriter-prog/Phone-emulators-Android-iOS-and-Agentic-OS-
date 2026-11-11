// Port of agenticOS crates/understand: a weighted multinomial Naive Bayes classifier that learns
// online, plus the rules that pull details out of a request (who, which day, how much, on/off,
// what to say). Kept behaviour-for-behaviour with the Rust so the simulator decides like agentd.

const FILLER = new Set(['the', 'a', 'an', 'to', 'please', 'could', 'would', 'can', 'you', 'it', 'its', 'is', 'are',
  'be', 'of', 'and', 'or', 'this', 'that', 'just', 'now', 'hey', 'ok', 'okay', 'will', 'kindly']);
const CONTRACT = { whats: 'what', hows: 'how', wheres: 'where', whos: 'who', im: 'i' };

function stem(w) {
  for (const suf of ['ing', 'ed', 'es', 's']) if (w.length > suf.length + 3 && w.endsWith(suf)) return w.slice(0, -suf.length);
  return w;
}

export function features(text) {
  const words = text.toLowerCase().replace(/'/g, '').split(/[^\p{L}\p{N}]+/u)
    .filter(w => w && !FILLER.has(w))
    .map(w => /^\d+$/.test(w) ? (w.length >= 7 ? '#phone' : '#num') : (CONTRACT[w] || stem(w)));
  const f = [...words];
  if (words.length) f.push(`^${words[0]}`);
  for (let i = 0; i + 1 < words.length; i++) f.push(`${words[i]}_${words[i + 1]}`);
  return f;
}

export class Classifier {
  constructor() { this.labels = new Map(); this.vocab = new Set(); this.docs = 0; }
  train(label, text) {
    let l = this.labels.get(label);
    if (!l) { l = { docs: 0, total: 0, counts: new Map() }; this.labels.set(label, l); }
    l.docs++; this.docs++;
    for (const f of features(text)) { l.counts.set(f, (l.counts.get(f) || 0) + 1); l.total++; this.vocab.add(f); }
  }
  predict(text) {
    const f = features(text);
    const v = Math.max(1, this.vocab.size);
    const known = f.filter(w => this.vocab.has(w));
    const nLabels = Math.max(1, this.labels.size);
    const weight = w => {
      let df = 0; for (const l of this.labels.values()) if (l.counts.has(w)) df++;
      return Math.max(0.05, Math.log(nLabels / Math.max(1, df)));
    };
    const scores = [...this.labels].map(([name, l]) => {
      const prior = Math.log(l.docs / Math.max(1, this.docs));
      let like = 0;
      for (const w of known) like += weight(w) * Math.log(((l.counts.get(w) || 0) + 1) / (l.total + v));
      return [name, prior + like];
    });
    const max = Math.max(...scores.map(s => s[1]));
    const total = scores.reduce((a, s) => a + Math.exp(s[1] - max), 0);
    const out = scores.map(([n, s]) => [n, Math.exp(s - max) / total]).sort((a, b) => b[1] - a[1]);
    return known.length ? out : out.map(([n]) => [n, 0]);
  }
  /** Best label if its probability is at least `min`. */
  decide(text, min) { const [best] = this.predict(text); return best && best[1] >= min ? best : null; }
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const RELATIONS = [
  [['mother', 'mom', 'mum', 'mummy', 'mommy', 'ma', 'amma'], ['mum', 'mom', 'mother', 'amma', 'ma']],
  [['father', 'dad', 'daddy', 'papa', 'appa'], ['dad', 'father', 'papa', 'appa']],
];

/** Who the request is about: a contact (name, a typo away, or a family word), a number, or a capitalised name. */
export function person(text, contacts) {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}+]+/u).filter(Boolean);
  const byLen = [...contacts].sort((a, b) => b.length - a.length);
  for (const c of byLen) {
    const parts = c.toLowerCase().split(/\s+/);
    for (let i = 0; i + parts.length <= words.length; i++) if (parts.every((p, k) => words[i + k] === p)) return c;
  }
  for (const c of byLen) {
    const cl = c.toLowerCase();
    if (cl.length >= 4 && !cl.includes(' ') && words.some(w => w.length >= 4 && editDistance(w, cl) === 1)) return c;
  }
  for (const [said, saved] of RELATIONS) {
    if (words.some(w => said.includes(w))) { const c = contacts.find(x => saved.includes(x.toLowerCase())); if (c) return c; }
  }
  let run = '', best = '';
  for (const ch of text + 'x') {
    if (/\d/.test(ch) || (ch === '+' && !run)) run += ch;
    else if ((ch === ' ' || ch === '-') && run) continue;
    else { if ((run.match(/\d/g) || []).length >= 7 && !best) best = run; run = ''; }
  }
  if (best) return best;
  const orig = text.split(/\s+/).slice(1).map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  return orig.find(w => w.length >= 2 && /^\p{Lu}/u.test(w) && w !== 'I') || null;
}

export function day(text) {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow', 'tonight'].find(d => words.includes(d)) || null;
}

export function percent(text) {
  const n = text.split(/\D+/).filter(Boolean).map(Number).find(n => n <= 100);
  return n == null ? null : String(n);
}

export function onOff(text) {
  const l = ` ${text.toLowerCase()} `;
  return [' off ', ' disable', ' stop ', ' kill ', ' no more ', 'turn it off'].some(w => l.includes(w)) ? 'off' : 'on';
}

export function messageText(text) {
  const lower = text.toLowerCase();
  for (const m of [' saying ', ' that says ', ' to say ', ': ', ' that ']) {
    const i = lower.indexOf(m);
    if (i >= 0) { const t = text.slice(i + m.length).trim().replace(/^"|"$/g, ''); if (t) return t; }
  }
  return null;
}

const CALENDAR_WORDS = new Set(['put', 'add', 'schedule', 'book', 'note', 'on', 'for', 'my', 'the', 'a', 'in', 'to', 'calendar', 'diary', 'agenda', 'please', 'an', 'at']);

/** qa::command: a classified command with every detail found by rules, or null (then the LLM is asked). */
export function command(label, text, contacts) {
  let args;
  switch (label) {
    case 'call': { const to = person(text, contacts); if (!to) return null; args = { to }; break; }
    case 'send_sms': { const to = person(text, contacts), t = messageText(text); if (!to || !t) return null; args = { to, text: t }; break; }
    case 'flashlight': case 'airplane_mode': case 'mobile_data': args = { on: onOff(text) }; break;
    case 'set_volume': { const v = percent(text) ?? (text.toLowerCase().includes('mute') ? '0' : null); if (v == null) return null; args = { percent: v }; break; }
    case 'read_calendar': args = { day: day(text) || 'today' }; break;
    case 'add_event': {
      const d = day(text); if (!d) return null;
      const title = text.split(/\s+/).map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(w => w && !CALENDAR_WORDS.has(w.toLowerCase()) && w.toLowerCase() !== d);
      if (!title.length) return null; args = { day: d, title: title.join(' ') }; break;
    }
    case 'hangup': case 'answer_call': case 'wifi_scan': case 'ring_phone': case 'phone_status': case 'where_am_i': case 'read_messages': case 'list_calls': args = {}; break;
    default: return null;
  }
  return { tool: label, args };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * qa::answer: a question over the phone's data, answered by exact code. `d` holds
 * messages [{incoming, name, number, text}], calls [{incoming, name, number}] and contacts [names].
 * Null when it is not such a question or a detail (who?) is missing.
 */
export function answer(label, text, d) {
  const who = () => person(text, d.contacts);
  const is = (r, p) => r.name === p || r.number === p;
  const incoming = d.messages.filter(m => m.incoming);
  switch (label) {
    case 'q.msgs_from': { const p = who(); if (!p) return null; return `${p} sent you ${plural(incoming.filter(m => is(m, p)).length, 'text', 'texts')}.`; }
    case 'q.msgs_sent': { const p = who(); const out = d.messages.filter(m => !m.incoming); return p ? `You sent ${p} ${plural(out.filter(m => is(m, p)).length, 'text', 'texts')}.` : `You sent ${plural(out.length, 'text', 'texts')}.`; }
    case 'q.msgs_total': return `You received ${plural(incoming.length, 'text', 'texts')}.`;
    case 'q.top_sender': {
      const by = new Map(); for (const m of incoming) { const k = m.name || m.number; by.set(k, (by.get(k) || 0) + 1); }
      if (!by.size) return null;
      const top = Math.max(...by.values());
      const names = [...by].filter(([, n]) => n === top).map(([k]) => k).sort((a, b) => (/^[+\d]/.test(a) ? 1 : 0) - (/^[+\d]/.test(b) ? 1 : 0));
      return `${names.join(' and ')} texted you the most (${plural(top, 'text', 'texts')}).`;
    }
    case 'q.strangers': return `${plural(incoming.filter(m => !m.name).length, 'text', 'texts')} came from numbers not in your contacts.`;
    case 'q.contacts_texted': {
      const names = [...new Set(incoming.map(m => m.name).filter(Boolean))].sort();
      return names.length ? `${plural(names.length, 'contact', 'contacts')} texted you: ${names.join(', ')}.` : 'None of your contacts has texted you.';
    }
    case 'q.calls_from': case 'q.did_call': {
      const p = who(); if (!p) return null;
      const n = d.calls.filter(c => c.incoming && is(c, p)).length;
      if (label === 'q.did_call') return n ? `Yes, ${p} called you (${plural(n, 'time', 'times')}).` : `No, ${p} has not called you.`;
      return `${p} called you ${plural(n, 'time', 'times')}.`;
    }
    case 'q.calls_to': { const p = who(); const out = d.calls.filter(c => !c.incoming); return p ? `You called ${p} ${plural(out.filter(c => is(c, p)).length, 'time', 'times')}.` : `You made ${plural(out.length, 'call', 'calls')}.`; }
    case 'q.last_from': { const p = who(); if (!p) return null; const m = [...incoming].reverse().find(x => is(x, p)); return m ? `${p}'s last text: ${m.text}` : `${p} has not texted you.`; }
  }
  return null;
}
