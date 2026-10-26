!include nsDialogs.nsh
!include LogicLib.nsh
!define APLOT_INSTALLER_DIR "${__FILEDIR__}"

; Interactive presentation delegates to WPF. /S, /P, /UPDATE and /CLASSIC keep the core protocol.
!macro APLOT_SETUP_UI
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode != 1
  ${AndIf} $UpdateMode != 1
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/CLASSIC" $1
    ${If} ${Errors}
      InitPluginsDir
      SetOutPath "$PLUGINSDIR\aplot-wizard"
      File /oname=Aplot-Maintenance.exe "${APLOT_INSTALLER_DIR}\Aplot-Maintenance.exe"
      File /oname=aplot-probe.exe "${MAINBINARYSRCPATH}"
      File "${APLOT_INSTALLER_DIR}\Install-Components.ps1"
      File "${APLOT_INSTALLER_DIR}\components.json"
      File "${APLOT_INSTALLER_DIR}\apply_strata_patch.py"
      File "${APLOT_INSTALLER_DIR}\strata-api.patch"
      StrCpy $1 ""
      ${If} $INSTDIR != "${PLACEHOLDER_INSTALL_DIR}"
        StrCpy $1 '--suggested-directory "$INSTDIR"'
      ${EndIf}
      HideWindow
      ExecWait '"$PLUGINSDIR\aplot-wizard\Aplot-Maintenance.exe" --setup --core-installer "$EXEPATH" --probe "$PLUGINSDIR\aplot-wizard\aplot-probe.exe" $1' $0
      SetErrorLevel $0
      Quit
    ${EndIf}
  ${EndIf}
