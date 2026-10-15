import * as src from './fr24.js';
import { hm, dayKey, dayLabel, shortDay, longDate, dur, rel, lateness, offsetMin, distanceKm, num, nowS } from './format.js';
import { icon } from './icons.js';
import { fetchLive } from './adsb.js';

const view = document.getElementById('view');
const topSearch = document.getElementById('top-search');
const LATE = 15 * 60; // arrival within 15 minutes of schedule counts as on time
const FLIGHT_REFRESH = 60_000;
const BOARD_REFRESH = 120_000;
const LIVE_REFRESH = 15_000;   // aircraft position while the map is on screen
const TRAIL_REFRESH = 300_000; // full flown track, between position updates we extend it locally

let token = 0;     // bumps on every navigation so stale responses are dropped
let timer = 0;
let liveTimer = 0;
let pending = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clean = s => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const viewerTime = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('airside:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('airside:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------- navigation

function go(url, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  route();
  scrollTo(0, 0);
}

function route() {
  clearTimeout(timer);
  clearTimeout(liveTimer);
  pending = null;
  token++;
  const q = new URLSearchParams(location.search);
  const flight = clean(q.get('flight'));
  topSearch.hidden = !flight;
  if (flight) return flightView(flight, q.get('date'), clean(q.get('from')));
  const airport = clean(q.get('airport')) || store.get('airport', 'ALC');
  homeView(airport, q.get('board') === 'arrivals' ? 'arrivals' : 'departures');
}

function later(fn, ms) {
  clearTimeout(timer);
  timer = setTimeout(() => (document.hidden ? (pending = fn) : fn()), ms);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pending) { const fn = pending; pending = null; fn(); }
});

