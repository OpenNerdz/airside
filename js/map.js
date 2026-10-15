// Moving map for a flight in the air, loaded only when one is on screen. Draws on
// a canvas: land, graticule, the planned great-circle route, the track actually
// flown, both airports and the aircraft at its live (or estimated) position.
import { distanceKm, num, hm, rel } from './format.js';

const RAD = Math.PI / 180;
const PLANE = new Path2D('M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z');
const STALE = 600; // seconds before a live fix stops counting as live

// Coastlines: 1:110m for whole routes (about 9 KB), 1:50m fetched only for the close-up view.
const land = { coarse: null, fine: null };
const loads = {};
const FILES = { coarse: 'land.json', fine: 'land-50m.json' };
const loadLand = which => loads[which] ??= fetch(new URL(`../data/${FILES[which]}`, import.meta.url))
  .then(r => r.json())
  .then(rings => land[which] = rings.map(flat => {
    // Rings are delta-encoded tenths of a degree: [lon0, lat0, dlon, dlat, ...].
    const pts = new Float32Array(flat.length);
    for (let i = 0, x = 0, y = 0; i < flat.length; i += 2) {
      pts[i] = (x += flat[i]) / 10;
      pts[i + 1] = (y += flat[i + 1]) / 10;
    }
    return pts;
  }))
  .catch(() => { loads[which] = null; });

// ---------- spherical helpers

const toVec = p => [Math.cos(p.lat * RAD) * Math.cos(p.lon * RAD), Math.cos(p.lat * RAD) * Math.sin(p.lon * RAD), Math.sin(p.lat * RAD)];
const fromVec = ([x, y, z]) => ({ lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD });

function along(a, b, t) {
  const va = toVec(a), vb = toVec(b);
  const d = Math.acos(Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])));
  if (d < 1e-9) return { ...a };
  const A = Math.sin((1 - t) * d) / Math.sin(d), B = Math.sin(t * d) / Math.sin(d);
  return fromVec(va.map((v, i) => A * v + B * vb[i]));
}

const greatCircle = (a, b, n = 72) => Array.from({ length: n + 1 }, (_, i) => along(a, b, i / n));

function bridgeGaps(pts) {
  const out = [];
  pts.forEach((p, i) => {
    const q = pts[i - 1];
    const d = q && distanceKm(q, p);
    if (d > 150) out.push(...greatCircle(q, p, Math.ceil(d / 100)).slice(1, -1));
    out.push(p);
  });
  return out;
}

function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

function ahead(p, deg, km) {
  const d = km / 6371, b = deg * RAD, φ = p.lat * RAD, λ = p.lon * RAD;
  const φ2 = Math.asin(Math.sin(φ) * Math.cos(d) + Math.cos(φ) * Math.sin(d) * Math.cos(b));
  return { lat: φ2 / RAD, lon: (λ + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ), Math.cos(d) - Math.sin(φ) * Math.sin(φ2))) / RAD };
}

const wrap = d => ((d + 540) % 360) - 180;

// Where the aircraft is: the live fix if it is fresh, otherwise a point on the
// great circle at the fraction of the trip elapsed (take-off to arrival estimate).
export function whereIs(f, live) {
  const pos = live?.pos;
  if (pos && pos.age < STALE && (Date.now() / 1000 - (live.at ?? 0) / 1000) < STALE) {
    return { lat: pos.lat, lon: pos.lon, track: pos.track, live: true };
  }
  const start = f.dep.actual ?? f.dep.est ?? f.dep.sched;
  const end = f.arr.est ?? f.arr.sched;
  const t = Math.min(0.98, Math.max(0.02, (Date.now() / 1000 - start) / (end - start)));
  const p = along(f.dep, f.arr, t);
  return { ...p, track: bearing(p, f.arr), live: false };
}

// Share of the route flown, by distance.
export function flownShare(f, live) {
  const p = whereIs(f, live);
  const a = distanceKm(f.dep, p) ?? 0, b = distanceKm(p, f.arr) ?? 0;
  return a + b ? a / (a + b) : 0;
}

// ---------- the map

