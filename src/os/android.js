// Android behaviour: verified boot → init → zygote → system_server, lmkd
// (low memory killer by oom_adj), cached-app freezer, App Standby buckets,
// Doze (light & deep), Battery Saver, adaptive/limited charging, thermal
// status levels and an `adb shell`-like command set.

import { BaseOS, fmtUptime } from '../core/os-base.js';

const DOZE = ['ACTIVE', 'INACTIVE', 'LIGHT_IDLE', 'IDLE_PENDING', 'SENSING', 'IDLE'];
const THERMAL_STATUS = ['NONE', 'LIGHT', 'MODERATE', 'SEVERE', 'CRITICAL', 'EMERGENCY', 'SHUTDOWN'];

export class AndroidOS extends BaseOS {
  static id = 'android';
  static label = 'Android';

  constructor(device) {
    super(device);
    this.doze = 'ACTIVE';
    this.dozeFor = 0;
    this.maintenanceIn = 0;
    this.deferredPush = [];
    this.lastStrongAuth = -Infinity;
    this.saverAuto = false;
  }

  defaultSettings() {
    return { batterySaverAt: 15, adaptiveCharging: true, autoLockSec: 30, chargeLimit: 1, developerOptions: false };
  }

  defaultApps() {
    const vendor = this.spec.vendor;
    return this.makeApps({
      chrome: ['browser', 'Chrome', { pkg: 'com.android.chrome' }],
      camera: ['camera', 'Camera', { pkg: vendor === 'Samsung' ? 'com.sec.android.app.camera' : 'com.google.android.GoogleCamera' }],
      maps: ['maps', 'Maps', { pkg: 'com.google.android.apps.maps' }],
      youtube: ['video', 'YouTube', { pkg: 'com.google.android.youtube' }],
      game: ['game', 'Genshin-class 3D game', { pkg: 'com.example.game3d' }],
      music: ['music', 'YouTube Music', { pkg: 'com.google.android.apps.youtube.music' }],
      messages: ['messages', 'Messages', { pkg: 'com.google.android.apps.messaging' }],
      gmail: ['mail', 'Gmail', { pkg: 'com.google.android.gm' }],
      photos: ['photos', 'Photos', { pkg: 'com.google.android.apps.photos' }],
      settings: ['settings', 'Settings', { pkg: 'com.android.settings' }],
      meet: ['videocall', 'Meet', { pkg: 'com.google.android.apps.tachyon' }],
      gemini: ['assistant', 'Gemini', { pkg: 'com.google.android.apps.bard' }],
    });
  }

  bootStages() {
    return [
      ['bootloader: Android Verified Boot (AVB) state GREEN', 1.0],
      ['kernel: decompress & init drivers', 1.5],
      ['init: first stage mount, SELinux enforcing', 1.0],
      ['init: second stage, starting HALs (health, thermal, power)', 2.0],
      ['zygote64 preloading classes', 3.0],
      ['system_server: ActivityManager, PackageManager, PowerManager', 4.0],
      ['SystemUI + launcher; sys.boot_completed=1, BOOT_COMPLETED broadcast', 3.0],
    ];
  }

  onBooted() {
    this.doze = 'ACTIVE';
    this.lastStrongAuth = -Infinity;
    if (this.settings.adaptiveCharging && this.spec.vendor === 'Google') this.settings.chargeLimit = 0.8;
  }

  // ---------------------------------------------------------- security
  biometricName() { return 'Fingerprint Unlock'; }
  unlock(opts = {}) {
    if (opts.method && opts.method !== 'pin' && this.now - this.lastStrongAuth > 72 * 3600)
      if (this.unlockedSinceBoot) return this.fail('PIN required: not entered in the last 72 hours');
    const r = super.unlock(opts);
    if (r.ok && (opts.method || 'pin') === 'pin') this.lastStrongAuth = this.now;
    return r;
  }
  lockoutAfter(n) { return n >= 5 && n % 5 === 0 ? 30 : 0; }
  grantKind(perm) { return perm === 'location' ? 'granted (while using app)' : 'granted'; }

  // ----------------------------------------------------------- memory
  systemMemMB() { return 1800 + this.spec.ramGB * 90; }
  memReserveMB() { return 256 + this.spec.ramGB * 16; }

