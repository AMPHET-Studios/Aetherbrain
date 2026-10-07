@echo off
rem Makes the standalone Windows program of the Unreal version of Aether Brain: AetherBrainViewer.exe.
rem
rem Double-click this file. It needs, on this computer:
rem   1. Unreal Engine 5.8 (Epic Games Launcher)
rem   2. Visual Studio 2022 with the "Game development with C++" workload
rem   3. AetherBrainViewer.uproject opened in the Unreal Editor once (the editor makes the glow materials and the map)
rem
rem The program lands in the Packaged\Windows folder next to this file. It takes 10 to 30 minutes the first time.
rem Not run by the repository's tests: it drives Unreal's own build tool, which is not available there.
setlocal EnableExtensions

set "HERE=%~dp0"
set "PROJECT=%HERE%AetherBrainViewer\AetherBrainViewer.uproject"
set "OUT=%HERE%Packaged"

rem 1. Where is Unreal Engine 5.8? (Set UE_ROOT first if it is somewhere else.)
if not defined UE_ROOT set "UE_ROOT=C:\Program Files\Epic Games\UE_5.8"
if not exist "%UE_ROOT%\Engine\Build\BatchFiles\RunUAT.bat" goto :noengine

rem 2. Has the editor made the materials and the map yet?
if not exist "%HERE%AetherBrainViewer\Content\AetherBrain\Maps\Brain.umap" goto :openeditor
if not exist "%HERE%AetherBrainViewer\Content\AetherBrain\M_AetherNode.uasset" goto :openeditor

rem 3. Build, cook and package.
echo.
echo Packaging the Unreal version of Aether Brain. Please wait, and leave this window open.
echo.
call "%UE_ROOT%\Engine\Build\BatchFiles\RunUAT.bat" BuildCookRun -project="%PROJECT%" -noP4 -platform=Win64 -clientconfig=Development -build -cook -allmaps -stage -pak -archive -archivedirectory="%OUT%" -utf8output
if errorlevel 1 goto :failed

if not exist "%OUT%\Windows\AetherBrainViewer.exe" goto :failed
echo.
echo Done. Your program is here:
echo   %OUT%\Windows\AetherBrainViewer.exe
echo.
echo To use it: open Aether Brain, press the a key, switch the Unreal companion link on, then start AetherBrainViewer.exe.
echo.
pause
exit /b 0

:noengine
echo.
echo Could not find Unreal Engine 5.8 in:
echo   %UE_ROOT%
echo Install it from the Epic Games Launcher. If it is somewhere else, type this first, in this window, with its folder:
echo   set UE_ROOT=D:\Epic\UE_5.8
echo and then run this file from the same window.
goto :failed

:openeditor
echo.
echo One step first: the project has not been opened in the Unreal Editor yet.
echo Double-click AetherBrainViewer\AetherBrainViewer.uproject, press Yes when it asks to build, wait for the editor to open,
echo then close the editor and run this file again. The editor makes the glow materials and the map on its first start.
goto :failed

:failed
echo.
echo Nothing was packaged. The messages above say why. If a compiler error is shown, send it back word for word.
echo.
pause
exit /b 1
