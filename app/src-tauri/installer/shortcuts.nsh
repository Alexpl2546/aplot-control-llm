; Explicit opt-in for shortcut creation. Shared with the isolated NSIS acceptance test.
!macro APLOT_SHORTCUT_VARIABLES
Var AplotDesktopShortcut
Var AplotStartMenuShortcut
!macroend

!macro APLOT_SHORTCUT_ARGUMENTS
  StrCpy $AplotDesktopShortcut 0
  StrCpy $AplotStartMenuShortcut 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/SHORTCUTS=" $1
  ${IfNot} ${Errors}
    ${If} $1 == "desktop"
    ${OrIf} $1 == "both"
      StrCpy $AplotDesktopShortcut 1
    ${EndIf}
    ${If} $1 == "startmenu"
    ${OrIf} $1 == "both"
      StrCpy $AplotStartMenuShortcut 1
    ${EndIf}
  ${EndIf}
!macroend
