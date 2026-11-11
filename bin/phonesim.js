#!/usr/bin/env node
// phonesim CLI: list models, inspect specs, run scenarios, or drive a device
// interactively. Run `phonesim help` for usage.

import readline from 'node:readline';
import { Device, CHARGERS, DEVICES, OS_LABEL, getSpec, supportedOS, SCENARIOS, runScenario } from '../src/index.js';

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true); }
  else pos.push(a);
}
const out = s => process.stdout.write(s + '\n');

const USAGE = `phonesim: behavioural simulators for virtual phones & computers

usage:
  phonesim list [--os android|ios|linux|macos|agentic] [--json]
  phonesim info <device>
  phonesim scenario <name> <device|all> [--os <os>] [--json]
  phonesim bench <scenario> [--os <os>]        run a scenario on every model
  phonesim shell <device> [--os <os>] [--off] [--battery 0-100]
  phonesim serve [--port 8080]                 web UI

scenarios: ${Object.entries(SCENARIOS).map(([k, v]) => `\n  ${k.padEnd(9)} ${v.describe}`).join('')}

In the shell, OS commands go straight to the simulated OS (e.g. "dumpsys battery"
on Android, "pmset -g batt" on macOS, "agent run ..." on Agentic OS). Lines that
start with ":" control the virtual hardware, e.g. ":run 10m". Type ":help" there.`;

