// The pillars and the pulsar between them, as one asset (projects/pillars_pulsar):
// the two slabs playing their Game of Life on `screen_0` and `screen_1`, and
// the pulsar, its middle level with their tops, running on `screen` - its cubes
// still parts of their own, `cell_<column>_<row>` (the item keeps its parts), so
// its `dead` switch hides a dead one as it does on the pulsar alone. Each is its
// part's own script (scripts/pillars, scripts/pulsar) as it was when this was put
// together - a script imports nothing, so they are copied in, and an edit to
// either has to be made here too.
//
// And the ships, which are this asset's own (below): from the pulsar's middle,
// spaceships flying out across a level field through it, fading as they go.
export default function (object) {
  pillars(object);
  ships(object, pulsar(object));
}

function pillars(object) {
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

function pulsar(object) {
  const settings = {
    cols: 15,
    rows: 15,
    cellSize: 32,
    // Half of it falls in each cell, and a face shows all but its outer half-pixel (pulsar.py): a 1-pixel rim.
    gridThickness: 3,
  };
  // By the `scheme` param. `pillars` is theirs to the digit. A scheme without a
  // grid colour draws no grid, and one without glow no glow.
  const schemes = {
    pillars: { bgColor: '#000000', gridColor: '#2b2b2b', alive1Color: '#ff3b3b', alive2Color: '#16c172', alive10Color: '#2f7cff', glow: true },
    onyx: { bgColor: '#060607', gridColor: '#1f1f22', alive1Color: '#ffffff', alive2Color: '#b4b4ba', alive10Color: '#66666e', glow: true },
    classic: { bgColor: '#d6d6d6', gridColor: null, alive1Color: '#000000', alive2Color: '#000000', alive10Color: '#000000', glow: false },
  };
  // Here two a second, in `classic`, the dead cells hidden - the pulsar alone steps once, in `pillars`, all shown.
  const speed = object.param('speed', 2, { label: 'Generations a second', min: 1, max: 60, step: 1 });
  const scheme = object.param('scheme', 'classic', { label: 'Colours', options: Object.keys(schemes) });
  const colours = () => schemes[scheme.value] ?? schemes.pillars;
  const dead = object.param('dead', false, { label: 'Dead cells shown' });
  // The pillars blur 4 px on a 5 px cell; this is that much of a cell here.
  const glow = { blur: 0.8 * settings.cellSize, alpha: 1, blendMode: 'lighten' };

  const { cols, rows, cellSize } = settings;
  const width = cols * cellSize;
  const height = rows * cellSize;

  const PULSAR = [
    '..OOO...OOO..',
    '.............',
    'O....O.O....O',
    'O....O.O....O',
    'O....O.O....O',
    '..OOO...OOO..',
    '.............',
    '..OOO...OOO..',
    'O....O.O....O',
    'O....O.O....O',
    'O....O.O....O',
    '.............',
    '..OOO...OOO..',
  ];

  const screen = object.canvas('screen', { width, height });
  const ctx = screen.context;

  let cells = new Uint8Array(cols * rows);
  let ages = new Uint16Array(cols * rows);
  let nextCells = new Uint8Array(cols * rows);
  let nextAges = new Uint16Array(cols * rows);
  function start() {
    cells.fill(0);
    ages.fill(0);
    PULSAR.forEach((line, y) => [...line].forEach((c, x) => {
      if (c !== 'O') return;
      const i = (y + 1) * cols + (x + 1);
      cells[i] = 1;
      ages[i] = 1;
    }));
  }

  const colorOf = (c, age) => (age >= 10 ? c.alive10Color : age >= 2 ? c.alive2Color : c.alive1Color);

  function step() {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= rows) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((dx || dy) && xx >= 0 && xx < cols) n += cells[yy * cols + xx];
          }
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
  }

  // The cells with a cube - every one the three phases light - and whether each is drawn now.
  start();
  const cubes = new Map();
  for (let g = 0; g < 3; g++) {
    for (let i = 0; i < cells.length; i++) if (cells[i]) cubes.set(i, true);
    step();
  }
  start();
  const cubeOf = (i) => `cell_${i % cols}_${(i / cols) | 0}`;

  function showCubes() {
    for (const [i, shown] of cubes) {
      const show = dead.value || cells[i] === 1;
      if (show === shown) continue;
      object.shade(show ? 'textured' : 'hidden', { part: cubeOf(i) });
      cubes.set(i, show);
    }
  }

  let drawnIn = null;
  function draw() {
    showCubes();
    const c = colours();
    drawnIn = c;
    ctx.fillStyle = c.bgColor;
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < cells.length; i++) {
      if (cells[i] !== 1) continue;
      ctx.fillStyle = colorOf(c, ages[i]);
      ctx.fillRect((i % cols) * cellSize, ((i / cols) | 0) * cellSize, cellSize, cellSize);
    }

    // Every cell's square is a whole face, so the grid is each face's rim.
    if (c.gridColor) {
      ctx.strokeStyle = c.gridColor;
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
    }

    if (c.glow) {
      ctx.save();
      ctx.globalCompositeOperation = glow.blendMode;
      ctx.globalAlpha = glow.alpha;
      ctx.filter = `blur(${glow.blur}px)`;
      ctx.drawImage(screen.canvas, 0, 0);
      ctx.restore();
    }

    screen.update();
  }

  draw();
  let accumulator = 0;
  object.on('tick', (dt) => {
    const stepTime = 1 / speed.value;
    // Capped, so a frame after the tab was hidden does not step a minute at once - but never under one step, or a slow pulsar would never step.
    accumulator = Math.min(accumulator + dt, Math.max(0.25, stepTime));
    if (accumulator < stepTime) {
      // A new scheme shows at once, not on the next generation - which at 1 a second is a while.
      if (colours() !== drawnIn) draw();
      else showCubes();
      return;
    }
    while (accumulator >= stepTime) {
      step();
      accumulator -= stepTime;
    }
    draw();
  });
  return { speed, colours };
}

