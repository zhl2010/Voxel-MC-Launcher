@echo off
chcp 65001 >nul
setlocal
title Voxel Launcher
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Check Node.js and your network connection.
    set "EXIT_CODE=1"
    goto :hold
  )
)

call npm start
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo Launcher closed.
) else (
  echo [ERROR] Launcher exited with code %EXIT_CODE%.
  echo Check the messages above, or run "npm run devtools" for more diagnostics.
)

:hold
echo.
echo Press any key to close this window...
pause >nul
endlocal & exit /b %EXIT_CODE%
