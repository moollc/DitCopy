@echo off
rem Windows: double click, or run in a terminal. The launcher is ditcopy.js, shared with macOS and Linux.
cd /d "%~dp0"
rem A downloaded copy carries its own Node in runtime. A source checkout uses the Node you installed.
set "NODE=node"
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
if "%NODE%"=="node" where node >nul 2>nul || (echo This is the developer version, and it needs Node.js. To use DitCopy without installing anything, download the app: https://github.com/moollc/DitCopy/releases/latest & pause & exit /b 1)
"%NODE%" ditcopy.js stop %*
if errorlevel 1 pause
