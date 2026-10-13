@echo off
set "BWS_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if not exist "%BWS_PYTHON%" (
  echo The bundled Python runtime could not be found. Open Codex and try again.
  pause
  exit /b 1
)
"%BWS_PYTHON%" "%~dp0launch.py" --app
if errorlevel 1 pause
