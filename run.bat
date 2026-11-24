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

echo ========================================================
echo   BOT DONG HANH MINECRAFT - AUTO LAN ^& AUTO VERSION
echo ========================================================
echo  - Tu dong do cong Open to LAN ^& nhan dien phien ban (1.8.8 - 1.21.x+)
echo  - Mo san Antigravity Desktop (bat Minecraft Bot Companion - Gemini 4 Hydrogen Low) de chat tu nhien nhu nguoi that
echo  - Co the go so cong LAN (vd: 59251) hoac domain e4mc (vd: xxx.e4mc.link) hoac lenh bot trong CMD bat ky luc nao
echo ========================================================
echo.

if "%~1"=="" (
    "%NODE%" src/index.js --auto-lan --no-prompt
) else (
    "%NODE%" src/index.js %*
)

if errorlevel 1 (
    echo.
    echo [!] Bot dung voi loi. Xem log o tren hoac trong data\bot.log de chinh sua.
) else (
    echo.
    echo [!] Bot da dung.
)
pause
