@echo off
rem Build the TrendScope desktop shell (Tauri 2).
rem
rem Why this is a .bat and not just "npm run desktop:build":
rem rustc looks for "link.exe" on PATH. On a machine with Git for Windows installed,
rem PATH also contains Git's Unix "link" utility, and rustc can pick THAT up -
rem the build then dies with "link: extra operand ..." instead of linking.
rem Loading the Visual Studio developer environment first puts the real MSVC
rem linker ahead of it, which is what vcvars64.bat below does.
rem
rem Network note: crates.io is slow from this machine without a proxy, so the
rem proxy variables are set for this command only (nothing is written to config).
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

if defined HTTPS_PROXY goto proxy_ok
set HTTPS_PROXY=http://127.0.0.1:7897
set HTTP_PROXY=http://127.0.0.1:7897
:proxy_ok

set VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat
if not exist "%VCVARS%" (
  echo [ERROR] vcvars64.bat not found at "%VCVARS%"
  echo         Install Visual Studio 2022 Build Tools with the C++ workload, then try again.
  pause
  exit /b 1
)

echo [1/3] Loading the Visual Studio C++ environment...
call "%VCVARS%" >nul
if errorlevel 1 goto failed

echo [2/3] Building front-end and server...
call npm run build
if errorlevel 1 goto failed

echo [3/3] Building the desktop shell...
call npx tauri build --no-bundle
if errorlevel 1 goto failed

echo.
echo Done. The executable is under src-tauri\target\release\.
pause
exit /b 0

:failed
echo [ERROR] Desktop build failed - see the output above.
pause
exit /b 1