!macroend
!macro APLOT_UNINSTALL_UI
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode != 1
  ${AndIf} $UpdateMode != 1
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/CLASSIC" $1
    ${If} ${Errors}
    ${AndIf} ${FileExists} "$INSTDIR\installer\Aplot-Maintenance.exe"
      InitPluginsDir
      CreateDirectory "$PLUGINSDIR\aplot-wizard"
      CopyFiles /SILENT "$INSTDIR\installer\Aplot-Maintenance.exe" "$PLUGINSDIR\aplot-wizard\Aplot-Maintenance.exe"
      CopyFiles /SILENT "$INSTDIR\${MAINBINARYNAME}.exe" "$PLUGINSDIR\aplot-wizard\aplot-probe.exe"
      CopyFiles /SILENT "$INSTDIR\installer\Install-Components.ps1" "$PLUGINSDIR\aplot-wizard\Install-Components.ps1"
      CopyFiles /SILENT "$INSTDIR\installer\components.json" "$PLUGINSDIR\aplot-wizard\components.json"
      CopyFiles /SILENT "$INSTDIR\installer\apply_strata_patch.py" "$PLUGINSDIR\aplot-wizard\apply_strata_patch.py"
      CopyFiles /SILENT "$INSTDIR\installer\strata-api.patch" "$PLUGINSDIR\aplot-wizard\strata-api.patch"
      HideWindow
      ExecWait '"$PLUGINSDIR\aplot-wizard\Aplot-Maintenance.exe" --maintenance --app-directory "$INSTDIR" --core-uninstaller "$INSTDIR\uninstall.exe" --probe "$PLUGINSDIR\aplot-wizard\aplot-probe.exe"' $0
      SetErrorLevel $0
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro APLOT_LANGUAGES
LangString AplotModeTitle ${LANG_ENGLISH} "Choose installation"
LangString AplotModeTitle ${LANG_RUSSIAN} "Выберите установку"
LangString AplotModeHint ${LANG_ENGLISH} "Install the application and only the optional components you need."
LangString AplotModeHint ${LANG_RUSSIAN} "Установите приложение и только нужные дополнительные компоненты."
LangString AplotExpress ${LANG_ENGLISH} "Express — Aplot application only"
LangString AplotExpress ${LANG_RUSSIAN} "Экспресс — только приложение Aplot"
LangString AplotExpressHint ${LANG_ENGLISH} "Use your existing engines and agents. No optional downloads."
LangString AplotExpressHint ${LANG_RUSSIAN} "Используйте свои движки и агентов. Без дополнительных загрузок."
LangString AplotCustom ${LANG_ENGLISH} "Custom — choose engines and agents"
LangString AplotCustom ${LANG_RUSSIAN} "Выборочная — выбрать движки и агентов"
LangString AplotCustomHint ${LANG_ENGLISH} "Download selected Windows components from official GitHub repositories."
LangString AplotCustomHint ${LANG_RUSSIAN} "Загрузить выбранные Windows-компоненты из официальных GitHub-репозиториев."
LangString AplotNoModels ${LANG_ENGLISH} "Model weights are not downloaded. Components can be added later by running this installer again."
LangString AplotNoModels ${LANG_RUSSIAN} "Веса моделей не скачиваются. Добавить компоненты можно позже, повторно запустив установщик."
LangString AplotComponentsTitle ${LANG_ENGLISH} "Engines and agents"
LangString AplotComponentsTitle ${LANG_RUSSIAN} "Движки и агенты"
LangString AplotComponentsHint ${LANG_ENGLISH} "Nothing is selected automatically. Existing installations can be reused."
LangString AplotComponentsHint ${LANG_RUSSIAN} "Галочки не проставляются автоматически. Найденные установки можно использовать повторно."
LangString AplotEngines ${LANG_ENGLISH} "Local model engines"
LangString AplotEngines ${LANG_RUSSIAN} "Движки локальных моделей"
LangString AplotAgents ${LANG_ENGLISH} "Agents"
LangString AplotAgents ${LANG_RUSSIAN} "Агенты"
LangString AplotFound ${LANG_ENGLISH} "found"
LangString AplotFound ${LANG_RUSSIAN} "найден"
LangString AplotReuse ${LANG_ENGLISH} "Reuse existing components (recommended)"
LangString AplotReuse ${LANG_RUSSIAN} "Использовать найденные компоненты (рекомендуется)"
LangString AplotNote ${LANG_ENGLISH} "Internet required. Python dependencies are installed only for Strata / Hermes."
LangString AplotNote ${LANG_RUSSIAN} "Нужен интернет. Python-зависимости устанавливаются только для Strata / Hermes."
LangString AplotInstalling ${LANG_ENGLISH} "Installing selected components... This may take several minutes."
LangString AplotInstalling ${LANG_RUSSIAN} "Установка выбранных компонентов… Это может занять несколько минут."
LangString AplotFailed ${LANG_ENGLISH} "Aplot is installed. Some optional components failed. See the installation details and the log:"
LangString AplotFailed ${LANG_RUSSIAN} "Aplot установлен. Часть дополнительных компонентов не установлена. Подробности в журнале установки:"
LangString AplotChecking ${LANG_ENGLISH} "Checking existing components..."
LangString AplotChecking ${LANG_RUSSIAN} "Поиск установленных компонентов…"

LangString AplotHermesHint ${LANG_ENGLISH} "Python + dictation"
LangString AplotHermesHint ${LANG_RUSSIAN} "Python + диктовка"
LangString AplotUninstallShortcut ${LANG_ENGLISH} "Uninstall Aplot Control LLM"
LangString AplotUninstallShortcut ${LANG_RUSSIAN} "Удалить Aplot Control LLM"
LangString AplotRemoveTitle ${LANG_ENGLISH} "Choose components to remove"
LangString AplotRemoveTitle ${LANG_RUSSIAN} "Выберите компоненты для удаления"
LangString AplotRemoveHint ${LANG_ENGLISH} "Aplot will be removed. Optional components are kept unless selected below."
LangString AplotRemoveHint ${LANG_RUSSIAN} "Aplot будет удалён. Отметьте дополнительные компоненты, которые тоже нужно удалить."
LangString AplotRemoveNote ${LANG_ENGLISH} "Only Aplot-managed modules are removed. External installations, models and projects are kept. Stop agents and servers first."
LangString AplotRemoveNote ${LANG_RUSSIAN} "Удаляются только модули Aplot. Внешние установки, модели и проекты сохраняются. Сначала остановите серверы и агентов."
LangString AplotRemoveNow ${LANG_ENGLISH} "Uninstall Aplot"
LangString AplotRemoveNow ${LANG_RUSSIAN} "Удалить Aplot"
LangString AplotCache ${LANG_ENGLISH} "Downloaded archives and package cache"
LangString AplotCache ${LANG_RUSSIAN} "Скачанные архивы и кэш пакетов"
LangString AplotPython ${LANG_ENGLISH} "Shared Python / uv (only without Strata and Hermes)"
LangString AplotPython ${LANG_RUSSIAN} "Общие Python / uv (если удалены Strata и Hermes)"
LangString AplotRemoveFailed ${LANG_ENGLISH} "Component removal failed. Aplot was kept. Stop running modules and retry; see the report:"
LangString AplotRemoveFailed ${LANG_RUSSIAN} "Не удалось удалить компоненты. Aplot сохранён. Остановите работающие модули и повторите; отчёт:"
!macroend