document.addEventListener('click', e => {
  const a = e.target.closest('a[data-nav]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});

document.addEventListener('submit', e => {
  const form = e.target;
  e.preventDefault();
  if (form.matches('.js-flight-search')) {
    const n = clean(form.elements.q.value);
    if (n.length < 3) { form.elements.q.setCustomValidity('Enter a flight number like FR2660'); form.reportValidity(); return; }
    form.elements.q.blur();
    go(`?flight=${n}`);
  } else if (form.matches('.js-airport')) {
    const code = clean(form.elements.ap.value);
    if (!/^[A-Z]{3}$/.test(code)) { form.elements.ap.setCustomValidity('Use a 3-letter airport code, like ALC'); form.reportValidity(); return; }
    go(`?airport=${code}&board=${form.dataset.mode}`);
  }
});

document.addEventListener('input', e => e.target.setCustomValidity?.(''));
addEventListener('popstate', route);

// ---------- status

const toneOf = d => d == null ? 'idle' : d < LATE ? 'ok' : d < 3600 ? 'warn' : 'bad';

function statusOf(f) {
  const now = nowS();
  const depBest = f.dep.actual ?? f.dep.est;
  const arrBest = f.arr.actual ?? f.arr.est;
  const depDelay = depBest && f.dep.sched ? depBest - f.dep.sched : null;
  const arrDelay = arrBest && f.arr.sched ? arrBest - f.arr.sched : null;
  const airline = f.airline?.name ?? 'the airline';

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
      detail: `Now expected to leave at ${hm(depBest, f.dep.tz)} local time, ${rel(depBest)}.`,
    };
  }
  return {
    tone: depBest ? 'ok' : 'idle',
    label: depBest ? 'On time' : 'Scheduled',
    detail: `Departs at ${hm(depBest ?? f.dep.sched, f.dep.tz)} local time, ${rel(depBest ?? f.dep.sched)}.`,
  };
}

// Short status for one row of an airport board.
function rowStatus(f, mode) {
  const dep = mode === 'departures';
  const s = statusOf(f);
  switch (f.state) {
    case 'canceled': return { ...s, text: 'Cancelled' };
    case 'diverted': return { ...s, text: 'Diverted' };
    case 'landed':
      return dep ? { ...s, text: `Departed ${hm(f.dep.actual, f.dep.tz)}`, past: true }
                 : { ...s, text: `Landed ${hm(f.arr.actual, f.arr.tz)}`, past: true };
    case 'airborne':
    case 'departed':
      return dep ? { ...s, text: `Departed ${hm(f.dep.actual, f.dep.tz)}`, past: true }
                 : { ...s, text: 'In the air' }; // the time column already shows the new arrival time
  }
  // The time column already shows the new departure time; say how late in words.
  if (s.label === 'Delayed') return { ...s, text: `Delayed ${dur(f.dep.est - f.dep.sched)}` };
  return { ...s, text: s.label };
}

const airborne = f => f.state === 'airborne' || f.state === 'departed';

const isFinal = f => f.state === 'canceled' || f.state === 'diverted' ||
  (f.state === 'landed' && f.arr.actual < nowS() - 1800) || f.dep.sched < nowS() - 86400;

// ---------- home: search + airport board

function remember(f) {
  const list = store.get('recent', []).filter(r => r.n !== f.number);
  list.unshift({ n: f.number, r: `${f.dep.iata} → ${f.arr.iata}` });
  store.set('recent', list.slice(0, 6));
}

function recentHTML() {
  const list = store.get('recent', []);
  const items = list.length ? list : [{ n: 'FR2660', r: 'Example' }];
  return `<div class="chips" aria-label="${list.length ? 'Recent flights' : 'Example flight'}">
    ${items.map(r => `<a class="chip" href="?flight=${esc(r.n)}" data-nav><b>${esc(r.n)}</b><span>${esc(r.r)}</span></a>`).join('')}
  </div>`;
}

function homeView(iata, mode) {
  const my = token;
  document.title = 'Airside';
  const other = mode === 'departures' ? 'arrivals' : 'departures';
  view.innerHTML = `
    <section class="hero">
      <h1 class="hero-title">Where’s my flight?</h1>
      <form class="search search-big js-flight-search" role="search">
        <label class="sr-only" for="q-home">Flight number</label>
        ${icon('search')}
        <input id="q-home" name="q" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="search" placeholder="Flight number">
        <button>Track</button>
      </form>
      ${recentHTML()}
    </section>
    <section class="board" aria-labelledby="board-title">
      <div class="board-head">
        <div>
          <h2 id="board-title" class="board-title">${icon(mode === 'departures' ? 'departure' : 'arrival', 'i board-icon')}<span id="board-name">${esc(iata)}</span></h2>
          <p class="board-sub" id="board-sub">Loading the live board…</p>
        </div>
        <form class="airport js-airport" data-mode="${mode}">
          <label for="ap">Airport</label>
          <input id="ap" name="ap" value="${esc(iata)}" maxlength="3" autocomplete="off" autocapitalize="characters" spellcheck="false">
          <button>Show</button>
        </form>
      </div>
      <div class="board-tools">
        <nav class="seg" aria-label="Board">
          <a href="?airport=${esc(iata)}&board=departures" data-nav ${mode === 'departures' ? 'aria-current="page"' : ''}>Departures</a>
          <a href="?airport=${esc(iata)}&board=arrivals" data-nav ${mode === 'arrivals' ? 'aria-current="page"' : ''}>Arrivals</a>
        </nav>
        <label class="sr-only" for="filter">Filter flights</label>
        <input id="filter" type="search" placeholder="Filter by city, flight or airline" autocomplete="off">
      </div>
      <div class="rows-head" aria-hidden="true"><span>Time</span><span>${mode === 'departures' ? 'To' : 'From'}</span><span>Flight</span><span>${mode === 'departures' ? 'Gate' : 'Belt'}</span><span>Status</span></div>
      <div class="rows" id="rows">${skeletonRows(8)}</div>
      <p class="empty" id="no-match" hidden>No flights match that filter.</p>
      <button class="more" id="more" hidden>Show later flights</button>
    </section>`;

  const rowsEl = document.getElementById('rows');
  const filter = document.getElementById('filter');
  const more = document.getElementById('more');
  let pages = 1, total = 1, apt = null, visible = 20;

  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = [...rowsEl.querySelectorAll('a.row')];
    let shown = 0;
    rows.forEach((r, i) => { r.hidden = q ? !r.dataset.q.includes(q) : i >= visible; shown += !r.hidden; });
    document.getElementById('no-match').hidden = !q || shown > 0;
    more.hidden = !!q || !rows.length || (rows.length <= visible && pages >= total);
  };
  filter.addEventListener('input', applyFilter);

  const load = async (fresh) => {
    let results;
    const from = nowS() - 45 * 60; // keep the last few departed flights in view
    try {
      results = [];
      for (let p = 1; p <= pages; p++) results.push(await src.board(iata, mode, { from, page: p, limit: 40, details: p === 1, fresh }));
    } catch (e) {
      if (my !== token) return;
      if (!apt) rowsEl.innerHTML = problemHTML(e);
      later(() => load(true), BOARD_REFRESH);
      return;
    }
    if (my !== token) return;
    if (!results[0]?.airport) {
      rowsEl.innerHTML = `<div class="problem"><p><b>No airport found for “${esc(iata)}”.</b></p><p>Check the 3-letter code on your ticket, for example ALC for Alicante or MAN for Manchester.</p></div>`;
      document.getElementById('board-sub').textContent = '';
      return;
    }
    apt = results[0].airport;
    total = results[0].pages;
    store.set('airport', iata);
    document.title = `${apt.city} ${mode} · Airside`;
    document.getElementById('board-name').textContent = apt.city || apt.name;
    document.getElementById('board-sub').innerHTML =
      `${esc(apt.name)} · ${esc(apt.iata)} · local time <b>${hm(nowS(), apt.tz)}</b> · updated ${viewerTime()}`;
    const rows = results.flatMap(r => r.rows);
    rowsEl.innerHTML = rows.length ? rows.map(f => rowHTML(f, mode)).join('')
      : `<p class="empty">No ${mode} listed for the next few hours.</p>`;
    applyFilter();
    later(() => load(true), BOARD_REFRESH);
  };

  more.addEventListener('click', async () => {
    visible += 20;
    if (rowsEl.querySelectorAll('a.row').length >= visible || pages >= total) return applyFilter();
    more.disabled = true;
    pages++;
    await load(false);
    more.disabled = false;
  });

  load(false);
}

