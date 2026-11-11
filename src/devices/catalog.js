// Device catalog. Every simulator is driven by one of these spec records, so
// adding a model is a one-line change. Figures are approximate public specs;
// `perf` is a relative multi-core index, not a benchmark result.

const SOC = {
  // name: [perf, peakW, idleW, perfCores, effCores, npuTokensPerSec, armDot]
  // armDot: the integer kernel agentos-llm can use: 'i8mm' (SMMLA), 'sdot', or 'none' (portable code)
  'A14 Bionic':        [4.7, 6.0, 0.08, 2, 4, 0],
  'A15 Bionic':        [5.3, 6.2, 0.08, 2, 4, 0],
  'A16 Bionic':        [6.6, 6.5, 0.08, 2, 4, 0],
  'A17 Pro':           [7.2, 7.0, 0.08, 2, 4, 18],
  'A18':               [8.0, 7.0, 0.08, 2, 4, 24],
  'A18 Pro':           [8.5, 7.2, 0.08, 2, 4, 26],
  'A19':               [9.2, 7.2, 0.08, 2, 4, 30],
  'A19 Pro':           [9.9, 7.5, 0.08, 2, 4, 34],
  'Tensor':            [3.0, 6.5, 0.10, 2, 6, 0],
  'Tensor G2':         [3.5, 6.5, 0.10, 2, 6, 0],
  'Tensor G3':         [4.4, 6.8, 0.10, 1, 8, 12],
  'Tensor G4':         [4.6, 6.5, 0.10, 1, 7, 16],
  'Tensor G5':         [6.2, 6.5, 0.09, 1, 7, 22],
  'Snapdragon 8+ Gen 1': [4.4, 6.5, 0.09, 1, 7, 0],
  'Snapdragon 8 Gen 2':  [5.3, 6.8, 0.09, 1, 7, 10],
  'Snapdragon 8 Gen 3':  [7.0, 7.2, 0.09, 1, 7, 20],
  'Snapdragon 8 Elite':  [9.5, 7.8, 0.09, 2, 6, 30],
  'Snapdragon 685':      [1.9, 4.0, 0.08, 4, 4, 0],
  'Exynos 1480':         [3.4, 5.0, 0.09, 4, 4, 0],
  'QCM6490':             [2.9, 5.0, 0.09, 4, 4, 0],
  'Helio G99':           [2.0, 4.5, 0.09, 2, 6, 0],
  'Allwinner A64':       [0.4, 2.5, 0.15, 4, 0, 0],
  'Rockchip RK3399S':    [0.9, 4.0, 0.18, 2, 4, 0],
  'NXP i.MX 8M Quad':    [0.5, 3.5, 0.25, 4, 0, 0],
  'M2':                  [9.7, 20, 0.5, 4, 4, 30],
  'M3':                  [11.7, 20, 0.5, 4, 4, 35],
  'M3 Pro':              [15.0, 45, 0.8, 6, 6, 45],
  'M3 Max':              [21.0, 90, 1.2, 12, 4, 70],
  'M2 Max':              [14.8, 80, 1.5, 8, 4, 55],
  'M4':                  [14.7, 35, 0.6, 4, 6, 45],
  'Snapdragon 845':      [2.6, 5.5, 0.10, 4, 4, 0, 'sdot'],
  'Snapdragon 750G':     [2.3, 5.0, 0.09, 2, 6, 0, 'sdot'],
  'Snapdragon 410':      [0.35, 2.5, 0.10, 0, 4, 0, 'none'],
};

// Cortex-A510/A710 and later have i8mm; A55/A75/A76-class have SDOT; A53/A72-only chips neither.
function defaultDot(name) {
  if (/Allwinner|Rockchip|NXP|Snapdragon 410/.test(name)) return 'none';
  if (/^(A1\d|M\d)/.test(name)) return 'i8mm';
  if (/8 Gen [23]|8 Elite|Tensor G[345]|Exynos 1480|8\+ Gen 1/.test(name)) return 'i8mm';
  return 'sdot';
}

function soc(name) {
  const s = SOC[name];
  if (!s) throw new Error(`Unknown SoC ${name}`);
  return { name, perf: s[0], peakW: s[1], idleW: s[2], perfCores: s[3], effCores: s[4], npuTps: s[5], armDot: s[6] || defaultDot(name) };
}

