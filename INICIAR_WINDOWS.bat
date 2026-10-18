@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Primero instala Node.js LTS desde https://nodejs.org/
  echo Cierra esta ventana y abre INICIAR_WINDOWS.bat otra vez al terminar.
  pause
  exit /b 1
)
echo PERU ARENA - PRUEBA EN TU PC
echo No cierres esta ventana mientras juegas.
echo Si el navegador muestra un error al principio, recarga la pagina.
echo Para amigos de otras casas, usa el enlace de Render.
start "" "http://localhost:3000"
node server.js
pause
