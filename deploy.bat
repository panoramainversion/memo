@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo   memo 一键发布
echo ============================================================
echo.
echo   提醒：如果你已经绑了自己的域名，请先确认 wrangler.toml 里的
echo         [[routes]] 段是取消注释状态，否则这次部署会把域名解绑。
echo.

echo [1/2] 检查 Cloudflare 登录状态...
call npx wrangler whoami >nul 2>&1
if errorlevel 1 (
  echo       未登录，正在打开浏览器授权，请点 Allow ...
  call npx wrangler login
)

echo.
echo [2/2] 开始部署...
echo.
call npx wrangler deploy
if errorlevel 1 (
  echo.
  echo [失败] 部署没成功，把上面的报错贴出来对照 GUIDE.md 第 11 节。
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   发布完成，访问地址见上面的输出。
echo ============================================================
pause
