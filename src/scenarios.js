// Repeatable scenarios that exercise hardware + OS behaviour. Each returns a
// plain report object, so they can be printed, diffed or asserted on.

import { Device } from './core/device.js';

function bootAndUnlock(d) {
  d.os.boot();
  const bootS = d.runUntil(x => x.os.state === 'on', 300, 0.25);
  if (d.os.hasLockScreen()) d.os.unlock({ pin: d.os.pin });
  return bootS;
}

/** Pick the first installed app of a given archetype. */
function appOfKind(d, kind) { return Object.values(d.os.apps).find(a => a.kind === kind)?.id; }

export const SCENARIOS = {
  boot: {
    describe: 'Cold boot to an unlocked home screen',
    run(d) {
      const s = bootAndUnlock(d);
      return { bootSeconds: +s.toFixed(1), state: d.os.state, locked: d.os.locked };
    },
  },

  standby: {
    describe: '24 h screen-off standby with a few notifications (doze / suspend behaviour)',
    run(d) {
      d.hw.battery.level = 1;
      bootAndUnlock(d);
      const msgs = appOfKind(d, 'messages') || (d.os.id === 'agentic' ? 'sms' : null);
      if (msgs && d.os.apps[msgs]) { d.os.launch(msgs); d.os.home(); }
      d.os.screenOff('power button');
      const start = d.hw.battery.level;
      for (let h = 0; h < 24 && d.os.state !== 'off'; h++) {
        d.run(1800, 10);
        if (msgs) d.os.notify(msgs, h % 6 === 0 ? 'urgent: call me back' : 'new message');
        d.run(1800, 10);
      }
      const snap = d.os.snapshot();
      return {
        usedPct: +((start - d.hw.battery.level) * 100).toFixed(1),
        finalState: d.os.state,
        notificationsShown: d.os.notifications.length,
        deferredByOS: snap.deferredPush ?? 0,
        idleMode: snap.doze || d.os.sleepName(),
      };
    },
  },

  video: {
    describe: 'Stream video at 50% brightness on Wi-Fi until the battery dies (max 30 h)',
    run(d) {
      d.hw.battery.level = 1;
      bootAndUnlock(d);
      d.os.set('autoBrightness', false); d.os.set('brightness', 0.5);
      d.os.settings.autoLockSec = 0;
      const app = appOfKind(d, 'video') || appOfKind(d, 'browser');
      if (!app) return { skipped: 'headless OS: no video player' };
      d.os.launch(app);
      const hours = d.runUntil(x => x.os.state !== 'on', 30 * 3600, 30) / 3600;
      return { app, hours: +hours.toFixed(2), endState: d.os.state, batteryPowered: d.hw.battery.present, lowPowerKickedIn: d.events.some(e => /Low Power|Battery Saver|energy governor/.test(e.msg)) };
    },
  },

  gaming: {
    describe: '30 min demanding 3D game: thermals, throttling, frame rate',
    run(d) {
      d.hw.battery.level = 1;
      bootAndUnlock(d);
      d.os.settings.autoLockSec = 0;
      const game = appOfKind(d, 'game');
      if (!game) return { skipped: 'no game skill on this OS' };
      const r = d.os.launch(game);
      if (!r.ok) return { skipped: r.msg };
      const fps = [];
      let peakC = 0;
      for (let m = 0; m < 30 && d.os.state !== 'off'; m++) {
        for (let s = 0; s < 60; s++) { d.tick(1); d.os.touch(); peakC = Math.max(peakC, d.hw.thermal.tempC); }
        fps.push(d.os.fps());
      }
      return {
        startFps: fps[0], endFps: fps.at(-1), minFps: Math.min(...fps),
        peakTempC: +peakC.toFixed(1), throttle: +d.hw.thermal.throttle.toFixed(2),
        thermalState: d.os.thermalState(), batteryUsedPct: +((1 - d.hw.battery.level) * 100).toFixed(1),
        stillRunning: d.os.procs.has(game),
      };
    },
  },

  charge: {
    describe: 'Charge from 5% with the fastest supported charger, screen off',
    run(d) {
      if (!d.hw.battery.present) return { skipped: 'no battery' };
      d.hw.battery.level = 0.05;
      bootAndUnlock(d);
      d.os.screenOff('power button');
      const watts = d.spec.charge.wiredW;
      d.plug({ kind: 'usb-pd', watts });
      const t = {};
      for (const target of [0.5, 0.8, 1]) {
        const s = d.runUntil(x => x.hw.battery.level >= target - 0.005, 6 * 3600, 10);
        t[`to${target * 100}`] = s >= 6 * 3600 - 10 ? null : Math.round((d.clock - (t.start ?? (t.start = d.clock - s))) / 60);
      }
      delete t.start;
      return { chargerW: watts, minutesTo50: t.to50, minutesTo80: t.to80, minutesTo100: t.to100, peakTempC: +d.hw.thermal.tempC.toFixed(1), finalPct: Math.round(d.hw.battery.level * 100), heldByLimit: d.hw.battery.level < 0.99 };
    },
  },

  memory: {
    describe: 'Open every app one after another; see what the OS kills, freezes or swaps',
    run(d) {
      bootAndUnlock(d);
      if (!Object.keys(d.os.apps).length) return { skipped: 'headless OS: no apps to open' };
      const killed = [];
      const off = d.on(e => { if (/killed|evicted|jetsam|lmkd|Out of memory/.test(e.msg)) killed.push(e.msg); });
      for (const id of Object.keys(d.os.apps)) { d.os.launch(id); d.run(15, 1); }
      off();
      const s = d.os.snapshot();
      return { ramGB: d.spec.ramGB, running: s.procs.length, killed: killed.length, firstKill: killed[0] || null, swapMB: s.swapMB, memoryPressure: s.memoryPressure, states: Object.fromEntries(s.procs.map(p => [p.id, p.state])) };
    },
  },

  agent: {
    describe: 'agenticOS (agentd): code-first routing, the approval key, the LLM fallback, the ledger',
    run(d) {
      if (d.os.id !== 'agentic') return { skipped: 'agenticOS only' };
      d.hw.battery.level = 0.8;
      d.os.boot();
      d.runUntil(x => x.os.state === 'on', 300, 0.25);
      const warmS = d.runUntil(x => x.os.snapshot().models.every(m => m.state === 'ready'), 3 * 3600, 1);
      const say = l => d.exec(l);
      say('save Mum as +919876543210');
      const asked = say('call mum');
      const shortPress = d.holdKey(300);
      const hold = d.holdKey(2500);
      const dialled = say('call mum');
      say('hang up');
      say('sim-sms +919876543210|dinner at 8?');
      const t0 = d.clock;
      const byCode = say('how many texts did Mum send me');
      const codeS = d.clock - t0;
      const t1 = d.clock;
      const byModel = say('how is the network');
      const modelS = d.clock - t1;
      say('text mum late'); say('text mum very late');
      const twoWaiting = d.holdKey(2500);
      let ledgerOk; try { d.os.ledger.verify(); ledgerOk = true; } catch { ledgerOk = false; }
      return {
        models: d.os.snapshot().models.map(m => m.name).join('+'), warmUpS: Math.round(warmS),
        approvalAsked: /approval required/.test(asked), shortPress, hold, dialledAfterKey: /^done: calling/.test(dialled),
        codeAnswer: byCode, codeAnswerS: +codeS.toFixed(1), modelAnswer: byModel.slice(0, 40), modelAnswerS: Math.round(modelS),
        keyWithTwoWaiting: twoWaiting, ledgerLines: d.os.ledger.lines.length, ledgerOk,
      };
    },
  },

  overnight: {
    describe: 'agenticOS: a night on the charger: Deep stage, large model, nightly training, held texts and the digest',
    run(d) {
      if (d.os.id !== 'agentic') return { skipped: 'agenticOS only' };
      d.hw.battery.level = 0.35;
      d.os.cfg.startMinute = 21 * 60 + 30; // 21:30
      d.os.boot();
      d.runUntil(x => x.os.state === 'on', 300, 0.25);
      d.exec('save Mum as +919876543210');
      for (const t of ['torch on', 'volume 40', 'signal', 'missed calls']) d.exec(t);
      d.exec('call mum'); d.holdKey(); d.exec('call mum'); d.exec('hang up');
      d.plug('usb-pd-20w');
      const stages = new Set();
      let held = 0, trainingStarted = null;
      for (let i = 0; i < 10 * 360; i++) {
        d.tick(10);
        stages.add(d.os.stage);
        if (i === 360) { d.exec('sim-sms +918000000005|late night promo'); held = d.os.held.length; d.exec('sim-call +918000000006'); }
        if (d.os.trainer.running && trainingStarted == null) trainingStarted = d.os.snapshot().localTime;
      }
      const snap = d.os.snapshot();
      return {
        stages: [...stages].join('>'), models: snap.models.map(m => `${m.name}:${m.state}`).join(' '),
        heldDuringQuietHours: held, morningDigest: d.exec('digest').split('\n').length,
        trainingStarted, training: snap.trainer.last, batteryPct: Math.round(d.hw.battery.level * 100), peakDieC: snap.dieC,
      };
    },
  },
};

export function runScenario(name, deviceId, opts = {}) {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`unknown scenario ${name}; try: ${Object.keys(SCENARIOS).join(', ')}`);
  const d = deviceId instanceof Device ? deviceId : new Device(deviceId, { maxEvents: 2000, ...opts });
  return { scenario: name, device: d.spec.id, os: d.os.id, ...sc.run(d) };
}
