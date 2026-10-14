/**
 * 模拟世界：游戏规则的唯一收敛点。
 *
 * 本模块持有全部游戏状态，产出每帧只读快照供渲染层消费。
 * 严禁在这里 import three 或触碰 DOM（设计文档 §4 的红线）。
 *
 * 依赖注入的物理接口 `phys` 需要提供：
 *   moveCapsule({position, motion, radius, height, group, mask})
 *   raycast({origin, dir, maxToi, group, mask})
 *   step(dt)
 * 这样在测试中可以替换成桩实现。
 */

import { config } from '../config.js';
import { GROUP } from '../physics/world.js';
import { Rng, generateRoom } from '../physics/level.js';
import {
  ENEMY_TYPES, createEnemy, rollEnemyComposition,
} from './enemies.js';
import {
  createMech, tickResources, turnToward, addHeat, damageMech,
  heatMax, dashCooldown, recalcMech,
} from './mech.js';
import { tryFire, tryReload, resolveShot, anglesToDir } from './weapons.js';
import { buildMods, rollRelics } from './relics.js';

/** 敌人移动用的碰撞组掩码 */
const ENEMY_GROUP = GROUP.ENEMY;
const ENEMY_MASK = GROUP.LEVEL | GROUP.PLAYER;

/** 玩家移动用的掩码 */
const PLAYER_MASK = GROUP.LEVEL | GROUP.ENEMY;

export class Simulation {
  /**
   * @param {object} phys 物理接口
   * @param {number} seed
   */
  constructor(phys, seed = 12345) {
    this.phys = phys;
    this.seed = seed;
    this.rng = new Rng(seed);
    /** 开火散布需要一个 [0,1) 随机源 */
    this.rand = () => this.rng.next();

    /** 当前关卡几何（只读，渲染层建网格用） */
    this.room = null;
    this.colliders = [];

    this.mech = createMech();
    /** @type {object[]} */
    this.enemies = [];
    /** @type {object[]} */
    this.projectiles = [];
    /** 掉落物（奇点核心） */
    this.orbs = [];

    /** 0 起的当前房间序号 */
    this.roomIndex = 0;
    /** 状态机：'playing' | 'relic-choice' | 'dead' | 'cleared' */
    this.phase = 'playing';
    /** 待选择的遗物候选 */
    this.relicChoices = [];
    /** 本帧产生的事件，渲染层消费后清空 */
    this.events = [];

    /** 相机朝向由输入驱动，存在这里因为开火方向依赖它 */
    this.aim = { yaw: Math.PI, pitch: 0 };

    /** 累计统计 */
    this.stats = { kills: 0, rooms: 0 };

    /** 用于渲染的冷却提示 */
    this.boosts = [];

    this._nextEnemyId = 1;
    this._elapsed = 0;
  }

  // ══════════════════════════════════════════════════════════
  // 生命周期
  // ══════════════════════════════════════════════════════════

  /** 开始新的一局 */
  startNewRun() {
    this.mech = createMech();
    this.mech.mods = buildMods([]);
    recalcMech(this.mech);
    this.mech.hp = this.mech.maxHp;
    this.roomIndex = 0;
    this.phase = 'playing';
    this.stats = { kills: 0, rooms: 0 };
    this.projectiles.length = 0;
    this.orbs.length = 0;
    this.events.length = 0;
    this._nextEnemyId = 1;
    this._elapsed = 0;
    this.aim.pitch = 0;

    this.loadRoom(0);
    this.pushEvent({ type: 'run-start' });
  }

