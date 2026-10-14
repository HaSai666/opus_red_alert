/**
 * 敌人类型表。
 *
 * 每种类型是一个纯数据描述 + 一个行为函数。行为函数签名统一为
 *   (enemy, ctx, dt) => void
 * 其中 ctx 提供只读的世界查询与副作用回调（开火、播放特效）。
 *
 * 设计约束：行为函数内不做射线检测——射线是物理层的活，由 ctx.raycast 提供。
 * 这样敌人 AI 可以在无物理环境的测试中运行。
 */

import { config } from '../config.js';

/** @typedef {'charger'|'ranged'|'heavy'} EnemyKind */

/**
 * @typedef {object} EnemyType
 * @property {EnemyKind} kind
 * @property {string} name
 * @property {number} hp
 * @property {number} radius
 * @property {number} height
 * @property {number} speed
 * @property {number} accel
 * @property {number} damage
 * @property {number} color       渲染层用的主色（0xRRGGBB）
 * @property {number} [attackRange]
 * @property {number} [preferredRange]
 * @property {number} [attackCooldown]
 * @property {number} [projectileSpeed]
 * @property {(e:any, ctx:any, dt:number)=>void} think
 */

/** 两点水平距离 */
function dist2(a, b) {
  return Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
}

/** 从 a 指向 b 的水平单位向量 */
function dirTo(a, b) {
  const dx = b.pos.x - a.pos.x;
  const dz = b.pos.z - a.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len, yaw: Math.atan2(dx, dz) };
}

/** @type {Record<EnemyKind, EnemyType>} */
export const ENEMY_TYPES = {
  /**
   * 冲锋型：直冲玩家，近身自爆式攻击。
   * 作用是施加空间压力，逼玩家移动而不是站桩输出。
   */
  charger: {
    kind: 'charger',
    name: '突袭机',
    hp: 42,
    radius: 0.46,
    height: 1.5,
    speed: 7.2,
    accel: 34,
    damage: 14,
    color: 0xe8664a,
    attackRange: 2.3,
    attackCooldown: 1.1,
    think(e, ctx, dt) {
      const d = dirTo(e, ctx.player);
      const dist = dist2(e, ctx.player);

      // 目标朝向：始终看玩家
      ctx.faceYaw(e, d.yaw, dt, 7.5);

      if (e.attackCd > 0) e.attackCd -= dt;

      if (dist > (this.attackRange ?? 2.3)) {
        // 冲向玩家；接近时略微加速，制造压迫感
        const boost = dist < 7 ? 1.22 : 1.0;
        ctx.moveToward(e, d.x, d.z, this.speed * boost, this.accel, dt);
      } else {
        // 进入攻击距离：停下并攻击
        ctx.brake(e, dt);
        if (e.attackCd <= 0) {
          e.attackCd = this.attackCooldown ?? 1.1;
          ctx.meleeAttack(e, this.damage);
        }
      }
    },
  },

  /**
   * 远程型：保持距离射击。
   * 作用是惩罚站桩，逼玩家利用掩体推进。
   */
  ranged: {
    kind: 'ranged',
    name: '射手机',
    hp: 34,
    radius: 0.44,
    height: 1.7,
    speed: 4.4,
    accel: 22,
    damage: 9,
    color: 0xa07dd6,
    attackRange: 26,
    preferredRange: 13,
    attackCooldown: 1.75,
    projectileSpeed: 32,
    think(e, ctx, dt) {
      const d = dirTo(e, ctx.player);
      const dist = dist2(e, ctx.player);

      ctx.faceYaw(e, d.yaw, dt, 5.5);

      if (e.attackCd > 0) e.attackCd -= dt;

      const preferred = this.preferredRange ?? 13;
      const band = 3.2; // 在 preferred ± band 内视为理想距离

      if (dist > preferred + band) {
        ctx.moveToward(e, d.x, d.z, this.speed, this.accel, dt);
      } else if (dist < preferred - band) {
        // 太近：后退，同时侧移，避免直线后退被追死
        const side = e.strafeDir;
        ctx.moveToward(e, -d.x * 0.72 + side * 0.68, -d.z * 0.72 + (-side) * 0.68 * 0, this.speed, this.accel, dt);
      } else {
        // 理想距离：横向游走（strafe），制造瞄准难度
        ctx.moveToward(e, -d.z * e.strafeDir, d.x * e.strafeDir, this.speed * 0.82, this.accel * 0.8, dt);
      }

      // 射程内且大致朝向玩家时开火
      if (dist <= (this.attackRange ?? 26) && e.attackCd <= 0 && ctx.hasLineOfSight(e, ctx.player)) {
        e.attackCd = this.attackCooldown ?? 1.75;
        ctx.fireProjectile(e, this.projectileSpeed ?? 32, this.damage);
      }
    },
  },

  /**
   * 重型：血厚、移动慢、发射三连散射。
   * 作为房间里的「锚点」，逼玩家做目标优先级决策。
   */
  heavy: {
    kind: 'heavy',
    name: '重装机',
    hp: 130,
    radius: 0.78,
    height: 2.7,
    speed: 2.9,
    accel: 13,
    damage: 11,
    color: 0xe8a84a,
    attackRange: 30,
    preferredRange: 16,
    attackCooldown: 2.6,
    projectileSpeed: 26,
    think(e, ctx, dt) {
      const d = dirTo(e, ctx.player);
      const dist = dist2(e, ctx.player);

      ctx.faceYaw(e, d.yaw, dt, 3.2);

      if (e.attackCd > 0) e.attackCd -= dt;

      const preferred = this.preferredRange ?? 16;
      if (dist > preferred + 2.5) {
        ctx.moveToward(e, d.x, d.z, this.speed, this.accel, dt);
      } else if (dist < preferred - 4.5) {
        ctx.moveToward(e, -d.x, -d.z, this.speed * 0.7, this.accel * 0.7, dt);
      } else {
        ctx.brake(e, dt);
      }

      if (dist <= (this.attackRange ?? 30) && e.attackCd <= 0 && ctx.hasLineOfSight(e, ctx.player)) {
        e.attackCd = this.attackCooldown ?? 2.6;
        // 三连扇形：一次发三枚带角度偏移的弹
        for (const spread of [-0.18, 0, 0.18]) {
          ctx.fireProjectile(e, this.projectileSpeed ?? 26, this.damage, spread);
        }
      }
    },
  },
};

