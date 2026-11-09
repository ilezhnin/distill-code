; NSIS installer hooks for the Windows bundle
; (bundle.windows.nsis.installerHooks in tauri.windows.conf.json).
;
; A flock-monitor runs an agent's long job and outlives the app: it leaves
; the job object the app keeps agent processes in. An update can therefore
; find flock-monitor.exe still running from the install folder, and a monitor
; may be running flockctl.exe for a report at that moment. Windows refuses to
; overwrite or delete a running executable, so the copy would stop on an
; "Error opening file for writing" prompt (or, in a silent install, skip the
; file and keep the old monitor).
;
; Windows does let a running executable be renamed. Before the files are
; copied, each command-line tool moves into the "superseded" folder: a
; running monitor keeps its old binary there, the new binary lands under the
; usual name, and every monitor started afterwards runs the new one. No
; monitor is stopped. A moved file that nothing runs is deleted at once; the
; ones still running are deleted by a later install or by the uninstaller,
; after their monitors have ended.

!define FLOCK_SUPERSEDED_DIR "$INSTDIR\superseded"

Var FlockSupersededStamp

; Deletes the superseded binaries nothing runs any more. Delete skips a file
; that is still running, and RMDir keeps a folder that is not empty.
!macro FlockRemoveSuperseded
  Delete "${FLOCK_SUPERSEDED_DIR}\*.exe"
  RMDir "${FLOCK_SUPERSEDED_DIR}"
!macroend

; Moves $INSTDIR\<stem>.exe out of the way of the copy, running or not, so
; that no process can start from it until the new file is in place.
!macro FlockSetAside stem
  ${If} ${FileExists} "$INSTDIR\${stem}.exe"
    CreateDirectory "${FLOCK_SUPERSEDED_DIR}"
    ClearErrors
    Rename "$INSTDIR\${stem}.exe" "${FLOCK_SUPERSEDED_DIR}\${stem}-$FlockSupersededStamp.exe"
    ${If} ${Errors}
      DetailPrint "Could not move $INSTDIR\${stem}.exe aside"
    ${Else}
      Delete "${FLOCK_SUPERSEDED_DIR}\${stem}-$FlockSupersededStamp.exe"
      ${If} ${FileExists} "${FLOCK_SUPERSEDED_DIR}\${stem}-$FlockSupersededStamp.exe"
        DetailPrint "${stem}.exe is still running; kept as ${FLOCK_SUPERSEDED_DIR}\${stem}-$FlockSupersededStamp.exe"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; The install closes the app right after this hook. Ask first, so that a
  ; cancelled close aborts the install before any file has moved.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  !insertmacro FlockRemoveSuperseded

  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  StrCpy $FlockSupersededStamp "$2$1$0-$4$5$6"
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0

  !insertmacro FlockSetAside "flock-monitor"
  !insertmacro FlockSetAside "flockctl"
  !insertmacro FlockSetAside "flock-history"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro FlockRemoveSuperseded
!macroend
