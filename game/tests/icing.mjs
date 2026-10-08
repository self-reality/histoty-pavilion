// The icing (src/icing.mjs): balls scattered over the white ground, worked out
// in each browser from a seed. Two browsers standing in different places must
// come to the same balls wherever both can see, every ball must lie on ground
// it could be put on, and the scattering must be what the manifest asks for.
import { chromium } from 'playwright';
import { manifest } from '../scene.manifest.mjs';

const { apart, radius, varies, range, colors } = manifest.icing;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

// One player: a browser of its own, standing at `at` on the ground.
async function player(at) {
  const page = await (await browser.newContext({ viewport: { width: 600, height: 400 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:5173/?at=${at}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.game?.icing?.ground.size > 0, { timeout: 40000 });
  return page.evaluate(([x, y, z]) => {
    const g = window.game;
    // The ground is a prop, and lands after the player: stand on it now.
    g.player.teleport(x, y, z);
    g.icing.update(g.camera.getPosition());
    const balls = g.icing.balls();
    const view = g.camera.getPosition();
    return {
      balls,
      view: [view.x, view.z],
      drawn: g.icing.entity.render.meshInstances.reduce((n, mi) => n + (mi.visible ? mi.instancingCount : 0), 0),
      // What the collider says is under each ball: the ground is solid, the balls are not.
      under: balls.map((b) => g.collider.groundBelow(b.x, b.z, b.y + 0.5, 1)?.y ?? null),
      tris: g.collider.tris.length,
    };
  }, at.split(',').map(Number)).then((r) => ({ ...r, errors }));
}

// Outside the map on the plane, and 60 m along it: most of what one sees the other does.
const [a, b] = await Promise.all([player('62,10.6,-28'), player('62,10.6,32')]);
await browser.close();

const fails = [];
const want = (ok, what) => { if (!ok) fails.push(what); };
const cell = (p) => `${Math.floor(p.x / apart)},${Math.floor(p.z / apart)}`;

for (const [who, r] of [['first', a], ['second', b]]) {
  want(!r.errors.length, `the ${who} player's page threw: ${r.errors[0]}`);
  want(r.balls.length > 500, `the ${who} player sees ${r.balls.length} balls`);
  want(r.drawn === r.balls.length, `the ${who} player draws ${r.drawn} balls of ${r.balls.length}`);
  want(new Set(r.balls.map(cell)).size === r.balls.length, 'a square has two balls');
  const off = r.balls.filter((p, n) => r.under[n] === null || Math.abs(r.under[n] - p.y) > 1e-3);
  want(!off.length, `${off.length} of the ${who} player's balls are not on the ground, the first at ${JSON.stringify(off[0])}`);
  const size = r.balls.map((p) => p.radius);
  want(Math.min(...size) >= radius * (1 - varies) && Math.max(...size) <= radius * (1 + varies),
    `radii run from ${Math.min(...size)} to ${Math.max(...size)}`);
  want(Math.max(...size) - Math.min(...size) > radius * varies, 'the balls are all but one size');
  want(new Set(r.balls.map((p) => p.colour)).size === colors.length, 'not every colour is used');
  const far = Math.max(...r.balls.map((p) => Math.hypot(p.x - r.view[0], p.z - r.view[1])));
  want(far < range + apart * 8, `a ball is drawn ${far.toFixed(0)} m away`);
}

// Where both look, both see the same: the ball of a square is the same ball.
const mine = new Map(a.balls.map((p) => [cell(p), p]));
const both = b.balls.filter((p) => mine.has(cell(p)));
want(both.length > 300, `only ${both.length} squares are seen by both`);
const differ = both.filter((p) => JSON.stringify(p) !== JSON.stringify(mine.get(cell(p))));
want(!differ.length, `${differ.length} balls differ between the two players`);

// One to a square on open ground: this far out there are no holes within 40 m.
const nearby = a.balls.filter((p) => Math.abs(p.x - 100) < 20 && Math.abs(p.z + 30) < 20).length;
want(nearby === (40 / apart) ** 2, `${nearby} balls in a 40 m square of open ground, not ${(40 / apart) ** 2}`);

console.log(`first sees ${a.balls.length} balls, second ${b.balls.length}; ${both.length} seen by both, ${differ.length} differ`);
console.log(`collider: ${a.tris.toLocaleString()} triangles`);
for (const f of fails) console.log('FAIL', f);
console.log(fails.length ? 'ICING: FAIL' : 'ICING: PASS');
process.exit(fails.length ? 1 : 0);
