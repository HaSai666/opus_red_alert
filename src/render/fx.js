/**
 * 瞬时几何特效：曳光弹道、冲击环、能量球、EMP 波前。
 *
 * 这些是「有形体」的特效，与 Particles 的无形体粒子互补。
 * 同样使用池化：曳光是肉鸽里最高频的视觉元素（每秒十几次），
 * 每次 new 一个 Mesh 是不可接受的。
 */

import * as THREE from 'three';

/** 曳光池容量：远超实际同屏数量，避免突发时复用出闪烁 */
const TRACER_POOL = 48;
const RING_POOL = 20;
const BOLT_POOL = 64;

/** 一条曳光的生命周期 */
const TRACER_LIFE = 0.075;

export class Effects {
  constructor(scene) {
    this.scene = scene;

    this._initTracers();
    this._initRings();
    this._initBolts();

    this._time = 0;
    this._tmp = new THREE.Vector3();
  }

  // ══════════════════════════════════════════════════
  // 曳光：一条从枪口到命中点的细长光柱
  // ══════════════════════════════════════════════════
  _initTracers() {
    // 用一个细圆柱：原点在底部，沿 Y 轴延伸，这样只需 scale.y 与朝向即可
    const geo = new THREE.CylinderGeometry(0.028, 0.028, 1, 6, 1, true);
    geo.translate(0, 0.5, 0);

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.tracerGroup = new THREE.Group();
    this.tracerGroup.name = 'tracers';
    this.scene.add(this.tracerGroup);

    /** @type {{mesh:THREE.Mesh, life:number}[]} */
    this.tracers = [];
    for (let i = 0; i < TRACER_POOL; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      m.matrixAutoUpdate = true;
      m.frustumCulled = false;
      this.tracerGroup.add(m);
      this.tracers.push({ mesh: m, life: 0, maxLife: TRACER_LIFE });
    }
    this._tracerCursor = 0;
    this._tracerGeo = geo;
  }

  /**
   * 画一条曳光。
   * @param {{x,y,z}} from
   * @param {{x,y,z}} to
   * @param {string} [weapon] 'pulse' | 'scatter'
   */
  tracer(from, to, weapon = 'pulse') {
    const t = this.tracers[this._tracerCursor];
    this._tracerCursor = (this._tracerCursor + 1) % TRACER_POOL;

    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return;

    t.mesh.position.set(from.x, from.y, from.z);
    // 让局部 +Y 轴对准方向
    this._tmp.set(dx / len, dy / len, dz / len);
    t.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this._tmp);
    t.mesh.scale.set(1, len, 1);
    t.mesh.visible = true;

