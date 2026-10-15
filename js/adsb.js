// Live position source: adsb.lol (open ADS-B network, ODbL) through Airside's own
// relay, because adsb.lol doesn't let browsers call it directly. The relay is
// netlify/functions/live.mjs, deployed at airside-live.netlify.app.
const API = 'https://airside-live.netlify.app/api/live';

// { pos: {lat, lon, alt, gs, track, vrate, age, ground, mlat} | null, trail: [[lat, lon, alt]] | null }
export async function fetchLive(f, { trail = false } = {}) {
  const q = new URLSearchParams();
  if (f.aircraft.hex) q.set('hex', f.aircraft.hex.toLowerCase());
  if (f.callsign) q.set('cs', f.callsign);
  if (!q.size) return { pos: null, trail: null };
  if (trail) {
    q.set('trail', '1');
    if (f.dep.actual) q.set('since', Math.floor(f.dep.actual));
  }
  const r = await fetch(`${API}?${q}`, { credentials: 'omit' });
  if (!r.ok) throw new Error(`Live position relay answered ${r.status}`);
  return r.json();
}