// display: [diagIn, w, h, maxHz, minHz, type, cutout]
function disp(a, extra = {}) {
  const [diag, w, h, hz, minHz, type, cutout] = a;
  return { diag, w, h, hz, minHz, type, cutout, ppi: Math.round(Math.hypot(w, h) / diag), ...extra };
}

const PHONE_V = 3.87; // nominal cell voltage used to convert mAh → Wh

function phone(id, name, vendor, year, os, osVersion, display, socName, ramGB, mAh, charge, radios, extra = {}) {
  return {
    id, name, vendor, year, family: 'phone', os, osVersion,
    display: disp(display, extra.display),
    soc: soc(socName), ramGB,
    battery: { wh: +(mAh * PHONE_V / 1000).toFixed(2), mAh, removable: !!extra.removableBattery },
    charge: { wiredW: charge[0], wirelessW: charge[1], port: charge[2] },
    radios: { cellular: radios[0], wifi: radios[1], uwb: !!radios[2], satellite: !!radios[3], nfc: true, bt: true },
    biometrics: extra.biometrics || 'fingerprint',
    cooling: extra.cooling || 'passive',
    massG: extra.massG || 190,
    altOS: extra.altOS || [],
    ...(extra.more || {}),
  };
}

const iphone = (id, name, year, osV, display, s, ram, mAh, charge, radios, extra = {}) =>
  phone(id, name, 'Apple', year, 'ios', osV, display, s, ram, mAh, charge, radios,
    { biometrics: 'face', ...extra });
const android = (id, name, vendor, year, osV, display, s, ram, mAh, charge, radios, extra = {}) =>
  phone(id, name, vendor, year, 'android', osV, display, s, ram, mAh, charge, radios, extra);

function mac(id, name, year, family, display, socName, ramGB, wh, extra = {}) {
  return {
    id, name, vendor: 'Apple', year, family, os: 'macos', osVersion: extra.osVersion || '15',
    display: display ? disp(display) : null,
    soc: soc(socName), ramGB,
    battery: wh ? { wh, removable: false } : null,
    charge: wh ? { wiredW: extra.chargeW || 70, wirelessW: 0, port: 'MagSafe 3 / USB-C' } : null,
    radios: { cellular: null, wifi: '6e', nfc: false, bt: true },
    biometrics: extra.biometrics ?? 'fingerprint',
    cooling: extra.cooling || 'fan',
    massG: extra.massG || 1500,
    altOS: extra.altOS || [],
  };
}

