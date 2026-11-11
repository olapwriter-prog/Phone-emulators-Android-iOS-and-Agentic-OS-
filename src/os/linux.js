// Mobile / desktop Linux behaviour (postmarketOS, PureOS, Ubuntu Touch, or
// a mainline distro on other hardware): U-Boot/GRUB → kernel → systemd boot,
// background apps keep running (no freezer), kernel OOM killer by oom_score,
// systemd-logind idle suspend with modem wake, hardware kill switches,
// power-profiles-daemon, kernel thermal trip points, UPower critical action
// and a real-ish POSIX shell.

import { BaseOS, fmtUptime } from '../core/os-base.js';

export class LinuxOS extends BaseOS {
  static id = 'linux';
  static label = 'Linux';

  constructor(device) {
    super(device);
    const ks = this.spec.killSwitches || [];
    this.killSwitches = Object.fromEntries(ks.map(k => [k, true])); // true = hardware enabled
    this.profile = 'balanced';
    this.suspendedAt = null;
    this.units = { 'ModemManager.service': 'active', 'NetworkManager.service': 'active', 'bluetooth.service': 'active', 'phosh.service': 'active', 'upower.service': 'active', 'power-profiles-daemon.service': 'active' };
  }

  get distro() {
    if (this.spec.distro) return this.spec.distro;
    const isMac = this.spec.vendor === 'Apple';
    return isMac
      ? { name: 'Fedora Asahi Remix 41', shell: 'GNOME', kernel: '6.12.4-asahi' }
      : { name: 'postmarketOS edge', shell: 'Phosh', kernel: '6.12.9-postmarketos-qcom-sm7325' };
  }

  defaultSettings() {
    const mobile = this.spec.family !== 'desktop' && this.spec.family !== 'laptop';
    return { autoSuspend: true, suspendAfterSec: mobile ? 120 : 900, autoLockSec: mobile ? 60 : 300, criticalAction: 'PowerOff', chargeLimit: 1 };
  }

  defaultApps() {
    const desk = this.spec.family === 'laptop' || this.spec.family === 'desktop';
    return this.makeApps({
      firefox: ['browser', 'Firefox', { desktop: 'org.mozilla.firefox' }],
      camera: ['camera', desk ? 'Snapshot' : 'Megapixels', { desktop: desk ? 'org.gnome.Snapshot' : 'org.postmarketos.Megapixels' }],
      maps: ['maps', 'GNOME Maps', { desktop: 'org.gnome.Maps' }],
      video: ['video', 'Clapper', { desktop: 'com.github.rafostar.Clapper' }],
      game: ['game', 'SuperTuxKart', { desktop: 'net.supertuxkart.SuperTuxKart' }],
      music: ['music', 'Amberol', { desktop: 'io.bassi.Amberol' }],
      chatty: ['messages', 'Chats', { desktop: 'sm.puri.Chatty' }],
      mail: ['mail', 'Geary', { desktop: 'org.gnome.Geary' }],
      settings: ['settings', 'Settings', { desktop: 'org.gnome.Settings' }],
      console: ['terminal', 'Console', { desktop: 'org.gnome.Console' }],
      ...(desk ? { code: ['ide', 'VS Code (OSS)', { desktop: 'code-oss' }], blender: ['render', 'Blender', { desktop: 'org.blender.Blender' }] } : {}),
    });
  }

  bootStages() {
    const desk = this.spec.vendor === 'Apple';
    return [
      [desk ? 'm1n1 → U-Boot → GRUB' : 'U-Boot / lk2nd bootloader', 1.0],
      [`Linux ${this.distro.kernel}: early init, devicetree`, 2.0],
      ['initramfs: unlocking & mounting rootfs', 1.5],
      ['systemd: reached basic.target, starting NetworkManager, ModemManager', 3.5],
      [`systemd: graphical.target, ${this.distro.shell} lock screen`, 3.0],
    ];
  }

  // ---------------------------------------------------------- security
  hasLockScreen() { return this.spec.display != null; }
  lockoutAfter(n) { return n >= 3 && n % 3 === 0 ? 600 : 0; } // pam_faillock deny=3 unlock_time=600
  biometricName(m) { return m === 'fingerprint' ? 'fprintd' : m; }
  grantKind(perm) { return `granted (xdg-desktop-portal)`; }
  requestPermission(appId, perm) {
    // Native packages are not sandboxed; only portals for camera/location.
    if (perm === 'contacts' || perm === 'photos') return 'granted';
    if (perm === 'camera' && this.killSwitches.camera === false) return 'unavailable (kill switch)';
    if (perm === 'microphone' && this.killSwitches.mic === false) return 'unavailable (kill switch)';
    return super.requestPermission(appId, perm);
  }