  oomAdj(p) {
    if (p.state === 'foreground') return 0;
    if (p.fgService) return 200; // perceptible
    if (p.state === 'background') return 700;
    return 900 + Math.min(99, Math.floor(p.bgFor / 60)); // cached
  }

  reclaimMemory() {
    let victim = null;
    for (const p of this.procs.values()) {
      if (p.state === 'foreground') continue;
      if (!victim || this.oomAdj(p) > this.oomAdj(victim)
        || (this.oomAdj(p) === this.oomAdj(victim) && p.bgFor > victim.bgFor)) victim = p;
    }
    if (!victim) return false;
    this.kill(victim.id, `lmkd (oom_score_adj ${this.oomAdj(victim)}, free ${Math.round(this.freeMB)}MB)`);
    return true;
  }

  // ------------------------------------------------------- background
  onBackground(p) {
    const bg = p.profile.bg;
    p.fgService = (bg === 'audio' || (bg === 'location' && this.settings.location) || bg === 'voip');
    if (p.fgService) this.log('app', `${p.name} running foreground service (${bg})`);
  }

  backgroundPolicy(p) {
    if (p.fgService) return;
    if (p.state === 'background' && p.bgFor >= 10) {
      p.state = 'cached';
      this.log('app', `${p.name} cached & frozen (cgroup freezer)`, 'debug');
    }
  }

  bgCpuShare(p) {
    if (p.fgService) return this.doze === 'IDLE' && p.profile.bg !== 'audio' ? 0.3 : 0.6;
    return 0.05;
  }

  standbyBucket(p) {
    if (!p) return 'NEVER';
    if (p.state === 'foreground' || p.fgService) return 'ACTIVE';
    if (p.bgFor < 3600 * 12) return 'WORKING_SET';
    if (p.bgFor < 3600 * 24 * 2) return 'FREQUENT';
    if (p.bgFor < 3600 * 24 * 8) return 'RARE';
    return 'RESTRICTED';
  }

  // ------------------------------------------------------------ doze
  idlePolicy(dt) {
    const env = this.device.env;
    const canDoze = !this.screenOn && !this.hw.battery.external;
    if (!canDoze) {
      if (this.doze !== 'ACTIVE') {
        this.log('deviceidle', `exit ${this.doze} → ACTIVE`);
        this.flushPush();
      }
      this.doze = 'ACTIVE'; this.dozeFor = 0;
    } else {
      this.dozeFor += dt;
      const before = this.doze;
      // light doze ignores motion; deep doze requires stationary
      if (this.doze === 'ACTIVE') this.doze = 'INACTIVE';
      if (this.doze === 'INACTIVE' && this.dozeFor >= 5 * 60) this.doze = 'LIGHT_IDLE';
      if (this.doze === 'LIGHT_IDLE' && this.dozeFor >= 30 * 60 && !env.moving) this.doze = 'IDLE_PENDING';
      if (this.doze === 'IDLE_PENDING' && this.dozeFor >= 30 * 60 + 30) this.doze = 'SENSING';
      if (this.doze === 'SENSING' && this.dozeFor >= 30 * 60 + 34) this.doze = env.moving ? 'LIGHT_IDLE' : 'IDLE';
      if (this.doze !== before) {
        this.log('deviceidle', `${before} → ${this.doze}`);
        this.maintenanceIn = this.doze === 'IDLE' ? 3600 : 15 * 60;
      }
      if (this.doze === 'IDLE' || this.doze === 'LIGHT_IDLE') {
        this.maintenanceIn -= dt;
        if (this.maintenanceIn <= 0) {
          this.log('deviceidle', 'maintenance window: deferred jobs, syncs & alarms run');
          this.flushPush();
          this.maintenanceIn = this.doze === 'IDLE' ? Math.min(6 * 3600, 3600 * 2) : 15 * 60;
        }
      }
    }
    // kernel suspend when screen off & nothing holds a wakelock
    const held = [...this.procs.values()].some(p => p.fgService && p.profile.bg !== 'push');
    if (this.state === 'on' && !this.screenOn && !held && this.screenOffFor > 5 && !this.hw.battery.charging) {
      this.state = 'suspended';
      this.log('power', 'kernel suspend (no wakelocks held)', 'debug');
    } else if (this.state === 'suspended' && (held || this.hw.battery.charging)) {
      this.state = 'on';
    }
  }

