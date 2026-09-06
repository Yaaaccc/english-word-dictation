@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=C:\Users\14821\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
if not exist "%NODE%" (where node >nul 2>nul && set "NODE=node")

set GRAB_HEADLESS=1
set SERVER_NO_OPEN=1

echo ============================================
echo   每日定时同步（%date% %time%）
echo ============================================

echo.
echo [1/3] 抓取扇贝今日单词…
"%NODE%" grab-shanbay.js

echo.
echo [2/3] 抓取不背单词生词本…
if exist bubei-auth.json (
  "%NODE%" grab-bubei.js
) else (
  echo   [提示] 尚未登录不背单词，跳过；首次使用请先双击「抓取不背单词.bat」
)

echo.
echo [3/3] 同步到 GitHub（网站自动更新）…
"%NODE%" sync-github.js

echo.
echo ============================================
echo   同步流程结束（%date% %time%）
echo ============================================
