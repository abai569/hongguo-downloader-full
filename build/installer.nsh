; Custom NSIS hooks.
;
; Default electron-builder behaviour only tries "taskkill" twice and then gives up
; with the "cannot be closed" dialog. A leftover process keeps app.asar locked, so
; the freshly installed files are not really in effect and the in-app version keeps
; showing the old value. This override closes the app for real before installing.
;
; NOTE: keep this file ASCII-only. NSIS reads non-BOM scripts using the machine
; ANSI codepage, so non-ASCII text would be mangled on non-Chinese build agents.

!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif

!macro customCheckAppRunning
  ; Ask the running instance to exit gracefully (no-op when nothing is running).
  nsExec::Exec 'taskkill /IM "${APP_EXECUTABLE_FILENAME}" /T'
  Pop $0
  Sleep 1500

  StrCpy $R1 0

  hongguoCloseLoop:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 != 0
      Goto hongguoCloseDone
    ${EndIf}

    ; Still alive: force kill the whole process tree (Electron spawns children).
    nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $0
    Sleep 1500

    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 != 0
      Goto hongguoCloseDone
    ${EndIf}

    IntOp $R1 $R1 + 1
    ${If} $R1 < 3
      Goto hongguoCloseLoop
    ${EndIf}

    ; Only ask the user when the process really cannot be terminated
    ; (usually an instance started with administrator rights).
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY hongguoCloseLoop
    Quit

  hongguoCloseDone:
!macroend
