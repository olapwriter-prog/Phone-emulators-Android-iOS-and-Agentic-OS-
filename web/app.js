// Browser front-end. Runs the exact same simulation modules as the CLI.
import { Device, CHARGERS, DEVICES, OS_LABEL, supportedOS } from '/src/index.js';

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
};

const APP_COLORS = { browser: '#2d6cdf', camera: '#555c66', maps: '#2e9a5c', video: '#d63b3b', game: '#7b3fd1', music: '#e0457b', messages: '#2fb44f', mail: '#2b8fe0', photos: '#e8a33a', settings: '#7a808b', terminal: '#222', ide: '#1f6fb2', office: '#e07b26', videocall: '#23a35a', render: '#5a2fa8', assistant: '#4a6cf7' };
const OS_ACCENT = { android: '#3ddc84', ios: '#ffffff', linux: '#f2c94c', macos: '#c7c9ce', agentic: '#9fb4ff' };

let dev, paused = false, history = [], lastFrame = performance.now(), acc = 0;

// ------------------------------------------------------------ pickers
const devSel = $('#device');
for (const os of Object.keys(OS_LABEL)) {
  const g = el('optgroup', { label: OS_LABEL[os] });
  for (const d of DEVICES.filter(x => x.os === os)) g.append(el('option', { value: d.id }, d.name));
  devSel.append(g);
}
for (const [k, c] of Object.entries(CHARGERS)) $('#charger').append(el('option', { value: k }, `${k} (${c.kind}, ${c.watts} W)`));

const params = new URLSearchParams(location.hash.slice(1));
devSel.value = params.get('d') || 'iphone-16-pro';

function fillOS() {
  const spec = DEVICES.find(d => d.id === devSel.value);
  const osSel = $('#os');
  osSel.replaceChildren(...supportedOS(spec).map(o => el('option', { value: o }, OS_LABEL[o])));
  if (params.get('os') && supportedOS(spec).includes(params.get('os'))) osSel.value = params.get('os');
}

function create() {
  dev = new Device(devSel.value, { os: $('#os').value, maxEvents: 800 });
  location.hash = `d=${dev.spec.id}&os=${dev.os.id}`;
  history = [];
  $('#log').replaceChildren();
  $('#term').textContent = '';
  dev.on(e => {
    if (e.level === 'debug' && dev.os.id !== 'agentic') return;
    const line = el('div', { class: e.level }, `${fmtT(e.t).padStart(7)} ${e.tag}: ${e.msg}`);
    const log = $('#log'); log.append(line);
    while (log.childNodes.length > 300) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  });
  // apply current environment controls
  applyEnv();
  const s = dev.spec;
  const frame = $('#frame');
  frame.className = 'frame ' + (s.family === 'laptop' ? 'laptop' : s.family === 'desktop' ? (s.display ? 'desktop' : 'headless') : '') + (s.display?.cutout === 'homeButton' ? ' homeButton' : '');
  const headless = dev.os.id === 'agentic';
  $('#bioBtn').hidden = headless || !s.biometrics || s.biometrics === 'none';
  document.querySelector('[data-act=unlock-pin]').hidden = headless;
  document.querySelector('[data-act=home]').hidden = headless;
  $('#keyBtn').hidden = !headless;
  chatLog.length = 0;
  $('#bioBtn').textContent = s.biometrics === 'face' ? 'Face ID / Face Unlock' : 'Fingerprint';
  $('#foldBtn').hidden = s.family !== 'foldable';
  $('#lidBtn').hidden = !(s.family === 'laptop' && dev.os.closeLid);
  $('#spec').textContent = `${s.vendor} · ${s.year} · ${s.soc.name} · ${s.ramGB} GB RAM · ${s.battery ? `${s.battery.wh} Wh` : 'mains'}${s.display ? ` · ${s.display.diag}" ${s.display.w}×${s.display.h} ${s.display.hz} Hz` : ''}${s.hypothetical ? '\n(hypothetical reference design)' : ''}`;
  $('#shellHint').textContent = { android: 'adb shell', ios: 'host tools (no on-device shell)', linux: 'bash', macos: 'zsh', agentic: 'agentd ctl (or just type a request)' }[dev.os.id];
  term(`${OS_LABEL[dev.os.id]} on ${s.name}. Press ⏻ Power to boot, then try "help".`);
  sizeScreen();
  screenKey = '';
  render();
}