!macro APLOT_ROW ID Y LABEL HINT
  ReadINIStr $0 "$PLUGINSDIR\aplot-components.ini" "components" "${ID}"
  StrCpy $1 "${LABEL}"
  ${If} $0 == "1"
    StrCpy $1 "$1 — $(AplotFound)"
  ${EndIf}
  ${NSD_CreateCheckbox} 0 ${Y}u 190u 12u "$1"
  Pop $AplotCheck_${ID}
  ${If} $AplotSaved_${ID} == "1"
    ${NSD_Check} $AplotCheck_${ID}
  ${EndIf}
  ${NSD_CreateLabel} 194u ${Y}u 106u 12u "${HINT}"
  Pop $0
!macroend
!macro APLOT_COLLECT ID
  ${NSD_GetState} $AplotCheck_${ID} $AplotSaved_${ID}
  ${If} $AplotSaved_${ID} == ${BST_CHECKED}
    StrCpy $AplotSelected "$AplotSelected,${ID}"
  ${EndIf}
!macroend

; The template calls this once after its directory page.
!macro APLOT_COMPONENT_PAGES
Var AplotMode
Var AplotExpressRadio
Var AplotCustomRadio
Var AplotReuseCheck
Var AplotFresh
Var AplotSelected
Var AplotChecked
Var AplotCheck_llama_cpp
Var AplotCheck_strata
Var AplotCheck_claude
Var AplotCheck_codex
Var AplotCheck_hermes
Var AplotSaved_llama_cpp
Var AplotSaved_strata
Var AplotSaved_claude
Var AplotSaved_codex
Var AplotSaved_hermes

Page custom AplotModeCreate AplotModeLeave
Page custom AplotComponentsCreate AplotComponentsLeave

Function AplotModeCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  ${If} $PassiveMode == 1
    Abort
  ${EndIf}
  ${If} $UpdateMode == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(AplotModeTitle)" "$(AplotModeHint)"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateRadioButton} 0 12u 100% 14u "$(AplotExpress)"
  Pop $AplotExpressRadio
  ${NSD_CreateLabel} 12u 30u 286u 24u "$(AplotExpressHint)"
  Pop $0
  ${NSD_CreateRadioButton} 0 64u 100% 14u "$(AplotCustom)"
  Pop $AplotCustomRadio
  ${NSD_CreateLabel} 12u 82u 286u 24u "$(AplotCustomHint)"
  Pop $0
  ${NSD_CreateLabel} 0 140u 100% 24u "$(AplotNoModels)"
  Pop $0
  ${If} $AplotMode == "custom"
    ${NSD_Check} $AplotCustomRadio
  ${Else}
    ${NSD_Check} $AplotExpressRadio
  ${EndIf}
  nsDialogs::Show
FunctionEnd
Function AplotModeLeave
  ${NSD_GetState} $AplotCustomRadio $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $AplotMode "custom"
  ${Else}
    StrCpy $AplotMode "express"
    StrCpy $AplotSelected ""
  ${EndIf}
