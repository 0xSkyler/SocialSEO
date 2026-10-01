@echo off
setlocal
set NODE_OPTIONS=--max-old-space-size=8192
set PLAYWRIGHT_BROWSERS_PATH=0
cd /d "%~dp0"

echo ==============================================
echo Social SEO 4.3.9 - Concurrent Chromium Windows Build
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
  echo Dependencies are missing. Installing dependencies and Playwright browsers...
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 pause & exit /b 1
)

echo.
echo Running typecheck, lint, tests, production build and NSIS packaging...
call npm.cmd run package:win
if errorlevel 1 (
  echo.
  echo VALIDATION OR PACKAGING FAILED. No final installer should be shipped from this run.
  pause
  exit /b 1
)

echo.
echo VERIFIED BUILD COMPLETE.
echo Installer: release\Social-SEO-Setup-4.3.9.exe
for %%F in ("release\Social-SEO-Setup-4.3.9.exe") do echo Size: %%~zF bytes
pause
