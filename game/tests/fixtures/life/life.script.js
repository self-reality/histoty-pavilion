// A box that plays Conway's Game of Life on its sides — and, because it is the
// fixture for tests/script.mjs, a little of everything else script API 1 does.
export default function (object) {
  const N = 32;
  const screen = object.canvas('screen', { width: N, height: N, smooth: false });

  // A glider, and a seeded scatter: the same board on every load.
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const fresh = () => {
    const cells = new Uint8Array(N * N);
    for (let i = 0; i < cells.length; i++) cells[i] = random() < 0.25 ? 1 : 0;
    for (const [x, y] of [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]) cells[y * N + x] = 1;
    return cells;
  };
  const step = (cells) => {
    const next = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx || dy) n += cells[((y + dy + N) % N) * N + ((x + dx + N) % N)];
          }
        }
        next[y * N + x] = n === 3 || (n === 2 && cells[y * N + x]) ? 1 : 0;
      }
    }
    return next;
  };
  const draw = (cells) => {
    screen.context.fillStyle = '#0b1a0b';
    screen.context.fillRect(0, 0, N, N);
    screen.context.fillStyle = '#7dff7d';
    for (let i = 0; i < cells.length; i++) if (cells[i]) screen.context.fillRect(i % N, (i / N) | 0, 1, 1);
    screen.update();
  };

  let cells = fresh();
  let generation = 0;
  let since = 0;
  draw(cells);
  object.on('tick', (dt) => {
    since += dt;
    if (since < 0.1) return;
    since = 0;
    cells = step(cells);
    generation++;
    draw(cells);
  });

  object.action({ name: 'count', label: 'Count', stop: 'Stop' }, async (run) => {
    await run.wait(1);
    object.log(`one, at generation ${generation}`);
    await run.wait(1);
    object.log('two');
  });
  object.action({ name: 'show', label: 'Show', stop: 'Stop' }, async (run) => {
    run.sound('beep.ogg', { loop: true });
    await run.video('film.webm', { material: 'lid', loop: true });
    object.log('the film ended, which a looped one never does');
  });
  object.action({ name: 'visit', label: 'Visit' }, () => object.open('https://example.org/life', { newTab: true }));
}
