// Behaviour shared by every simulated operating system. Each concrete OS
// overrides the hooks at the bottom (boot stages, background policy, memory
// policy, idle policy, battery policy, shell commands...).

import { clamp } from './hardware.js';

// Generic app archetypes. cpu is in the same relative units as SoC `perf`.
// bg: what the app may keep doing in the background.
export const APP_PROFILES = {
  browser:   { cpu: 1.2, memMB: 450, net: 0.4, bg: 'none' },
  camera:    { cpu: 3.0, memMB: 600, net: 0.0, bg: 'none', perms: ['camera', 'microphone'] },
  maps:      { cpu: 1.5, memMB: 400, net: 0.3, gps: true, bg: 'location', perms: ['location'] },
  video:     { cpu: 0.3, memMB: 350, net: 0.25, bg: 'none', inhibitIdle: true },
  game:      { cpu: 6.5, memMB: 1800, net: 0.1, bg: 'none', inhibitIdle: true },
  music:     { cpu: 0.25, memMB: 180, net: 0.15, bg: 'audio' },
  messages:  { cpu: 0.3, memMB: 150, net: 0.05, bg: 'push', perms: ['contacts'] },
  mail:      { cpu: 0.4, memMB: 200, net: 0.1, bg: 'push' },
  photos:    { cpu: 0.9, memMB: 400, net: 0.05, bg: 'none', perms: ['photos'] },
  settings:  { cpu: 0.2, memMB: 120, net: 0.0, bg: 'none' },
  terminal:  { cpu: 0.2, memMB: 60, net: 0.0, bg: 'process' },
  ide:       { cpu: 1.5, memMB: 1500, net: 0.05, bg: 'process' },
  office:    { cpu: 0.6, memMB: 700, net: 0.05, bg: 'none' },
  videocall: { cpu: 2.5, memMB: 500, net: 0.8, bg: 'voip', perms: ['camera', 'microphone'], inhibitIdle: true },
  render:    { cpu: 20, memMB: 6000, net: 0.0, bg: 'process' },
  assistant: { cpu: 0.4, memMB: 300, net: 0.1, bg: 'none' },
};

export const THERMAL_STATES = ['nominal', 'fair', 'serious', 'critical'];

let PID = 1000;

export class BaseOS {
  constructor(device) {
    this.device = device;
    this.hw = device.hw;
    this.spec = device.spec;
    this.state = 'off'; // off | booting | on | suspended | shutting-down
    this.bootQueue = [];
    this.bootElapsed = 0;
    this.locked = true;
    this.screenOn = false;
    this.idleFor = 0;           // seconds since last interaction
    this.screenOffFor = 0;      // seconds since screen went off
    this.unlockedSinceBoot = false;
    this.failedUnlocks = 0;
    this.lockoutUntil = 0;
    this.procs = new Map();     // appId -> process record
    this.foreground = null;
    this.notifications = [];
    this.permissions = {};      // appId -> {perm: 'granted'|'denied'|'ask'}
    this.wakeLocks = new Set();
    this.pin = '0000';
    this.uptime = 0;
    this.settings = {
      brightness: 0.5, autoBrightness: true,
      wifi: true, cellular: !!this.spec.radios.cellular, bluetooth: true,
      location: true, airplane: false, lowPower: false,
      autoLockSec: 30, chargeLimit: 1, ...this.defaultSettings(),
    };
    this.apps = this.defaultApps();
  }

  // ---------------------------------------------------------------- info
  get id() { return this.constructor.id; }
  get label() { return this.constructor.label; }
  log(tag, msg, level = 'info') { this.device.log(level, tag, msg); }
  get now() { return this.device.clock; }
  get ramMB() { return this.spec.ramGB * 1024; }
  get usedMB() {
    let m = this.systemMemMB();
    for (const p of this.procs.values()) m += this.procMem(p);
    return m;
  }
  get freeMB() { return this.ramMB - this.usedMB; }
  procMem(p) { return p.state === 'suspended' ? p.memMB * 0.85 : p.memMB; }

  thermalState() {
    const t = this.hw.thermal.tempC, L = this.hw.limits;
    if (t >= L.critical) return 'critical';
    if (t >= L.end) return 'serious';
    if (t >= L.start) return 'fair';
    return 'nominal';
  }

