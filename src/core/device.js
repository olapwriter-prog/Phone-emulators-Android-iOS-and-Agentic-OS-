// A simulated device = hardware model + operating system + environment.

import { Hardware } from './hardware.js';
import { OS_REGISTRY } from '../os/index.js';
import { getSpec, supportedOS } from '../devices/catalog.js';

const DEFAULT_ENV = {
  ambientC: 22, lux: 300, signal: 0.8, wifiAvailable: true,
  charger: null, mains: false, moving: false, sunW: 0, externalDisplay: false,
};

export const CHARGERS = {
  'usb-5w': { kind: 'usb', watts: 5 },
  'usb-pd-20w': { kind: 'usb-pd', watts: 20 },
  'usb-pd-30w': { kind: 'usb-pd', watts: 30 },
  'usb-pd-65w': { kind: 'usb-pd', watts: 65 },
  'usb-pd-140w': { kind: 'usb-pd', watts: 140 },
  'supervooc-100w': { kind: 'usb-pd', watts: 100 },
  'qi2-15w': { kind: 'wireless', watts: 15 },
  'qi2-25w': { kind: 'wireless', watts: 25 },
};

export class Device {
  /**
   * @param {string|object} spec  catalog id or a spec object
   * @param {{os?:string, env?:object, battery?:number, autoGrant?:boolean, maxEvents?:number}} opts
   */
  constructor(spec, opts = {}) {
    this.spec = typeof spec === 'string' ? getSpec(spec) : spec;
    const osId = opts.os || this.spec.os;
    if (!supportedOS(this.spec).includes(osId))
      throw new Error(`${this.spec.name} cannot run ${osId} (supported: ${supportedOS(this.spec).join(', ')})`);
    if (osId !== this.spec.os) {
      // alternative OS: version string comes from the OS, not the stock firmware
      this.spec = { ...this.spec, os: osId, osVersion: { linux: 'postmarketOS edge', agentic: '1.0', android: 'LineageOS 22' }[osId] || '1.0' };
    }
    this.clock = 0;
    this.events = [];
    this.maxEvents = opts.maxEvents ?? 5000;
    this.listeners = new Set();
    this.autoGrant = opts.autoGrant ?? true;
    this.env = { ...DEFAULT_ENV, mains: !this.spec.battery, ...(opts.env || {}) };
    this.hw = new Hardware(this.spec);
    if (opts.battery != null) this.hw.battery.level = opts.battery;
    this.hw.thermal.tempC = this.env.ambientC;
    const OS = OS_REGISTRY[osId];
    this.os = new OS(this);
    this.folded = false; // foldables start open on the main display; fold() switches to the cover screen
  }

  // ---------------------------------------------------------- events
  log(level, tag, msg) {
    const e = { t: this.clock, level, tag, msg };
    this.events.push(e);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    for (const fn of this.listeners) fn(e);
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ------------------------------------------------------ simulation
  tick(dt = 1) {
    this.clock += dt;
    this.os.tick(dt);
    const load = this.os.workload();
    const r = this.hw.tick(dt, load, this.env, this.os.chargePolicy());
    if (r.depleted && this.os.state !== 'off') this.os.shutdown('battery depleted');
    if (r.overheated && this.os.state !== 'off') this.os.shutdown(`overheat ${this.hw.thermal.tempC.toFixed(1)}°C`);
    return this;
  }

  /** Advance `seconds` of simulated time in steps of `step` seconds. */
  run(seconds, step = 1) {
    let left = seconds;
    while (left > 1e-9) { const dt = Math.min(step, left); this.tick(dt); left -= dt; }
    return this;
  }

  /** Run until predicate(device) is true or `max` seconds elapse. Returns elapsed seconds. */
  runUntil(pred, max = 86400, step = 1) {
    const start = this.clock;
    while (this.clock - start < max) { if (pred(this)) break; this.tick(step); }
    return this.clock - start;
  }

  // ------------------------------------------------- hardware actions
  plug(charger = 'usb-pd-30w') {
    const c = typeof charger === 'string' ? CHARGERS[charger] : charger;
    if (!c) throw new Error(`unknown charger ${charger}`);
    if (c.kind === 'wireless' && !this.spec.charge?.wirelessW) { this.log('warn', 'hardware', `${this.spec.name} has no wireless charging coil`); return; }
    this.env.charger = c;
    this.log('info', 'hardware', `charger connected: ${c.kind} ${c.watts}W (device max ${c.kind === 'wireless' ? this.spec.charge?.wirelessW : this.spec.charge?.wiredW}W)`);
    if (this.os.state === 'off' && this.spec.family !== 'desktop') this.log('info', 'hardware', 'off-mode charging animation');
  }
  unplug() { if (this.env.charger) { this.env.charger = null; this.log('info', 'hardware', 'charger disconnected'); } }
  setMains(on) { this.env.mains = on; this.log('info', 'hardware', `mains power ${on ? 'connected' : 'disconnected'}`); if (!on && !this.spec.battery && this.os.state !== 'off') this.os.shutdown('power loss'); }
  setEnv(patch) { Object.assign(this.env, patch); }

  fold(closed = true) {
    if (this.spec.family !== 'foldable') return { ok: false, msg: 'not a foldable' };
    this.folded = closed;
    this.hw.setActiveDisplay(closed ? this.spec.coverDisplay : this.spec.display);
    this.log('info', 'hardware', closed ? 'folded: cover display active' : 'unfolded: main display active');
    if (this.os.foreground) this.log('info', 'display', `app continuity: ${this.os.apps[this.os.foreground]?.name} moved to ${closed ? 'cover' : 'main'} display`);
    return { ok: true, msg: closed ? 'folded' : 'unfolded' };
  }

  // ------------------------------------------------------- snapshot
  /** Recompute instantaneous power for the current state without advancing time. */
  refresh() { this.hw.tick(0, this.os.workload(), this.env, this.os.chargePolicy()); return this; }

  snapshot() {
    this.refresh();
    const h = this.hw;
    return {
      t: this.clock,
      device: { id: this.spec.id, name: this.spec.name, vendor: this.spec.vendor, family: this.spec.family, folded: this.folded },
      hardware: {
        battery: h.battery.present ? { pct: +(h.battery.level * 100).toFixed(2), charging: h.battery.charging, chargeW: +h.battery.chargeW.toFixed(2), external: h.battery.external, health: +(h.battery.health * 100).toFixed(1), cycles: +h.battery.cycles.toFixed(2), mV: h.battery.mV } : null,
        tempC: +h.thermal.tempC.toFixed(2), throttle: +h.thermal.throttle.toFixed(3), fan: +h.thermal.fan.toFixed(2),
        cpu: { util: +h.cpu.util.toFixed(3), capacity: +h.cpu.capacity.toFixed(2), demand: +h.cpu.demand.toFixed(2) },
        power: Object.fromEntries(Object.entries(h.power).map(([k, v]) => [k, +v.toFixed(3)])),
        display: h.display,
      },
      env: { ...this.env },
      os: this.os.snapshot(),
    };
  }

  /** Estimated hours to empty at the current draw. */
  hoursRemaining() {
    const b = this.hw.battery;
    if (!b.present || b.external || this.hw.power.totalW <= 0) return Infinity;
    return (b.level * b.capacityWh * b.health) / this.hw.power.totalW;
  }

  exec(line) { return this.os.exec(line); }
}

export function createDevice(id, opts) { return new Device(id, opts); }