function rowHTML(f, mode) {
  const dep = mode === 'departures';
  const here = dep ? f.dep : f.arr;
  const there = dep ? f.arr : f.dep;
  const s = rowStatus(f, mode);
  const best = here.actual ?? here.est;
  const moved = best && Math.abs(best - here.sched) >= 5 * 60 && !s.past;
  const q = [there.city, there.iata, f.number, f.airline?.name, ...f.codeshares].join(' ').toLowerCase();
  const gate = dep ? here.gate : here.belt;
  return `<a class="row tone-${s.tone}${s.past ? ' is-past' : ''}" href="?flight=${esc(f.number)}&date=${dayKey(f.dep.sched, f.dep.tz)}&from=${esc(f.dep.iata)}" data-nav data-q="${esc(q)}">
    <span class="r-time"><b${moved ? ' class="was"' : ''}>${hm(here.sched, here.tz)}</b>${moved ? `<i>${hm(best, here.tz)}</i>` : ''}</span>
    <span class="r-place"><b>${esc(there.city || there.name)}</b> <span class="code-sm">${esc(there.iata)}</span></span>
    <span class="r-flight"><b>${esc(f.number)}</b> ${esc(f.airline?.name ?? '')}</span>
    <span class="r-gate">${gate ? `<span class="mini-plate" title="${dep ? 'Gate' : 'Baggage belt'}">${esc(gate)}</span>` : ''}</span>
    <span class="r-status">${airborne(f) ? icon('cruise', 'i r-live') : '<span class="dot"></span>'}${esc(s.text)}</span>
  </a>`;
}

