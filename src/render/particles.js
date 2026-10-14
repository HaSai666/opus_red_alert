/**
 * 粒子特效系统。
 *
 * 设计约束（设计文档 §8 风险对策）：从第一天起就上对象池。
 * 肉鸽会在同一帧产生几十个爆炸与命中火花，逐次 new Mesh 会造成 GC 尖峰，
 * 表现为随机的每帧卡顿——这是 WebGL 游戏最常见的性能问题来源。
 *
 * 实现：一个 InstancedMesh 承载全部粒子，池内对象仅更新矩阵与颜色。
 * 所有粒子共用同一个基础几何（八面体），靠缩放与颜色区分类型。
 */

import * as THREE from 'three';

/** 单次爆炸产生的粒子数上限，用于确定池容量 */
const POOL_SIZE = 1400;

/** 粒子类型预设 */
const PRESETS = {
  /** 命中火花：小而亮，快速消散，带重力 */
  spark: {
    count: [3, 6], speed: [6, 16], life: [0.14, 0.30],
    size: [0.035, 0.075], color: 0xffc46a, gravity: 14, drag: 6.5, glow: true,
  },
  /** 金属命中：冷色碎屑，比火花慢 */
  debris: {
    count: [4, 8], speed: [3, 9], life: [0.35, 0.7],
    size: [0.03, 0.065], color: 0x9fb0c4, gravity: 18, drag: 4.0, glow: false,
  },
  /** 敌人死亡爆炸：体积大、数量多、持续久 */
  explosion: {
    count: [24, 38], speed: [5, 20], life: [0.42, 1.05],
    size: [0.10, 0.30], color: 0xff8a30, gravity: 9, drag: 3.2, glow: true,
  },
  /** Boss 死亡：更大更久 */
  bigExplosion: {
    count: [70, 110], speed: [7, 30], life: [0.7, 1.8],
    size: [0.16, 0.52], color: 0xffb040, gravity: 8, drag: 2.6, glow: true,
  },
  /** 冲刺起步的地面冲击环 */
  groundBurst: {
    count: [10, 16], speed: [7, 14], life: [0.25, 0.5],
    size: [0.05, 0.12], color: 0x8ec8ff, gravity: 3, drag: 7.0, glow: true,
  },
  /** 落地尘土 */
  dust: {
    count: [10, 18], speed: [2.5, 6.5], life: [0.4, 0.85],
    size: [0.06, 0.17], color: 0x8a8f9a, gravity: 1.5, drag: 5.5, glow: false,
  },
  /** EMP 电磁脉冲：紫白色，向外扩散 */
  emp: {
    count: [40, 60], speed: [14, 26], life: [0.3, 0.62],
    size: [0.06, 0.16], color: 0xc08aff, gravity: 0, drag: 1.4, glow: true,
  },
  /** 过热排汽 */
  steam: {
    count: [6, 12], speed: [2, 5], life: [0.6, 1.2],
    size: [0.10, 0.26], color: 0xd8d8d8, gravity: -1.2, drag: 4.2, glow: false,
  },
  /** 奇点球拾取 */
  orbPickup: {
    count: [16, 24], speed: [4, 11], life: [0.3, 0.6],
    size: [0.05, 0.12], color: 0x7dffd4, gravity: 0, drag: 5.0, glow: true,
  },
};

/**
 * 内部：一个可回收的粒子。
 * 用扁平的字段而非嵌套对象，减少分配与属性查找。
 */
class Particle {
  constructor() {
    this.alive = false;
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.life = 0; this.maxLife = 1;
    this.size = 0.05;
    this.gravity = 0;
    this.drag = 0;
    this.r = 1; this.g = 1; this.b = 1;
    this.glow = false;
  }
}