/**
 * 按房间进度选择敌人构成。
 * 前面的房间只有冲锋型，逐步引入远程和重型，形成难度曲线。
 *
 * @param {number} roomIndex 0 起的房间序号
 * @param {number} roomsTotal
 * @param {import('../physics/level.js').Rng} rng
 * @returns {EnemyKind[]}
 */
export function rollEnemyComposition(roomIndex, roomsTotal, rng, count) {
  const t = roomsTotal > 1 ? roomIndex / (roomsTotal - 1) : 1;
  const kinds = [];

  for (let i = 0; i < count; i++) {
    const roll = rng.next();
    let kind;
    if (t < 0.25) {
      // 第一间：纯冲锋，教会玩家移动
      kind = 'charger';
    } else if (t < 0.55) {
      kind = roll < 0.62 ? 'charger' : 'ranged';
    } else {
      if (roll < 0.44) kind = 'charger';
      else if (roll < 0.82) kind = 'ranged';
      else kind = 'heavy';
    }
    kinds.push(kind);
  }

  // 保证后期房间至少有一个重型，否则缺乏压力点
  if (t > 0.6 && !kinds.includes('heavy')) {
    kinds[rng.int(0, kinds.length - 1)] = 'heavy';
  }
  return kinds;
}

/**
 * 创建一个敌人实例。
 * @param {EnemyKind} kind
 * @param {{x:number,y:number,z:number}} spawn
 * @param {number} id
 */
export function createEnemy(kind, spawn, id) {
  const type = ENEMY_TYPES[kind];
  const maxHp = type.hp;
  return {
    id,
    kind,
    type,
    alive: true,

    pos: { x: spawn.x, y: spawn.y, z: spawn.z },
    prevPos: { x: spawn.x, y: spawn.y, z: spawn.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    grounded: false,

    hp: maxHp,
    maxHp,
    /** 受击硬直剩余时间，>0 时不执行 think */
    stun: 0,
    /** 受击闪烁，渲染层读取 */
    hitFlash: 0,
    /** 攻击冷却 */
    attackCd: 0.4 + Math.random() * 0.9,
    /** 横向游走方向，随机初始化为 ±1 */
    strafeDir: Math.random() < 0.5 ? -1 : 1,
    /** 游走换向计时 */
    strafeTimer: 1.5 + Math.random() * 2.5,

    /** 死亡后残骸保留倒计时 */
    corpseTimer: 0,
    /** 被 EMP 瘫痪的剩余时间 */
    disabled: 0,
  };
}
