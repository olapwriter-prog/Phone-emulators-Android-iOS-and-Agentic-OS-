// Port of agenticOS crates/intents (the fast path, no model) and the phrase table agentd registers.

export class Intent {
  constructor(pattern, tool) {
    this.tool = tool; this.parts = [];
    let rest = pattern;
    for (let open; (open = rest.indexOf('{')) >= 0;) {
      if (open > 0) this.parts.push({ lit: rest.slice(0, open).toLowerCase() });
      const close = rest.indexOf('}', open);
      this.parts.push({ slot: rest.slice(open + 1, close) });
      rest = rest.slice(close + 1);
    }
    if (rest) this.parts.push({ lit: rest.toLowerCase() });
  }
  match(input) {
    const text = input.trim().replace(/[.!?]+$/, '');
    const lower = text.toLowerCase();
    if (lower.length !== text.length) return null;
    let pos = 0; const args = {};
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (p.lit != null) { if (!lower.startsWith(p.lit, pos)) return null; pos += p.lit.length; continue; }
      const next = this.parts[i + 1];
      let end;
      if (next?.lit != null) { const o = lower.indexOf(next.lit, pos); if (o < 0) return null; end = o; }
      else if (next?.slot != null) return null;
      else end = text.length;
      const v = text.slice(pos, end).trim();
      if (!v) return null;
      args[p.slot] = v; pos = end;
    }
    return pos === text.length ? { tool: this.tool, args } : null;
  }
}

// The phrases agentd registers (connectors, phone, partner, skills, documents, apps, functions).
export const PHRASES = [
  ['remind me to {text} at {when}', 'set_reminder'], ['add {title} to my calendar on {day}', 'add_event'],
  ["what's on {day}", 'read_calendar'], ['what is on {day}', 'read_calendar'], ['message {to} {text}', 'send_message'],
  ['save {name} as {number}', 'add_contact'], ["what's {name}'s number", 'find_contact'],
  ['text {to} {text}', 'send_sms'], ['sms {to} {text}', 'send_sms'], ['call {to}', 'call'],
  ['answer', 'answer_call'], ['pick up', 'answer_call'], ['hang up', 'hangup'], ['read my messages', 'read_messages'],
  ['messages from {from}', 'messages_from'], ['missed calls', 'list_calls'], ['check balance {code}', 'ussd'], ['ussd {code}', 'ussd'],
  ['signal', 'phone_status'], ['phone status', 'phone_status'], ['scan wifi', 'wifi_scan'],
  ['join wifi {ssid} password {password}', 'wifi_connect'], ['airplane mode {on}', 'airplane_mode'], ['mobile data {on}', 'mobile_data'],
  ['where am i', 'where_am_i'], ['flashlight {on}', 'flashlight'], ['torch {on}', 'flashlight'], ['volume {percent}', 'set_volume'],
  ['find my phone', 'ring_phone'],
  ['inbox', 'inbox'], ['whatsapp', 'inbox'], ['reply to {to}: {text}', 'reply'], ['reply to {to} saying {text}', 'reply'],
  ['invoices', 'invoices'], ['who owes me', 'invoices'], ['send invoice {number}', 'send_invoice'], ['gst for {period}', 'gst_summary'],
  ['file {form} for {period}', 'file_gst'], ['bills', 'bills'], ['what bills are due', 'bills'], ['pay bill {id}', 'pay_bill'],
  ['wallet', 'wallet'], ['pay {amount} to {to} for {note}', 'pay'], ['my orders', 'orders'], ['best price for {item}', 'best_price'],
  ['buy {option}', 'buy'], ['news about {topic}', 'news'], ['news', 'news'], ['book {event} for {qty}', 'book'], ['book {event}', 'book'],
  ['skills about {topic}', 'skills'], ['skill {name}: {question}', 'skill'], ['my documents', 'documents'], ['documents', 'documents'],
  ['what does {name} say about {question}', 'read_document'],
  ['weather in {place}', 'weather'], ['will it rain in {place}', 'weather'], ['weather', 'weather'], ['air quality', 'air_quality'],
  ['what time is it in {place}', 'time_in'], ['directions from {from} to {to}', 'directions'], ['find {query} nearby', 'places'],
  ['convert {amount} {from} to {to}', 'convert_currency'], ['tell me about {topic}', 'wiki'], ['define {word}', 'define'],
  ['public holidays in {country}', 'holidays'], ['play {query} radio', 'radio'], ['how to make {dish}', 'recipe'],
  ['translate {text} to {to}', 'translate'], ['{coin} price', 'crypto'],
  ['list functions', 'list_functions'], ['my functions', 'list_functions'], ['show function {name}', 'show_function'],
];

export class IntentTable {
  constructor(phrases = PHRASES) { this.intents = phrases.map(([p, t]) => new Intent(p, t)); }
  resolve(text) { for (const i of this.intents) { const a = i.match(text); if (a) return a; } return null; }
}
