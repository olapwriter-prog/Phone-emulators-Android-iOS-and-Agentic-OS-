// Hardware model: battery, thermals, CPU, display and radios.
// Everything here is OS-agnostic. The OS hands in a "load" each tick and
// reads back the resulting state (temperature, throttle, battery level...).

export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

// Per form-factor defaults. R is thermal resistance to ambient (K/W),
// cPerG the lumped heat capacity per gram (J/K/g). Temperatures are °C of
// the lumped body (roughly battery/skin temperature).
const FAMILY = {
  phone:    { baseW: 0.12, sleepW: 0.012, R: 5.0, cPerG: 0.85, panelK: 1.0,
              thermal: { start: 38, end: 46, critical: 48, shutdown: 55 } },
  foldable: { baseW: 0.14, sleepW: 0.014, R: 4.6, cPerG: 0.85, panelK: 1.0,
              thermal: { start: 38, end: 46, critical: 48, shutdown: 55 } },
  laptop:   { baseW: 1.8, sleepW: 0.05, R: 1.6, cPerG: 0.5, panelK: 0.55,
              thermal: { start: 45, end: 60, critical: 65, shutdown: 75 } },
  desktop:  { baseW: 5.0, sleepW: 0.8, R: 0.5, cPerG: 0.5, panelK: 0.55,
              thermal: { start: 45, end: 60, critical: 65, shutdown: 75 } },
};
const COOLING_R = { vapor: 0.84, fan: 0.75 }; // multiplier on passive R (fan: at rest)

export function displayAreaCm2(d) {
  if (!d) return 0;
  const hyp = Math.hypot(d.w, d.h);
  return (d.diag * d.w / hyp) * (d.diag * d.h / hyp) * 6.4516;
}

export class Hardware {
  constructor(spec) {
    this.spec = spec;
    const fam = FAMILY[spec.family] || FAMILY.phone;
    this.fam = fam;
    this.limits = { ...fam.thermal, ...(spec.thermal || {}) };
    this.baseW = spec.power?.baseW ?? fam.baseW;
    this.sleepW = spec.power?.sleepW ?? fam.sleepW;
    this.R0 = fam.R * (COOLING_R[spec.cooling] || 1);
    this.C = spec.massG * fam.cPerG;
    this.activeDisplay = spec.display;

    const b = spec.battery;
    this.battery = {
      present: !!b, capacityWh: b ? b.wh : 0, health: 1, cycles: 0,
      level: b ? 0.8 : 0, charging: false, chargeW: 0, external: false, mV: 3900,
    };
    this.thermal = { tempC: 22, throttle: 1, fan: 0 };
    this.cpu = { capacity: spec.soc.perf, demand: 0, served: 0, util: 0, satisfaction: 1 };
    this.power = { totalW: 0, displayW: 0, cpuW: 0, radioW: 0, baseW: 0, npuW: 0 };
    this.display = { on: false, brightness: 0, hz: 0 };
  }

  setActiveDisplay(d) { this.activeDisplay = d; }

  /** Is there any usable energy source right now? */
  hasPower(env) {
    if (this.battery.present) return this.battery.level > 0 || this.chargerWatts(env) > 0;
    return !!env.mains;
  }

  /** Watts the device will accept from whatever is plugged in. */
  chargerWatts(env) {
    const c = env.charger;
    if (!this.battery.present) return env.mains ? Infinity : 0;
    if (!c) return 0;
    const max = c.kind === 'wireless' ? (this.spec.charge?.wirelessW || 0) : (this.spec.charge?.wiredW || 0);
    return Math.min(c.watts, max);
  }