    // 散射炮的曳光更粗更短命，脉冲炮更细更亮
    if (weapon === 'scatter') {
      t.mesh.scale.x = 2.1;
      t.mesh.scale.z = 2.1;
      t.mesh.material.color.setHex(0xffc07a);
    } else {
      t.mesh.scale.x = 1;
      t.mesh.scale.z = 1;
      t.mesh.material.color.setHex(0xffe0b0);
    }
    t.mesh.material.opacity = 1;
    t.life = TRACER_LIFE;
    t.maxLife = TRACER_LIFE;
  }

  // ══════════════════════════════════════════════════
  // 冲击环：地面冲击波、EMP 波前、冲刺起步
  // ══════════════════════════════════════════════════
  _initRings() {
    // 用 RingGeometry 平铺在 XZ 平面
    const geo = new THREE.RingGeometry(0.42, 0.55, 40);

    this.ringGroup = new THREE.Group();
    this.ringGroup.name = 'rings';
    this.scene.add(this.ringGroup);

    /** @type {object[]} */
    this.rings = [];
    for (let i = 0; i < RING_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.frustumCulled = false;
      this.ringGroup.add(m);
      this.rings.push({ mesh: m, life: 0, maxLife: 0.4, from: 0.4, to: 4, flat: true });
    }
    this._ringCursor = 0;
    this._ringGeo = geo;
  }

  /**
   * 触发一个扩散环。
   * @param {{x,y,z}} pos
   * @param {object} [o]
   * @param {number} [o.from] 起始半径
   * @param {number} [o.to] 结束半径
   * @param {number} [o.life] 持续时长
   * @param {number} [o.color]
   * @param {boolean} [o.flat] 是否平铺地面（false 表示朝向相机，做爆炸闪环）
   */
  ring(pos, o = {}) {
    const r = this.rings[this._ringCursor];
    this._ringCursor = (this._ringCursor + 1) % RING_POOL;

    r.mesh.position.set(pos.x, pos.y, pos.z);
    r.mesh.material.color.setHex(o.color ?? 0x8ec8ff);
    r.mesh.material.opacity = 1;
    r.mesh.visible = true;
    r.flat = o.flat !== false;
    r.mesh.rotation.x = r.flat ? -Math.PI / 2 : 0;
    r.mesh.rotation.z = Math.random() * Math.PI;
    r.from = o.from ?? 0.4;
    r.to = o.to ?? 4.5;
    r.maxLife = o.life ?? 0.42;
    r.life = r.maxLife;
    r.mesh.scale.setScalar(r.from);
  }

  // ══════════════════════════════════════════════════
  // 能量弹：敌人投射物的可见弹体
  // ══════════════════════════════════════════════════
  _initBolts() {
    const geo = new THREE.IcosahedronGeometry(0.14, 0);

    this.boltGroup = new THREE.Group();
    this.boltGroup.name = 'bolts';
    this.scene.add(this.boltGroup);

    /** @type {object[]} */
    this.bolts = [];
    for (let i = 0; i < BOLT_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.frustumCulled = false;
      this.boltGroup.add(m);
      this.bolts.push({ mesh: m, active: false });
    }
    this._boltGeo = geo;
  }

  /**
   * 同步一帧的全部弹体。
   * 与曳光/环不同，弹体是持续存在的，所以每帧整体重建可见集合。
   * @param {object[]} projectiles 快照里的投射物列表
   */
  syncBolts(projectiles) {
    const n = Math.min(projectiles.length, BOLT_POOL);
    for (let i = 0; i < BOLT_POOL; i++) {
      const b = this.bolts[i];
      if (i < n) {
        const p = projectiles[i];
        b.mesh.visible = true;
        b.mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
        b.mesh.material.color.setHex(p.color);
        // 呼吸脉冲，让弹体看起来是活的
        const s = 1 + Math.sin(this._time * 22 + i) * 0.16;
        b.mesh.scale.setScalar(s);
        b.mesh.rotation.x += 0.22;
        b.mesh.rotation.y += 0.17;
      } else if (b.mesh.visible) {
        b.mesh.visible = false;
      }
    }
  }

  // ══════════════════════════════════════════════════
  // 每帧更新
  // ══════════════════════════════════════════════════

  update(dt) {
    this._time += dt;

    // ── 曳光：快速淡出 ──
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) { t.mesh.visible = false; continue; }
      const k = t.life / t.maxLife;
      // 二次曲线淡出，前段更亮
      t.mesh.material.opacity = k * k;
      // 略微变粗再收缩，制造「能量消散」感
      const w = 1 + (1 - k) * 0.7;
      t.mesh.scale.x = (t.mesh.scale.x < 1.5 ? 1 : 2.1) * w;
      t.mesh.scale.z = t.mesh.scale.x;
    }

    // ── 冲击环：线性扩散 + 淡出 ──
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.mesh.visible = false; continue; }

      const age = 1 - r.life / r.maxLife;          // 0 → 1
      // 缓出曲线：起步快、末端慢，符合冲击波物理直觉
      const ease = 1 - Math.pow(1 - age, 2.4);
      const radius = r.from + (r.to - r.from) * ease;
      r.mesh.scale.setScalar(radius);
      r.mesh.material.opacity = Math.pow(1 - age, 1.8);
    }
  }

  /** 清空所有瞬时特效（换房间/重开） */
  clear() {
    for (const t of this.tracers) { t.life = 0; t.mesh.visible = false; }
    for (const r of this.rings) { r.life = 0; r.mesh.visible = false; }
    for (const b of this.bolts) b.mesh.visible = false;
  }

  dispose() {
    this.scene.remove(this.tracerGroup);
    this.scene.remove(this.ringGroup);
    this.scene.remove(this.boltGroup);
    this._tracerGeo.dispose();
    this._ringGeo.dispose();
    this._boltGeo.dispose();
    for (const t of this.tracers) t.mesh.material.dispose();
    for (const r of this.rings) r.mesh.material.dispose();
    for (const b of this.bolts) b.mesh.material.dispose();
  }
}