function sizeScreen() {
  const s = dev.spec, d = dev.hw.activeDisplay || { w: 16, h: 10 };
  const portrait = s.family !== 'laptop' && s.family !== 'desktop';
  let w = portrait ? Math.min(d.w, d.h) : Math.max(d.w, d.h), h = portrait ? Math.max(d.w, d.h) : Math.min(d.w, d.h);
  if (!s.display) { w = 16; h = 10; }
  const maxW = Math.min(portrait ? 300 : 400, window.innerWidth - 64), maxH = portrait ? 600 : 300;
  const k = Math.min(maxW / w, maxH / h);
  const sc = $('#screen');
  sc.style.width = `${Math.round(w * k)}px`;
  sc.style.height = `${Math.round(h * k)}px`;
}

// --------------------------------------------------------- environment
function applyEnv() {
  if (!dev) return;
  const lux = Math.round(Math.pow(10, Number($('#lux').value)));
  dev.setEnv({ ambientC: Number($('#ambient').value), lux, signal: Number($('#signal').value), wifiAvailable: $('#wifi').checked, moving: $('#moving').checked, sunW: $('#sun').checked ? 2.5 : 0 });
  $('#ambient').nextElementSibling.textContent = `${$('#ambient').value}°`;
  $('#lux').nextElementSibling.textContent = lux;
  $('#signal').nextElementSibling.textContent = `${Math.round($('#signal').value * 100)}%`;
}
for (const id of ['ambient', 'lux', 'signal', 'wifi', 'moving', 'sun']) $('#' + id).addEventListener('input', applyEnv);
$('#charger').addEventListener('change', e => { if (e.target.value) dev.plug(e.target.value); else dev.unplug(); });
$('#lowpower').addEventListener('change', e => dev.os.set('lowPower', e.target.checked));
devSel.addEventListener('change', () => { params.delete('os'); fillOS(); create(); });
$('#os').addEventListener('change', create);
$('#pause').addEventListener('click', () => { paused = !paused; $('#pause').textContent = paused ? 'Resume' : 'Pause'; });
window.addEventListener('resize', () => dev && sizeScreen());

// ------------------------------------------------------------ actions
document.querySelector('.hwbuttons').addEventListener('click', e => {
  const act = e.target.dataset?.act; if (!act) return;
  const os = dev.os;
  if (os.screenOn) os.touch();
  if (act === 'power') os.pressPower();
  if (act === 'key') chatLog.push({ who: 'key', text: dev.holdKey(2500) });
  if (act === 'unlock-bio') say(os.unlock({ method: dev.spec.biometrics }));
  if (act === 'unlock-pin') say(os.unlock({ pin: os.pin }));
  if (act === 'home') { os.wake('home'); os.home(); }
  if (act === 'fold') { const r = dev.fold(!dev.folded); $('#foldBtn').textContent = dev.folded ? 'Unfold' : 'Fold'; sizeScreen(); say(r); }
  if (act === 'lid') { const r = os.lidOpen ? os.closeLid() : os.openLid(); $('#lidBtn').textContent = os.lidOpen ? 'Close lid' : 'Open lid'; say(r); }
  render();
});
function say(r) { if (r && !r.ok) term(`! ${r.msg}`); }

$('#shellForm').addEventListener('submit', e => {
  e.preventDefault();
  const line = $('#shellIn').value.trim(); if (!line) return;
  $('#shellIn').value = '';
  term(`$ ${line}`);
  if (dev.os.screenOn) dev.os.touch();
  const out = dev.exec(line);
  if (out) term(out);
  render();
});
function term(s) { const t = $('#term'); t.textContent += s + '\n'; t.scrollTop = t.scrollHeight; }

