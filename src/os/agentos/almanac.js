// The almanac: time and calendar answers computed on the phone, with no LLM and no network.
// Country profiles decide how time is shown and which related answers follow it
// (India: nakshatra, tithi, rahu kaal, vastu; China: lunar date and feng shui; Japan: era
// date and rokuyō; Gulf: Hijri date; elsewhere just the time).
//
// Moon and Sun positions use a low-precision ephemeris (Meeus, "Astronomical Algorithms",
// ch. 47 main terms; ch. 25 low accuracy Sun): about 0.3° for the Moon, enough to name the
// nakshatra (13°20' wide) and tithi (12°) except within minutes of a boundary.

const rad = Math.PI / 180;
const norm = x => ((x % 360) + 360) % 360;

/** Days since J2000.0 (2000-01-01 12:00 TT, ignoring ΔT). */
const daysJ2000 = ms => ms / 86400000 + 2440587.5 - 2451545.0;

export function moonLongitude(ms) {
  const d = daysJ2000(ms);
  const L = 218.3164477 + 13.17639648 * d;     // mean longitude
  const D = 297.8501921 + 12.19074912 * d;     // mean elongation
  const M = 357.5291092 + 0.98560028 * d;      // Sun's mean anomaly
  const Mm = 134.9633964 + 13.06499295 * d;    // Moon's mean anomaly
  const F = 93.272095 + 13.22935024 * d;       // argument of latitude
  const s = deg => Math.sin(deg * rad);
  return norm(L + 6.288774 * s(Mm) + 1.274027 * s(2 * D - Mm) + 0.658314 * s(2 * D) + 0.213618 * s(2 * Mm)
    - 0.185116 * s(M) - 0.114332 * s(2 * F) + 0.058793 * s(2 * D - 2 * Mm) + 0.057066 * s(2 * D - M - Mm)
    + 0.053322 * s(2 * D + Mm) + 0.045758 * s(2 * D - M) - 0.040923 * s(M - Mm) - 0.034720 * s(D) - 0.030383 * s(M + Mm));
}

export function sunLongitude(ms) {
  const d = daysJ2000(ms);
  const L0 = 280.46646 + 0.98564736 * d, M = 357.52911 + 0.98560028 * d;
  return norm(L0 + 1.914602 * Math.sin(M * rad) + 0.019993 * Math.sin(2 * M * rad));
}

/** Lahiri (Chitrapaksha) ayanamsa, linear fit: 23.853° at 2000.0, +50.29"/year. */
export const ayanamsa = ms => 23.853 + 0.013969 * ((ms - Date.UTC(2000, 0, 1, 12)) / (365.25 * 86400000));

export const NAKSHATRAS = ['Ashwini', 'Bharani', 'Krittika', 'Rohini', 'Mrigashira', 'Ardra', 'Punarvasu', 'Pushya', 'Ashlesha',
  'Magha', 'Purva Phalguni', 'Uttara Phalguni', 'Hasta', 'Chitra', 'Swati', 'Vishakha', 'Anuradha', 'Jyeshtha', 'Mula',
  'Purva Ashadha', 'Uttara Ashadha', 'Shravana', 'Dhanishta', 'Shatabhisha', 'Purva Bhadrapada', 'Uttara Bhadrapada', 'Revati'];
const TITHIS = ['Pratipada', 'Dwitiya', 'Tritiya', 'Chaturthi', 'Panchami', 'Shashthi', 'Saptami', 'Ashtami', 'Navami',
  'Dashami', 'Ekadashi', 'Dwadashi', 'Trayodashi', 'Chaturdashi'];

export function nakshatra(ms) {
  const sid = norm(moonLongitude(ms) - ayanamsa(ms));
  const span = 360 / 27, i = Math.floor(sid / span);
  return { index: i, name: NAKSHATRAS[i], pada: Math.floor((sid % span) / (span / 4)) + 1, siderealMoon: +sid.toFixed(2) };
}

export function tithi(ms) {
  const e = norm(moonLongitude(ms) - sunLongitude(ms)), n = Math.floor(e / 12) + 1; // 1..30
  const paksha = n <= 15 ? 'Shukla' : 'Krishna';
  const name = n === 15 ? 'Purnima' : n === 30 ? 'Amavasya' : TITHIS[(n - 1) % 15];
  return { number: n, paksha, name, elongation: +e.toFixed(1) };
}

