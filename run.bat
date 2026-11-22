@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE="
where node >nul 2>nul
if %errorlevel%==0 (
    set "NODE=node"
) else if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
) else (
    echo [!] Khong tim thay Node.js 22+. Hay cai Node.js roi thu lai.
    pause
    exit /b 1
)

if not exist "config.json" (
    if exist "config.example.json" copy /y "config.example.json" "config.json" >nul
)

echo ========================================
echo   BOT DONG HANH MINECRAFT - JAVA 1.21.1
echo ========================================
echo.
set "LAN_PORT="
set /p LAN_PORT="Nhap cong LAN Minecraft (bam Enter de dung cong trong config.json): "
echo.

if defined LAN_PORT (
    "%NODE%" src/index.js --port "%LAN_PORT%"
) else (
    "%NODE%" src/index.js --no-prompt
)

if errorlevel 1 (
    echo.
    echo [!] Bot dung voi loi. Xem log o tren hoac trong data\bot.log de chinh sua.
) else (
    echo.
    echo [!] Bot da dung.
)
pause
