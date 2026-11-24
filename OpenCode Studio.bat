@echo off
setlocal EnableExtensions
title OpenCode Studio Launcher

set "PORT=17620"
set "URL=http://127.0.0.1:%PORT%"

REM Resolve project root (works both inside repo root and when copied to Desktop)
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"
if not exist "%DIR%\server\index.mjs" set "DIR=D:\gemini\opencode-studio"

if not exist "%DIR%\server\index.mjs" (
  echo [OpenCode Studio] Project directory not found: %DIR%
  pause
  exit /b 1
)

REM 1. Instant version read (<5ms, zero Node cold-boot overhead)
set "PKG_VER="
for /f "tokens=2 delims=:, " %%v in ('findstr /r /c:"\"version\"[ ]*:" "%DIR%\package.json"') do (
  if not defined PKG_VER set "PKG_VER=%%~v"
)

REM 2. Fast loopback health check (~25ms, strictly bypassing Clash / system HTTP proxy)
set "HFILE=%TEMP%\ocs_health_%PORT%.json"
curl.exe --noproxy "*" -sf --connect-timeout 1 --max-time 1 "%URL%/api/health" -o "%HFILE%" >nul 2>&1
if not errorlevel 1 (
  findstr /c:"\"version\":\"%PKG_VER%\"" "%HFILE%" >nul 2>&1
  if not errorlevel 1 (
    del /q "%HFILE%" >nul 2>&1
    goto :ready
  )
  del /q "%HFILE%" >nul 2>&1
  echo [OpenCode Studio] New version v%PKG_VER% detected! Restarting local server cleanly ...
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    taskkill /PID %%p /T /F >nul 2>&1
  )
)

REM 3. Cold-start server & poll every 60ms via direct loopback socket (zero 1s timeout lag!)
echo [OpenCode Studio] Starting local server (v%PKG_VER%) on %URL% ...
start "OpenCode Studio Server" /min cmd /c "cd /d ""%DIR%"" && set ""NO_PROXY=127.0.0.1,localhost,::1"" && node server\index.mjs"

node -e "const http=require('http'),t=Date.now();(function p(){const r=http.get('%URL%/api/health',s=>{s.resume();s.statusCode===200?process.exit(0):n()});r.on('error',n);function n(){Date.now()-t>15000?process.exit(1):setTimeout(p,60)}})()" >nul 2>&1
if errorlevel 1 (
  echo [OpenCode Studio] Server took too long to respond. Please check the server window.
  pause
  exit /b 1
)

:ready
start "" "%URL%"
exit /b 0
