/**
 * 程序化机甲模型。
 *
 * 为什么不用 GLTF 资产：设计文档 §3 计划使用 CC0 模型，但当前环境无法下载外部
 * 资产。机械体恰好是最适合程序化生成的题材——硬表面几何体、无面部、无骨骼动画，
 * 因此这里用图元拼装一台机甲，并保留「日后换成 GLTF 只需替换 buildMech 的返回」
 * 的接口形状。
 *
 * 返回的 Object3D 具有命名部件，供动画代码按名字取用：
 *   torso / head / armL / armR / legL / legR / thrusterL / thrusterR / muzzleR / muzzleL
 */

import * as THREE from 'three';

/** 机甲主色板 */
export const MECH_PALETTE = {
  armor: 0x6f7a8c,      // 主装甲：冷灰蓝
  armorDark: 0x3d4552,  // 暗部装甲
  accent: 0xff9a3c,     // 配色点缀：橙
  joint: 0x23272f,      // 关节与机械件
  metal: 0x9aa3b0,      // 裸金属
  glow: 0xffb454,       // 发光件
  visor: 0x4ad4ff,      // 头部传感器
};

/**
 * 创建一个标准材质的辅助函数。
 * 机甲用 MeshStandardMaterial：金属度偏高、粗糙度中低，靠环境贴图出金属质感。
 */
function mat(color, { metalness = 0.72, roughness = 0.42, emissive = 0, emissiveIntensity = 0 } = {}) {
  const m = new THREE.MeshStandardMaterial({
    color,
    metalness,
    roughness,
    emissive: emissive ? new THREE.Color(emissive) : new THREE.Color(0x000000),
    emissiveIntensity,
  });
  return m;
}

