// macOS behaviour (Apple silicon): iBoot → XNU → launchd → WindowServer →
// loginwindow, FileVault/Touch ID rules, App Nap, memory compression and
// swap instead of killing apps, display sleep vs. system sleep, lid close and
// clamshell mode, Power Nap, hibernate on critically low battery, Low Power
// Mode, Optimized Battery Charging and a zsh-like shell with pmset & friends.

import { BaseOS, fmtUptime } from '../core/os-base.js';

const NAMES = { 13: 'Ventura', 14: 'Sonoma', 15: 'Sequoia', 26: 'Tahoe' };

export class MacOS extends BaseOS {
  static id = 'macos';
  static label = 'macOS';

  constructor(device) {
    super(device);
    this.lidOpen = true;
    this.assertions = new Set();
    this.lastPassword = -Infinity;
    this.compressedMB = 0;
    this.swapMB = 0;
    this.hibernating = false;
    this.powerNapIn = 0;
  }

  get laptop() { return this.spec.family === 'laptop'; }

  defaultSettings() {
    return {
      autoLockSec: this.laptop ? 120 : 600,      // display sleep
      sleepAfterSec: this.laptop ? 600 : 0,      // system sleep after display off (0 = never)
      powerNap: true, optimizedCharging: true, chargeLimit: 1,
      lowPowerMode: 'never',                      // never | battery | always
    };
  }

  defaultApps() {
    return this.makeApps({
      safari: ['browser', 'Safari', { bundle: 'com.apple.Safari' }],
      facetime: ['videocall', 'FaceTime', { bundle: 'com.apple.FaceTime' }],
      maps: ['maps', 'Maps', { bundle: 'com.apple.Maps' }],
      tv: ['video', 'TV', { bundle: 'com.apple.TV' }],
      game: ['game', 'Metal 3D game', { bundle: 'com.example.game3d' }],
      music: ['music', 'Music', { bundle: 'com.apple.Music' }],
      messages: ['messages', 'Messages', { bundle: 'com.apple.MobileSMS' }],
      mail: ['mail', 'Mail', { bundle: 'com.apple.mail' }],
      photos: ['photos', 'Photos', { bundle: 'com.apple.Photos' }],
      settings: ['settings', 'System Settings', { bundle: 'com.apple.systempreferences' }],
      terminal: ['terminal', 'Terminal', { bundle: 'com.apple.Terminal' }],
      xcode: ['ide', 'Xcode', { bundle: 'com.apple.dt.Xcode' }],
      pages: ['office', 'Pages', { bundle: 'com.apple.iWork.Pages' }],
      finalcut: ['render', 'Final Cut Pro (export)', { bundle: 'com.apple.FinalCut' }],
    });
  }

  bootStages() {
    return [
      ['LLB/iBoot: Secure Boot (Full Security), loading kernelcache', 1.5],
      ['XNU kernel init, APFS: preboot volume', 2.0],
      ['FileVault pre-boot authentication: volume unlocked', 1.0],
      ['launchd: WindowServer, coreaudiod, powerd, thermalmonitord', 3.0],
      ['loginwindow ready', 1.5],
    ];
  }

  onBooted() { this.hibernating = false; }

  // ---------------------------------------------------------- security
  biometricName() { return 'Touch ID'; }
  biometricBlocked() { return this.now - this.lastPassword > 48 * 3600; }
  unlock(opts = {}) {
    if (!this.lidOpen && !this.device.env.externalDisplay) return this.fail('lid is closed');
    const r = super.unlock(opts);
    if (r.ok && (opts.method || 'pin') === 'pin') this.lastPassword = this.now;
    return r;
  }
  lockoutAfter(n) { return n >= 5 ? 60 * Math.pow(2, n - 5) : 0; }
  grantKind(perm) { return `granted (TCC: ${perm})`; }

  // ----------------------------------------------------------- memory
  systemMemMB() { return 2600 + this.spec.ramGB * 120; }
  memReserveMB() { return 300; }

