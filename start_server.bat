@echo off
title China Tourism Map - Server Launcher
color 0b
cls

echo =====================================================================
echo    CHINA TOURISM MAP - COMMERCIAL SERVER LAUNCHER
echo =====================================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0c
    echo [ERROR] Node.js was not found on your system!
    echo Please install Node.js from https://nodejs.org/ first.
    echo.
    pause
    exit /b
)

set LOCAL_IP=127.0.0.1
for /f "delims=" %%i in ('node -e "let ip='127.0.0.1';const ifs=require('os').networkInterfaces();for(const n in ifs)for(const net of ifs[n])if(net.family==='IPv4'&&!net.internal)if(net.address.indexOf('192.')===0)ip=net.address;console.log(ip);"') do set LOCAL_IP=%%i

echo [STATUS] Checking environment... OK
echo [STATUS] Current Working Directory: %~dp0
echo.
echo ---------------------------------------------------------------------
echo SERVER ACCESS DETAILS:
echo.
echo    Local PC Access:    http://localhost:3000
echo    Android/LAN Access: http://%LOCAL_IP%:3000
echo.
echo    (Make sure both your PC and your tablet are connected
echo    to the same Wi-Fi / Local Area Network)
echo ---------------------------------------------------------------------
echo.
echo Starting the server... Please keep this window open!
echo ---------------------------------------------------------------------
echo.

cd /d "%~dp0"

set PORT_PID=
for /f "delims=" %%p in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1"') do set PORT_PID=%%p

if not "%PORT_PID%"=="" (
    color 0e
    echo [INFO] Port 3000 is already in use by process %PORT_PID%.
    echo [INFO] If this is the tourism map server, it is already running.
    echo.
    echo    Local PC Access:    http://localhost:3000
    echo    Android/LAN Access: http://%LOCAL_IP%:3000
    echo.
    echo To restart it, close the old server window or stop process %PORT_PID% first.
    echo.
    pause
    exit /b 0
)

if not exist "backend\node_modules" (
    echo [INFO] First-time run: Installing required backend dependencies...
    cd backend
    call npm install --no-audit --no-fund
    cd ..
)

node backend/server.js

if %errorlevel% neq 0 (
    color 0c
    echo.
    echo [ERROR] The server crashed or port 3000 is already in use.
    echo.
    pause
)
