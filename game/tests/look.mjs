import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.player, { timeout: 25000 });
await page.evaluate(() => { document.getElementById('overlay').style.display = 'none'; });

// Inspect viewmodel presence.
const vmInfo = await page.evaluate(() => {
  const g = window.game;
  const vm = g.camera.findByName('viewmodel');
  const renders = vm ? vm.findComponents('render').length : 0;
  return { hasVm: !!vm, parts: renders, camPos: g.camera.getPosition().toString(), spawn: g.player.spawn };
});
console.log('viewmodel:', JSON.stringify(vmInfo));

// Sweep yaw and screenshot each angle.
const yaws = [0, 90, 180, 270];
for (const y of yaws) {
  await page.evaluate((yaw) => { window.game.player.yaw = yaw; window.game.player.pitch = -3; }, y);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `/tmp/dust2_yaw_${y}.png` });
}
console.log('errors:', errors.length, errors.slice(0, 5));
await browser.close();