  updateMemory() {
    let raw = this.systemMemMB();
    let bg = 0;
    for (const p of this.procs.values()) { raw += p.memMB; if (p.state !== 'foreground') bg += p.memMB; }
    const over = Math.max(0, raw + this.memReserveMB() - this.ramMB);
    // the compressor squeezes ~2:1, up to half of inactive memory
    const compressible = bg * 0.5;
    this.compressedMB = Math.min(over * 2, compressible);
    const saved = this.compressedMB / 2;
    this.swapMB = Math.max(0, over - saved);
    if (this.swapMB > this.ramMB * 0.75 && !this._oomWarned) {
      this._oomWarned = true;
      this.log('memory', 'Your system has run out of application memory. Quit applications to continue.', 'error');
    }
    if (this.swapMB < this.ramMB * 0.25) this._oomWarned = false;
  }

  get usedMB() { this.updateMemory(); return Math.min(this.ramMB - this.memReserveMB() * 0.5, super.usedMB - this.compressedMB / 2 - this.swapMB); }
  memoryPressure() {
    this.updateMemory();
    if (this.swapMB > this.ramMB * 0.3) return 'critical';
    if (this.swapMB > 0 || this.compressedMB > this.ramMB * 0.2) return 'warn';
    return 'normal';
  }
  reclaimMemory() { return false; } // macOS compresses & swaps; it does not kill apps

  // ---------------------------------------------------------- App Nap
  napped(p) {
    if (p.state === 'foreground') return false;
    const bg = p.profile.bg;
    if (bg === 'audio' || bg === 'voip' || bg === 'process' || this.assertions.has(p.id)) return false;
    return p.bgFor > 8;
  }

  backgroundPolicy(p) {
    const n = this.napped(p);
    if (n && !p.napped) this.log('app', `${p.name} entered App Nap`, 'debug');
    p.napped = n;
  }

  bgCpuShare(p) { return p.napped ? 0.03 : p.profile.bg === 'process' ? 1 : 0.4; }

  workload() {
    const w = super.workload();
    if (this.laptop && !this.lidOpen && !this.device.env.externalDisplay) w.display.on = false;
    // swap thrash costs throughput
    this.updateMemory();
    w.perfCap = (w.perfCap ?? 1) * (1 - Math.min(0.5, this.swapMB / this.ramMB * 0.6));
    if (this.state === 'suspended') w.sleepFactor = this.hibernating ? 0.05 : 1;
    return w;
  }

  // ------------------------------------------------------------ sleep
  closeLid() {
    if (!this.laptop) return this.fail('not a laptop');
    this.lidOpen = false;
    this.log('power', 'lid closed (clamshell)');
    const clamshell = this.device.env.externalDisplay && this.hw.chargerWatts(this.device.env) > 0;
    if (clamshell) { this.log('power', 'clamshell mode: external display + power, staying awake'); return { ok: true, msg: 'clamshell mode' }; }
    this.screenOff('lid closed');
    this.sleep('Clamshell Sleep');
    return { ok: true, msg: 'sleeping' };
  }

  openLid() {
    if (!this.laptop) return this.fail('not a laptop');
    this.lidOpen = true;
    this.log('power', 'lid opened');
    if (this.state === 'off') this.boot(); // Apple silicon laptops boot on lid open
    else this.wake('Lid Open');
    return { ok: true, msg: 'lid open' };
  }

  pressPower() {
    if (this.state === 'on' && this.screenOn) return this.sleep('Power Button');
    return super.pressPower();
  }

  sleep(reason) {
    if (this.state !== 'on') return;
    if (this.screenOn) this.screenOff(reason);
    this.state = 'suspended';
    this.log('powerd', `Entering Sleep state due to '${reason}'`);
  }

  wake(reason) {
    if (this.laptop && !this.lidOpen && !this.device.env.externalDisplay && reason !== 'Power Nap') return;
    if (this.hibernating) { this.log('power', 'restoring memory image from /var/vm/sleepimage'); this.hibernating = false; }
    super.wake(reason);
  }

