/**
 * 武器系统。
 *
 * 职责：决定「这一帧要不要开火、打出几条射线、每条射线打中了什么」。
 * 不负责：渲染弹道、播放音效、扣除敌人血量——这些都是把结果交回给 world.js 之后的事。
 *
 * 射线检测通过传入的 `raycast` 回调完成，因此本模块可在无物理环境下测试。
 */

import { config } from '../config.js';
import { GROUP } from '../physics/world.js';
import { addHeat, currentFireRate, heatMax } from './mech.js';

/** 武器定义 */
export const WEAPONS = {
  pulse: {
    id: 'pulse',
    name: '脉冲炮',
    slot: 'R',
    /** 能量武器：不消耗弹药，只积热 */
    ammo: Infinity,
    cfg: () => config.weapons.pulse,
  },
  scatter: {
    id: 'scatter',
    name: '散射炮',
    slot: 'L',
    cfg: () => config.weapons.scatter,
  },
};

/** 把 yaw 与 pitch 转成单位方向向量（右手系，-Z 为前方） */
export function anglesToDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

/**
 * 在一个锥形范围内随机扰动方向。
 * 用「垂直于主方向的平面内随机偏移」实现，比逐轴加随机数分布更均匀。
 */
function applySpread(dir, spreadRad, rng) {
  if (spreadRad <= 0) return dir;

  // 构造一组与 dir 正交的基向量
  const up = Math.abs(dir.y) > 0.94 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  // right = dir × up
  let rx = dir.y * up.z - dir.z * up.y;
  let ry = dir.z * up.x - dir.x * up.z;
  let rz = dir.x * up.y - dir.y * up.x;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // up2 = right × dir
  const ux = ry * dir.z - rz * dir.y;
  const uy = rz * dir.x - rx * dir.z;
  const uz = rx * dir.y - ry * dir.x;

  // 均匀圆盘采样，保证散布是圆形而非方形
  const r = Math.sqrt(rng()) * Math.tan(spreadRad);
  const theta = rng() * Math.PI * 2;
  const ox = Math.cos(theta) * r;
  const oy = Math.sin(theta) * r;

  const nx = dir.x + rx * ox + ux * oy;
  const ny = dir.y + ry * ox + uy * oy;
  const nz = dir.z + rz * ox + uz * oy;
  const nl = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / nl, y: ny / nl, z: nz / nl };
}

/**
 * 尝试开火。
 *
 * @param {object} mech
 * @param {object} ctx
 * @param {object} ctx.raycast  ({origin, dir, maxToi, group, mask}) => hit|null
 * @param {() => number} ctx.rng
 * @param {boolean} wantFire 本帧是否按下了开火键
 * @param {number} dt
 * @param {number} aimYaw   枪口朝向（通常等于相机 yaw）
 * @param {number} aimPitch
 * @returns {{ fired: boolean, shots: Array<object> }}
 */
export function tryFire(mech, ctx, wantFire, dt, aimYaw, aimPitch) {
  const result = { fired: false, shots: [] };

  if (!mech.alive) return result;
  if (mech.overheated) return result;
  if (mech.weaponCd[mech.weapon] > 0) return result;

  const weaponId = mech.weapon === 0 ? 'pulse' : 'scatter';
  const wdef = WEAPONS[weaponId];
  const w = wdef.cfg();

  // 散射炮需要装弹
  if (weaponId === 'scatter') {
    if (mech.reloading > 0) return result;
    if (mech.shells <= 0) {
      mech.reloading = 1.5 * (mech.mods.reloadTimeMul || 1);
      return result;
    }
  }

  if (!wantFire) {
    // 未开火时连射计数自然回落（由 tickResources 处理），此处只维护冷却
    return result;
  }

  // ── 冷却 ──
  const rate = currentFireRate(mech, w.fireRate);
  mech.weaponCd[mech.weapon] = rate;
  mech.sinceFire = 0;
  mech.burst = Math.min(mech.burst + 1, 24);

  if (weaponId === 'scatter') mech.shells -= 1;

  // ── 计算散布：连射越久越散 ──
  const burstT = Math.min(1, mech.burst / 12);
  let spread;
  if (weaponId === 'pulse') {
    spread = w.spread + (w.spreadMax - w.spread) * burstT * (w.spreadGrowth / 3.4);
    spread = Math.min(spread, w.spreadMax);
  } else {
    spread = w.spread;
  }

  // ── 枪口位置：机甲右肩前方，避免射线从机甲体内出发 ──
  const forward = anglesToDir(mech.yaw, 0);
  const rightX = Math.cos(mech.yaw);
  const rightZ = -Math.sin(mech.yaw);
  const origin = {
    x: mech.pos.x + forward.x * 1.1 + rightX * 0.55,
    y: mech.pos.y + 1.42,
    z: mech.pos.z + forward.z * 1.1 + rightZ * 0.55,
  };

  // ── 逐发投射 ──
  const pelletCount = weaponId === 'scatter'
    ? (w.pellets + (mech.mods.pelletAdd || 0))
    : 1;

  for (let i = 0; i < pelletCount; i++) {
    const base = anglesToDir(aimYaw, aimPitch);
    const dir = applySpread(base, spread, ctx.rng);

    const hit = ctx.raycast({
      origin,
      dir,
      maxToi: w.range,
      group: GROUP.PLAYER,
      mask: GROUP.LEVEL | GROUP.ENEMY,
    });

    let damage = w.damage;
    if (weaponId === 'scatter') damage *= (mech.mods.pelletDamageMul || 1);

    result.shots.push({
      origin: { ...origin },
      dir,
      hit,
      damage,
      /** 射线最远点，用于渲染弹道（未命中时画到射程末端） */
      end: hit
        ? hit.point
        : { x: origin.x + dir.x * w.range, y: origin.y + dir.y * w.range, z: origin.z + dir.z * w.range },
      weapon: weaponId,
    });
  }

  // ── 热量与后坐力 ──
  // 散射炮热量按弹丸数折算，避免单发过热
  const heatPerShot = weaponId === 'pulse'
    ? config.heat.perShot
    : config.heat.perShot * 0.42 * (pelletCount / 7);

  const causedOverheat = addHeat(mech, heatPerShot);
  result.fired = true;
  result.causedOverheat = causedOverheat;
  result.recoil = w.recoil * (causedOverheat ? 1.4 : 1);
  result.weapon = weaponId;

  return result;
}

/**
 * 手动装填（R 键）。
 */
export function tryReload(mech) {
  if (mech.weapon !== 1) return false;
  if (mech.reloading > 0) return false;
  if (mech.shells >= mech.maxShells) return false;
  mech.reloading = 1.5 * (mech.mods.reloadTimeMul || 1);
  return true;
}

/**
 * 把命中信息解析成「打中了什么」。
 *
 * @param {object} shot
 * @param {Map<number, object>} colliderToEnemy 碰撞体 handle → 敌人
 * @returns {{ kind:'enemy'|'world'|'miss', enemy?:object, point:object, normal?:object, damage:number }}
 */
export function resolveShot(shot, colliderToEnemy) {
  if (!shot.hit) {
    return { kind: 'miss', point: shot.end, damage: 0 };
  }
  const handle = shot.hit.collider?.handle;
  const enemy = handle !== undefined ? colliderToEnemy.get(handle) : undefined;

  if (enemy && enemy.alive) {
    return {
      kind: 'enemy',
      enemy,
      point: shot.hit.point,
      normal: shot.hit.normal,
      damage: shot.damage,
    };
  }
  return {
    kind: 'world',
    point: shot.hit.point,
    normal: shot.hit.normal,
    damage: 0,
  };
}