  /**
   * 装载指定序号的房间。
   * 房间序号决定：是否 Boss 房、敌人构成、门在哪个方向。
   */
  loadRoom(index) {
    const total = config.world.roomsPerRun;
    this.roomIndex = index;
    const isBoss = index >= total - 1;

    // 门的方向：随房间序号轮转，让每间的入场方向不同
    const sides = ['N', 'E', 'S', 'W'];
    const doorSide = isBoss ? null : sides[index % 4];

    // 门在 N 侧时，玩家从 N 侧进入，房间应整体向玩家前进方向铺开
    const roomSeed = this.seed + index * 7919;

    const room = generateRoom({
      seed: roomSeed,
      doorSide,
      originX: 0,
      originZ: 0,
      isBoss,
    });

    // 移除上一间的碰撞体，避免内存与性能泄漏
    if (this._removeColliders) this._removeColliders();
    this.room = room;
    this._removeColliders = () => {};

    // ── 玩家落位 ──
    const ps = room.playerSpawn;
    this.mech.pos = { x: ps.x, y: 0.2, z: ps.z };
    this.mech.prevPos = { ...this.mech.pos };
    this.mech.vel = { x: 0, y: 0, z: 0 };
    this.mech.heat = 0;
    this.mech.overheated = false;
    this.mech.overheatTimer = 0;
    this.mech.dashTimer = 0;
    this.mech.dashCd = 0;
    this.mech.shells = this.mech.maxShells;
    this.mech.reloading = 0;

    // 朝向房间中心
    const toCenter = Math.atan2(-ps.x, -ps.z);
    this.mech.yaw = toCenter;
    this.aim.yaw = toCenter;

    // ── 生成敌人 ──
    this.enemies.length = 0;
    this.projectiles.length = 0;
    this.orbs.length = 0;

    if (isBoss) {
      this._spawnBossRoom(room);
    } else {
      const kinds = rollEnemyComposition(index, total, this.rng, room.spawnPoints.length);
      room.spawnPoints.forEach((sp, i) => {
        const kind = kinds[i % kinds.length];
        const e = createEnemy(kind, { x: sp.x, y: 0.3, z: sp.z }, this._nextEnemyId++);
        e.yaw = Math.atan2(this.mech.pos.x - sp.x, this.mech.pos.z - sp.z);
        this.enemies.push(e);
      });
    }

    this.phase = 'playing';
    this.stats.rooms = index + 1;
    this.pushEvent({ type: 'room-enter', index, isBoss, total });
  }

  /**
   * Boss 房：一个放大的重型单位 + 少量护卫。
   * 用数值放大而非引入新资产，符合「零美术成本」约束。
   */
  _spawnBossRoom(room) {
    const bossSpawn = { x: 0, y: 0.4, z: -8 };
    const boss = createEnemy('heavy', bossSpawn, this._nextEnemyId++);
    // 放大：血量、体型、伤害全部提升
    boss.isBoss = true;
    boss.maxHp = 620;
    boss.hp = 620;
    boss.scale = 2.15;
    boss.type = { ...boss.type, damage: 20, attackCooldown: 1.5, speed: 3.6, attackRange: 40 };
    this.enemies.push(boss);

    // 护卫
    const guards = room.spawnPoints.slice(0, 4);
    for (const sp of guards) {
      const e = createEnemy('ranged', { x: sp.x, y: 0.3, z: sp.z }, this._nextEnemyId++);
      this.enemies.push(e);
    }
  }

  pushEvent(ev) { this.events.push(ev); }

  // ══════════════════════════════════════════════════════════
  // 主循环
  // ══════════════════════════════════════════════════════════

  /**
   * 推进一帧。
   * @param {number} dt 秒
   * @param {object} input 语义化输入
   * @param {{x:number,y:number}} input.move 移动轴 [-1,1]
   * @param {number} input.aimDX 鼠标水平位移（原始像素）
   * @param {number} input.aimDY 鼠标垂直位移
   * @param {boolean} input.fire
   * @param {boolean} input.dash
   * @param {boolean} input.jump
   * @param {boolean} input.reload
   * @param {boolean} input.swap
   * @param {number} [input.wheel] 滚轮
   * @param {boolean} input.enabled 输入是否有效（暂停时为 false）
   */
  update(dt, input) {
    this._elapsed += dt;
    this.mech.prevPos = { ...this.mech.pos };
    for (const e of this.enemies) e.prevPos = { ...e.pos };

    if (this.phase === 'dead') {
      this._updateCorpses(dt);
      return;
    }
    if (this.phase === 'relic-choice') {
      // 遗物界面打开时世界静止，但仍推进残骸淡出与特效
      this._updateCorpses(dt);
      return;
    }

    // ── 相机朝向由输入直接驱动（不受机甲转向限制） ──
    if (input.enabled) {
      const sens = config.camera.sensitivity * 0.0022;
      this.aim.yaw -= input.aimDX * sens;
      this.aim.pitch -= input.aimDY * sens;
      this.aim.pitch = Math.max(config.camera.pitchMin, Math.min(config.camera.pitchMax, this.aim.pitch));
      while (this.aim.yaw > Math.PI) this.aim.yaw -= Math.PI * 2;
      while (this.aim.yaw < -Math.PI) this.aim.yaw += Math.PI * 2;

      if (input.swap) {
        this.mech.weapon = this.mech.weapon === 0 ? 1 : 0;
        this.mech.burst = 0;
      }
      if (input.wheel) {
        this.mech.weapon = ((this.mech.weapon + (input.wheel > 0 ? 1 : -1)) % 2 + 2) % 2;
        this.mech.burst = 0;
      }
      if (input.reload) tryReload(this.mech);
    }

    this._updateMech(dt, input);
    this._updateEnemies(dt);
    this._updateProjectiles(dt);
    this._updateOrbs(dt);
    this._checkRoomClear();
  }