  idlePolicy(dt) {
    const s = this.settings, b = this.hw.battery;
    const prevent = this.assertions.size > 0
      || [...this.procs.values()].some(p => p.profile.bg === 'audio' && p.state !== 'foreground' || p.profile.bg === 'process' && p.state !== 'cached' && this.cpuShare(p) > 0 && p.profile.cpu > 1);
    if (this.state === 'on' && !this.screenOn && !prevent) {
      const after = s.sleepAfterSec > 0 ? s.sleepAfterSec : (b.present && !b.external ? 600 : Infinity);
      if (this.screenOffFor >= after) this.sleep('Idle Sleep');
    }
    if (this.state === 'suspended' && s.powerNap && (b.external || !b.present) && !this.hibernating) {
      this.powerNapIn -= dt;
      if (this.powerNapIn <= 0) {
        this.powerNapIn = 3600;
        this.log('powerd', 'DarkWake for Power Nap: mail, iCloud sync, Time Machine', 'debug');
      }
    }
  }

  sleepName() { return this.hibernating ? 'hibernation' : 'sleep'; }
  wakeOnNotification() { return false; } // notifications queue during sleep; display stays off
  deliverPush(n) { return this.state !== 'suspended' || (this.settings.powerNap && this.hw.battery.external); }

  // ---------------------------------------------------------- battery
  batteryPolicy() {
    const b = this.hw.battery, s = this.settings;
    if (!b.present) return;
    const pct = b.level * 100;
    const want = s.lowPowerMode === 'always' || (s.lowPowerMode === 'battery' && !b.external);
    if (want !== s.lowPower) { s.lowPower = want; this.log('power', `Low Power Mode ${want ? 'on' : 'off'}`); }
    if (pct <= 10 && !b.external && !this._w10) { this._w10 = true; this.notify('settings', 'Low Battery: Your Mac will sleep soon unless plugged into a power outlet.'); }
    if (pct > 15) this._w10 = false;
    if (pct <= 3 && !b.external && this.state === 'on') {
      this.sleep('Low Power Sleep');
      this.hibernating = true;
      this.log('powerd', 'hibernatemode 3: RAM image written, entering standby', 'warn');
    }
    this.effectiveLimit = s.optimizedCharging && b.external && this.uptime > 0 ? Math.min(s.chargeLimit, 0.8) : s.chargeLimit;
  }

  onSetting(key, v) { if (key === 'lowPower') this.settings.lowPowerMode = v ? 'always' : 'never'; }
  chargePolicy() { return { chargeLimit: this.effectiveLimit ?? this.settings.chargeLimit }; }
  lowPowerPerfCap() { return 0.7; }
  powerModeName() { return this.settings.lowPower ? 'Low Power' : 'Automatic'; }

  thermalPolicy() {
    const st = this.thermalState(), t = this.hw.thermal.tempC;
    if (st !== this._st) { this.log('thermal', `thermal pressure: ${st}`, st === 'critical' ? 'warn' : 'info'); this._st = st; }
    if (t >= this.hw.limits.critical + 5) {
      this.log('kernel', 'SMC: thermal emergency, forcing shutdown', 'error');
      this.shutdown('thermal emergency');
    }
  }

  extraSnapshot() {
    this.updateMemory();
    return {
      lidOpen: this.lidOpen, memoryPressure: this.memoryPressure(),
      compressedMB: Math.round(this.compressedMB), swapMB: Math.round(this.swapMB),
      fanPct: Math.round(this.hw.thermal.fan * 100), assertions: [...this.assertions],
      napped: [...this.procs.values()].filter(p => p.napped).map(p => p.id),
    };
  }

  // ------------------------------------------------------------ shell
  findApp(n) { const k = String(n).toLowerCase(); return Object.values(this.apps).find(a => a.id === k || a.name.toLowerCase() === k || a.bundle.toLowerCase() === k); }

