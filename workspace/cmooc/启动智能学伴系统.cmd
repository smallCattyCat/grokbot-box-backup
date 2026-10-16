@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"
title cMOOC 智能学伴系统启动器

set "APP_URL=http://localhost:3000/"
set "HEALTH_URL=http://localhost:3000/api/operator/manifest"

echo.
echo ==========================================
echo   cMOOC 智能学伴研究运行系统
echo ==========================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo 未检测到 npm。请先安装 Node.js LTS，然后重新双击本启动器。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 首次启动：正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请查看上方信息。
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-RestMethod -Uri '%HEALTH_URL%' -TimeoutSec 2; if ($r.appId -eq 'cmooc-companion-system') { exit 0 } }; exit 1"
if "%ERRORLEVEL%"=="0" (
  echo 系统已经就绪，正在打开运行中心...
  start "" "%APP_URL%"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$server=Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($server) { exit 0 } else { exit 1 }"
if "%ERRORLEVEL%"=="0" (
  echo 端口 3000 已被其他程序占用。请关闭该程序后重试。
  pause
  exit /b 1
)

echo 正在检查数据库版本...
call npm run prisma:migrate
if errorlevel 1 (
  echo 数据库检查失败；原数据库不会被自动清空。请查看上方信息。
  pause
  exit /b 1
)

echo 正在启动本地服务...
start "cMOOC 智能学伴服务" /min cmd /k "npm run dev"

echo 正在等待系统就绪...
powershell -NoProfile -ExecutionPolicy Bypass -Command "for ($i=0; $i -lt 60; $i++) { try { $r=Invoke-RestMethod -Uri '%HEALTH_URL%' -TimeoutSec 2; if ($r.appId -eq 'cmooc-companion-system') { exit 0 } } catch {}; Start-Sleep -Seconds 1 }; exit 1"
if errorlevel 1 (
  echo 系统启动超时。请查看 cMOOC 智能学伴服务 窗口。
  pause
  exit /b 1
)

echo 系统已启动，正在打开运行中心...
start "" "%APP_URL%"
exit /b 0