const skeletonRows = n => Array.from({ length: n }, () => '<div class="row is-loading"><span></span><span></span><span></span></div>').join('');

function problemHTML(e, retry = true) {
  const msg = e?.kind === 'blocked'
    ? 'The live data source is busy or refusing requests. This usually clears within a minute.'
    : e?.kind === 'network' ? 'Could not reach the live data source. Check your connection.'
    : esc(e?.message ?? 'Something went wrong while loading flight data.');
  return `<div class="problem"><p><b>Live data unavailable.</b> ${msg}</p>
    ${retry ? '<p>Airside retries automatically every minute.</p>' : ''}</div>`;
}

// ---------- flight page

const flightUrl = (f, flights) => {
  const date = dayKey(f.dep.sched, f.dep.tz);
  const legs = flights?.filter(g => dayKey(g.dep.sched, g.dep.tz) === date).length ?? 1;
  return `?flight=${encodeURIComponent(f.number)}&date=${date}${legs > 1 ? `&from=${f.dep.iata}` : ''}`;
};

function pick(flights, date, from) {
  if (date) {
    const m = flights.find(f => dayKey(f.dep.sched, f.dep.tz) === date && (!from || f.dep.iata === from));
    if (m) return m;
  }
  const now = nowS();
  return flights.find(f => (f.arr.actual ?? f.arr.est ?? f.arr.sched ?? f.dep.sched) > now - 3 * 3600) ?? flights.at(-1);
}

function flightView(number, date, from) {
  const my = token;
  document.title = `${number} · Airside`;
  topSearch.elements.q.value = number;
  view.innerHTML = `<div class="loading-flight"><p class="plate-num">${esc(number)}</p><p>Finding ${esc(number)}…</p></div>`;
  let shown = false;
  let current = null;            // the flight on screen
  let map = null, mapLib = null; // moving map, loaded on first need
  const live = { pos: null, trail: null, at: 0, trailAt: 0 };

  // Position polling runs on its own 15 s clock while the flight is in the air.
  const tick = async () => {
    if (my !== token || !current || !airborne(current)) return;
    if (!document.hidden) {
      const wantTrail = Date.now() - live.trailAt > TRAIL_REFRESH;
      try {
        const r = await fetchLive(current, { trail: wantTrail });
        if (my !== token) return;
        if (r.pos) {
          live.pos = r.pos;
          live.at = Date.now();
          if (wantTrail && r.trail) { live.trail = r.trail; live.trailAt = Date.now(); }
          else if (live.trail) live.trail.push([r.pos.lat, r.pos.lon, r.pos.alt]);
        }
      } catch { /* keep the last fix; the map falls back to an estimate when it goes stale */ }
      showLive();
    }
    liveTimer = setTimeout(tick, LIVE_REFRESH);
  };

  const showLive = () => {
    if (!mapLib || !current) return;
    map?.update(current, live);
    const track = view.querySelector('.route .track');
    if (track) track.style.setProperty('--p', mapLib.flownShare(current, live).toFixed(3));
  };

  const mountMap = async () => {
    const slot = view.querySelector('.map-slot');
    if (!slot) { map?.destroy(); map = null; return; }
    mapLib ??= await import('./map.js');
    if (my !== token) return;
    const fresh = !map;
    map ??= mapLib.createMap();
    map.attach(view.querySelector('.map-slot') ?? slot);
    showLive();
    if (fresh) { clearTimeout(liveTimer); tick(); }
  };

  const load = async (fresh) => {
    let flights;
    try {
      flights = await src.findFlight(number, { fresh });
    } catch (e) {
      if (my !== token) return;
      if (!shown) view.innerHTML = `<div class="loading-flight"><p class="plate-num">${esc(number)}</p>${problemHTML(e)}</div>`;
      later(() => load(true), FLIGHT_REFRESH);
      return;
    }
    if (my !== token) return;
    if (!flights.length) {
      view.innerHTML = `<div class="loading-flight"><p class="plate-num">${esc(number)}</p>
        <div class="problem"><p><b>No flight found for ${esc(number)}.</b></p>
        <p>Check the number on your booking: it is the airline’s two-letter code and up to four digits, like FR2660 or U22014.</p></div></div>`;
      return;
    }
    const f = pick(flights, date, from);
    if (current && (current.number !== f.number || current.dep.sched !== f.dep.sched)) Object.assign(live, { pos: null, trail: null, at: 0, trailAt: 0 });
    current = f;
    render(flights, f);
    remember(f);
    if (Math.abs(f.dep.sched - nowS()) < 36 * 3600) {
      try {
        merge(f, await src.gateInfo(f, { fresh }));
        if (my === token) render(flights, f);
      } catch { /* gates are a bonus */ }
    }
    if (my !== token) return;
    later(() => load(true), isFinal(f) ? 15 * 60_000 : FLIGHT_REFRESH);
  };

  const render = (flights, f) => {
    shown = true;
    const scroller = view.querySelector('.days');
    const keep = scroller?.scrollLeft;
    view.innerHTML = flightHTML(flights, f);
    document.title = `${f.number} · ${statusOf(f).label.replace(/&amp;/g, '&')} · Airside`;
    const days = view.querySelector('.days');
    const on = days?.querySelector('[aria-current]');
    if (days && on) days.scrollLeft = keep ?? on.offsetLeft - days.clientWidth / 2 + on.clientWidth / 2;
    mountMap();
  };

  load(false);
}