  sleepName() { return `suspend (${this.doze})`; }
  sleepFactor() { return this.doze === 'IDLE' ? 0.55 : this.doze === 'LIGHT_IDLE' ? 0.8 : 1; }
  onResume() {}

  deliverPush(n) {
    const highPriority = /call|otp|alarm|urgent/i.test(n.text);
    if ((this.doze === 'IDLE' || this.doze === 'LIGHT_IDLE') && !highPriority) {
      this.deferredPush.push(n);
      this.log('fcm', `normal-priority message deferred by Doze (${this.apps[n.appId]?.name || n.appId})`, 'debug');
      return false;
    }
    return true;
  }
  flushPush() {
    const q = this.deferredPush; this.deferredPush = [];
    for (const n of q) { this.notifications.push(n); this.log('notify', `${this.apps[n.appId]?.name || n.appId}: ${n.text} (delayed)`); }
  }

  // --------------------------------------------------------- battery
  batteryPolicy() {
    const b = this.hw.battery;
    if (!b.present) return;
    const pct = b.level * 100;
    if (!this.settings.lowPower && !b.external && pct <= this.settings.batterySaverAt) {
      this.settings.lowPower = true; this.saverAuto = true;
      this.log('power', `Battery Saver turned on automatically at ${Math.round(pct)}%`);
      this.notify('settings', 'Battery Saver is on. Some features may be limited.');
    }
    if (this.settings.lowPower && this.saverAuto && b.external && pct >= 90) {
      this.settings.lowPower = false; this.saverAuto = false;
      this.log('power', 'Battery Saver turned off (charged to 90%)');
    }
    if (pct <= 5 && !b.external && !this._warned5) {
      this._warned5 = true; this.notify('settings', 'Battery critically low: 5% remaining');
    }
    if (pct > 10) this._warned5 = false;
  }

  lowPowerPerfCap() { return 0.65; }
  alwaysOnDisplay() { return !!this.spec.display?.aod && !this.settings.lowPower; }

  // --------------------------------------------------------- thermal
  thermalStatus() {
    const t = this.hw.thermal.tempC, L = this.hw.limits;
    if (t >= L.shutdown) return 'SHUTDOWN';
    if (t >= L.critical + 3) return 'EMERGENCY';
    if (t >= L.critical) return 'CRITICAL';
    if (t >= L.end) return 'SEVERE';
    if (t >= (L.start + L.end) / 2) return 'MODERATE';
    if (t >= L.start) return 'LIGHT';
    return 'NONE';
  }

  thermalPolicy() {
    const st = this.thermalStatus();
    if (st !== this._lastThermal) {
      this.log('thermal', `thermal status ${this._lastThermal || 'NONE'} → ${st}`, THERMAL_STATUS.indexOf(st) >= 3 ? 'warn' : 'info');
      if (st === 'SEVERE') this.notify('settings', 'Phone is getting warm. Some features limited while it cools down.');
      if (st === 'EMERGENCY' && this.foreground && this.procs.get(this.foreground)?.profile.cpu > 2) {
        this.kill(this.foreground, 'thermal emergency');
      }
      this._lastThermal = st;
    }
  }

  effectiveBrightness() {
    const b = super.effectiveBrightness();
    const st = this.thermalStatus();
    return st === 'SEVERE' || st === 'CRITICAL' || st === 'EMERGENCY' ? Math.min(b, 0.6) : b;
  }

  powerModeName() { return this.settings.lowPower ? 'Battery Saver' : 'Default'; }

  extraSnapshot() {
    return { doze: this.doze, thermalStatus: this.thermalStatus(), deferredPush: this.deferredPush.length };
  }

  // ------------------------------------------------------------ shell
  pkgToApp(pkg) { return Object.values(this.apps).find(a => a.pkg === pkg || a.id === pkg); }

