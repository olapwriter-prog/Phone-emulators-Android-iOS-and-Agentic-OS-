// Agentic OS: an intent-first OS where the primary interface is an on-device
// agent rather than an app grid. Apps become "skills" (tools) the agent
// drives. Behaviours simulated:
//   - boot loads on-device model weights sized to RAM; NPU vs CPU fallback
//   - goals are planned into steps (inference + tool calls)
//   - sensitive capabilities need human approval; grants are task-scoped
//   - energy & thermal governor: defers low-priority work on low battery,
//     pauses local inference when hot, optionally offloads to cloud
//   - memory pressure evicts the model (reload costs time) before skills
//   - every tool call is written to an append-only audit log

import { BaseOS, fmtUptime } from '../core/os-base.js';

const SENSITIVE = new Set(['messages.send', 'mail.send', 'payments.authorize', 'phone.call', 'files.delete', 'location.share', 'social.post', 'calendar.invite']);
const PRIORITY = { high: 0, normal: 1, low: 2 };

// tool → [seconds, cpu, net, gps, skill]
const TOOLS = {
  'contacts.lookup': [1, 0.3, 0, false, 'contacts'],
  'messages.send': [1, 0.2, 0.05, false, 'messages'],
  'mail.search': [2, 0.4, 0.2, false, 'mail'],
  'mail.send': [1, 0.2, 0.1, false, 'mail'],
  'browser.fetch': [4, 1.0, 0.6, false, 'browser'],
  'browser.search': [3, 0.8, 0.5, false, 'browser'],
  'browser.form': [4, 1.0, 0.3, false, 'browser'],
  'payments.authorize': [2, 0.3, 0.1, false, 'wallet'],
  'maps.route': [2, 0.8, 0.3, true, 'maps'],
  'maps.navigate': [120, 0.9, 0.2, true, 'maps'],
  'camera.capture': [2, 3.0, 0, false, 'camera'],
  'calendar.read': [1, 0.2, 0.02, false, 'calendar'],
  'calendar.create': [1, 0.2, 0.05, false, 'calendar'],
  'calendar.invite': [1, 0.2, 0.05, false, 'calendar'],
  'phone.call': [60, 0.6, 0.3, false, 'phone'],
  'files.scan': [5, 1.2, 0, false, 'files'],
  'files.delete': [1, 0.3, 0, false, 'files'],
  'location.share': [1, 0.2, 0.05, true, 'maps'],
  'social.post': [2, 0.3, 0.2, false, 'browser'],
};

const PLANS = [
  [/\b(message|text|tell|whatsapp|sms)\b/i, [['think', 150], ['contacts.lookup'], ['think', 120], ['messages.send']]],
  [/\b(e-?mail|reply|inbox)\b/i, [['mail.search'], ['think', 800], ['mail.send']]],
  [/\b(summari[sz]e|read|news|article|research)\b/i, [['browser.search'], ['browser.fetch'], ['think', 2500]]],
  [/\b(book|reserve|order|buy|pay|purchase)\b/i, [['browser.search'], ['think', 600], ['browser.form'], ['payments.authorize']]],
  [/\b(navigate|directions|route|drive to|take me)\b/i, [['maps.route'], ['think', 200], ['maps.navigate']]],
  [/\b(photo|picture|camera|scan|what is this)\b/i, [['camera.capture'], ['think', 1600]]],
  [/\b(invite)\b/i, [['calendar.read'], ['think', 300], ['calendar.invite']]],
  [/\b(remind|schedule|calendar|meeting)\b/i, [['calendar.read'], ['think', 300], ['calendar.create']]],
  [/\b(call|ring|phone)\b/i, [['contacts.lookup'], ['phone.call']]],
  [/\b(delete|remove|clean up|free up)\b/i, [['files.scan'], ['think', 400], ['files.delete']]],
  [/\b(share (my )?location|where am i)\b/i, [['maps.route'], ['location.share']]],
  [/\b(post|tweet|publish)\b/i, [['think', 400], ['social.post']]],
];

let TASK_ID = 1;

export class AgenticOS extends BaseOS {
  static id = 'agentic';
  static label = 'Agentic OS';

