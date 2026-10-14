/**
 * 输入采集。
 *
 * 只负责把物理输入归一化为一份每帧可读的快照，不解释语义。
 * 指针锁定（pointer lock）在此管理；未锁定时游戏逻辑照常运行但鼠标不产生转向。
 */

const KEY_MAP = {
  KeyW: 'forward',   ArrowUp: 'forward',
  KeyS: 'back',      ArrowDown: 'back',
  KeyA: 'left',      ArrowLeft: 'left',
  KeyD: 'right',     ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'dash',  ShiftRight: 'dash',
  KeyR: 'reload',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3',
  KeyF: 'interact',
  Tab: 'swap',
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;

    /** 本帧的按键状态 */
    this.keys = Object.create(null);
    /** 上一帧的按键状态，用于边沿检测 */
    this._prevKeys = Object.create(null);
    /** 鼠标按下（0=左键, 2=右键） */
    this.mouse = [false, false, false];
    this._prevMouse = [false, false, false];

    /** 累积的鼠标位移，读取后清零 */
    this.mouseDX = 0;
    this.mouseDY = 0;
    /** 本帧滚轮位移 */
    this.wheel = 0;

    /** 指针是否锁定 */
    this.locked = false;
    /** 是否被禁用（暂停/菜单） */
    this.enabled = true;

    /** 一次性事件回调：key -> [fn] */
    this._listeners = new Map();

    this._bind();
  }

  _bind() {
    const onKeyDown = (e) => {
      const action = KEY_MAP[e.code];
      // 阻止浏览器默认行为：空格滚动、Tab 切焦点、方向键滚动
      if (action || ['F1', 'F3', 'Escape'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys[e.code] = true;
      this._fire(e.code);
    };
    const onKeyUp = (e) => { this.keys[e.code] = false; };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // 失焦时清空按键，避免 Alt+Tab 后角色一直跑
    window.addEventListener('blur', () => { this.keys = Object.create(null); this.mouse = [false, false, false]; });

    const onMouseMove = (e) => {
      if (!this.locked || !this.enabled) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    };
    document.addEventListener('mousemove', onMouseMove);

    const onMouseDown = (e) => {
      if (e.button <= 2) this.mouse[e.button] = true;
      // 未锁定时点击画布即请求锁定
      if (!this.locked && this.enabled && e.target === this.canvas) this.requestLock();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', (e) => { if (e.button <= 2) this.mouse[e.button] = false; });
    document.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });

    document.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.onLockChange?.(this.locked);
    });
  }

  /** 请求指针锁定；浏览器可能拒绝（非用户手势），静默忽略 */
  requestLock() {
    if (this.locked) return;
    const p = this.canvas.requestPointerLock?.();
    // Chrome 新版返回 Promise，被拒绝时不要抛出未捕获异常
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  releaseLock() {
    if (this.locked) document.exitPointerLock?.();
  }

  /**
   * 注册一次性按键回调。
   * @param {string} code KeyboardEvent.code
   * @param {() => void} fn
   */
  on(code, fn) {
    if (!this._listeners.has(code)) this._listeners.set(code, []);
    this._listeners.get(code).push(fn);
  }

  _fire(code) {
    const fns = this._listeners.get(code);
    if (fns) for (const fn of fns) fn();
  }

  /** 语义动作是否按下 */
  action(name) {
    for (const [code, mapped] of Object.entries(KEY_MAP)) {
      if (mapped === name && this.keys[code]) return true;
    }
    return false;
  }

  /** 本帧是否刚按下某个键（边沿） */
  pressed(code) {
    return !!this.keys[code] && !this._prevKeys[code];
  }

  /** 本帧是否刚松开某个键 */
  released(code) {
    return !this.keys[code] && !!this._prevKeys[code];
  }

  /** 鼠标键边沿 */
  mousePressed(btn) {
    return this.mouse[btn] && !this._prevMouse[btn];
  }

  /** 移动轴，返回值域 [-1,1] 的 {x, y}，x 为右方向，y 为前方向 */
  moveAxis() {
    let x = 0, y = 0;
    if (this.action('right')) x += 1;
    if (this.action('left')) x -= 1;
    if (this.action('forward')) y += 1;
    if (this.action('back')) y -= 1;
    // 归一化，避免斜向移动比直线快
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }

  /**
   * 每帧末调用。
   * 必须在所有逻辑读取完输入之后执行，否则边沿检测会漏事件。
   */
  endFrame() {
    this._prevKeys = { ...this.keys };
    this._prevMouse = [...this.mouse];
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
