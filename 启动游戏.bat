@echo off
chcp 65001 >nul
REM ═══════════════════════════════════════════════════════════════
REM  本地启动 MECHA // ROGUE
REM
REM  为什么不能直接双击 index.html：
REM  本项目使用 ES Module 与 WebAssembly，浏览器在 file:// 协议下会以
REM  CORS 为由拒绝加载模块（报错通常是 "Cross origin requests are only
REM  supported for protocol schemes: http..."）。必须通过 HTTP 提供。
REM
REM  端口自动选择，避免与其它本地项目撞车。
REM ═══════════════════════════════════════════════════════════════

setlocal
cd /d "%~dp0"

set PYEXE=

REM ── 依次尝试常见的 Python 位置 ──────────────────────────────
where python.exe >nul 2>nul && set PYEXE=python.exe
if not defined PYEXE where py.exe >nul 2>nul && set PYEXE=py.exe
if not defined PYEXE if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set PYEXE="%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PYEXE if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set PYEXE="%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PYEXE if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set PYEXE="%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not defined PYEXE if exist "C:\Python312\python.exe" set PYEXE="C:\Python312\python.exe"
if not defined PYEXE if exist "D:\anaconda\python.exe" set PYEXE="D:\anaconda\python.exe"

if not defined PYEXE (
  echo.
  echo   [x] 没找到 Python。
  echo.
  echo   本游戏需要一个静态 HTTP 服务器才能运行，任选一种方式：
  echo.
  echo     1. 安装 Python: https://www.python.org/downloads/
  echo        安装时请勾选 "Add python.exe to PATH"
  echo     2. 或用在线版本: https://hasai666.github.io/opus_red_alert/
  echo.
  pause
  exit /b 1
)

"%PYEXE%" "scripts\serve.py"

if errorlevel 1 (
  echo.
  echo   [x] 启动失败。请把上面的信息反馈给开发者。
  pause
)

endlocal