/** 建一个盒子网格并设置阴影 */
function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(g, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** 圆柱（用于关节、炮管） */
function cyl(rTop, rBot, h, material, seg = 12) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * 构建机甲。
 *
 * 尺寸约定：脚底在 y=0，总高约 2.35，与 physics 里的胶囊体（高 1.75 + 半径 0.52）匹配。
 *
 * @returns {THREE.Group} 带命名部件的机甲根节点
 */
export function buildMech() {
  const root = new THREE.Group();
  root.name = 'mech';

  const mArmor = mat(MECH_PALETTE.armor, { metalness: 0.68, roughness: 0.46 });
  const mDark = mat(MECH_PALETTE.armorDark, { metalness: 0.6, roughness: 0.55 });
  const mJoint = mat(MECH_PALETTE.joint, { metalness: 0.9, roughness: 0.35 });
  const mMetal = mat(MECH_PALETTE.metal, { metalness: 0.95, roughness: 0.26 });
  const mAccent = mat(MECH_PALETTE.accent, { metalness: 0.5, roughness: 0.4, emissive: MECH_PALETTE.accent, emissiveIntensity: 0.35 });
  const mGlow = mat(0x2a1c0a, { metalness: 0.3, roughness: 0.6, emissive: MECH_PALETTE.glow, emissiveIntensity: 2.4 });
  const mVisor = mat(0x061018, { metalness: 0.2, roughness: 0.15, emissive: MECH_PALETTE.visor, emissiveIntensity: 2.0 });

  // ── 躯干 ─────────────────────────────────────
  const torso = new THREE.Group();
  torso.name = 'torso';
  torso.position.y = 1.24;

  // 胸腔：上宽下窄的机甲剪影
  torso.add(box(0.80, 0.52, 0.56, mArmor, 0, 0.10, 0));
  torso.add(box(0.94, 0.20, 0.62, mDark, 0, 0.36, 0));      // 肩甲横梁
  torso.add(box(0.62, 0.42, 0.46, mDark, 0, -0.22, 0));     // 腰部收窄
  torso.add(box(0.70, 0.10, 0.50, mAccent, 0, 0.47, 0));    // 顶部橙色条

  // 胸口发光核心
  const core = box(0.22, 0.14, 0.06, mGlow, 0, 0.14, -0.30);
  torso.add(core);
  torso.userData.core = core;

  // 背包 + 推进器
  torso.add(box(0.66, 0.44, 0.22, mDark, 0, 0.06, 0.36));
  const thrusterL = new THREE.Group();
  const thrusterR = new THREE.Group();
  thrusterL.name = 'thrusterL';
  thrusterR.name = 'thrusterR';
  for (const [grp, sx] of [[thrusterL, -0.24], [thrusterR, 0.24]]) {
    grp.position.set(sx, 0.06, 0.48);
    const shell = cyl(0.11, 0.13, 0.30, mJoint, 10);
    shell.rotation.x = Math.PI / 2;
    grp.add(shell);
    // 喷口内壁（发光）——冲刺时加大 emissive
    const inner = cyl(0.085, 0.085, 0.30, mGlow, 10);
    inner.rotation.x = Math.PI / 2;
    grp.add(inner);
    grp.userData.flame = inner;
    torso.add(grp);
  }

  // ── 头部 ─────────────────────────────────────
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, 0.50, -0.04);
  head.add(box(0.34, 0.24, 0.32, mArmor));
  head.add(box(0.30, 0.07, 0.05, mVisor, 0, 0.01, -0.17));  // 传感器条
  head.add(box(0.06, 0.10, 0.06, mJoint, -0.16, 0.16, 0));  // 天线座
  head.add(box(0.03, 0.22, 0.03, mAccent, -0.16, 0.30, 0)); // 天线
  torso.add(head);
  root.add(torso);

  // ── 手臂：肩 → 上臂 → 肘 → 前臂 → 炮 ─────────
  /**
   * 手臂结构。右臂是脉冲炮（长管），左臂是散射炮（短粗）。
   * 用嵌套 Group 表示骨骼层级，动画时只转上层，下层跟随。
   */
  function buildArm(side) {
    const isRight = side > 0;
    const shoulder = new THREE.Group();
    shoulder.name = isRight ? 'armR' : 'armL';
    shoulder.position.set(side * 0.60, 0.30, 0);

    // 肩甲
    const pad = box(0.26, 0.24, 0.34, mArmor, side * 0.05, 0.04, 0);
    shoulder.add(pad);
    shoulder.add(box(0.30, 0.08, 0.36, mAccent, side * 0.05, 0.16, 0)); // 肩甲橙色缘

    // 肩关节球
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.10, 12, 10), mJoint);
    ball.position.set(0, -0.10, 0);
    ball.castShadow = true;
    shoulder.add(ball);

    // 上臂
    const upper = new THREE.Group();
    upper.name = isRight ? 'upperArmR' : 'upperArmL';
    upper.position.y = -0.12;
    upper.add(box(0.20, 0.30, 0.22, mDark, 0, -0.16, 0));
    shoulder.add(upper);

    // 肘关节
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 10), mJoint);
    elbow.position.y = -0.32;
    elbow.castShadow = true;
    upper.add(elbow);

    // 前臂 + 武器
    const forearm = new THREE.Group();
    forearm.name = isRight ? 'forearmR' : 'forearmL';
    forearm.position.y = -0.34;
    upper.add(forearm);

    // 前臂壳
    forearm.add(box(0.22, 0.34, 0.24, mArmor, 0, -0.16, 0));

    const muzzle = new THREE.Object3D();
    muzzle.name = isRight ? 'muzzleR' : 'muzzleL';

    if (isRight) {
      // 右臂：细长脉冲炮管，带散热环
      const barrel = cyl(0.055, 0.065, 0.62, mMetal, 12);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, -0.30, -0.22);
      forearm.add(barrel);

      for (let i = 0; i < 3; i++) {
        const ring = cyl(0.078, 0.078, 0.03, mJoint, 12);
        ring.rotation.x = Math.PI / 2;
        ring.position.set(0, -0.30, -0.06 - i * 0.17);
        forearm.add(ring);
      }

      // 炮口发光
      const glow = cyl(0.048, 0.048, 0.03, mGlow, 10);
      glow.rotation.x = Math.PI / 2;
      glow.position.set(0, -0.30, -0.52);
      forearm.add(glow);
      forearm.userData.muzzleGlow = glow;

      muzzle.position.set(0, -0.30, -0.56);
    } else {
      // 左臂：短粗散射炮，带弹鼓
      const barrel = cyl(0.095, 0.11, 0.34, mMetal, 12);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, -0.28, -0.20);
      forearm.add(barrel);

      const drum = cyl(0.115, 0.115, 0.16, mDark, 10);
      drum.rotation.z = Math.PI / 2;
      drum.position.set(side * -0.02, -0.34, 0.04);
      forearm.add(drum);

      const glow = cyl(0.08, 0.08, 0.03, mGlow, 10);
      glow.rotation.x = Math.PI / 2;
      glow.position.set(0, -0.28, -0.36);
      forearm.add(glow);
      forearm.userData.muzzleGlow = glow;

      muzzle.position.set(0, -0.28, -0.40);
    }

    forearm.add(muzzle);
    shoulder.userData.upper = upper;
    shoulder.userData.forearm = forearm;

    return shoulder;
  }

  const armR = buildArm(1);
  const armL = buildArm(-1);
  torso.add(armR);
  torso.add(armL);

  // ── 腿部：髋 → 大腿 → 膝 → 小腿 → 足 ─────────
  function buildLeg(side) {
    const hip = new THREE.Group();
    hip.name = side > 0 ? 'legR' : 'legL';
    hip.position.set(side * 0.24, 1.00, 0);

    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), mJoint);
    ball.castShadow = true;
    hip.add(ball);

    const thigh = new THREE.Group();
    thigh.position.y = -0.10;
    thigh.add(box(0.26, 0.34, 0.28, mArmor, 0, -0.18, 0));
    hip.add(thigh);

    const knee = new THREE.Mesh(new THREE.SphereGeometry(0.095, 12, 10), mJoint);
    knee.position.y = -0.36;
    knee.castShadow = true;
    thigh.add(knee);

    const shin = new THREE.Group();
    shin.position.y = -0.38;
    thigh.add(shin);

    // 小腿：反关节（向后弯），机甲感的来源之一
    shin.add(box(0.22, 0.36, 0.24, mDark, 0, -0.18, 0.02));
    shin.add(box(0.24, 0.10, 0.26, mArmor, 0, -0.36, 0.02));

    // 足部
    const foot = new THREE.Group();
    foot.position.set(0, -0.42, 0);
    foot.add(box(0.30, 0.11, 0.46, mJoint, 0, 0, -0.06));
    foot.add(box(0.32, 0.05, 0.16, mAccent, 0, 0.06, 0.12)); // 脚跟橙色块
    shin.add(foot);

    hip.userData = { thigh, shin, foot };
    return hip;
  }

  const legR = buildLeg(1);
  const legL = buildLeg(-1);
  root.add(legR);
  root.add(legL);

  // ── 收尾 ─────────────────────────────────────
  root.userData.parts = { torso, head, armR, armL, legR, legL, thrusterL, thrusterR };
  root.userData.muzzles = { right: armR.getObjectByName('muzzleR'), left: armL.getObjectByName('muzzleL') };
  root.userData.materials = { mGlow, mAccent, mVisor, mArmor, mDark };

  return root;
}

