import { Entity, Vec3, Color, StandardMaterial, BLEND_ADDITIVE } from 'playcanvas';

const _o = new Vec3();
const _d = new Vec3();
const _tmp = new Vec3();

function mat(r, g, b, { metal = 0, gloss = 0.3, emissive = null } = {}) {
  const m = new StandardMaterial();
  m.diffuse = new Color(r, g, b);
  m.useMetalness = true;
  m.metalness = metal;
  m.gloss = gloss;
  if (emissive) m.emissive = new Color(emissive[0], emissive[1], emissive[2]);
  m.update();
  return m;
}

function box(parent, mtl, px, py, pz, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
  const e = new Entity();
  e.addComponent('render', { type: 'box', material: mtl, castShadows: false, receiveShadows: false });
  e.setLocalPosition(px, py, pz);
  e.setLocalScale(sx, sy, sz);
  e.setLocalEulerAngles(rx, ry, rz);
  parent.addChild(e);
  return e;
}

export class Weapon {
  constructor(app, cameraEntity, player, collider, opts = {}) {
    this.app = app;
    this.camera = cameraEntity;
    this.player = player;
    this.collider = collider;
    this.queryTargets = opts.queryTargets || (() => null);
    this.hud = opts.hud;
    this.layerId = opts.layer ?? null;   // dedicated viewmodel layer (no wall clipping)

    // Stats
    this.magSize = 30;
    this.mag = 30;
    this.reserve = 90;
    this.fireInterval = 0.1;     // 600 rpm, full-auto
    this.range = 300;
    this.reloadTime = 2.3;

    // Runtime
    this.cooldown = 0;
    this.reloading = 0;
    this.firing = false;
    this.recoil = 0;             // accumulates while spraying
    this.bobPhase = 0;

    // View punch (camera kick) and viewmodel offset springs
    this.punchX = 0; this.punchY = 0;       // applied to camera (degrees)
    this.vmKick = 0;                         // viewmodel slide-back

    this.fx = [];        // transient effects
    this.holes = [];     // persistent bullet holes (capped)

    this._buildViewmodel();
    this._tracerColor = new Color(1, 0.82, 0.45);
    this._syncHud();
  }

  _buildViewmodel() {
    const metal = mat(0.14, 0.14, 0.16, { metal: 0.7, gloss: 0.5 });
    const wood = mat(0.42, 0.21, 0.08, { metal: 0, gloss: 0.35 });
    const dark = mat(0.06, 0.06, 0.06, { metal: 0.3, gloss: 0.3 });

    const vm = new Entity('viewmodel');
    this.camera.addChild(vm);
    this.vmBase = new Vec3(0.17, -0.17, -0.42);
    vm.setLocalPosition(this.vmBase.x, this.vmBase.y, this.vmBase.z);
    vm.setLocalEulerAngles(0, -4, 0);
    this.vm = vm;

    // Receiver / body
    box(vm, metal, 0, 0, 0, 0.07, 0.10, 0.42);
    // Barrel
    box(vm, metal, 0, 0.02, -0.34, 0.03, 0.03, 0.34);
    // Front sight
    box(vm, dark, 0, 0.08, -0.42, 0.012, 0.06, 0.02);
    // Hand guard (wood)
    box(vm, wood, 0, -0.01, -0.22, 0.06, 0.07, 0.18);
    // Magazine (curved — two angled boxes)
    box(vm, dark, 0, -0.14, 0.02, 0.05, 0.16, 0.10, 18, 0, 0);
    box(vm, dark, 0, -0.26, 0.07, 0.05, 0.12, 0.09, 34, 0, 0);
    // Grip
    box(vm, dark, 0, -0.13, 0.14, 0.045, 0.14, 0.06, -22, 0, 0);
    // Stock (wood)
    box(vm, wood, 0, -0.03, 0.34, 0.05, 0.08, 0.22);

    // Muzzle anchor + flash + light
    const muzzle = new Entity('muzzle');
    muzzle.setLocalPosition(0, 0.02, -0.52);
    vm.addChild(muzzle);
    this.muzzle = muzzle;

    const flashMat = new StandardMaterial();
    flashMat.emissive = new Color(1.0, 0.8, 0.35);
    flashMat.diffuse = new Color(0, 0, 0);
    flashMat.blendType = BLEND_ADDITIVE;
    flashMat.depthWrite = false;
    flashMat.update();
    const flash = new Entity('flash');
    flash.addComponent('render', { type: 'plane', material: flashMat, castShadows: false });
    flash.setLocalEulerAngles(90, 0, 0);
    flash.setLocalScale(0.18, 0.18, 0.18);
    muzzle.addChild(flash);
    flash.enabled = false;
    this.flash = flash;
    this.flashMat = flashMat;

    const flashLight = new Entity('flashLight');
    flashLight.addComponent('light', {
      type: 'omni', color: new Color(1, 0.8, 0.4), intensity: 0, range: 8, castShadows: false
    });
    muzzle.addChild(flashLight);
    this.flashLight = flashLight;

    // Put all viewmodel meshes on the dedicated viewmodel layer (rendered on top,
    // depth-cleared, so the gun never clips into walls).
    if (this.layerId != null) {
      for (const rc of vm.findComponents('render')) rc.layers = [this.layerId];
    }
  }

