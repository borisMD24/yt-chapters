@echo off
rem Demarrage en un clic de yt-chapters.
rem
rem Double-cliquez sur ce fichier depuis l'Explorateur Windows : il lance
rem scripts\launch.ps1, qui installe ce qui manque, demarre le serveur et
rem ouvre le navigateur. La fenetre reste ouverte a la fin (pause), pour que
rem tout message d'erreur reste lisible.
rem
rem Options possibles (en ligne de commande) :
rem   Demarrer.cmd -Check        verifie l'environnement sans rien installer
rem   Demarrer.cmd -NoBrowser    demarre sans ouvrir le navigateur
rem   Demarrer.cmd -Port 3001    force le port

rem Toutes les commandes suivantes partent du dossier de ce fichier, meme si
rem le script est lance depuis un autre dossier.
cd /d "%~dp0"

rem Sortie UTF-8 : les accents francais restent lisibles.
chcp 65001 >nul

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\launch.ps1" %*

set EXITCODE=%ERRORLEVEL%
echo.
echo (Fin du demarrage, code %EXITCODE%.)
pause
exit /b %EXITCODE%
