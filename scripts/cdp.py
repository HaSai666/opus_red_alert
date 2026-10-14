"""Chrome DevTools Protocol 的最小客户端（仅用标准库，无需安装依赖）。

被 smoke-test.py 与 verify-behaviour.py 共用。

为什么需要它：浏览器游戏的多数缺陷不会抛异常——方向反了、角色悬空、
画面全黑，控制台都是干净的。只有真正连进浏览器驱动输入、读取运行时状态，
才能把这类问题变成可断言的检查。
"""

import base64
import json
import os
import socket
import struct
import time
import urllib.request


class WS:
    def __init__(self, url):
        assert url.startswith("ws://")
        rest = url[5:]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port)), timeout=20)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /{path} HTTP/1.1\r\n"
            f"Host: {hostport}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("handshake closed")
            buf += chunk
        head, _, self._rest = buf.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise RuntimeError("handshake failed: " + head.decode(errors="replace")[:200])
        self._id = 0

    def send(self, method, params=None):
        self._id += 1
        payload = json.dumps({"id": self._id, "method": method, "params": params or {}})
        data = payload.encode()
        header = bytearray([0x81])
        mask = os.urandom(4)
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(header) + masked)
        return self._id

    def _read_exact(self, n):
        out = self._rest
        while len(out) < n:
            chunk = self.sock.recv(max(4096, n - len(out)))
            if not chunk:
                raise RuntimeError("socket closed")
            out += chunk
        self._rest = out[n:]
        return out[:n]

    def recv(self, timeout=1.0):
        self.sock.settimeout(timeout)
        try:
            b1, b2 = self._read_exact(2)
        except (socket.timeout, TimeoutError):
            return None
        opcode = b1 & 0x0F
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exact(8))[0]
        payload = self._read_exact(length) if length else b""
        if opcode == 0x8:
            raise RuntimeError("server closed websocket")
        if opcode == 0x1:
            return payload.decode(errors="replace")
        if opcode == 0x9:  # ping -> pong
            self.sock.sendall(b"\x8a\x00")
        return None

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def find_ws_url(port, tries=40):
    for _ in range(tries):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2) as r:
                tabs = json.load(r)
            for t in tabs:
                if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                    return t["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(0.5)
    return None


