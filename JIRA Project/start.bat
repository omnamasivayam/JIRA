@echo off
REM Double-click to start SprintPilot. Opens your browser automatically.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required: https://nodejs.org  ^(the "LTS" Windows installer, or the .zip if you can't install software^)
  pause
  exit /b 1
)
if not exist config.json (
  echo No config.json found - starting in DEMO mode with sample data.
  echo Copy config.example.json to config.json and fill it in to connect to Jira.
  start "" http://localhost:4300
  node server.js --demo
) else (
  if /i "%~1"=="demo" (
    start "" http://localhost:4300
    node server.js --demo
  ) else (
    start "" http://localhost:4300
    node server.js
  )
)
pause