  constructor(device) {
    super(device);
    this.tasks = [];
    this.audit = [];
    this.grants = [];   // {skill, cap, taskId, until}
    this.memory = [];   // long-term facts the agent learned
    this.modelLoaded = false;
    this.modelLoading = 0;
    this.current = null; // {task, step, left}
    this.policy = {
      autoApprove: [],           // tool names the user pre-approved
      allowCloud: false,         // privacy: on-device only by default
      lowBatteryDefer: 0.2,      // defer low-priority work below this level
      maxConcurrentInference: 1,
    };
  }

  defaultSettings() { return { autoLockSec: 20, wakeWord: true }; }

  // Skills are headless; they appear as processes while the agent uses them.
  defaultApps() {
    return this.makeApps({
      agent: ['assistant', 'Agent', { skill: 'agent' }],
      browser: ['browser', 'Web skill', { skill: 'browser' }],
      maps: ['maps', 'Maps skill', { skill: 'maps' }],
      camera: ['camera', 'Vision skill', { skill: 'camera' }],
      messages: ['messages', 'Messaging skill', { skill: 'messages' }],
      mail: ['mail', 'Mail skill', { skill: 'mail' }],
      music: ['music', 'Audio skill', { skill: 'music' }],
      calendar: ['settings', 'Calendar skill', { skill: 'calendar', memMB: 90 }],
      contacts: ['settings', 'Contacts skill', { skill: 'contacts', memMB: 60 }],
      wallet: ['settings', 'Wallet skill', { skill: 'wallet', memMB: 80 }],
      files: ['photos', 'Files skill', { skill: 'files' }],
      phone: ['videocall', 'Telephony skill', { skill: 'phone', memMB: 120 }],
      settings: ['settings', 'Settings', { skill: 'settings' }],
      media: ['video', 'Media surface', { skill: 'media', surface: true }],
    });
  }

  // ------------------------------------------------------------- model
  get model() {
    const r = this.spec.ramGB;
    const m = r >= 12 ? { name: 'agent-8b-q4', memMB: 5200, params: '8B' }
      : r >= 8 ? { name: 'agent-3b-q4', memMB: 2200, params: '3B' }
        : { name: 'agent-1b-q4', memMB: 900, params: '1B' };
    const npu = this.spec.soc.npuTps;
    const scale = { '8B': 1, '3B': 2.2, '1B': 5 }[m.params];
    m.tps = npu > 0 ? npu * scale : this.spec.soc.perf * 1.6 * scale; // tokens / s at full speed
    m.accel = npu > 0 ? 'NPU' : 'CPU';
    m.loadSec = m.memMB / 1000 * (npu > 0 ? 1.2 : 2);
    return m;
  }

  bootStages() {
    const m = this.model;
    return [
      ['secure boot: measured boot, attestation keys sealed', 1.0],
      ['microkernel + driver sandboxes', 1.5],
      ['capability broker: loading grant policy', 0.8],
      [`model loader: ${m.name} (${m.params}, ${m.memMB}MB) → ${m.accel}`, m.loadSec],
      ['agent runtime ready; wake word armed', 0.7],
    ];
  }

  onBooted() {
    this.modelLoaded = true;
    this.log('agent', `${this.model.name} resident on ${this.model.accel}, ~${Math.round(this.model.tps)} tok/s`);
  }

  systemMemMB() { return 900 + (this.modelLoaded || this.modelLoading > 0 ? this.model.memMB : 0); }
  memReserveMB() { return 200; }

  reclaimMemory(need, forApp) {
    const v = this.lruBackground(p => p.id !== forApp);
    if (v) { this.kill(v.id, 'skill evicted (memory pressure)'); return true; }
    if (this.modelLoaded && !this.inferenceActive()) {
      this.modelLoaded = false;
      this.log('agent', `model ${this.model.name} evicted to free ${this.model.memMB}MB`, 'warn');
      return true;
    }
    return false;
  }