/**
 * 机甲每帧动画。
 *
 * 输入是只读快照——本函数**不得**修改 any 传入的状态。
 *
 * @param {THREE.Group} mech buildMech 的返回值
 * @param {object} s simulation.snapshot().mech
 * @param {number} dt
 * @param {number} time 累计时间，用于正弦循环
 */
export function animateMech(mech, s, dt, time) {
  const p = mech.userData.parts;
  if (!p) return;

  // 移动速度决定步态幅度
  const speed = Math.hypot(s.velX || 0, s.velZ || 0);
  const moveT = Math.min(1, speed / 8.6);

  // ── 呼吸 / 待机浮动 ──
  const breathe = Math.sin(time * 1.6) * 0.012;
  const bob = Math.sin(time * (2.2 + moveT * 7.5)) * (0.028 + moveT * 0.055);

  // ── 腿部：交替摆动 ──
  const stride = Math.sin(time * (2.2 + moveT * 7.5));
  const legAmp = 0.30 * moveT;

  if (p.legR) {
    p.legR.userData.thigh.rotation.x = stride * legAmp;
    p.legR.userData.shin.rotation.x = -Math.max(0, stride) * legAmp * 1.5;
    p.legR.userData.foot.rotation.x = -stride * legAmp * 0.5;
  }
  if (p.legL) {
    const strideL = -stride;
    p.legL.userData.thigh.rotation.x = strideL * legAmp;
    p.legL.userData.shin.rotation.x = -Math.max(0, strideL) * legAmp * 1.5;
    p.legL.userData.foot.rotation.x = -strideL * legAmp * 0.5;
  }

  // ── 躯干：随步态轻微上下与侧倾 ──
  if (p.torso) {
    p.torso.position.y = 1.24 + bob + breathe;
    p.torso.rotation.z = stride * 0.035 * moveT;
    p.torso.rotation.x = moveT * 0.06;   // 移动时前倾，速度感
  }

  // ── 头部：轻微反向补偿，保持「看前方」 ──
  if (p.head) {
    p.head.rotation.z = -stride * 0.02 * moveT;
  }

  // ── 手臂：非冲刺时保持举枪姿态 ──
  // 瞄准姿态：两臂略微前指、肘部内收，枪口朝前方
  const aimPose = -1.32;   // 上臂前抬角度
  const recoilT = s.recoil || 0;

  if (p.armR) {
    p.armR.rotation.x = aimPose + stride * 0.05 * moveT - recoilT * 0.4;
    p.armR.rotation.z = 0.06;
    p.armR.userData.upper.rotation.x = 0.18;
  }
  if (p.armL) {
    p.armL.rotation.x = aimPose + 0.06 - (-stride) * 0.05 * moveT - recoilT * 0.5;
    p.armL.rotation.z = -0.08;
    p.armL.userData.upper.rotation.x = 0.22;
  }

  // ── 推进器：冲刺时全开 ──
  const dashT = s.dashing ? 1 : 0;
  const thrusterBase = dashT * 1.0 + moveT * 0.18;
  for (const t of [p.thrusterL, p.thrusterR]) {
    if (!t) continue;
    const flame = t.userData.flame;
    if (flame?.material) {
      // 冲刺时喷口发亮，待机时暗
      flame.material.emissiveIntensity = 2.0 + thrusterBase * 9.0;
    }
    t.scale.setScalar(1 + dashT * 0.10 + Math.sin(time * 40) * 0.02 * dashT);
  }

  // ── 胸口核心：随热量升高而变红 ──
  const core = p.torso?.userData.core;
  if (core?.material) {
    const heatT = Math.min(1, s.heat / Math.max(1, s.heatMax));
    // 从暖橙到报警红
    core.material.emissive.setRGB(1.0, 0.72 - heatT * 0.55, 0.33 - heatT * 0.28);
    core.material.emissiveIntensity = 2.0 + heatT * 5.5 + (s.overheated ? Math.sin(time * 22) * 2.5 : 0);
  }

  // ── 过热：全身装甲泛红，视觉上是「惩罚」的主要反馈 ──
  const armorMats = [mech.userData.materials?.mArmor, mech.userData.materials?.mDark];
  for (const m of armorMats) {
    if (!m) continue;
    if (s.overheated) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 14);
      m.emissive.setRGB(0.9, 0.18, 0.06);
      m.emissiveIntensity = 0.55 + pulse * 0.5;
    } else {
      m.emissive.setRGB(0, 0, 0);
      m.emissiveIntensity = 0;
    }
  }

  // ── 受击闪白 ──
  if (s.hitFlash > 0.01 && mech.userData.materials?.mArmor) {
    const f = s.hitFlash;
    mech.userData.materials.mArmor.emissive.setRGB(f * 0.8, f * 0.8, f * 0.9);
    mech.userData.materials.mArmor.emissiveIntensity = f * 2.2;
  }

  // ── 冲刺姿态：前倾并收腿 ──
  if (dashT > 0 && p.torso) {
    p.torso.rotation.x = 0.28;
  }
}

