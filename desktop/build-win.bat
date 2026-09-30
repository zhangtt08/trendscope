@echo off
rem Build TrendScope.exe - a native Windows desktop shell (WinForms + WebView2).
rem
rem Why not Tauri/Electron here: this machine has the MSVC toolset but NOT the
rem Windows SDK, so every Rust link step fails with LNK1181, and no .NET SDK is
rem installed either. Windows already ships the C# compiler (csc) and the
rem WebView2 Runtime is present, so this produces a real .exe with no new
rem toolchain and no admin rights.
rem
rem The WebView2 assemblies come from the Microsoft.Web.WebView2 NuGet package
rem (a plain zip) - see desktop\vendor. Nothing is downloaded at runtime.
setlocal
cd /d "%~dp0.."

set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set OUT=%CD%\desktop\bin
set VENDOR=%CD%\desktop\vendor\pkg

if not exist "%CSC%" (
  echo [ERROR] csc.exe not found at "%CSC%"
  exit /b 1
)
if not exist "%VENDOR%\lib\net462\Microsoft.Web.WebView2.Core.dll" (
  echo [ERROR] WebView2 assemblies missing. Unpack the Microsoft.Web.WebView2 nupkg into desktop\vendor\pkg first.
  exit /b 1
)
if not exist "%OUT%" mkdir "%OUT%"

copy /y "%VENDOR%\lib\net462\Microsoft.Web.WebView2.Core.dll" "%OUT%\" >nul
copy /y "%VENDOR%\lib\net462\Microsoft.Web.WebView2.WinForms.dll" "%OUT%\" >nul
copy /y "%VENDOR%\runtimes\win-x64\native\WebView2Loader.dll" "%OUT%\" >nul
if not exist "%~dp0icon.ico" if exist "src-tauri\icons\icon.ico" copy /y "src-tauri\icons\icon.ico" "%~dp0icon.ico" >nul
if exist "%~dp0icon.ico" (
  copy /y "%~dp0icon.ico" "%OUT%\TrendScope.ico" >nul
  set ICONFLAG=-win32icon:"%OUT%\TrendScope.ico"
) else (
  set ICONFLAG=
)

"%CSC%" -nologo -target:winexe -out:"%OUT%\TrendScope.exe" %ICONFLAG% -codepage:65001 ^
  -r:"%OUT%\Microsoft.Web.WebView2.Core.dll" ^
  -r:"%OUT%\Microsoft.Web.WebView2.WinForms.dll" ^
  -r:System.Windows.Forms.dll -r:System.Drawing.dll ^
  "desktop\TrendScope.cs"
if errorlevel 1 (
  echo [ERROR] compile failed
  exit /b 1
)

echo Built: %OUT%\TrendScope.exe
exit /b 0
