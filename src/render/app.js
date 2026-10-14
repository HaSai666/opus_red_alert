/**
 * 渲染器与环境启动。
 *
 * 负责：WebGL 上下文、场景、基础光照环境、自适应分辨率。
 * 不负责：游戏循环（在 loop.js）、特效（在 fx.js / particles.js）。
 *
 * 光照策略：不用 HDRI 贴图（无法下载资产），改用程序化生成的渐变环境贴图。
 * 一个由代码画出的天空/地面渐变经 PMREM 处理后，能给金属材质提供可信的反射，
 * 这是「画面质感」的关键一环——没有环境反射的话，金属看起来像塑料。
 */

import * as THREE from 'three';
import { config } from '../config.js';

export class RenderApp {
  constructor(canvas) {
    this.canvas = canvas;

    // ── 渲染器 ──
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // 开启硬件 MSAA。之前关掉它是想省性能、把抗锯齿交给 SMAA，
      // 但实测「不抗锯齿 + 后期 SMAA」在低分辨率下边缘依旧发毛，
      // 而 MSAA 由 GPU 硬件承担，代价远小于画面收益。
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    // 像素比上限。之前是 1.75，在 2x 屏上相当于放弃了近一半的实际像素，
    // 画面会明显发虚。改为 2 以覆盖主流高 DPI 显示器，
    // 真正的性能兜底交给下面的动态分辨率机制。
    this.pixelRatioCap = 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x0a0b0e, 1);

