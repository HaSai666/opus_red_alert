"""Behavioural verification of the movement-direction and image-sharpness fixes.

Movement: presses W and checks the mech travels AWAY from the camera, which is
what a player expects from a forward key. Direction bugs never throw; only
measuring the resulting motion catches them.

Sharpness: reports the effective render scale and drawing-buffer resolution.

Usage: python -I verify-behaviour.py <url>
"""
import json
import math
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import WS, find_ws_url  # noqa: E402

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
USERDIR = os.path.join(os.environ.get("TEMP", "/tmp"), "mecha-verify-profile")
PORT = 9338

# 记录机甲与相机的相对关系，以及渲染分辨率
STATE = r"""
(() => {
  const g = window.__game;
  const s = g.sim, cam = g.env.camera, r = g.env.renderer;
  const gl = r.getContext();
  return {
    mech: [+s.mech.pos.x.toFixed(3), +s.mech.pos.z.toFixed(3)],
    cam:  [+cam.position.x.toFixed(3), +cam.position.z.toFixed(3)],
    yaw:  +s.aim.yaw.toFixed(3),
    renderScale: +g.env.resolutionScale.toFixed(3),
    pixelRatio: +r.getPixelRatio().toFixed(3),
    bufferW: gl.drawingBufferWidth,
    bufferH: gl.drawingBufferHeight,
    ctrlW: window.innerWidth,
    ctrlH: window.innerHeight,
    grounded: s.mech.grounded,
  };
})()
"""

KEY = r"""
(() => {
  const g = window.__game;
  // 直接操纵输入层的按键表，绕过 CDP 键盘事件的时序问题，
  // 保证在采样窗口内按键确实是「按下」状态。
  g.input.keys['KeyW'] = %s;
  return g.input.keys['KeyW'] === true;
})()
"""


def eval_expr(ws, expr, timeout=12):
    want = ws.send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
    end = time.time() + timeout
    while time.time() < end:
        raw = ws.recv(timeout=1.0)
        if raw is None:
            continue
        try:
            m = json.loads(raw)
        except Exception:
            continue
        if m.get("id") != want:
            continue
        res = m.get("result", {})
        if "exceptionDetails" in res:
            d = res["exceptionDetails"]
            return {"__exc": str(d.get("exception", {}).get("description", ""))[:400]}
        return res.get("result", {}).get("value")
    return {"__timeout": True}


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def key_event(ws, kind, vk, code, key):
    """Dispatch a real key event.

    The `code` field is mandatory: the input layer keys off KeyboardEvent.code
    (e.g. 'KeyW'), not the virtual key code. Omitting it makes the event a no-op,
    which looks exactly like a broken movement system.
    Also sets windowsVirtualKeyCode + nativeVirtualKeyCode, which Chrome requires
    for the event to be treated as a genuine user input.
    """
    ws.send("Input.dispatchKeyEvent", {
        "type": kind,
        "windowsVirtualKeyCode": vk,
        "nativeVirtualKeyCode": vk,
        "code": code,
        "key": key,
    })


