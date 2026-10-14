/**
 * 机甲（玩家）模拟。
 *
 * 纯逻辑：不 import three，不碰 DOM，不直接访问物理世界。
 * 所有需要物理查询的动作（移动、射线）通过传入的 `physics` 接口完成，
 * 这样测试时可以塞一个假的物理实现。
 *
 * 状态机：
 *   grounded/airborne 由物理判定
 *   dashing 是一个有时限的覆盖状态，期间覆盖水平速度
 *   overheated 是一个锁定状态，期间禁止开火
 */

import { config } from '../config.js';
import { GROUP } from '../physics/world.js';
import { buildMods } from './relics.js';

/** @typedef {{x:number,y:number,z:number}} Vec3 */

/**
 * 创建一个初始机甲状态。
 * @param {{x:number,y:number,z:number}} spawn
 * @returns {object}
 */
export function createMech(spawn = { x: 0, y: 0, z: 0 }) {
  const mods = buildMods([]);
  return {
    // ── 变换 ──
    pos: { x: spawn.x, y: spawn.y, z: spawn.z },
    /** 朝向弧度，绕 Y 轴。0 表示面向 -Z */
    yaw: Math.PI,
    /** 当前水平速度 */
    vel: { x: 0, y: 0, z: 0 },
    /** 上一帧位置，渲染层用于插值 */
    prevPos: { x: spawn.x, y: spawn.y, z: spawn.z },

    // ── 状态 ──
    grounded: false,
    /** 剩余冲刺时间，>0 表示正在冲刺 */
    dashTimer: 0,
    dashCd: 0,
    /** 冲刺方向（单位向量，水平） */
    dashDir: { x: 0, z: 0 },
    /** 冲刺期间是否已对某个敌人造成过伤害（避免一次冲刺反复打同一个） */
    dashHitSet: new Set(),

    // ── 资源 ──
    hp: config.mech.maxHp,
    maxHp: config.mech.maxHp,
    heat: 0,
    overheated: false,
    /** 过热锁定剩余时间 */
    overheatTimer: 0,
    /** 距最后一次开火的时间，用于散热延迟 */
    sinceFire: 99,
    /** 已过去的无敌时间 */
    invulnTimer: 0,
    /** 受击闪烁，渲染层读取 */
    hitFlash: 0,

    // ── 武器 ──
    /** 当前武器槽：0=脉冲炮 1=散射炮 */
    weapon: 0,
    /** 各武器独立冷却 */
    weaponCd: [0, 0],
    /** 散射炮装弹 */
    shells: 8,
    maxShells: 8,
    reloading: 0,
    /** 连续开火计数，用于散布增长 */
    burst: 0,

    // ── 元数据 ──
    alive: true,
    mods,
    /** 已获得的遗物 */
    relics: [],
    /** 累计击杀 */
    kills: 0,
  };
}

/** 重新计算派生数值（拾取遗物后调用） */
export function recalcMech(mech) {
  const m = mech.mods;
  const prevMax = mech.maxHp;
  mech.maxHp = Math.max(20, config.mech.maxHp + (m.maxHpAdd || 0));

  // 最大生命变化时保留当前血量占比，避免拾取「附加装甲」反而掉血。
  // 注意下限是 1 而不是 0：遗物不该把玩家直接算死。
  if (mech.maxHp !== prevMax) {
    const ratio = prevMax > 0 ? mech.hp / prevMax : 1;
    mech.hp = Math.max(1, Math.min(mech.maxHp, Math.round(ratio * mech.maxHp)));
  }

  const newMax = Math.max(1, Math.round(8 + (m.shellAdd || 0)));
  const prevShellMax = mech.maxShells;
  mech.maxShells = newMax;
  if (newMax > prevShellMax) {
    // 弹舱扩容时直接把新增的弹量补给玩家，而不是让弹量比例缩水
    mech.shells = Math.min(newMax, mech.shells + (newMax - prevShellMax));
  } else {
    mech.shells = Math.min(newMax, mech.shells);
  }
}

/** 当前生效的热量上限 */
export function heatMax(mech) {
  return config.heat.max * (mech.mods.heatMaxMul || 1);
}

/** 当前散热速率 */
export function coolRate(mech) {
  const base = mech.overheated ? config.heat.overheatCoolRate : config.heat.coolRate;
  return base * (mech.mods.coolRateMul || 1);
}

/** 冲刺冷却时长（含遗物修正） */
export function dashCooldown(mech) {
  return config.dash.cooldown * (mech.mods.dashCooldownMul || 1);
}