  // ----------------------------------------------------------- lifecycle
  boot() {
    if (this.state !== 'off') return this.log('power', `boot ignored (state=${this.state})`);
    if (!this.hw.hasPower(this.device.env)) return this.log('power', 'no power: battery empty and no charger', 'warn');
    if (this.hw.thermal.tempC >= this.hw.limits.shutdown - 2) return this.log('power', 'refusing to boot: device too hot', 'warn');
    const speed = Math.sqrt(Math.max(0.5, this.spec.soc.perf) / 5);
    this.bootQueue = this.bootStages().map(([name, s]) => ({ name, left: s / speed }));
    this.bootElapsed = 0;
    this.state = 'booting';
    this.screenOn = this.spec.display != null;
    this.log('power', `${this.label} ${this.spec.osVersion} boot started on ${this.spec.name}`);
    this.log('boot', this.bootQueue[0].name);
  }

  finishBoot() {
    this.state = 'on';
    this.locked = this.hasLockScreen();
    this.unlockedSinceBoot = false;
    this.uptime = 0;
    this.idleFor = 0;
    this.log('power', `boot completed in ${this.bootElapsed.toFixed(1)}s`);
    this.onBooted();
  }

  shutdown(reason = 'user') {
    if (this.state === 'off') return;
    this.log('power', `shutdown (${reason})`, reason === 'user' ? 'info' : 'warn');
    for (const id of [...this.procs.keys()]) this.procs.delete(id);
    this.foreground = null;
    this.state = 'off';
    this.screenOn = false;
    this.wakeLocks.clear();
  }

  reboot() { this.shutdown('reboot'); this.boot(); }

  pressPower() {
    if (this.state === 'off') return this.boot();
    if (this.state === 'booting') return;
    if (this.screenOn) this.screenOff('power button');
    else this.wake('power button');
  }

  wake(reason = 'user') {
    if (this.state === 'off' || this.state === 'booting') return;
    if (this.state === 'suspended') {
      this.state = 'on';
      this.log('power', `resume from ${this.sleepName()} (${reason})`);
      this.onResume();
    }
    if (!this.screenOn) {
      this.screenOn = true;
      this.screenOffFor = 0;
      this.log('display', `screen on (${reason})`);
    }
    this.touch();
  }

  screenOff(reason = 'timeout') {
    if (!this.screenOn) return;
    this.screenOn = false;
    this.screenOffFor = 0;
    if (this.hasLockScreen()) this.locked = true;
    this.log('display', `screen off (${reason})`);
    this.onScreenOff();
  }

  touch() { this.idleFor = 0; }
  /** Foreground media/games keep the display awake (like a screen wakelock). */
  fgInhibits() { return !!(this.foreground && this.apps[this.foreground]?.inhibitIdle); }

  // -------------------------------------------------------------- unlock
  hasLockScreen() { return this.spec.display != null; }

  unlock({ method = 'pin', pin } = {}) {
    if (this.state === 'suspended' || (this.state === 'on' && !this.screenOn)) this.wake('unlock');
    if (this.state !== 'on') return this.fail(`device is ${this.state}`);
    if (!this.locked) return { ok: true, msg: 'already unlocked' };
    if (this.now < this.lockoutUntil) return this.fail(`locked out for ${Math.ceil(this.lockoutUntil - this.now)}s`);
    if (method !== 'pin') {
      if (this.spec.biometrics !== method) return this.fail(`${method} is not available on ${this.spec.name}`);
      if (!this.unlockedSinceBoot) return this.fail(`${this.biometricName(method)} requires your passcode after restart`);
      if (this.biometricBlocked()) return this.fail(`${this.biometricName(method)} temporarily disabled; use passcode`);
    } else if (pin !== this.pin) {
      this.failedUnlocks++;
      const wait = this.lockoutAfter(this.failedUnlocks);
      if (wait) { this.lockoutUntil = this.now + wait; this.log('security', `too many attempts, locked out ${wait}s`, 'warn'); }
      return this.fail(`wrong passcode (${this.failedUnlocks} failed)`);
    }
    this.locked = false;
    this.failedUnlocks = 0;
    this.unlockedSinceBoot = true;
    this.touch();
    this.log('security', `unlocked with ${method === 'pin' ? 'passcode' : this.biometricName(method)}`);
    return { ok: true, msg: 'unlocked' };
  }