// Spaceships out of the pulsar's middle, on a field through it parallel to the
// floor - the pulsar's own grid laid flat, its cubes at its pitch - each a
// glider or a light, middle or heavy-weight spaceship, turned and mirrored at
// random, so it flies one of the four diagonals or the four straight ways. They
// step at their own pace, `shipSpeed` - 11.5 generations a second unless said - and
// wear the pulsar's live colour. Each lives on a field of its own, so two never
// change each other.
//
// Nor do two ever overlap: a ship goes out only when every cell of it is at
// least GAP cells clear of every other ship's. Once out, none catches another -
// those flying one way all fly at one speed, and ways out of one middle only
// part - so that clearance at the start holds for good. A ship that is not clear
// waits a generation and tries again.
//
// Diagonal or straight is drawn first, then the ship. There is one diagonal
// ship to three straight ones - the glider is the only small one that flies a
// diagonal - so a ship drawn from all four would be a glider one time in four.
// And a glider is slower out, c/4 along a diagonal, 0.35 of a cell a
// generation against the others' 0.5, so it is out 1.41 times as long. A ship
// is a glider DIAGONAL of the time, 0.41, so as many fly diagonally as
// straight at any moment.
//
// A ship is due at a random moment, the time to the next one drawn so half
// the waits are under `interval` - 0.5 s unless said - and half over. It fades as
// it goes, and is gone at 100 m: a cell is drawn by a copy of one of eight cubes
// (pulsar_ships, the cube for each eighth of the way), solid near and an eighth
// less each 12.5 m. The copies are made when the script starts - 150 a step,
// 1.4 times what the busiest 12.5 m asks at the defaults (106; about 550 cells out
// in all, 23 ships flying diagonally and 25 straight); past that a cell is not
// drawn until a copy is free, and a ship waits to go out. Slow ships stay out
// longer and are where it binds.
function ships(object, { colours }) {
  const SCALE = 0.6774;           // the pulsar's and pulsar_ships' in projects/pillars_pulsar - change all three together
  const pitch = 0.45 * SCALE;     // a cell of the pulsar's field (source/pulsar)
  const REACH = 100;
  const STEPS = 8;
  const COPIES = 150;
  const GAP = 3;                  // cells clear of every other ship a new one needs, any way - a 2-cell gap between them at least
  const shipSpeed = object.param('shipSpeed', 11.5, { label: 'Ships, generations a second', min: 0.5, max: 60, step: 0.5 });
  const interval = object.param('interval', 0.5, { label: 'A ship every, seconds (median)', min: 0.5, max: 60, step: 0.5 });

  const DIAGONAL = 1 / (1 + Math.SQRT2);   // 0.41: a glider is out sqrt 2 times as long as a straight ship
  const SHIPS = [
    ['.O.', '..O', 'OOO'],               // the glider, the one diagonal - shapes[0]
    ['.O..O', 'O....', 'O...O', 'OOOO.'],
    ['...O..', '.O...O', 'O.....', 'O....O', 'OOOOO.'],
    ['...OO..', '.O....O', 'O......', 'O.....O', 'OOOOOO.'],
  ];
  // Every ship in its eight turns and mirrorings, its middle on the cell at the pulsar's.
  const shapes = SHIPS.map((rows) => {
    const cells = rows.flatMap((r, y) => [...r].flatMap((c, x) => (c === 'O' ? [[x, y]] : [])));
    const ways = [];
    for (let m = 0; m < 2; m++) {
      for (let q = 0; q < 4; q++) {
        let turned = cells.map(([x, y]) => (m ? [-x, y] : [x, y]));
        for (let i = 0; i < q; i++) turned = turned.map(([x, y]) => [-y, x]);
        const cx = Math.round(turned.reduce((a, [x]) => a + x, 0) / turned.length);
        const cy = Math.round(turned.reduce((a, [, y]) => a + y, 0) / turned.length);
        ways.push(turned.map(([x, y]) => [x - cx, y - cy]));
      }
    }
    return ways;
  });

  // A cell is x and y packed into one number; a field never reaches 2048 cells out.
  const key = (x, y) => (x + 2048) * 4096 + (y + 2048);
  function step(cells) {
    const alive = new Set(cells.map(([x, y]) => key(x, y)));
    const count = new Map();
    for (const [x, y] of cells) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const k = key(x + dx, y + dy);
          count.set(k, (count.get(k) ?? 0) + 1);
        }
      }
    }
    const next = [];
    for (const [k, n] of count) {
      if (n === 3 || (n === 2 && alive.has(k))) next.push([Math.floor(k / 4096) - 2048, (k % 4096) - 2048]);
    }
    return next;
  }

  // Each step's cube, hidden - a copy of a hidden part starts hidden - and its copies.
  const steps = [];
  for (let k = 0; k < STEPS; k++) {
    const part = `ship_${k}_nocol`;
    object.shade('hidden', { part });
    const copies = [];
    for (let n = 0; n < COPIES; n++) {
      const name = object.spawn(part, { name: `ship_${k}_${n}` });
      if (name) copies.push(name);
    }
    steps.push({ copies, shown: 0, screen: object.canvas(`ship_${k}`, { width: 4, height: 4 }) });
  }

  let painted = null;
  function paint() {
    const c = colours();
    if (c === painted) return;
    painted = c;
    for (const { screen } of steps) {
      screen.context.fillStyle = c.alive2Color;
      screen.context.fillRect(0, 0, screen.width, screen.height);
      screen.update();
    }
  }

  let flying = [];
  // Each cell to a copy of the cube for how far out it is; the copies left over hidden.
  function place() {
    const used = new Array(STEPS).fill(0);
    const band = REACH / STEPS;
    for (const cells of flying) {
      for (const [x, y] of cells) {
        const k = Math.floor((pitch * Math.hypot(x, y)) / band);
        if (k >= STEPS) continue;
        const s = steps[k];
        if (used[k] >= s.copies.length) continue;
        const i = used[k]++;
        object.turn([0, 0, 0], { part: s.copies[i], by: [x * pitch, 0, y * pitch] });
        if (i >= s.shown) object.shade('textured', { part: s.copies[i] });
      }
    }
    steps.forEach((s, k) => {
      for (let i = used[k]; i < s.shown; i++) object.shade('hidden', { part: s.copies[i] });
      s.shown = used[k];
    });
  }

  // Whether `cells` stand GAP clear of every ship out.
  function clear(cells) {
    for (const other of flying) {
      for (const [x, y] of other) {
        for (const [cx, cy] of cells) {
          if (Math.abs(x - cx) < GAP && Math.abs(y - cy) < GAP) return false;
        }
      }
    }
    return true;
  }

  // Exponential waits, their median `interval`.
  const wait = () => (-Math.log(1 - Math.random()) / Math.LN2) * interval.value;
  let untilNext = wait();
  let due = null;                 // the ship whose time has come, waiting to be clear
  let accumulator = 0;
  paint();
  object.on('tick', (dt) => {
    paint();
    let changed = false;
    untilNext -= dt;
    if (untilNext <= 0 && !due) {
      const ways = Math.random() < DIAGONAL ? shapes[0] : shapes[1 + Math.floor(Math.random() * (shapes.length - 1))];
      due = ways[Math.floor(Math.random() * ways.length)];
    }
    // Out only clear of the others, and into a step with copies left for it.
    if (due && clear(due) && steps[0].shown + 18 <= steps[0].copies.length) {
      flying.push(due);
      due = null;
      untilNext = wait();
      changed = true;
    }
    const stepTime = 1 / shipSpeed.value;
    // Capped, so a frame after the tab was hidden does not step a minute at once.
    accumulator = Math.min(accumulator + dt, Math.max(0.25, stepTime));
    while (accumulator >= stepTime) {
      flying = flying.map(step).filter((cells) => cells.some(([x, y]) => pitch * Math.hypot(x, y) < REACH));
      accumulator -= stepTime;
      changed = true;
    }
    if (changed) place();
  });
}
