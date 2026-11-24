!macro NSIS_HOOK_POSTINSTALL
  ; Remove only the nested shortcuts created by the legacy PowerShell web-app installer.
  ; The Tauri shortcut lives directly under $SMPROGRAMS and is not affected.
  Delete "$SMPROGRAMS\AliceRealm\AliceRealm.lnk"
  Delete "$SMPROGRAMS\AliceRealm\Stop AliceRealm.lnk"
  RMDir "$SMPROGRAMS\AliceRealm"
!macroend
