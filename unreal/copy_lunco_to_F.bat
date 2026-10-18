@echo off
echo Copying D:\Lunco to F:\Lunco  (D:\Lunco is not changed)
echo Close Unreal and Blender first. Press Ctrl+C to stop, or
pause
robocopy "D:\Lunco" "F:\Lunco" /E /DCOPY:DAT /MT:16 /R:1 /W:1 /XJ
echo.
if %ERRORLEVEL% GEQ 8 (echo Some files did NOT copy - check the list above.) else (echo Done - everything copied to F:\Lunco)
pause
