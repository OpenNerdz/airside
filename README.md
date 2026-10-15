# Airside

Live flight status and airport boards, without ads, trackers or a framework.
Plain HTML, CSS and ES modules: about 45 KB before fonts, no build step.

- `?flight=FR2660` shows one flight: live status, gate, terminal, check-in and belt,
  progress while airborne, every known day for that number, punctuality chart and recent history.
- `?airport=ALC&board=departures` (or `arrivals`) shows a live airport board with a filter.
- All times are shown in each airport's local time zone.

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