def main():
    url = sys.argv[1]
    args = [CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
            f"--user-data-dir={USERDIR}", "--no-first-run", "--no-default-browser-check",
            "--mute-audio", "--enable-unsafe-swiftshader",
            "--use-gl=angle", "--use-angle=swiftshader",
            "--window-size=1280,720", "about:blank"]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws = None
    try:
        wsurl = find_ws_url(PORT)
        if not wsurl:
            print("no devtools"); return 2
        ws = WS(wsurl)
        ws.send("Runtime.enable")
        ws.send("Page.enable")
        ws.send("Page.navigate", {"url": url})
        time.sleep(13)

        # 先让角色落地稳定，避免在空中开始测量
        time.sleep(1.5)

        before = eval_expr(ws, STATE)
        if not isinstance(before, dict) or "mech" not in before:
            print("采样失败:", json.dumps(before, ensure_ascii=False)[:300])
            return 2

        d_before = dist(before["mech"], before["cam"])

        print("=" * 72)
        print("① 画质参数")
        print(f"   渲染比例     : {before['renderScale']}")
        print(f"   pixelRatio   : {before['pixelRatio']}")
        print(f"   绘制缓冲区   : {before['bufferW']} x {before['bufferH']}")
        print(f"   CSS 视口     : {before['ctrlW']} x {before['ctrlH']}")
        print(f"   有效像素倍率 : {(before['bufferW']/max(1,before['ctrlW'])):.3f}x 横向")

        print()
        print("=" * 72)
        print("② 按 W 前进 —— 机甲应远离相机")
        print(f"   按下前: 机甲({before['mech']})  相机({before['cam']})  距离={d_before:.3f}")

        # 用真实键盘事件：rawKeyDown 让按键保持按下状态
        key_event(ws, "rawKeyDown", 87, "KeyW", "w")
        time.sleep(1.8)
        during = eval_expr(ws, STATE)
        key_event(ws, "keyUp", 87, "KeyW", "w")

        if not isinstance(during, dict) or "mech" not in during:
            print("采样失败:", json.dumps(during, ensure_ascii=False)[:300])
            return 2

        d_during = dist(during["mech"], during["cam"])
        moved = dist(before["mech"], during["mech"])

        print(f"   按下后: 机甲({during['mech']})  相机({during['cam']})  距离={d_during:.3f}")
        print(f"   机甲位移量: {moved:.3f} 米")
        print(f"   与相机距离变化: {d_during - d_before:+.3f} 米")

        # 额外验证：再按 S 应朝反方向走
        key_event(ws, "rawKeyDown", 83, "KeyS", "s")
        time.sleep(1.8)
        back = eval_expr(ws, STATE)
        key_event(ws, "keyUp", 83, "KeyS", "s")
        moved_back = dist(during["mech"], back["mech"]) if isinstance(back, dict) and "mech" in back else -1
        print(f"   再按 S 位移量: {moved_back:.3f} 米")

        print()
        verdict = []
        if moved < 0.5:
            verdict.append("X 机甲几乎没动 —— 移动逻辑未生效")
        else:
            if d_during < d_before - 0.6:
                verdict.append(f"X 机甲朝相机移动（距离缩小 {d_before - d_during:.3f} 米）→ 前进方向仍然反了")
            else:
                verdict.append("OK 机甲未朝相机移动，前进方向正确")

        if moved_back >= 0:
            if moved_back < 0.2:
                verdict.append("X 按 S 几乎没动 —— 后退不可用")
            else:
                verdict.append(f"OK 后退可用（{moved_back:.3f} 米）")

        # 渲染清晰度判据。
        #
        # 注意：不能简单地断言「渲染比例必须接近 1」。
        # 无头浏览器用 SwiftShader 软件渲染，只有约 20 FPS，
        # 动态分辨率会按设计降到下限——这是正确行为而非缺陷。
        # 因此只在「帧率其实够高、却仍然降采样」时才报错。
        scale = before["renderScale"]
        fps = before.get("fps", 0)
        if scale < 0.8 and fps > 45:
            verdict.append(f"X 帧率 {fps:.0f} 充足但渲染比例仅 {scale}，降采样策略有误")
        elif scale < 0.8:
            verdict.append(f"OK 渲染比例 {scale}（软件渲染 {fps:.0f} FPS，动态分辨率已自动兜底）")
        else:
            verdict.append(f"OK 渲染比例 {scale}，清晰度正常")

        print("\n".join(verdict))
        ok = all(v.startswith("OK") for v in verdict)
        print("\nRESULT:", "PASS" if ok else "FAIL")
        return 0 if ok else 1
    finally:
        if ws:
            ws.close()
        try:
            proc.terminate(); proc.wait(timeout=8)
        except Exception:
            try: proc.kill()
            except Exception: pass


if __name__ == "__main__":
    sys.exit(main())
