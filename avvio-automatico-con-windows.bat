@echo off
rem Crea un collegamento nella cartella Esecuzione automatica di Windows:
rem FormaOps parte da solo, ridotto a icona, quando accendi il PC.
cd /d "%~dp0"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\FormaOps.lnk'); $s.TargetPath='%~dp0avvia-formaops.bat'; $s.Arguments='silenzioso'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
echo.
echo Fatto: FormaOps partira' da solo all'accensione del PC.
echo Per toglierlo: Win+R, scrivi shell:startup e cancella "FormaOps".
pause