  lock() { if (this.hasLockScreen()) { this.locked = true; this.log('security', 'locked'); } }
  fail(msg) { this.log('os', msg, 'warn'); return { ok: false, msg }; }
  biometricName(m) { return m; }
  biometricBlocked() { return false; }
  lockoutAfter(n) { return n >= 5 ? 30 * Math.pow(2, n - 5) : 0; }

  // ---------------------------------------------------------------- apps
  ready() {
    if (this.state !== 'on') return this.fail(`device is ${this.state}`);
    if (!this.screenOn && this.hasLockScreen()) return this.fail('screen is off');
    if (this.locked) return this.fail('device is locked');
    return null;
  }

  launch(appId) {
    const err = this.ready(); if (err) return err;
    const app = this.apps[appId];
    if (!app) return this.fail(`app "${appId}" is not installed`);
    const denied = (app.perms || []).filter(p => this.checkPermission(appId, p) === 'denied');
    if (denied.length && app.requiresPerms) return this.fail(`${app.name} cannot start without ${denied.join(', ')}`);
    if (this.foreground && this.foreground !== appId) this.toBackground(this.foreground);
    let p = this.procs.get(appId);
    const cold = !p;
    if (!p) {
      const mem = app.memMB;
      this.ensureMemory(mem, appId);
      p = { id: appId, pid: PID++, name: app.name, memMB: mem, profile: app, state: 'foreground', bgFor: 0, startedAt: this.now };
      this.procs.set(appId, p);
    }
    p.state = 'foreground';
    p.bgFor = 0;
    this.foreground = appId;
    this.touch();
    this.log('app', `${cold ? 'cold' : 'warm'} start ${app.name} (pid ${p.pid})`);
    for (const perm of app.perms || []) this.requestPermission(appId, perm);
    return { ok: true, msg: `${app.name} ${cold ? 'started' : 'resumed'}` };
  }

  home() {
    if (this.foreground) this.toBackground(this.foreground);
    this.foreground = null;
    this.touch();
    return { ok: true, msg: 'home' };
  }

  toBackground(appId) {
    const p = this.procs.get(appId);
    if (!p) return;
    p.state = 'background';
    p.bgFor = 0;
    if (this.foreground === appId) this.foreground = null;
    this.onBackground(p);
  }

  kill(appId, reason = 'user') {
    const p = this.procs.get(appId);
    if (!p) return this.fail(`${appId} is not running`);
    this.procs.delete(appId);
    if (this.foreground === appId) this.foreground = null;
    this.log('app', `${p.name} (pid ${p.pid}) killed: ${reason}`, reason === 'user' ? 'info' : 'warn');
    return { ok: true, msg: `${p.name} stopped` };
  }

  /** Free memory for `needMB`, using the OS-specific reclaim policy. */
  ensureMemory(needMB, forApp) {
    let guard = 20;
    while (this.freeMB - needMB < this.memReserveMB() && guard-- > 0) {
      if (!this.reclaimMemory(needMB, forApp)) break;
    }
  }

  // --------------------------------------------------------- permissions
  checkPermission(appId, perm) { return this.permissions[appId]?.[perm] || 'ask'; }

  requestPermission(appId, perm) {
    const cur = this.checkPermission(appId, perm);
    if (cur !== 'ask') return cur;
    const auto = this.device.autoGrant ?? true;
    const res = auto ? this.grantKind(perm) : 'denied';
    (this.permissions[appId] ||= {})[perm] = res;
    this.log('privacy', `${this.apps[appId]?.name || appId} asked for ${perm}: ${res}`);
    return res;
  }

  setPermission(appId, perm, value) { (this.permissions[appId] ||= {})[perm] = value; return { ok: true, msg: `${appId}.${perm}=${value}` }; }
  grantKind() { return 'granted'; }

  // ------------------------------------------------------- notifications
  notify(appId, text) {
    if (this.state === 'off') return;
    const n = { appId, text, at: this.now };
    const delivered = this.deliverPush(n);
    if (!delivered) return;
    this.notifications.push(n);
    if (this.notifications.length > 50) this.notifications.shift();
    this.log('notify', `${this.apps[appId]?.name || appId}: ${text}`);
    if (this.wakeOnNotification() && !this.screenOn) {
      if (this.state === 'suspended') this.wake('notification');
      else { this.screenOn = true; this.screenOffFor = 0; this.log('display', 'screen on (notification)'); }
    }
  }
  deliverPush() { return true; }
  wakeOnNotification() { return true; }