function table(rows, cols) {
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  out(cols.map((c, i) => c.padEnd(w[i])).join('  '));
  out(w.map(x => '-'.repeat(x)).join('  '));
  for (const r of rows) out(cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  '));
}

function devicesFor(osFilter) {
  return DEVICES.filter(d => !osFilter || supportedOS(d).includes(osFilter));
}

function describeSpec(s) {
  const d = s.display;
  return [
    `${s.name} (${s.id}) by ${s.vendor}, ${s.year}${s.hypothetical ? '  [hypothetical reference design]' : ''}`,
    `  form factor : ${s.family}, ${s.massG} g, cooling: ${s.cooling}`,
    `  OS          : ${OS_LABEL[s.os]} ${s.osVersion}${s.altOS?.length ? `  (can also run: ${s.altOS.map(o => OS_LABEL[o]).join(', ')})` : ''}`,
    `  SoC         : ${s.soc.name} (${s.soc.perfCores}P+${s.soc.effCores}E, perf index ${s.soc.perf}, peak ${s.soc.peakW} W${s.soc.npuTps ? `, NPU ~${s.soc.npuTps} tok/s` : ''})`,
    `  memory      : ${s.ramGB} GB`,
    d ? `  display     : ${d.diag}" ${d.type.toUpperCase()} ${d.w}x${d.h} (${d.ppi} ppi), ${d.minHz === d.hz ? `${d.hz} Hz` : `${d.minHz}-${d.hz} Hz`}, ${d.cutout}${d.aod ? ', always-on' : ''}` : '  display     : none (external)',
    s.coverDisplay ? `  cover disp. : ${s.coverDisplay.diag}" ${s.coverDisplay.w}x${s.coverDisplay.h}` : null,
    s.battery ? `  battery     : ${s.battery.wh} Wh${s.battery.mAh ? ` (${s.battery.mAh} mAh)` : ''}${s.battery.removable ? ', removable' : ''}` : '  battery     : none (mains powered)',
    s.charge ? `  charging    : ${s.charge.wiredW} W wired${s.charge.wirelessW ? `, ${s.charge.wirelessW} W wireless` : ''} via ${s.charge.port}` : null,
    `  radios      : ${[s.radios.cellular?.toUpperCase(), `Wi-Fi ${s.radios.wifi}`, s.radios.bt && 'BT', s.radios.nfc && 'NFC', s.radios.uwb && 'UWB', s.radios.satellite && 'satellite SOS'].filter(Boolean).join(', ')}`,
    `  biometrics  : ${s.biometrics}`,
    s.killSwitches ? `  kill switch : ${s.killSwitches.join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(String(s));
  if (!m) throw new Error(`bad duration "${s}" (try 30s, 10m, 2h)`);
  return Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's'];
}

function statusLine(d) {
  const s = d.snapshot(), b = s.hardware.battery, o = s.os;
  const bat = b ? `${b.pct.toFixed(1)}%${b.charging ? ' ⚡' : b.external ? ' (plugged)' : ''}` : 'AC';
  const extra = o.doze ? ` doze=${o.doze}` : o.memoryPressure ? ` mem=${o.memoryPressure}` : o.inference ? ` ai=${o.inference}` : '';
  return `[t=${fmtT(s.t)}] ${o.label} ${o.state}${o.locked ? ' 🔒' : ''}${o.screenOn ? ' screen-on' : ''} | bat ${bat} | ${s.hardware.tempC.toFixed(1)}°C ${o.thermalState} | ${s.hardware.power.totalW.toFixed(2)} W | fg=${o.foreground || '-'} | ${o.powerMode}${extra}`;
}
const fmtT = t => t < 120 ? `${t.toFixed(0)}s` : t < 7200 ? `${(t / 60).toFixed(1)}m` : `${(t / 3600).toFixed(2)}h`;

const META_HELP = `hardware / simulation commands:
  :status                    one-line status         :snapshot     full JSON state
  :power                     press power button      :boot | :shutdown | :reboot
  :unlock [pin|face|fingerprint] [code]              :lock
  :launch <app>  :home  :kill <app>  :apps           :notify <app> <text>
  :run <dur> [step]          advance time, e.g. :run 30m
  :plug [charger]            chargers: ${Object.keys(CHARGERS).join(', ')}
  :unplug                    :mains on|off (desktops)
  :env key=value ...         ambientC, lux, signal, wifiAvailable, moving, sunW, externalDisplay
  :set <setting> <value>     OS setting (see :settings)
  :fold | :unfold            foldables       :lid open|close   laptops (macOS)
  :events [n]                recent log       :watch on|off    stream log lines
  :quit`;

function meta(d, line, ctx) {
  const [cmd, ...a] = line.slice(1).trim().split(/\s+/);
  const os = d.os;
  const r = x => (x && typeof x === 'object' && 'msg' in x ? x.msg : x ?? '');
  switch (cmd) {
    case 'help': return META_HELP;
    case 'status': return statusLine(d);
    case 'snapshot': return JSON.stringify(d.snapshot(), null, 2);
    case 'power': os.pressPower(); return statusLine(d);
    case 'boot': os.boot(); d.runUntil(x => x.os.state !== 'booting', 300, 0.25); return statusLine(d);
    case 'shutdown': os.shutdown(); return statusLine(d);
    case 'reboot': os.reboot(); d.runUntil(x => x.os.state !== 'booting', 300, 0.25); return statusLine(d);
    case 'unlock': {
      const method = ['face', 'fingerprint'].includes(a[0]) ? a[0] : 'pin';
      return r(os.unlock({ method, pin: method === 'pin' ? (a[0] === 'pin' ? a[1] : a[0]) ?? os.pin : undefined }));
    }
    case 'lock': os.lock(); return 'locked';
    case 'launch': return r(os.launch(a[0]));
    case 'home': return r(os.home());
    case 'kill': return r(os.kill(a[0]));
    case 'apps': return Object.values(os.apps).map(x => `${x.id.padEnd(10)} ${x.name}${os.procs.has(x.id) ? `  [${os.procs.get(x.id).state}]` : ''}`).join('\n');
    case 'notify': os.notify(a[0], a.slice(1).join(' ') || 'hello'); return '';
    case 'run': { const s = parseDuration(a[0] || '60'); d.run(s, a[1] ? parseDuration(a[1]) : Math.max(0.25, Math.min(10, s / 600))); return statusLine(d); }
    case 'plug': d.plug(a[0] || 'usb-pd-30w'); return statusLine(d);
    case 'unplug': d.unplug(); return statusLine(d);
    case 'mains': d.setMains(a[0] !== 'off'); return statusLine(d);
    case 'env': for (const kv of a) { const [k, v] = kv.split('='); d.env[k] = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v); } return JSON.stringify(d.env);
    case 'set': return r(os.set(a[0], a.slice(1).join(' ')));
    case 'settings': return JSON.stringify(os.settings, null, 2);
    case 'fold': return r(d.fold(true));
    case 'unfold': return r(d.fold(false));
    case 'lid': return os.closeLid ? r(a[0] === 'close' ? os.closeLid() : os.openLid()) : 'no lid on this device';
    case 'events': return d.events.slice(-(Number(a[0]) || 20)).map(fmtEvent).join('\n');
    case 'watch': ctx.watch = a[0] !== 'off'; return `watch ${ctx.watch ? 'on' : 'off'}`;
    case 'quit': case 'exit': ctx.quit = true; return '';
    default: return `unknown command :${cmd} (try :help)`;
  }
}
const fmtEvent = e => `${fmtT(e.t).padStart(7)} ${e.level === 'warn' ? '⚠' : e.level === 'error' ? '✖' : ' '} ${e.tag}: ${e.msg}`;

async function shell(id) {
  const d = new Device(id, { os: flags.os, battery: flags.battery != null ? Number(flags.battery) / 100 : undefined });
  const ctx = { watch: true, quit: false };
  d.on(e => { if (ctx.watch && e.level !== 'debug') out(fmtEvent(e)); });
  const tty = process.stdin.isTTY;
  out(describeSpec(d.spec));
  if (!flags.off) { d.os.boot(); d.runUntil(x => x.os.state !== 'booting', 300, 0.25); }
  out(statusLine(d));
  if (tty) out('type :help for hardware commands, "help" for OS commands, :quit to exit');
  const prompt = () => {
    const o = d.os;
    if (o.id === 'android') return `${d.spec.id}:/ $ `;
    if (o.id === 'linux') return `user@${d.spec.id}:~$ `;
    if (o.id === 'macos') return `user@${d.spec.id} ~ % `;
    if (o.id === 'agentic') return `agent> `;
    return `${d.spec.name}> `;
  };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty, prompt: prompt() });
  if (tty) rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) {
      if (!tty) out(`${prompt()}${line}`);
      let res;
      try { res = line.startsWith(':') ? meta(d, line, ctx) : d.exec(line); } catch (e) { res = `error: ${e.message}`; }
      if (res) out(res);
      if (ctx.quit) break;
    }
    if (tty) { rl.setPrompt(prompt()); rl.prompt(); }
  }
  rl.close();
}

function fmtScenario(r) {
  const { scenario, device, os, ...rest } = r;
  return `${device} [${os}] ${scenario}: ` + Object.entries(rest).filter(([, v]) => typeof v !== 'object' || v === null).map(([k, v]) => `${k}=${v}`).join(' ');
}

async function main() {
  const cmd = pos[0];
  switch (cmd) {
    case undefined: case 'help': case '-h': out(USAGE); break;
    case 'list': {
      const list = devicesFor(flags.os);
      if (flags.json) return out(JSON.stringify(list, null, 2));
      table(list.map(s => ({ id: s.id, name: s.name, os: OS_LABEL[s.os] + (s.altOS?.length ? ` (+${s.altOS.join(',')})` : ''), soc: s.soc.name, ram: `${s.ramGB} GB`, battery: s.battery ? `${s.battery.wh} Wh` : 'AC', display: s.display ? `${s.display.diag}" ${s.display.hz}Hz` : '-' })), ['id', 'name', 'os', 'soc', 'ram', 'battery', 'display']);
      out(`\n${list.length} models`);
      break;
    }
    case 'info': out(describeSpec(getSpec(pos[1]))); break;
    case 'scenario': {
      const [_, name, target] = pos;
      if (!name || !target) return out('usage: phonesim scenario <name> <device|all> [--os <os>]');
      const ids = target === 'all' ? devicesFor(flags.os).map(d => d.id) : [target];
      for (const id of ids) {
        const os = flags.os && supportedOS(getSpec(id)).includes(flags.os) ? flags.os : undefined;
        const r = runScenario(name, id, { os });
        out(flags.json ? JSON.stringify(r) : fmtScenario(r));
      }
      break;
    }
    case 'bench': {
      const name = pos[1] || 'video';
      const rows = devicesFor(flags.os).map(s => runScenario(name, s.id, { os: flags.os && supportedOS(s).includes(flags.os) ? flags.os : undefined }))
        .filter(r => !r.skipped);
      const cols = ['device', 'os', ...Object.keys(rows[0] || {}).filter(k => !['scenario', 'device', 'os'].includes(k) && rows.every(r => typeof r[k] !== 'object' || r[k] === null))];
      table(rows, cols);
      break;
    }
    case 'shell': if (!pos[1]) return out('usage: phonesim shell <device>'); await shell(pos[1]); break;
    case 'serve': { const { serve } = await import('../scripts/serve.js'); serve(Number(flags.port) || 8080); break; }
    default: out(`unknown command ${cmd}\n\n${USAGE}`); process.exitCode = 1;
  }
}

main().catch(e => { console.error(`phonesim: ${e.message}`); process.exitCode = 1; });
