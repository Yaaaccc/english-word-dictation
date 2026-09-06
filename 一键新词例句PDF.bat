@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   每日新词 · 例句精读 PDF 生成器
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)
node "每日新词例句PDF.js" %*
echo.
echo 如需补历史某天的 PDF：node 每日新词例句PDF.js --date 2026-08-30
pause
