// iOS behaviour: SecureROM → iBoot → XNU → launchd → SpringBoard boot chain,
// background suspension (with audio / location / VoIP exceptions), jetsam
// memory policy, Low Power Mode prompts, Optimized Battery Charging / charge
// limit, thermal states incl. the "needs to cool down" screen, Face ID /
// Touch ID rules and escalating passcode lockout. iOS exposes no shell, so
// the command set mimics host-side libimobiledevice tools plus Settings.

import { BaseOS, fmtUptime } from '../core/os-base.js';

export class IOS extends BaseOS {
  static id = 'ios';
  static label = 'iOS';

  constructor(device) {
    super(device);
    this.lastPasscode = -Infinity;
    this.faceFails = 0;
    this.coolDown = false;
    this.lpmPrompted = new Set();
    this.unavailable = false;
  }

  defaultSettings() {
    return {
      optimizedCharging: true, chargeLimit: 1, // 80/85/90/95/100 % on iPhone 15+
      backgroundAppRefresh: true,
      autoLockSec: 30, lowPowerPrompt: 'accept', proMotion: this.spec.display.hz > 60,
    };
  }

  defaultApps() {
    return this.makeApps({
      safari: ['browser', 'Safari', { bundle: 'com.apple.mobilesafari' }],
      camera: ['camera', 'Camera', { bundle: 'com.apple.camera' }],
      maps: ['maps', 'Maps', { bundle: 'com.apple.Maps' }],
      tv: ['video', 'TV', { bundle: 'com.apple.tv' }],
      game: ['game', 'Metal 3D game', { bundle: 'com.example.game3d' }],
      music: ['music', 'Music', { bundle: 'com.apple.Music' }],
      messages: ['messages', 'Messages', { bundle: 'com.apple.MobileSMS' }],
      mail: ['mail', 'Mail', { bundle: 'com.apple.mobilemail' }],
      photos: ['photos', 'Photos', { bundle: 'com.apple.mobileslideshow' }],
      settings: ['settings', 'Settings', { bundle: 'com.apple.Preferences' }],
      facetime: ['videocall', 'FaceTime', { bundle: 'com.apple.facetime' }],
      siri: ['assistant', 'Siri', { bundle: 'com.apple.siri' }],
    });
  }

  bootStages() {
    return [
      ['SecureROM: verifying iBoot signature', 0.5],
      ['iBoot: loading kernelcache, Secure Enclave firmware', 1.5],
      ['XNU kernel init, APFS mount (Data volume class keys locked)', 2.5],
      ['launchd: starting daemons (backboardd, thermalmonitord, powerd)', 3.0],
      ['SpringBoard: lock screen ready', 2.5],
    ];
  }

  onBooted() { this.faceFails = 0; this.coolDown = false; }

  // ---------------------------------------------------------- security
  biometricName(m) { return m === 'face' ? 'Face ID' : 'Touch ID'; }
  biometricBlocked() { return this.faceFails >= 5 || this.now - this.lastPasscode > 48 * 3600; }

  unlock(opts = {}) {
    if (this.unavailable) return this.fail('iPhone Unavailable. Erase iPhone to continue.');
    if (this.coolDown) return this.fail('iPhone needs to cool down before you can use it.');
    const method = opts.method || 'pin';
    if (method !== 'pin' && this.spec.biometrics === method && opts.match === false) {
      this.faceFails++;
      return this.fail(`${this.biometricName(method)} not recognised (${this.faceFails}/5)`);
    }
    const r = super.unlock(opts);
    if (r.ok && method === 'pin') { this.lastPasscode = this.now; this.faceFails = 0; }
    if (!r.ok && this.failedUnlocks >= 10) {
      this.unavailable = true;
      this.log('security', 'iPhone Unavailable (10 failed passcode attempts)', 'error');
    }
    return r;
  }

  lockoutAfter(n) { return { 5: 60, 6: 300, 7: 900, 8: 3600, 9: 3600 }[n] || (n >= 10 ? Infinity : 0); }
  grantKind(perm) {
    return { location: 'granted (While Using)', photos: 'granted (Limited Access)', contacts: 'granted' }[perm] || 'granted';
  }

  // ----------------------------------------------------------- memory
  systemMemMB() { return 1200 + this.spec.ramGB * 60; }
  memReserveMB() { return 150 + this.spec.ramGB * 10; }
  perAppLimitMB() { return this.ramMB * (this.spec.ramGB >= 6 ? 0.6 : 0.5); }

