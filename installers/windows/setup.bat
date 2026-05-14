@echo off
setlocal
title DotAIOS Setup

echo ============================================
echo  DotAIOS Setup
echo ============================================
echo.
echo This will create a local memory folder (~\aios)
echo and connect it to your AI tools (Claude Code,
echo Cursor, Codex, Gemini).
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but is not installed.
  echo.
  echo Opening the Node.js download page in your browser.
  echo Download the LTS version, install it, then run
  echo "Set up DotAIOS" from your Start Menu again.
  echo.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)

echo Found Node.js. Starting DotAIOS setup.
echo.
call npx -y dotaios@latest setup
if errorlevel 1 (
  echo.
  echo Setup did not finish cleanly. Read the messages above.
  echo You can rerun this any time from the Start Menu.
  pause
  exit /b 1
)

echo.
echo Setup complete. You can close this window.
pause
endlocal