// ------------------------------------------------------------- render
const fmtT = t => t < 120 ? `${t.toFixed(0)}s` : t < 7200 ? `${(t / 60).toFixed(1)}m` : `${(t / 3600).toFixed(2)}h`;
const clock = t => { const m = Math.floor((9 * 3600 + 41 * 60 + t) / 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

function statusBar(snap) {
  const b = snap.hardware.battery, s = snap.os.settings;
  const sig = s.airplane ? '✈' : dev.spec.radios.cellular && s.cellular ? '▂▄▆█'.slice(0, Math.max(1, Math.round(dev.env.signal * 4))) : '';
  return el('div', { class: 'status' },
    el('span', {}, snap.os.localTime || clock(snap.t)),
    el('span', {}, `${sig} ${s.wifi && dev.env.wifiAvailable && !s.airplane ? 'Wi-Fi' : ''} ${b ? `${Math.round(b.pct)}%${b.charging ? '⚡' : ''}` : ''}`));
}

let screenKey = '';
function render() {
  const snap = dev.snapshot(), o = snap.os, scr = $('#screen');
  metrics(snap);
  chart();
  $('#clock').textContent = `t = ${fmtT(snap.t)}`;
  $('#lowpower').checked = !!o.settings.lowPower;
  // Only rebuild the screen DOM when what it shows changes, so clicks and
  // typing are not lost mid-gesture.
  const on0 = o.state === 'booting' || (o.state === 'on' && (o.screenOn || !dev.spec.display));
  const showsClock = !on0 || o.locked; // lock screen / AOD show a big clock but have no buttons
  const key = JSON.stringify([o.state, o.locked, o.screenOn, o.foreground, o.coolDown, o.foreground ? o.fps : 0, showsClock ? clock(snap.t) : '',
    showsClock ? Math.round(snap.hardware.battery?.pct ?? 0) : '', snap.hardware.battery?.charging, dev.os.bootQueue?.[0]?.name, o.notifications.length,
    o.statusLine, o.pending?.map(p => p.id).join(), o.job?.promptLeft != null, o.models?.map(m => m.state).join(), o.call, chatLog.length, chatLog.at(-1)?.text,
    [...dev.os.procs.keys()].join(), dev.folded]);
  // status bar & brightness update every frame without touching the content
  const bar = scr.querySelector('.status');
  if (bar && on0 && o.state === 'on') bar.replaceWith(statusBar(snap));
  if (on0 && o.state === 'on') scr.style.filter = `brightness(${0.45 + 0.55 * (snap.hardware.display.brightness || 0.6)})`;
  if (key === screenKey) return;
  if (scr.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && o.os === 'agentic' && !o.locked && o.state === 'on') {
    // keep the input alive while typing; refresh only the transcript and pending list
    const fresh = agentView(o).querySelector('.agent-tasks'), cur = scr.querySelector('.agent-tasks');
    if (fresh && cur) cur.replaceWith(fresh);
    screenKey = key;
    return;
  }
  screenKey = key;
  const kids = [];
  const cut = dev.hw.activeDisplay?.cutout;
  if (cut && ['notch', 'island', 'punch'].includes(cut)) kids.push(el('div', { class: `cutout ${cut}` }));
  // agenticOS is headless: the panel stands for `agentd ctl` over SSH, or agentos-ui when switched on
  const on = o.state === 'booting' || ((o.state === 'on') && (o.screenOn || !dev.spec.display || o.os === 'agentic'));

  if (!on) {
    const aod = o.state !== 'off' && dev.hw.activeDisplay?.aod && dev.os.alwaysOnDisplay?.();
    kids.push(el('div', { class: 'content' }, el('div', { class: 'center' }, aod ? el('div', { class: 'bigclock', style: 'opacity:.35' }, clock(snap.t)) : '',
      o.state === 'off' && snap.hardware.battery?.charging ? el('div', {}, `⚡ ${Math.round(snap.hardware.battery.pct)}%`) : '')));
    scr.style.filter = 'none';
  } else if (o.state === 'booting') {
    const stage = dev.os.bootQueue[0]?.name || '';
    kids.push(el('div', { class: 'content' }, el('div', { class: 'center' },
      el('div', { style: `font-size:40px;color:${OS_ACCENT[o.os]}` }, { android: '🤖', ios: '', linux: '🐧', macos: '', agentic: '⌁' }[o.os]),
      el('div', {}, `${o.label} ${o.version}`), el('div', { class: 'boot-stage' }, stage))));
  } else {
    kids.push(statusBar(snap));
    const c = el('div', { class: 'content' });
    if (o.coolDown) c.append(el('div', { class: 'center' }, el('div', { class: 'overlay-hot' }, '🌡 Temperature', el('br'), 'iPhone needs to cool down before you can use it.')));
    else if (o.locked) {
      c.append(el('div', { class: 'center' }, el('div', { class: 'bigclock' }, clock(snap.t)), el('div', {}, '🔒 ' + (dev.spec.biometrics === 'face' ? 'Look to unlock' : dev.spec.biometrics === 'fingerprint' ? 'Touch sensor or enter PIN' : 'Enter PIN'))));
      for (const n of o.notifications.slice(-3).reverse()) c.append(el('div', { class: 'notif' }, `${dev.os.apps[n.appId]?.name || n.appId}: ${n.text}`));
    } else if (o.os === 'agentic') c.append(agentView(o));
    else if (o.foreground) {
      const app = dev.os.apps[o.foreground];
      c.append(el('div', { class: 'appview', style: `background:${APP_COLORS[app.kind]}` }, el('div', {}, app.name), el('div', { class: 'fps' }, `${o.fps} fps`), el('div', { style: 'font-size:11px;opacity:.8' }, `CPU demand ${(app.cpu).toFixed(1)} / capacity ${snap.hardware.cpu.capacity.toFixed(1)}`)));
    } else {
      const grid = el('div', { class: 'apps' });
      for (const a of Object.values(dev.os.apps)) {
        const running = dev.os.procs.has(a.id);
        grid.append(el('button', { class: `app${running ? ' running' : ''}`, type: 'button', onclick: () => { say(dev.os.launch(a.id)); render(); } },
          el('i', { style: `background:${APP_COLORS[a.kind]}` }, a.name[0]), a.name.length > 12 ? a.name.slice(0, 11) + '…' : a.name));
      }
      c.append(grid);
    }
    kids.push(c);
    scr.style.filter = `brightness(${0.45 + 0.55 * (snap.hardware.display.brightness || 0.6)})`;
  }
  scr.replaceChildren(...kids);
}

// agenticOS: what agentd says (status line, pending approvals, the conversation). No app grid.
const chatLog = [];
function agentView(o) {
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;font-size:11px' });
  const small = o.models?.[0];
  wrap.append(el('div', { style: 'opacity:.8' }, o.settings.ui ? 'agentos-ui' : 'headless · agentd ctl', ` · ${o.stage} · ${o.governor}`),
    el('div', { style: 'opacity:.75' }, (o.models || []).map(m => `${m.name} ${m.state}${m.state === 'ready' ? ` · ${m.tokPerSecGen} tok/s` : ''}`).join(' | ') || 'no model'),
    el('div', { class: 'notif' }, o.statusLine));
  const list = el('div', { class: 'agent-tasks' });
  for (const p of o.pending || []) {
    list.append(el('div', { class: 'task' }, el('b', {}, `#${p.id} ${p.tool} `), Object.entries(p.args).map(([k, v]) => `${k}=${v}`).join(' '),
      el('div', {}, el('button', { type: 'button', onclick: () => { chatLog.push({ who: 'key', text: dev.holdKey(2500) }); render(); } }, 'Hold volume-down 2 s'),
        el('button', { type: 'button', onclick: () => { chatLog.push({ who: 'ctl', text: dev.exec(`press ${p.id}`) }); render(); } }, `press ${p.id}`),
        el('button', { type: 'button', onclick: () => { chatLog.push({ who: 'ctl', text: dev.exec(`decline ${p.id}`) }); render(); } }, 'decline'))));
  }
  if (o.call) list.append(el('div', { class: 'task' }, `📞 ${o.call}`));
  for (const m of chatLog.slice(-8)) {
    if (m.job && m.job.reply) { m.text = m.job.reply; m.job = null; }
    list.append(el('div', { class: 'task', style: m.who === 'you' ? 'background:rgba(159,180,255,.25)' : '' }, el('b', {}, m.who === 'you' ? 'you: ' : 'agentd: '), m.job ? `thinking on ${m.job.model}… ${Math.max(0, Math.round(m.job.promptLeft))} prompt + ${Math.max(0, Math.round(m.job.outLeft))} answer tokens left` : m.text));
  }
  if (!chatLog.length) list.append(el('div', { class: 'center', style: 'opacity:.7' }, 'Say something.', el('div', {}, 'e.g. "save Mum as +919876543210", then "call mum"')));
  const input = el('input', { placeholder: 'call mum · text mum running late · signal · how many texts did Mum send me' });
  const form = el('form', { class: 'agent-input', onsubmit: e => {
    e.preventDefault(); const t = input.value.trim(); if (!t) return;
    chatLog.push({ who: 'you', text: t });
    const r = dev.os.exec(t);
    chatLog.push(r && r.job ? { who: 'agentd', job: r.job, text: '' } : { who: 'agentd', text: String(r) });
    input.value = ''; render();
  } }, input);
  wrap.append(list, form);
  return wrap;
}

let metricEls = null;
function metrics(snap) {
  const h = snap.hardware, o = snap.os;
  const items = [
    ['State', o.state + (o.locked ? ' · locked' : ''), ''],
    ['Battery', h.battery ? `${h.battery.pct.toFixed(1)}%${h.battery.charging ? ` +${h.battery.chargeW.toFixed(1)}W` : ''}` : 'mains', h.battery && h.battery.pct < 15 ? 'err' : ''],
    ['Remaining', (() => { const r = dev.hoursRemaining(); return isFinite(r) ? `${r.toFixed(1)} h` : '—'; })(), ''],
    ['Power', `${h.power.totalW.toFixed(2)} W`, ''],
    ['Temp', `${h.tempC.toFixed(1)} °C`, o.thermalState === 'critical' ? 'err' : o.thermalState === 'serious' ? 'warn' : ''],
    ['Thermal', o.thermalStatus || o.thermalState, ''],
    ['CPU', `${Math.round(h.cpu.util * 100)}% · ×${h.throttle.toFixed(2)}`, h.throttle < 0.8 ? 'warn' : ''],
    ['Frame rate', `${o.fps} / ${h.display.hz || 0} Hz`, o.fps && o.fps < h.display.hz * 0.8 ? 'warn' : ''],
    ['Memory', `${(o.memory.usedMB / 1024).toFixed(1)} / ${(o.memory.totalMB / 1024).toFixed(0)} GB`, ''],
    ['Power mode', o.powerMode, ''],
    ...(o.doze ? [['Doze', o.doze, '']] : []),
    ...(o.memoryPressure ? [['Mem pressure', `${o.memoryPressure}${o.swapMB ? ` · swap ${o.swapMB}MB` : ''}`, o.memoryPressure === 'critical' ? 'err' : '']] : []),
    ...(o.fanPct != null && dev.spec.cooling === 'fan' ? [['Fan', `${o.fanPct}%`, '']] : []),
    ...(o.killSwitches && Object.keys(o.killSwitches).length ? [['Kill switches', Object.entries(o.killSwitches).map(([k, v]) => `${k}:${v ? 'on' : 'off'}`).join(' '), '']] : []),
    ...(o.stage ? [['agentd stage', o.stage, ''], ['Governor', o.governor, o.governor === 'powersave' ? 'warn' : ''], ['Pending', String(o.pending.length), o.pending.length ? 'warn' : ''],
      ['Hottest zone', `${o.dieC} °C${o.hot ? ' HOT' : ''}`, o.hot ? 'err' : ''], ['Local time', `${o.localTime}${o.quiet ? ' (quiet)' : ''}`, ''], ['Ledger', `${o.ledger} lines`, ''],
      ['Learned', `${o.labelled} confirmed`, ''], ['Training', o.trainer.running ? `step ${o.trainer.running.step}/${o.trainer.running.of}` : (o.trainer.blocker || 'ready'), '']] : []),
  ];
  $('#metrics').replaceChildren(...items.map(([k, v, cls]) => el('div', { class: `metric ${cls}` }, el('small', {}, k), el('b', {}, v))));
}

function chart() {
  const cv = $('#chart'), g = cv.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = 120 * devicePixelRatio;
  g.clearRect(0, 0, W, H);
  if (history.length < 2) return;
  const t0 = history[0].t, t1 = history.at(-1).t || 1;
  const maxW = Math.max(1, ...history.map(p => p.w));
  const line = (key, max, color, min = 0) => {
    g.strokeStyle = color; g.lineWidth = 2 * devicePixelRatio; g.beginPath();
    history.forEach((p, i) => { const x = (p.t - t0) / Math.max(1, t1 - t0) * W, y = H - ((p[key] - min) / (max - min)) * (H - 8) - 4; i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  };
  line('b', 100, css.getPropertyValue('--bat'));
  line('c', 60, css.getPropertyValue('--tmp'), 0);
  line('w', maxW, css.getPropertyValue('--pwr'));
}

// --------------------------------------------------------------- loop
function frame(now) {
  const dtReal = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!paused && dev) {
    const speed = Number($('#speed').value);
    let sim = dtReal * speed;
    const step = speed >= 600 ? 5 : speed >= 60 ? 1 : 0.25;
    acc += sim;
    let n = 0;
    while (acc >= step && n < 2000) { dev.tick(step); acc -= step; n++; }
    const h = dev.hw;
    if (!history.length || dev.clock - history.at(-1).t >= Math.max(1, speed / 10)) {
      history.push({ t: dev.clock, b: h.battery.present ? h.battery.level * 100 : 100, c: h.thermal.tempC, w: h.power.totalW });
      if (history.length > 600) history.shift();
    }
    render();
  }
  requestAnimationFrame(frame);
}

fillOS();
create();
requestAnimationFrame(frame);

// A pointer over the screen is a person using the phone: keep it from auto-locking at high speeds.
for (const ev of ['pointermove', 'pointerdown']) $('#screen').addEventListener(ev, () => { if (dev?.os.screenOn) dev.os.touch(); });