FunctionEnd
Function AplotComponentsCreate
  ${If} $AplotMode != "custom"
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(AplotComponentsTitle)" "$(AplotChecking)"
  ${If} $AplotChecked != 1
    InitPluginsDir
    SetOutPath "$PLUGINSDIR\aplot-components"
    File /oname=aplot-probe.exe "${MAINBINARYSRCPATH}"
    File "${APLOT_INSTALLER_DIR}\Install-Components.ps1"
    File "${APLOT_INSTALLER_DIR}\components.json"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\aplot-components\Install-Components.ps1" -Probe -AppDirectory "$INSTDIR" -AppPath "$PLUGINSDIR\aplot-components\aplot-probe.exe" -ResultIni "$PLUGINSDIR\aplot-components.ini"'
    Pop $0
    StrCpy $AplotChecked 1
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(AplotComponentsTitle)" "$(AplotComponentsHint)"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 12u "$(AplotEngines)"
  Pop $0
  !insertmacro APLOT_ROW llama_cpp 12 "llama.cpp b11723" "CPU / Vulkan, 31 MB"
  !insertmacro APLOT_ROW strata 24 "Strata 0.2.6 · Qwen + DeepSeek" "NVIDIA / AMD + Python"
  ${NSD_CreateLabel} 0 54u 100% 12u "$(AplotAgents)"
  Pop $0
  !insertmacro APLOT_ROW hermes 66 "Hermes CLI 0.22.2" "$(AplotHermesHint)"
  !insertmacro APLOT_ROW codex 78 "Codex CLI" "OpenAI / ChatGPT"
  !insertmacro APLOT_ROW claude 90 "Claude Code" "Anthropic / Claude"
  ${NSD_CreateCheckbox} 0 114u 100% 12u "$(AplotReuse)"
  Pop $AplotReuseCheck
  ${If} $AplotFresh != "1"
    ${NSD_Check} $AplotReuseCheck
  ${EndIf}
  ${NSD_CreateLabel} 0 128u 100% 20u "$(AplotNote)"
  Pop $0
  nsDialogs::Show
FunctionEnd
Function AplotComponentsLeave
  StrCpy $AplotSelected ""
  !insertmacro APLOT_COLLECT llama_cpp
  !insertmacro APLOT_COLLECT strata
  !insertmacro APLOT_COLLECT hermes
  !insertmacro APLOT_COLLECT codex
  !insertmacro APLOT_COLLECT claude
  ${NSD_GetState} $AplotReuseCheck $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $AplotFresh "0"
  ${Else}
    StrCpy $AplotFresh "1"
  ${EndIf}
FunctionEnd
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Keep a discoverable uninstall entry even when Start Menu uses a flat shortcut.
  ${If} $NoShortcutMode != 1
  ${AndIf} $AplotStartMenuShortcut = 1
    !if "${STARTMENUFOLDER}" != ""
      CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\$(AplotUninstallShortcut).lnk" "$INSTDIR\uninstall.exe"
    !else
      CreateShortcut "$SMPROGRAMS\$(AplotUninstallShortcut).lnk" "$INSTDIR\uninstall.exe"
    !endif
  ${EndIf}
  ; Silent installs never fetch optional packages unless explicitly requested.
  ${If} ${Silent}
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/COMPONENTS=" $AplotSelected
  ${EndIf}
  ${If} $AplotSelected != ""
    DetailPrint "$(AplotInstalling)"
    StrCpy $0 ""
    ${If} $AplotFresh == "1"
      StrCpy $0 "-Fresh"
    ${EndIf}
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\installer\Install-Components.ps1" -Components "$AplotSelected" -AppDirectory "$INSTDIR" -AppPath "$INSTDIR\${MAINBINARYNAME}.exe" $0'
    Pop $0
    ${If} $0 != "0"
      SetErrorLevel 1
      DetailPrint "$(AplotFailed) $LOCALAPPDATA\Aplot Control LLM\components\install.log"
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(AplotFailed)$\r$\n$LOCALAPPDATA\Aplot Control LLM\components\install.log"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro APLOT_REMOVE_ROW ID Y LABEL
  ${NSD_CreateCheckbox} 0 ${Y}u 100% 12u "${LABEL}"
  Pop $AplotRemove_${ID}
  ReadINIStr $0 "$PLUGINSDIR\aplot-remove.ini" "components" "${ID}"
  ${If} $0 != "1"
    EnableWindow $AplotRemove_${ID} 0
  ${EndIf}
