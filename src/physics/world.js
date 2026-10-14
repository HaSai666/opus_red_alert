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
  moveCapsule({ position, motion, radius, height, group, mask, maxSlides = 4 }) {
    const shape = this._capsuleShape(radius, height);
    const filter = membership(group, mask);

    let pos = { x: position.x, y: position.y, z: position.z };
    let remaining = { x: motion.x, y: motion.y, z: motion.z };
    let grounded = false;
    let lastNormal = { x: 0, y: 1, z: 0 };

    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const centerOffset = (height / 2) + radius;

    for (let i = 0; i < maxSlides; i++) {
      const len = Math.hypot(remaining.x, remaining.y, remaining.z);

      // 绝不能因为「位移很小」就跳过查询。
      // 静止站在地板上时，单步垂直位移只有 gravity×dt² ≈ 0.007m；
      // 若在此处早退，grounded 会一直停留在初始的 false，
      // 表现为角色悬空、无法跳跃、相机抖动。
      // 因此这里只挡真正的零位移，其余一律交给 castShape。
      if (len < 1e-7) break;

      // 胶囊体几何中心相对底部位置的偏移
      const origin = { x: pos.x, y: pos.y + centerOffset, z: pos.z };
      const dir = { x: remaining.x / len, y: remaining.y / len, z: remaining.z / len };

      // Rapier 0.14 的精确签名（顺序极易搞错，务必对照）：
      //   castShape(shapePos, shapeRot, shapeVel, shape,
      //             targetDistance, maxToi, stopAtPenetration,
      //             filterFlags, filterGroups, filterExcludeCollider,
      //             filterExcludeRigidBody, filterPredicate)
      // 关键点：shapeVel 与 maxToi 配合决定最远距离（vel 的方向即投射方向，
      // 长度即速度）；漏掉 targetDistance 会让后续所有参数错位，
      // maxToi 收到 0 → 恒不命中 → 实体穿过地板自由落体。
      const hit = this.world.castShape(
        origin,                 // shapePos
        rot,                    // shapeRot
        dir,                    // shapeVel（direction × 1，故 maxToi 即距离）
        shape,                  // shape
        0,                      // targetDistance：提前 0 距离即算命中
        len,                    // maxToi
        true,                   // stopAtPenetration
        undefined,              // filterFlags
        filter,                 // filterGroups
        undefined, undefined, undefined,
      );

      if (!hit || hit.time_of_impact === null || hit.time_of_impact === undefined) {
        // 畅通：走完剩余路程
        pos = { x: pos.x + remaining.x, y: pos.y + remaining.y, z: pos.z + remaining.z };
        break;
      }

      const t = Math.max(0, hit.time_of_impact - 1e-4);
      pos = { x: pos.x + dir.x * len * t, y: pos.y + dir.y * len * t, z: pos.z + dir.z * len * t };

      // 不同 Rapier 版本把法线放在 normal1 / normal2，或在 witness1 / witness2.intSeg
      const n = this._extractNormal(hit);
      lastNormal = n;

      // 法线朝上的面视为地面
      if (n.y > 0.62) grounded = true;

      // 把剩余位移投影到切平面，形成贴墙滑行
      const dot = remaining.x * n.x + remaining.y * n.y + remaining.z * n.z;
      remaining = {
        x: remaining.x - dot * n.x,
        y: remaining.y - dot * n.y,
        z: remaining.z - dot * n.z,
      };

      // 移除朝墙内的分量后若几乎不动，就是卡住了，直接退出
      if (Math.hypot(remaining.x, remaining.y, remaining.z) < 1e-4) break;
    }

    return { position: pos, grounded, normal: lastNormal };
  }

  /**
   * 从 castShape 的结果里取出碰撞法线。
   *
   * Rapier 各版本把法线放在不同字段：0.11 起用 normal1/normal2，
   * 更早的版本用 witness1/witness2。逐级回退，避免因版本差异导致
   * 「法线恒为向上」→ 贴墙滑行和地面判定全部失效。
   */
  _extractNormal(hit) {
    const cands = [
      hit.normal1, hit.normal2,
      hit.witness1?.intSeg, hit.witness2?.intSeg,
    ];
    for (const c of cands) {
      if (c && (c.x !== 0 || c.y !== 0 || c.z !== 0)) {
        const len = Math.hypot(c.x, c.y, c.z);
        if (len > 1e-6) return { x: c.x / len, y: c.y / len, z: c.z / len };
      }
    }
    return { x: 0, y: 1, z: 0 };
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