  _syncHud() {
    if (!this.hud) return;
    this.hud.mag.textContent = this.mag;
    this.hud.reserve.textContent = this.reserve;
    this.hud.reloading.style.display = this.reloading > 0 ? 'block' : 'none';
  }

  startFire() { this.firing = true; }
  stopFire() { this.firing = false; this.recoil = Math.max(0, this.recoil - 0.5); }

  reload() {
    if (this.reloading > 0 || this.mag === this.magSize || this.reserve <= 0) return;
    this.reloading = this.reloadTime;
    this._syncHud();
  }

  _fireOne() {
    this.mag--;
    this.cooldown = this.fireInterval;
    this.recoil = Math.min(1, this.recoil + 0.12);

    // Camera punch (climbs while spraying) + viewmodel kick.
    this.punchX += 0.9 + this.recoil * 1.6;
    this.punchY += (Math.random() - 0.5) * (0.5 + this.recoil * 1.2);
    this.vmKick = Math.min(0.09, this.vmKick + 0.05);

    // Muzzle flash.
    this.flash.enabled = true;
    this.flash.setLocalEulerAngles(90, 0, Math.random() * 360);
    this.flashMat.opacity = 1;
    this.flashLight.light.intensity = 6;
    this._flashTime = 0.045;

    // Hitscan from camera centre, with movement/recoil spread.
    const cam = this.camera;
    _o.copy(cam.getPosition());
    _d.copy(cam.forward);
    const moveSpread = Math.min(0.06, (Math.hypot(this.player.vel.x, this.player.vel.z)) * 0.004);
    const spread = 0.004 + moveSpread + this.recoil * 0.01 * (this.player.grounded ? 1 : 2);
    _d.x += (Math.random() - 0.5) * spread;
    _d.y += (Math.random() - 0.5) * spread;
    _d.z += (Math.random() - 0.5) * spread;
    _d.normalize();

    const geo = this.collider.raycast(_o, _d, this.range);
    const tgt = this.queryTargets(_o, _d, geo ? geo.dist : this.range);

    let endX, endY, endZ;
    if (tgt && (!geo || tgt.dist < geo.dist)) {
      endX = tgt.point.x; endY = tgt.point.y; endZ = tgt.point.z;
      tgt.target.onHit(_d);
      if (this.hud) this.hud.hit();
    } else if (geo) {
      endX = geo.point.x; endY = geo.point.y; endZ = geo.point.z;
      this._spawnImpact(geo.point, geo.normal);
    } else {
      endX = _o.x + _d.x * this.range;
      endY = _o.y + _d.y * this.range;
      endZ = _o.z + _d.z * this.range;
    }
    // Tracer from muzzle to impact.
    this._tracers = this._tracers || [];
    const mp = this.muzzle.getPosition();
    this._tracers.push({ a: new Vec3(mp.x, mp.y, mp.z), b: new Vec3(endX, endY, endZ), life: 0.05 });

    if (this.mag <= 0) this.reload();
    this._syncHud();
  }