  // ----------------------------------------------------------- memory
  systemMemMB() { return this.spec.family === 'phone' ? 550 : 1600; }
  memReserveMB() { return 64; }
  procMem(p) { return p.memMB; }

  // kernel OOM killer: biggest resident process, foreground included
  reclaimMemory() {
    let victim = null;
    for (const p of this.procs.values()) if (!victim || p.memMB > victim.memMB) victim = p;
    if (!victim) return false;
    if (victim.state === 'foreground' && this.procs.size > 1) {
      // oom_score_adj of the focused app is lowered slightly by the compositor
      const alt = [...this.procs.values()].filter(p => p.state !== 'foreground').sort((a, b) => b.memMB - a.memMB)[0];
      if (alt && alt.memMB >= victim.memMB * 0.7) victim = alt;
    }
    this.kill(victim.id, `Out of memory: Killed process ${victim.pid} (${victim.name}) total-vm:${victim.memMB * 1024}kB`);
    return true;
  }

  // ------------------------------------------------------- background
  bgCpuShare(p) { return p.profile.bg === 'process' ? 1 : p.profile.bg === 'none' ? 0.35 : 0.6; }

  // ------------------------------------------------------------ radios
  workload() {
    const w = super.workload();
    if (this.killSwitches.modem === false) { w.cellOn = false; w.cell = 0; }
    if (this.killSwitches.wifi === false) { w.wifiOn = false; w.wifi = 0; w.bt = false; }
    return w;
  }

  // -------------------------------------------------------------- idle
  idlePolicy() {
    const s = this.settings;
    const audio = [...this.procs.values()].some(p => p.profile.bg === 'audio' || p.profile.bg === 'voip');
    const inhibited = audio || this.wakeLocks.has('inhibit') || (this.screenOn && this.fgInhibits());
    if (this.state === 'on' && s.autoSuspend && !inhibited && this.hw.battery.present && !this.hw.battery.external) {
      const idle = this.screenOn ? this.idleFor : this.screenOffFor + s.autoLockSec;
      if (idle >= s.suspendAfterSec) this.suspend('idle');
    }
  }

  suspend(reason) {
    if (this.state !== 'on') return;
    this.screenOff('suspend');
    this.state = 'suspended';
    this.log('systemd-logind', `The system will suspend now! (${reason}) [mem_sleep: s2idle]`);
  }

  onResume() { this.log('kernel', 'PM: suspend exit'); }
  sleepName() { return 's2idle'; }
  sleepFactor() { return this.spec.soc.name.includes('Allwinner') || this.spec.soc.name.includes('NXP') ? 2.5 : 1.3; }
  deliverPush(n) {
    // Only the modem can wake the SoC (ring indicator); IP push needs the system awake.
    if (this.state === 'suspended' && !/call|sms/i.test(n.text)) return false;
    return true;
  }

  // ------------------------------------------------------------ power
  batteryPolicy() {
    const b = this.hw.battery;
    if (!b.present) return;
    const pct = b.level * 100;
    if (pct <= 10 && !b.external && !this._low) { this._low = true; this.notify('settings', 'Battery low: 10% remaining'); }
    if (pct > 15) this._low = false;
    if (pct <= 2 && !b.external) {
      this.log('upower', `battery critical, performing CriticalPowerAction=${this.settings.criticalAction}`, 'error');
      this.shutdown('upower critical action');
    }
  }

  onSetting(key, v) { if (key === 'lowPower') this.profile = v ? 'power-saver' : 'balanced'; }
  lowPowerPerfCap() { return 0.55; }
  powerModeName() { return this.profile; }

  thermalPolicy() {
    const t = this.hw.thermal.tempC, L = this.hw.limits;
    const zone = t >= L.critical ? 'critical' : t >= L.start ? 'passive' : 'none';
    if (zone !== this._zone) {
      if (zone !== 'none') this.log('kernel', `thermal thermal_zone0: trip point ${zone} crossed at ${t.toFixed(1)}°C`, zone === 'critical' ? 'error' : 'warn');
      this._zone = zone;
    }
    if (zone === 'critical' && t >= L.critical + 2) {
      this.log('kernel', 'thermal thermal_zone0: critical temperature reached, shutting down', 'error');
      this.shutdown('thermal critical trip');
    }
  }

