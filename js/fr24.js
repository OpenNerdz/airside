// Data source adapter. This is the only file that knows where flight data comes
// from: it calls the public JSON endpoints that flightradar24.com uses for its
// own pages and turns them into the plain shapes the rest of the app reads.
// To switch to another provider (Aena, AeroDataBox, a paid API behind your own
// proxy), write a module with the same three exports: findFlight, board, gateInfo.
//
// Normalised flight:
// { number, callsign, codeshares[], state, divertedTo,
//   airline: {name, iata, icao}, aircraft: {code, model, reg, hex},
//   dep: {iata, icao, name, city, country, lat, lon, tz, tzAbbr,
//         sched, est, actual, terminal, gate, desk},
//   arr: { ...same, belt instead of desk } }
// Times are Unix seconds (UTC). state is one of: scheduled, airborne, departed,
// landed, canceled, diverted, unknown.

const BASE = 'https://api.flightradar24.com/common/v1';
const TTL = 30_000;
const cache = new Map();

export class SourceError extends Error {
  constructor(kind, status) {
    super(kind === 'blocked'
      ? 'The live data source is refusing requests right now.'
      : `The live data source answered with an error (${status || 'network'}).`);
    this.kind = kind;
  }
}

async function getJSON(url, { fresh = false } = {}) {
  const hit = cache.get(url);
  if (!fresh && hit && Date.now() - hit.t < TTL) return hit.p;
  const p = fetch(url, { credentials: 'omit' }).then(r => {
    if (r.status === 403 || r.status === 429) throw new SourceError('blocked', r.status);
    if (!r.ok) throw new SourceError('http', r.status);
    return r.json();
  }, () => { throw new SourceError('network'); });
  cache.set(url, { t: Date.now(), p });
  p.catch(() => cache.delete(url));
  return p;
}

function place(a, info) {
  const pos = a?.position ?? {};
  return {
    iata: a?.code?.iata ?? '',
    icao: a?.code?.icao ?? '',
    name: a?.name ?? '',
    city: pos.region?.city || a?.name || '',
    country: pos.country?.name ?? '',
    lat: pos.latitude ?? null,
    lon: pos.longitude ?? null,
    tz: a?.timezone?.name ?? 'UTC',
    tzAbbr: a?.timezone?.abbr ?? '',
    terminal: info?.terminal || null,
    gate: info?.gate || null,
  };
}

const STATES = {
  scheduled: 'scheduled', estimated: 'scheduled', delayed: 'scheduled',
  departed: 'departed', landed: 'landed', canceled: 'canceled',
  cancelled: 'canceled', diverted: 'diverted',
};

function normalise(f, here) {
  const t = f.time ?? {};
  const gs = f.status?.generic ?? {};
  const ev = gs.eventTime?.utc ?? null;
  const evType = gs.status?.type;
  const real = t.real ?? {};

  let state = STATES[gs.status?.text] ?? 'unknown';
  if (gs.status?.diverted) state = 'diverted';
  else if (real.arrival) state = 'landed';
  else if (f.status?.live) state = 'airborne';
  else if (real.departure && state === 'scheduled') state = 'departed';

  // A board only describes its own airport by timezone, so fill it in.
  const o = f.airport?.origin, d = f.airport?.destination;
  const dep = place(o?.code ? o : { ...here?.raw, timezone: o?.timezone ?? here?.raw?.timezone }, o?.info);
  const arr = place(d?.code ? d : { ...here?.raw, timezone: d?.timezone ?? here?.raw?.timezone }, d?.info);
  dep.desk = o?.info?.baggage || null; // at the departure airport this is the check-in area
  arr.belt = d?.info?.baggage || null;

  dep.sched = t.scheduled?.departure ?? null;
  dep.actual = real.departure ?? null;
  dep.est = t.estimated?.departure ?? (evType === 'departure' && !dep.actual ? ev : null);
  arr.sched = t.scheduled?.arrival ?? null;
  arr.actual = real.arrival ?? null;
  arr.est = arr.actual ? null : t.estimated?.arrival ?? t.other?.eta ?? (evType === 'arrival' ? ev : null);

  const al = f.airline ?? f.owner;
  return {
    number: f.identification?.number?.default ?? '',
    callsign: f.identification?.callsign ?? '',
    codeshares: f.identification?.codeshare ?? [],
    state,
    divertedTo: typeof gs.status?.diverted === 'string' ? gs.status.diverted : null,
    airline: al ? { name: al.short || al.name, iata: al.code?.iata ?? '', icao: al.code?.icao ?? '' } : null,
    aircraft: {
      code: f.aircraft?.model?.code ?? '',
      model: f.aircraft?.model?.text ?? '',
      reg: f.aircraft?.registration ?? '',
      hex: f.aircraft?.hex ?? '',
    },
    dep, arr,
  };
}

