/**
 * 运行时调参面板。
 *
 * 存在理由（设计文档 §4）：开发协作方看不到运行画面，第三人称手感只能靠人眼判断。
 * 因此所有手感数值必须运行时可调，并支持导出 JSON——调好之后把 JSON 发回来固化进
 * config.js。这条路径把「我看不到画面」这个最大劣势转化为可操作流程。
 *
 * 面板还提供三个自检开关：碰撞盒可视化、敌人状态、性能明细。
 */

import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { config, cloneConfig, mergeConfig } from '../config.js';

/** 数值滑杆的推荐调节区间与说明。区间外仍可用键盘输入。 */
const HINTS = {
  'camera.distance':      { min: 3, max: 14, step: 0.1, note: '太近会看不到机甲全身，太远瞄准变难。建议 6.5–8.5' },
  'camera.height':        { min: 0.8, max: 3.2, step: 0.05, note: '观察点高度。1.7–2.1 最自然' },
  'camera.shoulder':      { min: 0, max: 1.6, step: 0.05, note: '肩部偏移，0 为居中视角' },
  'camera.stiffness':     { min: 20, max: 220, step: 1, note: '太小镜头拖沓，太大抖动。70–140' },
  'camera.damping':       { min: 4, max: 40, step: 0.5, note: '经验值 ≈ 2×sqrt(stiffness)。跟 stiffness 一起调' },
  'camera.sensitivity':   { min: 0.2, max: 3, step: 0.05, note: '鼠标灵敏度倍率' },
  'camera.dashFovKick':   { min: 0, max: 26, step: 0.5, note: '冲刺 FOV 外扩，速度感来源。8–16' },
  'mech.maxSpeed':        { min: 3, max: 16, step: 0.1, note: '机甲跑步最高速。7–10 有重量感' },
  'mech.accel':           { min: 10, max: 160, step: 1, note: '加速度决定起步跟手程度。45–80' },
  'mech.friction':        { min: 2, max: 40, step: 0.5, note: '松键后的减速。太小会滑冰' },
  'mech.turnSpeed':       { min: 3, max: 30, step: 0.5, note: '机甲转向速度。10–18，太快失去机械感' },
  'dash.speed':           { min: 8, max: 40, step: 0.5, note: '冲刺瞬时速度' },
  'dash.duration':        { min: 0.06, max: 0.6, step: 0.01, note: '冲刺时长。0.15–0.25 比较干脆' },
  'dash.cooldown':        { min: 0.2, max: 4, step: 0.05, note: '冲刺冷却，决定闪避节奏' },
  'heat.perShot':         { min: 1, max: 20, step: 0.1, note: '单发积热。越大越快过热' },
  'heat.coolRate':        { min: 5, max: 70, step: 1, note: '散热速率' },
  'heat.overheatLockout': { min: 0.5, max: 6, step: 0.1, note: '过热强制停机时长。2–4 秒有惩罚感' },
  'fx.bloomStrength':     { min: 0, max: 2, step: 0.02, note: '泛光强度。>1 容易糊' },
  'fx.bloomThreshold':    { min: 0.3, max: 1.5, step: 0.01, note: '泛光阈值。越低越多物体发光' },
  'fx.exposure':          { min: 0.4, max: 2, step: 0.02, note: '曝光' },
  'fx.shakeScale':        { min: 0, max: 3, step: 0.05, note: '屏幕震动倍率。0 可关闭（易晕者）' },
};

/**
 * 按点号路径设置 config 的值。
 */
function setPath(path, value) {
  const parts = path.split('.');
  let obj = config;
  for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
  obj[parts[parts.length - 1]] = value;
}

