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

node ops.mjs preflight >nul 2>&1
if errorlevel 1 (
  echo Menjalankan pemeriksaan sistem...
  node ops.mjs preflight
  echo.
  pause
  exit /b 1
)

if "%PORT%"=="" set "PORT=4545"
set "URL=http://127.0.0.1:%PORT%"

echo ========================================================
echo   LLK Agent - Pengadilan Negeri Natuna
echo   Alamat: %URL%
echo Membuka browser otomatis...
start "" /min powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 1200; Start-Process '%URL%'"

echo Aplikasi aktif. Tekan Ctrl+C untuk menutup.
echo.
node server.js
