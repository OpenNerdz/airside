// Screenshot harness: node tools/shot.mjs [baseUrl]
// Uses the phone's system Chromium through playwright-core (borrowed from another project's node_modules).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_CORE ?? `${process.env.HOME}/projects/weather-showcase/node_modules/playwright-core`;
const { chromium } = require(pwPath);

const base = process.argv[2] ?? 'http://127.0.0.1:8787/';
const out = new URL('../.work/', import.meta.url).pathname;
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const shots = (process.env.SHOTS ?? 'home-phone-light,flight-phone-light,flight-desk-dark,home-desk-dark').split(',');

const browser = await chromium.launch({
  executablePath: '/data/data/com.termux/files/usr/bin/chromium-browser',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
for (const name of shots) {
  const [page_, size, theme] = name.split('-');
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: size === 'phone' ? { width: 400, height: 860 } : { width: 1280, height: 900 },
    deviceScaleFactor: size === 'phone' ? 2 : 1,
    colorScheme: theme,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', e => errors.push(String(e)));
  const url = page_ === 'flight' ? `${base}?flight=${process.env.FLIGHT ?? 'FR2660'}`
    : `${base}?airport=${process.env.AIRPORT ?? 'ALC'}&board=${process.env.BOARD ?? 'departures'}`;
  const reqs = [];
  page.on('requestfinished', async r => reqs.push({ url: r.url(), bytes: (await r.sizes()).responseBodySize }));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  if (process.env.OPEN) for (const s of await page.$$('details.fold > summary')) await s.click();
  await page.waitForTimeout(800);
  const own = reqs.filter(r => !r.url.includes('flightradar24'));
  const feed = reqs.filter(r => r.url.includes('flightradar24'));
  const kb = list => (list.reduce((t, r) => t + r.bytes, 0) / 1024).toFixed(1);
  console.log(`${name}: site ${own.length} requests ${kb(own)} KB, feed ${feed.length} requests ${kb(feed)} KB (as transferred)`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await page.screenshot({ path: `${out}${process.env.TAG ?? ''}${name}.png`, fullPage: true });
  console.log(name, 'overflow', overflow, errors.length ? 'ERRORS ' + errors.join(' | ') : 'no errors');
  await ctx.close();
}
await browser.close();
