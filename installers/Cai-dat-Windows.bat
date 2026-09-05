@echo off
title Cai dat Shared Files
setlocal enabledelayedexpansion
set "SRC=%~dp0app"
set "DEST=%LOCALAPPDATA%\SharedFiles"
set "DESKTOP=%USERPROFILE%\Desktop\Shared Files.lnk"
set "STARTMENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Shared Files.lnk"

echo.
echo   ==========================================
echo    Cai dat Shared Files
echo   ==========================================
echo.

if not exist "%SRC%\server.js" (
  echo   [!] Khong thay thu muc "app" ben canh file nay.
  echo       Hay giai nen ca goi ra roi chay lai file nay.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] May chua cai Node.js - ung dung can no de chay.
  echo.
  choice /c YN /n /m "   Mo trang tai Node.js bay gio? [Y/N] "
  if !errorlevel! equ 1 start "" https://nodejs.org/vi/download
  echo.
  echo   Cai Node.js xong thi chay lai file nay.
  pause
  exit /b 1
)

echo   Dang chep vao: %DEST%
if exist "%DEST%" rmdir /s /q "%DEST%"
robocopy "%SRC%" "%DEST%" /e /nfl /ndl /njh /njs /nc /ns >nul
if errorlevel 8 (
  echo   [!] Chep file that bai.
  pause
  exit /b 1
)

echo   Dang tao loi tat...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w = New-Object -ComObject WScript.Shell;" ^
  "foreach ($p in @('%DESKTOP%','%STARTMENU%')) {" ^
  "  $s = $w.CreateShortcut($p);" ^
  "  $s.TargetPath = '%DEST%\start.bat';" ^
  "  $s.WorkingDirectory = '%DEST%';" ^
  "  $s.IconLocation = '%DEST%\public\icons\app.ico';" ^
  "  $s.Description = 'Chia se file toc do cao giua cac may';" ^
  "  $s.Save() }" >nul

> "%DEST%\Go-cai-dat.bat" (
  echo @echo off
  echo rem Xoa ung dung khoi may. Tu copy ra TEMP roi chay, vi khong the tu xoa
  echo rem thu muc dang chua chinh minh.
  echo if /i not "%%~dp0"=="%%TEMP%%\" ^(
  echo   copy /y "%%~f0" "%%TEMP%%\SF-gocaidat.bat" ^>nul
  echo   start "" "%%TEMP%%\SF-gocaidat.bat"
  echo   exit /b
  echo ^)
  echo del "%DESKTOP%" 2^>nul
  echo del "%STARTMENU%" 2^>nul
  echo rmdir /s /q "%DEST%"
  echo echo Da go Shared Files khoi may.
  echo pause
)

echo.
echo   Xong. Da tao loi tat "Shared Files" ngoai Desktop va trong Start Menu.
echo   Go cai dat: chay %DEST%\Go-cai-dat.bat
echo.
choice /c YN /n /m "   Chay thu ngay bay gio? [Y/N] "
if !errorlevel! equ 1 start "" "%DEST%\start.bat"
exit /b 0