// All known days for one flight number, oldest first.
export async function findFlight(number, opts) {
  const url = `${BASE}/flight/list.json?query=${encodeURIComponent(number)}&fetchBy=flight&page=1&limit=100`;
  const json = await getJSON(url, opts);
  const rows = json?.result?.response?.data ?? [];
  const flights = rows.map(f => normalise(f)).filter(f => f.dep.sched);
  flights.sort((a, b) => a.dep.sched - b.dep.sched);
  // Future rows often lack the airline and aircraft name; borrow them from flown days.
  const known = flights.find(f => f.airline);
  for (const f of flights) {
    f.airline ??= known?.airline ?? null;
    if (!f.aircraft.model) f.aircraft.model = flights.find(g => g.aircraft.code === f.aircraft.code && g.aircraft.model)?.aircraft.model ?? '';
  }
  return flights;
}

// One page of an airport's departures or arrivals, starting at `from` (Unix s).
// `details` adds the airport's own name and timezone (about 5 KB); skip it when only rows are needed.
export async function board(iata, mode, { from, page = 1, limit = 40, details = true, fresh } = {}) {
  const q = new URLSearchParams({ code: iata.toLowerCase(), page, limit });
  if (details) q.append('plugin[]', 'details');
  q.append('plugin[]', 'schedule');
  q.set('plugin-setting[schedule][mode]', mode);
  if (from) q.set('plugin-setting[schedule][timestamp]', Math.floor(from));
  const json = await getJSON(`${BASE}/airport.json?${q}`, { fresh });
  const data = json?.result?.response?.airport?.pluginData;
  const det = data?.details;
  if (details && !det?.code) return null;
  const here = det?.code ? { raw: { name: det.name, code: det.code, position: det.position, timezone: det.timezone } } : null;
  const sched = data.schedule?.[mode] ?? {};
  const rows = (sched.data ?? [])
    .map(x => normalise(x.flight, here))
    .filter(f => f.number && f.dep.sched);
  return {
    airport: here ? place(here.raw) : null,
    rows,
    page: sched.page?.current ?? page,
    pages: sched.page?.total ?? page,
  };
}

// Terminal, gate, check-in and belt come from the airport boards, not the flight list.
export async function gateInfo(f, opts) {
  const near = (rows, key) => rows?.find(r =>
    (r.number === f.number || r.codeshares.includes(f.number)) &&
    Math.abs(r[key].sched - f[key].sched) < 3 * 3600);
  const [d, a] = await Promise.allSettled([
    f.dep.iata && board(f.dep.iata, 'departures', { from: f.dep.sched - 60, limit: 25, details: false, ...opts }),
    f.arr.iata && board(f.arr.iata, 'arrivals', { from: f.arr.sched - 60, limit: 25, details: false, ...opts }),
  ]);
  const dr = d.status === 'fulfilled' ? near(d.value?.rows, 'dep') : null;
  const ar = a.status === 'fulfilled' ? near(a.value?.rows, 'arr') : null;
  return {
    dep: dr ? { terminal: dr.dep.terminal, gate: dr.dep.gate, desk: dr.dep.desk } : null,
    arr: ar ? { terminal: ar.arr.terminal, gate: ar.arr.gate, belt: ar.arr.belt } : null,
    aircraft: (dr ?? ar)?.aircraft ?? null,
    airline: (dr ?? ar)?.airline ?? null,
    callsign: (dr ?? ar)?.callsign ?? '',
  };
}
