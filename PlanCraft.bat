@echo off
setlocal
title PlanCraft - keep this window open
cd /d "%~dp0"

rem Use a Python that already has the plan libraries (PyMuPDF, Pillow, openpyxl, OpenCV).
python -c "import pymupdf, PIL, openpyxl, cv2, numpy" >nul 2>nul && (set "PY=python" & goto run)
py -3 -c "import pymupdf, PIL, openpyxl, cv2, numpy" >nul 2>nul && (set "PY=py -3" & goto run)

rem None has them yet: install once.
set "PY=python"
where python >nul 2>nul || set "PY=py -3"
echo Setting up PlanCraft - one time only, needs internet...
%PY% -m pip install --user --quiet -r requirements.txt
%PY% -c "import pymupdf, PIL, openpyxl, cv2, numpy" >nul 2>nul || goto setupfailed

:run
%PY% server.py --open
if errorlevel 1 (
    echo.
    echo PlanCraft stopped with an error. See the messages above.
    pause
)
goto :eof

:setupfailed
echo.
echo Could not install the libraries PlanCraft needs: PyMuPDF, Pillow, openpyxl and OpenCV.
echo Check the internet connection, or run this in a terminal:
echo     %PY% -m pip install -r requirements.txt
pause
