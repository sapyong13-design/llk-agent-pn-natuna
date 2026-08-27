@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 atau lebih baru belum terpasang.
  echo Instal Node.js LTS dari https://nodejs.org/ lalu buka ulang file ini.
  pause
  exit /b 1
)
call npm.cmd start
if errorlevel 1 pause
