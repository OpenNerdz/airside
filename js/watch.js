// Alerts for flights you ask to watch: a gate appearing or changing, a new
// departure time, take-off, landing, a cancellation or diversion, and the bag
// belt. Checks run every minute while Airside is open (browsers slow background
// tabs to about once a minute, which is enough). On a phone, alerts arrive as
// system notifications through the service worker; they also show on the page.
import { fetchFlight, store, airborne } from './flight.js';
import { hm, lateness, dayKey } from './format.js';

const CHECK_EVERY = 60_000;
const listeners = new Set();

const all = () => store.get('watch', {});
const save = w => { store.set('watch', w); listeners.forEach(fn => fn()); };
export const keyOf = f => `${f.number}|${dayKey(f.dep.sched, f.dep.tz)}|${f.dep.iata}`;
export const isWatched = f => !!all()[keyOf(f)];
export const watchedNumbers = () => new Set(Object.values(all()).map(w => w.n));
export const onWatchChange = fn => listeners.add(fn);

export const canNotify = () => 'Notification' in window && 'serviceWorker' in navigator;
export const notifyPermission = () => (canNotify() ? Notification.permission : 'unsupported');

// What an alert compares between two checks.
function snapshot(f) {
  return {
    state: f.state,
    gate: f.dep.gate ?? null,
    terminal: f.dep.terminal ?? null,
    dep: f.dep.actual ?? f.dep.est ?? null,
    arr: f.arr.actual ?? null,
    belt: f.arr.belt ?? null,
    checked: Date.now(),
  };
}

function changes(a, b, f) {
  if (!a) return [];
  const out = [];
  const gateName = g => (/^[A-Z]$/.test(g) ? `gate area ${g}` : `gate ${g}`);
  if (b.gate && b.gate !== a.gate) {
    out.push(a.gate && !/^[A-Z]$/.test(a.gate) ? `Gate changed to ${b.gate} (was ${a.gate})` : `Boarding from ${gateName(b.gate)}`);
  }
  if (b.terminal && a.terminal && b.terminal !== a.terminal) out.push(`Terminal changed to ${b.terminal}`);
  if (b.state !== a.state) {
    if (b.state === 'canceled') out.push('Cancelled');
    else if (b.state === 'diverted') out.push(f.divertedTo ? `Diverted to ${f.divertedTo}` : 'Diverted');
    else if (airborne(f) && !['airborne', 'departed'].includes(a.state)) out.push(`Took off at ${hm(f.dep.actual ?? Date.now() / 1000, f.dep.tz)}`);
    else if (b.state === 'landed') out.push(`Landed at ${hm(f.arr.actual, f.arr.tz)} in ${f.arr.city}`);
  } else if (b.state === 'scheduled' && b.dep && a.dep && Math.abs(b.dep - a.dep) >= 5 * 60) {
    out.push(`Now departing ${hm(b.dep, f.dep.tz)} (${lateness(b.dep - f.dep.sched)})`);
  }
  if (b.belt && b.belt !== a.belt) out.push(`Bags on belt ${b.belt}`);
  return out;
}

// ---------- alerts

let toastBox = null;
function toast(title, body, url) {
  toastBox ??= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'toasts' });
  toastBox.setAttribute('aria-live', 'assertive');
  const t = document.createElement('a');
  t.className = 'toast';
  t.href = url;
  t.dataset.nav = '';
  t.innerHTML = '<b></b><span></span>';
  t.firstChild.textContent = title;
  t.lastChild.textContent = body;
  toastBox.append(t);
  setTimeout(() => t.remove(), 12_000);
}

async function alertFor(f, lines) {
  const title = `${f.number} ${f.dep.iata} → ${f.arr.iata}`;
  const body = lines.join('. ');
  const url = `?flight=${encodeURIComponent(f.number)}&date=${dayKey(f.dep.sched, f.dep.tz)}&from=${f.dep.iata}`;
  toast(title, body, url);
  if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([180, 90, 180]); // browsers refuse before a first tap
  if (notifyPermission() !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, {
      body,
      tag: f.number,
      renotify: true,
      icon: new URL('icons/icon-192.png', location.href).href,
      data: { url: new URL(url, location.href).href },
    });
  } catch { /* the toast already showed it */ }
}

// Called with every fresh copy of a flight, from the page or from the watcher.
export function observe(f) {
  const w = all();
  const entry = w[keyOf(f)];
  if (!entry) return;
  const next = snapshot(f);
  const lines = changes(entry.last, next, f);
  entry.last = next;
  if (f.state === 'canceled' || f.state === 'diverted' || (f.state === 'landed' && f.arr.actual && Date.now() / 1000 - f.arr.actual > 2 * 3600)) {
    delete w[keyOf(f)]; // nothing left to tell you about
  }
  store.set('watch', w);
  if (lines.length) alertFor(f, lines);
}

export async function toggle(f) {
  const w = all();
  const key = keyOf(f);
  if (w[key]) {
    delete w[key];
    save(w);
    return false;
  }
  w[key] = { n: f.number, date: dayKey(f.dep.sched, f.dep.tz), from: f.dep.iata, route: `${f.dep.iata} → ${f.arr.iata}`, last: snapshot(f) };
  save(w);
  if (notifyPermission() === 'default') {
    try { await Notification.requestPermission(); } catch { /* old browsers */ }
    listeners.forEach(fn => fn());
  }
  return true;
}

let started = false;
export function startWatcher() {
  if (started) return;
  started = true;
  const tick = async () => {
    const stale = dayKey(Date.now() / 1000 - 2 * 86400, 'UTC');
    for (const [key, entry] of Object.entries(all())) {
      if (entry.date < stale) { const w = all(); delete w[key]; save(w); continue; } // a trip that's long over
      if (Date.now() - (entry.last?.checked ?? 0) < CHECK_EVERY - 5_000) continue; // the open page just checked it
      try {
        const { f } = await fetchFlight(entry.n, { date: entry.date, from: entry.from, fresh: true });
        if (f) observe(f);
      } catch { /* offline: try again next minute */ }
    }
    setTimeout(tick, CHECK_EVERY);
  };
  setTimeout(tick, 5_000);
}
