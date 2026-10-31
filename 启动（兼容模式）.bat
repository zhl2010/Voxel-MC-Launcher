@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
"Voxel Launcher.exe" --no-sandbox --disable-gpu
if errorlevel 1 pause
