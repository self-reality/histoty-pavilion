import { chromium } from 'playwright';
const browser = await chromium.launch({
  args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.player, { timeout: 25000 });

// Drive it: mark started, walk forward a bit under the real render loop so the
// camera-smoothing path runs, then grab a frame from inside the map.
await page.evaluate(async () => {
  const g = window.game;
  g.player.teleport(g.player.spawn.x, g.player.spawn.y, g.player.spawn.z);
  // face into the level and step forward for ~1s of real frames
  g.player.yaw = 40;
  let frames = 0;
  await new Promise(res => {
    const onUpd = (dt) => {
      g.player.update(Math.min(dt,0.05), { forward: 1, strafe: 0, jump: false, sprint: false });
      if (++frames > 60) { g.app.off('update', onUpd); res(); }
    };
    g.app.on('update', onUpd);
  });
});
await page.waitForTimeout(200);
await page.screenshot({ path: './tests/_ingame.png' });
console.log('camera world Y:', (await page.evaluate(() => window.game.camera.getPosition().y)).toFixed(3));
console.log('pageerrors:', errs.length, errs.slice(0,3));
await browser.close();
