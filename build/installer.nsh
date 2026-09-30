; mwcode installer additions (electron-builder NSIS).
; Install: the CLI (mw, mindweave) goes first on PATH, so it works in any new terminal and wins over an
; older copy installed with npm. Uninstall: PATH is put back, and you are asked whether your data goes too.

!macro mwPath ACTION
  ${if} $installMode == "all"
    StrCpy $R9 "machine"
  ${else}
    StrCpy $R9 "user"
  ${endif}
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\setup\path.ps1" -Action ${ACTION} -Dir "$INSTDIR\resources\bin" -Scope $R9'
  Pop $R8
!macroend

!macro customInstall
  !insertmacro mwPath add
!macroend

!macro customUnInstall
  !insertmacro mwPath remove
  ; An update runs the old uninstaller silently: never ask then, and never touch data.
  ${ifNot} ${isUpdated}
  ${andIfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your mwcode data?$\r$\n$\r$\nThis removes your sessions, settings and saved API keys (in $PROFILE\.mindweave), which the mw command line uses too, and the app's saved window and drafts.$\r$\n$\r$\nChoose No to keep them for a later install." IDNO mwKeepData
      SetShellVarContext current
      RMDir /r "$PROFILE\.mindweave"
      RMDir /r "$APPDATA\mwcode-desktop"
      RMDir /r "$APPDATA\mwcode"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    mwKeepData:
  ${endif}
!macroend
