/**
 * 物理世界封装。
 *
 * 职责边界（见设计文档 §4）：
 *   本模块拥有 Rapier 世界、碰撞体与射线查询，但**不拥有任何游戏状态**。
 *   它只回答「从这里移动到这里会被挡住吗」「这条射线打中了什么」。
 *   simulation 决定要不要移动、打中之后发生什么。
 */

import RAPIER from 'rapier';
import { config } from '../config.js';

/**
 * Rapier 的版本号。
 *
 * 注意：不能在模块顶层调用 RAPIER.version()——那时 wasm 尚未 init，
 * 内部绑定还是 undefined，会抛 TypeError 并让整个模块加载失败。
 * 因此这里初始为 null，由 PhysicsWorld.init() 在 init 之后填入。
 */
export let RAPIER_VERSION = null;

/** 碰撞分组：用位掩码区分实体类别，避免不必要的碰撞对 */
export const GROUP = {
  /** 静态关卡几何 */
  LEVEL: 0b0001,
  /** 玩家机甲 */
  PLAYER: 0b0010,
  /** 敌人 */
  ENEMY: 0b0100,
  /** 投射物（导弹等实体弹，不是 hitscan） */
  PROJECTILE: 0b1000,
};

/**
 * 生成一个碰撞过滤掩码。
 * @param {number} group 自身所属类别
 * @param {number} mask  与之碰撞的类别
 */
export const membership = (group, mask) => (group << 16) | mask;

export class PhysicsWorld {
  constructor() {
    this.world = null;
    /** 累加器，用于固定步长 */
    this._accumulator = 0;
    /** 本帧的事件队列（碰撞开始/结束），在 step 后清空 */
    this.events = { collisions: [], contacts: [] };
    /** 射线命中结果复用对象，避免每帧分配 */
    this._rayHit = null;
  }

  async init() {
    // rapier3d-compat 需要先显式初始化 wasm（内嵌 base64，无外部文件）
    await RAPIER.init();
    // init 之后才能安全读取版本号
    try { RAPIER_VERSION = RAPIER.version(); } catch { RAPIER_VERSION = 'unknown'; }

    this.world = new RAPIER.World({ x: 0, y: -config.mech.gravity, z: 0 });
    this.world.timestep = config.world.fixedStep;
    this._rayHit = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    return this;
  }

  /**
   * 以固定步长推进世界。
   * @param {number} dt 真实帧耗时
   * @returns {number} 实际推进了多少个物理步
   */
  step(dt) {
    const fixed = config.world.fixedStep;
    this._accumulator += Math.min(dt, 0.25);
    let steps = 0;
    this.events.collisions.length = 0;

    while (this._accumulator >= fixed && steps < config.world.maxSubSteps) {
      this.world.step(this._buildEventQueue());
      this._accumulator -= fixed;
      steps += 1;
    }

    // 补算次数用尽仍有剩余：丢弃，避免卡顿后物理爆炸
    if (steps >= config.world.maxSubSteps) this._accumulator = 0;
    return steps;
  }

  _buildEventQueue() {
    if (!this._eq) {
      this._eq = new RAPIER.EventQueue(true);
    }
    // 收集碰撞开始事件
    this._eq.drainCollisionEvents((h1, h2, started) => {
      if (started) this.events.collisions.push({ h1, h2 });
    });
    return this._eq;
  }