  commands() {
    const self = this, s = this.spec, b = this.hw.battery;
    const ver = s.osVersion;
    return {
      sw_vers: () => `ProductName:\t\tmacOS\nProductVersion:\t\t${ver}.0\nBuildVersion:\t\t${{ 13: '22A380', 14: '23A344', 15: '24A335', 26: '25A354' }[ver] || '24A335'}`,
      uname: a => a.includes('-a') ? `Darwin ${s.id}.local 24.0.0 Darwin Kernel Version 24.0.0: RELEASE_ARM64_T8112 arm64` : a.includes('-m') ? 'arm64' : 'Darwin',
      sysctl(a) {
        const k = a.filter(x => !x.startsWith('-'))[0];
        const m = { 'machdep.cpu.brand_string': `Apple ${s.soc.name}`, 'hw.memsize': s.ramGB * 1024 ** 3, 'hw.ncpu': s.soc.perfCores + s.soc.effCores, 'hw.perflevel0.physicalcpu': s.soc.perfCores, 'hw.perflevel1.physicalcpu': s.soc.effCores, 'kern.osproductversion': `${ver}.0`, 'vm.swapusage': `total = 2048.00M  used = ${self.swapMB.toFixed(2)}M` };
        return k ? String(m[k] ?? `sysctl: unknown oid '${k}'`) : Object.entries(m).map(([x, y]) => `${x}: ${y}`).join('\n');
      },
      pmset(a) {
        if (a[0] === 'sleepnow') { self.sleep('Software Sleep pid=1'); return 'Sleeping now...'; }
        if (a[0] === '-g' && a[1] === 'batt') {
          if (!b.present) return "Now drawing from 'AC Power'";
          return `Now drawing from '${b.external ? 'AC Power' : 'Battery Power'}'\n -InternalBattery-0 (id=1234)\t${Math.round(b.level * 100)}%; ${b.charging ? 'charging' : b.external ? 'AC attached; not charging' : 'discharging'}; present: true`;
        }
        if (a[0] === '-g' && a[1] === 'assertions') return `Assertion status system-wide:\n   PreventUserIdleSystemSleep    ${self.assertions.size ? 1 : 0}\nListed by owning process:\n${[...self.assertions].map(x => `   pid ${self.procs.get(x)?.pid || 1}(${x}): PreventUserIdleSystemSleep`).join('\n')}`;
        if (a[0] === '-g' && a[1] === 'therm') return `CPU_Speed_Limit = ${Math.round(self.hw.thermal.throttle * 100)}`;
        if (a[0] === '-g') return ` lowpowermode         ${self.settings.lowPower ? 1 : 0}\n displaysleep         ${Math.round(self.settings.autoLockSec / 60)}\n sleep                ${Math.round(self.settings.sleepAfterSec / 60)}\n powernap             ${self.settings.powerNap ? 1 : 0}\n hibernatemode        3`;
        if (a[0] === '-a' || a[0] === '-b' || a[0] === '-c') {
          const kv = { lowpowermode: v => self.set('lowPower', v === '1'), displaysleep: v => self.set('autoLockSec', Number(v) * 60), sleep: v => self.set('sleepAfterSec', Number(v) * 60), powernap: v => self.set('powerNap', v === '1') };
          for (let i = 1; i < a.length; i += 2) kv[a[i]]?.(a[i + 1]);
          return '';
        }
        return 'usage: pmset -g [batt|assertions|therm] | pmset -a <key> <value> | pmset sleepnow';
      },
      caffeinate(a) { const id = 'caffeinate'; if (a[0] === '-x' || a[0] === 'stop') { self.assertions.delete(id); return 'released'; } self.assertions.add(id); return 'PreventUserIdleSystemSleep asserted (use "caffeinate stop" to release)'; },
      vm_stat: () => { self.updateMemory(); const pg = 16384 / 1024 / 1024; return `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: ${Math.round(Math.max(0, self.freeMB) / pg)}.\nPages occupied by compressor: ${Math.round(self.compressedMB / 2 / pg)}.\nSwapouts: ${Math.round(self.swapMB / pg)}.`; },
      memory_pressure: () => `The system has ${s.ramGB * 1024 ** 3} bytes of memory.\nSystem-wide memory free percentage: ${Math.max(0, Math.round(self.freeMB / self.ramMB * 100))}%\nmemory pressure: ${self.memoryPressure()}`,
      top: () => ['PID    COMMAND          %CPU MEM   STATE', ...[...self.procs.values()].map(p => `${String(p.pid).padEnd(6)} ${p.name.slice(0, 16).padEnd(16)} ${(self.cpuShare(p) * p.profile.cpu / Math.max(0.01, self.hw.cpu.capacity) * 100).toFixed(1).padStart(4)} ${String(p.memMB) + 'M'}  ${p.napped ? 'napping' : p.state === 'foreground' ? 'running' : 'sleeping'}`)].join('\n'),
      ps: () => self.commands().top(),
      open(a) { const i = a.indexOf('-a'); const app = self.findApp(i >= 0 ? a.slice(i + 1).join(' ') : a[0]); return app ? self.launch(app.id).msg : `Unable to find application named '${a.slice(i + 1).join(' ')}'`; },
      killall(a) { const app = self.findApp(a.join(' ')); return app ? (self.kill(app.id).ok ? '' : `No matching processes belonging to you were found`) : 'No matching processes belonging to you were found'; },
      kill(a) { const pid = Number(a.filter(x => !x.startsWith('-'))[0]); const p = [...self.procs.values()].find(x => x.pid === pid); return p ? (self.kill(p.id, 'SIGTERM'), '') : `kill: ${pid}: No such process`; },
      system_profiler(a) {
        if (a[0] === 'SPPowerDataType') return b.present ? `Battery Information:\n  State of Charge (%): ${Math.round(b.level * 100)}\n  Cycle Count: ${Math.floor(b.cycles)}\n  Condition: ${b.health > 0.8 ? 'Normal' : 'Service Recommended'}\n  Maximum Capacity: ${Math.round(b.health * 100)}%\n  Charging: ${b.charging ? 'Yes' : 'No'}\nAC Charger Information:\n  Connected: ${b.external ? 'Yes' : 'No'}${b.external ? `\n  Wattage (W): ${self.device.env.charger?.watts}` : ''}` : 'AC Power: connected (no battery)';
        return `Hardware Overview:\n  Model Name: ${s.name}\n  Chip: Apple ${s.soc.name}\n  Total Number of Cores: ${s.soc.perfCores + s.soc.effCores} (${s.soc.perfCores} performance and ${s.soc.effCores} efficiency)\n  Memory: ${s.ramGB} GB`;
      },
      powermetrics: () => `**** SMC sensors ****\nCPU die temperature: ${self.hw.thermal.tempC.toFixed(2)} C\nFan: ${Math.round(1200 + self.hw.thermal.fan * 5000)} rpm\n**** Processor usage ****\nCPU Power: ${Math.round(self.hw.power.cpuW * 1000)} mW\nCombined Power (CPU + GPU + ANE): ${Math.round((self.hw.power.cpuW + self.hw.power.npuW) * 1000)} mW`,
      uptime: () => `up ${fmtUptime(self.uptime)}, 1 user, load averages: ${(self.hw.cpu.util * s.soc.perfCores).toFixed(2)}`,
      shutdown(a) { if (a.includes('-r')) self.reboot(); else self.shutdown(); return ''; },
      log: () => self.device.events.slice(-30).map(e => `${e.t.toFixed(3)} ${e.tag}: ${e.msg}`).join('\n'),
      osascript: a => /sleep/.test(a.join(' ')) ? (self.sleep('osascript'), '') : 'osascript: only "tell app \\"System Events\\" to sleep" is simulated',
      lid: a => (a[0] === 'close' ? self.closeLid() : self.openLid()).msg,
    };
  }
}

export const macName = v => NAMES[v] || '';
