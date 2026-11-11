# phonesim: virtual phones (and Macs) with real OS behaviour

`phonesim` simulates **52 device models** running **Android, iOS, Linux, macOS and
an Agentic OS**. Each simulator combines three parts:

1. **A hardware model** taken from the device's spec: SoC performance and power
   curve, RAM, display size, refresh rate and panel type, battery capacity,
   charging limits, radios, biometrics, mass and cooling (passive, vapor chamber
   or fan). From these it works out battery drain, charging curves, heat,
   thermal throttling and frame rate.
2. **An OS layer** that reproduces how each platform manages power, memory,
   background work, security and thermals.
3. **A shell** that matches the platform: `adb shell` on Android, host tools on
   iOS, bash/sysfs/systemctl on Linux, zsh/pmset on macOS, and an agent CLI on
   Agentic OS.

You can drive the same engine from a CLI, a browser UI, or as a library. It has
no dependencies and needs Node 18 or later.

```bash
npm test                                   # 44 behaviour tests
node bin/phonesim.js list                  # the catalog
node bin/phonesim.js info galaxy-z-fold6
node bin/phonesim.js shell pixel-9         # interactive device
node bin/phonesim.js bench video           # every model, same scenario
npm start                                  # web UI on http://localhost:8080
```

> This is a **behavioural simulator**, not an instruction-set emulator. It does
> not run real Android, iOS or macOS images. It models how those systems behave
> on each piece of hardware: what gets frozen, killed, throttled, deferred or put
> to sleep, and what that does to battery and temperature. Figures are
> approximate public specs plus calibrated estimates. Expect realistic trends and
> rankings, not lab-exact numbers.

## Device catalog

| OS | Models |
|---|---|
| **iOS** | iPhone SE (3rd gen), 12, 13, 14, 14 Pro, 15, 15 Pro, 15 Pro Max, 16, 16 Pro, 16 Pro Max, 17, Air, 17 Pro, 17 Pro Max |
| **Android** | Pixel 6, 7, 8, 8a, 8 Pro, 9, 9 Pro XL, 10, 10 Pro · Galaxy S23, S24, S24 Ultra, S25, S25 Ultra, A55, Z Fold6, Z Flip6 · OnePlus 12, 13 · Xiaomi 14 · Redmi Note 13 · Nothing Phone (2) · Fairphone 5 |
| **Linux** | PinePhone, PinePhone Pro (postmarketOS), Librem 5 (PureOS), Volla Phone X23 (Ubuntu Touch); also as an alternative OS on Pixel 6, Fairphone 5 and Apple-silicon Macs (Asahi) |
| **macOS** | MacBook Air 13" M2/M3, 15" M3 · MacBook Pro 14" M3 Pro, 16" M3 Max · iMac 24" M3 · Mac mini M4 · Mac Studio M2 Max |
| **Agentic OS** | Agentic One and Agentic Pocket (hypothetical reference designs); also runs on every Android phone and the Volla X23 |

To add a model, add one line to `src/devices/catalog.js`.

## What each OS simulates

| | Android | iOS | Linux | macOS | Agentic OS |
|---|---|---|---|---|---|
| Boot chain | AVB → init → zygote → system_server | SecureROM → iBoot → XNU → launchd → SpringBoard | U-Boot/GRUB → kernel → systemd | iBoot → XNU → FileVault → loginwindow | measured boot → capability broker → **model load** |
| Background apps | cached + frozen after 10 s; foreground services keep running | suspended after 5 s; audio, navigation and VoIP keep running | **keep running** (no freezer) | App Nap for hidden idle apps | skills are headless and task-scoped |
| Memory pressure | lmkd kills by `oom_score_adj` | jetsam kills suspended apps by LRU; per-app limit | kernel OOM killer kills the largest process | compressor + swap, **never kills**; "out of application memory" warning | evicts idle skills, then the **model** (reloads on demand) |
| Idle / sleep | Doze: INACTIVE → LIGHT_IDLE → … → IDLE (needs stillness), maintenance windows, deferred FCM | idle sleep; Background App Refresh | logind idle suspend (s2idle); only the modem can wake it | display sleep → system sleep, lid/clamshell, Power Nap, `caffeinate` | sleeps waiting for the wake word; wakes for tasks |
| Low battery | Battery Saver at 15%, off at 90% | Low Power Mode prompt at 20%/10%, off at 80% | UPower warning, poweroff at 2% | Low Power Mode, hibernate at 3% | governor defers low-priority tasks |
| Charging | Pixel adaptive charging (80% hold) | Optimized Charging (80%), limit of 80–100% | full charge | Optimized Charging | full charge |
| Thermal | Thermal HAL levels NONE…SHUTDOWN; brightness cap; kills heavy app at EMERGENCY | thermalState; **"needs to cool down"** screen | kernel trip points; critical shutdown | fan curve, SMC emergency shutdown | halves local inference; offloads to cloud only if allowed |
| Security | PIN required after boot and every 72 h; 30 s lockouts | Face/Touch ID needs passcode after restart and 48 h; lockout 1 m → 5 m → 15 m → 1 h → unavailable | pam_faillock (3 tries, 10 min); hardware kill switches | Touch ID + FileVault, TCC prompts | human approval for sensitive actions; task-scoped grants; audit log |