  // ------------------------------------------------------------ settings
  set(key, value) {
    if (!(key in this.settings)) return this.fail(`unknown setting ${key}`);
    if (typeof this.settings[key] === 'number') value = Number(value);
    if (typeof this.settings[key] === 'boolean') value = value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
    const old = this.settings[key];
    this.settings[key] = value;
    if (key === 'airplane') {
      if (value) { this.settings.cellular = false; this.settings.wifi = false; this.settings.bluetooth = false; }
      else { this.settings.cellular = !!this.spec.radios.cellular; }
    }
    if (key === 'cellular' && value && !this.spec.radios.cellular) { this.settings.cellular = false; return this.fail('no cellular modem'); }
    this.onSetting(key, value, old);
    this.log('settings', `${key}: ${old} → ${this.settings[key]}`);
    return { ok: true, msg: `${key}=${this.settings[key]}` };
  }

  // --------------------------------------------------------------- tick
  tick(dt) {
    if (this.state === 'booting') {
      this.bootElapsed += dt;
      let left = dt;
      while (left > 0 && this.bootQueue.length) {
        const st = this.bootQueue[0];
        const used = Math.min(left, st.left);
        st.left -= used; left -= used;
        if (st.left <= 1e-9) {
          this.bootQueue.shift();
          if (this.bootQueue.length) this.log('boot', this.bootQueue[0].name);
        }
      }
      if (!this.bootQueue.length) this.finishBoot();
      return;
    }
    if (this.state === 'off') return;
    this.uptime += dt;

    if (this.screenOn) {
      this.idleFor += dt;
      const lim = this.settings.autoLockSec;
      if (lim > 0 && this.idleFor >= lim && !this.wakeLocks.has('screen') && !this.fgInhibits()) this.screenOff('auto-lock');
    } else {
      this.screenOffFor += dt;
    }

    // background lifecycle
    for (const p of [...this.procs.values()]) {
      if (p.state === 'foreground') continue;
      p.bgFor += dt;
      this.backgroundPolicy(p, dt);
    }

    // memory pressure from growth (e.g. leaks, caches)
    if (this.freeMB < this.memReserveMB()) this.ensureMemory(0);

    this.batteryPolicy(dt);
    this.thermalPolicy(dt);
    this.idlePolicy(dt);
    this.osTick(dt);
  }

  // ---------------------------------------------------------- workload
  /** Translate OS state into a hardware load description. */
  workload() {
    const s = this.settings;
    if (this.state === 'off') return { on: false, display: { on: false } };
    const booting = this.state === 'booting';
    const suspended = this.state === 'suspended';
    let cpu = booting ? this.spec.soc.perf * 0.6 : this.systemCpu();
    let net = 0, gps = false;
    for (const p of this.procs.values()) {
      const f = this.cpuShare(p);
      cpu += p.profile.cpu * f;
      net += (p.profile.net || 0) * f;
      if (p.profile.gps && f > 0 && s.location) gps = true;
    }
    const extra = this.extraLoad();
    cpu += extra.cpu || 0;
    net += extra.net || 0;
    const d = this.hw.activeDisplay;
    const brightness = this.effectiveBrightness();
    const fgApp = this.foreground && this.apps[this.foreground];
    const interactive = fgApp && (this.idleFor < 3 || fgApp.kind === 'game');
    const maxHz = d ? (s.lowPower ? Math.min(60, d.hz) : d.hz) : 0;
    const hz = d ? (interactive ? maxHz : Math.max(d.minHz, Math.min(maxHz, this.foreground ? 60 : d.minHz))) : 0;
    const wifiOk = s.wifi && !s.airplane && this.device.env.wifiAvailable;
    return {
      on: true, suspended,
      sleepFactor: this.sleepFactor(),
      cpu, npu: extra.npu || 0, extraW: extra.extraW || 0,
      perfCap: s.lowPower ? this.lowPowerPerfCap() : 1,
      display: { on: this.screenOn && !!d, brightness, hz, aod: !this.screenOn && this.alwaysOnDisplay() },
      cellOn: s.cellular && !s.airplane && !!this.spec.radios.cellular,
      wifiOn: wifiOk,
      cell: wifiOk ? 0 : net, wifi: wifiOk ? net : 0,
      gps: gps || !!extra.gps, bt: s.bluetooth && !s.airplane,
    };
  }