  getprop() {
    const s = this.spec;
    return {
      'ro.product.model': s.name, 'ro.product.manufacturer': s.vendor,
      'ro.product.device': s.id, 'ro.build.version.release': s.osVersion,
      'ro.build.version.sdk': { 14: 34, 15: 35, 16: 36 }[s.osVersion] || 35,
      'ro.soc.model': s.soc.name, 'ro.boot.verifiedbootstate': 'green',
      'sys.boot_completed': this.state === 'on' || this.state === 'suspended' ? '1' : '0',
      'ro.sf.lcd_density': Math.round(s.display.ppi / 160) * 160 > 0 ? Math.min(640, Math.round(s.display.ppi * 0.9 / 40) * 40) : 420,
    };
  }

  commands() {
    const self = this;
    return {
      getprop(a) {
        const p = self.getprop();
        if (a[0]) return String(p[a[0]] ?? '');
        return Object.entries(p).map(([k, v]) => `[${k}]: [${v}]`).join('\n');
      },
      uname: a => a.includes('-a') ? `Linux localhost 6.1.99-android14-11 #1 SMP PREEMPT aarch64 Toybox` : 'Linux',
      uptime: () => `up ${fmtUptime(self.uptime)}, load average: ${(self.hw.cpu.util * 4).toFixed(2)}`,
      dumpsys(a) {
        const b = self.hw.battery;
        switch (a[0]) {
          case 'battery': return [
            'Current Battery Service state:',
            `  AC powered: ${!!self.device.env.charger && self.device.env.charger.kind !== 'wireless'}`,
            `  Wireless powered: ${self.device.env.charger?.kind === 'wireless'}`,
            `  status: ${b.charging ? 2 : b.level >= 0.995 ? 5 : 3}`,
            `  health: 2`, `  present: true`,
            `  level: ${Math.round(b.level * 100)}`, `  scale: 100`,
            `  voltage: ${b.mV}`, `  temperature: ${Math.round(self.hw.thermal.tempC * 10)}`,
            `  technology: Li-ion`, `  cycle count: ${Math.floor(b.cycles)}`,
            `  charge limit: ${Math.round(self.settings.chargeLimit * 100)}%`,
          ].join('\n');
          case 'deviceidle': return `  mState=${self.doze} mLightState=${self.doze === 'LIGHT_IDLE' ? 'IDLE' : 'ACTIVE'}\n  mScreenOn=${self.screenOn} mCharging=${b.charging}`;
          case 'thermalservice': return `IsStatusOverride: false\nThermal Status: ${THERMAL_STATUS.indexOf(self.thermalStatus())}\nCurrent temperatures from HAL:\n  Temperature{mValue=${self.hw.thermal.tempC.toFixed(1)}, mType=2, mName=battery, mStatus=${THERMAL_STATUS.indexOf(self.thermalStatus())}}`;
          case 'meminfo': return [`Total RAM: ${Math.round(self.ramMB * 1024)}K`, ` Free RAM: ${Math.round(self.freeMB * 1024)}K`, ...[...self.procs.values()].map(p => `  ${Math.round(self.procMem(p) * 1024).toString().padStart(9)}K: ${p.profile.pkg} (pid ${p.pid}) adj=${self.oomAdj(p)}`)].join('\n');
          case 'power': return `mWakefulness=${self.screenOn ? 'Awake' : 'Asleep'}\nmIsPowered=${b.external}\nmBatterySaverEnabled=${self.settings.lowPower}`;
          case 'usagestats': return Object.values(self.apps).map(a => `  package=${a.pkg} bucket=${self.standbyBucket(self.procs.get(a.id))}`).join('\n');
          case 'activity': return `  mResumedActivity: ${self.foreground ? self.apps[self.foreground].pkg : 'com.google.android.apps.nexuslauncher'}`;
          default: return 'usage: dumpsys battery|deviceidle|thermalservice|meminfo|power|usagestats|activity';
        }
      },
      pm(a) {
        if (a[0] === 'list' && a[1] === 'packages') return Object.values(self.apps).map(x => `package:${x.pkg}`).join('\n');
        if (a[0] === 'grant' || a[0] === 'revoke') { const app = self.pkgToApp(a[1]); if (!app) return 'Unknown package'; self.setPermission(app.id, a[2].replace('android.permission.', '').toLowerCase(), a[0] === 'grant' ? 'granted' : 'denied'); return ''; }
        return 'usage: pm list packages | pm grant|revoke <pkg> <perm>';
      },
      am(a) {
        if (a[0] === 'start') { const pkg = (a.includes('-n') ? a[a.indexOf('-n') + 1] : a[1] || '').split('/')[0]; const app = self.pkgToApp(pkg); return app ? self.launch(app.id).msg : `Error: Activity not started, unable to resolve ${pkg}`; }
        if (a[0] === 'force-stop') { const app = self.pkgToApp(a[1]); return app ? self.kill(app.id).msg : ''; }
        return 'usage: am start -n <pkg>/<activity> | am force-stop <pkg>';
      },
      input(a) {
        if (a[0] !== 'keyevent') return 'usage: input keyevent <code>';
        const k = a[1];
        if (k === '26' || k === 'KEYCODE_POWER') self.pressPower();
        else if (k === '3' || k === 'KEYCODE_HOME') self.home();
        else if (k === '224' || k === 'KEYCODE_WAKEUP') self.wake('keyevent');
        else if (k === '223' || k === 'KEYCODE_SLEEP') self.screenOff('keyevent');
        return '';
      },
      settings(a) {
        const map = { low_power: 'lowPower', screen_brightness: 'brightness', airplane_mode_on: 'airplane', wifi_on: 'wifi', screen_off_timeout: 'autoLockSec', location_mode: 'location' };
        const key = map[a[2]] || a[2];
        if (a[0] === 'get') return String(self.settings[key] ?? 'null');
        if (a[0] === 'put') { let v = a[3]; if (a[2] === 'screen_brightness') v = Number(v) / 255; if (a[2] === 'screen_off_timeout') v = Number(v) / 1000; return self.set(key, v).ok ? '' : 'error'; }
        return 'usage: settings get|put <namespace> <key> [value]';
      },
      svc(a) { if (['wifi', 'data', 'bluetooth'].includes(a[0])) { self.set(a[0] === 'data' ? 'cellular' : a[0], a[1] === 'enable'); return ''; } return 'usage: svc wifi|data|bluetooth enable|disable'; },
      cmd(a) {
        if (a[0] === 'battery' && a[1] === 'unplug') { self.device.unplug(); return ''; }
        if (a[0] === 'battery' && a[1] === 'reset') { self.device.plug({ kind: 'usb-pd', watts: 30 }); return ''; }
        if (a[0] === 'deviceidle' && a[1] === 'force-idle') { self.doze = 'IDLE'; self.log('deviceidle', 'forced IDLE'); return 'Now forced in to deep idle mode'; }
        if (a[0] === 'deviceidle' && a[1] === 'unforce') { self.doze = 'ACTIVE'; self.flushPush(); return 'Light state: ACTIVE, deep state: ACTIVE'; }
        return 'usage: cmd battery unplug|reset | cmd deviceidle force-idle|unforce';
      },
      wm: a => a[0] === 'size' ? `Physical size: ${self.spec.display.w}x${self.spec.display.h}` : a[0] === 'density' ? `Physical density: ${self.getprop()['ro.sf.lcd_density']}` : 'usage: wm size|density',
      free: () => `\t\ttotal\tused\tfree\nMem:\t${Math.round(self.ramMB)}\t${Math.round(self.usedMB)}\t${Math.round(self.freeMB)}`,
      top: () => ['  PID USER  S %CPU  RES NAME', ...[...self.procs.values()].map(p => `${String(p.pid).padStart(5)} u0_a  ${p.state === 'cached' ? 'T' : 'S'} ${(self.cpuShare(p) * p.profile.cpu / Math.max(0.01, self.hw.cpu.capacity) * 100).toFixed(1).padStart(4)} ${Math.round(self.procMem(p))}M ${p.profile.pkg}`)].join('\n'),
      logcat: () => self.device.events.slice(-30).map(e => `${e.t.toFixed(1).padStart(8)} ${e.level[0].toUpperCase()} ${e.tag}: ${e.msg}`).join('\n'),
      reboot: () => { self.reboot(); return ''; },
    };
  }
}
