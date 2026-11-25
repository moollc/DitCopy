@echo off
rem Windows: double click, or run in a terminal. The launcher is ditcopy.js, shared with macOS and Linux.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
node ditcopy.js start %*
if errorlevel 1 pause
