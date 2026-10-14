/**
 * 遗物（强化模块）定义表。
 *
 * 设计红线（设计文档 §5）：每个遗物改变**机制**，不提供「+X% 伤害」式纯数值加成。
 * 判断标准：这个遗物是否让玩家产生一个之前不存在的决策？
 * 若不能，它就不该存在于本表。
 *
 * 实现方式：遗物只往 mech.mods 上挂标记位和倍率，具体效果由 player.js / weapons.js
 * 在相应时机查询。遗物本身不含每帧逻辑，便于测试。
 */

/** @typedef {'common'|'rare'|'legendary'} Rarity */

/**
 * @typedef {object} Relic
 * @property {string} id
 * @property {string} name
 * @property {Rarity} rarity
 * @property {string} desc     纯文本描述，UI 直接渲染（支持 <b> 标签）
 * @property {string} icon     单字符图标，用于 HUD 遗物条
 * @property {object} mods     挂到 mech.mods 的字段
 */

/** @type {Relic[]} */
export const RELICS = [
  // ── Common：小幅度改变行为，代价明确 ──────────────
  {
    id: 'surge_valve',
    name: '增压阀',
    rarity: 'common',
    icon: '▲',
    desc: '热量阈值 <b>+40%</b>，但过热后的停机时间<b>翻倍</b>。<br>用风险换输出窗口。',
    mods: { heatMaxMul: 1.4, overheatLockoutMul: 2.0 },
  },
  {
    id: 'light_frame',
    name: '轻量骨架',
    rarity: 'common',
    icon: '◈',
    desc: '移动速度 <b>+14%</b>，但最大生命 <b>-15</b>。<br>更灵活，也更脆。',
    mods: { speedMul: 1.14, maxHpAdd: -15 },
  },
  {
    id: 'quick_cycle',
    name: '快循环散热',
    rarity: 'common',
    icon: '≡',
    desc: '散热速率 <b>+35%</b>，但冲刺冷却 <b>+25%</b>。<br>持续输出换机动性。',
    mods: { coolRateMul: 1.35, dashCooldownMul: 1.25 },
  },
  {
    id: 'extended_mag',
    name: '扩容弹舱',
    rarity: 'common',
    icon: '▣',
    desc: '散射炮装弹量 <b>+4</b>，装填时间 <b>+30%</b>。<br>一次多打两轮还是少换一次弹。',
    mods: { shellAdd: 4, reloadTimeMul: 1.3 },
  },
  {
    id: 'reinforced_armor',
    name: '附加装甲',
    rarity: 'common',
    icon: '▤',
    desc: '最大生命 <b>+25</b>，移动速度 <b>-8%</b>。<br>站得住，但躲得慢。',
    mods: { maxHpAdd: 25, speedMul: 0.92 },
  },
  {
    id: 'coolant_injector',
    name: '冷却液喷射',
    rarity: 'common',
    icon: '❄',
    desc: '冲刺时<b>立即清除 20 点热量</b>。<br>把位移变成散热手段，鼓励贴身缠斗。',
    mods: { dashVent: 20 },
  },

  // ── Rare：引入新的战斗动作 ─────────────────────
  {
    id: 'blast_shield',
    name: '爆震护盾',
    rarity: 'rare',
    icon: '✦',
    desc: '冲刺穿过敌人时造成 <b>35 伤害</b>并将其击退。<br>让位移本身成为武器。',
    mods: { dashDamage: 35, dashKnockback: 9 },
  },
  {
    id: 'kinetic_recovery',
    name: '动能回收',
    rarity: 'rare',
    icon: '⟳',
    desc: '每次命中回复 <b>2 热量</b>（而非积累）。<br>持续开火不再积热，但命中率要求极高。',
    mods: { hitVent: 2 },
  },
  {
    id: 'hunter_protocol',
    name: '猎杀协议',
    rarity: 'rare',
    icon: '◎',
    desc: '敌人血量低于 <b>30%</b> 时，对其伤害 <b>+60%</b>。<br>改变目标优先级：先削血，再收割。',
    mods: { executeThreshold: 0.30, executeDamageMul: 1.6 },
  },
  {
    id: 'twin_core',
    name: '双联核心',
    rarity: 'rare',
    icon: '⋈',
    desc: '散射炮弹丸 <b>+4 颗</b>，单颗伤害 <b>-25%</b>。<br>近距离爆发更强，远距离更弱。',
    mods: { pelletAdd: 4, pelletDamageMul: 0.75 },
  },
  {
    id: 'phase_dash',
    name: '相位冲刺',
    rarity: 'rare',
    icon: '⇢',
    desc: '冲刺期间<b>免疫伤害</b>，但冲刺距离 <b>-25%</b>。<br>把冲刺当闪避用，而不是赶路。',
    mods: { dashInvuln: true, dashDistanceMul: 0.75 },
  },

  // ── Legendary：把惩罚变成资源 ──────────────────
  {
    id: 'overload_core',
    name: '过载核心',
    rarity: 'legendary',
    icon: '☢',
    desc: '过热不再是惩罚：停机期间释放电磁脉冲，<b>瘫痪周围 12 米内敌人 3 秒</b>。<br>把负面状态变成主动技。',
    mods: { overheatEmp: true, empRadius: 12, empDuration: 3.0 },
  },
  {
    id: 'reactive_plating',
    name: '反应装甲',
    rarity: 'legendary',
    icon: '✹',
    desc: '受到伤害时，向四周<b>弹射 8 枚破片</b>，每枚 20 伤害。<br>被包围时反而变强。',
    mods: { thorns: 8, thornsDamage: 20 },
  },
  {
    id: 'entropy_engine',
    name: '熵增引擎',
    rarity: 'legendary',
    icon: '∞',
    desc: '热量越高，射速越快：满热时射速 <b>+70%</b>。<br>逼你一直贴着过热边缘打。',
    mods: { heatFirerateScale: 0.7 },
  },
  {
    id: 'singularity_core',
    name: '奇点核心',
    rarity: 'legendary',
    icon: '◉',
    desc: '击杀敌人掉落奇点，拾取后<b>回复 12 生命</b>并<b>清空热量</b>。<br>把击杀转化为续航，滚雪球。',
    mods: { killDropsOrb: true, orbHeal: 12 },
  },
];

