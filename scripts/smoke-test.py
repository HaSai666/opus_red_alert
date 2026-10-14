"""Headless-Chrome smoke test for the mecha game.

Connects to Chrome's DevTools Protocol over WebSocket (stdlib only, no deps),
loads the page, and reports every console message, page error, failed request
and WebGL state. Exits non-zero if a runtime error or failed load appears.

Usage:  python -I smoke-test.py <url> [seconds]
"""
import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
USERDIR = os.path.join(os.environ.get("TEMP", "/tmp"), "mecha-cdp-profile")
DEBUG_PORT = 9333


# 让脚本无论从哪个目录调用都能 import 同目录的 cdp 模块。
# 缺少这一行会直接报 ModuleNotFoundError，且错误信息看起来像模块不存在，
# 而不是路径问题——很容易误判。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ─────────────────────────────── shared CDP client ──────────────────────
from cdp import WS, find_ws_url  # noqa: E402


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8123/"
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0

    args = [
        CHROME,
        "--headless=new",
        f"--remote-debugging-port={DEBUG_PORT}",
        f"--user-data-dir={USERDIR}",
        "--no-first-run", "--no-default-browser-check",
        "--disable-extensions", "--mute-audio",
        "--enable-unsafe-swiftshader",          # headless 下允许软件 WebGL
        "--use-gl=angle", "--use-angle=swiftshader",
        "--window-size=1280,720",
        "about:blank",
    ]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    console, errors, failed, exceptions = [], [], [], []
    ws = None
    try:
        wsurl = find_ws_url(DEBUG_PORT)
        if not wsurl:
            print("FATAL: could not reach Chrome DevTools endpoint")
            return 2
        ws = WS(wsurl)
        ws.send("Runtime.enable")
        ws.send("Log.enable")
        ws.send("Network.enable")
        ws.send("Page.enable")
        ws.send("Page.navigate", {"url": url})

        deadline = time.time() + seconds
        while time.time() < deadline:
            raw = ws.recv(timeout=0.6)
            if raw is None:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            method = msg.get("method")
            params = msg.get("params", {})
            if method == "Runtime.consoleAPICalled":
                text = " ".join(
                    str(a.get("value", a.get("description", "")))
                    for a in params.get("args", [])
                )
                lvl = params.get("type", "log")
                console.append((lvl, text))
                if lvl in ("error", "warning"):
                    errors.append((lvl, text))
            elif method == "Runtime.exceptionThrown":
                d = params.get("exceptionDetails", {})
                desc = d.get("exception", {}).get("description") or d.get("text", "")
                exceptions.append(desc)
            elif method == "Log.entryAdded":
                e = params.get("entry", {})
                lvl = e.get("level", "info")
                if lvl in ("error", "warning"):
                    errors.append((lvl, f'{e.get("text","")}  {e.get("url","")}'))
            elif method == "Network.loadingFailed":
                failed.append(f'{params.get("errorText","")} {params.get("requestId","")}')
    finally:
        if ws:
            ws.close()
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    print("=" * 66)
    print(f"console messages : {len(console)}")
    print(f"errors/warnings  : {len(errors)}")
    print(f"exceptions       : {len(exceptions)}")
    print(f"failed requests  : {len(failed)}")
    print("=" * 66)

    if console:
        print("\n--- console ---")
        for lvl, t in console[:60]:
            print(f"[{lvl}] {t[:300]}")
    if errors:
        print("\n--- errors / warnings ---")
        for lvl, t in errors[:60]:
            print(f"[{lvl}] {t[:400]}")
    if exceptions:
        print("\n--- uncaught exceptions ---")
        for e in exceptions[:20]:
            print(e[:1200])
    if failed:
        print("\n--- failed requests ---")
        for f in failed[:30]:
            print(f)

    bad = bool(exceptions or failed) or any(lvl == "error" for lvl, _ in errors)
    print("\nRESULT:", "FAIL" if bad else "PASS")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
