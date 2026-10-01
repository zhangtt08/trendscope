@echo off
rem TrendScope one-click start.
rem   deps (if missing) -> build if needed -> then launch the desktop program.
rem
rem The build step goes through scripts\build-if-needed.ps1, which compares the
rem newest build input against a build stamp and skips the rebuild when nothing
rem changed. That turns a ~13 s "npm run build" on every launch into ~0.3 s.
rem Force a rebuild by deleting dist\, or run this file with --force-build.
rem
rem Preferred path is desktop\bin\TrendScope.exe (a real native window, see desktop\TrendScope.cs).
rem If it has not been built yet, we fall back to an app-mode browser window against the
rem local server started in this console.
rem
rem Another port? Put the number in port.txt next to this file, or set PORT before double-clicking.
setlocal
cd /d "%~dp0"

if defined PORT goto port_ok
if exist port.txt set /p PORT=<port.txt
:port_ok
if not defined PORT set PORT=5184

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH.
  echo         Install Node 20.19+ / 22.x / 24.x, then double-click this file again.
  pause
  exit /b 1
)

if exist node_modules goto build
echo [1/3] First run: installing dependencies, this can take a few minutes...
call npm install
if errorlevel 1 goto failed
:build

echo [2/3] Checking whether the front-end and server need a rebuild...
set "PS=%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
if "%~1"=="--force-build" set "BUILD_ARGS=-Force"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-if-needed.ps1" %BUILD_ARGS%
if errorlevel 1 goto nostart

if not exist "desktop\bin\TrendScope.exe" goto fallback
echo [3/3] Launching TrendScope.exe (native window)...
start "" "desktop\bin\TrendScope.exe"
timeout /t 3 /nobreak >nul
exit /b 0

:fallback
rem No exe yet: use the installed browser in app mode as a standalone window.
set APP_EXE=
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set APP_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe
if not defined APP_EXE if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set APP_EXE=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
if not defined APP_EXE if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set APP_EXE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
if not defined APP_EXE if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set APP_EXE=C:\Program Files\Microsoft\Edge\Application\msedge.exe

echo [3/3] Starting. A TrendScope window opens by itself at http://localhost:%PORT%
echo       Keep this black window open - closing it stops the app.
echo       Tip: desktop\build-win.bat builds a real TrendScope.exe with its own icon.
if not defined APP_EXE goto plain_browser
start "" /min cmd /c "timeout /t 6 >nul & start "" ""%APP_EXE%"" --app=http://localhost:%PORT% --user-data-dir=""%LOCALAPPDATA%\TrendScope"" --window-size=1440,900"
goto serve

:plain_browser
start "" /min cmd /c "timeout /t 6 >nul & start http://localhost:%PORT%"

:serve
node dist-server\index.js
pause
exit /b 0

:nostart
echo [ERROR] Build failed, so nothing was started - otherwise you would see an outdated UI.
pause
exit /b 1

:failed
echo [ERROR] Dependency install failed. Please send the output above to me.
pause
exit /b 1
