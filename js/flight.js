// Flight logic shared by the flight page, the "My flights" cards and the alert
// watcher: status wording, picking the right day, merging gate data, estimates,
// border hints, and the copy kept on the phone for when there's no signal.
import * as src from './fr24.js';
import { hm, dayKey, rel, lateness, nowS } from './format.js';

export const LATE = 15 * 60; // arrival within 15 minutes of schedule counts as on time

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const clean = s => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('airside:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('airside:' + k, JSON.stringify(v)); } catch { /* private mode or full */ } },
  del(k) { try { localStorage.removeItem('airside:' + k); } catch { /* private mode */ } },
};

export const toneOf = d => d == null ? 'idle' : d < LATE ? 'ok' : d < 3600 ? 'warn' : 'bad';
export const airborne = f => f.state === 'airborne' || f.state === 'departed';
export const isFinal = f => f.state === 'canceled' || f.state === 'diverted' ||
  (f.state === 'landed' && f.arr.actual < nowS() - 1800) || f.dep.sched < nowS() - 86400;

// Before take-off the source has no arrival estimate; carry the departure delay over.
export function arrEstimate(f) {
  if (f.arr.actual || f.arr.est || !f.arr.sched || !f.dep.sched) return null;
  const depBest = f.dep.actual ?? f.dep.est;
  return depBest ? f.arr.sched + (depBest - f.dep.sched) : null;
}

export function statusOf(f) {
  const now = nowS();
  const depBest = f.dep.actual ?? f.dep.est;
  const arrBest = f.arr.actual ?? f.arr.est;
  const depDelay = depBest && f.dep.sched ? depBest - f.dep.sched : null;
  const arrDelay = arrBest && f.arr.sched ? arrBest - f.arr.sched : null;
  const airline = f.airline?.name ?? 'the airline';
  const landsAt = () => {
    const t = arrEstimate(f) ?? f.arr.sched;
    return t ? ` Lands at ${arrEstimate(f) ? 'about ' : ''}${hm(t, f.arr.tz)} local time.` : '';
  };

  switch (f.state) {
    case 'canceled':
      return { tone: 'bad', label: 'Cancelled', detail: `Contact ${esc(airline)} about rebooking or a refund.` };
    case 'diverted':
      return { tone: 'bad', label: f.divertedTo ? `Diverted to ${esc(f.divertedTo)}` : 'Diverted', detail: `The flight did not land at ${esc(f.arr.city)}.` };
    case 'landed':
      return {
        tone: toneOf(arrDelay), label: 'Landed', note: lateness(arrDelay),
        detail: `Landed at ${hm(f.arr.actual, f.arr.tz)} local time, ${rel(f.arr.actual)}.`,
      };
    case 'airborne':
    case 'departed':
      return {
        tone: toneOf(arrDelay ?? depDelay), label: 'In the air', note: arrDelay != null ? `Arriving ${lateness(arrDelay)}` : '',
        detail: `Departed at ${hm(f.dep.actual, f.dep.tz)}.` + (arrBest ? ` Lands at ${hm(arrBest, f.arr.tz)} local time, ${rel(arrBest)}.` : ''),
      };
  }
  if (!depBest && f.dep.sched < now - 3 * 3600) {
    return { tone: 'idle', label: 'No live data', detail: 'The data source has no record of this flight departing.' };
  }
  if (depDelay != null && depDelay >= LATE) {
    return {
      tone: toneOf(depDelay), label: 'Delayed', note: lateness(depDelay),
      detail: `Now expected to leave at ${hm(depBest, f.dep.tz)} local time, ${rel(depBest)}.${landsAt()}`,
    };
  }
  return {
    tone: depBest ? 'ok' : 'idle',
    label: depBest ? 'On time' : 'Scheduled',
    detail: `Departs at ${hm(depBest ?? f.dep.sched, f.dep.tz)} local time, ${rel(depBest ?? f.dep.sched)}.${landsAt()}`,
  };
}

// Border checks between the two airports' countries (Schengen as of 2026).
const SCHENGEN = new Set('AT BE BG HR CZ DK EE FI FR DE GR HU IS IT LV LI LT LU MT NL NO PL PT RO SK SI ES SE CH'.split(' '));
const CTA = new Set(['GB', 'IE', 'IM', 'JE', 'GG']); // UK–Ireland Common Travel Area

export function borderNote(f, side) {
  const a = f.dep.cc, b = f.arr.cc;
  if (!a || !b || a === b) return null;
  if (side === 'dep') {
    return SCHENGEN.has(a) && !SCHENGEN.has(b) ? 'Passport control after security: this flight leaves the Schengen area.' : null;
  }
  if (SCHENGEN.has(a) && SCHENGEN.has(b)) return null;
  if (CTA.has(a) && CTA.has(b)) return null;
  return 'Passport control on arrival.';
}

// The day to show: the one asked for, otherwise the next flight that hasn't finished.
export function pick(flights, date, from) {
  if (date) {
    const m = flights.find(f => dayKey(f.dep.sched, f.dep.tz) === date && (!from || f.dep.iata === from));
    if (m) return m;
  }
  const now = nowS();
  return flights.find(f => (f.arr.actual ?? f.arr.est ?? f.arr.sched ?? f.dep.sched) > now - 3 * 3600) ?? flights.at(-1);
}

export function merge(f, info) {
  for (const side of ['dep', 'arr']) {
    for (const [k, v] of Object.entries(info?.[side] ?? {})) if (v) f[side][k] = v;
  }
  for (const [k, v] of Object.entries(info?.aircraft ?? {})) if (v && !f.aircraft[k]) f.aircraft[k] = v;
  f.callsign ||= info?.callsign ?? '';
  f.airline ??= info?.airline ?? null;
}

// ---------- copy kept on the phone

const SNAP_MAX = 8;

export function readSnap(number) {
  const s = store.get('snap:' + number, null);
  return s?.flights?.length ? s : null;
}

function saveSnap(number, flights) {
  store.set('snap:' + number, { at: Date.now(), flights });
  const index = store.get('snaps', []).filter(n => n !== number);
  index.unshift(number);
  for (const old of index.splice(SNAP_MAX)) store.del('snap:' + old);
  store.set('snaps', index);
}

// Fetch a flight number, pick the day, add gates when the travel day is near, and
// keep a copy. `onList` gets an early look before the gate lookups finish.
export async function fetchFlight(number, { date, from, fresh, gateHours = 36, onList } = {}) {
  const flights = await src.findFlight(number, { fresh });
  if (!flights.length) return { flights, f: null };
  const f = pick(flights, date, from);
  onList?.(flights, f);
  if (Math.abs(f.dep.sched - nowS()) < gateHours * 3600) {
    try { merge(f, await src.gateInfo(f, { fresh })); } catch { /* gates are a bonus */ }
  }
  saveSnap(number, flights);
  return { flights, f };
}