    // ── 场景 ──
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0c10);
    // 雾的作用是「藏住房间边界 + 给纵深」，不是用来压暗画面。
    // 距离必须远大于房间尺度（房间对角线约 48m）：起雾点设在 26m 时，
    // 房间中后段会整个沉进黑雾，画面看起来像没打光。
    // 颜色用偏蓝的环境色而非近黑，避免远景糊成一块死黑。
    this.scene.fog = new THREE.Fog(0x1b2432, 46, 120);

    // ── 相机 ──
    this.camera = new THREE.PerspectiveCamera(64, 1, 0.1, 400);
    this.camera.position.set(0, 4, 8);

    // ── 环境 ──
    this._buildEnvironment();
    this._buildGlobalLights();

    // 自适应分辨率状态
    this._frameTimes = [];
    this._dynScale = 1.0;
    this._lastAdjust = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());

    // 页面隐藏时暂停渲染（省电，也避免切回来时时间步长巨大）
    this.hidden = false;
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden;
    });
  }

  /**
   * 程序化环境贴图。
   *
   * 用一个 Canvas 画一张「上方冷天光、下方暖地面反光」的渐变，
   * 经 PMREM 卷积后作为 scene.environment。
   * 成本极低，但让所有金属/粗糙材质瞬间获得可信的反射与漫反射光照。
   */
  _buildEnvironment() {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');

    // 垂直渐变：顶部冷色天光 → 中部暗 → 底部暖色地面反弹光
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0.00, '#5a7089');   // 顶部：冷灰蓝
    grad.addColorStop(0.34, '#2b333f');
    grad.addColorStop(0.52, '#141820');   // 地平线：最暗
    grad.addColorStop(0.74, '#2e2620');
    grad.addColorStop(1.00, '#4a3a2a');   // 底部：暖褐（地面反弹）
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // 左上角一个柔和的亮斑，模拟主光方向（给镜面高光一个来源）
    const spot = ctx.createRadialGradient(size * 0.28, size * 0.16, 0, size * 0.28, size * 0.16, size * 0.44);
    spot.addColorStop(0, 'rgba(255, 226, 180, 0.85)');
    spot.addColorStop(0.5, 'rgba(180, 170, 160, 0.22)');
    spot.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, size, size);

    // 右下一个较弱的冷色补光，避免暗部死黑
    const fill = ctx.createRadialGradient(size * 0.78, size * 0.72, 0, size * 0.78, size * 0.72, size * 0.40);
    fill.addColorStop(0, 'rgba(120, 160, 220, 0.42)');
    fill.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envRT = pmrem.fromEquirectangular(tex);
    this.scene.environment = envRT.texture;
    // 环境强度必须给足。机甲材质的金属度在 0.68–0.95，
    // 高金属度表面几乎不产生漫反射，成像完全依赖环境反射——
    // 环境一暗，金属直接变黑，看起来像没打光。
    this.scene.environmentIntensity = 1.75;

    this._envTarget = envRT;
    this._envSource = tex;
    pmrem.dispose();
  }

  /** 全局光：一个主方向光 + 两个补光，构成三点布光 */
  _buildGlobalLights() {
    // 环境光给足：机甲高金属度材质主要靠环境与方向光，纯环境光太弱会让暗部糊成黑块
    const amb = new THREE.AmbientLight(0x5c6a80, 1.05);
    this.scene.add(amb);

    // 主光：从左上打下来，负责投影
    const key = new THREE.DirectionalLight(0xfff0dc, 2.1);
    key.position.set(-18, 26, -12);
    key.castShadow = true;
    key.shadow.mapSize.set(1536, 1536);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 90;
    const ext = 34;
    key.shadow.camera.left = -ext;
    key.shadow.camera.right = ext;
    key.shadow.camera.top = ext;
    key.shadow.camera.bottom = -ext;
    key.shadow.bias = -0.0009;
    key.shadow.normalBias = 0.022;
    this.scene.add(key);
    this.keyLight = key;

    // 暖色补光：从右侧低角度，给机体暖侧（与冷环境形成色彩对比）
    const rim = new THREE.DirectionalLight(0xff9a5c, 0.42);
    rim.position.set(22, 8, 14);
    this.scene.add(rim);

    // 冷色轮廓光：从后方，勾勒机甲边缘——这是「剪影可读性」的关键
    const back = new THREE.DirectionalLight(0x6aa8ff, 0.55);
    back.position.set(6, 12, 26);
    this.scene.add(back);
    this.backLight = back;
  }

  /** 事件：把主光/轮廓光跟随玩家，保证角色始终在光照里（房间较大时必需） */
  followLighting(target) {
    if (!target) return;
    // 主光相对玩家的偏移保持不变
    this.keyLight.position.set(target.x - 18, target.y + 26, target.z - 12);
    this.keyLight.target.position.set(target.x, target.y, target.z);
    this.keyLight.target.updateMatrixWorld();

    this.backLight.position.set(target.x + 6, target.y + 12, target.z + 26);
    this.backLight.target.position.set(target.x, target.y, target.z);
    this.backLight.target.updateMatrixWorld();
  }

  /**
   * 同步画布尺寸与相机投影。
   *
   * 关键：相机的 aspect 必须从**渲染器实际使用的绘制缓冲区**推导，
   * 而不是从 window.innerWidth/Height。因为 setPixelRatio 会改变绘制缓冲区的
   * 实际像素数，一旦两者脱钩，投影矩阵就与实际视口不匹配——
   * 表现为画面被拉伸、物体跑到视野外（甚至整屏单色）。
   */
  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);

    this.renderer.setSize(w, h, false);
    // 让 canvas 的 CSS 尺寸铺满窗口（setSize 的第三个参数为 false 时不会自动设置）
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    // 用绘制缓冲区的真实像素数计算 aspect
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const aspect = size.y > 0 ? size.x / size.y : w / h;

    if (Math.abs(this.camera.aspect - aspect) > 1e-4) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }

    this.width = w;
    this.height = h;

    // 后处理链也要跟着尺寸走，否则 composer 用旧分辨率渲染，画面会错位或全黑
    this.onResize?.(w, h);
  }

  /**
   * 动态分辨率：帧率低于目标时降低渲染分辨率，高于目标时逐步恢复。
   *
   * 这是应对「肉鸽刷怪时粒子爆炸」这类瞬时负载的有效手段，
   * 但下限必须设得克制：分辨率一旦降到 62% 再被放大回屏幕，
   * 画面会糊成一团，观感损失远大于帧率收益。
   * 因此下限设在 0.85——留给性能波动的余量，同时不牺牲清晰度。
   *
   * @param {number} dt
   * @param {number} targetFps
   */
  adaptiveResolution(dt, targetFps = 58) {
    // 采样最近 60 帧
    this._frameTimes.push(dt);
    if (this._frameTimes.length > 60) this._frameTimes.shift();
    if (this._frameTimes.length < 40) return;

    const now = performance.now();
    // 每 700ms 最多调整一次，避免抖动
    if (now - this._lastAdjust < 700) return;

    const avg = this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;
    const fps = 1 / avg;

    let next = this._dynScale;
    if (fps < targetFps * 0.80) {
      // 降采样步长收窄，避免分辨率忽高忽低造成画面「呼吸」
      next = Math.max(config.fx.minRenderScale, this._dynScale - 0.05);
    } else if (fps > targetFps * 1.08 && this._dynScale < 1) {
      next = Math.min(1, this._dynScale + 0.05);
    }

    if (Math.abs(next - this._dynScale) > 0.005) {
      this._dynScale = next;
      const base = Math.min(window.devicePixelRatio || 1, this.pixelRatioCap);
      this.renderer.setPixelRatio(base * this._dynScale);
      // 改变像素比会改变绘制缓冲区尺寸，必须重新同步尺寸与投影，
      // 否则相机 aspect 会与实际视口脱钩（表现为画面拉伸或错位）。
      this.resize();
      this._lastAdjust = now;
    }
  }

  /** 当前实际渲染比例，供调试面板显示 */
  get resolutionScale() {
    return this._dynScale;
  }

  dispose() {
    this._envTarget?.dispose();
    this._envSource?.dispose();
    this.renderer.dispose();
  }
}