/** 按稀有度分档，用于抽取时按权重选择 */
export const RELICS_BY_RARITY = {
  common: RELICS.filter((r) => r.rarity === 'common'),
  rare: RELICS.filter((r) => r.rarity === 'rare'),
  legendary: RELICS.filter((r) => r.rarity === 'legendary'),
};

/** 稀有度抽取权重，随房间进度递增稀有度概率 */
export function rarityWeights(roomIndex, roomsTotal) {
  const t = roomsTotal > 1 ? roomIndex / (roomsTotal - 1) : 0; // 0 → 1
  return {
    common:    0.72 - 0.34 * t,
    rare:      0.24 + 0.18 * t,
    legendary: 0.04 + 0.16 * t,
  };
}

/**
 * 抽取 n 个不重复的遗物候选。
 * @param {import('../physics/level.js').Rng} rng
 * @param {number} roomIndex
 * @param {number} roomsTotal
 * @param {string[]} owned 已拥有的遗物 id（不再重复出现）
 * @param {number} n
 */
export function rollRelics(rng, roomIndex, roomsTotal, owned = [], n = 3) {
  const w = rarityWeights(roomIndex, roomsTotal);
  const out = [];
  const used = new Set(owned);

  for (let i = 0; i < n; i++) {
    // 最多尝试若干次，避免在池子耗尽时死循环
    for (let attempt = 0; attempt < 40; attempt++) {
      const roll = rng.next();
      let rarity;
      if (roll < w.legendary) rarity = 'legendary';
      else if (roll < w.legendary + w.rare) rarity = 'rare';
      else rarity = 'common';

      let pool = RELICS_BY_RARITY[rarity].filter((r) => !used.has(r.id));
      // 该档抽空则退化到任意可用档
      if (!pool.length) {
        pool = RELICS.filter((r) => !used.has(r.id));
        if (!pool.length) break;
      }

      const pick = pool[Math.floor(rng.next() * pool.length)];
      used.add(pick.id);
      out.push(pick);
      break;
    }
  }
  return out;
}

/**
 * 把一份遗物列表应用到 mods 累加器上。
 * 使用乘加分离：mul 类字段相乘，add 类字段相加。
 * @param {Relic[]} relics
 * @returns {object} 默认值填充后的完整 mods
 */
export function buildMods(relics) {
  /** @type {Record<string, number|boolean>} */
  const m = {
    heatMaxMul: 1,        coolRateMul: 1,     overheatLockoutMul: 1,
    speedMul: 1,          maxHpAdd: 0,        dashCooldownMul: 1,
    dashDistanceMul: 1,   pelletDamageMul: 1, damageMul: 1,
    dashVent: 0,          hitVent: 0,         shellAdd: 0,
    reloadTimeMul: 1,     fireRateMul: 1,
    dashDamage: 0,        dashKnockback: 0,   pelletAdd: 0,
    executeThreshold: 0,  executeDamageMul: 1,
    dashInvuln: false,    overheatEmp: false, empRadius: 0, empDuration: 0,
    thorns: 0,            thornsDamage: 0,
    heatFirerateScale: 0, killDropsOrb: false, orbHeal: 0,
  };

  for (const r of relics) {
    for (const [k, v] of Object.entries(r.mods)) {
      if (typeof v === 'boolean') m[k] = m[k] || v;
      else if (k.startsWith('maxHpAdd') || k === 'dashVent' || k === 'hitVent' ||
               k === 'shellAdd' || k === 'dashDamage' || k === 'dashKnockback' ||
               k === 'pelletAdd' || k === 'thorns' || k === 'thornsDamage' ||
               k === 'empRadius' || k === 'orbHeal') {
        m[k] = (m[k] || 0) + v;
      } else {
        // 倍率与系数相乘（executeThreshold 亦然，取最大者更合理）
        if (k === 'executeThreshold') m[k] = Math.max(m[k] || 0, v);
        else m[k] = (m[k] || 1) * v;
      }
    }
  }
  return m;
}
