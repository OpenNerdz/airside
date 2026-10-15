# Airside

Live flight status and airport boards, without ads, trackers or a framework.
Live at https://opennerdz.github.io/airside/ (GitHub Pages, deployed from `main`).

Plain HTML, CSS and ES modules with no build step. A flight page costs about 60 KB of site
files on first visit (roughly 45 KB of that is fonts, cached afterwards) plus about 20 KB of live
data. There are no third-party requests other than the data feed.

- Fonts are self-hosted and subset to Latin-1 (Atkinson Hyperlegible Next as one variable file
  limited to weights 400–700, Barlow Semi Condensed 600 and 700). Licences are in `fonts/`.
- The flight page shows status, times and gates up front. Punctuality, recent flights and full
  flight details sit in folds that remember whether you left them open.
- Gate lookups are skipped for flights more than 36 hours away, because boards don't carry them.
- Installable to the home screen (`manifest.webmanifest`); no service worker.

- `?flight=FR2660` shows one flight: live status, gate, terminal, check-in and belt,
  progress while airborne, every known day for that number, punctuality chart and recent history.
- `?airport=ALC&board=departures` (or `arrivals`) shows a live airport board with a filter.
- All times are shown in each airport's local time zone.

## Live tracking

While a flight is in the air, its route card grows a moving map: land, the planned great-circle
route, the track actually flown, and the aircraft at its real position and heading, with altitude,
ground speed, heading or climb rate, and distance to go. Board rows for airborne flights carry an
aircraft icon. The map code (`js/map.js`) and outline data (`data/land.json`, Natural Earth 1:110m,
about 9 KB compressed) only load when a map is shown.

Positions come from [adsb.lol](https://adsb.lol), an open ADS-B network (ODbL). adsb.lol doesn't let
browsers call it directly, so `netlify/functions/live.mjs` relays a trimmed reply (position plus a
decimated track, about 3 KB) from https://airside-live.netlify.app/api/live. The relay only answers
this site's origins and its replies are CDN-cached for a few seconds, so many viewers of one flight
cost one upstream call. Where there's no coverage (mid-ocean, parts of Asia and Africa) the map shows
an estimated position from the take-off time and the arrival estimate, and says so.

Deploy the relay with `./nl deploy --prod --no-build --dir netlify/public --functions netlify/functions`.

## Run it

```sh
python3 -m http.server 8787   # then open http://127.0.0.1:8787
```

Any static host works (GitHub Pages, Vercel, Netlify). There is no server code.

## Data

`js/fr24.js` is the only file that knows where data comes from. It calls the public JSON
endpoints that flightradar24.com uses for its own pages, straight from the visitor's browser
(they send `Access-Control-Allow-Origin: *`). They are unofficial, can change without notice,
and Flightradar24's terms don't allow commercial use. For a public or commercial site, write a
module with the same three exports (`findFlight`, `board`, `gateInfo`) against a licensed API
such as AeroDataBox, FlightAware AeroAPI or Cirium, called through your own server so the key stays secret.

## Checks

```sh
node tools/check-source.mjs FR2660   # adapter against the live feed
node tools/shot.mjs                  # phone and desktop screenshots into .work/ (system Chromium)
```

The aircraft icon is Material Icons "flight" (Apache 2.0).