// Rahu kaal: the 8 equal parts of the day (sunrise to sunset; 06:00–18:00 assumed), one per weekday.
const RAHU_PART = [8, 2, 7, 5, 6, 4, 3]; // Sunday..Saturday, 1-based eighth of the day
export function rahuKaal(weekday) {
  const start = 6 * 60 + (RAHU_PART[weekday] - 1) * 90;
  const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${hm(start)}–${hm(start + 90)}`;
}

// Traditional guidance, offered as tradition, not fact.
export const VASTU = {
  entrance: 'Main entrance facing north or east is traditionally preferred; keep it well lit and uncluttered.',
  kitchen: 'Kitchen in the south-east (Agni corner); cook facing east.',
  bedroom: 'Master bedroom in the south-west; sleep with your head to the south or east.',
  pooja: 'Prayer room in the north-east (Ishanya), facing east or north.',
  study: 'Study facing east or north; keep the desk away from beams overhead.',
  toilet: 'Toilets in the west or north-west; avoid the north-east.',
  office: 'Sit facing north or east, with a solid wall behind you.',
  mirror: 'Mirrors on north or east walls; avoid one facing the bed.',
  water: 'Water tanks underground in the north-east; overhead tanks in the south-west.',
  locker: 'Keep the locker or safe in the south-west, opening towards the north (Kubera).',
};
const FENG_SHUI = [
  'Keep the front door clear so chi can enter.', 'Place the desk in the command position: facing the door, not in line with it.',
  'Fix leaking taps: in feng shui they stand for money draining away.', 'A healthy plant in the east supports family and health.',
  'Avoid sleeping with your feet pointing straight at the door.', 'Declutter one corner today: stagnant objects block chi.',
];
const ROKUYO = ['Taian (大安, lucky all day)', 'Shakkō (赤口, lucky only at noon)', 'Senshō (先勝, morning lucky)', 'Tomobiki (友引, avoid funerals)', 'Senbu (先負, afternoon lucky)', 'Butsumetsu (仏滅, unlucky)'];
const ZODIAC = ['Rat', 'Ox', 'Tiger', 'Rabbit', 'Dragon', 'Snake', 'Horse', 'Goat', 'Monkey', 'Rooster', 'Dog', 'Pig'];

// ---------------------------------------------------------------- countries
// How each country shows time, and which answers usually follow "what time is it".
export const COUNTRIES = {
  IN: { name: 'India', tz: 'Asia/Kolkata', locale: 'en-IN', zone: 'IST', after: { time_now: ['nakshatra', 'vastu'], nakshatra: ['rahu_kaal'] } },
  US: { name: 'United States', tz: 'America/New_York', locale: 'en-US', zone: 'ET', after: {} },
  GB: { name: 'United Kingdom', tz: 'Europe/London', locale: 'en-GB', zone: 'UK', after: {} },
  DE: { name: 'Germany', tz: 'Europe/Berlin', locale: 'de-DE', zone: 'MEZ', after: {} },
  CN: { name: 'China', tz: 'Asia/Shanghai', locale: 'zh-CN', zone: 'CST', after: { time_now: ['lunar_date', 'feng_shui'] } },
  JP: { name: 'Japan', tz: 'Asia/Tokyo', locale: 'ja-JP', zone: 'JST', after: { time_now: ['rokuyo'] } },
  SA: { name: 'Saudi Arabia', tz: 'Asia/Riyadh', locale: 'ar-SA', zone: 'AST', after: { time_now: ['hijri_date'] } },
  AE: { name: 'United Arab Emirates', tz: 'Asia/Dubai', locale: 'en-AE', zone: 'GST', after: { time_now: ['hijri_date'] } },
};

function weekdayIn(ms, tz) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(ms)); }
function chineseLunar(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-u-ca-chinese', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: tz }).formatToParts(ms);
  const get = t => parts.find(p => p.type === t)?.value;
  const month = parseInt(get('month'), 10), leap = /bis|leap/i.test(get('month') || ''), day = Number(get('day')), year = Number(get('relatedYear'));
  return { month, leap, day, year };
}

/** Run one almanac tool. `ms` is the phone's clock, `cc` its country code. */
export function almanac(tool, args, ms, cc = 'IN') {
  const c = COUNTRIES[cc] || COUNTRIES.IN;
  switch (tool) {
    case 'time_now': {
      const s = new Intl.DateTimeFormat(c.locale, { dateStyle: 'full', timeStyle: 'short', timeZone: c.tz }).format(ms);
      return `${s} (${c.zone})`;
    }
    case 'nakshatra': {
      const n = nakshatra(ms), t = tithi(ms);
      return `Nakshatra ${n.name}, pada ${n.pada} (sidereal Moon ${n.siderealMoon}°); tithi ${t.paksha} ${t.name}`;
    }
    case 'panchang': {
      const n = nakshatra(ms), t = tithi(ms), wd = weekdayIn(ms, c.tz);
      return `Tithi ${t.paksha} ${t.name} · Nakshatra ${n.name} (pada ${n.pada}) · Vaar ${['Ravivaar', 'Somvaar', 'Mangalvaar', 'Budhvaar', 'Guruvaar', 'Shukravaar', 'Shanivaar'][wd]} · Rahu kaal ${rahuKaal(wd)}`;
    }
    case 'rahu_kaal': return `Rahu kaal today: ${rahuKaal(weekdayIn(ms, c.tz))} (taking sunrise as 06:00)`;
    case 'vastu': {
      const topic = Object.keys(VASTU).find(k => (args.topic || '').toLowerCase().includes(k));
      const day = Math.floor(ms / 86400000), keys = Object.keys(VASTU);
      const k = topic || keys[day % keys.length];
      return `Vastu (${k}): ${VASTU[k]}`;
    }
    case 'hijri_date': return `Hijri: ${new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { dateStyle: 'long', timeZone: c.tz }).format(ms)}`;
    case 'lunar_date': {
      const l = chineseLunar(ms, 'Asia/Shanghai');
      return `Chinese lunar date: month ${l.month}${l.leap ? ' (leap)' : ''}, day ${l.day}; year of the ${ZODIAC[(l.year - 4) % 12]}`;
    }
    case 'feng_shui': return `Feng shui: ${FENG_SHUI[Math.floor(ms / 86400000) % FENG_SHUI.length]}`;
    case 'rokuyo': {
      const l = chineseLunar(ms, 'Asia/Tokyo');
      const era = new Intl.DateTimeFormat('ja-JP-u-ca-japanese', { era: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tokyo' }).format(ms);
      return `${era} · Rokuyō: ${ROKUYO[(l.month + l.day) % 6]}`;
    }
  }
  return null;
}

/** How often an answer goes stale, in seconds: what a widget's refresh is based on. */
export const STALE_AFTER = { time_now: 60, rahu_kaal: 3600, nakshatra: 1800, panchang: 1800, vastu: 86400, feng_shui: 86400, hijri_date: 3600, lunar_date: 3600, rokuyo: 3600, weather: 1800, phone_status: 300, read_messages: 300, list_calls: 300 };
