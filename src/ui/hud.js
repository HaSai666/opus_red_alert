/**
 * HUD 与界面更新。
 *
 * 严格只读：本模块接收快照，更新 DOM，绝不回写任何游戏状态。
 * 需要改变状态的交互（选择遗物、重开）通过回调交回给 main.js。
 */

export class Hud {
  /**
   * @param {object} deps
   * @param {(index:number) => void} deps.onChooseRelic
   * @param {() => void} deps.onReroll
   * @param {() => void} deps.onRetry
   */
  constructor(deps) {
    this.deps = deps;

    const $ = (id) => document.getElementById(id);
    this.el = {
      boot: $('boot'),
      bootFill: $('boot-fill'),
      bootMsg: $('boot-msg'),
      hud: $('hud'),

      barHp: $('bar-hp'), valHp: $('val-hp'),
      barHeat: $('bar-heat'), valHeat: $('val-heat'), heatWrap: $('heat-wrap'),
      barBoost: $('bar-boost'), valBoost: $('val-boost'),
      overheatWarn: $('overheat-warn'),

      room: $('val-room'), rooms: $('val-rooms'), enemies: $('val-enemies'),

      crosshair: $('crosshair'),
      hitmarker: $('hitmarker'),
      vignette: $('damage-vignette'),

      slotR: $('slot-r'), slotL: $('slot-l'), shell: $('val-shell'),
      relicStrip: $('relic-strip'),
      toasts: $('toast-stack'),

      relicScreen: $('relic-screen'),
      relicCards: $('relic-cards'),

      gameover: $('gameover'),
      overTitle: $('over-title'),
      overRoom: $('over-room'),
      overKills: $('over-kills'),
      overRelics: $('over-relics'),
      btnRetry: $('btn-retry'),

      paused: $('paused'),
      perf: $('perf'),
    };

    // 缓存上一次的值，避免每帧无谓的 DOM 写入（DOM 写入是 HUD 的主要开销）
    this._cache = {
      hp: -1, heat: -1, boost: -1, room: -1, enemies: -1,
      overheated: null, weapon: -1, shells: -1, relicCount: -1,
      reloading: null,
    };

    this._toastTimers = new Set();
    this._hitmarkerTimer = 0;

    // 遗物界面按钮
    this.el.btnRetry?.addEventListener('click', () => this.deps.onRetry?.());
    window.addEventListener('mecha-toast', (e) => this.toast(e.detail));

    this._buildRelicScreenHandlers();
  }

  // ══════════════════════════════════════════════════
  // 启动流程
  // ══════════════════════════════════════════════════

  setBootProgress(t, msg) {
    if (this.el.bootFill) this.el.bootFill.style.width = `${Math.round(t * 100)}%`;
    if (msg && this.el.bootMsg) this.el.bootMsg.textContent = msg;
  }

  hideBoot() {
    this.el.boot.hidden = true;
    this.el.hud.hidden = false;
  }

  showGameOver(win, stats) {
    this.el.gameover.hidden = false;
    this.el.overTitle.textContent = win ? '区域肃清' : '机体损毁';
    this.el.overTitle.className = win ? 'win' : 'lose';
    this.el.overRoom.textContent = String(stats.rooms ?? 1);
    this.el.overKills.textContent = String(stats.kills ?? 0);
    this.el.overRelics.textContent = String(stats.relics ?? 0);
    document.body.classList.add('show-cursor');
  }

  hideGameOver() {
    this.el.gameover.hidden = true;
  }

  setPaused(on) {
    this.el.paused.hidden = !on;
    document.body.classList.toggle('show-cursor', on);
  }

  // ══════════════════════════════════════════════════
  // 每帧更新
  // ══════════════════════════════════════════════════

