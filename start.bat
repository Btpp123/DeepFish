@echo off
chcp 65001 >nul
title DeepFish
cd /d "%~dp0"

rem ============================================================
rem  DeepFish launcher.
rem  IMPORTANT: this file must stay 100%% ASCII + CRLF line endings.
rem  Reason (verified experimentally on this machine): cmd.exe's
rem  batch parser desyncs on lines containing non-ASCII bytes.
rem  It then tries to execute fragments of comments/echo lines as
rem  commands ("... is not recognized as an internal or external
rem  command") and never reaches the line that starts the server.
rem  This is NOT about the console code page -- UTF-8 (with or
rem  without BOM) and GBK both fail. Keep it ASCII.
rem  The server itself prints its banner in Chinese via Node,
rem  which is fine: that is output, not batch-source parsing.
rem ============================================================

echo.
echo   ============================================
echo     DeepFish  -  Stockfish  +  DeepSeek
echo   ============================================
echo.
echo   Starting the server...
echo   A browser tab will open once it is ready.
echo   THIS BLACK WINDOW IS THE SERVER -- closing it stops the server.
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "node_modules" goto nomod

rem ---------- open the browser only after the server answers ----------
rem  Poll /api/health from a background helper; open the page on the
rem  first 200. Give up after ~30s (usually means the port is busy,
rem  and the error below will say so).
start "" /b powershell -NoProfile -Command "$ok=$false;for($i=0;$i -lt 60;$i++){try{if((Invoke-WebRequest http://127.0.0.1:3000/api/health -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200){$ok=$true;break}}catch{};Start-Sleep -Milliseconds 500};if($ok){Start-Process 'http://127.0.0.1:3000'}else{Write-Host '  (auto-open skipped: server did not answer in time - open http://localhost:3000 yourself)'}"

node src/server.js

echo.
echo   Server stopped. Press any key to close this window.
pause >nul
exit /b 0

:nonode
echo   [X] Node.js not found on PATH.
echo       Install it from https://nodejs.org/ then run start.bat again.
echo.
pause
exit /b 1

:nomod
echo   [X] Dependencies are not installed yet.
echo       Open a terminal in this folder and run:  npm install
echo.
pause
exit /b 1
