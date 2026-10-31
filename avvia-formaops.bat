@echo off
cd /d "%~dp0"
echo Controllo aggiornamenti di FormaOps...
git pull
echo Installo o aggiorno i componenti...
call npm install --no-fund --no-audit
if /I not "%1"=="silenzioso" start "" http://localhost:3210
echo.
echo FormaOps e' acceso. NON chiudere questa finestra finche' lo usi.
echo Si aggiorna da solo: puoi ridurla a icona.
echo.
npm start
pause