  /**
   * @param {object} s simulation.snapshot()
   * @param {number} dt
   * @param {number} time
   */
  update(s, dt, time) {
    const c = this._cache;
    const m = s.mech;

    // ── 血条 ──
    const hpInt = Math.ceil(m.hp);
    if (hpInt !== c.hp) {
      c.hp = hpInt;
      const ratio = Math.max(0, m.hp / Math.max(1, m.maxHp));
      this.el.barHp.style.transform = `scaleX(${ratio})`;
      this.el.valHp.textContent = String(hpInt);
      // 低血时变色
      this.el.valHp.style.color = ratio < 0.3 ? 'var(--danger)' : '';
    }

    // ── 热量条 ──
    const heatRatio = Math.max(0, Math.min(1, m.heat / Math.max(1, m.heatMax)));
    const heatPct = Math.round(heatRatio * 100);
    if (heatPct !== c.heat) {
      c.heat = heatPct;
      this.el.barHeat.style.transform = `scaleX(${heatRatio})`;
      this.el.valHeat.textContent = `${heatPct}%`;
    }
    if (m.overheated !== c.overheated) {
      c.overheated = m.overheated;
      this.el.heatWrap.classList.toggle('critical', m.overheated);
      this.el.overheatWarn.hidden = !m.overheated;
      this.el.crosshair.classList.toggle('overheated', m.overheated);
    }
    // 过热中显示倒计时
    if (m.overheated) {
      const left = (1 - m.overheatRatio) * (m.mods?.overheatLockout ?? 2.6);
      this.el.valHeat.textContent = `过热 ${(m.overheatRatio * 100).toFixed(0)}%`;
    } else if (c.overheated === false) {
      this.el.valHeat.textContent = `${heatPct}%`;
    }

    // ── 冲刺 ──
    const boostReady = m.dashCd <= 0;
    const boostRatio = boostReady ? 1 : 1 - m.dashCd / Math.max(0.01, m.dashCdMax);
    const boostKey = Math.round(boostRatio * 20);
    if (boostKey !== c.boost) {
      c.boost = boostKey;
      this.el.barBoost.style.transform = `scaleX(${boostRatio})`;
      this.el.valBoost.textContent = boostReady ? '就绪' : `${m.dashCd.toFixed(1)}s`;
      this.el.valBoost.style.color = boostReady ? '' : 'var(--ink-faint)';
    }

    // ── 房间与敌人 ──
    if (s.roomIndex + 1 !== c.room) {
      c.room = s.roomIndex + 1;
      this.el.room.textContent = String(c.room);
      this.el.rooms.textContent = String(s.roomsTotal);
    }
    const aliveCount = s.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
    if (aliveCount !== c.enemies) {
      c.enemies = aliveCount;
      this.el.enemies.textContent = String(aliveCount);
    }

    // ── 武器 ──
    if (m.weapon !== c.weapon) {
      c.weapon = m.weapon;
      this.el.slotR.classList.toggle('active', m.weapon === 0);
      this.el.slotL.classList.toggle('active', m.weapon === 1);
    }
    const shellKey = m.reloading > 0 ? -1 : m.shells;
    if (shellKey !== c.shells) {
      c.shells = shellKey;
      this.el.shell.textContent = m.reloading > 0 ? '装填中' : String(m.shells);
      this.el.shell.parentElement.innerHTML = m.reloading > 0
        ? '动能 · <i style="color:var(--ink-faint)">装填中</i>'
        : `动能 · <i>${m.shells}</i>`;
    }

    // ── 遗物条 ──
    if (m.relics.length !== c.relicCount) {
      c.relicCount = m.relics.length;
      this._renderRelicStrip(m.relics);
    }

    // ── 命中标记淡出 ──
    if (this._hitmarkerTimer > 0) {
      this._hitmarkerTimer -= dt;
      if (this._hitmarkerTimer <= 0) this.el.hitmarker.className = '';
    }

    // ── 受击暗角 ──
    // 必须由 hitFlash 的**实际数值**驱动强度，而不是用一个布尔 class 挂着。
    // 早期实现是「hitFlash > 0.6 加 class，< 0.35 移除」，在那个区间里
    // 暗角会以满强度常驻——玩家血量正常时画面却被一层暗红罩住，
    // 看起来像是因为光照坏了。这里改为逐帧按比例设置透明度，让它随受击衰减。
    const vig = this.el.vignette;
    if (m.hitFlash > 0.01) {
      vig.style.opacity = String(Math.min(0.85, m.hitFlash * 0.72));
    } else if (vig.style.opacity !== '0') {
      vig.style.opacity = '0';
    }
  }