  // ── 玩家 ───────────────────────────────────────────────

  _updateMech(dt, input) {
    const mech = this.mech;
    if (!mech.alive) return;

    // 资源与计时
    const { justRecovered } = tickResources(mech, dt);
    if (justRecovered) {
      this.pushEvent({ type: 'heat-recovered' });
      // 过载核心：过热结束时释放 EMP
      if (mech.mods.overheatEmp) this._fireEmp(mech);
    }
    const wasOverheated = mech.overheated;

    // ── 冲刺 ──
    let dashing = mech.dashTimer > 0;
    if (dashing) {
      mech.dashTimer -= dt;
      if (mech.dashTimer <= 0) {
        // 冲刺结束：保留部分速度
        mech.vel.x *= config.dash.exitSpeedMul;
        mech.vel.z *= config.dash.exitSpeedMul;
        mech.dashCd = dashCooldown(mech);
        mech.dashHitSet.clear();
      }
    }

    if (input.enabled && input.dash && mech.dashCd <= 0 && mech.dashTimer <= 0 && !dashing) {
      this._startDash(input);
      dashing = true;
    }

    // ── 水平移动 ──
    const axis = input.enabled ? input.move : { x: 0, y: 0 };
    // 相机朝向决定移动的世界方向
    const cy = Math.cos(this.aim.yaw), sy = Math.sin(this.aim.yaw);
    // 前方向（yaw=0 → -Z）
    const fx = -sy, fz = -cy;
    // 右方向
    const rx = cy, rz = -sy;

    let wishX = fx * axis.y + rx * axis.x;
    let wishZ = fz * axis.y + rz * axis.x;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1e-4) { wishX /= wishLen; wishZ /= wishLen; }

    if (dashing) {
      // 冲刺期间速度被锁定为冲刺方向 × 冲刺速度
      const dm = (mech.mods.dashDistanceMul || 1);
      mech.vel.x = mech.dashDir.x * config.dash.speed * dm;
      mech.vel.z = mech.dashDir.z * config.dash.speed * dm;
    } else {
      const maxSpeed = config.mech.maxSpeed * (mech.mods.speedMul || 1);
      const control = mech.grounded ? 1 : config.mech.airControl;
      const accel = config.mech.accel * control;

      if (wishLen > 1e-4) {
        mech.vel.x += wishX * accel * dt;
        mech.vel.z += wishZ * accel * dt;
        // 限速：只在超过上限时衰减，保证加速手感不被削平
        const sp = Math.hypot(mech.vel.x, mech.vel.z);
        if (sp > maxSpeed) {
          const k = maxSpeed / sp;
          mech.vel.x *= k;
          mech.vel.z *= k;
        }
      } else if (mech.grounded) {
        // 摩擦减速
        const sp = Math.hypot(mech.vel.x, mech.vel.z);
        if (sp > 1e-4) {
          const dec = Math.min(sp, config.mech.friction * dt);
          mech.vel.x -= (mech.vel.x / sp) * dec;
          mech.vel.z -= (mech.vel.z / sp) * dec;
        }
      }
    }

    // ── 重力 ──
    if (!mech.grounded) {
      mech.vel.y -= config.mech.gravity * dt;
      // 限制下落速度，避免高速穿模
      mech.vel.y = Math.max(mech.vel.y, -42);
    } else if (mech.vel.y < 0) {
      mech.vel.y = 0;
    }

    // ── 跳跃 ──
    if (input.enabled && input.jump && mech.grounded && mech.dashTimer <= 0) {
      mech.vel.y = 8.4;
      mech.grounded = false;
      this.pushEvent({ type: 'jump', pos: { ...mech.pos } });
    }

    // ── 与物理世界求解位移 ──
    const motion = {
      x: mech.vel.x * dt,
      y: mech.vel.y * dt,
      z: mech.vel.z * dt,
    };

    const res = this.phys.moveCapsule({
      position: mech.pos,
      motion,
      radius: config.mech.radius,
      height: config.mech.height,
      group: GROUP.PLAYER,
      mask: PLAYER_MASK,
    });

    const wasGrounded = mech.grounded;
    mech.pos = res.position;
    mech.grounded = res.grounded;

    // 落地事件
    if (!wasGrounded && mech.grounded && motion.y < -0.05) {
      this.boosts.push({ x: mech.pos.x, y: mech.pos.y, z: mech.pos.z, life: 0.35, max: 0.35 });
      this.pushEvent({ type: 'land', pos: { ...mech.pos }, speed: Math.abs(mech.vel.y) });
    }