  extraSnapshot() { return { distro: this.distro.name, powerProfile: this.profile, killSwitches: { ...this.killSwitches } }; }

  // ------------------------------------------------------------ shell
  findApp(name) { return Object.values(this.apps).find(a => a.id === name || a.desktop === name || a.name.toLowerCase() === String(name).toLowerCase()); }

  commands() {
    const self = this, b = this.hw.battery;
    const files = () => ({
      '/sys/class/power_supply/battery/capacity': String(Math.round(b.level * 100)),
      '/sys/class/power_supply/battery/status': b.charging ? 'Charging' : b.external && b.level >= 0.99 ? 'Full' : b.external ? 'Not charging' : 'Discharging',
      '/sys/class/power_supply/battery/voltage_now': String(b.mV * 1000),
      '/sys/class/power_supply/battery/cycle_count': String(Math.floor(b.cycles)),
      '/sys/class/thermal/thermal_zone0/temp': String(Math.round(self.hw.thermal.tempC * 1000)),
      '/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor': self.profile === 'power-saver' ? 'powersave' : 'schedutil',
      '/sys/power/mem_sleep': '[s2idle] deep',
      '/proc/meminfo': `MemTotal: ${Math.round(self.ramMB * 1024)} kB\nMemFree: ${Math.round(self.freeMB * 1024)} kB\nMemAvailable: ${Math.round(self.freeMB * 1024)} kB`,
      '/proc/loadavg': `${(self.hw.cpu.util * self.spec.soc.perfCores).toFixed(2)} 0.50 0.40 1/${120 + self.procs.size} ${self.procs.size ? [...self.procs.values()].at(-1).pid : 1}`,
      '/etc/os-release': `NAME="${self.distro.name}"\nPRETTY_NAME="${self.spec.osVersion || self.distro.name}"`,
    });
    return {
      uname: a => a.includes('-a') ? `Linux ${self.spec.id} ${self.distro.kernel} #1 SMP PREEMPT aarch64 GNU/Linux` : a.includes('-r') ? self.distro.kernel : 'Linux',
      cat: a => a.map(f => files()[f] ?? `cat: ${f}: No such file or directory`).join('\n'),
      ls: a => (a[0] === '/sys/class/power_supply' ? (b.present ? 'ac  battery' : 'ac') : Object.keys(files()).join('\n')),
      uptime: () => ` up ${fmtUptime(self.uptime)},  1 user,  load average: ${files()['/proc/loadavg'].split(' ').slice(0, 3).join(', ')}`,
      free: () => `               total        used        free\nMem:    ${String(Math.round(self.ramMB)).padStart(12)}${String(Math.round(self.usedMB)).padStart(12)}${String(Math.round(self.freeMB)).padStart(12)}\nSwap:   ${'2048'.padStart(12)}${'0'.padStart(12)}${'2048'.padStart(12)}`,
      ps: () => ['    PID STAT     RSS COMMAND', '      1 Ss     12000 /sbin/init', ...[...self.procs.values()].map(p => `${String(p.pid).padStart(7)} ${p.state === 'foreground' ? 'Rl ' : 'Sl '}  ${String(p.memMB * 1024).padStart(8)} ${p.profile.desktop}`)].join('\n'),
      top: () => self.commands().ps(),
      kill(a) { const pid = Number(a.filter(x => !x.startsWith('-'))[0]); const p = [...self.procs.values()].find(x => x.pid === pid); return p ? (self.kill(p.id, a.includes('-9') ? 'SIGKILL' : 'SIGTERM'), '') : `kill: (${pid}) - No such process`; },
      'gtk-launch': a => { const app = self.findApp(a[0]); return app ? self.launch(app.id).msg : `gtk-launch: no such application ${a[0]}`; },
      'flatpak': a => a[0] === 'run' ? self.commands()['gtk-launch'](a.slice(1)) : a[0] === 'list' ? Object.values(self.apps).map(x => x.desktop).join('\n') : 'usage: flatpak run|list',
      systemctl(a) {
        switch (a[0]) {
          case 'suspend': self.suspend('systemctl'); return '';
          case 'poweroff': self.shutdown(); return '';
          case 'reboot': self.reboot(); return '';
          case 'status': return a[1] ? `● ${a[1]}\n     Active: ${self.units[a[1]] || 'inactive (dead)'}` : `● ${self.spec.id}\n    State: running\n    Units: ${Object.keys(self.units).length} loaded`;
          case 'stop': case 'start': if (a[1] in self.units) { self.units[a[1]] = a[0] === 'start' ? 'active' : 'inactive'; if (a[1] === 'ModemManager.service') self.set('cellular', a[0] === 'start'); } return '';
          case 'list-units': return Object.entries(self.units).map(([k, v]) => `${k.padEnd(36)} loaded ${v}`).join('\n');
          default: return 'usage: systemctl suspend|poweroff|reboot|status|start|stop|list-units';
        }
      },
      loginctl: a => a[0] === 'lock-session' ? (self.lock(), '') : 'usage: loginctl lock-session',
      'systemd-inhibit': a => { self.wakeLocks.add('inhibit'); return `inhibiting idle/sleep for: ${a.join(' ') || 'shell'}`; },
      rfkill(a) {
        if (a[0] === 'block' || a[0] === 'unblock') { const on = a[0] === 'unblock'; const k = a[1] === 'wlan' ? 'wifi' : a[1] === 'wwan' ? 'cellular' : a[1] === 'all' ? 'airplane' : a[1]; self.set(k, k === 'airplane' ? !on : on); return ''; }
        const hw = k => (self.killSwitches[k] === false ? 'blocked' : 'unblocked');
        return ['ID TYPE      SOFT      HARD', ` 0 wlan      ${self.settings.wifi ? 'unblocked' : 'blocked  '} ${hw('wifi')}`, ` 1 bluetooth ${self.settings.bluetooth ? 'unblocked' : 'blocked  '} ${hw('wifi')}`, ...(self.spec.radios.cellular ? [` 2 wwan      ${self.settings.cellular ? 'unblocked' : 'blocked  '} ${hw('modem')}`] : [])].join('\n');
      },
      killswitch(a) {
        if (!(a[0] in self.killSwitches)) return `no hardware kill switch "${a[0]}" (available: ${Object.keys(self.killSwitches).join(', ') || 'none'})`;
        self.killSwitches[a[0]] = a[1] !== 'off';
        self.log('hardware', `${a[0]} kill switch ${self.killSwitches[a[0]] ? 'ON (enabled)' : 'OFF (cut)'}`);
        return '';
      },
      powerprofilesctl(a) {
        if (a[0] === 'set') { if (!['power-saver', 'balanced', 'performance'].includes(a[1])) return 'invalid profile'; self.profile = a[1]; self.settings.lowPower = a[1] === 'power-saver'; return ''; }
        return ['power-saver', 'balanced', 'performance'].map(p => `${p === self.profile ? '*' : ' '} ${p}:`).join('\n');
      },
      nmcli: a => a[0] === 'radio' && a[1] === 'wifi' ? (a[2] ? (self.set('wifi', a[2] === 'on'), '') : self.settings.wifi ? 'enabled' : 'disabled') : `wifi: ${self.device.env.wifiAvailable && self.settings.wifi ? 'connected' : 'disconnected'}`,
      mmcli: () => self.spec.radios.cellular ? `/org/freedesktop/ModemManager1/Modem/0 [${self.settings.cellular && self.killSwitches.modem !== false ? 'registered' : 'disabled'}] signal ${Math.round(self.device.env.signal * 100)}%` : 'error: no modems were found',
      'upower': () => [`  native-path: battery`, `  state: ${files()['/sys/class/power_supply/battery/status'].toLowerCase()}`, `  energy-full: ${(self.spec.battery?.wh * b.health || 0).toFixed(1)} Wh`, `  energy-rate: ${self.hw.power.totalW.toFixed(2)} W`, `  percentage: ${Math.round(b.level * 100)}%`].join('\n'),
      sensors: () => `thermal_zone0\ntemp1: +${self.hw.thermal.tempC.toFixed(1)}°C (crit = +${self.hw.limits.critical}.0°C)`,
      journalctl: () => self.device.events.slice(-30).map(e => `t+${e.t.toFixed(0)}s ${self.spec.id} ${e.tag}: ${e.msg}`).join('\n'),
      dmesg: () => self.device.events.filter(e => ['kernel', 'power', 'hardware', 'boot'].includes(e.tag)).slice(-30).map(e => `[${e.t.toFixed(6).padStart(12)}] ${e.msg}`).join('\n'),
      reboot: () => { self.reboot(); return ''; },
      poweroff: () => { self.shutdown(); return ''; },
    };
  }
}