  /**
   * Advance the hardware by dt seconds.
   * load: { on, suspended, sleepFactor, cpu, npu, perfCap, display:{on,brightness,hz,aod}, cell, wifi, gps, bt, cellOn, wifiOn }
   * policy: { chargeLimit, allowCharge }
   * Returns { depleted, overheated }.
   */
  tick(dt, load, env, policy = {}) {
    const { battery: bat, thermal: th, cpu, power } = this;

    // ---- throttle & fan from current temperature
    const L = this.limits;
    if (th.tempC <= L.start) th.throttle = 1;
    else if (th.tempC <= L.end) th.throttle = 1 - 0.45 * (th.tempC - L.start) / (L.end - L.start);
    else th.throttle = clamp(0.55 - 0.25 * (th.tempC - L.end) / 6, 0.3, 0.55);
    th.fan = this.spec.cooling === 'fan' && load.on && !load.suspended
      ? clamp((th.tempC - (L.start - 5)) / 15) : 0;

    // ---- CPU
    cpu.capacity = this.spec.soc.perf * th.throttle * (load.perfCap ?? 1);
    cpu.demand = load.on && !load.suspended ? load.cpu : 0;
    cpu.served = Math.min(cpu.demand, cpu.capacity);
    cpu.util = cpu.capacity > 0 ? cpu.served / cpu.capacity : 0;
    cpu.satisfaction = cpu.demand > 0 ? cpu.served / cpu.demand : 1;

    // ---- power draw
    const soc = this.spec.soc;
    let displayW = 0, cpuW = 0, radioW = 0, baseW = 0, npuW = 0;
    if (load.on) {
      if (load.suspended) {
        baseW = this.sleepW * (load.sleepFactor ?? 1);
      } else {
        baseW = load.display.on ? this.baseW : this.baseW * 0.25;
        cpuW = soc.idleW + (soc.peakW - soc.idleW) * Math.pow(cpu.served / soc.perf, 1.3);
        const d = this.activeDisplay;
        if (d && load.display.on) {
          const k = this.fam.panelK * (d.type === 'lcd' ? 1.2 : 1);
          displayW = displayAreaCm2(d) * k * (0.001 + 0.009 * Math.pow(load.display.brightness, 1.6))
            * (1 + 0.15 * (load.display.hz - 60) / 60);
        } else if (d && load.display.aod) {
          displayW = 0.03;
        }
        if (this.spec.cooling === 'fan') baseW += 1.5 * th.fan;
        // Neural engine: ~0.35 W per 10 tokens/s of rated throughput at full tilt.
        npuW = clamp(load.npu || 0) * (soc.npuTps / 10) * 0.35 * th.throttle;
      }
      const weak = 1 + 2 * (1 - clamp(env.signal));
      if (load.cellOn) {
        const act = this.spec.radios.cellular === '5g' ? 0.9 : 0.6;
        radioW += 0.015 * weak + act * weak * 0.6 * (load.cell || 0);
      }
      if (load.wifiOn) radioW += 0.008 + 0.35 * (load.wifi || 0);
      if (load.gps) radioW += 0.3;
      if (load.bt) radioW += 0.005;
    }
    const totalW = displayW + cpuW + radioW + baseW + npuW;
    Object.assign(power, { totalW, displayW, cpuW, radioW, baseW, npuW });
    this.display = load.on && !load.suspended
      ? { on: !!load.display.on, brightness: load.display.brightness, hz: load.display.on ? load.display.hz : 0 }
      : { on: false, brightness: 0, hz: 0 };

    // ---- battery / external power
    let depleted = false, chargeHeat = 0;
    const supply = this.chargerWatts(env);
    bat.external = supply > 0;
    if (bat.present) {
      const cap = bat.capacityWh * bat.health;
      const fromSupply = Math.min(totalW, supply);
      let toBattery = 0;
      const limit = policy.chargeLimit ?? 1;
      const canCharge = supply > 0 && policy.allowCharge !== false && bat.level < limit
        && th.tempC < 45 && th.tempC > 0;
      if (canCharge) {
        const max = env.charger.kind === 'wireless' ? this.spec.charge.wirelessW : this.spec.charge.wiredW;
        // CC phase to ~50 %, then CV taper; real devices average ~60 % of the
        // charger's rating even in the CC phase (negotiation, cable, heat).
        const taper = 0.6 * (bat.level < 0.5 ? 1 : bat.level < 0.8 ? 1 - 0.45 * (bat.level - 0.5) / 0.3 : 0.55 - 0.45 * (bat.level - 0.8) / 0.2);
        const hot = th.tempC > 40 ? 0.5 : 1;
        toBattery = Math.max(0, Math.min(supply - fromSupply, max * taper * hot));
        chargeHeat = toBattery * 0.08 + (env.charger.kind === 'wireless' ? toBattery * 0.2 : 0);
      }
      const drain = totalW - fromSupply;
      const deltaWh = (toBattery * 0.92 - drain) * dt / 3600;
      if (deltaWh < 0) {
        bat.cycles += -deltaWh / bat.capacityWh;
        bat.health = Math.max(0.6, 1 - 0.0002 * bat.cycles);
      }
      bat.level = clamp(bat.level + deltaWh / cap, 0, Math.max(limit, bat.level));
      bat.charging = toBattery > 0.01;
      bat.chargeW = toBattery;
      bat.mV = Math.round(3300 + 1050 * bat.level + (bat.charging ? 60 : 0));
      // Cold cells sag: below 0 °C the usable floor rises 2 % per degree.
      const floor = th.tempC < 0 ? Math.min(0.5, -th.tempC * 0.02) : 0;
      if (load.on && supply <= 0 && bat.level <= floor) depleted = true;
    } else if (load.on && !env.mains) {
      depleted = true;
    }

    // ---- thermal (lumped RC)
    const R = this.R0 * (1 - 0.7 * th.fan);
    const heat = totalW + chargeHeat + (env.sunW || 0);
    th.tempC += ((heat - (th.tempC - env.ambientC) / R) / this.C) * dt;

    return { depleted, overheated: load.on && th.tempC >= L.shutdown };
  }
}