  launch(appId) {
    if (this.coolDown) return this.fail('iPhone needs to cool down before you can use it.');
    const r = super.launch(appId);
    const p = this.procs.get(appId);
    if (r.ok && p && p.memMB > this.perAppLimitMB()) {
      this.kill(appId, `jetsam: per-process limit ${Math.round(this.perAppLimitMB())}MB exceeded (EXC_RESOURCE)`);
      return { ok: false, msg: `${p.name} quit unexpectedly (memory limit)` };
    }
    return r;
  }

  // jetsam: suspended apps first (LRU), then background, never foreground
  reclaimMemory() {
    const v = this.lruBackground(p => p.state === 'suspended')
      || this.lruBackground(p => !this.keepsRunning(p));
    if (!v) return false;
    this.kill(v.id, `jetsam (memory pressure, priority band ${v.state === 'suspended' ? 0 : 10})`);
    return true;
  }

  // ------------------------------------------------------- background
  keepsRunning(p) {
    const bg = p.profile.bg;
    if (bg === 'audio' || bg === 'voip') return true;
    if (bg === 'location') return this.settings.location;
    return false;
  }

  onBackground(p) {
    if (this.keepsRunning(p)) this.log('app', `${p.name} continues in background (${p.profile.bg} mode)`);
  }

  backgroundPolicy(p) {
    if (p.state === 'background' && !this.keepsRunning(p) && p.bgFor >= 5) {
      p.state = 'suspended';
      this.log('app', `${p.name} suspended`, 'debug');
    }
  }

  bgCpuShare(p) { return this.keepsRunning(p) ? 0.5 : 0.15; }

  extraLoad() {
    // Background App Refresh: periodic short wakes for 'push' apps
    if (this.settings.lowPower || !this.settings.backgroundAppRefresh || this.state !== 'on') return {};
    const refreshing = [...this.procs.values()].filter(p => p.state === 'suspended' && p.profile.bg === 'push').length;
    return { cpu: refreshing * 0.01, net: refreshing * 0.005 };
  }

  idlePolicy() {
    const active = [...this.procs.values()].some(p => p.state !== 'suspended' && p.state !== 'foreground' && this.keepsRunning(p));
    if (this.state === 'on' && !this.screenOn && !active && this.screenOffFor > 3) {
      this.state = 'suspended';
      this.log('power', 'system idle sleep', 'debug');
    } else if (this.state === 'suspended' && active) this.state = 'on';
  }

  sleepFactor() { return 0.9; }
  alwaysOnDisplay() { return !!this.spec.display?.aod && !this.settings.lowPower; }

  // --------------------------------------------------------- battery
  batteryPolicy() {
    const b = this.hw.battery, pct = Math.round(b.level * 100);
    // charge limit: Optimized Battery Charging holds at 80 % while plugged in
    const optimized = this.settings.optimizedCharging && b.external ? 0.8 : 1;
    this.effectiveLimit = Math.min(this.settings.chargeLimit, optimized);
    for (const at of [20, 10]) {
      if (pct <= at && !b.external && !this.lpmPrompted.has(at)) {
        this.lpmPrompted.add(at);
        this.notify('settings', `Low Battery: ${at}% of battery remaining.`);
        if (!this.settings.lowPower && this.settings.lowPowerPrompt === 'accept') {
          this.settings.lowPower = true;
          this.log('power', 'Low Power Mode turned on (accepted low-battery prompt)');
        }
      }
    }
    if (pct > 25) this.lpmPrompted.clear();
    if (this.settings.lowPower && b.external && pct >= 80) {
      this.settings.lowPower = false;
      this.log('power', 'Low Power Mode turned off automatically (charged to 80%)');
    }
  }

  onSetting(key, v) {
    if (key === 'lowPower') {
      if (v) { this._prevLock = this.settings.autoLockSec; this.settings.autoLockSec = 30; }
      else if (this._prevLock) this.settings.autoLockSec = this._prevLock;
    }
    if (key === 'chargeLimit' && ![0.8, 0.85, 0.9, 0.95, 1].includes(v)) {
      this.settings.chargeLimit = 1;
      this.log('settings', 'charge limit must be 80, 85, 90, 95 or 100%', 'warn');
    }
  }

  lowPowerPerfCap() { return 0.6; }
  chargePolicy() { return { chargeLimit: this.effectiveLimit ?? this.settings.chargeLimit }; }

