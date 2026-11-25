@echo off
rem Windows: double click, or run in a terminal. The launcher is ditcopy.js, shared with macOS and Linux.
cd /d "%~dp0"
rem A downloaded copy carries its own Node in runtime. A source checkout uses the Node you installed.
set "NODE=node"
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
if "%NODE%"=="node" where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
"%NODE%" ditcopy.js start %*
if errorlevel 1 pause
