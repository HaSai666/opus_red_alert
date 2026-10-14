/**
 * 入口。
 *
 * 只做三件事：等待 DOM、装配 Game、处理致命错误。
 * 所有游戏逻辑在 render/game.js 里。
 */

import { Game } from './render/game.js';

const canvas = document.getElementById('viewport');
const bootMsg = document.getElementById('boot-msg');

/** 把加载进度写到启动遮罩上 */
function progress(t, msg) {
  const fill = document.getElementById('boot-fill');
  if (fill) fill.style.width = `${Math.round(t * 100)}%`;
  if (bootMsg && msg) bootMsg.textContent = msg;
}

/**
 * 探测 WebGL 2 是否可用。
 *
 * 在一个用完即弃的临时 canvas 上探测，绝不碰 #viewport —— 那个 canvas 要留给
 * WebGLRenderer。getContext 会锁定 canvas 的上下文类型，误操作会让渲染器拿不到
 * 上下文。
 *
 * 探测完成后主动释放上下文：浏览器对同时存在的 WebGL 上下文数量有上限（通常 16 个），
 * 泄漏一个探测上下文虽然不致命，但反复刷新页面时会累积。
 */
function hasWebGL2() {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** 致命错误：在遮罩上显示，避免黑屏无信息 */
function fatal(err) {
  console.error(err);
  if (!bootMsg) return;
  bootMsg.innerHTML = '';
  bootMsg.style.color = '#e8664a';
  bootMsg.style.letterSpacing = '0';
  bootMsg.style.textTransform = 'none';
  bootMsg.style.fontSize = '13px';
  bootMsg.style.whiteSpace = 'pre-wrap';
  bootMsg.style.textAlign = 'left';
  bootMsg.style.maxWidth = '640px';

  const hint = err?.message?.includes('WebGL')
    ? '\n\n这台机器或浏览器的 WebGL 不可用。请更新显卡驱动，或换用 Chrome / Edge 最新版。'
    : '\n\n请把上面的错误信息发给开发者。';

  bootMsg.textContent = `启动失败\n\n${err?.stack || err?.message || String(err)}${hint}`;
}

(async () => {
  try {
    if (!canvas) throw new Error('找不到 #viewport 画布');

    progress(0.02, '检查运行环境…');

    // 用一个**独立的临时 canvas** 探测 WebGL 2。
    // 不能在 #viewport 上探测：getContext('webgl2') 一旦在某个 canvas 上调用，
    // 该 canvas 的上下文类型就被固定了；再对它调 loseContext 会连带把
    // 之后 WebGLRenderer 要用的上下文一起销毁（表现为 "Context Lost" + 黑屏）。
    if (!hasWebGL2()) {
      throw new Error(
        'WebGL 2 不可用。本游戏需要 WebGL 2：环境贴图（PMREM）、'
        + '实例化渲染与后处理链都依赖它。请更新显卡驱动，或改用最新版 Chrome / Edge。',
      );
    }

    const game = new Game(canvas);
    await game.init(progress);

    // 诊断开关：?nopostfx=1 绕过 EffectComposer，直接渲染场景。
    // 用于区分「场景本身没画出来」与「后处理链把它抹掉了」这两类问题。
    const params = new URLSearchParams(location.search);
    if (params.has('nopostfx')) {
      const raw = game.env.renderer;
      game.postfx.render = () => {
        raw.setRenderTarget(null);
        raw.render(game.env.scene, game.env.camera);
      };
      console.info('[诊断] 已绕过后处理链直接渲染场景');
    }
    // ?nofog=1 关掉雾，排除雾把画面吃掉的可能
    if (params.has('nofog')) game.env.scene.fog = null;

    // ?clean=1 隐藏所有 HUD，用于截图评估纯画面。
    // 没有这个开关时，评估渲染质量必须隔着一层 HUD 去猜，容易把界面问题
    // 误判成光照问题（本项目的受击暗角就曾被误判过一次）。
    if (params.has('clean')) {
      // 同时设置标志位：Hud.hideBoot() 会在 start() 时把 #hud 的 hidden 置回 false，
      // 一次性设置会被覆盖，因此由主循环每帧重新压住。
      game.hideHud = true;
      document.getElementById('hud').hidden = true;
      document.getElementById('perf').style.display = 'none';
      console.info('[诊断] HUD 已隐藏（?clean=1）');
    }

    // ?god=1 玩家免疫伤害，用于长时间观察场景而不被敌人打死
    if (params.has('god')) {
      game.godMode = true;
      console.info('[诊断] 已开启无敌（?god=1）');
    }

    // ?nolock=1 绕过指针锁定门控，让移动/开火逻辑可被脚本驱动。
    // 无头浏览器点不出真实的指针锁定，没有这个开关就无法自动化验证
    // 「按 W 到底往哪走」这类操作问题——而操作恰恰是最需要反复确认的部分。
    if (params.has('nolock')) {
      game.ignorePointerLock = true;
      console.info('[诊断] 已绕过指针锁定门控（?nolock=1）');
    }

    // 暴露到全局，便于在控制台里调参和排查
    // （这也是设计文档 §4 里「参数可导出」的兜底通道：window.__game.debug 可以直接改）
    window.__game = game;

    game.start();

    // 友好提示：第一次进入需要点击才能锁定鼠标
    setTimeout(() => {
      if (!game.input.locked) {
        game.hud.toast('点击画面以锁定鼠标', 4);
      }
    }, 600);
  } catch (err) {
    fatal(err);
  }
})();

// 未捕获的错误也显示出来，不要让玩家面对一个静止的画面
window.addEventListener('error', (e) => {
  if (document.getElementById('boot')?.hidden) {
    console.error('[未捕获异常]', e.error || e.message);
  }
});