  // Skills are not launched by the user; the agent opens them. But a user
  // can still bring the agent surface to the front.
  launch(appId) {
    if (!['agent', 'settings', 'media'].includes(appId)) {
      const err = this.ready(); if (err) return err;
      return { ok: true, msg: `skills are headless; ask the agent instead (e.g. agent run "use ${appId} to …")` };
    }
    return super.launch(appId);
  }

  // ------------------------------------------------------------- tasks
  /** One template per clause; clauses are split on "then" (e.g. "summarize X, then email it to Y"). */
  plan(goal) {
    const steps = [['think', 200]];
    for (const clause of goal.split(/\s*(?:,\s*)?\b(?:and then|then)\b\s*/i).filter(Boolean)) {
      const hit = PLANS.find(([re]) => re.test(clause));
      steps.push(...(hit ? hit[1] : [['browser.search'], ['think', 900]]));
    }
    steps.push(['think', 120]); // final answer
    return steps.map(([tool, tokens]) => tool === 'think'
      ? { tool, tokens, done: 0 }
      : { tool, needsApproval: SENSITIVE.has(tool), left: TOOLS[tool][0] });
  }

  submit(goal, opts = {}) {
    if (this.state === 'off' || this.state === 'booting') return this.fail(`device is ${this.state}`);
    // Goals can be spoken via the wake word while locked; sensitive steps
    // still need an unlocked approval.
    const task = {
      id: TASK_ID++, goal, priority: opts.priority || 'normal',
      privacy: opts.cloud ? 'allow-cloud' : this.policy.allowCloud ? 'allow-cloud' : 'local',
      steps: this.plan(goal), stepIx: 0, status: 'queued', created: this.now,
      tokens: 0, energyWh: 0, note: '', fromLocked: !!this.locked,
    };
    this.tasks.push(task);
    this.log('agent', `task #${task.id} queued (${task.priority}): "${goal}" → ${task.steps.map(s => s.tool).join(' → ')}`);
    if (this.state === 'suspended') { this.state = 'on'; this.log('power', 'resume for agent task'); }
    return { ok: true, msg: `task #${task.id} queued`, task };
  }

  find(id) { return this.tasks.find(t => t.id === Number(id)); }

  approve(id, allowAlways = false) {
    const t = this.find(id);
    if (!t || t.status !== 'awaiting-approval') return this.fail(`task #${id} is not awaiting approval`);
    if (this.locked) return this.fail('unlock to approve sensitive actions');
    const step = t.steps[t.stepIx];
    step.approved = true;
    if (allowAlways && !this.policy.autoApprove.includes(step.tool)) this.policy.autoApprove.push(step.tool);
    t.status = 'queued'; t.note = ''; // resumes in priority order
    if (this.state === 'suspended') this.state = 'on';
    this.log('agent', `task #${t.id}: user approved ${step.tool}${allowAlways ? ' (always)' : ''}`);
    return { ok: true, msg: `approved ${step.tool}` };
  }

  deny(id) {
    const t = this.find(id);
    if (!t || t.status !== 'awaiting-approval') return this.fail(`task #${id} is not awaiting approval`);
    t.status = 'cancelled'; t.note = `user denied ${t.steps[t.stepIx].tool}`;
    this.log('agent', `task #${t.id} cancelled: ${t.note}`);
    this.releaseGrants(t);
    return { ok: true, msg: 'denied' };
  }

  cancel(id) {
    const t = this.find(id);
    if (!t || ['done', 'failed', 'cancelled'].includes(t.status)) return this.fail(`task #${id} not active`);
    t.status = 'cancelled'; t.note = 'cancelled by user';
    this.releaseGrants(t);
    return { ok: true, msg: `task #${t.id} cancelled` };
  }

  releaseGrants(t) {
    const before = this.grants.length;
    this.grants = this.grants.filter(g => g.taskId !== t.id);
    if (before !== this.grants.length) this.log('broker', `revoked ${before - this.grants.length} task-scoped grant(s) for #${t.id}`, 'debug');
    for (const s of new Set(t.steps.filter(x => x.tool !== 'think').map(x => TOOLS[x.tool][4]))) {
      const p = this.procs.get(s);
      if (p && p.state !== 'foreground') p.state = 'cached';
    }
  }