  /**
   * 沿路径移动一个胶囊体，返回被约束后的落地位置。
   *
   * 这是玩家与敌人的共用移动原语。使用 Rapier 的 shape cast + 迭代滑动，
   * 而不是简单的位置修正，这样贴墙滑行和上台阶才不会卡住。
   *
   * @param {object} p
   * @param {{x:number,y:number,z:number}} p.position 当前胶囊体底部位置
   * @param {{x:number,y:number,z:number}} p.motion   本步期望位移
   * @param {number} p.radius
   * @param {number} p.height 圆柱段高度
   * @param {number} p.group  自身碰撞组
   * @param {number} p.mask   与之碰撞的组掩码
   * @param {number} p.maxSlides 最多滑动几次
   * @returns {{position:{x,y,z}, grounded:boolean, normal:{x,y,z}}}
   */
  moveCapsule({ position, motion, radius, height, group, mask, maxSlides = 6 }) {
    const shape = this._capsuleShape(radius, height);
    const filter = membership(group, mask);

    // 胶囊体几何中心相对「脚底位置」的偏移。
    // Rapier 的 Capsule(halfHeight, radius) 总高 = 2*halfHeight + 2*radius，
    // 因此中心到脚底的距离正好是 halfHeight + radius。
    const centerOffset = (height / 2) + radius;

    let pos = { x: position.x, y: position.y, z: position.z };
    let remaining = { x: motion.x, y: motion.y, z: motion.z };
    let grounded = false;
    let lastNormal = { x: 0, y: 1, z: 0 };

    const rot = { x: 0, y: 0, z: 0, w: 1 };

    // 起始即穿透的处理上限。防止在极深的穿透里无限推挤。
    let pushBudget = 4;

    for (let i = 0; i < maxSlides; i++) {
      const len = Math.hypot(remaining.x, remaining.y, remaining.z);

      // 绝不能因为「位移很小」就跳过查询。
      // 静止站在地板上时单步垂直位移只有 gravity×dt² ≈ 0.007m，
      // 一旦早退，grounded 会永远停在初始的 false。
      if (len < 1e-7) {
        // 没有剩余位移，但仍需确认脚下是否有支撑——用一次微小下垂探测。
        if (!grounded && pushBudget > 0) {
          const probe = this._probeGround(pos, centerOffset, rot, shape, filter);
          if (probe) {
            grounded = true;
            lastNormal = probe.normal;
            pos = probe.position;
          }
        }
        break;
      }

      const origin = { x: pos.x, y: pos.y + centerOffset, z: pos.z };
      const dir = { x: remaining.x / len, y: remaining.y / len, z: remaining.z / len };

      const hit = this.world.castShape(
        origin, rot, dir, shape,
        0,                      // targetDistance：提前 0 距离即算命中
        len,                    // maxToi（dir 已归一化，故 len 即最远距离）
        false,                  // stopAtPenetration
        undefined,              // filterFlags
        filter,                 // filterGroups
        undefined, undefined, undefined,
      );

      if (!hit || hit.time_of_impact === undefined || hit.time_of_impact === null) {
        pos = { x: pos.x + remaining.x, y: pos.y + remaining.y, z: pos.z + remaining.z };
        // 走完剩余路程后，若这是最后一步，补一次支撑探测
        if (!grounded && i === maxSlides - 1) {
          const probe = this._probeGround(pos, centerOffset, rot, shape, filter);
          if (probe) { grounded = true; lastNormal = probe.normal; pos = probe.position; }
        }
        // 不是最后一步的话，剩余路程已走完，可以结束
        break;
      }

      const toi = hit.time_of_impact;
      const n = this._extractNormal(hit, dir);
      lastNormal = n;

      // ── 关键分支：起始位置已经穿透 ──
      // Rapier 在这种情况下返回 toi = 0。若照常推进（推进 0 距离）并只把
      // 剩余位移投影到切平面，位置永远不变，而法线又可能不是竖直的
      // （斜靠掩体、或胶囊本就在地面里），于是 grounded 判不出来、
      // 移动完全失效——表现为角色站着不动、重力累积却不下落。
      // 正确做法是沿法线把胶囊推出穿透区，再继续求解。
      if (toi < 1e-6) {
        if (pushBudget > 0) {
          pushBudget--;
          // 沿法线推出一小段。真实穿透深度 Rapier 未直接给出，
          // 用一个与尺寸相关的保守值，配合下一次迭代逐步收敛。
          const push = Math.max(0.008, radius * 0.35);
          pos = {
            x: pos.x + n.x * push,
            y: pos.y + n.y * push,
            z: pos.z + n.z * push,
          };
          // 法线朝上即视为踩到地面
          if (n.y > 0.62) grounded = true;
          // 把剩余位移投影到切平面，继续沿表面滑行
          const dot = remaining.x * n.x + remaining.y * n.y + remaining.z * n.z;
          remaining = {
            x: remaining.x - dot * n.x,
            y: remaining.y - dot * n.y,
            z: remaining.z - dot * n.z,
          };
          continue;
        }
        break;
      }

      // ── 正常的光滑推进 ──
      const t = Math.max(0, toi - 1e-4);
      pos = { x: pos.x + dir.x * len * t, y: pos.y + dir.y * len * t, z: pos.z + dir.z * len * t };

      if (n.y > 0.62) grounded = true;

      const dot = remaining.x * n.x + remaining.y * n.y + remaining.z * n.z;
      remaining = {
        x: remaining.x - dot * n.x,
        y: remaining.y - dot * n.y,
        z: remaining.z - dot * n.z,
      };

      if (Math.hypot(remaining.x, remaining.y, remaining.z) < 1e-5) break;
    }

    return { position: pos, grounded, normal: lastNormal };
  }

  /**
   * 向下探测支撑。
   *
   * 存在理由：角色静止站在地面上时，垂直位移只有 gravity×dt² ≈ 0.007m，
   * 与地面法线的投影会让这一小段位移在数值上被吃掉，导致 grounded 判为 false。
   * 单独做一次固定距离的下垂探测，可以稳定地判定「脚下有没有东西」。
   *
   * @returns {{position:{x,y,z}, normal:{x,y,z}}|null}
   */
  _probeGround(pos, centerOffset, rot, shape, filter) {
    const dist = Math.max(0.02, centerOffset * 0.02);
    const origin = { x: pos.x, y: pos.y + centerOffset, z: pos.z };
    const dir = { x: 0, y: -1, z: 0 };

    const hit = this.world.castShape(
      origin, rot, dir, shape,
      0, dist, false,
      undefined, filter, undefined, undefined, undefined,
    );
    if (!hit || hit.time_of_impact === undefined || hit.time_of_impact === null) return null;

    const n = this._extractNormal(hit, dir);
    // 只有朝上的面才算「站得住」
    if (n.y <= 0.62) return null;

    // 把胶囊贴着地面放下：中心高度 = 地面 + centerOffset
    const surfaceY = origin.y - hit.time_of_impact;
    return {
      position: { x: pos.x, y: surfaceY - centerOffset + 1e-4, z: pos.z },
      normal: n,
    };
  }

