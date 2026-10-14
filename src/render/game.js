/**
 * 游戏主循环与模块装配。
 *
 * 这是唯一允许同时接触 simulation 与 render 的文件——它的职责就是做两者之间的
 * 适配层：把输入喂给 simulation，把 snapshot 喂给 render，把事件翻译成特效。
 *
 * 数据流（单向，见设计文档 §4）：
 *   输入 → simulation.update → snapshot → render 同步
 *                             → drainEvents → 特效 / 音效 / HUD 反馈
 */

import * as THREE from 'three';
import RAPIER from 'rapier';
import { config } from '../config.js';
import { PhysicsWorld, GROUP, membership } from '../physics/world.js';
import { buildColliders, removeColliders } from '../physics/level.js';
import { Simulation } from '../simulation/world.js';
import { RenderApp } from './app.js';
import { RoomView } from './world-view.js';
import { Particles } from './particles.js';
import { PostFX } from './postfx.js';
import { Effects } from './fx.js';
import { ThirdPersonCamera } from './camera.js';
import { buildMech, animateMech, buildEnemy, animateEnemy } from './models.js';
import { Input } from '../input/input.js';
import { Hud, perfText } from '../ui/hud.js';
import { DebugPanel } from '../diagnostics/panel.js';

/** 碰撞盒可视化用的材质 */
const COLLIDER_MAT = new THREE.MeshBasicMaterial({
  color: 0x4affa0, wireframe: true, transparent: true, opacity: 0.28, depthTest: true,
});

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.running = false;
    this.paused = false;
    this.timeScale = 1;
    this._time = 0;
    this._lastTs = 0;
    this._fps = 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._hitStop = 0;

    /** 由 main.js 装配，此处只是占位 */
    this.env = null;
  }

  /**
   * 异步初始化。分步报告进度，让加载遮罩有意义。
   * @param {(t:number, msg:string) => void} onProgress
   */
  async init(onProgress = () => {}) {
    // ── 1. 渲染环境 ──
    onProgress(0.05, '创建渲染环境…');
    this.env = new RenderApp(this.canvas);

    // ── 2. 物理 ──
    onProgress(0.25, '初始化物理引擎…');
    this.phys = new PhysicsWorld();
    await this.phys.init();

    // ── 3. 场景内容 ──
    onProgress(0.45, '构建机甲…');
    this.roomView = new RoomView(this.env.scene);
    this.particles = new Particles(this.env.scene, Math.random);
    this.fx = new Effects(this.env.scene);

    // 机甲模型
    this.mechObj = buildMech();
    this.env.scene.add(this.mechObj);

    // 敌人模型池：按 kind 复用，避免每帧创建销毁
    /** @type {Map<number, THREE.Group>} */
    this.enemyObjs = new Map();
    /** @type {THREE.Group[]} 空闲模型池，按 kind 分组 */
    this.enemyPool = { charger: [], ranged: [], heavy: [] };

    // 掉落物（奇点核心）用一个共享几何 + 材质
    this.orbGeo = new THREE.IcosahedronGeometry(0.22, 1);
    this.orbMat = new THREE.MeshStandardMaterial({
      color: 0x0a1a16,
      emissive: 0x7dffd4,
      emissiveIntensity: 3.2,
      metalness: 0.3,
      roughness: 0.2,
    });
    this.orbObjects = [];

    // ── 4. 后处理 ──
    onProgress(0.62, '编译着色器…');
    this.postfx = new PostFX(this.env.renderer, this.env.scene, this.env.camera);
    // 尺寸变化时同步 composer 与各 pass。RenderApp.resize() 会调用这里。
    this.env.onResize = (w, h) => {
      this.postfx.setSize(w, h);
      // 相机投影已在 resize 里处理，这里只需保证 composer 的渲染目标跟上
    };
    // RenderApp 的构造函数里已经 resize 过一次，那时 onResize 还不存在，
    // 因此这里必须主动补一次同步，否则 composer 的渲染目标会停留在初始尺寸。
    this.postfx.setSize(window.innerWidth, window.innerHeight);

    // ── 5. 相机与输入 ──
    // 相机必须在 Simulation 之前创建：Simulation.startNewRun() 会触发 loadRoom，
    // 而 loadRoom 的包装逻辑里有 camera.snapBehind()——顺序反了会直接抛异常。
    onProgress(0.72, '初始化相机…');
    this.camera = new ThirdPersonCamera(this.env.camera, this.phys);

    this.input = new Input(this.canvas);
    this.hud = new Hud({
      onChooseRelic: (i) => this.chooseRelic(i),
      onReroll: () => this.sim.rerollRelics(),
      onRetry: () => this.restart(),
    });

    // ── 6. 模拟 ──
    onProgress(0.82, '生成关卡…');
    // 种子可通过 ?seed=N 指定。默认随机，但固定种子是排查问题的前提——
    // 房间布局与敌人站位都由种子决定，种子一变，两次截图就没有可比性。
    const seedParam = new URLSearchParams(location.search).get('seed');
    const seed = seedParam !== null
      ? (Number(seedParam) >>> 0)
      : ((Math.random() * 0xffffffff) >>> 0);
    this.seed = seed;
    console.info(`[关卡种子] ${seed}   （用 ?seed=${seed} 可复现同一关）`);
    this.sim = new Simulation(this.phys, seed);
    // 把物理层的碰撞体创建交给游戏层，因为移除时机由房间切换决定
    this._installRoomHooks();
    this.sim.startNewRun();
    this.camera.snapBehind(this.sim.mech, this.sim.aim);

    // ── 7. 调参面板 ──
    this.debug = new DebugPanel({
      getStats: () => this._stats(),
      onReset: () => this.restart(),
      onToggleColliders: (v) => this._toggleColliders(v),
      onBloomChange: () => this.postfx.syncFromConfig(),
      onToggleSlowMo: (v) => { this.timeScale = v ? 0.25 : 1; },
    });

    this._bindKeys();

    onProgress(1.0, '完成');
    return this;
  }

  /**
   * 关卡切换时同步物理碰撞体。
   *
   * 用猴子补丁的方式挂钩，而不是把物理逻辑塞进 Simulation——
   * Simulation 保持纯粹的「逻辑 + 抽象物理接口」，创建/销毁具体碰撞体是适配层的活。
   */
  _installRoomHooks() {
    let currentColliders = [];

    this._syncRoom = () => {
      removeColliders(this.phys, currentColliders);
      currentColliders = buildColliders(this.phys, this.sim.room.shapes);

      // 旧房间的敌人碰撞体一并销毁；新房间的敌人会在下一帧按需挂载
      this._destroyEnemyColliders();

      this.roomView.build(this.sim.room.shapes);
      this.particles.clear();
      this.fx.clear();
    };

    // 包装 loadRoom，让每次换房间都重建碰撞体与渲染几何
    const origLoadRoom = this.sim.loadRoom.bind(this.sim);
    this.sim.loadRoom = (idx) => {
      origLoadRoom(idx);
      this._syncRoom();
      this.camera.snapBehind(this.sim.mech, this.sim.aim);
      this.env.followLighting(this.sim.mech.pos);
    };
  }

  /**
   * 为敌人挂载碰撞体。
   *
   * 为什么敌人必须有真实碰撞体：射线命中需要判断「打到了谁」。
   * 逐个做球体求交也能实现，但那样的命中判定与敌人实际覆盖的体积不一致
   * （胶囊 vs 球），而且无法参与物理引擎的碰撞过滤。
   *
   * 这里用运动学位置型刚体：位置由我们每帧写入，物理引擎不会推动它，
   * 但它可以被射线检测到，也能拦住玩家（敌人挡路是有意设计的）。
   */
  _enemyColliderFilter() {
    // 敌人只与关卡和玩家相互作用；敌人之间不碰撞，避免密集编队互相卡住
    return membership(GROUP.ENEMY, GROUP.LEVEL | GROUP.PLAYER);
  }

  _ensureEnemyCollider(e) {
    if (e.collider) return;

    const scale = e.scale || 1;
    const r = e.type.radius * scale;
    const h = e.type.height * scale;
    // 刚体原点在胶囊几何中心，而 e.pos 在脚底，故抬高 (h/2 + r)
    const offset = h / 2 + r;

    const bodyDesc = RAPIER.RigidBodyDesc
      .kinematicPositionBased()
      .setTranslation(e.pos.x, e.pos.y + offset, e.pos.z);
    const body = this.phys.world.createRigidBody(bodyDesc);

    const colDesc = RAPIER.ColliderDesc
      .capsule(h / 2, r)
      .setCollisionGroups(this._enemyColliderFilter())
      .setFriction(0.6)
      .setRestitution(0.05);
    const collider = this.phys.world.createCollider(colDesc, body);

    e.body = body;
    e.collider = collider;
    e._colOffset = offset;
  }

  _destroyEnemyColliders() {
    for (const e of this.sim.enemies) {
      if (!e.body) continue;
      try { this.phys.world.removeRigidBody(e.body); } catch { /* 已移除 */ }
      e.body = null;
      e.collider = null;
    }
  }

  /**
   * 每帧把敌人的模拟位置同步到物理刚体。
   * 必须在 phys.step 之前调用，否则射线检测用的是上一帧的位置。
   */
  _syncEnemyBodies() {
    for (const e of this.sim.enemies) {
      // 死亡的敌人撤掉碰撞体，让子弹能穿过残骸
      if (!e.alive) {
        if (e.body) {
          try { this.phys.world.removeRigidBody(e.body); } catch {}
          e.body = null;
          e.collider = null;
        }
        continue;
      }

      this._ensureEnemyCollider(e);
      if (e.body) {
        e.body.setNextKinematicTranslation({
          x: e.pos.x,
          y: e.pos.y + (e._colOffset || 0),
          z: e.pos.z,
        });
      }
    }
  }

  _bindKeys() {
    this.input.on('Escape', () => this.togglePause());
    this.input.on('F1', () => this.debug.toggle());
    this.input.on('F3', () => {
      this.debug.showStats = !this.debug.showStats;
      document.body.classList.toggle('debug', this.debug.showStats);
    });
    this.input.on('KeyR', () => {
      // 遗物界面里的重掷
      if (this.sim.phase === 'relic-choice') {
        const cost = 15;
        if (this.sim.mech.kills >= cost || true) {
          this.sim.rerollRelics();
          this.hud.showRelicChoices(this.sim.relicChoices);
        }
      }
    });
    this.input.on('Enter', () => {
      if (this.sim.phase === 'dead' || this.sim.phase === 'cleared') this.restart();
    });
    // 数字键选遗物
    for (let i = 1; i <= 3; i++) {
      this.input.on(`Digit${i}`, () => {
        if (this.sim.phase === 'relic-choice') this.chooseRelic(i - 1);
      });
    }
  }

  chooseRelic(index) {
    if (this.sim.phase !== 'relic-choice') return;
    const choices = this.sim.relicChoices;
    const picked = choices[index];
    if (!picked) return;

    this.sim.chooseRelic(index);
    this.hud.hideRelicChoices();

    // 重建敌人模型池：新房间的敌人构成不同
    this._recycleAllEnemyObjects();

    this.hud.toast(`获得 <strong>${picked.name}</strong>`);
    this.input.requestLock();
  }

  restart() {
    this.hud.hideGameOver();
    this.hud.hideRelicChoices();
    this._recycleAllEnemyObjects();
    this.sim.startNewRun();
    this._syncRoom();
    this.camera.snapBehind(this.sim.mech, this.sim.aim);
    this.input.requestLock();
  }

  togglePause() {
    if (this.sim.phase === 'dead' || this.sim.phase === 'cleared') return;
    this.paused = !this.paused;
    this.hud.setPaused(this.paused);
    if (this.paused) this.input.releaseLock();
    else this.input.requestLock();
  }

  // ══════════════════════════════════════════════════
  // 主循环
  // ══════════════════════════════════════════════════

  start() {
    this.running = true;
    this._lastTs = performance.now();
    this.hud.hideBoot();
    this.input.requestLock();
    this._rafloop();
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _rafloop = () => {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._rafloop);

    const now = performance.now();
    let dt = (now - this._lastTs) / 1000;
    this._lastTs = now;

    // 上限 1/20 秒：切标签页回来时不要一次补上巨大时间步
    dt = Math.min(dt, 0.05);

    if (this.env.hidden) return;

    this._update(dt);
  };

  _update(rawDt) {
    // 命中停顿：射击重量感（可在调参面板里关掉）
    let dt = rawDt * this.timeScale;
    if (this._hitStop > 0) {
      this._hitStop -= rawDt;
      dt *= 0.12;
    }

    const paused = this.paused;
    const phase = this.sim.phase;
    const acceptInput = !paused && (phase === 'playing' || phase === 'relic-choice');

    // 输入门控。
    //
    // 正常情况下必须锁定鼠标才接受操作输入（否则鼠标移出窗口还在转视角）。
    // 但无头浏览器里点不出真实的指针锁定，导致「操作类」改动无法自动化验证——
    // 只能靠人眼判断，这正是手感问题最容易反复的地方。
    // 因此提供 ?nolock=1 绕过该门控，让移动/开火逻辑可被脚本驱动与断言。
    const inputReady = this.ignorePointerLock || this.input.locked;

    // ── 1. 输入 → 语义 ──
    const semantic = acceptInput ? {
      move: this.input.moveAxis(),
      aimDX: this.input.mouseDX,
      aimDY: this.input.mouseDY,
      fire: this.input.mouse[0],
      dash: this.input.action('dash'),
      jump: this.input.action('jump'),
      reload: this.input.pressed('KeyR'),
      swap: this.input.pressed('Tab'),
      wheel: this.input.wheel,
      enabled: inputReady && phase === 'playing',
    } : {
      move: { x: 0, y: 0 }, aimDX: 0, aimDY: 0,
      fire: false, dash: false, jump: false,
      reload: false, swap: false, wheel: 0, enabled: false,
    };

    // ── 2. 物理步进 ──
    // 顺序有讲究：先把敌人的位置写进运动学刚体，再步进世界。
    // 反过来的话，本帧的射线检测会打在上一步的敌人位置上，快速移动时明显脱靶。
    if (!paused && phase !== 'relic-choice') {
      this._syncEnemyBodies();
      this.phys.step(dt);

      // 命中归属表必须在开火之前重建：敌人的碰撞体是上一帧才挂上的，
      // handle 会随房间切换而变。每帧重建的代价是 O(敌人数)，可以忽略。
      const map = new Map();
      for (const e of this.sim.enemies) {
        if (e.collider) map.set(e.collider.handle, e);
      }
      this.sim.buildColliderMap(map);
    }

    // ── 3. 模拟 ──
    // 诊断用的无敌：直接压掉这一帧会造成的伤害。
    // 实现方式是临时把玩家血量顶回原位，而不是在 Simulation 里判断标志位——
    // 后者要求 simulation 知道「调试模式」这种外部概念，会污染纯逻辑层。
    const hpBefore = this.sim.mech.hp;
    this.sim.update(paused ? 0 : dt, semantic);
    if (this.godMode && this.sim.mech.hp < hpBefore) {
      this.sim.mech.hp = hpBefore;
      this.sim.mech.alive = true;   // 已致死的情况下也要救回来
      // 同时压掉受击反馈：否则 hitFlash 会被反复顶满，
      // 整个画面被受击红闪罩住，无法用于评估光照与材质。
      this.sim.mech.hitFlash = 0;
      this.sim.mech.invulnTimer = 1;
    }

    // ── 4. 快照 ──
    const alpha = paused ? 1 : Math.min(1, this.phys._accumulator / config.world.fixedStep);
    const snap = this.sim.snapshot(alpha);
    const mechSnap = snap.mech;

    // 补上相机需要的速度字段（快照里没有原始速度，从位置差推算）
    if (this._lastMechPos) {
      mechSnap.velX = (mechSnap.pos.x - this._lastMechPos.x) / Math.max(1e-4, rawDt);
      mechSnap.velZ = (mechSnap.pos.z - this._lastMechPos.z) / Math.max(1e-4, rawDt);
    } else {
      mechSnap.velX = 0; mechSnap.velZ = 0;
    }
    this._lastMechPos = { ...mechSnap.pos };

    // ── 5. 事件 → 特效 ──
    const events = this.sim.drainEvents();
    this._consumeEvents(events, snap);

    // ── 6. 渲染同步 ──
    this._syncMech(mechSnap, dt);
    this._syncEnemies(snap, dt);
    this._syncOrbs(snap);
    this.fx.syncBolts(snap.projectiles);

    // ── 7. 特效系统 ──
    this.particles.update(dt);
    this.fx.update(dt);

    // ── 8. 相机 ──
    if (!paused && mechSnap.alive) {
      this.camera.update(dt, mechSnap, snap.aim);
      this.env.followLighting(mechSnap.pos);
    }

    // ── 9. HUD ──
    this.hud.update(snap, rawDt, this._time);
    // 诊断模式下每帧重新压住 HUD。
    // 不能只在 main.js 里设一次：Hud.hideBoot() 会在 game.start() 时把
    // #hud 的 hidden 置回 false，一次性设置会被它覆盖。
    if (this.hideHud) {
      this.hud.el.hud.hidden = true;
      this.hud.el.perf.style.display = 'none';
    }
    this._updatePhaseUi(snap);

    // ── 10. 后处理参数 ──
    this.postfx.update(dt, {
      hitFlash: mechSnap.hitFlash * 0.8,
      overheatT: mechSnap.overheated ? 1 : Math.min(1, mechSnap.heat / Math.max(1, mechSnap.heatMax)) * 0.45,
    });

    // ── 11. 渲染 ──
    this.postfx.render();

    // ── 12. 收尾 ──
    this.sim.endFrame(dt);
    this.input.endFrame();

    // ── 13. 自适应分辨率与统计 ──
    this.env.adaptiveResolution(rawDt);
    this._tickStats(rawDt, snap);

    this._time += dt;
  }

  /** 把模拟事件翻译成视觉表现 */
  _consumeEvents(events, snap) {
    for (const ev of events) {
      switch (ev.type) {
        case 'hit-enemy':
          this.particles.burst('spark', ev.point, { color: 0xffc46a, scale: 0.85 });
          if (ev.normal) {
            this.particles.burst('debris', ev.point, { scale: 0.5, speedScale: 0.7 });
          }
          this.hud.hitmarker(false);
          this.postfx.kick(0.004);
          break;

        case 'hit-world':
          this.particles.burst('spark', ev.point, { color: 0xffb060, scale: 0.7, speedScale: 0.85 });
          this.particles.burst('debris', ev.point, { scale: 0.45, speedScale: 0.55 });
          this.postfx.kick(0.0035);
          break;

        case 'tracer':
          this.fx.tracer(ev.from, ev.to, ev.weapon);
          break;

        case 'muzzle':
          if (ev.pos) {
            this.particles.burst('spark', ev.pos, { color: 0xffd090, scale: 0.55, speedScale: 1.5, lifeScale: 0.5 });
          }
          break;

        case 'enemy-died': {
          const isBig = ev.isBoss;
          this.particles.burst(isBig ? 'bigExplosion' : 'explosion', ev.pos, {
            scale: (ev.scale || 1) * (isBig ? 1.5 : 1),
          });
          this.fx.ring(ev.pos, {
            from: 0.3, to: (isBig ? 11 : 4.5) * (ev.scale || 1),
            life: isBig ? 0.9 : 0.42,
            color: 0xffa050,
          });
          this.camera.shake(isBig ? 1.2 : 0.22);
          this.postfx.kick(isBig ? 0.05 : 0.012);
          this.hud.hitmarker(true);
          this._hitStop = Math.max(this._hitStop, config.fx.hitStop * (isBig ? 4 : 1));
          if (ev.isBoss) this.hud.toast('首领已击毁');
          break;
        }

        case 'player-hit':
          this.camera.shake(0.42);
          this.postfx.flashHit(0.46);
          this.particles.burst('spark', ev.pos, { color: 0xff5544, scale: 0.8 });
          break;

        case 'dash':
          this.fx.ring(ev.pos, { from: 0.3, to: 3.4, life: 0.42, color: 0x8ec8ff });
          this.particles.burst('groundBurst', ev.pos, { scale: 1.0 });
          this.camera.shake(0.10);
          break;

        case 'dash-hit':
          this.particles.burst('explosion', ev.pos, { scale: 0.5, speedScale: 0.7 });
          this.camera.shake(0.3);
          this.hud.hitmarker(false);
          break;

        case 'jump':
          this.particles.burst('groundBurst', ev.pos, { scale: 0.6, speedScale: 0.6 });
          break;

        case 'land':
          this.particles.burst('dust', ev.pos, { scale: Math.min(1.6, 0.5 + ev.speed * 0.06) });
          if (ev.speed > 12) this.camera.shake(0.12);
          break;

        case 'overheat':
          this.camera.shake(0.34);
          this.postfx.kick(0.035);
          this.particles.burst('steam', { x: ev.pos.x, y: ev.pos.y + 1.6, z: ev.pos.z }, { scale: 1.6 });
          this.hud.toast('散热超限 — 强制停机');
          break;

        case 'heat-recovered':
          this.hud.toast('散热恢复');
          break;

        case 'emp':
          this.fx.ring(ev.pos, { from: 0.5, to: ev.radius, life: 0.72, color: 0xc08aff });
          this.particles.burst('emp', ev.pos, { scale: 2.2, speedScale: 0.8 });
          this.camera.shake(0.5);
          this.postfx.kick(0.06);
          this.hud.toast('电磁脉冲释放');
          break;

        case 'thorns':
          this.fx.ring(ev.pos, { from: 0.4, to: 6, life: 0.36, color: 0xff8080 });
          this.particles.burst('spark', ev.pos, { color: 0xff9060, scale: 1.3 });
          break;

        case 'enemy-melee':
          this.particles.burst('spark', ev.pos, { color: 0xff8050, scale: 0.7 });
          break;

        case 'enemy-fire':
          this.particles.burst('spark', ev.pos, { color: ev.dir ? 0xd0a0ff : 0xffaaaa, scale: 0.6, speedScale: 1.4, lifeScale: 0.5 });
          break;

        case 'impact':
          this.particles.burst('spark', ev.point, { color: ev.color || 0xffaa66, scale: 0.9, speedScale: 1.2 });
          this.particles.burst('debris', ev.point, { scale: 0.5 });
          break;

        case 'orb-pickup':
          this.particles.burst('orbPickup', ev.pos, { scale: 1.2 });
          this.fx.ring(ev.pos, { from: 0.2, to: 2.6, life: 0.36, color: 0x7dffd4, flat: false });
          this.hud.toast(`奇点回收 <strong>+${ev.heal}</strong> 生命`);
          break;

        case 'room-enter':
          this.hud.toast(ev.isBoss ? '<strong>首领区域</strong> — 准备接战' : `进入区域 <strong>${ev.index + 1}</strong> / ${ev.total}`);
          this.hud.setPaused(false);
          this.paused = false;
          break;

        case 'run-cleared':
          this.hud.showGameOver(true, {
            rooms: this.sim.stats.rooms,
            kills: this.sim.stats.kills,
            relics: this.sim.mech.relics.length,
          });
          this.input.releaseLock();
          break;

        case 'player-died':
          this.camera.shake(1.0);
          this.postfx.flashHit(1.0);
          this.particles.burst('explosion', ev.pos, { scale: 2.2, speedScale: 1.3 });
          this.fx.ring(ev.pos, { from: 0.5, to: 9, life: 1.1, color: 0xff6040 });
          this.hud.showGameOver(false, {
            rooms: this.sim.stats.rooms,
            kills: this.sim.stats.kills,
            relics: this.sim.mech.relics.length,
          });
          this.input.releaseLock();
          break;

        case 'relic-choice':
          this.hud.showRelicChoices(ev.choices);
          this.input.releaseLock();
          break;

        case 'run-start':
          this.hud.hideGameOver();
          this.hud.hideRelicChoices();
          break;

        default:
          break;
      }
    }
  }

  _updatePhaseUi(snap) {
    // 遗物界面与死亡界面由事件驱动，这里只处理暂停态的光标
    if (snap.phase === 'relic-choice' || snap.phase === 'dead' || snap.phase === 'cleared') {
      document.body.classList.add('show-cursor');
    }
  }

  // ══════════════════════════════════════════════════
  // 渲染同步
  // ══════════════════════════════════════════════════

  _syncMech(mechSnap, dt) {
    const o = this.mechObj;
    o.position.set(mechSnap.pos.x, mechSnap.pos.y, mechSnap.pos.z);

    // 模型朝向：直接使用 yaw，不加额外偏移。
    //
    // 建模时刻意把「脸」放在 -Z（胸口核心、头部传感器条、面罩都在负 Z），
    // 与全局约定「yaw = 0 时前方 = -Z」一致，因此 rotation.y = yaw 就是对的。
    // 曾经在这里加过 Math.PI 的补偿，那会让机甲倒退着走——
    // 是「操作很疑惑」的来源之一。
    o.rotation.y = mechSnap.yaw;

    // 死亡：向前倾倒
    if (!mechSnap.alive) {
      o.rotation.x = THREE.MathUtils.lerp(o.rotation.x, 1.35, Math.min(1, dt * 2.4));
      o.position.y = mechSnap.pos.y - 0.2;
    } else {
      o.rotation.x = THREE.MathUtils.lerp(o.rotation.x, 0, Math.min(1, dt * 6));
    }

    // 把后坐力传给动画：本帧开火则给一个脉冲
    const recoil = this._recoilPulse > 0 ? this._recoilPulse : 0;
    if (this._recoilPulse > 0) this._recoilPulse -= dt * 12;

    mechSnap.recoil = Math.max(0, recoil);
    animateMech(o, mechSnap, dt, this._time);
  }

  _syncEnemies(snap, dt) {
    const seen = new Set();

    for (const es of snap.enemies) {
      seen.add(es.id);
      let obj = this.enemyObjs.get(es.id);

      // 首次出现：从池里取或新建
      if (!obj) {
        obj = this._acquireEnemyObject(es.kind, es.color);
        // 应用 Boss 缩放
        obj.scale.setScalar(es.scale || 1);
        this.enemyObjs.set(es.id, obj);
      }

      // 残骸淡出：把不透明度映射到 1→0
      if (!es.alive) {
        const t = Math.max(0, es.corpseTimer / config.enemy.corpseDecay);
        obj.traverse((c) => {
          if (c.isMesh && c.material) {
            c.material.transparent = true;
            c.material.opacity = t;
          }
        });
        if (es.corpseTimer <= 0) {
          this._releaseEnemyObject(es.id);
          continue;
        }
      } else {
        obj.traverse((c) => {
          if (c.isMesh && c.material && c.material.opacity !== 1) {
            c.material.transparent = false;
            c.material.opacity = 1;
          }
        });
      }

      obj.rotation.y = es.yaw;
      animateEnemy(obj, es, dt, this._time);
    }

    // 回收已消失的
    for (const id of [...this.enemyObjs.keys()]) {
      if (!seen.has(id)) this._releaseEnemyObject(id);
    }
  }

  _acquireEnemyObject(kind, color) {
    const pool = this.enemyPool[kind] || this.enemyPool.charger;
    let obj = pool.pop();
    if (!obj) {
      obj = buildEnemy(kind, color);
      this.env.scene.add(obj);
    }
    obj.visible = true;
    return obj;
  }

  _releaseEnemyObject(id) {
    const obj = this.enemyObjs.get(id);
    if (!obj) return;
    this.enemyObjs.delete(id);
    obj.visible = false;
    obj.scale.setScalar(1);
    obj.rotation.set(0, 0, 0);
    // 恢复透明度，避免影响下次复用
    obj.traverse((c) => {
      if (c.isMesh && c.material) {
        c.material.transparent = false;
        c.material.opacity = 1;
      }
    });
    const kind = obj.userData.kind || 'charger';
    (this.enemyPool[kind] || this.enemyPool.charger).push(obj);
  }

  _recycleAllEnemyObjects() {
    for (const id of [...this.enemyObjs.keys()]) this._releaseEnemyObject(id);
  }

  _syncOrbs(snap) {
    // 按需增删
    while (this.orbObjects.length < snap.orbs.length) {
      const m = new THREE.Mesh(this.orbGeo, this.orbMat);
      m.castShadow = false;
      this.env.scene.add(m);
      this.orbObjects.push(m);
    }
    while (this.orbObjects.length > snap.orbs.length) {
      const m = this.orbObjects.pop();
      this.env.scene.remove(m);
    }
    for (let i = 0; i < snap.orbs.length; i++) {
      const o = snap.orbs[i];
      this.orbObjects[i].position.set(o.pos.x, o.pos.y, o.pos.z);
      this.orbObjects[i].rotation.y += 0.04;
      this.orbObjects[i].rotation.x += 0.02;
    }
  }

  // ══════════════════════════════════════════════════
  // 调试
  // ══════════════════════════════════════════════════

  _toggleColliders(on) {
    if (on) {
      if (!this.colliderHelper) {
        this.colliderHelper = new THREE.Group();
        this.colliderHelper.name = 'collider-debug';
        this.env.scene.add(this.colliderHelper);
      }
      this._rebuildColliderHelper();
    } else if (this.colliderHelper) {
      this.colliderHelper.visible = false;
    }
  }

  _rebuildColliderHelper() {
    const g = this.colliderHelper;
    // 清空
    while (g.children.length) {
      const c = g.children.pop();
      c.geometry?.dispose();
    }
    for (const s of this.sim.room.shapes) {
      const geo = new THREE.BoxGeometry(s.sx, s.sy, s.sz);
      const m = new THREE.Mesh(geo, COLLIDER_MAT);
      m.position.set(s.x, s.y, s.z);
      g.add(m);
    }
    g.visible = true;
  }

  _stats() {
    const info = this.env.renderer.info;
    return {
      fps: Math.round(this._fps),
      drawCalls: info.render.calls,
      tris: info.render.triangles,
      enemies: this.sim.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0),
      res: this.env.resolutionScale,
      phase: this.sim.phase,
    };
  }

  _tickStats(dt, snap) {
    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this._fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;

      if (this.debug.showStats) {
        const alive = snap.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
        this.hud.el.perf.textContent = perfText(
          this._fps,
          this.env.renderer.info.render.calls,
          this.env.renderer.info.render.triangles,
          this.env.resolutionScale,
          alive,
        );
      }
      this.debug.update();
    }

    // 记录后坐力脉冲：供 _syncMech 使用
    // （在事件里没法拿到开火时刻，这里用热量变化粗略近似）
    if (snap.mech.heat > (this._lastHeat || 0) + 0.5) {
      this._recoilPulse = 1;
    }
    this._lastHeat = snap.mech.heat;
  }
}
