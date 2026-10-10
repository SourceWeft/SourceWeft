; The portable runtime creates command hardlinks inside its private install
; directory. Remove those too on replacement/uninstall, so aliases cannot retain
; a previous winuxcmd binary. Never touch task directories or account data here.
!macro SOURCEWEFT_REMOVE_NIUBASH
  IfFileExists "$INSTDIR\resources\niubash\*.*" 0 +5
    ClearErrors
    RMDir /r "$INSTDIR\resources\niubash"
    IfErrors 0 +2
      Abort "Close local commands before replacing or removing bundled niubash."
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SOURCEWEFT_REMOVE_NIUBASH
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro SOURCEWEFT_REMOVE_NIUBASH
!macroend