/**
 * 构建一个敌人模型。
 * 三类敌人用不同剪影区分，便于玩家在混乱中快速识别威胁类型。
 *
 * @param {string} kind 'charger' | 'ranged' | 'heavy'
 * @param {number} color 主色
 * @returns {THREE.Group}
 */
export function buildEnemy(kind, color) {
  const root = new THREE.Group();
  root.name = `enemy-${kind}`;

  const mBody = mat(color, { metalness: 0.55, roughness: 0.5 });
  const mDark = mat(0x22262e, { metalness: 0.8, roughness: 0.42 });
  const mGlow = mat(0x1a0a0a, { metalness: 0.2, roughness: 0.5, emissive: color, emissiveIntensity: 2.6 });
  const mEye = mat(0x100404, { metalness: 0.1, roughness: 0.2, emissive: 0xff3322, emissiveIntensity: 3.0 });

  if (kind === 'charger') {
    // 突袭机：低矮、前倾、尖头——暗示「冲过来」的威胁
    root.add(box(0.62, 0.42, 0.72, mBody, 0, 0.82, 0));
    root.add(box(0.44, 0.24, 0.40, mDark, 0, 1.12, 0.10));
    // 前部尖刺
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.44, 6), mDark);
    spike.rotation.x = -Math.PI / 2;
    spike.position.set(0, 0.86, -0.52);
    spike.castShadow = true;
    root.add(spike);
    // 传感器眼
    root.add(box(0.34, 0.06, 0.05, mEye, 0, 1.04, -0.14));
    // 悬浮下肢（无腿，简化动画且符合机械设定）
    root.add(box(0.16, 0.34, 0.16, mDark, -0.22, 0.50, 0.10));
    root.add(box(0.16, 0.34, 0.16, mDark, 0.22, 0.50, 0.10));
    const thrust = box(0.30, 0.06, 0.22, mGlow, 0, 0.30, 0.10);
    root.add(thrust);
    root.userData.glow = thrust;
  } else if (kind === 'ranged') {
    // 射手机：瘦高、单臂炮、明显的传感器——暗示「远距离威胁」
    root.add(box(0.46, 0.70, 0.40, mBody, 0, 1.02, 0));
    root.add(box(0.34, 0.26, 0.34, mDark, 0, 1.48, 0));       // 头
    root.add(box(0.26, 0.07, 0.05, mEye, 0, 1.50, -0.16));    // 眼
    // 单臂炮（右）
    const arm = new THREE.Group();
    arm.position.set(0.30, 1.12, 0);
    arm.add(box(0.16, 0.16, 0.52, mDark, 0, 0, -0.22));
    const barrel = cyl(0.05, 0.055, 0.34, mMetal, 10);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0, -0.62);
    arm.add(barrel);
    arm.add(box(0.10, 0.10, 0.08, mGlow, 0, 0, -0.78));
    root.add(arm);
    root.userData.arm = arm;
    // 左臂配重
    root.add(box(0.16, 0.30, 0.18, mDark, -0.30, 0.96, 0));
    // 细腿
    root.add(box(0.13, 0.62, 0.15, mDark, -0.14, 0.42, 0));
    root.add(box(0.13, 0.62, 0.15, mDark, 0.14, 0.42, 0));
    root.add(box(0.20, 0.08, 0.30, mBody, -0.14, 0.10, -0.05));
    root.add(box(0.20, 0.08, 0.30, mBody, 0.14, 0.10, -0.05));
  } else {
    // 重装机：宽大、厚重、双臂炮——一眼看出是硬目标
    root.add(box(1.00, 0.80, 0.72, mBody, 0, 1.36, 0));
    root.add(box(0.80, 0.30, 0.60, mDark, 0, 1.86, 0));       // 肩甲
    root.add(box(0.42, 0.30, 0.38, mDark, 0, 2.14, 0));       // 头
    root.add(box(0.35, 0.08, 0.05, mEye, 0, 2.16, -0.19));
    // 双臂重炮
    for (const sx of [-0.62, 0.62]) {
      const arm = new THREE.Group();
      arm.position.set(sx, 1.50, 0);
      arm.add(box(0.28, 0.34, 0.34, mDark, 0, -0.14, 0));
      const barrel = cyl(0.09, 0.10, 0.60, mMetal, 10);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, -0.26, -0.44);
      arm.add(barrel);
      arm.add(box(0.14, 0.14, 0.10, mGlow, 0, -0.26, -0.76));
      root.add(arm);
    }
    // 粗腿
    for (const sx of [-0.30, 0.30]) {
      root.add(box(0.26, 0.80, 0.30, mDark, sx, 0.60, 0));
      root.add(box(0.34, 0.14, 0.50, mBody, sx, 0.14, -0.06));
    }
    root.add(box(0.60, 0.10, 0.30, mGlow, 0, 1.00, 0.34));    // 背部散热
    root.userData.glow = root.children[root.children.length - 1];
  }

  root.userData.kind = kind;
  return root;
}

