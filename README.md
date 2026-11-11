# phonesim: virtual phones (and Macs) with real OS behaviour

`phonesim` simulates **56 device models** running **Android, iOS, Linux, macOS and
[agenticOS](https://github.com/olapwriter-prog/agenticOS)**, the headless phone OS run by
`agentd`. Each simulator combines three parts:

1. **A hardware model** taken from the device's spec: SoC performance and power
   curve, RAM, display size, refresh rate and panel type, battery capacity,
   charging limits, radios, biometrics, mass and cooling (passive, vapor chamber
   or fan). From these it works out battery drain, charging curves, heat,
   thermal throttling and frame rate.
2. **An OS layer** that reproduces how each platform manages power, memory,
   background work, security and thermals.
3. **A shell** that matches the platform: `adb shell` on Android, host tools on
   iOS, bash/sysfs/systemctl on Linux, zsh/pmset on macOS, and `agentd ctl` on
   agenticOS.

You can drive the same engine from a CLI, a browser UI, or as a library. It has
no dependencies and needs Node 18 or later.

```bash
npm test                                   # 59 behaviour tests
node bin/phonesim.js list                  # the catalog
node bin/phonesim.js info galaxy-z-fold6
node bin/phonesim.js shell pixel-9         # interactive device
node bin/phonesim.js shell oneplus-6 --os agentic   # agenticOS: agentd ctl
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
| **Android** | Pixel 6, 7, 8, 8a, 8 Pro, 9, 9 Pro XL, 10, 10 Pro · Galaxy S23, S24, S24 Ultra, S25, S25 Ultra, A55, Z Fold6, Z Flip6 · OnePlus 12, 13 · Xiaomi 14 · Redmi Note 13 · Nothing Phone (2) · Fairphone 5 · (stock Android on) OnePlus 6, 6T, Pocophone F1, Fairphone 4, Galaxy A3/A5 (2015) |
| **Linux** | PinePhone, PinePhone Pro (postmarketOS), Librem 5 (PureOS), Volla Phone X23 (Ubuntu Touch); also as an alternative OS on Pixel 6, Fairphone 5 and Apple-silicon Macs (Asahi) |
| **macOS** | MacBook Air 13" M2/M3, 15" M3 · MacBook Pro 14" M3 Pro, 16" M3 Max · iMac 24" M3 · Mac mini M4 · Mac Studio M2 Max |
| **agenticOS** | The phones agenticOS's install guide names as well supported by postmarketOS with working modem, calls and SMS: PinePhone, PinePhone Pro, OnePlus 6, OnePlus 6T, Pocophone F1, Fairphone 4, Fairphone 5, Galaxy A3 (2015), Galaxy A5 (2015); plus Librem 5 (ModemManager, as on Mobian). Not offered where it would need an oFono backend (Volla / Ubuntu Touch) or where postmarketOS has no working modem (Pixels, Galaxy S) |

To add a model, add one line to `src/devices/catalog.js`.

## What each OS simulates

| | Android | iOS | Linux | macOS |
|---|---|---|---|---|
| Boot chain | AVB → init → zygote → system_server | SecureROM → iBoot → XNU → launchd → SpringBoard | U-Boot/GRUB → kernel → systemd | iBoot → XNU → FileVault → loginwindow |
| Background apps | cached + frozen after 10 s; foreground services keep running | suspended after 5 s; audio, navigation and VoIP keep running | **keep running** (no freezer) | App Nap for hidden idle apps |
| Memory pressure | lmkd kills by `oom_score_adj` | jetsam kills suspended apps by LRU; per-app limit | kernel OOM killer kills the largest process | compressor + swap, **never kills**; "out of application memory" warning |
| Idle / sleep | Doze: INACTIVE → LIGHT_IDLE → … → IDLE (needs stillness), maintenance windows, deferred FCM | idle sleep; Background App Refresh | logind idle suspend (s2idle); only the modem can wake it | display sleep → system sleep, lid/clamshell, Power Nap, `caffeinate` |
| Low battery | Battery Saver at 15%, off at 90% | Low Power Mode prompt at 20%/10%, off at 80% | UPower warning, poweroff at 2% | Low Power Mode, hibernate at 3% |
| Charging | Pixel adaptive charging (80% hold) | Optimized Charging (80%), limit of 80–100% | full charge | Optimized Charging |
| Thermal | Thermal HAL levels NONE…SHUTDOWN; brightness cap; kills heavy app at EMERGENCY | thermalState; **"needs to cool down"** screen | kernel trip points; critical shutdown | fan curve, SMC emergency shutdown |
| Security | PIN required after boot and every 72 h; 30 s lockouts | Face/Touch ID needs passcode after restart and 48 h; lockout 1 m → 5 m → 15 m → 1 h → unavailable | pam_faillock (3 tries, 10 min); hardware kill switches | Touch ID + FileVault, TCC prompts |

### agenticOS (github.com/olapwriter-prog/agenticOS)

Your OS, simulated from its source. It is postmarketOS with no UI plus one daemon,
`agentd`, that *is* the phone. There is no app grid and no screen to tap. The shell is
`agentd ctl`, and anything that isn't a ctl command is sent as `chat`.

**Ported from the Rust (same logic and constants):**

| Crate | Behaviour in the simulator |
|---|---|
| `stage`, `power`, `kerneld` | Asleep / Active / Deep / WindingDown. Chat wakes it, 120 s idle puts it to sleep, the charger (≥20%) brings Deep, power loss winds down. Every change goes to the ledger, background slices are frozen unless Deep, and the governor is powersave / schedutil / performance (powersave at ≤15% off the charger) |
| `intents` | the phrase table (`call {to}`, `text {to} {text}`, `weather in {place}`, … ~120 phrases), matched exactly as `Intent::try_match` does |
| `understand` + `agentd/qa.rs` | the weighted Naive Bayes classifier with the **same seed phrasings**, threshold 0.6, and the detail rules (contacts by name, a typo away or "mother", on/off, volume, message text). Data questions ("how many texts did Mum send me") are answered by code, with no LLM. Your `HELD_OUT` test questions: 8/8 |
| `executor`, `gateway`, `gate` | Low/Medium tools run; High tools (`call`, `send_sms`, `send_message`, `pay`, `reply`, `buy`, `book`, `file_gst`, `install_function`, …) queue. A volume-down hold of 2000 ms or more approves the **one** waiting action. With two waiting it approves neither ("use press N"). A short press does nothing. A grant lasts 10 minutes and runs once. Pending items expire after 10 minutes, at most 20 |
| `notify` | quiet hours 22:00–07:00, daily budget 5, calls and VIPs always ring, everything else held for `digest` |
| `ledger` | SHA-256 hash chain, byte-compatible line hashes. `ledger tamper N` then `ledger verify` shows the break |
| `learn` | approvals (+1), declines (−1), "that was right/wrong", corrections. Approved or corrected requests become shortcuts, and the classifier retrains on them |
| `models`, `prio`, `agentd` | models chosen from RAM per your `agentd.toml` comments (≥12 GB: Qwen3.5-4B + 9B; >4 GB: 4B; else Qwen2.5-0.5B). The small model is always loaded; the large one is loaded on the charger at ≥30%. The 897-token system prompt is read once (warm-up), one core is kept for calls, and the boost is dropped above 80 °C and restored below 70 °C |
| trainer conditions | charger, ≥50% battery, below `cool_c`, Deep stage, ≥20 new confirmed requests or nightly due |

**Simulated, not real:** the LLM's choice (no weights run; it picks a tool the
way the grammar forces: one registered call) and its latency. Latency comes from
`agentos-llm`'s measured speeds in PROGRESS.md (Qwen3.5-4B: ~10 tok/s answering,
~17 tok/s reading the prompt, on an M-series CPU), scaled to each phone's chip and
ARM kernel (i8mm, SDOT, or portable code on Cortex-A53). The modem and the outside
services are simulated too.

**Two things the simulator found in agentd as it is today:**

1. **The phone never suspends.** `kerneld::may_suspend()` exists, but nothing in
   agentd acts on it. Over 24 h of standby a OnePlus 6 uses ~40% under agenticOS
   against ~8% under stock Android's Doze, and a PinePhone uses ~80%
   (`phonesim scenario standby oneplus-6 --os agentic`).
2. **Nightly training stops a second after it starts.** `train_tick` calls
   `trainer.started_on(today)`. On the next tick `nightly_due` is false, because
   `last_day` is now today. With fewer than `train_min_new` (20) new confirmed
   requests, `blocker()` returns a reason, and the running job is stopped:
   "training stopped (1 new confirmed requests since the last run (needs 20))".
   `phonesim scenario overnight oneplus-6 --os agentic` reproduces it. One possible
   fix is to skip the `min_new` check for a run that is already going, or to set
   `last_day` when the run finishes.

```
$ node bin/phonesim.js shell oneplus-6 --os agentic
agentd Asleep> save Mum as +919876543210
done: saved Mum: +919876543210 [intent]
agentd Active> call mum
not done: approval required (id 1): press the approval key on the phone, then ask again [intent]
agentd Active> :key 300
key held 300 ms (< 2000 ms): nothing approved
agentd Active> :key
approved #1 call
agentd Active> call mum
done: calling Mum (+919876543210) [intent]
agentd Active> sim-sms +919876543210|dinner at 8?
agentd Active> how many texts did Mum send me
answer: Mum sent you 1 text.
agentd Active> how is the network
done: operator Airtel, signal 80%, ... [model, 29.0 s]
agentd Active> ledger verify
ledger ok: 21 lines, head d14ee2e478b5db7e…
```

#### Habits: similar questions, learned routines, widgets (simulator extension)

These add to agentd's routing; they are not in agenticOS yet. They live in
`src/os/agentos/habits.js` and `almanac.js`, written so they can be ported to Rust. The
request order becomes: feedback → exact phrase → learned shortcut → **question bank
(Jaccard)** → classifier → code answers → LLM.

- **Simple questions by Jaccard similarity.** Each phrasing the phone knows is kept as a
  set of content words, with stop words dropped, light stemming and aliases
  (`clock` → `time`, `vaastu` → `vastu`). "tell me the time", "whats the time now" and
  "time please" all reduce to {time}. If a new request scores at least 0.5 against a
  known phrasing, it runs the same tool with no classifier pass and no LLM. Every request
  that works is added to the bank.
- **The almanac, answered by code.** Local time in the country's own format and
  calendar. In India also nakshatra and pada, tithi, panchang and Rahu kaal; nakshatra
  and tithi come from a low-precision Moon and Sun ephemeris with Lahiri ayanamsa
  (checked against Paush Purnima 2024 in Pushya and Diwali 2024 Amavasya in Swati).
  Vastu guidance by topic, or a tip of the day. Elsewhere: the Chinese lunar date,
  zodiac and feng shui; the Japanese era date and rokuyō; the Hijri date.
- **Every country works differently.** `country IN|US|GB|DE|CN|JP|SA|AE` sets the
  timezone, format and custom. After "what time is it", India follows with
  nakshatra · vastu, China with lunar date · feng shui, Japan with rokuyō, and Saudi
  Arabia and the UAE with the Hijri date. `set followups suggest` (the default) offers
  them, `auto` answers them, `off` drops them.
- **Routines from what you repeat.** A session is a run of requests at most 5 minutes
  apart. When the same sequence starts 3 sessions (time → nakshatra → vastu), agentd
  writes a routine. From then on, asking the first question answers the whole chain,
  with the arguments you last used ("vastu for kitchen"). Counting only from a session's
  first request keeps routines from looping.
- **Widgets for frequent questions.** A question asked 3 times in 7 days becomes a widget.
  Its content is the routine's chain when there is one, and it refreshes when its answer
  goes stale: the time every minute, the nakshatra every 30 minutes, vastu daily. It
  shows on the agentos-ui panel and in `widgets`.
- **Generated code, read-only.** Routines and widgets are source programs the phone
  writes (`show routine N`, `show widget N`). They are compiled into a sandbox that can
  only call Low-tier tools, so a widget can never call, text, pay or post. Each one
  learned is written to the ledger.

```
agentd Active> tell me the time
done: Wednesday, 11 November 2026 at 9:00 am (IST) [jaccard 1 ~ "what is the time"]
  ↪ also ask: nakshatra · vastu
  … three mornings of time → nakshatra → vastu for kitchen …
agentd Active> time
done: Thursday, 12 November 2026 at 9:04 am (IST) [intent]
  + Nakshatra Jyeshtha, pada 4 (sidereal Moon 237.39°); tithi Shukla Tritiya   [routine 2: you usually ask nakshatra next]
  + Vastu (kitchen): Kitchen in the south-east (Agni corner); cook facing east.   [routine 2: you usually ask vastu next]
agentd Active> show routine 2
function run(tool) {
  const out = [];
  out.push(tool("time_now", {}));
  out.push(tool("nakshatra", {}));
  out.push(tool("vastu", {"topic":"kitchen"}));
  return out;
}
```

Other commands: `pending`, `press N`, `decline N`, `phone`, `models`, `prio`,
`power 80 charger`, `notify app|sender|priority|text`, `sim-call NUMBER`,
`sim-caller-hangup`, `digest`, `learn`, `train [now]`, `ledger [verify|tamper N]`,
`tools` (every tool with its tier), `set ui on` (agentos-ui screen), `state`.

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
| `agent` | agenticOS: model warm-up, phrase / classifier / code / LLM routing, the approval key, the ledger |
| `overnight` | agenticOS: a night on the charger: Deep stage, quiet hours, digest, nightly training |

Sample output (`bench video` and `bench charge`):

```
device                 os       hours      device             os       minutesTo50  minutesTo80  heldByLimit
iphone-17-pro-max      ios      21.44      iphone-17-pro      ios      20           38           true
pixel-10-pro           android  20.42      pixel-10           android  31           59           true
galaxy-s25-ultra       android  20.53      oneplus-13         android  11           21           false
pinephone              linux     3.58      macbook-air-13-m3  macos    37           69           true
macbook-pro-16-m3-max  macos    16.95
```

## Web UI

`npm start` serves a browser UI that runs the same modules in the page. It shows:

- a device frame drawn to the real screen proportions and cutout (notch, Dynamic
  Island, punch-hole, home button, laptop or desktop);
- the boot sequence, lock screen and home grid; on agenticOS, `agentd`'s status
  line, conversation, pending approvals and a "Hold volume-down" key;
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
src/os/*.js            android, ios, linux, macos, agentic (agentd) behaviour
src/os/agentos/        ports of agenticOS crates (understand + qa seeds, intents, ledger), plus
                       habits.js (Jaccard bank, routines, widgets) and almanac.js (time, panchang, customs)
src/devices/catalog.js the 56 models
src/scenarios.js       repeatable scenarios
bin/phonesim.js        CLI
web/                   browser UI
test/                  node:test behaviour suite
```