  effectiveBrightness() {
    if (!this.settings.autoBrightness) return this.settings.brightness;
    const lux = this.device.env.lux;
    const b = clamp(0.15 + Math.log10(Math.max(1, lux)) / 5.2);
    return clamp(b * (this.settings.lowPower ? 0.85 : 1), 0.05, 1);
  }

  cpuShare(p) {
    if (p.state === 'foreground') return this.screenOn || !this.hasLockScreen() ? 1 : 0.15;
    if (p.state === 'background') return this.bgCpuShare(p);
    return 0;
  }

  /** Effective frame rate the user would see. */
  fps() {
    const d = this.hw.display;
    if (!d.on) return 0;
    return Math.round(d.hz * Math.min(1, this.hw.cpu.satisfaction));
  }

  // --------------------------------------------------------------- shell
  exec(line) {
    const argv = tokenize(line);
    if (!argv.length) return '';
    const cmds = { ...this.commonCommands(), ...this.commands() };
    const fn = cmds[argv[0]];
    if (!fn) return `${argv[0]}: command not found`;
    try { return fn.call(this, argv.slice(1), line) ?? ''; } catch (e) { return `error: ${e.message}`; }
  }

  commonCommands() {
    return {
      help: () => 'commands: ' + Object.keys({ ...this.commonCommands(), ...this.commands() }).sort().join(' '),
      echo: a => a.join(' '),
    };
  }

  // ------------------------------------------------------------ snapshot
  snapshot() {
    return {
      os: this.id, label: this.label, version: this.spec.osVersion,
      state: this.state, locked: this.locked, screenOn: this.screenOn,
      foreground: this.foreground,
      procs: [...this.procs.values()].map(p => ({ id: p.id, name: p.name, pid: p.pid, state: p.state, memMB: Math.round(this.procMem(p)) })),
      memory: { totalMB: Math.round(this.ramMB), usedMB: Math.round(this.usedMB), freeMB: Math.round(this.freeMB) },
      thermalState: this.thermalState(),
      settings: { ...this.settings },
      fps: this.fps(),
      powerMode: this.powerModeName(),
      notifications: this.notifications.slice(-5),
      ...this.extraSnapshot(),
    };
  }

  // ------------------------------------------------------- OS overrides
  defaultSettings() { return {}; }
  defaultApps() { return {}; }
  bootStages() { return [['firmware', 1], ['kernel', 2], ['userspace', 3]]; }
  onBooted() {}
  onResume() {}
  onScreenOff() {}
  onBackground() {}
  onSetting() {}
  systemMemMB() { return 1500; }
  memReserveMB() { return 200; }
  /** Return true if something was freed. */
  reclaimMemory() { return false; }
  systemCpu() { return this.screenOn ? 0.15 : 0.04; }
  bgCpuShare() { return 0.1; }
  backgroundPolicy() {}
  batteryPolicy() {}
  thermalPolicy() {}
  idlePolicy() {}
  osTick() {}
  extraLoad() { return {}; }
  sleepFactor() { return 1; }
  sleepName() { return 'sleep'; }
  lowPowerPerfCap() { return 0.7; }
  chargePolicy() { return { chargeLimit: this.settings.chargeLimit }; }
  alwaysOnDisplay() { return false; }
  powerModeName() { return this.settings.lowPower ? 'low power' : 'normal'; }
  extraSnapshot() { return {}; }
  commands() { return {}; }

  // ------------------------------------------------------------ helpers
  makeApps(map) {
    const out = {};
    for (const [id, [profile, name, extra]] of Object.entries(map)) {
      out[id] = { id, name, ...APP_PROFILES[profile], kind: profile, ...(extra || {}) };
    }
    return out;
  }

  /** Least-recently used background process, optionally filtered. */
  lruBackground(filter = () => true) {
    let best = null;
    for (const p of this.procs.values()) {
      if (p.state === 'foreground' || !filter(p)) continue;
      if (!best || p.bgFor > best.bgFor) best = p;
    }
    return best;
  }
}

export function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export const fmtUptime = s => {
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  return `${d ? d + ' days, ' : ''}${String(h).padStart(2, ' ')}:${String(m).padStart(2, '0')}`;
};