    // 撞墙后把速度投影掉，否则会贴着墙持续积累速度
    if (res.grounded && mech.vel.y < 0) mech.vel.y = 0;
    // 水平方向被墙挡住时清零，避免「贴墙冲刺」产生的怪异手感
    const actualDX = mech.pos.x - mech.prevPos.x;
    const actualDZ = mech.pos.z - mech.prevPos.z;
    if (Math.abs(actualDX) < 1e-4) mech.vel.x *= 0.1;
    if (Math.abs(actualDZ) < 1e-4) mech.vel.z *= 0.1;

    // ── 朝向：面向相机方向（第三人称射击的常规做法） ──
    if (mech.dashTimer <= 0) turnToward(mech, this.aim.yaw, dt * (mech.alive ? 1 : 0.4));

    // ── 冲刺撞击（爆震护盾） ──
    if (dashing && (mech.mods.dashDamage || 0) > 0) this._dashCollide();

    // ── 开火 ──
    const fire = input.enabled && input.fire && mech.dashTimer <= 0;
    const shot = tryFire(mech, {
      raycast: (a) => this.phys.raycast(a),
      rng: this.rand,
    }, fire, dt, this.aim.yaw, this.aim.pitch);

    if (shot.fired) {
      this._resolveShots(shot);
    }
    if (!wasOverheated && mech.overheated) {
      this.pushEvent({ type: 'overheat', pos: { ...mech.pos } });
    }
  }

  _startDash(input) {
    const mech = this.mech;
    const axis = input.move;
    const cy = Math.cos(this.aim.yaw), sy = Math.sin(this.aim.yaw);
    const fx = -sy, fz = -cy;
    const rx = cy, rz = -sy;

    let dx = fx * axis.y + rx * axis.x;
    let dz = fz * axis.y + rz * axis.x;
    const len = Math.hypot(dx, dz);

    if (len < 1e-4) {
      // 无方向输入时朝正前方冲刺
      dx = fx; dz = fz;
    } else {
      dx /= len; dz /= len;
    }

    mech.dashDir = { x: dx, z: dz };
    mech.dashTimer = config.dash.duration;
    mech.dashCd = dashCooldown(mech);   // 先设为冷却，冲刺结束时再重置，避免连按
    mech.dashHitSet.clear();

    // 冷却液喷射：冲刺清热
    if (mech.mods.dashVent) addHeat(mech, -mech.mods.dashVent);

    this.pushEvent({
      type: 'dash',
      pos: { x: mech.pos.x, y: mech.pos.y + 0.5, z: mech.pos.z },
      dir: { x: dx, z: dz },
    });
  }

  /** 冲刺穿越敌人时造成伤害（爆震护盾遗物） */
  _dashCollide() {
    const mech = this.mech;
    const dmg = mech.mods.dashDamage;
    const kb = mech.mods.dashKnockback || 0;

    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (mech.dashHitSet.has(e.id)) continue;

      const d = Math.hypot(e.pos.x - mech.pos.x, e.pos.z - mech.pos.z);
      if (d > e.type.radius + config.mech.radius + 0.55) continue;

      mech.dashHitSet.add(e.id);
      this._damageEnemy(e, dmg, { x: 0, y: 0, z: 0 }, 'dash');

      // 击退：给敌人一个远离玩家的速度
      if (kb > 0) {
        const dx = e.pos.x - mech.pos.x;
        const dz = e.pos.z - mech.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        e.vel.x += (dx / l) * kb;
        e.vel.z += (dz / l) * kb;
      }
      this.pushEvent({ type: 'dash-hit', pos: { ...e.pos }, enemyId: e.id });
    }
  }

  /** 过热 EMP（过载核心遗物） */
  _fireEmp(mech) {
    const r = mech.mods.empRadius || 10;
    const dur = mech.mods.empDuration || 2.5;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.pos.x - mech.pos.x, e.pos.z - mech.pos.z);
      if (d <= r) {
        e.disabled = dur;
        e.vel.x = 0; e.vel.z = 0;
      }
    }
    this.pushEvent({ type: 'emp', pos: { ...mech.pos }, radius: r, duration: dur });
  }

  // ── 开火结算 ───────────────────────────────────────────

  _resolveShots(shot) {
    const mech = this.mech;
    for (const s of shot.shots) {
      const r = resolveShot(s, this._colliderMap);
      if (r.kind === 'enemy') {
        this._damageEnemy(r.enemy, r.damage, s.dir, 'bullet', r.point);
        this.pushEvent({ type: 'hit-enemy', point: r.point, normal: r.normal, enemyId: r.enemy.id });
        // 动能回收
        if (mech.mods.hitVent) addHeat(mech, -mech.mods.hitVent);
      } else if (r.kind === 'world') {
        this.pushEvent({ type: 'hit-world', point: r.point, normal: r.normal });
      }
      // 曳光始终推送，用于渲染弹道
      this.pushEvent({ type: 'tracer', from: s.origin, to: s.end, weapon: s.weapon });
    }
    this.pushEvent({ type: 'muzzle', pos: shot.shots[0]?.origin, weapon: shot.weapon });
  }

  /**
   * 建立「碰撞体 handle → 敌人」的映射。
   *
   * 由适配层在每帧开火结算前调用一次。用 Map 而不是逐条射线遍历敌人列表，
   * 是因为命中查询发生在射线内部，没有遍历的机会；同时把 O(敌人数) 的
   * 查找压到 O(1)。
   *
   * @param {Map<number, object>} [map] 适配层注入的映射；省略则按 e.collider 自建
   */
  buildColliderMap(map) {
    if (map) {
      this._colliderMap = map;
      return map;
    }
    const m = new Map();
    for (const e of this.enemies) {
      if (e.collider) m.set(e.collider.handle, e);
    }
    this._colliderMap = m;
    return m;
  }

  /**
   * 对敌人造成伤害，统一处理护甲、暴击（猎杀协议）、死亡。
   */
  _damageEnemy(enemy, amount, dir, source, point) {
    if (!enemy.alive) return;

    let dmg = amount;
    const mech = this.mech;
    // 猎杀协议：低血目标受额外伤害
    const thr = mech.mods.executeThreshold || 0;
    if (thr > 0 && enemy.hp / enemy.maxHp <= thr) {
      dmg *= (mech.mods.executeDamageMul || 1);
    }
    dmg *= (mech.mods.damageMul || 1);

    enemy.hp -= dmg;
    enemy.hitFlash = 1;
    enemy.stun = config.enemy.hitStun;

    if (enemy.hp <= 0) {
      enemy.hp = 0;
      enemy.alive = false;
      enemy.corpseTimer = config.enemy.corpseDecay;
      mech.kills += 1;
      this.stats.kills += 1;
      this.pushEvent({
        type: 'enemy-died',
        pos: { ...enemy.pos },
        enemyId: enemy.id,
        isBoss: !!enemy.isBoss,
        scale: enemy.scale || 1,
      });

      // 奇点核心：掉球
      if (mech.mods.killDropsOrb) {
        this.orbs.push({
          pos: { x: enemy.pos.x, y: enemy.pos.y + 0.9, z: enemy.pos.z },
          life: 14,
          bob: Math.random() * Math.PI * 2,
        });
      }
    }
  }

  // ── 敌人 ───────────────────────────────────────────────

  _updateEnemies(dt) {
    const ctx = {
      player: this.mech,
      faceYaw: (e, yaw, dt, speed) => {
        let diff = yaw - e.yaw;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const step = speed * dt;
        e.yaw += Math.abs(diff) <= step ? diff : Math.sign(diff) * step;
      },
      moveToward: (e, dx, dz, speed, accel, dt) => {
        e.vel.x += dx * accel * dt;
        e.vel.z += dz * accel * dt;
        const sp = Math.hypot(e.vel.x, e.vel.z);
        if (sp > speed) {
          const k = speed / sp;
          e.vel.x *= k; e.vel.z *= k;
        }
      },
      brake: (e, dt) => {
        const sp = Math.hypot(e.vel.x, e.vel.z);
        if (sp > 1e-4) {
          const dec = Math.min(sp, 22 * dt);
          e.vel.x -= (e.vel.x / sp) * dec;
          e.vel.z -= (e.vel.z / sp) * dec;
        }
      },
      hasLineOfSight: (e, target) => {
        const from = { x: e.pos.x, y: e.pos.y + e.type.height * 0.7, z: e.pos.z };
        const to = { x: target.pos.x, y: target.pos.y + 1.3, z: target.pos.z };
        const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
        const len = Math.hypot(dx, dy, dz);
        if (len < 0.1) return true;
        const dir = { x: dx / len, y: dy / len, z: dz / len };
        // 只对关卡几何做遮挡检测：敌人之间互相遮挡不算数，
        // 否则密集编队会因为友军挡住视线而集体不开火。
        const hit = this.phys.raycast({
          origin: from, dir, maxToi: len - 0.4,
          group: ENEMY_GROUP, mask: GROUP.LEVEL,
        });
        return !hit;
      },
      meleeAttack: (e, damage) => {
        const d = Math.hypot(e.pos.x - this.mech.pos.x, e.pos.z - this.mech.pos.z);
        if (d <= (e.type.attackRange ?? 2.3) + 0.7) {
          this._hurtPlayer(damage, e);
        }
        this.pushEvent({ type: 'enemy-melee', pos: { ...e.pos }, enemyId: e.id });
      },
      fireProjectile: (e, speed, damage, yawOffset = 0) => {
        const from = { x: e.pos.x, y: e.pos.y + e.type.height * 0.72, z: e.pos.z };
        const to = { x: this.mech.pos.x, y: this.mech.pos.y + 1.25, z: this.mech.pos.z };
        const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        let dir = { x: dx / len, y: dy / len, z: dz / len };

        if (yawOffset !== 0) {
          // 绕 Y 轴旋转一个小角度，形成扇形散射
          const c = Math.cos(yawOffset), s = Math.sin(yawOffset);
          dir = {
            x: dir.x * c - dir.z * s,
            y: dir.y,
            z: dir.x * s + dir.z * c,
          };
        }

        this.projectiles.push({
          pos: { ...from },
          prevPos: { ...from },
          vel: { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed },
          dir,
          damage,
          speed,
          life: 4.5,
          owner: e.id,
          color: e.type.color,
        });
        this.pushEvent({ type: 'enemy-fire', pos: { ...from }, enemyId: e.id, dir });
      },
    };

    for (const e of this.enemies) {
      if (!e.alive) continue;

      // 受击闪烁衰减
      if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt * 3.0);

      // 被 EMP 瘫痪
      if (e.disabled > 0) {
        e.disabled -= dt;
        e.vel.x *= 0.86; e.vel.z *= 0.86;
        this._moveEnemy(e, dt);
        continue;
      }

      // 受击硬直
      if (e.stun > 0) {
        e.stun -= dt;
        this._moveEnemy(e, dt);
        continue;
      }

      // 游走换向
      e.strafeTimer -= dt;
      if (e.strafeTimer <= 0) {
        e.strafeDir *= -1;
        e.strafeTimer = 1.6 + this.rng.next() * 2.8;
      }

      // 执行类型行为
      e.type.think.call(e.type, e, ctx, dt);
      this._moveEnemy(e, dt);
    }
  }

  _moveEnemy(e, dt) {
    // 重力
    if (!e.grounded) {
      e.vel.y -= config.enemy.gravity * dt;
      e.vel.y = Math.max(e.vel.y, -40);
    } else if (e.vel.y < 0) {
      e.vel.y = 0;
    }

    const motion = { x: e.vel.x * dt, y: e.vel.y * dt, z: e.vel.z * dt };
    const res = this.phys.moveCapsule({
      position: e.pos,
      motion,
      radius: e.type.radius * (e.scale || 1),
      height: e.type.height * (e.scale || 1),
      group: ENEMY_GROUP,
      mask: ENEMY_MASK,
    });

    e.pos = res.position;
    e.grounded = res.grounded;

    // 撞墙后衰减水平速度，避免贴墙累积
    const adx = e.pos.x - e.prevPos.x;
    const adz = e.pos.z - e.prevPos.z;
    if (Math.abs(adx) < 1e-4) e.vel.x *= 0.15;
    if (Math.abs(adz) < 1e-4) e.vel.z *= 0.15;
  }

  _updateCorpses(dt) {
    for (const e of this.enemies) {
      if (e.alive) continue;
      if (e.corpseTimer > 0) e.corpseTimer = Math.max(0, e.corpseTimer - dt);
      // 残骸继续受重力，掉到地上
      if (!e.grounded || e.vel.y > 0) {
        e.vel.y -= config.enemy.gravity * dt;
        const res = this.phys.moveCapsule({
          position: e.pos,
          motion: { x: 0, y: e.vel.y * dt, z: 0 },
          radius: e.type.radius * (e.scale || 1),
          height: e.type.height * (e.scale || 1),
          group: ENEMY_GROUP,
          mask: GROUP.LEVEL,
        });
        e.pos = res.position;
        e.grounded = res.grounded;
        if (res.grounded) e.vel.y = 0;
      }
    }
  }

  // ── 投射物 ─────────────────────────────────────────────

  _updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.prevPos = { ...p.pos };
      p.life -= dt;

      // 用射线做扫掠检测，避免高速弹穿模
      const step = Math.hypot(p.vel.x, p.vel.z, p.vel.y) * dt;
      if (step > 1e-5) {
        const hit = this.phys.raycast({
          origin: p.pos,
          dir: p.dir,
          maxToi: step,
          group: GROUP.PROJECTILE,
          mask: GROUP.LEVEL | GROUP.PLAYER,
        });

        if (hit) {
          // 命中玩家？
          const dToPlayer = Math.hypot(
            hit.point.x - this.mech.pos.x,
            hit.point.y - (this.mech.pos.y + 0.9),
            hit.point.z - this.mech.pos.z,
          );
          // 碰撞体归属判断：射线打在玩家胶囊上时距离会非常近
          const playerHit = dToPlayer < config.mech.radius + 0.65;
          if (playerHit) {
            this._hurtPlayer(p.damage, null, hit.point);
          } else {
            this.pushEvent({ type: 'impact', point: hit.point, normal: hit.normal, color: p.color });
          }
          this.projectiles.splice(i, 1);
          continue;
        }
      }

      p.pos = {
        x: p.pos.x + p.vel.x * dt,
        y: p.pos.y + p.vel.y * dt,
        z: p.pos.z + p.vel.z * dt,
      };

      if (p.life <= 0) this.projectiles.splice(i, 1);
    }
  }

  // ── 掉落物 ─────────────────────────────────────────────

  _updateOrbs(dt) {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.life -= dt;
      o.bob += dt * 3.2;

      const d = Math.hypot(o.pos.x - this.mech.pos.x, o.pos.z - this.mech.pos.z);
      // 磁吸
      if (d < 5.5) {
        const k = 9 * dt;
        const dx = this.mech.pos.x - o.pos.x;
        const dz = this.mech.pos.z - o.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        o.pos.x += (dx / l) * k * 1.6;
        o.pos.z += (dz / l) * k * 1.6;
      }

      if (d < 1.5) {
        // 拾取
        const heal = this.mech.mods.orbHeal || 10;
        this.mech.hp = Math.min(this.mech.maxHp, this.mech.hp + heal);
        this.mech.heat = 0;
        this.orbs.splice(i, 1);
        this.pushEvent({ type: 'orb-pickup', pos: { ...o.pos }, heal });
        continue;
      }

      if (o.life <= 0) this.orbs.splice(i, 1);
    }
  }

  // ── 玩家受伤 ───────────────────────────────────────────

  _hurtPlayer(amount, source, point) {
    const res = damageMech(this.mech, amount);
    if (res.absorbed) {
      this.pushEvent({ type: 'damage-absorbed' });
      return;
    }
    if (!res.applied) return;

    this.pushEvent({
      type: 'player-hit',
      amount,
      pos: point || { ...this.mech.pos },
      hp: this.mech.hp,
    });

    // 反应装甲：受击弹射破片
    const thorns = this.mech.mods.thorns || 0;
    if (thorns > 0) {
      const dmg = this.mech.mods.thornsDamage || 15;
      let fired = 0;
      for (const e of this.enemies) {
        if (!e.alive || fired >= thorns) continue;
        const d = Math.hypot(e.pos.x - this.mech.pos.x, e.pos.z - this.mech.pos.z);
        if (d < 10) {
          this._damageEnemy(e, dmg, { x: 0, y: 0, z: 0 }, 'thorns', e.pos);
          fired++;
        }
      }
      if (fired > 0) {
        this.pushEvent({ type: 'thorns', pos: { ...this.mech.pos }, count: fired });
      }
    }

    if (res.died) {
      this.mech.alive = false;
      this.phase = 'dead';
      this.pushEvent({ type: 'player-died', pos: { ...this.mech.pos } });
    }
  }

  // ── 房间状态 ───────────────────────────────────────────

  _checkRoomClear() {
    if (this.phase !== 'playing') return;
    const remaining = this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
    if (remaining > 0) return;

    const total = config.world.roomsPerRun;
    if (this.roomIndex >= total - 1) {
      // 最后一间清空 = 通关
      this.phase = 'cleared';
      this.pushEvent({ type: 'run-cleared', stats: { ...this.stats } });
      return;
    }

    // 弹出三选一
    this.relicChoices = rollRelics(
      this.rng,
      this.roomIndex,
      total,
      this.mech.relics.map((r) => r.id),
      3,
    );
    this.phase = 'relic-choice';
    this.pushEvent({
      type: 'relic-choice',
      choices: this.relicChoices.map((r) => ({ id: r.id, name: r.name, rarity: r.rarity, desc: r.desc, icon: r.icon })),
    });
  }

  /**
   * 玩家选定遗物。由 UI 调用。
   * @param {number} index relicChoices 的下标
   * @returns {boolean} 是否成功
   */
  chooseRelic(index) {
    if (this.phase !== 'relic-choice') return false;
    const relic = this.relicChoices[index];
    if (!relic) return false;

    this.mech.relics.push(relic);
    this.mech.mods = buildMods(this.mech.relics);
    recalcMech(this.mech);

    // 选完立刻回满一部分血，给一点正反馈
    this.mech.hp = Math.min(this.mech.maxHp, this.mech.hp + 12);

    this.pushEvent({ type: 'relic-taken', id: relic.id, name: relic.name });
    this.relicChoices = [];

    // 进入下一间
    this.loadRoom(this.roomIndex + 1);
    return true;
  }

  /** 重掷遗物候选，消耗代价由 UI 决定（这里只负责逻辑） */
  rerollRelics() {
    if (this.phase !== 'relic-choice') return false;
    this.relicChoices = rollRelics(
      this.rng,
      this.roomIndex,
      config.world.roomsPerRun,
      this.mech.relics.map((r) => r.id),
      3,
    );
    this.pushEvent({
      type: 'relic-choice',
      choices: this.relicChoices.map((r) => ({ id: r.id, name: r.name, rarity: r.rarity, desc: r.desc, icon: r.icon })),
    });
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // 快照
  // ══════════════════════════════════════════════════════════

  /**
   * 产出渲染层可读的只读快照。
   * 渲染层**只读**本对象，不得回写任何字段。
   * @param {number} alpha 固定步长插值系数 0..1
   */
  snapshot(alpha = 1) {
    const lerp = (a, b) => a + (b - a) * alpha;
    const mech = this.mech;

    return {
      phase: this.phase,
      roomIndex: this.roomIndex,
      roomsTotal: config.world.roomsPerRun,
      elapsed: this._elapsed,

      mech: {
        pos: {
          x: lerp(mech.prevPos.x, mech.pos.x),
          y: lerp(mech.prevPos.y, mech.pos.y),
          z: lerp(mech.prevPos.z, mech.pos.z),
        },
        yaw: mech.yaw,
        alive: mech.alive,
        grounded: mech.grounded,
        dashing: mech.dashTimer > 0,
        hp: mech.hp,
        maxHp: mech.maxHp,
        heat: mech.heat,
        heatMax: heatMax(mech),
        overheated: mech.overheated,
        overheatRatio: mech.overheatTimer > 0
          ? 1 - mech.overheatTimer / (config.heat.overheatLockout * (mech.mods.overheatLockoutMul || 1))
          : 0,
        dashCd: mech.dashCd,
        dashCdMax: dashCooldown(mech),
        reloading: mech.reloading,
        shells: mech.shells,
        maxShells: mech.maxShells,
        hitFlash: mech.hitFlash,
        weapon: mech.weapon,
        relics: mech.relics.map((r) => ({ id: r.id, icon: r.icon, rarity: r.rarity, name: r.name })),
        kills: mech.kills,
      },

      aim: { yaw: this.aim.yaw, pitch: this.aim.pitch },

      enemies: this.enemies.map((e) => ({
        id: e.id,
        kind: e.kind,
        alive: e.alive,
        isBoss: !!e.isBoss,
        scale: e.scale || 1,
        pos: {
          x: lerp(e.prevPos.x, e.pos.x),
          y: lerp(e.prevPos.y, e.pos.y),
          z: lerp(e.prevPos.z, e.pos.z),
        },
        yaw: e.yaw,
        hp: e.hp,
        maxHp: e.maxHp,
        hitFlash: e.hitFlash,
        disabled: e.disabled > 0,
        corpseTimer: e.corpseTimer,
        color: e.type.color,
        radius: e.type.radius,
        height: e.type.height,
      })),

      projectiles: this.projectiles.map((p) => ({
        pos: { x: lerp(p.prevPos.x, p.pos.x), y: lerp(p.prevPos.y, p.pos.y), z: lerp(p.prevPos.z, p.pos.z) },
        prevPos: { ...p.prevPos },
        dir: { ...p.dir },
        color: p.color,
      })),

      orbs: this.orbs.map((o) => ({
        pos: { x: o.pos.x, y: o.pos.y + Math.sin(o.bob) * 0.16, z: o.pos.z },
      })),

      boosts: this.boosts,

      stats: { ...this.stats },
      relicChoices: this.relicChoices,
    };
  }

  /**
   * 取出并清空本帧事件。
   * 渲染层每帧调用一次，处理完特效后事件即丢弃。
   */
  drainEvents() {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  /** 每帧末清理短生命周期数据 */
  endFrame(dt) {
    for (let i = this.boosts.length - 1; i >= 0; i--) {
      this.boosts[i].life -= dt;
      if (this.boosts[i].life <= 0) this.boosts.splice(i, 1);
    }
    this._colliderMap = null;
  }
}