  // --------------------------------------------------------- thermal
  thermalPolicy() {
    const st = this.thermalState(), L = this.hw.limits, t = this.hw.thermal.tempC;
    if (st !== this._lastSt) {
      this.log('thermal', `ProcessInfo.thermalState → .${st}`, st === 'serious' || st === 'critical' ? 'warn' : 'info');
      this._lastSt = st;
    }
    if (!this.coolDown && t >= L.critical + 3) {
      this.coolDown = true;
      this.home();
      this.screenOn = true;
      this.log('thermal', 'Temperature: iPhone needs to cool down before you can use it.', 'error');
    } else if (this.coolDown && t < L.critical) {
      this.coolDown = false;
      this.log('thermal', 'temperature warning cleared');
    }
  }

  effectiveBrightness() {
    const st = this.thermalState();
    const b = super.effectiveBrightness();
    if (this.coolDown) return 0.1;
    return st === 'serious' || st === 'critical' ? Math.min(b, 0.55) : b;
  }

  workload() {
    const w = super.workload();
    if (w.display && !this.settings.proMotion && w.display.hz > 60) w.display.hz = 60;
    if (this.coolDown) w.cpu = Math.min(w.cpu, 0.2);
    return w;
  }

  powerModeName() { return this.settings.lowPower ? 'Low Power Mode' : 'Normal'; }
  extraSnapshot() { return { coolDown: this.coolDown, unavailable: this.unavailable, chargeLimitEffective: this.effectiveLimit ?? 1 }; }

  // ------------------------------------------------------------ "shell"
  bundleToApp(b) { return Object.values(this.apps).find(a => a.bundle === b || a.id === b); }

  commands() {
    const self = this, s = this.spec, b = this.hw.battery;
    const info = () => ({
      DeviceName: s.name, ProductType: s.id, ProductVersion: s.osVersion,
      HardwareModel: s.soc.name, CPUArchitecture: 'arm64e', TotalRAM: `${s.ramGB}GB`,
      BatteryCurrentCapacity: Math.round(b.level * 100), BatteryIsCharging: b.charging,
      ExternalConnected: b.external, PasswordProtected: true,
    });
    return {
      ideviceinfo(a) {
        const i = info();
        if (a[0] === '-k') return String(i[a[1]] ?? '');
        return Object.entries(i).map(([k, v]) => `${k}: ${v}`).join('\n');
      },
      idevicediagnostics(a) {
        if (a[0] === 'ioregentry' && a[1] === 'AppleSmartBattery') return [
          `CurrentCapacity = ${Math.round(b.level * 100)}`, `CycleCount = ${Math.floor(b.cycles)}`,
          `DesignCapacity = ${s.battery.mAh}`, `NominalChargeCapacity = ${Math.round(s.battery.mAh * b.health)}`,
          `Temperature = ${Math.round(self.hw.thermal.tempC * 100)}`, `Voltage = ${b.mV}`,
          `IsCharging = ${b.charging ? 'Yes' : 'No'}`, `ExternalConnected = ${b.external ? 'Yes' : 'No'}`,
        ].join('\n');
        if (a[0] === 'restart') { self.reboot(); return 'Restarting device.'; }
        if (a[0] === 'shutdown') { self.shutdown(); return 'Shutting down device.'; }
        return 'usage: idevicediagnostics ioregentry AppleSmartBattery | restart | shutdown';
      },
      battery: () => [
        `Battery: ${Math.round(b.level * 100)}%${b.charging ? ' (charging)' : ''}`,
        `Low Power Mode: ${self.settings.lowPower ? 'On' : 'Off'}`,
        `Maximum Capacity: ${Math.round(b.health * 100)}%  Cycle Count: ${Math.floor(b.cycles)}`,
        `Charging Optimization: ${self.settings.optimizedCharging ? 'Optimized Battery Charging' : 'None'}; Limit ${Math.round(self.settings.chargeLimit * 100)}%`,
      ].join('\n'),
      open(a) { const app = self.bundleToApp(a[0]); return app ? self.launch(app.id).msg : `no app with bundle id ${a[0]}`; },
      killall(a) { const app = Object.values(self.apps).find(x => x.name === a[0] || x.id === a[0]); return app ? self.kill(app.id).msg : 'No matching processes'; },
      shortcuts(a) {
        if (a[0] === 'run' && /low power/i.test(a[1] || '')) return self.set('lowPower', !self.settings.lowPower).msg;
        return 'usage: shortcuts run "Low Power Mode"';
      },
      log: () => self.device.events.slice(-30).map(e => `${e.t.toFixed(1).padStart(8)} ${e.tag}[${e.level}]: ${e.msg}`).join('\n'),
      uptime: () => `up ${fmtUptime(self.uptime)}`,
      ps: () => 'ps: Operation not permitted (sandboxed; no shell on iOS)',
      sh: () => 'sh: Operation not permitted (sandboxed; no shell on iOS)',
    };
  }
}