export function createMap() {
  const el = document.createElement('div');
  el.className = 'map';
  el.innerHTML = `
    <div class="map-frame">
      <canvas role="img" aria-label="Map of the route showing where the aircraft is"></canvas>
      <p class="map-chip"><span class="dot"></span><span class="map-chip-text">Locating…</span></p>
      <div class="map-zoom" role="group" aria-label="Map view">
        <button type="button" data-zoom="route" aria-pressed="true">Route</button>
        <button type="button" data-zoom="plane" aria-pressed="false">Aircraft</button>
      </div>
      <p class="map-credit">Positions © <a href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> (ODbL) · Natural Earth</p>
    </div>
    <dl class="readout"></dl>`;
  const frame = el.querySelector('.map-frame');
  const canvas = el.querySelector('canvas');
  const chip = el.querySelector('.map-chip');
  const readout = el.querySelector('.readout');
  let f = null, live = null, mode = 'route';

  el.querySelector('.map-zoom').addEventListener('click', e => {
    const b = e.target.closest('button[data-zoom]');
    if (!b) return;
    mode = b.dataset.zoom;
    for (const x of el.querySelectorAll('[data-zoom]')) x.setAttribute('aria-pressed', x === b);
    if (mode === 'plane') loadLand('fine').then(() => draw());
    draw();
  });
  const ro = new ResizeObserver(() => draw());
  ro.observe(frame);
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', () => draw());
  loadLand('coarse').then(() => draw());

  function draw() {
    if (!f || !frame.isConnected) return;
    const w = frame.clientWidth, h = frame.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(devicePixelRatio || 1, 3);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(el);
    const c = name => css.getPropertyValue(name).trim();

    const plane = whereIs(f, live);
    const route = greatCircle(f.dep, f.arr);
    const mid = route[route.length >> 1];
    const k = Math.cos(mid.lat * RAD);

    // Equirectangular around the route's midpoint, longitudes unwrapped so a
    // route across the date line stays continuous.
    const unwrapLine = pts => {
      let prev = null;
      return pts.map(p => {
        const lon = prev == null ? mid.lon + wrap(p.lon - mid.lon) : prev + wrap(p.lon - prev);
        prev = lon;
        return { u: (lon - mid.lon) * k, v: -p.lat };
      });
    };
    const routeUV = unwrapLine(route);
    const trail = (live?.trail ?? []).map(([lat, lon]) => ({ lat, lon }));
    const [planeUV] = unwrapLine([plane]);

    // Frame the whole route, or a close-up box around the aircraft.
    const fitPts = mode === 'plane'
      ? [{ u: planeUV.u - 2.6, v: planeUV.v - 2.6 }, { u: planeUV.u + 2.6, v: planeUV.v + 2.6 }]
      : [...routeUV, planeUV];
    let minU = Math.min(...fitPts.map(p => p.u)), maxU = Math.max(...fitPts.map(p => p.u));
    let minV = Math.min(...fitPts.map(p => p.v)), maxV = Math.max(...fitPts.map(p => p.v));
    const minSpan = 3;
    if (maxU - minU < minSpan) { const m = (minU + maxU) / 2; minU = m - minSpan / 2; maxU = m + minSpan / 2; }
    if (maxV - minV < minSpan) { const m = (minV + maxV) / 2; minV = m - minSpan / 2; maxV = m + minSpan / 2; }
    const padX = 56, padTop = 56, padBottom = 40;
    const s = Math.min((w - 2 * padX) / (maxU - minU), (h - padTop - padBottom) / (maxV - minV));
    const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
    const X = u => (u - cu) * s + w / 2;
    const Y = v => (v - cv) * s + padTop + (h - padTop - padBottom) / 2;

    // Sea, graticule, land
    ctx.fillStyle = c('--sea');
    ctx.fillRect(0, 0, w, h);
    const lonAt = x => mid.lon + ((x - w / 2) / s + cu) / k;
    const latAt = y => -(((y - padTop - (h - padTop - padBottom) / 2) / s) + cv);
    const span = latAt(0) - latAt(h);
    const step = span > 60 ? 20 : span > 25 ? 10 : span > 8 ? 5 : 1;
    ctx.strokeStyle = c('--grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let lat = Math.ceil(latAt(h) / step) * step; lat <= latAt(0); lat += step) { const y = Y(-lat); ctx.moveTo(0, y); ctx.lineTo(w, y); }
    for (let lon = Math.ceil(lonAt(0) / step) * step; lon <= lonAt(w); lon += step) { const x = X((lon - mid.lon) * k); ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    ctx.stroke();

    const rings = mode === 'plane' ? land.fine ?? land.coarse : land.coarse;
    if (rings) {
      ctx.fillStyle = c('--land');
      ctx.beginPath();
      const uMin = (0 - w / 2) / s + cu, uMax = (w - w / 2) / s + cu;
      for (const ring of rings) {
        // Unwrap the ring, then draw whichever 360° copies fall in view.
        const us = new Float32Array(ring.length / 2), vs = new Float32Array(ring.length / 2);
        let prev = mid.lon + wrap(ring[0] - mid.lon), lo = Infinity, hi = -Infinity;
        for (let i = 0; i < ring.length; i += 2) {
          prev = i ? prev + wrap(ring[i] - ring[i - 2]) : prev;
          const u = (prev - mid.lon) * k;
          us[i / 2] = u; vs[i / 2] = -ring[i + 1];
          if (u < lo) lo = u; if (u > hi) hi = u;
        }
        for (const off of [-360 * k, 0, 360 * k]) {
          if (hi + off < uMin || lo + off > uMax) continue;
          ctx.moveTo(X(us[0] + off), Y(vs[0]));
          for (let i = 1; i < us.length; i++) ctx.lineTo(X(us[i] + off), Y(vs[i]));
          ctx.closePath();
        }
      }
      ctx.fill('evenodd');
    }

    // Planned route (dashed) and the track flown (solid)
    const line = pts => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(X(p.u), Y(p.v)) : ctx.moveTo(X(p.u), Y(p.v))); ctx.stroke(); };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = c('--muted');
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 6]);
    line(routeUV);
    ctx.setLineDash([]);
    const flown = unwrapLine(trail.length > 1 ? bridgeGaps([f.dep, ...trail, plane]) : greatCircle(f.dep, plane, 40));
    ctx.strokeStyle = c('--surface');
    ctx.lineWidth = 5;
    line(flown);
    ctx.strokeStyle = c('--ink');
    ctx.lineWidth = 2.6;
    line(flown);

    // Airports
    const label = (p, other, code) => {
      const x = X(p.u), y = Y(p.v);
      if (x < -10 || x > w + 10 || y < -10 || y > h + 10) return; // off-frame in the close-up
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = c('--surface');
      ctx.fill();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = c('--ink');
      ctx.stroke();
      // Put the code on the side away from the route; keep it fully inside the frame.
      const dx = X(other.u) - x, dy = Y(other.v) - y, len = Math.hypot(dx, dy) || 1;
      ctx.font = '700 15px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(code).width;
      let cx = x - dx / len * (14 + tw / 2), ly = y - dy / len * 14;
      cx = Math.min(w - 8 - tw / 2, Math.max(8 + tw / 2, cx));
      ly = Math.min(h - 26, Math.max(padTop - 14, ly));
      if (Math.abs(cx - x) < tw / 2 + 6 && Math.abs(ly - y) < 12) ly = y + (dy > 0 ? -16 : 16);
      ctx.textAlign = 'center';
      const lx = cx;
      ctx.lineWidth = 4;
      ctx.strokeStyle = c('--sea');
      ctx.strokeText(code, lx, ly);
      ctx.fillStyle = c('--ink');
      ctx.fillText(code, lx, ly);
    };
    label(routeUV[0], routeUV.at(-1), f.dep.iata);
    label(routeUV.at(-1), routeUV[0], f.arr.iata);

    // Aircraft, rotated to its screen heading
    const px = X(planeUV.u), py = Y(planeUV.v);
    const [nose] = unwrapLine([ahead(plane, plane.track ?? bearing(plane, f.arr), 20)]);
    const angle = Math.atan2(X(nose.u) - px, -(Y(nose.v) - py));
    ctx.beginPath();
    ctx.arc(px, py, 19, 0, Math.PI * 2);
    ctx.fillStyle = plane.live ? c('--halo') : 'transparent';
    ctx.fill();
    if (!plane.live) {
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = c('--muted');
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.scale(1.25, 1.25);
    ctx.translate(-12, -12);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = c('--surface');
    ctx.stroke(PLANE);
    ctx.fillStyle = c('--ink');
    ctx.fill(PLANE);
    ctx.restore();
  }

  function renderReadout() {
    const plane = whereIs(f, live);
    const pos = live?.pos;
    const toGo = distanceKm(plane, f.arr);
    const arrive = f.arr.est ?? f.arr.sched;
    chip.classList.toggle('is-live', plane.live);
    chip.querySelector('.map-chip-text').textContent = plane.live
      ? `Live${pos.age > 30 ? ` · ${rel(Date.now() / 1000 - pos.age)}` : ''}`
      : 'Estimated position';
    const items = [];
    if (plane.live) {
      items.push(['Altitude', pos.ground ? 'On the ground' : pos.alt != null ? `${num(Math.round(pos.alt / 100) * 100)} ft` : '–']);
      items.push(['Ground speed', pos.gs != null ? `${num(Math.round(pos.gs))} kn <small>${num(Math.round(pos.gs * 1.852))} km/h</small>` : '–']);
      if (pos.vrate != null && Math.abs(pos.vrate) >= 300) {
        items.push([pos.vrate > 0 ? 'Climbing' : 'Descending', `${num(Math.abs(Math.round(pos.vrate / 100) * 100))} <small>ft/min</small>`]);
      } else {
        items.push(['Heading', pos.track != null ? `${String(Math.round(pos.track) % 360).padStart(3, '0')}°` : '–']);
      }
    }
    items.push(['To go', toGo != null ? `${num(toGo)} km` : '–']);
    // With a live fix the readout is four flight numbers; the landing time is already on the arrival card.
    if (!plane.live) items.push(['Lands', `${hm(arrive, f.arr.tz)} <small>${rel(arrive)}</small>`]);
    readout.innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('') +
      (plane.live ? '' : `<p class="note">No live signal right now, which is common over oceans and remote areas. The position is worked out from the take-off time and the arrival estimate.</p>`);
  }

  return {
    el,
    attach(slot) { if (el.parentNode !== slot) slot.replaceChildren(el); draw(); },
    update(flight, data) { f = flight; live = data; renderReadout(); draw(); },
    destroy() { ro.disconnect(); el.remove(); },
  };
}
