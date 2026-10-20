@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "D=%%i"
set "OUT=backup-%D%.json"

echo ============================================================
echo   memo 备份
echo   导出全部条目到 %OUT%
echo ============================================================
echo.

call npx wrangler d1 execute memo --remote --command "SELECT id, content, created_at, updated_at, pinned FROM notes ORDER BY id" --json > "%OUT%"
if errorlevel 1 (
  echo [失败] 导出没成功。
  pause
  exit /b 1
)

for %%A in ("%OUT%") do echo   已写入 %%~fA  ^(%%~zA 字节^)
echo.
echo   恢复办法见 GUIDE.md 第 12 节「备份与恢复」。
echo.
pause