export class Particles {
  /**
   * @param {THREE.Scene} scene
   * @param {() => number} rng 确定性随机源
   */
  constructor(scene, rng = Math.random) {
    this.scene = scene;
    this.rng = rng;

    // 八面体比球体便宜一半，视觉上在高速运动中几乎无异
    const geo = new THREE.OctahedronGeometry(0.5, 0);

    /** 发光粒子材质：加法混合，配合 Bloom 出光晕 */
    this.glowMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    /** 非发光粒子材质：普通混合，用于碎屑与尘土 */
    this.solidMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });

    // 两个 InstancedMesh：加法混合与普通混合无法合并，分开渲染
    this.glowMesh = new THREE.InstancedMesh(geo, this.glowMat, POOL_SIZE);
    this.glowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.count = 0;
    this.glowMesh.castShadow = false;
    this.glowMesh.receiveShadow = false;
    this._addColorAttr(this.glowMesh);

    this.solidMesh = new THREE.InstancedMesh(geo, this.solidMat, POOL_SIZE);
    this.solidMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.solidMesh.frustumCulled = false;
    this.solidMesh.count = 0;
    this.solidMesh.castShadow = false;
    this.solidMesh.receiveShadow = false;
    this._addColorAttr(this.solidMesh);

    scene.add(this.glowMesh);
    scene.add(this.solidMesh);

    // 池
    /** @type {Particle[]} */
    this.pool = [];
    for (let i = 0; i < POOL_SIZE; i++) this.pool.push(new Particle());
    this.active = 0;

    // 复用对象，避免每帧分配
    this._dummy = new THREE.Object3D();
    this._color = new THREE.Color();
  }

  /** InstancedMesh 需要实例化颜色缓冲 */
  _addColorAttr(mesh) {
    const colors = new Float32Array(POOL_SIZE * 3).fill(1);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  /** 从池中取一个空闲粒子 */
  _acquire() {
    // 线性扫描是最坏情况；实际使用时池很大而活跃粒子集中在前部，
    // 因此以 active 为起点向后找一个死的，通常一步命中。
    for (let i = 0; i < POOL_SIZE; i++) {
      const idx = (this.active + i) % POOL_SIZE;
      const p = this.pool[idx];
      if (!p.alive) {
        this.active = (idx + 1) % POOL_SIZE;
        return p;
      }
    }
    // 池满：复用最老的（覆盖），保证不会无限增长
    return this.pool[(this.active++) % POOL_SIZE];
  }

  /**
   * 在指定位置爆发一组粒子。
   * @param {keyof PRESETS} type
   * @param {{x:number,y:number,z:number}} pos
   * @param {object} [over]
   * @param {number} [over.scale] 整体尺寸与数量的缩放
   * @param {number} [over.speedScale]
   * @param {number} [over.color] 覆盖颜色
   * @param {number} [over.lifeScale]
   */
  burst(type, pos, over = {}) {
    const preset = PRESETS[type];
    if (!preset) return;

    const scale = over.scale ?? 1;
    const speedScale = over.speedScale ?? 1;
    const lifeScale = over.lifeScale ?? 1;
    const n = Math.round(this._rngRange(preset.count) * scale);

    const col = this._color;
    col.set(over.color ?? preset.color);

    for (let i = 0; i < n; i++) {
      const p = this._acquire();
      p.alive = true;

      // 初始位置加一点随机偏移，避免所有粒子从同一点出发
      const jitter = 0.16 * scale;
      p.x = pos.x + (this.rng() - 0.5) * jitter;
      p.y = pos.y + (this.rng() - 0.5) * jitter;
      p.z = pos.z + (this.rng() - 0.5) * jitter;

      // 球面均匀方向
      const theta = this.rng() * Math.PI * 2;
      const phi = Math.acos(2 * this.rng() - 1);
      const sp = this._rngRange(preset.speed) * speedScale;
      p.vx = Math.sin(phi) * Math.cos(theta) * sp;
      p.vy = Math.cos(phi) * sp * 0.85 + sp * 0.25;  // 略微偏上，看起来更有能量
      p.vz = Math.sin(phi) * Math.sin(theta) * sp;

      p.maxLife = this._rngRange(preset.life) * lifeScale;
      p.life = p.maxLife;
      p.size = this._rngRange(preset.size) * scale;
      p.gravity = preset.gravity;
      p.drag = preset.drag;
      p.glow = !!preset.glow;

      // 颜色加一点明度扰动，避免一片死板的同色
      const v = 0.78 + this.rng() * 0.42;
      p.r = col.r * v;
      p.g = col.g * v;
      p.b = col.b * v;
    }
  }

  /** 在两点之间撒一条线状粒子（曳光辅助、冲刺残影） */
  trail(from, to, type = 'spark', count = 6, over = {}) {
    for (let i = 0; i < count; i++) {
      const t = i / Math.max(1, count - 1);
      this.burst(type, {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        z: from.z + (to.z - from.z) * t,
      }, { scale: 0.42, ...over });
    }
  }

  _rngRange([a, b]) { return a + this.rng() * (b - a); }

  /**
   * 更新所有粒子。
   * @param {number} dt
   */
  update(dt) {
    let glowCount = 0;
    let solidCount = 0;

    const dummy = this._dummy;

    for (let i = 0; i < POOL_SIZE; i++) {
      const p = this.pool[i];
      if (!p.alive) continue;

      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }

      // 阻力
      const dragFactor = Math.max(0, 1 - p.drag * dt);
      p.vx *= dragFactor;
      p.vy *= dragFactor;
      p.vz *= dragFactor;

      // 重力
      p.vy -= p.gravity * dt;

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // 生命末段缩小并淡出
      const t = p.life / p.maxLife;
      const sizeCurve = t > 0.72 ? 1 : t / 0.72;   // 前 28% 保持满尺寸，之后收缩
      const s = p.size * (0.35 + sizeCurve * 0.65);

      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.setScalar(s * 2);
      // 拉伸朝向速度方向，产生「拖尾」感
      const sp = Math.hypot(p.vx, p.vy, p.vz);
      if (sp > 1.5) {
        const stretch = Math.min(2.6, 1 + sp * 0.055);
        dummy.scale.y *= stretch;
        dummy.lookAt(p.x + p.vx, p.y + p.vy, p.z + p.vz);
        dummy.rotateX(Math.PI / 2);
      }
      dummy.updateMatrix();

      // 亮度随生命衰减
      const bright = Math.min(1, t * 1.8);

      if (p.glow) {
        if (glowCount >= POOL_SIZE) continue;
        this.glowMesh.setMatrixAt(glowCount, dummy.matrix);
        this.glowMesh.instanceColor.setXYZ(glowCount, p.r * bright, p.g * bright, p.b * bright);
        glowCount++;
      } else {
        if (solidCount >= POOL_SIZE) continue;
        this.solidMesh.setMatrixAt(solidCount, dummy.matrix);
        // 非发光粒子随生命变暗并偏灰
        const grey = 0.4 + t * 0.6;
        this.solidMesh.instanceColor.setXYZ(solidCount, p.r * grey, p.g * grey, p.b * grey);
        solidCount++;
      }
    }

    this.glowMesh.count = glowCount;
    this.solidMesh.count = solidCount;
    if (glowCount > 0) {
      this.glowMesh.instanceMatrix.needsUpdate = true;
      this.glowMesh.instanceColor.needsUpdate = true;
    }
    if (solidCount > 0) {
      this.solidMesh.instanceMatrix.needsUpdate = true;
      this.solidMesh.instanceColor.needsUpdate = true;
    }
  }

  /** 清空全部粒子（换局时） */
  clear() {
    for (const p of this.pool) p.alive = false;
    this.glowMesh.count = 0;
    this.solidMesh.count = 0;
    this.active = 0;
  }

  dispose() {
    this.scene.remove(this.glowMesh);
    this.scene.remove(this.solidMesh);
    this.glowMesh.geometry.dispose();
    this.glowMat.dispose();
    this.solidMat.dispose();
  }
}
