@echo off
setlocal
rem ---------------------------------------------------------------------------
rem build.bat -- compile src/watchdog/watchdog.cpp -> watchdog.exe
rem Toolchain: MSVC 14.29 (VS2019 Build Tools), Windows SDK 10.0.19041.0
rem Uses plain cl.exe only (no CMake/MSBuild/MinGW).
rem ---------------------------------------------------------------------------

set "ROOT=%~dp0"
set "VCVARS=F:\tools\VS2019_BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if not exist "%VCVARS%" (
    echo ERROR: vcvars64.bat not found at "%VCVARS%" 1>&2
    exit /b 1
)

rem Set up the MSVC x64 environment (INCLUDE/LIB/PATH).
call "%VCVARS%" >nul
if errorlevel 1 (
    echo ERROR: vcvars64.bat failed with exit code %errorlevel% 1>&2
    exit /b 1
)

pushd "%ROOT%"
cl.exe /nologo /W4 /EHsc /O2 /MT /utf-8 watchdog.cpp /Fe:watchdog.exe /link user32.lib kernel32.lib advapi32.lib
set "RC=%errorlevel%"
popd

if not "%RC%"=="0" (
    echo ERROR: cl.exe failed with exit code %RC% 1>&2
    exit /b %RC%
)

echo Build OK: "%ROOT%watchdog.exe"
exit /b 0
