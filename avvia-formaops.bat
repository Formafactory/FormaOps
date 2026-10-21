@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Prima installazione delle dipendenze...
  call npm install
)
start "" http://localhost:3210
npm start
pause
