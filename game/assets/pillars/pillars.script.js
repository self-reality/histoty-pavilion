// Conway's Game of Life round the four sides of each of two slabs, 8.2 x 1.1 m
// and 27.8 m tall: the life column's field (scripts/life), once a slab, each
// with its own cells - they start apart and never meet.
//
// A field is a cylinder - left and right edges stitched, top and bottom walls,
// ships spawned at the bottom flying up - so a slab's `screen_<n>` material, one
// UV band round it, shows it without a seam. The band gives the wide sides 82
// columns and the narrow ones 11 (source/pillars/pillars.py), so a cell is 10 cm
// either way and 277 rows reach the top.
//
// E drops a ship on the cell the player is looking at, on whichever slab that
// is: a random type, turned a random quarter, so it may fly any of four ways.
export default function (object) {
  const settings = {
    cols: 186,
    rows: 277,
    cellSize: 5,
    speed: 18,
    gridThickness: 1,
    bgColor: '#000000',
    gridColor: '#2b2b2b',
    alive1Color: '#ff3b3b',
    alive2Color: '#16c172',
    alive10Color: '#2f7cff',
    injections: 1,
    injectionPeriod: 80,
    initialAliveProbability: 0.25,
  };
  const glow = { blur: 4, alpha: 1, blendMode: 'lighten' };

  const { cols, rows, cellSize } = settings;
  const width = cols * cellSize;
  const height = rows * cellSize;

  // Stored facing up, so they stamp straight onto the bottom edge.
  const ships = {
    gliders: [
      [[1, 0], [2, 0], [0, 1], [2, 1], [2, 2]],
      [[0, 0], [1, 0], [2, 0], [0, 1], [1, 2]],
    ],
    spaceships: [
      [[0, 0], [1, 0], [2, 0], [0, 1], [3, 1], [0, 2], [0, 3], [1, 4], [3, 4]],
      [[0, 0], [1, 0], [2, 0], [0, 1], [3, 1], [0, 2], [0, 3], [4, 3], [0, 4], [1, 5], [3, 5]],
      [[0, 0], [1, 0], [2, 0], [0, 1], [3, 1], [0, 2], [0, 3], [4, 3], [0, 4], [4, 4], [0, 5], [1, 6], [3, 6]],
    ],
  };

  const wrapX = (x) => ((x % cols) + cols) % cols;

  function pickShip() {
    const names = Math.random() < 0.2 ? ships.gliders : ships.spaceships;
    return names[Math.floor(Math.random() * names.length)];
  }

  // A quarter turn is all it takes to aim an upward ship any of four ways.
  function rotate(ship, quarterTurns) {
    let turned = ship;
    for (let i = 0; i < quarterTurns % 4; i++) turned = turned.map(([x, y]) => [-y, x]);
    const minX = Math.min(...turned.map(([x]) => x));
    const minY = Math.min(...turned.map(([, y]) => y));
    return turned.map(([x, y]) => [x - minX, y - minY]);
  }

  const colorOf = (age) => (age >= 10 ? settings.alive10Color : age >= 2 ? settings.alive2Color : settings.alive1Color);

  // One slab's field: its cells, and the canvas on its material.
  function field(material) {
    const screen = object.canvas(material, { width, height });
    const ctx = screen.context;

    // ---- Simulation: simulation_core.js, horizontal wrap on -------------------

    let cells = new Uint8Array(cols * rows);
    let ages = new Uint16Array(cols * rows);
    let nextCells = new Uint8Array(cols * rows);
    let nextAges = new Uint16Array(cols * rows);
    let cycleCount = 0;
    for (let i = 0; i < cells.length; i++) {
      const alive = Math.random() < settings.initialAliveProbability ? 1 : 0;
      cells[i] = alive;
      ages[i] = alive;
    }

    // Clears the footprint plus a one-cell border, so the ship is born intact.
    function stamp(ship, posX, posY) {
      const shipWidth = Math.max(...ship.map(([x]) => x)) + 1;
      const shipHeight = Math.max(...ship.map(([, y]) => y)) + 1;
      for (let y = posY - 1; y <= posY + shipHeight; y++) {
        if (y < 0 || y >= rows) continue;
        for (let x = posX - 1; x <= posX + shipWidth; x++) {
          const i = y * cols + wrapX(x);
          cells[i] = 0;
          ages[i] = 0;
        }
      }
      for (const [x, y] of ship) {
        if (posY + y < 0 || posY + y >= rows) continue;
        const i = (posY + y) * cols + wrapX(posX + x);
        cells[i] = 1;
        ages[i] = 1;
      }
    }

    function spawnShipFromBottom() {
      const ship = pickShip();
      const shipHeight = Math.max(...ship.map(([, y]) => y)) + 1;
      stamp(ship, Math.floor(Math.random() * cols), rows - shipHeight);
    }

    // Centred on the cell, and pushed back inside if it would hang over the top
    // or bottom wall; across the seam it just wraps.
    function spawnShipAt(cellX, cellY) {
      const ship = rotate(pickShip(), Math.floor(Math.random() * 4));
      const shipWidth = Math.max(...ship.map(([x]) => x)) + 1;
      const shipHeight = Math.max(...ship.map(([, y]) => y)) + 1;
      const posY = Math.max(0, Math.min(cellY - (shipHeight >> 1), rows - shipHeight));
      stamp(ship, wrapX(cellX - (shipWidth >> 1)), posY);
    }

    function step() {
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const xl = x > 0 ? x - 1 : cols - 1;
          const xr = x < cols - 1 ? x + 1 : 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= rows) continue;
            const row = yy * cols;
            n += cells[row + xl] + cells[row + xr];
            if (dy) n += cells[row + x];
          }
          const i = y * cols + x;
          const alive = cells[i] === 1;
          const next = alive ? n === 2 || n === 3 : n === 3;
          nextCells[i] = next ? 1 : 0;
          nextAges[i] = next ? (alive ? ages[i] + 1 : 1) : 0;
        }
      }
      [cells, nextCells] = [nextCells, cells];
      [ages, nextAges] = [nextAges, ages];
      cycleCount++;
      if (cycleCount % settings.injectionPeriod === 0) {
        for (let k = 0; k < settings.injections; k++) spawnShipFromBottom();
      }
    }

    // ---- Drawing: script.js render(), without the margin and the ruler ------

    function draw() {
      ctx.fillStyle = settings.bgColor;
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = settings.gridColor;
      ctx.lineWidth = settings.gridThickness;
      ctx.beginPath();
      for (let x = 0; x <= cols; x++) {
        ctx.moveTo(x * cellSize, 0);
        ctx.lineTo(x * cellSize, height);
      }
      for (let y = 0; y <= rows; y++) {
        ctx.moveTo(0, y * cellSize);
        ctx.lineTo(width, y * cellSize);
      }
      ctx.stroke();

      for (let i = 0; i < cells.length; i++) {
        if (cells[i] !== 1) continue;
        ctx.fillStyle = colorOf(ages[i]);
        ctx.fillRect((i % cols) * cellSize, ((i / cols) | 0) * cellSize, cellSize, cellSize);
      }

      // The glow is the picture blurred over itself. The original blurs a copy
      // holding only the cells, but under `lighten` a blurred black background
      // and grid are darker than what they land on, so only the cells show.
      ctx.save();
      ctx.globalCompositeOperation = glow.blendMode;
      ctx.globalAlpha = glow.alpha;
      ctx.filter = `blur(${glow.blur}px)`;
      // Drawn a width either side too, so the glow crosses the seam like the cells do.
      for (const dx of [0, -width, width]) ctx.drawImage(screen.canvas, dx, 0);
      ctx.restore();

      screen.update();
    }

    return { material, step, draw, spawnShipAt };
  }

  // Named for the slabs in the file, `0` and `1`.
  const fields = ['screen_0', 'screen_1'].map(field);

  // uv is the file's: (0, 0) is the canvas's top-left corner, one band round the slab.
  // The slabs stand 4.3 m either side of the origin, so the radius reaches round both.
  object.action({ name: 'ship', label: 'Launch a ship', radius: 12 }, {
    start(run) {
      const aim = run.aim;
      const aimed = fields.find((f) => f.material === aim?.material);
      if (!aimed || !aim.uv) return;
      const [u, v] = aim.uv;
      aimed.spawnShipAt(wrapX(Math.floor(u * cols)), Math.min(rows - 1, Math.max(0, Math.floor(v * rows))));
      aimed.draw();
    },
  });

  for (const f of fields) f.draw();
  let accumulator = 0;
  object.on('tick', (dt) => {
    // Capped, so a frame after the tab was hidden does not step a minute at once.
    accumulator = Math.min(accumulator + dt, 0.25);
    const stepTime = 1 / settings.speed;
    if (accumulator < stepTime) return;
    while (accumulator >= stepTime) {
      for (const f of fields) f.step();
      accumulator -= stepTime;
    }
    for (const f of fields) f.draw();
  });
}
