// Time and distance formatting. Every clock time is shown in the local time of
// the airport it belongs to, so formatters always take that airport's timezone.

const fmts = new Map();
function fmt(tz, opts) {
  const key = tz + JSON.stringify(opts);
  let f = fmts.get(key);
  if (!f) fmts.set(key, f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }));
  return f;
}

export const nowS = () => Date.now() / 1000;

export function hm(ts, tz) {
  return ts ? fmt(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts * 1000) : '–';
}

// YYYY-MM-DD in the airport's own calendar.
export function dayKey(ts, tz) {
  const p = Object.fromEntries(fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(ts * 1000).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const dayNum = key => Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) / 864e5;

export function dayLabel(ts, tz) {
  const diff = dayNum(dayKey(ts, tz)) - dayNum(dayKey(nowS(), tz));
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return fmt(tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(ts * 1000);
}

export const shortDay = (ts, tz) => fmt(tz, { weekday: 'short', day: 'numeric' }).format(ts * 1000);
export const longDate = (ts, tz) => fmt(tz, { weekday: 'long', day: 'numeric', month: 'long' }).format(ts * 1000);

export function dur(secs) {
  const m = Math.round(Math.abs(secs) / 60);
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

// "in 2 h 5 min" / "12 min ago" / "now"
export function rel(ts) {
  const d = ts - nowS();
  if (Math.abs(d) < 60) return 'now';
  return d > 0 ? `in ${dur(d)}` : `${dur(d)} ago`;
}

// "12 min late", "4 min early", "on schedule"
export function lateness(secs) {
  if (secs == null) return '';
  if (Math.abs(secs) < 60) return 'on schedule';
  return `${dur(secs)} ${secs > 0 ? 'late' : 'early'}`;
}

export function offsetMin(tz, ts = nowS()) {
  const p = Object.fromEntries(fmt(tz, {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(ts * 1000).map(x => [x.type, +x.value]));
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 1000 - ts) / 60);
}

export function distanceKm(a, b) {
  if ([a.lat, a.lon, b.lat, b.lon].some(v => v == null)) return null;
  const r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return Math.round(12742 * Math.asin(Math.sqrt(h)));
}

export const num = n => n.toLocaleString('en-GB');
