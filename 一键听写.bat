@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)
echo 正在抓取扇贝今日单词…
node grab-shanbay.js
echo.
echo 正在抓取不背单词生词本…
if exist bubei-auth.json (
  node grab-bubei.js
) else (
  echo [提示] 尚未登录不背单词，跳过；首次使用请先双击「抓取不背单词.bat」
)
echo.
echo 正在生成每日英语小短文 PDF（保存到桌面\每日文章）…
set "PYCMD=C:\Users\14821\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if not exist "%PYCMD%" set "PYCMD="
if not defined PYCMD (where py >nul 2>nul && set "PYCMD=py -3")
if not defined PYCMD (where python >nul 2>nul && set "PYCMD=python")
if defined PYCMD (
  %PYCMD% daily_article.py
) else (
  echo [提示] 未找到 Python，跳过文章 PDF
)
echo.
echo 正在同步单词存档到 GitHub…
git rev-parse --is-inside-work-tree >nul 2>nul
if not errorlevel 1 (
  git add -A >nul 2>nul
  git commit -m "daily words sync" >nul 2>nul
  git push -q 2>nul
  if errorlevel 1 (
    echo [提示] 同步失败（可能未联网或未登录），不影响本次听写
  ) else (
    echo 已同步到 GitHub
  )
) else (
  echo [提示] 当前文件夹不是 git 仓库，跳过自动同步
)
echo.
echo 启动听写工具…
node server.js
pause