  _spawnImpact(point, normal) {
    // Dust puff (fades) + persistent hole (capped, recycled).
    const puff = new Entity();
    const puffMat = mat(0.5, 0.45, 0.38, { emissive: [0.35, 0.32, 0.27] });
    puffMat.blendType = BLEND_ADDITIVE;
    puffMat.update();
    puff.addComponent('render', { type: 'sphere', material: puffMat, castShadows: false });
    puff.setLocalScale(0.12, 0.12, 0.12);
    _tmp.copy(normal).mulScalar(0.03).add(point);
    puff.setPosition(_tmp);
    this.app.root.addChild(puff);
    this.fx.push({ entity: puff, mat: puffMat, life: 0.22, maxLife: 0.22, grow: 0.5 });

    const hole = new Entity();
    const holeMat = mat(0.02, 0.02, 0.02, { gloss: 0 });
    hole.addComponent('render', { type: 'sphere', material: holeMat, castShadows: false, receiveShadows: false });
    hole.setLocalScale(0.05, 0.05, 0.05);
    _tmp.copy(normal).mulScalar(0.01).add(point);
    hole.setPosition(_tmp);
    this.app.root.addChild(hole);
    this.holes.push(hole);
    if (this.holes.length > 48) this.holes.shift().destroy();
  }

  update(dt) {
    // Reload timer.
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        this.reloading = 0;
        const need = this.magSize - this.mag;
        const take = Math.min(need, this.reserve);
        this.mag += take; this.reserve -= take;
      }
      this._syncHud();
    }

    if (this.cooldown > 0) this.cooldown -= dt;

    // Full-auto firing.
    if (this.firing && this.reloading <= 0 && this.cooldown <= 0 && this.mag > 0) {
      this._fireOne();
    }

    // Recoil / punch recovery (spring back toward zero).
    const rec = Math.min(1, 12 * dt);
    this.punchX += (0 - this.punchX) * rec;
    this.punchY += (0 - this.punchY) * rec;
    this.vmKick += (0 - this.vmKick) * Math.min(1, 10 * dt);
    if (!this.firing) this.recoil += (0 - this.recoil) * Math.min(1, 3 * dt);

    // Apply camera punch on top of the player's look angles.
    this.camera.setLocalEulerAngles(this.player.pitch + this.punchX, this.punchY, 0);

    // Viewmodel bob + kick.
    const hspeed = Math.hypot(this.player.vel.x, this.player.vel.z);
    this.bobPhase += dt * (this.player.grounded ? hspeed * 1.6 : 0);
    const bobAmt = Math.min(0.014, hspeed * 0.0016);
    const bx = Math.cos(this.bobPhase) * bobAmt;
    const by = Math.abs(Math.sin(this.bobPhase)) * bobAmt;
    this.vm.setLocalPosition(this.vmBase.x + bx, this.vmBase.y - by, this.vmBase.z + this.vmKick);

    // Muzzle flash timing.
    if (this._flashTime > 0) {
      this._flashTime -= dt;
      this.flashMat.opacity = Math.max(0, this._flashTime / 0.045);
      this.flashLight.light.intensity = Math.max(0, 6 * (this._flashTime / 0.045));
      if (this._flashTime <= 0) { this.flash.enabled = false; this.flashLight.light.intensity = 0; }
    }

    // Tracers (immediate-mode lines).
    if (this._tracers) {
      for (let i = this._tracers.length - 1; i >= 0; i--) {
        const t = this._tracers[i];
        this.app.drawLine(t.a, t.b, this._tracerColor);
        t.life -= dt;
        if (t.life <= 0) this._tracers.splice(i, 1);
      }
    }

    // Transient FX (dust puffs).
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.life -= dt;
      const k = Math.max(0, f.life / f.maxLife);
      const s = 0.12 * (1 + (1 - k) * f.grow);
      f.entity.setLocalScale(s, s, s);
      f.mat.opacity = k;
      f.mat.update();
      if (f.life <= 0) { f.entity.destroy(); this.fx.splice(i, 1); }
    }
  }
}