function merge(f, info) {
  for (const side of ['dep', 'arr']) {
    for (const [k, v] of Object.entries(info?.[side] ?? {})) if (v) f[side][k] = v;
  }
  for (const [k, v] of Object.entries(info?.aircraft ?? {})) if (v && !f.aircraft[k]) f.aircraft[k] = v;
  f.callsign ||= info?.callsign ?? '';
  f.airline ??= info?.airline ?? null;
}

// Phones get the system share sheet; elsewhere the link goes to the clipboard.
const canShare = typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches;

view.addEventListener('click', async e => {
  const btn = e.target.closest('#copy');
  if (!btn) return;
  const url = location.href;
  if (canShare) {
    try { await navigator.share({ title: document.title, url }); } catch { /* closed the sheet */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    btn.lastChild.textContent = ' Link copied';
  } catch {
    btn.lastChild.textContent = ' Copy from the address bar';
  }
  setTimeout(() => { if (btn.isConnected) btn.lastChild.textContent = ' Copy link'; }, 2400);
});

function flightHTML(flights, f) {
  const s = statusOf(f);
  return `
    <nav class="crumbs"><a href="?airport=${esc(f.dep.iata)}&board=departures" data-nav>${icon('back')}${esc(f.dep.city || f.dep.iata)} departures</a></nav>
    <header class="fl-head">
      <p class="plate-num">${esc(f.number)}</p>
      <div class="fl-title">
        <h1>${esc(f.dep.city)} to ${esc(f.arr.city)}</h1>
        <p class="sub">${esc(f.airline?.name ?? '')}</p>
      </div>
      <button class="ghost" id="copy" type="button">${icon('link')}<span> ${canShare ? 'Share' : 'Copy link'}</span></button>
    </header>
    ${daysHTML(flights, f)}
    <section class="status tone-${s.tone}" aria-live="polite">
      <p class="status-main"><span class="dot"></span><strong>${s.label}</strong>${s.note ? `<span class="status-note">${esc(s.note)}</span>` : ''}</p>
      <p class="status-detail">${s.detail}</p>
      <p class="status-meta">${longDate(f.dep.sched, f.dep.tz)} · updated ${viewerTime()}${isFinal(f) ? '' : ' · refreshes every minute'}</p>
    </section>
    <section class="route" aria-label="Route">
      <div class="route-bar">
        <p class="rb-end"><span class="code">${esc(f.dep.iata)}</span><span class="city">${esc(f.dep.city)}</span></p>
        ${trackHTML(f)}
        <p class="rb-end rb-arr"><span class="code">${esc(f.arr.iata)}</span><span class="city">${esc(f.arr.city)}</span></p>
      </div>
      ${airborne(f) ? '<div class="map-slot"></div>' : ''}
      <div class="ends">${endHTML(f, 'dep')}${endHTML(f, 'arr')}</div>
    </section>
    ${recordHTML(flights)}
    ${detailsHTML(flights, f)}`;
}

function daysHTML(flights, sel) {
  if (flights.length < 2) return '';
  return `<nav class="days" aria-label="Other dates">${flights.map(f => {
    const tone = f.dep.sched < nowS() ? statusOf(f).tone : null;
    const legs = flights.filter(g => dayKey(g.dep.sched, g.dep.tz) === dayKey(f.dep.sched, f.dep.tz)).length;
    return `<a class="day" href="${flightUrl(f, flights)}" data-nav ${f === sel ? 'aria-current="date"' : ''}>
      ${tone ? `<span class="dot tone-${tone}"></span>` : ''}${dayLabel(f.dep.sched, f.dep.tz)}${legs > 1 ? ` · ${esc(f.dep.iata)}–${esc(f.arr.iata)}` : ''}</a>`;
  }).join('')}</nav>`;
}

function progress(f) {
  if (f.state === 'landed') return 1;
  if (f.state !== 'airborne' && f.state !== 'departed') return 0;
  const a = f.dep.actual ?? f.dep.sched, b = f.arr.est ?? f.arr.sched;
  return Math.min(0.96, Math.max(0.04, (nowS() - a) / (b - a)));
}

function trackHTML(f) {
  const p = progress(f);
  const km = distanceKm(f.dep, f.arr);
  return `<div class="track" style="--p:${p.toFixed(3)}">
    <div class="track-line"><span class="track-fill"></span>${icon('cruise', 'track-plane')}</div>
    <p class="track-meta">${f.arr.sched && f.dep.sched ? dur(f.arr.sched - f.dep.sched) : ''}${km ? ` · ${num(km)} km` : ''}</p>
  </div>`;
}

const plate = (label, v) => `<div class="plate${v ? '' : ' is-empty'}"><span>${label}</span><b>${v ? esc(v) : '–'}</b></div>`;

function endHTML(f, side) {
  const a = f[side];
  const dep = side === 'dep';
  const best = a.actual ?? a.est;
  const moved = best && a.sched && Math.abs(best - a.sched) >= 60;
  const tone = best ? toneOf(best - a.sched) : 'idle';
  const gateLabel = a.gate && /^[A-Z]$/.test(a.gate) ? 'Gate area' : 'Gate';
  return `<div class="end">
    <p class="end-label">${icon(dep ? 'departure' : 'arrival')}${dep ? 'Departure' : 'Arrival'} · ${esc(a.name || a.iata)}</p>
    <dl class="times">
      <div><dt>Scheduled</dt><dd${moved ? ' class="was"' : ''}>${hm(a.sched, a.tz)}</dd></div>
      <div><dt>${a.actual ? (dep ? 'Departed' : 'Landed') : 'Expected'}</dt><dd class="t-${best ? tone : 'idle'}">${best ? hm(best, a.tz) : '–'}</dd></div>
    </dl>
    <p class="tz">Local time (${esc(a.tzAbbr || a.tz)}), ${longDate(a.sched, a.tz)}</p>
    <div class="plates">
      ${plate('Terminal', a.terminal)}${plate(gateLabel, a.gate)}${dep ? plate('Check-in', a.desk) : plate('Bag belt', a.belt)}
    </div>
  </div>`;
}

// Secondary information lives in folds. Their open state survives the
// once-a-minute refresh and is remembered between visits.
const openFolds = new Set(store.get('folds', []));
view.addEventListener('toggle', e => {
  const d = e.target;
  if (!d.matches?.('details.fold')) return;
  if (d.open) openFolds.add(d.id); else openFolds.delete(d.id);
  store.set('folds', [...openFolds]);
}, true);

const fold = (id, title, hint, body) => `<details class="fold" id="${id}"${openFolds.has(id) ? ' open' : ''}>
  <summary><span class="fold-title">${title}</span>${hint ? `<span class="fold-hint">${hint}</span>` : ''}</summary>
  <div class="fold-body">${body}</div>
</details>`;

function recordHTML(flights) {
  const now = nowS();
  const done = flights.filter(f => (f.state === 'landed' && f.arr.actual) ||
    ((f.state === 'canceled' || f.state === 'diverted') && f.dep.sched < now));
  const past = flights.filter(f => f.dep.sched < now - 3600 && f.state !== 'scheduled').reverse();
  if (!past.length) return '';
  const flown = done.filter(f => f.arr.actual);
  const delays = flown.map(f => (f.arr.actual - f.arr.sched) / 60);
  const onTime = delays.filter(d => d < LATE / 60).length;
  const sorted = [...delays].sort((a, b) => a - b);
  const median = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : 0;
  const pct = done.length ? Math.round(onTime / done.length * 100) : null;
  const usually = median > 0 ? `usually ${median} min late` : median < 0 ? `usually ${-median} min early` : 'usually on schedule';
  const hint = done.length >= 2 ? `${pct}% on time · ${usually}` : `${past.length} recent flight${past.length > 1 ? 's' : ''}`;
  return fold('record', 'Punctuality', hint, `${done.length >= 2 ? chartHTML(done, delays, onTime, median, pct) : ''}
    <h3>Recent flights</h3>
    ${historyHTML(flights, past)}`);
}

function chartHTML(done, delays, onTime, median, pct) {
  const lost = done.length - delays.length;
  const avgLate = delays.length ? Math.round(delays.reduce((t, d) => t + Math.max(0, d), 0) / delays.length) : 0;
  const top = Math.max(30, Math.ceil(Math.max(0, ...delays) / 15) * 15);
  const bottom = Math.max(15, Math.ceil(Math.max(0, ...delays.map(d => -d)) / 15) * 15);
  const span = top + bottom;
  const y = v => ((top - v) / span * 100).toFixed(2); // % from top
  const bars = done.map(f => {
    if (!f.arr.actual) {
      return `<div class="col"><span class="x" style="top:${y(0)}%">×</span><span class="lbl down" style="top:${y(0)}%">${f.state === 'canceled' ? 'Cncl' : 'Div'}</span></div>`;
    }
    const d = Math.round((f.arr.actual - f.arr.sched) / 60);
    const hi = Math.max(d, 0), lo = Math.min(d, 0);
    const label = d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0';
    return `<div class="col" title="${shortDay(f.dep.sched, f.dep.tz)}: ${lateness(d * 60)}">
      <span class="bar tone-${toneOf(d * 60)}" style="top:${y(hi)}%;height:${Math.max(0.8, (hi - lo) / span * 100).toFixed(2)}%"></span>
      <span class="lbl ${d >= 0 ? 'up' : 'down'}" style="top:${y(d >= 0 ? hi : lo)}%">${label}</span>
    </div>`;
  }).join('');
  return `<div class="stats">
      <p><b>${pct}%</b><span>on time, ${onTime} of ${done.length}</span></p>
      <p><b>${median > 0 ? '+' : median < 0 ? '−' : ''}${Math.abs(median)} min</b><span>typical arrival</span></p>
      <p><b>${avgLate} min</b><span>average delay</span></p>
      ${lost ? `<p><b>${lost}</b><span>cancelled or diverted</span></p>` : ''}
    </div>
    <figure class="chart">
      <div class="chart-plot" role="img" aria-label="Arrival minutes late or early for each of the last ${done.length} flights">
        <span class="rule zero" style="top:${y(0)}%"></span>
        <span class="rule limit" style="top:${y(15)}%"><em>15 min late</em></span>
        ${bars}
      </div>
      <div class="chart-days">${done.map(f => `<span>${shortDay(f.dep.sched, f.dep.tz).replace(' ', '<br>')}</span>`).join('')}</div>
      <figcaption>Minutes early or late at arrival. A flight counts as on time if it lands less than 15 minutes after schedule.</figcaption>
    </figure>`;
}

function historyHTML(flights, past) {
  return `<div class="table-wrap"><table class="hist">
      <thead><tr><th scope="col">Date</th><th scope="col">Departed</th><th scope="col">Landed</th><th scope="col" class="opt">In the air</th><th scope="col" class="opt">Aircraft</th><th scope="col">Arrival</th></tr></thead>
      <tbody>${past.map(f => {
        const s = statusOf(f);
        const d = f.arr.actual ? f.arr.actual - f.arr.sched : null;
        return `<tr>
          <th scope="row"><a href="${flightUrl(f, flights)}" data-nav>${shortDay(f.dep.sched, f.dep.tz)}</a></th>
          <td>${hm(f.dep.actual, f.dep.tz)}</td>
          <td>${hm(f.arr.actual, f.arr.tz)}</td>
          <td class="opt">${f.dep.actual && f.arr.actual ? dur(f.arr.actual - f.dep.actual) : '–'}</td>
          <td class="opt">${esc(f.aircraft.reg || '–')}</td>
          <td><span class="pill tone-${s.tone}">${d != null ? esc(lateness(d)) : esc(s.label)}</span></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

function detailsHTML(flights, f) {
  const flown = flights.filter(x => x.dep.actual && x.arr.actual);
  const avg = flown.length ? flown.reduce((t, x) => t + x.arr.actual - x.dep.actual, 0) / flown.length : null;
  const diff = (offsetMin(f.arr.tz, f.arr.sched) - offsetMin(f.dep.tz, f.dep.sched)) / 60;
  const km = distanceKm(f.dep, f.arr);
  const model = f.aircraft.model || f.aircraft.code;
  const codes = a => [a.iata, a.icao].filter(Boolean).map(esc).join(' · ');
  const rows = [
    ['Aircraft', model ? `${esc(model)}${f.aircraft.model && f.aircraft.code ? ` <small>${esc(f.aircraft.code)}</small>` : ''}` : 'Not assigned yet'],
    ['Registration', f.aircraft.reg ? esc(f.aircraft.reg) : 'Not assigned yet'],
    f.callsign && ['Callsign', esc(f.callsign)],
    f.codeshares.length && ['Also sold as', esc(f.codeshares.join(', '))],
    ['From', `${esc(f.dep.name)} <small>${codes(f.dep)}</small>`],
    ['To', `${esc(f.arr.name)} <small>${codes(f.arr)}</small>`],
    km && ['Distance', `${num(km)} km <small>${num(Math.round(km / 1.852))} nm direct</small>`],
    ['Scheduled gate to gate', dur(f.arr.sched - f.dep.sched)],
    avg && ['Usual time in the air', `${dur(avg)} <small>over ${flown.length} flights</small>`],
    ['Time difference', diff === 0 ? 'Same time zone' : `${esc(f.arr.city)} is ${dur(Math.abs(diff) * 3600)} ${diff > 0 ? 'ahead' : 'behind'}`],
  ].filter(Boolean);
  const hint = [model, f.aircraft.reg].filter(Boolean).map(esc).join(' · ');
  return fold('details', 'Flight details', hint, `<dl class="kv">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <p class="source">Live data from Flightradar24, last checked at ${viewerTime()}.</p>`);
}

route();
