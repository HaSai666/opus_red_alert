"""本地静态服务器：自动选一个空闲端口，起服务，并打开浏览器。

为什么需要它：
  本项目用 ES Module + WebAssembly，浏览器在 file:// 协议下会以 CORS 为由
  拒绝加载模块。必须通过 HTTP 提供。

为什么不用 `python -m http.server 8080`：
  8080 常被其他项目占用。写死端口会静默地把别人的页面当成自己的（本项目的
  启动脚本就曾因此打开了另一个项目）。这里主动探测空闲端口，避免撞车。

用法：
    python scripts/serve.py            # 自动选端口并打开浏览器
    python scripts/serve.py 9000       # 指定端口
    python scripts/serve.py --no-open  # 不打开浏览器
"""
from __future__ import annotations

import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 候选端口。避开 8080/3000 等常见占用者，但也在列表里保留，
# 因为多数情况下它们其实是空的。
CANDIDATES = [8080, 8123, 8888, 9000, 9090, 7788, 0]


class Handler(http.server.SimpleHTTPRequestHandler):
    """静态文件服务。

    两个必要的调整：
      1. 明确 .js / .mjs / .wasm 的 MIME 类型 —— 浏览器对 ES Module 的
         MIME 类型有硬性要求，类型不对会直接拒绝执行模块。
      2. 关闭缓存 —— 开发期改完代码刷新就该看到新结果。
    """

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 默认日志每请求一行，噪音太大；只保留错误
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("  [%s] %s\n" % (args[1], args[0]))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def find_free_port(preferred: list[int]) -> int:
    """按优先级返回第一个可绑定的端口。0 交给系统分配。"""
    for port in preferred:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("127.0.0.1", port))
                return port
        except OSError:
            continue
    return 0


def main() -> int:
    args = [a for a in sys.argv[1:]]
    no_open = "--no-open" in args
    args = [a for a in args if a != "--no-open"]

    wanted = None
    if args:
        try:
            wanted = int(args[0])
        except ValueError:
            print(f"端口必须是数字，收到：{args[0]}")
            return 2

    candidates = [wanted] if wanted else CANDIDATES
    port = find_free_port(candidates)

    try:
        httpd = Server(("127.0.0.1", port), Handler)
    except OSError as e:
        print(f"无法监听端口 {port}：{e}")
        return 1

    # 系统分配端口时，取实际绑定的那个
    port = httpd.server_address[1]
    url = f"http://127.0.0.1:{port}/"

    print()
    print("  MECHA // ROGUE")
    print("  " + "-" * 46)
    print(f"  地址: {url}")
    print(f"  目录: {ROOT}")
    print("  按 Ctrl+C 停止")
    print("  " + "-" * 46)
    print()

    if not no_open:
        # 稍微延迟再开浏览器，确保监听已就绪
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