!macroend
!macro APLOT_REMOVE_COLLECT ID
  ${NSD_GetState} $AplotRemove_${ID} $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $AplotRemoveSelected "$AplotRemoveSelected,${ID}"
  ${EndIf}
!macroend
!macro APLOT_UNINSTALL_PAGES
Var AplotRemoveSelected
Var AplotRemove_llama_cpp
Var AplotRemove_strata
Var AplotRemove_claude
Var AplotRemove_codex
Var AplotRemove_hermes
Var AplotRemove_cache
Var AplotRemove_python_runtime
UninstPage custom un.AplotRemoveCreate un.AplotRemoveLeave
Function un.AplotRemoveCreate
  ${If} ${Silent}
  ${OrIf} $PassiveMode == 1
  ${OrIf} $UpdateMode == 1
    Abort
  ${EndIf}
  InitPluginsDir
  nsExec::ExecToLog '"$INSTDIR\${MAINBINARYNAME}.exe" --component-removal-inventory "$PLUGINSDIR\aplot-remove.ini"'
  Pop $0
  !insertmacro MUI_HEADER_TEXT "$(AplotRemoveTitle)" "$(AplotRemoveHint)"
  nsDialogs::Create 1018
  Pop $0
  !insertmacro APLOT_REMOVE_ROW llama_cpp 0 "llama.cpp"
  !insertmacro APLOT_REMOVE_ROW strata 14 "Strata"
  !insertmacro APLOT_REMOVE_ROW hermes 28 "Hermes CLI"
  !insertmacro APLOT_REMOVE_ROW codex 42 "Codex CLI"
  !insertmacro APLOT_REMOVE_ROW claude 56 "Claude Code"
  !insertmacro APLOT_REMOVE_ROW cache 70 "$(AplotCache)"
  !insertmacro APLOT_REMOVE_ROW python_runtime 84 "$(AplotPython)"
  ${NSD_CreateLabel} 0 98u 100% 20u "$(AplotRemoveNote)"
  Pop $0
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$(AplotRemoveNow)"
  nsDialogs::Show
FunctionEnd
Function un.AplotRemoveLeave
  StrCpy $AplotRemoveSelected ""
  !insertmacro APLOT_REMOVE_COLLECT llama_cpp
  !insertmacro APLOT_REMOVE_COLLECT strata
  !insertmacro APLOT_REMOVE_COLLECT hermes
  !insertmacro APLOT_REMOVE_COLLECT codex
  !insertmacro APLOT_REMOVE_COLLECT claude
  !insertmacro APLOT_REMOVE_COLLECT cache
  !insertmacro APLOT_REMOVE_COLLECT python_runtime
FunctionEnd
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  ; Updates always preserve modules; silent removal requires explicit selection.
  ${If} $UpdateMode != 1
    ${If} ${Silent}
      ${GetParameters} $0
      ClearErrors
      ${GetOptions} $0 "/REMOVE_COMPONENTS=" $AplotRemoveSelected
    ${EndIf}
    ${If} $AplotRemoveSelected != ""
      InitPluginsDir
      nsExec::ExecToLog '"$INSTDIR\${MAINBINARYNAME}.exe" --remove-components "$AplotRemoveSelected" "$PLUGINSDIR\aplot-removal.json"'
      Pop $0
      ${If} $0 != "0"
        SetErrorLevel 1
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONEXCLAMATION "$(AplotRemoveFailed)$\r$\n$PLUGINSDIR\aplot-removal.json"
        ${EndIf}
        Abort "$(AplotRemoveFailed)"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove either language's shortcut, including after an installer language change.
  Delete "$SMPROGRAMS\Удалить Aplot Control LLM.lnk"
  Delete "$SMPROGRAMS\Uninstall Aplot Control LLM.lnk"
  Delete "$SMPROGRAMS\$AppStartMenuFolder\Удалить Aplot Control LLM.lnk"
  Delete "$SMPROGRAMS\$AppStartMenuFolder\Uninstall Aplot Control LLM.lnk"
  RMDir "$SMPROGRAMS\$AppStartMenuFolder"
!macroend
