// Live aircraft position and flown track for Airside.
// GET /api/live?hex=4cade5&cs=RYR7LD[&since=<takeoff unix s>][&trail=1]
// Data: adsb.lol, an open ADS-B network (ODbL). Browsers can't call it directly
// (no CORS headers), so this function relays a trimmed copy.

const API = 'https://api.adsb.lol/v2';
const TRACES = 'https://globe.adsb.lol/data/traces';
const ORIGINS = new Set(['https://opennerdz.github.io', 'http://127.0.0.1:8787', 'http://localhost:8787']);
const MAX_TRAIL = 300;

const get = async url => {
  const r = await fetch(url, { headers: { 'user-agent': 'airside (+https://opennerdz.github.io/airside/)' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
};

function position(ac) {
  if (ac?.lat == null || ac?.lon == null) return null;
  const ground = ac.alt_baro === 'ground';
  return {
    hex: ac.hex,
    callsign: (ac.flight ?? '').trim(),
    reg: ac.r ?? '',
    type: ac.t ?? '',
    lat: ac.lat,
    lon: ac.lon,
    ground,
    alt: ground ? 0 : ac.alt_baro ?? ac.alt_geom ?? null,        // feet
    gs: ac.gs ?? null,                                            // knots
    track: ac.track ?? ac.true_heading ?? ac.mag_heading ?? null, // degrees
    vrate: ac.baro_rate ?? ac.geom_rate ?? null,                  // feet per minute
    age: Math.round(ac.seen_pos ?? ac.seen ?? 0),                 // seconds since this fix
    mlat: ac.type === 'mlat',
  };
}

async function trail(hex, since) {
  const dir = `${TRACES}/${hex.slice(-2)}`;
  const [full, recent] = await Promise.allSettled([
    get(`${dir}/trace_full_${hex}.json`),
    get(`${dir}/trace_recent_${hex}.json`),
  ]);
  const pts = new Map();
  for (const r of [full, recent]) {
    if (r.status !== 'fulfilled') continue;
    for (const p of r.value.trace ?? []) {
      const t = r.value.timestamp + p[0];
      if (t >= since && p[1] != null) pts.set(Math.round(t), [+p[1].toFixed(4), +p[2].toFixed(4), p[3] === 'ground' ? 0 : p[3]]);
    }
  }
  const all = [...pts.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  if (all.length <= MAX_TRAIL) return all;
  const step = all.length / MAX_TRAIL;
  return Array.from({ length: MAX_TRAIL }, (_, i) => all[Math.floor(i * step)]).concat([all.at(-1)]);
}

export default async req => {
  const url = new URL(req.url);
  const origin = req.headers.get('origin');
  const headers = { 'content-type': 'application/json', vary: 'origin' };
  if (ORIGINS.has(origin)) headers['access-control-allow-origin'] = origin;

  const hex = (url.searchParams.get('hex') ?? '').toLowerCase();
  const cs = (url.searchParams.get('cs') ?? '').toUpperCase();
  const since = Number(url.searchParams.get('since')) || Date.now() / 1000 - 6 * 3600;
  const wantTrail = url.searchParams.get('trail') === '1';
  if (!/^[0-9a-f]{6}$/.test(hex) && !/^[A-Z0-9]{3,8}$/.test(cs)) {
    return new Response(JSON.stringify({ error: 'Pass hex (6 hex digits) or cs (ICAO callsign).' }), { status: 400, headers });
  }

  try {
    let pos = null;
    if (/^[0-9a-f]{6}$/.test(hex)) pos = position((await get(`${API}/hex/${hex}`)).ac?.[0]);
    if (!pos && cs) pos = position((await get(`${API}/callsign/${cs}`)).ac?.find(a => a.lat != null));
    const body = { pos, trail: wantTrail && pos ? await trail(pos.hex, since - 600) : null, now: Math.round(Date.now() / 1000) };
    // Shared CDN cache: many viewers of one flight cost one upstream call per window.
    headers['cache-control'] = 'public, max-age=5';
    headers['netlify-cdn-cache-control'] = `public, durable, s-maxage=${wantTrail ? 60 : 8}`;
    return new Response(JSON.stringify(body), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message ?? e) }), { status: 502, headers });
  }
};

export const config = { path: '/api/live' };
