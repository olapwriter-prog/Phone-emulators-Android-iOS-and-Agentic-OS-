import { Device } from '../src/index.js';
export function up(id, opts = {}) {
  const d = new Device(id, { maxEvents: 3000, ...opts });
  d.os.boot();
  d.runUntil(x => x.os.state === 'on', 300, 0.25);
  if (opts.unlock !== false && d.os.hasLockScreen()) d.os.unlock({ pin: d.os.pin });
  return d;
}
export const logged = (d, re) => d.events.some(e => re.test(e.msg));
