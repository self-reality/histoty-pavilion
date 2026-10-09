// A script's menu: object.menu puts a question on the pause screen, and the
// button pressed is the script's answer.
//
//   node tests/menu.mjs        # needs `npm start` running on :5173
//                              # (GAME=http://localhost:5183 for another port)
//
// The salt van (assets/salt_van/, placed as salt_01) asks before it sends the
// player off to the Salt pavilion. What is checked, through the real key:
//
//   - E by the van brings up the overlay with the script's text and its two
//     buttons, and nothing else of the pause screen
//   - BACK takes it down, the game is back, the run is over and nothing opened
//   - Esc leaves it unanswered: nothing opened, the run over
//   - ACCEPT opens the address the script names
//   - while the question is up the key is not offered again
//
// Headless Chromium has no pointer lock, so the page is told it has one — the
// same trick as tests/actions.mjs.
import { chromium } from 'playwright';

const GAME = process.env.GAME ?? 'http://localhost:5173';
const VAN = 'salt_01';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${GAME}/`, { waitUntil: 'load' });
await page.waitForFunction((VAN) => window.game?.actions?.items.some((i) => i.name === VAN), VAN, { timeout: 90000 });

await page.evaluate(async (VAN) => {
  const g = window.game;
  const { page: runtime } = await import('/src/script.mjs');
  const item = g.actions.items.find((i) => i.name === VAN);
  const overlay = document.getElementById('overlay');
  const shown = (el) => getComputedStyle(el).display !== 'none';
  window.T = {
    opened: [],
    // Beside the van, looking at it, with the mouse "taken".
    stand() {
      g.actions.measure(item);
      const x = item.max.x + 1.5, y = item.min.y + 0.1, z = item.anchor.z;
      g.player.teleport(x, y, z);
      g.player.yaw = 90; g.player.pitch = 0;
      g.player.entity.setPosition(x, y, z);
      g.player.entity.setEulerAngles(0, 90, 0);
      g.camera.setLocalEulerAngles(0, 0, 0);
      g.actions.update(true);
    },
    read: () => ({
      up: !overlay.classList.contains('hidden'),
      asking: overlay.classList.contains('asking'),
      text: document.getElementById('askText').textContent,
      buttons: [...document.querySelectorAll('#askButtons button')].map((b) => b.textContent),
      rest: [...overlay.children].filter((el) => el.id !== 'ask' && shown(el)).map((el) => el.id),
      running: !!item.script.actions[0].run,
      offered: g.actions.offers.map((o) => o.item.name),
      opened: [...T.opened],
    }),
  };
  runtime.open = (url, newTab) => T.opened.push([url, newTab]);   // stay on the page
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => document.getElementById('app') });
  document.dispatchEvent(new Event('pointerlockchange'));
}, VAN);

const press = async () => { await page.evaluate(() => T.stand()); await page.keyboard.press('e'); await page.waitForTimeout(100); };
const read = () => page.evaluate(() => { window.game.actions.update(true); return T.read(); });
const r = {};

r.before = await page.evaluate(() => { T.stand(); return T.read(); });
await press();
r.asked = await read();
await page.keyboard.press('e');                      // a second press, with the question up
r.again = await read();
await page.click('#askButtons button:nth-child(2)');
await page.waitForTimeout(100);
r.back = await read();

await press();
r.askedTwice = await read();
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
r.escaped = await read();

await press();
await page.click('#askButtons button:nth-child(1)');
await page.waitForTimeout(100);
r.accepted = await read();

await page.screenshot({ path: process.env.SHOT ?? '/dev/null' }).catch(() => {});
await browser.close();
console.log(JSON.stringify(r, null, 2));

const problems = [];
const want = (ok, what) => { if (!ok) problems.push(what); };
if (errs.length) problems.push(`page errors: ${errs.join(' | ')}`);
want(!r.before.up && r.before.offered.includes(VAN), `by the van, playing, the key is not on offer: ${JSON.stringify(r.before)}`);
want(r.asked.up && r.asked.asking, 'E did not bring the question up');
want(/Salt pavilion/.test(r.asked.text) && r.asked.buttons.join() === 'ACCEPT,BACK', `the question is not the script's: ${r.asked.text} [${r.asked.buttons}]`);
want(r.asked.rest.length === 0, `the pause screen shows through the question: ${r.asked.rest}`);
want(r.asked.running && !r.asked.offered.includes(VAN), 'the key is offered again while the question is up');
want(r.again.asking && r.again.opened.length === 0, 'a second press did something to the question');
want(!r.back.up && !r.back.asking && !r.back.running && r.back.opened.length === 0, `BACK: ${JSON.stringify(r.back)}`);
want(r.back.offered.includes(VAN), 'after BACK the key is not on offer again');
want(r.askedTwice.asking, 'the van does not ask a second time');
want(!r.escaped.asking && !r.escaped.running && r.escaped.opened.length === 0, `Esc: ${JSON.stringify(r.escaped)}`);
want(!r.accepted.asking && r.accepted.opened.length === 1 && r.accepted.opened[0][0] === 'https://salt.singularitymuseum.com/' && r.accepted.opened[0][1] === false,
  `ACCEPT opened ${JSON.stringify(r.accepted.opened)}`);

if (problems.length) { console.log('\nFAIL'); for (const p of problems) console.log('  - ' + p); process.exit(1); }
console.log('\nmenu ok — the van asks on the pause screen, and only ACCEPT leaves');
