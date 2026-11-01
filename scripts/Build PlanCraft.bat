@echo off
setlocal
title Build PlanCraft
rem this file is in scripts\: work from the checkout folder above it
cd /d "%~dp0.."

rem Prefer the project virtual environment, then a Python on PATH.
set "PY=python"
if exist "%CD%\.venv\Scripts\python.exe" set "PY=%CD%\.venv\Scripts\python.exe"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" -Python "%PY%" %*
echo.
pause