export class DebugPanel {
  /**
   * @param {object} deps
   * @param {() => object} deps.getStats 返回 {fps, drawCalls, tris, enemies, res}
   * @param {() => void} deps.onReset 重置一局
   * @param {(v:boolean) => void} deps.onToggleColliders
   * @param {(v:boolean) => void} deps.onToggleSlowMo
   */
  constructor(deps = {}) {
    this.deps = deps;
    this.gui = null;
    this.visible = false;

    /** 实时数值显示（只读），由 update() 刷新 */
    this.stats = { fps: 0, drawCalls: 0, tris: 0, enemies: 0, res: 1.0, phase: '-' };
    this._statControllers = {};

    /** 调试开关 */
    this.toggles = {
      colliders: false,
      slowMo: false,
      wireframe: false,
    };

    /** 慢动作倍率 */
    this.timeScale = 1;

    this.showStats = false;
  }

  /** 首次 F1 时创建 GUI（懒加载，减少启动时间） */
  build() {
    if (this.gui) return this.gui;

    const gui = new GUI({ title: 'MECHA // 调参', width: 320 });
    gui.domElement.style.zIndex = '60';
    this.gui = gui;

    // ══ 实时读数 ══
    const fStats = gui.addFolder('实时读数');
    fStats.open();
    for (const [key, label] of [
      ['fps', 'FPS'], ['drawCalls', 'Draw Calls'], ['tris', '三角形'],
      ['enemies', '存活敌人'], ['res', '分辨率比例'], ['phase', '阶段'],
    ]) {
      const c = fStats.add(this.stats, key).name(label).disable().listen();
      this._statControllers[key] = c;
      // 让只读项显示为文本而非滑杆
      if (typeof this.stats[key] === 'number') c._input?.setAttribute('type', 'text');
    }

    // ══ 相机 ══
    const fCam = gui.addFolder('相机');
    this._addSliders(fCam, 'camera', ['distance', 'height', 'shoulder', 'stiffness', 'damping', 'sensitivity', 'dashFovKick']);

    // ══ 机甲移动 ══
    const fMech = gui.addFolder('机甲移动');
    this._addSliders(fMech, 'mech', ['maxSpeed', 'accel', 'friction', 'turnSpeed', 'airControl']);

    // ══ 冲刺 ══
    const fDash = gui.addFolder('冲刺');
    this._addSliders(fDash, 'dash', ['speed', 'duration', 'cooldown', 'exitSpeedMul']);

    // ══ 热量 ══
    const fHeat = gui.addFolder('热量');
    this._addSliders(fHeat, 'heat', ['perShot', 'coolRate', 'coolDelay', 'overheatLockout', 'overheatCoolRate']);

    // ══ 武器 ══
    const fW = gui.addFolder('武器 · 脉冲炮');
    fW.close();
    this._addSliders(fW, 'weapons.pulse', ['fireRate', 'damage', 'spread', 'spreadMax', 'recoil']);
    const fS = gui.addFolder('武器 · 散射炮');
    fS.close();
    this._addSliders(fS, 'weapons.scatter', ['fireRate', 'damage', 'pellets', 'spread', 'range', 'recoil']);

    // ══ 画面 ══
    const fFx = gui.addFolder('画面');
    this._addSliders(fFx, 'fx', ['bloomStrength', 'bloomRadius', 'bloomThreshold', 'exposure', 'shakeScale', 'hitStop']);
    fFx.add(this.deps, 'onBloomChange').name('应用泛光设置');

    // ══ 调试开关 ══
    const fDbg = gui.addFolder('调试');
    fDbg.open();
    fDbg.add(this.toggles, 'colliders').name('显示碰撞盒').onChange((v) => this.deps.onToggleColliders?.(v));
    fDbg.add(this.toggles, 'slowMo').name('慢动作 0.25×').onChange((v) => {
      this.timeScale = v ? 0.25 : 1;
      this.deps.onToggleSlowMo?.(v);
    });
    fDbg.add(this, 'showStats').name('顶部性能条').onChange((v) => {
      document.body.classList.toggle('debug', v);
    });
    fDbg.add({ reset: () => this.deps.onReset?.() }, 'reset').name('重开一局');

    // ══ 导出 / 导入 ══
    const fIO = gui.addFolder('导出参数');
    fIO.close();
    fIO.add({ copy: () => this._copyConfig() }, 'copy').name('复制参数 JSON（发给我）');
    fIO.add({ download: () => this._downloadConfig() }, 'download').name('下载 config.json');
    fIO.add({ reset: () => this._resetConfig() }, 'reset').name('恢复默认值');

    gui.close();
    return gui;
  }

