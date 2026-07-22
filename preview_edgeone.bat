@echo off
setlocal
title Lvyoumap EdgeOne Preview
cd /d "%~dp0"

if not exist "package.json" (
  echo [ERROR] package.json was not found in: %CD%
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required.
  echo Install it from https://nodejs.org/
  pause
  exit /b 1
)

for /f %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo [ERROR] Node.js 20 or newer is required. Current major: %NODE_MAJOR%
  pause
  exit /b 1
)

echo [1/2] Building the EdgeOne output...
call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed. Review the message above.
  pause
  exit /b 1
)

echo [2/2] Starting preview server...
echo Local URL: http://localhost:8080
echo LAN URLs will be printed after the server starts.
echo Press Ctrl+C to stop.
node scripts\serve_static.js

if errorlevel 1 (
  echo [ERROR] Preview server stopped unexpectedly.
  pause
  exit /b 1
)

endlocal
