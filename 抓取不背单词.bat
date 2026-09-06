@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   不背单词生词本抓取工具
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)
node grab-bubei.js
echo.
pause