  inferenceActive() { const c = this.activeStep(); return !!c && c.step.tool === 'think' && c.mode === 'local'; }

  activeStep() {
    const t = this.tasks.find(x => x.status === 'running');
    if (!t) return null;
    const step = t.steps[t.stepIx];
    return { task: t, step, mode: this._mode };
  }

  networkUp() {
    const s = this.settings, e = this.device.env;
    return !s.airplane && ((s.wifi && e.wifiAvailable) || (s.cellular && e.signal > 0.05));
  }

  /** Governor: decides whether a task may run now and how. */
  gate(t) {
    const b = this.hw.battery, st = this.thermalState();
    if (b.present && !b.external && b.level < this.policy.lowBatteryDefer && t.priority === 'low')
      return { ok: false, why: 'deferred: low battery, waiting for charger' };
    if (st === 'critical') return { ok: false, why: 'paused: device too hot' };
    return { ok: true };
  }

  osTick(dt) {
    if (this.state !== 'on' && this.state !== 'suspended') return;
    this.grants = this.grants.filter(g => g.until > this.now);
    if (this.modelLoading > 0) {
      this.modelLoading -= dt;
      if (this.modelLoading <= 0) { this.modelLoaded = true; this.log('agent', `model ${this.model.name} reloaded`); }
    }

    // pick next task
    // Tasks awaiting approval park; they don't block the queue.
    let t = this.tasks.find(x => x.status === 'running');
    if (!t) {
      const cand = this.tasks.filter(x => x.status === 'queued' || x.status === 'deferred')
        .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.id - b.id);
      for (const c of cand) {
        const g = this.gate(c);
        if (g.ok) { c.status = 'running'; c.note = ''; t = c; this.log('agent', `task #${c.id} ${c.stepIx ? 'resumed' : 'started'}`); break; }
        if (c.status !== 'deferred' || c.note !== g.why) { c.status = 'deferred'; c.note = g.why; this.log('agent', `task #${c.id} ${g.why}`); }
      }
    }
    this._mode = null;
    if (!t || t.status !== 'running') return;
    if (this.state === 'suspended') this.state = 'on';

    const g = this.gate(t);
    if (!g.ok) { t.status = 'deferred'; t.note = g.why; this.log('agent', `task #${t.id} ${g.why}`, 'warn'); return; }

    const step = t.steps[t.stepIx];
    if (step.tool === 'think') {
      const hot = this.thermalState() === 'serious';
      const cloudOk = t.privacy === 'allow-cloud' && this.networkUp();
      let mode = 'local';
      if ((hot || !this.modelLoaded) && cloudOk) mode = 'cloud';
      if (mode === 'local' && !this.modelLoaded) {
        if (this.modelLoading <= 0) { this.modelLoading = this.model.loadSec; this.ensureMemory(this.model.memMB); this.log('agent', `reloading model (${this.model.loadSec.toFixed(1)}s)`); }
        t.note = 'waiting for model'; return;
      }
      this._mode = mode;
      const rate = mode === 'cloud' ? 150 : this.model.tps * this.hw.thermal.throttle * (this.settings.lowPower ? 0.6 : 1) * (hot ? 0.5 : 1);
      const n = Math.min(step.tokens - step.done, rate * dt);
      step.done += n; t.tokens += n;
      if (step.done >= step.tokens - 1e-6) this.advance(t, { mode, tokens: step.tokens });
      return;
    }