/**
 * 敌人每帧动画：悬浮起伏、受击抖动、瘫痪下垂、死亡倾倒。
 *
 * @param {THREE.Group} obj
 * @param {object} s 敌人快照
 * @param {number} dt
 * @param {number} time
 */
export function animateEnemy(obj, s, dt, time) {
  if (!obj) return;
  const kind = obj.userData.kind;

  // 悬浮：所有敌人都有一点上下浮动，机械感
  const hover = Math.sin(time * 2.4 + (s.id % 7)) * 0.05;

  if (!s.alive) {
    // 死亡：向前倾倒并下沉，透明度由 render 层控制
    obj.rotation.z = THREE.MathUtils.lerp(obj.rotation.z, 1.45, Math.min(1, dt * 4));
    obj.position.y = s.pos.y + Math.max(-0.35, -0.35 * (1 - s.corpseTimer / 2.4));
    return;
  }

  obj.position.y = s.pos.y + hover;

  // 受击抖动
  if (s.hitFlash > 0.01) {
    const j = s.hitFlash * 0.09;
    obj.position.x = s.pos.x + (Math.random() - 0.5) * j;
    obj.position.z = s.pos.z + (Math.random() - 0.5) * j;
  } else {
    obj.position.x = s.pos.x;
    obj.position.z = s.pos.z;
  }

  // 瘫痪：整体下垂并抖动，明确传达「暂时不构成威胁」
  if (s.disabled) {
    obj.rotation.x = 0.22;
    obj.position.y = s.pos.y + hover - 0.22;
    obj.rotation.z = Math.sin(time * 30) * 0.07;
  } else {
    obj.rotation.x = THREE.MathUtils.lerp(obj.rotation.x, 0, Math.min(1, dt * 6));
    obj.rotation.z = THREE.MathUtils.lerp(obj.rotation.z, 0, Math.min(1, dt * 6));
  }

  // 射手机的手臂跟踪
  if (kind === 'ranged' && obj.userData.arm) {
    obj.userData.arm.rotation.x = Math.sin(time * 1.8) * 0.06;
  }

  // 发光件随受击闪亮
  const glow = obj.userData.glow;
  if (glow?.material) {
    glow.material.emissiveIntensity = 2.2 + s.hitFlash * 5.0 + Math.sin(time * 5) * 0.4;
  }
}
