@echo off
REM Flightdeck server manager (Windows)
REM Usage: bin\server.cmd [start|stop|restart|status|logs|help]
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
for %%i in ("%SCRIPT_DIR%..") do set "ROOT=%%~fi"
cd /d "%ROOT%"

REM Log lives in the project root so the path never contains spaces (*.log is gitignored).
set "LOG=%ROOT%\flightdeck.log"

set "PORT="
for /f "delims=" %%p in ('node -p "require('./flightdeck.config.json').port" 2^>nul') do set "PORT=%%p"
if not defined PORT set "PORT=4400"
REM `node -p` prints "undefined" and exits 0 when the config exists but names no `port`, so
REM a defined PORT is not necessarily a number. Anything non-numeric means use the default —
REM otherwise netstat below looks for a port called "undefined" and never finds the server.
echo !PORT!|findstr /r /c:"^[0-9][0-9]*$" >nul || set "PORT=4400"
set "URL=http://localhost:%PORT%"

set "CMD=%~1"
if "%CMD%"=="" set "CMD=restart"

if /i "%CMD%"=="start"   goto :start
if /i "%CMD%"=="stop"    goto :stop
if /i "%CMD%"=="restart" goto :restart
if /i "%CMD%"=="status"  goto :status
if /i "%CMD%"=="logs"    goto :logs
goto :help

REM ------------------------------------------------------------------ helpers

:findpid
REM Sets PID to the process listening on %PORT% (empty if none).
set "PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr /c:"LISTENING"') do set "PID=%%p"
exit /b 0

:checkup
REM Sets CODE to the HTTP status of the dashboard root.
set "CODE="
for /f "delims=" %%c in ('curl -s -o NUL -w "%%{http_code}" "%URL%/" 2^>nul') do set "CODE=%%c"
exit /b 0

REM ----------------------------------------------------------------- commands

:start
call :checkup
if "!CODE!"=="200" (
  echo Already running at %URL% - opening dashboard.
  start "" "%URL%"
  goto :eof
)

if not exist "%ROOT%\node_modules" (
  echo node_modules missing - running npm install...
  call npm install
)

echo Starting Flightdeck on port %PORT%...
REM Separate minimized window so the server outlives this cmd prompt.
start "Flightdeck" /min /d "%ROOT%" cmd /c "npm run start > flightdeck.log 2>&1"

for /l %%i in (1,1,30) do (
  call :checkup
  if "!CODE!"=="200" (
    echo   [ok] running at %URL%
    echo   opening dashboard...
    start "" "%URL%"
    echo   logs: %LOG%
    echo   NOTE: if you already had a dashboard tab open, hard-refresh it ^(Ctrl+F5^).
    goto :eof
  )
  timeout /t 1 /nobreak >nul
)

echo   [fail] server did not come up within 30s. Last lines of the log:
echo ---
if exist "%LOG%" (
  powershell -NoProfile -Command "Get-Content -Tail 30 -LiteralPath '%LOG%'"
) else (
  echo (no log at %LOG%^)
)
exit /b 1

:stop
echo Stopping Flightdeck...
call :findpid
if not defined PID (
  echo   ^(nothing running on port %PORT%^)
  goto :eof
)
echo   stopping PID !PID! ^(and children^)...
REM Windows has no SIGINT for console apps, so this is a tree kill: agent child
REM processes are terminated rather than shut down gracefully.
taskkill /pid !PID! /t >nul 2>&1
for /l %%i in (1,1,5) do (
  call :findpid
  if not defined PID (
    echo   [ok] stopped
    goto :eof
  )
  timeout /t 1 /nobreak >nul
)
echo   ! still alive - force killing
call :findpid
if defined PID taskkill /pid !PID! /t /f >nul 2>&1
timeout /t 1 /nobreak >nul
call :findpid
if defined PID (
  echo   [fail] could not free port %PORT%
  exit /b 1
)
echo   [ok] stopped ^(forced^)
goto :eof

:restart
echo Restarting Flightdeck...
call :stop
goto :start

:status
call :checkup
if "!CODE!"=="200" (
  call :findpid
  echo   [ok] running at %URL% ^(PID !PID!^)
  goto :eof
)
echo   [x] not running on port %PORT%
exit /b 1

:logs
if not exist "%LOG%" (
  echo No log at %LOG%
  exit /b 1
)
powershell -NoProfile -Command "Get-Content -Wait -Tail 50 -LiteralPath '%LOG%'"
goto :eof

:help
echo Flightdeck server manager
echo.
echo Usage: bin\server.cmd [command]
echo.
echo Commands:
echo   start      Start it ^(no-op + opens browser if already up^)
echo   stop       Stop it and its agent children
echo   restart    Stop then start - the default if you pass no command
echo   status     Is it running?
echo   logs       Tail the log
echo   help       This message
goto :eof
