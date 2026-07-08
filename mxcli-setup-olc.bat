@echo off
setlocal

rem ============================================================
rem  mxcli-setup-olc launcher
rem  Runs setup.js with Node.js - no npm/npx required.
rem  Usage: double-click, or run with an optional project path:
rem     mxcli-setup-olc.bat "C:\Users\Me\Mendix\MyProject"
rem ============================================================

where node >nul 2>nul
if errorlevel 1 (
    echo [mxcli-setup-olc] ERROR: Node.js was not found on this machine.
    echo Please install Node.js from https://nodejs.org/ and try again.
    echo.
    pause
    exit /b 1
)

node "%~dp0setup.js" %*
set EXITCODE=%ERRORLEVEL%

echo.
pause
exit /b %EXITCODE%
