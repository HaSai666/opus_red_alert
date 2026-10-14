/**
 * 关卡几何：把「房间布局」翻译成 Rapier 的静态碰撞体与可渲染的盒子列表。
 *
 * 本模块只描述**几何形状**，不产生 three.js 对象——渲染层读 shapes 自行建网格。
 * 这样物理与渲染共用同一份真相，不会出现「看得见走不过去」。
 */

import RAPIER from 'rapier';
import { config } from '../config.js';
import { GROUP, membership } from './world.js';

/**
 * @typedef {object} BoxShape
 * @property {'floor'|'wall'|'cover'|'pillar'|'ceiling'} kind
 * @property {number} x @property {number} y @property {number} z  中心点
 * @property {number} sx @property {number} sy @property {number} sz 尺寸（全宽）
 * @property {number} [tint] 0..1，渲染层用来做色调变化，避免整屋一个颜色
 */

/**
 * 用种子驱动的确定性随机，保证同一种子生成的房间完全一致（利于复现 bug）。
 */
export class Rng {
  constructor(seed = 1) { this.s = (seed >>> 0) || 1; }
  /** xorshift32 */
  next() {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;  x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** 洗牌（原地） */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/**
 * 生成一个房间的几何体列表。
 *
 * 布局规则：
 *   - 地板 + 天花板的方形空间
 *   - 三面实墙 + 一面在 doorSide 上留出通道缺口
 *   - 内部撒若干掩体柱/矮墙，位置不重叠、不堵死通道
 *
 * @param {object} opts
 * @param {number} opts.seed
 * @param {'N'|'E'|'S'|'W'|null} opts.doorSide 该面留门；null 表示全封闭（Boss 房）
 * @param {number} opts.originX 房间中心 X
 * @param {number} opts.originZ 房间中心 Z
 * @param {boolean} opts.isBoss
 * @returns {{ shapes: BoxShape[], spawnPoints: {x:number,z:number}[], playerSpawn: {x:number,z:number}, bounds: object }}
 */
export function generateRoom({ seed, doorSide, originX = 0, originZ = 0, isBoss = false }) {
  const rng = new Rng(seed);
  const S = config.world.roomSize;
  const H = config.world.wallHeight;
  const T = 0.9;               // 墙厚
  const glyphT = 0.42;         // 天花板厚度
  const half = S / 2;

  /** @type {BoxShape[]} */
  const shapes = [];

  // ── 地板与天花板 ──────────────────────────
  shapes.push({ kind: 'floor',   x: originX, y: -0.5, z: originZ, sx: S, sy: 1, sz: S, tint: 0.5 });
  shapes.push({ kind: 'ceiling', x: originX, y: H + glyphT / 2, z: originZ, sx: S, sy: glyphT, sz: S, tint: 0.35 });

  // ── 四面墙，其中一面开门 ──────────────────
  const gap = config.world.corridorWidth;
  const wallSegs = [
    { side: 'N', cx: originX, cz: originZ - half - T / 2, sx: S + T * 2, sz: T },
    { side: 'S', cx: originX, cz: originZ + half + T / 2, sx: S + T * 2, sz: T },
    { side: 'W', cx: originX - half - T / 2, cz: originZ, sx: T, sz: S },
    { side: 'E', cx: originX + half + T / 2, cz: originZ, sx: T, sz: S },
  ];

  for (const w of wallSegs) {
    const isDoor = w.side === doorSide;
    const horizontal = w.sx > w.sz;

    if (!isDoor) {
      shapes.push({ kind: 'wall', x: w.cx, y: H / 2, z: w.cz, sx: w.sx, sy: H, sz: w.sz, tint: 0.45 });
      continue;
    }

    // 开门：把整面墙拆成两段，中间留 gap 宽的缺口
    if (horizontal) {
      const segW = (w.sx - gap) / 2;
      if (segW > 0.2) {
        shapes.push({ kind: 'wall', x: w.cx - (gap / 2 + segW / 2), y: H / 2, z: w.cz, sx: segW, sy: H, sz: w.sz, tint: 0.45 });
        shapes.push({ kind: 'wall', x: w.cx + (gap / 2 + segW / 2), y: H / 2, z: w.cz, sx: segW, sy: H, sz: w.sz, tint: 0.45 });
      }
      // 门楣：门上方保留墙体，制造通道感
      shapes.push({ kind: 'wall', x: w.cx, y: H - 0.7, z: w.cz, sx: gap, sy: 1.4, sz: w.sz, tint: 0.38 });
    } else {
      const segD = (w.sz - gap) / 2;
      if (segD > 0.2) {
        shapes.push({ kind: 'wall', x: w.cx, y: H / 2, z: w.cz - (gap / 2 + segD / 2), sx: w.sx, sy: H, sz: segD, tint: 0.45 });
        shapes.push({ kind: 'wall', x: w.cx, y: H / 2, z: w.cz + (gap / 2 + segD / 2), sx: w.sx, sy: H, sz: segD, tint: 0.45 });
      }
      shapes.push({ kind: 'wall', x: w.cx, y: H - 0.7, z: w.cz, sx: w.sx, sy: 1.4, sz: gap, tint: 0.38 });
    }
  }

  // ── 内部掩体 ─────────────────────────────
  // 关键约束：不能在房间正中生成，否则玩家出生点被堵。
  // 掩体数量随房间大小缩放，Boss 房留出更大空地。
  const coverCount = isBoss ? rng.int(2, 3) : rng.int(4, 7);
  const margin = 5.2;          // 距墙最小距离
  const centerClear = 4.2;     // 中心禁放半径
  const placed = [];

  let attempts = 0;
  while (placed.length < coverCount && attempts < 120) {
    attempts++;
    const cx = rng.range(-half + margin, half - margin);
    const cz = rng.range(-half + margin, half - margin);

    // 避开房间中心（玩家出生点）
    if (Math.hypot(cx, cz) < centerClear) continue;

    // 避开门口通道：门方向外侧 9 米内不放东西
    if (doorSide) {
      const d = 9;
      if (doorSide === 'N' && cz < -half + d) continue;
      if (doorSide === 'S' && cz >  half - d) continue;
      if (doorSide === 'W' && cx < -half + d) continue;
      if (doorSide === 'E' && cx >  half - d) continue;
    }

    const tall = rng.next() < 0.34;
    const sx = rng.range(1.5, 3.4);
    const sz = rng.range(1.5, 3.4);
    const sy = tall ? rng.range(3.0, 4.4) : rng.range(1.0, 1.5);

    // 与已有掩体保持间距，避免拼成一堵厚墙
    const spacing = 2.6;
    let overlap = false;
    for (const p of placed) {
      if (Math.abs(cx - p.x) < (sx + p.sx) / 2 + spacing &&
          Math.abs(cz - p.z) < (sz + p.sz) / 2 + spacing) { overlap = true; break; }
    }
    if (overlap) continue;

    placed.push({ x: cx, z: cz, sx, sz });
    shapes.push({
      kind: tall ? 'pillar' : 'cover',
      x: originX + cx, y: sy / 2, z: originZ + cz,
      sx, sy, sz,
      tint: rng.range(0.3, 0.7),
    });
  }

  // ── 出生点 ───────────────────────────────
  // 玩家：从门的内侧进入，面朝房间中心
  let playerSpawn;
  const inset = half - 3.0;
  switch (doorSide) {
    case 'N': playerSpawn = { x: 0, z: -inset }; break;
    case 'S': playerSpawn = { x: 0, z:  inset }; break;
    case 'W': playerSpawn = { x: -inset, z: 0 }; break;
    case 'E': playerSpawn = { x:  inset, z: 0 }; break;
    default:  playerSpawn = { x: 0, z: -inset }; break;
  }
  playerSpawn = { x: originX + playerSpawn.x, z: originZ + playerSpawn.z };

  // 敌人：撒在房间后半部与两翼，避开玩家出生位置和掩体
  const spawnPoints = [];
  const enemyCount = isBoss ? 0 : rng.int(5, 8);
  let ea = 0;
  while (spawnPoints.length < enemyCount && ea < 200) {
    ea++;
    const ex = rng.range(-half + 3, half - 3);
    const ez = rng.range(-half + 3, half - 3);
    const wx = originX + ex, wz = originZ + ez;

    // 距玩家出生点至少 9 米，给玩家反应时间
    if (Math.hypot(wx - playerSpawn.x, wz - playerSpawn.z) < 9) continue;

    // 不能生成在掩体内部
    let inside = false;
    for (const c of shapes) {
      if (c.kind !== 'cover' && c.kind !== 'pillar') continue;
      if (Math.abs(wx - c.x) < c.sx / 2 + 0.8 && Math.abs(wz - c.z) < c.sz / 2 + 0.8) { inside = true; break; }
    }
    if (inside) continue;

    spawnPoints.push({ x: wx, z: wz });
  }

  return {
    shapes,
    spawnPoints,
    playerSpawn,
    bounds: { minX: originX - half, maxX: originX + half, minZ: originZ - half, maxZ: originZ + half },
  };
}

/**
 * 把盒子形状列表写入 Rapier 世界，返回创建的碰撞体数组。
 * 调用方负责在销毁关卡时把这些碰撞体从世界里移除。
 *
 * @param {import('./world.js').PhysicsWorld} physics
 * @param {BoxShape[]} shapes
 * @returns {any[]} 创建的 collider 列表
 */
export function buildColliders(physics, shapes) {
  const world = physics.world;
  const filter = membership(GROUP.LEVEL, GROUP.PLAYER | GROUP.ENEMY | GROUP.PROJECTILE);
  const colliders = [];

  for (const s of shapes) {
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(s.x, s.y, s.z);
    const body = world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc
      .cuboid(s.sx / 2, s.sy / 2, s.sz / 2)
      .setCollisionGroups(filter)
      .setFriction(0.85)
      .setRestitution(0.02);
    const collider = world.createCollider(colDesc, body);
    colliders.push({ collider, body, shape: s });
  }
  return colliders;
}

/** 从世界中移除一批碰撞体（重新开局时用） */
export function removeColliders(physics, colliders) {
  if (!physics.world) return;
  const world = physics.world;
  for (const c of colliders) {
    try {
      if (c.body) world.removeRigidBody(c.body);
      // 移除刚体会连带移除其上的 collider；单独创建的 collider 需另行移除
      else if (c.collider) world.removeCollider(c.collider, false);
    } catch { /* 已移除则忽略 */ }
  }
  colliders.length = 0;
}
