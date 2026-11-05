// The pause screen's view line and its link, and the E-hints switch.
//
//   node tests/view.mjs        # needs `npm start` running on :5173
//
// The link is read off the page as Copy would write it, opened in a fresh
// page, and the view that page opens on must be the one it was copied from —
// walking and in the fly-over. The switch must keep the hints off the screen
// while E still finds what it is pointed at.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const errs = [];
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

async function open(url) {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.game?.session, { timeout: 90000 });
  return page;
}

const near = (a, b, eps) => Math.abs(a - b) <= eps;
const same = (a, b) => near(a.x, b.x, 0.02) && near(a.y, b.y, 0.02) && near(a.z, b.z, 0.02)
  && near(a.yaw, b.yaw, 0.1) && near(a.pitch, b.pitch, 0.1);

for (const mode of ['shooter', 'flyover']) {
  const page = await open('http://localhost:5173/' + (mode === 'flyover' ? '?mode=flyover' : ''));
  // Somewhere that is not the spawn: in the fly-over, up in the air.
  const before = await page.evaluate(async (mode) => {
    const g = window.game, s = g.session;
    if (mode === 'flyover') { s.flyer.pos.set(s.flyer.pos.x + 3, s.flyer.pos.y + 4.37, s.flyer.pos.z - 2); }
    else { g.player.teleport(g.player.pos.x, g.player.pos.y, g.player.pos.z); }
    s.body.yaw = 123.4; s.body.pitch = -17.3;
    await new Promise((r) => setTimeout(r, 1500));
    return s.view();
  }, mode);
  const text = await page.textContent('#viewText');
  check(text.includes(before.x.toFixed(2)) && text.includes('123.4°') && text.includes('-17.3°'), `${mode}: the view line reads ${text}`);
  // What Copy writes, from the same function.
  await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await page.$eval('#viewCopy', (b) => b.click());
  const url = await page.evaluate(() => window.__copied);
  check(!!url && /[?&]at=/.test(url) && /[?&]look=/.test(url) && (mode === 'shooter' || /mode=flyover/.test(url)), `${mode}: Copy link wrote ${url}`);
  await page.close();

  const again = await open(url);
  const after = await again.evaluate(() => window.game.session.view());
  const want = mode === 'flyover' ? before : { ...before, y: after.y };   // the walker may settle onto the floor
  check(same(after, want), `${mode}: the link opens on the same view (${JSON.stringify(after)})`);
  await again.close();
}

// The switch: off, no hint is drawn even with one in reach; E still has a target.
{
  const page = await open('http://localhost:5173/');
  // Props land after the map is walkable.
  await page.waitForFunction(() => window.game.actions.items.some((i) => i.anchor), { timeout: 120000 });
  const r = await page.evaluate(async () => {
    const g = window.game;
    const it = g.actions.items.find((i) => i.anchor);
    if (!it) return null;
    g.player.teleport(it.anchor.x + 1, it.anchor.y, it.anchor.z);
    g.actions.update(true);
    const on = [...document.querySelectorAll('.action-hint')].filter((h) => h.style.display !== 'none').length;
    const cb = document.getElementById('hintsToggle');
    cb.click();
    // What the loop now hands it: live && checked.
    g.actions.update(true && cb.checked);
    const off = [...document.querySelectorAll('.action-hint')].filter((h) => h.style.display !== 'none').length;
    return { on, off, active: !!g.actions.active, stored: localStorage.getItem('pavilion.hints') };
  });
  if (!r) check(false, 'no prop with an action to stand by');
  else {
    check(r.on > 0, `hints on: ${r.on} drawn`);
    check(r.off === 0 && r.active, `hints off: ${r.off} drawn, E still has a target: ${r.active}`);
    check(r.stored === 'off', 'the choice is remembered');
  }
  await page.reload({ timeout: 120000 });
  await page.waitForFunction(() => window.game?.session, { timeout: 90000 });
  check(!(await page.isChecked('#hintsToggle')), 'still off after a reload');
  await page.close();
}

check(!errs.length, `no page errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
await browser.close();
process.exit(failed ? 1 : 0);
