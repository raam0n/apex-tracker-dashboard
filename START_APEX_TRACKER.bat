@echo off
echo Starting Apex Legends Pro Tracker...

:: Start the Companion Server in a new window
start "Apex Companion (Brain)" cmd /k "cd companion && npm start"

:: Start the Dashboard in a new window
start "Apex Dashboard (UI)" cmd /k "npm run dev"

echo.
echo Both components are starting! 
echo 1. Keep the "Apex Companion" window open while you play.
echo 2. Open the URL shown in the "Apex Dashboard" window (usually http://localhost:5173).
echo.
pause
