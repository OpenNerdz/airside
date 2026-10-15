// Smoke test for the data adapter against the live source: node tools/check-source.mjs FR2660
// Node's fetch sends "node" as its user agent, which Cloudflare challenges; browsers send their own.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(url, { ...init, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36', ...init.headers } });
const src = await import('../js/fr24.js');
const number = process.argv[2] ?? 'FR2660';
const flights = await src.findFlight(number);
console.log(`${flights.length} days for ${number}`);
for (const f of flights) console.log(new Date(f.dep.sched * 1000).toISOString(), f.dep.iata, '->', f.arr.iata, f.state, 'est', f.dep.est, 'act', f.dep.actual, f.arr.actual, f.aircraft.reg, f.airline?.name);
const now = Date.now() / 1000;
const today = flights.find(f => (f.arr.actual ?? f.arr.est ?? f.arr.sched) > now - 3 * 3600) ?? flights.at(-1);
console.log('gate info', JSON.stringify(await src.gateInfo(today)));
const b = await src.board('ALC', 'arrivals', { from: now - 2700, limit: 8 });
console.log(b.airport, b.page, b.pages);
for (const f of b.rows) console.log(f.number, f.dep.iata, f.dep.city, '->', f.arr.iata, f.arr.tz, f.state, f.arr.belt, f.arr.terminal);