/**
 * 玩家朝向平滑转向目标角度。
 * 机甲不瞬转——这是「重量感」的主要来源之一。
 * @param {object} mech
 * @param {number} targetYaw 目标弧度
 * @param {number} dt
 */
export function turnToward(mech, targetYaw, dt) {
  const speed = config.mech.turnSpeed;
  // 取最短角差，避免绕远路
  let diff = targetYaw - mech.yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;

  const step = speed * dt;
  if (Math.abs(diff) <= step) mech.yaw = targetYaw;
  else mech.yaw += Math.sign(diff) * step;

  // 归一化到 [-π, π]
  while (mech.yaw > Math.PI) mech.yaw -= Math.PI * 2;
  while (mech.yaw < -Math.PI) mech.yaw += Math.PI * 2;
}

/**
 * 施加热量。返回是否因此触发过热。
 * @param {object} mech
 * @param {number} amount 正数加热，负数散热
 */
export function addHeat(mech, amount) {
  if (mech.overheated) return false;
  const max = heatMax(mech);
  mech.heat = Math.max(0, mech.heat + amount);

  if (mech.heat >= max) {
    mech.heat = max;
    mech.overheated = true;
    mech.overheatTimer = config.heat.overheatLockout * (mech.mods.overheatLockoutMul || 1);
    return true;
  }
  return false;
}

/**
 * 每帧的资源恢复：热量、冷却、无敌时间、过热锁定。
 * 从 update 里拆出来，便于单独测试时间相关逻辑。
 * @param {object} mech
 * @param {number} dt
 * @returns {{ justRecovered: boolean }} 过热刚结束
 */
export function tickResources(mech, dt) {
  const wasOverheated = mech.overheated;
  mech.sinceFire += dt;

  // 冲刺冷却
  if (mech.dashCd > 0) mech.dashCd = Math.max(0, mech.dashCd - dt);
  // 无敌时间
  if (mech.invulnTimer > 0) mech.invulnTimer = Math.max(0, mech.invulnTimer - dt);
  // 受击闪烁衰减
  if (mech.hitFlash > 0) mech.hitFlash = Math.max(0, mech.hitFlash - dt * 3.2);

  // 武器冷却
  for (let i = 0; i < mech.weaponCd.length; i++) {
    if (mech.weaponCd[i] > 0) mech.weaponCd[i] = Math.max(0, mech.weaponCd[i] - dt);
  }

  // 装填
  if (mech.reloading > 0) {
    mech.reloading = Math.max(0, mech.reloading - dt);
    if (mech.reloading === 0) {
      mech.shells = mech.maxShells;
      mech.burst = 0;
    }
  }

  // 过热锁定
  if (mech.overheated) {
    mech.overheatTimer = Math.max(0, mech.overheatTimer - dt);
    if (mech.overheatTimer === 0) {
      mech.overheated = false;
      mech.heat = Math.max(0, heatMax(mech) * 0.18);
    }
  } else if (mech.sinceFire > config.heat.coolDelay) {
    // 延迟之后才开始散热
    mech.heat = Math.max(0, mech.heat - coolRate(mech) * dt);
  }

  // 长时间不开火后重置连射计数
  if (mech.sinceFire > 0.55) mech.burst = Math.max(0, mech.burst - dt * 8);

  return { justRecovered: wasOverheated && !mech.overheated };
}

/**
 * 受到伤害。
 * @param {object} mech
 * @param {number} amount
 * @returns {{ applied: boolean, died: boolean, absorbed: boolean }}
 */
export function damageMech(mech, amount) {
  if (!mech.alive) return { applied: false, died: false, absorbed: false };
  // 冲刺无敌（相位冲刺遗物）
  if (mech.dashTimer > 0 && mech.mods.dashInvuln) return { applied: false, died: false, absorbed: true };
  if (mech.invulnTimer > 0) return { applied: false, died: false, absorbed: true };

  mech.hp -= amount;
  mech.invulnTimer = config.mech.invulnTime;
  mech.hitFlash = 1;

  if (mech.hp <= 0) {
    mech.hp = 0;
    mech.alive = false;
    return { applied: true, died: true, absorbed: false };
  }
  return { applied: true, died: false, absorbed: false };
}

/**
 * 计算当前生效的射速间隔（含熵增引擎的随热加速）。
 */
export function currentFireRate(mech, baseRate) {
  let rate = baseRate;
  // 熵增引擎：热量比例越高射速越快
  const scale = mech.mods.heatFirerateScale || 0;
  if (scale > 0) {
    const t = Math.min(1, mech.heat / heatMax(mech));
    rate *= 1 - scale * t;
  }
  rate /= (mech.mods.fireRateMul || 1);
  return Math.max(0.035, rate);
}