### Agentic OS

The interface is an agent, not an app grid. A goal is split into clauses on
"then", and each clause is planned into **inference** steps and **tool calls**.

- Inference runs on the NPU, or falls back to the CPU at a much higher power
  cost. The model size depends on RAM (1B / 3B / 8B).
- Sensitive tools (`messages.send`, `payments.authorize`, `phone.call`,
  `files.delete`, …) wait for approval, which only works while unlocked. A task
  waiting for approval is parked and doesn't block the queue.
- Grants last only for the task and are revoked when it ends. Every tool call is
  written to an audit log.
- An energy and thermal governor defers low-priority work on low battery and
  pauses or slows inference when hot. Cloud offload happens only when the task's
  privacy policy allows it.

```
agent> agent run "summarize the news, then email it to Alex"
agent> agent run "clean up old screenshots" --low
agent> agent tasks
agent> agent approve 1
agent> audit
```

## Using the CLI shell

OS commands go to the simulated OS. Lines that start with `:` control the
virtual hardware and the clock:

```
$ node bin/phonesim.js shell pixel-9 --battery 40
pixel-9:/ $ :unlock 0000
pixel-9:/ $ :launch game
pixel-9:/ $ :run 20m                # advance simulated time
pixel-9:/ $ dumpsys thermalservice
pixel-9:/ $ :home
pixel-9:/ $ :power                  # screen off → watch Doze
pixel-9:/ $ :run 45m
pixel-9:/ $ dumpsys deviceidle
pixel-9:/ $ :plug qi2-15w
pixel-9:/ $ :env ambientC=38 sunW=2.5 moving=true signal=0.2
```

Other hardware commands: `:fold` / `:unfold` (foldables), `:lid close`
(MacBooks), `:mains off` (desktops), `:notify <app> <text>`, `:snapshot`
(full JSON state), `:help`. The shell also reads commands from stdin, so you
can script it: `node bin/phonesim.js shell iphone-16 < session.txt`.

## Scenarios

`phonesim scenario <name> <device|all>` runs one scenario; `phonesim bench <name>`
runs it on every model and prints a table.

| Scenario | What it measures |
|---|---|
| `boot` | cold boot time to an unlocked home screen |
| `standby` | 24 h screen-off drain, Doze/suspend, how notifications are handled |
| `video` | hours of streaming at 50% brightness until the device dies or sleeps |
| `gaming` | 30 min of a heavy 3D game: frame rate over time, peak temperature, throttling |
| `charge` | minutes to 50/80/100% with the fastest supported charger, and charge-limit holds |
| `memory` | opens every app; what gets killed, frozen or swapped |
| `agent` | Agentic OS task flow, approvals and NPU power |

Sample output (`bench video` and `bench charge`):

```
device                 os       hours      device             os       minutesTo50  minutesTo80  heldByLimit
iphone-17-pro-max      ios      21.44      iphone-17-pro      ios      20           38           true
pixel-10-pro           android  20.42      pixel-10           android  31           59           true
galaxy-s25-ultra       android  20.53      oneplus-13         android  11           21           false
pinephone              linux     3.58      macbook-air-13-m3  macos    37           69           true
macbook-pro-16-m3-max  macos    16.95
agentic-one            agentic  22.03
```

## Web UI

`npm start` serves a browser UI that runs the same modules in the page. It shows:

- a device frame drawn to the real screen proportions and cutout (notch, Dynamic
  Island, punch-hole, home button, laptop or desktop);
- the boot sequence, lock screen and home grid, plus the agent surface on
  Agentic OS;
- live meters for battery, power, temperature, throttling, frame rate, memory,
  Doze, swap, fan and NPU, with a history chart;
- environment controls (charger, ambient temperature, light, signal, Wi-Fi,
  motion, sun) and a simulation speed from 1× to 3600×;
- the platform shell and the system log.

You can link to a device directly: `/#d=fairphone-5&os=linux`.

## Library

```js
import { Device, runScenario } from './src/index.js';

const d = new Device('iphone-16-pro', { battery: 0.5 });
d.os.boot();
d.runUntil(x => x.os.state === 'on');
d.os.unlock({ pin: '0000' });
d.os.launch('game');
d.run(15 * 60);                       // 15 simulated minutes
console.log(d.snapshot().hardware);   // battery, tempC, throttle, power breakdown…
console.log(d.exec('battery'));       // OS-specific shell
d.on(e => console.log(e.tag, e.msg)); // event stream

runScenario('gaming', 'galaxy-s25');
```

## Layout

```
src/core/hardware.js   battery, thermal RC model, CPU capacity/throttle, power breakdown
src/core/os-base.js    shared lifecycle, lock and unlock, apps, permissions, notifications, shell
src/core/device.js     hardware + OS + environment, simulation clock, chargers, fold
src/os/*.js            android, ios, linux, macos, agentic behaviour
src/devices/catalog.js the 52 models
src/scenarios.js       repeatable scenarios
bin/phonesim.js        CLI
web/                   browser UI
test/                  node:test behaviour suite
```
