@echo off
rem The mwcode CLI, installed with the app: its own Node runs the core that ships beside it.
"%~dp0..\node\node.exe" "%~dp0..\app\node_modules\mindweave\dist\index.js" %*
