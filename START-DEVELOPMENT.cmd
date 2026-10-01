@echo off
setlocal
cd /d "%~dp0"

echo ==============================================
echo Social SEO 4.3.9 - Concurrent Chromium Keep Alive
echo ==============================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found. Install Node.js 24 LTS first.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo First run: installing dependencies and Playwright browsers...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo npm install failed. Review the error above.
    pause
    exit /b 1
  )
)

echo.
echo Starting Social SEO...
call npm.cmd run dev

if errorlevel 1 (
  echo.
  echo Social SEO exited with an error. Review the output above.
  pause
)
