/**
 * 全局可调参数。
 *
 * 设计约束：所有影响手感的数值都必须在这个对象里，不得硬编码在逻辑中。
 * 理由见设计文档 §4——调参者看不到运行画面，参数必须运行时可调、可导出。
 * `diagnostics/panel.js` 会把本对象映射成滑杆，`main.js` 不读取任何其他数值来源。
 */

export const config = {
  camera: {
    /** 相机到机甲的基准距离（米） */
    distance: 7.4,
    /** 观察点相对机甲原点的抬高量，避免盯着脚底 */
    height: 1.9,
    /** 相机自身跟随的垂直偏移 */
    shoulder: 0.55,
    /** 弹簧刚度：越大跟得越紧，太大会抖 */
    stiffness: 92,
    /** 阻尼：越大越不容易过冲，太大会拖沓 */
    damping: 17,
    /** 俯仰限位（弧度） */
    pitchMin: -0.62,
    pitchMax: 0.92,
    /** 鼠标灵敏度倍率 */
    sensitivity: 1.0,
    /** 相机碰撞回退时的最小距离，防止穿进机甲内部 */
    minDistance: 1.8,
    /** 相机防穿墙的探测球半径 */
    probeRadius: 0.34,
    /** 冲刺时 FOV 外扩量（度） */
    dashFovKick: 11,
  },

  mech: {
    /** 最大移动速度（米/秒） */
    maxSpeed: 8.6,
    /** 加速度，决定起步跟手程度 */
    accel: 62,
    /** 地面摩擦减速度 */
    friction: 13,
    /** 空中操控力度占地面的比例 */
    airControl: 0.32,
    /** 机体重力（米/秒²）——机甲偏重，比真实重力大 */
    gravity: 26.5,
    /** 机甲站立高度（胶囊体圆柱段） */
    height: 1.75,
    /** 机甲半径 */
    radius: 0.52,
    /** 机甲朝向的转向速度（弧度/秒），机甲不瞬转 */
    turnSpeed: 13.5,
    /** 最大生命值 */
    maxHp: 100,
    /** 受击后的无敌时间（秒），避免被瞬间秒杀 */
    invulnTime: 0.32,
  },

  dash: {
    /** 冲刺瞬时速度（米/秒） */
    speed: 21,
    /** 冲刺持续时间（秒） */
    duration: 0.19,
    /** 冲刺冷却（秒） */
    cooldown: 1.35,
    /** 冲刺结束后保留的水平速度比例 */
    exitSpeedMul: 0.44,
    /** 冲刺是否可用时需要在地面 */
    requireGround: false,
  },

  heat: {
    /** 脉冲炮每次开火积累的热量 */
    perShot: 7.2,
    /** 过热阈值 */
    max: 100,
    /** 未过热时的散热速率（每秒） */
    coolRate: 26,
    /** 过热状态下的散热速率（每秒）——过热后恢复更慢，构成惩罚 */
    overheatCoolRate: 15,
    /** 冷却：最后一次开火后多久才开始散热（秒） */
    coolDelay: 0.28,
    /** 过热后强制停机时长（秒） */
    overheatLockout: 2.6,
  },

  weapons: {
    pulse: {
      /** 每次开火的间隔（秒） */
      fireRate: 0.148,
      /** 单发伤害 */
      damage: 11,
      /** 射线最远距离 */
      range: 140,
      /** 静止时的最小散布（弧度） */
      spread: 0.0035,
      /** 连续开火时散布增长到上限所需比例 */
      spreadGrowth: 3.4,
      /** 散布上限 */
      spreadMax: 0.036,
      /** 后坐力对镜头的抬升（弧度/发） */
      recoil: 0.012,
      /** 射线检测碰撞半径，越大越容易命中 */
      probeRadius: 0.09,
    },
    scatter: {
      fireRate: 0.72,
      /** 单颗弹丸伤害，共 pellets 颗 */
      damage: 6.5,
      pellets: 7,
      range: 34,
      spread: 0.075,
      recoil: 0.028,
      probeRadius: 0.07,
    },
  },

  /** 敌人基础数值，具体敌人类型在 simulation/enemyTypes.js 里覆写 */
  enemy: {
    gravity: 26.5,
    /** 受击硬直时长（秒） */
    hitStun: 0.11,
    /** 死亡后残骸保留时长（秒） */
    corpseDecay: 2.4,
    /** 与世界碰撞时最多可爬升的台阶高度 */
    stepHeight: 0.42,
  },

  world: {
    /** 房间内部边长（米） */
    roomSize: 34,
    /** 墙体高度 */
    wallHeight: 6.4,
    /** 房间之间通道的宽度 */
    corridorWidth: 5.2,
    /** 单个区域包含的房间数 */
    roomsPerRun: 5,
    /** 碰撞用的固定物理步长（秒） */
    fixedStep: 1 / 60,
    /** 单帧最多补算多少个物理步，防止卡顿后雪崩 */
    maxSubSteps: 5,
  },

  fx: {
    /** 泛光强度 */
    bloomStrength: 0.62,
    /** 泛光半径 */
    bloomRadius: 0.42,
    /** 泛光阈值 */
    bloomThreshold: 0.86,
    /** 曝光 */
    exposure: 1.02,
    /** 屏幕震动强度倍率 */
    shakeScale: 1.0,
    /** 命中停顿（秒），给射击重量感；0 为关闭 */
    hitStop: 0.028,
  },
};

/** 生成一份深拷贝，用于重置 / 导出对比 */
export function cloneConfig(src = config) {
  return JSON.parse(JSON.stringify(src));
}

/** 把外部（如导出的 JSON）的值合并回 config，只接受已存在的键 */
export function mergeConfig(patch, target = config) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in target)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) mergeConfig(v, target[k]);
    else if (typeof v === typeof target[k]) target[k] = v;
  }
  return target;
}
