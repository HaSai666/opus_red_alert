/**
 * 后处理链。
 *
 * 这是「画面质感」的主要来源（设计文档 §2：本作画面主体是屏幕空间特效，
 * 而非高面数几何）。链路顺序有讲究：
 *
 *   场景渲染 → 泛光 → SMAA → 色调映射输出
 *
 * 泛光必须在色调映射之前，否则高光已被压到 LDR，泛光提取不到能量。
 * 色调映射与 sRGB 转换由 OutputPass 在最后统一完成。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { config } from '../config.js';

/**
 * 自定义后期着色器：暗角 + 色差 + 受击红闪。
 *
 * 这三项都是「廉价但有效」的电影感来源：
 *   - 暗角（vignette）把视线收拢到画面中心
 *   - 径向色差在高能量时刻出现，模拟镜头受冲击
 *   - 受击时的全屏红闪是低成本的伤害反馈
 */
const CompositeShader = {
  uniforms: {
    tDiffuse:    { value: null },
    uTime:       { value: 0 },
    uVignette:   { value: 0.42 },
    uAberration: { value: 0.0 },
    uHitFlash:   { value: 0.0 },
    uOverheat:   { value: 0.0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    // 胶片颗粒强度。取值必须很小：它是对每个像素逐帧加随机扰动，
    // 一旦超过约 0.01 就会在静止画面上形成持续可见的噪点，
    // 主观感受是「糊」而不是「有质感」。0.02 时已经明显影响清晰度。
    uNoise:      { value: 0.005 },
    // 锐化强度。轻微锐化能显著改善「被后期流程柔化」后的观感，
    // 代价只有一次 3×3 采样。
    uSharpen:    { value: 0.42 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uAberration;
    uniform float uHitFlash;
    uniform float uOverheat;
    uniform float uNoise;
    uniform float uSharpen;
    uniform vec2  uResolution;
    varying vec2 vUv;

    // 廉价的伪随机，用于胶片颗粒
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec2 center = uv - 0.5;
      float dist = length(center);
      vec2 texel = 1.0 / uResolution;

      // ── 径向色差：越靠画面边缘越明显，强度由外力驱动 ──
      // 过热时始终有一层基础色差，暗示机体不稳定
      float ab = uAberration + uOverheat * 0.0035;
      vec3 col;
      if (ab > 0.0001) {
        vec2 dir = normalize(center + 1e-6);
        float off = ab * dist * 2.0;
        col.r = texture2D(tDiffuse, uv + dir * off).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - dir * off).b;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      // ── 锐化 ──
      // 整个后期链（泛光 + SMAA + 色调映射）都会柔化边缘，
      // 这里用一次十字拉普拉斯把细节找回来。
      // 放在色调映射之前操作，避免放大已被压缩的高光。
      if (uSharpen > 0.001) {
        vec3 n = texture2D(tDiffuse, uv + vec2(0.0,  texel.y)).rgb;
        vec3 s = texture2D(tDiffuse, uv + vec2(0.0, -texel.y)).rgb;
        vec3 e = texture2D(tDiffuse, uv + vec2( texel.x, 0.0)).rgb;
        vec3 w = texture2D(tDiffuse, uv + vec2(-texel.x, 0.0)).rgb;
        vec3 blur = (n + s + e + w) * 0.25;
        col += (col - blur) * uSharpen;
      }

      // ── 过热：画面边缘的红色脉冲 ──
      if (uOverheat > 0.0) {
        float edge = smoothstep(0.30, 0.78, dist);
        float pulse = 0.5 + 0.5 * sin(uTime * 12.0);
        col.r += edge * uOverheat * (0.18 + pulse * 0.16);
        col.g *= 1.0 - edge * uOverheat * 0.10;
        col.b *= 1.0 - edge * uOverheat * 0.16;
      }

      // ── 受击：全屏红冲 ──
      if (uHitFlash > 0.0) {
        col.r += uHitFlash * 0.30;
        col.g -= uHitFlash * 0.10;
        col.b -= uHitFlash * 0.12;
      }

      // ── 暗角 ──
      float vig = 1.0 - smoothstep(0.30, 0.86, dist) * uVignette;
      col *= vig;
      // 受击时暗角加深，制造压迫
      col *= 1.0 - uHitFlash * 0.18;

      // ── 胶片颗粒：消除大面积纯色的色带，增加质感 ──
      float n = hash(uv * uResolution + fract(uTime) * 137.0) - 0.5;
      col += n * uNoise;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const size = renderer.getSize(new THREE.Vector2());

    this.composer = new EffectComposer(renderer);
    this.composer.setSize(size.x, size.y);

    // 1. 基础场景渲染（HDR 目标，供泛光提取）
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // 2. 泛光：所有发光材质（枪口、推进器、能量弹）都会在此产生光晕
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      config.fx.bloomStrength,
      config.fx.bloomRadius,
      config.fx.bloomThreshold,
    );
    this.composer.addPass(this.bloomPass);

    // 3. 自定义合成：暗角 / 色差 / 受击 / 颗粒
    this.compositePass = new ShaderPass(CompositeShader);
    this.compositePass.uniforms.uResolution.value.set(size.x, size.y);
    this.composer.addPass(this.compositePass);

    // 4. SMAA 抗锯齿。放在色调映射之前对线性空间操作，边缘更干净。
    this.smaaPass = new SMAAPass(size.x, size.y);
    this.composer.addPass(this.smaaPass);

    // 5. 输出：色调映射 + sRGB 转换，必须最后
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    // 色调映射设为 ACES Filmic：高光滚降柔和，是「电影感」的关键
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = config.fx.exposure;

    // 内部状态：由 render 层每帧写入
    this._aberration = 0;
    this._hitFlash = 0;
    this._overheat = 0;
    this._time = 0;
  }

  /**
   * 每帧更新后期参数。
   * @param {number} dt
   * @param {object} s
   * @param {number} s.aberration 色差强度（由爆炸/冲刺等瞬时事件驱动）
   * @param {number} s.hitFlash   受击闪红 0..1
   * @param {number} s.overheatT  过热比例 0..1
   */
  update(dt, s = {}) {
    this._time += dt;

    // 瞬时值快速衰减，新的刺激会把它重新顶上去
    this._aberration = Math.max((s.aberration ?? 0), this._aberration - dt * 1.6);
    this._hitFlash = Math.max((s.hitFlash ?? 0), this._hitFlash - dt * 4.2);
    // 过热是持续状态，平滑跟随
    const oTarget = s.overheatT ?? 0;
    this._overheat += (oTarget - this._overheat) * Math.min(1, dt * 6);

    const u = this.compositePass.uniforms;
    u.uTime.value = this._time;
    u.uAberration.value = this._aberration;
    u.uHitFlash.value = this._hitFlash;
    u.uOverheat.value = this._overheat;
    // 从 config 同步颗粒与锐化，让调参面板能实时改动
    u.uNoise.value = config.fx.grain;
    u.uSharpen.value = config.fx.sharpen;
  }

  /** 触发一次屏幕色差冲击（爆炸、冲刺、重击） */
  kick(amount) {
    this._aberration = Math.max(this._aberration, amount);
  }

  /** 触发受击红闪 */
  flashHit(amount = 0.5) {
    this._hitFlash = Math.max(this._hitFlash, amount);
  }

  /** 渲染一帧 */
  render() {
    this.composer.render();
  }

  /** 同步尺寸变化 */
  setSize(w, h) {
    this.composer.setSize(w, h);
    this.bloomPass.setSize(w, h);
    this.smaaPass.setSize(w, h);
    this.compositePass.uniforms.uResolution.value.set(w, h);
  }

  /** 把 config 里的值同步到实际 pass 上（调参面板用） */
  syncFromConfig() {
    this.bloomPass.strength = config.fx.bloomStrength;
    this.bloomPass.radius = config.fx.bloomRadius;
    this.bloomPass.threshold = config.fx.bloomThreshold;
    this.renderer.toneMappingExposure = config.fx.exposure;
  }

  dispose() {
    this.composer.dispose?.();
    this.bloomPass.dispose?.();
    this.smaaPass.dispose?.();
  }
}
