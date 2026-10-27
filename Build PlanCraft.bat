@echo off
setlocal
title Build PlanCraft
cd /d "%~dp0"

rem Prefer the project virtual environment, then a Python on PATH.
set "PY=python"
if exist "%~dp0.venv\Scripts\python.exe" set "PY=%~dp0.venv\Scripts\python.exe"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build.ps1" -Python "%PY%" %*
echo.
pause