  _renderRelicStrip(relics) {
    const strip = this.el.relicStrip;
    strip.innerHTML = '';
    for (const r of relics) {
      const d = document.createElement('div');
      d.className = `relic ${r.rarity}`;
      d.textContent = r.icon || '◆';
      d.title = `${r.name}(${r.rarity})`;
      strip.appendChild(d);
    }
  }

  // ══════════════════════════════════════════════════
  // 反馈
  // ══════════════════════════════════════════════════

  /** 命中反馈。kill 为 true 时用红色标记 */
  hitmarker(kill = false) {
    const el = this.el.hitmarker;
    el.className = '';
    // 强制回流以重启动画
    void el.offsetWidth;
    el.className = kill ? 'pop kill' : 'pop';
    this._hitmarkerTimer = 0.24;
  }

  /**
   * 弹出一条提示。
   * @param {string} msg 支持简单 HTML
   * @param {number} duration 秒
   */
  toast(msg, duration = 2.4) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = msg;
    this.el.toasts.appendChild(el);

    const rm = setTimeout(() => {
      el.classList.add('fade');
      setTimeout(() => el.remove(), 420);
      this._toastTimers.delete(rm);
    }, duration * 1000);
    this._toastTimers.add(rm);

    // 最多保留 4 条
    while (this.el.toasts.children.length > 4) {
      this.el.toasts.firstChild?.remove();
    }
  }

  // ══════════════════════════════════════════════════
  // 遗物三选一
  // ══════════════════════════════════════════════════

  showRelicChoices(choices) {
    const wrap = this.el.relicCards;
    wrap.innerHTML = '';

    choices.forEach((r, i) => {
      const card = document.createElement('div');
      card.className = `card ${r.rarity}`;
      card.innerHTML = `
        <div class="keyhint">${i + 1}</div>
        <div class="rarity">${this._rarityLabel(r.rarity)}</div>
        <div class="name">${r.name}</div>
        <div class="desc">${r.desc}</div>
      `;
      card.addEventListener('click', () => this.deps.onChooseRelic?.(i));
      card.addEventListener('mouseenter', () => {
        for (const c of wrap.children) c.classList.remove('focused');
        card.classList.add('focused');
      });
      wrap.appendChild(card);
    });

    this.el.relicScreen.hidden = false;
    document.body.classList.add('show-cursor');
    this.hideGameOver();
  }

  hideRelicChoices() {
    this.el.relicScreen.hidden = true;
    document.body.classList.remove('show-cursor');
  }

  highlightRelic(index) {
    const kids = this.el.relicCards.children;
    for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('focused', i === index);
  }

  _rarityLabel(r) {
    return { common: '普通', rare: '稀有', legendary: '传说' }[r] || r;
  }

  _buildRelicScreenHandlers() {
    // 键盘选择在 main.js 里统一处理，这里只处理鼠标悬停
    this.el.relicCards?.addEventListener('mouseleave', () => {
      for (const c of this.el.relicCards.children) c.classList.remove('focused');
    });
  }
}

/** 顶部性能条文本 */
export function perfText(fps, drawCalls, tris, scale, enemies) {
  return [
    `FPS ${fps.toFixed(0)}`,
    `draw ${drawCalls}`,
    `tri ${(tris / 1000).toFixed(0)}k`,
    `res ${(scale * 100).toFixed(0)}%`,
    `enemy ${enemies}`,
  ].join('   ');
}
