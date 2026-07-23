@echo off
setlocal
title Lvyoumap EdgeOne Dist Packager
cd /d "%~dp0"

set "OUTPUT_ZIP=lvyoumap-edgeone-dist.zip"

echo ============================================================
echo  Lvyoumap EdgeOne - Build and Package
echo ============================================================
echo.

if not exist "package.json" (
  echo [ERROR] package.json was not found in: %CD%
  goto :fail
)

if not exist "scripts\build_edgeone.js" (
  echo [ERROR] scripts\build_edgeone.js was not found.
  goto :fail
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required.
  echo Install it from https://nodejs.org/
  goto :fail
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js 20 or newer.
  goto :fail
)

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Windows PowerShell was not found.
  goto :fail
)

set "NODE_MAJOR="
for /f %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
  echo [ERROR] Unable to read the Node.js version.
  goto :fail
)

if %NODE_MAJOR% LSS 20 (
  echo [ERROR] Node.js 20 or newer is required. Current major: %NODE_MAJOR%
  goto :fail
)

echo [1/3] Building the latest dist folder...
call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed. Review the message above.
  goto :fail
)

echo.
echo [2/3] Validating the deployment output...
if not exist "dist\index.html" (
  echo [ERROR] dist\index.html was not generated.
  goto :fail
)
if not exist "dist\app.js" (
  echo [ERROR] dist\app.js was not generated.
  goto :fail
)
if not exist "dist\assets" (
  echo [ERROR] dist\assets was not generated.
  goto :fail
)
if not exist "dist\data" (
  echo [ERROR] dist\data was not generated.
  goto :fail
)
if not exist "dist\data\provinces\beijing.json" (
  echo [ERROR] ASCII province data files were not generated.
  goto :fail
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=(Resolve-Path 'dist').Path; $bad=Get-ChildItem -LiteralPath $root -Recurse -Force | Where-Object { $_.FullName.Substring($root.Length) -match '[^\x00-\x7F]' }; if ($bad) { $bad.FullName | ForEach-Object { Write-Host ('[ERROR] Non-ASCII deployment path: ' + $_) }; exit 1 }"
if errorlevel 1 (
  echo [ERROR] Deployment paths must use ASCII names for Linux compatibility.
  goto :fail
)

echo [3/3] Creating %OUTPUT_ZIP%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $root=(Get-Location).Path; $temp=Join-Path $root 'lvyoumap-edgeone-dist.tmp.zip'; $final=Join-Path $root 'lvyoumap-edgeone-dist.zip'; Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue; Compress-Archive -Path (Join-Path $root 'dist\*') -DestinationPath $temp -CompressionLevel Optimal; Move-Item -LiteralPath $temp -Destination $final -Force"
if errorlevel 1 (
  echo [ERROR] ZIP packaging failed. The previous ZIP was kept if it existed.
  goto :fail
)

if not exist "%OUTPUT_ZIP%" (
  echo [ERROR] %OUTPUT_ZIP% was not created.
  goto :fail
)

echo.
echo [SUCCESS] Deployment package is ready:
echo %CD%\%OUTPUT_ZIP%
echo.
echo Upload this ZIP to the Baota website root and extract it there.
echo index.html is already stored at the ZIP root.
echo.
pause
exit /b 0

:fail
echo.
echo Packaging stopped. No deployment was performed.
echo.
pause
exit /b 1