  /**
   * 为一个 config 子对象批量生成滑杆。
   * 优先使用 HINTS 里的推荐区间，没有则用当前值推断一个合理范围。
   */
  _addSliders(folder, path, keys) {
    for (const key of keys) {
      const full = `${path}.${key}`;
      const hint = HINTS[full];
      const value = this._get(path, key);

      if (hint) {
        const c = folder.add(this._proxy(path, key), key, hint.min, hint.max, hint.step);
        c.name(key);
        if (hint.note) c.domElement.title = hint.note;
        this._attachHint(c, hint);
      } else {
        // 无预设：按当前值推断范围
        const step = value < 1 ? 0.01 : value < 20 ? 0.1 : value < 200 ? 1 : 10;
        const min = 0;
        const max = Math.max(value * 3, 1);
        const c = folder.add(this._proxy(path, key), key, min, max, step);
        c.name(key);
      }
    }
  }

  /** 给滑杆加一行说明文字 */
  _attachHint(controller, hint) {
    const el = controller.domElement;
    if (!el || !hint.note) return;
    const note = document.createElement('div');
    note.textContent = hint.note;
    note.style.cssText = 'font-size:10px;line-height:1.4;color:#7b8494;padding:0 0 7px 8px;max-width:290px;';
    el.appendChild(note);
  }

  _get(path, key) {
    const parts = path.split('.');
    let obj = config;
    for (const p of parts) obj = obj[p];
    return obj[key];
  }

  /**
   * lil-gui 需要一个拥有可写属性的对象。
   * 直接传入 config 子对象即可——它是普通对象，lil-gui 会直接改它的属性。
   */
  _proxy(path) {
    const parts = path.split('.');
    let obj = config;
    for (const p of parts) obj = obj[p];
    return obj;
  }

  /** 刷新只读读数 */
  update() {
    if (!this.gui) return;
    const s = this.deps.getStats?.();
    if (!s) return;
    this.stats.fps = s.fps;
    this.stats.drawCalls = s.drawCalls;
    this.stats.tris = s.tris;
    this.stats.enemies = s.enemies;
    this.stats.res = s.res;
    this.stats.phase = s.phase;
  }

  toggle() {
    if (!this.gui) this.build();
    this.visible = !this.visible;
    if (this.visible) this.gui.open();
    else this.gui.close();
    return this.visible;
  }

  // ── 导出 ──────────────────────────────────────────

  _copyConfig() {
    const text = JSON.stringify(cloneConfig(), null, 2);
    // 剪贴板 API 在非 https 下不可用，降级到 textarea
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => this._toast('参数已复制到剪贴板'))
        .catch(() => this._fallbackCopy(text));
    } else {
      this._fallbackCopy(text);
    }
  }

  _fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      this._toast('参数已复制到剪贴板');
    } catch {
      this._toast('复制失败，请用下载');
    }
    document.body.removeChild(ta);
  }

  _downloadConfig() {
    const text = JSON.stringify(cloneConfig(), null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'config.json';
    a.click();
    URL.revokeObjectURL(url);
    this._toast('已下载 config.json');
  }

  _resetConfig() {
    // 从一份快照恢复：这里简单粗暴地重新载入默认值
    // （默认值在 config.js 里是字面量，所以用一个缓存的副本）
    if (!this._defaults) {
      this._defaults = cloneConfig();
      this._toast('已记录当前值为基准');
      return;
    }
    mergeConfig(this._defaults);
    this._refreshControllers();
    this._toast('已恢复默认值');
  }

  /** 值被程序修改后，让 GUI 控件同步显示 */
  _refreshControllers() {
    this.gui?.controllersRecursive?.().forEach((c) => c.updateDisplay());
  }

  _toast(msg) {
    window.dispatchEvent(new CustomEvent('mecha-toast', { detail: msg }));
  }

  destroy() {
    this.gui?.destroy();
    this.gui = null;
  }
}
