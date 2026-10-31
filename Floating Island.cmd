@echo off
rem Starts the island without keeping a console window open.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
