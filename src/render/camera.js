/**
 * 第三人称弹簧臂相机。
 *
 * 这是全项目手感最敏感的一个文件（设计文档 §8 把「手感调参」列为高风险项）。
 * 为此所有可调数值都来自 config.camera，且提供了运行时热更新接口。
 *
 * 三个关键行为：
 *   1. 弹簧阻尼跟随：位置不硬跟随，而是带惯性地追，产生「重量感」
 *   2. 防穿墙：从观察点向相机位置做形状探测，撞墙则把相机拉近，而不是穿进去
 *   3. 冲刺时的 FOV 外扩与镜头滞后：速度感的主要来源
 */

import * as THREE from 'three';
import { config } from '../config.js';
import { GROUP } from '../physics/world.js';

export class ThirdPersonCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {object} phys 物理接口，只用 raycast
   */
  constructor(camera, phys) {
    this.camera = camera;
    this.phys = phys;

    /** 相机实际位置（平滑后） */
    this.position = new THREE.Vector3(0, 4, 8);
    /** 观察点（机甲头部附近，也做平滑） */
    this.lookAt = new THREE.Vector3(0, 1.6, 0);
    /** 平滑速度，用于弹簧积分 */
    this._vel = new THREE.Vector3();

    /** 当前实际距离（受防穿墙影响，会在基准距离与最小距离之间变化） */
    this.currentDistance = config.camera.distance;
    this._targetDistance = config.camera.distance;

    /** 基础 FOV */
    this.baseFov = camera.fov;
    this._fov = camera.fov;

    /** 屏幕震动 */
    this._shakeAmount = 0;
    this._shakeDecay = 3.4;
    this._shakeOffset = new THREE.Vector3();

    /** 后坐力对俯仰的瞬时抬升，会自然回落 */
    this._recoilPitch = 0;
    this._recoilYaw = 0;

    /** 冲刺时的额外 FOV */
    this._dashFov = 0;

    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();
  }

  /** 施加一次屏幕震动。amount 大约 0..1 */
  shake(amount) {
    const scaled = amount * config.fx.shakeScale;
    this._shakeAmount = Math.min(1.6, this._shakeAmount + scaled);
  }

  /** 施加后坐力。pitch 向上抬，yaw 随机左右偏 */
  kick(pitch, yaw = 0) {
    this._recoilPitch += pitch;
    this._recoilYaw += yaw;
  }

  /**
   * 每帧更新。
   *
   * @param {number} dt
   * @param {object} mech 机甲快照
   * @param {{yaw:number, pitch:number}} aim 相机朝向
   */
  update(dt, mech, aim) {
    const C = config.camera;

    // ── 后坐力回落 ──
    this._recoilPitch *= Math.max(0, 1 - dt * 9.5);
    this._recoilYaw *= Math.max(0, 1 - dt * 9.5);

    const yaw = aim.yaw + this._recoilYaw;
    const pitch = Math.max(C.pitchMin, Math.min(C.pitchMax, aim.pitch + this._recoilPitch));

    // ── 观察点：机甲上半身，跟随稍微滞后于位置 ──
    const targetLook = this._tmpVec.set(
      mech.pos.x,
      mech.pos.y + C.height,
      mech.pos.z,
    );
    // lookAt 用较高的跟随速度，避免转向时画面拖尾
    const lookLerp = Math.min(1, dt * 14);
    this.lookAt.lerp(targetLook, lookLerp);

    // ── 相机理想位置：从观察点沿视线反方向退开 ──
    const dir = this._tmpVec2.set(0, 0, 0);
    const cp = Math.cos(pitch);
    // 相机在瞄准方向的后方
    dir.x = Math.sin(yaw) * cp;
    dir.y = -Math.sin(pitch);
    dir.z = Math.cos(yaw) * cp;
    dir.normalize();

    // ── 防穿墙：探测从小球到目标距离 ──
    const probeOrigin = {
      x: this.lookAt.x,
      y: this.lookAt.y + C.shoulder * 0.4,
      z: this.lookAt.z,
    };
    const hit = this.phys.raycast({
      origin: probeOrigin,
      dir: { x: dir.x, y: dir.y, z: dir.z },
      maxToi: C.distance + C.probeRadius,
      group: 0,
      // 只与关卡几何碰撞：不能因为敌人挡住而把镜头拉近
      mask: GROUP.LEVEL,
    });

    // 命中时把距离收到命中点之前，留出探测球半径
    let desired = C.distance;
    if (hit) {
      desired = Math.max(C.minDistance, hit.toi - C.probeRadius);
    }

    // 拉近要快（避免穿墙一瞬露馅），推远要慢（避免抖）
    const distLerp = desired < this.currentDistance
      ? Math.min(1, dt * 26)
      : Math.min(1, dt * 6.5);
    this.currentDistance += (desired - this.currentDistance) * distLerp;

    // ── 相机目标位置 ──
    // 肩部偏移必须沿**右方向**，而不是前方向。
    // 早期实现用的是 (cos yaw, -sin yaw)，那是「前方」向量——
    // 结果镜头不是偏到侧面，而是沿视线方向前后挪动（等于偷偷改变距离），
    // 同时永远偏不出「过肩视角」的效果。
    // 右方向 = (cos yaw, 0, -sin yaw)，与移动逻辑和模型朝向同一套约定。
    const shoulderX = Math.cos(yaw) * C.shoulder;
    const shoulderZ = -Math.sin(yaw) * C.shoulder;

    const targetX = this.lookAt.x + dir.x * this.currentDistance + shoulderX;
    const targetY = this.lookAt.y + dir.y * this.currentDistance + C.shoulder * 0.5;
    const targetZ = this.lookAt.z + dir.z * this.currentDistance + shoulderZ;

    // ── 弹簧阻尼积分 ──
    // 用临界阻尼近似的弹簧：a = k*(target - pos) - d*vel
    const k = C.stiffness;
    const d = C.damping;

    const ax = k * (targetX - this.position.x) - d * this._vel.x;
    const ay = k * (targetY - this.position.y) - d * this._vel.y;
    const az = k * (targetZ - this.position.z) - d * this._vel.z;

    this._vel.x += ax * dt;
    this._vel.y += ay * dt;
    this._vel.z += az * dt;

    this.position.x += this._vel.x * dt;
    this.position.y += this._vel.y * dt;
    this.position.z += this._vel.z * dt;

    // ── 屏幕震动 ──
    if (this._shakeAmount > 0.0005) {
      const a = this._shakeAmount;
      const t = performance.now() * 0.001;
      // 用不同频率的正弦叠加，比随机数更平滑，不会有「噪点」感
      this._shakeOffset.set(
        Math.sin(t * 47.3) * a * 0.28,
        Math.sin(t * 61.7 + 1.3) * a * 0.24,
        Math.sin(t * 53.1 + 2.7) * a * 0.28,
      );
      this._shakeAmount -= this._shakeAmount * this._shakeDecay * dt;
      if (this._shakeAmount < 0.0005) this._shakeAmount = 0;
    } else {
      this._shakeOffset.multiplyScalar(0.8);
    }

    // ── 冲刺时的 FOV 外扩 ──
    const dashTarget = mech.dashing ? C.dashFovKick : 0;
    this._dashFov += (dashTarget - this._dashFov) * Math.min(1, dt * (mech.dashing ? 14 : 6));

    // 速度带来的轻微 FOV 变化，增强高速感
    const speed = Math.hypot(mech.velX || 0, mech.velZ || 0);
    const speedFov = Math.min(3.2, speed * 0.28);

    const fovTarget = this.baseFov + this._dashFov + speedFov;
    this._fov += (fovTarget - this._fov) * Math.min(1, dt * 8);

    // ── 写回相机 ──
    this.camera.position.set(
      this.position.x + this._shakeOffset.x,
      this.position.y + this._shakeOffset.y,
      this.position.z + this._shakeOffset.z,
    );
    this.camera.lookAt(this.lookAt.x, this.lookAt.y + C.shoulder * 0.2, this.lookAt.z);

    if (Math.abs(this.camera.fov - this._fov) > 0.01) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** 立即把相机放到机甲身后，用于开局与房间切换，避免镜头从上一间飞过来 */
  snapBehind(mech, aim) {
    const C = config.camera;
    this.lookAt.set(mech.pos.x, mech.pos.y + C.height, mech.pos.z);

    const cp = Math.cos(aim.pitch);
    const dir = new THREE.Vector3(
      Math.sin(aim.yaw) * cp,
      -Math.sin(aim.pitch),
      Math.cos(aim.yaw) * cp,
    ).normalize();

    this.position.copy(this.lookAt).addScaledVector(dir, C.distance);
    this.position.y += C.shoulder * 0.5;
    this._vel.set(0, 0, 0);
    this.currentDistance = C.distance;
    this._recoilPitch = 0;
    this._recoilYaw = 0;
    this._shakeAmount = 0;
    this._dashFov = 0;
    this._fov = this.baseFov;

    this.camera.position.copy(this.position);
    this.camera.lookAt(this.lookAt.x, this.lookAt.y + C.shoulder * 0.2, this.lookAt.z);
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
  }
}