    // tool step
    const [, , net, gps, skill] = TOOLS[step.tool];
    if (net > 0 && !this.networkUp()) {
      if (t.note !== 'waiting for network') { t.note = 'waiting for network'; this.log('agent', `task #${t.id}: ${step.tool} waiting for network`, 'warn'); }
      return;
    }
    if (gps && !this.settings.location) { this.fail(`task #${t.id}: location is off`); t.status = 'failed'; t.note = 'location services disabled'; return; }
    if (step.needsApproval && !step.approved && !this.policy.autoApprove.includes(step.tool)) {
      t.status = 'awaiting-approval'; t.note = `needs approval: ${step.tool}`;
      this.notify('agent', `Task #${t.id} wants to ${step.tool.replace('.', ' → ')}. Approve?`);
      return;
    }
    if (!this.grants.some(gr => gr.taskId === t.id && gr.skill === skill)) {
      this.grants.push({ skill, cap: step.tool, taskId: t.id, until: this.now + 600 });
      this.openSkill(skill);
    }
    t.note = '';
    step.left -= dt;
    if (step.left <= 0) this.advance(t, { tool: step.tool, skill });
  }

  openSkill(skill) {
    if (this.procs.has(skill)) { const p = this.procs.get(skill); if (p.state !== 'foreground') { p.state = 'background'; p.bgFor = 0; } return; }
    const app = this.apps[skill];
    if (!app) return;
    this.ensureMemory(app.memMB, skill);
    this.procs.set(skill, { id: skill, pid: 4000 + Math.floor(Math.random() * 999), name: app.name, memMB: app.memMB, profile: app, state: 'background', bgFor: 0, startedAt: this.now, headless: true });
  }

  advance(t, info) {
    const step = t.steps[t.stepIx];
    this.audit.push({ t: this.now, task: t.id, step: step.tool, ...info, approved: !!step.approved || this.policy.autoApprove.includes(step.tool) });
    t.stepIx++;
    if (t.stepIx >= t.steps.length) {
      t.status = 'done'; t.finished = this.now;
      this.log('agent', `task #${t.id} done in ${(this.now - t.created).toFixed(0)}s, ${Math.round(t.tokens)} tokens`);
      this.memory.push({ t: this.now, fact: `completed: ${t.goal}` });
      if (this.memory.length > 100) this.memory.shift();
      this.releaseGrants(t);
      if (t.fromLocked && !this.screenOn) this.notify('agent', `Done: ${t.goal}`);
    }
  }

  extraLoad() {
    const c = this.activeStep();
    if (!c || this.state !== 'on') return {};
    if (c.step.tool === 'think') {
      if (this._mode === 'cloud') return { cpu: 0.2, net: 0.3 };
      if (this._mode !== 'local') return {};
      const m = this.model;
      return m.accel === 'NPU' ? { npu: 1, cpu: 0.4 } : { cpu: this.spec.soc.perf * 0.95 };
    }
    const [, cpu, net] = TOOLS[c.step.tool];
    return { cpu, net };
  }

  cpuShare(p) {
    if (p.headless) return 0; // tool cost already accounted in extraLoad
    return super.cpuShare(p);
  }

  backgroundPolicy(p) { if (p.headless && p.state === 'cached' && p.bgFor > 120) this.kill(p.id, 'idle skill reaped'); }

  idlePolicy() {
    const busy = this.tasks.some(t => t.status === 'running');
    if (this.state === 'on' && !this.screenOn && !busy && this.screenOffFor > 3) {
      this.state = 'suspended';
      this.log('power', 'idle: agent waiting on wake word', 'debug');
    }
  }

  sleepFactor() { return this.settings.wakeWord ? 1.4 : 1; } // always-on DSP for wake word

  batteryPolicy() {
    const b = this.hw.battery;
    if (!b.present) return;
    if (!this.settings.lowPower && !b.external && b.level <= 0.15) {
      this.settings.lowPower = true; this.log('power', 'energy governor: low power at 15% (inference capped, low-priority tasks deferred)');
    }
    if (this.settings.lowPower && b.external && b.level > 0.5) this.settings.lowPower = false;
  }

  thermalPolicy() {
    const st = this.thermalState();
    if (st !== this._st) { this.log('thermal', `thermal ${st}${st === 'serious' ? ': local inference halved, cloud offload if permitted' : ''}`, st === 'critical' ? 'warn' : 'info'); this._st = st; }
  }

  powerModeName() { return this.settings.lowPower ? 'Governor: saver' : 'Governor: balanced'; }

  extraSnapshot() {
    return {
      model: { ...this.model, loaded: this.modelLoaded },
      tasks: this.tasks.slice(-8).map(t => ({ id: t.id, goal: t.goal, status: t.status, step: t.steps[t.stepIx]?.tool || null, progress: `${t.stepIx}/${t.steps.length}`, note: t.note, tokens: Math.round(t.tokens) })),
      grants: this.grants.map(g => ({ ...g, until: Math.round(g.until - this.now) })),
      auditCount: this.audit.length,
      inference: this._mode || 'idle',
    };
  }

  // ------------------------------------------------------------- shell
  commands() {
    const self = this;
    return {
      agent(a, line) {
        const sub = a[0];
        if (sub === 'run' || sub === 'ask') {
          const goal = a.slice(1).filter(x => !x.startsWith('--')).join(' ');
          const pr = a.find(x => x.startsWith('--priority='))?.split('=')[1] || (a.includes('--low') ? 'low' : a.includes('--high') ? 'high' : 'normal');
          return self.submit(goal, { priority: pr, cloud: a.includes('--cloud'), voice: a.includes('--voice') }).msg;
        }
        if (sub === 'tasks') return self.tasks.map(t => `#${String(t.id).padEnd(3)} ${t.status.padEnd(17)} ${`${t.stepIx}/${t.steps.length}`.padEnd(5)} ${t.priority.padEnd(6)} ${t.goal}${t.note ? `  [${t.note}]` : ''}`).join('\n') || 'no tasks';
        if (sub === 'show') { const t = self.find(a[1]); return t ? t.steps.map((s, i) => `${i === t.stepIx ? '▶' : i < t.stepIx ? '✓' : ' '} ${s.tool}${s.tokens ? ` (${Math.round(s.done)}/${s.tokens} tok)` : ''}${s.needsApproval ? ' [approval]' : ''}`).join('\n') : 'no such task'; }
        if (sub === 'approve') return self.approve(a[1], a.includes('--always')).msg;
        if (sub === 'deny') return self.deny(a[1]).msg;
        if (sub === 'cancel') return self.cancel(a[1]).msg;
        if (sub === 'model') { const m = self.model; return `${m.name} (${m.params}) on ${m.accel}, ${Math.round(m.tps)} tok/s peak, ${m.memMB}MB, ${self.modelLoaded ? 'resident' : 'not loaded'}`; }
        if (sub === 'policy') {
          if (a[1]) {
            const k = a[1], v = a[2];
            if (k === 'allowCloud') self.policy.allowCloud = v === 'true' || v === 'on';
            else if (k === 'lowBatteryDefer') self.policy.lowBatteryDefer = Number(v);
            else if (k === 'autoApprove') self.policy.autoApprove = v ? v.split(',') : [];
            else return `unknown policy ${k}`;
          }
          return JSON.stringify(self.policy, null, 2);
        }
        if (sub === 'memory') return self.memory.map(m => `t+${m.t.toFixed(0)}s ${m.fact}`).join('\n') || '(empty)';
        return 'usage: agent run "<goal>" [--high|--low] [--cloud] | tasks | show <id> | approve <id> [--always] | deny <id> | cancel <id> | model | policy [key value] | memory';
      },
      audit: () => self.audit.slice(-30).map(e => `t+${e.t.toFixed(1)}s #${e.task} ${e.step}${e.mode ? ` (${e.mode}, ${e.tokens} tok)` : ''}${e.approved ? ' ✔approved' : ''}`).join('\n') || '(empty)',
      caps: () => self.grants.map(g => `${g.skill.padEnd(9)} ${g.cap.padEnd(20)} task #${g.taskId} expires in ${Math.round(g.until - self.now)}s`).join('\n') || 'no active grants',
      skills: () => Object.values(self.apps).map(x => `${x.id.padEnd(9)} ${x.name}${self.procs.has(x.id) ? ` [${self.procs.get(x.id).state}]` : ''}`).join('\n'),
      status: () => { const s = self.snapshot(); return `${self.label} ${self.spec.osVersion} on ${self.spec.name}\nstate ${s.state}, battery ${Math.round(self.hw.battery.level * 100)}%, ${s.thermalState}, inference ${s.inference}, uptime ${fmtUptime(self.uptime)}`; },
      reboot: () => { self.reboot(); return ''; },
    };
  }
}
