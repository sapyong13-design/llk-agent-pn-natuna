@echo off
setlocal
cd /d "%~dp0llk-agent"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js belum terpasang.
  echo Silakan unduh dan pasang Node.js versi 20+ dari https://nodejs.org/
  pause
  exit /b 1
)

node start.mjs
if errorlevel 1 (
  echo.
  echo Aplikasi gagal dijalankan. Periksa pesan ERROR di atas.
  pause
  exit /b 1
)
exit /b 0