  /**
   * 从 castShape 的结果里取出**朝外的表面法线**。
   *
   * 这里有个必须绕开的坑：castShape 返回两个法线，
   *   normal1 = 投射体自身接触点上的法线
   *   normal2 = 被撞碰撞体接触点上的法线
   * 两者方向相反，而 Rapier 并不保证哪个朝外。若固定取 normal1，
   * 命中地板时可能拿到 (0,-1,0)，于是 n.y = -1 不满足「朝上」的判定，
   * grounded 永远是 false —— 表现为角色站着却悬空、无法跳跃。
   *
   * 稳健做法：取与运动方向**点积最负**的那个。法线必然逆着来向，
   * 这一判据不依赖 Rapier 的内部约定，换版本也不会失效。
   *
   * @param {object} hit castShape 的返回值
   * @param {{x:number,y:number,z:number}} [dir] 本次投射的方向（应已归一化）
   */
  _extractNormal(hit, dir) {
    const cands = [hit.normal1, hit.normal2];
    const valid = [];
    for (const c of cands) {
      if (!c) continue;
      const len = Math.hypot(c.x, c.y, c.z);
      if (len > 1e-6) valid.push({ x: c.x / len, y: c.y / len, z: c.z / len });
    }
    if (valid.length === 0) return { x: 0, y: 1, z: 0 };
    if (valid.length === 1) return valid[0];

    // 有方向信息时按「逆着来向」挑选
    if (dir) {
      const d0 = valid[0].x * dir.x + valid[0].y * dir.y + valid[0].z * dir.z;
      const d1 = valid[1].x * dir.x + valid[1].y * dir.y + valid[1].z * dir.z;
      return d1 < d0 ? valid[1] : valid[0];
    }
    return valid[0];
  }

  _capsuleShape(radius, height) {
    // 胶囊形状按尺寸缓存。
    // moveCapsule 每帧对每个实体调用一次，如果每次都 new 一个 Capsule，
    // 60fps × 十几个实体会持续分配 wasm 堆内存——Rapier 的 wasm 堆不会自动回收，
    // 表现为运行几分钟后越来越卡。缓存后每个尺寸只建一次。
    const key = `${radius.toFixed(3)}:${height.toFixed(3)}`;
    if (!this._shapeCache) this._shapeCache = new Map();
    let shape = this._shapeCache.get(key);
    if (!shape) {
      // Rapier 的 Capsule(halfHeight, radius)
      shape = new RAPIER.Capsule(height / 2, radius);
      this._shapeCache.set(key, shape);
    }
    return shape;
  }

  /**
   * 射线检测：用于枪械 hitscan、相机防穿墙、敌人视线。
   *
   * @param {object} p
   * @param {{x,y,z}} p.origin
   * @param {{x,y,z}} p.dir    必须已归一化
   * @param {number} p.maxToi  最远距离
   * @param {number} p.group
   * @param {number} p.mask
   * @returns {{toi:number, point:{x,y,z}, normal:{x,y,z}, collider:any}|null}
   */
  raycast({ origin, dir, maxToi, group = GROUP.PLAYER, mask = GROUP.LEVEL | GROUP.ENEMY }) {
    const ray = this._rayHit;
    ray.origin = { x: origin.x, y: origin.y, z: origin.z };
    ray.dir = { x: dir.x, y: dir.y, z: dir.z };

    const hit = this.world.castRayAndGetNormal(
      ray, maxToi, true,
      undefined,               // filterFlags
      membership(group, mask), // filterGroups
      undefined,               // filterExcludeCollider
      undefined,               // filterExcludeRigidBody
      undefined,               // filterPredicate
    );

    if (!hit) return null;

    const toi = hit.time_of_impact;
    const n = hit.normal ?? { x: 0, y: 1, z: 0 };
    return {
      toi,
      point: {
        x: origin.x + dir.x * toi,
        y: origin.y + dir.y * toi,
        z: origin.z + dir.z * toi,
      },
      normal: { x: n.x, y: n.y, z: n.z },
      collider: hit.collider,
    };
  }

  /** 回收 shape 对象（Rapier wasm 内存需手动释放，否则长时间运行会涨） */
  disposeShape(shape) {
    try { shape?.free?.(); } catch { /* 已释放则忽略 */ }
  }

  /**
   * 释放世界及其所有资源。用于重新开局——不释放会泄漏 wasm 线性内存。
   */
  dispose() {
    if (this._eq) { try { this._eq.free(); } catch {} this._eq = null; }
    if (this.world) { try { this.world.free(); } catch {} this.world = null; }
  }
}
