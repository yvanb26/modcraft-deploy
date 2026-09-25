@echo off
chcp 65001 >nul
setlocal
title ModCraft Deploy - Commandes de compilation

:menu
cls
echo ================================================
echo   ModCraft Deploy - Commandes de compilation
echo ================================================
echo.
echo   1. Compiler le Launcher (installeur .exe)
echo   2. Compiler l'Admin (installeur .exe)
echo   3. Lancer le Launcher en mode dev (sans compiler)
echo   4. Lancer l'Admin en mode dev (sans compiler)
echo   5. Lancer le serveur API en local (node src/index.js)
echo   6. Quitter
echo.
set /p choix="Votre choix (1-6) : "

if "%choix%"=="1" goto build_launcher
if "%choix%"=="2" goto build_admin
if "%choix%"=="3" goto dev_launcher
if "%choix%"=="4" goto dev_admin
if "%choix%"=="5" goto dev_api
if "%choix%"=="6" goto fin
goto menu

:build_launcher
echo.
echo Compilation du launcher (npm run dist)...
pushd "%~dp0launcher"
call npm run dist
popd
echo.
echo Terminé. Le résultat se trouve dans launcher\dist\
pause
goto menu

:build_admin
echo.
echo Compilation de l'admin (npm run dist)...
pushd "%~dp0admin"
call npm run dist
popd
echo.
echo Terminé. Le résultat se trouve dans admin\dist\
pause
goto menu

:dev_launcher
echo.
echo Lancement du launcher (npm start)...
pushd "%~dp0launcher"
call npm start
popd
pause
goto menu

:dev_admin
echo.
echo Lancement de l'admin (npm start)...
pushd "%~dp0admin"
call npm start
popd
pause
goto menu

:dev_api
echo.
echo Lancement de l'API (npm start)...
pushd "%~dp0api"
call npm start
popd
pause
goto menu

:fin
endlocal
exit /b 0