@echo off
cd /d "%~dp0"
echo Controllo aggiornamenti di FormaOps...
git pull
echo Installo o aggiorno i componenti...
call npm install --no-fund --no-audit
start "" http://localhost:3210
echo.
echo FormaOps e' acceso. NON chiudere questa finestra finche' lo usi.
echo.
npm start
pause
