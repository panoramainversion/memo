@echo off
chcp 65001 >nul
setlocal
set "U=%~1"

if "%U%"=="" (
  echo.
  set /p "U=请输入站点地址（例如 https://你的域名）: "
)
if "%U%"=="" (
  echo 没给地址，退出。
  pause
  exit /b 1
)

echo ============================================================
echo   memo 线上体检
echo   站点： %U%
echo ============================================================
echo.
echo   路径                          状态
echo   ----------------------------------------------
call :chk /                     首页
call :chk /api/site             站点信息
call :chk /api/notes            时间线接口
call :chk /api/me               登录状态接口
call :chk /feed.xml             RSS
call :chk /style.css            样式
call :chk /app.js               脚本
call :chk /manifest.webmanifest PWA 清单
call :chk /icon-192.png         图标
echo   ----------------------------------------------
echo.
echo   200 = 正常    000 = 连不上（网络或域名问题）
echo   500 = Worker 报错，用 npx wrangler tail 看日志
echo.
pause
exit /b

:chk
<nul set /p "=   %~2  ->  "
curl -s -o NUL -w "%%{http_code}\n" --max-time 15 "%U%%~1"
exit /b
