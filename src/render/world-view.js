/**
 * 房间几何的渲染层。
 *
 * 性能关键：一个房间有 15–30 个盒子，若每个盒子一个 Mesh，一个房间就是 30 次 draw call。
 * 这里按材质类别合并成 4 个网格（地板/墙/掩体/天花板各一），把 draw call 压到个位数。
 *
 * 材质用顶点色而非多材质：合并后仍是单次绘制，同时保留每个盒子的色调差异。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { config } from '../config.js';

/** 各类几何的材质参数 */
const KIND_STYLE = {
  floor:   { color: 0x2b313b, metalness: 0.30, roughness: 0.82 },
  wall:    { color: 0x374050, metalness: 0.42, roughness: 0.68 },
  cover:   { color: 0x4a5464, metalness: 0.55, roughness: 0.52 },
  pillar:  { color: 0x505b6d, metalness: 0.62, roughness: 0.45 },
  ceiling: { color: 0x232830, metalness: 0.35, roughness: 0.78 },
};

export class RoomView {
  constructor(scene) {
    this.scene = scene;
    /** @type {THREE.Group|null} */
    this.group = null;
    /** 共享材质，避免重复创建 */
    this._mats = {};
    for (const [kind, st] of Object.entries(KIND_STYLE)) {
      this._mats[kind] = new THREE.MeshStandardMaterial({
        color: 0xffffff,          // 由顶点色决定实际颜色
        vertexColors: true,
        metalness: st.metalness,
        roughness: st.roughness,
      });
    }
  }

  /**
   * 用一组形状重建房间。
   * @param {import('../physics/level.js').BoxShape[]} shapes
   */
  build(shapes) {
    this.dispose();

    const group = new THREE.Group();
    group.name = 'room';

    // 按 kind 分组，每组合并为单个几何体
    /** @type {Map<string, THREE.BufferGeometry[]>} */
    const byKind = new Map();
    for (const s of shapes) {
      if (!byKind.has(s.kind)) byKind.set(s.kind, []);
      byKind.get(s.kind).push(this._boxGeometry(s));
    }

    for (const [kind, geoms] of byKind) {
      if (!geoms.length) continue;
      const merged = mergeGeometries(geoms, false);
      // 合并后原几何可以释放
      for (const g of geoms) g.dispose();
      if (!merged) continue;

      const mesh = new THREE.Mesh(merged, this._mats[kind]);
      mesh.castShadow = kind !== 'floor' && kind !== 'ceiling';
      mesh.receiveShadow = true;
      mesh.name = `room-${kind}`;
      // 静态几何不需要每帧更新矩阵
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
    }

    this._addLights(group, shapes);
    this.scene.add(group);
    this.group = group;
  }

  /**
   * 生成一个带顶点色的盒子几何。
   * 顶点色 = 基础色调 × tint 系数，让相邻掩体有明暗差异而不增加材质数量。
   */
  _boxGeometry(s) {
    const g = new THREE.BoxGeometry(s.sx, s.sy, s.sz);
    g.translate(s.x, s.y, s.z);

    const base = KIND_STYLE[s.kind]?.color ?? 0x808080;
    const c = new THREE.Color(base);
    const tint = s.tint ?? 0.5;
    // tint 0 → 0.72 倍亮度，1 → 1.28 倍。避免过暗或过曝。
    const k = 0.72 + tint * 0.56;
    c.multiplyScalar(k);

    const count = g.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  }

  /**
   * 房间光照。
   *
   * 设计取舍：不加真实点光源（性能杀手），而是用 4 个角落的自发光面板 + 环境光
   * 制造「工业照明」的氛围。发光面板靠 Bloom 后处理产生光晕，成本极低。
   */
  _addLights(group, shapes) {
    const floor = shapes.find((s) => s.kind === 'floor');
    if (!floor) return;

    const H = config.world.wallHeight;
    const S = config.world.roomSize;
    const cx = floor.x, cz = floor.z;

    // 天花板上四条发光灯带
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0x1a1c20,
      emissive: 0xffd9a0,
      // 亮度刻意压低：这些灯带要的是「被 Bloom 晕开的光源」，
      // 数值给高会直接烧成白色色块，反而失去灯具的形体。
      emissiveIntensity: 1.55,
      metalness: 0.1,
      roughness: 0.5,
    });

    const lampGeo = new THREE.BoxGeometry(S * 0.62, 0.12, 0.30);
    const offsets = [
      { x: -S * 0.22, z: -S * 0.20 },
      { x:  S * 0.22, z: -S * 0.20 },
      { x: -S * 0.22, z:  S * 0.20 },
      { x:  S * 0.22, z:  S * 0.20 },
    ];
    for (const o of offsets) {
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(cx + o.x, H - 0.30, cz + o.z);
      lamp.matrixAutoUpdate = false;
      lamp.updateMatrix();
      group.add(lamp);
    }

    // 墙体腰线发光带，增强纵深与科幻感。
    // 亮度必须克制：这条带子横贯整个视野，一旦过曝就会变成一道
    // 刺眼的亮线，把玩家的注意力从战场拉走。它的作用是「勾边」，
    // 不是「照明」。
    const stripMat = new THREE.MeshStandardMaterial({
      color: 0x11151c,
      emissive: 0x2d6a9a,
      emissiveIntensity: 0.62,
      metalness: 0.2,
      roughness: 0.6,
    });
    const half = S / 2;
    const stripGeo = new THREE.BoxGeometry(S, 0.07, 0.05);
    for (const [pos, rotY] of [
      [{ x: cx, y: 1.6, z: cz - half + 0.05 }, 0],
      [{ x: cx, y: 1.6, z: cz + half - 0.05 }, 0],
    ]) {
      const strip = new THREE.Mesh(stripGeo, stripMat);
      strip.position.set(pos.x, pos.y, pos.z);
      strip.rotation.y = rotY;
      strip.matrixAutoUpdate = false;
      strip.updateMatrix();
      group.add(strip);
    }
    const stripGeoZ = new THREE.BoxGeometry(0.05, 0.07, S);
    for (const pos of [
      { x: cx - half + 0.05, y: 1.6, z: cz },
      { x: cx + half - 0.05, y: 1.6, z: cz },
    ]) {
      const strip = new THREE.Mesh(stripGeoZ, stripMat);
      strip.position.set(pos.x, pos.y, pos.z);
      strip.matrixAutoUpdate = false;
      strip.updateMatrix();
      group.add(strip);
    }

    // 房间中央一盏真实的点光源，提供方向感与阴影
    const key = new THREE.PointLight(0xffd0a0, 42, S * 1.3, 1.8);
    key.position.set(cx, H - 0.5, cz);
    key.castShadow = true;
    key.shadow.mapSize.set(512, 512);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = H + 4;
    key.shadow.bias = -0.004;
    group.add(key);
  }

  /** 释放房间资源 */
  dispose() {
    if (!this.group) return;
    this.group.traverse((o) => {
      if (o.isMesh) o.geometry?.dispose();
      // 材质是共享的，跨房间复用，不在这里释放
    });
    this.scene.remove(this.group);
    this.group = null;
  }

  /** 彻底释放（换局时若不再复用材质再调用） */
  disposeAll() {
    this.dispose();
    for (const m of Object.values(this._mats)) m.dispose();
  }
}