export const DEVICES = [
  // ---------------------------------------------------------------- iOS
  iphone('iphone-se-3', 'iPhone SE (3rd gen)', 2022, '18', [4.7, 750, 1334, 60, 60, 'lcd', 'homeButton'], 'A15 Bionic', 4, 2018, [20, 7.5, 'Lightning'], ['5g', '6'], { biometrics: 'fingerprint', massG: 144 }),
  iphone('iphone-12', 'iPhone 12', 2020, '18', [6.1, 1170, 2532, 60, 60, 'oled', 'notch'], 'A14 Bionic', 4, 2815, [20, 15, 'Lightning'], ['5g', '6', 1], { massG: 164 }),
  iphone('iphone-13', 'iPhone 13', 2021, '18', [6.1, 1170, 2532, 60, 60, 'oled', 'notch'], 'A15 Bionic', 4, 3227, [20, 15, 'Lightning'], ['5g', '6', 1], { massG: 174 }),
  iphone('iphone-14', 'iPhone 14', 2022, '18', [6.1, 1170, 2532, 60, 60, 'oled', 'notch'], 'A15 Bionic', 6, 3279, [20, 15, 'Lightning'], ['5g', '6', 1, 1], { massG: 172 }),
  iphone('iphone-14-pro', 'iPhone 14 Pro', 2022, '18', [6.1, 1179, 2556, 120, 1, 'oled', 'island'], 'A16 Bionic', 6, 3200, [27, 15, 'Lightning'], ['5g', '6', 1, 1], { massG: 206, display: { aod: true } }),
  iphone('iphone-15', 'iPhone 15', 2023, '18', [6.1, 1179, 2556, 60, 60, 'oled', 'island'], 'A16 Bionic', 6, 3349, [27, 15, 'USB-C'], ['5g', '6', 1, 1], { massG: 171 }),
  iphone('iphone-15-pro', 'iPhone 15 Pro', 2023, '18', [6.1, 1179, 2556, 120, 1, 'oled', 'island'], 'A17 Pro', 8, 3274, [27, 15, 'USB-C'], ['5g', '6e', 1, 1], { massG: 187, display: { aod: true } }),
  iphone('iphone-15-pro-max', 'iPhone 15 Pro Max', 2023, '18', [6.7, 1290, 2796, 120, 1, 'oled', 'island'], 'A17 Pro', 8, 4441, [27, 15, 'USB-C'], ['5g', '6e', 1, 1], { massG: 221, display: { aod: true } }),
  iphone('iphone-16', 'iPhone 16', 2024, '18', [6.1, 1179, 2556, 60, 60, 'oled', 'island'], 'A18', 8, 3561, [30, 25, 'USB-C'], ['5g', '7', 1, 1], { massG: 170 }),
  iphone('iphone-16-pro', 'iPhone 16 Pro', 2024, '18', [6.3, 1206, 2622, 120, 1, 'oled', 'island'], 'A18 Pro', 8, 3582, [30, 25, 'USB-C'], ['5g', '7', 1, 1], { massG: 199, display: { aod: true } }),
  iphone('iphone-16-pro-max', 'iPhone 16 Pro Max', 2024, '18', [6.9, 1320, 2868, 120, 1, 'oled', 'island'], 'A18 Pro', 8, 4685, [30, 25, 'USB-C'], ['5g', '7', 1, 1], { massG: 227, display: { aod: true } }),
  iphone('iphone-17', 'iPhone 17', 2025, '26', [6.3, 1206, 2622, 120, 1, 'oled', 'island'], 'A19', 8, 3692, [40, 25, 'USB-C'], ['5g', '7', 1, 1], { massG: 177, display: { aod: true } }),
  iphone('iphone-air', 'iPhone Air', 2025, '26', [6.5, 1260, 2736, 120, 1, 'oled', 'island'], 'A19 Pro', 12, 3149, [20, 20, 'USB-C'], ['5g', '7', 1, 1], { massG: 165, display: { aod: true } }),
  iphone('iphone-17-pro', 'iPhone 17 Pro', 2025, '26', [6.3, 1206, 2622, 120, 1, 'oled', 'island'], 'A19 Pro', 12, 4252, [40, 25, 'USB-C'], ['5g', '7', 1, 1], { massG: 206, cooling: 'vapor', display: { aod: true } }),
  iphone('iphone-17-pro-max', 'iPhone 17 Pro Max', 2025, '26', [6.9, 1320, 2868, 120, 1, 'oled', 'island'], 'A19 Pro', 12, 5088, [40, 25, 'USB-C'], ['5g', '7', 1, 1], { massG: 233, cooling: 'vapor', display: { aod: true } }),

  // ------------------------------------------------------------ Android
  android('pixel-6', 'Pixel 6', 'Google', 2021, '15', [6.4, 1080, 2400, 90, 60, 'oled', 'punch'], 'Tensor', 8, 4614, [21, 21, 'USB-C'], ['5g', '6e'], { massG: 207, altOS: ['linux'] }),
  android('pixel-7', 'Pixel 7', 'Google', 2022, '16', [6.3, 1080, 2400, 90, 60, 'oled', 'punch'], 'Tensor G2', 8, 4355, [20, 20, 'USB-C'], ['5g', '6e'], { massG: 197 }),
  android('pixel-8', 'Pixel 8', 'Google', 2023, '16', [6.2, 1080, 2400, 120, 60, 'oled', 'punch'], 'Tensor G3', 8, 4575, [27, 18, 'USB-C'], ['5g', '7'], { massG: 187 }),
  android('pixel-8a', 'Pixel 8a', 'Google', 2024, '16', [6.1, 1080, 2400, 120, 60, 'oled', 'punch'], 'Tensor G3', 8, 4492, [18, 7.5, 'USB-C'], ['5g', '6e'], { massG: 188 }),
  android('pixel-8-pro', 'Pixel 8 Pro', 'Google', 2023, '16', [6.7, 1344, 2992, 120, 1, 'oled', 'punch'], 'Tensor G3', 12, 5050, [30, 23, 'USB-C'], ['5g', '7', 1], { massG: 213, display: { aod: true } }),
  android('pixel-9', 'Pixel 9', 'Google', 2024, '16', [6.3, 1080, 2424, 120, 60, 'oled', 'punch'], 'Tensor G4', 12, 4700, [27, 15, 'USB-C'], ['5g', '7', 0, 1], { massG: 198, display: { aod: true } }),
  android('pixel-9-pro-xl', 'Pixel 9 Pro XL', 'Google', 2024, '16', [6.8, 1344, 2992, 120, 1, 'oled', 'punch'], 'Tensor G4', 16, 5060, [37, 23, 'USB-C'], ['5g', '7', 1, 1], { massG: 221, cooling: 'vapor', display: { aod: true } }),
  android('pixel-10', 'Pixel 10', 'Google', 2025, '16', [6.3, 1080, 2424, 120, 60, 'oled', 'punch'], 'Tensor G5', 12, 4970, [30, 15, 'USB-C'], ['5g', '6e', 0, 1], { massG: 204, display: { aod: true } }),
  android('pixel-10-pro', 'Pixel 10 Pro', 'Google', 2025, '16', [6.3, 1280, 2856, 120, 1, 'oled', 'punch'], 'Tensor G5', 16, 4870, [30, 15, 'USB-C'], ['5g', '7', 1, 1], { massG: 207, cooling: 'vapor', display: { aod: true } }),
  android('galaxy-s23', 'Galaxy S23', 'Samsung', 2023, '15', [6.1, 1080, 2340, 120, 48, 'oled', 'punch'], 'Snapdragon 8 Gen 2', 8, 3900, [25, 15, 'USB-C'], ['5g', '6e'], { massG: 168, display: { aod: true } }),
  android('galaxy-s24', 'Galaxy S24', 'Samsung', 2024, '15', [6.2, 1080, 2340, 120, 1, 'oled', 'punch'], 'Snapdragon 8 Gen 3', 8, 4000, [25, 15, 'USB-C'], ['5g', '6e'], { massG: 167, cooling: 'vapor', display: { aod: true } }),
  android('galaxy-s24-ultra', 'Galaxy S24 Ultra', 'Samsung', 2024, '15', [6.8, 1440, 3120, 120, 1, 'oled', 'punch'], 'Snapdragon 8 Gen 3', 12, 5000, [45, 15, 'USB-C'], ['5g', '7', 1], { massG: 232, cooling: 'vapor', display: { aod: true }, more: { stylus: true } }),
  android('galaxy-s25', 'Galaxy S25', 'Samsung', 2025, '15', [6.2, 1080, 2340, 120, 1, 'oled', 'punch'], 'Snapdragon 8 Elite', 12, 4000, [25, 15, 'USB-C'], ['5g', '7'], { massG: 162, cooling: 'vapor', display: { aod: true } }),
  android('galaxy-s25-ultra', 'Galaxy S25 Ultra', 'Samsung', 2025, '15', [6.9, 1440, 3120, 120, 1, 'oled', 'punch'], 'Snapdragon 8 Elite', 12, 5000, [45, 15, 'USB-C'], ['5g', '7', 1], { massG: 218, cooling: 'vapor', display: { aod: true }, more: { stylus: true } }),
  android('galaxy-a55', 'Galaxy A55', 'Samsung', 2024, '15', [6.6, 1080, 2340, 120, 60, 'oled', 'punch'], 'Exynos 1480', 8, 5000, [25, 0, 'USB-C'], ['5g', '6'], { massG: 213 }),
  { ...android('galaxy-z-fold6', 'Galaxy Z Fold6', 'Samsung', 2024, '15', [7.6, 1856, 2160, 120, 1, 'oled', 'punch'], 'Snapdragon 8 Gen 3', 12, 4400, [25, 15, 'USB-C'], ['5g', '6e', 1], { massG: 239, cooling: 'vapor', display: { aod: true } }),
    family: 'foldable', coverDisplay: disp([6.3, 968, 2376, 120, 1, 'oled', 'punch']) },
  { ...android('galaxy-z-flip6', 'Galaxy Z Flip6', 'Samsung', 2024, '15', [6.7, 1080, 2640, 120, 1, 'oled', 'punch'], 'Snapdragon 8 Gen 3', 12, 4000, [25, 15, 'USB-C'], ['5g', '6e'], { massG: 187, cooling: 'vapor' }),
    family: 'foldable', coverDisplay: disp([3.4, 720, 748, 60, 60, 'oled', 'none']) },
  android('oneplus-12', 'OnePlus 12', 'OnePlus', 2024, '15', [6.82, 1440, 3168, 120, 1, 'oled', 'punch'], 'Snapdragon 8 Gen 3', 12, 5400, [100, 50, 'USB-C'], ['5g', '7'], { massG: 220, cooling: 'vapor' }),
  android('oneplus-13', 'OnePlus 13', 'OnePlus', 2025, '15', [6.82, 1440, 3168, 120, 1, 'oled', 'punch'], 'Snapdragon 8 Elite', 12, 6000, [100, 50, 'USB-C'], ['5g', '7'], { massG: 210, cooling: 'vapor' }),
  android('xiaomi-14', 'Xiaomi 14', 'Xiaomi', 2024, '15', [6.36, 1200, 2670, 120, 1, 'oled', 'punch'], 'Snapdragon 8 Gen 3', 12, 4610, [90, 50, 'USB-C'], ['5g', '7'], { massG: 193, cooling: 'vapor' }),
  android('redmi-note-13', 'Redmi Note 13 4G', 'Xiaomi', 2024, '14', [6.67, 1080, 2400, 120, 60, 'oled', 'punch'], 'Snapdragon 685', 6, 5000, [33, 0, 'USB-C'], ['4g', '5'], { massG: 188 }),
  android('nothing-phone-2', 'Nothing Phone (2)', 'Nothing', 2023, '15', [6.7, 1080, 2412, 120, 1, 'oled', 'punch'], 'Snapdragon 8+ Gen 1', 8, 4700, [45, 15, 'USB-C'], ['5g', '6'], { massG: 201 }),
  android('fairphone-5', 'Fairphone 5', 'Fairphone', 2023, '15', [6.46, 1224, 2700, 90, 60, 'oled', 'punch'], 'QCM6490', 8, 4200, [30, 0, 'USB-C'], ['5g', '6e'], { massG: 212, removableBattery: true, altOS: ['linux', 'agentic'] }),

  // -------------------------------------------------------------- Linux
  phone('pinephone', 'PinePhone', 'Pine64', 2020, 'linux', 'postmarketOS 24.12', [5.95, 720, 1440, 60, 60, 'lcd', 'none'], 'Allwinner A64', 3, 3000, [15, 0, 'USB-C'], ['4g', '4'],
    { biometrics: 'none', massG: 185, removableBattery: true, altOS: ['agentic'], more: { killSwitches: ['modem', 'wifi', 'mic', 'camera'], distro: { name: 'postmarketOS', shell: 'Phosh', kernel: '6.12.9-postmarketos-allwinner' } } }),
  phone('pinephone-pro', 'PinePhone Pro', 'Pine64', 2022, 'linux', 'postmarketOS 24.12', [6.0, 720, 1440, 60, 60, 'lcd', 'none'], 'Rockchip RK3399S', 4, 3000, [15, 0, 'USB-C'], ['4g', '5'],
    { biometrics: 'none', massG: 215, removableBattery: true, altOS: ['agentic'], more: { killSwitches: ['modem', 'wifi', 'mic', 'camera'], distro: { name: 'postmarketOS', shell: 'Phosh', kernel: '6.12.9-postmarketos-rockchip' } } }),
  phone('librem-5', 'Librem 5', 'Purism', 2020, 'linux', 'PureOS 10 (Byzantium)', [5.7, 720, 1440, 60, 60, 'lcd', 'none'], 'NXP i.MX 8M Quad', 3, 4500, [18, 0, 'USB-C'], ['4g', '4'],
    { biometrics: 'none', massG: 263, removableBattery: true, altOS: ['agentic'], more: { killSwitches: ['modem', 'wifi', 'mic', 'camera'], distro: { name: 'PureOS', shell: 'Phosh', kernel: '6.6.0-1-librem5' } } }),
  phone('volla-x23', 'Volla Phone X23', 'Volla', 2023, 'linux', 'Ubuntu Touch 20.04 OTA-7', [6.1, 720, 1560, 60, 60, 'lcd', 'punch'], 'Helio G99', 6, 5000, [18, 15, 'USB-C'], ['4g', '5'],
    { massG: 280, removableBattery: true, more: { distro: { name: 'Ubuntu Touch', shell: 'Lomiri', kernel: '4.19.191-halium' } } }),

  // -------------------------------------------------------------- macOS
  mac('macbook-air-13-m2', 'MacBook Air 13" (M2)', 2022, 'laptop', [13.6, 2560, 1664, 60, 60, 'lcd', 'notch'], 'M2', 8, 52.6, { cooling: 'passive', massG: 1240, chargeW: 67, altOS: ['linux'] }),
  mac('macbook-air-13-m3', 'MacBook Air 13" (M3)', 2024, 'laptop', [13.6, 2560, 1664, 60, 60, 'lcd', 'notch'], 'M3', 8, 52.6, { cooling: 'passive', massG: 1240, chargeW: 70 }),
  mac('macbook-air-15-m3', 'MacBook Air 15" (M3)', 2024, 'laptop', [15.3, 2880, 1864, 60, 60, 'lcd', 'notch'], 'M3', 16, 66.5, { cooling: 'passive', massG: 1510, chargeW: 70 }),
  mac('macbook-pro-14-m3-pro', 'MacBook Pro 14" (M3 Pro)', 2023, 'laptop', [14.2, 3024, 1964, 120, 24, 'lcd', 'notch'], 'M3 Pro', 18, 72.4, { massG: 1610, chargeW: 96 }),
  mac('macbook-pro-16-m3-max', 'MacBook Pro 16" (M3 Max)', 2023, 'laptop', [16.2, 3456, 2234, 120, 24, 'lcd', 'notch'], 'M3 Max', 36, 100, { massG: 2160, chargeW: 140 }),
  mac('imac-24-m3', 'iMac 24" (M3)', 2023, 'desktop', [23.5, 4480, 2520, 60, 60, 'lcd', 'none'], 'M3', 8, null, { massG: 4480 }),
  mac('mac-mini-m4', 'Mac mini (M4)', 2024, 'desktop', null, 'M4', 16, null, { massG: 670, biometrics: 'none' }),
  mac('mac-studio-m2-max', 'Mac Studio (M2 Max)', 2023, 'desktop', null, 'M2 Max', 32, null, { massG: 2700, biometrics: 'none', altOS: ['linux'] }),

  // ------------------------------------- phones agenticOS lists as well supported
  // docs/INSTALL-postmarketos.md: PinePhone, PinePhone Pro, OnePlus 6/6T, Pocophone F1,
  // Fairphone 4/5, Samsung Galaxy A3/A5 (2015). Shipped with Android; flash postmarketOS
  // (ui=none) plus agentd. Older ones run their final stock Android version here.
  android('oneplus-6', 'OnePlus 6', 'OnePlus', 2018, '11', [6.28, 1080, 2280, 60, 60, 'oled', 'notch'], 'Snapdragon 845', 8, 3300, [20, 0, 'USB-C'], ['4g', '5'], { massG: 177, altOS: ['linux', 'agentic'] }),
  android('oneplus-6t', 'OnePlus 6T', 'OnePlus', 2018, '11', [6.41, 1080, 2340, 60, 60, 'oled', 'notch'], 'Snapdragon 845', 8, 3700, [20, 0, 'USB-C'], ['4g', '5'], { massG: 185, altOS: ['linux', 'agentic'] }),
  android('pocophone-f1', 'Pocophone F1', 'Xiaomi', 2018, '10', [6.18, 1080, 2246, 60, 60, 'lcd', 'notch'], 'Snapdragon 845', 6, 4000, [18, 0, 'USB-C'], ['4g', '5'], { massG: 182, cooling: 'vapor', altOS: ['linux', 'agentic'] }),
  android('fairphone-4', 'Fairphone 4', 'Fairphone', 2021, '13', [6.3, 1080, 2340, 60, 60, 'lcd', 'notch'], 'Snapdragon 750G', 8, 3905, [20, 0, 'USB-C'], ['5g', '5'], { massG: 225, removableBattery: true, altOS: ['linux', 'agentic'] }),
  android('galaxy-a5-2015', 'Galaxy A5 (2015)', 'Samsung', 2014, '6', [5.0, 720, 1280, 60, 60, 'oled', 'homeButton'], 'Snapdragon 410', 2, 2300, [10, 0, 'micro-USB'], ['4g', '4'], { massG: 123, altOS: ['linux', 'agentic'] }),
  android('galaxy-a3-2015', 'Galaxy A3 (2015)', 'Samsung', 2014, '6', [4.5, 540, 960, 60, 60, 'oled', 'homeButton'], 'Snapdragon 410', 1, 1900, [10, 0, 'micro-USB'], ['4g', '4'], { massG: 110, altOS: ['linux', 'agentic'] }),
];

export const OS_LABEL = { android: 'Android', ios: 'iOS', linux: 'Linux', macos: 'macOS', agentic: 'agenticOS' };

export function getSpec(id) {
  const s = DEVICES.find(d => d.id === id);
  if (!s) throw new Error(`Unknown device "${id}". Run "phonesim list" to see the catalog.`);
  return s;
}

/** OSes a device can run: its stock OS plus anything in altOS. */
export function supportedOS(spec) { return [spec.os, ...(spec.altOS || [])]; }
